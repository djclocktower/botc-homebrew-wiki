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

/** Load an image from a URL as if it had been uploaded (used by the samples
 *  and by "start from this character's icon"). Same-origin only, so the
 *  canvas the engine draws it into stays untainted and can be exported. */
export async function loadSourceUrl(url) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error('Could not fetch that image (' + res.status + ')');
  const blob = await res.blob();
  if (/svg/i.test(blob.type)) return loadSvgString(await blob.text());
  return imageFromBlob(blob);
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

/* The built-in samples. Two are inline vectors (crisp line work, no request),
   two are real files that behave exactly like a user upload. */
export const SAMPLES = [
  {
    id: 'chalice',
    label: 'Chalice',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
      <path fill="#000" d="M52 34h96v16c0 34-15.5 58-38 66.5V150c0 9 11 13.5 20 18l7 4.5V182H63v-9.5l7-4.5c9-4.5 20-9 20-18v-33.5C67.5 108 52 84 52 50z"/>
      <path fill="#fff" d="M66 48h68v4c0 26-12.5 45.5-34 51.5C78.5 97.5 66 78 66 52z"/>
      <path fill="#fff" d="M100 128c-5.5 0-10 4.5-10 10s4.5 10 10 10 10-4.5 10-10-4.5-10-10-10zm0 7c1.7 0 3 1.3 3 3s-1.3 3-3 3-3-1.3-3-3 1.3-3 3-3z"/>
      <path fill="#fff" d="M70 176h60v3H70z"/>
    </svg>`
  },
  {
    id: 'moth',
    label: 'Death Moth',
    silhouette: true,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
      <path fill="#000" d="M100 52c-4 0-7 3-7 8v12c-14-18-34-30-58-30-8 0-11 9-6 14l23 24c-8 2-14 8-16 16-2 10 4 20 14 23l32 9c-6 4-9 10-9 17 0 13 9 27 27 27s27-14 27-27c0-7-3-13-9-17l32-9c10-3 16-13 14-23-2-8-8-14-16-16l23-24c5-5 2-14-6-14-24 0-44 12-58 30V60c0-5-3-8-7-8z"/>
      <circle cx="91" cy="150" r="5" fill="#fff"/>
      <circle cx="109" cy="150" r="5" fill="#fff"/>
    </svg>`
  },
  {
    id: 'moth-photo',
    label: 'Moth Photo',
    silhouette: true,
    file: '/assets/iconforge/samples/moth-photo.jpg'
  },
  {
    id: 'whip',
    label: 'Whip',
    silhouette: true,
    whiteKey: true,
    file: '/assets/iconforge/samples/whip.png'
  }
];
