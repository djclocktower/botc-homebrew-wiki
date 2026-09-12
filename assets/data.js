/* One parsed public response per URL and document. Never reuse private feeds. */
(function () {
  'use strict';
  var pending = new Map(), scripts = new Map();
  function json(path) {
    var url = new URL(path, document.baseURI);
    var shared = url.origin === location.origin &&
      (/^\/(characters|scripts|collections)\.json$/.test(url.pathname) || url.pathname === '/api/home') &&
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
  window.BotcData = { json: json, asset: asset, script: script, style: style, root: root };
})();
