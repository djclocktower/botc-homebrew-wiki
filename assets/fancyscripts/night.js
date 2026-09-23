/* Fancy Scripts — the night order sheets (and the jinx page).
 *
 * Two styles, both calibrated from the owner's reference sheets:
 *
 *   'ribbon' (the default, NIGHT_RIBBON in script.js, off "Valley of
 *   Shadows"): one row per step, the icon on the left, the name set
 *   RIGHT-aligned against a thin bar in the team's colour, and the
 *   Storyteller's reminder beside the bar with its second line indented.
 *   The bar, the name and the icon are centred on the reminder. The title
 *   ("OTHER NIGHTS") runs down a damask ribbon on the right edge, tinted
 *   like the script sheet's, and the script's logo sits at the foot of the
 *   page, bottom right; the rows that pass it wrap short around it.
 *
 *   'classic' (NIGHT, off "Blending In"): "First Night" in Dumbledor at the
 *   top left, the logo top right, and each step as the icon beside its name
 *   with the reminder under it.
 *
 * In both, the reminder is Trade Gothic with the info tokens (*YOU ARE*)
 * set in bold caps and each ':reminder:' placement drawn as a dot, and
 * Dusk, Minion Info, Demon Info and Dawn take their places between the
 * characters.
 *
 * It is written as a LIST-PAGE renderer: a page is one or two columns of
 * blocks, a block is an optional heading over rows, a row is icon(s) +
 * name + text. The night sheets are one column; "both nights on one
 * page" is two; the jinx page is one column of three blocks (jinxes,
 * house rules, notes), and takes the night sheets' chrome (ribbon and
 * logo) with its rows stacked, since a pair's two names do not fit a name
 * column. One renderer, so the pages cannot drift apart.
 *
 * Same contract as sheet.js: inline styles only, data-fs-drag on the
 * movable pieces, a measured layout pass (layoutList) that solves the
 * density and packs rows onto pages, then a render pass per page.
 * Browser-only.
 */

import {
  NIGHT, NIGHT_RIBBON, FIT, SHEET_W, SHEET_H, U, PLACEHOLDER_ICON, STEP_ICONS,
  nightLists, reminderParts, smartTypography, teamColor, fontFamily, elGet, sortCharacters, proxied,
} from './script.js';
import {
  el, img, px, clamp, wrappedRunLineCount, textWidth, normalizeIcons, iconFit, inkTransform, iconFilter,
  ICON_IDENTITY, drawIcon,
} from './util.js';
import { pageFrame, renderBackground, renderStickers, resolveSrc, markSelected } from './elements.js';
import { appendRibbon } from './sheet.js';

const G = NIGHT_RIBBON;

/* the step names and bars when no colour is picked: the reference's khaki
   on the ribbon style, the old near-black on the classic one */
const META_INK = { ribbon: '#8a7b58', classic: '#1c1c1c', app: '#1c1c1c' };

function iconImg(src, style, alt) {
  const n = img(src, style, alt);
  n.crossOrigin = 'anonymous';
  n.decoding = 'sync';
  n.addEventListener('error', () => {
    if (n.src !== PLACEHOLDER_ICON) n.src = PLACEHOLDER_ICON;
  });
  return n;
}

/* a logo that failed to load: the page shows the script's name instead */
const failedArt = new Set();

/* A logo's own size, so the list can wrap round the box it is actually
   drawn in rather than the largest one it could be. Loaded once per image;
   the page is laid out again when it lands. */
const logoDims = new Map();
function logoSize(src, requestRender) {
  const hit = logoDims.get(src);
  if (hit) return hit.w ? hit : null;
  const rec = {};
  logoDims.set(src, rec);
  const im = new Image();
  im.crossOrigin = 'anonymous';
  im.onload = () => {
    rec.w = im.naturalWidth || 1;
    rec.h = im.naturalHeight || 1;
    if (requestRender) requestRender();
  };
  im.onerror = () => {
    failedArt.add(src);
    if (requestRender) requestRender();
  };
  im.src = src;
  return null;
}

/* ── specs ─────────────────────────────────────────────────────────────── */

/* 'app' is the app view's (appview.js draws those pages; the spec is
   built here all the same) */
const styleOf = (cfg) => (cfg.style === 'classic' ? 'classic' : cfg.style === 'app' ? 'app' : 'ribbon');

/* the colour a row's name (and its bar) prints in */
export function rowColor(item, options, cfg) {
  if (item.kind === 'step') return cfg.metaColor || META_INK[styleOf(cfg)];
  if (item.color) return item.color;
  const t = item.team;
  if (t === 'minion' || t === 'demon') return cfg.evilColor || options.evilColor;
  if (t === 'traveller' || t === 'fabled' || t === 'loric') return cfg.neutralColor || teamColor(options, t);
  return cfg.goodColor || teamColor(options, t);
}

function nightRows(items, options, cfg, list) {
  return items.map((it, i) => ({
    icons: [it.icon],
    kind: it.kind,
    id: it.id,
    list,
    name: it.name,
    color: rowColor(it, options, cfg),
    number: i + 1,
    text: cfg.showReminders === false ? '' : it.text,
  }));
}

/* buildNightSpec(script, options, which) — which: 'first' | 'other' | 'both' */
export function buildNightSpec(script, options, which) {
  const cfg = options.night;
  const lists = nightLists(script, cfg);
  const columns = [];
  if (which === 'both') {
    columns.push({ heading: cfg.titleFirst || 'First Night', blocks: [{ rows: nightRows(lists.first, options, cfg, 'first') }] });
    columns.push({ heading: cfg.titleOther || 'Other Nights', blocks: [{ rows: nightRows(lists.other, options, cfg, 'other') }] });
  } else {
    const items = which === 'first' ? lists.first : lists.other;
    const rows = nightRows(items, options, cfg, which);
    if (cfg.twoColumns && rows.length > 3) {
      // split where the weight (a row plus its text) reaches half
      const weight = (r) => 1 + (r.text ? r.text.length / 170 : 0);
      const total = rows.reduce((n, r) => n + weight(r), 0);
      let acc = 0, cut = rows.length;
      for (let i = 0; i < rows.length; i++) {
        acc += weight(rows[i]);
        if (acc >= total / 2) { cut = i + 1; break; }
      }
      columns.push({ heading: '', blocks: [{ rows: rows.slice(0, cut) }] });
      columns.push({ heading: '', blocks: [{ rows: rows.slice(cut) }] });
    } else {
      columns.push({ heading: '', blocks: [{ rows }] });
    }
  }
  const style = styleOf(cfg);
  // every name on BOTH nights, so the two sheets size their name column
  // alike (with room for a step number when the steps are numbered)
  const names = [...lists.first, ...lists.other].map((it) =>
    (cfg.numbered ? '00. ' : '') + smartTypography(it.name));
  return {
    kind: 'night',
    names,
    which,
    elPrefix: 'night',
    title: which === 'both' ? 'Night Order' : (which === 'first' ? (cfg.titleFirst || 'First Night') : (cfg.titleOther || 'Other Nights')),
    columns,
    cfg,
    style,
    bars: style !== 'classic', // name beside a colour bar, rather than over the reminder
    meta: script.meta,
    numbered: !!cfg.numbered,
    paginate: which !== 'both',
  };
}

