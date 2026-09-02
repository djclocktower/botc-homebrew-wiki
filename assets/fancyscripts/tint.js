/* Fancy Scripts — recolouring a piece of artwork toward a picked colour.
 *
 * Shared by the classic sheet (the navy damask sidebar) and the teensy sheet
 * (the two purple ribbons). Re-tints an image in a CANVAS, pixel by pixel in
 * real HSL — never with a CSS hue-rotate filter. The filter was tried first
 * and failed exactly where the art is darkest: hue-rotate is a linear matrix
 * approximation, and it maps near-black shadows to neutral mud, so a red
 * ribbon showed un-tinted "missing" bands along its shaded edges.
 *
 * Per pixel: hue is ROTATED by the picked colour's offset from the art's
 * measured base colour, and saturation/lightness are scaled by ratio against
 * that base — so the art keeps its own shading and its darkest shadow ends
 * up the darkest shade of the picked colour.
 *
 * Each image is recoloured once per picked colour (a few million pixels,
 * cached per image), asynchronously: tintedCanvas() hands back the newest
 * finished canvas it has — possibly a stale colour, which beats flashing the
 * untinted art — and calls requestRender when a fresh one lands, exactly
 * like the icon-ink measurements in sheet.js.
 *
 * Browser-only (canvas) — do not import from the Worker.
 */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* hex → {h (deg), s, l}; null for anything that is not #rrggbb */
export function hexHsl(hex) {
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

/* HSL lightness shift of a hex colour (for building gradients from one pick) */
export function shade(hex, dl) {
  const c = hexHsl(hex);
  if (!c) return hex;
  return hslHex(c.h, c.s, clamp(c.l + dl, 0, 1));
}

export function hslHex(h, s, l) {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hh = (((h % 360) + 360) % 360) / 360;
  const chan = (tt) => {
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const to = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
  return '#' + to(chan(hh + 1 / 3)) + to(chan(hh)) + to(chan(hh - 1 / 3));
}

function recolor(src, base, color) {
  const t = hexHsl(color);
  const c = document.createElement('canvas');
  c.width = src.naturalWidth;
  c.height = src.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0);
  const im = ctx.getImageData(0, 0, c.width, c.height);
  const d = im.data;
  const dH = t.h - base.h;
  const sRatio = t.s < 0.06 ? 0 : t.s / base.s;
  const lRatio = t.l / base.l;
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
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

/* one entry per source image url */
const jobs = new Map();

function job(src) {
  let j = jobs.get(src);
  if (!j) {
    j = { img: null, ready: false, color: '', canvas: null, busy: false, want: '', base: null, notify: null };
    jobs.set(src, j);
  }
  return j;
}

function pump(j) {
  if (j.busy || !j.ready || !j.want || j.want === j.color) return;
  j.busy = true;
  const color = j.want;
  // off the current frame, so a drag on the picker stays responsive
  setTimeout(() => {
    try {
      j.canvas = recolor(j.img, j.base, color);
      j.color = color;
    } catch { j.want = j.color; }
    j.busy = false;
    if (j.notify) j.notify();
    pump(j); // the wanted colour may have moved on meanwhile
  }, 0);
}

/* The newest recoloured canvas of `src` for `color` (base = the art's own
   measured {h, s, l}), or the best stale one while the fresh one is computed
   off this frame; null means "show the plain art". The returned canvas is a
   singleton per image — whoever appends it adopts it, which is safe because
   the previous sheet is already detached by the time a new one is built. */
export function tintedCanvas(src, base, color, requestRender) {
  const j = job(src);
  j.notify = requestRender;
  j.base = base;
  if (j.color === color && j.canvas) return j.canvas;
  j.want = color;
  if (!j.img) {
    j.img = new Image();
    j.img.onload = () => { j.ready = true; pump(j); };
    j.img.src = src;
  } else {
    pump(j);
  }
  return j.canvas;
}

/* does this pick actually differ from the art's own colour? */
export function wantsTint(color, baseHex) {
  return !!color && color.toLowerCase() !== baseHex.toLowerCase() && !!hexHsl(color);
}
