/* Fancy Scripts — dragging things around the preview.
 *
 * One pointer handler for every page. Anything the renderers mark with
 * data-fs-drag="<kind>:<id>" can be picked up and moved; a child marked
 * data-fs-handle resizes it instead. The layer knows nothing about the
 * option model: it reports pointer deltas in SHEET units (dx in % of the
 * sheet's width, dy in % of its height, which is the same thing as em)
 * and lets the app decide what those do to which field.
 *
 * DRAGGING NEVER REBUILDS. The moving node gets a CSS `translate` while
 * the pointer is down; the model is patched live through onMove (so the
 * panel's sliders can follow) and the full re-render happens on release
 * through onCommit. A rebuild mid-drag destroys the element holding the
 * pointer capture — it moved a hair and died, in the first cut.
 *
 * onMove may return a snapped delta ({dx, dy, guideX, guideY}) — the
 * node follows the snapped value and the guides are drawn as thin lines
 * across the sheet for as long as the snap holds. Pointer events only, so
 * mouse and touch are one path; touch-action: none on the draggables
 * keeps the page from scrolling under a finger. Browser-only.
 */

import { SHEET_W, SHEET_H } from './script.js';

const CLICK_SLOP = 3; // px of movement below which a press is a click

export function mountDrag(root, h) {
  let drag = null;
  let guideV = null, guideH = null;

  const showGuide = (axis, pct) => {
    let g = axis === 'v' ? guideV : guideH;
    if (pct == null) {
      if (g) { g.remove(); if (axis === 'v') guideV = null; else guideH = null; }
      return;
    }
    if (!g) {
      g = document.createElement('div');
      g.dataset.fsGuide = axis;
      Object.assign(g.style, {
        position: 'absolute', pointerEvents: 'none', zIndex: '50',
        background: 'rgba(200, 40, 60, 0.85)',
      });
      root.append(g);
      if (axis === 'v') guideV = g; else guideH = g;
    }
    if (axis === 'v') Object.assign(g.style, { left: pct + '%', top: '0', width: '2px', height: '100%' });
    else Object.assign(g.style, { top: pct + '%', left: '0', height: '2px', width: '100%' });
  };

  const clearGuides = () => { showGuide('v', null); showGuide('h', null); };

  root.addEventListener('pointerdown', (ev) => {
    if (ev.button != null && ev.button !== 0) return;
    const handle = ev.target.closest && ev.target.closest('[data-fs-handle]');
    const node = handle
      ? handle.closest('[data-fs-drag]')
      : (ev.target.closest && ev.target.closest('[data-fs-drag]'));
    if (!node) {
      if (h.onBackground && root.contains(ev.target)) h.onBackground();
      return;
    }
    const id = node.dataset.fsDrag;
    if (h.onSelect) h.onSelect(id, node);
    drag = {
      node, id, resize: !!handle,
      sx: ev.clientX, sy: ev.clientY, moved: false, last: { dx: 0, dy: 0 },
      pointerId: ev.pointerId,
    };
    try { root.setPointerCapture(ev.pointerId); } catch { /* not all targets capture */ }
    ev.preventDefault();
  });

  root.addEventListener('pointermove', (ev) => {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    const s = (h.getScale && h.getScale()) || 1;
    const dxPx = (ev.clientX - drag.sx) / s;
    const dyPx = (ev.clientY - drag.sy) / s;
    if (!drag.moved && Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy) < CLICK_SLOP) return;
    drag.moved = true;
    let d = { dx: (dxPx / SHEET_W) * 100, dy: (dyPx / SHEET_H) * 100 };
    if (drag.resize) {
      const r = h.onResize && h.onResize(drag.id, d, false);
      if (r && r.applied) { drag.last = d; return; }
      // no model hook: scale the node visually until release
      drag.last = d;
      return;
    }
    const snapped = h.onMove ? h.onMove(drag.id, d) : null;
    if (snapped && typeof snapped === 'object') {
      if (snapped.dx != null) d.dx = snapped.dx;
      if (snapped.dy != null) d.dy = snapped.dy;
      showGuide('v', snapped.guideX != null ? snapped.guideX : null);
      showGuide('h', snapped.guideY != null ? snapped.guideY : null);
    }
    drag.last = d;
    drag.node.style.translate = `${((d.dx / 100) * SHEET_W).toFixed(2)}px ${((d.dy / 100) * SHEET_H).toFixed(2)}px`;
  });

  const end = (ev) => {
    if (!drag || (ev && ev.pointerId != null && ev.pointerId !== drag.pointerId)) return;
    const d = drag;
    drag = null;
    clearGuides();
    try { root.releasePointerCapture(d.pointerId); } catch { /* already released */ }
    if (!d.moved) return; // a click: selection only, nothing to commit
    if (d.resize) { if (h.onResize) h.onResize(d.id, d.last, true); return; }
    if (h.onCommit) h.onCommit(d.id, d.last);
  };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);
  root.addEventListener('lostpointercapture', (ev) => { if (drag && ev.pointerId === drag.pointerId) end(ev); });

  return {
    cancel() { if (drag) { drag = null; clearGuides(); } },
    dragging() { return !!drag; },
  };
}

/* the app's snap helper: pull a value to the nearest of `targets` when
   inside `tol`, and say which target caught it */
export function snapTo(value, targets, tol) {
  let best = null;
  for (const t of targets) {
    const dist = Math.abs(value - t);
    if (dist <= tol && (best === null || dist < Math.abs(value - best))) best = t;
  }
  return best;
}