/* the jinx page: every jinx pair on the script once, house rules
   (_meta.bootlegger) and the writer's own notes */
export function buildJinxSpec(script, options) {
  const cfg = options.jinxPage;
  const chars = sortCharacters(script.characters, options.sortMode);
  const seen = new Set();
  const rows = [];
  for (const c of chars) {
    for (const j of c.jinxList || []) {
      if (!j.onScript) continue;
      const key = [c.id, j.id].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        icons: [c.icon, j.icon],
        kind: 'jinx',
        id: key,
        nameParts: [
          { s: c.name, color: c.color || teamColor(options, c.team) },
          { s: ' & ', color: cfg.textColor || '#2b2b2b' },
          { s: j.name, color: teamColor(options, j.team) },
        ],
        name: c.name + ' & ' + j.name,
        color: cfg.textColor || '#2b2b2b',
        text: j.reason || '',
      });
    }
  }
  const blocks = [];
  blocks.push({ heading: '', rows });
  if (cfg.showHouseRules && script.meta.bootlegger && script.meta.bootlegger.length) {
    blocks.push({
      heading: cfg.houseTitle || 'House Rules',
      rows: script.meta.bootlegger.map((r, i) => ({
        icons: [STEP_ICONS.rule], kind: 'rule', id: 'rule' + i, name: '', color: cfg.textColor, text: r,
      })),
    });
  }
  const notes = String(cfg.notes || '').trim();
  if (notes) {
    blocks.push({
      heading: cfg.notesTitle || 'Notes',
      rows: notes.split(/\n\s*\n/).map((p, i) => ({
        icons: [], kind: 'note', id: 'note' + i, name: '', color: cfg.textColor, text: p.replace(/\s*\n\s*/g, ' '),
      })),
    });
  }
  if (!rows.length && blocks.length === 1) {
    blocks[0].rows = [{ icons: [STEP_ICONS.jinx], kind: 'note', id: 'none', name: 'No jinxes', color: cfg.textColor,
      text: 'None of the characters on this script are jinxed with each other.' }];
  }
  return {
    kind: 'jinx', which: 'jinx', elPrefix: 'jinx',
    title: cfg.title || 'Jinxes',
    columns: [{ heading: '', blocks }],
    cfg, style: styleOf(cfg), bars: false, meta: script.meta, numbered: false, paginate: true,
  };
}

/* ── layout ─────────────────────────────────────────────────────────────── */

function fontsOf(cfg, options) {
  return {
    title: fontFamily(cfg.fontTitle || 'dumbledor'),
    name: fontFamily(cfg.fontName || 'goudy'),
    text: fontFamily(cfg.fontText || 'trade'),
    token: fontFamily(cfg.fontToken || 'tradebold'),
    logo: fontFamily(options.fontTitle || 'unlovable'),
  };
}

/* how an info token is set: bold caps in the text face (the reference's
   look), bold condensed caps, or plain words */
function tokenLook(cfg, fonts) {
  if (cfg.tokenStyle === 'plain') return null;
  const condensed = cfg.tokenStyle === 'caps';
  return { family: condensed ? fonts.token : fonts.text, spacing: condensed ? 0.01 : 0.03 };
}

/* the width a reminder dot takes, as a fraction of the text size, margins
   included — the renderer draws exactly this */
const DOT_W = { dot: 0.9 + 0.14, token: 1.15 + 0.28 };

/* the text runs a row's reminder wraps in, for measuring: plain runs in
   the text face, tokens in the token face (upper-cased unless plain), a
   dot as a fixed-width box */
function textRuns(row, cfg, fonts, textPx) {
  const base = `400 ${textPx}px ${fonts.text}`;
  const look = tokenLook(cfg, fonts);
  const tokenFont = look ? `700 ${(textPx * 0.96).toFixed(2)}px ${look.family}` : base;
  const runs = [];
  for (const p of reminderParts(smartTypography(row.text || ''))) {
    if (p.t === 'text') runs.push({ s: p.s, font: base });
    else if (p.t === 'token') runs.push({ s: look ? p.s.toUpperCase() : p.s, font: tokenFont, ls: look ? look.spacing * textPx * 0.96 : 0 });
    else if (cfg.dotStyle !== 'none') runs.push({ w: textPx * (DOT_W[cfg.dotStyle] || DOT_W.dot) });
  }
  return { runs, base };
}

/* the page's frame: where the list may go and what is reserved around it */
function geometry(spec) {
  const cfg = spec.cfg;
  if (spec.style === 'classic') {
    return {
      ribbon: false, showRibbon: false, edge: 0,
      listTop: NIGHT.listTop, listBottom: NIGHT.listBottom,
      x0: NIGHT.iconX, x1: 100 - NIGHT.textRight, mid: 50, colGap: NIGHT.colGap,
    };
  }
  const showRibbon = cfg.ribbon !== false;
  // the title stays down the right edge with the ribbon off, so its width
  // is kept clear either way
  const edge = G.ribbonW + (showRibbon ? G.edgeW : 0);
  const x0 = spec.bars ? G.iconX : NIGHT.iconX;
  const x1 = 100 - edge - G.textRight;
  return {
    ribbon: true, showRibbon, edge,
    listTop: G.listTop, listBottom: G.listBottom,
    x0, x1, mid: (x0 + x1) / 2, colGap: G.colGap,
  };
}

/* the geometry every row shares at density 1 (em) */
function metrics(spec) {
  const cfg = spec.cfg;
  const ts = cfg.textSize || 1;
  const gapMul = cfg.rowGap == null ? 1 : cfg.rowGap;
  if (spec.bars) {
    const line = G.textLine * ts;
    return {
      textSize: G.textSize * ts,
      nameH: G.nameSize * (cfg.nameSize || 1),
      line,
      pad: (G.barMin - G.textLine) * ts, // the bar's height beyond its lines
      iconEm: G.iconSize * (cfg.iconSize || 1),
      gap: G.rowGap * gapMul,
    };
  }
  const nameH = NIGHT.nameSize * (cfg.nameSize || 1);
  return {
    textSize: NIGHT.textSize * ts,
    nameH,
    textTop: NIGHT.nameTop + nameH * 1.12,
    line: NIGHT.textLine * ts,
    iconEm: NIGHT.iconSize * (cfg.iconSize || 1),
    gap: NIGHT.rowGap * gapMul,
  };
}

/* where a bar row's pieces sit in its column, in % of the sheet width from
   the column's left edge, at density d. The name column is as wide as the
   longest name (`nameW1`, % of the width at density 1) within
   nameMin..nameMax, so a page of short names gives the room back to the
   reminders and both night sheets of a script put the bar in one place.
   The gaps grow and shrink with the type. A column of two is narrower, so
   its name column is capped lower (names shrink to fit it). */
