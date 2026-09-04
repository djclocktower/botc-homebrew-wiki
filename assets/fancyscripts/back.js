/* Fancy Scripts — the back cover.
 *
 * The official journal-back style, replicated from the owner's PSD template
 * ("Clockback"): a damask pattern with a centre glow and heavy edge vignette,
 * and the script title stacked in large LHF Unlovable — gold fill, black
 * stroke, drop shadow — one word to a line at varying sizes.
 *
 * The background is BUILT, not baked: a grayscale pattern tile
 * (art/back-pattern2.png — a period-aligned block cut from the owner's
 * high-res swirl texture, illumination-flattened and wrap-blended at the
 * seams so it tiles cleanly) is tiled at the chosen scale and rotation,
 * colorized per pixel in HSL (the CAL constants below were regressed from
 * the template so the default colour reproduces its look) at the chosen
 * strength (a gain on the pattern's depth, pivoting on the tile's mean so
 * the cover's own lightness does not move with it), and multiplied by the
 * template's glow/vignette map (art/back-vignette2.png, luminance ratio
 * encoded 0..2, glow peak = 1.0) raised to the Border-shading strength.
 * The map is BLURRED CLEAN of the template's own damask — the first cut
 * carried it, which painted a soft second pattern layer over the crisp
 * tile and read as "blurry"; the pattern must come from the tile alone.
 * Brightness/saturation multiply in the same pass, and a background
 * gradient swaps the single target colour for a 256-step ramp between two
 * picked colours along an angle.
 *
 * The per-pixel pass (pixel.js's colorizeBack) runs in the pixel WORKER:
 * it is 8 million HSL conversions, which froze the page for the better
 * part of a second on every colour change when it ran here. The main
 * thread only tiles the pattern and stretches the vignette (canvas work
 * the GPU does), hands the two buffers over, and puts the result back.
 * One cached canvas job; renderBack() shows the newest canvas it has and
 * asks for a re-render when a fresh one lands.
 *
 * Text elements are the shared sticker renderer (elements.js): two
 * stacked spans, an outside stroke, a drop shadow, an optional gradient
 * fill. They carry data-fs-drag="back:<index>" and drag.js moves them.
 *
 * Browser-only (canvas + DOM) — do not import from the Worker.
 */

import { BACK_BASE } from './script.js';
import { px, clamp, hexHsl } from './util.js';
import { ART, pageFrame, renderTextElement, renderStickers, resolveSrc, markSelected } from './elements.js';
import { runPixelJob } from './jobs.js';

export const BACK_W = 1242;
export const BACK_H = 1656;

/* working canvas: print-resolution 3:4 */
const SRC_W = 2480;
const SRC_H = 3307;

/* the tile asset is 2134×1067 — two motif periods wide, one tall, kept at
   the source texture's full resolution (period 1067px). ×0.75 draws a motif
   at ~800 canvas px, so patScale 1 is a slight DOWNscale and stays crisp */
const TILE_BASE = 0.75;

/* regressed from the template (see CLAUDE.md): with the default colour,
   shading 1, brightness/saturation 1, the build reproduces its look.
   The lightness pair is NORMALIZED so lA + lB·L_avg = 1 for this tile
   (L_avg 0.447): a picked colour then paints true to its swatch — the
   pattern's midtone in the neutral vignette zone IS the picked lightness —
   instead of ×3ing it into white the moment somebody picks a mid colour
   (the raw regression was lA 3.033, lB 0.489 against a 0.100-lightness
   default; that gain now lives in BACK_BASE's lightness instead, so the
   default render is unchanged). Rebaking the tile changes L_avg — re-do
   the normalization then. */
const CAL = { lA: 0.9327, lB: 0.1504, sC: 0.955, sD: -0.038 };

/* the tile's mean luminance, and therefore the point the CAL pair is
   normalized about (lA + lB·L_AVG = 1). It is also the PIVOT the pattern
   strength turns around: the gain scales each modulation term's deviation
   from this, so the pattern deepens or flattens without the cover's own
   lightness moving. Rebaking the tile changes it — measure the new mean. */
const L_AVG = 0.447;

/* ── background pipeline ──────────────────────────────────────────────── */
const bk = {
  pattern: null, vignette: null, ready: false, loading: false,
  key: '', canvas: null,
  busy: false, want: '', wantParams: null, notify: null,
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
  Promise.all([loadImage(ART + 'back-pattern2.png'), loadImage(ART + 'back-vignette2.png')])
    .then(([p, v]) => {
      bk.pattern = p; bk.vignette = v; bk.ready = true;
      pumpBack();
    })
    .catch(() => { bk.loading = false; });
}

function backParams(back) {
  return {
    c1: hexHsl(back.bgColor) || BACK_BASE,
    c2: hexHsl(back.bgColor2) || BACK_BASE,
    grad: !!back.bgGradient,
    gradAngle: Number(back.bgGradAngle) || 0,
    bright: clamp(Number(back.brightness) || 1, 0.1, 3),
    sat: clamp(Number(back.saturation ?? 1), 0, 3),
    shading: clamp(Number(back.shading ?? 1), 0, 2),
    patScale: clamp(Number(back.patScale) || 1, 0.2, 5),
    patRot: Number(back.patRot) || 0,
    patStrength: clamp(Number(back.patStrength ?? 1), 0, 6),
    CAL, L_AVG,
  };
}

