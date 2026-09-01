/* Fancy Scripts — the back cover.
 *
 * The official journal-back style, replicated from the owner's PSD template
 * ("Clockback"): a damask pattern with a centre glow and heavy edge vignette,
 * and the script title stacked in large LHF Unlovable — gold fill, black
 * stroke, drop shadow — one word to a line at varying sizes.
 *
 * The background is TWO assets extracted from that PSD (art/back-flat.jpg,
 * the pattern with no shading; art/back-shaded.jpg, the exact composite with
 * the glow + vignette in). The shading slider interpolates per pixel between
 * them — 0 is flat, 1 is the template exactly, up to 2 extrapolates darker
 * edges — and any non-default colour is a per-pixel HSL rotate/scale against
 * the template's measured base (BACK_BASE), the same approach as the front
 * sheet's ribbon. Both passes run in one async canvas job, cached per
 * (colour, shading); renderBack() shows the newest canvas it has and asks
 * for a re-render when a fresh one lands.
 *
 * Text elements are plain DOM: two stacked spans per element (a stroked one
 * underneath carrying the drop shadow, a clean fill on top), so the stroke
 * reads as an outside stroke and the shadow is cast by the stroked
 * silhouette — which is how the PSD's layer styles compose. Everything is
 * inline-styled; the element is what html-to-image captures.
 *
 * Browser-only (canvas + DOM) — do not import from the Worker.
 */

import { BACK_BASE } from './script.js';

const ART = '/assets/fancyscripts/art/';

/* the back is the same logical size as the front sheet */
export const BACK_W = 1242;
export const BACK_H = 1656;

/* The PSD is A4 (2480×3508); the sheet is 3:4. The pixel pass crops the A4
   art to 3:4 centred (top and bottom lose ~2.9% each — the vignette is
   symmetric, nothing structural is cut). */
const SRC_W = 2480;
const SRC_H = 3508;
const CROP_H = Math.round(SRC_W * 4 / 3); // 3307
const CROP_Y = Math.round((SRC_H - CROP_H) / 2);

const px = (v) => v + 'px';
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function hexHsl(hex) {
  const m = /^#?([\da-f]{6})$/i.exec(String(hex || ''));
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

/* ── background pipeline ────────────────────────────────────────────────
   One cached canvas per (colour, shading). The default pair is a cheap
   drawImage crop; anything else is a per-pixel pass over ~8M px, run off
   the current frame and swapped in on completion. */
const bk = {
  flat: null, shaded: null, ready: false, loading: false,
  key: '', canvas: null,
  busy: false, want: '', notify: null,
};

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('Could not load ' + src));
    im.src = src;
  });
}

function ensureImages() {
  if (bk.loading) return;
  bk.loading = true;
  Promise.all([loadImage(ART + 'back-flat.jpg'), loadImage(ART + 'back-shaded.jpg')])
    .then(([f, s]) => {
      bk.flat = f; bk.shaded = s; bk.ready = true;
      pumpBack();
    })
    .catch(() => { bk.loading = false; });
}

function cropDraw(img) {
  const c = document.createElement('canvas');
  c.width = SRC_W;
  c.height = CROP_H;
  c.getContext('2d').drawImage(img, 0, CROP_Y, SRC_W, CROP_H, 0, 0, SRC_W, CROP_H);
  return c;
}

function buildBackCanvas(color, shading) {
  const flatC = cropDraw(bk.flat);
  if (shading === 1 && color === BACK_BASE.hex) return cropDraw(bk.shaded);
  const shadC = cropDraw(bk.shaded);
  const ctx = shadC.getContext('2d', { willReadFrequently: true });
  const fctx = flatC.getContext('2d', { willReadFrequently: true });
  const A = ctx.getImageData(0, 0, SRC_W, CROP_H);
  const F = fctx.getImageData(0, 0, SRC_W, CROP_H);
  const a = A.data, f = F.data;
  const t = hexHsl(color) || BACK_BASE;
  const recolor = color.toLowerCase() !== BACK_BASE.hex;
  const dH = t.h - BACK_BASE.h;
  const sRatio = t.s < 0.06 ? 0 : t.s / BACK_BASE.s;
  const lRatio = t.l / BACK_BASE.l;
  for (let i = 0; i < a.length; i += 4) {
    // shading: per-channel lerp flat -> shaded (1 = the template exactly)
    let r = f[i] + (a[i] - f[i]) * shading;
    let g = f[i + 1] + (a[i + 1] - f[i + 1]) * shading;
    let b = f[i + 2] + (a[i + 2] - f[i + 2]) * shading;
    if (recolor) {
      r /= 255; g /= 255; b /= 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      let l = (mx + mn) / 2;
      const d = mx - mn;
      let h = 0, s = 0;
      if (d) {
        s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
        h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
        h *= 60;
      }
      h = (((h + dH) % 360) + 360) % 360;
      s = Math.min(1, s * sRatio);
      l = Math.min(1, l * lRatio);
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
      r = chan(hh + 1 / 3) * 255; g = chan(hh) * 255; b = chan(hh - 1 / 3) * 255;
    }
    a[i] = clamp(Math.round(r), 0, 255);
    a[i + 1] = clamp(Math.round(g), 0, 255);
    a[i + 2] = clamp(Math.round(b), 0, 255);
  }
  ctx.putImageData(A, 0, 0);
  return shadC;
}

function backKey(back) {
  return (back.bgColor || BACK_BASE.hex).toLowerCase() + '|' + Number(back.shading).toFixed(2);
}

