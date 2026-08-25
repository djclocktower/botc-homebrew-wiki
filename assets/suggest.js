/* Type-ahead for a plain text field: mountSuggest(input, {source}).

   Written for the admin dashboard, where nearly every box wants a slug, a
   username, a creator name or a tag — none of which anybody remembers exactly,
   and all of which the site already knows. Moderation was a matter of typing a
   slug from memory and finding out it was wrong only after the save.

   It is deliberately NOT a <datalist>: the value a dashboard field posts is a
   slug, the thing a person can actually recall is the name, and a datalist
   only matches what you type against the option's VALUE in some browsers. Here
   the filter reads the label as well, so typing "potato" finds
   `the-potato-patch` and fills the slug in.

   Nothing is ever forced. Typing a value that matches nothing leaves the box
   exactly as typed, because a dashboard field is often used on a page that has
   just been made, or one whose feed has not caught up yet.

   Shape and keyboard handling follow assets/jinx-picker.js, which is the same
   control worn differently; the drop-down skin is shared with it in
   styles.css. The one structural difference is that this one hangs its list
   off <body> at a fixed position rather than wrapping the field: the dashboard
   packs its inputs into flex rows, and inserting a wrapper around one moves
   the row about.

   Usage:
     mountSuggest(field, {
       source: function () { return [{value, label, meta}] | Promise },
       empty:  'nothing by that name'        // optional
     })
   `source` is called on every open, so a field whose list depends on a <select>
   beside it just reads that select. Cache the fetch inside the source, not
   here. */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var seq = 0;
  var mounted = [];

  /* A list lives on <body>, not beside its field, so a field that gets thrown
     away in a redraw (the dashboard rebuilds its unowned rows on every load)
     would leave its list behind. Swept on the next mount, which is the moment
     new rows arrive. */
  function sweep() {
    mounted = mounted.filter(function (m) {
      if (m.field.isConnected) return true;
      if (m.drop.parentNode) m.drop.parentNode.removeChild(m.drop);
      return false;
    });
  }

  function mountSuggest(field, opts) {
    if (!field || field.getAttribute('data-sgmounted') === '1') return;
    opts = opts || {};
    if (typeof opts.source !== 'function') return;
    field.setAttribute('data-sgmounted', '1');
    field.setAttribute('autocomplete', 'off');
    field.setAttribute('role', 'combobox');
    field.setAttribute('aria-autocomplete', 'list');
    field.setAttribute('aria-expanded', 'false');

    var listId = 'sg-drop-' + (++seq);
    var drop = document.createElement('div');
    drop.className = 'sg-drop';
    drop.id = listId;
    drop.setAttribute('role', 'listbox');
    drop.hidden = true;
    document.body.appendChild(drop);
    field.setAttribute('aria-controls', listId);
    mounted.push({ field: field, drop: drop });
    sweep();

    var rows = [], active = -1, open = false;

    function close() {
      if (!open) return;
      open = false;
      drop.hidden = true;
      field.setAttribute('aria-expanded', 'false');
      field.removeAttribute('aria-activedescendant');
      active = -1;
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    }

    /* The list is fixed to the viewport, so it has to be told where the field
       is every time either of them moves. Below the field unless the space
       below is smaller than the space above, which is what a phone keyboard
       leaves. */
    function place() {
      if (!open) return;
      var r = field.getBoundingClientRect();
      var below = window.innerHeight - r.bottom, above = r.top;
      var room = Math.max(120, Math.min(280, (below >= above ? below : above) - 12));
      drop.style.width = Math.max(r.width, 180) + 'px';
      drop.style.left = Math.max(6, Math.min(r.left, window.innerWidth - Math.max(r.width, 180) - 6)) + 'px';
      drop.style.maxHeight = room + 'px';
      if (below >= above) {
        drop.style.top = (r.bottom + 4) + 'px';
        drop.style.bottom = 'auto';
      } else {
        drop.style.top = 'auto';
        drop.style.bottom = (window.innerHeight - r.top + 4) + 'px';
      }
    }

    function highlight(i) {
      if (!rows.length) return;
      if (i < 0) i = rows.length - 1;
      if (i >= rows.length) i = 0;
      rows.forEach(function (r) { r.el.classList.remove('on'); });
      active = i;
      var el = rows[i].el;
      el.classList.add('on');
      field.setAttribute('aria-activedescendant', el.id);
      if (el.offsetTop < drop.scrollTop) drop.scrollTop = el.offsetTop;
      else if (el.offsetTop + el.offsetHeight > drop.scrollTop + drop.clientHeight)
        drop.scrollTop = el.offsetTop + el.offsetHeight - drop.clientHeight;
    }

    function match(items) {
      var q = String(field.value || '').trim().toLowerCase();
      var hits = [];
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (!it) continue;
        var value = String(it.value == null ? '' : it.value);
        var label = String(it.label == null ? value : it.label);
        if (!value && !label) continue;
        var v = value.toLowerCase(), l = label.toLowerCase();
        // Rank: what was typed in full, then what starts with it, then what
        // merely contains it. A name and a slug are both worth matching —
        // "potato" has to find `the-potato-patch`.
        var rank = 3;
        if (!q) rank = 3;
        else if (v === q || l === q) rank = 0;
        else if (v.indexOf(q) === 0 || l.indexOf(q) === 0) rank = 1;
        else if (v.indexOf(q) !== -1 || l.indexOf(q) !== -1) rank = 2;
        else continue;
        hits.push({ it: it, value: value, label: label, rank: rank });
      }
      hits.sort(function (a, b) {
        if (a.rank !== b.rank) return a.rank - b.rank;
        return a.label.localeCompare(b.label);
      });
      return hits.slice(0, 40);
    }

    function draw(items) {
      var hits = match(items || []);
      rows = [];
      drop.innerHTML = '';
      if (!hits.length) {
        if (!opts.empty) { close(); return; }
        drop.innerHTML = '<p class="sg-empty">' + esc(opts.empty) + '</p>';
      }
      hits.forEach(function (h, i) {
        var el = document.createElement('button');
        el.type = 'button';
        el.className = 'sg-opt';
        el.id = listId + '-' + i;
        el.tabIndex = -1;
        el.setAttribute('role', 'option');
        var meta = h.it.meta || (h.label !== h.value ? h.value : '');
        el.innerHTML =
          '<span class="sg-opt-body"><span class="sg-opt-name">' + esc(h.label) + '</span>' +
          (meta ? '<span class="sg-opt-meta">' + esc(meta) + '</span>' : '') + '</span>';
        el.addEventListener('mousedown', function (e) { e.preventDefault(); pick(h); });
        drop.appendChild(el);
        rows.push({ el: el, h: h });
      });
      drop.scrollTop = 0;
      drop.hidden = false;
      open = true;
      field.setAttribute('aria-expanded', 'true');
      window.addEventListener('scroll', place, true);
      window.addEventListener('resize', place);
      place();
    }

    function pick(h) {
      field.value = h.value;
      close();
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      if (typeof opts.onPick === 'function') opts.onPick(h.it, field);
    }

    var token = 0;
    function show() {
      var mine = ++token;
      Promise.resolve(opts.source(field)).then(function (items) {
        // A slow fetch that lands after the field was left alone must not
        // reopen the list over whatever the person is doing now.
        if (mine !== token || document.activeElement !== field) return;
        draw(Array.isArray(items) ? items : []);
      }).catch(function () { /* no list is the same as no matches */ });
    }

    field.addEventListener('input', show);
    field.addEventListener('focus', show);
    field.addEventListener('blur', function () { setTimeout(close, 0); });
    field.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!open) return show();
        highlight(active + (e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === 'Enter') {
        // Enter with a row highlighted takes it; Enter with nothing highlighted
        // belongs to the form (several of these fields run their search on it).
        if (open && active > -1) { e.preventDefault(); pick(rows[active].h); }
      } else if (e.key === 'Escape') {
        if (open) { e.stopPropagation(); close(); }
      }
    });
  }

  if (typeof window !== 'undefined') window.mountSuggest = mountSuggest;
})();
