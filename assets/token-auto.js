/* ============================================================================
   token-auto.js — the character editors' door into the token renderer.

   Ticking "Show the token in this page's icon gallery" must not send anybody
   to the Token Tool first: a token rendered with the COMPLETE DEFAULT
   settings appears by itself, and the Token Tool's per-token editor is the
   opt-in for fine-tuning it. This file owns that: a lazy copy of the same
   Pyodide engine the Token Tool runs (assets/token-worker.js — nothing is
   loaded until a page actually asks for a token), and the mount() logic the
   two editors share so create.html and edit.html cannot drift.

   The engine is ~15 MB on first use (Pyodide + the toolkit, both cached
   immutable after that), which is why NOTHING here runs at page load: the
   worker starts on the first render() call, i.e. the first time the tick is
   on with art to draw from.

   mount(opts) wires one editor's Printable token slot. The page hands in
   closures over its own state rather than DOM ids, because the two editors
   hold their art in page-local variables:
     gather()   -> the form as an entry object (name/ability/team/setup/
                   firstNight/otherNight/reminders/remindersGlobal)
     art()      -> the primary icon as a data URL or same-origin URL, or null
     hasToken() -> a token image already exists (saved on the row, or
                   uploaded by hand this visit)
     apply(url) -> take the rendered token as if it had been uploaded
     hint(text) -> the slot's status line
   and gets back { poke, manual }:
     poke()   — call whenever the form or the art changed (the editors call
                it from update(), so it is debounced and keyed here: a poke
                that changes nothing on the token renders nothing).
     manual() — the reader uploaded their own file; stop regenerating over it.
   ============================================================================ */