/* newest background canvas for these settings, or the best stale one while
   a fresh one is computed (null = nothing yet; a plain colour shows) */
export function backCanvas(back, requestRender) {
  bk.notify = requestRender;
  const key = backKey(back);
  if (bk.key === key && bk.canvas) return bk.canvas;
  bk.want = key;
  ensureImages();
  pumpBack();
  return bk.canvas;
}

function pumpBack() {
  if (bk.busy || !bk.ready || !bk.want || bk.want === bk.key) return;
  bk.busy = true;
  const key = bk.want;
  setTimeout(() => {
    try {
      const [color, shading] = key.split('|');
      bk.canvas = buildBackCanvas(color, Number(shading));
      bk.key = key;
    } catch { bk.want = bk.key; }
    bk.busy = false;
    if (bk.notify) bk.notify();
    pumpBack();
  }, 0);
}

/* everything the current settings need is already cached (export waits on this) */
export function backReady(back) {
  return bk.key === backKey(back) && !!bk.canvas;
}

/* ── the element ──────────────────────────────────────────────────────── */

const FONT_FAMILIES = {
  unlovable: '"LHF Unlovable", "Goudy Text MT", serif',
  goudy: '"Goudy Old Style", "Goudy Bookletter 1911", serif',
  trade: '"Trade Gothic", "Archivo Narrow", sans-serif',
  dumbledor: '"Dumbledor", serif',
};

/* renderBack(script, options, requestRender, {selected}) → .script-back.
   `selected` draws the editing ring on that text element; export renders
   with selected: -1 so the ring can never reach a download. */
export function renderBack(script, options, requestRender, ui) {
  const back = options.back;
  const sel = ui && ui.selected != null ? ui.selected : -1;

  const root = document.createElement('div');
  root.className = 'script-back';
  Object.assign(root.style, {
    position: 'relative',
    width: px(BACK_W),
    height: px(BACK_H),
    overflow: 'hidden',
    background: back.bgColor || BACK_BASE.hex,
    userSelect: 'none',
    fontKerning: 'normal',
  });

  const canvas = backCanvas(back, requestRender);
  if (canvas) {
    Object.assign(canvas.style, {
      position: 'absolute', left: '0', top: '0',
      width: '100%', height: '100%',
    });
    root.append(canvas); // singleton canvas adopted by each new render
  }

  (back.texts || []).forEach((t, i) => {
    const wrap = document.createElement('div');
    wrap.dataset.backIdx = String(i);
    Object.assign(wrap.style, {
      position: 'absolute',
      left: t.x + '%',
      top: t.y + '%',
      transform: `translate(-50%, -50%) rotate(${t.rotate || 0}deg)`,
      fontFamily: FONT_FAMILIES[t.font] || FONT_FAMILIES.unlovable,
      fontSize: px(t.size),
      lineHeight: '1',
      letterSpacing: (t.spacing || 0) + 'em',
      whiteSpace: 'nowrap',
      cursor: 'grab',
      touchAction: 'none',
    });
    const shadow = t.shadowBlur || t.shadowX || t.shadowY
      ? `${t.shadowX || 0}px ${t.shadowY || 0}px ${t.shadowBlur || 0}px ${t.shadowColor || '#000000'}`
      : 'none';
    // stroke layer: centred stroke at double width reads as an outside
    // stroke once the fill covers the inner half; it also casts the shadow,
    // so the shadow silhouette includes the stroke, like the PSD's styles
    const strokeSpan = document.createElement('span');
    Object.assign(strokeSpan.style, {
      position: 'absolute', left: '0', top: '0',
      color: 'transparent',
      textShadow: shadow,
    });
    if (t.strokeW > 0) {
      strokeSpan.style.webkitTextStroke = `${t.strokeW * 2}px ${t.strokeColor || '#000000'}`;
      strokeSpan.style.setProperty('-webkit-text-stroke', `${t.strokeW * 2}px ${t.strokeColor || '#000000'}`);
    }
    strokeSpan.textContent = t.text;
    const fillSpan = document.createElement('span');
    Object.assign(fillSpan.style, {
      position: 'relative',
      color: t.fill || '#bea881',
    });
    if (!(t.strokeW > 0)) strokeSpan.style.textShadow = shadow; // shadow still wants the plain glyph
    fillSpan.textContent = t.text;
    wrap.append(strokeSpan, fillSpan);
    if (i === sel) {
      wrap.style.outline = '2px dashed rgba(255,255,255,0.75)';
      wrap.style.outlineOffset = '6px';
    }
    root.append(wrap);
  });

  return root;
}

/* drag-to-move: the page mounts this once per render on the PREVIEW copy
   (never on an export render). `getScale` maps pointer px to sheet px. */
export function mountBackDrag(root, back, { getScale, onSelect, onChange }) {
  let drag = null;
  root.addEventListener('pointerdown', (ev) => {
    const el = ev.target.closest('[data-back-idx]');
    if (!el) return;
    const idx = Number(el.dataset.backIdx);
    onSelect(idx);
    const t = back.texts[idx];
    drag = { idx, sx: ev.clientX, sy: ev.clientY, x0: t.x, y0: t.y };
    root.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });
  root.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const s = getScale() || 1;
    const t = back.texts[drag.idx];
    if (!t) return;
    t.x = clamp(drag.x0 + ((ev.clientX - drag.sx) / s / BACK_W) * 100, -10, 110);
    t.y = clamp(drag.y0 + ((ev.clientY - drag.sy) / s / BACK_H) * 100, -10, 110);
    onChange();
  });
  const end = () => { drag = null; };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);
}
