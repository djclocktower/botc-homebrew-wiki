/* Fancy Scripts — the night order sheets (and the jinx page).
 *
 * The official-style night sheet: "First Night" in Dumbledor at the top
 * left, the script's logo at the top right, then one row per step down
 * the page — the character's icon, its name in team-coloured Goudy, and
 * the Storyteller's reminder in Trade Gothic with the info tokens (*YOU
 * ARE*) set in bold condensed caps and each ':reminder:' placement drawn
 * as a dot. Dusk, Minion Info, Demon Info and Dawn take their places
 * between the characters. Calibrated from the owner's reference sheets
 * (NIGHT in script.js).
 *
 * It is written as a LIST-PAGE renderer: a page is one or two columns of
 * blocks, a block is an optional heading over rows, a row is icon(s) +
 * name + text. The night sheets are one column; "both nights on one
 * page" is two; the jinx page is one column of three blocks (jinxes,
 * house rules, notes). One renderer, so the pages cannot drift apart.
 *
 * Same contract as sheet.js: inline styles only, data-fs-drag on the
 * movable pieces, a measured layout pass (layoutList) that solves the
 * density and packs rows onto pages, then a render pass per page.
 * Browser-only.
 */

import {
  NIGHT, SHEET_W, SHEET_H, U, PLACEHOLDER_ICON, STEP_ICONS,
  nightLists, reminderParts, smartTypography, teamColor, fontFamily, elGet, sortCharacters, proxied,
} from './script.js';
import {
  el, img, px, clamp, wrappedRunLineCount, normalizeIcons, iconFit, inkTransform, iconFilter, ICON_IDENTITY,
} from './util.js';
import { pageFrame, renderBackground, renderStickers, resolveSrc, markSelected } from './elements.js';

const BADGE = '/assets/ccc-parchment.png';

function iconImg(src, style, alt) {
  const n = img(src, style, alt);
  n.crossOrigin = 'anonymous';
  n.addEventListener('error', () => {
    if (n.src !== PLACEHOLDER_ICON) n.src = PLACEHOLDER_ICON;
  });
  return n;
}

/* ── specs ─────────────────────────────────────────────────────────────── */

