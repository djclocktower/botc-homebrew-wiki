/* Fancy Scripts — the pieces every page shares.
 *
 *   - the page frame (a sized, clipped sheet with its background: the
 *     baked parchment, the light parchment, a plain colour or an upload,
 *     with the adjustment filter and the vignette on top);
 *   - stickers: the free text and image elements a person adds to any
 *     page (and the back cover's title words, which are the same thing).
 *     A text element is two stacked spans — a stroked one underneath
 *     carrying the drop shadow, a clean fill on top — so the stroke reads
 *     as an OUTSIDE stroke and the shadow silhouette includes it, like a
 *     PSD layer style. A gradient fill clips a two-colour ramp to the
 *     glyphs (background-clip: text, the front title's own technique);
 *   - the asset resolver: an uploaded file is stored once in the app's
 *     asset store and referenced as 'asset:<id>' from the options, so an
 *     undo snapshot never carries a megabyte of PNG. Renderers call
 *     resolveSrc() on anything that might be a reference.
 *
 * Every element that can be dragged carries data-fs-drag="<kind>:<id>";
 * the drag layer (drag.js) reads nothing else. Browser-only.
 */

import { fontFamily, EL_DEFAULT } from './script.js';
import { el, img, px, clamp } from './util.js';

export const ART = '/assets/fancyscripts/art/';
export const LIGHT_PARCHMENT = '/assets/parchment.jpg';

/* ── assets ──────────────────────────────────────────────────────────── */
let assetResolver = null;
export function setAssetResolver(fn) { assetResolver = fn; }

export function resolveSrc(v) {
  const s = String(v || '');
  if (!s) return '';
  if (s.startsWith('asset:')) return (assetResolver && assetResolver(s)) || '';
  return s;
}

/* ── the page frame ──────────────────────────────────────────────────── */
export function pageFrame(w, h, unit, className) {
  const sheet = el('div', {
    position: 'relative',
    width: px(w),
    height: px(h),
    fontSize: px(unit),
    overflow: 'hidden',
    background: '#d8cdb2',
    userSelect: 'none',
    textRendering: 'optimizeLegibility',
    fontKerning: 'normal',
    fontFeatureSettings: '"kern" 1, "liga" 1',
  });
  sheet.className = className;
  return sheet;
}

/* the background layers for a page. `page` is 'front' (the baked sheet
   art with its frame and garland) or 'list' (a night/jinx page, which
   wants a clean parchment — the same art zoomed to its interior so the
   frame and garland fall outside the page). */
export function renderBackground(bg, page, extra) {
  const b = bg || {};
  const nodes = [];
  let mode = b.mode || 'parchment';
  // 'script': the background image the script itself carries (_meta.background)
  const scriptBg = extra && extra.scriptBg;
  if (mode === 'script' && !scriptBg) mode = page === 'list' ? 'light' : 'parchment';
  const filter = [];
  if (b.brightness != null && Number(b.brightness) !== 1) filter.push(`brightness(${Number(b.brightness)})`);
  if (b.contrast != null && Number(b.contrast) !== 1) filter.push(`contrast(${Number(b.contrast)})`);
  if (b.saturate != null && Number(b.saturate) !== 1) filter.push(`saturate(${Number(b.saturate)})`);
  if (b.sepia) filter.push(`sepia(${Number(b.sepia)})`);
  if (b.hue) filter.push(`hue-rotate(${Number(b.hue)}deg)`);
  const f = filter.join(' ');
  const full = { position: 'absolute', inset: '0', width: '100%', height: '100%' };
  if (mode === 'plain') {
    nodes.push(el('div', { ...full, background: b.color || '#ece2c8' }));
  } else if (mode === 'script') {
    nodes.push(el('div', { ...full, background: b.color || '#ece2c8' }));
    const im = img(scriptBg, { ...full, objectFit: 'cover', objectPosition: 'center', filter: f || undefined });
    im.crossOrigin = 'anonymous';
    nodes.push(im);
  } else if (mode === 'custom' && resolveSrc(b.src)) {
    const fit = b.fit === 'contain' ? 'contain' : b.fit === 'stretch' ? 'fill' : 'cover';
    nodes.push(el('div', { ...full, background: b.color || '#ece2c8' }));
    nodes.push(img(resolveSrc(b.src), { ...full, objectFit: fit, objectPosition: 'center', filter: f || undefined }));
  } else if (mode === 'light' || (mode === 'custom')) {
    nodes.push(img(LIGHT_PARCHMENT, { ...full, objectFit: 'cover', filter: f || undefined }));
  } else if (page === 'list') {
    // the baked art's clean interior: the frame ends ~9% in on the left,
    // ~4% on the right, and the garland starts at 89.5% down — 150% shows
    // the middle two thirds, all of it clean parchment
    nodes.push(img(ART + 'parchment.jpg', {
      position: 'absolute', left: '-25%', top: '-25%', width: '150%', height: '150%',
      objectFit: 'fill', filter: f || undefined,
    }));
  } else {
    nodes.push(img(ART + 'parchment.jpg', { ...full, filter: f || undefined }));
  }
  const v = clamp(Number(b.vignette) || 0, 0, 1);
  if (v > 0) {
    nodes.push(el('div', {
      ...full,
      pointerEvents: 'none',
      background: `radial-gradient(ellipse at center, rgba(40,25,10,0) 48%, rgba(40,25,10,${(0.62 * v).toFixed(3)}) 100%)`,
      mixBlendMode: 'multiply',
    }));
  }
  return nodes;
}

