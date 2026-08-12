/* Special properties editor — create.html and edit.html.

   The official character schema carries a `special[]` array of behaviour flags
   for the script tool: whether a character may be drawn from the bag, whether
   the app shows it the grimoire, how it votes, what it reveals. The Drunk has
   {type:"ability", name:"bag-disabled"}; the Phantom is the same kind of
   character and needs the same entry, or an app treats it as an ordinary
   townsfolk.

   The wiki understood exactly one of these — the `setup` flag, which has its
   own checkbox — so importing a character threw the rest away and the wiki's
   own JSON export then came back missing them. Preserving them on import is
   half the fix; this is the other half, so one can be added or corrected by
   hand on a page that never had them.

   The vocabulary below is the common set, offered as a menu with plain-English
   labels. It is a datalist, not a closed list: the official set grows, and a
   name this file has never heard of is still typed straight in and kept.
   assets/render.js owns the validation (sanitizeSpecial) and the export.

   Mounted by both editors:
     var ui = window.SpecialEditor.mount(listEl, addButtonEl, {onChange: fn});
     ui.set(list);   // fill from a loaded character
     ui.gather();    // -> [{type, name, value?, time?}]
*/
(function () {
  'use strict';

  // Kept short: on a phone this select is barely 250px wide, and a label that
  // runs past the end of the box tells the reader nothing.
  var TYPES = [
    ['ability',   'Ability — how it behaves'],
    ['selection', 'Selection — setup & bag'],
    ['signal',    'Signal — Storyteller sees'],
    ['reveal',    'Reveal — player sees'],
    ['vote',      'Vote — how it votes'],
    ['player',    'Player — the player']
  ];

  // The names in common use, grouped by the type they belong with, purely so
  // the menu can suggest sensible ones first. Anything may be typed.
  var NAMES = [
    ['bag-disabled',     'Cannot be put in the bag (Drunk, Marionette)'],
    ['bag-duplicate',    'Can appear in the bag more than once (Legion)'],
    ['distribute-roles', 'Hands roles out at setup (Boffin, Legion)'],
    ['grimoire',         'Shows the Storyteller the grimoire'],
    ['pointing',         'Shows who a player is pointing at'],
    ['ghost-votes',      'Shows remaining ghost votes'],
    ['replace-character', 'Replaces another character'],
    ['hidden',           'Hidden from the player'],
    ['open-eyes',        'Player keeps their eyes open at night'],
    ['card',             'Shows a card to the player'],
    ['player',           'Names a player'],
    ['multiplier',       'Multiplies a count']
  ];

  var TIMES = [
    ['',           'any time'],
    ['pregame',    'before the game'],
    ['day',        'during the day'],
    ['night',      'during the night'],
    ['firstNight', 'first night only'],
    ['otherNight', 'other nights only'],
    ['firstDay',   'first day only'],
    ['otherDay',   'other days only']
  ];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function options(pairs, sel) {
    return pairs.map(function (p) {
      return '<option value="' + esc(p[0]) + '"' + (p[0] === sel ? ' selected' : '') + '>' +
        esc(p[1]) + '</option>';
    }).join('');
  }

  function mount(list, addBtn, opts) {
    opts = opts || {};
    if (!list) return null;

    // One datalist for the whole editor, shared by every row's name box.
    var DL_ID = 'special-name-list';
    if (!document.getElementById(DL_ID)) {
      var dl = document.createElement('datalist');
      dl.id = DL_ID;
      dl.innerHTML = NAMES.map(function (n) {
        return '<option value="' + esc(n[0]) + '">' + esc(n[1]) + '</option>';
      }).join('');
      document.body.appendChild(dl);
    }

    function changed() { if (opts.onChange) opts.onChange(); }

    function addRow(s) {
      s = s || {};
      var row = document.createElement('div');
      row.className = 'special-row';
      row.innerHTML =
        '<select class="sp-type" aria-label="Kind of property">' + options(TYPES, s.type || 'ability') + '</select>' +
        '<input class="sp-name" type="text" list="' + DL_ID + '" maxlength="60" placeholder="bag-disabled" ' +
          'aria-label="Property name" value="' + esc(s.name || '') + '">' +
        '<select class="sp-time" aria-label="When it applies">' + options(TIMES, s.time || '') + '</select>' +
        '<input class="sp-value" type="number" step="1" placeholder="number" ' +
          'aria-label="Number, if the property takes one" value="' +
          esc(s.value === 0 || s.value ? s.value : '') + '">' +
        '<button type="button" class="btn btn-ghost btn-sm sp-del" aria-label="Remove this property">✕</button>';
      row.querySelector('.sp-del').addEventListener('click', function () {
        row.remove();
        changed();
      });
      row.addEventListener('input', changed);
      row.addEventListener('change', changed);
      list.appendChild(row);
      return row;
    }

    if (addBtn) {
      addBtn.addEventListener('click', function () {
        addRow().querySelector('.sp-name').focus();
      });
    }

    return {
      addRow: addRow,
      set: function (entries) {
        list.innerHTML = '';
        (Array.isArray(entries) ? entries : []).forEach(addRow);
      },
      // A row with no name is an empty row somebody opened and left — never a
      // property. render.js drops those too, but not building them keeps the
      // saved object clean.
      gather: function () {
        var out = [];
        Array.prototype.forEach.call(list.querySelectorAll('.special-row'), function (r) {
          var name = r.querySelector('.sp-name').value.trim();
          if (!name) return;
          var o = { type: r.querySelector('.sp-type').value, name: name };
          var time = r.querySelector('.sp-time').value;
          if (time) o.time = time;
          var raw = r.querySelector('.sp-value').value.trim();
          if (raw !== '' && !isNaN(Number(raw))) o.value = Number(raw);
          out.push(o);
        });
        return out;
      }
    };
  }

  window.SpecialEditor = { mount: mount, TYPES: TYPES, NAMES: NAMES, TIMES: TIMES };
})();
