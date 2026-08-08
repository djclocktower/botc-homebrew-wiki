/* ── System text overrides (the /text-editor page) ─────────────────────────
   Wording the owner has rewritten on /text-editor, applied to this page as it
   renders. The catalogue of editable strings is built in the browser by
   text-scan.js; only the strings that were actually CHANGED are stored, and
   only those come down here, so this whole block does nothing on a site with
   no edits.

   It rewrites text nodes and the handful of reader-visible attributes —
   never markup, never innerHTML — so an override can change words and
   nothing else. A MutationObserver re-runs it on anything rendered later,
   which is what covers the client-rendered pages (browse lists, comments,
   editor previews) and content that loads after the first paint.

   Two things decide what is safe to touch:
     - scope. An override made from a string found on exactly one page only
       applies on that page; one from a shared assets/*.js file (or found on
       several pages, like the topbar and footer) applies site-wide.
     - opt-out. Anything inside [data-no-text-override] or a contenteditable
       is left alone.

   The map is kept in localStorage so a repeat visit applies it immediately
   instead of flashing the original wording, but it is re-fetched on every
   page load all the same — the stored copy buys the first paint, never a
   skipped request, or an edit would outlive several reloads. This runs first
   in the file on purpose: the sooner it goes, the less there is to see. */
(function () {
  var KEY = 'botc_site_text';
  var ATTRS = ['placeholder', 'title', 'alt', 'aria-label'];
  var ATTR_SEL = '[placeholder],[title],[alt],[aria-label]';
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, TEMPLATE: 1 };
  var OBS = { childList: true, subtree: true, characterData: true };
  var rules = [];
  var undoRules = [];     // reverses what is already on the page; one pass only
  var allItems = [];      // the map as it stands
  var appliedItems = [];  // the map the page currently reflects
  var minLen = 0;
  var observer = null;

  function here() {
    var p = location.pathname.replace(/\.html$/, '');
    if (p.length > 1) p = p.replace(/\/+$/, '');
    return (p === '' || p === '/index') ? '/' : p;
  }
  function inScope(scope) {
    if (!scope || scope === '*') return true;
    var want = scope.replace(/\.html$/, '');
    if (want.length > 1) want = want.replace(/\/+$/, '');
    if (want === '' || want === '/index') want = '/';
    return here() === want;
  }

  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /* A {placeholder} in the original marks a slot the site fills in (the list
     of missing bits in the Partial banner, say). Those become a capture group
     so the filled-in value survives into the replacement. */
  function compile(item) {
    if (/\{[A-Za-z][\w-]*\}/.test(item.o)) {
      var names = [];
      var pattern = escRe(item.o).replace(/\\\{([A-Za-z][\w-]*)\\\}/g, function (m, n) {
        names.push(n);
        return '([\\s\\S]{0,300}?)';
      });
      return { re: new RegExp(pattern, 'g'), names: names, from: item.o, to: item.r };
    }
    return { from: item.o, to: item.r };
  }

  function filler(rule) {
    return function () {
      var args = arguments;
      return rule.to.replace(/\{([A-Za-z][\w-]*)\}/g, function (m, n) {
        var i = rule.names.indexOf(n);
        return i >= 0 ? (args[i + 1] == null ? '' : args[i + 1]) : m;
      });
    };
  }

  function rewrite(text) {
    if (!text || text.length < minLen) return text;
    // Undo first, then the current wording. The undo pass puts back what the
    // source file says before the new rules go on, so an override that was
    // deleted or rewritten does not leave the old words sitting on the page.
    return pass(pass(text, undoRules), rules);
  }

  function pass(text, list) {
    var out = text;
    for (var i = 0; i < list.length; i++) {
      var rule = list[i];
      if (rule.re) {
        rule.re.lastIndex = 0;
        if (!rule.re.test(out)) continue;
        rule.re.lastIndex = 0;
        out = out.replace(rule.re, filler(rule));
      } else if (out.indexOf(rule.from) >= 0) {
        out = out.split(rule.from).join(rule.to);
      }
    }
    return out;
  }

  function patchAttrs(root, anyOptOut) {
    if (!root || !root.querySelectorAll) return;
    var list = Array.prototype.slice.call(root.querySelectorAll(ATTR_SEL));
    if (root.nodeType === 1 && root.matches && root.matches(ATTR_SEL)) list.push(root);
    for (var i = 0; i < list.length; i++) {
      if (anyOptOut && optedOut(list[i])) continue;
      for (var a = 0; a < ATTRS.length; a++) {
        var el = list[i], name = ATTRS[a];
        if (!el.hasAttribute(name)) continue;
        var v = el.getAttribute(name), out = rewrite(v);
        if (out !== v) el.setAttribute(name, out);
      }
    }
  }

  function patchText(node) {
    var v = node.nodeValue;
    if (!v) return;
    var out = rewrite(v);
    if (out !== v) node.nodeValue = out;
  }

  var OPT_OUT = '[data-no-text-override],[contenteditable]';
  function optedOut(node) {
    var el = node.nodeType === 1 ? node : node.parentNode;
    return !!(el && el.closest && el.closest(OPT_OUT));
  }

  function walk(root) {
    if (!root) return;
    // Asked against the whole document, not `root`: the observer hands us
    // nodes from inside an opted-out container (the text editor's own list of
    // strings, which must show them as they are), and a container's marker is
    // above those nodes, not inside them.
    var anyOptOut = !!document.querySelector(OPT_OUT);
    if (anyOptOut && optedOut(root)) return;
    if (root.nodeType === 3) { patchText(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    var doc = root.ownerDocument || document;
    var walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var p = n.parentNode;
        if (!p || SKIP_TAGS[p.nodeName]) return NodeFilter.FILTER_REJECT;
        if (anyOptOut && optedOut(n)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var n, list = [];
    while ((n = walker.nextNode())) list.push(n);
    for (var i = 0; i < list.length; i++) patchText(list[i]);
    patchAttrs(root, anyOptOut);
  }

  function applyAll() {
    if (!rules.length && !undoRules.length) return;
    if (observer) observer.disconnect();
    walk(document.body || document.documentElement);
    var t = rewrite(document.title);
    if (t !== document.title) document.title = t;
    if (observer && document.body) { observer.takeRecords(); observer.observe(document.body, OBS); }
  }

  function startObserver() {
    if (observer || !window.MutationObserver || !document.body) return;
    observer = new MutationObserver(function (records) {
      var touched = [], i, j;
      for (i = 0; i < records.length; i++) {
        if (records[i].type === 'characterData') touched.push(records[i].target);
        else for (j = 0; j < records[i].addedNodes.length; j++) touched.push(records[i].addedNodes[j]);
      }
      if (!touched.length) return;
      // Our own edits must not wake the observer again: drop the records we
      // generate while patching, then start listening afresh.
      observer.disconnect();
      for (i = 0; i < touched.length; i++) walk(touched[i]);
      observer.takeRecords();
      observer.observe(document.body, OBS);
    });
    observer.observe(document.body, OBS);
  }

  function usable(it) {
    return it && it.o && typeof it.r === 'string' && it.r && it.o !== it.r && inScope(it.s);
  }
  var bylen = function (a, b) { return b.o.length - a.o.length; };

  function setItems(items) {
    allItems = items || [];

    // Everything already painted onto this page, backwards. Rebuilt on every
    // change, because "undo" and "change it again" both need the source
    // wording back before the new wording can go on.
    undoRules = appliedItems.filter(usable)
      .map(function (it) { return { o: it.r, r: it.o, s: it.s }; })
      .sort(bylen).map(compile);

    // Longest first, so an override of a whole sentence wins over one of a
    // phrase inside it.
    rules = allItems.filter(usable).sort(bylen).map(compile);

    var all = rules.concat(undoRules);
    minLen = all.length ? Math.min.apply(null, all.map(function (r) {
      // a rule with a {placeholder} can match something shorter than itself
      return r.re ? 1 : r.from.length;
    })) : 0;
  }

  function run() {
    if (!rules.length && !undoRules.length) return;
    applyAll();
    startObserver();
    // The page now reflects the current map, and the undo pass is spent —
    // content rendered from here on only needs the forward rules.
    appliedItems = allItems.slice();
    undoRules = [];
  }

  function refresh() {
    // cache:'no-store' matters as much as the header does — without it a
    // refresh right after a save can be answered from the browser's own copy.
    return fetch('/api/site-text', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var items = (d && d.items) || [];
        try { localStorage.setItem(KEY, JSON.stringify({ ts: Date.now(), items: items })); } catch (e) {}
        setItems(items);
        run();
        return items;
      })
      .catch(function () { return null; });
  }

  // The stored copy is for PAINT SPEED, not for saving requests: it goes on
  // immediately so a repeat visit never flashes the old wording, and then the
  // real map is fetched on every single page load. An earlier version treated
  // it as a two-minute cache and skipped the fetch, which meant an edit could
  // survive several reloads — worse than a flash by a long way.
  var cached = null;
  try { cached = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) {}
  if (cached && cached.items) { setItems(cached.items); run(); }
  refresh();

  // /text-editor calls refresh() after a save so the change shows at once;
  // text-live.js reads items()/inScope() to know what a piece of text on the
  // page was called in the source file before it was rewritten.
  window.SiteText = {
    refresh: refresh,
    apply: applyAll,
    items: function () { return allItems.slice(); },
    inScope: inScope,
    here: here
  };
})();

/* ── Live text editing (admin, opt-in) ────────────────────────────────────
   The switch on /text-editor turns on a mode where the admin browses the
   wiki normally and double-clicks any of the site's own wording to rewrite
   it in place. Everything it needs lives in assets/text-live.js, which is
   fetched only when the flag is set AND the reader really is an admin — a
   reader who sets the flag by hand gets nothing, and every save is checked
   again on the server. */
(function () {
  var FLAG = 'botc_text_edit';
  var on = false;
  try { on = localStorage.getItem(FLAG) === '1'; } catch (e) {}
  if (!on || window.TextLive) return;

  function me() {
    try {
      var raw = JSON.parse(sessionStorage.getItem('botc_me'));
      if (raw && (Date.now() - raw.ts) < 60 * 1000) return Promise.resolve(raw.me);
    } catch (e) {}
    return fetch('/api/me', { credentials: 'same-origin' }).then(function (r) { return r.json(); });
  }

  me().then(function (u) {
    if (!u || !u.loggedIn || !u.isAdmin) return;
    var s = document.createElement('script');
    s.src = '/assets/text-live.js';   // absolute: this also runs under /c/, /s/, /p/
    document.head.appendChild(s);
  }).catch(function () {});
})();

/* Shared site behaviours: search, mobile nav, script-count badge.
   Root-aware: derives the path prefix from the stylesheet href so it works
   from the site root and from subdirectories like /c/. */
(function () {
  var ROOT = (function () {
    var s = document.querySelector('link[rel="stylesheet"]');
    if (!s) return '';
    return s.getAttribute('href').replace('assets/styles.css', '');
  })();

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Does this <a> point at the given page? Matches clean URLs ("script",
  // "../script", "/script") and the legacy .html form, but not other pages
  // that merely end with the same word (e.g. "create-script").
  function linkMatches(a, name) {
    var h = (a.getAttribute('href') || '').split(/[?#]/)[0];
    return new RegExp('(^|\\/)' + name + '(\\.html)?$').test(h);
  }
  function findLinks(name, scope) {
    return Array.prototype.filter.call(
      (scope || document).querySelectorAll('a[href]'),
      function (a) { return linkMatches(a, name); }
    );
  }
  var GOOD = { townsfolk: 1, outsider: 1 };
  var TEAM_LABEL = {
    townsfolk: 'Townsfolk', outsider: 'Outsider', minion: 'Minion',
    demon: 'Demon', traveller: 'Traveller', fabled: 'Fabled', loric: 'Loric'
  };

  /* ── Site-wide announcement banner (set on the admin dashboard) ── */
  (function () {
    var CACHE_KEY = 'botc_announce';
    var DISMISS_KEY = 'botc_announce_dismissed';
    // Announcements may contain [label](url) text links. The formatter is
    // shared with the news articles and the wiki pages (render-wiki.js, via
    // render-news.js), which escapes the text first and only lets
    // http(s)/mailto/site-relative hrefs through — so an announcement can
    // never inject markup. Neither file is on every page, so they are pulled
    // in on demand and only when the message actually contains a link.
    function loadScript(src, done) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = done;
      s.onerror = done;
      document.head.appendChild(s);
    }
    function loadFormatter(cb) {
      if (window.NewsRender && window.WikiRender) return cb(window.NewsRender);
      // render-news.js forwards to render-wiki.js, so that one loads first.
      loadScript(ROOT + 'assets/render-wiki.js', function () {
        if (window.NewsRender) return cb(window.NewsRender);
        loadScript(ROOT + 'assets/render-news.js', function () {
          cb(window.NewsRender || null);
        });
      });
    }

    function show(ann) {
      if (!ann || !ann.text) return;
      var dismissed = '';
      try { dismissed = localStorage.getItem(DISMISS_KEY) || ''; } catch (e) {}
      if (dismissed === ann.text) return; // this exact message was dismissed
      var bar = document.createElement('div');
      bar.className = 'site-announcement';
      var span = document.createElement('span');
      span.textContent = ann.text; // plain text unless it turns out to have links
      if (/\[[^\]\n]+\]\([^)\s]+\)/.test(ann.text)) {
        loadFormatter(function (NR) {
          if (NR) span.innerHTML = NR.inlineFormat(ann.text);
        });
      }
      var btn = document.createElement('button');
      btn.className = 'site-announcement-close';
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Dismiss announcement');
      btn.textContent = '×';
      btn.addEventListener('click', function () {
        try { localStorage.setItem(DISMISS_KEY, ann.text); } catch (e) {}
        bar.remove();
      });
      bar.appendChild(span);
      bar.appendChild(btn);
      document.body.insertBefore(bar, document.body.firstChild);
    }
    try {
      var cached = JSON.parse(sessionStorage.getItem(CACHE_KEY));
      if (cached && (Date.now() - cached.ts) < 60 * 1000) { show(cached.ann); return; }
    } catch (e) {}
    fetch('/api/announcement')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var ann = (d && d.announcement) || null;
        try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), ann: ann })); } catch (e) {}
        show(ann);
      })
      .catch(function () {});
  })();

  /* ── Script-count badge on Script Builder nav links ── */
  var SCRIPT_KEY = 'botc_script';
  function scriptCount() {
    try { return (JSON.parse(localStorage.getItem(SCRIPT_KEY)) || []).length; }
    catch (e) { return 0; }
  }
  function updateScriptBadge() {
    var n = scriptCount();
    // Find every link to the Script Builder (root or ../, clean or .html)
    var links = findLinks('script');
    links.forEach(function (a) {
      var badge = a.querySelector('.script-badge');
      if (n > 0) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'script-badge';
          a.appendChild(badge);
        }
        badge.textContent = n;
      } else if (badge) {
        badge.remove();
      }
    });
  }
  window.updateScriptBadge = updateScriptBadge;
  updateScriptBadge();
  window.addEventListener('storage', function (e) { if (e.key === SCRIPT_KEY) updateScriptBadge(); });

  /* ── Tools link in the crumb nav, mirroring Script Builder (desktop top bar) ──
     One nav entry for the whole toolbox: the Token Tool, Grimoire Forge,
     Icon Forge, the Script Builder and the creator icons all live on /tools. */
  (function () {
    document.querySelectorAll('.crumb').forEach(function (crumb) {
      if (findLinks('tools', crumb).length) return;
      var sb = findLinks('script', crumb)[0];
      if (!sb) return;
      var sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '\u00b7';
      var link = document.createElement('a'); link.href = ROOT + 'tools'; link.textContent = 'Tools';
      crumb.insertBefore(sep, sb.nextSibling);
      crumb.insertBefore(link, sep.nextSibling);
    });
  })();

  /* ── "Create a Character" link in the crumb nav (desktop top bar) ──
     Injected after Script Builder, i.e. BEFORE Tools, so the Account
     link (added later, anchored on Tools) stays the last child —
     header-redesign.css styles .crumb a:last-child as the outlined button. */
  (function () {
    document.querySelectorAll('.crumb').forEach(function (crumb) {
      if (findLinks('create', crumb).length) return;
      var sb = findLinks('script', crumb)[0];
      if (!sb) return;
      var sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '·';
      var link = document.createElement('a'); link.href = ROOT + 'create'; link.textContent = 'Create a Character';
      crumb.insertBefore(sep, sb.nextSibling);
      crumb.insertBefore(link, sep.nextSibling);
    });
  })();

  /* ── Account link (crumb bar + mobile nav), based on login state ── */
  (function () {
    var ME_KEY = 'botc_me';
    function cachedMe() {
      try {
        var raw = JSON.parse(sessionStorage.getItem(ME_KEY));
        // short cache: keeps the unread-mail icon reasonably fresh
        if (raw && (Date.now() - raw.ts) < 60 * 1000) return Promise.resolve(raw.me);
      } catch (e) {}
      return fetch('/api/me', { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (me) {
          try { sessionStorage.setItem(ME_KEY, JSON.stringify({ ts: Date.now(), me: me })); } catch (e) {}
          return me;
        });
    }
    cachedMe().then(function (me) {
      var loggedIn = !!(me && me.loggedIn);
      var label = loggedIn ? 'My Account' : 'Log In';
      var href = ROOT + (loggedIn ? 'account' : 'login');
      var unread = (loggedIn && me.unreadMessages) || 0;
      // Little mail icon + count, appended to "My Account" links when there
      // is unread mail. Clicking it goes straight to /messages.
      function mailFlag() {
        // span, not <a>: it lives inside the account link (nested anchors are
        // invalid). Clicking it jumps to /messages instead of the account page.
        var wrap = document.createElement('span');
        wrap.className = 'mail-flag';
        wrap.title = unread + ' unread message' + (unread === 1 ? '' : 's');
        wrap.addEventListener('click', function (e) {
          e.preventDefault(); e.stopPropagation();
          location.href = ROOT + 'messages';
        });
        wrap.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>';
        var b = document.createElement('span');
        b.className = 'script-badge';
        b.textContent = unread > 99 ? '99+' : unread;
        wrap.appendChild(b);
        return wrap;
      }
      function flagAccountLink(a) {
        if (unread > 0 && !a.querySelector('.mail-flag')) a.appendChild(mailFlag());
      }
      // Hardcoded "Login" links (e.g. the homepage crumb + hamburger) flip
      // to "My Account" once logged in. Nav/crumb links only — never links
      // inside page content.
      if (loggedIn) {
        document.querySelectorAll('.crumb a, .nav-dropdown a').forEach(function (a) {
          if (linkMatches(a, 'login')) { a.href = href; a.textContent = label; }
        });
      }
      // mobile nav dropdown
      var drop = document.getElementById('nav-dropdown');
      if (drop && !findLinks('account', drop).length && !findLinks('login', drop).length) {
        var a = document.createElement('a');
        a.href = href; a.textContent = label;
        drop.appendChild(a);
      }
      if (loggedIn && drop) {
        var navAcct = findLinks('account', drop)[0];
        if (navAcct) flagAccountLink(navAcct);
      }
      // desktop crumb bar (after Tools, like the Tools injection)
      document.querySelectorAll('.crumb').forEach(function (crumb) {
        if (findLinks('account', crumb).length || findLinks('login', crumb).length) return;
        var anchor = findLinks('tools', crumb)[0] || findLinks('script', crumb)[0];
        if (!anchor) return;
        var sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '·';
        var link = document.createElement('a'); link.href = href; link.textContent = label;
        crumb.insertBefore(sep, anchor.nextSibling);
        crumb.insertBefore(link, sep.nextSibling);
      });
      if (loggedIn) {
        document.querySelectorAll('.crumb').forEach(function (crumb) {
          var acct = findLinks('account', crumb)[0];
          if (acct) flagAccountLink(acct);
        });
      }
    }).catch(function () {});
  })();

  /* ── Search ── */
  (function () {
    var input = document.getElementById('search-input');
    var drop  = document.getElementById('search-drop');
    if (!input || !drop) return;
    var allChars = null, allScripts = [], allCollections = [], fetchPromise = null;

    function ensureData() {
      if (allChars) return Promise.resolve(allChars);
      if (fetchPromise) return fetchPromise;
      fetchPromise = Promise.all([
        fetch(ROOT + 'characters.json?fields=card').then(function (r) { return r.json(); }),
        fetch(ROOT + 'scripts.json').then(function (r) { return r.json(); }).catch(function () { return []; }),
        fetch(ROOT + 'collections.json').then(function (r) { return r.json(); }).catch(function () { return []; })
      ]).then(function (res) {
        allChars = res[0] || [];
        allScripts = res[1] || [];
        allCollections = res[2] || [];
        return allChars;
      });
      return fetchPromise;
    }

    // Returns {type, item, field} entries — characters first, then scripts,
    // then collections. Caps at 8 results total, but scripts and collections
    // keep up to PAGE_SLOTS of them: every character on "Fall of Rome" matches
    // the words "fall of rome" through its Appears-in field, and filling the
    // list with characters first meant the script's own page — the thing being
    // searched for — never appeared at all.
    var MAX_RESULTS = 8, PAGE_SLOTS = 3;
    function search(q) {
      q = q.trim().toLowerCase();
      if (!q || !allChars) return [];
      var out = [];
      for (var i = 0; i < allChars.length && out.length < MAX_RESULTS; i++) {
        var c = allChars[i];
        var field = null;
        if ((c.name || '').toLowerCase().indexOf(q) !== -1) field = 'name';
        else if ((c.ability || '').toLowerCase().indexOf(q) !== -1) field = 'ability';
        else if ((c.tags || '').toLowerCase().indexOf(q) !== -1) field = 'tag';
        else if ((c.appearsIn || '').toLowerCase().indexOf(q) !== -1) field = 'collection';
        else if ((c.creator || '').toLowerCase().indexOf(q) !== -1) field = 'creator';
        else if ((c.lede || '').toLowerCase().indexOf(q) !== -1) field = 'flavor';
        if (field) out.push({ type: 'character', c: c, field: field });
      }
      function matchPage(p) {
        return (p.name || p.displayName || '').toLowerCase().indexOf(q) !== -1 ||
               (p.tagline || '').toLowerCase().indexOf(q) !== -1 ||
               (p.description || '').toLowerCase().indexOf(q) !== -1 ||
               (p.author || '').toLowerCase().indexOf(q) !== -1;
      }
      var pages = [];
      for (var s = 0; s < allScripts.length && pages.length < PAGE_SLOTS; s++) {
        if (matchPage(allScripts[s])) pages.push({ type: 'script', c: allScripts[s] });
      }
      for (var k = 0; k < allCollections.length && pages.length < PAGE_SLOTS; k++) {
        if (matchPage(allCollections[k])) pages.push({ type: 'collection', c: allCollections[k] });
      }
      // Give the pages their slots back by trimming characters, never the
      // other way round.
      if (pages.length) out = out.slice(0, Math.max(0, MAX_RESULTS - pages.length));
      return out.concat(pages);
    }

    // On mobile the topbar dropdown (.search-wrap) is display:none, so the
    // nav search would render results invisibly. Mirror them into an in-flow
    // box inside the mobile nav instead.
    var navResults = null;
    function navResultsBox() {
      if (navResults) return navResults;
      var nav = document.getElementById('nav-dropdown');
      if (!nav) return null;
      navResults = document.createElement('div');
      navResults.className = 'nav-search-results';
      var ns = nav.querySelector('.nav-dropdown-search');
      if (ns && ns.nextSibling) nav.insertBefore(navResults, ns.nextSibling);
      else nav.appendChild(navResults);
      return navResults;
    }

    function render(results, q) {
      var html;
      if (!results.length) {
        html = '<div class="search-empty">Nothing found for \u201c' + esc(q) + '\u201d</div>';
      } else {
        html = resultsHTML(results);
      }
      drop.innerHTML = html;
      var nb = navResultsBox();
      if (nb) nb.innerHTML = html;
    }

    function pageThumb(p) {
      var img = p.logo || p.header;
      return img ? (ROOT + 'assets/' + img) : (ROOT + 'assets/favicon.png');
    }
    function resultsHTML(results) {
      return results.map(function (r) {
        if (r.type === 'script' || r.type === 'collection') {
          var p = r.c;
          var pname = p.name || p.displayName || '';
          var phref = r.type === 'script'
            ? ROOT + 's/' + encodeURIComponent(p.slug)
            : ROOT + 'collection/' + encodeURIComponent(p.id || p.slug);
          var psub = p.tagline || p.description || '';
          if (psub.length > 80) psub = psub.slice(0, 80) + '\u2026';
          return '<a class="search-result" href="' + esc(phref) + '" role="option">' +
            '<img class="search-result-thumb" src="' + esc(pageThumb(p)) + '" alt="" ' +
            'onerror="this.src=\'' + ROOT + 'assets/favicon.png\'">' +
            '<div class="search-result-info">' +
            '<span class="search-result-name">' + esc(pname) +
            '<span class="search-match">' + (r.type === 'script' ? 'Script' : 'Collection') + '</span></span>' +
            '<span class="search-result-ability">' + esc(psub) + '</span>' +
            '</div></a>';
        }
        var c = r.c;
        var typeClass = GOOD[c.team] ? ' good' : '';
        var ability = c.ability || '';
        if (ability.length > 80) ability = ability.slice(0, 80) + '…';
        var fieldTag = r.field !== 'name'
          ? '<span class="search-match">matched ' + esc(r.field) + '</span>' : '';
        return '<a class="search-result" href="' + esc(ROOT + c.page) + '" role="option">' +
          '<img class="search-result-thumb" src="' + esc(ROOT + 'assets/' + c.art) + '" alt="" ' +
          'onerror="this.src=\'' + ROOT + 'assets/favicon.png\'">' +
          '<div class="search-result-info">' +
          '<span class="search-result-name">' + esc(c.name) + fieldTag + '</span>' +
          '<span class="search-result-type' + typeClass + '">' + esc(TEAM_LABEL[c.team] || c.team) + '</span>' +
          '<span class="search-result-ability">' + esc(ability) + '</span>' +
          '</div></a>';
      }).join('');
    }

    function open() { drop.hidden = false; input.setAttribute('aria-expanded', 'true'); }
    function close() {
      drop.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      if (navResults) navResults.innerHTML = '';
    }

    var debTimer;
    input.addEventListener('input', function () {
      clearTimeout(debTimer);
      var q = input.value.trim();
      if (!q) { close(); return; }
      debTimer = setTimeout(function () {
        ensureData().then(function () { render(search(q), q); open(); });
      }, 150);
    });
    input.addEventListener('focus', function () { if (input.value.trim() && allChars) open(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { close(); input.blur(); return; }
      if (e.key === 'ArrowDown') { var f = drop.querySelector('.search-result'); if (f) { e.preventDefault(); f.focus(); } }
    });
    drop.addEventListener('keydown', function (e) {
      var cur = document.activeElement;
      if (e.key === 'ArrowDown') { e.preventDefault(); var n = cur.nextElementSibling; if (n) n.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); var p = cur.previousElementSibling; if (p) p.focus(); else input.focus(); }
      else if (e.key === 'Escape') { close(); input.focus(); }
    });
    document.addEventListener('click', function (e) {
      var w = document.getElementById('search-wrap');
      if (navResults && navResults.contains(e.target)) return; // tapping a mobile result
      if (w && !w.contains(e.target)) close();
    });
    var sw = document.getElementById('search-wrap');
    if (sw) sw.addEventListener('mouseenter', ensureData);
  })();

  /* ── Mobile nav ── */
  (function () {
    var btn = document.getElementById('hamburger');
    var drop = document.getElementById('nav-dropdown');
    if (!btn || !drop) return;
    // Inject the Tools link into the nav once, on every page (root-aware).
    if (!findLinks('tools', drop).length) {
      var ttLink = document.createElement('a');
      ttLink.href = ROOT + 'tools';
      ttLink.textContent = 'Tools';
      var sb = findLinks('script', drop)[0];
      if (sb) drop.insertBefore(ttLink, sb.nextSibling); else drop.appendChild(ttLink);
    }
    // "Create a Character" sits between Script Builder and Tools, matching
    // the desktop crumb order.
    if (!findLinks('create', drop).length) {
      var ccLink = document.createElement('a');
      ccLink.href = ROOT + 'create';
      ccLink.textContent = 'Create a Character';
      var sbc = findLinks('script', drop)[0];
      if (sbc) drop.insertBefore(ccLink, sbc.nextSibling); else drop.appendChild(ccLink);
    }
    // Random Character link (/random is a Worker route, so the path is absolute).
    if (!drop.querySelector('a[href="/random"]')) {
      var rcLink = document.createElement('a');
      rcLink.href = '/random';
      rcLink.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><rect width="12" height="12" x="2" y="10" rx="2" ry="2"/><path d="m17.92 14 3.5-3.5a2.24 2.24 0 0 0 0-3l-5-4.92a2.24 2.24 0 0 0-3 0L10 6"/><path d="M6 18h.01"/><path d="M10 14h.01"/><path d="M15 6h.01"/><path d="M18 9h.01"/></svg>Random Character';
      var tt = findLinks('tools', drop)[0];
      if (tt) drop.insertBefore(rcLink, tt.nextSibling); else drop.appendChild(rcLink);
    }
    var here = (location.pathname.split('/').pop() || 'index').replace(/\.html$/, '');
    drop.querySelectorAll('a').forEach(function (a) {
      var h = (a.getAttribute('href') || '').replace(/\.html$/, '');
      if (h === here || (here === 'index' && (h === '/' || h === '../' || h === './'))) a.classList.add('active');
    });
    function positionDrop() {
      var tb = document.querySelector('.topbar');
      if (tb) drop.style.top = tb.getBoundingClientRect().height + 'px';
    }
    btn.addEventListener('click', function () {
      positionDrop();
      var open = drop.classList.toggle('open');
      btn.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      // Don't auto-focus the search field on open — that pops the mobile
      // keyboard uninvited. The keyboard appears only when the user taps
      // the search field themselves.
    });
    var navSearch = document.getElementById('nav-search-input');
    var topSearch = document.getElementById('search-input');
    if (navSearch && topSearch) {
      navSearch.addEventListener('input', function () {
        topSearch.value = navSearch.value;
        topSearch.dispatchEvent(new Event('input'));
      });
      navSearch.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { drop.classList.remove('open'); btn.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); }
      });
    }
    window.addEventListener('resize', positionDrop);
    document.addEventListener('click', function (e) {
      if (!btn.contains(e.target) && !drop.contains(e.target)) {
        drop.classList.remove('open'); btn.classList.remove('open'); btn.setAttribute('aria-expanded', 'false');
      }
    });
  })();
})();

