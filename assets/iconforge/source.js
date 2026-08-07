/* Icon Forge — source loading.

   Files (SVG / PNG / JPG / WebP) and inline SVG strings, normalized to a
   high-resolution raster the engine can measure and crop. */

const VECTOR_TARGET = 1800; // longest side when rasterizing vectors

/** Give an SVG explicit pixel dimensions so it rasterizes crisply. */
function sizeSvgText(svgText) {
  try {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const root = doc.querySelector('svg');
    if (!root) return svgText;

    let w = parseFloat(root.getAttribute('width') || '');
    let h = parseFloat(root.getAttribute('height') || '');
    const vb = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    if ((!Number.isFinite(w) || !Number.isFinite(h)) && vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
      w = vb[2];
      h = vb[3];
    }
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return svgText;

    const s = VECTOR_TARGET / Math.max(w, h);
    root.setAttribute('width', String(Math.round(w * s)));
    root.setAttribute('height', String(Math.round(h * s)));
    return new XMLSerializer().serializeToString(doc);
  } catch {
    return svgText;
  }
}

function imageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not decode that image'));
    };
    img.src = url;
  });
}

export function loadSvgString(svgText) {
  return imageFromBlob(new Blob([sizeSvgText(svgText)], { type: 'image/svg+xml' }));
}

export async function loadSourceFile(file) {
  const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
  if (isSvg) return loadSvgString(await file.text());
  if (!/^image\//.test(file.type)) {
    throw new Error('Unsupported file type — use SVG, PNG, JPG or WebP');
  }
  return imageFromBlob(file);
}

/** Re-encode an image as a small data-URL thumbnail. Source images arrive from
 *  blob URLs that are revoked once decoded, so their own .src cannot be shown
 *  again — every thumbnail on the page goes through here. */
export function thumbDataUrl(img, max) {
  try {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const scale = Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(h * scale));
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  } catch {
    return null;
  }
}
