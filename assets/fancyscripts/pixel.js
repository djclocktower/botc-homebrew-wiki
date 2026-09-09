/* Fancy Scripts — the per-pixel passes, as pure functions on RGBA buffers.
 *
 * Two jobs live here: re-tinting the sidebar ribbon and colorizing the
 * back cover's pattern. Both are millions of HSL conversions, which is
 * exactly the work that froze the page for a third of a second on every
 * colour change when it ran on the main thread — so pixel-worker.js runs
 * these in a Web Worker and jobs.js is the main-thread side that feeds
 * it. The maths is kept HERE, in one module both sides import, so the
 * worker and the no-worker fallback cannot disagree by a rounding.
 *
 * No DOM, no canvas: a buffer in, the same buffer changed in place.
 */

/* rgb (0..1) → h (deg), s, l — inlined by both loops for speed */
function hslOf(r, g, b, out) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  let h = 0, s = 0;
  if (d) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  out[0] = h; out[1] = s; out[2] = l;
}

function chan(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

/* write hsl (h in deg) into d at i */
function putHsl(d, i, h, s, l) {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hh = (((h % 360) + 360) % 360) / 360;
  d[i] = Math.round(chan(p, q, hh + 1 / 3) * 255);
  d[i + 1] = Math.round(chan(p, q, hh) * 255);
  d[i + 2] = Math.round(chan(p, q, hh - 1 / 3) * 255);
}

/* ── sidebar ribbon recolour ────────────────────────────────────────────
   Per pixel: hue is ROTATED by the picked colour's offset from the art's
   measured base, and saturation/lightness are scaled by ratio against
   that base — so the damask keeps its own shading and its darkest shadow
   ends up the darkest shade of the picked colour. (A CSS hue-rotate was
   tried first: it is a linear approximation that maps the art's near-black
   navy to neutral mud, so a red ribbon showed un-tinted bands.) */
export function tintHSL(d, dH, sRatio, lRatio) {
  const hsl = [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) {
    hslOf(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255, hsl);
    const h = hsl[0] + dH;
    const s = Math.min(1, hsl[1] * sRatio);
    const l = Math.min(1, hsl[2] * lRatio);
    putHsl(d, i, h, s, l);
  }
}

/* ── back cover colorize ────────────────────────────────────────────────
   `d` is the tiled grayscale pattern (any channel is the luminance), `v`
   the vignette map stretched over the same pixels (encoded 0..2, glow
   peak = 1.0). p carries: c1/c2 {h,s,l}, grad, gradAngle, bright, sat,
   shading, patStrength (the CAL pair and L_AVG come along in p too, so
   the constants live in back.js beside their explanation). */
export function colorizeBack(d, v, p, W, H) {
  const powLut = new Float32Array(256);
  for (let i = 0; i < 256; i++) powLut[i] = Math.pow(i / 127.5, p.shading);

  let ramp = null, ca = 0, sa = 0;
  if (p.grad) {
    ramp = { h: new Float32Array(256), s: new Float32Array(256), l: new Float32Array(256) };
    let dh = p.c2.h - p.c1.h;
    if (dh > 180) dh -= 360;
    if (dh < -180) dh += 360;
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      ramp.h[i] = (p.c1.h + dh * t + 360) % 360;
      ramp.s[i] = p.c1.s + (p.c2.s - p.c1.s) * t;
      ramp.l[i] = p.c1.l + (p.c2.l - p.c1.l) * t;
    }
    const a = ((p.gradAngle - 90) * Math.PI) / 180; // CSS-style: 0deg = bottom->top
    ca = Math.cos(a); sa = Math.sin(a);
  }
  const span = Math.abs(ca) * W + Math.abs(sa) * H || 1;

  const g = p.patStrength;
  const lA = p.CAL.lA + p.CAL.lB * p.L_AVG * (1 - g), lB = p.CAL.lB * g;
  const sC = p.CAL.sC + p.CAL.sD * p.L_AVG * (1 - g), sD = p.CAL.sD * g;
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  let i = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++, i += 4) {
      const L = d[i] / 255; // grayscale tile: any channel
      let th, ts, tl;
      if (ramp) {
        let t = (((x - W / 2) * ca + (y - H / 2) * sa) / span + 0.5) * 255;
        t = t < 0 ? 0 : t > 255 ? 255 : t | 0;
        th = ramp.h[t]; ts = ramp.s[t]; tl = ramp.l[t];
      } else { th = p.c1.h; ts = p.c1.s; tl = p.c1.l; }
      const l = clamp01(tl * (lA + lB * L) * p.bright * powLut[v[i]]);
      const s = clamp01(ts * (sC + sD * L) * p.sat);
      putHsl(d, i, th, s, l);
      d[i + 3] = 255;
    }
  }
}
