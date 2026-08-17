/* jinx-editor.js — the jinxes on one script, edited by its owner.
 *
 * A jinx normally belongs to the characters: both character editors write it
 * into the character's own `jinxes`, and any script holding both ends shows
 * it. That is right for a rule the character carries everywhere — and no help
 * at all to a script that wants to drop one, or to add a rule that only holds
 * on this script (two homebrew characters that only meet here, a house ruling
 * between an official character and a homebrew one).
 *
 * So a script may carry its own edits, stored as
 *
 *   jinxEdits: {off: ["slugA|slugB"], add: [{a, b, text}]}
 *
 * and PageRender.scriptJinxes() is what turns characters + edits into the
 * list. This widget only edits; the resolving, the page and the exported JSON
 * all go through that one function. Nothing here is written back to the
 * characters — another script keeps whatever they say.
 *
 *   JinxEditor.mount(container, {getEntries, getEdits, setEdits})
 *
 * Returns {render}; the host calls render() when the roster changes.
 * Browser only. Styles are .jx-* in styles.css.
 */
(function (global) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function mount(container, opts) {
    opts = opts || {};
    var getEntries = opts.getEntries || function () { return []; };
    var getEdits = opts.getEdits || function () { return {}; };
    var setEdits = opts.setEdits || function () {};

    function edits() {
      var e = getEdits() || {};
      return {
        off: Array.isArray(e.off) ? e.off.slice() : [],
        add: Array.isArray(e.add) ? e.add.slice() : []
      };
    }
    function save(e) {
      var out = {};
      if (e.off.length) out.off = e.off;
      if (e.add.length) out.add = e.add;
      setEdits(out.off || out.add ? out : null);
      render();
    }
    function key(a, b) {
      return global.PageRender && global.PageRender.jinxKey
        ? global.PageRender.jinxKey(a, b) : [a, b].sort().join('|');
    }
    function list() {
      var PR = global.PageRender;
      return (PR && PR.scriptJinxes) ? PR.scriptJinxes(getEntries(), getEdits() || {}) : [];
    }

    function render() {
      var entries = getEntries();
      var jinxes = list();
      var e = edits();
      // Inherited jinxes that this script has switched off — listed so they
      // can be switched back on. A pair whose characters have both left the
      // roster is not shown (and is left in the data: it applies again if
      // they come back).
      var bySlug = {};
      entries.forEach(function (c) { bySlug[c.slug] = c; });
      var offRows = e.off.map(function (k) {
        var parts = String(k).split('|');
        var a = bySlug[parts[0]], b = bySlug[parts[1]];
        return (a && b) ? { k: k, a: a, b: b } : null;
      }).filter(Boolean);

      var html = '';
      if (!entries.length) {
        container.innerHTML = '<p class="jx-empty">Add characters to your script first — a jinx is a rule between two of them.</p>';
        return;
      }
      html += '<div class="jx-list">';
      if (!jinxes.length) {
        html += '<p class="jx-empty">No jinxes on this script.</p>';
      } else {
        jinxes.forEach(function (j) {
          var k = key(j.a.slug, j.b.slug);
          html += '<div class="jx-row" data-key="' + esc(k) + '">' +
            '<div class="jx-text">' +
              '<span class="jx-pair">' + esc(j.a.name) + ' &harr; ' + esc(j.b.name) +
                (j.custom ? ' <span class="jx-own">this script</span>' : '') + '</span>' +
              '<span class="jx-reason">' + esc(j.text || '(no text)') + '</span>' +
            '</div>' +
            '<button type="button" class="jx-btn jx-remove" data-key="' + esc(k) + '"' +
              ' data-custom="' + (j.custom ? '1' : '') + '"' +
              ' aria-label="Remove the jinx between ' + esc(j.a.name) + ' and ' + esc(j.b.name) + '">&#10005;</button>' +
            '</div>';
        });
      }
      html += '</div>';

      if (offRows.length) {
        html += '<div class="jx-off"><p class="jx-off-head">Switched off for this script</p>';
        offRows.forEach(function (r) {
          html += '<div class="jx-row jx-row-off">' +
            '<div class="jx-text"><span class="jx-pair">' + esc(r.a.name) + ' &harr; ' + esc(r.b.name) + '</span></div>' +
            '<button type="button" class="jx-btn jx-restore" data-key="' + esc(r.k) + '">Put back</button>' +
            '</div>';
        });
        html += '</div>';
      }

      // "Add a jinx" — both ends are characters already on the script, so
      // there is no way to write a rule about somebody who is not here.
      var opts2 = entries.map(function (c) {
        return '<option value="' + esc(c.slug) + '">' + esc(c.name) +
          (c.official ? ' (official)' : '') + '</option>';
      }).join('');
      html += '<div class="jx-add">' +
        '<div class="jx-add-row">' +
          '<select class="jx-sel" id="jx-a" aria-label="First character"><option value="">Character…</option>' + opts2 + '</select>' +
          '<span class="jx-amp">&harr;</span>' +
          '<select class="jx-sel" id="jx-b" aria-label="Second character"><option value="">Character…</option>' + opts2 + '</select>' +
        '</div>' +
        '<input type="text" class="jx-input" id="jx-text" maxlength="300" placeholder="What the jinx does, e.g. “If both are in play, the Demon does not wake.”">' +
        '<button type="button" class="jx-btn jx-add-btn" id="jx-add">+ Add this jinx</button>' +
        '<p class="jx-note" id="jx-note"></p>' +
      '</div>';
      container.innerHTML = html;
    }

    container.addEventListener('click', function (ev) {
      var e = edits();
      var rm = ev.target.closest && ev.target.closest('.jx-remove');
      if (rm) {
        var k = rm.getAttribute('data-key');
        if (rm.getAttribute('data-custom')) {
          // One this script wrote: it just goes.
          e.add = e.add.filter(function (j) { return key(j.a, j.b) !== k; });
        } else if (e.off.indexOf(k) === -1) {
          // One the characters carry: switched off here, left alone everywhere
          // else, and listed below so it can be put back.
          e.off.push(k);
        }
        save(e);
        return;
      }
      var back = ev.target.closest && ev.target.closest('.jx-restore');
      if (back) {
        var bk = back.getAttribute('data-key');
        e.off = e.off.filter(function (x) { return x !== bk; });
        save(e);
        return;
      }
      if (ev.target.closest && ev.target.closest('#jx-add')) {
        var a = container.querySelector('#jx-a').value;
        var b = container.querySelector('#jx-b').value;
        var text = container.querySelector('#jx-text').value.trim();
        var note = container.querySelector('#jx-note');
        if (!a || !b || a === b) { note.textContent = 'Pick two different characters.'; return; }
        if (!text) { note.textContent = 'Say what the jinx does.'; return; }
        var k2 = key(a, b);
        if (list().some(function (j) { return key(j.a.slug, j.b.slug) === k2; })) {
          note.textContent = 'Those two already have a jinx on this script.';
          return;
        }
        // Adding one back that was switched off is a change of mind, not a
        // second rule: drop it from off[] so the character's own text returns
        // if this one is ever removed.
        e.off = e.off.filter(function (x) { return x !== k2; });
        e.add.push({ a: a, b: b, text: text });
        save(e);
      }
    });

    render();
    return { render: render };
  }

  global.JinxEditor = { mount: mount };
})(typeof window !== 'undefined' ? window : this);
