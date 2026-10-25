/* Fancy Scripts — the sheet renderer.
 *
 * Vanilla-DOM port of the handoff's ScriptSheet component: builds one
 * .script-sheet element (1242×1656 CSS px, the 3:4 reference trim) per
 * PAGE from a parsed script + options. Everything is inline-styled with
 * the calibrated values from script.js's SHEET — this element is also what
 * the PNG/PDF export captures, so its pixels ARE the product; nothing about
 * it may depend on the page's stylesheet.
 *
 * Two passes:
 *   layoutSheet()     — measures every row (word-wrap in the real fonts),
 *                       solves the density that fits every section on the
 *                       one page (the script sheet is always one page).
 *   renderSheetPage() — draws one of those pages: background, ribbon,
 *                       header band, sections, footnote, page number,
 *                       stickers. Every movable piece carries
 *                       data-fs-drag so drag.js can pick it up.
 *
 * Two async loops feed back into rendering, and both go through the caller's
 * requestRender callback instead of touching the DOM they built:
 *   - icon ink normalization: every icon's alpha bounding box is measured
 *     once (cached per url) and the artwork scaled/recentred so all icons
 *     carry the same visual weight, like the hand-laid official sheets;
 *   - the sidebar recolour and the fonts: word-wrap and the title width are
 *     measured with canvas/layout, so the caller re-renders once
 *     document.fonts.ready resolves.
 *
 * fitTitle(el) must be called after the element is in the document: the
 * swash title shrinks to the band between the skull and the right flourish,
 * and that needs real layout. Browser-only (canvas + DOM) — do not import
 * from the Worker.
 */

import {
  SHEET, FIT, SHEET_W, SHEET_H, U, SIDEBAR_BASE, footEm,
  TEAM_LABELS, TEAM_LABELS_SINGULAR, PLACEHOLDER_ICON,
  groupByTeam, splitColumns, proxied, smartTypography, teamColor, fontFamily, elGet, NO_ART, artChoice, garlandOval, garlandShift, footInOval,
} from './script.js';
import {
  el, img, px, clamp, solveFit, isDark, hexHsl, shade, wrappedLineCount,
  normalizeIcons, iconFit, inkTransform, iconFilter, ICON_IDENTITY, drawIcon,
} from './util.js';
import {
  ART, pageFrame, renderBackground, renderStickers, resolveSrc, applyEl, markSelected, watermark,
} from './elements.js';
import { runPixelJob } from './jobs.js';

/* an icon <img> that falls back to the placeholder when its art 404s.
   Decoded synchronously: the preview rebuilds these nodes on every change
   and an async decode paints them blank for a frame or two first. */
function iconImg(src, style, alt) {
  const n = img(src, style, alt);
  n.crossOrigin = 'anonymous';
  n.decoding = 'sync';
  n.addEventListener('error', () => {
    if (n.src !== PLACEHOLDER_ICON) n.src = PLACEHOLDER_ICON;
  });
  return n;
}

/* title art that failed to load (a dead _meta.logo URL): the sheet falls
   back to the swash text title instead of an empty band */
const failedArt = new Set();

/* each title image's width / height, learnt when it first loads. A logo is
   fitted into a box 9.4 em tall, but a wide one comes out shorter than
   that, and the author line and the first section sit under the logo's
   REAL bottom: placed under the box instead, "by …" landed on top of every
   square logo (the box is centred at 6.66 em, the author line was at 10.8). */
const artAspect = new Map();
function titleArtOf(script, options) {
  const t = elGet(options, 'title');
  const art = resolveSrc(t.src) || (script.meta.logo && options.useLogo ? proxied(script.meta.logo, options.proxyIcons) : '');
  return art && !failedArt.has(art) ? art : '';
}
/* The tallest the title image may be drawn, in em. In the 'shared' column
   layout the left column's first row starts at contentTop, level with the
   header, so an image there has to end above it or it covers that row. */
function artMaxHEm(options, t) {
  const h = 9.4 * t.scale;
  return options.columnLayout === 'shared' ? Math.min(h, 2 * (SHEET.contentTop - 0.25 - SHEET.titleCY - t.dy)) : h;
}
// half the drawn height of the title image, in em
function artHalfEm(art, t, options) {
  const maxH = artMaxHEm(options, t), maxW = (0.4911 * SHEET_W * t.scale) / U;
  const a = artAspect.get(art);
  return (a ? Math.min(maxH, maxW / a) : maxH) / 2;
}
/* The swash title's ink is calibrated on a name with nothing below the
   line; a g, j, p, q or y hangs about an em lower, onto the author line
   ("by Patters" through the y of "Inch by Inch"). */
function titleDropEm(script, options) {
  const name = (options.titleOverride || '').trim() || script.meta.name || '';
  return /[gjpqy]/.test(name) ? 0.9 * elGet(options, 'title').scale : 0;
}
// the author line's vertical centre, in em
function authorCYEm(script, options) {
  const t = elGet(options, 'title');
  const a = elGet(options, 'author');
  const art = titleArtOf(script, options);
  return (art ? SHEET.titleCY + t.dy + artHalfEm(art, t, options) + 0.95 * a.scale
    : 10.8 + t.dy + titleDropEm(script, options)) + a.dy;
}

/* ability text with typographic punctuation and the ornamental asterisk of
   the official sheets */
function abilityNodes(text, bracketStyle) {
  const parts = smartTypography(text).split('*');
  const out = [];
  const bracketed = (s) => {
    // "[+2 Outsiders]" setup notes, styled apart from the rule when asked
    if (!bracketStyle || bracketStyle === 'plain') return [document.createTextNode(s)];
    const nodes = [];
    const re = /\[[^\]\n]{1,60}\]/g;
    let last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) nodes.push(document.createTextNode(s.slice(last, m.index)));
      const span = el('span', bracketStyle === 'italic' ? { fontStyle: 'italic' }
        : bracketStyle === 'bold' ? { fontWeight: '700' }
          : { opacity: '0.72', fontStyle: 'italic' }, m[0]);
      nodes.push(span);
      last = m.index + m[0].length;
    }
    if (last < s.length) nodes.push(document.createTextNode(s.slice(last)));
    return nodes;
  };
  parts.forEach((p, i) => {
    for (const n of bracketed(p)) out.push(n);
    if (i < parts.length - 1) {
      out.push(img(ART + 'asterisk.png', {
        display: 'inline-block',
        height: '0.6em',
        width: 'auto',
        margin: '0 0.09em 0 0.05em',
        verticalAlign: '0.16em',
      }, '*'));
    }
  });
  return out;
}

/* ── sidebar ribbon recolour ────────────────────────────────────────────
   Re-tint the navy damask strip toward any picked colour — per pixel in
   real HSL (see pixel.js for why a CSS hue-rotate was not good enough).
   The recolour runs once per picked colour, in the pixel worker, and is
   cached: renderSheetPage() shows the newest canvas it has and asks for a
   re-render when a fresh one lands, exactly like the icon-ink
   measurements.

   Cached PER COLOUR, a few deep: the classic sheet's ribbon and the app
   view's red one can both be in one design (a navy sheet with app-view
   night sheets), and a single slot would have the two pages recolour
   over each other on every render, each finish asking for the other. */
const TINT_KEEP = 4;
const sidebarTint = {
  img: null, imgReady: false,
  done: new Map(), // colour -> finished canvas, oldest first
  last: null, // the newest finished canvas of any colour
  busy: false, queue: [], notify: null,
  waiters: [], // ribbonReady() callbacks, run after every finished job
};

/* recoloured canvas for `color`, or the newest one of any colour while the
   fresh one is computed off this frame (null = show the plain navy art) */
