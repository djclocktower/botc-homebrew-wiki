/* night-order-editor.js — the two night lists, arranged by hand.
 *
 * Mounted twice: in the Script Builder (script.html), next to the roster, and
 * on the publish page (publish-script.html). Both write the same
 * `nightOrder: {first: [slug], other: [slug]}` into the script's meta, and
 * both build their lists through PageRender.nightItems — the same function
 * the published page renders through — so what is dragged here is what a
 * reader sees. See "Night order" in CLAUDE.md.
 *
 * Two ways to move a character, on purpose:
 *   - drag a row (pointer events: mouse, pen and touch on one path)
 *   - the ▲▼ buttons, which work with a keyboard, with a screen reader, and
 *     for anyone who finds dragging on a phone fiddly.
 *
 * Who ACTS is never editable here. A character is on a list because its own
 * firstNight / otherNight says so; this only changes the order.
 *
 *   NightOrderEditor.mount(container, {getEntries, getOrder, setOrder})
 *
 * Returns {render}. The host calls render() whenever the roster changes.
 * Browser only (DOM + pointer events). Styles are .no-* in styles.css.
 */
(function (global) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  var COLS = [['first', 'First Night'], ['other', 'Other Nights']];

  function mount(container, opts) {
    opts = opts || {};
    var getEntries = opts.getEntries || function () { return []; };
    var getOrder = opts.getOrder || function () { return {}; };
    var setOrder = opts.setOrder || function () {};

    /* The lists as they stand: the stored arrangement applied to the roster
       that is on the script right now. Rebuilt on every render, so a
       character added since the last save is already in place. */
    function lists() {
      var PR = global.PageRender;
      if (!PR || !PR.nightItems) return { first: [], other: [] };
      return PR.nightItems(getEntries(), getOrder() || {});
    }

    // Write both lists whenever either is touched: an arrangement only means
    // anything as the whole order, and half of one would let the other drift
    // back to the characters' numbers on the next save.
    function commit(which, slugs) {
      var now = lists();
      var out = { first: [], other: [] };
      COLS.forEach(function (c) {
        out[c[0]] = c[0] === which ? slugs : now[c[0]].map(function (it) { return it.c.slug; });
      });
      setOrder((out.first.length || out.other.length) ? out : null);
      render();
    }

    function slugsFromDOM(listEl) {
      return [].slice.call(listEl.querySelectorAll('.no-row'))
        .map(function (row) { return row.getAttribute('data-slug'); });
    }

    function render() {
      var L = lists();
      if (!L.first.length && !L.other.length) {
        container.innerHTML = '<p class="no-empty">No character on this script wakes at night, so there is no night order to arrange.</p>';
        if (opts.onEmpty) opts.onEmpty(true);
        return;
      }
      if (opts.onEmpty) opts.onEmpty(false);
      container.innerHTML = COLS.map(function (c) {
        var which = c[0], items = L[which];
        var rows = items.length
          ? items.map(function (it, i) {
            return '<div class="no-row" data-slug="' + esc(it.c.slug) + '" data-i="' + i + '">' +
              '<span class="no-grip" aria-hidden="true" title="Drag to move">&#10247;</span>' +
              '<span class="no-pos">' + (i + 1) + '</span>' +
              '<span class="no-text">' +
                '<span class="no-name">' + esc(it.c.name) +
                  (it.c.official ? ' <span class="no-official">(official)</span>' : '') + '</span>' +
                (it.r ? '<span class="no-reminder">' + esc(it.r) + '</span>' : '') +
              '</span>' +
              '<span class="no-moves">' +
                '<button type="button" class="no-move" data-move="up"' + (i === 0 ? ' disabled' : '') +
                  ' aria-label="Move ' + esc(it.c.name) + ' earlier">&#9650;</button>' +
                '<button type="button" class="no-move" data-move="down"' + (i === items.length - 1 ? ' disabled' : '') +
                  ' aria-label="Move ' + esc(it.c.name) + ' later">&#9660;</button>' +
              '</span></div>';
          }).join('')
          : '<p class="no-empty">Nobody acts.</p>';
        return '<div class="no-col" data-list="' + which + '">' +
          '<h3 class="no-head">' + esc(c[1]) + '</h3>' +
          '<div class="no-list">' + rows + '</div></div>';
      }).join('');
    }

    /* ── ▲▼ ── */
    container.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('.no-move');
      if (!btn) return;
      var row = btn.closest('.no-row');
      var listEl = row.parentNode;
      var slugs = slugsFromDOM(listEl);
      var i = slugs.indexOf(row.getAttribute('data-slug'));
      var j = i + (btn.getAttribute('data-move') === 'up' ? -1 : 1);
      if (i < 0 || j < 0 || j >= slugs.length) return;
      var tmp = slugs[i]; slugs[i] = slugs[j]; slugs[j] = tmp;
      commit(listEl.parentNode.getAttribute('data-list'), slugs);
    });

    /* ── drag ──
       The lifted row leaves the flow (position:fixed, following the pointer)
       and a placeholder of the same height takes its place. Everything else
       stays exactly where it was, and the only thing that moves during the
       drag is that placeholder — which is what makes this stable. Lifting the
       row but leaving it IN the flow does not work: each re-insert shifts the
       rows above the pointer, the next hit-test lands somewhere else again,
       and a drag downwards walks the wrong character to the bottom.

       The row under the pointer is found with elementFromPoint; the lifted row
       is pointer-events:none, so the hit lands on the row underneath it. On
       release the row goes back into the flow where the placeholder sits and
       the order is read off the DOM — so the list you let go of is exactly the
       list that gets stored. */
    var drag = null;

    function rowUnder(x, y, listEl) {
      var el = document.elementFromPoint(x, y);
      var row = el && el.closest ? el.closest('.no-row') : null;
      return (row && row.parentNode === listEl && row !== (drag && drag.row)) ? row : null;
    }

    container.addEventListener('pointerdown', function (e) {
      var row = e.target.closest && e.target.closest('.no-row');
      if (!row || (e.target.closest && e.target.closest('.no-move'))) return;
      // A plain touch has to stay able to scroll the page, so on a phone the
      // drag starts from the grip; with a mouse, anywhere on the row.
      if (e.pointerType === 'touch' && !(e.target.closest && e.target.closest('.no-grip'))) return;

      var listEl = row.parentNode;
      var rect = row.getBoundingClientRect();
      var ph = document.createElement('div');
      ph.className = 'no-placeholder';
      ph.style.height = rect.height + 'px';
      listEl.insertBefore(ph, row);

      drag = { row: row, listEl: listEl, ph: ph, grabY: e.clientY - rect.top };
      row.classList.add('no-dragging');
      row.style.width = rect.width + 'px';
      row.style.left = rect.left + 'px';
      row.style.top = rect.top + 'px';
      container.classList.add('no-is-dragging');
      if (container.setPointerCapture) { try { container.setPointerCapture(e.pointerId); } catch (err) { /* fine */ } }
      e.preventDefault();
    });

    container.addEventListener('pointermove', function (e) {
      if (!drag) return;
      drag.row.style.top = (e.clientY - drag.grabY) + 'px';
      var over = rowUnder(e.clientX, e.clientY, drag.listEl);
      if (over && over !== drag.ph) {
        var rect = over.getBoundingClientRect();
        var after = e.clientY > rect.top + rect.height / 2;
        drag.listEl.insertBefore(drag.ph, after ? over.nextSibling : over);
      }
      // Dragging past the end of a scrolling list should follow.
      var box = drag.listEl.getBoundingClientRect();
      if (e.clientY < box.top + 24) drag.listEl.scrollTop -= 8;
      else if (e.clientY > box.bottom - 24) drag.listEl.scrollTop += 8;
      e.preventDefault();
    });

    function endDrag() {
      if (!drag) return;
      var listEl = drag.listEl;
      listEl.insertBefore(drag.row, drag.ph);
      listEl.removeChild(drag.ph);
      drag.row.classList.remove('no-dragging');
      drag.row.style.width = drag.row.style.left = drag.row.style.top = '';
      container.classList.remove('no-is-dragging');
      drag = null;
      commit(listEl.parentNode.getAttribute('data-list'), slugsFromDOM(listEl));
    }
    container.addEventListener('pointerup', endDrag);
    container.addEventListener('pointercancel', endDrag);

    render();
    return { render: render };
  }

  global.NightOrderEditor = { mount: mount };
})(typeof window !== 'undefined' ? window : this);
