/* One parsed public response per URL and document. Never reuse private feeds. */
(function () {
  'use strict';
  var pending = new Map(), scripts = new Map();
  function json(path) {
    var url = new URL(path, document.baseURI);
    var shared = url.origin === location.origin &&
      (/^\/(characters|scripts|collections)\.json$/.test(url.pathname) || url.pathname === '/api/home' ||
        url.pathname === '/api/search-index') &&
      !url.searchParams.has('drafts');
    var key = url.href;
    if (shared && pending.has(key)) return pending.get(key);
    var request = fetch(key, { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('Could not load data (' + r.status + ')');
      return r.json();
    }).then(function (data) {
      if (/^\/(characters|scripts|collections)\.json$/.test(url.pathname) && !Array.isArray(data)) throw new Error('Invalid feed');
      if (url.pathname === '/api/home' && (!data || !data.stats)) throw new Error('Invalid homepage data');
      return data;
    }).catch(function (error) {
      if (pending.get(key) === request) pending.delete(key);
      throw error;
    });
    if (shared) pending.set(key, request);
    return request;
  }
  function asset(path) {
    var key = String(path).replace(/^\/?assets\//, '');
    return '/assets/' + ((window.BOTC_ASSETS || {})[key] || key);
  }
  function script(path) {
    var url = asset(path);
    if (scripts.has(url)) return scripts.get(url);
    var request = new Promise(function (resolve, reject) {
      var node = document.createElement('script');
      node.src = url;
      node.onload = resolve;
      node.onerror = function () { node.remove(); scripts.delete(url); reject(new Error('Could not load ' + path)); };
      document.head.appendChild(node);
    });
    scripts.set(url, request);
    return request;
  }
  // The prefix that turns a site page name into a link from THIS page: '' at
  // the root, '../' or '../../' on a server-rendered one. An SSR page states
  // it outright as window.LINK_ROOT; everywhere else it is read back off our
  // own stylesheet link.
  //
  // "Our own" is the load-bearing word. This used to take the FIRST
  // link[rel=stylesheet] in the document, which is only ours in a clean
  // browser: an ad blocker injects its element-hiding stylesheet at
  // document_start, so for those readers the first stylesheet was the
  // extension's, and every nav link built from the root (Tools, Create a
  // Character, My Account, Messages, search results) pointed into
  // chrome-extension://... — clicking "My Account" opened the blocker's own
  // filter list instead of the wiki. So a candidate has to look like a path
  // on this site: something before 'assets/' that is only './' and '../'
  // steps, never a scheme or a host, whatever it happens to keep under an
  // assets/ folder of its own.
  function root() {
    if (window.LINK_ROOT != null) return window.LINK_ROOT;
    var links = document.querySelectorAll('link[rel~="stylesheet"]');
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href') || '';
      var cut = href.indexOf('assets/');
      if (cut < 0) continue;
      var prefix = href.slice(0, cut);
      if (!/^(?:\.{0,2}\/)*$/.test(prefix)) continue;
      return prefix;
    }
    return '';
  }
  function style(path) {
    var url = asset(path);
    if (document.querySelector('link[href="' + url + '"]')) return;
    var node = document.createElement('link');
    node.rel = 'stylesheet'; node.href = url; document.head.appendChild(node);
  }

  /* /api/boot: the site-text overrides and the announcement, one request per
     page. site.js starts it; me() below waits on it when there is no login
     hint, because the Worker sets the hint on that response for a session
     that predates it. Shared, so the page never asks twice. */
  var bootPromise = null;
  function boot() {
    if (!bootPromise) {
      bootPromise = fetch('/api/boot', { credentials: 'same-origin', cache: 'no-cache' })
        .then(function (r) { return r.json(); })
        .catch(function () { return null; });
    }
    return bootPromise;
  }

  /* Who is reading — ONE answer per page. site.js (the account link),
     favorites.js, page-viewer.js and the live text editor all ask it, and
     before this the character and collection pages asked /api/me twice.

     The session cookie is HttpOnly, so the page cannot see whether there is
     one. The Worker therefore sets a second, JS-readable cookie beside it,
     `botc_li=1`, carrying nothing but "a session cookie was issued here"
     (withLoginHint in worker.js): on every login, cleared on logout and
     whenever /api/me finds the session gone. No hint, no /api/me request —
     the logged-out reader, which is most readers, costs nothing. A session
     from before the hint existed is caught by the Worker too: it adds the
     hint to any private response for a request that carries a session and no
     hint, /api/boot included, so the no-hint path waits for boot and looks
     again before deciding.

     The 60-second sessionStorage copy (botc_me) is unchanged: it keeps the
     unread-mail count fresh enough without a request on every page. */
  var ME_KEY = 'botc_me';
  var mePromise = null;
  function loginHint() {
    try { return /(?:^|;\s*)botc_li=1(?:;|$)/.test(document.cookie || ''); } catch (e) { return false; }
  }
  function clearLoginHint() {
    try { document.cookie = 'botc_li=; Path=/; Max-Age=0; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : ''); } catch (e) {}
  }
  function cachedMe() {
    try {
      var raw = JSON.parse(sessionStorage.getItem(ME_KEY));
      if (raw && raw.me && (Date.now() - raw.ts) < 60 * 1000) return raw.me;
    } catch (e) {}
    return null;
  }
  function fetchMe() {
    return fetch('/api/me', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (m) {
        try { sessionStorage.setItem(ME_KEY, JSON.stringify({ ts: Date.now(), me: m })); } catch (e) {}
        if (!(m && m.loggedIn)) clearLoginHint();
        return m;
      });
  }
  var LOGGED_OUT = { loggedIn: false, isAdmin: false };
  function withHint() {
    var c = cachedMe();
    if (c && c.loggedIn) return Promise.resolve(c);
    return fetchMe();
  }
  // Resolves to the /api/me object ({loggedIn:false,…} when logged out) and
  // rejects only when /api/me itself fails, as the old per-file copies did.
  function me(opts) {
    if (opts && opts.fresh) mePromise = null;
    if (mePromise) return mePromise;
    if (loginHint()) mePromise = withHint();
    else {
      mePromise = boot().then(function () {
        return loginHint() ? withHint() : LOGGED_OUT;
      });
    }
    return mePromise;
  }
  // Forget the answer (the logout button, a page restored from the
  // back/forward cache). The next me() asks again.
  function forgetMe() {
    mePromise = null;
    try { sessionStorage.removeItem(ME_KEY); } catch (e) {}
  }

  /* The announcement bar, painted from the last copy this browser saw BEFORE
     the first paint, so the page does not jump down when /api/boot answers
     (site.js reconciles it with the fresh copy and owns the close button and
     the link formatting). requestAnimationFrame runs just before the frame is
     painted, so a bar inserted there is in the first frame that shows any of
     the body. pageShell() in worker.js inlines the same few lines right after
     <body> for the server-rendered pages, where this file is deferred —
     change the markup in one, change it in both (and show() in site.js). */
  var ANN_KEY = 'botc_announce';
  var ANN_MAX_AGE = 3 * 24 * 60 * 60 * 1000;
  function earlyAnnouncement() {
    var ann = null;
    try {
      var c = JSON.parse(localStorage.getItem(ANN_KEY));
      if (c && c.ann && c.ann.text && (Date.now() - c.ts) < ANN_MAX_AGE &&
          localStorage.getItem('botc_announce_dismissed') !== c.ann.text) ann = c.ann;
    } catch (e) {}
    if (!ann) return;
    function paint() {
      if (!document.body) { requestAnimationFrame(paint); return; }
      if (document.querySelector('.site-announcement')) return;
      var bar = document.createElement('div');
      bar.className = 'site-announcement';
      bar.setAttribute('data-early', '1');
      bar.setAttribute('data-text', ann.text);
      var span = document.createElement('span');
      // A [label](url) shows its label, which is what the formatted link
      // will read, so formatting it later moves nothing.
      span.textContent = ann.text.replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1');
      var btn = document.createElement('button');
      btn.className = 'site-announcement-close';
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Dismiss announcement');
      btn.textContent = '×';
      bar.appendChild(span); bar.appendChild(btn);
      document.body.insertBefore(bar, document.body.firstChild);
    }
    if (document.body) paint();
    else if (window.requestAnimationFrame) requestAnimationFrame(paint);
  }
  earlyAnnouncement();

  window.BotcData = {
    json: json, asset: asset, script: script, style: style, root: root,
    boot: boot, me: me, forgetMe: forgetMe, loginHint: loginHint
  };
})();
