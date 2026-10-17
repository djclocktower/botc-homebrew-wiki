/* char-snapshot.js — the "Snapshot" button on the two character editors.
 *
 * One picture of the whole almanac entry: the title, the parchment panel with
 * Summary / How to Run / Examples / Tips, and the sidebar with the art, the
 * information box, a QR square pointing at the page and the jinxes. It is the
 * page as a poster — the thing people paste into Discord, print for a table or
 * post next to a script.
 *
 *   CharSnapshot.open(d, {artSrc, pageUrl, siteRoot})   // preview + copy/share/download
 *   CharSnapshot.render(d, opts) -> Promise<canvas>     // just the canvas
 *
 * `d` is exactly what the editors' gather() returns — the same object the live
 * preview is painted from — so the snapshot cannot describe a character the
 * preview does not.
 *
 * Drawn on a CANVAS rather than screenshotted from the preview frame: there is
 * no way to turn a live DOM into an image in a browser without either a
 * library or an <img src="data:…svg+xml"> foreignObject, and the second one
 * silently drops self-hosted fonts and any image it cannot inline. So the
 * layout is written out here in the wiki's own measurements, in "units" of a
 * 1360-wide poster, and the whole thing is scaled up once when it is drawn.
 *
 * Three rules worth keeping:
 *
 *  1. **The marks come through render-wiki.js, never from a second parser.**
 *     Every prose field is formatted by the same call the page makes
 *     (inlineFormat, links mode) and the resulting HTML is walked into styled
 *     runs by htmlRuns(). A mark added to the engine works here for free, and
 *     the asterisk convention ("Each night*") stays safe because the mode is
 *     the page's mode.
 *  2. **Nothing foreign is drawn without CORS.** One image the browser refuses
 *     to let us read back taints the canvas and the whole poster becomes
 *     un-exportable — so a picture on another host is fetched with
 *     crossOrigin and simply left out when that fails. Official jinx icons
 *     therefore prefer the committed assets/icons/ copy over the CDN's.
 *  3. **The poster is not the page.** A jinx dropdown, a JSON box you can open
 *     and the Curata wreath are all interface; a still image gets the jinx
 *     card, a QR square and the almanac. Everything a reader would actually
 *     read is here, including the callout and the custom sidebar boxes.
 *
 * Browser only (canvas, DOM). Styles live in styles.css under .snap-*.
 * Needs assets/qr.js for the square; without it the poster simply has no QR.
 */
