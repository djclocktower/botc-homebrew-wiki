/* Create-a-Character layout enhancement.

   Loaded BEFORE the page's own scripts so the fields it converts already
   exist when the page wires up its listeners. Pure progressive enhancement:
   everything keys off existing IDs, no field is added or removed, and no
   saved data changes shape. If this file fails to load the page still works
   exactly as it did — the CSS is scoped to html.create-redesign, which is
   only added once the form has actually been restructured.

   Pairs with assets/redesign-create.css. */
(function () {
  'use strict';

  var card = document.querySelector('.formcard');
  if (!card) return;
  document.documentElement.classList.add('create-redesign');

  /* ============================================================
     1. One-line inputs that routinely hold a whole sentence become
        auto-growing textareas (same id, so page JS keeps working).
        They stay single-line in substance: Enter is swallowed and
        pasted newlines collapse to spaces, so nothing downstream
        (appearsIn matching, the JSON export) sees a stray \n.
     ============================================================ */
  ['lede', 'callout', 'quote', 'appears'].forEach(function (id) {
    var el = document.getElementById(id);
    if (!el || el.tagName !== 'INPUT') return;
    var ta = document.createElement('textarea');
    ta.id = el.id;
    ta.placeholder = el.placeholder;
    ta.value = el.value;
    ta.rows = 1;
    if (el.className) ta.className = el.className;
    el.parentNode.replaceChild(ta, el);

    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') e.preventDefault();
    });
    ta.addEventListener('input', function () {
      if (!/[\r\n]/.test(ta.value)) return;
      var at = ta.selectionStart;
      ta.value = ta.value.replace(/[\r\n]+/g, ' ');
      try { ta.setSelectionRange(Math.min(at, ta.value.length), Math.min(at, ta.value.length)); } catch (e) {}
    });
  });

  /* ============================================================
     2. The flavour quote and "appears in" share one two-column row,
        but the quote belongs up in Basics. Split the row into two
        plain fields and park the quote under the ability line, so the
        section pass below picks each of them up on its own.
     ============================================================ */
  (function () {
    var quote = document.getElementById('quote');
    var row = quote && quote.closest ? quote.closest('.row2') : null;
    if (!row || !row.parentNode) return;
    var quoteFld = quote.closest('.fld') || quote.parentNode;
    var ability = document.getElementById('ability');
    var abilityFld = ability && ability.closest ? ability.closest('.fld') : null;

    // unwrap first, so the quote is never left inside the discarded row
    Array.prototype.slice.call(row.children).forEach(function (fld) {
      row.parentNode.insertBefore(fld, row);
    });
    row.parentNode.removeChild(row);

    if (abilityFld && abilityFld.parentNode)
      abilityFld.parentNode.insertBefore(quoteFld, abilityFld.nextSibling);
  })();

  /* ============================================================
     3. Re-order the flat field run into titled sections:
        Basics → The Page → Special properties → Tags → Sharing
        → Night Order → Advanced → actions
     ============================================================ */
  var GROUP_DEFS = [
    { key: 'basics',   title: 'Basics',   sub: 'name, team, ability, quote and art',
      ids: ['name', 'team', 'ability', 'quote', 'art'] },
    { key: 'the-page', title: 'Page',     sub: 'what readers see on the wiki page',
      ids: ['lede', 'bullets', 'howto', 'callout', 'examples', 'tips',
            'bluffing-fld', 'bluffing', 'fighting-fld', 'fighting', 'appears'] },
    /* `curata-fld` is edit.html only, and only drawn for a page that has the
       Curata mark. It sits with the tags because that is where the wreath is
       drawn on the page itself — the end of the /c/ page's Tags row. */
    { key: 'tags',     title: 'Tags',     sub: 'how readers find it',
      ids: ['tag-picker', 'tags', 'curata-fld'] },
    /* Sharing is a section of its own rather than another fieldset swept into
       Advanced Options. Buried under a summary reading "credits, alt art,
       jinxes, sidebar boxes, custom JSON", the one control that decides who
       else may touch the page was effectively unfindable, and the page's own
       history had nowhere to be linked from at all. `hist-fld` is edit.html
       only: a page being created has no history yet. */
    { key: 'sharing',  title: 'Sharing',  sub: 'who else may edit, and every change so far',
      ids: ['publicEdit', 'hist-fld'] }
  ];
  var ADVANCED_FIELD_IDS = ['pronunciation', 'ipa', 'respelling',
    'translatedBy', 'iconBy', 'artAlt'];
  var NIGHTORDER_ID = 'edition'; // first id inside the Night Order fieldset
  /* Special properties is a section in its own right, above Tags and above
     Night Order. It was swept into Advanced Options with the jinxes and the
     custom JSON simply because it is a <fieldset>, and that is the wrong
     place for it: what it holds ("cannot go in the bag", "show the
     Storyteller the grimoire") is part of how the character WORKS, so it
     belongs beside the mechanics rather than under a summary that never
     mentions it. First id inside that fieldset. */
  var SPECIAL_ID = 'specials';
  // create.html and edit.html between them: publish / draft / save /
  // snapshot / delete.
  var ACTION_IDS = ['publish', 'save-draft', 'save', 'save-publish', 'snapshot', 'delete-char', 'status'];

  function bucketOf(node) {
    var cand = [node.id, node.querySelector ? (node.querySelector('[id]') || {}).id : null];
    for (var i = 0; i < cand.length; i++) {
      var id = cand[i];
      if (!id) continue;
      for (var g = 0; g < GROUP_DEFS.length; g++)
        if (GROUP_DEFS[g].ids.indexOf(id) !== -1) return GROUP_DEFS[g].key;
      if (ADVANCED_FIELD_IDS.indexOf(id) !== -1) return 'advFld';
      if (id === SPECIAL_ID) return 'special';
      if (id === NIGHTORDER_ID) return 'nightorder';
      if (ACTION_IDS.indexOf(id) !== -1) return 'actions';
    }
    if (node.tagName === 'FIELDSET' && !node.classList.contains('import'))
      return 'advFs'; // jinxes / sidebar boxes / custom JSON
    return 'head'; // h2, intro sub, import fieldset, anything unrecognised
  }

  var buckets = { head: [], basics: [], 'the-page': [], special: [], tags: [],
                  sharing: [], nightorder: [], advFld: [], advFs: [], actions: [] };
  Array.prototype.slice.call(card.children).forEach(function (node) {
    buckets[bucketOf(node)].push(node);
  });

  // rebuild the card in the new order (appendChild moves, never clones)
  buckets.head.forEach(function (n) { card.appendChild(n); });

  /* Special properties goes in ahead of the Tags section — and, if there is
     no Tags section on this page, still ahead of Night Order, which is the
     other half of what it was asked to sit above. */
  var specialPlaced = false;
  function placeSpecial() {
    if (specialPlaced) return;
    specialPlaced = true;
    buckets.special.forEach(function (n) { card.appendChild(n); });
  }

  GROUP_DEFS.forEach(function (g) {
    if (g.key === 'tags') placeSpecial();
    if (!buckets[g.key].length) return;
    var wrap = document.createElement('section');
    wrap.className = 'rsec';
    wrap.id = 'sec-' + g.key;
    wrap.innerHTML =
      '<div class="rsec-head"><h3 class="rsec-title">' + g.title + '</h3>' +
      '<span class="rsec-rule"></span>' +
      '<span class="rsec-sub">' + g.sub + '</span></div>';
    card.appendChild(wrap);
    buckets[g.key].forEach(function (n) { wrap.appendChild(n); });
  });

  placeSpecial();
  buckets.nightorder.forEach(function (n) { card.appendChild(n); });

  /* ============================================================
     4. Advanced Options: credit fields, alternate art, and the
        jinx / sidebar-box / custom-JSON fieldsets.
        Auto-opens when anything inside already has content.
     ============================================================ */
  var det = null;
  if (buckets.advFld.length || buckets.advFs.length) {
    det = document.createElement('details');
    det.className = 'advanced';
    det.innerHTML =
      '<summary><span class="rsec-title">Advanced Options</span>' +
      '<span class="adv-sub">credits, alt art, jinxes, sidebar boxes, custom JSON</span>' +
      '<span class="adv-caret"></span></summary>';
    card.appendChild(det);
    buckets.advFld.forEach(function (n) { det.appendChild(n); });
    buckets.advFs.forEach(function (n) { det.appendChild(n); });

    // Textareas sized while the panel was shut measure 0; re-measure on open.
    det.addEventListener('toggle', function () { if (det.open) growAll(det); });

    // Note this counts values only: the editors seed an empty jinx row on
    // load, so the mere existence of a row means nothing.
    window.openAdvancedIfFilled = function () {
      var fields = det.querySelectorAll('input, textarea');
      for (var i = 0; i < fields.length; i++) {
        if (fields[i].value && fields[i].type !== 'hidden' && fields[i].type !== 'file') {
          det.open = true; return;
        }
      }
    };
  }

  /* ============================================================
     5. Sticky action bar: publish / draft / status
     ============================================================ */
  if (buckets.actions.length) {
    var bar = document.createElement('div');
    bar.className = 'ractions';
    card.appendChild(bar);
    buckets.actions.forEach(function (n) { bar.appendChild(n); });
  }

  /* ============================================================
     6. Auto-expanding text boxes.
        The pages size their own textareas on load; this adds a
        delegated handler so boxes created later (jinx rows, custom
        sidebar boxes, JSON autofill) are covered too.
     ============================================================ */
  function grow(ta) {
    if (!ta || ta.tagName !== 'TEXTAREA') return;
    ta.style.overflowY = 'hidden';
    ta.style.height = 'auto';
    ta.style.height = Math.max(ta.scrollHeight, 44) + 'px';
  }
  function growAll(scope) {
    Array.prototype.forEach.call((scope || document).querySelectorAll('textarea'), grow);
  }
  window.growAllTextareas = growAll;

  card.addEventListener('input', function (e) {
    if (e.target.tagName === 'TEXTAREA') grow(e.target);
  });

  ['jinxes', 'customboxes'].forEach(function (id) {
    var host = document.getElementById(id);
    if (!host || typeof MutationObserver !== 'function') return;
    new MutationObserver(function () { growAll(host); })
      .observe(host, { childList: true, subtree: true });
  });

  // Import & Autofill changes values without firing input events.
  var importBtn = document.getElementById('importjson');
  if (importBtn) {
    importBtn.addEventListener('click', function () {
      setTimeout(function () {
        growAll();
        if (window.openAdvancedIfFilled) window.openAdvancedIfFilled();
      }, 350);
    });
  }

  window.addEventListener('resize', function () { growAll(); });
  document.addEventListener('DOMContentLoaded', function () {
    growAll();
    if (window.openAdvancedIfFilled) window.openAdvancedIfFilled();
  });

  /* ============================================================
     7. Preview plaque: "updates as you type" with a pulse on refresh
     ============================================================ */
  var label = document.querySelector('.preview-label');
  if (label) {
    label.innerHTML =
      '<span>Live Preview</span>' +
      '<span class="pv-note"><span class="pv-dot" id="pv-dot"></span>updates as you type</span>';
    var dot = label.querySelector('#pv-dot');
    var t;
    card.addEventListener('input', function () {
      clearTimeout(t);
      t = setTimeout(function () {
        dot.classList.remove('flash');
        void dot.offsetWidth;
        dot.classList.add('flash');
      }, 260); // roughly matches the page's preview debounce
    });
  }
})();
