/* ============================================================================
   token-tool.js — Token Tool for botchomebrew.wiki
   Loads the real Python toolkit (gen/deco/reminder/web_render) in-browser via
   Pyodide and renders print-ready token sheets. Wiki characters only; art is
   same-origin (assets/...), so no CORS and no proxy.
   ============================================================================ */
(function () {
  'use strict';

  var INDEX = window.TT_PYODIDE_INDEX || 'assets/pyodide/';
  var TOK_BASE = 'assets/tokens/';            // toolkit .py + assets live here
  var SET_KEY = 'botc_token_set';             // persisted working set (array of slugs)
  var FSDIR = '/tok';

  var $ = function (id) { return document.getElementById(id); };
  var statusEl = $('status'), statusText = $('status-text');
  function setStatus(kind, msg) {
    statusEl.className = 'tt-status' + (kind ? ' ' + kind : '');
    statusText.textContent = msg;
  }

  // ---- state ----
  var charBySlug = {};       // slug -> character object
  var allChars = [];         // array for the picker
  var setSlugs = [];         // current working set
  var pyodide = null, pyReady = false, engineErr = null;
  var artWritten = {};       // slug -> true once art is in the FS

  var opts = {
    paper: 'A4', format: 'png', layout: 'grid',
    char_margin: 1.05, rem_margin: 1.10, pad_mm: 2,
    dpi: 400, want_char: true, want_rem: true, include_global: true,
    preview_scale: 0.42
  };

  // ---- helpers ----
  function loadSet() { try { return JSON.parse(localStorage.getItem(SET_KEY)) || []; } catch (e) { return []; } }
  function saveSet() { try { localStorage.setItem(SET_KEY, JSON.stringify(setSlugs)); } catch (e) {} }
  function artUrl(c) { return 'assets/' + (c.art || ('art/' + c.slug + '.png')); }
  function isGood(c) { return c.team === 'townsfolk' || c.team === 'outsider'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, function (m) { return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[m]; }); }

  // ---- data load ----
  function loadData() {
    return fetch('characters.json?_=' + Date.now()).then(function (r) { return r.json(); }).then(function (list) {
      allChars = list.filter(function (c) { return c && c.slug && c.ability; });
      allChars.forEach(function (c) { charBySlug[c.slug] = c; });
    });
  }

  // ---- collection resolution (ported from all-characters.html) ----
  function norm(x){ return String(x||'').toLowerCase().replace(/[^a-z0-9]+/g,''); }
  var AC_COLLECTIONS = [
    { slug:'Fall of Rome', match:['fallofrome'] },
    { slug:'Festival of Lanterns \u2014 Temple Fair', displayName:'Temple Fair', match:['festivaloflanternstemplefair','templefair'] },
    { slug:'Festival of Lanterns \u2014 The Storm Is Coming', displayName:'The Storm Is Coming', match:['festivaloflanternsthestormiscoming','thestormiscoming','stormiscoming'] },
    { slug:'Ravenswood Chronicle', match:['ravenswoodchronicle','ravenswoodchronicles'] },
    { slug:"A Midsummer Night's Dream", match:['amidsummernightsdream','midsummernightsdream','babybusamidsummernightsdream'] },
    { slug:'Travel by Starlight', match:['travelbystarlight'] },
    { slug:'Standalone', match:[] }
  ];
  function findCollection(param){
    if(!param) return null; var n=norm(param);
    for(var i=0;i<AC_COLLECTIONS.length;i++){ var c=AC_COLLECTIONS[i];
      if(norm(c.slug)===n || norm(c.displayName||'')===n || c.match.indexOf(n)!==-1) return c; }
    return null;
  }
  function charInCollection(c, coll){
    if(!coll) return false;
    if(coll.slug==='Standalone'){ var a=norm(c.appearsIn); if(!a) return true;
      for(var i=0;i<AC_COLLECTIONS.length-1;i++){ if(AC_COLLECTIONS[i].match.indexOf(a)!==-1) return false; } return true; }
    return coll.match.indexOf(norm(c.appearsIn))!==-1;
  }

  // resolve URL entry points. ?script / ?collection -> REPLACE the set (you're opening it);
  // ?chars -> ADD to the existing persisted set (accumulate while browsing).
  function ingestUrl() {
    var q = new URLSearchParams(location.search);
    var hasScript = !!q.get('script'), hasColl = !!q.get('collection');
    var incoming = [];
    if (q.get('chars')) incoming = incoming.concat(q.get('chars').split(',').map(function(x){return x.trim();}).filter(Boolean));
    if (hasColl) {
      var coll = findCollection(q.get('collection'));
      if (coll) allChars.forEach(function(c){ if (charInCollection(c, coll)) incoming.push(c.slug); });
    }
    var jobs = [];
    if (hasScript) {
      jobs.push(fetch('scripts.json?_=' + Date.now()).then(function(r){return r.json();}).then(function(scripts){
        var sc = scripts.filter(function(x){ return x.slug === q.get('script'); })[0];
        if (sc && sc.characters) incoming = incoming.concat(sc.characters);
      }).catch(function(){}));
    }
    return Promise.all(jobs).then(function(){
      var valid = incoming.filter(function(sl){ return charBySlug[sl]; });
      if (hasScript || hasColl) setSlugs = [];        // opening a defined set -> replace
      valid.forEach(function(sl){ if (setSlugs.indexOf(sl) < 0) setSlugs.push(sl); });
    });
  }

  // ---- working-set UI ----
  function renderSet() {
    var box = $('set'); box.innerHTML = '';
    setSlugs.forEach(function (sl) {
      var c = charBySlug[sl]; if (!c) return;
      var chip = document.createElement('span');
      chip.className = 'tt-chip' + (isGood(c) ? '' : ' evil');
      chip.innerHTML = '<img src="' + esc(artUrl(c)) + '" alt="" onerror="this.style.visibility=\'hidden\'">' +
        '<span>' + esc(c.name) + '</span><button class="x" title="Remove" aria-label="Remove">×</button>';
      chip.querySelector('.x').onclick = function () {
        setSlugs = setSlugs.filter(function (x) { return x !== sl; });
        saveSet(); renderSet(); schedulePreview(); refreshGenerate();
      };
      box.appendChild(chip);
    });
    $('set-count').textContent = setSlugs.length + ' character' + (setSlugs.length === 1 ? '' : 's');
  }

  function addSlug(sl) {
    if (!charBySlug[sl] || setSlugs.indexOf(sl) >= 0) return;
    setSlugs.push(sl); saveSet(); renderSet(); schedulePreview(); refreshGenerate();
  }

  // ---- picker (type-ahead) ----
  function wirePicker() {
    var inp = $('picker'), drop = $('picker-drop');
    function close() { drop.hidden = true; drop.innerHTML = ''; }
    inp.addEventListener('input', function () {
      var q = inp.value.trim().toLowerCase();
      if (!q) { close(); return; }
      var hits = allChars.filter(function (c) { return c.name.toLowerCase().indexOf(q) >= 0 && setSlugs.indexOf(c.slug) < 0; }).slice(0, 8);
      if (!hits.length) { close(); return; }
      drop.innerHTML = '';
      hits.forEach(function (c) {
        var b = document.createElement('button');
        b.innerHTML = '<img src="' + esc(artUrl(c)) + '" alt="" onerror="this.style.visibility=\'hidden\'">' +
          '<span><span class="nm">' + esc(c.name) + '</span><br><span class="ab">' + esc((c.ability || '').slice(0, 60)) + '</span></span>';
        b.onclick = function () { addSlug(c.slug); inp.value = ''; close(); inp.focus(); };
        drop.appendChild(b);
      });
      drop.hidden = false;
    });
    document.addEventListener('click', function (e) { if (!drop.contains(e.target) && e.target !== inp) close(); });
  }

  // ---- options wiring ----
  function wireOptions() {
    function seg(id, key, cast) {
      var g = $(id);
      g.querySelectorAll('button').forEach(function (btn) {
        btn.onclick = function () {
          g.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', 'false'); });
          btn.setAttribute('aria-pressed', 'true');
          opts[key] = cast ? cast(btn.dataset.v) : btn.dataset.v;
          schedulePreview();
        };
      });
    }
    seg('opt-paper', 'paper');
    seg('opt-format', 'format');
    seg('opt-layout', 'layout');
    seg('opt-dpi', 'dpi', Number);

    function rng(id, outId, key, fmt, toVal) {
      var r = $(id), o = $(outId);
      r.oninput = function () {
        o.innerHTML = fmt(r.value);
        opts[key] = toVal ? toVal(r.value) : Number(r.value);
        schedulePreview();
      };
    }
    rng('opt-cmargin', 'out-cmargin', 'char_margin', function (v) { return v + '%'; }, function (v) { return 1 + Number(v) / 100; });
    rng('opt-rmargin', 'out-rmargin', 'rem_margin', function (v) { return v + '%'; }, function (v) { return 1 + Number(v) / 100; });
    rng('opt-pad', 'out-pad', 'pad_mm', function (v) { return v + '&nbsp;mm'; });

    $('opt-char').onchange = function () { opts.want_char = this.checked; refreshGenerate(); };
    $('opt-rem').onchange = function () { opts.want_rem = this.checked; refreshGenerate(); };
    $('opt-global').onchange = function () { opts.include_global = this.checked; };
    $('clear-set').onclick = function () { setSlugs = []; saveSet(); renderSet(); schedulePreview(); refreshGenerate(); };
  }

  // ---- Pyodide bootstrap (warm in background) ----
  function injectScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = src;
      s.onload = res; s.onerror = function () { rej(new Error('failed to load ' + src)); };
      document.head.appendChild(s);
    });
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
  function fetchBytes(url) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error(url + ' -> ' + r.status); return r.arrayBuffer(); })
      .then(function (b) { return new Uint8Array(b); });
  }

  function bootEngine() {
    setStatus('busy', 'Loading renderer (first visit downloads ~17 MB; later visits are cached)…');
    return injectScript(INDEX + 'pyodide.js')
      .then(function () { return loadPyodide({ indexURL: INDEX }); })
      .then(function (py) { pyodide = py; setStatus('busy', 'Loading numpy + Pillow…'); return py.loadPackage(['numpy', 'pillow']); })
      .then(function () {
        setStatus('busy', 'Unpacking the toolkit…');
        try { pyodide.FS.mkdir(FSDIR); } catch (e) {}
        return fetch(TOK_BASE + 'manifest.json?_=' + Date.now()).then(function (r) { return r.json(); });
      })
      .then(function (man) {
        return Promise.all(man.files.map(function (rel) {
          return fetchBytes(TOK_BASE + rel).then(function (u8) { fsWrite(FSDIR + '/' + rel, u8); });
        }));
      })
      .then(function () {
        try { pyodide.FS.mkdir(FSDIR + '/art'); } catch (e) {}
        pyodide.runPython("import os, sys\nos.chdir('" + FSDIR + "')\nif '" + FSDIR + "' not in sys.path: sys.path.insert(0,'" + FSDIR + "')\nimport web_render");
        pyReady = true;
        setStatus('ready', 'Renderer ready.');
        refreshGenerate(); schedulePreview();
      })
      .catch(function (err) {
        engineErr = err; console.error(err);
        setStatus('err', 'Renderer failed to load: ' + err.message + ' — try a refresh, or tell DJ.');
      });
  }

  // ---- art -> FS ----
  function ensureArt(slugs) {
    var todo = slugs.filter(function (sl) { return !artWritten[sl] && charBySlug[sl]; });
    return Promise.all(todo.map(function (sl) {
      var c = charBySlug[sl];
      return fetchBytes(artUrl(c)).then(function (u8) {
        fsWrite(FSDIR + '/art/' + sl + '.png', u8); artWritten[sl] = true;
      }).catch(function (e) { console.warn('art failed for', sl, e); });
    }));
  }
  function payloadFor(sl) {
    var c = charBySlug[sl];
    return {
      name: c.name, ability: c.ability, team: c.team,
      firstNight: c.firstNight, otherNight: c.otherNight, setup: c.setup,
      reminders: c.reminders || [], remindersGlobal: c.remindersGlobal || [],
      _art: 'art/' + sl + '.png'
    };
  }

  // ---- preview (debounced) ----
  var previewTimer = null;
  function schedulePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(doPreview, 280); }
  function doPreview() {
    var box = $('preview');
    if (!setSlugs.length) { box.innerHTML = '<span class="ph">Add a character to preview a token</span>'; return; }
    if (!pyReady) { box.innerHTML = '<span class="ph">Preview will appear once the renderer is ready…</span>'; return; }
    var sl = setSlugs[0];
    ensureArt([sl]).then(function () {
      try {
        var res = JSON.parse(pyodide.globals.get('web_render').web_preview(JSON.stringify(payloadFor(sl)), JSON.stringify(opts)));
        if (res.error) { box.innerHTML = '<span class="ph">No art for ' + esc(charBySlug[sl].name) + '</span>'; return; }
        box.innerHTML = '<img alt="token preview" src="data:image/png;base64,' + res.png + '">';
      } catch (e) { console.error(e); box.innerHTML = '<span class="ph">Preview error (see console)</span>'; }
    });
  }

  // ---- generate ----
  function refreshGenerate() {
    $('generate').disabled = !(pyReady && setSlugs.length && (opts.want_char || opts.want_rem));
  }
  function wireGenerate() {
    $('generate').onclick = function () {
      if (!pyReady || !setSlugs.length) return;
      var btn = this; btn.disabled = true;
      $('output').innerHTML = ''; $('thumbs').innerHTML = '';
      setStatus('busy', 'Rendering sheets… (this can take a little while for big sets)');
      ensureArt(setSlugs).then(function () {
        // let the busy status paint before the synchronous Python call
        return new Promise(function (r) { setTimeout(r, 40); });
      }).then(function () {
        try {
          var payload = setSlugs.map(payloadFor);
          var res = JSON.parse(pyodide.globals.get('web_render').web_sheets(JSON.stringify(payload), JSON.stringify(opts)));
          showOutput(res);
          setStatus('ready', 'Done — ' + res.counts.char + ' character + ' + res.counts.rem + ' reminder tokens.');
        } catch (e) {
          console.error(e); setStatus('err', 'Render error: ' + e.message);
        } finally { btn.disabled = false; refreshGenerate(); }
      });
    };
  }
  function showOutput(res) {
    var out = $('output'), thumbs = $('thumbs');
    if (!res.files.length) { out.innerHTML = '<p style="color:var(--maroon)">Nothing to render — check your sheet selections.</p>'; return; }
    res.files.forEach(function (f) {
      var url = 'data:' + f.mime + ';base64,' + f.b64;
      var a = document.createElement('a'); a.href = url; a.download = f.name;
      a.innerHTML = '&#11015; ' + esc(f.name);
      out.appendChild(a);
      if (f.mime === 'image/png') {
        var img = document.createElement('img'); img.src = url; img.alt = f.name; thumbs.appendChild(img);
      }
    });
  }

  // ---- init ----
  setStatus('busy', 'Loading character data…');
  loadData().then(function () {
    setSlugs = loadSet().filter(function (sl) { return charBySlug[sl]; });
    return ingestUrl();
  }).then(function () {
    saveSet(); renderSet(); wirePicker(); wireOptions(); wireGenerate();
    bootEngine();   // warm the engine in the background while the user sets options
  }).catch(function (err) {
    console.error(err); setStatus('err', 'Could not load character data: ' + err.message);
  });
})();
