/* assets/starlit.js: the Starlit Gallery (/starlit). See "The Starlit
 * Gallery" in CLAUDE.md.
 *
 * An icon is a BLACK layer, filled with the picked texture, over a WHITE one,
 * filled with parchment, with a drop shadow under both. The layers are only
 * masks. compose() does all the drawing; the Worker only stores files.
 * ?icon={id} opens one icon; ?pick=1 is the gallery inside a character
 * editor (assets/starlit-picker.js). Browser only.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var PICK = document.documentElement.classList.contains('sg-pick');
  var FILL = window.ART_FILL || 0.6;
  var TARGET = window.ART_TARGET || 591;
  var LAYER_MAX = 1200;       // longest side a layer is stored at
  var THUMB = 256;            // the grid's picture
  var ARTISTS = 'Harry & Co & Bendan';
  // The team's texture sets, from their Photoshop templates: eight sheets
  // each, and an Outline sheet that paints the white layer whichever of the
  // set's sheets is on the black one. assets/starlit/tex/{set}-{kind}.webp,
  // with a small -s copy for the picker.
  var TEX_DIR = '/assets/starlit/tex/';
  // Official is the wiki's own (Icon Forge's sheets, assets/iconforge/
  // textures/), its traveller halves baked into files like the team's; its
  // base sheet is the white one, so it goes by Icon Forge's name for it.
  var SETS = [['default', 'Default'], ['vibrant', 'Vibrant'], ['treasure', 'Treasure Hunt'], ['starlit', 'Starlit'],
    ['glitchy', 'Glitchy'], ['official', 'Official', { base: 'Monochrome' }]];
  var KINDS = [['base', 'Base'], ['good', 'Good'], ['evil', 'Evil'], ['traveller', 'Traveller'],
    ['traveller-good', 'Traveller Good'], ['traveller-evil', 'Traveller Evil'], ['fabled', 'Fabled'], ['loric', 'Loric']];
  var BUILT_IN = [];
  SETS.forEach(function (s) {
    KINDS.forEach(function (k) {
      var f = TEX_DIR + s[0] + '-' + k[0];
      BUILT_IN.push({ id: s[0] + '-' + k[0], set: s[1], name: (s[2] && s[2][k[0]]) || k[1], src: f + '.webp', thumb: f + '-s.webp',
        outline: TEX_DIR + s[0] + '-outline.webp' });
    });
  });
  // The outline for a texture that is not one of the sets'.
  var PARCHMENT = TEX_DIR + 'default-outline.webp';
  // The whites have a picker of their own: by default they follow the set
  // of the blacks' texture, or the reader picks any set's Outline sheet.
  var OUTLINES = SETS.map(function (s) {
    return { id: 'w-' + s[0], set: 'Outlines', name: s[1], src: TEX_DIR + s[0] + '-outline.webp', thumb: TEX_DIR + s[0] + '-outline-s.webp' };
  });
  var PLAIN_BLACK = { id: 'plain', set: '', name: 'Plain black', plain: '#000000' };
  var MATCH_WHITE = { id: '', set: '', name: 'Match blacks', match: true };
  var PLAIN_WHITE = { id: 'plain', set: '', name: 'Plain white', plain: '#ffffff' };
  var TOGGLES = ['texture', 'whites', 'blacks', 'shadow'];

  var gallery = { icons: [], textures: [], canUpload: false, isAdmin: false, uploaders: [] };
  var textures = BUILT_IN.slice();   // + the gallery's own, + the reader's
  var own = null;                    // a texture picked from the reader's device
  var ownWhite = null;               // the same, for the whites
  var ownFor = 'black';              // which picker the device file is for
  // tags: {keyword: 1 to require it, -1 to leave it out}.
  var filter = { q: '', tags: Object.create(null) };
  // An icon opens as it was uploaded: no texture until the reader picks one.
  var view = { tex: 'default-base', wtex: '', bcut: { x: 0, y: 0, z: 1 }, wcut: { x: 0, y: 0, z: 1 }, texture: false, whites: true, blacks: true, shadow: true };
  var current = null;                // the icon open in the window
  var previewUrl = null, paintSeq = 0;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fold(s) { return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
  function canvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h == null ? w : h;
    return c;
  }
  function say(id, text, bad) { var el = $(id); el.textContent = text || ''; el.className = 'sg-msg' + (bad ? ' err' : ''); }

  function imageFrom(src) {
    return new Promise(function (resolve, reject) {
      var im = new Image();
      im.onload = function () { resolve(im); };
      im.onerror = function () { reject(new Error('An image did not load. Check your connection and try again.')); };
      im.src = src;
    });
  }
  var images = Object.create(null);
  function loadImg(src) {
    if (!images[src]) images[src] = imageFrom(src).catch(function (e) { delete images[src]; throw e; });
    return images[src];
  }
  function texById(id) {
    for (var i = 0; i < textures.length; i++) if (textures[i].id === id) return textures[i];
    return null;
  }
  function whiteById(id) {
    var list = [MATCH_WHITE, PLAIN_WHITE].concat(OUTLINES, ownWhite ? [ownWhite] : []);
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return MATCH_WHITE;
  }
  // The blacks' fill and the whites' fill for a choice: a picture, or a
  // plain colour (compose() takes either).
  function texturesFor(o) {
    var t = o.tex === 'plain' ? PLAIN_BLACK : texById(o.tex) || textures[0], w = whiteById(o.wtex || '');
    // Match blacks follows the blacks: plain black takes plain white.
    var white = w.match ? (t.plain ? '#ffffff' : t.outline || PARCHMENT) : w.plain || w.src;
    return Promise.all([t.plain ? t.plain : loadImg(t.src), white.charAt(0) === '#' ? white : loadImg(white)])
      .then(function (r) { return { fill: r[0], parch: r[1] }; });
  }

  /* ── drawing ──────────────────────────────────────────────────── */

  // Where the figure sits on the layers: both drawn on the black layer's
  // frame, trimmed the way every character icon is (artTrimBox).
  function figureBox(black, white) {
    var W = black.naturalWidth || black.width, H = black.naturalHeight || black.height;
    var c = canvas(W, H), x = c.getContext('2d');
    x.drawImage(white, 0, 0, W, H);
    x.drawImage(black, 0, 0, W, H);
    var b = window.artTrimBox ? window.artTrimBox(c) : { x: 0, y: 0, w: W, h: H };
    return { x: b.x, y: b.y, w: b.w, h: b.h, W: W, H: H };
  }
  function layersOf(icon) {
    if (!icon._layers) {
      icon._layers = Promise.all([loadImg(icon.black + '?v=' + icon.v), loadImg(icon.white + '?v=' + icon.v)])
        .then(function (l) { return { black: l[0], white: l[1], box: figureBox(l[0], l[1]) }; })
        .catch(function (e) { icon._layers = null; throw e; });
    }
    return icon._layers;
  }
  // A texture over the whole frame, cut as `cut` says: z zooms in from the
  // sheet just covering the frame, x / y (-1..1) pan across what the zoom
  // leaves spare. No cut is the sheet centred, as it always was.
  function cover(x, img, size, cut) {
    var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    var s = size / Math.min(w, h) * ((cut && cut.z) || 1), dw = w * s, dh = h * s;
    x.drawImage(img, (size - dw) / 2 - ((cut && cut.x) || 0) * (dw - size) / 2,
      (size - dh) / 2 - ((cut && cut.y) || 0) * (dh - size) / 2, dw, dh);
  }
  /* The icon at `size` px. `o` says what to show (TOGGLES) and carries the
     loaded textures: `fill` for the black layer, `parch` for the white. With
     the texture off they are plain black and plain white. */
  function compose(L, o, size) {
    var b = L.box, k = size * FILL / Math.max(b.w, b.h, 1);
    var dx = size / 2 - (b.x + b.w / 2) * k, dy = size / 2 - (b.y + b.h / 2) * k;
    function layer(img, fill, cut) {
      var c = canvas(size), x = c.getContext('2d');
      x.imageSmoothingQuality = 'high';
      x.drawImage(img, dx, dy, b.W * k, b.H * k);
      x.globalCompositeOperation = 'source-in';
      if (typeof fill === 'string') { x.fillStyle = fill; x.fillRect(0, 0, size, size); }
      else cover(x, fill, size, cut);
      return c;
    }
    var art = canvas(size), ax = art.getContext('2d');
    if (o.whites) ax.drawImage(layer(L.white, o.texture && o.parch ? o.parch : '#ffffff', o.pcut), 0, 0);
    if (o.blacks) ax.drawImage(layer(L.black, o.texture && o.fill ? o.fill : '#000000', o.fcut), 0, 0);
    var out = canvas(size), ctx = out.getContext('2d');
    if (o.shadow) {
      // Icon Forge's default shadow, at any size.
      ctx.shadowColor = 'rgba(0,0,0,0.4)';
      ctx.shadowBlur = size * 0.027;
      ctx.shadowOffsetX = ctx.shadowOffsetY = size * 0.0072;
    }
    ctx.drawImage(art, 0, 0);
    return out;
  }
  // The grid picture and the upload form's preview: the layers as uploaded.
  var AS_UPLOADED = { texture: false, whites: true, blacks: true, shadow: true };
  function render(icon, size, opts) {
    opts = opts || view;
    return Promise.all([layersOf(icon), texturesFor(opts)]).then(function (r) {
      return compose(r[0], {
        texture: opts.texture, whites: opts.whites, blacks: opts.blacks, shadow: opts.shadow,
        fill: r[1].fill, parch: r[1].parch, fcut: opts.bcut, pcut: opts.wcut
      }, size);
    });
  }
  function toBlob(c) {
    return new Promise(function (resolve, reject) {
      c.toBlob(function (b) { if (b) resolve(b); else reject(new Error('The PNG could not be made.')); }, 'image/png');
    });
  }
  function fileName(icon) {
    return (String(icon.name).replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '') || 'icon') + '_Starlit.png';
  }

  /* ── the grid ─────────────────────────────────────────────────── */

  /* Every ticked keyword must be on the icon and no crossed-out one may be;
     every typed word must be found, and a word typed with a minus in front
     (-skull) must not. */
  function matches(icon) {
    for (var t in filter.tags) {
      if ((icon.tags.indexOf(t) >= 0) !== (filter.tags[t] > 0)) return false;
    }
    var words = fold(filter.q).split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    var hay = fold(icon.name + ' ' + icon.tags.join(' ') + ' ' + icon.artist);
    return words.every(function (w) {
      if (w.charAt(0) === '-' && w.length > 1) return hay.indexOf(w.slice(1)) < 0;
      return hay.indexOf(w) >= 0;
    });
  }
  function shown() { return gallery.icons.filter(matches); }
  function byId(id) {
    for (var i = 0; i < gallery.icons.length; i++) if (String(gallery.icons[i].id) === String(id)) return gallery.icons[i];
    return null;
  }
  function drawGrid() {
    var list = shown(), n = gallery.icons.length;
    $('sg-grid').innerHTML = list.map(function (ic) {
      return '<button type="button" class="sg-tile" data-id="' + ic.id + '">' +
        '<img src="' + esc(ic.thumb + '?v=' + ic.v) + '" alt="" loading="lazy" decoding="async">' +
        '<span class="sg-tile-name">' + esc(ic.name) + '</span>' +
        (ic.tags.length ? '<span class="sg-tile-tags">' + esc(ic.tags.join(', ')) + '</span>'
          : '<span class="sg-tile-tags none">No keywords</span>') + '</button>';
    }).join('');
    $('sg-count').textContent = !n ? 'No icons yet.'
      : list.length === n ? n + (n === 1 ? ' icon' : ' icons')
      : list.length + ' of ' + n + ' icons';
    $('sg-random').disabled = !list.length;
  }
  // Every keyword in the gallery, most used first.
  function tagCounts() {
    var count = Object.create(null);
    gallery.icons.forEach(function (ic) { ic.tags.forEach(function (t) { count[t] = (count[t] || 0) + 1; }); });
    return Object.keys(count).sort(function (a, b) { return count[b] - count[a] || a.localeCompare(b); })
      .map(function (t) { return { tag: t, n: count[t] }; });
  }
  /* The most used keywords as chips, plus any in use. A tap cycles a chip
     through: show only icons with it, leave icons with it out, off. */
  function drawTags() {
    var all = tagCounts(), top = all.slice(0, 30), on = Object.keys(filter.tags);
    on.forEach(function (t) {
      if (!top.some(function (x) { return x.tag === t; })) top.unshift({ tag: t, n: 0 });
    });
    $('sg-tags').innerHTML = top.map(function (x) {
      var st = filter.tags[x.tag] || 0;
      return '<button type="button" class="sg-chip" data-tag="' + esc(x.tag) + '" data-state="' + st + '" aria-pressed="' + (st !== 0) + '"' +
        ' title="' + (st > 0 ? 'Only icons with this. Tap to leave them out instead.' : st < 0 ? 'Icons with this are left out. Tap to clear.' : 'Tap to show only icons with this.') + '">' +
        esc(x.tag) + '<small>' + (x.n || '') + '</small></button>';
    }).join('') + (on.length ? '<button type="button" class="sg-chip sg-chip-clear" data-clear="1">Clear</button>' : '');
  }
  function setTag(t) {
    var st = filter.tags[t] || 0;
    if (st > 0) filter.tags[t] = -1;
    else if (st < 0) delete filter.tags[t];
    else filter.tags[t] = 1;
    drawTags(); drawGrid();
  }

  $('sg-search').addEventListener('input', function () { filter.q = this.value; drawGrid(); });
  $('sg-tags').addEventListener('click', function (e) {
    if (e.target.closest('[data-clear]')) { filter.tags = Object.create(null); drawTags(); drawGrid(); return; }
    var b = e.target.closest('[data-tag]');
    if (b) setTag(b.getAttribute('data-tag'));
  });
  $('sg-grid').addEventListener('click', function (e) {
    var b = e.target.closest('[data-id]');
    if (b) openIcon(byId(b.getAttribute('data-id')));
  });
  $('sg-random').addEventListener('click', function () {
    var list = shown();
    if (list.length) openIcon(list[Math.floor(Math.random() * list.length)]);
  });

  /* ── windows ──────────────────────────────────────────────────── */

  function show(id, on) {
    $(id).hidden = !on;
    var open = !$('sg-detail').hidden || !$('sg-form-modal').hidden;
    document.documentElement.style.overflow = open ? 'hidden' : '';
  }
  function setUrlIcon(id) {
    try {
      var u = new URL(location.href);
      if (id) u.searchParams.set('icon', id); else u.searchParams.delete('icon');
      history.replaceState(history.state, '', u.pathname + u.search + u.hash);
    } catch (e) { /* the address just stays as it was */ }
  }
  ['sg-detail', 'sg-form-modal'].forEach(function (id) {
    // Only a press that starts AND ends on the backdrop closes the window, or
    // dragging out past its edge (a selection, a slider) would.
    var downOn = null;
    $(id).addEventListener('pointerdown', function (e) { downOn = e.target; });
    $(id).addEventListener('click', function (e) { if (e.target === this && downOn === this) closeWindow(id); });
  });
  function closeWindow(id) {
    show(id, false);
    if (id === 'sg-detail') { current = null; setUrlIcon(null); }
  }
  $('sg-d-close').addEventListener('click', function () { closeWindow('sg-detail'); });
  $('sg-f-close').addEventListener('click', function () { closeWindow('sg-form-modal'); });
  $('sg-f-cancel').addEventListener('click', function () { closeWindow('sg-form-modal'); });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!$('sg-form-modal').hidden) closeWindow('sg-form-modal');
    else if (!$('sg-detail').hidden) closeWindow('sg-detail');
  });

  /* ── one icon ─────────────────────────────────────────────────── */

  function creditHTML(icon) {
    var who = icon.artist || ARTISTS;
    var names = window.splitCreators ? window.splitCreators(who) : [who];
    return 'Art by ' + names.map(function (n) {
      var mark = window.CreatorSymbols ? window.CreatorSymbols.markHTMLFor(n) : '';
      return esc(n) + (mark ? ' ' + mark : '');
    }).join(', ') + ', from the Starlit Gallery';
  }
  function openIcon(icon) {
    if (!icon) return;
    current = icon;
    view.texture = false;
    if (!texById(view.tex)) view.tex = textures[0].id;
    $('sg-d-name').textContent = icon.name;
    $('sg-d-credit').innerHTML = creditHTML(icon);
    $('sg-d-tags').innerHTML = icon.tags.map(function (t) {
      return '<button type="button" class="sg-chip" data-tag="' + esc(t) + '">' + esc(t) + '</button>';
    }).join('');
    $('sg-d-img').removeAttribute('src');
    $('sg-manage').hidden = !gallery.canUpload || PICK;
    say('sg-d-msg', '');
    drawTexs();
    TOGGLES.forEach(function (k) { $('sg-o-' + k).checked = view[k]; });
    show('sg-detail', true);
    setUrlIcon(icon.id);
    say('sg-save-msg', '');
    loadMyChars();
    paint();
  }
  function paint() {
    if (!current) return;
    var icon = current, seq = ++paintSeq;
    render(icon, TARGET).then(toBlob).then(function (blob) {
      if (seq !== paintSeq) return;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(blob);
      $('sg-d-img').src = previewUrl;
      $('sg-d-img').alt = icon.name;
    }).catch(function (e) { if (seq === paintSeq) say('sg-d-msg', e.message, true); });
  }

  function rebuildTextures() {
    textures = BUILT_IN.concat(gallery.textures.map(function (t) {
      var src = t.image + '?v=' + t.v;
      return { id: 'starlit-' + t.id, set: 'More from the gallery', name: t.name, src: src, thumb: src };
    }), own ? [own] : []);
  }
  /* Two pickers, the blacks' texture and the whites', each a drop-down:
     closed, it shows the choice in use; open, every choice, grouped, each
     with its picture. Picking either turns the texture on. */
  var PICKERS = {
    black: { drop: 'sg-tex-drop', now: 'sg-tex-now', panel: 'sg-texs', key: 'tex',
      list: function () { return [PLAIN_BLACK].concat(textures); },
      find: function (id) { return id === 'plain' ? PLAIN_BLACK : texById(id); } },
    white: { drop: 'sg-wtex-drop', now: 'sg-wtex-now', panel: 'sg-wtexs', key: 'wtex',
      list: function () { return [MATCH_WHITE, PLAIN_WHITE].concat(OUTLINES, ownWhite ? [ownWhite] : []); },
      find: whiteById }
  };
  function swatch(t) {
    if (t.plain) return '<i class="sg-sw" style="background:' + t.plain + '" aria-hidden="true"></i>';
    if (t.match) return '<i class="sg-sw sg-sw-match" aria-hidden="true"></i>';
    return '<img src="' + esc(t.thumb) + '" alt="" loading="lazy" decoding="async">';
  }
  function label(t) {
    if (t.set === 'Yours') return 'Your own';
    if (t.set === 'Outlines') return t.name + ' outline';
    return t.set ? t.set + ': ' + t.name : t.name;
  }
  function drawPicker(which) {
    var P = PICKERS[which], sel = view[P.key], groups = [], by = {};
    var t = view.texture ? P.find(sel) : null;
    P.list().forEach(function (x) {
      var g = x.set === 'Yours' ? 'Your own' : x.set;
      if (!by[g]) { by[g] = []; groups.push(g); }
      by[g].push(x);
    });
    $(P.now).innerHTML = t ? swatch(t) + '<span>' + esc(label(t)) + '</span>'
      : '<i class="sg-sw sg-sw-none" aria-hidden="true"></i><span>None, as uploaded</span>';
    $(P.panel).innerHTML = groups.map(function (g) {
      return (g ? '<p class="sg-drop-h">' + esc(g) + '</p>' : '') + '<div class="sg-texs">' + by[g].map(function (x) {
        return '<button type="button" class="sg-tex" data-tex="' + esc(x.id) + '" aria-pressed="' + (!!view.texture && x.id === sel) + '" title="' + esc(x.name) + '">' +
          swatch(x) + '<b>' + esc(x.name) + '</b></button>';
      }).join('') + '</div>';
    }).join('') +
      '<div class="sg-texs"><button type="button" class="sg-tex sg-tex-own" data-own="1" title="Use a texture from your device"><i aria-hidden="true">+</i><b>Your own</b></button></div>';
  }
  /* Under each picker, the cut: a pad of arrows to pan the texture, dice in
     the middle for a random cut, a zoom slider and Reset, as Icon Forge
     places its texture. Built here, once per picker. Hidden while that
     layer has no texture to cut. */
  var CUT_STEP = 0.15, CUT_MIN_PAN_ZOOM = 1.3;
  function cutKey(which) { return which === 'white' ? 'wcut' : 'bcut'; }
  function arrow(cls, label, n) {
    return '<button type="button" data-n="' + n + '" aria-label="' + label + '"><span class="ico ' + cls + '" aria-hidden="true"></span></button>';
  }
  Object.keys(PICKERS).forEach(function (which) {
    var box = document.createElement('div');
    box.className = 'sg-cut';
    box.id = 'sg-cut-' + which;
    box.innerHTML = '<div class="sg-pad">' +
      '<span></span>' + arrow('ico-right sg-ico-up', 'Move the texture up', '0,1') + '<span></span>' +
      arrow('ico-left', 'Move the texture left', '1,0') +
      '<button type="button" class="sg-pad-mid" data-rand="1" aria-label="A random cut of the texture"><span class="ico ico-dice" aria-hidden="true"></span></button>' +
      arrow('ico-right', 'Move the texture right', '-1,0') +
      '<span></span>' + arrow('ico-right sg-ico-down', 'Move the texture down', '0,-1') + '<span></span></div>' +
      '<div class="sg-cut-side"><label class="sg-cut-zoom"><span>Zoom</span><input type="range" min="1" max="4" step="0.05" aria-label="Zoom the texture"></label>' +
      '<button type="button" class="sg-link-btn" data-reset="1">Reset</button></div>';
    $(PICKERS[which].drop).insertAdjacentElement('afterend', box);
    var zoom = box.querySelector('input');
    function set(c) { view[cutKey(which)] = c; zoom.value = c.z; paint(); }
    box.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      var c = view[cutKey(which)];
      if (b.hasAttribute('data-rand')) {
        set({ x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z: 1.3 + Math.random() * 1.2 });
      } else if (b.hasAttribute('data-reset')) {
        set({ x: 0, y: 0, z: 1 });
      } else {
        // At full size there is nothing spare to pan across, so an arrow
        // zooms in a little first.
        var n = b.getAttribute('data-n').split(',').map(Number), clamp = function (v) { return Math.max(-1, Math.min(1, v)); };
        set({ x: clamp(c.x + n[0] * CUT_STEP), y: clamp(c.y + n[1] * CUT_STEP), z: Math.max(c.z, CUT_MIN_PAN_ZOOM) });
      }
    });
    zoom.addEventListener('input', function () {
      var c = view[cutKey(which)];
      view[cutKey(which)] = { x: c.x, y: c.y, z: parseFloat(this.value) || 1 };
      paint();
    });
  });
  function drawCuts() {
    Object.keys(PICKERS).forEach(function (which) {
      var t = PICKERS[which].find(view[PICKERS[which].key]);
      $('sg-cut-' + which).hidden = !view.texture || !t || !!t.plain;
      $('sg-cut-' + which).querySelector('input').value = view[cutKey(which)].z;
    });
  }
  function drawTexs() { drawPicker('black'); drawPicker('white'); drawCuts(); }
  Object.keys(PICKERS).forEach(function (which) {
    var P = PICKERS[which];
    $(P.panel).addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      if (b.hasAttribute('data-own')) { ownFor = which; $('sg-own-tex').click(); return; }
      view[P.key] = b.getAttribute('data-tex');
      view.texture = true; $('sg-o-texture').checked = true;
      $(P.drop).open = false;
      drawTexs(); paint();
    });
  });
  document.addEventListener('click', function (e) {
    Object.keys(PICKERS).forEach(function (which) {
      var drop = $(PICKERS[which].drop);
      if (drop.open && !drop.contains(e.target)) drop.open = false;
    });
  });
  // A texture from the reader's own device: used here and nowhere else.
  $('sg-own-tex').addEventListener('change', function () {
    var f = this.files && this.files[0];
    this.value = '';
    if (!f) return;
    var src = URL.createObjectURL(f), mine = { id: 'own', set: 'Yours', name: 'Yours', src: src, thumb: src };
    var old = ownFor === 'white' ? ownWhite : own;
    if (old) { URL.revokeObjectURL(old.src); delete images[old.src]; }
    if (ownFor === 'white') { ownWhite = mine; view.wtex = 'own'; }
    else { own = mine; rebuildTextures(); view.tex = 'own'; }
    view.texture = true; $('sg-o-texture').checked = true;
    $(PICKERS[ownFor].drop).open = false;
    drawTexs(); paint();
  });
  TOGGLES.forEach(function (k) {
    $('sg-o-' + k).addEventListener('change', function () { view[k] = this.checked; if (k === 'texture') drawTexs(); paint(); });
  });
  $('sg-d-tags').addEventListener('click', function (e) {
    var b = e.target.closest('[data-tag]');
    if (!b) return;
    closeWindow('sg-detail');
    filter.tags = Object.create(null);
    setTag(b.getAttribute('data-tag'));
    $('sg-search').scrollIntoView({ block: 'center' });
  });

  $('sg-download').addEventListener('click', function () {
    if (!current) return;
    var icon = current, btn = this;
    btn.disabled = true;
    render(icon, parseInt($('sg-size').value, 10) || TARGET).then(toBlob).then(function (blob) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fileName(icon);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
    }).catch(function (e) { say('sg-d-msg', e.message, true); })
      .then(function () { btn.disabled = false; });
  });

  /* Icon Forge takes one picture: the layers are flattened, plain black over
     plain white, and left in localStorage for iconforge?from=starlit
     (assets/iconforge/app.js), with the texture to open on. */
  $('sg-forge').addEventListener('click', function () {
    if (!current) return;
    var icon = current, tex = view.texture && view.tex !== 'own' ? texById(view.tex) : null;
    render(icon, TARGET * 2, { tex: view.tex, texture: false, whites: view.whites, blacks: view.blacks, shadow: false })
      .then(function (c) {
        localStorage.setItem('botc_starlit_forge', JSON.stringify({
          name: icon.name, png: c.toDataURL('image/png'),
          tex: tex ? { id: tex.id, name: tex.set + ': ' + tex.name, file: tex.src } : null
        }));
        location.href = 'iconforge?from=starlit';
      })
      .catch(function (e) { say('sg-d-msg', 'Could not open it in Icon Forge: ' + e.message, true); });
  });

  // Inside a character editor: hand the icon back (assets/starlit-picker.js).
  $('sg-use').addEventListener('click', function () {
    if (!current) return;
    var icon = current, btn = this;
    btn.disabled = true;
    render(icon, TARGET).then(toBlob).then(function (blob) {
      window.parent.postMessage({
        starlit: 'pick', id: icon.id, name: icon.name, artist: icon.artist || ARTISTS, blob: blob
      }, location.origin);
    }).catch(function (e) { say('sg-d-msg', e.message, true); })
      .then(function () { btn.disabled = false; });
  });

  /* ── save straight onto one of your characters (drafts too) ───── */
  // assets/char-icon-save.js does the work, shared with Icon Forge.

  var myChars = null;   // asked once, on the first icon opened
  function loadMyChars() {
    if (myChars || PICK || !window.CharIconSave) return;
    myChars = window.CharIconSave.list().then(function (list) {
      $('sg-save').hidden = false;
      if (!list) {
        $('sg-save-msg').innerHTML = '<a href="login?next=' + encodeURIComponent('starlit' + location.search) + '">Sign in</a> to save it straight onto one of your characters.';
        return;
      }
      if (!list.length) {
        $('sg-save-msg').innerHTML = 'You have no characters yet. Start one in the <a href="create">character editor</a>.';
        return;
      }
      list.sort(function (a, b) { return a.name.localeCompare(b.name); });
      $('sg-save-pick').innerHTML = '<option value="">Choose a character…</option>' + list.map(function (c) {
        return '<option value="' + esc(c.slug) + '">' + esc(c.name) + (c.status === 'draft' ? ' (draft)' : '') + '</option>';
      }).join('');
      $('sg-save-row').hidden = false;
    }).catch(function () { myChars = null; });
  }
  $('sg-save-pick').addEventListener('change', function () { $('sg-save-go').disabled = !this.value; });
  $('sg-save-go').addEventListener('click', function () {
    var pick = $('sg-save-pick'), slug = pick.value, icon = current, btn = this;
    if (!slug || !icon) return;
    var name = pick.options[pick.selectedIndex].text.replace(/ \(draft\)$/, '');
    btn.disabled = true;
    say('sg-save-msg', 'Saving…');
    render(icon, TARGET).then(function (c) {
      return window.CharIconSave.save(slug, c.toDataURL('image/png'), {
        iconBy: String(icon.artist || ARTISTS).replace(/[[\]()]/g, '').trim() +
          ' ([Starlit Gallery](/starlit?icon=' + encodeURIComponent(icon.id) + '))',
        confirmReplace: function (n) { return window.confirm('Replace the icon on ' + n + '?'); }
      });
    }).then(function (saved) {
      if (!saved) { say('sg-save-msg', ''); return; }
      $('sg-save-msg').className = 'sg-msg';
      $('sg-save-msg').innerHTML = 'Saved to <a href="c/' + encodeURIComponent(saved) + '">' + esc(name) + '</a>.';
    }).catch(function (e) { say('sg-save-msg', e.message, true); })
      .then(function () { btn.disabled = !pick.value; });
  });

  /* ── the gallery team ─────────────────────────────────────────── */

  function api(body, path) {
    return fetch(path || '/api/starlit', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || j.error) throw new Error(j.error || 'The wiki could not save that (' + r.status + ').');
        return j;
      });
    });
  }
  function byName(a, b) { return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id - b.id; }
  function readDataURL(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result)); };
      r.onerror = function () { reject(new Error('That file could not be read.')); };
      r.readAsDataURL(file);
    });
  }

  function drawTeam() {
    $('sg-team').hidden = !gallery.canUpload || PICK;
    $('sg-admin').hidden = !gallery.isAdmin;
    $('sg-tex-list').innerHTML = gallery.textures.length ? gallery.textures.map(function (t) {
      return '<li><img src="' + esc(t.image + '?v=' + t.v) + '" alt=""><span>' + esc(t.name) + '</span>' +
        '<button type="button" class="sg-link-btn" data-del="' + t.id + '">Delete</button></li>';
    }).join('') : '<li>None yet.</li>';
    if (gallery.isAdmin) {
      $('sg-up-list').innerHTML = gallery.uploaders.length ? gallery.uploaders.map(function (u) {
        return '<li><span>@' + esc(u.username) + '</span><button type="button" class="sg-link-btn" data-unapprove="' + esc(u.username) + '">Remove</button></li>';
      }).join('') : '<li>Nobody yet. Only admins can upload.</li>';
    }
  }

  $('sg-t-add').addEventListener('click', function () {
    var name = $('sg-t-name').value.trim(), file = $('sg-t-file').files[0], btn = this;
    if (!name || !file) { say('sg-t-msg', 'Give the texture a name and pick its image.', true); return; }
    if (file.size > 4 * 1024 * 1024) { say('sg-t-msg', 'That image is over 4 MB.', true); return; }
    btn.disabled = true;
    say('sg-t-msg', 'Uploading…');
    readDataURL(file).then(function (data) { return api({ action: 'texture', name: name, image: data }); })
      .then(function (r) {
        gallery.textures.push(r.texture);
        rebuildTextures(); drawTeam();
        $('sg-t-name').value = ''; $('sg-t-file').value = '';
        say('sg-t-msg', 'Added to the texture picker.');
      })
      .catch(function (e) { say('sg-t-msg', e.message, true); })
      .then(function () { btn.disabled = false; });
  });
  $('sg-tex-list').addEventListener('click', function (e) {
    var b = e.target.closest('[data-del]');
    if (!b) return;
    var id = Number(b.getAttribute('data-del'));
    var t = gallery.textures.filter(function (x) { return x.id === id; })[0];
    if (!t || !confirm('Delete the texture "' + t.name + '"? Icons shown in it will open in Good instead.')) return;
    api({ action: 'delete-texture', id: id }).then(function () {
      gallery.textures = gallery.textures.filter(function (x) { return x.id !== id; });
      rebuildTextures(); drawTeam();
      say('sg-t-msg', 'Deleted.');
    }).catch(function (e2) { say('sg-t-msg', e2.message, true); });
  });

  /* Approved Artists: the list as it stands, each with Remove, and a box that
     only ADDS. It used to be one comma-separated box that replaced the whole
     list, and saving it with one new name quietly took everyone else off. */
  function saveUploaders(names, btn) {
    if (btn) btn.disabled = true;
    return api({ names: names }, '/api/admin/starlit-uploaders').then(function (r) {
      gallery.uploaders = r.uploaders || [];
      drawTeam();
      say('sg-up-msg', r.unknown && r.unknown.length ? 'No account is called ' + r.unknown.join(', ') + '.' : 'Saved.',
        !!(r.unknown && r.unknown.length));
    }).catch(function (e) { say('sg-up-msg', e.message, true); })
      .then(function () { if (btn) btn.disabled = false; });
  }
  function uploaderNames() { return gallery.uploaders.map(function (u) { return u.username; }); }
  $('sg-up-save').addEventListener('click', function () {
    var add = $('sg-up-names').value.split(',').map(function (s) { return s.trim().replace(/^@+/, ''); }).filter(Boolean);
    if (!add.length) { say('sg-up-msg', 'Type a username to add.', true); return; }
    saveUploaders(uploaderNames().concat(add), this).then(function () { $('sg-up-names').value = ''; });
  });
  $('sg-up-names').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); $('sg-up-save').click(); }
  });
  $('sg-up-list').addEventListener('click', function (e) {
    var b = e.target.closest('[data-unapprove]');
    if (!b) return;
    var who = b.getAttribute('data-unapprove');
    if (!confirm('Take @' + who + ' off Approved Artists? They will no longer be able to add or change icons.')) return;
    saveUploaders(uploaderNames().filter(function (n) { return n !== who; }));
  });

  /* The form: a new icon, or changes to one. A picked layer is redrawn onto a
     canvas no larger than LAYER_MAX and stored as a PNG, whatever it came in
     as; an edit sends only the layers it replaces, and a fresh grid picture
     whenever the look changed. */
  var form = { icon: null, black: null, white: null, blackData: null, whiteData: null, L: null };

  function readLayer(file) {
    var url = URL.createObjectURL(file);
    return imageFrom(url).then(function (im) {
      var w = im.naturalWidth, h = im.naturalHeight, k = Math.min(1, LAYER_MAX / Math.max(w, h));
      var c = canvas(Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)));
      var x = c.getContext('2d');
      x.imageSmoothingQuality = 'high';
      x.drawImage(im, 0, 0, c.width, c.height);
      var data = c.toDataURL('image/png');
      return imageFrom(data).then(function (img) { return { img: img, data: data }; });
    }, function () {
      throw new Error('That file could not be read as an image. Use a PNG with a transparent background.');
    }).then(function (r) { URL.revokeObjectURL(url); return r; }, function (e) { URL.revokeObjectURL(url); throw e; });
  }
  function formLayers() {
    if (!form.L) form.L = { black: form.black, white: form.white, box: figureBox(form.black, form.white) };
    return form.L;
  }
  // A layer exported trimmed to its own drawing has lost where it sat on the
  // canvas, and stretched over the other one the outline slips out of line.
  var SIZES_DIFFER = 'The two layers are different sizes, so they will not line up. Export both at the full canvas size, not trimmed.';
  function layersDiffer() {
    return form.black.naturalWidth !== form.white.naturalWidth || form.black.naturalHeight !== form.white.naturalHeight;
  }
  function formPreview() {
    var c = $('sg-f-preview'), x = c.getContext('2d');
    x.clearRect(0, 0, c.width, c.height);
    if (!form.black || !form.white) return Promise.resolve();
    if (layersDiffer()) say('sg-f-msg', SIZES_DIFFER, true);
    var L = formLayers();
    x.drawImage(compose(L, AS_UPLOADED, c.width), 0, 0);
    return Promise.resolve();
  }
  function openForm(icon) {
    form = { icon: icon || null, black: null, white: null, blackData: null, whiteData: null, L: null };
    $('sg-f-title').textContent = icon ? 'Edit ' + icon.name : 'Add an icon';
    $('sg-f-name').value = icon ? icon.name : '';
    $('sg-f-tags').value = icon ? icon.tags.join(', ') : '';
    drawFormTags();
    var last = '';
    try { last = localStorage.getItem('botc_starlit_artist') || ''; } catch (e) { /* none */ }
    $('sg-f-artist').value = icon ? icon.artist : last;
    $('sg-f-black').value = ''; $('sg-f-white').value = '';
    Array.prototype.forEach.call($('sg-form').querySelectorAll('.sg-paste input'), function (f) { f.value = ''; });
    say('sg-f-msg', icon ? 'Pick a new layer only to replace it.' : '');
    show('sg-form-modal', true);
    formPreview();
    if (icon) {
      layersOf(icon).then(function (L) {
        if (form.icon !== icon) return;
        form.black = form.black || L.black;
        form.white = form.white || L.white;
        form.L = null;
        formPreview();
      }).catch(function (e) { say('sg-f-msg', e.message, true); });
    }
    $('sg-f-name').focus();
  }
  ['black', 'white'].forEach(function (k) {
    $('sg-f-' + k).addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (!f) return;
      say('sg-f-msg', '');
      readLayer(f).then(function (r) {
        form[k] = r.img; form[k + 'Data'] = r.data; form.L = null;
        formPreview();
      }).catch(function (e) { say('sg-f-msg', e.message, true); });
    });
  });
  /* Paste into an upload: under each file box, a box that takes a pasted
     image or an image link (and a Paste button, for a phone, where the
     browser can read the clipboard). Whatever arrives is put into the file
     box itself, so the rest of the form cannot tell it from a picked file. */
  function pasteImageInto(input, msgId) {
    var box = document.createElement('div');
    box.className = 'sg-paste';
    box.innerHTML = '<input type="text" inputmode="url" placeholder="or paste an image or an image link here" aria-label="Paste an image or an image link">' +
      '<button type="button" class="sg-btn sg-btn-quiet" hidden>Paste</button>';
    input.closest('label').insertAdjacentElement('afterend', box);
    var field = box.querySelector('input'), btn = box.querySelector('button');
    function use(blob) {
      if (!blob || !/^image\//.test(blob.type)) { say(msgId, 'That is not an image.', true); return; }
      var ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      var file = blob instanceof File && blob.name ? blob : new File([blob], 'pasted image.' + ext, { type: blob.type });
      try {
        var dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
      } catch (e) {
        say(msgId, 'This browser cannot take a pasted image here. Save it and pick the file instead.', true);
        return;
      }
      field.value = '';
      say(msgId, '');
      input.dispatchEvent(new Event('change'));
    }
    function fromLink(text) {
      var url = String(text || '').trim();
      if (!/^https?:\/\/\S+$/i.test(url)) { if (url) say(msgId, 'Paste an image, or a link starting with https://.', true); return; }
      say(msgId, 'Fetching the image…');
      fetch(url, { mode: 'cors', credentials: 'omit' })
        .then(function (r) { if (!r.ok) throw new Error('status'); return r.blob(); })
        .then(use, function () {
          say(msgId, 'That site does not let other pages copy its images, or the link is not an image. Save the image and pick the file instead.', true);
        });
    }
    field.addEventListener('paste', function (e) {
      var items = (e.clipboardData && e.clipboardData.items) || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file' && /^image\//.test(items[i].type)) {
          e.preventDefault();
          use(items[i].getAsFile());
          return;
        }
      }
      var text = e.clipboardData && e.clipboardData.getData('text/plain');
      if (text) { e.preventDefault(); field.value = text.trim(); fromLink(text); }
    });
    field.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); fromLink(field.value); }
    });
    field.addEventListener('change', function () { fromLink(field.value); });
    if (navigator.clipboard && navigator.clipboard.read) {
      btn.hidden = false;
      btn.addEventListener('click', function () {
        navigator.clipboard.read().then(function (items) {
          for (var i = 0; i < items.length; i++) {
            var type = items[i].types.filter(function (t) { return /^image\//.test(t); })[0];
            if (type) return items[i].getType(type).then(use);
          }
          return navigator.clipboard.readText().then(function (t) {
            if (t && t.trim()) { field.value = t.trim(); fromLink(t); }
            else say(msgId, 'There is no image or link on the clipboard. Copy one first.', true);
          });
        }).catch(function () {
          say(msgId, 'The browser did not let the page read the clipboard. Paste into the box instead.', true);
        });
      });
    }
  }
  pasteImageInto($('sg-f-black'), 'sg-f-msg');
  pasteImageInto($('sg-f-white'), 'sg-f-msg');
  pasteImageInto($('sg-t-file'), 'sg-t-msg');

  /* The keywords already in the gallery, under the form's Keywords box: a
     tap adds one to the box, or takes it out if it is there. */
  function formTags() {
    return $('sg-f-tags').value.split(',').map(function (t) { return t.toLowerCase().replace(/\s+/g, ' ').trim(); }).filter(Boolean);
  }
  function drawFormTags() {
    var have = formTags(), all = tagCounts();
    $('sg-f-tagpick').hidden = !all.length;
    $('sg-f-tagpick-list').innerHTML = all.map(function (x) {
      var on = have.indexOf(x.tag) >= 0;
      return '<button type="button" class="sg-chip" data-tag="' + esc(x.tag) + '" aria-pressed="' + on + '">' + esc(x.tag) + '<small>' + x.n + '</small></button>';
    }).join('');
  }
  $('sg-f-tagpick-list').addEventListener('click', function (e) {
    var b = e.target.closest('[data-tag]');
    if (!b) return;
    var t = b.getAttribute('data-tag'), have = formTags(), i = have.indexOf(t);
    if (i >= 0) have.splice(i, 1); else have.push(t);
    $('sg-f-tags').value = have.join(', ');
    drawFormTags();
  });
  $('sg-f-tags').addEventListener('input', drawFormTags);

  $('sg-add').addEventListener('click', function () { openForm(null); });
  $('sg-edit').addEventListener('click', function () {
    var icon = current;
    closeWindow('sg-detail');
    openForm(icon);
  });
  $('sg-delete').addEventListener('click', function () {
    var icon = current;
    if (!icon || !confirm('Delete "' + icon.name + '" from the gallery? This cannot be undone.')) return;
    api({ action: 'delete', id: icon.id }).then(function () {
      gallery.icons = gallery.icons.filter(function (x) { return x.id !== icon.id; });
      closeWindow('sg-detail');
      drawTags(); drawGrid();
    }).catch(function (e) { say('sg-d-msg', e.message, true); });
  });

  $('sg-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var icon = form.icon, btn = $('sg-f-save');
    var body = {
      action: 'save', name: $('sg-f-name').value.trim(), tags: $('sg-f-tags').value,
      artist: $('sg-f-artist').value.trim(), tex: ''
    };
    if (icon) body.id = icon.id;
    if (!body.name) { say('sg-f-msg', 'Give the icon a name.', true); return; }
    if (!form.black || !form.white) {
      say('sg-f-msg', icon ? 'The layers are still loading. Try again in a moment.' : 'Pick both layers.', true);
      return;
    }
    if (layersDiffer()) { say('sg-f-msg', SIZES_DIFFER, true); return; }
    if (form.blackData) body.black = form.blackData;
    if (form.whiteData) body.white = form.whiteData;
    var newLook = !icon || body.black || body.white || icon.tex;
    btn.disabled = true;
    say('sg-f-msg', 'Saving…');
    Promise.resolve().then(function () {
      if (newLook) body.thumb = compose(formLayers(), AS_UPLOADED, THUMB).toDataURL('image/webp', 0.86);
      return api(body);
    }).then(function (r) {
      gallery.icons = gallery.icons.filter(function (x) { return x.id !== r.icon.id; }).concat([r.icon]).sort(byName);
      try { localStorage.setItem('botc_starlit_artist', body.artist); } catch (e2) { /* fine */ }
      closeWindow('sg-form-modal');
      drawTags(); drawGrid();
      openIcon(r.icon);
    }).catch(function (e2) { say('sg-f-msg', e2.message, true); })
      .then(function () { btn.disabled = false; });
  });

  /* ── start ────────────────────────────────────────────────────── */

  if (PICK) {
    $('sg-pick-head').hidden = false;
    $('sg-use').hidden = false;
    $('sg-download').hidden = true;
    $('sg-size').hidden = true;
  }
  if (window.CreatorSymbols) {
    var drawHeroMark = function () {
      var old = document.querySelector('.sg-by .creator-mark');
      if (old) old.remove();
      var m = window.CreatorSymbols.markHTMLFor(ARTISTS);
      if (m) $('sg-by-link').parentNode.insertAdjacentHTML('beforeend', ' ' + m);
    };
    drawHeroMark();
    window.CreatorSymbols.load().then(drawHeroMark);
  }

  fetch('/api/starlit', { credentials: 'same-origin' })
    .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
    .then(function (d) {
      gallery = {
        icons: d.icons || [], textures: d.textures || [], canUpload: !!d.canUpload,
        isAdmin: !!d.isAdmin, uploaders: d.uploaders || []
      };
      rebuildTextures(); drawTags(); drawGrid(); drawTeam();
      var want = new URLSearchParams(location.search).get('icon');
      if (want) openIcon(byId(want));
    })
    .catch(function () { $('sg-count').textContent = 'The gallery could not be loaded. Refresh the page to try again.'; });
})();
