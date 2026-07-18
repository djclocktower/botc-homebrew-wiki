/* Script Studio — Phase 1: the renderer.
 *
 * Draws a print-ready illustrated script sheet (the "No Greater Joy" style)
 * on a Konva stage: parchment + purple night bars + botanical chrome, team
 * sections with colored headers/dividers, character cells (icon, name,
 * centered ability), auto-computed first-night / other-nights columns, a
 * gradient Dumbledor title and the *NOT THE FIRST NIGHT footnote.
 *
 * The scene is data: a JSON document (see buildScriptDoc/buildDemoDoc) of
 * ordered layers {id, type: image|text|rect, x, y, w, h, ...}. The renderer
 * only draws documents, so the Phase 2 editor can mutate them and re-render.
 * Layout is a pure function script -> document; template.json carries the
 * canvas geometry extracted from the design PSD.
 *
 * Phase 1 scope: no editing. Sources: the built-in demo sheet, the Script
 * Builder working set (localStorage), and published wiki scripts. PNG export.
 */
(function () {
  'use strict';

  if (typeof Konva === 'undefined') {
    var m = document.getElementById('ss-msg');
    if (m) { m.className = 'ss-msg err'; m.textContent = 'Could not load the drawing engine (konva.min.js). Try a hard refresh.'; }
    return;
  }

  var BASE = 'assets/script-studio/';
  var CANVAS_W = 1500, CANVAS_H = 2100;

  // Content region between the purple bars, and the vertical band the team
  // sections may occupy (below the title block, above the footnote).
  var X0 = 108, X1 = 1394;
  var SECT_Y0 = 480, SECT_Y1 = 2030;

  var TEAM_ORDER = ['townsfolk', 'outsider', 'minion', 'demon', 'traveller', 'fabled'];
  var TEAM_LABEL = {
    townsfolk: 'TOWNSFOLK', outsider: 'OUTSIDERS', minion: 'MINIONS',
    demon: 'DEMON', traveller: 'TRAVELLERS', fabled: 'FABLED'
  };
  // traveller/fabled aren't in the PSD palette; colors follow the official look
  var EXTRA_COLORS = { traveller: '#6C2CA7', fabled: '#A8871F' };

  var FONT = {
    title: 'Dumbledor2',
    heading: 'OptimusPrinceps',
    headingBold: 'OptimusPrincepsSemiBold',
    ability: 'TradeGothicLT'
  };

  var $ = function (id) { return document.getElementById(id); };

  var tpl = null;               // template.json
  var stage, sheetLayer;
  var currentDoc = null;
  var currentName = 'script';
  var charIndex = null;         // slug -> character (lazy, from live characters.json)
  var scriptsCache = null;

  /* ── messages ─────────────────────────────────────────────── */
  function msg(kind, text) {
    var el = $('ss-msg');
    if (!el) return;
    if (!text) { el.className = 'ss-msg'; el.textContent = ''; return; }
    el.className = 'ss-msg ' + kind;
    el.textContent = text;
  }

  /* ── asset loading ────────────────────────────────────────── */
  var IMG_CACHE = {};
  function loadImage(src) {
    if (!src) return Promise.resolve(null);
    if (IMG_CACHE[src]) return IMG_CACHE[src];
    IMG_CACHE[src] = new Promise(function (resolve) {
      var im = new Image();
      // absolute URLs: request CORS-clean so a fallback fetched from another
      // origin can never taint the canvas and kill PNG export
      if (/^https?:\/\//.test(src)) im.crossOrigin = 'anonymous';
      im.onload = function () { resolve(im); };
      im.onerror = function () { resolve(null); };
      im.src = src;
    });
    return IMG_CACHE[src];
  }

  function loadFonts() {
    if (!document.fonts || typeof FontFace === 'undefined') return Promise.resolve();
    var defs = [
      [FONT.heading, 'assets/fonts/OptimusPrinceps.ttf'],
      [FONT.headingBold, 'assets/fonts/OptimusPrincepsSemiBold.ttf'],
      [FONT.title, 'assets/fonts/dumbledor2.ttf'],
      [FONT.ability, 'assets/fonts/trade-gothic-lt-std.otf']
    ];
    return Promise.all(defs.map(function (d) {
      var ff = new FontFace(d[0], 'url(' + d[1] + ')');
      return ff.load().then(function (f) { document.fonts.add(f); }).catch(function () {});
    }));
  }

  /* ── text style resolution ────────────────────────────────── */
  // Mirrors template.json's textStyles, resolved to real font families.
  function textStyle(name, scale) {
    var s = scale || 1;
    switch (name) {
      case 'teamHeader': return { fontFamily: FONT.headingBold, fontSize: 42 * s, letterSpacing: 0.84 * s, fill: '#000' };
      case 'charName': return { fontFamily: FONT.heading, fontSize: 30 * s, align: 'center', fill: '#000' };
      case 'charNameBig': return { fontFamily: FONT.heading, fontSize: 40 * s, align: 'center', fill: '#000' };
      case 'ability': return { fontFamily: FONT.ability, fontSize: 22 * s, lineHeight: 1.25, align: 'center', fill: '#000' };
      case 'nightLabel': return { fontFamily: FONT.heading, fontSize: 17, align: 'center', fill: '#fff', lineHeight: 1.15 };
      case 'footnote': return { fontFamily: FONT.headingBold, fontSize: 28 * s, align: 'right', fill: '#000' };
      default: return { fontFamily: FONT.ability, fontSize: 22 * s, fill: '#000' };
    }
  }

  // Credit marks some character names carry in D1 (∇, ♊︎) — stripped on
  // print artifacts only, same as the Token Tool does.
  function cleanName(name) {
    return String(name || '').replace(/[∇♊︎️]/g, '').replace(/\s+/g, ' ').trim();
  }

  function artSrcs(ch) {
    var out = [];
    if (ch.art) out.push('assets/' + ch.art);
    out.push('assets/art/' + ch.slug + '.png');
    if (ch.image && /^https?:\/\//.test(ch.image)) out.push(ch.image);
    return out;
  }

  /* ── document -> Konva ────────────────────────────────────── */
  function makeTextNode(L) {
    var st = L.style || {};
    var cfg = {
      x: L.x, y: L.y, text: L.text,
      fontFamily: st.fontFamily || FONT.ability,
      fontSize: st.fontSize || 22,
      fill: st.fill || '#000',
      align: st.align || 'left',
      lineHeight: st.lineHeight || 1,
      letterSpacing: st.letterSpacing || 0,
      opacity: L.opacity != null ? L.opacity : 1,
      rotation: L.rotation || 0,
      listening: false,
      name: L.id || ''
    };
    if (L.w) cfg.width = L.w;
    var t = new Konva.Text(cfg);
    if (st.gradient) {
      // Dumbledor title treatment: vertical purple gradient + dark edge +
      // offset shadow standing in for the PSD's bevel.
      t.fillPriority('linear-gradient');
      t.fillLinearGradientStartPoint({ x: 0, y: 0 });
      t.fillLinearGradientEndPoint({ x: 0, y: Math.max(1, t.height()) });
      t.fillLinearGradientColorStops([0, '#dcb8f2', 0.45, '#8a3fb8', 1, '#41135c']);
      t.stroke('#2a0b3d');
      t.strokeWidth(Math.max(1.5, (st.fontSize || 60) * 0.022));
      t.shadowColor('#1c0526');
      t.shadowOffset({ x: 3, y: 5 });
      t.shadowBlur(2);
      t.shadowOpacity(0.5);
    }
    return t;
  }

  function containRect(im, box) {
    var iw = im.naturalWidth || im.width, ih = im.naturalHeight || im.height;
    if (!iw || !ih) return box;
    var k = Math.min(box.w / iw, box.h / ih);
    var w = iw * k, h = ih * k;
    return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w: w, h: h };
  }

  // Try each source in turn, resolving with the first image that loads.
  // Fallbacks (e.g. an external image URL) are only ever fetched if the
  // sources before them actually fail.
  function loadFirstImage(srcs) {
    if (!srcs.length) return Promise.resolve(null);
    return loadImage(srcs[0]).then(function (im) {
      return im || loadFirstImage(srcs.slice(1));
    });
  }

  function renderDoc(doc) {
    var jobs = doc.layers.map(function (L) {
      if (L.type !== 'image' || L.visible === false) return Promise.resolve(null);
      return loadFirstImage([L.src].concat(L.srcAlts || []));
    });
    return Promise.all(jobs).then(function (loaded) {
      sheetLayer.destroyChildren();
      doc.layers.forEach(function (L, li) {
        if (L.visible === false) return;
        if (L.type === 'image') {
          var im = loaded[li];
          if (!im) return; // missing art hides gracefully
          var r = { x: L.x, y: L.y, w: L.w, h: L.h };
          if (L.fit === 'contain') r = containRect(im, r);
          var cfg = {
            image: im, x: r.x, y: r.y, width: r.w, height: r.h,
            opacity: L.opacity != null ? L.opacity : 1,
            rotation: L.rotation || 0, listening: false, name: L.id || ''
          };
          if (L.blend) cfg.globalCompositeOperation = L.blend;
          sheetLayer.add(new Konva.Image(cfg));
        } else if (L.type === 'text') {
          sheetLayer.add(makeTextNode(L));
        } else if (L.type === 'rect') {
          sheetLayer.add(new Konva.Rect({
            x: L.x, y: L.y, width: L.w, height: L.h, fill: L.fill || '#000',
            opacity: L.opacity != null ? L.opacity : 1, listening: false, name: L.id || ''
          }));
        }
      });
      sheetLayer.batchDraw();
    });
  }

  /* ── measurement helpers ──────────────────────────────────── */
  // Widest single word at a given style — Konva breaks words that exceed the
  // wrap width mid-word, so sizes must be chosen where every word fits.
  function widestWord(text, style) {
    var max = 0;
    String(text).split(/\s+/).forEach(function (w) {
      if (!w) return;
      var m = measureText(w, style);
      if (m.w > max) max = m.w;
    });
    return max;
  }

  function measureText(text, style, width) {
    var cfg = {
      text: text,
      fontFamily: style.fontFamily, fontSize: style.fontSize,
      lineHeight: style.lineHeight || 1, letterSpacing: style.letterSpacing || 0
    };
    if (width) cfg.width = width;
    var t = new Konva.Text(cfg);
    var out = { w: width ? width : t.getTextWidth(), h: t.height() };
    t.destroy();
    return out;
  }

  /* ── demo document (exact PSD coordinates) ────────────────── */
  function buildDemoDoc() {
    var d = tpl.demo;
    var layers = [];
    tpl.chrome.forEach(function (c) {
      layers.push(chromeLayer(c));
    });
    layers.push(nightLabelLayer('left'), nightLabelLayer('right'));
    layers.push(chromeLayer(d.title, 'title'));
    tpl.teamSections.forEach(function (sec) {
      var h = sec.header;
      layers.push({
        id: h.id, type: 'text', text: h.text, x: h.x, y: h.y, w: h.w + 60,
        style: assign(textStyle('teamHeader'), { fill: h.color, align: sec.columns === 1 ? 'center' : 'left' })
      });
    });
    d.characters.forEach(function (ch) {
      layers.push({ id: ch.icon.id, type: 'image', src: BASE + ch.icon.src, x: ch.icon.x, y: ch.icon.y, w: ch.icon.w, h: ch.icon.h, fit: 'contain' });
      layers.push({ id: ch.name.id, type: 'text', text: ch.name.text, x: ch.name.x, y: ch.name.y, w: ch.name.w, style: textStyle(ch.name.style) });
      layers.push({ id: ch.ability.id, type: 'text', text: ch.ability.text, x: ch.ability.x, y: ch.ability.y, w: ch.ability.w, style: textStyle(ch.ability.style) });
    });
    ['left', 'right'].forEach(function (side) {
      var geom = tpl.nightColumns[side];
      var ids = d.nightOrder[side].filter(function (id) { return id.indexOf('night-mini-') === 0; });
      ids.forEach(function (id, i) {
        layers.push({
          id: id, type: 'image', src: BASE + 'demo/' + id + '.png',
          x: geom.x, y: geom.startY + geom.gapY * (i + 1),
          w: geom.iconSize, h: geom.iconSize, fit: 'contain'
        });
      });
    });
    var f = d.footnote;
    layers.push({ id: f.id, type: 'text', text: f.text, x: f.x, y: f.y, w: f.w, style: textStyle(f.style) });
    return { version: 1, canvas: { w: CANVAS_W, h: CANVAS_H }, meta: { name: d.scriptName, source: 'demo' }, layers: layers };
  }

  function nightLabelLayer(side) {
    var geom = tpl.nightColumns[side];
    var b = geom.labelBox; // [x0, y0, x1, y1]
    return {
      id: 'night-label-' + side, type: 'text',
      text: geom.label.replace(' ', '\n'),
      x: b[0], y: b[1], w: b[2] - b[0],
      style: textStyle('nightLabel'), chrome: true
    };
  }

  function assign(a, b) {
    for (var k in b) if (Object.prototype.hasOwnProperty.call(b, k)) a[k] = b[k];
    return a;
  }

  /* ── auto-layout: script -> document ──────────────────────── */
  function chromeById(id) {
    for (var i = 0; i < tpl.chrome.length; i++) if (tpl.chrome[i].id === id) return tpl.chrome[i];
    return null;
  }

  // template.json entry -> image layer, carrying opacity/blend through
  function chromeLayer(c, id) {
    var L = { id: id || c.id, type: 'image', src: BASE + c.src, x: c.x, y: c.y, w: c.w, h: c.h, chrome: true };
    if (c.opacity != null) L.opacity = c.opacity;
    if (c.blend) L.blend = c.blend;
    if (c.visible === false) L.visible = false;
    return L;
  }

  function teamColor(team) {
    return tpl.palette[team] || EXTRA_COLORS[team] || '#000';
  }

  function buildScriptDoc(meta, list) {
    var byTeam = {};
    list.forEach(function (c) {
      var t = TEAM_ORDER.indexOf(c.team) !== -1 ? c.team : 'townsfolk';
      (byTeam[t] = byTeam[t] || []).push(c);
    });

    // Largest global scale whose sections fit the vertical budget — big
    // scripts compress toward the floor; below it we keep the floor and warn
    // (multi-page and roomy Teensyville density modes arrive in Phase 3).
    var scales = [1, 0.94, 0.88, 0.82, 0.76, 0.7, 0.64, 0.58];
    var sections = null, overflow = false;
    for (var i = 0; i < scales.length; i++) {
      sections = layoutSections(byTeam, scales[i]);
      if (sections.bottom <= SECT_Y1) break;
    }
    if (sections.bottom > SECT_Y1) overflow = true;

    var layers = [];
    ['bg-parchment', 'bar-left', 'bar-right',
     'botanical-top-left', 'botanical-top-right', 'botanical-bottom-left',
     'botanical-bottom-right', 'botanical-berries-left', 'clock'
    ].forEach(function (id) {
      var c = chromeById(id);
      if (c) layers.push(chromeLayer(c));
    });

    layers = layers.concat(buildTitleLayers(meta.name || 'Untitled Script'));
    layers = layers.concat(buildNightColumn('left', 'firstNight', list));
    layers = layers.concat(buildNightColumn('right', 'otherNight', list));
    layers = layers.concat(sections.layers);

    var hasStar = list.some(function (c) { return /\*/.test(c.ability || ''); });
    if (hasStar) {
      layers.push({
        id: 'footnote', type: 'text', text: '*NOT THE FIRST NIGHT',
        x: X1 - 520, y: 2046, w: 520, style: textStyle('footnote')
      });
    }

    return {
      version: 1, canvas: { w: CANVAS_W, h: CANVAS_H },
      meta: { name: meta.name || 'Untitled Script', author: meta.author || '', source: meta.source || '' },
      overflow: overflow,
      layers: layers
    };
  }

  function layoutSections(byTeam, s) {
    var layers = [];
    var y = SECT_Y0;
    TEAM_ORDER.forEach(function (team) {
      var chars = byTeam[team];
      if (!chars || !chars.length) return;

      var cols = team === 'townsfolk' ? 3 : team === 'demon' ? (chars.length > 1 ? 2 : 1) : 2;
      if (chars.length < cols && team !== 'demon') cols = Math.max(1, chars.length);
      var color = teamColor(team);
      var label = TEAM_LABEL[team] + (team === 'demon' && chars.length > 1 ? 'S' : '');
      var hStyle = assign(textStyle('teamHeader', s), { fill: color });

      var centered = team === 'demon' && cols === 1;
      if (centered) {
        // The demon section centers its header over a full-width divider
        // (the PSD's DEMON treatment).
        var hh = measureText(label, hStyle).h;
        layers.push({ id: 'hdr-' + team, type: 'text', text: label, x: X0, y: y, w: X1 - X0, style: assign(hStyle, { align: 'center' }) });
        y += hh + 10 * s;
        layers.push({ id: 'div-' + team, type: 'rect', x: 97, y: y, w: 1306, h: 6, fill: color });
        y += 18 * s;
      } else {
        var hw = measureText(label, hStyle).w;
        var hh2 = measureText(label, hStyle).h;
        layers.push({ id: 'hdr-' + team, type: 'text', text: label, x: X0, y: y, style: hStyle });
        layers.push({ id: 'div-' + team, type: 'rect', x: X0 + hw + 20, y: y + hh2 * 0.52, w: X1 - (X0 + hw + 20), h: 5, fill: color });
        y += hh2 + 16 * s;
      }

      var inset = centered ? 100 * s : 0;
      var cx0 = X0 + inset, cx1 = X1 - inset;
      var colW = (cx1 - cx0) / cols;
      var iconSize = (cols >= 3 ? 172 : cols === 2 ? 238 : 265) * s;
      var nameStyle = textStyle(cols >= 3 ? 'charName' : 'charNameBig', s);
      var abStyle = textStyle('ability', s);

      for (var r = 0; r < chars.length; r += cols) {
        var row = chars.slice(r, r + cols);
        // pass 1: measure every cell in the row
        var cells = row.map(function (ch) {
          var textW = colW - iconSize - 30 * s;
          var nm = cleanName(ch.name).toUpperCase();
          // long names shrink until their widest word fits the cell
          var nSt = assign({}, nameStyle);
          while (nSt.fontSize > 16 && widestWord(nm, nSt) > textW) nSt.fontSize -= 2;
          var nameH = measureText(nm, nSt, textW).h;
          var abH = ch.ability ? measureText(ch.ability, abStyle, textW).h : 0;
          var textH = nameH + 6 * s + abH;
          return { ch: ch, nm: nm, nameStyle: nSt, textW: textW, nameH: nameH, abH: abH, cellH: Math.max(iconSize, textH), textH: textH };
        });
        var rowH = Math.max.apply(null, cells.map(function (c) { return c.cellH; }));
        // pass 2: place, vertically centered in the row
        cells.forEach(function (cell, ci) {
          var cellX = cx0 + ci * colW;
          var iconY = y + (rowH - iconSize) / 2;
          var textX = cellX + iconSize + 12 * s;
          var textY = y + (rowH - cell.textH) / 2;
          var slug = cell.ch.slug;
          var srcs = artSrcs(cell.ch);
          layers.push({
            id: 'icon-' + slug, type: 'image', src: srcs[0], srcAlts: srcs.slice(1),
            x: cellX, y: iconY, w: iconSize, h: iconSize, fit: 'contain'
          });
          layers.push({ id: 'name-' + slug, type: 'text', text: cell.nm, x: textX, y: textY, w: cell.textW, style: cell.nameStyle });
          if (cell.ch.ability) {
            layers.push({ id: 'ability-' + slug, type: 'text', text: cell.ch.ability, x: textX, y: textY + cell.nameH + 6 * s, w: cell.textW, style: abStyle });
          }
        });
        y += rowH + 20 * s;
      }
      y += 12 * s;
    });
    return { layers: layers, bottom: y };
  }

  function buildTitleLayers(name) {
    // Title sits left of the clock chrome, like the PSD. Pick the biggest
    // Dumbledor size whose wrapped title fits the zone.
    var zone = { x: 385, w: 450, yTop: 50, hMax: 390 };
    var size = 150, h = 0;
    var sizes = [150, 135, 120, 108, 96, 85, 75, 66, 58, 50, 42];
    for (var i = 0; i < sizes.length; i++) {
      size = sizes[i];
      var st = { fontFamily: FONT.title, fontSize: size, lineHeight: 0.98 };
      h = measureText(name, st, zone.w).h;
      if (h <= zone.hMax && widestWord(name, st) <= zone.w) break;
    }
    return [{
      id: 'title', type: 'text', text: name,
      x: zone.x, y: zone.yTop + Math.max(0, (zone.hMax - h) / 2), w: zone.w,
      style: { fontFamily: FONT.title, fontSize: size, lineHeight: 0.98, align: 'center', gradient: true }
    }];
  }

  function buildNightColumn(side, field, list) {
    var geom = tpl.nightColumns[side];
    var layers = [nightLabelLayer(side)];
    var moon = chromeById('night-moon-' + side);
    var entries = list.filter(function (c) { return Number(c[field]) > 0; })
      .sort(function (a, b) { return Number(a[field]) - Number(b[field]); });

    if (moon) layers.push({ id: moon.id, type: 'image', src: BASE + moon.src, x: moon.x, y: geom.startY, w: moon.w, h: moon.h, chrome: true });

    // moon in slot 0, minis in slots 1..n, gold dawn sun in slot n+1;
    // the step compresses below the design's 82px when the column is full
    var n = entries.length;
    var step = Math.min(geom.gapY, (2040 - geom.iconSize - geom.startY) / (n + 1));
    entries.forEach(function (c, i) {
      var srcs = artSrcs(c);
      layers.push({
        id: 'night-' + side + '-' + c.slug, type: 'image', src: srcs[0], srcAlts: srcs.slice(1),
        x: geom.x, y: geom.startY + step * (i + 1),
        w: geom.iconSize, h: geom.iconSize, fit: 'contain'
      });
    });
    layers.push({
      id: 'night-sun-' + side, type: 'image',
      src: BASE + 'template/night-sun-glyph-' + side + '.png',
      x: geom.x, y: geom.startY + step * (n + 1),
      w: geom.iconSize, h: geom.iconSize, fit: 'contain', chrome: true
    });
    return layers;
  }

  /* ── stage ────────────────────────────────────────────────── */
  function fitStage() {
    var holder = $('ss-stage-holder');
    var w = holder.clientWidth;
    if (!w) return;
    var k = w / CANVAS_W;
    stage.width(w);
    stage.height(Math.round(CANVAS_H * k));
    stage.scale({ x: k, y: k });
    stage.batchDraw();
  }

  /* ── data sources ─────────────────────────────────────────── */
  function getCharIndex() {
    if (charIndex) return Promise.resolve(charIndex);
    return fetch('characters.json?_=' + Date.now())
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (arr) {
        charIndex = {};
        arr.forEach(function (c) { if (c && c.slug) charIndex[c.slug] = c; });
        return charIndex;
      });
  }

  function resolveSlugs(slugs) {
    return getCharIndex().then(function (idx) {
      var found = [], missing = [];
      slugs.forEach(function (sl) {
        if (idx[sl]) found.push(idx[sl]); else missing.push(sl);
      });
      return { chars: found, missing: missing };
    });
  }

  function showDoc(doc) {
    currentDoc = doc;
    currentName = doc.meta.name || 'script';
    var nameOut = $('ss-current');
    if (nameOut) nameOut.textContent = doc.meta.name + (doc.meta.source === 'demo' ? ' (demo)' : '');
    return renderDoc(doc).then(function () {
      if (doc.overflow) {
        msg('warn', 'This script is too big for one sheet — it’s been compacted as far as Phase 1 allows. Multi-page sheets arrive in Phase 3.');
      }
    });
  }

  function setActiveSource(btnId) {
    ['ss-src-demo', 'ss-src-builder'].forEach(function (id) {
      var b = $(id);
      if (b) b.classList.toggle('on', id === btnId);
    });
    var sel = $('ss-src-published');
    if (sel && btnId !== 'ss-src-published') sel.value = '';
  }

  function loadDemo() {
    msg();
    setActiveSource('ss-src-demo');
    return showDoc(buildDemoDoc());
  }

  function loadBuilderSet() {
    msg();
    var slugs = [];
    var meta = {};
    try { slugs = JSON.parse(localStorage.getItem('botc_script')) || []; } catch (e) {}
    try { meta = JSON.parse(localStorage.getItem('botc_script_meta')) || {}; } catch (e) {}
    if (!slugs.length) {
      msg('err', 'Your Script Builder set is empty. Add characters on the Script Builder page first.');
      return Promise.resolve();
    }
    setActiveSource('ss-src-builder');
    msg('info', 'Building sheet…');
    return resolveSlugs(slugs).then(function (r) {
      var doc = buildScriptDoc({ name: meta.name || 'My Script', author: meta.author || '', source: 'builder' }, r.chars);
      return showDoc(doc).then(function () {
        if (r.missing.length) msg('warn', 'Skipped ' + r.missing.length + ' character(s) not on the wiki: ' + r.missing.join(', '));
        else if (!doc.overflow) msg();
      });
    }).catch(function (e) {
      msg('err', 'Could not load characters: ' + e.message);
    });
  }

  function loadPublished(slug) {
    msg();
    var find = scriptsCache ? Promise.resolve(scriptsCache)
      : fetch('scripts.json?_=' + Date.now()).then(function (r) { return r.json(); }).then(function (arr) { scriptsCache = arr; return arr; });
    msg('info', 'Building sheet…');
    return find.then(function (arr) {
      var sc = null;
      arr.forEach(function (s) { if (s.slug === slug) sc = s; });
      if (!sc) throw new Error('script not found');
      setActiveSource('ss-src-published');
      return resolveSlugs(sc.characters || []).then(function (r) {
        var doc = buildScriptDoc({ name: sc.name, author: sc.author || '', source: 'published' }, r.chars);
        return showDoc(doc).then(function () {
          if (r.missing.length) msg('warn', 'Skipped ' + r.missing.length + ' character(s): ' + r.missing.join(', '));
          else if (!doc.overflow) msg();
        });
      });
    }).catch(function (e) {
      msg('err', 'Could not load that script: ' + e.message);
    });
  }

  function populatePublished() {
    fetch('scripts.json?_=' + Date.now())
      .then(function (r) { return r.json(); })
      .then(function (arr) {
        scriptsCache = arr;
        var sel = $('ss-src-published');
        if (!sel || !arr.length) return;
        arr.forEach(function (s) {
          var o = document.createElement('option');
          o.value = s.slug;
          o.textContent = s.name + (s.author ? ' — ' + s.author : '');
          sel.appendChild(o);
        });
      })
      .catch(function () {});
  }

  function updateBuilderCount() {
    var n = 0;
    try { n = (JSON.parse(localStorage.getItem('botc_script')) || []).length; } catch (e) {}
    var el = $('ss-builder-count');
    if (el) el.textContent = n ? '(' + n + ')' : '(empty)';
  }

  /* ── export ───────────────────────────────────────────────── */
  function slugify(s) {
    return String(s || 'script').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'script';
  }

  function exportPNG() {
    if (!currentDoc) return;
    var mult = 2;
    var seg = $('ss-export-scale');
    if (seg) {
      var on = seg.querySelector('button[aria-pressed="true"]');
      if (on) mult = Number(on.getAttribute('data-v')) || 2;
    }
    msg('info', 'Rendering PNG…');
    // pixelRatio is relative to the on-screen stage scale; normalize so the
    // export is exactly CANVAS_W * mult pixels wide regardless of screen size.
    setTimeout(function () {
      try {
        var url = stage.toDataURL({ pixelRatio: mult / stage.scaleX(), mimeType: 'image/png' });
        var a = document.createElement('a');
        a.href = url;
        a.download = slugify(currentName) + '-sheet-' + mult + 'x.png';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        msg('ok', 'PNG exported at ' + (CANVAS_W * mult) + '×' + (CANVAS_H * mult) + '.');
      } catch (e) {
        msg('err', 'Export failed — this device may not handle a canvas that large. Try a smaller size.');
      }
    }, 30);
  }

  /* ── init ─────────────────────────────────────────────────── */
  function init() {
    var holder = $('ss-stage-holder');
    stage = new Konva.Stage({ container: holder, width: 300, height: 420, listening: false });
    sheetLayer = new Konva.Layer({ listening: false });
    stage.add(sheetLayer);

    Promise.all([
      fetch(BASE + 'template.json').then(function (r) {
        if (!r.ok) throw new Error('template.json HTTP ' + r.status);
        return r.json();
      }),
      loadFonts()
    ]).then(function (res) {
      tpl = res[0];
      var load = $('ss-load');
      if (load) load.classList.add('done');
      fitStage();
      loadDemo();
    }).catch(function (e) {
      var load = $('ss-load');
      if (load) load.classList.add('done');
      msg('err', 'Could not start Script Studio: ' + e.message);
    });

    window.addEventListener('resize', fitStage);

    if ($('ss-src-demo')) $('ss-src-demo').addEventListener('click', loadDemo);
    if ($('ss-src-builder')) $('ss-src-builder').addEventListener('click', loadBuilderSet);
    var sel = $('ss-src-published');
    if (sel) sel.addEventListener('change', function () { if (sel.value) loadPublished(sel.value); });
    var seg = $('ss-export-scale');
    if (seg) {
      seg.addEventListener('click', function (ev) {
        var b = ev.target.closest('button');
        if (!b) return;
        seg.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
      });
    }
    if ($('ss-export')) $('ss-export').addEventListener('click', exportPNG);

    populatePublished();
    updateBuilderCount();
  }

  // Public surface for Phase 2 (editor) to build on.
  window.ScriptStudio = {
    get stage() { return stage; },
    get doc() { return currentDoc; },
    renderDoc: renderDoc,
    buildScriptDoc: buildScriptDoc,
    buildDemoDoc: buildDemoDoc
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