(function () {
  'use strict';

  var ROOT = new URL('.', location.href).href;

  /* ---- the engine, started on first use ----
     The worker queues messages until Pyodide is ready and answers failures
     itself, so callers never need a separate "is it ready" dance. */
  var worker = null, bootErr = null, pending = {}, reqSeq = 0;
  function ensureWorker() {
    if (worker || bootErr) return;
    try {
      worker = new Worker(ROOT + 'assets/token-worker.js');
    } catch (e) {
      bootErr = 'The token engine could not start.';
      return;
    }
    worker.postMessage({
      type: 'init',
      index: ROOT + 'assets/pyodide/',
      tokBase: ROOT + 'assets/tokens/'
    });
    worker.onmessage = function (e) {
      var m = e.data || {};
      if (m.type === 'status') {
        if (m.state === 'error') failAll(m.message || 'The token engine failed to load.');
        return;
      }
      var p = pending[m.id]; if (!p) return; delete pending[m.id];
      if (m.type === 'result') p.res(m.res); else p.rej(new Error(m.message || 'Render failed'));
    };
    worker.onerror = function (e) { failAll((e && e.message) || 'The token engine failed to load.'); };
  }
  function failAll(msg) {
    bootErr = msg;
    Object.keys(pending).forEach(function (id) {
      pending[id].rej(new Error(msg)); delete pending[id];
    });
  }
  function callWorker(type, msg) {
    return new Promise(function (res, rej) {
      if (bootErr) return rej(new Error(bootErr));
      ensureWorker();
      if (bootErr || !worker) return rej(new Error(bootErr || 'The token engine could not start.'));
      var id = ++reqSeq;
      pending[id] = { res: res, rej: rej };
      msg.type = type; msg.id = id;
      worker.postMessage(msg);
    });
  }

  /* art as base64 bytes: a data URL is split, a same-origin URL is fetched */
  function artB64(src) {
    if (typeof src !== 'string' || !src) return Promise.reject(new Error('No art to draw the token from.'));
    if (src.indexOf('data:') === 0) {
      var i = src.indexOf(',');
      if (i < 0) return Promise.reject(new Error('Unreadable art.'));
      return Promise.resolve(src.slice(i + 1));
    }
    return fetch(src).then(function (r) {
      if (!r.ok) throw new Error('The art could not be fetched.');
      return r.blob();
    }).then(function (blob) {
      return new Promise(function (res, rej) {
        var fr = new FileReader();
        fr.onload = function () { res(String(fr.result).split(',', 2)[1]); };
        fr.onerror = function () { rej(new Error('The art could not be read.')); };
        fr.readAsDataURL(blob);
      });
    });
  }

  /* One full-size token, complete default settings. Resolves with a PNG data
     URL — the same thing the slot's own file input would have produced.
     One fixed FS name: the art write is awaited before the render reads it,
     mount() never overlaps two renders, and a fresh name per render would
     grow the worker's virtual FS by one icon per regeneration. */
  function render(entry, artSrc) {
    var fsSlug = '__auto__';
    return artB64(artSrc)
      .then(function (b64) { return callWorker('artBytes', { slug: fsSlug, b64: b64 }); })
      .then(function () {
        return callWorker('preview', {
          payload: {
            name: String(entry.name || ''), ability: String(entry.ability || ''),
            team: entry.team, setup: !!entry.setup,
            firstNight: Number(entry.firstNight) || 0,
            otherNight: Number(entry.otherNight) || 0,
            reminders: entry.reminders || [], remindersGlobal: entry.remindersGlobal || [],
            _art: 'art/' + fsSlug + '.png', _adj: {}, _count: 1, _rem: []
          },
          opts: { char_margin: 1.05, preview_scale: 1, ignore_premade: true },
          art: []
        });
      })
      .then(function (res) {
        if (res.error) throw new Error('The art could not be rendered onto a token.');
        return 'data:image/png;base64,' + res.png;
      });
  }

  function mount(opts) {
    var tick = document.getElementById('tokenArt');
    if (!tick) return null;
    var busy = false, again = false, auto = false, lastKey = null, timer = null;

    function payloadKey(entry, art) {
      return JSON.stringify([
        entry.name, entry.ability, entry.team, !!entry.setup,
        Number(entry.firstNight) || 0, Number(entry.otherNight) || 0,
        entry.reminders, entry.remindersGlobal,
        // enough of the art to notice it changed without keying megabytes
        typeof art === 'string' ? art.length + '|' + art.slice(0, 128) + art.slice(-64) : null
      ]);
    }

    function maybe() {
      if (!tick.checked) return;
      // A guest on an opened page cannot upload into the token slot, so a
      // token drawn for them would only make their save fail — say so
      // instead of rendering one.
      if (opts.allowed && !opts.allowed()) {
        opts.hint('The printable token is the page owner’s (or an approved editor’s) to change.');
        return;
      }
      // A real token already stands — saved on the row, or uploaded by hand
      // this visit. Only a token this mount drew itself is redrawn.
      if (opts.hasToken() && !auto) return;
      var art = opts.art();
      if (!art) { opts.hint('Upload character art first — the default token is drawn from it.'); return; }
      var entry = opts.gather();
      if (!entry.name) { opts.hint('Give the character a name first — it is written around the token.'); return; }
      if (!entry.ability) { opts.hint('Write the ability first — it is printed on the token.'); return; }
      var k = payloadKey(entry, art);
      if (k === lastKey) return;
      if (busy) { again = true; return; }
      busy = true; lastKey = k;
      opts.hint(worker ? 'Drawing the default token…' : 'Drawing the default token… (the first one loads the token engine, so it takes a moment)');
      render(entry, art).then(function (url) {
        busy = false; auto = true;
        opts.apply(url);
        opts.hint('Default token, drawn from this page — it updates as you edit, and saves with the character. Fine-tune it in the Token Tool if you like.');
        if (again) { again = false; maybe(); }
      }, function (e) {
        busy = false;
        again = false;
        opts.hint('Could not draw a token: ' + ((e && e.message) || 'render failed') + ' You can still upload a finished token image below.');
      });
    }

    function poke() {
      clearTimeout(timer);
      timer = setTimeout(maybe, 900);
    }
    tick.addEventListener('change', function () { if (tick.checked) maybe(); });

    return {
      poke: poke,
      manual: function () { auto = false; lastKey = null; }
    };
  }

  window.TokenAuto = { render: render, mount: mount };
})();
