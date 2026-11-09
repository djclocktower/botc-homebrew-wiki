/* The Script Builder's background maker: the Fancy Scripts ribbon's damask
   (assets/script-bg/damask.webp, a mirrored, seamless tile cut from
   fancyscripts/art/sidebar-flat.png) laid over a two-colour gradient, with a
   mottled texture and shading round the edges, drawn on a canvas at
   1920x1080. BgMaker.open({canUse, onUse(dataURL), onLogin}) shows the
   dialog; "Use this" hands the finished picture back for the builder to
   upload. The colour picker is drawn here (a saturation square, a hue strip
   and a hex box) for the reason Fancy Scripts draws its own: <input
   type="color"> on Android Chrome offers a grid of presets and nothing else.
   Settings are kept per browser (localStorage botc_bgmaker). */
(function () {
  'use strict';
  var KEY = 'botc_bgmaker';
  var W = 1920, H = 1080;
  var PRESETS = [
    ['Midnight', '#1f6fa8', '#101a70'],
    ['Crimson', '#8e1b24', '#36060f'],
    ['Emerald', '#1f7a4d', '#0a2f22'],
    ['Violet', '#6a2a8a', '#22082f'],
    ['Bronze', '#9a6a22', '#3a2208'],
    ['Slate', '#4a5560', '#15191e'],
    ['Rose', '#a34a6a', '#3b0f22']
  ];
  var DEFAULTS = { c1: '#1f6fa8', c2: '#101a70', dir: 'lr', size: 100, strength: 65, texture: 35, shade: 55 };

  function load() {
    var o = {};
    try { o = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { /* none */ }
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) { out[k] = o[k] != null ? o[k] : DEFAULTS[k]; });
    return out;
  }
  function save(o) { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) { /* fine */ } }

  function root() { return (window.BotcData && window.BotcData.root && window.BotcData.root()) || ''; }

  /* The tile as black with the gaps between the motifs opaque, so drawing
     it over the gradient darkens the ground and leaves the damask in the
     chosen colour. Made once. */
  var tilePromise = null;
  function tile() {
    if (tilePromise) return tilePromise;
    tilePromise = new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        var x = c.getContext('2d');
        x.drawImage(img, 0, 0);
        var d = x.getImageData(0, 0, c.width, c.height), p = d.data;
        for (var i = 0; i < p.length; i += 4) { var a = 255 - p[i]; p[i] = p[i + 1] = p[i + 2] = 0; p[i + 3] = a; }
        x.putImageData(d, 0, 0);
        resolve(c);
      };
      img.onerror = function () { tilePromise = null; reject(new Error('tile')); };
      img.src = root() + 'assets/script-bg/damask.webp';
    });
    return tilePromise;
  }

  /* Fixed noise, so the same settings always give the same picture. */
  function noiseCanvas(w, h, seed) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var x = c.getContext('2d'), d = x.createImageData(w, h), p = d.data, s = seed;
    for (var i = 0; i < p.length; i += 4) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      var v = (s >> 16) & 255;
      p[i] = p[i + 1] = p[i + 2] = v; p[i + 3] = 255;
    }
    x.putImageData(d, 0, 0);
    return c;
  }
  var mottle = null, grain = null;

  function draw(canvas, o, t) {
    var w = canvas.width, h = canvas.height, k = w / W;
    var x = canvas.getContext('2d');
    x.save();
    x.globalCompositeOperation = 'source-over';
    x.globalAlpha = 1;
    // the gradient
    var g;
    if (o.dir === 'centre') {
      g = x.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.hypot(w, h) / 2);
    } else {
      var v = { lr: [0, 0, w, 0], tb: [0, 0, 0, h], diag: [0, 0, w, h] }[o.dir] || [0, 0, w, 0];
      g = x.createLinearGradient(v[0], v[1], v[2], v[3]);
    }
    g.addColorStop(0, o.c1);
    g.addColorStop(1, o.c2);
    x.fillStyle = g;
    x.fillRect(0, 0, w, h);
    // the damask
    if (t && o.strength > 0) {
      var pat = x.createPattern(t, 'repeat');
      var sc = (436 / 654) * (o.size / 100) * k;
      if (pat.setTransform && window.DOMMatrix) pat.setTransform(new DOMMatrix().scale(sc));
      x.globalAlpha = o.strength / 100;
      x.fillStyle = pat;
      x.fillRect(0, 0, w, h);
    }
    // the texture: soft blotches and a fine grain, laid over the colour
    if (o.texture > 0) {
      mottle = mottle || noiseCanvas(48, 27, 7);
      grain = grain || noiseCanvas(160, 160, 11);
      x.globalCompositeOperation = 'overlay';
      x.imageSmoothingEnabled = true;
      x.imageSmoothingQuality = 'high';
      x.globalAlpha = 0.45 * o.texture / 100;
      x.drawImage(mottle, 0, 0, w, h);
      x.globalAlpha = 0.18 * o.texture / 100;
      x.fillStyle = x.createPattern(grain, 'repeat');
      x.fillRect(0, 0, w, h);
    }
    // the shading round the edges
    if (o.shade > 0) {
      x.globalCompositeOperation = 'source-over';
      x.globalAlpha = 1;
      var r = x.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.hypot(w, h) / 2);
      r.addColorStop(0, 'rgba(0,0,0,0)');
      r.addColorStop(1, 'rgba(0,0,0,' + (0.85 * o.shade / 100).toFixed(3) + ')');
      x.fillStyle = r;
      x.fillRect(0, 0, w, h);
    }
    x.restore();
  }

  /* ── colours ── */
  function hexToRgb(h) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim());
    if (!m) return null;
    var n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(function (v) { return ('0' + Math.round(Math.max(0, Math.min(255, v))).toString(16)).slice(-2); }).join('');
  }
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, h = 0;
    if (d) { h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; }
    return { h: h, s: mx ? d / mx : 0, v: mx };
  }
  function hsvToRgb(h, s, v) {
    h = ((h % 360) + 360) % 360;
    var c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    var t = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [(t[0] + m) * 255, (t[1] + m) * 255, (t[2] + m) * 255];
  }

  var dlg = null;
  function open(opts) {
    opts = opts || {};
    var o = load();
    var which = 'c1';
    if (dlg) dlg.remove();
    dlg = document.createElement('dialog');
    dlg.className = 'sbx-dlg bgm';
    dlg.innerHTML =
      '<h3 class="sbx-pop-title">Make a background</h3>' +
      '<div class="bgm-prev"><canvas width="960" height="540" aria-label="Preview"></canvas></div>' +
      '<div class="bgm-presets">' + PRESETS.map(function (p, i) {
        return '<button type="button" class="bgm-preset" data-i="' + i + '" title="' + p[0] + '" aria-label="' + p[0] + '"' +
          ' style="background:linear-gradient(90deg,' + p[1] + ' 50%,' + p[2] + ' 50%)"></button>';
      }).join('') + '</div>' +
      '<div class="bgm-cols">' +
        '<button type="button" class="bgm-sw on" data-c="c1"><span></span> Colour 1</button>' +
        '<button type="button" class="bgm-sw" data-c="c2"><span></span> Colour 2</button>' +
      '</div>' +
      '<div class="bgm-cp">' +
        '<div class="bgm-sv"><div class="bgm-dot"></div></div>' +
        '<input type="range" class="bgm-hue" min="0" max="360" step="1" aria-label="Hue">' +
        '<input type="text" class="bgm-hex" spellcheck="false" autocapitalize="off" aria-label="Hex colour">' +
      '</div>' +
      '<label class="bgm-row">Blend <select data-k="dir">' +
        '<option value="lr">Left to right</option><option value="tb">Top to bottom</option>' +
        '<option value="diag">Corner to corner</option><option value="centre">From the centre</option></select></label>' +
      '<label class="bgm-row">Pattern size <input type="range" data-k="size" min="40" max="220" step="5"></label>' +
      '<label class="bgm-row">Pattern strength <input type="range" data-k="strength" min="0" max="100" step="1"></label>' +
      '<label class="bgm-row">Texture <input type="range" data-k="texture" min="0" max="100" step="1"></label>' +
      '<label class="bgm-row">Shading <input type="range" data-k="shade" min="0" max="100" step="1"></label>' +
      '<p class="bgm-note" hidden></p>' +
      '<div class="sbx-dlg-btns">' +
        '<button type="button" class="sbx-b-sm" data-v="close">Close</button>' +
        '<button type="button" class="sbx-b-sm" data-v="download">Download</button>' +
        '<button type="button" class="sbx-b-sm sbx-dlg-go" data-v="use">Use this</button>' +
      '</div>';
    document.body.appendChild(dlg);
    var q = function (s) { return dlg.querySelector(s); };
    var cv = q('canvas'), sv = q('.bgm-sv'), dot = q('.bgm-dot'), hue = q('.bgm-hue'), hex = q('.bgm-hex');
    var hsv = rgbToHsv.apply(null, hexToRgb(o[which]) || [0, 0, 0]);
    var tileCanvas = null, raf = 0;

    function paintPicker(skipHex) {
      sv.style.backgroundColor = 'hsl(' + Math.round(hsv.h) + ',100%,50%)';
      dot.style.left = (hsv.s * 100) + '%';
      dot.style.top = ((1 - hsv.v) * 100) + '%';
      hue.value = hsv.h;
      if (!skipHex) hex.value = o[which];
      dlg.querySelectorAll('.bgm-sw').forEach(function (b) {
        b.classList.toggle('on', b.getAttribute('data-c') === which);
        b.querySelector('span').style.background = o[b.getAttribute('data-c')];
      });
    }
    function paintControls() {
      dlg.querySelectorAll('[data-k]').forEach(function (el) { el.value = o[el.getAttribute('data-k')]; });
      paintPicker();
    }
    function redraw() {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(function () { draw(cv, o, tileCanvas); });
    }
    function changed(skipHex) { paintPicker(skipHex); redraw(); save(o); }
    function setFromHsv(skipHex) { o[which] = rgbToHex.apply(null, hsvToRgb(hsv.h, hsv.s, hsv.v)); changed(skipHex); }

    function svPick(e) {
      var r = sv.getBoundingClientRect();
      hsv.s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      hsv.v = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
      setFromHsv();
    }
    sv.addEventListener('pointerdown', function (e) { e.preventDefault(); sv.setPointerCapture(e.pointerId); svPick(e); });
    sv.addEventListener('pointermove', function (e) { if (sv.hasPointerCapture(e.pointerId)) svPick(e); });
    hue.addEventListener('input', function () { hsv.h = Number(hue.value); setFromHsv(); });
    hex.addEventListener('input', function () {
      var rgb = hexToRgb(hex.value);
      if (!rgb) return;
      hsv = rgbToHsv.apply(null, rgb);
      o[which] = rgbToHex.apply(null, rgb);
      changed(true);
    });
    dlg.querySelectorAll('[data-k]').forEach(function (el) {
      el.addEventListener('input', function () {
        var k = el.getAttribute('data-k');
        o[k] = k === 'dir' ? el.value : Number(el.value);
        redraw(); save(o);
      });
    });
    q('.bgm-cols').addEventListener('click', function (e) {
      var b = e.target.closest('.bgm-sw');
      if (!b) return;
      which = b.getAttribute('data-c');
      hsv = rgbToHsv.apply(null, hexToRgb(o[which]) || [0, 0, 0]);
      paintPicker();
    });
    q('.bgm-presets').addEventListener('click', function (e) {
      var b = e.target.closest('.bgm-preset');
      if (!b) return;
      var p = PRESETS[Number(b.getAttribute('data-i'))];
      o.c1 = p[1]; o.c2 = p[2];
      hsv = rgbToHsv.apply(null, hexToRgb(o[which]));
      changed();
    });

    function full() {
      var c = document.createElement('canvas');
      c.width = W; c.height = H;
      draw(c, o, tileCanvas);
      var out = c.toDataURL('image/webp', 0.9);
      // A browser that cannot write WebP hands back a PNG; a JPEG is far
      // smaller, and a background has no transparency to keep.
      return out.indexOf('data:image/webp') === 0 ? out : c.toDataURL('image/jpeg', 0.9);
    }
    function note(t) { var n = q('.bgm-note'); n.textContent = t || ''; n.hidden = !t; }
    if (!opts.canUse) note('Log in to use it in your script. You can download it now.');

    function close() { cancelAnimationFrame(raf); dlg.close(); dlg.remove(); dlg = null; }
    dlg.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-v]');
      if (!b) return;
      var v = b.getAttribute('data-v');
      if (v === 'close') { close(); return; }
      if (!tileCanvas) return;
      var data = full();
      if (v === 'download') {
        var a = document.createElement('a');
        a.href = data;
        a.download = 'background.' + (data.indexOf('image/webp') > 0 ? 'webp' : 'jpg');
        document.body.appendChild(a); a.click(); a.remove();
        return;
      }
      if (!opts.canUse) { if (opts.onLogin) opts.onLogin(); return; }
      if (opts.onUse) opts.onUse(data);
      close();
    });
    dlg.addEventListener('cancel', function (e) { e.preventDefault(); close(); });
    paintControls();
    draw(cv, o, null);
    dlg.showModal();
    tile().then(function (t) { tileCanvas = t; redraw(); })
      .catch(function () { note('The pattern could not be loaded. Check your connection and try again.'); });
  }

  window.BgMaker = { open: open, draw: draw, PRESETS: PRESETS };
})();
