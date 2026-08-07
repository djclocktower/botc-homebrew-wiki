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
  var bar = null;
  var pop = null;
  var openEntry = null;
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

  function off() {
    try { localStorage.setItem(FLAG, '0'); } catch (e) {}
    document.documentElement.classList.remove('textedit-on');
    Array.prototype.forEach.call(document.querySelectorAll('.' + HIT), function (el) {
      el.classList.remove(HIT);
    });
    if (bar) bar.remove();
    closeEditor();
    index = null;
  }

  /* ---- the catalogue --------------------------------------------- */

  /* What each string currently SAYS on the page (an override may have
     changed it) paired with what it is called in the source file, which is
     the key every save is stored under. */
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
      var shown = (typeof replaced === 'string' && replaced) ? replaced : e.text;
      var slot = /\{[A-Za-z][\w-]*\}/.test(shown);
      var entry = {
        id: ++id,
        original: e.text,
        shown: shown,
        scope: e.scope,
        edited: typeof replaced === 'string',
        slot: slot,
        re: slot ? slotRe(shown) : null
      };
      all.push(entry);
      // A string with a {placeholder} does not appear on the page as written,
      // so its first word may be the placeholder's name and index to nothing.
      // There are only ever a handful: test them against everything.
      var first = slot ? null : words(shown)[0];
      if (first) (byWord[first] = byWord[first] || []).push(entry);
      else loose.push(entry);
    });
    // Longest first everywhere, so a whole sentence beats a phrase inside it.
    var bylen = function (a, b) { return b.shown.length - a.shown.length; };
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
  function matchIn(entry, text, from) {
    if (entry.re) {
      var m = entry.re.exec(from ? text.slice(from) : text);
      return m ? { at: m.index + (from || 0), len: m[0].length } : null;
    }
    var at = text.indexOf(entry.shown, from || 0);
    return at < 0 ? null : { at: at, len: entry.shown.length };
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

     So a short string is only offered when it IS the text that was
     double-clicked, or very nearly all of it. Longer strings (a whole
     sentence of the site's own prose) are safe on their own, but still have
     to sit on word boundaries. Anything this turns away is still there in the
     full list on /text-editor, where the source file is shown next to it. */
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

  function offers(text) {
    if (!text) return [];
    var whole = text.replace(/^\s+|\s+$/g, '').length;
    return candidates(text).filter(function (c) {
      if (c.len === whole) return true;                       // it is the text
      if (!bounded(text, c.at, c.len)) return false;          // mid-word: no
      return c.len >= STANDS_ALONE || c.len >= whole * 0.6;
    });
  }

  /* The element's OWN words, not its descendants': hovering a <strong> should
     offer the <strong>, and hovering the paragraph around it the paragraph. */
  function directText(el) {
    var out = '';
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) out += n.nodeValue;
    }
    return out;
  }

  function editableIn(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.closest('.te-live-ui') || el.closest(OPT_OUT)) return null;
    var hits = offers(directText(el));
    return hits.length ? hits[0].entry : null;
  }

  /* ---- the switch bar -------------------------------------------- */

  function makeBar() {
    bar = document.createElement('div');
    bar.className = 'te-live-bar te-live-ui';
    bar.innerHTML =
      '<span class="te-live-dot" aria-hidden="true"></span>' +
      '<span class="te-live-title">Text editing</span>' +
      '<span class="te-live-note" id="te-live-note">reading the site…</span>' +
      '<a class="te-live-link" href="/text-editor">All text</a>' +
      '<button class="te-live-off" type="button">Turn off</button>';
    bar.querySelector('.te-live-off').addEventListener('click', off);
    document.body.appendChild(bar);
  }

  function note(text) {
    var el = document.getElementById('te-live-note');
    if (el) el.textContent = text;
  }

  /* ---- the editor ------------------------------------------------- */

  function closeEditor() {
    if (pop) { pop.remove(); pop = null; }
    openEntry = null;
  }

  function openEditor(entry, x, y) {
    closeEditor();
    openEntry = entry;
    var slot = /\{[A-Za-z][\w-]*\}/.test(entry.original);

    pop = document.createElement('div');
    pop.className = 'te-live-pop te-live-ui';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Edit this wording');
    pop.innerHTML =
      '<div class="te-live-pop-head">' +
        '<strong>Edit this wording</strong>' +
        '<span class="te-live-scope">' +
          (entry.scope === '*' ? 'changes it everywhere' : 'changes it on this page') +
        '</span>' +
      '</div>' +
      '<textarea class="te-live-ta" spellcheck="true" rows="3"></textarea>' +
      '<p class="te-live-hint">' +
        (slot
          ? 'Keep the {…} exactly as it is — the site fills it in.'
          : (entry.edited
              ? 'Already edited. Undo puts the original wording back.'
              : 'Saved straight away, wherever this wording appears.')) +
      '</p>' +
      '<div class="te-live-acts">' +
        '<button class="te-live-btn" data-a="save" type="button">Save</button>' +
        (entry.edited ? '<button class="te-live-btn ghost" data-a="undo" type="button">Undo</button>' : '') +
        '<button class="te-live-btn ghost" data-a="cancel" type="button">Cancel</button>' +
        '<span class="te-live-say"></span>' +
      '</div>';
    document.body.appendChild(pop);

    var ta = pop.querySelector('textarea');
    ta.value = entry.shown;
    place(pop, x, y);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    pop.addEventListener('click', function (e) {
      var a = e.target.getAttribute && e.target.getAttribute('data-a');
      if (!a) return;
      if (a === 'cancel') return closeEditor();
      commit(entry, a === 'undo' ? entry.original : ta.value, a === 'undo');
    });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeEditor();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit(entry, ta.value, false);
    });
  }

  function place(el, x, y) {
    if (window.innerWidth <= 620) return;   // a bottom sheet; CSS positions it
    var w = el.offsetWidth, h = el.offsetHeight;
    var left = Math.max(10, Math.min(x - w / 2, window.innerWidth - w - 10));
    var top = y + 14;
    if (top + h > window.innerHeight - 10) top = Math.max(10, y - h - 14);
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }

  function commit(entry, value, undo) {
    var say = pop && pop.querySelector('.te-live-say');
    var btns = pop ? pop.querySelectorAll('.te-live-btn') : [];
    for (var i = 0; i < btns.length; i++) btns[i].disabled = true;
    if (say) { say.className = 'te-live-say'; say.textContent = 'Saving…'; }

    fetch('/api/admin/site-text', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: entry.scope,
        source: 'live edit',
        original: entry.original,
        replacement: undo ? '' : value,
        action: undo ? 'revert' : 'save'
      })
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, body: j }; });
    }).then(function (res) {
      for (var j = 0; j < btns.length; j++) btns[j].disabled = false;
      if (!res.ok) {
        if (say) { say.className = 'te-live-say err'; say.textContent = (res.body && res.body.error) || 'Could not save.'; }
        return;
      }
      closeEditor();
      // The page repaints itself from the refreshed map, then the index is
      // rebuilt so the same words can be edited again straight away.
      var done = window.SiteText && window.SiteText.refresh
        ? window.SiteText.refresh()
        : Promise.resolve();
      Promise.resolve(done).then(function () {
        var cached = window.TextScan && window.TextScan.loadCatalog && window.TextScan.loadCatalog();
        if (cached) index = buildIndex(cached.entries);
        note(undo ? 'put back' : 'saved');
        setTimeout(function () { note('double-click any wording'); }, 2500);
      });
    }).catch(function () {
      for (var k = 0; k < btns.length; k++) btns[k].disabled = false;
      if (say) { say.className = 'te-live-say err'; say.textContent = 'Could not reach the server.'; }
    });
  }

  /* ---- what was double-clicked ------------------------------------ */

  /* Prefer the entry that actually covers the spot that was clicked, so a
     paragraph made of several source strings opens the right one. */
  function entryAt(el, x, y) {
    var node = null, offset = -1;
    if (document.caretPositionFromPoint) {
      var cp = document.caretPositionFromPoint(x, y);
      if (cp) { node = cp.offsetNode; offset = cp.offset; }
    } else if (document.caretRangeFromPoint) {
      var r = document.caretRangeFromPoint(x, y);
      if (r) { node = r.startContainer; offset = r.startOffset; }
    }
    if (node && node.nodeType === 3) {
      var host = node.parentNode;
      if (host && !host.closest('.te-live-ui') && !host.closest(OPT_OUT)) {
        var hits = offers(node.nodeValue);
        // The one that actually covers the spot that was clicked, so a
        // paragraph stitched together from several source strings opens the
        // one under the pointer rather than the longest one in the line.
        for (var i = 0; i < hits.length; i++) {
          if (offset >= hits[i].at && offset <= hits[i].at + hits[i].len) return hits[i].entry;
        }
        if (hits.length) return hits[0].entry;
      }
    }
    return editableIn(el) || editableIn(el && el.parentElement);
  }

  function tryOpen(el, x, y) {
    if (!index) return;
    // One gesture, one box: a double-tap on a phone reaches this through both
    // the tap counter and the dblclick that follows it. Only swallow the
    // second one while the box from the first is still standing.
    if (pop && (Date.now() - lastOpenAt) < 500) return;
    if (el && el.closest && el.closest('.te-live-ui')) return;
    var entry = entryAt(el, x, y);
    if (!entry) {
      note('not the site’s own wording — try the full list');
      setTimeout(function () { note(index.all.length + ' strings · double-click any wording'); }, 2600);
      return;
    }
    lastOpenAt = Date.now();
    var sel = window.getSelection && window.getSelection();
    if (sel && sel.removeAllRanges) sel.removeAllRanges();
    openEditor(entry, x, y);
  }

  /* ---- events ----------------------------------------------------- */

  function wire() {
    document.addEventListener('mouseover', function (e) {
      if (!index || !e.target || e.target.nodeType !== 1) return;
      if (editableIn(e.target)) e.target.classList.add(HIT);
    }, true);
    document.addEventListener('mouseout', function (e) {
      if (e.target && e.target.nodeType === 1) e.target.classList.remove(HIT);
    }, true);

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
      if (!editableIn(el) && !editableIn(e.target)) return;
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
    index = buildIndex(entries);
    note(index.all.length + ' strings · double-click any wording');
    if (stale) refreshCatalog();
  }

  function loadScanner() {
    return new Promise(function (res) {
      if (window.TextScan) return res(window.TextScan);
      var s = document.createElement('script');
      s.src = '/assets/text-scan.js';
      s.onload = function () { res(window.TextScan || null); };
      s.onerror = function () { res(null); };
      document.head.appendChild(s);
    });
  }

  function refreshCatalog() {
    return loadScanner().then(function (TS) {
      if (!TS) { note('could not read the site’s files'); return; }
      note('reading the site…');
      return TS.scan({
        onProgress: function (done, total) { note('reading the site… ' + done + '/' + total); }
      }).then(function (res) {
        TS.saveCatalog(res.entries);
        index = buildIndex(res.entries);
        note(index.all.length + ' strings · double-click any wording');
      });
    }).catch(function () { note('could not read the site’s files'); });
  }

  function boot() {
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

  window.TextLive = { off: off, refresh: refreshCatalog };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
