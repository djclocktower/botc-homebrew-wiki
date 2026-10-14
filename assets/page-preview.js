/* page-preview.js: the live page beside an editor, and dragging things on it.

   PagePreview.mount(host, opts) -> { paint(html, theme, extra), refresh(), frame }

   One preview for the script, collection, wiki page, news and creator-page
   editors, the way char-preview.js is the one for the character editors.
   The page is drawn in an iframe carrying the site's own stylesheet, at a
   real desktop width (1280px) scaled down to fit, or at a phone's width —
   so what an author sees is the layout a reader gets, media queries and
   all, and not the editor column squeezed into a narrow box.

   opts:
     kind       'script' | 'collection' | 'page' | 'news' | 'profile'
     src        profile only: the real creator page, loaded in the frame and
                re-themed in place (profile.html calls back when it is drawn)
     getTheme() the editor's current theme
     setTheme(t) store a changed theme (moves) through the editor
     render()   -> {html, theme, base, bgUrl}: what to draw now (not profile)

   "Move things" turns the page into a board: every part of it that
   PageRender.MOVABLE names, every character box, team block and creator
   page section can be dragged. A drop stores an offset in theme.moves and
   the page is redrawn from it, through the same movesCSS() the published
   page prints, so the preview cannot disagree with the page. Moves apply
   on wide screens only; the phone view shows the page as a phone gets it.

   Browser only. */