function sidebarTintCanvas(color, requestRender) {
  const st = sidebarTint;
  st.notify = requestRender;
  const hit = st.done.get(color);
  if (hit) return hit;
  // newest request first, and only a few: dragging the colour picker asks
  // for sixty colours a second and only the last one matters
  st.queue = [color, ...st.queue.filter((c) => c !== color)].slice(0, 3);
  if (!st.img) {
    st.img = new Image();
    st.img.onload = () => { st.imgReady = true; pumpSidebarTint(); };
    st.img.src = ART + 'sidebar-flat.png';
  } else {
    pumpSidebarTint();
  }
  return st.last; // possibly another colour — better than flashing navy
}

function pumpSidebarTint() {
  const st = sidebarTint;
  while (st.queue.length && st.done.has(st.queue[0])) st.queue.shift();
  if (st.busy || !st.imgReady || !st.queue.length) return;
  const color = st.queue.shift();
  const t = hexHsl(color);
  if (!t) { pumpSidebarTint(); return; }
  st.busy = true;
  const src = st.img;
  const c = document.createElement('canvas');
  c.width = src.naturalWidth;
  c.height = src.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0);
  const im = ctx.getImageData(0, 0, c.width, c.height);
  const job = {
    type: 'tint', buf: im.data.buffer,
    dH: t.h - SIDEBAR_BASE.h,
    sRatio: t.s < 0.06 ? 0 : t.s / SIDEBAR_BASE.s,
    lRatio: t.l / SIDEBAR_BASE.l,
  };
  runPixelJob(job, [im.data.buffer]).then((buf) => {
    ctx.putImageData(new ImageData(new Uint8ClampedArray(buf), c.width, c.height), 0, 0);
    st.done.set(color, c);
    while (st.done.size > TINT_KEEP) st.done.delete(st.done.keys().next().value);
    st.last = c;
  }).catch(() => { /* the art stays navy for this colour */ }).then(() => {
    st.busy = false;
    for (const w of st.waiters.splice(0)) w();
    if (st.notify) st.notify();
    pumpSidebarTint(); // the wanted colour may have moved on meanwhile
  });
}

/* an export renders pages the preview may never have shown, so it waits
   for their ribbon's colour rather than capturing whichever was last */
export function ribbonReady(color) {
  if (!color || color.toLowerCase() === SIDEBAR_BASE.hex || !hexHsl(color)) return Promise.resolve();
  const st = sidebarTint;
  const t0 = Date.now();
  return new Promise((resolve) => {
    setTimeout(resolve, 15000); // an art file that never loads must not hang the export
    const check = () => {
      if (st.done.has(color) || Date.now() - t0 > 15000) { resolve(); return; }
      sidebarTintCanvas(color, st.notify);
      st.waiters.push(check);
    };
    check();
  });
}

/* the ribbon, shared by every style: the damask art (recoloured), a flat
   colour, or an upload, full height from the sheet's edge to `widthPct`.
   Down the LEFT edge on the script sheets; the ribbon-style night sheets
   hang theirs down the right (`side: 'right'`), where the art is cropped to
   the narrower strip from its own left edge. `shade` lays the parchment
   frame's shading over the damask (the classic sheet's slider; 0
   elsewhere). */
export function appendRibbon(sheet, r, ctx) {
  const style = {
    position: 'absolute', top: '0', height: '100%', width: r.widthPct + '%',
    ...(r.side === 'right' ? { right: '0' } : { left: '0' }),
    objectFit: 'cover', objectPosition: r.side === 'right' ? '0% 50%' : '50% 50%',
  };
  const opacity = String(r.opacity == null ? 1 : r.opacity);
  if (r.mode === 'none') return;
  if (r.src) {
    sheet.append(img(r.src, { ...style, opacity }));
    return;
  }
  if (r.mode === 'flat') {
    sheet.append(el('div', { ...style, background: r.color || SIDEBAR_BASE.hex, opacity }));
    return;
  }
  const wantsTint = r.color && r.color.toLowerCase() !== SIDEBAR_BASE.hex && hexHsl(r.color);
  const tinted = wantsTint ? sidebarTintCanvas(r.color, ctx.requestRender) : null;
  if (tinted) {
    // the cached canvas is adopted by each new sheet; the old sheet is
    // already detached, so moving it is safe. An export render that runs
    // while the preview is up gets a COPY, so the preview keeps its ribbon.
    // Its style is wiped first: a left strip and a right one are not laid
    // out alike, and one colour can be both in one design.
    let node = tinted;
    if (tinted.parentNode && ctx.forExport) {
      node = document.createElement('canvas');
      node.width = tinted.width; node.height = tinted.height;
      node.getContext('2d').drawImage(tinted, 0, 0);
    }
    node.style.cssText = '';
    Object.assign(node.style, style, { opacity });
    sheet.append(node);
  } else {
    sheet.append(img(ART + 'sidebar-flat.png', { ...style, opacity }));
  }
  // softer pattern: a wash of the ribbon's own colour over the damask
  const soften = 1 - clamp(r.contrast == null ? 1 : Number(r.contrast), 0, 1);
  if (soften > 0) sheet.append(el('div', { ...style, background: r.color || SIDEBAR_BASE.hex, opacity: String(soften * Number(opacity)) }));
  // only fetched when it is actually asked for — it is a 1.6 MB overlay
  const shadeAmt = clamp(Number(r.shade) || 0, 0, 1);
  if (shadeAmt > 0) sheet.append(img(ART + 'sidebar-shade.png', { ...style, opacity: String(shadeAmt) }));
}

/* title in the swash face: the default keeps the reference's exact
   indigo→near-black ramp over a bronze offset duplicate; other styles
   build the same two layers from the picked colour(s) */
function swashTitle(text, options, shadowDX, shadowDY) {
  const color = options.titleColor || '#10102e';
  const style = options.titleStyle || 'classic';
  let gradient;
  if (style === 'flat') gradient = null;
  else if (style === 'gradient') gradient = `linear-gradient(180deg, ${options.titleColor2 || '#3d3e88'} 0%, ${color} 100%)`;
  else if (style === 'classic' && color.toLowerCase() === '#10102e') {
    gradient = 'linear-gradient(180deg, #3d3e88 0%, #2c2a70 34%, #141244 55%, #0e0e20 74%, #10102e 100%)';
  } else gradient = `linear-gradient(-20deg, ${shade(color, 0.18)} 50%, ${shade(color, -0.14)})`;
  const wrap = el('span', { position: 'relative', display: 'inline-block' });
  const sh = clamp(Number(options.titleShadow == null ? 1 : options.titleShadow), 0, 3);
  if (sh > 0) {
    const back = el('span', {
      position: 'absolute',
      left: '0',
      top: '0',
      color: options.titleShadowColor || '#ad9069',
      transform: `translate(${shadowDX * sh}px, ${shadowDY * sh}px)`,
      zIndex: '0',
    }, text);
    back.setAttribute('aria-hidden', 'true');
    wrap.append(back);
  }
  const front = el('span', { position: 'relative', zIndex: '1' }, text);
  if (gradient) {
    Object.assign(front.style, { background: gradient, backgroundClip: 'text', color: 'transparent' });
    front.style.setProperty('-webkit-background-clip', 'text');
  } else {
    front.style.color = color;
  }
  wrap.append(front);
  return wrap;
}

/* one character row: icon, name (+ jinx partner icons), ability.
   `heightEm` is the row's drawn height; `naturalEm` is what its own text
   needs. They differ when a section is dealing out spare height (an uneven
   column split, or a short script spreading down the page) — and the icon
   goes by the second, because it belongs beside the NAME, not in the middle
   of the padding under it. Centring it in the drawn row let it sink away
   from its own name as the rows stretched. */
