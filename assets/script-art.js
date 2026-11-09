/* The Script Builder's two picture makers, behind Export's "Make one"
   buttons. Both draw on a canvas in the browser and hand a data URL back
   (opts.onUse) for the builder to upload, as Upload does.

   BgMaker   the Fancy Scripts back cover's swirl pattern (assets/script-bg/
             swirl.webp, fancyscripts/art/back-pattern2.png at half size; it
             repeats without a seam) over a two-colour gradient, with a
             mottled texture and shading round the edges, at 1920x1080.
   LogoMaker the script's name in LHF Unlovable, the Fancy Scripts title
             face, filled with a two-colour gradient and the same texture,
             inside a thin white outline, on a transparent 1200x1200 square
             sized like the official app's own logos.

   The colour picker is drawn here (a saturation square, a hue strip and a
   hex box) for the reason Fancy Scripts draws its own: <input type="color">
   on Android Chrome offers a grid of presets and nothing else. Settings are
   kept per browser (localStorage botc_bgmaker / botc_logomaker). */
(function () {
  'use strict';

  function root() { return (window.BotcData && window.BotcData.root && window.BotcData.root()) || ''; }
  function loadOpts(key, defaults) {
    var o = {};
    try { o = JSON.parse(localStorage.getItem(key)) || {}; } catch (e) { /* none */ }
    var out = {};
    Object.keys(defaults).forEach(function (k) { out[k] = o[k] != null ? o[k] : defaults[k]; });
    return out;
  }
  function saveOpts(key, o) { try { localStorage.setItem(key, JSON.stringify(o)); } catch (e) { /* fine */ } }

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
  /* The mottled texture, laid over whatever is on the canvas. */
  function texture(x, w, h, amount) {
    if (!(amount > 0)) return;
    mottle = mottle || noiseCanvas(48, 27, 7);
    grain = grain || noiseCanvas(160, 160, 11);
    x.save();
    x.globalCompositeOperation = 'overlay';
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.globalAlpha = 0.45 * amount / 100;
    x.drawImage(mottle, 0, 0, w, h);
    x.globalAlpha = 0.18 * amount / 100;
    x.fillStyle = x.createPattern(grain, 'repeat');
    x.fillRect(0, 0, w, h);
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

  /* ── the dialog both makers share ──
     spec: {title, key, defaults, presets [[name, c1, c2]], colours [[key,
     label]], fields (extra markup), preview {w, h}, draw(canvas, o, extra),
     prepare() -> promise of `extra`, full(o, extra) -> data URL, file,
     opts}. */
  var dlg = null;
  function openMaker(spec) {
    var opts = spec.opts || {};
    var o = loadOpts(spec.key, spec.defaults);
    if (spec.init) spec.init(o, opts);
    var which = spec.colours[0][0];
    if (dlg) dlg.remove();
    dlg = document.createElement('dialog');
    dlg.className = 'sbx-dlg bgm';
    dlg.innerHTML =
      '<h3 class="sbx-pop-title">' + spec.title + '</h3>' +
      '<div class="bgm-prev' + (spec.prevClass ? ' ' + spec.prevClass : '') + '"><canvas width="' + spec.preview.w + '" height="' + spec.preview.h + '" aria-label="Preview"></canvas></div>' +
      (spec.top || '') +
      '<div class="bgm-presets">' + spec.presets.map(function (p, i) {
        return '<button type="button" class="bgm-preset" data-i="' + i + '" title="' + p[0] + '" aria-label="' + p[0] + '"' +
          ' style="background:linear-gradient(90deg,' + p[1] + ' 50%,' + p[2] + ' 50%)"></button>';
      }).join('') + '</div>' +
      '<div class="bgm-cols">' + spec.colours.map(function (c, i) {
        return '<button type="button" class="bgm-sw' + (i ? '' : ' on') + '" data-c="' + c[0] + '"><span></span> ' + c[1] + '</button>';
      }).join('') + '</div>' +
      '<div class="bgm-cp">' +
        '<div class="bgm-sv"><div class="bgm-dot"></div></div>' +
        '<input type="range" class="bgm-hue" min="0" max="360" step="1" aria-label="Hue">' +
        '<input type="text" class="bgm-hex" spellcheck="false" autocapitalize="off" aria-label="Hex colour">' +
      '</div>' +
      spec.fields +
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
    var extra = null, raf = 0;
    if (opts.backdrop) q('.bgm-prev').style.backgroundImage = 'url("' + String(opts.backdrop).replace(/"/g, '%22') + '")';

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
    function redraw() {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(function () { spec.draw(cv, o, extra); });
    }
    function changed(skipHex) { paintPicker(skipHex); redraw(); saveOpts(spec.key, o); }
    function setFromHsv() { o[which] = rgbToHex.apply(null, hsvToRgb(hsv.h, hsv.s, hsv.v)); changed(); }

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
      el.value = o[el.getAttribute('data-k')];
      el.addEventListener('input', function () {
        var k = el.getAttribute('data-k');
        o[k] = el.type === 'range' ? Number(el.value) : el.value;
        redraw(); saveOpts(spec.key, o);
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
      var p = spec.presets[Number(b.getAttribute('data-i'))];
      o.c1 = p[1]; o.c2 = p[2];
      hsv = rgbToHsv.apply(null, hexToRgb(o[which]));
      changed();
    });

    function note(t) { var n = q('.bgm-note'); n.textContent = t || ''; n.hidden = !t; }
    if (!opts.canUse) note('Log in to use it in your script. You can download it now.');

    function close() { cancelAnimationFrame(raf); dlg.close(); dlg.remove(); dlg = null; }
    dlg.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-v]');
      if (!b) return;
      var v = b.getAttribute('data-v');
      if (v === 'close') { close(); return; }
      if (!extra) return;
      var data = spec.full(o, extra);
      if (v === 'download') {
        var a = document.createElement('a');
        a.href = data;
        a.download = spec.file + '.' + (/^data:image\/(\w+)/.exec(data) || [0, 'png'])[1].replace('jpeg', 'jpg');
        document.body.appendChild(a); a.click(); a.remove();
        return;
      }
      if (!opts.canUse) { if (opts.onLogin) opts.onLogin(); return; }
      if (opts.onUse) opts.onUse(data);
      close();
    });
    dlg.addEventListener('cancel', function (e) { e.preventDefault(); close(); });
    paintPicker();
    dlg.showModal();
    spec.prepare().then(function (x) { extra = x; redraw(); })
      .catch(function () { note('Something it needs could not be loaded. Check your connection and try again.'); });
  }

  /* WebP where the browser can write it. */
  function encode(c, fallback) {
    var out = c.toDataURL('image/webp', 0.9);
    return out.indexOf('data:image/webp') === 0 ? out : c.toDataURL(fallback, 0.9);
  }

  // ══ the background ══════════════════════════════════════════════════
  var BW = 1920, BH = 1080;
  var BG_PRESETS = [
    ['Trouble Brewing', '#8a1222', '#2e040a'],
    ['Midnight', '#1f6fa8', '#101a70'],
    ['Crimson', '#8e1b24', '#36060f'],
    ['Emerald', '#1f7a4d', '#0a2f22'],
    ['Violet', '#6a2a8a', '#22082f'],
    ['Bronze', '#9a6a22', '#3a2208'],
    ['Slate', '#4a5560', '#15191e'],
    ['Rose', '#a34a6a', '#3b0f22']
  ];
  /* The tile as black with the gaps between the motifs opaque, so drawing
     it over the gradient darkens the ground and leaves the swirls in the
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
      img.src = root() + 'assets/script-bg/swirl.webp';
    });
    return tilePromise;
  }
  function drawBg(canvas, o, t) {
    var w = canvas.width, h = canvas.height, k = w / BW;
    var x = canvas.getContext('2d');
    x.save();
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
    if (t && o.strength > 0) {
      var pat = x.createPattern(t, 'repeat');
      var sc = 0.9 * (o.size / 100) * k;
      if (pat.setTransform && window.DOMMatrix) pat.setTransform(new DOMMatrix().scale(sc));
      x.globalAlpha = o.strength / 100;
      x.fillStyle = pat;
      x.fillRect(0, 0, w, h);
      x.globalAlpha = 1;
    }
    texture(x, w, h, o.texture);
    if (o.shade > 0) {
      var r = x.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.hypot(w, h) / 2);
      r.addColorStop(0, 'rgba(0,0,0,0)');
      r.addColorStop(1, 'rgba(0,0,0,' + (0.85 * o.shade / 100).toFixed(3) + ')');
      x.fillStyle = r;
      x.fillRect(0, 0, w, h);
    }
    x.restore();
  }
  window.BgMaker = {
    draw: drawBg,
    open: function (opts) {
      openMaker({
        title: 'Make a background', key: 'botc_bgmaker', file: 'background', opts: opts,
        defaults: { c1: '#8a1222', c2: '#2e040a', dir: 'lr', size: 100, strength: 65, texture: 15, shade: 55 },
        presets: BG_PRESETS,
        colours: [['c1', 'Colour 1'], ['c2', 'Colour 2']],
        preview: { w: 960, h: 540 },
        fields:
          '<label class="bgm-row">Blend <select data-k="dir">' +
            '<option value="lr">Left to right</option><option value="tb">Top to bottom</option>' +
            '<option value="diag">Corner to corner</option><option value="centre">From the centre</option></select></label>' +
          '<label class="bgm-row">Pattern size <input type="range" data-k="size" min="40" max="220" step="5"></label>' +
          '<label class="bgm-row">Pattern strength <input type="range" data-k="strength" min="0" max="100" step="1"></label>' +
          '<label class="bgm-row">Texture <input type="range" data-k="texture" min="0" max="100" step="1"></label>' +
          '<label class="bgm-row">Shading <input type="range" data-k="shade" min="0" max="100" step="1"></label>',
        draw: drawBg,
        prepare: tile,
        full: function (o, t) {
          var c = document.createElement('canvas');
          c.width = BW; c.height = BH;
          drawBg(c, o, t);
          // A background has no transparency to keep, so JPEG where WebP fails.
          return encode(c, 'image/jpeg');
        }
      });
    }
  };

  // ══ the logo ════════════════════════════════════════════════════════
  var LS = 1200;                 // the square the official app's logos come in
  var LOGO_FONT = 'LHF Unlovable';
  var LOGO_ASC = 0.36;           // the tallest a capital may be, as a share of the square
  var LOGO_PRESETS = [
    ['Trouble Brewing', '#9c1230', '#6c0410'],
    ['Sapphire', '#262c8c', '#1e94b8'],
    ['Crimson', '#7a0f1c', '#d0412f'],
    ['Emerald', '#0f4f33', '#3fae6c'],
    ['Gold', '#8a5a14', '#e8c56a'],
    ['Violet', '#3c1458', '#a14fc4'],
    ['Silver', '#3a4048', '#b8c2cc'],
    ['Ink', '#0c0c10', '#3a3a44']
  ];
  var fontPromise = null;
  function logoFont() {
    if (fontPromise) return fontPromise;
    if (!window.FontFace || !document.fonts) return (fontPromise = Promise.resolve(true));
    var f = new FontFace(LOGO_FONT, 'url("' + root() + 'assets/fancyscripts/fonts/LHFUnlovable-400.woff2") format("woff2")');
    fontPromise = f.load().then(function (ff) { document.fonts.add(ff); return true; })
      .catch(function (e) { fontPromise = null; throw e; });
    return fontPromise;
  }
  /* The name in one line, or two when one line would set it too small:
     split at the space that leaves the two halves closest in length. */
  function logoLines(text) {
    var t = String(text || '').replace(/\s+/g, ' ').trim() || 'My Script';
    var words = t.split(' ');
    if (words.length < 2 || t.length <= 12) return [[t]];
    var best = null;
    for (var i = 1; i < words.length; i++) {
      var a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
      var d = Math.abs(a.length - b.length);
      if (!best || d < best.d) best = { d: d, l: [a, b] };
    }
    return [[t], best.l];
  }
  /* Set the lines as large as fits the box, measuring the ink (this face's
     swashes reach well past its advance widths). */
  function logoLayout(x, w, lines) {
    var boxW = w * 0.94, boxH = w * 0.76;
    var size = 100;
    x.font = size + 'px "' + LOGO_FONT + '"';
    var ms = lines.map(function (l) { return x.measureText(l); });
    var wide = Math.max.apply(null, ms.map(function (m) { return (m.actualBoundingBoxLeft || 0) + (m.actualBoundingBoxRight || m.width); }));
    var asc = Math.max.apply(null, ms.map(function (m) { return m.actualBoundingBoxAscent || 70; }));
    var desc = Math.max.apply(null, ms.map(function (m) { return m.actualBoundingBoxDescent || 25; }));
    var lineH = (asc + desc) * 0.92;
    var tall = lineH * (lines.length - 1) + asc + desc;
    var k = Math.min(boxW / wide, boxH / tall);
    // Never taller than the face's own size on the example (a short name
    // would otherwise fill the whole square).
    k = Math.min(k, (w * LOGO_ASC) / asc);
    return {
      size: size * k, asc: asc * k, desc: desc * k, lineH: lineH * k,
      top: (w - tall * k) / 2,
      xs: ms.map(function (m) { return (w - ((m.actualBoundingBoxRight || m.width) - (m.actualBoundingBoxLeft || 0)) * k) / 2; })
    };
  }
  function drawLogo(canvas, o) {
    var w = canvas.width, x = canvas.getContext('2d');
    x.clearRect(0, 0, w, w);
    // Two lines only when one line comes out well under the largest the
    // face is set, and the split makes it clearly bigger.
    var sets = logoLines(o.text), lines = sets[0], L = logoLayout(x, w, lines);
    if (sets[1] && L.asc < w * LOGO_ASC * 0.75) {
      var two = logoLayout(x, w, sets[1]);
      if (two.size > L.size * 1.2) { L = two; lines = sets[1]; }
    }
    var font = L.size.toFixed(1) + 'px "' + LOGO_FONT + '"';
    var edge = L.size * 0.08 * (o.outline / 100);   // the white outline
    function each(fn) {
      lines.forEach(function (l, i) { fn(l, L.xs[i], L.top + L.asc + i * L.lineH); });
    }
    x.save();
    x.font = font;
    x.textBaseline = 'alphabetic';
    x.lineJoin = 'round';
    if (edge > 0) {
      x.strokeStyle = '#fffdf8';
      x.lineWidth = edge;
      each(function (l, lx, ly) { x.strokeText(l, lx, ly); });
    }
    x.restore();
    // the letters: the gradient and the texture, kept inside the letters
    var f = document.createElement('canvas');
    f.width = f.height = w;
    var y = f.getContext('2d');
    y.font = font;
    y.textBaseline = 'alphabetic';
    var g = y.createLinearGradient(0, L.top, 0, L.top + L.asc + L.desc + (lines.length - 1) * L.lineH);
    g.addColorStop(0, o.c1);
    g.addColorStop(1, o.c2);
    y.fillStyle = g;
    lines.forEach(function (l, i) { y.fillText(l, L.xs[i], L.top + L.asc + i * L.lineH); });
    texture(y, w, w, o.texture);
    // Clip to every line at once: clipping line by line keeps only the
    // overlap of the lines, which is nothing.
    var m = document.createElement('canvas');
    m.width = m.height = w;
    var mx = m.getContext('2d');
    mx.font = font;
    mx.textBaseline = 'alphabetic';
    lines.forEach(function (l, i) { mx.fillText(l, L.xs[i], L.top + L.asc + i * L.lineH); });
    y.globalCompositeOperation = 'destination-in';
    y.drawImage(m, 0, 0);
    x.drawImage(f, 0, 0);
  }
  window.LogoMaker = {
    draw: drawLogo,
    open: function (opts) {
      openMaker({
        title: 'Make a logo', key: 'botc_logomaker', file: 'logo', opts: opts,
        defaults: { text: '', c1: '#9c1230', c2: '#6c0410', texture: 40, outline: 30 },
        init: function (o, op) { o.text = op.text || o.text || 'My Script'; },
        presets: LOGO_PRESETS,
        colours: [['c1', 'Top'], ['c2', 'Bottom']],
        preview: { w: 600, h: 600 },
        prevClass: 'bgm-prev-logo',
        top: '<label class="bgm-row">Name <input type="text" data-k="text" maxlength="60"></label>',
        fields:
          '<label class="bgm-row">Texture <input type="range" data-k="texture" min="0" max="100" step="1"></label>' +
          '<label class="bgm-row">Outline <input type="range" data-k="outline" min="0" max="100" step="1"></label>',
        draw: drawLogo,
        prepare: logoFont,
        full: function (o) {
          var c = document.createElement('canvas');
          c.width = c.height = LS;
          drawLogo(c, o);
          return encode(c, 'image/png');
        }
      });
    }
  };
})();
