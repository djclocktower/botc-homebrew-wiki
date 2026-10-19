/* ============================================================================
   token-worker.js — Pyodide render engine for the Token Tool, in a Web Worker.
   Keeps the page responsive: all loading + rendering happens off the main
   thread. Boot is parallelized — toolkit files download while Pyodide inits.
   Protocol (postMessage):
     in:  {type:'init', index, tokBase}
     in:  {type:'preview', id, payload, opts, art:[{slug,url}]}
     in:  {type:'render',  id, payloads, opts, art:[{slug,url}]}
     out: {type:'status', state:'loading'|'ready'|'error', message}
     out: {type:'result', id, res} | {type:'fail', id, message}
   ============================================================================ */
'use strict';

var pyodide = null, ready = false, bootErr = null;
var FSDIR = '/tok';
var artWritten = {};   // slug -> true once written to the FS
var queue = [];        // messages received before the engine is ready

function post(msg) { self.postMessage(msg); }

var PROXY_FETCH = 'https://botc-wiki-proxy.djclocktower.workers.dev/fetch?url=';

/* The engine is ~13 MB (Python, numpy, Pillow, the toolkit). Phone Chrome's
   HTTP cache is small and drops files that size quickly, so a phone was
   downloading all of it on every visit: five minutes on a slow connection.
   Cache Storage keeps it until the site's storage is cleared. Every fetch
   in this worker (Pyodide's own included, which is why this replaces
   self.fetch before Pyodide loads) checks it first for the engine's files.
   A pyodide file is keyed without its query (the numpy fallback asks with
   ?r=), a toolkit file by its ?v= version; the manifest and art are never
   kept. Without Cache Storage everything simply goes to the network. */
var ENGINE_CACHE = 'token-engine-v1';
var netFetch = self.fetch.bind(self);
function engineKey(url) {
  var u = new URL(url, self.location.href);
  if (u.origin !== self.location.origin) return null;
  if (u.pathname.indexOf('/assets/pyodide/') === 0) return u.origin + u.pathname;
  if (u.pathname.indexOf('/assets/tokens/') === 0 && /^\?v=/.test(u.search)) return u.origin + u.pathname + u.search;
  return null;
}
if (self.caches) {
  self.fetch = function (input, init) {
    var key = engineKey(input instanceof Request ? input.url : String(input));   // Pyodide passes a URL object
    if (!key) return netFetch(input, init);
    return caches.open(ENGINE_CACHE).then(function (c) {
      return c.match(key).then(function (hit) {
        if (hit) return hit;
        return netFetch(input, init).then(function (r) {
          if (r.ok) c.put(key, r.clone()).catch(function () {});
          return r;
        });
      });
    }, function () { return netFetch(input, init); });
  };
}
/* A new toolkit version leaves the old one's files behind; drop them. */
function dropOldToolkit(v) {
  if (!self.caches) return;
  caches.open(ENGINE_CACHE).then(function (c) {
    return c.keys().then(function (keys) {
      keys.forEach(function (req) {
        var u = new URL(req.url);
        if (u.pathname.indexOf('/assets/tokens/') === 0 && u.search !== v) c.delete(req);
      });
    });
  }).catch(function () {});
}

function b64ToU8(b64) {
  var bin = atob(b64), u8 = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
function looksLikeImage(u8) {
  if (u8.length < 12) return false;
  if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) return true;      // PNG
  if (u8[0] === 0xFF && u8[1] === 0xD8 && u8[2] === 0xFF) return true;                        // JPEG
  if (u8[0] === 0x52 && u8[1] === 0x49 && u8[8] === 0x57 && u8[9] === 0x45) return true;      // WEBP
  if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x38) return true;      // GIF
  return false;
}

function fetchBytes(url) {
  return fetch(url).then(function (r) {
    if (!r.ok) throw new Error(url + ' -> ' + r.status);
    return r.arrayBuffer();
  }).then(function (b) { return new Uint8Array(b); });
}

function fsMkdirp(path) {
  var parts = path.split('/'), cur = '';
  for (var i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    cur += '/' + parts[i];
    try { pyodide.FS.mkdir(cur); } catch (e) { /* exists */ }
  }
}
function fsWrite(path, u8) {
  var dir = path.substring(0, path.lastIndexOf('/'));
  if (dir) fsMkdirp(dir);
  pyodide.FS.writeFile(path, u8);
}