function backKey(back) {
  const p = backParams(back);
  return [back.bgColor, p.grad ? back.bgColor2 + '@' + p.gradAngle : '-',
    p.bright.toFixed(2), p.sat.toFixed(2), p.shading.toFixed(2),
    p.patScale.toFixed(2), p.patRot.toFixed(1),
    p.patStrength.toFixed(2)].join('|').toLowerCase();
}

/* the main-thread half: tile the pattern (pattern fills follow the CTM)
   and stretch the vignette map, then hand both buffers to the worker */
function buildBackCanvas(p) {
  const c = document.createElement('canvas');
  c.width = SRC_W; c.height = SRC_H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const k = TILE_BASE * p.patScale;
  ctx.save();
  ctx.translate(SRC_W / 2, SRC_H / 2);
  ctx.rotate((p.patRot * Math.PI) / 180);
  ctx.scale(k, k);
  ctx.fillStyle = ctx.createPattern(bk.pattern, 'repeat');
  const r = Math.hypot(SRC_W, SRC_H) / 2 / k + bk.pattern.width;
  ctx.fillRect(-r, -r, 2 * r, 2 * r);
  ctx.restore();
  const im = ctx.getImageData(0, 0, SRC_W, SRC_H);

  const vc = document.createElement('canvas');
  vc.width = SRC_W; vc.height = SRC_H;
  const vctx = vc.getContext('2d', { willReadFrequently: true });
  vctx.drawImage(bk.vignette, 0, 0, SRC_W, SRC_H);
  const vim = vctx.getImageData(0, 0, SRC_W, SRC_H);

  const { CAL: cal, L_AVG: lavg, ...rest } = p;
  const msg = { type: 'back', buf: im.data.buffer, vbuf: vim.data.buffer, w: SRC_W, h: SRC_H,
    p: { ...rest, CAL: cal, L_AVG: lavg } };
  return runPixelJob(msg, [im.data.buffer, vim.data.buffer]).then((buf) => {
    ctx.putImageData(new ImageData(new Uint8ClampedArray(buf), SRC_W, SRC_H), 0, 0);
    return c;
  });
}

export function backCanvas(back, requestRender) {
  bk.notify = requestRender;
  const key = backKey(back);
  if (bk.key === key && bk.canvas) return bk.canvas;
  bk.want = key;
  bk.wantParams = backParams(back);
  ensureImages();
  pumpBack();
  return bk.canvas; // possibly a stale mix — better than flashing flat colour
}

function pumpBack() {
  if (bk.busy || !bk.ready || !bk.want || bk.want === bk.key) return;
  bk.busy = true;
  const key = bk.want;
  const params = bk.wantParams;
  buildBackCanvas(params).then((c) => {
    bk.canvas = c;
    bk.key = key;
  }).catch(() => { bk.want = bk.key; }).then(() => {
    bk.busy = false;
    if (bk.notify) bk.notify();
    pumpBack();
  });
}

export function backReady(back) {
  if ((back.bgMode || 'pattern') !== 'pattern') return true;
  return bk.key === backKey(back) && !!bk.canvas;
}

/* ── the element ──────────────────────────────────────────────────────── */
export function renderBack(script, options, requestRender, ui) {
  const back = options.back;
  const selected = (ui && ui.selected) || '';

  const root = pageFrame(BACK_W, BACK_H, BACK_H / 100, 'script-back');
  root.style.background = back.bgColor || BACK_BASE.hex;

  const mode = back.bgMode || 'pattern';
  const custom = mode === 'custom' ? resolveSrc(back.bgSrc) : '';
  if (custom) {
    const im = document.createElement('img');
    im.src = custom;
    im.crossOrigin = 'anonymous';
    im.draggable = false;
    Object.assign(im.style, {
      position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', objectFit: 'cover',
    });
    root.append(im);
  } else if (mode === 'plain') {
    // flat colour, already painted by the frame; a gradient is honoured
    if (back.bgGradient) {
      root.style.background = `linear-gradient(${Number(back.bgGradAngle) || 180}deg, ${back.bgColor}, ${back.bgColor2 || back.bgColor})`;
    }
  } else {
    const canvas = backCanvas(back, requestRender);
    if (canvas) {
      // the singleton canvas is adopted by each new render; an export
      // render that runs while the preview is showing it gets a copy
      let node = canvas;
      if (canvas.parentNode && ui && ui.forExport) {
        node = document.createElement('canvas');
        node.width = canvas.width; node.height = canvas.height;
        node.getContext('2d').drawImage(canvas, 0, 0);
      }
      Object.assign(node.style, {
        position: 'absolute', left: '0', top: '0',
        width: '100%', height: '100%',
      });
      root.append(node);
    }
  }

  (back.texts || []).forEach((t, i) => {
    root.append(renderTextElement(t, 'back:' + i, selected === 'back:' + i));
  });
  for (const n of renderStickers(ui && ui.stickers, selected)) root.append(n);

  return root;
}
