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
  /* Textures come in PACKS, kept by the team in Settings (the ones the page
     shipped with are the team's Photoshop sets, Default to Glitchy, and the
     wiki's own Official set): eight sheets for the blacks and an Outline
     sheet that paints the whites whichever of the pack's sheets is on.
     Built from the server's list by rebuildTextures(). */
  var KINDS = [['base', 'Base'], ['good', 'Good'], ['evil', 'Evil'], ['traveller', 'Traveller'],
    ['traveller-good', 'Traveller Good'], ['traveller-evil', 'Traveller Evil'], ['fabled', 'Fabled'], ['loric', 'Loric'],
    ['outline', 'Outline']];
  var KIND_LABEL = {};
  KINDS.forEach(function (k) { KIND_LABEL[k[0]] = k[1]; });
  // The whites for a texture with no pack outline (the reader's own).
  var PARCHMENT = '/assets/starlit/tex/default-outline.webp';
  var OUTLINES = [];
  var PLAIN_BLACK = { id: 'plain', set: '', name: 'Plain black', plain: '#000000' };
  var MATCH_WHITE = { id: '', set: '', name: 'Match blacks', match: true };
  var PLAIN_WHITE = { id: 'plain', set: '', name: 'Plain white', plain: '#ffffff' };
  var TOGGLES = ['texture', 'whites', 'blacks', 'shadow'];

  var gallery = { icons: [], textures: [], files: [], page: null, canUpload: false, isAdmin: false, uploaders: [] };
  var textures = [];                 // every pack's sheets, + the reader's own
  var own = null;                    // a texture picked from the reader's device
  var ownWhite = null;               // the same, for the whites
  var ownFor = 'black';              // which picker the device file is for
  // tags: {keyword: 1 to require it, -1 to leave it out}.
  var filter = { q: '', tags: Object.create(null), artists: Object.create(null) };
  // An icon opens as it was uploaded: no texture until the reader picks one.
  var view = { tex: '', wtex: '', bcut: { x: 0, y: 0, z: 1 }, wcut: { x: 0, y: 0, z: 1 }, texture: false, whites: true, blacks: true, shadow: true };
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
    var t = o.tex === 'plain' ? PLAIN_BLACK : texById(o.tex) || textures[0] || PLAIN_BLACK, w = whiteById(o.wtex || '');
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
  // The artists an icon credits, one name each ("A, B" is two).
  function artistsOf(icon) {
    var who = icon.artist || ARTISTS;
    return (window.splitCreators ? window.splitCreators(who) : who.split(','))
      .map(function (n) { return String(n).trim(); }).filter(Boolean);
  }
  function matches(icon) {
    for (var t in filter.tags) {
      if ((icon.tags.indexOf(t) >= 0) !== (filter.tags[t] > 0)) return false;
    }
    for (var a in filter.artists) {
      var has = artistsOf(icon).some(function (n) { return fold(n) === fold(a); });
      if (has !== (filter.artists[a] > 0)) return false;
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
  // Every keyword (or artist) in the gallery, most used first.
  function countsOf(each) {
    var count = Object.create(null);
    gallery.icons.forEach(function (ic) { each(ic).forEach(function (t) { count[t] = (count[t] || 0) + 1; }); });
    return Object.keys(count).sort(function (a, b) { return count[b] - count[a] || a.localeCompare(b); })
      .map(function (t) { return { tag: t, n: count[t] }; });
  }
  function tagCounts() { return countsOf(function (ic) { return ic.tags; }); }
  function artistCounts() { return countsOf(artistsOf); }
  /* The most used keywords as chips, plus any in use; the artists likewise,
     on a row of their own. A tap cycles a chip through: show only icons with
     it, leave icons with it out, off. */
  function chipsHTML(list, state, attr, what) {
    var on = Object.keys(state);
    on.forEach(function (t) {
      if (!list.some(function (x) { return x.tag === t; })) list.unshift({ tag: t, n: 0 });
    });
    return list.map(function (x) {
      var st = state[x.tag] || 0;
      return '<button type="button" class="sg-chip" ' + attr + '="' + esc(x.tag) + '" data-state="' + st + '" aria-pressed="' + (st !== 0) + '"' +
        ' title="' + (st > 0 ? 'Only icons ' + what + '. Tap to leave them out instead.' : st < 0 ? 'Icons ' + what + ' are left out. Tap to clear.' : 'Tap to show only icons ' + what + '.') + '">' +
        esc(x.tag) + '<small>' + (x.n || '') + '</small></button>';
    }).join('') + (on.length ? '<button type="button" class="sg-chip sg-chip-clear" data-clear="1">Clear</button>' : '');
  }
  function drawTags() {
    $('sg-tags').innerHTML = chipsHTML(tagCounts().slice(0, 30), filter.tags, 'data-tag', 'with this');
    var artists = artistCounts();
    // One artist is nothing to choose between.
    $('sg-artists').hidden = artists.length < 2 && !Object.keys(filter.artists).length;
    $('sg-artists').innerHTML = '<span class="sg-chips-h">Artists</span>' + chipsHTML(artists, filter.artists, 'data-artist', 'by this artist');
  }
  function cycle(state, t) {
    var st = state[t] || 0;
    if (st > 0) state[t] = -1;
    else if (st < 0) delete state[t];
    else state[t] = 1;
    drawTags(); drawGrid();
  }
  function setTag(t) { cycle(filter.tags, t); }

  $('sg-search').addEventListener('input', function () { filter.q = this.value; drawGrid(); });
  $('sg-tags').addEventListener('click', function (e) {
    if (e.target.closest('[data-clear]')) { filter.tags = Object.create(null); drawTags(); drawGrid(); return; }
    var b = e.target.closest('[data-tag]');
    if (b) setTag(b.getAttribute('data-tag'));
  });
  $('sg-artists').addEventListener('click', function (e) {
    if (e.target.closest('[data-clear]')) { filter.artists = Object.create(null); drawTags(); drawGrid(); return; }
    var b = e.target.closest('[data-artist]');
    if (b) cycle(filter.artists, b.getAttribute('data-artist'));
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
    if (!texById(view.tex)) view.tex = textures[0] ? textures[0].id : 'plain';
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

  function kindOrder(k) { for (var i = 0; i < KINDS.length; i++) if (KINDS[i][0] === k) return i; return 99; }
  // The server's list, pack by pack in its order, as the two pickers' entries.
  function packsOf(list) {
    var packs = [], by = {};
    list.forEach(function (t) {
      if (!by[t.pack]) { by[t.pack] = { name: t.pack, sheets: [] }; packs.push(by[t.pack]); }
      by[t.pack].sheets.push(t);
    });
    packs.forEach(function (p) { p.sheets.sort(function (a, b) { return kindOrder(a.kind) - kindOrder(b.kind) || a.id - b.id; }); });
    return packs;
  }
  function rebuildTextures() {
    textures = []; OUTLINES = [];
    packsOf(gallery.textures).forEach(function (p) {
      var out = p.sheets.filter(function (t) { return t.kind === 'outline'; })[0];
      var outSrc = out ? out.image + '?v=' + out.v : PARCHMENT;
      if (out) OUTLINES.push({ id: 'w' + out.id, set: 'Outlines', name: p.name, src: outSrc, thumb: out.thumb + '?v=' + out.v });
      p.sheets.forEach(function (t) {
        if (t.kind === 'outline') return;
        textures.push({ id: 't' + t.id, set: p.name, name: t.name || KIND_LABEL[t.kind] || t.kind,
          src: t.image + '?v=' + t.v, thumb: t.thumb + '?v=' + t.v, outline: outSrc });
      });
    });
    if (own) textures.push(own);
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
    drawPacks();
    drawDownloads();
    if (!gallery.page || !gallery.page.credits) drawCredits(gallery.page);
    drawRenameList();
    if (gallery.isAdmin) {
      $('sg-up-list').innerHTML = gallery.uploaders.length ? gallery.uploaders.map(function (u) {
        return '<li><span>@' + esc(u.username) + '</span><button type="button" class="sg-link-btn" data-unapprove="' + esc(u.username) + '">Remove</button></li>';
      }).join('') : '<li>Nobody yet. Only admins can upload.</li>';
    }
  }

  /* ── texture packs ───────────────────────────────────────────── */

  function drawPacks() {
    if (!gallery.canUpload) return;
    var packs = packsOf(gallery.textures);
    $('sg-packs').innerHTML = packs.length ? packs.map(function (p, pi) {
      var have = {};
      p.sheets.forEach(function (t) { have[t.kind] = t; });
      return '<div class="sg-pack" data-pack="' + esc(p.name) + '"><div class="sg-pack-head"><b>' + esc(p.name) + '</b>' +
        moveButtons(pi, packs.length, 'pack') +
        '<button type="button" class="sg-link-btn" data-act="more">Add several</button>' +
        '<button type="button" class="sg-link-btn" data-act="rename">Rename</button>' +
        '<button type="button" class="sg-link-btn" data-act="drop">Delete pack</button></div>' +
        '<div class="sg-pack-sheets">' + KINDS.map(function (k) {
          var t = have[k[0]];
          return '<div class="sg-sheet"><button type="button" data-act="put" data-kind="' + k[0] + '" title="' + (t ? 'Replace' : 'Add') + ' the ' + esc(k[1]) + ' sheet">' +
            (t ? '<img src="' + esc(t.thumb + '?v=' + t.v) + '" alt="" loading="lazy">' : '+') + '</button>' +
            '<span>' + esc((t && t.name) || k[1]) + '</span>' +
            (t ? '<button type="button" class="sg-link-btn" data-act="remove" data-id="' + t.id + '">Remove</button>' : '') + '</div>';
        }).join('') + '</div></div>';
    }).join('') : '<p>No packs. Add one below.</p>';
  }
  /* Which sheet a file is, from its name (unless another file in this batch
     already is), else the first sheet the pack does not have yet. */
  function guessKind(name, taken, existing) {
    var n = ' ' + String(name).toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z]+/g, ' ') + ' ';
    var trav = /travel/.test(n), k = '';
    if (/outline|white|parch/.test(n)) k = 'outline';
    else if (trav && /good|blue/.test(n)) k = 'traveller-good';
    else if (trav && /evil|red/.test(n)) k = 'traveller-evil';
    else if (trav) k = 'traveller';
    else if (/fabled/.test(n)) k = 'fabled';
    else if (/loric/.test(n)) k = 'loric';
    else if (/good|townsfolk|outsider/.test(n)) k = 'good';
    else if (/evil|minion|demon/.test(n)) k = 'evil';
    else if (/ base | black | mono/.test(n)) k = 'base';
    if (k && !taken[k]) return k;
    for (var i = 0; i < KINDS.length; i++) if (!taken[KINDS[i][0]] && !existing[KINDS[i][0]]) return KINDS[i][0];
    return '';
  }
  // A sheet as the server stores it: WebP no wider than 1182px, plus a
  // 160px square for the pickers.
  function prepSheet(file) {
    var url = URL.createObjectURL(file);
    return imageFrom(url).then(function (im) {
      URL.revokeObjectURL(url);
      var w = im.naturalWidth, h = im.naturalHeight, k = Math.min(1, 1182 / Math.max(w, h));
      var c = canvas(Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)));
      var x = c.getContext('2d');
      x.imageSmoothingQuality = 'high';
      x.drawImage(im, 0, 0, c.width, c.height);
      var th = canvas(160), tx = th.getContext('2d');
      tx.imageSmoothingQuality = 'high';
      cover(tx, im, 160);
      return { image: c.toDataURL('image/webp', 0.86), thumb: th.toDataURL('image/webp', 0.8) };
    }, function () { URL.revokeObjectURL(url); throw new Error(file.name + ' could not be read as an image.'); });
  }
  // A sheet back from the server: in its old place, or after its pack's
  // other sheets, or (a new pack) at the end, which is where the server
  // lists a pack its order does not name yet.
  function putSheet(t) {
    var list = gallery.textures, i = list.findIndex(function (x) { return x.id === t.id; });
    if (i >= 0) { list[i] = t; return; }
    var last = -1;
    list.forEach(function (x, j) { if (x.pack === t.pack) last = j; });
    if (last >= 0) list.splice(last + 1, 0, t); else list.push(t);
  }
  /* Moving a pack or a download up or down the list. The order is stored
     as a list of names (`order {what, list}`), so it costs one small save. */
  var UP = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 7.5 6 4l3.5 3.5"/></svg>';
  var DOWN = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5"/></svg>';
  function moveButtons(i, n, what) {
    return '<span class="sg-move"><button type="button" data-move="-1" aria-label="Move this ' + what + ' up"' + (i === 0 ? ' disabled' : '') + '>' + UP + '</button>' +
      '<button type="button" data-move="1" aria-label="Move this ' + what + ' down"' + (i === n - 1 ? ' disabled' : '') + '>' + DOWN + '</button></span>';
  }
  function moved(names, name, by) {
    var i = names.indexOf(name), j = i + by;
    if (i < 0 || j < 0 || j >= names.length) return null;
    names = names.slice();
    names.splice(i, 1);
    names.splice(j, 0, name);
    return names;
  }
  function regroup(list, key, names) {
    return names.reduce(function (out, n) { return out.concat(list.filter(function (x) { return x[key] === n; })); }, []);
  }
  /* Files into a pack, one after another; `kind` puts a single file on that
     sheet, otherwise each goes where its name says. */
  function uploadSheets(pack, files, kind) {
    var taken = {}, existing = {}, jobs = [];
    gallery.textures.forEach(function (t) { if (t.pack === pack) existing[t.kind] = true; });
    Array.prototype.forEach.call(files, function (f) {
      var k = kind || guessKind(f.name, taken, existing);
      if (!k) return;
      taken[k] = true;
      jobs.push({ file: f, kind: k });
    });
    if (!jobs.length) { say('sg-t-msg', 'A pack has nine sheets and these files did not name one. Tap a sheet to replace it.', true); return Promise.resolve(); }
    var done = 0;
    return jobs.reduce(function (chain, j) {
      return chain.then(function () {
        say('sg-t-msg', 'Uploading ' + (done + 1) + ' of ' + jobs.length + '…');
        if (j.file.size > 25 * 1024 * 1024) throw new Error(j.file.name + ' is over 25 MB.');
        return prepSheet(j.file).then(function (img) {
          return api({ action: 'texture', pack: pack, kind: j.kind, image: img.image, thumb: img.thumb });
        }).then(function (r) { putSheet(r.texture); done++; });
      });
    }, Promise.resolve()).then(function () {
      rebuildTextures(); drawPacks();
      say('sg-t-msg', done === 1 ? 'Saved ' + KIND_LABEL[jobs[0].kind] + ' in ' + pack + '.'
        : 'Saved ' + done + ' sheets in ' + pack + ': ' + jobs.map(function (j) { return j.file.name + ' as ' + KIND_LABEL[j.kind]; }).join(', ') + '.');
    }).catch(function (e) {
      rebuildTextures(); drawPacks();
      say('sg-t-msg', e.message, true);
    });
  }
  var packTarget = null;   // {pack, kind} for the hidden file boxes
  $('sg-packs').addEventListener('click', function (e) {
    var mv = e.target.closest('[data-move]');
    if (mv) {
      var names = moved(packsOf(gallery.textures).map(function (p) { return p.name; }),
        mv.closest('[data-pack]').getAttribute('data-pack'), Number(mv.getAttribute('data-move')));
      if (!names) return;
      gallery.textures = regroup(gallery.textures, 'pack', names);
      rebuildTextures(); drawPacks();
      api({ action: 'order', what: 'packs', list: names }).catch(function (e2) { say('sg-t-msg', e2.message, true); });
      return;
    }
    var b = e.target.closest('[data-act]');
    if (!b) return;
    var pack = b.closest('[data-pack]').getAttribute('data-pack'), act = b.getAttribute('data-act');
    if (act === 'put') { packTarget = { pack: pack, kind: b.getAttribute('data-kind') }; $('sg-p-one').click(); }
    else if (act === 'more') { packTarget = { pack: pack }; $('sg-p-more').click(); }
    else if (act === 'remove') {
      var id = Number(b.getAttribute('data-id'));
      if (!confirm('Remove this sheet from ' + pack + '?')) return;
      api({ action: 'delete-texture', id: id }).then(function () {
        gallery.textures = gallery.textures.filter(function (x) { return x.id !== id; });
        rebuildTextures(); drawPacks(); say('sg-t-msg', 'Removed.');
      }).catch(function (e2) { say('sg-t-msg', e2.message, true); });
    } else if (act === 'rename') {
      var to = (prompt('New name for ' + pack + ':', pack) || '').replace(/\s+/g, ' ').trim();
      if (!to || to === pack) return;
      api({ action: 'pack', from: pack, to: to }).then(function () {
        gallery.textures.forEach(function (t) { if (t.pack === pack) t.pack = to; });
        rebuildTextures(); drawPacks(); say('sg-t-msg', 'Renamed to ' + to + '.');
      }).catch(function (e2) { say('sg-t-msg', e2.message, true); });
    } else if (act === 'drop') {
      if (!confirm('Delete the whole ' + pack + ' pack? Its sheets go from every picker.')) return;
      api({ action: 'pack', from: pack, remove: true }).then(function () {
        gallery.textures = gallery.textures.filter(function (x) { return x.pack !== pack; });
        rebuildTextures(); drawPacks(); say('sg-t-msg', pack + ' deleted.');
      }).catch(function (e2) { say('sg-t-msg', e2.message, true); });
    }
  });
  ['sg-p-one', 'sg-p-more'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      var files = Array.prototype.slice.call(this.files || []);
      this.value = '';
      if (files.length && packTarget) uploadSheets(packTarget.pack, files, packTarget.kind);
    });
  });
  $('sg-p-add').addEventListener('click', function () {
    var name = $('sg-p-name').value.replace(/\s+/g, ' ').trim(), files = $('sg-p-files').files, btn = this;
    if (!name || !files.length) { say('sg-t-msg', 'Name the pack and pick its sheets.', true); return; }
    if (gallery.textures.some(function (t) { return t.pack === name; }) &&
        !confirm('There is already a pack called ' + name + '. Add these sheets to it?')) return;
    btn.disabled = true;
    uploadSheets(name, files).then(function () {
      $('sg-p-name').value = ''; $('sg-p-files').value = '';
      btn.disabled = false;
    });
  });

  /* ── keyword and artist renames ──────────────────────────────── */

  function drawRenameList() {
    if (!gallery.canUpload) return;
    var list = $('sg-r-what').value === 'artist' ? artistCounts() : tagCounts();
    $('sg-r-list').innerHTML = list.map(function (x) { return '<option value="' + esc(x.tag) + '">'; }).join('');
  }
  $('sg-r-what').addEventListener('change', drawRenameList);
  $('sg-r-go').addEventListener('click', function () {
    var what = $('sg-r-what').value, from = $('sg-r-from').value.trim(), to = $('sg-r-to').value.trim(), btn = this;
    if (!from) { say('sg-r-msg', 'Type the ' + (what === 'artist' ? 'artist' : 'keyword') + ' to change.', true); return; }
    if (!to && what === 'artist') { say('sg-r-msg', 'Type the artist\'s new name.', true); return; }
    if (!to && !confirm('Take the keyword "' + from + '" off every icon?')) return;
    btn.disabled = true;
    api({ action: 'rename', what: what, from: from, to: to }).then(function (r) {
      say('sg-r-msg', r.changed ? 'Changed on ' + r.changed + (r.changed === 1 ? ' icon.' : ' icons.') : 'No icon has "' + from + '".', !r.changed);
      $('sg-r-from').value = ''; $('sg-r-to').value = '';
      return load();
    }).catch(function (e) { say('sg-r-msg', e.message, true); })
      .then(function () { btn.disabled = false; });
  });

  /* ── downloads ───────────────────────────────────────────────── */

  function sizeText(n) {
    return n >= 1048576 ? (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  }
  // Files sharing a title are one row: a PSD beside its PNG.
  function drawDownloads() {
    var groups = [], by = {};
    gallery.files.forEach(function (f) {
      if (!by[f.title]) { by[f.title] = { title: f.title, note: '', files: [] }; groups.push(by[f.title]); }
      by[f.title].files.push(f);
      if (f.note) by[f.title].note = f.note;
    });
    var team = gallery.canUpload && !PICK;
    $('sg-dl').hidden = !groups.length && !team;
    $('sg-dl-team').hidden = !team;
    $('sg-dl-list').innerHTML = groups.length ? groups.map(function (g, gi) {
      return '<li data-group="' + esc(g.title) + '"><div class="sg-dl-head"><div class="sg-dl-t">' + esc(g.title) + '</div>' +
        (team && groups.length > 1 ? moveButtons(gi, groups.length, 'download') : '') + '</div>' + (g.note ? '<p class="sg-dl-n">' + esc(g.note) + '</p>' : '') +
        '<div class="sg-dl-files">' + g.files.map(function (f) {
          var ext = String(f.name.split('.').pop() || '').toUpperCase();
          return '<a class="sg-btn" href="' + esc(f.url) + '" download="' + esc(f.name) + '">Download ' + esc(ext) + '<small>' + sizeText(f.size) + '</small></a>' +
            (team ? '<button type="button" class="sg-link-btn" data-fdel="' + f.id + '">Delete ' + esc(ext) + '</button>' : '');
        }).join('') + (team ? '<button type="button" class="sg-link-btn" data-fedit="' + esc(g.title) + '">Edit title and note</button>' : '') +
        '</div></li>';
    }).join('') : '<li class="sg-dl-none">Nothing to download yet.</li>';
  }
  $('sg-dl-list').addEventListener('click', function (e) {
    var mv = e.target.closest('[data-move]');
    if (mv) {
      var titles = [];
      gallery.files.forEach(function (f) { if (titles.indexOf(f.title) < 0) titles.push(f.title); });
      titles = moved(titles, mv.closest('[data-group]').getAttribute('data-group'), Number(mv.getAttribute('data-move')));
      if (!titles) return;
      gallery.files = regroup(gallery.files, 'title', titles);
      drawDownloads();
      api({ action: 'order', what: 'files', list: titles }).catch(function (e2) { say('sg-dl-msg', e2.message, true); });
      return;
    }
    var del = e.target.closest('[data-fdel]'), ed = e.target.closest('[data-fedit]');
    if (del) {
      var id = Number(del.getAttribute('data-fdel'));
      if (!confirm('Delete this file from Downloads?')) return;
      api({ action: 'delete-file', id: id }).then(function () {
        gallery.files = gallery.files.filter(function (f) { return f.id !== id; });
        drawDownloads();
      }).catch(function (e2) { say('sg-dl-msg', e2.message, true); });
    } else if (ed) {
      var old = ed.getAttribute('data-fedit');
      var group = gallery.files.filter(function (f) { return f.title === old; });
      var title = prompt('Title:', old);
      if (title == null || !title.trim()) return;
      var note = prompt('Note (optional):', (group.filter(function (f) { return f.note; })[0] || {}).note || '');
      if (note == null) return;
      Promise.all(group.map(function (f) {
        return api({ action: 'file', id: f.id, title: title.trim(), note: note.trim() }).then(function () {
          f.title = title.replace(/\s+/g, ' ').trim(); f.note = note.trim();
        });
      })).then(drawDownloads).catch(function (e2) { say('sg-dl-msg', e2.message, true); });
    }
  });
  // The file goes as the request's whole body, with a progress count: a
  // Photoshop file can be tens of MB on a phone's connection.
  $('sg-dl-add').addEventListener('click', function () {
    var title = $('sg-dl-title').value.trim(), file = $('sg-dl-file').files[0], btn = this;
    if (!title || !file) { say('sg-dl-msg', 'Give it a title and pick the file.', true); return; }
    if (file.size > 95 * 1024 * 1024) { say('sg-dl-msg', 'That file is over 95 MB.', true); return; }
    var q = new URLSearchParams({ title: title, note: $('sg-dl-note').value.trim(), name: file.name });
    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/starlit-file?' + q);
    xhr.upload.onprogress = function (e) {
      if (e.lengthComputable) say('sg-dl-msg', 'Uploading… ' + Math.round(e.loaded / e.total * 100) + '%');
    };
    xhr.onload = function () {
      btn.disabled = false;
      var j = {};
      try { j = JSON.parse(xhr.responseText); } catch (e2) { /* not JSON */ }
      if (xhr.status !== 200 || !j.file) { say('sg-dl-msg', j.error || 'The upload failed (' + xhr.status + ').', true); return; }
      gallery.files.push(j.file);
      drawDownloads();
      $('sg-dl-file').value = '';
      say('sg-dl-msg', 'Added to Downloads.');
    };
    xhr.onerror = function () { btn.disabled = false; say('sg-dl-msg', 'The upload stopped. Check your connection and try again.', true); };
    btn.disabled = true;
    say('sg-dl-msg', 'Uploading…');
    xhr.send(file);
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
    drawPick('artist');
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

  /* The keywords already in the gallery under the form's Keywords box, and
     the artists under its Artist box: a tap adds one to the box, or takes it
     out if it is there. */
  var PICKS = {
    tag: { field: 'sg-f-tags', wrap: 'sg-f-tagpick', list: 'sg-f-tagpick-list', all: tagCounts,
      norm: function (t) { return t.toLowerCase().replace(/\s+/g, ' ').trim(); } },
    artist: { field: 'sg-f-artist', wrap: 'sg-f-artistpick', list: 'sg-f-artistpick-list', all: artistCounts,
      norm: function (t) { return t.replace(/\s+/g, ' ').trim(); } }
  };
  function boxValues(P) {
    return $(P.field).value.split(',').map(P.norm).filter(Boolean);
  }
  function drawPick(which) {
    var P = PICKS[which], have = boxValues(P).map(fold), all = P.all();
    $(P.wrap).hidden = !all.length;
    $(P.list).innerHTML = all.map(function (x) {
      var on = have.indexOf(fold(x.tag)) >= 0;
      return '<button type="button" class="sg-chip" data-pick="' + esc(x.tag) + '" aria-pressed="' + on + '">' + esc(x.tag) + '<small>' + x.n + '</small></button>';
    }).join('');
  }
  function drawFormTags() { drawPick('tag'); drawPick('artist'); }
  Object.keys(PICKS).forEach(function (which) {
    var P = PICKS[which];
    $(P.list).addEventListener('click', function (e) {
      var b = e.target.closest('[data-pick]');
      if (!b) return;
      var t = b.getAttribute('data-pick'), have = boxValues(P);
      var i = have.map(fold).indexOf(fold(t));
      if (i >= 0) have.splice(i, 1); else have.push(t);
      $(P.field).value = have.join(', ');
      drawPick(which);
    });
    $(P.field).addEventListener('input', function () { drawPick(which); });
  });

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

  /* ── the page itself: its words and its look ─────────────────── */
  /* The line under the title and the About text are the team's, written in
     the wiki's text marks and drawn by render-wiki.js (which escapes first,
     so nothing typed becomes raw HTML); the theme kit is the one every other
     page has (PageRender.sanitizeTheme, applied as on a creator page). Until
     the team saves anything, the page's own HTML is what shows. The DEFAULT
     texts are that HTML in marks, so the editor opens on what is there. */
  var DEFAULT_INTRO = 'The Starlit Gallery is a free to use icon collection, developed by [@harryandco](/u/harryandco) and [@bendan07](/u/Bendan).';
  var DEFAULT_SYNOPSIS = [
    '{{i|The endless void of the skies above stretches into the darkness far beyond mortal perception. Galaxies, vagabond planets, and unreachable alien life dwell beyond the lights that mark our known universe, shimmering with miracles humanity may never witness.}}',
    '{{i|Vibrant constellations line the ceilings in colors beyond perception. As gravity weaves, the planets waltz in a pure celestial dance of forces that will last far beyond the mortal race.}}',
    '{{i|Mother nature\'s firstborn children, the stars, blink past the shimmering veils of the night sky, waiting to be seen, known, and found.}}',
    '{{i|This is the universe at its finest, its veil, its costume.}}',
    '{{i|Welcome in, visitors, to the...}}'
  ].join('\n\n');
  var DEFAULT_OVERVIEW = [
    'Created by [@Harry & Co](/u/harryandco) and [@Bendan07](/u/Bendan), the creators of **Travel by the Starlight**, the Starlit Gallery contains **100 unique, hand-drawn, and black-and-white icons**, **5 texture variants,** and handful of **icon templates, a custom script logo, and a blank character token image** for you to use on your botc homebrew characters.',
    'Notably, you **do not** need to credit us when you use* our resources - however, a shout-out would be appreciated, since it helps promote the collection.\n{{i|*Please refrain from using our work for commercial products, though!}}',
    'So take a look, visitors, and experience the wonders of craft, of creativity, of human expression.',
    'Welcome once more to the... **Starlit Gallery.**'
  ].join('\n\n');
  // What the page's own HTML says, put back when the team clears a piece.
  var ORIGINAL = { intro: document.querySelector('.sg-by').innerHTML, synopsis: $('sg-synopsis').innerHTML, overview: $('sg-overview').innerHTML };
  var PAGE_BASE = 'starlit/page';

  function drawHeroMark() {
    if (!window.CreatorSymbols) return;
    var by = document.querySelector('.sg-by'), old = by.querySelector('.creator-mark');
    if (old) old.remove();
    var m = window.CreatorSymbols.markHTMLFor(ARTISTS);
    if (m) by.insertAdjacentHTML('beforeend', ' ' + m);
  }
  function drawPageText(page) {
    var W = window.WikiRender;
    document.querySelector('.sg-by').innerHTML = page && page.intro && W ? W.inlineFormat(page.intro) : ORIGINAL.intro;
    $('sg-synopsis').innerHTML = page && page.synopsis && W ? W.renderBody(page.synopsis) : ORIGINAL.synopsis;
    $('sg-overview').innerHTML = page && page.overview && W ? W.renderBody(page.overview) : ORIGINAL.overview;
    drawHeroMark();
    drawCredits(page);
  }
  /* The Credits section near the bottom: the team's text, or for the team
     alone a note saying where to write it. Readers see nothing until then. */
  function drawCredits(page) {
    var W = window.WikiRender, text = page && page.credits, team = gallery.canUpload && !PICK;
    $('sg-credits').hidden = !(text && W) && !team;
    $('sg-credits-body').innerHTML = text && W ? W.renderBody(text)
      : '<p class="sg-credits-empty">Nothing here yet. Write the credits in Settings, under "The gallery page". Only the team sees this note.</p>';
  }
  // What a theme added last time is taken off before the next is put on.
  var themed = { cls: [], props: [] };
  function applyTheme(theme) {
    var PR = window.PageRender;
    themed.cls.forEach(function (c) { document.body.classList.remove(c); });
    themed.props.forEach(function (k) { document.body.style.removeProperty(k); });
    themed = { cls: [], props: [] };
    ['page-custom-css', 'page-moves'].forEach(function (id) { var o = $(id); if (o) o.remove(); });
    var oldSt = document.querySelector('body > .pg-stickers'); if (oldSt) oldSt.remove();
    var t = theme && PR && PR.sanitizeTheme ? PR.sanitizeTheme(theme, PAGE_BASE) : null;
    if (!t) return;
    var ta = PR.themeAttrs(t);
    ta.cls.split(' ').forEach(function (c) {
      if (c && !document.body.classList.contains(c)) { document.body.classList.add(c); themed.cls.push(c); }
    });
    ta.style.split(';').forEach(function (decl) {
      var i = decl.indexOf(':');
      if (i > 0) { document.body.style.setProperty(decl.slice(0, i), decl.slice(i + 1)); themed.props.push(decl.slice(0, i)); }
    });
    (ta.fonts || []).forEach(function (href) {
      if (document.querySelector('link[href="' + href + '"]')) return;
      var l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = href;
      document.head.appendChild(l);
    });
    if (t.stickers && PR.stickersHTML) document.body.insertAdjacentHTML('beforeend', PR.stickersHTML(t.stickers));
    if (ta.movesCss) {
      var mv = document.createElement('style');
      mv.id = 'page-moves'; mv.textContent = ta.movesCss;
      document.head.appendChild(mv);
    }
    var css = t.css && window.CustomCSS ? window.CustomCSS.clean(t.css).css : '';
    if (css) {
      var st = document.createElement('style');
      st.id = 'page-custom-css'; st.textContent = css;
      document.head.appendChild(st);
      // Custom CSS reaches the hero and the gallery, nothing round them.
      var hero = document.querySelector('.home-hero'), main = $('content');
      if (!hero.parentNode.classList.contains('ucss')) {
        var frame = document.createElement('div'), inner = document.createElement('div');
        frame.className = 'ucss-frame'; inner.className = 'ucss';
        frame.appendChild(inner);
        hero.parentNode.insertBefore(frame, hero);
        inner.appendChild(hero); inner.appendChild(main);
      }
    }
  }
  function pageScripts(theme, editor) {
    var B = window.BotcData, list = [B.script('render-wiki.js')];
    if (theme || editor) list.push(B.script('render-page.js').then(function () {
      return Promise.all([B.script('custom-css.js'), editor ? B.script('theme-editor.js') : null]);
    }));
    if (editor) list.push(B.style('editor.css'));
    return Promise.all(list);
  }
  function showPage(page) {
    if (!page) { drawPageText(null); applyTheme(null); return Promise.resolve(); }
    return pageScripts(!!page.theme, false).then(function () {
      drawPageText(page);
      applyTheme(page.theme || null);
    });
  }

  // The editor, built the first time Settings opens it.
  var pe = null;
  function peDraft() {
    return { synopsis: $('sg-pe-synopsis').value.trim(), intro: $('sg-pe-intro').value.trim(),
      overview: $('sg-pe-overview').value.trim(), credits: $('sg-pe-credits').value.trim(), theme: pe.theme };
  }
  function pePreview() { drawPageText(peDraft()); }
  var PE_TEXT = ['sg-pe-synopsis', 'sg-pe-intro', 'sg-pe-overview', 'sg-pe-credits'];
  function colorRow(k, label, val) {
    return '<div class="th-row"><label for="th-' + k + '">' + label + '</label><span class="th-state" id="th-' + k + '-state">not set</span>' +
      '<input type="color" id="th-' + k + '" data-k="' + k + '" value="' + val + '"><button type="button" class="th-clear" data-k="' + k + '">reset</button></div>';
  }
  function openPageEditor() {
    if (pe) return;
    pe = { theme: JSON.parse(JSON.stringify((gallery.page && gallery.page.theme) || {})) };
    var page = gallery.page || {};
    pageScripts(true, true).then(function () {
      $('sg-page-body').innerHTML =
        '<label class="sg-f">Above the title<textarea id="sg-pe-synopsis" rows="9" maxlength="4000"></textarea></label>' +
        '<label class="sg-f">The line under the title<textarea id="sg-pe-intro" rows="3" maxlength="600"></textarea></label>' +
        '<label class="sg-f">Under that line, in smaller type<textarea id="sg-pe-overview" rows="10" maxlength="8000"></textarea></label>' +
        '<label class="sg-f">Credits, near the bottom of the page<textarea id="sg-pe-credits" rows="8" maxlength="8000"></textarea></label>' +
        '<p class="sg-hint">Marks: **bold**, {{i|italic}}, [a link](/u/harryandco), ## a heading, ### a smaller one, - a list. Leave a box empty to show nothing there. The page changes as you type; nothing is kept until you press Save.</p>' +
        '<h4>Look</h4>' +
        '<div class="sg-row"><span class="sg-label" style="flex-basis:100%">Page background</span>' +
        '<img id="sg-pe-bg" alt="" style="display:none;width:120px;height:68px;object-fit:cover;border:1px solid #cdbfa0">' +
        '<input type="file" id="sg-pe-bgfile" accept="image/png,image/jpeg,image/webp" hidden>' +
        '<button type="button" class="sg-btn" id="sg-pe-bgup">Upload background</button>' +
        '<button type="button" class="sg-link-btn" id="sg-pe-bgdel" hidden>Remove</button></div>' +
        '<label class="sg-f">Heading font <select id="th-font"></select></label>' +
        '<div class="sg-f">' + colorRow('accent', 'Accent', '#e8c66a') + colorRow('panel', 'Section boxes', '#f0e8d5') +
        colorRow('text', 'Text', '#ece1c8') + colorRow('link', 'Links', '#7fb2e6') + '</div>' +
        '<div id="th-more" data-kind="page"></div>' +
        '<div class="sg-actions"><button type="button" class="sg-btn sg-btn-green" id="sg-pe-save">Save the page</button>' +
        '<button type="button" class="sg-btn sg-btn-quiet" id="sg-pe-reset">Put back the original</button></div>' +
        '<p class="sg-msg" id="sg-pe-msg"></p>';
      $('sg-pe-synopsis').value = page.synopsis || DEFAULT_SYNOPSIS;
      $('sg-pe-intro').value = page.intro || DEFAULT_INTRO;
      $('sg-pe-overview').value = page.overview || DEFAULT_OVERVIEW;
      $('sg-pe-credits').value = page.credits || '';
      PE_TEXT.forEach(function (id) { $(id).addEventListener('input', pePreview); });
      window.ThemeEditor.wire({
        get: function () { return pe.theme; },
        set: function (t) { pe.theme = t || {}; },
        onChange: function (t) { applyTheme(t); },
        stickerBase: function () { return PAGE_BASE; },
        stickerMaxMB: 5,
        stickerUpload: function (n, dataUrl) {
          return api({ action: 'page-image', kind: 'st', n: n, data: dataUrl }).then(function (r) { return r.path; });
        }
      });
      window.ThemeEditor.prime(pe.theme);
      showBg();
      $('sg-pe-bgup').addEventListener('click', function () { $('sg-pe-bgfile').click(); });
      $('sg-pe-bgdel').addEventListener('click', function () {
        delete pe.theme.background; window.ThemeEditor.prime(pe.theme); applyTheme(pe.theme); showBg();
      });
      $('sg-pe-bgfile').addEventListener('change', function () {
        var f = this.files && this.files[0];
        this.value = '';
        if (!f) return;
        say('sg-pe-msg', 'Uploading the background…');
        var url = URL.createObjectURL(f);
        imageFrom(url).then(function (im) {
          URL.revokeObjectURL(url);
          // Screen-sized, as a creator page's background is.
          var k = Math.min(1, 2400 / Math.max(im.naturalWidth, 1));
          var c = canvas(Math.max(1, Math.round(im.naturalWidth * k)), Math.max(1, Math.round(im.naturalHeight * k)));
          c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
          return api({ action: 'page-image', kind: 'bg', data: c.toDataURL('image/jpeg', 0.85) });
        }).then(function (r) {
          pe.theme.background = r.path;
          window.ThemeEditor.prime(pe.theme); applyTheme(pe.theme); showBg();
          say('sg-pe-msg', 'Background uploaded. Save the page to keep it.');
        }).catch(function (e) { say('sg-pe-msg', e.message || 'That image could not be used.', true); });
      });
      $('sg-pe-save').addEventListener('click', function () {
        var btn = this, d = peDraft();
        // Unchanged from the original: nothing to store, the HTML says it.
        if (d.intro === DEFAULT_INTRO) d.intro = '';
        if (d.synopsis === DEFAULT_SYNOPSIS) d.synopsis = '';
        if (d.overview === DEFAULT_OVERVIEW) d.overview = '';
        btn.disabled = true;
        api({ action: 'page', page: d }).then(function (r) {
          gallery.page = r.page;
          say('sg-pe-msg', 'Saved. Everyone sees it now.');
        }).catch(function (e) { say('sg-pe-msg', e.message, true); })
          .then(function () { btn.disabled = false; });
      });
      $('sg-pe-reset').addEventListener('click', function () {
        if (!confirm('Put the page back as it was before the team changed it? Your text and look are cleared.')) return;
        api({ action: 'page', page: null }).then(function () {
          gallery.page = null;
          pe.theme = {};
          $('sg-pe-intro').value = DEFAULT_INTRO; $('sg-pe-synopsis').value = DEFAULT_SYNOPSIS; $('sg-pe-overview').value = DEFAULT_OVERVIEW; $('sg-pe-credits').value = '';
          window.ThemeEditor.prime(pe.theme);
          showPage(null); showBg();
          say('sg-pe-msg', 'The page is back to its original.');
        }).catch(function (e) { say('sg-pe-msg', e.message, true); });
      });
    }).catch(function () {
      pe = null;
      $('sg-page-body').innerHTML = '<p class="sg-msg err">The editor could not be loaded. Close this and open it again.</p>';
    });
  }
  function showBg() {
    var bg = pe && pe.theme.background;
    $('sg-pe-bg').style.display = bg ? '' : 'none';
    if (bg) $('sg-pe-bg').src = '/assets/' + bg + '?v=' + Date.now();
    $('sg-pe-bgdel').hidden = !bg;
  }
  $('sg-page-ed').addEventListener('toggle', function () { if (this.open) openPageEditor(); });

  /* ── start ────────────────────────────────────────────────────── */

  if (PICK) {
    $('sg-pick-head').hidden = false;
    $('sg-use').hidden = false;
    $('sg-download').hidden = true;
    $('sg-size').hidden = true;
  }
  if (window.CreatorSymbols) {
    drawHeroMark();
    window.CreatorSymbols.load().then(drawHeroMark);
  }

  // The whole gallery, from the server; again after a rename changes icons.
  function load() {
    return fetch('/api/starlit', { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function (d) {
        gallery = {
          icons: d.icons || [], textures: d.textures || [], files: d.files || [], page: d.page || null,
          canUpload: !!d.canUpload, isAdmin: !!d.isAdmin, uploaders: d.uploaders || []
        };
        rebuildTextures(); drawTags(); drawGrid(); drawTeam();
      });
  }
  load().then(function () {
    var want = new URLSearchParams(location.search).get('icon');
    if (want) openIcon(byId(want));
    if (gallery.page && !PICK) showPage(gallery.page).catch(function () { /* the page's own text stays */ });
  }).catch(function () { $('sg-count').textContent = 'The gallery could not be loaded. Refresh the page to try again.'; });
})();