/* ── stickers ────────────────────────────────────────────────────────── */
export const TEXT_ELEMENT_KEYS = ['text', 'x', 'y', 'size', 'font', 'fill', 'fillGrad', 'fill2', 'gradAngle',
  'strokeW', 'strokeColor', 'shadowX', 'shadowY', 'shadowBlur', 'shadowColor', 'rotate', 'spacing',
  'opacity', 'align', 'lineHeight', 'blend'];

function anchorTranslate(align) {
  if (align === 'left') return 'translate(0, -50%)';
  if (align === 'right') return 'translate(-100%, -50%)';
  return 'translate(-50%, -50%)';
}

/* one text element. `drag` is the data-fs-drag value ('back:3',
   'custom:abc'); `scaleUnit` converts the element's px size (authored in
   the 1242-wide sheet space) — pages are all that size, so it is 1. */
export function renderTextElement(t, drag, selected) {
  const wrap = document.createElement('div');
  if (drag) wrap.dataset.fsDrag = drag;
  const lines = String(t.text == null ? '' : t.text).split('\n');
  Object.assign(wrap.style, {
    position: 'absolute',
    left: (Number(t.x) || 0) + '%',
    top: (Number(t.y) || 0) + '%',
    transform: `${anchorTranslate(t.align)} rotate(${Number(t.rotate) || 0}deg)`,
    transformOrigin: t.align === 'left' ? '0 50%' : t.align === 'right' ? '100% 50%' : '50% 50%',
    fontFamily: fontFamily(t.font || 'unlovable'),
    fontSize: px(Number(t.size) || 100),
    lineHeight: String(Number(t.lineHeight) || 1),
    letterSpacing: (Number(t.spacing) || 0) + 'em',
    whiteSpace: 'nowrap',
    textAlign: t.align || 'center',
    cursor: drag ? 'grab' : 'default',
    touchAction: 'none',
    opacity: t.opacity == null ? '1' : String(clamp(Number(t.opacity), 0, 1)),
    mixBlendMode: t.blend === 'multiply' ? 'multiply' : 'normal',
    zIndex: '3',
  });
  const shadow = t.shadowBlur || t.shadowX || t.shadowY
    ? `${Number(t.shadowX) || 0}px ${Number(t.shadowY) || 0}px ${Number(t.shadowBlur) || 0}px ${t.shadowColor || '#000000'}`
    : 'none';
  const strokeSpan = document.createElement('span');
  Object.assign(strokeSpan.style, {
    position: 'absolute', left: '0', top: '0', right: '0',
    color: 'transparent',
    textShadow: shadow,
    whiteSpace: 'pre',
  });
  if (Number(t.strokeW) > 0) {
    strokeSpan.style.setProperty('-webkit-text-stroke', `${Number(t.strokeW) * 2}px ${t.strokeColor || '#000000'}`);
  }
  const fillSpan = document.createElement('span');
  Object.assign(fillSpan.style, { position: 'relative', display: 'inline-block', whiteSpace: 'pre' });
  if (t.fillGrad) {
    // two-colour ramp clipped to the glyphs — the front title's technique.
    // The background only PAINTS inside the span's box, and LHF's swashes
    // overhang it (left bearing, tall ascenders) — those parts got no
    // gradient and showed the stroke layer as bare black. Padding grows
    // the painting area over the overhang; the equal negative margin puts
    // the box back so the glyphs (and the stroke overlay) do not move.
    fillSpan.style.padding = '0.45em';
    fillSpan.style.margin = '-0.45em';
    fillSpan.style.backgroundImage =
      `linear-gradient(${Number(t.gradAngle) || 180}deg, ${t.fill || '#bea881'}, ${t.fill2 || '#e8d9a0'})`;
    fillSpan.style.setProperty('-webkit-background-clip', 'text');
    fillSpan.style.backgroundClip = 'text';
    fillSpan.style.color = 'transparent';
  } else {
    fillSpan.style.color = t.fill || '#bea881';
  }
  lines.forEach((ln, i) => {
    if (i) { strokeSpan.append(document.createElement('br')); fillSpan.append(document.createElement('br')); }
    strokeSpan.append(document.createTextNode(ln));
    fillSpan.append(document.createTextNode(ln));
  });
  wrap.append(strokeSpan, fillSpan);
  if (selected) markSelected(wrap);
  return wrap;
}