(function (global) {
  'use strict';

  var doc = global.document;

  /* ── the poster, in layout units ──────────────────────────────────────
     1360 wide, which puts the left column at about the width the real page
     gives it on a desktop, so the type sizes below are the page's own. */
  var W = 1360;
  var MARGIN = 26;
  var COL_GAP = 28;
  var LEFT_W = 850;
  var RIGHT_W = W - MARGIN * 2 - COL_GAP - LEFT_W;
  var PANEL_PAD_X = 34, PANEL_PAD_Y = 30, BORDER = 4;
  var CARD_PAD_X = 20, CARD_PAD_Y = 18;
  var RIGHT_TOP = 58;          // the sidebar starts above the parchment panel
  var TITLE_MAX = 168, TITLE_MIN = 30;
  var CARD_GAP = 24;
  /* How many device pixels the export is allowed. A phone's canvas is capped
     (Safari refuses much past 16 million), and a character with a long tips
     list can run to 4000 units tall, so the scale is chosen to fit rather than
     fixed — a short page gets the full 2x, a very long one a little less. */
  var MAX_PIXELS = 9e6;
  var SCALE_MAX = 2;
  // "Large": up to 3x, within the 16.7 million pixels a phone's canvas allows.
  var LARGE_PIXELS = 16e6, LARGE_SCALE = 3;
  // "Small": the longest side, about what Discord shows before you click it.
  var SMALL_SIDE = 1600;

  var C = {
    parch: '#F0E8D5', frame: '#bda89a',
    exBg: '#ded3cd', exFrame: '#bcae93',
    maroon: '#5B1F21', ink: '#000',
    good: '#2C7BD0', goodName: '#2f6fb8', evil: '#9A0D12',
    outsider: '#1a6a80', minion: '#b5441a', fabled: '#8f6d1a', loric: '#2f6b3f',
    rule: '#b79c6f', purple: '#1a0820',
    hair: 'rgba(180,160,120,.45)',
    quiet: '#8a7a62', pronounce: '#6b5d49'
  };
  var FAM = {
    body: '"TradeGothicLT","Libre Franklin",-apple-system,sans-serif',
    display: '"Dumbledor2",serif',
    quote: '"Noto Serif",Georgia,serif',
    name: '"Roboto",sans-serif',
    mono: 'ui-monospace,Menlo,Consolas,monospace'
  };

  // render.js's, which both editors load before this file.
  var TEAM_LABEL = global.TEAM_LABEL || {};

  /* The colour marks, by the class render-wiki.js puts on them — the same
     colours as .wiki-* in styles.css. 'traveller' is the half-blue,
     half-red split, drawn as a gradient in drawLines(). */
  var MARK_COLOR = {
    'wiki-red': C.evil, 'wiki-blue': C.good, 'wiki-townsfolk': C.good,
    'wiki-demon': C.evil, 'wiki-outsider': C.outsider, 'wiki-minion': C.minion,
    'wiki-fabled': C.fabled, 'wiki-loric': C.loric, 'wiki-traveller': 'traveller'
  };
  // The Related ribbons' left edge, as .rel-* in styles.css.
  var RIBBON = { good: C.good, evil: C.evil, fabled: '#b8952a', loric: '#3a7a4a',
                 page: '#cdb488', ext: '#ffffff', traveller: 'traveller' };

  /* The two flourishes the page draws inside an example box and a callout,
     lifted from styles.css so the poster's ornaments are the page's ornaments.
     Built as data URIs: an SVG with no external reference never taints. */
  var ORN_EX = svgURI("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 64' fill='none' stroke='#5B1F21' stroke-width='1.3' stroke-linecap='round'><path d='M16 3 C16 20 16 44 16 61'/><path d='M16 12 C10 12 6 9 5 4 C11 5 15 8 16 12'/><path d='M16 12 C22 12 26 9 27 4 C21 5 17 8 16 12'/><path d='M16 30 C8 30 4 25 3 18 C11 20 15 24 16 30'/><path d='M16 30 C24 30 28 25 29 18 C21 20 17 24 16 30'/><path d='M16 49 C10 49 7 45 6 40 C12 42 15 45 16 49'/><path d='M16 49 C22 49 25 45 26 40 C20 42 17 45 16 49'/><circle cx='16' cy='3' r='1.6' fill='#5B1F21'/><circle cx='16' cy='61' r='1.6' fill='#5B1F21'/></svg>");
  var ORN_CALL = svgURI("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='#5B1F21' stroke-width='1.3'><path d='M12 4c0 3-2 4-4 4 2 0 4 1 4 4 0-3 2-4 4-4-2 0-4-1-4-4Z'/><path d='M6 12c0 2-1.3 2.6-2.6 2.6 1.3 0 2.6.7 2.6 2.6 0-1.9 1.3-2.6 2.6-2.6-1.3 0-2.6-.7-2.6-2.6Z'/><path d='M18 12c0 2-1.3 2.6-2.6 2.6 1.3 0 2.6.7 2.6 2.6 0-1.9 1.3-2.6 2.6-2.6-1.3 0-2.6-.7-2.6-2.6Z'/></svg>");

  function svgURI(svg) {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function assign(a, b) {
    var out = {};
    for (var k in a) if (Object.prototype.hasOwnProperty.call(a, k)) out[k] = a[k];
    for (var j in b) if (Object.prototype.hasOwnProperty.call(b, j) && b[j] !== undefined) out[j] = b[j];
    return out;
  }
  function list(v) {
    return (Array.isArray(v) ? v : []).filter(function (x) { return x && String(x).trim(); });
  }

  /* ── fonts ──
     The wiki's faces are self-hosted and Google-hosted; canvas will silently
     fall back to a system serif for any that has not actually been fetched
     yet, so ask for each one first. A face that never arrives just draws in
     its fallback, exactly as the page would. */
  var FONT_PROBES = [
    '400 100px "Dumbledor2"', '400 17px "TradeGothicLT"', '700 17px "TradeGothicLT"',
    'italic 400 20px "Noto Serif"', '600 17px "Roboto"'
  ];
  function ensureFonts() {
    var fonts = doc && doc.fonts;
    if (!fonts || !fonts.load) return Promise.resolve();
    return Promise.all(FONT_PROBES.map(function (f) {
      try { return fonts.load(f, 'Aa'); } catch (e) { return null; }
    })).then(null, function () { return null; }).then(function () { return null; });
  }

  /* ── images ── */
  function foreign(src) {
    if (/^(data:|blob:)/i.test(src)) return false;
    if (!/^https?:/i.test(src)) return false;
    try { return new URL(src, location.href).origin !== location.origin; }
    catch (e) { return true; }
  }
  function loadImage(src) {
    return new Promise(function (resolve) {
      if (!src) { resolve(null); return; }
      var img = new Image();
      if (foreign(src)) img.crossOrigin = 'anonymous';
      img.onload = function () { resolve(img); };
      img.onerror = function () { resolve(null); };
      img.src = src;
    });
  }
  // The first source that loads, in order of preference.
  function loadFirst(srcs) {
    var i = 0;
    function next() {
      if (i >= srcs.length) return Promise.resolve(null);
      return loadImage(srcs[i++]).then(function (img) { return img || next(); });
    }
    return next();
  }

  /* ── the wiki's inline marks, as styled runs ──
     render-wiki.js formats the text (through render.js's own two doors, so the
     mode matches the page), and this walks the HTML it produced. Every mark
     the engine can emit is either given a style here or ignored; nothing is
     parsed twice. */
  function inlineHTML(text, mode) {
    var W2 = global.WikiRender;
    var s = String(text == null ? '' : text);
    if (!W2 || !W2.inlineFormat) return esc(s);
    return W2.inlineFormat(s, mode === 'full' ? {} : { marks: 'links' });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function htmlRuns(html) {
    var host = doc.createElement('div');
    host.innerHTML = String(html == null ? '' : html);
    var out = [];
    (function walk(node, st) {
      for (var n = node.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) {
          if (n.nodeValue) out.push(assign(st, { text: n.nodeValue }));
          continue;
        }
        if (n.nodeType !== 1) continue;
        var tag = n.tagName;
        if (tag === 'BR') { out.push({ text: '\n' }); continue; }
        if (tag === 'IMG') continue;          // an inline picture has no place here
        var next = {
          bold: st.bold || tag === 'STRONG' || tag === 'B',
          italic: st.italic || tag === 'EM' || tag === 'I',
          strike: st.strike || tag === 'S' || tag === 'DEL' || tag === 'STRIKE',
          mono: st.mono || tag === 'CODE',
          under: st.under, color: st.color, token: st.token, drop: st.drop
        };
        // The colour marks win over a link inside them, exactly as
        // `.wiki-red a { color: inherit !important }` does on the page.
        for (var k = 0; k < n.classList.length; k++) {
          var c = n.classList[k];
          if (MARK_COLOR[c]) { next.color = MARK_COLOR[c]; next.bold = true; }
          else if (c === 'tok') next.token = true;
          else if (c === 'dropcap') next.drop = true;
        }
        if (tag === 'A') { next.under = true; if (!next.color) next.color = C.goodName; }
        walk(n, next);
      }
    })(host, {});
    return out;
  }
  function textRuns(text) { return [{ text: String(text == null ? '' : text) }]; }
  function marked(text, mode) { return htmlRuns(inlineHTML(text, mode)); }

  /* ── laying text out ──────────────────────────────────────────────────
     A style is {size, family, weight, italic, color, align, lh, spacing};
     a run may override the weight, the slant, the colour or make the piece a
     reminder-token pill. Measured and drawn with the same strings, so what is
     measured is what appears. */
  function fontFor(sty, run) {
    run = run || {};
    // A drop cap is drawn the way the page draws one inside a list or a box:
    // a big initial on the line, not a float (a float is a layout engine).
    if (run.drop) return '400 ' + (sty.size * 1.5) + 'px ' + FAM.display;
    var fam = run.token ? FAM.name : run.mono ? FAM.mono : (sty.family || FAM.body);
    var weight = run.token ? 600 : (run.bold || sty.bold) ? 700 : (sty.weight || 400);
    return ((run.italic || sty.italic) ? 'italic ' : '') + weight + ' ' + sty.size + 'px ' + fam;
  }
  function setSpacing(ctx, sty) { ctx.letterSpacing = (sty && sty.spacing) || '0px'; }

  function splitLong(ctx, word, maxW) {
    var parts = [], buf = '';
    for (var i = 0; i < word.length; i++) {
      if (buf && ctx.measureText(buf + word[i]).width > maxW) { parts.push(buf); buf = word[i]; }
      else buf += word[i];
    }
    if (buf) parts.push(buf);
    return parts;
  }

  function layout(ctx, runs, maxW, sty) {
    setSpacing(ctx, sty);
    var lines = [], cur = [], curW = 0;
    var pad = 0;
    function flush() {
      while (cur.length && cur[cur.length - 1].text === ' ') { curW -= cur[cur.length - 1].w; cur.pop(); }
      lines.push({ items: cur, w: curW });
      cur = []; curW = 0;
    }
    function put(text, w, run, font) {
      if (curW + w > maxW && cur.length) flush();
      cur.push({ text: text, w: w, run: run, font: font });
      curW += w;
    }
    runs.forEach(function (run) {
      var font = fontFor(sty, run);
      ctx.font = font;
      pad = run.token ? sty.size * 0.3 : 0;
      String(run.text).split('\n').forEach(function (chunk, ci) {
        if (ci) flush();
        chunk.split(/(\s+)/).forEach(function (piece) {
          if (!piece) return;
          ctx.font = font;
          if (/^\s+$/.test(piece)) {
            if (!cur.length) return;
            var sw = ctx.measureText(' ').width;
            cur.push({ text: ' ', w: sw, run: run, font: font });
            curW += sw;
            return;
          }
          var w = ctx.measureText(piece).width + pad * 2;
          if (w <= maxW) { put(piece, w, run, font); return; }
          // One token wider than the column (a bare URL, usually): break it.
          splitLong(ctx, piece, maxW - pad * 2).forEach(function (part) {
            put(part, ctx.measureText(part).width + pad * 2, run, font);
          });
        });
      });
    });
    flush();
    ctx.letterSpacing = '0px';
    var lh = sty.size * (sty.lh || 1.4);
    return { lines: lines, lh: lh, sty: sty, width: maxW, height: lines.length * lh };
  }

  function drawLines(ctx, laid, x, y) {
    var sty = laid.sty;
    var ascent = sty.size * (sty.ascent || 0.78);
    setSpacing(ctx, sty);
    ctx.textBaseline = 'alphabetic';
    laid.lines.forEach(function (line, i) {
      var lx = x;
      if (sty.align === 'center') lx = x + (laid.width - line.w) / 2;
      else if (sty.align === 'right') lx = x + laid.width - line.w;
      var by = y + i * laid.lh + ascent;
      line.items.forEach(function (it) {
        var run = it.run || {};
        ctx.font = it.font;
        if (run.token) {
          var pad = sty.size * 0.3;
          ctx.fillStyle = 'rgba(91,31,33,.10)';
          ctx.fillRect(lx, by - ascent, it.w, sty.size * 1.18);
          ctx.fillStyle = C.maroon;
          ctx.fillText(it.text, lx + pad, by);
        } else {
          ctx.fillStyle = paint(ctx, run.drop && !run.color ? C.maroon : (run.color || sty.color || C.ink),
            by - ascent, by + sty.size * 0.22);
          ctx.fillText(it.text, lx, by);
          if (run.under) {
            ctx.fillRect(lx, by + Math.max(1, sty.size * 0.09), it.w, Math.max(1, sty.size * 0.05));
          }
          if (run.strike && it.text !== ' ') {
            ctx.fillRect(lx, by - sty.size * 0.28, it.w, Math.max(1, sty.size * 0.05));
          }
        }
        lx += it.w;
      });
    });
    ctx.letterSpacing = '0px';
  }

  // A colour, or the traveller's split: blue over red across the line's glyphs.
  function paint(ctx, color, top, bottom) {
    if (color !== 'traveller') return color;
    var g = ctx.createLinearGradient(0, top, 0, bottom);
    g.addColorStop(0, C.good); g.addColorStop(0.5, C.good);
    g.addColorStop(0.5, C.evil); g.addColorStop(1, C.evil);
    return g;
  }

  /* ── blocks ──
     Everything on the poster is {h, draw(ctx, x, y)}: measured once against a
     width, then painted at whatever y it ends up at. */
  function blk(h, draw) { return { h: h, draw: draw || function () {} }; }
  function stack(items, gap) {
    items = items.filter(Boolean);
    gap = gap || 0;
    var h = 0;
    items.forEach(function (b, i) { h += b.h + (i ? gap : 0); });
    return blk(h, function (ctx, x, y) {
      var at = y;
      items.forEach(function (b, i) { if (i) at += gap; b.draw(ctx, x, at); at += b.h; });
    });
  }
  function spacer(h) { return blk(h); }

  function para(ctx, runs, width, sty) {
    sty = assign({ size: 17, lh: 1.42, family: FAM.body, color: C.ink }, sty);
    var laid = layout(ctx, runs, width, sty);
    return blk(laid.height, function (c, x, y) { drawLines(c, laid, x, y); });
  }

  var BULLET_GAP = 8.5;                    // li margin-bottom: .85em, minus leading
  function bulletItems(ctx, items, width, sty) {
    sty = assign({ size: 17, lh: 1.42, family: FAM.body, color: C.ink }, sty);
    var indent = sty.size * 1.1;
    return items.map(function (t) {
      var l = layout(ctx, marked(t), width - indent, sty);
      return blk(l.height, function (c, x, y) {
        c.font = fontFor(sty, { bold: true });
        c.fillStyle = C.evil;
        c.textBaseline = 'alphabetic';
        c.fillText('•', x, y + sty.size * (sty.ascent || 0.78));
        drawLines(c, l, x + indent, y);
      });
    });
  }
  function bullets(ctx, items, width, sty) {
    return stack(bulletItems(ctx, items, width, sty), BULLET_GAP);
  }

  /* Items in two columns, read down the left and then the right, split where
     the two come out closest in height. Used under the sidebar, where a
     single column across the whole poster would be a line far too long. */
  var COLS_GAP = 34;
  function twoCols(items, colW, gap) {
    if (items.length < 2) return stack(items, gap);
    var best = 1, bestH = Infinity;
    for (var s = 1; s < items.length; s++) {
      var h = Math.max(stack(items.slice(0, s), gap).h, stack(items.slice(s), gap).h);
      if (h < bestH) { bestH = h; best = s; }
    }
    var a = stack(items.slice(0, best), gap), b = stack(items.slice(best), gap);
    return blk(bestH, function (c, x, y) { a.draw(c, x, y); b.draw(c, x + colW + COLS_GAP, y); });
  }

  /* A section heading: the wiki's display face, uppercase, with a hairline
     rule under it — the almanac's own furniture. */
  function heading(ctx, text, width, opts) {
    opts = opts || {};
    var size = opts.size || 30;
    var sty = { size: size, family: FAM.display, color: C.maroon, align: 'center',
                lh: 1.05, ascent: 0.76, spacing: (size * 0.04).toFixed(2) + 'px' };
    var laid = layout(ctx, textRuns(String(text).toUpperCase()), width, sty);
    var ruleGap = 7, ruleH = 1, after = opts.after == null ? 14 : opts.after;
    return blk(laid.height + ruleGap + ruleH + after, function (c, x, y) {
      drawLines(c, laid, x, y);
      var tw = Math.min(width, Math.max(laid.lines[0] ? laid.lines[0].w * 1.5 : width, 120));
      var rx = x + (width - tw) / 2;
      var ry = y + laid.height + ruleGap;
      var g = c.createLinearGradient(rx, ry, rx + tw, ry);
      g.addColorStop(0, 'rgba(183,156,111,0)');
      g.addColorStop(0.5, C.rule);
      g.addColorStop(1, 'rgba(183,156,111,0)');
      c.fillStyle = g;
      c.fillRect(rx, ry, tw, ruleH);
    });
  }

  function hairline(width, opts) {
    opts = opts || {};
    var above = opts.above || 0, below = opts.below || 0;
    return blk(above + 1 + below, function (c, x, y) {
      c.fillStyle = opts.color || C.frame;
      c.fillRect(x, y + above, width, 1);
    });
  }

  /* ── panels, cards and pictures ── */
  function drawCover(ctx, img, x, y, w, h, anchorTop) {
    var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;
    var s = Math.max(w / iw, h / ih);
    var dw = iw * s, dh = ih * s;
    ctx.drawImage(img, x + (w - dw) / 2, anchorTop ? y : y + (h - dh) / 2, dw, dh);
  }
  function drawPanel(ctx, x, y, w, h, art) {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.45)';
    ctx.shadowBlur = 26;
    ctx.shadowOffsetY = 10;
    ctx.fillStyle = C.parch;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
    if (art) {
      ctx.save();
      ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
      drawCover(ctx, art, x, y, w, h);
      ctx.restore();
    }
    ctx.lineWidth = BORDER;
    ctx.strokeStyle = C.frame;
    ctx.strokeRect(x + BORDER / 2, y + BORDER / 2, w - BORDER, h - BORDER);
  }
  // A card is a panel that measures itself around its contents.
  function card(inner, width, art, padY) {
    padY = padY == null ? CARD_PAD_Y : padY;
    var h = inner.h + padY * 2 + BORDER * 2;
    return blk(h, function (ctx, x, y) {
      drawPanel(ctx, x, y, width, h, art);
      inner.draw(ctx, x + BORDER + CARD_PAD_X, y + BORDER + padY);
    });
  }
  function cardInnerWidth(width) { return width - BORDER * 2 - CARD_PAD_X * 2; }

  function ornament(ctx, img, x, y, w, h, alpha, flip) {
    if (!img) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (flip) { ctx.translate(x + w, y); ctx.scale(-1, 1); ctx.drawImage(img, 0, 0, w, h); }
    else ctx.drawImage(img, x, y, w, h);
    ctx.restore();
  }

  /* An example box: the page's framed panel, inset rules and all. */
  function exampleBox(ctx, text, width, assets) {
    var boxW = Math.min(width, 760);
    var padX = 54, padY = 20;
    var sty = { size: 18.5, lh: 1.4, align: 'center', color: C.ink };
    var laid = layout(ctx, marked(text), boxW - padX * 2, sty);
    var h = laid.height + padY * 2;
    return blk(h, function (c, x, y) {
      var bx = x + (width - boxW) / 2;
      c.fillStyle = C.exBg;
      c.fillRect(bx, y, boxW, h);
      // border 2px, then the three inset rules the page draws inside it
      inset(c, bx, y, boxW, h, [[0, 2, C.exFrame], [2, 2, 'rgba(255,255,255,.5)'],
        [4, 2, C.exFrame], [6, 2, 'rgba(255,255,255,.2)']]);
      ornament(c, assets.ornEx, bx + 12, y + h / 2 - 26, 26, 52, 0.55, false);
      ornament(c, assets.ornEx, bx + boxW - 38, y + h / 2 - 26, 26, 52, 0.55, true);
      drawLines(c, laid, bx + padX, y + padY);
    });
  }
  // Concentric rules drawn inward from the edge: [inset, thickness, colour].
  function inset(ctx, x, y, w, h, rings) {
    rings.forEach(function (r) {
      ctx.lineWidth = r[1];
      ctx.strokeStyle = r[2];
      ctx.strokeRect(x + r[0] + r[1] / 2, y + r[0] + r[1] / 2, w - (r[0] + r[1] / 2) * 2, h - (r[0] + r[1] / 2) * 2);
    });
  }

  function calloutBox(ctx, text, width, assets) {
    var padX = 44, padY = 14;
    var sty = { size: 17, lh: 1.45, align: 'center', italic: true, color: C.ink };
    var laid = layout(ctx, marked(text), width - padX * 2, sty);
    var h = laid.height + padY * 2;
    return blk(h, function (c, x, y) {
      c.fillStyle = C.exBg;
      c.fillRect(x, y, width, h);
      inset(c, x, y, width, h, [[0, 1, C.exFrame], [1, 3, 'rgba(255,255,255,.4)']]);
      ornament(c, assets.ornCall, x + 12, y + h / 2 - 10, 20, 20, 0.45, false);
      ornament(c, assets.ornCall, x + width - 32, y + h / 2 - 10, 20, 20, 0.45, true);
      drawLines(c, laid, x + padX, y + padY);
    });
  }

  /* The Related ribbons: a coloured edge, the icon, the name and the note —
     .rel-card on the page. Who each one points at was settled in
     gatherAssets() through render.js's resolveRelatedTarget(), the page's
     own answer, so a character's live name and team win over the stored one. */
  function relatedBlock(ctx, d, assets, width) {
    var rows = assets.related;
    if (!rows.length) return null;
    var edge = 6, ico = 44, pad = 10, padL = 17;
    var parts = [heading(ctx, 'Related', width, { after: 12 })];
    rows.forEach(function (r, i) {
      if (i) parts.push(spacer(9));
      var img = r.icon;
      var textX = padL + (img ? ico + pad : 0);
      var textW = width - textX - 12;
      var color = r.t.ribbon === 'good' ? C.goodName : r.t.ribbon === 'evil' ? C.evil : C.maroon;
      var name = layout(ctx, textRuns(r.t.name + (r.t.external ? ' ↗' : '')), textW,
        { size: 17, family: FAM.name, weight: 600, lh: 1.2, color: color });
      var note = r.note ? layout(ctx, marked(r.note, 'full'), textW,
        { size: 16, family: '"EB Garamond",Georgia,serif', italic: true, lh: 1.28, color: C.ink }) : null;
      var textH = name.height + (note ? note.height + 2 : 0);
      var h = Math.max(img ? ico : 0, textH) + 18;
      parts.push(blk(h, function (c, x, y) {
        c.fillStyle = 'rgba(255,252,244,.55)';
        c.fillRect(x, y, width, h);
        c.lineWidth = 1;
        c.strokeStyle = '#d7c9ab';
        c.strokeRect(x + 0.5, y + 0.5, width - 1, h - 1);
        c.fillStyle = paint(c, RIBBON[r.t.ribbon] || RIBBON.page, y, y + h);
        c.fillRect(x, y, edge, h);
        if (img) fitInto(c, img, x + padL, y + 9, ico, ico);
        drawLines(c, name, x + textX, y + 9);
        if (note) drawLines(c, note, x + textX, y + 9 + name.height + 2);
      }));
    });
    return stack(parts);
  }

  /* ── the left-hand parchment ── */
  /* The parchment as SECTIONS, each of which can be laid out in either of two
     places: beside the sidebar (the page's own column), or under it across
     the whole poster (`wide`), where its items flow in two columns. compose()
     decides where the cut goes. Each section carries the rule that separates
     it from the one before; the first in a panel draws none. */
  function parchmentSections(ctx, d, assets) {
    var bulletLines = list(d.summaryBullets);
    var howLines = list(d.howToRun);
    var examples = list(d.examples);
    // A list since How to Run grew several notes; old rows hold one string.
    var callouts = (Array.isArray(d.callout) ? d.callout : [d.callout])
      .filter(function (x) { return typeof x === 'string' && x.trim(); });
    var secs = [];
    function colWidth(inner) { return Math.floor((inner - COLS_GAP) / 2); }

    if (d.ability || d.lede || bulletLines.length || assets.related.length || howLines.length || callouts.length) {
      secs.push({ sep: function () { return []; }, build: function (inner) {
        var colW = colWidth(inner);
        var related = relatedBlock(ctx, d, assets, colW);
        var summary = [];
        if (d.ability || d.lede || bulletLines.length || related) {
          summary.push(heading(ctx, 'Summary', colW, { after: 12 }));
          // The ability stays escaped, exactly as it is on the page: it is the
          // character's rule, not writing about the character.
          if (d.ability) summary.push(para(ctx, textRuns(d.ability), colW,
            { size: 18, bold: true, lh: 1.34 }));
          if (d.ability && (d.lede || bulletLines.length)) summary.push(spacer(12));
          if (d.lede) summary.push(para(ctx, marked(d.lede), colW, {}));
          if (d.lede && bulletLines.length) summary.push(spacer(11));
          if (bulletLines.length) summary.push(bullets(ctx, bulletLines, colW, {}));
          // The Related ribbons close the summary column, as on the page.
          if (related) { if (summary.length > 1) summary.push(spacer(20)); summary.push(related); }
        }
        var how = [];
        if (howLines.length || callouts.length) {
          how.push(heading(ctx, 'How to Run', colW, { after: 12 }));
          howLines.forEach(function (p, i) {
            if (i) how.push(spacer(11));
            how.push(para(ctx, marked(p), colW, {}));
          });
          callouts.forEach(function (c, i) {
            if (howLines.length || i) how.push(spacer(16));
            how.push(calloutBox(ctx, c, colW, assets));
          });
        }
        var left = stack(summary), right = stack(how);
        return [blk(Math.max(left.h, right.h) + 16, function (c, x, y) {
          if (summary.length) left.draw(c, x, y);
          if (how.length) right.draw(c, x + colW + COLS_GAP, y);
        })];
      } });
    }

    if (examples.length) {
      secs.push({ sep: function (inner) { return [hairline(inner, { below: 18 })]; },
        build: function (inner, wide) {
          var w = wide ? colWidth(inner) : inner;
          var boxes = examples.map(function (e) { return exampleBox(ctx, e, w, assets); });
          return [heading(ctx, 'Examples', inner), wide ? twoCols(boxes, w, 16) : stack(boxes, 16)];
        } });
    }

    var charName = (d.name || 'Character').trim();
    [['Tips & Tricks', d.tips], ['Bluffing as the ' + charName, d.bluffing],
     ['Fighting the ' + charName, d.fighting]].forEach(function (s) {
      var items = list(s[1]);
      if (!items.length) return;
      secs.push({ sep: function (inner) { return [spacer(24), hairline(inner, { below: 14 })]; },
        build: function (inner, wide) {
          var w = wide ? colWidth(inner) : inner;
          var li = bulletItems(ctx, items, w, {});
          return [heading(ctx, s[0], inner), wide ? twoCols(li, w, BULLET_GAP) : stack(li, BULLET_GAP)];
        } });
    });
    return secs;
  }

  // Some sections laid into one parchment panel `width` wide.
  function parchmentPanel(secs, width, wide, assets) {
    var inner = width - BORDER * 2 - PANEL_PAD_X * 2;
    var blocks = [];
    secs.forEach(function (s, i) {
      if (i) blocks = blocks.concat(s.sep(inner));
      blocks = blocks.concat(s.build(inner, wide));
    });
    var body = stack(blocks);
    var h = body.h + (PANEL_PAD_Y + BORDER) * 2;
    return blk(h, function (ctx2, x, y) {
      drawPanel(ctx2, x, y, width, h, assets.parchment);
      body.draw(ctx2, x + BORDER + PANEL_PAD_X, y + BORDER + PANEL_PAD_Y);
    });
  }

  /* ── the sidebar ── */
  function infoRows(d, opts) {
    var rows = [];
    var team = d.team || 'townsfolk';
    rows.push(['Type:', textRuns(TEAM_LABEL[team] || team)]);
    var creators = global.splitCreators ? global.splitCreators(d.creator)
      : String(d.creator || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (creators.length) {
      rows.push([creators.length > 1 ? 'Creators:' : 'Creator:', textRuns(creators.join(', '))]);
    }
    var appears = (d.appearsIn || '').trim();
    if (!appears && Array.isArray(d.appearsInFrom)) {
      appears = d.appearsInFrom.map(function (c) { return c && c.name; }).filter(Boolean).join(', ');
    }
    if (appears) rows.push(['Appears in:', textRuns(appears)]);
    var tags = String(d.tags || '').split(',').map(function (t) { return t.trim(); })
      .filter(Boolean).map(function (t) {
        return t.toLowerCase().replace(/(^|[\s\-\/])[a-z]/g, function (m) { return m.toUpperCase(); });
      });
    if (tags.length) rows.push(['Tags:', textRuns(tags.join(', '))]);
    if (d.translatedBy && d.translatedBy.trim()) rows.push(['Translated by:', marked(d.translatedBy.trim(), 'full')]);
    if (d.iconBy && d.iconBy.trim()) rows.push(['Icon by:', marked(d.iconBy.trim(), 'full')]);
    return rows;
  }

  function infoCard(ctx, d, assets, width, opts) {
    var inner = cardInnerWidth(width);
    var parts = [];

    if (assets.art) {
      var aw = Math.min(inner * 0.86, 286);
      var ah = aw;
      parts.push(blk(ah + 10, function (c, x, y) {
        c.save();
        c.shadowColor = 'rgba(120,20,20,.25)';
        c.shadowBlur = 10; c.shadowOffsetY = 5;
        fitInto(c, assets.art, x + (inner - aw) / 2, y + 4, aw, ah);
        c.restore();
      }));
    }

    var quote = String(d.quote || d.flavor || '').replace(/^["']|["']$/g, '').trim();
    if (quote) {
      parts.push(para(ctx, marked('“' + quote + '”'), inner - 12, {
        size: 20, family: FAM.quote, italic: true, align: 'center', lh: 1.32
      }));
      parts.push(spacer(14));
    }

    var pron = pronounceBlock(ctx, d, inner);
    if (pron) { parts.push(pron); parts.push(spacer(12)); }

    if (opts.hide && opts.hide.info) return parts.length ? card(stack(parts), width, assets.parchment) : null;
    if (parts.length) parts.push(hairline(inner, { above: 12, below: 12, color: C.hair }));
    parts.push(para(ctx, textRuns('Information'), inner, {
      size: 20, bold: true, align: 'center', spacing: '0.4px'
    }));
    parts.push(spacer(14));

    var rows = infoRows(d, opts);
    var labelW = 96, rowGap = 8;
    var valueW = inner - labelW - rowGap;
    rows.forEach(function (r, i) {
      var lab = layout(ctx, textRuns(r[0]), labelW, { size: 17, bold: true, color: C.ink, lh: 1.32 });
      var val = layout(ctx, r[1], valueW, { size: 17, color: C.ink, lh: 1.32 });
      var h = Math.max(lab.height, val.height);
      parts.push(blk(h, function (c, x, y) {
        drawLines(c, lab, x, y);
        drawLines(c, val, x + labelW + rowGap, y);
      }));
      if (i < rows.length - 1) parts.push(spacer(rowGap));
    });

    return card(stack(parts), width, assets.parchment);
  }

  function pronounceBlock(ctx, d, inner) {
    var free = String(d.pronunciation || '').trim();
    var ipa = String(d.ipa || '').trim();
    var respell = String(d.respelling || '').trim();
    if (!free && !ipa && !respell) return null;
    var parts = [para(ctx, textRuns('PRONUNCIATION'), inner, {
      size: 12, bold: true, align: 'center', color: C.quiet, spacing: '1.1px'
    })];
    if (free) parts.push(para(ctx, marked(free, 'full'), inner, {
      size: 16, family: FAM.quote, align: 'center', color: C.pronounce, lh: 1.3
    }));
    if (ipa) parts.push(para(ctx, textRuns(ipa), inner, {
      size: 16, align: 'center', color: '#7a6c56', lh: 1.3
    }));
    if (respell) parts.push(para(ctx, textRuns(respell), inner, {
      size: 14, align: 'center', color: C.quiet, spacing: '0.8px', lh: 1.3
    }));
    return stack(parts, 3);
  }

  // Draw an image inside a box, keeping its aspect ratio (object-fit: contain).
  function fitInto(ctx, img, x, y, w, h) {
    var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;
    var s = Math.min(w / iw, h / ih);
    ctx.drawImage(img, x + (w - iw * s) / 2, y + (h - ih * s) / 2, iw * s, ih * s);
  }

  function qrCard(ctx, url, width, assets) {
    if (!url || !global.QR || !global.QR.matrix) return null;
    var q = global.QR.matrix(url);
    if (!q) return null;
    var inner = cardInnerWidth(width);
    // Painted at one device pixel per module and scaled up with smoothing off,
    // so the squares stay square whatever the poster's scale works out to.
    var quiet = 4, side = q.size + quiet * 2;
    var bits = doc.createElement('canvas');
    bits.width = bits.height = side;
    var bctx = bits.getContext('2d');
    bctx.fillStyle = '#ffffff';
    bctx.fillRect(0, 0, side, side);
    bctx.fillStyle = '#141014';
    for (var r = 0; r < q.size; r++) {
      for (var c = 0; c < q.size; c++) {
        if (q.modules[r][c]) bctx.fillRect(quiet + c, quiet + r, 1, 1);
      }
    }
    var draw = Math.min(inner, 246);
    var shown = url.replace(/^https?:\/\/(www\.)?/i, '');
    var parts = [
      heading(ctx, 'Wiki Link', inner, { after: 10 }),
      blk(draw, function (c, x, y) {
        var px = x + (inner - draw) / 2;
        c.save();
        c.imageSmoothingEnabled = false;
        c.drawImage(bits, px, y, draw, draw);
        c.restore();
        c.lineWidth = 1;
        c.strokeStyle = C.frame;
        c.strokeRect(px + 0.5, y + 0.5, draw - 1, draw - 1);
      }),
      spacer(8),
      para(ctx, textRuns(shown), inner, { size: 14, align: 'center', color: C.quiet, lh: 1.3 })
    ];
    return card(stack(parts), width, assets.parchment);
  }

  function jinxCard(ctx, jinxes, width, assets) {
    if (!jinxes.length) return null;
    var inner = cardInnerWidth(width);
    var ico = 48, gap = 12, rowPad = 9;
    var parts = [heading(ctx, 'Jinxes', inner, { after: 12 })];
    jinxes.forEach(function (j, i) {
      if (i) parts.push(hairline(inner, { above: rowPad, below: rowPad, color: C.hair }));
      var img = assets.jinxIcons[i];
      var textW = inner - (img ? ico + gap : 0);
      // The almanac prints the rule, not the pairing — the icon says who it is
      // with. A jinx nobody has written a rule for falls back to the name so
      // the row is never a bare picture.
      var body = (j.text || j.reason || '').trim();
      var laid = body
        ? layout(ctx, marked(body, 'full'), textW, { size: 17, family: FAM.quote, italic: true, lh: 1.3, color: C.ink })
        : layout(ctx, textRuns(j.name || ''), textW, { size: 17, family: FAM.name, weight: 600, lh: 1.3,
            color: j.align === 'evil' ? C.evil : C.good });
      var h = Math.max(img ? ico : 0, laid.height);
      parts.push(blk(h, function (c, x, y) {
        if (img) fitInto(c, img, x, y, ico, ico);
        drawLines(c, laid, x + (img ? ico + gap : 0), y + Math.max(0, (h - laid.height) / 2));
      }));
    });
    return card(stack(parts), width, assets.parchment);
  }

  function customBoxCards(ctx, boxes, width, assets) {
    var inner = cardInnerWidth(width);
    return boxes.map(function (b) {
      var title = String((b && b.title) || '').trim();
      var content = String((b && b.content) || '');
      if (!title && !content.trim()) return null;
      var parts = [];
      if (title) parts.push(heading(ctx, title, inner, { after: 12 }));
      content.split(/\n{2,}/).forEach(function (p, i) {
        if (!p.trim()) return;
        if (i) parts.push(spacer(10));
        parts.push(para(ctx, marked(p.replace(/\s+$/, '')), inner, { size: 17, lh: 1.4 }));
      });
      if (!parts.length) return null;
      return card(stack(parts), width, assets.parchment);
    }).filter(Boolean);
  }

  /* ── the title ──
     Fitted to the left column the way fitCharTitle does on the page: one line
     if it can, two if the name is long enough that one line would be small. */
  function titleBlock(ctx, name, width) {
    var text = String(name || 'Unnamed').toUpperCase();
    var sty = { size: 100, family: FAM.display, color: C.parch, lh: 0.98,
                ascent: 0.74, spacing: '4px' };
    setSpacing(ctx, sty);
    ctx.font = fontFor(sty, null);
    var w100 = ctx.measureText(text).width || 1;
    ctx.letterSpacing = '0px';
    var size = Math.min(TITLE_MAX, (width * 100) / w100);
    var lines = 1;
    if (size < 62 && /\s/.test(text)) { lines = 2; size = Math.min(96, size * 1.85); }
    size = Math.max(TITLE_MIN, size);
    sty = assign(sty, { size: size, spacing: (size * 0.04).toFixed(2) + 'px' });
    var laid = layout(ctx, textRuns(text), width, sty);
    // Shrink until it really does fit the intended number of lines.
    var guard = 0;
    while (laid.lines.length > lines && guard++ < 12) {
      sty = assign(sty, { size: sty.size * 0.9, spacing: (sty.size * 0.9 * 0.04).toFixed(2) + 'px' });
      laid = layout(ctx, textRuns(text), width, sty);
    }
    return blk(laid.height, function (c, x, y) {
      c.save();
      c.shadowColor = 'rgba(0,0,0,.7)';
      c.shadowBlur = 18;
      c.shadowOffsetY = 4;
      drawLines(c, laid, x, y);
      c.restore();
    });
  }

  /* ── what the poster needs fetched before it can be measured ── */
  function gatherAssets(d, opts) {
    var root = opts.siteRoot || '';
    var jinxes = (d.jinxes || []).filter(function (j) { return j && (j.name || j.id || j.slug); });
    var iconJobs = jinxes.map(function (j) {
      var t = global.resolveJinxTarget ? global.resolveJinxTarget(j, root) : null;
      var id = String(j.id || (global.slugId ? global.slugId(j.name || '') : ''))
        .replace(/_festival_of_lanterns$/, '').replace(/-/g, '');
      return loadFirst(officialIcons(t, id, root));
    });
    var related = (Array.isArray(d.related) ? d.related : []).map(function (r) {
      var t = r && global.resolveRelatedTarget ? global.resolveRelatedTarget(r, root) : null;
      return t && t.name ? { t: t, note: String(r.note || '').trim(),
        id: r.type === 'official' && global.slugId ? global.slugId(r.id || r.name || '') : '' } : null;
    }).filter(Boolean);
    var relJobs = related.map(function (r) { return loadFirst(officialIcons(r.t, r.id, root)); });
    return Promise.all([
      ensureFonts(),
      loadImage(root + 'assets/bg.webp'),
      loadImage(root + 'assets/parchment.webp'),
      loadImage(opts.artSrc || ''),
      loadImage(ORN_EX),
      loadImage(ORN_CALL),
      Promise.all(iconJobs),
      Promise.all(relJobs)
    ]).then(function (r) {
      related.forEach(function (x, i) { x.icon = r[7][i]; });
      return { bg: r[1], parchment: r[2], art: r[3], ornEx: r[4], ornCall: r[5],
               jinxIcons: r[6], jinxes: jinxes, related: related };
    });
  }
  /* An icon in the order to try it: what the page draws, then the official
     art in its CURRENT style by id (icons-sm, which is what the page draws
     for an official character once roles.json has loaded — a snapshot taken
     before then, or a jinx typed by hand, still gets the modern picture),
     then the CDN, and the old-style assets/icons/ copy only as a last
     resort. */
  function officialIcons(t, id, root) {
    var all = sameOriginFirst([t && t.iconSrc, id && root + 'assets/icons-sm/' + id + '.webp',
      t && t.iconFallback, id && root + 'assets/icons/' + id + '.png']);
    // resolveJinxTarget's own last resort is that old copy, so it can be
    // t.iconSrc: whatever its source, it goes to the back.
    var old = function (s) { return /\/assets\/icons\//.test(s); };
    return all.filter(function (s) { return !old(s); }).concat(all.filter(old));
  }
  /* Our own files before anybody else's: another host need not send CORS
     headers, and a picture we cannot read back is worse than one we never
     asked for (it is dropped, see loadImage). */
  function sameOriginFirst(srcs) {
    srcs = srcs.filter(function (s, i) { return s && srcs.indexOf(s) === i; });
    return srcs.filter(function (s) { return !foreign(s); })
      .concat(srcs.filter(function (s) { return foreign(s); }));
  }

  /* ── the whole thing ── */
  function compose(ctx, d, assets, opts) {
    var name = d.name || 'Unnamed';
    var strip = global.CreatorSymbols && global.CreatorSymbols.stripCreatorMark;
    var creators = global.splitCreators ? global.splitCreators(d.creator) : [];
    var titleName = strip ? (strip(name, creators[0] || '') || name) : name;

    var title = titleBlock(ctx, titleName, LEFT_W);

    var sideCards = [infoCard(ctx, d, assets, RIGHT_W, opts)];
    var qr = qrCard(ctx, opts.pageUrl, RIGHT_W, assets);
    if (qr) sideCards.push(qr);
    var jx = jinxCard(ctx, assets.jinxes, RIGHT_W, assets);
    if (jx) sideCards.push(jx);
    customBoxCards(ctx, d.customBoxes || [], RIGHT_W, assets).forEach(function (c) { sideCards.push(c); });
    var side = stack(sideCards, CARD_GAP);

    var titleTop = 14;
    var panelTop = titleTop + title.h + 12;
    var sideBottom = RIGHT_TOP + side.h;

    /* Where the parchment is cut. Everything beside the sidebar is the page's
       own layout; once the sidebar has run out, the rest can go under it
       across the whole poster instead of leaving that side empty. Every cut
       between sections is tried and the shortest poster wins, so a long
       almanac fills the width and a short one stays exactly as the page
       draws it (a cut has to save a real amount to be taken). */
    var secs = parchmentSections(ctx, d, assets);
    var best = { top: null, rest: null, bottom: sideBottom };
    for (var k = secs.length; k >= 0; k--) {
      var top = k ? parchmentPanel(secs.slice(0, k), LEFT_W, false, assets) : null;
      var rest = k < secs.length ? parchmentPanel(secs.slice(k), W - MARGIN * 2, true, assets) : null;
      var leftBottom = top ? panelTop + top.h : panelTop;
      // With nothing in the sidebar the full-width part starts under the title.
      var restTop = side.h ? Math.max(leftBottom, sideBottom) + CARD_GAP : leftBottom + (top ? CARD_GAP : 0);
      var bottom = rest ? restTop + rest.h : Math.max(leftBottom, sideBottom);
      if (!best.top && !best.rest || bottom < best.bottom - 40) {
        best = { top: top, rest: rest, restTop: restTop, bottom: bottom };
      }
    }
    var FOOT = 34;
    var height = best.bottom + MARGIN + 8 + FOOT;

    return {
      height: height,
      // cw x ch is the picture, which a chosen shape can make larger than the
      // poster: the site's background fills all of it and the poster sits in
      // the middle, at the size it was laid out at.
      draw: function (c, cw, ch) {
        c.fillStyle = C.purple;
        c.fillRect(0, 0, cw, ch);
        if (assets.bg) {
          c.save();
          c.beginPath(); c.rect(0, 0, cw, ch); c.clip();
          drawCover(c, assets.bg, 0, 0, cw, ch, true);
          c.restore();
        }
        c.save();
        c.translate((cw - W) / 2, (ch - height) / 2);
        title.draw(c, MARGIN, titleTop);
        if (best.top) best.top.draw(c, MARGIN, panelTop);
        if (best.rest) best.rest.draw(c, MARGIN, best.restTop);
        side.draw(c, MARGIN + LEFT_W + COL_GAP, RIGHT_TOP);
        c.restore();
        // Where the picture came from, for wherever it ends up.
        c.font = '400 20px ' + FAM.display;
        c.letterSpacing = '1.5px';
        c.fillStyle = 'rgba(240,232,213,.72)';
        c.textAlign = 'right';
        c.fillText('BOTCHOMEBREW.WIKI', cw - MARGIN, ch - MARGIN + 2);
        c.textAlign = 'left';
        c.letterSpacing = '0px';
      }
    };
  }

  /* ── the settings wheel ───────────────────────────────────────────────
     What can be left out, as [key, label, has(d, opts), drop(d, opts)]. A
     hidden section is emptied out of a COPY of the character before anything
     is laid out, so nothing below has to know the wheel exists. Only the
     sections this character actually has are offered. */
  function callouts(d) {
    return (Array.isArray(d.callout) ? d.callout : [d.callout])
      .filter(function (x) { return typeof x === 'string' && x.trim(); });
  }
  var SECTIONS = [
    ['summary', 'Summary', function (d) { return d.ability || d.lede || list(d.summaryBullets).length; },
      function (d) { d.ability = ''; d.lede = ''; d.summaryBullets = []; }],
    ['related', 'Related', function (d) { return list(d.related).length; }, function (d) { d.related = []; }],
    ['howToRun', 'How to Run', function (d) { return list(d.howToRun).length || callouts(d).length; },
      function (d) { d.howToRun = []; d.callout = ''; }],
    ['examples', 'Examples', function (d) { return list(d.examples).length; }, function (d) { d.examples = []; }],
    ['tips', 'Tips & Tricks', function (d) { return list(d.tips).length; }, function (d) { d.tips = []; }],
    ['bluffing', 'Bluffing', function (d) { return list(d.bluffing).length; }, function (d) { d.bluffing = []; }],
    ['fighting', 'Fighting', function (d) { return list(d.fighting).length; }, function (d) { d.fighting = []; }],
    ['art', 'Icon', function (d, o) { return o.artSrc; }, function (d, o) { o.artSrc = ''; }],
    ['quote', 'Flavour quote', function (d) { return String(d.quote || d.flavor || '').trim(); },
      function (d) { d.quote = ''; d.flavor = ''; }],
    ['pronunciation', 'Pronunciation', function (d) { return d.pronunciation || d.ipa || d.respelling; },
      function (d) { d.pronunciation = ''; d.ipa = ''; d.respelling = ''; }],
    ['creator', 'Creator credit', function (d) { return String(d.creator || '').trim(); },
      function (d) { d.creator = ''; }],
    ['appearsIn', 'Collection (Appears in)', function (d) {
      return String(d.appearsIn || '').trim() || list(d.appearsInFrom).length;
    }, function (d) { d.appearsIn = ''; d.appearsInFrom = []; }],
    ['info', 'Information', function () { return true; }, function () {}],   // infoCard reads opts.hide
    ['qr', 'Wiki Link', function (d, o) { return o.pageUrl; }, function (d, o) { o.pageUrl = ''; }],
    ['jinxes', 'Jinxes', function (d) { return list(d.jinxes).length; }, function (d) { d.jinxes = []; }]
  ];
  // A custom box is keyed by its title, so leaving out "Credits" sticks
  // from one character to the next.
  function boxKey(b, i) { return 'box:' + (String((b && b.title) || '').trim() || '#' + i); }
  function realBoxes(d) {
    return (Array.isArray(d.customBoxes) ? d.customBoxes : []).filter(function (b) {
      return b && (String(b.title || '').trim() || String(b.content || '').trim());
    });
  }
  function offered(d, opts) {
    var out = SECTIONS.filter(function (s) { return s[2](d, opts); })
      .map(function (s) { return { key: s[0], label: s[1] }; });
    realBoxes(d).forEach(function (b, i) {
      out.push({ key: boxKey(b, i), label: String(b.title || '').trim() || 'Untitled box' });
    });
    return out;
  }
  function applyHidden(d, opts) {
    var hide = opts.hide || {};
    d = assign(d, {});
    opts = assign(opts, {});
    SECTIONS.forEach(function (s) { if (hide[s[0]]) s[3](d, opts); });
    d.customBoxes = realBoxes(d).filter(function (b, i) { return !hide[boxKey(b, i)]; });
    return { d: d, opts: opts };
  }

  // Width over height; 0 is "fit the page".
  var RATIOS = { auto: 0, '1:1': 1, '4:5': 4 / 5, '9:16': 9 / 16, '16:9': 16 / 9 };
  var RATIO_LABELS = [['auto', 'Fit the page'], ['1:1', 'Square (1:1)'], ['4:5', 'Portrait (4:5)'],
    ['9:16', 'Phone screen (9:16)'], ['16:9', 'Widescreen (16:9)']];
  var SIZE_LABELS = [['small', 'Small: quick to share'], ['standard', 'Standard'], ['large', 'Large: for printing']];

  /* opts: {artSrc, pageUrl, siteRoot, hide: {key: true}, ratio, size}. */
  function render(d, opts) {
    var h = applyHidden(d, opts || {});
    d = h.d; opts = h.opts;
    return gatherAssets(d, opts).then(function (assets) {
      var measure = doc.createElement('canvas').getContext('2d');
      // "[[Drunk]]" is this character's reminder token when it carries one,
      // as on the page (renderCharacter sets the same registry, and clears it).
      var W2 = global.WikiRender, poster;
      if (W2 && W2.setReminderTokens) W2.setReminderTokens(list(d.reminders).concat(list(d.remindersGlobal)));
      try { poster = compose(measure, d, assets, opts); }
      finally { if (W2 && W2.setReminderTokens) W2.setReminderTokens(null); }
      // A chosen shape adds background around the poster rather than
      // shrinking or squashing it.
      var cw = W, ch = poster.height, r = RATIOS[opts.ratio] || 0;
      if (r) { if (cw / ch > r) ch = cw / r; else cw = ch * r; }
      var area = cw * ch;
      var std = Math.max(1, Math.min(SCALE_MAX, Math.sqrt(MAX_PIXELS / area)));
      var scale = opts.size === 'small' ? Math.min(SCALE_MAX, SMALL_SIDE / Math.max(cw, ch))
        : opts.size === 'large' ? Math.max(std, Math.min(LARGE_SCALE, Math.sqrt(LARGE_PIXELS / area)))
        : std;
      var canvas = doc.createElement('canvas');
      canvas.width = Math.round(cw * scale);
      canvas.height = Math.round(ch * scale);
      var ctx = canvas.getContext('2d');
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.textBaseline = 'alphabetic';
      poster.draw(ctx, cw, ch);
      return canvas;
    });
  }

  /* Charactername_Almanac.png — spaces become underscores, and anything a
     filesystem would object to is dropped. */
  function fileName(d) {
    var base = String((d && d.name) || 'Character').trim()
      .replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '_').replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
    return (base || 'Character') + '_Almanac.png';
  }

  /* ── the preview ──────────────────────────────────────────────────────
     The canvas is turned into a blob and shown as an <img>: an image is what
     a browser lets you right-click and copy, and on a phone a long press
     offers the same. The Download button carries the name; Copy image is
     there because a right-click is not a gesture a phone has, and Share
     (phones, mostly) hands the file straight to Discord or Messages. */
  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* The wheel's choices are kept per browser, so a creator who always
     leaves the QR off or always wants a square sets it once. */
  var PREFS_KEY = 'botc_snap_opts';
  function loadPrefs() {
    try {
      var p = JSON.parse(global.localStorage.getItem(PREFS_KEY) || 'null');
      if (p && typeof p === 'object') {
        return { hide: p.hide && typeof p.hide === 'object' ? p.hide : {},
                 ratio: RATIOS.hasOwnProperty(p.ratio) ? p.ratio : 'auto',
                 size: /^(small|standard|large)$/.test(p.size) ? p.size : 'standard' };
      }
    } catch (e) {}
    return { hide: {}, ratio: 'auto', size: 'standard' };
  }
  function savePrefs(p) {
    try { global.localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (e) {}
  }

  function button(cls, text) {
    var b = el('button', cls, text);
    b.type = 'button';
    return b;
  }
  function select(choices, value) {
    var s = el('select', 'snap-select');
    choices.forEach(function (c) {
      var o = el('option', null, c[1]);
      o.value = c[0];
      if (c[0] === value) o.selected = true;
      s.appendChild(o);
    });
    return s;
  }

  function open(d, opts) {
    opts = opts || {};
    // Building the picture takes a second or two, which is long enough for a
    // second click: one preview at a time.
    if (doc.querySelector('.snap-backdrop')) return;
    var prefs = loadPrefs();

    var back = el('div', 'snap-backdrop');
    var panel = el('div', 'snap-panel');
    var head = el('div', 'snap-head');
    head.appendChild(el('h2', 'snap-title', 'Almanac snapshot'));
    // U+FE0E asks for the plain glyph, or a phone draws a coloured emoji.
    var gear = button('snap-x snap-gear', '⚙︎');
    gear.setAttribute('aria-label', 'Picture settings');
    gear.setAttribute('aria-expanded', 'false');
    gear.title = 'Picture settings';
    var closeX = button('snap-x', '✕');
    closeX.setAttribute('aria-label', 'Close');
    head.appendChild(gear);
    head.appendChild(closeX);
    panel.appendChild(head);

    // ── the settings, hidden until the wheel is pressed ──
    var settings = el('div', 'snap-settings');
    settings.hidden = true;
    var showBox = el('fieldset', 'snap-show');
    showBox.appendChild(el('legend', null, 'Show'));
    offered(d, opts).forEach(function (s) {
      var lab = el('label', 'snap-check');
      var cb = el('input');
      cb.type = 'checkbox';
      cb.checked = !prefs.hide[s.key];
      cb.addEventListener('change', function () {
        if (cb.checked) delete prefs.hide[s.key]; else prefs.hide[s.key] = true;
        changed();
      });
      lab.appendChild(cb);
      lab.appendChild(doc.createTextNode(' ' + s.label));
      showBox.appendChild(lab);
    });
    settings.appendChild(showBox);
    var shape = select(RATIO_LABELS, prefs.ratio);
    var size = select(SIZE_LABELS, prefs.size);
    [['Shape', shape], ['Size', size]].forEach(function (f) {
      var lab = el('label', 'snap-field');
      lab.appendChild(el('span', null, f[0]));
      lab.appendChild(f[1]);
      settings.appendChild(lab);
      f[1].addEventListener('change', function () {
        prefs.ratio = shape.value; prefs.size = size.value;
        changed();
      });
    });
    panel.appendChild(settings);
    gear.addEventListener('click', function () {
      settings.hidden = !settings.hidden;
      gear.setAttribute('aria-expanded', String(!settings.hidden));
      gear.classList.toggle('on', !settings.hidden);
    });

    var hint = el('p', 'snap-hint', 'Building the picture…');
    panel.appendChild(hint);
    var stage = el('div', 'snap-stage');
    panel.appendChild(stage);

    var actions = el('div', 'snap-actions');
    var shareBtn = button('snap-btn snap-share', 'Share');
    shareBtn.hidden = true;
    var copyBtn = button('snap-btn snap-copy', 'Copy image');
    copyBtn.disabled = true;
    var dl = el('a', 'snap-btn snap-dl', 'Download PNG');
    dl.setAttribute('role', 'button');
    var done = button('snap-btn snap-close', 'Close');
    actions.appendChild(shareBtn);
    actions.appendChild(copyBtn);
    actions.appendChild(dl);
    actions.appendChild(done);
    panel.appendChild(actions);
    back.appendChild(panel);
    doc.body.appendChild(back);

    var img = el('img', 'snap-img');
    img.alt = (d.name || 'Character') + ' almanac';
    img.title = 'Tap to zoom in';
    // A click zooms; a right-click or a long press still offers Copy image,
    // which is what the picture is here for.
    img.addEventListener('click', function () {
      var full = img.classList.toggle('snap-full');
      img.title = full ? 'Tap to see the whole page' : 'Tap to zoom in';
    });

    // The picture on screen. Every button reads it at the moment it is
    // pressed, so a rebuild never leaves a button holding an old one.
    var cur = null, url = null, shut = false, run = 0, timer = null;
    function close() {
      shut = true;
      if (url) URL.revokeObjectURL(url);
      doc.removeEventListener('keydown', onKey);
      if (back.parentNode) back.parentNode.removeChild(back);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    doc.addEventListener('keydown', onKey);
    closeX.addEventListener('click', close);
    done.addEventListener('click', close);
    back.addEventListener('click', function (e) { if (e.target === back) close(); });

    var canShareFiles = !!(global.File && navigator.canShare &&
      navigator.canShare({ files: [new global.File([''], 'x.png', { type: 'image/png' })] }));
    shareBtn.addEventListener('click', function () {
      if (!cur) return;
      var file = new global.File([cur.blob], fileName(d), { type: 'image/png' });
      navigator.share({ files: [file], title: (d.name || 'Character') + ' almanac' })
        .catch(function () {});   // closing the share sheet is not an error
    });
    if (!(navigator.clipboard && global.ClipboardItem)) copyBtn.remove();
    copyBtn.addEventListener('click', function () {
      if (!cur) return;
      var item = {};
      item['image/png'] = cur.blob;
      navigator.clipboard.write([new global.ClipboardItem(item)]).then(function () {
        copyBtn.textContent = 'Copied!';
        setTimeout(function () { copyBtn.textContent = 'Copy image'; }, 1600);
      }, function () {
        copyBtn.textContent = 'Copy failed';
        setTimeout(function () { copyBtn.textContent = 'Copy image'; }, 1600);
      });
    });

    function changed() {
      savePrefs(prefs);
      clearTimeout(timer);
      timer = setTimeout(build, 250);   // a run of ticks is one rebuild
    }
    function build() {
      var mine = ++run;
      hint.className = 'snap-hint';
      hint.textContent = cur ? 'Updating the picture…' : 'Building the picture…';
      render(d, assign(opts, { hide: prefs.hide, ratio: prefs.ratio, size: prefs.size }))
        .then(function (canvas) {
          return new Promise(function (resolve, reject) {
            try {
              canvas.toBlob(function (blob) {
                if (blob) resolve({ blob: blob, canvas: canvas });
                else reject(new Error('The picture could not be saved.'));
              }, 'image/png');
            } catch (e) { reject(e); }
          });
        }).then(function (out) {
          if (shut || mine !== run) return;   // closed, or a newer build is on its way
          if (url) URL.revokeObjectURL(url);
          cur = out;
          url = URL.createObjectURL(out.blob);
          img.src = url;
          if (!img.parentNode) stage.appendChild(img);
          hint.textContent = 'Right-click (or long-press) the picture to copy it, tap it to zoom in, ' +
            'or use the buttons below. ' + out.canvas.width + '×' + out.canvas.height + ' pixels.';
          dl.href = url;
          dl.download = fileName(d);
          dl.hidden = false;
          copyBtn.disabled = false;
          shareBtn.hidden = !canShareFiles;
        }).catch(function (err) {
          if (shut || mine !== run) return;
          hint.className = 'snap-hint snap-error';
          hint.textContent = (err && err.message) ||
            'The picture could not be built. Art hosted on another site can stop it being saved.';
          cur = null;
          copyBtn.disabled = true;
          shareBtn.hidden = true;
          dl.hidden = true;
        });
    }
    build();
  }

  global.CharSnapshot = { open: open, render: render, fileName: fileName };
})(typeof window !== 'undefined' ? window : this);