/* ── Redesigned top bar: solid/scrolled state past 24px of scroll ── */
(function () {
  var tb = document.querySelector('.topbar');
  if (!tb) return;
  function onScroll() {
    tb.classList.toggle('scrolled', (window.scrollY || window.pageYOffset || 0) > 24);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
})();

/* ── Redesigned top bar: Edit button placement (editable pages) ──
   Editable server-rendered pages (/c/, /s/, /collection/) carry
   <a class="edit-link" id="edit-btn"> in the brand group; charpage.js /
   pageview.js set its href and un-hide it BEFORE this file runs (script
   order). Move it to the end of the nav row on desktop, and clone it into
   the hamburger dropdown for mobile (where the nav row is hidden). Guarded
   on display so a hidden/inactive button is never surfaced. */
(function () {
  var editBtn = document.getElementById('edit-btn');
  if (!editBtn || editBtn.style.display === 'none') return;
  var crumb = document.querySelector('.crumb');
  if (crumb) crumb.appendChild(editBtn);
  var dropdown = document.getElementById('nav-dropdown');
  if (dropdown && !document.getElementById('edit-btn-mobile')) {
    var clone = editBtn.cloneNode(true);
    clone.id = 'edit-btn-mobile';
    clone.classList.add('edit-link-clone');
    clone.style.display = '';
    dropdown.appendChild(clone);
  }
})();

/* Auto-growing textareas: every edit form on the site expands to fit its
   content as you type, so long fields (abilities, descriptions, strategy
   notes) don't hide text behind a scrollbar. Opt out with class="no-autosize"
   (used for the big JSON paste box on mass-upload). Pages that fill textareas
   after load — the character/collection/script editors — can call
   window.autosizeTextareas() to re-fit once the values are in. */
(function () {
  function fit(ta) {
    if (!ta || ta.tagName !== 'TEXTAREA' || ta.classList.contains('no-autosize')) return;
    ta.style.overflowY = 'hidden';
    ta.style.height = 'auto';
    ta.style.height = (ta.scrollHeight + 2) + 'px';
  }
  function fitAll() {
    Array.prototype.forEach.call(document.querySelectorAll('textarea'), fit);
  }
  window.autosizeTextareas = fitAll;
  document.addEventListener('input', function (e) { fit(e.target); });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fitAll);
  } else {
    fitAll();
  }
})();