function barColumn(two, d, iconEm, nameW1) {
  const grow = clamp(d, 0.8, FIT.listGrowMax);
  const iconW = ((iconEm * d * U) / SHEET_W) * 100;
  const nameLeft = iconW + G.nameGap * grow;
  const nameW = clamp(nameW1 * d, G.nameMin * grow, G.nameMax * grow * (two ? G.twoColScale : 1));
  const nameRight = nameLeft + nameW;
  const barX = nameRight + G.barGap * grow;
  return {
    nameLeft,
    nameRight,
    barX,
    textX: barX + G.textGap * grow,
    hang: G.hang * grow,
  };
}

/* the logo (or the script's name) at the foot of a ribbon-style page, and
   the box the list has to keep clear of. Positions are page-wide: x in %
   of the width, y in em. null when nothing is drawn there. */
function logoPlan(spec, options, geo, requestRender) {
  if (!geo.ribbon) return null;
  const cfg = spec.cfg;
  const lT = elGet(options, spec.elPrefix + 'Logo');
  if (lT.hidden) return null;
  const custom = resolveSrc(lT.src);
  let src = custom || (cfg.showLogo !== false && spec.meta.logo && options.useLogo
    ? proxied(spec.meta.logo, options.proxyIcons) : '');
  if (src && failedArt.has(src)) src = '';
  const right = geo.edge + G.logoRight - lT.dx; // % from the sheet's right edge
  const bottom = G.logoBottom - lT.dy; // em up from the foot
  const maxW = G.logoMaxW * lT.scale;
  const maxH = G.logoMaxH * lT.scale;
  let plan = null;
  if (src) {
    const dim = logoSize(src, requestRender);
    let w = maxW, h = maxH;
    if (dim) {
      const s = Math.min(((maxW / 100) * SHEET_W) / dim.w, (maxH * U) / dim.h);
      w = ((dim.w * s) / SHEET_W) * 100;
      h = (dim.h * s) / U;
    }
    plan = { kind: 'img', src, lT, right, bottom, w, h, known: !!dim };
  } else if (cfg.showName !== false) {
    const title = (options.titleOverride || '').trim() || (spec.meta && spec.meta.name) || '';
    if (!title) return null;
    const size = 3.4 * lT.scale;
    const font = `400 ${size * U}px ${fontFamily(options.fontTitle || 'unlovable')}`;
    const natural = (textWidth(title, font) / SHEET_W) * 100;
    const fit = natural > maxW ? maxW / natural : 1;
    plan = { kind: 'name', title, lT, right, bottom, w: Math.min(natural, maxW), h: size * fit * 1.25, size: size * fit };
  }
  if (!plan) return null;
  plan.x0 = 100 - right - plan.w;
  plan.y0 = 100 - bottom - plan.h;
  return plan;
}

/* layoutList(spec, options, requestRender) → {pages, d, cols, m, fonts, ...}
   Solves the density like the sheet does, and fills the page the same way:
   the type grows to FIT.growMax (FIT.listGrowMax on the ribbon style) and
   what is left over is dealt out as SPACE between the rows (`gapEm`), with
   the remainder split above and below (`offsetEm`) — centred on the ribbon
   style, which has no title above the list to hold a short one up. Rows are
   spaced further APART rather than made taller: a row's own height is what
   its bar, its line count, its zebra band and its rule are drawn from.

   On the ribbon style the logo sits at the foot of the page, and a row
   whose reminder would pass it is measured again narrower, to wrap short
   of it. That moves the rows below it, so the solve is repeated until no
   new row reaches the logo: rows are only ever ADDED to the narrow set, so
   it settles in a pass or two.

   Packs rows onto pages when even minFit could not hold them all, and
   deals them out evenly between the pages rather than filling each in
   turn. Two-column specs never paginate: they shrink instead. */
