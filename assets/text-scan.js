/* Site text scanner — builds the catalogue behind /text-editor.

   WHAT COUNTS AS SYSTEM TEXT
   --------------------------
   Everything written into the site's own files: the copy on a static page,
   the labels and messages inside assets/*.js, and the Worker's page text
   (kept in assets/system-text.js so this scanner can reach it). What does NOT
   count is anything that lives in D1 — characters, scripts, collections, wiki
   pages, news, comments. Those belong to whoever wrote them, admins included,
   and are edited in their own editors. This file never fetches them.

   WHERE IT RUNS
   -------------
   In the browser, on the admin's own machine, not in the Worker. The files it
   reads are public static assets, so a plain fetch() gets them; doing it
   client-side means no Worker CPU or subrequest budget is involved and a scan
   can cover the whole site in one go. Nothing here is Worker-safe (DOMParser).

   HOW IT FINDS FILES
   ------------------
   SEED_PAGES / SEED_ASSETS below are the known files, so a scan is complete
   even on a page nothing links to. On top of that every fetched page is
   crawled for <a href> (new static pages) and <script src> (new assets), so a
   page or asset added later turns up on its own without editing this list.
   Server-rendered paths (/c/, /s/, /p/, …) are never followed: that is D1
   content, not system text.

   EXTRACTION
   ----------
   HTML  -> visible text nodes, plus the attributes a reader actually sees
            (placeholder/title/alt/aria-label/value), <title> and the meta
            description. Inline <script> blocks go through the JS path.
   JS    -> string literals, read with a small lexer (not a regex) so that
            comments, apostrophes and regex literals do not confuse it, and
            escapes like ’ are decoded to the character the page shows.
            Literals that are HTML fragments are split on their tags so only
            the words come through. looksLikeCopy() then throws out the
            obvious code: identifiers, selectors, URLs, paths, CSS, SQL.

   Identical text found in several files becomes ONE catalogue entry — the
   topbar and footer are copied into every page by hand, and the owner should
   edit them once, not thirty times. */
