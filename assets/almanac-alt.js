/* Second almanac version editor — create.html and edit.html.

   A character can carry its almanac written twice, the way the official wiki
   gives God of Ug a "Big Word Mode" and an "Ug Mode", and readers switch
   between the two at the top of the page. Stored as `almanacAlt` on the
   character; render.js owns the shape (sanitizeAlmanacAlt) and the drawing.

   Mounted by both editors, inside a <fieldset> so redesign-create.js files it
   under Advanced Options:
     var ui = window.AlmanacAlt.mount(boxEl, {onChange: fn});
     ui.set(entry.almanacAlt);   // fill from a loaded character
     ui.gather();                // -> {label, altLabel, ability, ...} or null
*/
(function () {
  'use strict';

  var TEXT = [
    ['label', 'Name of the main version', 'Standard', 'input'],
    ['altLabel', 'Name of the second version', 'Alternate', 'input'],
    ['ability', 'Ability line', '', 'textarea'],
    ['quote', 'Flavour quote', '', 'input'],
    ['lede', 'Lede', '', 'input']
  ];
  var LISTS = [
    ['summaryBullets', 'Summary bullets'],
    ['howToRun', 'How to Run'],
    ['callout', 'How-to-Run notes'],
    ['examples', 'Examples'],
    ['tips', 'Tips & Tricks'],
    ['bluffing', 'Bluffing'],
    ['fighting', 'Fighting']
  ];
  function cap(k) { return 'almAlt' + k.charAt(0).toUpperCase() + k.slice(1); }

  function mount(box, opts) {
    var onChange = (opts && opts.onChange) || function () {};
    var html =
      '<div class="fld ck"><input type="checkbox" id="almAltOn">' +
      '<label for="almAltOn" style="margin:0">This character has a second version of its almanac</label></div>' +
      '<div id="almAltFields" hidden>' +
      '<p class="sub" style="margin:0 0 10px">Readers switch between the two versions at the top of the page. ' +
      'Leave a box empty to use the main version&rsquo;s text. The JSON export, tokens and cards always use the main version.</p>';
    TEXT.forEach(function (f) {
      var id = cap(f[0]);
      html += '<div class="fld"><label for="' + id + '">' + f[1] + '</label>' +
        (f[3] === 'textarea' ? '<textarea id="' + id + '"></textarea>'
          : '<input type="text" id="' + id + '"' + (f[2] ? ' placeholder="' + f[2] + '" maxlength="40"' : '') + '>') +
        '</div>';
    });
    LISTS.forEach(function (f) {
      var id = cap(f[0]);
      html += '<div class="fld"><label for="' + id + '">' + f[1].replace('&', '&amp;') +
        ' <span class="hint">(one per line)</span></label><textarea id="' + id + '"></textarea></div>';
    });
    box.innerHTML = html + '</div>';

    var on = box.querySelector('#almAltOn');
    var fields = box.querySelector('#almAltFields');
    function el(k) { return box.querySelector('#' + cap(k)); }
    function sync() { fields.hidden = !on.checked; }
    on.addEventListener('change', function () { sync(); onChange(); });
    box.addEventListener('input', onChange);

    return {
      set: function (o) {
        o = o && typeof o === 'object' ? o : null;
        on.checked = !!o;
        TEXT.forEach(function (f) { el(f[0]).value = (o && o[f[0]]) || ''; });
        LISTS.forEach(function (f) {
          var v = o && o[f[0]];
          el(f[0]).value = (Array.isArray(v) ? v : (v ? [v] : [])).join('\n');
        });
        sync();
      },
      gather: function () {
        if (!on.checked) return null;
        var o = {};
        TEXT.forEach(function (f) { o[f[0]] = el(f[0]).value.trim(); });
        LISTS.forEach(function (f) {
          o[f[0]] = el(f[0]).value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
        });
        return o;
      }
    };
  }

  window.AlmanacAlt = { mount: mount };
})();