function characterEntry(char, options, heightEm, iconEm, ed, e, fonts, widthMul, mark, naturalEm) {
  const { textSize, nameSize } = options;
  const colW = SHEET.textOffsetX + SHEET.textWidth * widthMul; // column width in % of sheet
  const textLeftPct = (SHEET.textOffsetX / colW) * 100;
  const textWidthPct = ((SHEET.textWidth * widthMul) / colW) * 100;
  const abilityTopEff = SHEET.nameTop + (SHEET.abilityTop - SHEET.nameTop) * nameSize;
  const fit = options.normalizeIcons ? iconFit(char.icon) : ICON_IDENTITY;
  const color = char.color || teamColor(options, char.team);

  const row = el('div', { position: 'relative', height: px(ed(heightEm)) });
  row.dataset.fsChar = char.id;
  if (mark) mark(row, 'crow:' + char.id); // drag a row to reorder it within its team

  const iconPx = ed(iconEm) * (char.iconScale || 1);
  // this character's own nudge plus the sheet's "move every icon" offset
  const iconLeft = (((char.iconDX || 0) + (Number(options.iconShiftX) || 0)) / 100) * SHEET_W;
  const blockEm = Math.min(naturalEm == null ? heightEm : naturalEm, heightEm);
  const iconTop = ed((blockEm - iconEm) / 2 + 0.5) - (iconPx - ed(iconEm)) / 2 +
    e((char.iconDY || 0) + (Number(options.iconShiftY) || 0));
  const icon = iconImg(drawIcon(char.icon), {
    position: 'absolute',
    left: px(iconLeft),
    top: px(iconTop),
    width: px(iconPx),
    height: px(iconPx),
    objectFit: 'contain',
    transform: inkTransform(fit),
    transformOrigin: 'center',
    filter: iconFilter(options.iconEffect, options.iconShadow, ed),
  });
  if (options.iconEffect === 'engraved') icon.style.mixBlendMode = 'multiply';
  if (mark) mark(icon, 'char:' + char.id); // drag an icon to nudge it
  row.append(icon);

  const nameRow = el('div', {
    position: 'absolute',
    left: textLeftPct + '%',
    top: px(ed(SHEET.nameTop)),
    width: textWidthPct + '%',
    display: 'flex',
    alignItems: 'center',
    gap: px(ed(0.14)),
    fontFamily: fonts.name,
    fontWeight: '700',
    fontSize: px(ed(SHEET.nameSize * nameSize)),
    lineHeight: '1',
    color,
    letterSpacing: (options.nameSpacing == null ? 0.02 : options.nameSpacing) + 'em',
    whiteSpace: 'nowrap',
    textTransform: options.nameCase === 'upper' ? 'uppercase' : 'none',
    fontVariant: options.nameCase === 'smallcaps' ? 'small-caps' : 'normal',
  }, el('span', null, smartTypography(char.name)));

  if (options.showJinxes) {
    for (const j of char.jinxIcons) {
      const jf = options.normalizeIcons ? iconFit(j.icon) : ICON_IDENTITY;
      const jsz = ed(SHEET.jinxSize * nameSize) * 0.72 * (options.jinxIconSize || 1);
      const ji = iconImg(drawIcon(j.icon), {
        height: px(jsz),
        width: px(jsz),
        objectFit: 'contain',
        flexShrink: '0',
        transform: inkTransform(jf),
        transformOrigin: 'center',
        filter: iconFilter(options.iconEffect, options.iconShadow * 0.7, ed),
      }, j.name);
      ji.title = 'Jinxed: ' + j.name + (j.reason ? ' — ' + j.reason : '');
      nameRow.append(ji);
    }
  }
  row.append(nameRow);

  row.append(el('div', {
    position: 'absolute',
    left: textLeftPct + '%',
    top: px(ed(abilityTopEff)),
    width: textWidthPct + '%',
    fontFamily: fonts.ability,
    fontWeight: '400',
    fontSize: px(ed(SHEET.abilitySize * textSize)),
    lineHeight: String((SHEET.abilityLine / SHEET.abilitySize) * (options.abilityLine || 1)),
    color: options.inkColor || '#222222',
    mixBlendMode: 'multiply',
    textAlign: options.abilityAlign === 'justify' ? 'justify' : 'left',
    whiteSpace: 'pre-line', // a line break typed in the ability is kept, as the printed sheets break them
  }, ...abilityNodes(char.ability, options.bracketStyle)));

  return row;
}

/* the fonts every text role uses, resolved once per render */
function fontsOf(options) {
  return {
    title: fontFamily(options.fontTitle),
    name: fontFamily(options.fontName),
    ability: fontFamily(options.fontAbility),
    label: fontFamily(options.fontLabel),
    author: fontFamily(options.fontAuthor),
    footnote: fontFamily(options.fontFootnote),
  };
}

/* the band the title/logo and author occupy, in em below contentTop —
   the first section starts under it (even layout; fixed, because the
   title does not scale with density) */
function headerExtraEm(script, options) {
  if (!options.showHeader) return 0;
  const t = elGet(options, 'title');
  const a = elGet(options, 'author');
  const bottoms = [];
  if (!t.hidden) {
    const art = titleArtOf(script, options);
    if (art) {
      bottoms.push(SHEET.titleCY + t.dy + artHalfEm(art, t, options));
    } else {
      // the swash title's ink reaches ~3.05 em below its centre at size 1
      bottoms.push(SHEET.titleCY + t.dy + 3.05 * t.scale + titleDropEm(script, options));
    }
  }
  const author0 = ((options.authorOverride || '').trim() || script.meta.author || '').trim();
  if (options.showAuthor && author0 && !a.hidden) bottoms.push(authorCYEm(script, options) + 0.75 * a.scale);
  if (!bottoms.length) return 0;
  return Math.max(0, Math.max(...bottoms) - SHEET.contentTop + 0.35);
}

/* ── layout ─────────────────────────────────────────────────────────────
   layoutSheet(script, options, requestRender) → {pages, d, iconEm, ...}
   Measured layout: rows grow to fit wrapped ability text. Constant row
   pitch like the reference — up to 3 ability lines fit inside one pitch;
   only genuine spill grows a row. fitToContent solves for the density
   that fills contentTop..contentBottom (3 iterations converge). */
