/* Live text editing — browse the wiki, double-click any of its own wording,
   rewrite it in place.

   The switch lives on /text-editor and sets localStorage botc_text_edit=1;
   site.js checks that flag AND /api/me before it ever fetches this file, so a
   reader never loads it, and every save is checked again on the server.

   HOW IT KNOWS WHAT IS EDITABLE
   -----------------------------
   Only text the SITE wrote can be edited — a character's ability or somebody's
   comment must stay untouchable. The list of the site's own strings is the
   same catalogue /text-editor builds (text-scan.js), cached in localStorage
   and refreshed in the background when it goes stale. A piece of text that is
   not in the catalogue simply is not offered: that is the whole guard, and it
   is why this file never guesses from the shape of the page.

   Strings already rewritten are matched on what they now SAY, but saved under
   what the source file still says, so editing the same words twice updates one
   row rather than piling up.

   FINDING A MATCH FAST
   --------------------
   A catalogue is a couple of thousand strings and hover has to feel instant,
   so entries are bucketed by their first word. Testing a piece of text means
   looking up its own words and only then doing a substring check against the
   handful of candidates that come back.

   ONE BOX, SEVERAL PIECES
   -----------------------
   Overrides are applied to text nodes (site.js never touches markup), so a
   paragraph with a link in it is three strings: the words before the link,
   the link, the words after. A double-click opens the whole box the reader
   sees, one field per piece, so a paragraph can be rewritten in one go
   while its link keeps working. Pieces are matched on what the page said
   before any override (SiteText.sourceOf), which is what lets an edited or
   emptied piece be found and edited again.

   CLICKING VS EDITING
   -------------------
   Double-clicking a link would follow it on the first click, so while the
   mode is on a click on an editable link or button is held for a moment and
   replayed if no second click arrives. Everything that is not editable — a
   character card, a filter chip with somebody's name on it — clicks through
   with no delay at all. On a phone, double-tap does the same job; the page
   sets touch-action so the browser stops treating it as a zoom. */