export function layoutList(spec, options, requestRender) {
  const cfg = spec.cfg;
  const fonts = fontsOf(cfg, options);
  const geo = geometry(spec);
  const m = metrics(spec);
  const two = spec.columns.length > 1;
  const bars = !!spec.bars;

  // icon ink measurement for every row's art
  const urls = new Set();
  spec.columns.forEach((c) => c.blocks.forEach((b) => b.rows.forEach((r) => r.icons.forEach((u) => urls.add(resolveSrc(u))))));
  normalizeIcons([...urls], requestRender);

  // column geometry (% of sheet width)
  const cols = two
    ? [{ x0: geo.x0, x1: geo.mid - geo.colGap / 2 }, { x0: geo.mid + geo.colGap / 2, x1: geo.x1 }]
    : [{ x0: geo.x0, x1: geo.x1 }];
  // the longest name on the night sheets, % of the width at density 1
  const namePx1 = m.nameH * U;
  const nameW1 = bars
    ? Math.max(0, ...(spec.names || []).map((n) => textWidth(n, `700 ${namePx1}px ${fonts.name}`) * 1.015)) / SHEET_W * 100
    : 0;
  const barAt = (d) => barColumn(two, d, m.iconEm, nameW1);
  /* the reminder's left edge, % of the width from the column's: past the
     name column on a bar row; on a stacked row the calibrated column, or
     clear of the icon once a short list has grown it past that */
  const textXAt = (d) => (bars ? barAt(d).textX
    : Math.max(NIGHT.textX - NIGHT.iconX, ((m.iconEm * d * U) / SHEET_W) * 100 + 0.6));
  const hangAt = (d) => (bars && cfg.hang !== false ? (barAt(d).hang / 100) * SHEET_W : 0);
  const hasHeadings = spec.columns.some((c) => c.heading);
  const listTop = geo.listTop + (hasHeadings ? (two ? 4.6 : 3.2) : 0);
  const availEm = geo.listBottom - listTop;
  const logo = logoPlan(spec, options, geo, requestRender);

  /* a stacked row with two icons (a jinx pair) needs its text pushed right
     of the second icon; everything else starts at the text column. Layout
     em at density d (the column is a fixed width, the icons are not) */
  const extraLeftEm = (row, d) => {
    const n = row.icons.length;
    if (bars || n < 2) return 0;
    const iconsEm = m.iconEm * 0.86 * (1 + (n - 1) * 0.62);
    return Math.max(0, iconsEm + 0.6 - (textXAt(d) / 100) * (SHEET_W / (U * d)));
  };
  /* the right edge of a row's reminder, % of the sheet width: the column's,
     or short of the logo for a row that passes it */
  const textRight = (ci, narrow) => (narrow && logo ? Math.min(cols[ci].x1, logo.x0 - G.logoClear) : cols[ci].x1);
  const textWidthPx = (row, ci, d, narrow) =>
    ((textRight(ci, narrow) - cols[ci].x0 - textXAt(d)) / 100) * SHEET_W - extraLeftEm(row, d) * U * d;

  /* one row's measurements at density d: its height, its line count and
     (bar rows) the height of its bar, all in layout em */
  const measure = (row, ci, d, narrow) => {
    let lines = 0;
    if (row.text) {
      const textPx = m.textSize * U * d;
      const { runs, base } = textRuns(row, cfg, fonts, textPx);
      const maxW = Math.max(40, textWidthPx(row, ci, d, narrow));
      lines = wrappedRunLineCount(runs, maxW, base, Math.max(40, maxW - hangAt(d)));
    }
    if (bars) {
      const blockEm = Math.max(Math.max(1, lines) * m.line + m.pad, m.nameH * 1.3);
      return { h: Math.max(blockEm + m.gap, m.iconEm + m.gap * 0.4), lines, blockEm };
    }
    let h;
    if (row.text) h = (row.name ? m.textTop : NIGHT.nameTop) + lines * m.line + m.gap;
    else h = NIGHT.nameTop + m.nameH + m.gap;
    if (row.icons.length) h = Math.max(h, m.iconEm + 0.5);
    h = Math.max(row.text ? NIGHT.rowMin * (cfg.rowGap == null ? 1 : Math.min(1, cfg.rowGap + 0.5)) : 0, h);
    return { h, lines, blockEm: 0 };
  };
  const headingEm = 2.9;

  // flatten each column to units; `key` is what the narrow set holds
  const colUnits = spec.columns.map((c, ci) => {
    const units = [];
    c.blocks.forEach((b, bi) => {
      if (b.heading) units.push({ type: 'heading', text: b.heading, h: headingEm + (bi ? 1.2 : 0), key: ci + ':h' + bi });
      b.rows.forEach((r, ri) => units.push({ type: 'row', row: r, col: ci, key: ci + ':' + bi + ':' + ri }));
    });
    return units;
  });
  /* A column that would be left too little room beside the logo — the
     right-hand one of two, or any column once the logo is moved well into
     the page — stops above the logo instead of wrapping round it: a
     reminder squeezed into a sliver there broke a word to a line. */
  const floorOf = (ci) => {
    if (!logo || cols[ci].x1 <= logo.x0 - G.logoClear) return null;
    const full = cols[ci].x1 - cols[ci].x0 - textXAt(1);
    const left = logo.x0 - G.logoClear - cols[ci].x0 - textXAt(1);
    return left < Math.max(18, full * 0.5) ? logo.y0 - G.logoClear : null;
  };
  const availCol = cols.map((_, ci) => {
    const floor = floorOf(ci);
    return floor == null ? availEm : Math.max(8, floor - listTop);
  });
  const narrow = new Set();
  const unitMeasure = (u, ci, d) => (u.type === 'row' ? measure(u.row, ci, d, narrow.has(u.key)) : { h: u.h, lines: 0, blockEm: 0 });
  const needAt = (ci, d) => colUnits[ci].reduce((n, u) => n + unitMeasure(u, ci, d).h, 0);
  const growMax = geo.ribbon ? FIT.listGrowMax : FIT.growMax;
  const spreadMax = geo.ribbon ? FIT.listSpreadMax : FIT.spreadMax;
  const minFit = clamp(Number(cfg.minFit) || 0.68, 0.3, 1);

  const solve = () => {
    // density
    let d = cfg.fit === false ? clamp(Number(cfg.density) || 1, 0.3, 2) : 1;
    let pagesN = 1;
    if (cfg.fit !== false) {
      let fit = 1;
      for (let iter = 0; iter < 3; iter++) {
        const f = clamp(Math.min(...colUnits.map((_, ci) => availCol[ci] / Math.max(needAt(ci, fit), 0.01))), 0.42, growMax);
        if (Math.abs(f - fit) < 0.002) { fit = f; break; }
        fit = f;
      }
      // two-column specs never paginate, so they shrink as far as they must
      if (fit >= minFit || !spec.paginate || two) d = fit;
      else {
        // the fewest pages that hold the list at a density still above
        // minFit, then the density that fills those pages evenly (never
        // above 1 — the reference pitch is the cap)
        const need1 = needAt(0, 1);
        pagesN = Math.max(1, Math.ceil((need1 * minFit) / availCol[0]));
        d = clamp((pagesN * availCol[0]) / need1, minFit, 1);
      }
    }

    /* pack (single column only paginates). Units are measured in layout em
       and drawn at `dd` of that, so a page holds availEm / dd of them. With
       more than one page the cap is the list's share of pagesN pages, so
       the last page is not a straggler under a full first one; if the
       rows cannot be dealt out that evenly, it falls back to the room a
       page actually has. */
    const pack = (dd, share) => {
      const pages = [];
      let page = { columns: cols.map(() => ({ units: [], used: 0 })) };
      colUnits.forEach((units, ci) => {
        const room = availCol[ci] / dd;
        const cap = share ? Math.min(room, share) : room;
        for (const u of units) {
          const mm = unitMeasure(u, ci, dd);
          const pc = page.columns[ci];
          if (pc.used + mm.h > cap + 0.001 && pc.units.length && spec.paginate && !two) {
            pages.push(page);
            page = { columns: cols.map(() => ({ units: [], used: 0 })) };
          }
          page.columns[ci].units.push({ ...u, hEm: mm.h, lines: mm.lines, blockEm: mm.blockEm, narrow: narrow.has(u.key) });
          page.columns[ci].used += mm.h;
        }
      });
      pages.push(page);
      return pages;
    };
    const balanced = (dd) => {
      if (!(spec.paginate && !two && pagesN > 1)) return pack(dd);
      const share = (needAt(0, dd) / pagesN) * 1.04;
      const even = pack(dd, share);
      return even.length <= pagesN ? even : pack(dd);
    };
    let pages = balanced(d);
    if (spec.paginate && !two) {
      for (let iter = 0; iter < 4 && pages.length > pagesN; iter++) {
        d = Math.max(minFit, d * 0.97);
        pages = balanced(d);
        if (d <= minFit) break;
      }
    }
    // a heading left stranded at the foot of a page moves to the next
    pages.forEach((p, pi) => {
      p.columns.forEach((pc, ci) => {
        const last = pc.units[pc.units.length - 1];
        if (last && last.type === 'heading' && pages[pi + 1]) {
          pc.units.pop();
          pages[pi + 1].columns[ci].units.unshift(last);
        }
      });
    });

    /* take up the rest of the page. The spacing is the most EVERY column
       can take, so none is pushed past its foot (or into the logo), and the
       same spacing goes on every column of the page: two night lists side
       by side are two lists, but a different row pitch in each reads as a
       mistake. A page the pack filled has no slack and solves to nothing,
       so a long script is untouched. */
    pages.forEach((p) => {
      let natural = 0;
      let units = 0;
      let gapEm = Infinity;
      const cs = p.columns.map((pc, ci) => {
        const nat = pc.units.reduce((a, u) => a + u.hEm, 0);
        const slack = availCol[ci] / d - nat;
        natural = Math.max(natural, nat);
        units = Math.max(units, pc.units.length);
        if (pc.units.length > 1) gapEm = Math.min(gapEm, Math.max(0, slack) / (pc.units.length - 1));
        return { slack, n: pc.units.length };
      });
      if (!isFinite(gapEm) || units < 2) gapEm = 0;
      gapEm = Math.min(gapEm, (spreadMax - 1) * (natural / Math.max(1, units)));
      p.gapEm = gapEm;
      const rest = Math.max(0, Math.min(...cs.map((c) => c.slack - gapEm * Math.max(0, c.n - 1))));
      p.offsetEm = geo.ribbon ? rest / 2 : Math.min(rest * FIT.topShare, FIT.listTopMax);
      // where every unit is drawn, in layout em from the top of its column
      p.columns.forEach((pc) => {
        let y = p.offsetEm;
        for (const u of pc.units) {
          u.yEm = y;
          y += u.hEm + gapEm;
        }
      });
    });
    return { pages, d };
  };

  let solved = solve();
  if (logo) {
    const zoneTop = logo.y0 - G.logoClear;
    for (let pass = 0; pass < 6; pass++) {
      let added = false;
      for (const p of solved.pages) {
        p.columns.forEach((pc, ci) => {
          if (cols[ci].x1 <= logo.x0 - G.logoClear || floorOf(ci) != null) return;
          for (const u of pc.units) {
            if (u.type !== 'row' || narrow.has(u.key)) continue;
            // the lowest point of the row's reminder on the page
            const lowEm = bars ? (u.hEm + u.blockEm) / 2 : u.hEm;
            if (listTop + (u.yEm + lowEm) * solved.d > zoneTop) {
              narrow.add(u.key);
              added = true;
            }
          }
        });
      }
      if (!added) break;
      solved = solve();
    }
  }

  return {
    pages: solved.pages, d: solved.d, cols, m, fonts, geo, logo, bars,
    bc: barAt(solved.d), hangPx: hangAt(solved.d), textXOff: textXAt(solved.d),
    listTop, two, extraLeftEm, textRight,
  };
}

