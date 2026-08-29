/* Fancy Scripts — the sheet renderer.
 *
 * Vanilla-DOM port of the handoff's ScriptSheet component: builds one
 * .script-sheet element (1242×1656 CSS px, the 3:4 reference trim) from a
 * parsed script + options. Everything is inline-styled with the calibrated
 * values from script.js's SHEET — this element is also what the PNG/PDF
 * export captures, so its pixels ARE the product; nothing about it may
 * depend on the page's stylesheet.
 *
 * Two async loops feed back into rendering, and both go through the caller's
 * requestRender callback instead of touching the DOM they built:
 *   - icon ink normalization: every icon's alpha bounding box is measured
 *     once (cached per url) and the artwork scaled/recentred so all icons
 *     carry the same visual weight, like the hand-laid official sheets;
 *   - fonts: ability word-wrap and the title width are measured with canvas/
 *     layout, so the caller re-renders once document.fonts.ready resolves.
 *
 * fitTitle(el) must be called after the element is in the document: the
 * swash title shrinks to the band between the skull and the right flourish,
 * and that needs real layout. Browser-only (canvas + DOM) — do not import
 * from the Worker.
 */

import {
  SHEET, SHEET_W, SHEET_H, U, SIDEBAR_BASE,
  TEAM_LABELS, TEAM_LABELS_SINGULAR, PLACEHOLDER_ICON,
  groupByTeam, splitColumns, proxied, smartTypography,
} from './script.js';

const ART = '/assets/fancyscripts/art/';

const FONT_TITLE = '"LHF Unlovable", "Goudy Text MT", serif';
const FONT_SIDEBAR = '"Dumbledor", "Hallowen", "Pirata One", serif';
const FONT_NAME = '"Goudy Old Style", "Goudy Bookletter 1911", serif';
const FONT_ABILITY = '"Trade Gothic", "Archivo Narrow", sans-serif';

const EVIL_TEAMS = ['minion', 'demon'];
const NEUTRAL_TEAMS = ['traveller', 'fabled', 'loric'];

/* warm printer's ink for body text — multiplied into the parchment grain */
const INK = '#222222';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const px = (v) => v + 'px';

/* tiny element builder: tag, style object, then children (nodes/strings) */
function el(tag, style, ...children) {
  const n = document.createElement(tag);
  if (style) Object.assign(n.style, style);
  for (const c of children) {
    if (c == null) continue;
    n.append(c);
  }
  return n;
}

function img(src, style, alt) {
  const n = document.createElement('img');
  n.src = src;
  n.alt = alt || '';
  n.draggable = false;
  if (style) Object.assign(n.style, style);
  return n;
}

/* an icon <img> that falls back to the placeholder when its art 404s */
function iconImg(src, style, alt) {
  const n = img(src, style, alt);
  n.crossOrigin = 'anonymous';
  n.addEventListener('error', () => {
    if (n.src !== PLACEHOLDER_ICON) n.src = PLACEHOLDER_ICON;
  });
  return n;
}

/* ── icon ink normalization ─────────────────────────────────────────────
   Source icon files have wildly inconsistent transparent padding (official
   and homebrew alike). Measure each icon's alpha bounding box once and
   scale/recentre so every icon's INK occupies the same visual size. */
const ICON_IDENTITY = { s: 1, dx: 0, dy: 0 };
const iconInkCache = new Map();
const iconInkPending = new Set();

function iconFit(url) {
  return iconInkCache.get(url) || ICON_IDENTITY;
}

