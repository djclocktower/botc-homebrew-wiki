/* Fancy Scripts — shared helpers for the page renderers.
 *
 * DOM builders, colour math and the word-wrap measurer that sheet.js,
 * night.js, back.js and elements.js all need. Browser-only (canvas + DOM);
 * script.js stays pure and imports nothing from here.
 */

export const px = (v) => v + 'px';
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* tiny element builder: tag, style object, then children (nodes/strings) */
export function el(tag, style, ...children) {
  const n = document.createElement(tag);
  if (style) Object.assign(n.style, style);
  for (const c of children) {
    if (c == null) continue;
    n.append(c);
  }
  return n;
}

export function img(src, style, alt) {
  const n = document.createElement('img');
  n.src = src;
  n.alt = alt || '';
  n.draggable = false;
  n.decoding = 'async';
  if (style) Object.assign(n.style, style);
  return n;
}

/* ── colour ──────────────────────────────────────────────────────────── */
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r, g, b) {
  const to = (v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}

/* hex → {h (deg), s, l} */
export function hexHsl(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
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

export function hslToHex(h, s, l) {
  h = (((h % 360) + 360) % 360) / 360;
  s = clamp(s, 0, 1); l = clamp(l, 0, 1);
  const chan = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r, g, b;
  if (!s) r = g = b = l;
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = chan(p, q, h + 1 / 3);
    g = chan(p, q, h);
    b = chan(p, q, h - 1 / 3);
  }
  return rgbToHex(r * 255, g * 255, b * 255);
}

/* HSL lightness shift for building embossed title gradients from any colour */
export function shade(hex, dl) {
  const c = hexHsl(hex);
  if (!c) return hex;
  return hslToHex(c.h, c.s, c.l + dl);
}

/* is this colour dark enough that light text should sit on it? */
export function isDark(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return true;
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 < 0.55;
}

/* ── text measurement ──────────────────────────────────────────────────
   Word-wrap line counts are computed with canvas measureText in the real
   fonts, which is what lets the layout know a row's height before it is
   drawn. Memoised: a slider drag re-measures the same 25 abilities sixty
   times a second otherwise, and measureText is the one cost in a render
   that scales with the script. The cache is dropped when the fonts
   arrive (fontsChanged()), since every width moves then. */
let measureCtx = null;
let wrapCache = new Map();
const WRAP_CACHE_MAX = 6000;

function ctx2d() {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  return measureCtx;
}

export function fontsChanged() {
  wrapCache = new Map();
  widthCache = new Map();
}

let widthCache = new Map();
export function textWidth(text, font) {
  const key = font + '' + text;
  let w = widthCache.get(key);
  if (w == null) {
    const c = ctx2d();
    if (!c) return text.length * 8;
    c.font = font;
    w = c.measureText(text).width;
    if (widthCache.size > WRAP_CACHE_MAX * 4) widthCache = new Map();
    widthCache.set(key, w);
  }
  return w;
}

/* how many lines `text` takes at `maxW` px in `font` (a CSS font shorthand) */
export function wrappedLineCount(text, font, maxW) {
  if (!text || !text.trim()) return 1;
  const key = font + '' + Math.round(maxW) + '' + text;
  const hit = wrapCache.get(key);
  if (hit != null) return hit;
  const words = text.split(/\s+/).filter(Boolean);
  let lines = 1;
  let line = '';
  for (const w of words) {
    const trial = line ? line + ' ' + w : w;
    if (line && textWidth(trial, font) > maxW) {
      lines++;
      line = w;
    } else {
      line = trial;
    }
  }
  if (wrapCache.size > WRAP_CACHE_MAX) wrapCache = new Map();
  wrapCache.set(key, lines);
  return lines;
}

/* the same for text made of runs in different fonts — the night sheet's
   reminders mix Trade Gothic with bold condensed info tokens. `runs` is
   [{s, font}] (a run may hold several words); `gap` is the width of one
   space in the base font. */
export function wrappedRunLineCount(runs, maxW, baseFont) {
  const key = runs.map((r) => r.font + '' + r.s).join('') + '' + Math.round(maxW);
  const hit = wrapCache.get(key);
  if (hit != null) return hit;
  const space = textWidth(' ', baseFont);
  let lines = 1;
  let x = 0;
  let pendingSpace = false;
  for (const r of runs) {
    const parts = r.s.split(/(\s+)/);
    for (const p of parts) {
      if (!p) continue;
      if (/^\s+$/.test(p)) { pendingSpace = true; continue; }
      const w = textWidth(p, r.font);
      const need = (pendingSpace && x > 0 ? space : 0) + w;
      if (x > 0 && x + need > maxW) {
        lines++;
        x = w;
      } else {
        x += need;
      }
      pendingSpace = false;
    }
  }
  if (wrapCache.size > WRAP_CACHE_MAX) wrapCache = new Map();
  wrapCache.set(key, lines);
  return lines;
}

/* ── icon ink normalization ─────────────────────────────────────────────
   Source icon files have wildly inconsistent transparent padding (official
   and homebrew alike). Measure each icon's alpha bounding box once and
   scale/recentre so every icon's INK occupies the same visual size. */
export const ICON_IDENTITY = { s: 1, dx: 0, dy: 0 };
const iconInkCache = new Map();
const iconInkPending = new Set();

export function iconFit(url) {
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

export function normalizeIcons(urls, requestRender) {
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

export const inkTransform = (f) =>
  `translate(${(f.dx * 100).toFixed(2)}%, ${(f.dy * 100).toFixed(2)}%) scale(${f.s.toFixed(3)})`;

/* the CSS filter for an icon: its drop shadow at `strength` and the chosen
   effect. Returned as one string so every icon on every page agrees. */
export function iconFilter(effect, strength, ed) {
  const f = [];
  if (effect === 'grayscale') f.push('grayscale(1)');
  else if (effect === 'sepia') f.push('sepia(0.75) saturate(0.9)');
  else if (effect === 'engraved') f.push('grayscale(1) contrast(1.35) brightness(0.92)');
  else if (effect === 'vivid') f.push('saturate(1.35) contrast(1.08)');
  if (strength > 0) {
    const a = clamp(0.42 * strength, 0, 0.9);
    f.push(`drop-shadow(${ed(0.05)}px ${ed(0.13 * strength)}px ${ed(0.2 * strength)}px rgba(32, 20, 8, ${a.toFixed(2)}))`);
  }
  return f.join(' ') || 'none';
}

/* a stable 32-bit hash for cache keys */
export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