/* ── render ─────────────────────────────────────────────────────────────── */

function reminderNodes(row, cfg, fonts, ed) {
  const out = [];
  const look = tokenLook(cfg, fonts);
  for (const p of reminderParts(smartTypography(row.text || ''))) {
    if (p.t === 'text') out.push(document.createTextNode(p.s));
    else if (p.t === 'token') {
      const s = el('span', { whiteSpace: 'nowrap' }, look ? p.s.toUpperCase() : p.s);
      if (look) {
        Object.assign(s.style, {
          fontFamily: look.family,
          fontWeight: '700',
          fontSize: '0.96em',
          letterSpacing: look.spacing + 'em',
        });
      }
      out.push(s);
    } else if (cfg.dotStyle === 'token') {
      const tok = el('span', {
        display: 'inline-block', width: '1.15em', height: '1.15em', borderRadius: '50%',
        background: '#efe6d2', border: `${Math.max(1, ed(0.06))}px solid #7a6a4a`, boxSizing: 'border-box',
        verticalAlign: '-0.28em', margin: '0 0.14em', overflow: 'hidden', position: 'relative',
      });
      if (row.icons[0]) {
        tok.append(iconImg(drawIcon(resolveSrc(row.icons[0])), {
          position: 'absolute', left: '8%', top: '8%', width: '84%', height: '84%', objectFit: 'contain',
        }));
      }
      out.push(tok);
    } else if (cfg.dotStyle !== 'none') {
      // DOT_W.dot is this box plus its margins
      out.push(el('span', {
        display: 'inline-block', width: '0.9em', height: '0.9em', borderRadius: '50%',
        background: cfg.dotColor || '#62489b', verticalAlign: '-0.14em', margin: '0 0.07em',
      }));
    }
  }
  return out;
}

/* the row's icons, left to right: a jinx row shows its pair, overlapped */
function rowIcons(row, node, top, size, cfg, options, ed) {
  const shiftX = ((Number(cfg.iconShiftX) || 0) / 100) * SHEET_W;
  const shiftY = (Number(cfg.iconShiftY) || 0) * U;
  row.icons.forEach((raw, k) => {
    const u2 = resolveSrc(raw);
    const fit = iconFit(u2) || ICON_IDENTITY;
    const sz = size * (row.icons.length > 1 ? 0.86 : 1);
    const ic = iconImg(drawIcon(u2), {
      position: 'absolute',
      left: px(shiftX + k * sz * 0.62),
      top: px(top + shiftY + (size - sz) / 2),
      width: px(sz), height: px(sz),
      objectFit: 'contain',
      transform: inkTransform(fit),
      transformOrigin: 'center',
      filter: iconFilter(options.iconEffect, cfg.iconShadow == null ? 1 : cfg.iconShadow, ed),
      zIndex: String(2 - k),
    });
    if (options.iconEffect === 'engraved') ic.style.mixBlendMode = 'multiply';
    node.append(ic);
  });
}

function rowShell(u, cfg, ed, mark, rowIndex) {
  const row = u.row;
  const node = el('div', { position: 'relative', height: px(ed(u.hEm)) });
  node.dataset.fsRow = row.id;
  if (cfg.zebra && rowIndex % 2 === 1) {
    node.append(el('div', {
      position: 'absolute', left: px(-ed(0.6)), right: px(-ed(0.4)), top: px(-ed(0.25)), bottom: px(ed(0.35)),
      background: 'rgba(40, 25, 10, 0.055)', borderRadius: px(ed(0.5)), mixBlendMode: 'multiply',
    }));
  }
  if (cfg.rowLines) {
    node.append(el('div', {
      position: 'absolute', left: '0', right: '0', bottom: px(ed(0.3)), height: px(Math.max(1, ed(0.05))),
      background: cfg.textColor || '#2b2b2b', opacity: '0.22',
    }));
  }
  if (mark && row.list) mark(node, 'nrow:' + row.list + ':' + row.id); // drag to reorder the night
  return node;
}

/* Both the name and the reminder have their CAPITALS centred on the bar,
   which is what the reference does (their baselines then land within a
   pixel or two of each other on a one-line row). Measured off the faces in
   a line-height:1 box: Goudy's baseline sits at 0.82 of it with capitals
   0.67 tall; Trade Gothic's at 0.72, capitals 0.74. So the name's box goes
   0.485 of its size above the centre line, and a reminder block, whose
   capitals would otherwise sit 0.15 of its size high, drops by that. */
const NAME_TOP = 0.82 - 0.67 / 2;
const TEXT_DROP = 0.74 / 2 - 0.22;

/* a ribbon-style row: icon, name right-aligned to the bar, the bar, the
   reminder beside it — all four centred on the reminder */
