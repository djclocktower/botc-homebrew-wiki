/**
 * AI background removal — wraps @imgly/background-removal (in-browser ISNet
 * segmentation via ONNX runtime). The model is fetched from the imgly CDN on
 * first use (~44 MB, quantized "small" model) and cached by the browser, then
 * everything runs locally. The library is dynamically imported so it only
 * loads when the feature is actually used.
 *
 * The expensive part (the neural segmentation) runs once per source image and
 * the RAW cutout is cached. The cleanup pass (alpha floor + residue filter)
 * is cheap and re-applied on demand, so the tolerance slider is live.
 */
/** Cache: one RAW model cutout per source object (re-selects are instant). */
const cache = new WeakMap();
function toCanvasSized(img) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  // Composite onto opaque white. The segmentation model reads RGB and ignores
  // the alpha channel, so transparent pixels arrive as BLACK — including the
  // "erased" spots an editor cut to transparency, which would otherwise
  // reappear as ghost blobs in the cutout. White reads as empty background.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0);
  return c;
}
function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Could not encode image'))),
      'image/png',
    );
  });
}
/** Resolution cap for the connected-component analysis. */
const CLEAN_MAX = 768;
/**
 * Map a 0–100 tolerance onto cleanup strength. 50 reproduces the original
 * fixed defaults; lower keeps faint lines and small detached parts, higher
 * strips more background residue.
 */
export function cleanupFor(tolerance) {
  const t = Math.min(100, Math.max(0, tolerance));
  return {
    alphaFloor: Math.round(48 + t * 1.6), // 48..208 — 128 at 50
    minPart: 0.005 + t * 0.0015, // 0.005..0.155 — 0.08 at 50
    erode: t >= 40,
  };
}
/**
 * Clean up a raw AI cutout: neural matting leaves faint partial-alpha smudges
 * outside the subject (paper stains, shadows), which would otherwise grow
 * their own borders in the icon pipeline. Binarize the alpha, then keep only
 * meaningful connected components (the subject and any large detached parts).
 * Mutates the passed canvas.
 */
function cleanCutout(canvas, settings) {
  const { alphaFloor, minPart, erode } = settings;
  const w = canvas.width;
  const h = canvas.height;
  const scale = Math.min(1, CLEAN_MAX / Math.max(w, h));
  const sw = Math.max(1, Math.round(w * scale));
  const sh = Math.max(1, Math.round(h * scale));
  const small = document.createElement('canvas');
  small.width = sw;
  small.height = sh;
  const sctx = small.getContext('2d');
  if (!sctx) return canvas;
  sctx.drawImage(canvas, 0, 0, sw, sh);
  const sd = sctx.getImageData(0, 0, sw, sh).data;
  const n = sw * sh;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = sd[i * 4 + 3] >= alphaFloor ? 1 : 0;
  if (erode) {
    // Morphological opening (erode then dilate): matting residue often clings
    // to the subject by a 1–2 px bridge — breaking those lets the component
    // filter below drop the smudge instead of keeping it as part of the
    // subject. At gentle tolerances this is skipped so thin lines survive.
    const eroded = new Uint8Array(n);
    for (let y = 1; y < sh - 1; y++) {
      for (let x = 1; x < sw - 1; x++) {
        const p = y * sw + x;
        eroded[p] =
          mask[p] && mask[p - 1] && mask[p + 1] && mask[p - sw] && mask[p + sw] ? 1 : 0;
      }
    }
    for (let y = 1; y < sh - 1; y++) {
      for (let x = 1; x < sw - 1; x++) {
        const p = y * sw + x;
        mask[p] =
          eroded[p] || eroded[p - 1] || eroded[p + 1] || eroded[p - sw] || eroded[p + sw]
            ? 1
            : 0;
      }
    }
  }
  // Label connected components (4-neighbour flood fill).
  const label = new Int32Array(n).fill(-1);
  const sizes = [];
  const stack = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (!mask[s] || label[s] >= 0) continue;
    const id = sizes.length;
    let sp = 0;
    let size = 0;
    stack[sp++] = s;
    label[s] = id;
    while (sp > 0) {
      const p = stack[--sp];
      size++;
      const px = p % sw;
      const py = (p / sw) | 0;
      if (px > 0 && mask[p - 1] && label[p - 1] < 0) {
        label[p - 1] = id;
        stack[sp++] = p - 1;
      }
      if (px < sw - 1 && mask[p + 1] && label[p + 1] < 0) {
        label[p + 1] = id;
        stack[sp++] = p + 1;
      }
      if (py > 0 && mask[p - sw] && label[p - sw] < 0) {
        label[p - sw] = id;
        stack[sp++] = p - sw;
      }
      if (py < sh - 1 && mask[p + sw] && label[p + sw] < 0) {
        label[p + sw] = id;
        stack[sp++] = p + sw;
      }
    }
    sizes.push(size);
  }
  if (sizes.length <= 1) {
    // Single blob — still apply the alpha floor at full resolution.
    if (sizes.length === 0) return canvas;
  }
  const biggest = sizes.reduce((a, b) => Math.max(a, b), 0);
  const minSize = Math.max(biggest * minPart, 16);
  const keepLabel = new Uint8Array(sizes.length);
  sizes.forEach((s, i) => {
    keepLabel[i] = s >= minSize ? 1 : 0;
  });
  const keepMap = new Uint8Array(n);
  for (let i = 0; i < n; i++) keepMap[i] = label[i] >= 0 && keepLabel[label[i]] ? 1 : 0;
  // Apply floor + component filter to the full-resolution alpha.
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const full = ctx.getImageData(0, 0, w, h);
  const fd = full.data;
  for (let y = 0; y < h; y++) {
    const sy = Math.min(sh - 1, ((y * sh) / h) | 0);
    const row = sy * sw;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const sx = Math.min(sw - 1, ((x * sw) / w) | 0);
      if (!keepMap[row + sx] || fd[i + 3] < alphaFloor) fd[i + 3] = 0;
    }
  }
  ctx.putImageData(full, 0, 0);
  return canvas;
}
/**
 * Clone the cached raw cutout and apply the cleanup pass at the given
 * tolerance (0–100). The raw cutout itself is never mutated, so this can be
 * re-run freely as the slider moves.
 */
