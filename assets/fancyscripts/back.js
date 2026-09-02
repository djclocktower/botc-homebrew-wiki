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
 * seams so it tiles cleanly) is tiled at the chosen scale
 * and rotation, colorized per pixel in HSL (the CAL constants below were
 * regressed from the template so the default colour reproduces its look)
 * at the chosen strength (a gain on the pattern's depth, pivoting on the
 * tile's mean so the cover's own lightness does not move with it),
 * and multiplied by the template's glow/vignette map
 * (art/back-vignette2.png, luminance ratio encoded 0..2, glow peak = 1.0)
 * raised to the Border-shading strength. The map is BLURRED CLEAN of the
 * template's own damask — the first cut carried it, which painted a soft
 * second pattern layer over the crisp tile and read as "blurry"; the
 * pattern must come from the tile alone. Brightness/saturation multiply in the same pass,
 * and a background gradient swaps the single target colour for a 256-step
 * ramp between two picked colours along an angle. One async cached canvas
 * job; renderBack() shows the newest canvas it has and asks for a re-render
 * when a fresh one lands.
 *
 * Text elements are plain DOM: two stacked spans per element (a stroked one
 * underneath carrying the drop shadow, a clean fill on top — so the stroke
 * reads as an outside stroke and the shadow silhouette includes it, like
 * the PSD's layer styles). A gradient fill clips a two-colour ramp to the
 * glyphs, the same background-clip:text the front title uses.
 *
 * DRAGGING NEVER REBUILDS: pointermove writes the live element's left/top
 * and the model, and the full re-render happens on release. The first cut
 * re-rendered per move, which destroyed the element (and its pointer
 * capture) one frame into every drag — it moved a hair and died.
 *
 * Browser-only (canvas + DOM) — do not import from the Worker.
 */

import {
  BACK_BASE, sheetSize, nightLists, TEAM_LABELS, TEAM_INK,
} from './script.js';
import {
  el, px, clamp, panelFrame, nightColumn, nightColumnHeight, fitNightSizes,
  setupTable, setupTableHeight, teamRowGeometry, teamRowsHeight, teamRows, fontsFor,
} from './panels.js';
import { iconFit, normalizeIcons } from './sheet.js';

const ART = '/assets/fancyscripts/art/';

/* The back takes its front's trim: 1242×1656 for the classic sheet,
   1500×2100 for the teensy one. Everything below is in that space. */
export function backSize(options) {
  const s = sheetSize(options && options.mode);
  return { w: s.w, h: s.h };
}

/* working canvas: print-resolution, the sheet's own ratio */
const SRC_W = 2480;
const srcHFor = (size) => Math.round((SRC_W * size.h) / size.w);

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

/* ── background pipeline ──────────────────────────────────────────────── */
const bk = {
  pattern: null, vignette: null, ready: false, loading: false,
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
  Promise.all([loadImage(ART + 'back-pattern2.png'), loadImage(ART + 'back-vignette2.png')])
    .then(([p, v]) => {
      bk.pattern = p; bk.vignette = v; bk.ready = true;
      pumpBack();
    })
    .catch(() => { bk.loading = false; });
}

function backParams(back, size) {
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
    srcH: srcHFor(size || { w: 1242, h: 1656 }),
  };
}

function backKey(back, size) {
  const p = backParams(back, size);
  return [back.bgColor, p.grad ? back.bgColor2 + '@' + p.gradAngle : '-',
    p.bright.toFixed(2), p.sat.toFixed(2), p.shading.toFixed(2),
    p.patScale.toFixed(2), p.patRot.toFixed(1),
    p.patStrength.toFixed(2), p.srcH].join('|').toLowerCase();
}