function barRowNode(u, ci, layout, cfg, options, ed, mark, rowIndex) {
  const { m, fonts, cols, bc } = layout;
  const row = u.row;
  const node = rowShell(u, cfg, ed, mark, rowIndex);
  const blockTop = (u.hEm - u.blockEm) / 2;
  const mid = blockTop + u.blockEm / 2;

  rowIcons(row, node, ed(mid - m.iconEm / 2), ed(m.iconEm), cfg, options, ed);

  if (row.name) {
    // right-aligned against the bar; a name too long for the room between
    // the icon and the bar is set smaller rather than run into either
    const text = (cfg.numbered && row.number ? row.number + '. ' : '') + smartTypography(row.name);
    const sizePx = ed(m.nameH);
    const room = Math.max(ed(m.nameH) * 2,
      ((bc.nameRight - bc.nameLeft - Math.max(0, Number(cfg.iconShiftX) || 0)) / 100) * SHEET_W);
    const natural = textWidth(text, `700 ${sizePx}px ${fonts.name}`) * 1.015;
    const fs = natural > room ? sizePx * (room / natural) : sizePx;
    node.append(el('div', {
      position: 'absolute', left: '0', width: px((bc.nameRight / 100) * SHEET_W),
      top: px(ed(mid) - fs * NAME_TOP),
      fontFamily: fonts.name, fontWeight: '700', fontSize: px(fs),
      lineHeight: '1', letterSpacing: '0.015em', whiteSpace: 'nowrap', textAlign: 'right',
      color: row.color,
    }, text));
  }

  node.append(el('div', {
    position: 'absolute',
    left: px((bc.barX / 100) * SHEET_W),
    top: px(ed(blockTop)),
    width: px(Math.max(2, (G.barW / 100) * SHEET_W)),
    height: px(ed(u.blockEm)),
    background: row.color,
  }));

  if (row.text) {
    const right = layout.textRight(ci, u.narrow);
    const w = ((right - cols[ci].x0 - bc.textX) / 100) * SHEET_W;
    node.append(el('div', {
      position: 'absolute',
      left: px((bc.textX / 100) * SHEET_W),
      top: px(ed(mid - (u.lines * m.line) / 2 + m.textSize * TEXT_DROP)),
      width: px(w),
      boxSizing: 'border-box',
      paddingLeft: px(layout.hangPx),
      textIndent: px(-layout.hangPx),
      fontFamily: fonts.text, fontWeight: '400',
      fontSize: px(ed(m.textSize)),
      lineHeight: px(ed(m.line)),
      color: cfg.textColor || '#2b2b2b',
    }, ...reminderNodes(row, cfg, fonts, ed)));
  }
  return node;
}

/* a classic row (and every jinx-page row): icon, the name, the reminder
   under it */
function stackedRowNode(u, ci, layout, cfg, options, ed, mark, rowIndex) {
  const { m, fonts, cols, textXOff } = layout;
  const row = u.row;
  const h = u.hEm;
  const node = rowShell(u, cfg, ed, mark, rowIndex);
  const extra = ed(layout.extraLeftEm(row, layout.d));
  const textW = ((layout.textRight(ci, u.narrow) - cols[ci].x0 - textXOff) / 100) * SHEET_W - extra;
  const textLeft = px((textXOff / 100) * SHEET_W + extra);
  const lines = row.text ? Math.max(1, u.lines || Math.round((h - (row.name ? m.textTop : NIGHT.nameTop) - m.gap) / m.line)) : 0;
  const blockH = (row.name ? m.textTop : NIGHT.nameTop) + lines * m.line;

  rowIcons(row, node, ed(Math.max(0, (blockH - m.iconEm) / 2)), ed(m.iconEm), cfg, options, ed);

  if (row.name) {
    const nameEl = el('div', {
      position: 'absolute', left: textLeft, top: px(ed(NIGHT.nameTop)),
      fontFamily: fonts.name, fontWeight: '700',
      fontSize: px(ed(m.nameH)),
      lineHeight: '1', letterSpacing: '0.015em', whiteSpace: 'nowrap',
      color: row.color,
    });
    if (row.nameParts) {
      row.nameParts.forEach((p) => nameEl.append(el('span', { color: p.color }, smartTypography(p.s))));
    } else {
      nameEl.append((cfg.numbered && row.number ? row.number + '. ' : '') + smartTypography(row.name));
    }
    node.append(nameEl);
  }
  if (row.text) {
    node.append(el('div', {
      position: 'absolute', left: textLeft, top: px(ed(row.name ? m.textTop : NIGHT.nameTop)),
      width: px(textW),
      fontFamily: fonts.text, fontWeight: '400',
      fontSize: px(ed(m.textSize)),
      lineHeight: px(ed(m.line)),
      color: cfg.textColor || '#2b2b2b',
    }, ...reminderNodes(row, cfg, fonts, ed)));
  }
  return node;
}

/* a fixed pseudo-random sequence, so the torn edge is the same every
   render (and in every export) */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return (s & 0xffff) / 0xffff;
  };
}

/* the paper's torn edge where the page meets the ribbon: a tan strip with
   a ragged right side, casting a little shadow onto the damask */
function paperEdge(e) {
  const rnd = seeded(20260923);
  const pts = [];
  const n = 70;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    // a slow wander plus a little grit, and now and then a deeper tear
    const wander = Math.sin(t * 19.3) * 7 + Math.sin(t * 47.1 + 1.3) * 5;
    const tear = rnd() < 0.07 ? -18 * rnd() : 0;
    pts.push(`${clamp(80 + wander * 0.8 + (rnd() - 0.5) * 8 + tear, 50, 98).toFixed(1)}% ${(t * 100).toFixed(2)}%`);
  }
  const clip = `polygon(0% 0%, ${pts.join(', ')}, 0% 100%)`;
  const w = G.edgeW * 1.8;
  const wrap = el('div', {
    position: 'absolute', top: '0', height: '100%',
    left: (100 - G.ribbonW - G.edgeW - w * 0.25) + '%', width: w + '%',
    filter: `drop-shadow(${e(0.1)}px 0 ${e(0.14)}px rgba(22, 14, 6, 0.55))`,
    pointerEvents: 'none',
  });
  wrap.append(el('div', {
    position: 'absolute', inset: '0',
    clipPath: clip,
    background: 'linear-gradient(90deg, rgba(158, 142, 110, 0) 0%, rgba(158, 142, 110, 0.6) 14%, #a08f6c 30%, #978665 70%, #8a795a 100%)',
  }));
  return wrap;
}

/* the colour a ribbon-style page's ribbon is drawn in: its own, or the
   script sheet's. app.js asks too, so an export waits for that recolour. */
export function nightRibbonColor(cfg, options) {
  return cfg.ribbonColor || options.sidebarColor;
}

/* the ribbon down the right edge, the title on it, and a page count under
   the title when the list runs to more than one page */