export function layoutSheet(script, options, requestRender) {
  const groups = groupByTeam(script.characters, options.sortMode);
  const { iconSize, textSize, nameSize } = options;
  const fonts = fontsOf(options);

  // kick off icon ink measurement for anything new
  if (options.normalizeIcons) {
    const urls = new Set();
    script.characters.forEach((c) => {
      urls.add(c.icon);
      c.jinxIcons.forEach((j) => urls.add(j.icon));
    });
    normalizeIcons([...urls], requestRender);
  }

  const abilityTopEff = SHEET.nameTop + (SHEET.abilityTop - SHEET.nameTop) * nameSize;
  /* 'single' puts every character in one column that runs the width of
     both — the second column's icon x plus its text width, over the first
     column's text width */
  const single = options.columnLayout === 'single';
  const widthMul = (options.columnWidth || 1) *
    (single ? (SHEET.col2IconX - SHEET.col1IconX + SHEET.textWidth) / SHEET.textWidth : 1);
  const maxTextW = ((SHEET.textWidth * widthMul) / 100) * SHEET_W;
  const availableEm = footEm(SHEET.contentBottom) - SHEET.contentTop;
  const bareAvailEm = footEm(SHEET.contentBottom) - SHEET.bareTop;
  // the icon must never spill into the text gutter, whatever the density
  const gutterEm = ((SHEET.textOffsetX - 0.05) / 100) * (SHEET_W / U);
  const iconEmFor = (density) => Math.min(SHEET.rowIcon * iconSize, gutterEm / density);
  const lineMul = options.abilityLine || 1;

  const rowHeightEm = (char, density) => {
    let need = Math.max(SHEET.rowPitch, iconEmFor(density) * (char ? (char.iconScale || 1) : 1) + 0.2);
    if (char) {
      const fontPx = SHEET.abilitySize * textSize * U * density;
      const lines = wrappedLineCount(smartTypography(char.ability), `400 ${fontPx}px ${fonts.ability}`, maxTextW);
      // 0.7 margin keeps 3-line rows inside one pitch (1.0 broke it)
      need = Math.max(need, abilityTopEff + (lines - 1) * SHEET.abilityLine * textSize * lineMul + 0.7);
    }
    return need;
  };

  const layoutEven = options.columnLayout !== 'shared';
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  // team names as horizontal headings over each section (instead of, or
  // as well as, the ribbon labels) take a band at the top of the section
  const headEm = options.showLabels && (options.labelStyle === 'heading' || options.labelStyle === 'both')
    ? 2.35 * (options.labelSize || 1) : 0;

  /* Two column layouts:

     'shared' — the classic reference layout: the two columns share one row
     grid (each row as tall as its taller side), and the title occupies the
     first row slot of the SECOND column in the first section, so col 2
     starts one row lower than col 1 (hence shift = 1 there).

     'even' — the official printed sheets: both columns start together and
     both END together. Each column keeps every row's needed height and the
     section's leftover space is dealt out evenly between its rows, so a
     7/6 townsfolk split gives the 6-row column a slightly wider pitch
     instead of a hole at the bottom. The title no longer takes a column
     slot, so the first section starts below the title/author ink instead
     (headerExtra — fixed, because the title does not scale with density). */
  const splitTeam = (chars, density) => {
    if (options.columnSplit !== 'balance' || chars.length < 3) return splitColumns(chars);
    const h = chars.map((ch) => rowHeightEm(ch, density));
    const total = sum(h);
    let at = Math.ceil(chars.length / 2), best = Infinity, acc = 0;
    for (let k = 1; k < chars.length; k++) {
      acc += h[k - 1];
      const tall = Math.max(acc, total - acc);
      if (tall < best - 1e-6) { best = tall; at = k; }
    }
    return [chars.slice(0, at), chars.slice(at)];
  };
  const measureSection = (chars, density, shift) => {
    const [left, right] = single ? [chars, []] : splitTeam(chars, density);
    if (layoutEven) {
      const leftNeeds = left.map((ch) => rowHeightEm(ch, density));
      const rightNeeds = right.map((ch) => rowHeightEm(ch, density));
      return { left, right, leftNeeds, rightNeeds, head: headEm, need: Math.max(sum(leftNeeds), sum(rightNeeds)) + headEm };
    }
    const rows = Math.max(left.length, right.length + shift);
    const rowHeights = [];
    for (let i = 0; i < rows; i++) {
      rowHeights.push(Math.max(
        rowHeightEm(left[i], density),
        rowHeightEm(right[i - shift], density),
      ));
    }
    return { left, right, rowHeights, head: headEm, need: sum(rowHeights) + headEm, shift };
  };

  const headerExtra = headerExtraEm(script, options);
  const pageHasHeader = () => !!options.showHeader;
  const availFor = (i) => (pageHasHeader(i)
    ? availableEm - (layoutEven ? headerExtra : 0)
    : bareAvailEm);
  const topFor = (i) => (pageHasHeader(i) ? SHEET.contentTop + (layoutEven ? headerExtra : 0) : SHEET.bareTop);

  /* every section on the one page, at density d. The script sheet is
     always one page: a long script shrinks to fit rather than running on. */
  const pack = (d) => {
    const page = { sections: [], used: 0, index: 0 };
    groups.forEach((g, i) => {
      const shift = (!layoutEven && i === 0 && pageHasHeader(0)) ? 1 : 0;
      const m = measureSection(g.characters, d, shift);
      page.sections.push({ team: g.team, chars: g.characters, cont: false, total: g.characters.length, ...m });
      page.used += m.need + (i ? SHEET.sectionGap : 0);
    });
    return [page];
  };

  // ── solve the density ──
  const totalNeedAt = (d) => {
    let need = 0;
    groups.forEach((g, i) => {
      need += measureSection(g.characters, d, (!layoutEven && i === 0 && pageHasHeader(0)) ? 1 : 0).need;
    });
    return need + Math.max(0, groups.length - 1) * SHEET.sectionGap;
  };

  let d = options.fitToContent ? 1 : clamp(Number(options.density) || 1, 0.3, 2);
  if (options.fitToContent && groups.length) d = solveFit((dd) => availFor(0) / totalNeedAt(dd), 0.01, FIT.growMax);
  const pages = pack(d);

  const ed = (em) => em * U * d; // density-scaled px
  const iconEm = iconEmFor(d);

  // deal a section's leftover height evenly between one column's rows
  const dealEven = (needs, needEm) => {
    if (!needs.length) return [];
    const per = (needEm - sum(needs)) / needs.length;
    return needs.map((n) => n + per);
  };

  /* ── take up the rest of the page ──
     The density stops growing at FIT.growMax, so a page holding less than
     that fills is left with room under its last row. Rather than leave it
     there as a hole at the foot of the sheet, the rows and the gaps between
     sections stretch into it (up to FIT.spreadMax of what they need), and
     what is still left after that is split above and below the block so the
     sheet reads as laid out rather than as run out. A page that is already
     full solves stretch = 1 and no offset, so nothing about a normal script
     moves. Team HEADINGS are left out of the stretch: a heading band is type,
     not space, and stretching it would just push the name off its rule. */
  pages.forEach((page) => {
    page.header = pageHasHeader(page.index);
    page.topEm = topFor(page.index);
    const gapCount = Math.max(0, page.sections.length - 1);
    const fixedEm = page.sections.reduce((a, m) => a + (m.head || 0), 0);
    const flexEm = page.sections.reduce((a, m) => a + m.need - (m.head || 0), 0) +
      gapCount * SHEET.sectionGap;
    const roomEm = availFor(page.index) / d;
    const stretch = flexEm > 0.01
      ? clamp((roomEm - fixedEm) / flexEm, 1, FIT.spreadMax) : 1;
    const gapEm = SHEET.sectionGap * stretch;
    const spareEm = Math.max(0, roomEm - fixedEm - flexEm * stretch);
    page.stretch = stretch;
    let cursorPx = topFor(page.index) * U + ed(spareEm * FIT.topShare);
    page.sections.forEach((m, i) => {
      const topPx = cursorPx;
      const headEmSec = m.head || 0;
      const rowsNeed = (m.need - headEmSec) * stretch;
      const heightPx = ed(rowsNeed + headEmSec);
      m.gapAboveEm = i ? gapEm : SHEET.sectionGap;
      m.gapBelowEm = gapEm;
      cursorPx += heightPx + ed(gapEm);
      m.topPx = topPx;
      m.heightPx = heightPx;
      m.headPx = ed(headEmSec);
      const rows = layoutEven ? null : m.rowHeights.map((h) => h * stretch);
      m.leftHeights = layoutEven ? dealEven(m.leftNeeds, rowsNeed) : rows;
      m.rightHeights = layoutEven
        ? dealEven(m.rightNeeds, rowsNeed)
        : rows.slice(m.shift ? 1 : 0);
      m.leftNatural = layoutEven ? m.leftNeeds : m.rowHeights;
      m.rightNatural = layoutEven ? m.rightNeeds : m.rowHeights.slice(m.shift ? 1 : 0);
      m.rowsTopPx = topPx + m.headPx;
      m.rightTopPx = ((!layoutEven && m.shift) ? topPx + ed(rows[0] || 0) : topPx) + m.headPx;
      m.first = i === 0;
    });
  });

  return { pages, d, iconEm, layoutEven, fonts, groups, widthMul };
}