/* one image element: a sticker, an uploaded ornament, a second logo */
export function renderImageElement(t, drag, selected) {
  const src = resolveSrc(t.src);
  const wrap = document.createElement('div');
  if (drag) wrap.dataset.fsDrag = drag;
  const w = clamp(Number(t.w) || 20, 1, 300);
  Object.assign(wrap.style, {
    position: 'absolute',
    left: (Number(t.x) || 0) + '%',
    top: (Number(t.y) || 0) + '%',
    width: w + '%',
    transform: `translate(-50%, -50%) rotate(${Number(t.rotate) || 0}deg)${t.flip ? ' scaleX(-1)' : ''}`,
    opacity: t.opacity == null ? '1' : String(clamp(Number(t.opacity), 0, 1)),
    mixBlendMode: t.blend === 'multiply' ? 'multiply' : 'normal',
    cursor: drag ? 'grab' : 'default',
    touchAction: 'none',
    lineHeight: '0',
    zIndex: t.behind ? '0' : '2',
  });
  if (src) {
    const im = img(src, {
      display: 'block', width: '100%', height: 'auto',
      borderRadius: t.round ? (Number(t.round) + '%') : '0',
      filter: Number(t.shadow) > 0
        ? `drop-shadow(0 ${(Number(t.shadow) * 4).toFixed(1)}px ${(Number(t.shadow) * 8).toFixed(1)}px rgba(20,10,0,${clamp(0.25 + Number(t.shadow) * 0.15, 0, 0.8).toFixed(2)}))`
        : 'none',
    });
    im.crossOrigin = 'anonymous';
    wrap.append(im);
  } else {
    // nothing uploaded yet: a dashed box so it can still be found and moved
    wrap.append(el('div', {
      width: '100%', paddingTop: '60%', border: '3px dashed rgba(120,80,40,0.55)',
      boxSizing: 'border-box', borderRadius: '6px',
    }));
  }
  if (drag) {
    // the corner grip that resizes it (drag.js reads data-fs-handle)
    const grip = el('div', {
      position: 'absolute', right: '-9px', bottom: '-9px', width: '18px', height: '18px',
      borderRadius: '50%', background: '#f3e9d2', border: '2px solid #5b1f21',
      cursor: 'nwse-resize', display: selected ? 'block' : 'none', zIndex: '5',
    });
    grip.dataset.fsHandle = drag;
    wrap.append(grip);
  }
  if (selected) markSelected(wrap);
  return wrap;
}

export function markSelected(node) {
  node.style.outline = '2px dashed rgba(91,31,33,0.85)';
  node.style.outlineOffset = '5px';
  node.dataset.fsSelected = '1';
}

/* every sticker that belongs on this page, rendered in order. `stickers`
   is the already-filtered list for the page; `behind` picks the ones
   marked to sit under the page's own content (true), the rest (false),
   or all of them (undefined). */
export function renderStickers(stickers, selectedId, behind) {
  return (stickers || [])
    .filter((st) => behind === undefined || !!st.behind === behind)
    .map((st) => (st.type === 'image'
      ? renderImageElement(st, st.locked ? '' : 'custom:' + st.id, selectedId === 'custom:' + st.id)
      : renderTextElement(st, st.locked ? '' : 'custom:' + st.id, selectedId === 'custom:' + st.id)));
}

/* apply an element's transform (offsets in % of width / em, rotation,
   scale, opacity, hidden) to a node that is already positioned at its
   calibrated place; `base` is the transform it carries on its own */
export function applyEl(node, t, base, unitPx, sheetW) {
  const tr = t || EL_DEFAULT;
  const parts = [];
  if (tr.dx || tr.dy) parts.push(`translate(${((tr.dx || 0) / 100) * sheetW}px, ${(tr.dy || 0) * unitPx}px)`);
  if (base) parts.push(base);
  if (tr.rot) parts.push(`rotate(${tr.rot}deg)`);
  if (tr.scale != null && tr.scale !== 1) parts.push(`scale(${tr.scale})`);
  if (parts.length) node.style.transform = parts.join(' ');
  if (tr.opacity != null && tr.opacity !== 1) node.style.opacity = String(clamp(tr.opacity, 0, 1));
  if (tr.hidden) node.style.display = 'none';
  return node;
}