function ribbonNodes(spec, options, layout, pageIndex, ctx, mark, e) {
  const cfg = spec.cfg;
  const { geo, fonts } = layout;
  const nodes = [];
  if (geo.showRibbon) {
    const sbT = elGet(options, 'sidebar');
    const holder = document.createDocumentFragment();
    appendRibbon(holder, {
      mode: options.sidebarMode === 'flat' ? 'flat' : 'damask',
      color: nightRibbonColor(cfg, options),
      src: resolveSrc(sbT.src),
      widthPct: G.ribbonW + G.edgeW * 0.6,
      side: 'right',
    }, { requestRender: ctx.requestRender, forExport: ctx.forExport });
    nodes.push(...holder.childNodes);
    nodes.push(paperEdge(e));
  }

  const tT = elGet(options, spec.elPrefix + 'Title');
  if (!tT.hidden) {
    const text = String(spec.title || '').toUpperCase();
    // upright letters advance about an em less the letter spacing; a long
    // title shrinks to the ribbon rather than running off its foot
    const advance = 1 + G.titleSpacing;
    const room = (100 - G.titleTop - 12) * U;
    const fitPx = room / Math.max(1, text.length * advance);
    const fs = clamp(fitPx, e(G.titleMin), e(G.titleSize)) * tT.scale;
    const onRibbon = geo.showRibbon;
    const title = el('div', {
      position: 'absolute',
      left: (100 - G.ribbonW / 2 + tT.dx) + '%',
      top: px(e(G.titleTop + tT.dy)),
      transform: `translateX(-50%)${tT.rot ? ` rotate(${tT.rot}deg)` : ''}`,
      transformOrigin: '50% 0',
      writingMode: 'vertical-rl',
      textOrientation: 'upright',
      fontFamily: fonts.title,
      fontSize: px(fs),
      lineHeight: '1',
      letterSpacing: G.titleSpacing + 'em',
      color: onRibbon ? (options.labelColor || '#eeeeee') : (cfg.titleColor || '#1c1c1c'),
      opacity: String(tT.opacity),
      whiteSpace: 'nowrap',
      filter: onRibbon
        ? 'drop-shadow(0.6px 0.6px 1.8px rgba(34,34,34,0.66)) drop-shadow(-0.6px 0.6px 1.8px rgba(34,34,34,0.53)) drop-shadow(0.6px -0.6px 1.8px rgba(34,34,34,0.66)) drop-shadow(-0.6px -0.6px 1.8px rgba(34,34,34,0.66))'
        : 'none',
    }, text);
    nodes.push(mark(title, 'el:' + spec.elPrefix + 'Title'));
    if (layout.pages.length > 1) {
      nodes.push(el('div', {
        position: 'absolute',
        left: (100 - G.ribbonW / 2) + '%',
        bottom: px(e(2.2)),
        transform: 'translateX(-50%)',
        fontFamily: fonts.name,
        fontSize: px(e(1.25)),
        lineHeight: '1',
        whiteSpace: 'nowrap',
        color: onRibbon ? (options.labelColor || '#eeeeee') : (cfg.titleColor || '#1c1c1c'),
        opacity: String(0.9 * tT.opacity),
        filter: onRibbon ? 'drop-shadow(0 0.6px 1.6px rgba(34,34,34,0.7))' : 'none',
      }, (pageIndex + 1) + '/' + layout.pages.length));
    }
  }
  return nodes;
}

/* the logo, or the script's name, at the foot of a ribbon-style page */
function footLogo(script, spec, options, layout, ctx, mark, e) {
  const plan = layout.logo;
  if (!plan) return null;
  const { lT } = plan;
  const rot = lT.rot ? ` rotate(${lT.rot}deg)` : '';
  if (plan.kind === 'img') {
    const style = {
      position: 'absolute',
      right: plan.right + '%',
      bottom: px(e(plan.bottom)),
      transform: rot.trim() || '',
      transformOrigin: '100% 100%',
      objectFit: 'contain',
      objectPosition: '100% 100%',
      opacity: String(lT.opacity),
      filter: `drop-shadow(${e(0.06)}px ${e(0.1)}px ${e(0.12)}px rgba(40, 26, 10, 0.35))`,
    };
    if (plan.known) {
      style.width = px((plan.w / 100) * SHEET_W);
      style.height = px(plan.h * U);
    } else {
      style.maxWidth = plan.w + '%';
      style.maxHeight = px(plan.h * U);
    }
    const logoEl = img(plan.src, style, script.meta.name);
    logoEl.crossOrigin = 'anonymous';
    logoEl.addEventListener('error', () => {
      failedArt.add(plan.src);
      if (ctx.requestRender) ctx.requestRender();
    });
    return mark(logoEl, 'el:' + spec.elPrefix + 'Logo');
  }
  const nameEl = el('div', {
    position: 'absolute',
    right: plan.right + '%',
    bottom: px(e(plan.bottom)),
    transform: rot.trim() || '',
    transformOrigin: '100% 100%',
    maxWidth: plan.w + 0.5 + '%',
    fontFamily: layout.fonts.logo,
    fontSize: px(e(plan.size)),
    lineHeight: '1.15',
    color: options.titleColor || '#10102e',
    opacity: String(lT.opacity),
    whiteSpace: 'nowrap',
    textAlign: 'right',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    wordSpacing: (options.fontTitle || 'unlovable') === 'unlovable' ? '-0.21em' : '0',
    mixBlendMode: 'multiply',
  }, plan.title);
  nameEl.dataset.fsFitName = String(e(plan.size));
  return mark(nameEl, 'el:' + spec.elPrefix + 'Logo');
}