/* loadPackage only LOGS a failed download, it never rejects, so a phone that
   dropped the numpy wheel went on to "No module named 'numpy'". Check what
   actually loaded. On a miss, fetch the wheel from a NEW address each try:
   the query string skips any copy the browser or Cloudflare kept, and Pyodide
   reads the package name off the #/file.whl fragment, which is never sent.
   A phone on Chrome kept failing numpy with "Failed to fetch" through two
   plain retries of the normal address. */
function loadPackages(index, names) {
  var errs = [];
  function missingOf(list) {
    var have = Object.keys(pyodide.loadedPackages).join(' ').toLowerCase().split(' ');   // keyed 'Pillow'
    return list.filter(function (n) { return have.indexOf(n) < 0; });
  }
  function load(what) {
    return pyodide.loadPackage(what, { errorCallback: function (m) { errs.push(m); } });
  }
  return load(names).then(function () {
    var missing = missingOf(names);
    if (!missing.length) return;
    return fetch(index + 'pyodide-lock.json', { cache: 'no-store' }).then(function (r) { return r.json(); })
      .then(function (lock) {
        var tries = 0;
        function again() {
          tries++;
          errs = [];
          return load(missing.map(function (n) {
            var f = lock.packages[n].file_name;
            return index + f + '?r=' + Date.now() + '#/' + f;
          })).then(function () {
            missing = missingOf(missing);
            if (!missing.length) return;
            if (tries >= 3) throw new Error('Could not load ' + missing.join(', ') + (errs.length ? ': ' + errs.join(' ') : ''));
            return new Promise(function (res) { setTimeout(res, tries * 2000); }).then(again);
          });
        }
        return again();
      });
  });
}

/* ---- boot: toolkit downloads run in parallel with Pyodide init ---- */
function boot(cfg) {
  post({ type: 'status', state: 'loading', message: 'Loading…' });

  // Kick off ALL toolkit downloads immediately (network runs in parallel
  // with the WASM init below). Files are held in memory until the FS exists.
  var filesP = fetch(cfg.tokBase + 'manifest.json?_=' + Date.now())
    .then(function (r) { if (!r.ok) throw new Error('manifest -> ' + r.status); return r.json(); })
    .then(function (man) {
      var v = man.v ? ('?v=' + encodeURIComponent(man.v)) : '';
      if (v) dropOldToolkit(v);
      return Promise.all(man.files.map(function (rel) {
        return fetchBytes(cfg.tokBase + rel + v).then(function (u8) { return { rel: rel, u8: u8 }; });
      }));
    });

  var pyP;
  try {
    post({ type: 'status', state: 'loading', message: 'Downloading Python…' });
    importScripts(cfg.index + 'pyodide.js');
    pyP = loadPyodide({ indexURL: cfg.index })
      .then(function (py) {
        pyodide = py;
        post({ type: 'status', state: 'loading', message: 'Loading numpy and Pillow…' });
        return loadPackages(cfg.index, ['numpy', 'pillow']);
      });
  } catch (e) { pyP = Promise.reject(e); }

  Promise.all([pyP, filesP]).then(function (both) {
    var files = both[1];
    post({ type: 'status', state: 'loading', message: 'Starting the token maker…' });
    try { pyodide.FS.mkdir(FSDIR); } catch (e) {}
    files.forEach(function (f) { fsWrite(FSDIR + '/' + f.rel, f.u8); });
    try { pyodide.FS.mkdir(FSDIR + '/art'); } catch (e) {}
    pyodide.runPython(
      "import os, sys\n" +
      "os.chdir('" + FSDIR + "')\n" +
      "if '" + FSDIR + "' not in sys.path: sys.path.insert(0,'" + FSDIR + "')\n" +
      "import web_render"
    );
    ready = true;
    post({ type: 'status', state: 'ready', message: 'Ready' });
    var q = queue; queue = [];
    q.forEach(handle);
  }).catch(function (err) {
    bootErr = err;
    post({ type: 'status', state: 'error', message: String(err && err.message || err) });
    var q = queue; queue = [];
    q.forEach(function (m) { if (m.id != null) post({ type: 'fail', id: m.id, message: 'Renderer failed to load.' }); });
  });
}

/* ---- art: fetch into the virtual FS (skips slugs already written) ---- */
function ensureArt(list) {
  var todo = (list || []).filter(function (a) { return a && a.slug && !artWritten[a.slug]; });
  return Promise.all(todo.map(function (a) {
    return fetchBytes(a.url).then(function (u8) {
      fsWrite(FSDIR + '/art/' + a.slug + '.png', u8);
      artWritten[a.slug] = true;
    }).catch(function (e) { /* missing art is handled by the renderer */ });
  }));
}