/* the colour a row's name prints in */
function rowColor(item, options, cfg) {
  if (item.kind === 'step') return cfg.metaColor || '#1c1c1c';
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
  return {
    kind: 'night',
    which,
    elPrefix: 'night',
    title: which === 'both' ? 'Night Order' : (which === 'first' ? (cfg.titleFirst || 'First Night') : (cfg.titleOther || 'Other Nights')),
    columns,
    cfg,
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
    cfg, numbered: false, paginate: true,
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

/* the text runs a row's reminder wraps in, for measuring: plain runs in
   the text face, tokens in the token face (upper-cased when caps is on),
   a dot as a token-sized gap */
function textRuns(row, cfg, fonts, textPx) {
  const base = `400 ${textPx}px ${fonts.text}`;
  const tokenFont = cfg.tokenStyle === 'plain' ? base
    : `700 ${(textPx * 0.96).toFixed(2)}px ${cfg.tokenStyle === 'bold' ? fonts.text : fonts.token}`;
  const runs = [];
  for (const p of reminderParts(smartTypography(row.text || ''))) {
    if (p.t === 'text') runs.push({ s: p.s, font: base });
    else if (p.t === 'token') runs.push({ s: cfg.tokenStyle === 'plain' ? p.s : p.s.toUpperCase(), font: tokenFont });
    else if (cfg.dotStyle !== 'none') runs.push({ s: cfg.dotStyle === 'token' ? '●●' : '●', font: base });
  }
  return { runs, base };
}

/* the geometry every row shares at density 1 (em) */
function metrics(cfg) {
  const nameH = NIGHT.nameSize * (cfg.nameSize || 1);
  const textTop = NIGHT.nameTop + nameH * 1.12;
  const line = NIGHT.textLine * (cfg.textSize || 1);
  const iconEm = NIGHT.iconSize * (cfg.iconSize || 1);
  const gap = NIGHT.rowGap * (cfg.rowGap == null ? 1 : cfg.rowGap);
  return { nameH, textTop, line, iconEm, gap };
}

/* layoutList(spec, options, requestRender) → {pages, d, cols, m, fonts}
   Solves the density like the sheet does — the reference pitch (d = 1)
   is the cap, a short list simply leaves room — and packs rows onto
   pages when even minFit could not hold them all. Two-column specs never
   paginate: they shrink instead. */
export function layoutList(spec, options, requestRender) {
  const cfg = spec.cfg;
  const fonts = fontsOf(cfg, options);
  const m = metrics(cfg);
  const two = spec.columns.length > 1;

  // icon ink measurement for every row's art
  const urls = new Set();
  spec.columns.forEach((c) => c.blocks.forEach((b) => b.rows.forEach((r) => r.icons.forEach((u) => urls.add(resolveSrc(u))))));
  normalizeIcons([...urls], requestRender);

  // column geometry (% of sheet width)
  const cols = two
    ? [
      { x0: NIGHT.iconX, x1: 50 - NIGHT.colGap / 2 },
      { x0: 50 + NIGHT.colGap / 2, x1: 100 - NIGHT.textRight },
    ]
    : [{ x0: NIGHT.iconX, x1: 100 - NIGHT.textRight }];
  const textXOff = NIGHT.textX - NIGHT.iconX; // name/text left, relative to the column
  const hasHeadings = spec.columns.some((c) => c.heading);
  const listTop = NIGHT.listTop + (hasHeadings ? (two ? 4.6 : 3.2) : 0);
  const availEm = NIGHT.listBottom - listTop;

  /* a row with two icons (a jinx pair) needs its text pushed right of the
     second icon; everything else starts at the calibrated text column */
  const extraLeftEm = (row) => {
    const n = row.icons.length;
    if (n < 2) return 0;
    const iconsEm = m.iconEm * 0.86 * (1 + (n - 1) * 0.62);
    return Math.max(0, iconsEm + 0.6 - (textXOff / 100) * (SHEET_W / U));
  };
  const rowHeightEm = (row, colW, d) => {
    let h;
    if (row.text) {
      const textPx = NIGHT.textSize * (cfg.textSize || 1) * U * d;
      const { runs, base } = textRuns(row, cfg, fonts, textPx);
      const maxW = ((colW - textXOff) / 100) * SHEET_W - extraLeftEm(row) * U * d;
      const lines = wrappedRunLineCount(runs, maxW, base);
      h = (row.name ? m.textTop : NIGHT.nameTop) + lines * m.line + m.gap;
    } else {
      h = NIGHT.nameTop + m.nameH + m.gap;
    }
    if (row.icons.length) h = Math.max(h, m.iconEm + 0.5);
    return Math.max(row.text ? NIGHT.rowMin * (cfg.rowGap == null ? 1 : Math.min(1, cfg.rowGap + 0.5)) : 0, h);
  };
  const headingEm = 2.9;

  // flatten each column to units
  const colUnits = spec.columns.map((c, ci) => {
    const units = [];
    c.blocks.forEach((b, bi) => {
      if (b.heading) units.push({ type: 'heading', text: b.heading, h: headingEm + (bi ? 1.2 : 0) });
      b.rows.forEach((r) => units.push({ type: 'row', row: r, col: ci }));
    });
    return units;
  });
  const colW = (ci) => cols[ci].x1 - cols[ci].x0;
  const unitH = (u, ci, d) => (u.type === 'row' ? rowHeightEm(u.row, colW(ci), d) : u.h);
  const needAt = (ci, d) => colUnits[ci].reduce((n, u) => n + unitH(u, ci, d), 0);

  // density
  let d = cfg.fit === false ? clamp(Number(cfg.density) || 1, 0.3, 2) : 1;
  const minFit = clamp(Number(cfg.minFit) || 0.68, 0.3, 1);
  let pagesN = 1;
  if (cfg.fit !== false) {
    let fit = 1;
    for (let iter = 0; iter < 3; iter++) {
      const need = Math.max(...colUnits.map((_, ci) => needAt(ci, fit)));
      const f = clamp(availEm / Math.max(need, 0.01), 0.42, 1);
      if (Math.abs(f - fit) < 0.002) { fit = f; break; }
      fit = f;
    }
    if (fit >= minFit || !spec.paginate) d = fit;
    else {
      const need1 = needAt(0, 1);
      pagesN = Math.max(1, Math.ceil(need1 / availEm));
      d = clamp((pagesN * availEm) / need1, minFit, 1);
    }
  }

  // pack (single column only paginates)
  const pack = (dd) => {
    const pages = [];
    let page = { columns: cols.map(() => ({ units: [], used: 0 })) };
    colUnits.forEach((units, ci) => {
      const cap = availEm;
      for (const u of units) {
        const h = unitH(u, ci, dd);
        const pc = page.columns[ci];
        if (pc.used + h > cap + 0.001 && pc.units.length && spec.paginate && !two) {
          pages.push(page);
          page = { columns: cols.map(() => ({ units: [], used: 0 })) };
        }
        page.columns[ci].units.push({ ...u, hEm: h });
        page.columns[ci].used += h;
      }
    });
    pages.push(page);
    return pages;
  };
  let pages = pack(d);
  if (spec.paginate && !two) {
    for (let iter = 0; iter < 4 && pages.length > pagesN; iter++) {
      d = Math.max(minFit, d * 0.97);
      pages = pack(d);
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

  return { pages, d, cols, m, fonts, listTop, textXOff, two, extraLeftEm };
}

/* ── render ─────────────────────────────────────────────────────────────── */

function reminderNodes(row, cfg, fonts, ed) {
  const out = [];
  for (const p of reminderParts(smartTypography(row.text || ''))) {
    if (p.t === 'text') out.push(document.createTextNode(p.s));
    else if (p.t === 'token') {
      const s = el('span', { whiteSpace: 'nowrap' }, cfg.tokenStyle === 'plain' ? p.s : p.s.toUpperCase());
      if (cfg.tokenStyle !== 'plain') {
        Object.assign(s.style, {
          fontFamily: cfg.tokenStyle === 'bold' ? fonts.text : fonts.token,
          fontWeight: '700',
          fontSize: '0.96em',
          letterSpacing: '0.01em',
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
        tok.append(iconImg(resolveSrc(row.icons[0]), {
          position: 'absolute', left: '8%', top: '8%', width: '84%', height: '84%', objectFit: 'contain',
        }));
      }
      out.push(tok);
    } else if (cfg.dotStyle !== 'none') {
      out.push(el('span', {
        display: 'inline-block', width: '0.62em', height: '0.62em', borderRadius: '50%',
        background: cfg.textColor || '#2b2b2b', verticalAlign: '-0.02em', margin: '0 0.1em',
      }));
    }
  }
  return out;
}

function rowNode(u, ci, layout, cfg, options, ed, e, mark) {
  const { m, fonts, cols, textXOff } = layout;
  const row = u.row;
  const h = u.hEm;
  const node = el('div', { position: 'relative', height: px(ed(h)) });
  node.dataset.fsRow = row.id;
  if (mark && row.list) mark(node, 'nrow:' + row.list + ':' + row.id); // drag to reorder the night
  const extra = ed(layout.extraLeftEm(row));
  const textW = ((cols[ci].x1 - cols[ci].x0 - textXOff) / 100) * SHEET_W - extra;
  const textLeft = px((textXOff / 100) * SHEET_W + extra);
  const lines = row.text ? Math.max(1, Math.round((h - (row.name ? m.textTop : NIGHT.nameTop) - m.gap) / m.line)) : 0;
  const blockH = (row.name ? m.textTop : NIGHT.nameTop) + lines * m.line;

  // icon(s): a jinx row shows the pair, overlapped
  row.icons.forEach((raw, k) => {
    const u2 = resolveSrc(raw);
    const fit = iconFit(u2) || ICON_IDENTITY;
    const size = ed(m.iconEm) * (row.icons.length > 1 ? 0.86 : 1);
    const ic = iconImg(u2, {
      position: 'absolute',
      left: px(k * size * 0.62),
      top: px(ed(Math.max(0, (blockH - m.iconEm) / 2))),
      width: px(size), height: px(size),
      objectFit: 'contain',
      transform: inkTransform(fit),
      transformOrigin: 'center',
      filter: iconFilter(options.iconEffect, cfg.iconShadow == null ? 1 : cfg.iconShadow, ed),
      zIndex: String(2 - k),
    });
    if (options.iconEffect === 'engraved') ic.style.mixBlendMode = 'multiply';
    node.append(ic);
  });

  if (row.name) {
    const nameEl = el('div', {
      position: 'absolute', left: textLeft, top: px(ed(NIGHT.nameTop)),
      fontFamily: fonts.name, fontWeight: '700',
      fontSize: px(ed(NIGHT.nameSize * (cfg.nameSize || 1))),
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
      fontSize: px(ed(NIGHT.textSize * (cfg.textSize || 1))),
      lineHeight: px(ed(m.line)),
      color: cfg.textColor || '#2b2b2b',
    }, ...reminderNodes(row, cfg, fonts, ed)));
  }
  return node;
}

/* renderListPage(spec, options, layout, pageIndex, ctx) → element */
export function renderListPage(script, spec, options, layout, pageIndex, ctx) {
  ctx = ctx || {};
  const selected = ctx.selected || '';
  const cfg = spec.cfg;
  const { d, fonts, cols, listTop } = layout;
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

  // page title, top left
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
    sheet.append(mark(titleEl, 'el:' + P + 'Title'));
  }

  // the script's logo (or its name) at the top right
  const lT = elGet(options, P + 'Logo');
  if (!lT.hidden) {
    const custom = resolveSrc(lT.src);
    const logoSrc = custom || (cfg.showLogo !== false && script.meta.logo && options.useLogo
      ? script.meta.logo : '');
    if (logoSrc) {
      const logoEl = iconImg(custom ? custom : logoSrc, {
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
      if (!custom) logoEl.src = logoSrc.startsWith('data:') ? logoSrc : logoSrc;
      sheet.append(mark(logoEl, 'el:' + P + 'Logo'));
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
      sheet.append(mark(nameEl, 'el:' + P + 'Logo'));
    }
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
    let y = 0;
    for (const u of pc.units) {
      if (u.type === 'heading') {
        const hd = el('div', {
          position: 'absolute', left: '0', top: px(ed(y) + ed(u.hEm - 2.9) + ed(0.5)),
          fontFamily: fonts.title, fontWeight: '700', fontSize: px(ed(2.0)), lineHeight: '1',
          color: cfg.titleColor || '#1c1c1c', whiteSpace: 'nowrap',
        }, u.text);
        col.append(hd);
      } else {
        const rn = rowNode(u, ci, layout, cfg, options, ed, e, mark);
        rn.style.position = 'absolute';
        rn.style.left = '0';
        rn.style.right = '0';
        rn.style.top = px(ed(y));
        col.append(rn);
      }
      y += u.hEm;
    }
    listWrap.append(col);
  });
  sheet.append(listWrap);

  // footer lines, bottom right
  const fT = elGet(options, P + 'Footer');
  if (cfg.showFooter !== false && !fT.hidden && ((cfg.footer1 || '').trim() || (cfg.footer2 || '').trim())) {
    const foot = el('div', {
      position: 'absolute',
      right: (NIGHT.footerRight - fT.dx) + '%',
      top: px(e(NIGHT.footerTop + fT.dy)),
      textAlign: 'right',
      fontFamily: fonts.name,
      fontSize: px(e(NIGHT.footerSize) * fT.scale),
      lineHeight: px(e(NIGHT.footerLine) * fT.scale),
      color: cfg.textColor || '#2b2b2b',
      opacity: String(fT.opacity * 0.85),
      transform: fT.rot ? `rotate(${fT.rot}deg)` : '',
      transformOrigin: '100% 0',
      whiteSpace: 'nowrap',
    });
    if ((cfg.footer1 || '').trim()) foot.append(el('div', null, smartTypography(cfg.footer1)));
    if ((cfg.footer2 || '').trim()) foot.append(el('div', null, smartTypography(cfg.footer2)));
    sheet.append(mark(foot, 'el:' + P + 'Footer'));
  }

  // the Community Created Content badge, bottom left
  const bT = elGet(options, P + 'Badge');
  if (cfg.showBadge !== false && !bT.hidden) {
    const badge = img(resolveSrc(bT.src) || BADGE, {
      position: 'absolute',
      left: (NIGHT.badgeX + bT.dx) + '%',
      bottom: px(e(NIGHT.badgeBottom - bT.dy)),
      width: (NIGHT.badgeW * bT.scale) + '%',
      opacity: String(bT.opacity),
      transform: bT.rot ? `rotate(${bT.rot}deg)` : '',
    });
    sheet.append(mark(badge, 'el:' + P + 'Badge'));
  }

  for (const n of renderStickers(ctx.stickers, selected)) sheet.append(n);
  return sheet;
}

/* after the page is in the document: a long script name at the top right
   shrinks to its band instead of being cut short */
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
