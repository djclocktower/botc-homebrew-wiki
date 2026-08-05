/* Night-order "acts directly after" picker — create.html and edit.html.

   The wake-priority fields are raw numbers, so setting one used to mean
   knowing the official night order by heart (or guessing). This puts a
   search box over the official list: pick the character you want to act
   after and the field is filled with that character's position plus a
   random four-digit fraction. The Poisoner is 33 on the first night, so
   you get something like 33.5691 — directly after the Poisoner, and far
   enough from any other homebrew page that picked the same anchor that
   the two still sort apart.

   The number field stays: it shows the result, takes a hand-typed value
   for anyone who wants one, and holds whatever an older page already had.

   Data: assets/night-order.json (see the `source` field inside it).
   If the fetch fails nothing is injected and the plain number field is
   exactly what it was. Pages that fill the fields after load (edit.html)
   should call window.refreshNightOrderPickers() once the values are in. */
(function () {
  'use strict';

  var first = document.getElementById('firstNight');
  var other = document.getElementById('otherNight');
  if (!first && !other) return;

  var nameField = document.getElementById('name');
  var DATA = null;
  var pickers = [];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var TEAM_LABEL = {
    townsfolk: 'Townsfolk', outsider: 'Outsider', minion: 'Minion', demon: 'Demon',
    traveller: 'Traveller', fabled: 'Fabled', loric: 'Loric'
  };

  /* The character's own name, with a leading "the" trimmed so the sentence
     doesn't read "I want the The Cartographer to act…". */
  function whoHTML() {
    var n = nameField ? nameField.value.trim().replace(/^the\s+/i, '') : '';
    return n ? 'I want the <b>' + esc(n) + '</b> to act directly after&hellip;'
             : 'I want <b>this character</b> to act directly after&hellip;';
  }

  /* Four digits, never 0000: a .0000 fraction would land the page exactly on
     the official character's own position instead of just after it. */
  function fraction() {
    return String(1000 + Math.floor(Math.random() * 9000));
  }

  /* ---- the two wake fields share a two-column row; a sentence, a search
     box and a result line do not fit in half a column ---- */
  (function () {
    var anchor = first || other;
    var row = anchor.closest ? anchor.closest('.row2') : null;
    if (!row || !row.parentNode) return;
    Array.prototype.slice.call(row.children).forEach(function (fld) {
      row.parentNode.insertBefore(fld, row);
    });
    row.parentNode.removeChild(row);
  })();

  function makePicker(field, key) {
    if (!field) return null;
    var fld = field.closest ? field.closest('.fld') : null;
    if (!fld) return null;

    var listId = key + '-after-list';
    var wrap = document.createElement('div');
    wrap.className = 'no-pick';
    wrap.innerHTML =
      '<p class="no-sentence"></p>' +
      '<div class="no-combo">' +
        '<input type="text" class="no-search" autocomplete="off" spellcheck="false"' +
        ' role="combobox" aria-expanded="false" aria-autocomplete="list"' +
        ' aria-controls="' + listId + '" placeholder="Search official characters&hellip;">' +
        '<div class="no-drop" id="' + listId + '" role="listbox" hidden></div>' +
      '</div>' +
      '<p class="no-result" hidden></p>';
    fld.insertBefore(wrap, field);

    var p = {
      key: key,
      field: field,
      sentence: wrap.querySelector('.no-sentence'),
      search: wrap.querySelector('.no-search'),
      drop: wrap.querySelector('.no-drop'),
      result: wrap.querySelector('.no-result'),
      rows: [],
      active: -1
    };

    /* ---- dropdown ---- */
    function close() {
      p.drop.hidden = true;
      p.search.setAttribute('aria-expanded', 'false');
      p.search.removeAttribute('aria-activedescendant');
      p.active = -1;
    }
    function highlight(i) {
      if (!p.rows.length) return;
      if (i < 0) i = p.rows.length - 1;
      if (i >= p.rows.length) i = 0;
      p.rows.forEach(function (r) { r.el.classList.remove('on'); });
      p.active = i;
      var el = p.rows[i].el;
      el.classList.add('on');
      p.search.setAttribute('aria-activedescendant', el.id);
      if (el.offsetTop < p.drop.scrollTop) p.drop.scrollTop = el.offsetTop;
      else if (el.offsetTop + el.offsetHeight > p.drop.scrollTop + p.drop.clientHeight)
        p.drop.scrollTop = el.offsetTop + el.offsetHeight - p.drop.clientHeight;
    }
    function open() {
      if (!DATA) return;
      var q = p.search.value.trim().toLowerCase();
      var hits = DATA
        .filter(function (c) { return c[key] > 0 && (!q || c.name.toLowerCase().indexOf(q) !== -1); })
        .sort(function (a, b) { return a[key] - b[key]; });

      p.rows = [];
      p.drop.innerHTML = '';
      if (!hits.length) {
        p.drop.innerHTML = '<p class="no-empty">No official character by that name wakes ' +
          (key === 'firstNight' ? 'on the first night.' : 'on other nights.') + '</p>';
      }
      hits.forEach(function (c, i) {
        var el = document.createElement('button');
        el.type = 'button';
        el.className = 'no-opt';
        el.id = listId + '-' + i;
        el.tabIndex = -1; // reachable by arrow key, not by Tab
        el.setAttribute('role', 'option');
        el.innerHTML =
          '<span class="no-opt-name">' + esc(c.name) + '</span>' +
          '<span class="no-opt-meta">' + esc(TEAM_LABEL[c.team] || c.team || '') +
          ' &middot; ' + c[key] + '</span>';
        el.addEventListener('mousedown', function (e) { e.preventDefault(); pick(c); });
        p.drop.appendChild(el);
        p.rows.push({ el: el, c: c });
      });
      p.drop.scrollTop = 0;
      p.drop.hidden = false;
      p.search.setAttribute('aria-expanded', 'true');
    }

    /* ---- choosing one ---- */
    function pick(c) {
      var value = c[key] + '.' + fraction();
      p.field.value = value;
      p.field.dispatchEvent(new Event('input', { bubbles: true }));
      p.field.dispatchEvent(new Event('change', { bubbles: true }));
      p.search.value = '';
      close();
      showResult(c, value);
    }

    function showResult(c, value) {
      if (!c) { p.result.hidden = true; p.result.innerHTML = ''; return; }
      p.result.innerHTML =
        'Acts directly after the <b>' + esc(c.name) + '</b> (' + c[key] + ') &mdash; ' +
        'wake priority <b>' + esc(value) + '</b>. ' +
        '<button type="button" class="no-clear">clear</button>';
      p.result.hidden = false;
      p.result.querySelector('.no-clear').addEventListener('click', function () {
        p.field.value = 0;
        p.field.dispatchEvent(new Event('input', { bubbles: true }));
        p.field.dispatchEvent(new Event('change', { bubbles: true }));
        showResult(null);
        p.search.focus();
      });
    }
    p.showResult = showResult;

    /* Read the field back: a whole number is somebody's hand-set position,
       not a slot behind an official character, so only a fraction counts. */
    p.sync = function () {
      var v = parseFloat(p.field.value);
      if (!DATA || !(v > 0) || v === Math.floor(v)) return showResult(null);
      var base = Math.floor(v);
      var match = null;
      for (var i = 0; i < DATA.length; i++)
        if (DATA[i][key] === base) { match = DATA[i]; break; }
      showResult(match, p.field.value);
    };

    p.search.addEventListener('focus', open);
    p.search.addEventListener('input', open);
    p.search.addEventListener('blur', function () { setTimeout(close, 0); });
    p.search.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (p.drop.hidden) return open();
        highlight(p.active + (e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === 'Enter') {
        if (!p.drop.hidden && p.active > -1) { e.preventDefault(); pick(p.rows[p.active].c); }
      } else if (e.key === 'Escape') {
        if (!p.drop.hidden) { e.stopPropagation(); close(); }
      }
    });
    p.field.addEventListener('input', function () { p.sync(); });

    return p;
  }

  pickers = [makePicker(first, 'firstNight'), makePicker(other, 'otherNight')]
    .filter(Boolean);
  if (!pickers.length) return;

  function paintSentence() {
    var html = whoHTML();
    pickers.forEach(function (p) { p.sentence.innerHTML = html; });
  }
  paintSentence();
  if (nameField) nameField.addEventListener('input', paintSentence);

  window.refreshNightOrderPickers = function () {
    paintSentence();
    pickers.forEach(function (p) { p.sync(); });
  };

  fetch(new URL('assets/night-order.json', document.baseURI).href)
    .then(function (r) { return r.json(); })
    .then(function (d) {
      DATA = (d && d.characters) || [];
      pickers.forEach(function (p) { p.sync(); });
    })
    .catch(function () {
      pickers.forEach(function (p) {
        p.search.disabled = true;
        p.search.placeholder = 'Official night order unavailable — type a number below';
      });
    });
})();