/* ── one page ─────────────────────────────────────────────────────────── */
export function renderSheetPage(script, options, layout, pageIndex, ctx) {
  ctx = ctx || {};
  const requestRender = ctx.requestRender;
  const selected = ctx.selected || '';
  const page = layout.pages[Math.min(pageIndex, layout.pages.length - 1)];
  const { d, iconEm, fonts } = layout;
  const ed = (em) => em * U * d; // density-scaled px
  const e = (em) => em * U; // fixed px
  const isLastPage = pageIndex === layout.pages.length - 1;

  const title = (options.titleOverride || '').trim() || script.meta.name;
  const author = ((options.authorOverride || '').trim() || script.meta.author || '').trim();
  const hasNightStar = script.characters.some((c) => c.ability.includes('night*'));
  const widthMul = layout.widthMul || options.columnWidth || 1;
  const colWPct = SHEET.textOffsetX + SHEET.textWidth * widthMul;

  const sheet = pageFrame(SHEET_W, SHEET_H, U, 'script-sheet');
  sheet.dataset.fsPage = String(pageIndex);
  // the density auto-fit actually solved for — the page reads this to show
  // it on the (always live) density slider
  sheet.dataset.fsDensity = d.toFixed(3);

  const mark = (node, id) => {
    node.dataset.fsDrag = id;
    if (id === selected) markSelected(node);
    return node;
  };

  // background: the baked parchment (texture + garland), or what was chosen
  const scriptBg = script.meta.background ? proxied(script.meta.background, options.proxyIcons) : '';
  const gaT = elGet(options, 'garland');
  // the ribbon's right edge (% of width): everything that sits on the ribbon
  // or meets it follows this rather than the reference's fixed numbers
  const ribW = clamp(Number(options.sidebarWidth) || 1, 0.6, 1.4);
  const RIB = (SHEET.sidebarX + SHEET.sidebarW) * ribW;
  for (const n of renderBackground(options.bg, 'front', { scriptBg, noGarland: !!gaT.src || gaT.hidden, squeezeLeft: ribW })) sheet.append(n);
  // stickers marked "behind" sit under the sheet's own content: painting
  // order is DOM order among positioned elements, so they go in here
  for (const n of renderStickers(ctx.stickers, selected, 'back')) sheet.append(n);

  // a garland picked from the pack, in the painted one's place: its oval
  // centred where the footnote sits, as wide as the painted one
  const garland = gaT.src === NO_ART ? '' : resolveSrc(gaT.src);
  if (garland && !gaT.hidden) {
    const gEl = img(garland, {
      position: 'absolute',
      left: (SHEET.footnoteCX + gaT.dx) + '%',
      bottom: px(-e(gaT.dy)),
      width: (88 * gaT.scale) + '%',
      // the pack's ovals sit about 54% across; an upload is centred
      transform: `translateX(-${garlandShift(gaT.src)}%)${gaT.rot ? ` rotate(${gaT.rot}deg)` : ''}`,
      opacity: String(gaT.opacity),
    });
    gEl.crossOrigin = 'anonymous';
    sheet.append(mark(gEl, 'el:garland'));
  }

  /* ── the ribbon ──
     The ribbon art is FULL-BLEED: it spans from the sheet's left edge to
     the strip's right edge (sidebarX + sidebarW) over the full height. It
     used to be drawn inset at sidebarX/sidebarY like the handoff, which
     left the parchment's black frame showing as a bare gap along the top,
     left and bottom — invisible against the navy art, glaring the moment
     the ribbon was recoloured. sidebarX/sidebarW still position the LABELS.

     The art is FLAT damask, and the parchment frame's shading is a
     SEPARATE overlay (sidebar-shade.png: black, alpha = 1 - the parchment
     column's normalized luminance) drawn over it at `sidebarShade`. Baking
     that shading into the ribbon put a hard left-to-right lightness ramp
     through it — barely readable in navy, an obvious band in any other
     colour — so the default is 0 (a solid, even ribbon) and the slider
     dials the old blend back in; at 1 it reproduces the baked composite
     exactly, because opacity over black IS the multiply that baked it. */
  const sbT = elGet(options, 'sidebar');
  if (!sbT.hidden) {
    appendRibbon(sheet, {
      mode: options.sidebarMode || 'damask',
      color: options.sidebarColor,
      src: resolveSrc(sbT.src),
      opacity: sbT.opacity,
      shade: options.sidebarShade,
      contrast: options.sidebarContrast,
      widthPct: RIB,
    }, { requestRender, forExport: ctx.forExport });
    // the gold edge, top to bottom. ribbon-edge.png is the parchment's own
    // band (cut where it is brightest and mirrored out to the full height,
    // darkened with the paper's vignette); its third column is where the
    // reference ribbon ends
    if (options.ribbonEdge !== false && options.sidebarMode !== 'none') {
      sheet.append(img(ART + 'ribbon-edge.png', {
        position: 'absolute', left: (RIB - 0.121) + '%', top: '0', width: '1.532%', height: '100%',
        objectFit: 'fill', opacity: String(sbT.opacity),
      }));
    }
  }
  // middle-layer stickers: over the ribbon and the paper's art, under the words
  for (const n of renderStickers(ctx.stickers, selected, 'mid')) sheet.append(n);

  /* ── header band ── */
  if (page.header) {
    const skT = elGet(options, 'skull');
    const flLT = elGet(options, 'fll');
    const flRT = elGet(options, 'flr');
    const tT = elGet(options, 'title');
    const aT = elGet(options, 'author');
    /* header decor geometry (movable / scalable). Verticals are settled
       here; the HORIZONTAL positions set below are only the calibrated
       full-width fallback — fitTitle() re-places the skull and flourishes
       against the title's measured width so they come in to meet a short
       name (see the hug pass there). */
    const skullW = SHEET.skullW * skT.scale;
    const skullLeft = SHEET.skullX + (SHEET.skullW - skullW) / 2 + skT.dx;
    const skullTop = SHEET.skullY + (SHEET.skullH * (1 - skT.scale)) / 2 + skT.dy;
    const flLW = SHEET.flLW * flLT.scale;
    const flLLeft = SHEET.flLX + SHEET.flLW - flLW + flLT.dx;
    const flLTop = SHEET.flLY + (SHEET.flLH * (1 - flLT.scale)) / 2 + flLT.dy;
    const flRW = SHEET.flRW * flRT.scale;
    const flRLeft = SHEET.flRX + flRT.dx;
    const flRTop = SHEET.flRY + (SHEET.flRH * (1 - flRT.scale)) / 2 + flRT.dy;

    if (options.showSkull && !skT.hidden) {
      /* The stock skull is cut from the reference sheet WITH its patch of
         parchment, a full rectangle. On any background but the calibrated
         one (a vignette, the grimy top edge, another paper) that patch read
         as a pale box behind the skull, so its edges are faded into the
         page. An uploaded replacement is drawn as it is. */
      const feather = resolveSrc(skT.src) ? '' : 'radial-gradient(ellipse 50% 50% at 50% 54%, #000 62%, transparent 100%)';
      const skullEl = img(resolveSrc(skT.src) || ART + 'skull.png', {
        position: 'absolute', left: skullLeft + '%', top: px(e(skullTop)), width: skullW + '%',
        opacity: String(skT.opacity), transform: skT.rot ? `rotate(${skT.rot}deg)` : '',
        maskImage: feather, webkitMaskImage: feather,
      });
      skullEl.dataset.fsDecor = 'skull';
      if (resolveSrc(skT.src)) skullEl.crossOrigin = 'anonymous';
      sheet.append(mark(skullEl, 'el:skull'));
    }
    if (options.showFlourishes) {
      if (!flLT.hidden) {
        const flLEl = img(resolveSrc(flLT.src) || ART + 'flourish-left.png', {
          position: 'absolute', left: flLLeft + '%', top: px(e(flLTop)), width: flLW + '%',
          opacity: String(flLT.opacity), transform: flLT.rot ? `rotate(${flLT.rot}deg)` : '',
        });
        flLEl.dataset.fsDecor = 'fll';
        sheet.append(mark(flLEl, 'el:fll'));
      }
      if (!flRT.hidden) {
        const flREl = img(resolveSrc(flRT.src) || ART + 'flourish-right.png', {
          position: 'absolute', left: flRLeft + '%', top: px(e(flRTop)), width: flRW + '%',
          opacity: String(flRT.opacity), transform: flRT.rot ? `rotate(${flRT.rot}deg)` : '',
        });
        flREl.dataset.fsDecor = 'flr';
        sheet.append(mark(flREl, 'el:flr'));
      }
    }

    // title: an uploaded title image, else the script's logo when provided,
    // else the swash text title
    if (!tT.hidden) {
      const titleArt = titleArtOf(script, options);
      if (titleArt) {
        const logoEl = img(titleArt, {
          position: 'absolute',
          left: (SHEET.titleCX + tT.dx) + '%',
          top: px(e(SHEET.titleCY + tT.dy)),
          transform: `translate(-50%, -50%)${tT.rot ? ` rotate(${tT.rot}deg)` : ''}`,
          maxWidth: px(0.4911 * SHEET_W * tT.scale),
          maxHeight: px(e(artMaxHEm(options, tT))),
          objectFit: 'contain',
          opacity: String(tT.opacity),
          filter: `drop-shadow(${e(0.09)}px ${e(0.13)}px ${e(0.11)}px rgba(40, 26, 10, 0.45))`,
        }, title);
        logoEl.dataset.fsTbox = '1';
        logoEl.crossOrigin = 'anonymous';
        // the logo's width is only known once it loads — re-hug the decor then
        logoEl.addEventListener('load', () => {
          // first sight of this image: lay the header out again on its shape
          if (!artAspect.has(titleArt) && logoEl.naturalHeight) {
            artAspect.set(titleArt, logoEl.naturalWidth / logoEl.naturalHeight);
            if (requestRender) { requestRender(); return; }
          }
          fitTitle(sheet, options);
        });
        logoEl.addEventListener('error', () => {
          failedArt.add(titleArt);
          if (requestRender) requestRender();
        });
        sheet.append(mark(logoEl, 'el:title'));
      } else {
        const titleEl = el('div', {
          position: 'absolute',
          left: (SHEET.titleCX + tT.dx) + '%',
          top: px(e(SHEET.titleCY + tT.dy)),
          transform: `translate(-50%, -50%)${tT.rot ? ` rotate(${tT.rot}deg)` : ''}`,
          fontFamily: fonts.title,
          fontSize: px(e(8.35) * tT.scale),
          lineHeight: '1',
          whiteSpace: 'nowrap',
          wordSpacing: (options.fontTitle || 'unlovable') === 'unlovable' ? '-0.21em' : '0',
          opacity: String(tT.opacity),
          mixBlendMode: 'multiply',
        }, swashTitle(title, options, e(0.11), e(0.13)));
        titleEl.dataset.fsTitle = String(e(8.35) * tT.scale);
        titleEl.dataset.fsTbox = '1';
        sheet.append(mark(titleEl, 'el:title'));
      }
    }

    // author credit, hand-set beneath the title
    if (options.showAuthor && author && !aT.hidden) {
      const authorEl = el('div', {
        position: 'absolute',
        left: (SHEET.titleCX + tT.dx + aT.dx) + '%',
        top: px(e(authorCYEm(script, options))),
        transform: `translate(-50%, -50%)${aT.rot ? ` rotate(${aT.rot}deg)` : ''}`,
        fontFamily: fonts.author,
        fontStyle: 'italic',
        fontSize: px(e(1.42) * aT.scale),
        letterSpacing: '0.05em',
        color: options.authorColor || '#5a4632',
        opacity: String(aT.opacity),
        mixBlendMode: 'multiply',
        whiteSpace: 'nowrap',
      }, (options.authorPrefix == null ? 'by ' : options.authorPrefix) + smartTypography(author));
      authorEl.dataset.fsAuthor = '1';
      sheet.append(mark(authorEl, 'el:author'));
    }
  }

  /* ── team sections ── */
  const cT = elGet(options, 'content');
  const c1T = elGet(options, 'col1');
  const c2T = elGet(options, 'col2');
  const lT = elGet(options, 'labels');
  const dvT = elGet(options, 'dividers');
  const contentWrap = el('div', {
    position: 'absolute', inset: '0',
    opacity: String(cT.opacity),
    display: cT.hidden ? 'none' : 'block',
  });
  applyEl(contentWrap, { ...cT, opacity: 1, hidden: false, scale: 1 }, '', U, SHEET_W);
  if (cT.scale !== 1) {
    contentWrap.style.transformOrigin = '50% 0';
    contentWrap.style.transform = (contentWrap.style.transform || '') + ` scale(${cT.scale})`;
  }
  contentWrap.dataset.fsEl = 'content';
  contentWrap.style.pointerEvents = 'none'; // only the rows themselves grab the pointer
  /* the ribbon labels and the dividers' ribbon ends belong to the RIBBON,
     so they are drawn outside the grid: they follow it down the page (its
     Vertical offset and Size, scaled from its top) but stay on the ribbon
     across it. Inside it, sizing the grid walked them off the ribbon. */
  const ribbonLayer = el('div', { position: 'absolute', inset: '0', pointerEvents: 'none', display: cT.hidden ? 'none' : 'block' });
  const cs = cT.scale || 1;
  const cy = (y) => e(cT.dy) + cs * y;

  page.sections.forEach((sec, si) => {
    const { team, chars, left, right, leftHeights, rightHeights, rightTopPx, topPx, heightPx } = sec;
    const rowsTopPx = sec.rowsTopPx != null ? sec.rowsTopPx : topPx;
    const wrap = el('div');

    // divider above every section except the first, plus the cap on the
    // ribbon. divider-taper.png is drawn to the official sheet's shape —
    // a hairline with a small knot where it meets the ribbon, near-constant
    // thickness, fading to fully transparent by the right end (the old
    // spindle art was thin at both ends and fat in the middle, which is
    // not how the print rules them). One multiply pass; the colour and the
    // fade are baked into the art's alpha.
    if (si > 0 && options.showDividers && !dvT.hidden) {
      const divH = 0.5 * dvT.scale;
      // the rule rides just under the top of its section, so a gap that
      // stretched to fill the page carries it along instead of leaving it
      // stranded at the old pitch above
      const gapAbove = sec.gapAboveEm != null ? sec.gapAboveEm : SHEET.sectionGap;
      const divTop = topPx - ed(gapAbove) +
        ed(0.7962 * (gapAbove / SHEET.sectionGap) - divH / 2) + e(dvT.dy);
      const op = String(clamp((options.dividerOpacity == null ? 1 : options.dividerOpacity) * dvT.opacity, 0, 1));
      // a divider from the pack keeps its own shape: a thin line stretches
      // like the built-in one, an ornament is drawn at its own proportions
      const pick = artChoice(dvT.src);
      const pickH = pick && pick.h ? pick.h * dvT.scale : divH;
      const ruleL = RIB - 0.455; // the knot sits just inside the ribbon's edge
      ribbonLayer.append(img(resolveSrc(dvT.src) || ART + 'divider-taper.png', {
        position: 'absolute', left: (ruleL + dvT.dx) + '%', top: px(cy(divTop + ed(divH - pickH) / 2)),
        width: (97.65 - ruleL) + '%', height: px(cs * ed(pickH)),
        objectFit: pick && pick.fit === 'contain' ? 'contain' : 'fill', mixBlendMode: 'multiply', opacity: op,
      }));
      if (!dvT.src) ribbonLayer.append(img(ART + 'divider-cap.png', {
        position: 'absolute', left: (2.337 * ribW + dvT.dx) + '%', top: px(cy(divTop)),
        width: (6.26 * ribW) + '%', height: px(cs * ed(divH * 0.56)),
        objectFit: 'fill', opacity: op,
        marginTop: px(cs * ed(divH * 0.22)),
      }));
    }

    // the team's name as a heading over the section (labelStyle heading/both)
    const labelText = ((options.teamLabels && options.teamLabels[team] || '').trim() ||
      (sec.total === 1 ? TEAM_LABELS_SINGULAR[team] : TEAM_LABELS[team])).toUpperCase() +
      (options.labelCounts ? ' · ' + sec.total : '');
    const labelStyle = options.labelStyle || 'ribbon';
    if (options.showLabels && sec.head && !lT.hidden) {
      wrap.append(el('div', {
        position: 'absolute',
        left: (SHEET.col1IconX + c1T.dx) + '%',
        top: px(topPx + ed(0.35)),
        fontFamily: fonts.label,
        fontSize: px(ed(1.55) * (options.labelSize || 1) * lT.scale),
        lineHeight: '1',
        letterSpacing: '0.14em',
        color: options.headingColor || teamColor(options, team),
        opacity: String(lT.opacity),
        mixBlendMode: 'multiply',
        whiteSpace: 'nowrap',
      }, labelText));
    }

    // sidebar label, centred on the section span including the trailing gap
    // (last section: down to 87.5 em); singular when the section holds one
    if (options.showLabels && !lT.hidden && labelStyle !== 'heading') {
      const label = labelText;
      const baseFs = e(SHEET.labelSize) * (options.labelSize || 1) * lT.scale;
      const isLast = si === page.sections.length - 1;
      /* The band a label is centred on and shrinks to fit: its own section
         plus the trailing gap. The LAST section owns the ribbon on down to
         the garland — but only ever as a BONUS. Taking that run as the band
         outright measured it from a fixed bottom (87.5 em) against a top
         that moves with the density, so the last label shrank as the sheet
         filled and the span went NEGATIVE once the rows reached past 87.5
         em (any density above the auto fit) — flooring the last label at
         the minimum whatever it said. It is positional, not a long-word
         problem: a five-letter LORIC collapsed exactly like TRAVELLERS did. */
      const ownH = heightPx + ed(sec.gapBelowEm != null ? sec.gapBelowEm : SHEET.sectionGap);
      /* and only ever a bonus: on a page the content does not reach the
         foot of, that run down to the garland is mostly empty ribbon, and
         centring the label on it walked the word away from the rows it
         names — a three-character script printed OUTSIDER halfway down a
         blank sheet. The band may reach past its own height, but not by
         more than its own height again. */
      const spanH = isLast
        ? clamp(footEm(87.5) * U - topPx, ownH, ownH * 2) : ownH;
      // upright vertical letters advance ≈ font-size (Chromium ignores
      // line-height in vertical-rl/upright) — shrink-to-fit uses 0.85/letter
      // with room at both ends, or two labels meeting at a divider read as
      // one word ("OUTSIDERSMINIONS")
      const fitFs = (spanH - e(0.9)) / (label.length * 0.85);
      const labelInk = options.labelColor || '#eeeeee';
      const darkInk = isDark(labelInk);
      const glow = darkInk ? 'rgba(250,246,236,0.75)' : 'rgba(34,34,34,0.66)';
      const halo = darkInk ? 'rgba(250,246,236,0.9)' : 'rgba(20,14,8,0.9)';
      const labelEl = el('div', {
        position: 'absolute',
        // the reference's centre (sidebarX + sidebarW/2 + 0.3) as a share of the ribbon
        left: (RIB * (SHEET.sidebarX + SHEET.sidebarW / 2 + 0.3) / (SHEET.sidebarX + SHEET.sidebarW) + lT.dx) + '%',
        top: px(cy(topPx + spanH / 2) + e(lT.dy)),
        transform: 'translate(-50%, -50%)',
        writingMode: 'vertical-rl',
        textOrientation: 'upright',
        fontFamily: fonts.label,
        // the floor gives way before the word runs into the next team's
        // label: on a tightly packed sheet a two-row OUTSIDERS section is
        // shorter than the word at the usual minimum
        fontSize: px(cs * clamp(fitFs, Math.min(e(SHEET.labelSizeMin), Math.max(e(0.45), fitFs)), baseFs)),
        lineHeight: '1',
        letterSpacing: (options.labelSpacing == null ? -0.15 : options.labelSpacing) + 'em',
        color: labelInk,
        opacity: String(lT.opacity),
        // the glow behind the letters is the label colour's opposite: the
        // dark shadows made for the stock white labels smeared a dark label
        // (Ink Saver's) into a blot
        filter: `drop-shadow(0.6px 0.6px 1.8px ${glow}) drop-shadow(-0.6px 0.6px 1.8px ${glow}) drop-shadow(0.6px -0.6px 1.8px ${glow}) drop-shadow(-0.6px -0.6px 1.8px ${glow})`,
        // With the ribbon off the labels sit on the parchment's burnt edge,
        // which is pale in places and dark in others: a halo in the same
        // opposite colour keeps them readable on both
        textShadow: options.sidebarMode === 'none'
          ? `0 0 ${e(0.25)}px ${halo}, 0 0 ${e(0.5)}px ${halo}` : '',
        whiteSpace: 'nowrap',
      }, label);
      ribbonLayer.append(labelEl);
    }

    // columns
    const colL = el('div', {
      position: 'absolute',
      left: (SHEET.col1IconX + c1T.dx) + '%',
      top: px(rowsTopPx + e(c1T.dy)),
      width: colWPct + '%',
      opacity: String(c1T.opacity),
      display: c1T.hidden ? 'none' : 'block',
      pointerEvents: 'auto',
    });
    left.forEach((c, i) => colL.append(
      characterEntry(c, options, leftHeights[i], iconEm, ed, e, fonts, widthMul, mark,
        sec.leftNatural && sec.leftNatural[i]),
    ));
    wrap.append(colL);

    // rightTopPx: same as topPx, except the classic layout's first section,
    // where the title takes the second column's first row slot
    const colR = el('div', {
      position: 'absolute',
      left: (SHEET.col2IconX + c2T.dx) + '%',
      top: px(rightTopPx + e(c2T.dy)),
      width: colWPct + '%',
      opacity: String(c2T.opacity),
      display: c2T.hidden ? 'none' : 'block',
      pointerEvents: 'auto',
    });
    right.forEach((c, i) => colR.append(
      characterEntry(c, options, rightHeights[i], iconEm, ed, e, fonts, widthMul, mark,
        sec.rightNatural && sec.rightNatural[i]),
    ));
    wrap.append(colR);

    contentWrap.append(wrap);
  });
  sheet.append(contentWrap);
  sheet.append(ribbonLayer);

  // "*Not the first night" footnote inside the garland circle
  const fT = elGet(options, 'footnote');
  // a garland from the pack: centred in its oval, wherever it is moved
  const oval = !gaT.hidden && garlandOval(gaT.src, 88, gaT.scale, gaT.dy);
  let footEnd = null; // where the footnote's last line ends, for the watermark under it
  if (options.showFootnote && (hasNightStar || (options.footnoteText || '').trim()) &&
      !fT.hidden && (isLastPage || options.footnoteEveryPage)) {
    const custom = (options.footnoteText || '').trim();
    const star = el('span', {
      display: 'inline-block',
      width: px(e(0.819)),
      height: '0',
      lineHeight: '0',
      verticalAlign: 'baseline',
      position: 'relative',
      overflow: 'visible',
    }, img(ART + 'asterisk.png', {
      position: 'absolute',
      left: '0',
      bottom: px(e(0.428)),
      height: px(e(0.705)),
      width: px(e(0.743)),
    }, '*'));
    const footX = SHEET.footnoteCX + (oval ? gaT.dx : 0) + fT.dx;
    const footY = fT.dy + (oval ? footInOval(oval, custom, SHEET.footnoteLine) : footEm(SHEET.footnoteTop));
    footEnd = { x: footX, y: footY + (custom ? custom.split('\n').length : 2) * SHEET.footnoteLine * fT.scale };
    const foot = el('div', {
      position: 'absolute',
      left: footX + '%',
      top: px(e(footY)),
      transform: `translateX(-50%)${fT.rot ? ` rotate(${fT.rot}deg)` : ''}${fT.scale !== 1 ? ` scale(${fT.scale})` : ''}`,
      transformOrigin: '50% 0',
      textAlign: 'center',
      fontFamily: fonts.footnote,
      color: options.footnoteColor || '#786254',
      opacity: String(fT.opacity),
      mixBlendMode: 'multiply',
      fontSize: px(e(1.1964)),
      lineHeight: px(e(SHEET.footnoteLine)),
      whiteSpace: 'nowrap',
    });
    if (custom) {
      const lines = custom.split('\n');
      lines.forEach((ln, i) => {
        const withStar = i === 0 && ln.startsWith('*');
        foot.append(el('div', null, withStar ? star : null, withStar ? ln.slice(1) : ln));
      });
    } else {
      foot.append(el('div', null, star, 'Not the'), el('div', null, 'first night'));
    }
    sheet.append(mark(foot, 'el:footnote'));
  }
  if (ctx.forExport) {
    sheet.append(footEnd ? watermark(footEnd.x, footEnd.y + 0.1, false, 0.95, 0.05)
      : watermark(SHEET.footnoteCX + (oval ? gaT.dx : 0), oval ? (oval.top + oval.bottom) / 2 - 0.5 : footEm(SHEET.footnoteTop) + 1, false, 0.95, 0.05));
  }

  // the rest of the stickers last, over everything
  for (const n of renderStickers(ctx.stickers, selected, 'front')) sheet.append(n);

  return sheet;
}