function buildBackCanvas(p) {
  const SRC_H = p.srcH;
  // 1) tile the pattern at scale + rotation (pattern fills follow the CTM)
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
  const img = ctx.getImageData(0, 0, SRC_W, SRC_H);
  const d = img.data;

  // 2) the vignette map, stretched over the sheet
  const vc = document.createElement('canvas');
  vc.width = SRC_W; vc.height = SRC_H;
  const vctx = vc.getContext('2d', { willReadFrequently: true });
  vctx.drawImage(bk.vignette, 0, 0, SRC_W, SRC_H);
  const v = vctx.getImageData(0, 0, SRC_W, SRC_H).data;

  // LUT: encoded vignette byte -> ratio^shading
  const powLut = new Float32Array(256);
  for (let i = 0; i < 256; i++) powLut[i] = Math.pow(i / 127.5, p.shading);

  // gradient ramp LUT (256 HSL stops c1 -> c2, hue by the shortest path)
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
  const span = Math.abs(ca) * SRC_W + Math.abs(sa) * SRC_H || 1;

  // 3) colorize. The strength gain scales how far each modulation term
  //    departs from the tile's mean: at 0 the pattern is gone and the cover
  //    is the flat picked colour, at 1 it is the template's own depth, above
  //    that it deepens. Pivoting on L_AVG is what keeps the overall lightness
  //    (and saturation) where the picked colour put it at every setting —
  //    scaling the raw terms would darken the whole cover as it strengthened.
  const g = p.patStrength;
  const lA = CAL.lA + CAL.lB * L_AVG * (1 - g), lB = CAL.lB * g;
  const sC = CAL.sC + CAL.sD * L_AVG * (1 - g), sD = CAL.sD * g;
  let i = 0;
  for (let y = 0; y < SRC_H; y++) {
    for (let x = 0; x < SRC_W; x++, i += 4) {
      const L = d[i] / 255; // grayscale tile: any channel
      let th, ts, tl;
      if (ramp) {
        const t = clamp((((x - SRC_W / 2) * ca + (y - SRC_H / 2) * sa) / span + 0.5) * 255, 0, 255) | 0;
        th = ramp.h[t]; ts = ramp.s[t]; tl = ramp.l[t];
      } else { th = p.c1.h; ts = p.c1.s; tl = p.c1.l; }
      const l = clamp(tl * (lA + lB * L) * p.bright * powLut[v[i]], 0, 1);
      const s = clamp(ts * (sC + sD * L) * p.sat, 0, 1);
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const pp = 2 * l - q;
      const hh = th / 360;
      const chan = (tt) => {
        if (tt < 0) tt += 1;
        if (tt > 1) tt -= 1;
        if (tt < 1 / 6) return pp + (q - pp) * 6 * tt;
        if (tt < 1 / 2) return q;
        if (tt < 2 / 3) return pp + (q - pp) * (2 / 3 - tt) * 6;
        return pp;
      };
      d[i] = Math.round(chan(hh + 1 / 3) * 255);
      d[i + 1] = Math.round(chan(hh) * 255);
      d[i + 2] = Math.round(chan(hh - 1 / 3) * 255);
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function backCanvas(back, requestRender, size) {
  bk.notify = requestRender;
  const key = backKey(back, size);
  if (bk.key === key && bk.canvas) return bk.canvas;
  bk.want = key;
  bk.wantParams = backParams(back, size);
  ensureImages();
  pumpBack();
  return bk.canvas; // possibly a stale mix — better than flashing flat colour
}

function pumpBack() {
  if (bk.busy || !bk.ready || !bk.want || bk.want === bk.key) return;
  bk.busy = true;
  const key = bk.want;
  const params = bk.wantParams;
  setTimeout(() => {
    try {
      bk.canvas = buildBackCanvas(params);
      bk.key = key;
    } catch { bk.want = bk.key; }
    bk.busy = false;
    if (bk.notify) bk.notify();
    pumpBack();
  }, 0);
}

export function backReady(back, size) {
  return bk.key === backKey(back, size) && !!bk.canvas;
}

/* ── the panels ──────────────────────────────────────────────────────────
   What the back carries besides its title, laid out like the reference
   sheets: the night order runs DOWN BOTH EDGES as strips of icons — first
   night on the left, other nights on the right, the moon at the top and
   the sun at the bottom, names beside them when asked, a parchment panel
   behind each when asked — and the centre column under the title stacks
   the official setup table (players 5..15+ × team counts) and any team
   moved off the front sheet (travellers, fabled, loric as icon/name/ability
   rows). Each element has its own size (nightScale, playersScale,
   panelScale); a strip too tall for the page closes up evenly, and centre
   boxes that overflow scale down together. */
function renderPanels(root, script, options, requestRender, size) {
  const back = options.back;
  const W = size.w, H = size.h;
  const F = fontsFor(options.mode);
  const parchment = ART + (options.mode === 'teensy' ? 'teensy-parchment-panel.jpg' : 'parchment-panel.jpg');
  const ornament = options.mode !== 'teensy';
  const base = W / 1242; // px per classic-sheet px
  const stripsOn = !!back.nightOrder;
  const lists = stripsOn ? nightLists(script, options.nightInfoSteps) : null;
  const teams = ['traveller', 'fabled', 'loric'].filter((t) => back[t === 'traveller' ? 'travellers' : t]);
  const teamChars = (t) => script.characters.filter((c) => c.team === t);

  normalizeIcons(script.characters.map((c) => c.icon), requestRender);

  /* ── the night strips, one down each edge ── */
  let stripW = 0;
  const edge = W * 0.028;
  if (stripsOn) {
    const ns = base * clamp(Number(back.nightScale) || 1, 0.4, 2.2);
    const names = !!back.nightNames;
    const backing = !!back.nightBacking;
    const pad = backing ? 7 * ns : 0;
    const bandTop = H * 0.07, bandBottom = H * 0.96;
    const natural = { iconPx: 60 * ns, pitchPx: 72 * ns, moonPx: 70 * ns, sunPx: 58 * ns, labelPx: 22 * ns, hasLabel: true };
    const fit = fitNightSizes([lists.first, lists.other], natural, bandBottom - bandTop - 2 * pad, 16 * ns);
    const colW = names ? Math.max(W * 0.2, fit.iconPx * 4.2) : Math.max(fit.moonPx, fit.iconPx) + 10 * ns;
    stripW = colW + 2 * pad;
    const sides = [
      [lists.first, 'First\nnight', edge + pad],
      [lists.other, 'Other\nnights', W - edge - pad - colW],
    ];
    // both strips start at one height (the taller one, centred in the band)
    const tallest = Math.max(...sides.map(([items]) => nightColumnHeight(items, fit)));
    const stripTop = bandTop + pad + Math.max(0, (bandBottom - bandTop - 2 * pad - tallest) / 2);
    for (const [items, label, x] of sides) {
      const h = nightColumnHeight(items, fit);
      const top = stripTop;
      if (backing) {
        const { root: box } = panelFrame({
          title: '', fonts: F, parchment, scale: ns, headingPx: 0,
          width: colW + 2 * pad, left: x - pad, top: top - pad, height: h + 2 * pad, pad: 0, flat: true,
        });
        root.append(box);
      }
      const col = nightColumn({
        items, label, fonts: F,
        iconPx: fit.iconPx, pitchPx: fit.pitchPx, moonPx: fit.moonPx, sunPx: fit.sunPx,
        names, width: colW, labelPx: fit.labelPx,
        labelColor: backing ? '#2a1b10' : '#ffffff', labelShadow: !backing,
        nameColor: backing ? '#222222' : '#f3e9d2',
        namePx: Math.min(24 * ns, fit.iconPx * 0.42), iconFit,
      });
      Object.assign(col.style, { position: 'absolute', left: px(x), top: px(top) });
      if (!backing && names) col.style.textShadow = '0 1px 3px rgba(0,0,0,0.9)';
      root.append(col);
    }
  }

  /* ── the centre column: the setup table, then the team boxes ── */
  const left = stripsOn ? edge + stripW + W * 0.025 : W * 0.06;
  const width = W - 2 * left;
  const top = H * (clamp(Number(back.panelTop) || 30, 5, 80) / 100);
  const bottom = H * 0.965;
  const avail = bottom - top;

  const tableW = Math.min(width, width * clamp(Number(back.playersScale) || 1, 0.4, 1.6));
  const tableH = back.playersBox ? setupTableHeight(tableW) : 0;

  // the team boxes at a given unit (px per classic px) → their plan
  const plan = (unit) => {
    const pad = 18 * unit, border = 3 * unit;
    const bodyW = width - 2 * pad - 2 * border;
    const headingPx = 30 * unit;
    const headingH = headingPx * 1.1 + 12 * unit + 4 * unit + 1.5 * unit;
    const gap = 16 * unit;
    const out = [];
    for (const t of teams) {
      const chars = teamChars(t);
      if (!chars.length) continue;
      const cols = chars.length > 4 ? 2 : 1;
      const g = teamRowGeometry(unit, cols, 25 * unit, 19 * unit, 64 * unit, bodyW);
      const rows = teamRowsHeight(chars, g, F, cols);
      out.push({ team: t, chars, cols, g, rows, h: rows.total + headingH + 10 * unit + 14 * unit + 2 * border });
    }
    const used = out.reduce((n, p) => n + p.h, 0) + Math.max(0, out.length - 1) * gap;
    return { out, used, gap, headingPx };
  };

  let unit = base * clamp(Number(back.panelScale) || 1, 0.4, 2);
  let p = plan(unit);
  const gapAfterTable = tableH ? 16 * base : 0;
  // over the page: the team boxes scale down together (twice, because the
  // ability text re-wraps at the smaller size)
  for (let iter = 0; iter < 2 && p.out.length && tableH + gapAfterTable + p.used > avail; iter++) {
    unit *= clamp((avail - tableH - gapAfterTable) / p.used, 0.4, 1);
    p = plan(unit);
  }

  let y = top;
  if (back.playersBox) {
    // the sheet's NAME inks: the classic pickers colour names directly; on
    // the teensy sheet names are black and the pickers colour the headings,
    // so the table takes the fixed name inks there
    const teensy = options.mode === 'teensy';
    root.append(setupTable({
      parchment, width: tableW, left: left + (width - tableW) / 2, top: y,
      good: teensy ? TEAM_INK.townsfolk : options.goodColor,
      evil: teensy ? TEAM_INK.minion : options.evilColor,
    }));
    y += tableH + gapAfterTable;
  }
  for (const panel of p.out) {
    const { root: box, body } = panelFrame({
      title: TEAM_LABELS[panel.team], fonts: F, parchment, scale: unit, headingPx: p.headingPx,
      width, left, top: y, height: panel.h,
    });
    body.append(teamRows(panel.chars, panel.g, F, panel.cols, (t) => TEAM_INK[t] || '#7a5230', ornament));
    root.append(box);
    y += panel.h + p.gap;
  }
}

/* ── the element ──────────────────────────────────────────────────────── */

const FONT_FAMILIES = {
  unlovable: '"LHF Unlovable", "Goudy Text MT", serif',
  goudy: '"Goudy Old Style", "Goudy Bookletter 1911", serif',
  trade: '"Trade Gothic", "Archivo Narrow", sans-serif',
  dumbledor: '"Dumbledor", serif',
  optimus: '"OptimusPrinceps", "Trajan Pro", "Cinzel", serif',
  helvetica: '"Liberation Sans", "Helvetica Neue", Helvetica, Arial, sans-serif',
};

export function renderBack(script, options, requestRender, ui) {
  const back = options.back;
  const sel = ui && ui.selected != null ? ui.selected : -1;
  const size = backSize(options);

  const root = document.createElement('div');
  root.className = 'script-back';
  Object.assign(root.style, {
    position: 'relative',
    width: px(size.w),
    height: px(size.h),
    overflow: 'hidden',
    background: back.bgColor || BACK_BASE.hex,
    userSelect: 'none',
    fontKerning: 'normal',
  });

  const canvas = backCanvas(back, requestRender, size);
  if (canvas) {
    Object.assign(canvas.style, {
      position: 'absolute', left: '0', top: '0',
      width: '100%', height: '100%',
    });
    root.append(canvas); // singleton canvas adopted by each new render
  }

  // the panels sit under the title words, so a word can be dragged over one
  renderPanels(root, script, options, requestRender, size);

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
    const strokeSpan = document.createElement('span');
    Object.assign(strokeSpan.style, {
      position: 'absolute', left: '0', top: '0',
      color: 'transparent',
      textShadow: shadow,
    });
    if (t.strokeW > 0) {
      strokeSpan.style.setProperty('-webkit-text-stroke', `${t.strokeW * 2}px ${t.strokeColor || '#000000'}`);
    }
    strokeSpan.textContent = t.text;
    const fillSpan = document.createElement('span');
    fillSpan.style.position = 'relative';
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

/* drag-to-move on the PREVIEW copy. Selection and movement touch the live
   DOM only; the full re-render happens on release (onCommit) — a rebuild
   mid-drag destroys the element holding the pointer capture. */
export function mountBackDrag(root, back, { getScale, onSelect, onCommit, size }) {
  let drag = null;
  const BACK_W = (size && size.w) || 1242;
  const BACK_H = (size && size.h) || 1656;
  const ring = (el) => {
    root.querySelectorAll('[data-back-idx]').forEach((w) => {
      w.style.outline = 'none';
      w.style.outlineOffset = '';
    });
    if (el) {
      el.style.outline = '2px dashed rgba(255,255,255,0.75)';
      el.style.outlineOffset = '6px';
    }
  };
  root.addEventListener('pointerdown', (ev) => {
    const el = ev.target.closest('[data-back-idx]');
    if (!el) return;
    const idx = Number(el.dataset.backIdx);
    ring(el);
    onSelect(idx); // chips + panel only — must not rebuild the preview
    const t = back.texts[idx];
    if (!t) return;
    drag = { el, idx, sx: ev.clientX, sy: ev.clientY, x0: t.x, y0: t.y };
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
    drag.el.style.left = t.x + '%';
    drag.el.style.top = t.y + '%';
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    onCommit();
  };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);
}
