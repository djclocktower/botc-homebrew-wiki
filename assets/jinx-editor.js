/* jinx-editor.js: the jinxes on one script, edited by its owner.
 *
 * A jinx normally belongs to the characters: both character editors write it
 * into the character's own `jinxes`, and any script holding both ends shows
 * it. That is right for a rule the character carries everywhere, and no help
 * to a script that wants to drop one, or to add a rule that only holds
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
 * characters, so another script keeps whatever they say.
 *
 *   JinxEditor.mount(container, {getEntries, getEdits, setEdits,
 *                                getView, artOf})
 *
 * getView() may answer {icons}: whether a row shows the pair's icons
 * (default no; artOf(c) gives the src). The publish page passes neither.
 *
 * Returns {render}; the host calls render() when the roster changes.
 * Browser only. Styles are .sjx-* in styles.css (.jx-* belongs to the jinx
 * picker, assets/jinx-picker.js).
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
      var v = (opts.getView && opts.getView()) || {};
      var icons = !!v.icons && typeof opts.artOf === 'function';
      function pair(a, b) {
        if (!icons) return '';
        return '<span class="sjx-icons">' +
          '<img loading="lazy" decoding="async" src="' + esc(opts.artOf(a)) + '" alt="" onerror="this.style.visibility=\'hidden\'">' +
          '<img loading="lazy" decoding="async" src="' + esc(opts.artOf(b)) + '" alt="" onerror="this.style.visibility=\'hidden\'"></span>';
      }
      // Inherited jinxes this script has switched off, listed so they can be
      // switched back on. A pair whose characters have both left the
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
        container.innerHTML = '<p class="sjx-empty">Add characters to your script first. A jinx is a rule between two of them.</p>';
        return;
      }
      html += '<div class="sjx-list">';
      if (!jinxes.length) {
        html += '<p class="sjx-empty">No jinxes on this script.</p>';
      } else {
        jinxes.forEach(function (j) {
          var k = key(j.a.slug, j.b.slug);
          html += '<div class="sjx-row" data-key="' + esc(k) + '">' + pair(j.a, j.b) +
            '<div class="sjx-text">' +
              '<span class="sjx-pair">' + esc(j.a.name) + ' &harr; ' + esc(j.b.name) +
                (j.custom ? ' <span class="sjx-own">this script</span>' : '') + '</span>' +
              '<span class="sjx-reason">' + esc(j.text || '(no text)') + '</span>' +
            '</div>' +
            '<button type="button" class="sjx-btn sjx-remove" data-key="' + esc(k) + '"' +
              ' data-custom="' + (j.custom ? '1' : '') + '"' +
              ' aria-label="Remove the jinx between ' + esc(j.a.name) + ' and ' + esc(j.b.name) + '">&#10005;</button>' +
            '</div>';
        });
      }
      html += '</div>';

      if (offRows.length) {
        html += '<div class="sjx-off"><p class="sjx-off-head">Switched off for this script</p>';
        offRows.forEach(function (r) {
          html += '<div class="sjx-row sjx-row-off">' +
            '<div class="sjx-text"><span class="sjx-pair">' + esc(r.a.name) + ' &harr; ' + esc(r.b.name) + '</span></div>' +
            '<button type="button" class="sjx-btn sjx-restore" data-key="' + esc(r.k) + '">Put back</button>' +
            '</div>';
        });
        html += '</div>';
      }

      // "Add a jinx": both ends are already on the script, so there is no way
      // to write a rule about somebody who is not here.
      var opts2 = entries.map(function (c) {
        return '<option value="' + esc(c.slug) + '">' + esc(c.name) +
          (c.official ? ' (official)' : '') + '</option>';
      }).join('');
      html += '<div class="sjx-add">' +
        '<div class="sjx-add-row">' +
          '<select class="sjx-sel" id="sjx-a" aria-label="First character"><option value="">Character…</option>' + opts2 + '</select>' +
          '<span class="sjx-amp">&harr;</span>' +
          '<select class="sjx-sel" id="sjx-b" aria-label="Second character"><option value="">Character…</option>' + opts2 + '</select>' +
        '</div>' +
        '<input type="text" class="sjx-input" id="sjx-text" maxlength="300" placeholder="What the jinx does, e.g. “If both are in play, the Demon does not wake.”">' +
        '<button type="button" class="sjx-btn sjx-add-btn" id="sjx-add">+ Add this jinx</button>' +
        '<p class="sjx-note" id="sjx-note"></p>' +
      '</div>';
      container.innerHTML = html;
    }

    container.addEventListener('click', function (ev) {
      var e = edits();
      var rm = ev.target.closest && ev.target.closest('.sjx-remove');
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
      var back = ev.target.closest && ev.target.closest('.sjx-restore');
      if (back) {
        var bk = back.getAttribute('data-key');
        e.off = e.off.filter(function (x) { return x !== bk; });
        save(e);
        return;
      }
      if (ev.target.closest && ev.target.closest('#sjx-add')) {
        var a = container.querySelector('#sjx-a').value;
        var b = container.querySelector('#sjx-b').value;
        var text = container.querySelector('#sjx-text').value.trim();
        var note = container.querySelector('#sjx-note');
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