/* convenience: layout + first page, for callers that only want one sheet */
export function renderSheet(script, options, requestRender, ctx) {
  const layout = layoutSheet(script, options, requestRender);
  return renderSheetPage(script, options, layout, (ctx && ctx.pageIndex) || 0, { ...(ctx || {}), requestRender });
}

/* Two jobs that both need real layout, so the caller runs this AFTER the
   sheet is in the document (and again when the logo image loads):

   1. Shrink the swash title to the band between the skull and the right
      flourish — scrollWidth at the natural size gives the true width in
      one pass, no iteration.

   2. THE HUG PASS: slide the skull (with the left flourish riding along)
      and the right flourish in against the title's measured width, the way
      the official sheets set them — a short name like "Biota" pulls the
      decor in to meet it instead of leaving it stranded at the calibrated
      full-width positions. The three inset constants below are derived
      from the calibration itself (skull overlaps the title box's left
      bearing by 1.49%, the left flourish tucks 1.24% under the skull, the
      right flourish starts 0.58% inside the title box), so a title at the
      full band width reproduces the reference positions exactly. Switched
      off by options.hugDecor, every piece stays at its calibrated place
      (plus whatever it was dragged by). */
export function fitTitle(sheet, options) {
  const titleEl = sheet.querySelector('[data-fs-title]');
  if (titleEl) {
    const naturalFs = Number(titleEl.dataset.fsTitle);
    const bandW = 0.4911 * SHEET_W; // reference title ink width (skull → right swirl)
    titleEl.style.fontSize = px(naturalFs);
    const trueW = titleEl.scrollWidth;
    if (trueW > bandW) titleEl.style.fontSize = px(naturalFs * (bandW / trueW));
  }
  /* In the 'shared' layout the left column's first row sits level with the
     author line, so a long "by …" centred under the title ran into that
     row's ability. Its left edge is kept clear of the column. */
  const authorEl = sheet.querySelector('[data-fs-author]');
  if (authorEl && options && options.columnLayout === 'shared') {
    const sr = sheet.getBoundingClientRect(), ar = authorEl.getBoundingClientRect();
    const colRight = SHEET.col1IconX + SHEET.textOffsetX + SHEET.textWidth * (Number(options.columnWidth) || 1) + 0.6;
    const over = colRight - ((ar.left - sr.left) / sr.width) * 100;
    if (sr.width && ar.width && over > 0) {
      const room = 97 - ((ar.right - sr.left) / sr.width) * 100;
      authorEl.style.left = (parseFloat(authorEl.style.left) + Math.min(over, Math.max(0, room))) + '%';
    }
  }
  if (!options || options.hugDecor === false) return;

  const tbox = sheet.querySelector('[data-fs-tbox]');
  const skullEl = sheet.querySelector('[data-fs-decor="skull"]');
  const flLEl = sheet.querySelector('[data-fs-decor="fll"]');
  const flREl = sheet.querySelector('[data-fs-decor="flr"]');
  if (!tbox) return;
  const sheetRect = sheet.getBoundingClientRect();
  const tRect = tbox.getBoundingClientRect();
  if (!sheetRect.width || !tRect.width) return; // logo not loaded yet
  const tT = elGet(options, 'title');
  const skT = elGet(options, 'skull');
  const flLT = elGet(options, 'fll');
  const flRT = elGet(options, 'flr');
  // rects survive the preview's scale transform because both are scaled alike
  const wPct = (tRect.width / sheetRect.width) * 100;
  const centerPct = SHEET.titleCX + tT.dx;
  const leftPct = centerPct - wPct / 2;
  const rightPct = centerPct + wPct / 2;

  const skullW = SHEET.skullW * skT.scale;
  const flLW = SHEET.flLW * flLT.scale;
  const flRW = SHEET.flRW * flRT.scale;
  // The insets tuck the decor into the swash title's side bearings. A logo
  // or an uploaded title image has no bearings, so the same tuck put the
  // skull on top of the picture; an image is given a small gap instead.
  // Only the built-in skull fades out at its right edge: a picked or
  // uploaded one is drawn to its edge, and the swash overhangs its box, so
  // it gets a wider gap.
  const isImg = tbox.tagName === 'IMG';
  const skullIn = isImg ? -0.6 : skT.src ? -1.4 : 1.49, flRIn = isImg ? -0.6 : 0.58;
  // never ride onto the ribbon, however long the name gets
  const skullLeft = Math.max(9.2, leftPct + skullIn - skullW + skT.dx);
  const flLLeft = skullLeft - skT.dx + 1.24 - flLW + flLT.dx;
  const flRLeft = Math.min(97.65 - flRW, rightPct - flRIn + flRT.dx);
  if (skullEl) skullEl.style.left = skullLeft + '%';
  if (flLEl) flLEl.style.left = flLLeft + '%';
  if (flREl) flREl.style.left = flRLeft + '%';
}