function pyCall(fn, argsJson, optsJson) {
  var mod = pyodide.globals.get('web_render');
  var out = mod[fn](argsJson, optsJson);
  return JSON.parse(out);
}

/* try direct fetch, then the wiki proxy (if deployed); validate it's a real image */
function fetchExternalArt(url) {
  function attempt(u) {
    return fetch(u).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.arrayBuffer();
    }).then(function (b) {
      var u8 = new Uint8Array(b);
      if (!looksLikeImage(u8)) throw new Error('not an image');
      return u8;
    });
  }
  return attempt(url).catch(function () {
    return attempt(PROXY_FETCH + encodeURIComponent(url));
  });
}

function handle(m) {
  if (m.type === 'preview') {
    ensureArt(m.art).then(function () {
      try {
        var res = pyCall('web_preview', JSON.stringify(m.payload), JSON.stringify(m.opts));
        post({ type: 'result', id: m.id, res: res });
      } catch (e) { post({ type: 'fail', id: m.id, message: String(e && e.message || e) }); }
    });
  } else if (m.type === 'render') {
    ensureArt(m.art).then(function () {
      try {
        var res = pyCall('web_sheets', JSON.stringify(m.payloads), JSON.stringify(m.opts));
        post({ type: 'result', id: m.id, res: res });
      } catch (e) { post({ type: 'fail', id: m.id, message: String(e && e.message || e) }); }
    });
  } else if (m.type === 'asset') {
    try {
      var pth = FSDIR + '/custom/' + m.kind + '.png';
      fsWrite(pth, b64ToU8(m.b64));
      var mod = pyodide.globals.get('web_render');
      var r = JSON.parse(mod.set_asset(m.kind, pth));
      post({ type: 'result', id: m.id, res: r });
    } catch (e) { post({ type: 'fail', id: m.id, message: String(e && e.message || e) }); }
  } else if (m.type === 'geometry') {
    try {
      var modg = pyodide.globals.get('web_render');
      post({ type: 'result', id: m.id, res: JSON.parse(modg.geometry()) });
    } catch (e) { post({ type: 'fail', id: m.id, message: String(e && e.message || e) }); }
  } else if (m.type === 'assetClear') {
    try {
      var mod2 = pyodide.globals.get('web_render');
      var r2 = JSON.parse(mod2.clear_asset(m.kind));
      post({ type: 'result', id: m.id, res: r2 });
    } catch (e) { post({ type: 'fail', id: m.id, message: String(e && e.message || e) }); }
  } else if (m.type === 'artBytes') {
    try {
      fsWrite(FSDIR + '/art/' + m.slug + '.png', b64ToU8(m.b64));
      artWritten[m.slug] = true;
      post({ type: 'result', id: m.id, res: { ok: true } });
    } catch (e) { post({ type: 'fail', id: m.id, message: String(e && e.message || e) }); }
  } else if (m.type === 'fetchArt') {
    var ok = [], failed = [];
    Promise.all((m.list || []).map(function (a) {
      return fetchExternalArt(a.url).then(function (u8) {
        fsWrite(FSDIR + '/art/' + a.slug + '.png', u8);
        artWritten[a.slug] = true;
        ok.push(a.slug);
      }).catch(function () { failed.push(a.slug); });
    })).then(function () {
      post({ type: 'result', id: m.id, res: { ok: ok, failed: failed } });
    });
  }
}

/* An error Pyodide throws from inside one of its own callbacks rejects a
   promise nobody awaits, and boot() then waits for good: the page sat on
   "Loading…" with no message. Before the engine is ready, any such error is
   the boot failing, so say so. */
self.addEventListener('unhandledrejection', function (e) {
  if (ready || bootErr) return;
  bootErr = e.reason || new Error('unknown error');
  post({ type: 'status', state: 'error', message: String(bootErr && bootErr.message || bootErr) });
});

self.onmessage = function (e) {
  var m = e.data || {};
  if (m.type === 'init') { boot(m); return; }
  if (bootErr) { if (m.id != null) post({ type: 'fail', id: m.id, message: 'Renderer failed to load.' }); return; }
  if (!ready) { queue.push(m); return; }
  handle(m);
};
