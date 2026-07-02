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

/* ---- boot: toolkit downloads run in parallel with Pyodide init ---- */
function boot(cfg) {
  post({ type: 'status', state: 'loading', message: 'Loading…' });

  // Kick off ALL toolkit downloads immediately (network runs in parallel
  // with the WASM init below). Files are held in memory until the FS exists.
  var filesP = fetch(cfg.tokBase + 'manifest.json?_=' + Date.now())
    .then(function (r) { if (!r.ok) throw new Error('manifest -> ' + r.status); return r.json(); })
    .then(function (man) {
      var v = man.v ? ('?v=' + encodeURIComponent(man.v)) : '';
      return Promise.all(man.files.map(function (rel) {
        return fetchBytes(cfg.tokBase + rel + v).then(function (u8) { return { rel: rel, u8: u8 }; });
      }));
    });

  var pyP;
  try {
    importScripts(cfg.index + 'pyodide.js');
    pyP = loadPyodide({ indexURL: cfg.index })
      .then(function (py) { pyodide = py; return py.loadPackage(['numpy', 'pillow']); });
  } catch (e) { pyP = Promise.reject(e); }

  Promise.all([pyP, filesP]).then(function (both) {
    var files = both[1];
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
  }
}

self.onmessage = function (e) {
  var m = e.data || {};
  if (m.type === 'init') { boot(m); return; }
  if (bootErr) { if (m.id != null) post({ type: 'fail', id: m.id, message: 'Renderer failed to load.' }); return; }
  if (!ready) { queue.push(m); return; }
  handle(m);
};
