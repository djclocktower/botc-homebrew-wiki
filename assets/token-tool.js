/* ============================================================================
   token-tool.js — Token Tool for botchomebrew.wiki (v2)
   The Pyodide renderer lives in a Web Worker (assets/token-worker.js), so the
   page stays responsive while it loads and renders. The worker starts on the
   very first line — character data loads in parallel with the engine.
   ============================================================================ */
(function () {
  'use strict';

  var ROOT = new URL('.', location.href).href;
  var SET_KEY = 'botc_token_set';

  /* ---- engine (Web Worker) — start it IMMEDIATELY, before anything else ---- */
  var worker = new Worker('assets/token-worker.js');
  worker.postMessage({
    type: 'init',
    index: ROOT + 'assets/pyodide/',
    tokBase: ROOT + 'assets/tokens/'
  });

  var pyReady = false, engineErr = null;
  var pending = {}, reqSeq = 0;
  function callWorker(type, msg) {
    return new Promise(function (res, rej) {
      var id = ++reqSeq;
      pending[id] = { res: res, rej: rej };
      msg.type = type; msg.id = id;
      worker.postMessage(msg);
    });
  }
  worker.onmessage = function (e) {
    var m = e.data || {};
    if (m.type === 'status') {
      if (m.state === 'ready') { pyReady = true; hideLoad(); refreshGenerate(); schedulePreview(); }
      else if (m.state === 'error') { engineErr = m.message; hideLoad(); showMsg('err', 'The renderer failed to load — try a refresh, or tell DJ. (' + esc(m.message) + ')'); }
      return;
    }
    var p = pending[m.id]; if (!p) return; delete pending[m.id];
    if (m.type === 'result') p.res(m.res); else p.rej(new Error(m.message || 'Render failed'));
  };
  worker.onerror = function (e) {
    engineErr = e.message; hideLoad();
    showMsg('err', 'The renderer failed to load — try a refresh, or tell DJ.');
  };

  /* ---- tiny DOM helpers ---- */
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, function (m) { return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[m]; }); }

  /* ---- loading bar + messages ---- */
  function showLoad(text) { var el = $('tt-load'); el.classList.remove('done'); $('tt-load-text').textContent = text || 'Loading…'; }
  function hideLoad() { $('tt-load').classList.add('done'); }
  function showMsg(kind, html) { var el = $('tt-msg'); el.className = 'tt-msg ' + kind; el.innerHTML = html; }
  function clearMsg() { var el = $('tt-msg'); el.className = 'tt-msg'; el.innerHTML = ''; }

  /* ---- state ---- */
  var charBySlug = {}, allChars = [], setSlugs = [];
  var TEAMS = [
    ['townsfolk', 'Townsfolk'], ['outsider', 'Outsiders'], ['minion', 'Minions'],
    ['demon', 'Demons'], ['traveller', 'Travellers'], ['fabled', 'Fabled'], ['loric', 'Loric']
  ];
  var opts = {
    paper: 'A4', format: 'png', layout: 'grid',
    char_margin: 1.05, rem_margin: 1.10, pad_mm: 2,
    dpi: 400, want_char: true, want_rem: true,
    preview_scale: (window.matchMedia && matchMedia('(max-width: 820px)').matches) ? 0.32 : 0.42
  };

  function loadSet() { try { return JSON.parse(localStorage.getItem(SET_KEY)) || []; } catch (e) { return []; } }
  function saveSet() { try { localStorage.setItem(SET_KEY, JSON.stringify(setSlugs)); } catch (e) {} }
  function artRel(c) { return 'assets/' + (c.art || ('art/' + c.slug + '.png')); }
  function artAbs(c) { return ROOT + artRel(c); }

  /* ---- data load (in parallel with the engine boot above) ---- */
  function loadData() {
    return fetch('characters.json?_=' + Date.now()).then(function (r) { return r.json(); }).then(function (list) {
      allChars = list.filter(function (c) { return c && c.slug && c.ability; });
      allChars.forEach(function (c) { charBySlug[c.slug] = c; });
    });
  }

  /* ---- collection resolution (mirrors all-characters.html: always fetched live, never hardcoded) ---- */
  function norm(x) { return String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
  function findCollection(list, param) {
    if (!param) return null; var n = norm(param);
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (norm(c.slug) === n || norm(c.displayName || '') === n || (c.match || []).indexOf(n) !== -1) return c;
    }
    return null;
  }
  function charInCollection(c, coll, list) {
    if (!coll) return false;
    if (coll.standalone) {
      var a = norm(c.appearsIn); if (!a) return true;
      for (var i = 0; i < list.length; i++) { if (!list[i].standalone && (list[i].match || []).indexOf(a) !== -1) return false; }
      return true;
    }
    return (coll.match || []).indexOf(norm(c.appearsIn)) !== -1;
  }

  /* ?script / ?collection -> REPLACE the set; ?chars -> ADD to the set */
  function ingestUrl() {
    var q = new URLSearchParams(location.search);
    var hasScript = !!q.get('script'), hasColl = !!q.get('collection');
    var incoming = [];
    if (q.get('chars')) incoming = incoming.concat(q.get('chars').split(',').map(function (x) { return x.trim(); }).filter(Boolean));
    var jobs = [];
    if (hasScript) {
      jobs.push(fetch('scripts.json?_=' + Date.now()).then(function (r) { return r.json(); }).then(function (scripts) {
        var sc = scripts.filter(function (x) { return x.slug === q.get('script'); })[0];
        if (sc && sc.characters) incoming = incoming.concat(sc.characters);
      }).catch(function () {}));
    }
    if (hasColl) {
      jobs.push(fetch('collections.json?_=' + Date.now()).then(function (r) { return r.json(); }).catch(function () { return []; }).then(function (collData) {
        var list = (collData || []).map(function (c) {
          return { id: c.id, slug: c.slug, displayName: c.displayName || c.slug, match: c.match || [] };
        });
        list.push({ id: 'standalone', slug: 'Standalone', displayName: 'Standalone Characters', match: [], standalone: true });
        var coll = findCollection(list, q.get('collection'));
        if (coll) allChars.forEach(function (c) { if (charInCollection(c, coll, list)) incoming.push(c.slug); });
      }));
    }
    return Promise.all(jobs).then(function () {
      var valid = incoming.filter(function (sl) { return charBySlug[sl]; });
      if (hasScript || hasColl) setSlugs = [];
      valid.forEach(function (sl) { if (setSlugs.indexOf(sl) < 0) setSlugs.push(sl); });
    });
  }

  /* ---- LEFT SIDEBAR: all characters, grouped by team (Script Builder style) ---- */
  function renderSidebar(filter) {
    filter = (filter || '').trim().toLowerCase();
    var html = '';
    TEAMS.forEach(function (t) {
      var key = t[0], label = t[1];
      var group = allChars.filter(function (c) {
        if (c.team !== key) return false;
        if (filter && (c.name || '').toLowerCase().indexOf(filter) === -1) return false;
        return true;
      }).sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
      if (!group.length) return;
      html += '<div class="sb-add-group"><h3 class="sb-add-grouphead">' + esc(label) + '</h3>';
      group.forEach(function (c) {
        var on = setSlugs.indexOf(c.slug) >= 0;
        var ability = c.ability || '';
        html += '<div class="sb-add-row">' +
          '<button type="button" class="sb-add-item' + (on ? ' on' : '') + '" data-slug="' + esc(c.slug) + '">' +
            '<img class="sb-add-thumb" src="' + esc(artRel(c)) + '" alt="" onerror="this.src=\'assets/favicon.png\'">' +
            '<span class="sb-add-name">' + esc(c.name) + '</span>' +
          '</button>' +
          (ability
            ? '<button type="button" class="sb-add-chevron" data-slug="' + esc(c.slug) + '" aria-label="Show ability" aria-expanded="false">&#9662;</button>' +
              '<div class="sb-add-ability" id="tta-' + esc(c.slug) + '" hidden>' + esc(ability) + '</div>'
            : '') +
          '</div>';
      });
      html += '</div>';
    });
    $('sb-add-list').innerHTML = html || '<p class="sb-loading">No matches.</p>';
  }

  function wireSidebar() {
    $('sb-add-list').addEventListener('click', function (e) {
      var chev = e.target.closest('.sb-add-chevron');
      if (chev) {
        var box = $('tta-' + chev.dataset.slug);
        if (box) { box.hidden = !box.hidden; chev.classList.toggle('open', !box.hidden); chev.setAttribute('aria-expanded', String(!box.hidden)); }
        return;
      }
      var item = e.target.closest('.sb-add-item');
      if (!item) return;
      var sl = item.dataset.slug;
      if (setSlugs.indexOf(sl) >= 0) removeSlug(sl); else addSlug(sl);
    });
    $('sb-filter').addEventListener('input', function () { renderSidebar(this.value); });
    $('sb-mobile-toggle').addEventListener('click', function () { $('sb-add-sidebar').classList.add('open'); });
    $('sb-close-mobile').addEventListener('click', function () { $('sb-add-sidebar').classList.remove('open'); });
  }

  /* ---- working set (main column, Script Builder rows) ---- */
  function addSlug(sl) {
    if (!charBySlug[sl] || setSlugs.indexOf(sl) >= 0) return;
    setSlugs.push(sl); saveSet(); renderAll(); schedulePreview(); refreshGenerate();
  }
  function removeSlug(sl) {
    setSlugs = setSlugs.filter(function (x) { return x !== sl; });
    saveSet(); renderAll(); schedulePreview(); refreshGenerate();
  }
  function renderSet() {
    var box = $('tt-set');
    $('tt-count').textContent = setSlugs.length + ' character' + (setSlugs.length === 1 ? '' : 's');
    var chars = setSlugs.map(function (sl) { return charBySlug[sl]; }).filter(Boolean);
    if (!chars.length) { box.innerHTML = '<p class="sb-empty">Your set is empty. Add characters from the sidebar.</p>'; return; }
    var html = '';
    TEAMS.forEach(function (t) {
      var key = t[0], label = t[1];
      var group = chars.filter(function (c) { return c.team === key; });
      if (!group.length) return;
      html += '<div class="sb-script-group"><h3 class="sb-script-grouphead">' + esc(label) + ' <span>(' + group.length + ')</span></h3>';
      group.forEach(function (c) {
        html += '<div class="sb-script-item">' +
          '<img class="sb-script-thumb" src="' + esc(artRel(c)) + '" alt="" onerror="this.src=\'assets/favicon.png\'">' +
          '<div class="sb-script-info"><span class="sb-script-name">' + esc(c.name) + '</span>' +
          '<span class="sb-script-ability">' + esc(c.ability || '') + '</span></div>' +
          '<button type="button" class="sb-script-remove" data-slug="' + esc(c.slug) + '" aria-label="Remove">✕</button>' +
          '</div>';
      });
      html += '</div>';
    });
    box.innerHTML = html;
  }
  function renderAll() { renderSet(); renderSidebar($('sb-filter').value); }
  function wireSet() {
    $('tt-set').addEventListener('click', function (e) {
      var btn = e.target.closest('.sb-script-remove');
      if (btn) removeSlug(btn.dataset.slug);
    });
    $('tt-clear').onclick = function () { setSlugs = []; saveSet(); renderAll(); schedulePreview(); refreshGenerate(); };
  }

  /* ---- options ---- */
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
  }

  /* ---- payloads ---- */
  function payloadFor(sl) {
    var c = charBySlug[sl];
    return {
      name: c.name, ability: c.ability, team: c.team,
      firstNight: c.firstNight, otherNight: c.otherNight, setup: c.setup,
      reminders: c.reminders || [], remindersGlobal: c.remindersGlobal || [],
      _art: 'art/' + sl + '.png'
    };
  }
  function artList(slugs) {
    return slugs.map(function (sl) {
      var c = charBySlug[sl]; if (!c) return null;
      return { slug: sl, url: artAbs(c) };
    }).filter(Boolean);
  }

  /* ---- preview (debounced, rendered in the worker) ---- */
  var previewTimer = null, previewSeq = 0;
  function schedulePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(doPreview, 280); }
  function doPreview() {
    var box = $('preview');
    if (!setSlugs.length) { box.innerHTML = '<span class="ph">Add a character to preview a token</span>'; return; }
    if (!pyReady) { box.innerHTML = '<span class="ph">Preview will appear once loading finishes…</span>'; return; }
    var sl = setSlugs[0], mySeq = ++previewSeq;
    callWorker('preview', { payload: payloadFor(sl), opts: opts, art: artList([sl]) })
      .then(function (res) {
        if (mySeq !== previewSeq) return; // a newer preview superseded this one
        if (res.error) { box.innerHTML = '<span class="ph">No art for ' + esc(charBySlug[sl].name) + '</span>'; return; }
        box.innerHTML = '<img alt="token preview" src="data:image/png;base64,' + res.png + '">';
      })
      .catch(function (e) { if (mySeq === previewSeq) box.innerHTML = '<span class="ph">Preview error (see console)</span>'; console.error(e); });
  }

  /* ---- generate ---- */
  function refreshGenerate() {
    $('generate').disabled = !(pyReady && setSlugs.length && (opts.want_char || opts.want_rem));
  }
  function wireGenerate() {
    $('generate').onclick = function () {
      if (!pyReady || !setSlugs.length) return;
      var btn = this; btn.disabled = true;
      $('output').innerHTML = ''; $('thumbs').innerHTML = ''; clearMsg();
      showLoad('Rendering…');
      callWorker('render', { payloads: setSlugs.map(payloadFor), opts: opts, art: artList(setSlugs) })
        .then(function (res) {
          hideLoad(); showOutput(res);
          showMsg('ok', 'Done — ' + res.counts.char + ' character + ' + res.counts.rem + ' reminder tokens.');
        })
        .catch(function (e) { hideLoad(); console.error(e); showMsg('err', 'Render error: ' + esc(e.message)); })
        .then(function () { btn.disabled = false; refreshGenerate(); });
    };
  }
  function showOutput(res) {
    var out = $('output'), thumbs = $('thumbs');
    if (!res.files.length) { showMsg('err', 'Nothing to render — check your sheet selections.'); return; }
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

  /* ---- init (character data loads in parallel with the engine boot) ---- */
  showLoad('Loading…');
  loadData().then(function () {
    setSlugs = loadSet().filter(function (sl) { return charBySlug[sl]; });
    return ingestUrl();
  }).then(function () {
    saveSet(); renderAll(); wireSidebar(); wireSet(); wireOptions(); wireGenerate();
    refreshGenerate(); schedulePreview();
  }).catch(function (err) {
    console.error(err); hideLoad();
    showMsg('err', 'Could not load character data: ' + esc(err.message));
  });
})();