(function () {
  'use strict';

  /* ---- known static pages (path form, no .html) ---------------------- */
  var SEED_PAGES = [
    '/', '/all-characters', '/all-collections', '/tags', '/tag', '/team',
    '/scripts', '/script', '/publish-script', '/publish-collection',
    '/publish-page', '/publish-news', '/create', '/edit', '/mass-upload',
    '/creators', '/drafts', '/account', '/dashboard', '/login',
    '/reset-password', '/messages', '/news', '/profile', '/tools', '/tokens',
    '/grimforge', '/rules', '/steven-approved-order', '/script-view',
    '/normalize-icons'
  ];

  /* The text editor's own controls are not wiki text, and listing them buries
     the strings the owner came to find. */
  var SKIP_PAGES = ['/text-editor'];

  /* ---- known shared scripts ------------------------------------------ */
  var SEED_ASSETS = [
    'assets/site.js', 'assets/system-text.js', 'assets/render.js',
    'assets/render-page.js', 'assets/render-wiki.js', 'assets/render-news.js',
    'assets/classify.js', 'assets/tags.js', 'assets/creators.js',
    'assets/card-filters.js', 'assets/charpage.js', 'assets/comments.js',
    'assets/editor-notices.js', 'assets/grimforge.js', 'assets/pageview.js',
    'assets/night-order-picker.js', 'assets/redesign-create.js',
    'assets/rules.js', 'assets/rules-gate.js', 'assets/sao.js',
    'assets/theme-editor.js', 'assets/token-tool.js', 'assets/wiki-editor.js',
    'assets/wikipage.js', 'assets/art-normalize.js'
  ];

  /* Server-rendered / dynamic paths. Their text is somebody's page content,
     so the crawler stops at them. */
  var DYNAMIC = [
    '/c/', '/s/', '/collection/', '/p/', '/news/', '/u/', '/author',
    '/api/', '/random', '/sitemap', '/assets/'
  ];

  /* Scanning these adds nothing but noise: a dedicated Web Worker with no
     page copy in it, and this scanner's own source. */
  var SKIP_ASSETS = ['assets/token-worker.js', 'assets/text-scan.js'];

  function isDynamic(path) {
    for (var i = 0; i < DYNAMIC.length; i++) {
      if (path === DYNAMIC[i] || path.indexOf(DYNAMIC[i]) === 0) return true;
    }
    return false;
  }

  /* ================================================================
     JS string extraction
     ================================================================ */

  /* A '/' here starts a regex literal, not a division: what comes before it
     is an operator or an opening bracket rather than a value. */
  function regexAllowed(prev) {
    return prev === '' || '(,=:[!&|?{};+-*%~^<>'.indexOf(prev) >= 0;
  }

  var SIMPLE_ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };

  /* Reads one escape sequence starting at the backslash. Returns the decoded
     character and where to carry on. */
  function readEscape(src, i) {
    var c = src[i + 1];
    if (c === undefined) return { value: '', end: i + 1 };
    if (c === '\n') return { value: '', end: i + 2 };           // line continuation
    if (c === 'u') {
      if (src[i + 2] === '{') {
        var close = src.indexOf('}', i + 3);
        if (close > 0) {
          var cp = parseInt(src.slice(i + 3, close), 16);
          if (!isNaN(cp)) {
            try { return { value: String.fromCodePoint(cp), end: close + 1 }; } catch (e) {}
          }
        }
      }
      var hex4 = src.substr(i + 2, 4);
      if (/^[0-9a-fA-F]{4}$/.test(hex4)) {
        return { value: String.fromCharCode(parseInt(hex4, 16)), end: i + 6 };
      }
    }
    if (c === 'x') {
      var hex2 = src.substr(i + 2, 2);
      if (/^[0-9a-fA-F]{2}$/.test(hex2)) {
        return { value: String.fromCharCode(parseInt(hex2, 16)), end: i + 4 };
      }
    }
    if (Object.prototype.hasOwnProperty.call(SIMPLE_ESCAPES, c)) {
      return { value: SIMPLE_ESCAPES[c], end: i + 2 };
    }
    return { value: c, end: i + 2 };   // \' \" \` \\ \/ and anything else
  }

  function readString(src, i, quote) {
    var out = '', j = i + 1;
    while (j < src.length) {
      var ch = src[j];
      if (ch === '\\') { var e = readEscape(src, j); out += e.value; j = e.end; continue; }
      if (ch === quote) return { value: out, end: j + 1 };
      if (ch === '\n') return { value: out, end: j };           // unterminated; bail
      out += ch; j++;
    }
    return { value: out, end: j };
  }

  /* Template literals come back as their literal chunks: the ${...} holes are
     values the page fills in, and each surrounding chunk is matched on its own
     against the rendered text. Nested strings/templates inside a hole are
     skipped properly so the lexer stays in step. */
  function readTemplate(src, i) {
    var parts = [], cur = '', j = i + 1;
    while (j < src.length) {
      var ch = src[j];
      if (ch === '\\') { var e = readEscape(src, j); cur += e.value; j = e.end; continue; }
      if (ch === '`') { parts.push(cur); return { parts: parts, end: j + 1 }; }
      if (ch === '$' && src[j + 1] === '{') {
        parts.push(cur); cur = '';
        j = skipHole(src, j + 2);
        continue;
      }
      cur += ch; j++;
    }
    parts.push(cur);
    return { parts: parts, end: j };
  }

  /* Walks past a ${ ... } hole, counting braces and stepping over any strings
     or templates inside it. Returns the index just after the closing brace. */
  function skipHole(src, j) {
    var depth = 1;
    while (j < src.length && depth > 0) {
      var ch = src[j];
      if (ch === '"' || ch === "'") { j = readString(src, j, ch).end; continue; }
      if (ch === '`') { j = readTemplate(src, j).end; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      j++;
    }
    return j;
  }

  function jsStrings(src) {
    var out = [], i = 0, n = src.length, prev = '';
    while (i < n) {
      var ch = src[i];
      if (ch === '/' && src[i + 1] === '/') {
        while (i < n && src[i] !== '\n') i++;
        continue;
      }
      if (ch === '/' && src[i + 1] === '*') {
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
      if (ch === '/' && regexAllowed(prev)) {
        i++;
        while (i < n && src[i] !== '/' && src[i] !== '\n') {
          if (src[i] === '\\') i++;
          else if (src[i] === '[') { while (i < n && src[i] !== ']' && src[i] !== '\n') { if (src[i] === '\\') i++; i++; } }
          i++;
        }
        i++;
        prev = '/';
        continue;
      }
      if (ch === '"' || ch === "'") {
        var s = readString(src, i, ch);
        out.push(s.value); i = s.end; prev = ch;
        continue;
      }
      if (ch === '`') {
        var t = readTemplate(src, i);
        for (var k = 0; k < t.parts.length; k++) out.push(t.parts[k]);
        i = t.end; prev = ch;
        continue;
      }
      if (!/\s/.test(ch)) prev = ch;
      i++;
    }
    return out;
  }

  /* A lot of the site's JS builds HTML by hand. Split those literals on their
     tags so the catalogue holds the words, never the markup — the override is
     applied to text nodes in the browser, so markup would never match anyway. */
  function textPieces(str) {
    if (!/<[a-zA-Z/!]/.test(str) && str.indexOf('>') < 0) return [str];
    var parts = str.split(/<[^>]*>/g);
    for (var i = 0; i < parts.length; i++) parts[i] = stripMarkupBits(parts[i]);
    return parts;
  }

  /* Markup built by concatenation gets cut mid-tag, so a literal often ends
     with the start of a tag ('<span class="x" title="') or begins with the
     tail of one ('" aria-label="Star">✦'). Whole tags are already gone by the
     time this runs; these are the ragged ends. */
  function stripMarkupBits(s) {
    // '…href="/account">account page' — everything up to the '>' is the tail
    // of an attribute list, which always ends on its closing quote.
    var gt = s.lastIndexOf('>');
    if (gt >= 0 && /["']\s*\/?$/.test(s.slice(0, gt))) s = s.slice(gt + 1);
    // 'Pinned<span class="x" title="' — a tag the literal never closes.
    var lt = s.indexOf('<');
    if (lt >= 0 && /^[a-zA-Z/!]/.test(s.charAt(lt + 1))) s = s.slice(0, lt);
    return s;
  }

  /* Markup built in JS carries reader-visible attributes too — a tooltip on a
     button the page draws by hand is text the owner should be able to edit. */
  var ATTR_IN_MARKUP = /\b(?:title|alt|placeholder|aria-label)\s*=\s*"([^"]{2,})"/g;
  function attrsInMarkup(str) {
    var out = [], m;
    ATTR_IN_MARKUP.lastIndex = 0;
    while ((m = ATTR_IN_MARKUP.exec(str))) out.push(m[1]);
    return out;
  }

  /* Is this string something a reader sees, or is it code? Nothing here is
     exact — the point is to keep the catalogue readable. The editor's search,
     source filter and "prose only" toggle mop up whatever slips through. */
  var NOT_COPY = {
    'use strict': 1, 'utf-8': 1, 'UTF-8': 1,
    'GET': 1, 'POST': 1, 'PUT': 1, 'DELETE': 1, 'PATCH': 1,
    'Content-Type': 1, 'Authorization': 1, 'same-origin': 1, 'no-store': 1
  };

  function looksLikeCopy(s) {
    if (!s) return false;
    if (s.length < 2 || s.length > 2000) return false;
    if (NOT_COPY[s]) return false;
    if (/^&[a-zA-Z#][\w#]*;$/.test(s)) return false;                // bare HTML entity
    if (!/[A-Za-zÀ-ɏͰ-῿぀-鿿]/.test(s)) return false;
    if (/^\s+$/.test(s)) return false;
    if (/^(https?:)?\/\//.test(s)) return false;                    // URL
    if (/^(mailto|data|blob|javascript):/i.test(s)) return false;
    if (/^[.#][A-Za-z][\w-]*$/.test(s)) return false;               // CSS selector
    if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return false;                // hex colour
    if (/^[\w./-]*\.(js|css|json|png|jpe?g|svg|webp|gif|html|woff2?|ico|txt|xml)$/i.test(s)) return false;
    if (/^[\w-]+\/[\w./+-]+$/.test(s)) return false;                // path or MIME type
    if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|PRAGMA)\b/i.test(s)) return false;
    if (/^\[[\w-]+[^\]]*\]$/.test(s)) return false;                 // attribute selector
    if (/^--?[\w-]+:?$/.test(s)) return false;                      // CSS custom property
    if (/^[\w./-]*\/$/.test(s)) return false;                       // path fragment
    if (/^[/#][\w./?=&#-]*$/.test(s)) return false;                 // URL path or anchor
    if (/[?&][\w-]*=$/.test(s)) return false;                       // query-string fragment
    if (/=["']/.test(s)) return false;                              // leftover markup attributes
    if (/["']/.test(s) && !/\s/.test(s)) return false;              // a torn-off chunk of markup
    // a lone identifier: camelCase, dotted.path, snake_case, DOMContentLoaded
    if (!/\s/.test(s) && /^[A-Za-z][\w$]*(\.[A-Za-z][\w$]*)*$/.test(s) && /[a-z][A-Z]|[._]/.test(s)) return false;
    if (!/\s/.test(s) && /^[a-z][a-z0-9]*$/.test(s)) return false;  // lone lowercase word: css keyword, event name
    // a run of kebab-case tokens is a class list, not a sentence
    if (/^[a-z0-9-]+(\s+[a-z0-9-]+)*$/.test(s) && /-/.test(s) && !/[.!?,;:]/.test(s)) return false;
    // a CSS declaration or two
    if (/^[a-z-]+\s*:\s*[^;]+;?\s*$/i.test(s) && !/[.!?]/.test(s)) return false;
    return true;
  }

  function scanJS(src, file, kind) {
    var found = [], seen = Object.create(null);
    var raws = jsStrings(src);
    function take(text, asKind) {
      var t = text.replace(/^\s+|\s+$/g, '');
      if (!looksLikeCopy(t) || seen[t]) return;
      seen[t] = 1;
      found.push({ text: t, file: file, kind: asKind });
    }
    for (var i = 0; i < raws.length; i++) {
      var attrs = attrsInMarkup(raws[i]);
      for (var a = 0; a < attrs.length; a++) take(attrs[a], 'attr');
      var parts = textPieces(raws[i]);
      for (var j = 0; j < parts.length; j++) take(parts[j], kind || 'script');
    }
    return found;
  }

  /* ================================================================
     HTML extraction
     ================================================================ */

  var TEXT_ATTRS = ['placeholder', 'title', 'alt', 'aria-label'];
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };

  function scanHTML(html, file) {
    var found = [], seen = Object.create(null);
    var doc;
    try { doc = new DOMParser().parseFromString(html, 'text/html'); }
    catch (e) { return { entries: found, doc: null }; }

    function add(text, kind) {
      var t = String(text == null ? '' : text).replace(/^\s+|\s+$/g, '');
      if (!t || t.length > 2000) return;
      if (!/[A-Za-zÀ-ɏͰ-῿぀-鿿]/.test(t)) return;
      var key = kind + ' ' + t;
      if (seen[key]) return;
      seen[key] = 1;
      found.push({ text: t, file: file, kind: kind });
    }

    var title = doc.querySelector('title');
    if (title) add(title.textContent, 'attr');
    var desc = doc.querySelector('meta[name="description"]');
    if (desc) add(desc.getAttribute('content'), 'attr');

    var walker = doc.createTreeWalker(doc.body || doc.documentElement, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walker.nextNode())) {
      if (node.parentNode && SKIP_TAGS[node.parentNode.nodeName]) continue;
      add(node.nodeValue, 'page');
    }

    var all = (doc.body || doc.documentElement).querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      for (var a = 0; a < TEXT_ATTRS.length; a++) {
        if (el.hasAttribute(TEXT_ATTRS[a])) add(el.getAttribute(TEXT_ATTRS[a]), 'attr');
      }
      // the label on a button/submit lives in value=
      if ((el.nodeName === 'INPUT' || el.nodeName === 'BUTTON') &&
          /^(button|submit|reset)$/i.test(el.getAttribute('type') || '') &&
          el.hasAttribute('value')) {
        add(el.getAttribute('value'), 'attr');
      }
    }

    // inline <script> blocks are JS like any other file
    var scripts = doc.querySelectorAll('script:not([src])');
    for (var s = 0; s < scripts.length; s++) {
      var inner = scanJS(scripts[s].textContent || '', file, 'script');
      for (var k = 0; k < inner.length; k++) {
        var key2 = 'script ' + inner[k].text;
        if (seen[key2]) continue;
        seen[key2] = 1;
        found.push(inner[k]);
      }
    }

    return { entries: found, doc: doc };
  }


  /* Pages and shared scripts this page links to, so a file added later is
     picked up without touching SEED_PAGES / SEED_ASSETS. */
  function discover(doc) {
    var pages = [], assets = [], i;
    var links = doc.querySelectorAll('a[href]');
    for (i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href') || '';
      if (/^[a-z]+:/i.test(href) || href.charAt(0) === '#') continue;
      var path = href.split(/[?#]/)[0].replace(/\.html$/, '');
      path = path.replace(/^(\.\.?\/)+/, '/');
      if (path.charAt(0) !== '/') path = '/' + path;
      if (path === '' || path === '/') continue;
      if (isDynamic(path)) continue;
      if (SKIP_PAGES.indexOf(path) >= 0) continue;
      if (path.split('/').length !== 2) continue;   // root-level pages only
      pages.push(path);
    }
    var srcs = doc.querySelectorAll('script[src]');
    for (i = 0; i < srcs.length; i++) {
      var src = (srcs[i].getAttribute('src') || '').split(/[?#]/)[0];
      var m = src.match(/(assets\/[\w.-]+\.js)$/);
      if (m) assets.push(m[1]);
    }
    return { pages: pages, assets: assets };
  }

  /* ================================================================
     The scan
     ================================================================ */

  function fetchText(url) {
    return fetch(url, { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.text() : null; })
      .catch(function () { return null; });
  }

  /* opts: { onProgress(done, total, label), maxPages }
     Resolves to { entries, files, skipped } where entries are deduplicated
     across files and carry every source they were found in. */
  function scan(opts) {
    opts = opts || {};
    var onProgress = opts.onProgress || function () {};
    var maxPages = opts.maxPages || 120;

    var pageQueue = SEED_PAGES.slice();
    var assetSet = Object.create(null);
    SEED_ASSETS.forEach(function (a) { if (SKIP_ASSETS.indexOf(a) < 0) assetSet[a] = 1; });

    var queued = Object.create(null);
    pageQueue.forEach(function (p) { queued[p] = 1; });

    var raw = [];
    var files = [];
    var skipped = [];
    var done = 0;

    function total() { return pageQueue.length + Object.keys(assetSet).length; }

    function nextPage(i) {
      if (i >= pageQueue.length || i >= maxPages) return Promise.resolve();
      var path = pageQueue[i];
      onProgress(done, total(), path);
      return fetchText(path).then(function (html) {
        done++;
        if (html == null) { skipped.push(path); return nextPage(i + 1); }
        var res = scanHTML(html, path);
        var entries = res.entries;
        if (entries.length) files.push(path);
        raw = raw.concat(entries);
        if (res.doc) {
          var found = discover(res.doc);
          found.pages.forEach(function (p) {
            if (!queued[p] && pageQueue.length < maxPages) { queued[p] = 1; pageQueue.push(p); }
          });
          found.assets.forEach(function (a) {
            if (SKIP_ASSETS.indexOf(a) < 0) assetSet[a] = 1;
          });
        }
        return nextPage(i + 1);
      });
    }

    function doAssets() {
      var list = Object.keys(assetSet).sort();
      function step(i) {
        if (i >= list.length) return Promise.resolve();
        var file = list[i];
        onProgress(done, total(), file);
        return fetchText('/' + file).then(function (src) {
          done++;
          if (src == null) { skipped.push(file); return step(i + 1); }
          var entries = scanJS(src, file, 'script');
          if (entries.length) files.push(file);
          raw = raw.concat(entries);
          return step(i + 1);
        });
      }
      return step(0);
    }

    return nextPage(0).then(doAssets).then(function () {
      onProgress(done, done, '');
      return { entries: merge(raw), files: files.sort(), skipped: skipped };
    });
  }

  /* One entry per distinct string. `files` lists every place it was found and
     decides how widely an override applies:
       - found in a shared assets/*.js, or in more than one page -> site-wide,
         which is what makes editing the topbar or footer a single edit
       - found on exactly one page -> scoped to that page, so a short label
         can be changed without touching a page that happens to use the same
         word */
  function merge(raw) {
    var byText = Object.create(null);
    for (var i = 0; i < raw.length; i++) {
      var e = raw[i];
      var hit = byText[e.text];
      if (!hit) {
        hit = byText[e.text] = { text: e.text, files: [], kinds: {}, len: e.text.length };
      }
      if (hit.files.indexOf(e.file) < 0) hit.files.push(e.file);
      hit.kinds[e.kind] = 1;
    }
    var out = [];
    for (var k in byText) {
      if (!Object.prototype.hasOwnProperty.call(byText, k)) continue;
      var entry = byText[k];
      entry.files.sort();
      var shared = entry.files.length > 1 ||
                   entry.files.some(function (f) { return f.indexOf('assets/') === 0; });
      entry.scope = shared ? '*' : entry.files[0];
      entry.kindList = Object.keys(entry.kinds).sort();
      delete entry.kinds;
      out.push(entry);
    }
    return out;
  }

  /* ================================================================
     The cached catalogue
     ================================================================
     Live editing (text-live.js) has to answer one question on every
     double-click: is this piece of text something the SITE wrote, and how
     widely does an override of it apply? That is exactly what a scan
     produces, so the answer is cached rather than re-derived on every page.
     Only the text and its scope are kept — the file list is for the editor's
     list view, not for this — which keeps a whole site's worth of strings
     comfortably inside localStorage. /text-editor refreshes it every time it
     scans; text-live.js rescans in the background when it goes stale. */
  var CACHE_KEY = 'botc_text_catalog';
  var CACHE_TTL = 12 * 60 * 60 * 1000;

  function saveCatalog(entries) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        ts: Date.now(),
        e: entries.map(function (x) { return [x.text, x.scope]; })
      }));
      return true;
    } catch (e) { return false; }   // quota: live editing just rescans instead
  }

  function loadCatalog() {
    var raw;
    try { raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) { return null; }
    if (!raw || !raw.e || !raw.e.length) return null;
    return {
      stale: (Date.now() - raw.ts) > CACHE_TTL,
      ts: raw.ts,
      entries: raw.e.map(function (p) {
        return { text: p[0], scope: p[1], len: p[0].length, files: [], kindList: [] };
      })
    };
  }

  var API = {
    saveCatalog: saveCatalog,
    loadCatalog: loadCatalog,
    CACHE_KEY: CACHE_KEY,
    scan: scan,
    scanHTML: scanHTML,
    scanJS: scanJS,
    jsStrings: jsStrings,
    looksLikeCopy: looksLikeCopy,
    merge: merge,
    SEED_PAGES: SEED_PAGES,
    SEED_ASSETS: SEED_ASSETS
  };

  if (typeof window !== 'undefined') window.TextScan = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