(function () {
  'use strict';
  if (window.TextLive) return;

  var FLAG = 'botc_text_edit';
  var OPT_OUT = '[data-no-text-override],[contenteditable]';
  var INTERACTIVE = 'a[href],button,[role="button"],input[type="submit"],input[type="button"],summary,label';
  var HIT = 'te-live-hit';

  var index = null;        // {byWord: {word: [entry]}, loose: [entry], all: [entry]}
  var active = false;      // the mode is on; nothing may set `index` while it is off
  var wired = false;
  var bar = null;
  var pop = null;
  var lit = null;           // the box being edited, outlined while the editor is open
  var hovered = null;
  var lastUndo = null;      // the changes that put back what the last save replaced
  var undoTimer = null;
  var pendingClick = null;
  var replaying = false;
  var lastOpenAt = 0;
  var lastTap = { at: 0, target: null };

  /* ---------------------------------------------------------------- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function words(s) {
    return String(s).toLowerCase().match(/[a-z0-9À-ɏ]+/g) || [];
  }

  /* Off is real: the listeners stay attached (they are cheap and all bail
     on a null index) but nothing can put an index back while `active` is
     false — a catalogue scan still in flight when the switch was flipped used
     to finish, set the index and switch editing straight back on. */
  function off() {
    active = false;
    try { localStorage.setItem(FLAG, '0'); } catch (e) {}
    clearTimeout(pendingClick); pendingClick = null;
    document.documentElement.classList.remove('textedit-on');
    Array.prototype.forEach.call(document.querySelectorAll('.' + HIT), function (el) {
      el.classList.remove(HIT);
    });
    hovered = null;
    if (bar) { bar.remove(); bar = null; }
    closeEditor();
    index = null;
  }

  function setIndex(entries) {
    if (!active) return false;
    index = buildIndex(entries);
    return true;
  }

  /* Somebody's writing is never offered, even where a catalogued phrase sits
     inside it: site.js would not apply the override there, so offering it
     would only rewrite the site's copy somewhere else. */
  function skipped(el) {
    if (!el) return true;
    if (el.closest('.te-live-ui') || el.closest(OPT_OUT)) return true;
    return !!(window.SiteText && window.SiteText.skip && window.SiteText.skip(el));
  }

  /* ---- the catalogue --------------------------------------------- */

  /* Entries are matched against what the page said BEFORE any override
     (SiteText.sourceOf), so they are keyed by the source file's wording;
     `shown` is only what the editor opens on. An empty `shown` is wording
     that was removed. */
  function buildIndex(entries) {
    var overrides = {};
    if (window.SiteText && window.SiteText.items) {
      window.SiteText.items().forEach(function (it) {
        if (it && it.o && typeof it.r === 'string') overrides[it.s + '\n' + it.o] = it.r;
      });
    }

    var all = [], byWord = {}, loose = [], id = 0;
    entries.forEach(function (e) {
      if (!e.text || !window.SiteText || !window.SiteText.inScope(e.scope)) return;
      var replaced = overrides[e.scope + '\n' + e.text];
      var edited = typeof replaced === 'string' && replaced !== e.text;
      var slot = /\{[A-Za-z][\w-]*\}/.test(e.text);
      var entry = {
        id: ++id,
        original: e.text,
        shown: edited ? replaced : e.text,
        scope: e.scope,
        edited: edited,
        slot: slot,
        re: slot ? slotRe(e.text) : null
      };
      all.push(entry);
      // A string with a {placeholder} does not appear on the page as written,
      // so its first word may be the placeholder's name and index to nothing.
      // There are only ever a handful: test them against everything.
      var first = slot ? null : words(e.text)[0];
      if (first) (byWord[first] = byWord[first] || []).push(entry);
      else loose.push(entry);
    });
    // Longest first everywhere, so a whole sentence beats a phrase inside it.
    var bylen = function (a, b) { return b.original.length - a.original.length; };
    all.sort(bylen);
    loose.sort(bylen);
    for (var k in byWord) if (Object.prototype.hasOwnProperty.call(byWord, k)) byWord[k].sort(bylen);
    return { all: all, byWord: byWord, loose: loose };
  }

  /* "Add {missing} to fix." reaches the page as "Add tags to fix.", so a
     string with a slot in it is matched by shape rather than by equality. */
  function slotRe(s) {
    var pattern = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\{[A-Za-z][\w-]*\\\}/g, '[\\s\\S]{0,300}?');
    return new RegExp(pattern);
  }

  /* Where an entry sits inside `text`, or null. */
  function matchIn(entry, text) {
    if (entry.re) {
      var m = entry.re.exec(text);
      return m ? { at: m.index, len: m[0].length } : null;
    }
    var at = text.indexOf(entry.original);
    return at < 0 ? null : { at: at, len: entry.original.length };
  }

  /* Every catalogue entry that appears inside `text`, longest first. */
  function candidates(text) {
    if (!index || !text) return [];
    var picked = {}, seen = [], out = [], list = words(text), i, j;
    for (i = 0; i < list.length; i++) {
      var bucket = index.byWord[list[i]];
      if (!bucket) continue;
      for (j = 0; j < bucket.length; j++) {
        if (picked[bucket[j].id]) continue;
        picked[bucket[j].id] = 1;
        seen.push(bucket[j]);
      }
    }
    for (i = 0; i < index.loose.length; i++) seen.push(index.loose[i]);
    for (i = 0; i < seen.length; i++) {
      var hit = matchIn(seen[i], text);
      if (hit) out.push({ entry: seen[i], at: hit.at, len: hit.len });
    }
    return out.sort(function (a, b) { return b.len - a.len; });
  }

  /* THE GUARD.

     A phrase can be genuinely part of the site's own files and still turn up
     in the middle of somebody's writing — "Each night" is a sort rule in
     sao.js and also the opening of half the abilities on the wiki. Rewriting
     it site-wide from a character page is never what was meant.

     So a short string is only offered when it IS the text of its piece of
     the page, or very nearly all of it. Longer strings (a whole sentence of
     the site's own prose) are safe on their own, but still have to sit on
     word boundaries. Anything this turns away is still there in the full
     list on /text-editor, where the source file is shown next to it. */
  var STANDS_ALONE = 25;

  function bounded(text, at, len) {
    var before = at === 0 ? '' : text.charAt(at - 1);
    var after = text.charAt(at + len) || '';
    var starts = text.charAt(at), ends = text.charAt(at + len - 1);
    var word = /[A-Za-z0-9]/;
    if (word.test(before) && word.test(starts)) return false;
    if (word.test(after) && word.test(ends)) return false;
    return true;
  }

  /* The entries a piece of text offers, longest first and never overlapping
     (a phrase inside a sentence already offered is the sentence's). */
  function offers(text) {
    if (!text) return [];
    var whole = text.replace(/^\s+|\s+$/g, '').length;
    var taken = [];
    return candidates(text).filter(function (c) {
      if (c.len !== whole) {
        if (!bounded(text, c.at, c.len)) return false;          // mid-word: no
        if (c.len < STANDS_ALONE && c.len < whole * 0.6) return false;
      }
      for (var i = 0; i < taken.length; i++) {
        if (c.at < taken[i].at + taken[i].len && taken[i].at < c.at + c.len) return false;
      }
      taken.push(c);
      return true;
    }).sort(function (a, b) { return a.at - b.at; });
  }

  /* ---- the box ------------------------------------------------------ */

  /* A paragraph with a link in it is three text nodes, and so three strings
     in the catalogue ("…listed on", "Creators", ". Script makers…"). The
     reader sees one box, so a double-click opens the whole box: the nearest
     element that is not laid out inline, with every editable piece in it. */
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, TEMPLATE: 1, SELECT: 1, OPTION: 1 };

  function isInline(el) {
    var d = window.getComputedStyle(el).display;
    return d === 'inline' || d === 'contents';
  }

  function blockOf(el) {
    while (el && el.nodeType === 1 && el !== document.body && isInline(el) && el.parentElement) {
      el = el.parentElement;
    }
    return el && el.nodeType === 1 ? el : null;
  }

  /* What sort of thing a piece of text is, for the label over its box. */
  function kindOf(node, box) {
    for (var el = node.parentElement; el && el !== box.parentElement; el = el.parentElement) {
      if (el.matches('a[href]')) return 'Link text';
      if (el.matches('button,[role="button"],summary')) return 'Button';
      if (el.matches('h1,h2,h3,h4,h5,h6')) return 'Heading';
      if (el.matches('label')) return 'Label';
      if (el === box) break;
    }
    return 'Text';
  }

  /* The box's pieces in reading order: {node, entry} for wording that can be
     edited, {node, fixed} for the rest (somebody's name, a number). Text in
     a nested box (a list item inside this one) belongs to that box. */
  function piecesIn(box) {
    if (!box || skipped(box)) return [];
    var out = [], walker = document.createTreeWalker(box, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (n.nodeType === 1) {
          if (SKIP_TAGS[n.nodeName] || skipped(n) || !isInline(n)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var n;
    while ((n = walker.nextNode())) {
      var src = window.SiteText && window.SiteText.sourceOf ? window.SiteText.sourceOf(n) : n.nodeValue;
      if (!src || !/\S/.test(src)) continue;
      var hits = offers(src), from = 0;
      for (var i = 0; i < hits.length; i++) {
        var gap = src.slice(from, hits[i].at);
        if (/\S/.test(gap)) out.push({ node: n, fixed: gap });
        out.push({ node: n, entry: hits[i].entry, at: hits[i].at, len: hits[i].len });
        from = hits[i].at + hits[i].len;
      }
      var tail = src.slice(from);
      // A node an override emptied shows nothing, so it has no fixed text.
      if (/\S/.test(tail) && (n.nodeValue || hits.length)) out.push({ node: n, fixed: tail });
    }
    return out;
  }

  function editable(pieces) {
    for (var i = 0; i < pieces.length; i++) if (pieces[i].entry) return true;
    return false;
  }

  /* ---- the switch bar -------------------------------------------- */

  function makeBar() {
    bar = document.createElement('div');
    bar.className = 'te-live-bar te-live-ui';
    bar.innerHTML =
      '<span class="te-live-dot" aria-hidden="true"></span>' +
      '<span class="te-live-title">Text editing</span>' +
      '<span class="te-live-note" id="te-live-note">reading the site…</span>' +
      '<button class="te-live-undo" type="button" hidden>Undo</button>' +
      '<a class="te-live-link" href="/text-editor">All text</a>' +
      '<button class="te-live-off" type="button">Turn off</button>';
    bar.querySelector('.te-live-off').addEventListener('click', off);
    bar.querySelector('.te-live-undo').addEventListener('click', undoLast);
    document.body.appendChild(bar);
  }

  function note(text) {
    var el = document.getElementById('te-live-note');
    if (el) el.textContent = text;
  }

  function idleNote() {
    if (index) note(index.all.length + ' strings · double-click any wording');
  }

  /* ---- the editor ------------------------------------------------- */

  function closeEditor() {
    if (pop) { pop.remove(); pop = null; }
    if (lit) { lit.classList.remove('te-live-editing'); lit = null; }
  }

  function scopeTag(entry) {
    return '<span class="te-live-scope">' +
      (entry.scope === '*' ? 'changes it everywhere' : 'changes it on this page') + '</span>';
  }

  function grow(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight + 2, 320) + 'px';
  }

  /* `pieces` is the whole box; `focus` the entry under the pointer. */
  function openEditor(box, pieces, focus, x, y) {
    closeEditor();
    lit = box;
    box.classList.add('te-live-editing');

    var fields = [], seen = {}, rows = '', i;
    for (i = 0; i < pieces.length; i++) {
      var p = pieces[i];
      if (p.fixed) {
        rows += '<p class="te-live-fixed" title="Not the site’s own wording, so it is not edited here">' +
          esc(p.fixed.replace(/\s+/g, ' ').trim().slice(0, 140)) + '</p>';
        continue;
      }
      if (seen[p.entry.id]) continue;      // the same words twice in one box: one field
      seen[p.entry.id] = 1;
      var f = fields.length;
      fields.push(p.entry);
      rows +=
        '<div class="te-live-field" data-f="' + f + '">' +
          '<div class="te-live-field-head">' +
            '<span class="te-live-kind">' + esc(kindOf(p.node, box)) + '</span>' +
            scopeTag(p.entry) +
            (p.entry.edited ? '<button class="te-live-orig" type="button" data-orig="' + f + '">Put back the original</button>' : '') +
          '</div>' +
          '<textarea class="te-live-ta" spellcheck="true" rows="1"></textarea>' +
          (p.entry.slot ? '<p class="te-live-hint">Keep the {…} exactly as it is — the site fills it in.</p>' : '') +
        '</div>';
    }

    pop = document.createElement('div');
    pop.className = 'te-live-pop te-live-ui';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Edit this wording');
    pop.innerHTML =
      '<div class="te-live-pop-head">' +
        '<strong>Edit this ' + (fields.length > 1 ? 'box' : 'wording') + '</strong>' +
        '<button class="te-live-x" type="button" data-a="cancel" aria-label="Close">' +
          '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' +
        '</button>' +
      '</div>' +
      '<div class="te-live-fields">' + rows + '</div>' +
      '<p class="te-live-hint">' +
        (fields.length > 1 ? 'Links and buttons are separate pieces, so each keeps working. ' : '') +
        'Empty a box to remove that wording. Ctrl+Enter saves.' +
      '</p>' +
      '<div class="te-live-acts">' +
        '<button class="te-live-btn" data-a="save" type="button">Save</button>' +
        '<button class="te-live-btn ghost" data-a="cancel" type="button">Cancel</button>' +
        '<span class="te-live-say" role="status"></span>' +
      '</div>';
    document.body.appendChild(pop);

    var tas = pop.querySelectorAll('textarea'), first = null;
    for (i = 0; i < tas.length; i++) {
      tas[i].value = fields[i].shown;
      tas[i].addEventListener('input', function () { grow(this); });
      if (fields[i] === focus) first = tas[i];
    }
    place(pop, x, y);
    for (i = 0; i < tas.length; i++) grow(tas[i]);
    first = first || tas[0];
    if (first) {
      first.focus();
      first.setSelectionRange(first.value.length, first.value.length);
    }

    pop.addEventListener('click', function (e) {
      var t = e.target.closest && e.target.closest('[data-a],[data-orig]');
      if (!t) return;
      if (t.hasAttribute('data-orig')) {
        var k = +t.getAttribute('data-orig');
        tas[k].value = fields[k].original;
        grow(tas[k]);
        tas[k].focus();
        return;
      }
      if (t.getAttribute('data-a') === 'cancel') return closeEditor();
      save(fields, tas);
    });
    pop.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeEditor();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(fields, tas); }
    });
  }

  function place(el, x, y) {
    if (window.innerWidth <= 620) return;   // a bottom sheet; CSS positions it
    var w = el.offsetWidth, h = el.offsetHeight;
    var left = Math.max(10, Math.min(x - w / 2, window.innerWidth - w - 10));
    var top = y + 14;
    if (top + h > window.innerHeight - 10) top = Math.max(10, y - h - 14);
    if (top + h > window.innerHeight - 10) top = Math.max(10, window.innerHeight - h - 10);
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }

  /* What a field's value asks the server to do with its entry. */
  function changeFor(entry, value) {
    if (value === entry.shown) return null;
    if (value === entry.original) return { entry: entry, action: 'revert', replacement: '' };
    if (!value.trim()) return { entry: entry, action: 'remove', replacement: '' };
    return { entry: entry, action: 'save', replacement: value };
  }

  /* The opposite of a change, for the bar's Undo: what the entry said before. */
  function inverseOf(c) {
    var e = c.entry;
    if (!e.edited) return { entry: e, action: 'revert', replacement: '' };
    if (!e.shown) return { entry: e, action: 'remove', replacement: '' };
    return { entry: e, action: 'save', replacement: e.shown };
  }

  function post(c) {
    return fetch('/api/admin/site-text', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: c.entry.scope,
        source: 'live edit',
        original: c.entry.original,
        replacement: c.replacement,
        action: c.action,
        // A short phrase only reaches this box when it IS its piece of the
        // page (the guard above), and the field says "changes it everywhere" beside it —
        // that is the confirmation the server asks for.
        confirmShort: true
      })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || 'Could not save.');
        return j;
      });
    });
  }

  /* One request per changed piece, in order; stops at the first refusal so
     the box says which one and keeps what was typed. */
  function postAll(list) {
    return list.reduce(function (p, c) { return p.then(function () { return post(c); }); }, Promise.resolve());
  }

  function save(fields, tas) {
    var changes = [];
    for (var i = 0; i < fields.length; i++) {
      var c = changeFor(fields[i], tas[i].value);
      if (c) changes.push(c);
    }
    if (!changes.length) return closeEditor();
    var say = pop.querySelector('.te-live-say');
    var btns = pop.querySelectorAll('.te-live-btn');
    var busy = function (b) { for (var k = 0; k < btns.length; k++) btns[k].disabled = b; };
    busy(true);
    say.className = 'te-live-say'; say.textContent = 'Saving…';
    var undo = changes.map(inverseOf);
    postAll(changes).then(function () {
      closeEditor();
      return settle(undo, changes.some(function (c) { return c.action === 'remove'; }) ? 'removed' : 'saved');
    }).catch(function (err) {
      busy(false);
      say.className = 'te-live-say err';
      say.textContent = err && err.message && err.message !== 'Failed to fetch' ? err.message : 'Could not reach the server.';
      settle(null);    // a piece saved before the refusal still shows
    });
  }

  /* The page repaints itself from the refreshed map, then the index is
     rebuilt so the same words can be edited again straight away. */
  function settle(undo, said) {
    var done = window.SiteText && window.SiteText.refresh ? window.SiteText.refresh() : Promise.resolve();
    return Promise.resolve(done).then(function () {
      var cached = window.TextScan && window.TextScan.loadCatalog && window.TextScan.loadCatalog();
      if (cached) setIndex(cached.entries);
      if (!said) return;
      lastUndo = undo;
      note(said);
      showUndo(true);
      clearTimeout(undoTimer);
      undoTimer = setTimeout(function () { showUndo(false); idleNote(); }, 10000);
    });
  }

  function showUndo(on) {
    var b = bar && bar.querySelector('.te-live-undo');
    if (b) b.hidden = !on;
    if (!on) lastUndo = null;
  }

  function undoLast() {
    var undo = lastUndo;
    if (!undo) return;
    showUndo(false);
    clearTimeout(undoTimer);
    note('undoing…');
    postAll(undo).then(function () {
      return settle(null).then(function () { note('undone'); setTimeout(idleNote, 2500); });
    }).catch(function () { note('could not undo — use All text'); });
  }

  /* ---- what was double-clicked ------------------------------------ */

  /* The text node and offset under the pointer, when the browser says. */
  function caretAt(x, y) {
    if (document.caretPositionFromPoint) {
      var cp = document.caretPositionFromPoint(x, y);
      if (cp) return { node: cp.offsetNode, offset: cp.offset };
    } else if (document.caretRangeFromPoint) {
      var r = document.caretRangeFromPoint(x, y);
      if (r) return { node: r.startContainer, offset: r.startOffset };
    }
    return null;
  }

  function tryOpen(el, x, y) {
    if (!index) return;
    // One gesture, one box: a double-tap on a phone reaches this through both
    // the tap counter and the dblclick that follows it. Only swallow the
    // second one while the box from the first is still standing.
    if (pop && (Date.now() - lastOpenAt) < 500) return;
    if (el && el.closest && el.closest('.te-live-ui')) return;
    var caret = caretAt(x, y);
    var start = caret && caret.node && caret.node.nodeType === 3 ? caret.node.parentElement : el;
    var box = blockOf(start), pieces = piecesIn(box);
    if (!editable(pieces) && start !== el) { box = blockOf(el); pieces = piecesIn(box); }
    if (!editable(pieces)) {
      note('not the site’s own wording — try All text');
      setTimeout(idleNote, 2600);
      return;
    }
    // Focus the piece under the pointer, so a box stitched together from
    // several source strings opens on the one that was clicked.
    var focus = null;
    for (var i = 0; i < pieces.length && caret; i++) {
      var p = pieces[i];
      if (p.entry && p.node === caret.node && caret.offset >= p.at && caret.offset <= p.at + p.len) focus = p.entry;
    }
    lastOpenAt = Date.now();
    var sel = window.getSelection && window.getSelection();
    if (sel && sel.removeAllRanges) sel.removeAllRanges();
    openEditor(box, pieces, focus, x, y);
  }

  /* Is the wording of this link or button (not just its box) editable? */
  function labelEditable(el) {
    var pieces = piecesIn(blockOf(el));
    for (var i = 0; i < pieces.length; i++) {
      if (pieces[i].entry && el.contains(pieces[i].node)) return true;
    }
    return false;
  }

  /* ---- events ----------------------------------------------------- */

  function wire() {
    if (wired) return;
    wired = true;
    // The box a double-click would open is the one outlined on hover.
    document.addEventListener('mouseover', function (e) {
      if (!index || !e.target || e.target.nodeType !== 1 || e.target.closest('.te-live-ui')) return;
      var box = blockOf(e.target);
      if (box === hovered) return;
      if (hovered) hovered.classList.remove(HIT);
      hovered = box && editable(piecesIn(box)) ? box : null;
      if (hovered) hovered.classList.add(HIT);
    }, true);
    document.addEventListener('mouseleave', function () {
      if (hovered) hovered.classList.remove(HIT);
      hovered = null;
    });

    document.addEventListener('dblclick', function (e) {
      if (!index) return;
      if (e.target && e.target.closest && e.target.closest('.te-live-ui')) return;
      clearTimeout(pendingClick); pendingClick = null;
      e.preventDefault();
      tryOpen(e.target, e.clientX, e.clientY);
    }, true);

    // Phones: a second tap on the same element inside 400ms. touch-action on
    // the page has already stopped the browser reading it as a zoom.
    document.addEventListener('pointerup', function (e) {
      if (!index || e.pointerType !== 'touch') return;
      var now = Date.now();
      if (lastTap.target === e.target && (now - lastTap.at) < 400) {
        lastTap = { at: 0, target: null };
        clearTimeout(pendingClick); pendingClick = null;
        tryOpen(e.target, e.clientX, e.clientY);
        return;
      }
      lastTap = { at: now, target: e.target };
    }, true);

    /* A link or button whose LABEL is editable holds its click for a moment,
       in case a second one is coming. Anything else — a character card, a
       creator's name — is not touched, so browsing stays exactly as fast as
       it was. */
    document.addEventListener('click', function (e) {
      if (!index || replaying) return;
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var el = e.target && e.target.closest ? e.target.closest(INTERACTIVE) : null;
      if (!el || el.closest('.te-live-ui')) return;
      if (!labelEditable(el)) return;
      e.preventDefault();
      e.stopPropagation();
      clearTimeout(pendingClick);
      pendingClick = setTimeout(function () {
        pendingClick = null;
        replaying = true;
        try { el.click(); } finally { replaying = false; }
      }, 320);
    }, true);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && pop) closeEditor();
    });

    // A click anywhere off the box puts it away, the way any other popover
    // on the site behaves.
    document.addEventListener('mousedown', function (e) {
      if (!pop || !e.target || !e.target.closest) return;
      if (!e.target.closest('.te-live-pop')) closeEditor();
    }, true);
  }

  /* ---- start ------------------------------------------------------ */

  function useCatalog(entries, stale) {
    if (!setIndex(entries)) return;
    idleNote();
    if (stale) refreshCatalog();
  }

  function loadScanner() {
    return new Promise(function (res) {
      if (window.TextScan) return res(window.TextScan);
      var s = document.createElement('script');
      s.src = window.BotcData.asset('text-scan.js');
      s.onload = function () { res(window.TextScan || null); };
      s.onerror = function () { res(null); };
      document.head.appendChild(s);
    });
  }

  function refreshCatalog() {
    if (!active) return Promise.resolve();
    return loadScanner().then(function (TS) {
      if (!TS) { note('could not read the site’s files'); return; }
      note('reading the site…');
      return TS.scan({
        onProgress: function (done, total) { note('reading the site… ' + done + '/' + total); }
      }).then(function (res) {
        TS.saveCatalog(res.entries);
        if (!setIndex(res.entries)) return;
        idleNote();
      });
    }).catch(function () { note('could not read the site’s files'); });
  }

  function boot() {
    if (active) return;
    active = true;
    document.documentElement.classList.add('textedit-on');
    makeBar();
    wire();
    var cached = window.TextScan && window.TextScan.loadCatalog
      ? window.TextScan.loadCatalog()
      : null;
    if (cached) return useCatalog(cached.entries, cached.stale);
    // No cache yet (first page after turning it on somewhere else).
    loadScanner().then(function (TS) {
      var c = TS && TS.loadCatalog();
      if (c) return useCatalog(c.entries, c.stale);
      return refreshCatalog();
    });
  }

  /* on() is what /text-editor calls when the switch is flipped back on in
     the same visit; the script is already loaded by then, so loading it
     again would do nothing at all. */
  function on() {
    try { localStorage.setItem(FLAG, '1'); } catch (e) {}
    boot();
  }

  window.TextLive = { on: on, off: off, refresh: refreshCatalog };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