(function (global) {
  'use strict';

  var DESKTOP = 1280, PHONE = 390;
  function PR() { return global.PageRender || {}; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function siteRoot() { return new URL('/', location.href).href; }
  function cssHref(name) {
    return global.BotcData && global.BotcData.asset ? global.BotcData.asset(name) : 'assets/' + name;
  }

  // Inside the frame: links do nothing (it is a picture of the page, and a
  // srcdoc frame that followed one would leave the preview), and the few
  // collapsible boxes still open and close.
  var FRAME_CSS =
    'html.pp-arrange [data-pp-mv]{outline:1px dashed rgba(245,197,66,.55);outline-offset:-1px;cursor:grab;' +
      'touch-action:none;-webkit-user-select:none;user-select:none}' +
    'html.pp-arrange [data-pp-mv]:hover{outline:2px solid #f5c542}' +
    'html.pp-arrange [data-pp-mv].pp-picked{outline:3px solid #ffd54a;outline-offset:-3px}' +
    'html.pp-arrange [data-pp-mv].pp-dragging{cursor:grabbing;opacity:.92}' +
    'html.pp-arrange a{cursor:grab}' +
    'html.pp-arrange img{-webkit-user-drag:none}';

  function frameDoc(f) { try { return f.contentDocument; } catch (e) { return null; } }

  function shell() {
    return '<!doctype html><html><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<base href="' + esc(siteRoot()) + '">' +
      '<link rel="stylesheet" href="' + esc(cssHref('styles.css')) + '">' +
      '<link rel="stylesheet" href="' + esc(cssHref('header-redesign.css')) + '">' +
      '<style id="pp-css">' + FRAME_CSS + '</style>' +
      '<style id="page-custom-css"></style><style id="page-moves"></style>' +
      '</head><body>' +
      '<header class="topbar"><a class="brand"><img class="brand-skull" src="assets/logo_skull.webp" alt="">' +
      '<span class="brand-text"><b>BOTC</b><br>HomeBrew Wiki</span></a></header>' +
      '<main class="wrap" id="content"></main></body></html>';
  }

  function wireFrameDoc(doc) {
    if (!doc || doc.__ppWired) return;
    doc.__ppWired = true;
    doc.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('a')) e.preventDefault();
      var j = t.closest('.json-bar-toggle');
      if (j) { var b = j.closest('.json-box'); if (b) { var o = b.classList.toggle('open'); var bd = b.querySelector('.json-body'); if (bd) bd.hidden = !o; } }
      var d = t.closest('.jinx-drop-bar');
      if (d) { var jb = d.closest('.jinx-drop'); if (jb) { var jo = jb.classList.toggle('open'); var jd = jb.querySelector('.jinx-drop-body'); if (jd) jd.hidden = !jo; } }
    }, true);
    if (!doc.getElementById('pp-css')) {
      var st = doc.createElement('style');
      st.id = 'pp-css'; st.textContent = FRAME_CSS;
      doc.head.appendChild(st);
    }
  }

  function mount(host, opts) {
    opts = opts || {};
    var kind = opts.kind || 'script';
    host.innerHTML =
      '<div class="pp">' +
        '<div class="pp-bar">' +
          '<div class="pp-seg" role="group" aria-label="Preview size">' +
            '<button type="button" class="pp-dev on" data-dev="desktop" aria-pressed="true">Desktop</button>' +
            '<button type="button" class="pp-dev" data-dev="phone" aria-pressed="false">Phone</button>' +
          '</div>' +
          '<button type="button" class="pp-move" aria-pressed="false">✥ Move things</button>' +
        '</div>' +
        '<div class="pp-movebar" hidden>' +
          '<span class="pp-picked-name">Drag anything on the page. Tap a part to pick it; arrow keys nudge it.</span>' +
          '<button type="button" class="pp-btn pp-back-one" hidden>Put it back</button>' +
          '<button type="button" class="pp-btn pp-back-all">Put everything back</button>' +
        '</div>' +
        '<p class="pp-phone-note" hidden>Phones always get the tidy one-column page, so moved parts sit where the page puts them here. Switch to Desktop to move things.</p>' +
        '<div class="pp-view"><iframe class="pp-frame" title="Live preview of the page"></iframe></div>' +
      '</div>';
    var view = host.querySelector('.pp-view');
    var frame = host.querySelector('.pp-frame');
    var moveBtn = host.querySelector('.pp-move');
    var moveBar = host.querySelector('.pp-movebar');
    var phoneNote = host.querySelector('.pp-phone-note');
    var pickedName = host.querySelector('.pp-picked-name');
    var backOne = host.querySelector('.pp-back-one');
    // A phone opens on the phone view: a whole desktop page scaled to a
    // phone's width is too small to read. Desktop is one tap away.
    var device = (global.innerWidth || 1200) < 700 ? 'phone' : 'desktop';
    var arranging = false, picked = null, ready = false, pending = false;
    var profileWin = null;
    Array.prototype.forEach.call(host.querySelectorAll('.pp-dev'), function (x) {
      var on = x.getAttribute('data-dev') === device;
      x.classList.toggle('on', on); x.setAttribute('aria-pressed', on ? 'true' : 'false');
    });

    function theme() { return (opts.getTheme && opts.getTheme()) || {}; }
    function moves() { return PR().sanitizeMoves ? PR().sanitizeMoves(theme().moves) : {}; }

    /* ── size: a real page width, scaled to the column ── */
    function fit() {
      var w = view.clientWidth || 600;
      var fw = device === 'phone' ? PHONE : Math.max(DESKTOP, w);
      var s = Math.min(1, w / fw);
      var h = view.clientHeight || 600;
      frame.style.width = fw + 'px';
      frame.style.height = Math.round(h / s) + 'px';
      frame.style.transform = s < 1 ? 'scale(' + s + ')' : '';
      frame.style.left = device === 'phone' ? Math.max(0, Math.round((w - fw * s) / 2)) + 'px' : '0';
    }
    if (global.ResizeObserver) new ResizeObserver(fit).observe(view);
    else global.addEventListener('resize', fit);

    /* ── drawing ── */
    function applyTheme(doc, t, base, bgUrl) {
      var P = PR();
      var clean = P.sanitizeTheme ? (P.sanitizeTheme(t || {}, base || 'x') || {}) : {};
      if (t && t.background && /^[a-z0-9/-]+-bg\.(png|jpe?g|webp)$/i.test(t.background)) clean.background = t.background;
      if (bgUrl) clean.background = 'x/pp-bg.png';
      var ta = P.themeAttrs ? P.themeAttrs(clean) : { cls: '', style: '', fonts: [], movesCss: '' };
      var style = ta.style;
      if (bgUrl) style = style.split('/assets/x/pp-bg.png').join(bgUrl);
      doc.body.className = ta.cls;
      doc.body.setAttribute('style', style);
      (ta.fonts || []).forEach(function (href) {
        if (doc.querySelector('link[href="' + href + '"]')) return;
        var l = doc.createElement('link'); l.rel = 'stylesheet'; l.href = href; doc.head.appendChild(l);
      });
      var css = clean.css && global.CustomCSS ? global.CustomCSS.clean(clean.css).css : '';
      doc.getElementById('page-custom-css').textContent = css;
      doc.getElementById('page-moves').textContent = ta.movesCss || '';
      return { clean: clean, css: css };
    }

    function paintNow() {
      pending = false;
      if (kind === 'profile') {
        if (profileWin && profileWin.__botcApplyTheme) {
          try { profileWin.__botcApplyTheme(theme()); } catch (e) { /* frame went away */ }
          tagMovables();
        }
        return;
      }
      var doc = frameDoc(frame);
      if (!ready || !doc || !doc.getElementById('content') || !opts.render) return;
      var r = opts.render() || {};
      var res = applyTheme(doc, r.theme || theme(), r.base, r.bgUrl);
      var html = r.html || '';
      if (res.css) html = '<div class="ucss-frame"><div class="ucss">' + html + '</div></div>';
      var st = res.clean.stickers && PR().stickersHTML ? PR().stickersHTML(res.clean.stickers) : '';
      doc.getElementById('content').innerHTML = st + html;
      if (r.after) { try { r.after(doc); } catch (e) { /* a preview nicety */ } }
      tagMovables();
    }
    var timer = null;
    function refresh() {
      if (pending) return;
      pending = true;
      clearTimeout(timer);
      timer = setTimeout(paintNow, 120);
    }

    if (kind === 'profile') {
      global.__botcProfileFrame = function (win) {
        profileWin = win;
        wireFrameDoc(win.document);
        paintNow();
      };
      frame.src = opts.src || 'about:blank';
    } else {
      frame.addEventListener('load', function () {
        ready = true;
        wireFrameDoc(frameDoc(frame));
        paintNow();
      });
      frame.srcdoc = shell();
    }
    fit();

    /* ── moving things ── */
    function keysFor(doc) {
      var P = PR(), list = [];
      Object.keys(P.MOVABLE || {}).forEach(function (k) {
        Array.prototype.forEach.call(doc.querySelectorAll(P.MOVABLE[k][1]), function (el) { list.push([el, k]); });
      });
      Array.prototype.forEach.call(doc.querySelectorAll('.type-section[data-team], .script-team-group[data-team]'), function (el) {
        list.push([el, 't:' + el.getAttribute('data-team')]);
      });
      Array.prototype.forEach.call(doc.querySelectorAll('.prof-panel > [data-sec]'), function (el) {
        list.push([el, 's:' + el.getAttribute('data-sec')]);
      });
      Array.prototype.forEach.call(doc.querySelectorAll('.char-card[data-slug], .script-char-row[data-slug]'), function (el) {
        list.push([el, 'c:' + el.getAttribute('data-slug')]);
      });
      return list.filter(function (x) { return P.moveSelector && P.moveSelector(x[1]); });
    }
    function currentDoc() { return kind === 'profile' ? (profileWin && profileWin.document) : frameDoc(frame); }
    function tagMovables() {
      var doc = currentDoc();
      if (!doc || !doc.documentElement) return;
      wireFrameDoc(doc);
      doc.documentElement.classList.toggle('pp-arrange', arranging && device === 'desktop');
      Array.prototype.forEach.call(doc.querySelectorAll('[data-pp-mv]'), function (el) { el.removeAttribute('data-pp-mv'); });
      if (!arranging) return;
      keysFor(doc).forEach(function (x) { x[0].setAttribute('data-pp-mv', x[1]); });
      if (picked) markPicked(picked);
      bindDrag(doc);
    }
    function labelFor(key) {
      var P = PR();
      if (P.MOVABLE && P.MOVABLE[key]) return P.MOVABLE[key][0];
      var doc = currentDoc();
      if (key.indexOf('c:') === 0) {
        var el = doc && doc.querySelector('[data-pp-mv="' + key + '"]');
        var n = el && el.querySelector('.char-card-name, .script-char-name');
        return 'Character: ' + (n ? n.textContent.trim() : key.slice(2));
      }
      if (key.indexOf('t:') === 0) return 'Team: ' + key.slice(2);
      if (key.indexOf('s:') === 0) return 'Section: ' + key.slice(2);
      return key;
    }
    function markPicked(key) {
      var doc = currentDoc(); if (!doc) return;
      Array.prototype.forEach.call(doc.querySelectorAll('.pp-picked'), function (el) { el.classList.remove('pp-picked'); });
      if (!key) return;
      Array.prototype.forEach.call(doc.querySelectorAll('[data-pp-mv="' + key + '"]'), function (el) { el.classList.add('pp-picked'); });
    }
    function pick(key) {
      picked = key;
      markPicked(key);
      pickedName.textContent = key ? labelFor(key) + (moves()[key] ? ' (moved)' : '') : 'Drag anything on the page. Tap a part to pick it; arrow keys nudge it.';
      backOne.hidden = !(key && moves()[key]);
    }
    function storeMove(key, x, y) {
      var t = theme();
      var m = Object.assign({}, t.moves || {});
      if (x || y) m[key] = [x, y]; else delete m[key];
      var t2 = Object.assign({}, t);
      if (Object.keys(m).length) t2.moves = m; else delete t2.moves;
      if (opts.setTheme) opts.setTheme(t2);
      paintNow();
      pick(key);
    }
    function bindDrag(doc) {
      if (doc.__ppDrag) return;
      doc.__ppDrag = true;
      var drag = null;
      doc.addEventListener('pointerdown', function (e) {
        if (!arranging || device !== 'desktop' || e.button > 0) return;
        var el = e.target.closest && e.target.closest('[data-pp-mv]');
        if (!el) return;
        e.preventDefault();
        var key = el.getAttribute('data-pp-mv');
        var cur = moves()[key] || [0, 0];
        drag = { key: key, sx: e.clientX, sy: e.clientY, bx: cur[0], by: cur[1], id: e.pointerId, moved: false,
                 els: doc.querySelectorAll('[data-pp-mv="' + key + '"]') };
        try { el.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }
      }, true);
      doc.addEventListener('pointermove', function (e) {
        if (!drag || e.pointerId !== drag.id) return;
        var dx = Math.round(e.clientX - drag.sx), dy = Math.round(e.clientY - drag.sy);
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        drag.moved = true;
        drag.x = drag.bx + dx; drag.y = drag.by + dy;
        Array.prototype.forEach.call(drag.els, function (el) {
          el.classList.add('pp-dragging');
          el.style.translate = drag.x + 'px ' + drag.y + 'px';
        });
      });
      function end(e) {
        if (!drag || e.pointerId !== drag.id) return;
        var d = drag; drag = null;
        Array.prototype.forEach.call(d.els, function (el) { el.classList.remove('pp-dragging'); el.style.translate = ''; });
        if (d.moved) storeMove(d.key, d.x, d.y); else pick(d.key);
      }
      doc.addEventListener('pointerup', end);
      doc.addEventListener('pointercancel', end);
      doc.addEventListener('keydown', nudge);
    }
    function nudge(e) {
      if (!arranging || !picked || !/^Arrow/.test(e.key)) return;
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && !e.target.closest('.pp')) return;
      e.preventDefault();
      var step = e.shiftKey ? 10 : 1, cur = moves()[picked] || [0, 0];
      storeMove(picked, cur[0] + (e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0),
                        cur[1] + (e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0));
    }
    host.addEventListener('keydown', nudge);

    function setArranging(on) {
      arranging = on;
      moveBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      moveBtn.classList.toggle('on', on);
      moveBar.hidden = !on || device !== 'desktop';
      phoneNote.hidden = !(on && device === 'phone');
      if (!on) pick(null);
      tagMovables();
    }
    host.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b || !host.contains(b)) return;
      if (b.hasAttribute('data-dev')) {
        device = b.getAttribute('data-dev');
        Array.prototype.forEach.call(host.querySelectorAll('.pp-dev'), function (x) {
          var on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        fit();
        setArranging(arranging);
      } else if (b === moveBtn) {
        setArranging(!arranging);
      } else if (b === backOne && picked) {
        storeMove(picked, 0, 0);
      } else if (b.classList.contains('pp-back-all')) {
        if (!Object.keys(moves()).length) return;
        if (!global.confirm('Put every moved part back where the page puts it?')) return;
        var t2 = Object.assign({}, theme()); delete t2.moves;
        if (opts.setTheme) opts.setTheme(t2);
        pick(null);
        paintNow();
      }
    });

    return { paint: paintNow, refresh: refresh, frame: frame, fit: fit };
  }

  /* The usual wiring, so an editor carries a few lines of it: a "Live
     preview" box at the end of the form, the theme read and written through
     ThemeEditor, a redraw after anything is typed or clicked in the form,
     and the form and preview side by side (WikiEditor.splitPreview).
       PagePreview.attach({editor, kind, render | src, wide}) -> preview */
  function attach(o) {
    var TE = global.ThemeEditor || {};
    var wrap = document.createElement('div');
    wrap.className = 'we-preview pp-wrap';
    wrap.innerHTML = '<h2>Live preview</h2><div class="pp-host"></div>';
    o.editor.appendChild(wrap);
    var pv = mount(wrap.querySelector('.pp-host'), {
      kind: o.kind, src: o.src, render: o.render,
      getTheme: o.getTheme || TE.current, setTheme: o.setTheme || TE.store
    });
    if (TE.listen) TE.listen(pv.refresh);
    ['input', 'change', 'click'].forEach(function (ev) {
      o.editor.addEventListener(ev, function (e) { if (!wrap.contains(e.target)) pv.refresh(); });
    });
    if (global.WikiEditor && global.WikiEditor.splitPreview) global.WikiEditor.splitPreview(o.editor, wrap, { wide: o.wide });
    return pv;
  }

  global.PagePreview = { mount: mount, attach: attach };
})(typeof window !== 'undefined' ? window : this);