/* the classic chrome: the title at the top left, the logo at the top right */
function classicHead(script, spec, options, layout, pageIndex, ctx, mark, e) {
  const cfg = spec.cfg;
  const { fonts } = layout;
  const P = spec.elPrefix;
  const nodes = [];
  const tT = elGet(options, P + 'Title');
  if (!tT.hidden) {
    const suffix = layout.pages.length > 1 ? ' (' + (pageIndex + 1) + '/' + layout.pages.length + ')' : '';
    const titleEl = el('div', {
      position: 'absolute',
      left: (NIGHT.titleX + tT.dx) + '%',
      top: px(e(NIGHT.titleCY + tT.dy)),
      transform: `translateY(-50%)${tT.rot ? ` rotate(${tT.rot}deg)` : ''}`,
      transformOrigin: '0 50%',
      fontFamily: fonts.title,
      fontWeight: '700', // synthetic bold of the 400 cut — the reference's own weight
      fontSize: px(e(NIGHT.titleSize) * tT.scale),
      lineHeight: '1',
      color: cfg.titleColor || '#1c1c1c',
      opacity: String(tT.opacity),
      whiteSpace: 'nowrap',
      letterSpacing: '0.01em',
    }, spec.title + suffix);
    nodes.push(mark(titleEl, 'el:' + P + 'Title'));
  }

  const lT = elGet(options, P + 'Logo');
  if (!lT.hidden) {
    const custom = resolveSrc(lT.src);
    let logoSrc = custom || (cfg.showLogo !== false && script.meta.logo && options.useLogo
      ? proxied(script.meta.logo, options.proxyIcons) : '');
    if (logoSrc && failedArt.has(logoSrc)) logoSrc = '';
    if (logoSrc) {
      const logoEl = img(logoSrc, {
        position: 'absolute',
        right: (NIGHT.logoRight - lT.dx) + '%',
        top: px(e(NIGHT.logoCY + lT.dy)),
        transform: `translateY(-50%)${lT.rot ? ` rotate(${lT.rot}deg)` : ''}`,
        transformOrigin: '100% 50%',
        maxWidth: (NIGHT.logoMaxW * lT.scale) + '%',
        maxHeight: px(e(NIGHT.logoMaxH) * lT.scale),
        objectFit: 'contain',
        opacity: String(lT.opacity),
        filter: `drop-shadow(${e(0.06)}px ${e(0.1)}px ${e(0.1)}px rgba(40, 26, 10, 0.35))`,
      }, script.meta.name);
      logoEl.crossOrigin = 'anonymous';
      logoEl.addEventListener('error', () => {
        failedArt.add(logoSrc);
        if (ctx.requestRender) ctx.requestRender();
      });
      nodes.push(mark(logoEl, 'el:' + P + 'Logo'));
    } else if (cfg.showName !== false) {
      const title = (options.titleOverride || '').trim() || script.meta.name;
      const nameEl = el('div', {
        position: 'absolute',
        right: (NIGHT.logoRight - lT.dx) + '%',
        top: px(e(NIGHT.logoCY + lT.dy)),
        transform: `translateY(-50%)${lT.rot ? ` rotate(${lT.rot}deg)` : ''}`,
        transformOrigin: '100% 50%',
        maxWidth: (NIGHT.logoMaxW + 12) + '%',
        fontFamily: fonts.logo,
        fontSize: px(e(3.4) * lT.scale),
        lineHeight: '1',
        color: options.titleColor || '#10102e',
        opacity: String(lT.opacity),
        whiteSpace: 'nowrap',
        textAlign: 'right',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        wordSpacing: (options.fontTitle || 'unlovable') === 'unlovable' ? '-0.21em' : '0',
        mixBlendMode: 'multiply',
      }, title);
      nameEl.dataset.fsFitName = String(e(3.4) * lT.scale);
      nodes.push(mark(nameEl, 'el:' + P + 'Logo'));
    }
  }
  return nodes;
}

/* renderListPage(spec, options, layout, pageIndex, ctx) → element */
export function renderListPage(script, spec, options, layout, pageIndex, ctx) {
  ctx = ctx || {};
  const selected = ctx.selected || '';
  const cfg = spec.cfg;
  const { d, fonts, cols, listTop, geo } = layout;
  const page = layout.pages[Math.min(pageIndex, layout.pages.length - 1)];
  const ed = (em) => em * U * d;
  const e = (em) => em * U;
  const P = spec.elPrefix;
  const mark = (node, id) => {
    node.dataset.fsDrag = id;
    if (id === selected) markSelected(node);
    return node;
  };

  const sheet = pageFrame(SHEET_W, SHEET_H, U, spec.kind === 'jinx' ? 'script-jinx' : 'script-night');
  sheet.dataset.fsPage = String(pageIndex);
  sheet.dataset.fsDensity = d.toFixed(3);
  const scriptBg = script.meta.background ? proxied(script.meta.background, options.proxyIcons) : '';
  for (const n of renderBackground(cfg.bg, 'list', { scriptBg })) sheet.append(n);
  for (const n of renderStickers(ctx.stickers, selected, true)) sheet.append(n);

  if (geo.ribbon) {
    for (const n of ribbonNodes(spec, options, layout, pageIndex, ctx, mark, e)) sheet.append(n);
    const logoEl = footLogo(script, spec, options, layout, ctx, mark, e);
    if (logoEl) sheet.append(logoEl);
  } else {
    for (const n of classicHead(script, spec, options, layout, pageIndex, ctx, mark, e)) sheet.append(n);
  }

  // the list(s)
  const listT = elGet(options, P + 'List');
  const listWrap = el('div', {
    position: 'absolute', inset: '0',
    opacity: String(listT.opacity),
    display: listT.hidden ? 'none' : 'block',
    transform: (listT.dx || listT.dy) ? `translate(${(listT.dx / 100) * SHEET_W}px, ${listT.dy * U}px)` : '',
    pointerEvents: 'none',
  });
  if (listT.scale !== 1) {
    listWrap.style.transformOrigin = '0 0';
    listWrap.style.transform += ` scale(${listT.scale})`;
  }
  listWrap.dataset.fsEl = P + 'List';
  page.columns.forEach((pc, ci) => {
    const col = el('div', {
      position: 'absolute',
      left: cols[ci].x0 + '%',
      top: px(e(listTop)),
      width: (cols[ci].x1 - cols[ci].x0) + '%',
      pointerEvents: 'auto',
    });
    if (spec.columns[ci].heading) {
      col.append(el('div', {
        position: 'absolute', left: '0', top: px(e(-4.4)),
        fontFamily: fonts.title, fontWeight: '700', fontSize: px(e(2.1)), lineHeight: '1',
        color: cfg.titleColor || '#1c1c1c', whiteSpace: 'nowrap',
      }, spec.columns[ci].heading));
    }
    let rowIndex = 0;
    for (const u of pc.units) {
      if (u.type === 'heading') {
        col.append(el('div', {
          position: 'absolute', left: '0', top: px(ed(u.yEm) + ed(u.hEm - 2.9) + ed(0.5)),
          fontFamily: fonts.title, fontWeight: '700', fontSize: px(ed(2.0)), lineHeight: '1',
          color: cfg.titleColor || '#1c1c1c', whiteSpace: 'nowrap',
        }, u.text));
        continue;
      }
      const rn = layout.bars
        ? barRowNode(u, ci, layout, cfg, options, ed, mark, rowIndex++)
        : stackedRowNode(u, ci, layout, cfg, options, ed, mark, rowIndex++);
      rn.style.position = 'absolute';
      rn.style.left = '0';
      rn.style.right = '0';
      rn.style.top = px(ed(u.yEm));
      col.append(rn);
    }
    listWrap.append(col);
  });
  sheet.append(listWrap);

  for (const n of renderStickers(ctx.stickers, selected, false)) sheet.append(n);
  return sheet;
}

/* after the page is in the document: a long script name in the logo's
   place shrinks to its band instead of being cut short */
export function fitListPage(sheet) {
  const nameEl = sheet.querySelector('[data-fs-fit-name]');
  if (!nameEl) return;
  const natural = Number(nameEl.dataset.fsFitName);
  nameEl.style.fontSize = px(natural);
  nameEl.style.overflow = 'visible';
  nameEl.style.textOverflow = 'clip';
  const maxW = nameEl.clientWidth || (SHEET_W * 0.42);
  const w = nameEl.scrollWidth;
  if (w > maxW + 1) nameEl.style.fontSize = px(Math.max(natural * 0.35, natural * (maxW / w)));
}