export function applyCleanup(raw, tolerance) {
  const c = document.createElement('canvas');
  c.width = raw.width;
  c.height = raw.height;
  const ctx = c.getContext('2d');
  if (!ctx) return raw;
  ctx.drawImage(raw, 0, 0);
  return cleanCutout(c, cleanupFor(tolerance));
}
async function runRemoval(source, onProgress) {
  // The library is vendored under vendor/ rather than bundled — the wiki has
  // no build step. It dynamically imports the bare specifier
  // "onnxruntime-web", which the import map in iconforge.html points at our
  // vendored copy; the ONNX wasm and the model itself still come from imgly's
  // CDN at run time (the model is ~44 MB, far too big to commit).
  const { removeBackground } = await import('./vendor/imgly-bg-removal.js');
  const blob = await canvasToBlob(toCanvasSized(source));
  const resultBlob = await removeBackground(blob, {
    // Quantized small model: ~4x smaller download than the default, and for
    // bold line-art shapes the segmentation difference is negligible.
    model: 'isnet_quint8',
    output: { format: 'image/png' },
    progress: (key, current, total) => {
      const fraction = total > 0 ? current / total : 0;
      const label = key.startsWith('fetch:') ? 'Downloading AI model…' : 'Removing background…';
      onProgress?.(fraction, label);
    },
  });
  const bitmap = await createImageBitmap(resultBlob);
  const out = document.createElement('canvas');
  out.width = bitmap.width;
  out.height = bitmap.height;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return out;
}
/**
 * Remove the background from a raster source image. Returns the RAW model
 * cutout (no cleanup applied) — pass it through applyCleanup() with the
 * current tolerance. Results are cached per source image, so repeat calls
 * are free.
 */
export function removeImageBackground(source, onProgress) {
  let p = cache.get(source);
  if (!p) {
    p = runRemoval(source, onProgress);
    cache.set(source, p);
    // A failure should not poison the cache — allow retry.
    p.catch(() => cache.delete(source));
  } else if (onProgress) {
    onProgress(1, 'Ready');
  }
  return p;
}