function measureInk(image) {
  const nw = image.naturalWidth, nh = image.naturalHeight;
  if (!nw || !nh) return ICON_IDENTITY;
  const w = Math.max(8, Math.min(nw, 140));
  const h = Math.max(8, Math.min(nh, 140));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return ICON_IDENTITY;
  ctx.drawImage(image, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (d[(y * w + x) * 4 + 3] > 26) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return ICON_IDENTITY;
  const maxDim = Math.max(nw, nh);
  const rw = nw / maxDim, rh = nh / maxDim; // object-fit: contain content box
  const fx = ((x1 - x0 + 1) / w) * rw;
  const fy = ((y1 - y0 + 1) / h) * rh;
  const span = Math.max(fx, fy);
  const s = clamp(0.88 / span, 0.85, 1.35);
  const cx = ((x0 + x1 + 1) / 2 / w - 0.5) * rw;
  const cy = ((y0 + y1 + 1) / 2 / h - 0.5) * rh;
  return { s, dx: -cx * s, dy: -cy * s };
}

function normalizeIcons(urls, requestRender) {
  for (const u of urls) {
    if (!u || iconInkCache.has(u) || iconInkPending.has(u)) continue;
    iconInkPending.add(u);
    const image = new Image();
    image.crossOrigin = 'anonymous';
    const done = (fit) => {
      iconInkPending.delete(u);
      iconInkCache.set(u, fit);
      if (requestRender) requestRender();
    };
    image.onload = () => {
      try { done(measureInk(image)); } catch { done(ICON_IDENTITY); }
    };
    image.onerror = () => done(ICON_IDENTITY);
    image.src = u;
  }
}

const inkTransform = (f) =>
  `translate(${(f.dx * 100).toFixed(2)}%, ${(f.dy * 100).toFixed(2)}%) scale(${f.s.toFixed(3)})`;

/* ability text with typographic punctuation and the ornamental asterisk of
   the official sheets */
function abilityNodes(text) {
  const parts = smartTypography(text).split('*');
  const out = [];
  parts.forEach((p, i) => {
    out.push(document.createTextNode(p));
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

/* HSL lightness shift for building embossed title gradients from any colour */
function shade(hex, dl) {
  const m = /^#?([\da-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const rr = ((n >> 16) & 255) / 255, gg = ((n >> 8) & 255) / 255, bb = (n & 255) / 255;
  const mx = Math.max(rr, gg, bb), mn = Math.min(rr, gg, bb);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  let hDeg = 0, sat = 0;
  if (d) {
    sat = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    hDeg = mx === rr ? (gg - bb) / d + (gg < bb ? 6 : 0) : mx === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4;
    hDeg /= 6;
  }
  const nl = clamp(l + dl, 0, 1);
  const hue2rgb = (p, q, tt) => {
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  let r2, g2, b2;
  if (!sat) r2 = g2 = b2 = nl;
  else {
    const q = nl < 0.5 ? nl * (1 + sat) : nl + sat - nl * sat;
    const p = 2 * nl - q;
    r2 = hue2rgb(p, q, hDeg + 1 / 3);
    g2 = hue2rgb(p, q, hDeg);
    b2 = hue2rgb(p, q, hDeg - 1 / 3);
  }
  const to = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
  return '#' + to(r2) + to(g2) + to(b2);
}

/* hex → {h (deg), s, l} for the sidebar recolour ratios */
function hexHsl(hex) {
  const m = /^#?([\da-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  let h = 0, s = 0;
  if (d) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return { h, s, l };
}

/* ── sidebar ribbon recolour ────────────────────────────────────────────
   Re-tint the navy damask strip toward any picked colour — in a CANVAS,
   pixel by pixel in real HSL, not with a CSS hue-rotate filter. The filter
   was tried first and failed exactly where the art is darkest: hue-rotate
   is a linear matrix approximation, and it maps the strip's near-black
   navy (the shadowed edges at the top, bottom and left) to neutral mud,
   so a red ribbon showed un-tinted "missing" bands along those edges.

   Per pixel: hue is ROTATED by the picked colour's offset from the art's
   measured base (SIDEBAR_BASE), and saturation/lightness are scaled by
   ratio against that base — so the damask keeps its own shading and its
   darkest shadow ends up the darkest shade of the picked colour. The
   recolour runs once per picked colour (~2.5M px, cached), asynchronously:
   renderSheet() shows the newest canvas it has and asks for a re-render
   when a fresh one lands, exactly like the icon-ink measurements. */
const sidebarTint = {
  img: null, imgReady: false,
  color: '', canvas: null, // the newest finished recolour
  busy: false, want: '', notify: null,
};

function recolorSidebar(color) {
  const t = hexHsl(color);
  const src = sidebarTint.img;
  const c = document.createElement('canvas');
  c.width = src.naturalWidth;
  c.height = src.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0);
  const im = ctx.getImageData(0, 0, c.width, c.height);
  const d = im.data;
  const dH = t.h - SIDEBAR_BASE.h;
  const sRatio = t.s < 0.06 ? 0 : t.s / SIDEBAR_BASE.s;
  const lRatio = t.l / SIDEBAR_BASE.l;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    let l = (mx + mn) / 2;
    const df = mx - mn;
    let h = 0, s = 0;
    if (df) {
      s = l > 0.5 ? df / (2 - mx - mn) : df / (mx + mn);
      h = mx === r ? (g - b) / df + (g < b ? 6 : 0) : mx === g ? (b - r) / df + 2 : (r - g) / df + 4;
      h *= 60;
    }
    h = (((h + dH) % 360) + 360) % 360;
    s = Math.min(1, s * sRatio);
    l = Math.min(1, l * lRatio);
    // hsl -> rgb
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hh = h / 360;
    const chan = (tt) => {
      if (tt < 0) tt += 1;
      if (tt > 1) tt -= 1;
      if (tt < 1 / 6) return p + (q - p) * 6 * tt;
      if (tt < 1 / 2) return q;
      if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
      return p;
    };
    d[i] = Math.round(chan(hh + 1 / 3) * 255);
    d[i + 1] = Math.round(chan(hh) * 255);
    d[i + 2] = Math.round(chan(hh - 1 / 3) * 255);
  }
  ctx.putImageData(im, 0, 0);
  return c;
}

/* newest recoloured canvas for `color`, or the best stale one while the
   fresh one is computed off this frame (null = show the plain navy art) */
function sidebarTintCanvas(color, requestRender) {
  const st = sidebarTint;
  st.notify = requestRender;
  if (st.color === color && st.canvas) return st.canvas;
  st.want = color;
  if (!st.img) {
    st.img = new Image();
    st.img.onload = () => { st.imgReady = true; pumpSidebarTint(); };
    st.img.src = ART + 'sidebar-full.png';
  } else {
    pumpSidebarTint();
  }
  return st.canvas; // possibly a stale colour — better than flashing navy
}

function pumpSidebarTint() {
  const st = sidebarTint;
  if (st.busy || !st.imgReady || !st.want || st.want === st.color) return;
  st.busy = true;
  const color = st.want;
  // off the current frame, so a drag on the picker stays responsive
  setTimeout(() => {
    try {
      st.canvas = recolorSidebar(color);
      st.color = color;
    } catch { st.want = st.color; }
    st.busy = false;
    if (st.notify) st.notify();
    pumpSidebarTint(); // the wanted colour may have moved on meanwhile
  }, 0);
}

/* shared canvas context for word-wrap measurement of ability text */
let measureCtx = null;
function wrappedLineCount(text, fontPx, maxW) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx || !text.trim()) return 1;
  measureCtx.font = `400 ${fontPx}px ${FONT_ABILITY}`;
  const words = text.split(/\s+/).filter(Boolean);
  let lines = 1;
  let line = '';
  for (const w of words) {
    const trial = line ? line + ' ' + w : w;
    if (line && measureCtx.measureText(trial).width > maxW) {
      lines++;
      line = w;
    } else {
      line = trial;
    }
  }
  return lines;
}

/* title in LHF Unlovable: indigo→near-black gradient fill over a bronze
   offset duplicate. The default colour keeps the reference's exact ramp;
   any other colour gets a two-stop emboss built from itself. */
function swashTitle(text, color, shadowDX, shadowDY) {
  const isDefault = color.toLowerCase() === '#10102e';
  const gradient = isDefault
    ? 'linear-gradient(180deg, #3d3e88 0%, #2c2a70 34%, #141244 55%, #0e0e20 74%, #10102e 100%)'
    : `linear-gradient(-20deg, ${shade(color, 0.18)} 50%, ${shade(color, -0.14)})`;
  const wrap = el('span', { position: 'relative', display: 'inline-block' });
  const back = el('span', {
    position: 'absolute',
    left: '0',
    top: '0',
    color: '#ad9069',
    transform: `translate(${shadowDX}px, ${shadowDY}px)`,
    zIndex: '0',
  }, text);
  back.setAttribute('aria-hidden', 'true');
  const front = el('span', {
    position: 'relative',
    zIndex: '1',
    background: gradient,
    webkitBackgroundClip: 'text',
    backgroundClip: 'text',
    color: 'transparent',
  }, text);
  front.style.setProperty('-webkit-background-clip', 'text');
  wrap.append(back, front);
  return wrap;
}

/* one character row: icon, name (+ jinx partner icons), ability */
function characterEntry(char, color, showJinxes, heightEm, iconEm, textSize, nameSize, ed) {
  const colW = SHEET.textOffsetX + SHEET.textWidth; // column width in % of sheet
  const textLeftPct = (SHEET.textOffsetX / colW) * 100;
  const textWidthPct = (SHEET.textWidth / colW) * 100;
  const abilityTopEff = SHEET.nameTop + (SHEET.abilityTop - SHEET.nameTop) * nameSize;
  const fit = iconFit(char.icon);

  const row = el('div', { position: 'relative', height: px(ed(heightEm)) });

  row.append(iconImg(char.icon, {
    position: 'absolute',
    left: '0',
    top: px(ed((heightEm - iconEm) / 2 + 0.5)),
    width: px(ed(iconEm)),
    height: px(ed(iconEm)),
    objectFit: 'contain',
    transform: inkTransform(fit),
    transformOrigin: 'center',
    filter: `drop-shadow(${ed(0.05)}px ${ed(0.13)}px ${ed(0.2)}px rgba(32, 20, 8, 0.42))`,
  }));

  const nameRow = el('div', {
    position: 'absolute',
    left: textLeftPct + '%',
    top: px(ed(SHEET.nameTop)),
    width: textWidthPct + '%',
    display: 'flex',
    alignItems: 'center',
    gap: px(ed(0.14)),
    fontFamily: FONT_NAME,
    fontWeight: '700',
    fontSize: px(ed(SHEET.nameSize * nameSize)),
    lineHeight: '1',
    color,
    letterSpacing: '0.02em',
    whiteSpace: 'nowrap',
  }, el('span', null, smartTypography(char.name)));

  if (showJinxes) {
    for (const j of char.jinxIcons) {
      const jf = iconFit(j.icon);
      const ji = iconImg(j.icon, {
        height: px(ed(SHEET.jinxSize * nameSize) * 0.72),
        width: px(ed(SHEET.jinxSize * nameSize) * 0.72),
        objectFit: 'contain',
        flexShrink: '0',
        transform: inkTransform(jf),
        transformOrigin: 'center',
        filter: `drop-shadow(${ed(0.03)}px ${ed(0.08)}px ${ed(0.14)}px rgba(32, 20, 8, 0.38))`,
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
    fontFamily: FONT_ABILITY,
    fontWeight: '400',
    fontSize: px(ed(SHEET.abilitySize * textSize)),
    lineHeight: String(SHEET.abilityLine / SHEET.abilitySize),
    color: INK,
    mixBlendMode: 'multiply',
  }, ...abilityNodes(char.ability)));

  return row;
}

/* ── the sheet ──────────────────────────────────────────────────────────
   renderSheet(script, options, requestRender) → the .script-sheet element.
   requestRender is invoked (any number of times) when an async measurement
   lands and the sheet is worth rebuilding. */
export function renderSheet(script, options, requestRender) {
  const groups = groupByTeam(script.characters, options.sortMode);
  const { iconSize, textSize, nameSize } = options;

  // kick off icon ink measurement for anything new
  const urls = new Set();
  script.characters.forEach((c) => {
    urls.add(c.icon);
    c.jinxIcons.forEach((j) => urls.add(j.icon));
  });
  normalizeIcons([...urls], requestRender);

  /* ── measured layout: rows grow to fit wrapped ability text ──
     Constant row pitch like the reference — up to 3 ability lines fit inside
     one pitch; only genuine spill grows a row. fitToContent solves for the
     density that fills contentTop..contentBottom (3 iterations converge). */
  const abilityTopEff = SHEET.nameTop + (SHEET.abilityTop - SHEET.nameTop) * nameSize;
  const maxTextW = (SHEET.textWidth / 100) * SHEET_W;
  const availableEm = SHEET.contentBottom - SHEET.contentTop;
  // the icon must never spill into the text gutter, whatever the density
  const gutterEm = ((SHEET.textOffsetX - 0.05) / 100) * (SHEET_W / U);
  const iconEmFor = (density) => Math.min(SHEET.rowIcon * iconSize, gutterEm / density);

  const rowHeightEm = (char, density) => {
    let need = Math.max(SHEET.rowPitch, iconEmFor(density) + 0.2);
    if (char) {
      const fontPx = SHEET.abilitySize * textSize * U * density;
      const lines = wrappedLineCount(smartTypography(char.ability), fontPx, maxTextW);
      // 0.7 margin keeps 3-line rows inside one pitch (1.0 broke it)
      need = Math.max(need, abilityTopEff + (lines - 1) * SHEET.abilityLine * textSize + 0.7);
    }
    return need;
  };

  const cols = groups.map((g) => {
    const [left, right] = splitColumns(g.characters);
    return { g, left, right };
  });

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
     (firstExtraEm — fixed, because the title does not scale with density). */
  const layoutEven = options.columnLayout !== 'shared';

  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const measure = (density) =>
    cols.map((c, ci) => {
      if (layoutEven) {
        const leftNeeds = c.left.map((ch) => rowHeightEm(ch, density));
        const rightNeeds = c.right.map((ch) => rowHeightEm(ch, density));
        return { leftNeeds, rightNeeds, need: Math.max(sum(leftNeeds), sum(rightNeeds)) };
      }
      const shift = ci === 0 ? 1 : 0;
      const rows = Math.max(c.left.length, c.right.length + shift);
      const rowHeights = [];
      for (let i = 0; i < rows; i++) {
        rowHeights.push(Math.max(
          rowHeightEm(c.left[i], density),
          rowHeightEm(c.right[i - shift], density),
        ));
      }
      return { rowHeights, need: sum(rowHeights) };
    });

  // even layout: clear the title band (title or logo, plus the author line)
  let firstExtraEm = 0;
  if (layoutEven) {
    const bottoms = [];
    if (script.meta.logo && options.useLogo) {
      bottoms.push(SHEET.titleCY + options.titleDY + (9.4 * options.titleSize) / 2);
    } else {
      // the swash title's ink reaches ~3.05 em below its centre at size 1
      bottoms.push(SHEET.titleCY + options.titleDY + 3.05 * options.titleSize);
    }
    const author0 = (options.authorOverride.trim() || script.meta.author || '').trim();
    if (options.showAuthor && author0) bottoms.push(10.8 + options.titleDY + 0.75);
    firstExtraEm = Math.max(0, Math.max(...bottoms) - SHEET.contentTop + 0.35);
  }
  const availEm = availableEm - firstExtraEm;

  let d = options.fitToContent ? 1 : options.density;
  let measured = measure(d);
  if (options.fitToContent) {
    for (let iter = 0; iter < 3; iter++) {
      const neededEm =
        measured.reduce((n, m) => n + m.need, 0) +
        Math.max(0, groups.length - 1) * SHEET.sectionGap;
      const fit = clamp(availEm / neededEm, 0.42, 1.55);
      if (Math.abs(fit - d) < 0.002) { d = fit; break; }
      d = fit;
      measured = measure(d);
    }
  }

  const ed = (em) => em * U * d; // density-scaled px
  const e = (em) => em * U; // fixed px
  const iconEm = iconEmFor(d);

  // deal a section's leftover height evenly between one column's rows
  const dealEven = (needs, needEm) => {
    if (!needs.length) return [];
    const per = (needEm - sum(needs)) / needs.length;
    return needs.map((n) => n + per);
  };

  let cursorPx = (SHEET.contentTop + firstExtraEm) * U;
  const sections = cols.map((c, i) => {
    const m = measured[i];
    const topPx = cursorPx;
    const heightPx = ed(m.need);
    cursorPx += heightPx + ed(SHEET.sectionGap);
    const leftHeights = layoutEven ? dealEven(m.leftNeeds, m.need) : m.rowHeights;
    const rightHeights = layoutEven
      ? dealEven(m.rightNeeds, m.need)
      : m.rowHeights.slice(i === 0 ? 1 : 0);
    return { ...c, leftHeights, rightHeights, rightTopPx: (!layoutEven && i === 0) ? topPx + ed(m.rowHeights[0] || 0) : topPx, topPx, heightPx };
  });

  const nameColor = (team) =>
    EVIL_TEAMS.includes(team) ? options.evilColor
      : NEUTRAL_TEAMS.includes(team) ? '#7a5230'
        : options.goodColor;

  const title = options.titleOverride.trim() || script.meta.name;
  const author = (options.authorOverride.trim() || script.meta.author || '').trim();
  const hasNightStar = script.characters.some((c) => c.ability.includes('night*'));
  const colWPct = SHEET.textOffsetX + SHEET.textWidth;

  // header decor geometry (movable / scalable, inner edges anchored)
  const skullW = SHEET.skullW * options.skullScale;
  const skullLeft = SHEET.skullX + (SHEET.skullW - skullW) / 2 + options.skullDX;
  const skullTop = SHEET.skullY + (SHEET.skullH * (1 - options.skullScale)) / 2 + options.skullDY;
  const flLW = SHEET.flLW * options.flourishScale;
  const flLLeft = SHEET.flLX + SHEET.flLW - flLW - options.flourishSpread;
  const flLTop = SHEET.flLY + (SHEET.flLH * (1 - options.flourishScale)) / 2 + options.flourishDY;
  const flRW = SHEET.flRW * options.flourishScale;
  const flRLeft = SHEET.flRX + options.flourishSpread;
  const flRTop = SHEET.flRY + (SHEET.flRH * (1 - options.flourishScale)) / 2 + options.flourishDY;

  const sheet = el('div', {
    position: 'relative',
    width: px(SHEET_W),
    height: px(SHEET_H),
    fontSize: px(U),
    overflow: 'hidden',
    background: '#d8cdb2',
    userSelect: 'none',
    textRendering: 'optimizeLegibility',
    fontKerning: 'normal',
    fontFeatureSettings: '"kern" 1, "liga" 1',
  });
  sheet.className = 'script-sheet';
  // the density auto-fit actually solved for — the page reads this to show
  // it on the (always live) density slider
  sheet.dataset.fsDensity = d.toFixed(3);

  // baked parchment (texture + garland) and the damask sidebar strip
  sheet.append(img(ART + 'parchment.jpg', {
    position: 'absolute', inset: '0', width: '100%', height: '100%',
  }));
  /* The ribbon art is FULL-BLEED: it spans from the sheet's left edge to
     the strip's right edge (sidebarX + sidebarW) over the full height, with
     the parchment frame's shading baked into it (multiplied in when the
     composite was built — see CLAUDE.md). It used to be drawn inset at
     sidebarX/sidebarY like the handoff, which left the parchment's black
     frame showing as a bare gap along the top, left and bottom — invisible
     against the navy art, glaring the moment the ribbon was recoloured.
     sidebarX/sidebarW still position the LABELS on the strip's damask. */
  const sidebarStyle = {
    position: 'absolute',
    left: '0',
    top: '0',
    width: (SHEET.sidebarX + SHEET.sidebarW) + '%',
    height: '100%',
  };
  const wantsTint = options.sidebarColor &&
    options.sidebarColor.toLowerCase() !== SIDEBAR_BASE.hex && hexHsl(options.sidebarColor);
  const tinted = wantsTint ? sidebarTintCanvas(options.sidebarColor, requestRender) : null;
  if (tinted) {
    // the singleton canvas is adopted by each new sheet; the old sheet is
    // already detached, so moving it is safe
    Object.assign(tinted.style, sidebarStyle);
    sheet.append(tinted);
  } else {
    sheet.append(img(ART + 'sidebar-full.png', sidebarStyle));
  }

  // movable header decor: skull + flourishes
  sheet.append(img(ART + 'skull.png', {
    position: 'absolute', left: skullLeft + '%', top: px(e(skullTop)), width: skullW + '%',
  }));
  sheet.append(img(ART + 'flourish-left.png', {
    position: 'absolute', left: flLLeft + '%', top: px(e(flLTop)), width: flLW + '%',
  }));
  sheet.append(img(ART + 'flourish-right.png', {
    position: 'absolute', left: flRLeft + '%', top: px(e(flRTop)), width: flRW + '%',
  }));

  // title: homebrew logo image when provided, else the swash text title
  if (script.meta.logo && options.useLogo) {
    sheet.append(iconImg(proxied(script.meta.logo, options.proxyIcons), {
      position: 'absolute',
      left: (SHEET.titleCX + options.titleDX) + '%',
      top: px(e(SHEET.titleCY + options.titleDY)),
      transform: 'translate(-50%, -50%)',
      maxWidth: px(0.4911 * SHEET_W * options.titleSize),
      maxHeight: px(e(9.4) * options.titleSize),
      objectFit: 'contain',
      filter: `drop-shadow(${e(0.09)}px ${e(0.13)}px ${e(0.11)}px rgba(40, 26, 10, 0.45))`,
    }, title));
  } else {
    const titleEl = el('div', {
      position: 'absolute',
      left: (SHEET.titleCX + options.titleDX) + '%',
      top: px(e(SHEET.titleCY + options.titleDY)),
      transform: 'translate(-50%, -50%)',
      fontFamily: FONT_TITLE,
      fontSize: px(e(8.35) * options.titleSize),
      lineHeight: '1',
      whiteSpace: 'nowrap',
      wordSpacing: '-0.21em',
      mixBlendMode: 'multiply',
    }, swashTitle(title, options.titleColor, e(0.11), e(0.13)));
    titleEl.dataset.fsTitle = String(e(8.35) * options.titleSize);
    sheet.append(titleEl);
  }

  // author credit, hand-set beneath the title
  if (options.showAuthor && author) {
    sheet.append(el('div', {
      position: 'absolute',
      left: (SHEET.titleCX + options.titleDX) + '%',
      top: px(e(10.8 + options.titleDY)),
      transform: 'translate(-50%, -50%)',
      fontFamily: FONT_NAME,
      fontStyle: 'italic',
      fontSize: px(e(1.42)),
      letterSpacing: '0.05em',
      color: '#5a4632',
      mixBlendMode: 'multiply',
      whiteSpace: 'nowrap',
    }, 'by ' + smartTypography(author)));
  }

  // team sections
  sections.forEach(({ g, left, right, leftHeights, rightHeights, rightTopPx, topPx, heightPx }, si) => {
    const wrap = el('div');

    // divider above every section except the first, plus the cap on the
    // ribbon. divider-taper.png is drawn to the official sheet's shape —
    // a hairline with a small knot where it meets the ribbon, near-constant
    // thickness, fading to fully transparent by the right end (the old
    // spindle art was thin at both ends and fat in the middle, which is
    // not how the print rules them). One multiply pass; the colour and the
    // fade are baked into the art's alpha.
    if (si > 0) {
      const divH = 0.5;
      const divTop = topPx - ed(SHEET.sectionGap) + ed(0.7962 - divH / 2);
      wrap.append(img(ART + 'divider-taper.png', {
        position: 'absolute', left: '8.3%', top: px(divTop),
        width: '89.35%', height: px(ed(divH)),
        objectFit: 'fill', mixBlendMode: 'multiply',
      }));
      wrap.append(img(ART + 'divider-cap.png', {
        position: 'absolute', left: '2.337%', top: px(divTop),
        width: '6.26%', height: px(ed(divH * 0.56)),
        objectFit: 'fill',
        marginTop: px(ed(divH * 0.22)),
      }));
    }

    // sidebar label, centred on the section span including the trailing gap
    // (last section: down to 87.5 em); singular when the section holds one
    const label = (g.characters.length === 1
      ? TEAM_LABELS_SINGULAR[g.team]
      : TEAM_LABELS[g.team]).toUpperCase();
    const baseFs = e(SHEET.labelSize); // official labels: one fixed size
    const isLast = si === sections.length - 1;
    const spanH = isLast ? 87.5 * U - topPx : heightPx + ed(SHEET.sectionGap);
    // upright vertical letters advance ≈ font-size (Chromium ignores
    // line-height in vertical-rl/upright) — shrink-to-fit uses 0.85/letter
    const fitFs = (spanH - e(0.2)) / (label.length * 0.85);
    wrap.append(el('div', {
      position: 'absolute',
      left: (SHEET.sidebarX + SHEET.sidebarW / 2 + 0.3) + '%',
      top: px(topPx + spanH / 2),
      transform: 'translate(-50%, -50%)',
      writingMode: 'vertical-rl',
      textOrientation: 'upright',
      fontFamily: FONT_SIDEBAR,
      fontSize: px(Math.max(8, Math.min(baseFs, fitFs))),
      lineHeight: '1',
      letterSpacing: '-0.15em',
      color: '#eeeeee',
      filter:
        'drop-shadow(0.6px 0.6px 1.8px rgba(34,34,34,0.66)) drop-shadow(-0.6px 0.6px 1.8px rgba(34,34,34,0.53)) drop-shadow(0.6px -0.6px 1.8px rgba(34,34,34,0.66)) drop-shadow(-0.6px -0.6px 1.8px rgba(34,34,34,0.66))',
      whiteSpace: 'nowrap',
    }, label));

    // columns
    const colL = el('div', {
      position: 'absolute',
      left: SHEET.col1IconX + '%',
      top: px(topPx),
      width: colWPct + '%',
    });
    left.forEach((c, i) => colL.append(
      characterEntry(c, nameColor(c.team), options.showJinxes, leftHeights[i], iconEm, textSize, nameSize, ed),
    ));
    wrap.append(colL);

    // rightTopPx: same as topPx, except the classic layout's first section,
    // where the title takes the second column's first row slot
    const colR = el('div', {
      position: 'absolute',
      left: SHEET.col2IconX + '%',
      top: px(rightTopPx),
      width: colWPct + '%',
    });
    right.forEach((c, i) => colR.append(
      characterEntry(c, nameColor(c.team), options.showJinxes,
        rightHeights[i], iconEm, textSize, nameSize, ed),
    ));
    wrap.append(colR);

    sheet.append(wrap);
  });

  // "*Not the first night" footnote inside the garland circle
  if (options.showFootnote && hasNightStar) {
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
    sheet.append(el('div', {
      position: 'absolute',
      left: SHEET.footnoteCX + '%',
      top: px(e(SHEET.footnoteTop)),
      transform: 'translateX(-50%)',
      textAlign: 'center',
      fontFamily: FONT_NAME,
      color: '#786254',
      mixBlendMode: 'multiply',
      fontSize: px(e(1.1964)),
      lineHeight: px(e(SHEET.footnoteLine)),
    },
      el('div', null, star, 'Not the'),
      el('div', null, 'first night'),
    ));
  }

  return sheet;
}

/* Shrink the swash title to the band between the skull and the right
   flourish. Needs the element laid out, so the caller runs this AFTER the
   sheet is in the document — scrollWidth at the natural size gives the true
   width in one pass, no iteration. */
export function fitTitle(sheet) {
  const titleEl = sheet.querySelector('[data-fs-title]');
  if (!titleEl) return;
  const naturalFs = Number(titleEl.dataset.fsTitle);
  const bandW = 0.4911 * SHEET_W; // reference title ink width (skull → right swirl)
  titleEl.style.fontSize = px(naturalFs);
  const trueW = titleEl.scrollWidth;
  if (trueW > bandW) titleEl.style.fontSize = px(naturalFs * (bandW / trueW));
}
