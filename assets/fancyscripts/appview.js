/* Fancy Scripts — the app view.
 *
 * The official app's own script view, as a second style for the script
 * sheet and for the night sheets (options.sheetStyle / options.night.style
 * = 'app'). One column down the page:
 *
 *   script sheet   [ribbon + team name] icon  Name  | ability…
 *   night sheet    [ribbon]             icon  Name  | reminder… ●
 *
 * a red damask ribbon with the team names turned up it, a coloured bar
 * between the name and the text, thin lines between the teams, the
 * script's logo (the sheet's title, and after the night list), and the
 * "*Not the first night" footnote in the garland's oval. Geometry is
 * APP_SHEET / APP_NIGHT in script.js, measured off the owner's
 * screenshots of the app; the look is options.app (DEFAULT_APP).
 *
 * It keeps the classic renderers' contracts so the rest of the tool does
 * not need to know which style a page is in: inline styles only (the
 * export captures these nodes), data-fs-drag on everything movable
 * ('crow:' / 'nrow:' rows reorder exactly as on the classic pages, 'char:'
 * icons nudge), a layout pass that measures, solves the density and packs
 * pages, then a render pass per page. The layouts carry the fields
 * app.js's reorderFront / reorderNight read (sections with left/leftHeights/
 * topPx; pages with columns of units).
 *
 * Unlike the classic sheet, the text is broken into lines HERE
 * (breakRuns in script.js) and each line is drawn as its own nowrap
 * block, because the bar beside a block has to be exactly as tall as the
 * block, and a night line carrying a reminder disc is taller than one that
 * does not. The layout pass and the render pass read the same breaks.
 * Browser-only (canvas + DOM).
 */

import {
  APP_SHEET, APP_NIGHT, FIT, SHEET_W, SHEET_H, U, TEAM_LABELS, PLACEHOLDER_ICON,
  groupByTeam, proxied, smartTypography, teamColor, fontFamily, elGet, reminderParts,
  breakRuns, fitNameLines,
} from './script.js';
import {
  el, img, px, clamp, textWidth, normalizeIcons, iconFit, inkTransform, iconFilter, ICON_IDENTITY, drawIcon,
} from './util.js';
import { ART, pageFrame, renderBackground, renderStickers, resolveSrc, applyEl, markSelected } from './elements.js';
import { appendRibbon } from './sheet.js';

const BADGE = '/assets/ccc-parchment.png';

function iconImg(src, style, alt) {
  const n = img(src, style, alt);
  n.crossOrigin = 'anonymous';
  n.decoding = 'sync';
  n.addEventListener('error', () => {
    if (n.src !== PLACEHOLDER_ICON) n.src = PLACEHOLDER_ICON;
  });
  return n;
}

/* title art that failed to load: fall back to the text title */
const failedArt = new Set();

const appCfg = (options) => options.app || {};
const sum = (a) => a.reduce((x, y) => x + y, 0);

/* the centre of the parchment right of the ribbon, where the app centres
   its logo and its footer */
const paperCX = (ribbonW) => (ribbonW + 100) / 2;

function fontsOf(options, cfg) {
  const a = appCfg(options);
  return {
    name: fontFamily(a.fontName || 'tradebold'),
    text: fontFamily(a.fontText || 'trade'),
    label: fontFamily(a.fontLabel || 'goudy'),
    token: fontFamily((cfg && cfg.fontToken) || 'tradebold'),
    title: fontFamily(options.fontTitle || 'unlovable'),
    author: fontFamily(options.fontAuthor || 'goudy'),
  };
}

/* the ribbon, shared by both pages */
function drawRibbon(sheet, options, widthPct, ctx) {
  const a = appCfg(options);
  const t = elGet(options, 'appSidebar');
  if (t.hidden) return;
  appendRibbon(sheet, {
    mode: a.sidebarMode || 'damask',
    color: a.sidebarColor,
    src: resolveSrc(t.src),
    opacity: t.opacity,
    shade: 0,
    widthPct,
  }, { requestRender: ctx.requestRender, forExport: ctx.forExport });
}

/* one line of set text: its items as spans / discs / icons, nowrap, in a
   block exactly `lineH` px tall */
function lineNode(line, style, drawItem) {
  const n = el('div', { position: 'absolute', whiteSpace: 'nowrap', ...style });
  for (const it of line.items) {
    if (it.lead) n.append(el('span', { display: 'inline-block', width: px(it.lead) }));
    n.append(drawItem(it));
  }
  return n;
}

/* ════════════════════════════════════════════════════════════════════
   THE SCRIPT SHEET
   ════════════════════════════════════════════════════════════════════ */

function labelTextFor(options, team, total) {
  return ((options.teamLabels && options.teamLabels[team] || '').trim() || TEAM_LABELS[team]).toUpperCase() +
    (options.labelCounts ? ' · ' + total : '');
}

/* the header band's height, and where its pieces sit (em) */
function headerMetrics(script, options) {
  const A = APP_SHEET;
  const aT = elGet(options, 'appAuthor');
  const author = ((options.authorOverride || '').trim() || script.meta.author || '').trim();
  const withAuthor = !!(options.showAuthor && author && !aT.hidden);
  const authorCY = A.titleCY + A.titleMaxH / 2 + A.authorGap + A.authorSize / 2;
  const top = withAuthor ? authorCY + A.authorSize / 2 + 0.75 : A.contentTop;
  return { withAuthor, author, authorCY, top };
}

/* layoutAppSheet(script, options, requestRender) → {style:'app', pages, d, …}
   The classic sheet's policy, in one column: measure every row at a
   density, pack the teams onto pages (a team that does not fit is split
   and its name repeated), solve the density that fills the page, and deal
   whatever is left over out as space. A short team — the lone Imp — grows
   to hold its name up the ribbon, as it does in the app. */
export function layoutAppSheet(script, options, requestRender) {
  const A = APP_SHEET;
  const a = appCfg(options);
  const groups = groupByTeam(script.characters, options.sortMode);
  const fonts = fontsOf(options);
  const iconSize = options.iconSize || 1;
  const textSize = options.textSize || 1;
  const nameSize = options.nameSize || 1;
  const lineMul = options.abilityLine || 1;

  if (options.normalizeIcons) {
    const urls = new Set();
    script.characters.forEach((c) => { urls.add(c.icon); c.jinxIcons.forEach((j) => urls.add(j.icon)); });
    normalizeIcons([...urls], requestRender);
  }

  const textW = ((A.textRight - A.textX) / 100) * SHEET_W;
  const nameW = (A.nameW / 100) * SHEET_W;
  const lineEm = A.textLine * textSize * lineMul;
  const nameLineEm = (s) => A.nameSize * nameSize * s * A.nameLine;
  const rowMin = A.rowMin * Math.max(1, iconSize);
  const nameFont = (d) => (s) => `${options.nameCase === 'smallcaps' ? 'small-caps ' : ''}700 ${(A.nameSize * nameSize * U * d * s).toFixed(2)}px ${fonts.name}`;
  const caseName = (s) => (options.nameCase === 'upper' ? s.toUpperCase() : s);

  const measureRow = (c, d) => {
    const textPx = A.textSize * textSize * U * d;
    const font = `400 ${textPx.toFixed(2)}px ${fonts.text}`;
    const runs = [{ s: smartTypography(c.ability || ''), font, kind: 'text' }];
    if (options.showJinxes && c.jinxIcons.length) {
      // the partners' icons close the ability, where the app lists them
      runs.push({ s: ' ', font, kind: 'text' });
      const jw = textPx * 1.3 * (options.jinxIconSize || 1);
      for (const j of c.jinxIcons) runs.push({ kind: 'icon', src: j.icon, name: j.name, reason: j.reason, w: jw, font });
    }
    const lines = breakRuns(runs, textW, textWidth, { baseFont: font });
    const nm = fitNameLines(caseName(smartTypography(c.name)), nameW, textWidth, nameFont(d));
    const textH = lines.length * lineEm;
    const nameH = nm.lines.length * nameLineEm(nm.scale);
    const blockH = Math.max(textH, nameH);
    return { lines, name: nm, textH, nameH, blockH, h: Math.max(rowMin, blockH + A.rowPad) };
  };

  // the team names are set at the sheet's size (they scale with density
  // like everything else, so a band's height in layout em is fixed)
  const labelOn = options.showLabels !== false && !elGet(options, 'appLabels').hidden;
  const labelEm = (text) => {
    const fs = A.labelSize * (options.labelSize || 1) * U;
    const spacing = (a.labelSpacing == null ? 0.04 : a.labelSpacing) * fs;
    return (textWidth(text, `400 ${fs.toFixed(2)}px ${fonts.label}`) + spacing * Math.max(0, text.length - 1)) / U;
  };

  const measureSection = (team, chars, d, total) => {
    const rows = chars.map((c) => measureRow(c, d));
    const rowsH = sum(rows.map((r) => r.h));
    const label = labelTextFor(options, team, total);
    const labelNeed = labelOn ? labelEm(label) + 2 * A.labelPad : 0;
    return { team, chars, rows, rowsH, label, labelNeed, need: Math.max(rowsH, labelNeed) };
  };

  const hm = headerMetrics(script, options);
  const pageHasHeader = (i) => options.showHeader !== false && (i === 0 || options.repeatHeader);
  const topFor = (i) => (pageHasHeader(i) ? hm.top : A.bareTop);
  const availFor = (i) => A.contentBottom - topFor(i);
  const gapEm = A.sectionGap;

  const pack = (d, single) => {
    const pages = [];
    let page = { sections: [], used: 0, index: 0 };
    const avail = () => availFor(page.index) / d;
    const newPage = () => { pages.push(page); page = { sections: [], used: 0, index: pages.length }; };
    const put = (m) => {
      page.used += m.need + (page.sections.length ? gapEm : 0);
      page.sections.push(m);
    };
    for (const g of groups) {
      let chars = g.characters;
      let cont = false;
      while (chars.length) {
        const gap = page.sections.length ? gapEm : 0;
        const room = avail() - page.used - gap;
        const whole = measureSection(g.team, chars, d, g.characters.length);
        if (single || whole.need <= room + 0.001) { put({ ...whole, cont }); break; }
        // split: the most characters that fit the room left
        let n = 0;
        if (room > avail() * 0.22 || page.sections.length === 0) {
          for (let k = chars.length - 1; k >= 1; k--) {
            if (measureSection(g.team, chars.slice(0, k), d, g.characters.length).need <= room + 0.001) { n = k; break; }
          }
        }
        if (n === 0) {
          if (page.sections.length === 0) n = 1; // a team taller than a page still makes progress
          else { newPage(); continue; }
        }
        put({ ...measureSection(g.team, chars.slice(0, n), d, g.characters.length), cont });
        chars = chars.slice(n);
        cont = true;
        newPage();
      }
    }
    if (page.sections.length || !pages.length) pages.push(page);
    return pages;
  };

  const totalNeedAt = (d) => sum(groups.map((g) => measureSection(g.team, g.characters, d, g.characters.length).need)) +
    Math.max(0, groups.length - 1) * gapEm;

  let d = options.fitToContent ? 1 : clamp(Number(options.density) || 1, 0.3, 2);
  let pages;
  const minFit = clamp(Number(options.minFit) || 0.62, 0.3, 1);
  if (options.fitToContent) {
    let fit = 1;
    for (let iter = 0; iter < 4; iter++) {
      const f = clamp(availFor(0) / Math.max(0.01, totalNeedAt(fit)), 0.42, FIT.growMax);
      if (Math.abs(f - fit) < 0.002) { fit = f; break; }
      fit = f;
    }
    if (fit >= minFit || !options.paginate || !groups.length) {
      d = fit;
      pages = pack(d, true);
    } else {
      d = 1;
      pages = pack(d, false);
      // one sheet fewer, if a density still above minFit holds it
      for (let iter = 0; iter < 4 && pages.length > 1; iter++) {
        const n = pages.length - 1;
        let room = 0;
        for (let i = 0; i < n; i++) room += availFor(i);
        let d2 = d;
        for (let k = 0; k < 3; k++) d2 = clamp(room / (totalNeedAt(d2) + (n - 1) * gapEm * 0.5), minFit, 1);
        let found = null;
        for (let tries = 0; tries < 8 && d2 >= minFit - 1e-9; tries++, d2 -= 0.025) {
          const p2 = pack(d2, false);
          if (p2.length <= n) { found = { d: d2, pages: p2 }; break; }
        }
        if (!found) break;
        d = found.d;
        pages = found.pages;
      }
      // then fill the sheets it settled on evenly
      const n = pages.length;
      let room = 0;
      for (let i = 0; i < n; i++) room += availFor(i);
      let grown = d;
      for (let k = 0; k < 3; k++) grown = clamp(room / (totalNeedAt(grown) + (n - 1) * gapEm * 0.5), d, FIT.growMax);
      for (let tries = 0; tries < 10 && grown > d + 1e-9; tries++, grown -= 0.02) {
        const p3 = pack(grown, false);
        if (p3.length <= n) { d = grown; pages = p3; break; }
      }
    }
  } else {
    pages = pack(d, !options.paginate);
  }

  const ed = (em) => em * U * d;

  /* take up the rest of the page: rows and gaps stretch (to FIT.spreadMax)
     and what is still left is split above and below. A team held open by
     its name only grows once its rows have caught up with it. */
  pages.forEach((page) => {
    page.header = pageHasHeader(page.index);
    const roomEm = availFor(page.index) / d;
    const gaps = Math.max(0, page.sections.length - 1);
    const natural = (s) => sum(page.sections.map((m) => Math.max(m.rowsH * s, m.labelNeed))) + gaps * gapEm * s;
    let lo = 1, hi = FIT.spreadMax;
    if (natural(1) >= roomEm) hi = 1;
    else if (natural(hi) <= roomEm) lo = hi;
    else for (let k = 0; k < 24; k++) { const mid = (lo + hi) / 2; if (natural(mid) <= roomEm) lo = mid; else hi = mid; }
    const stretch = lo;
    const spare = Math.max(0, roomEm - natural(stretch));
    let cursor = topFor(page.index) * U + ed(spare * FIT.topShare);
    page.stretch = stretch;
    page.sections.forEach((m, i) => {
      if (i) cursor += ed(gapEm * stretch);
      const rowsH = m.rowsH * stretch;
      const secH = Math.max(rowsH, m.labelNeed);
      m.sectionTopPx = cursor;
      m.heightPx = ed(secH);
      m.gapAboveEm = i ? gapEm * stretch : 0;
      m.heights = m.rows.map((r) => r.h * stretch);
      m.topPx = cursor + ed((secH - rowsH) / 2); // where the rows begin
      // what app.js's reorderFront reads, in the classic sheet's shape
      m.left = m.chars; m.right = [];
      m.leftHeights = m.heights; m.rightHeights = [];
      m.rightTopPx = m.topPx; m.rowsTopPx = m.topPx;
      cursor += m.heightPx;
    });
  });

  return { style: 'app', pages, d, fonts, groups, hm, iconEm: A.iconSize * iconSize, lineEm, nameLineEm };
}

/* the text title: the script's name between the tool's own flourishes,
   the way the official logos set it, sized to the band. No skull: its art
   carries a patch of the classic sheet's parchment, cut to vanish where
   that sheet puts it, and anywhere else it shows as a pale box. */
function textTitle(sheet, title, options, cx, mark, e) {
  const A = APP_SHEET;
  const a = appCfg(options);
  const tT = elGet(options, 'appTitle');
  const fam = fontFamily(options.fontTitle || 'unlovable');
  const unlovable = (options.fontTitle || 'unlovable') === 'unlovable';
  let fs = e(A.titleSize) * tT.scale;
  const measure = (size) => {
    const w = textWidth(title, `400 ${size}px ${fam}`);
    // the swash face's spaces are tightened on the page; measure the same
    return w - (unlovable ? (title.split(' ').length - 1) * 0.21 * size : 0);
  };
  const k = fs / e(8.35); // the classic title's size, which the flourish art is drawn to
  const flLW = options.showFlourishes !== false ? 9.956 * k : 0; // % width
  const flRW = options.showFlourishes !== false ? 17.453 * k : 0;
  const gap = 0.9 * k; // clear air between each flourish and the words
  const decorW = (flLW ? flLW + gap : 0) + (flRW ? flRW + gap : 0);
  const band = A.titleMaxW + 18; // the logo's width plus the flourishes'
  let w = (measure(fs) / SHEET_W) * 100;
  if (w + decorW > band) {
    const s = clamp((band - decorW) / w, 0.35, 1);
    fs *= s;
    w *= s;
  }
  const total = w + decorW;
  const left = cx + tT.dx - total / 2;
  const cy = A.titleCY + tT.dy;
  const titleLeft = left + (flLW ? flLW + gap : 0);
  if (flLW) {
    sheet.append(img(ART + 'flourish-left.png', {
      position: 'absolute', left: left + '%', top: px(e(cy) - e(3.204 * k) / 2 + e(0.26 * k)), width: flLW + '%',
      opacity: String(tT.opacity),
    }));
  }
  if (flRW) {
    sheet.append(img(ART + 'flourish-right.png', {
      position: 'absolute', left: (titleLeft + w + gap) + '%', top: px(e(cy) - e(3.295 * k) / 2 + e(0.26 * k)),
      width: flRW + '%', opacity: String(tT.opacity),
    }));
  }
  const titleEl = el('div', {
    position: 'absolute',
    left: titleLeft + '%',
    top: px(e(cy)),
    transform: `translateY(-52%)${tT.rot ? ` rotate(${tT.rot}deg)` : ''}`,
    fontFamily: fam,
    fontSize: px(fs),
    lineHeight: '1',
    whiteSpace: 'nowrap',
    wordSpacing: unlovable ? '-0.21em' : '0',
    color: a.titleColor || '#8b1a23',
    opacity: String(tT.opacity),
    textShadow: `${e(0.04)}px ${e(0.07)}px ${e(0.08)}px rgba(40, 20, 10, 0.35)`,
  }, title);
  sheet.append(mark(titleEl, 'el:appTitle'));
}

/* one character row, drawn at `h` layout em (the row may have stretched
   past what its own block needs; everything centres in it) */
function sheetRow(c, m, h, options, layout, ed, e, mark) {
  const A = APP_SHEET;
  const a = appCfg(options);
  const { fonts, lineEm, nameLineEm } = layout;
  const row = el('div', { position: 'relative', height: px(ed(h)) });
  row.dataset.fsChar = c.id;
  if (mark) mark(row, 'crow:' + c.id);
  const color = c.color || teamColor(options, c.team);

  // icon, centred on the row
  const iconEm = layout.iconEm;
  const iconPx = ed(iconEm) * (c.iconScale || 1);
  const iconLeft = (A.iconCX / 100) * SHEET_W - iconPx / 2 + ((c.iconDX || 0) / 100) * SHEET_W;
  const iconTop = ed(h / 2) - iconPx / 2 + e(c.iconDY || 0);
  if (options.iconFrame && options.iconFrame !== 'none') {
    const pad = iconPx * 0.1;
    row.append(el('div', {
      position: 'absolute', left: px(iconLeft - pad), top: px(iconTop - pad),
      width: px(iconPx + pad * 2), height: px(iconPx + pad * 2), borderRadius: '50%', boxSizing: 'border-box',
      background: options.iconFrame === 'disc' ? 'rgba(248, 242, 226, 0.92)' : 'transparent',
      border: `${Math.max(1, ed(0.09))}px solid rgba(90, 70, 40, 0.55)`,
    }));
  }
  const fit = options.normalizeIcons ? iconFit(c.icon) : ICON_IDENTITY;
  const icon = iconImg(drawIcon(c.icon), {
    position: 'absolute', left: px(iconLeft), top: px(iconTop), width: px(iconPx), height: px(iconPx),
    objectFit: 'contain', transform: inkTransform(fit), transformOrigin: 'center',
    filter: iconFilter(options.iconEffect, options.iconShadow == null ? 1 : options.iconShadow, ed),
  });
  if (options.iconEffect === 'engraved') icon.style.mixBlendMode = 'multiply';
  if (mark) mark(icon, 'char:' + c.id);
  row.append(icon);

  const blockTop = (h - m.blockH) / 2;
  // the name, wrapped at its spaces, shrunk only when one word will not fit
  const nlh = nameLineEm(m.name.scale);
  const nameTop = blockTop + (m.blockH - m.nameH) / 2;
  m.name.lines.forEach((ln, i) => {
    row.append(el('div', {
      position: 'absolute',
      left: A.nameX + '%',
      top: px(ed(nameTop + i * nlh)),
      height: px(ed(nlh)),
      lineHeight: px(ed(nlh)),
      whiteSpace: 'nowrap',
      fontFamily: fonts.name,
      fontWeight: '700',
      fontSize: px(ed(A.nameSize * (options.nameSize || 1) * m.name.scale)),
      fontVariant: options.nameCase === 'smallcaps' ? 'small-caps' : 'normal',
      color,
    }, ln));
  });

  // the bar, exactly as tall as the text block
  const textTop = blockTop + (m.blockH - m.textH) / 2;
  if (a.showBars !== false) {
    row.append(el('div', {
      position: 'absolute',
      left: A.barX + '%',
      top: px(ed(textTop) + ed(0.08)),
      width: px(Math.max(1.5, (A.barW / 100) * SHEET_W * (a.barWidth || 1))),
      height: px(Math.max(2, ed(m.textH) - ed(0.16))),
      background: color,
    }));
  }

  // the ability, one block per line
  const textPx = ed(A.textSize * (options.textSize || 1));
  m.lines.forEach((ln, i) => {
    row.append(lineNode(ln, {
      left: A.textX + '%',
      top: px(ed(textTop + i * lineEm)),
      height: px(ed(lineEm)),
      lineHeight: px(ed(lineEm)),
      fontFamily: fonts.text,
      fontSize: px(textPx),
      color: a.inkColor || '#271d17',
    }, (it) => {
      if (it.kind === 'icon') {
        const jf = options.normalizeIcons ? iconFit(it.src) : ICON_IDENTITY;
        const ji = iconImg(drawIcon(it.src), {
          display: 'inline-block', width: px(it.w), height: px(it.w), verticalAlign: 'middle',
          objectFit: 'contain', transform: inkTransform(jf), marginTop: px(-it.w * 0.12),
        }, it.name);
        ji.title = 'Jinxed: ' + it.name;
        return ji;
      }
      return document.createTextNode(it.s);
    }));
  });
  return row;
}

export function renderAppSheetPage(script, options, layout, pageIndex, ctx) {
  ctx = ctx || {};
  const A = APP_SHEET;
  const a = appCfg(options);
  const selected = ctx.selected || '';
  const page = layout.pages[Math.min(pageIndex, layout.pages.length - 1)];
  const { d, fonts, hm } = layout;
  const ed = (em) => em * U * d;
  const e = (em) => em * U;
  const isLastPage = pageIndex === layout.pages.length - 1;
  const title = (options.titleOverride || '').trim() || script.meta.name;
  const cx = paperCX(A.sidebarW);

  const sheet = pageFrame(SHEET_W, SHEET_H, U, 'script-sheet script-app');
  sheet.dataset.fsPage = String(pageIndex);
  sheet.dataset.fsDensity = d.toFixed(3);
  const mark = (node, id) => {
    node.dataset.fsDrag = id;
    if (id === selected) markSelected(node);
    return node;
  };

  const scriptBg = script.meta.background ? proxied(script.meta.background, options.proxyIcons) : '';
  for (const n of renderBackground(a.bg, 'appfront', { scriptBg })) sheet.append(n);
  for (const n of renderStickers(ctx.stickers, selected, true)) sheet.append(n);
  drawRibbon(sheet, options, A.sidebarW, ctx);

  // the garland across the foot: only when one has been uploaded (the aged
  // parchment carries its own)
  const gT = elGet(options, 'appGarland');
  const garland = resolveSrc(gT.src);
  if (garland && !gT.hidden && isLastPage) {
    const gEl = img(garland, {
      position: 'absolute',
      left: (cx + gT.dx) + '%',
      bottom: px(-e(gT.dy)),
      width: (A.garlandW * gT.scale) + '%',
      maxHeight: px(e(A.garlandH) * gT.scale),
      objectFit: 'contain',
      objectPosition: '50% 100%',
      transform: `translateX(-50%)${gT.rot ? ` rotate(${gT.rot}deg)` : ''}`,
      opacity: String(gT.opacity),
    });
    gEl.crossOrigin = 'anonymous';
    sheet.append(mark(gEl, 'el:appGarland'));
  }

  // the title: an uploaded title image, the script's logo, or the name
  if (page.header) {
    const tT = elGet(options, 'appTitle');
    if (!tT.hidden) {
      let art = resolveSrc(tT.src) || (script.meta.logo && options.useLogo ? proxied(script.meta.logo, options.proxyIcons) : '');
      if (art && failedArt.has(art)) art = '';
      if (art) {
        const logoEl = img(art, {
          position: 'absolute',
          left: (cx + tT.dx) + '%',
          top: px(e(A.titleCY + tT.dy)),
          transform: `translate(-50%, -50%)${tT.rot ? ` rotate(${tT.rot}deg)` : ''}`,
          maxWidth: (A.titleMaxW * tT.scale) + '%',
          maxHeight: px(e(A.titleMaxH) * tT.scale),
          objectFit: 'contain',
          opacity: String(tT.opacity),
        }, title);
        logoEl.crossOrigin = 'anonymous';
        logoEl.addEventListener('error', () => { failedArt.add(art); if (ctx.requestRender) ctx.requestRender(); });
        sheet.append(mark(logoEl, 'el:appTitle'));
      } else {
        textTitle(sheet, title, options, cx, mark, e);
      }
    }
    if (hm.withAuthor) {
      const aT = elGet(options, 'appAuthor');
      sheet.append(mark(el('div', {
        position: 'absolute',
        left: (cx + tT.dx + aT.dx) + '%',
        top: px(e(hm.authorCY + tT.dy + aT.dy)),
        transform: `translate(-50%, -50%)${aT.rot ? ` rotate(${aT.rot}deg)` : ''}`,
        fontFamily: fonts.author,
        fontStyle: 'italic',
        fontSize: px(e(A.authorSize) * aT.scale),
        letterSpacing: '0.04em',
        color: a.authorColor || '#5a4632',
        opacity: String(aT.opacity),
        whiteSpace: 'nowrap',
      }, (options.authorPrefix == null ? 'by ' : options.authorPrefix) + smartTypography(hm.author)), 'el:appAuthor'));
    }
  }

  // the teams
  const cT = elGet(options, 'content');
  const lT = elGet(options, 'appLabels');
  const dvT = elGet(options, 'appDividers');
  const wrap = el('div', { position: 'absolute', inset: '0', opacity: String(cT.opacity), display: cT.hidden ? 'none' : 'block' });
  applyEl(wrap, { ...cT, opacity: 1, hidden: false, scale: 1 }, '', U, SHEET_W);
  if (cT.scale !== 1) {
    wrap.style.transformOrigin = '50% 0';
    wrap.style.transform = (wrap.style.transform || '') + ` scale(${cT.scale})`;
  }
  wrap.dataset.fsEl = 'content';
  wrap.style.pointerEvents = 'none';

  page.sections.forEach((sec, si) => {
    // the line between two teams, half way down the gap: pale on the
    // ribbon, a faint rule on the paper that fades out to the right
    if (si > 0 && a.showDividers !== false && !dvT.hidden) {
      const y = sec.sectionTopPx - ed(sec.gapAboveEm) / 2 + e(dvT.dy);
      const k = clamp((a.dividerStrength == null ? 1 : a.dividerStrength) * dvT.opacity, 0, 1.5);
      const h = Math.max(1.5, e(0.12) * dvT.scale);
      wrap.append(el('div', {
        position: 'absolute', left: A.dividerX0 + '%', top: px(y - h / 2), width: (A.sidebarW - A.dividerX0) + '%', height: px(h),
        background: `rgba(236, 206, 182, ${(0.42 * k).toFixed(3)})`,
      }));
      wrap.append(el('div', {
        position: 'absolute', left: A.sidebarW + '%', top: px(y - h / 2), width: (A.dividerX1 - A.sidebarW) + '%', height: px(h),
        background: `linear-gradient(90deg, rgba(70, 50, 34, ${(0.2 * k).toFixed(3)}) 0%, rgba(70, 50, 34, ${(0.16 * k).toFixed(3)}) 80%, rgba(70, 50, 34, 0) 100%)`,
      }));
    }

    // the team's name up the ribbon, centred on its section
    if (sec.labelNeed > 0 && !lT.hidden) {
      const fs = ed(A.labelSize * (options.labelSize || 1)) * lT.scale;
      wrap.append(el('div', {
        position: 'absolute',
        left: (A.labelCX + lT.dx) + '%',
        top: px(sec.sectionTopPx + sec.heightPx / 2 + e(lT.dy)),
        transform: 'translate(-50%, -50%) rotate(-90deg)',
        fontFamily: fonts.label,
        fontSize: px(fs),
        lineHeight: '1',
        letterSpacing: (a.labelSpacing == null ? 0.04 : a.labelSpacing) + 'em',
        color: a.labelColor || '#dcc0a4',
        opacity: String(lT.opacity),
        whiteSpace: 'nowrap',
        textShadow: `0 ${ed(0.05)}px ${ed(0.12)}px rgba(20, 0, 4, 0.55)`,
      }, sec.label));
    }

    const col = el('div', { position: 'absolute', left: '0', top: px(sec.topPx), width: '100%', pointerEvents: 'auto' });
    sec.chars.forEach((c, i) => col.append(sheetRow(c, sec.rows[i], sec.heights[i], options, layout, ed, e, mark)));
    wrap.append(col);
  });
  sheet.append(wrap);

  // "*Not the first night", in the garland's oval
  const fT = elGet(options, 'footnote');
  const hasNightStar = script.characters.some((c) => c.ability.includes('night*'));
  if (options.showFootnote && (hasNightStar || (options.footnoteText || '').trim()) && !fT.hidden &&
      (isLastPage || options.footnoteEveryPage)) {
    const custom = (options.footnoteText || '').trim();
    const foot = el('div', {
      position: 'absolute',
      left: (A.footnoteCX + fT.dx) + '%',
      top: px(e(A.footnoteTop + fT.dy)),
      transform: `translateX(-50%)${fT.rot ? ` rotate(${fT.rot}deg)` : ''}${fT.scale !== 1 ? ` scale(${fT.scale})` : ''}`,
      transformOrigin: '50% 0',
      textAlign: 'center',
      fontFamily: fonts.text,
      fontSize: px(e(A.footnoteSize)),
      lineHeight: px(e(A.footnoteLine)),
      color: a.footnoteColor || '#8b786b',
      opacity: String(fT.opacity),
      whiteSpace: 'nowrap',
    });
    const lines = custom ? custom.split('\n') : ['*Not the', 'first night'];
    lines.forEach((ln) => foot.append(el('div', null, ln)));
    sheet.append(mark(foot, 'el:footnote'));
  }

  const pT = elGet(options, 'pageno');
  if (layout.pages.length > 1 && options.showPageNumbers && !pT.hidden) {
    sheet.append(mark(el('div', {
      position: 'absolute',
      right: (7.5 - pT.dx) + '%', // clear of the parchment's dark right edge
      top: px(e(96.2 + pT.dy)),
      fontFamily: fonts.text,
      fontSize: px(e(1.05) * pT.scale),
      color: a.footnoteColor || '#8b786b',
      opacity: String(pT.opacity),
      whiteSpace: 'nowrap',
    }, (pageIndex + 1) + ' / ' + layout.pages.length), 'el:pageno'));
  }

  for (const n of renderStickers(ctx.stickers, selected, false)) sheet.append(n);
  return sheet;
}

/* ════════════════════════════════════════════════════════════════════
   THE NIGHT SHEETS
   ════════════════════════════════════════════════════════════════════ */

/* the horizontal grid of each column: one column is the app's own grid;
   two split the paper right of the ribbon, and keep the icon and the name
   nearly their full width (a name squeezed into a proportional share of
   the page spills over its icon) while the text column narrows */
function nightCols(n) {
  const A = APP_NIGHT;
  if (n < 2) return [{ iconCX: A.iconCX, nameRight: A.nameRight, barX: A.barX, textX: A.textX, textRight: A.textRight }];
  const x0 = A.sidebarW;
  const half = (100 - x0 - A.colGap) / 2;
  const at = (start) => ({
    iconCX: start + 4.4,
    nameRight: start + 19.5,
    barX: start + 20.6,
    textX: start + 22.0,
    textRight: Math.min(start + half - 0.8, A.textRight),
  });
  return [at(x0), at(x0 + half + A.colGap)];
}

/* layoutAppList(spec, options, requestRender) → a layout in the classic
   list's shape (pages of columns of units), so the drag reorder reads it */
export function layoutAppList(spec, options, requestRender) {
  const A = APP_NIGHT;
  const cfg = spec.cfg;
  const fonts = fontsOf(options, cfg);
  const two = spec.columns.length > 1;
  const cols = nightCols(spec.columns.length);
  const textSize = cfg.textSize || 1;
  const nameSize = cfg.nameSize || 1;
  const iconEm = A.iconSize * (cfg.iconSize || 1);
  const rowGap = cfg.rowGap == null ? 1 : cfg.rowGap;
  const pitch = Math.max(A.rowPitch * (1 + (rowGap - 1) * 0.35), iconEm + 0.15);
  const nameLineEm = (s) => A.nameSize * nameSize * s * A.nameLine;

  const urls = new Set();
  spec.columns.forEach((c) => c.blocks.forEach((b) => b.rows.forEach((r) => r.icons.forEach((u) => urls.add(resolveSrc(u))))));
  normalizeIcons([...urls], requestRender);

  const dotOn = cfg.dotStyle !== 'none';
  const measureRow = (row, ci, d) => {
    const g = cols[ci];
    const textPx = A.textSize * textSize * U * d;
    const base = `400 ${textPx.toFixed(2)}px ${fonts.text}`;
    const tokenFont = cfg.tokenStyle === 'plain' ? base
      : `700 ${(textPx * 0.96).toFixed(2)}px ${cfg.tokenStyle === 'bold' ? fonts.text : fonts.token}`;
    const runs = [];
    for (const p of reminderParts(smartTypography(row.text || ''))) {
      if (p.t === 'text') runs.push({ s: p.s, font: base, kind: 'text' });
      else if (p.t === 'token') runs.push({ s: cfg.tokenStyle === 'plain' ? p.s : p.s.toUpperCase(), font: tokenFont, kind: 'token' });
      else if (dotOn) runs.push({ kind: 'dot', font: base });
    }
    const dotW = textPx * (cfg.dotStyle === 'token' ? 1.15 : A.dotSize) + textPx * 0.3;
    const textW = ((g.textRight - g.textX) / 100) * SHEET_W;
    const lines = row.text ? breakRuns(runs, textW, textWidth, { baseFont: base, dotW }) : [];
    const lineHs = lines.map((ln) => (ln.dot && dotOn ? A.dotLine : A.textLine) * textSize);
    const textH = sum(lineHs);
    // the name, flush right against the bar
    const nameLeft = g.iconCX + ((iconEm * U * d) / SHEET_W) * 50 + 1.2;
    const nameW = ((g.nameRight - nameLeft) / 100) * SHEET_W;
    const label = (cfg.numbered && row.number ? row.number + '. ' : '') + smartTypography(row.name || '');
    const nm = fitNameLines(label, nameW, textWidth, (s) => `700 ${(A.nameSize * nameSize * U * d * s).toFixed(2)}px ${fonts.name}`,
      { shrinkFirst: 0.8, minScale: 0.4 });
    const nameH = row.name ? nm.lines.length * nameLineEm(nm.scale) : 0;
    const blockH = Math.max(textH, nameH);
    return { lines, lineHs, textH, name: nm, nameH, blockH, h: Math.max(pitch, blockH + A.rowPad) };
  };

  // headings: a column heading (both nights on one page), and the page
  // title when it is asked for (the app shows none)
  const hasHeadings = spec.columns.some((c) => c.heading);
  const titleOn = !!cfg.appTitle && !elGet(options, spec.elPrefix + 'Title').hidden;
  const listTop = A.listTop + (titleOn ? A.titleSize + 1.6 : 0) + (hasHeadings ? 3.4 : 0);
  // the logo after the list
  const logoOn = !elGet(options, spec.elPrefix + 'Logo').hidden && cfg.showLogo !== false;
  const logoEm = logoOn ? A.logoGap + A.logoMaxH : 0;
  const availEm = A.listBottom - listTop - logoEm;

  const colUnits = spec.columns.map((c) => {
    const units = [];
    c.blocks.forEach((b, bi) => {
      if (b.heading) units.push({ type: 'heading', text: b.heading, h: 2.9 + (bi ? 1.2 : 0) });
      b.rows.forEach((r) => units.push({ type: 'row', row: r }));
    });
    return units;
  });
  const measure = (u, ci, d) => (u.type === 'row' ? measureRow(u.row, ci, d) : { h: u.h });
  const needAt = (ci, d) => sum(colUnits[ci].map((u) => measure(u, ci, d).h));

  let d = cfg.fit === false ? clamp(Number(cfg.density) || 1, 0.3, 2) : 1;
  const minFit = clamp(Number(cfg.minFit) || 0.68, 0.3, 1);
  let pagesN = 1;
  if (cfg.fit !== false) {
    let fit = 1;
    for (let iter = 0; iter < 4; iter++) {
      const need = Math.max(...colUnits.map((_, ci) => needAt(ci, fit)));
      const f = clamp(availEm / Math.max(need, 0.01), 0.42, FIT.growMax);
      if (Math.abs(f - fit) < 0.002) { fit = f; break; }
      fit = f;
    }
    if (fit >= minFit || !spec.paginate || two) d = fit;
    else {
      const need1 = needAt(0, 1);
      pagesN = Math.max(1, Math.ceil((need1 * minFit) / (availEm + logoEm)));
      d = clamp((pagesN * (availEm + logoEm)) / need1, minFit, 1);
    }
  }

  const pack = (dd) => {
    const pages = [];
    let page = { columns: cols.map(() => ({ units: [], used: 0 })) };
    colUnits.forEach((units, ci) => {
      // only the last page carries the logo, so the others have its room
      const cap = (availEm + logoEm) / dd;
      for (const u of units) {
        const m = measure(u, ci, dd);
        const pc = page.columns[ci];
        if (pc.used + m.h > cap + 0.001 && pc.units.length && spec.paginate && !two) {
          pages.push(page);
          page = { columns: cols.map(() => ({ units: [], used: 0 })) };
        }
        page.columns[ci].units.push({ ...u, m, hEm: m.h });
        page.columns[ci].used += m.h;
      }
    });
    pages.push(page);
    return pages;
  };
  let pages = pack(d);
  const lastFits = (ps, dd) => ps[ps.length - 1].columns.every((pc) => pc.used <= availEm / dd + 0.001);
  if (spec.paginate && !two) {
    for (let iter = 0; iter < 6 && (pages.length > pagesN || !lastFits(pages, d)); iter++) {
      if (d <= minFit) break;
      d = Math.max(minFit, d * 0.97);
      pages = pack(d);
    }
  }

  // rows spaced further apart to take up the rest (never taller: the bar
  // and the name are drawn off a row's own block), anchored at the top as
  // the app is, with the logo following the list
  pages.forEach((p, pi) => {
    const isLast = pi === pages.length - 1;
    const room = (isLast ? availEm : availEm + logoEm) / d;
    let natural = 0, units = 0;
    p.columns.forEach((pc) => {
      natural = Math.max(natural, sum(pc.units.map((u) => u.hEm)));
      units = Math.max(units, pc.units.length);
    });
    const slack = room - natural;
    let gapEm = 0;
    if (slack > 0.01 && units > 1) gapEm = Math.min(slack / (units - 1), (FIT.spreadMax - 1) * (natural / units));
    p.gapEm = gapEm;
    p.offsetEm = 0;
    p.naturalEm = natural + gapEm * Math.max(0, units - 1);
  });

  return { style: 'app', pages, d, cols, fonts, listTop, two, iconEm, nameLineEm, logoOn, titleOn, pitch };
}

/* a reminder mark: the app's plum disc, the little token with the icon,
   or nothing */
function dotNode(cfg, row, size) {
  if (cfg.dotStyle === 'token') {
    const tok = el('span', {
      display: 'inline-block', width: px(size * 1.15), height: px(size * 1.15), borderRadius: '50%',
      background: '#efe6d2', border: `${Math.max(1, size * 0.06)}px solid #7a6a4a`, boxSizing: 'border-box',
      verticalAlign: 'middle', margin: `0 ${px(size * 0.15)}`, overflow: 'hidden', position: 'relative',
    });
    if (row.icons[0]) {
      tok.append(iconImg(drawIcon(resolveSrc(row.icons[0])), {
        position: 'absolute', left: '8%', top: '8%', width: '84%', height: '84%', objectFit: 'contain',
      }));
    }
    return tok;
  }
  const d = size * APP_NIGHT.dotSize;
  return el('span', {
    display: 'inline-block', width: px(d), height: px(d), borderRadius: '50%', verticalAlign: 'middle',
    margin: `0 ${px(size * 0.15)}`, boxSizing: 'border-box',
    background: 'radial-gradient(circle at 38% 32%, #5d4a73 0%, #3c2c49 55%, #2a1e34 100%)',
    border: `${Math.max(1, size * 0.05)}px solid rgba(20, 12, 28, 0.55)`,
    boxShadow: `0 ${px(size * 0.04)} ${px(size * 0.08)} rgba(0, 0, 0, 0.3)`,
  });
}

function nightRow(u, g, layout, cfg, options, ed, e, mark) {
  const A = APP_NIGHT;
  const a = appCfg(options);
  const row = u.row;
  const m = u.m;
  const h = u.hEm;
  const { fonts, nameLineEm } = layout;
  const node = el('div', { position: 'absolute', left: '0', right: '0', height: px(ed(h)) });
  node.dataset.fsRow = row.id;
  if (mark && row.list) mark(node, 'nrow:' + row.list + ':' + row.id);

  // icon(s), centred on the row
  const iconPx = ed(layout.iconEm);
  row.icons.forEach((raw, k) => {
    const src = resolveSrc(raw);
    const fit = iconFit(src) || ICON_IDENTITY;
    const size = iconPx * (row.icons.length > 1 ? 0.86 : 1);
    const ic = iconImg(drawIcon(src), {
      position: 'absolute',
      left: px((g.iconCX / 100) * SHEET_W - size / 2 + k * size * 0.62),
      top: px(ed(h / 2) - size / 2),
      width: px(size), height: px(size),
      objectFit: 'contain', transform: inkTransform(fit), transformOrigin: 'center',
      filter: iconFilter(options.iconEffect, cfg.iconShadow == null ? 1 : cfg.iconShadow, ed),
      zIndex: String(2 - k),
    });
    if (options.iconEffect === 'engraved') ic.style.mixBlendMode = 'multiply';
    node.append(ic);
  });

  const blockTop = (h - m.blockH) / 2;
  if (row.name) {
    const nlh = nameLineEm(m.name.scale);
    const top = blockTop + (m.blockH - m.nameH) / 2;
    m.name.lines.forEach((ln, i) => {
      node.append(el('div', {
        position: 'absolute',
        right: (100 - g.nameRight) + '%',
        top: px(ed(top + i * nlh)),
        height: px(ed(nlh)),
        lineHeight: px(ed(nlh)),
        whiteSpace: 'nowrap',
        textAlign: 'right',
        fontFamily: fonts.name,
        fontWeight: '700',
        fontSize: px(ed(A.nameSize * (cfg.nameSize || 1) * m.name.scale)),
        color: row.color,
      }, ln));
    });
  }

  if (row.text) {
    const textTop = blockTop + (m.blockH - m.textH) / 2;
    if (a.showBars !== false) {
      node.append(el('div', {
        position: 'absolute',
        left: g.barX + '%',
        top: px(ed(textTop) + ed(0.06)),
        width: px(Math.max(1.5, (A.barW / 100) * SHEET_W * (a.barWidth || 1))),
        height: px(Math.max(2, ed(m.textH) - ed(0.12))),
        background: row.color,
      }));
    }
    const textPx = ed(A.textSize * (cfg.textSize || 1));
    let y = textTop;
    m.lines.forEach((ln, i) => {
      const lh = m.lineHs[i];
      node.append(lineNode(ln, {
        left: g.textX + '%',
        top: px(ed(y)),
        height: px(ed(lh)),
        lineHeight: px(ed(lh)),
        fontFamily: fonts.text,
        fontSize: px(textPx),
        color: cfg.textColor || '#2b2b2b',
      }, (it) => {
        if (it.kind === 'dot') return dotNode(cfg, row, textPx);
        if (it.kind === 'token') {
          const s = el('span', null, it.s);
          if (cfg.tokenStyle !== 'plain') {
            Object.assign(s.style, {
              fontFamily: cfg.tokenStyle === 'bold' ? fonts.text : fonts.token,
              fontWeight: '700', fontSize: '0.96em',
            });
          }
          return s;
        }
        return document.createTextNode(it.s);
      }));
      y += lh;
    });
  }
  return node;
}

export function renderAppListPage(script, spec, options, layout, pageIndex, ctx) {
  ctx = ctx || {};
  const A = APP_NIGHT;
  const a = appCfg(options);
  const selected = ctx.selected || '';
  const cfg = spec.cfg;
  const { d, fonts, cols, listTop } = layout;
  const page = layout.pages[Math.min(pageIndex, layout.pages.length - 1)];
  const isLast = pageIndex === layout.pages.length - 1;
  const ed = (em) => em * U * d;
  const e = (em) => em * U;
  const P = spec.elPrefix;
  const cx = paperCX(A.sidebarW);
  const mark = (node, id) => {
    node.dataset.fsDrag = id;
    if (id === selected) markSelected(node);
    return node;
  };

  const sheet = pageFrame(SHEET_W, SHEET_H, U, 'script-night script-app');
  sheet.dataset.fsPage = String(pageIndex);
  sheet.dataset.fsDensity = d.toFixed(3);
  const scriptBg = script.meta.background ? proxied(script.meta.background, options.proxyIcons) : '';
  for (const n of renderBackground(a.bg, 'applist', { scriptBg })) sheet.append(n);
  for (const n of renderStickers(ctx.stickers, selected, true)) sheet.append(n);
  drawRibbon(sheet, options, A.sidebarW, ctx);

  // the corner art at the top right, one per night
  const decorKey = spec.which === 'other' ? 'nightDecorOther' : 'nightDecorFirst';
  const dT = elGet(options, decorKey);
  const decor = resolveSrc(dT.src);
  if (decor && !dT.hidden) {
    const dEl = img(decor, {
      position: 'absolute',
      right: (A.decorRight - dT.dx) + '%',
      top: px(e(dT.dy)),
      width: (A.decorW * dT.scale) + '%',
      maxHeight: px(e(A.decorMaxH) * dT.scale),
      objectFit: 'contain',
      objectPosition: '100% 0',
      transform: dT.rot ? `rotate(${dT.rot}deg)` : '',
      transformOrigin: '100% 0',
      opacity: String(dT.opacity),
    });
    dEl.crossOrigin = 'anonymous';
    sheet.append(mark(dEl, 'el:' + decorKey));
  }

  // the page title, only when asked for
  if (layout.titleOn) {
    const tT = elGet(options, P + 'Title');
    const suffix = layout.pages.length > 1 ? ' (' + (pageIndex + 1) + '/' + layout.pages.length + ')' : '';
    sheet.append(mark(el('div', {
      position: 'absolute',
      left: (cols[0].textX + tT.dx) + '%',
      top: px(e(A.titleTop + tT.dy)),
      transform: tT.rot ? `rotate(${tT.rot}deg)` : '',
      transformOrigin: '0 0',
      fontFamily: fonts.name,
      fontWeight: '700',
      fontSize: px(e(A.titleSize) * tT.scale),
      lineHeight: '1',
      color: cfg.titleColor || '#1c1c1c',
      opacity: String(tT.opacity),
      whiteSpace: 'nowrap',
    }, spec.title + suffix), 'el:' + P + 'Title'));
  }

  // the list
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
    const g = cols[ci];
    const col = el('div', { position: 'absolute', left: '0', top: px(e(listTop)), width: '100%', pointerEvents: 'auto' });
    if (spec.columns[ci].heading) {
      col.append(el('div', {
        position: 'absolute', left: g.textX + '%', top: px(-e(3.1)),
        fontFamily: fonts.name, fontWeight: '700', fontSize: px(e(2.1)), lineHeight: '1',
        color: cfg.titleColor || '#1c1c1c', whiteSpace: 'nowrap',
      }, spec.columns[ci].heading));
    }
    let y = page.offsetEm || 0;
    for (const u of pc.units) {
      if (u.type === 'heading') {
        col.append(el('div', {
          position: 'absolute', left: g.textX + '%', top: px(ed(y) + ed(u.hEm - 2.9) + ed(0.5)),
          fontFamily: fonts.name, fontWeight: '700', fontSize: px(ed(2.0)), lineHeight: '1',
          color: cfg.titleColor || '#1c1c1c', whiteSpace: 'nowrap',
        }, u.text));
      } else {
        const rn = nightRow(u, g, layout, cfg, options, ed, e, mark);
        rn.style.top = px(ed(y));
        col.append(rn);
      }
      y += u.hEm + (page.gapEm || 0);
    }
    listWrap.append(col);
  });
  sheet.append(listWrap);

  // the script's logo (or its name) after the list, on the last page
  if (isLast && layout.logoOn) {
    const lT = elGet(options, P + 'Logo');
    const top = listTop + (page.naturalEm || 0) * d + A.logoGap + A.logoMaxH / 2;
    let logoSrc = resolveSrc(lT.src) || (script.meta.logo && options.useLogo ? proxied(script.meta.logo, options.proxyIcons) : '');
    if (logoSrc && failedArt.has(logoSrc)) logoSrc = '';
    if (logoSrc) {
      const logoEl = img(logoSrc, {
        position: 'absolute',
        left: (cx + lT.dx) + '%',
        top: px(e(top + lT.dy)),
        transform: `translate(-50%, -50%)${lT.rot ? ` rotate(${lT.rot}deg)` : ''}`,
        maxWidth: (A.logoMaxW * lT.scale) + '%',
        maxHeight: px(e(A.logoMaxH) * lT.scale),
        objectFit: 'contain',
        opacity: String(lT.opacity),
      }, script.meta.name);
      logoEl.crossOrigin = 'anonymous';
      logoEl.addEventListener('error', () => { failedArt.add(logoSrc); if (ctx.requestRender) ctx.requestRender(); });
      sheet.append(mark(logoEl, 'el:' + P + 'Logo'));
    } else if (cfg.showName !== false) {
      const title = (options.titleOverride || '').trim() || script.meta.name;
      const fam = fontFamily(options.fontTitle || 'unlovable');
      const unlovable = (options.fontTitle || 'unlovable') === 'unlovable';
      let fs = e(A.logoNameSize) * lT.scale;
      const w = textWidth(title, `400 ${fs}px ${fam}`) - (unlovable ? (title.split(' ').length - 1) * 0.21 * fs : 0);
      const maxW = (A.logoMaxW / 100) * SHEET_W;
      if (w > maxW) fs *= maxW / w;
      sheet.append(mark(el('div', {
        position: 'absolute',
        left: (cx + lT.dx) + '%',
        top: px(e(top + lT.dy)),
        transform: `translate(-50%, -50%)${lT.rot ? ` rotate(${lT.rot}deg)` : ''}`,
        fontFamily: fam,
        fontSize: px(fs),
        lineHeight: '1',
        whiteSpace: 'nowrap',
        wordSpacing: unlovable ? '-0.21em' : '0',
        color: a.titleColor || '#8b1a23',
        opacity: String(lT.opacity),
        textShadow: `${e(0.04)}px ${e(0.07)}px ${e(0.08)}px rgba(40, 20, 10, 0.35)`,
      }, title), 'el:' + P + 'Logo'));
    }
  }

  // the footer lines and the badge, only when asked for (the app has none)
  if (cfg.appFooter) {
    const fT = elGet(options, P + 'Footer');
    if (cfg.showFooter !== false && !fT.hidden && ((cfg.footer1 || '').trim() || (cfg.footer2 || '').trim())) {
      const foot = el('div', {
        position: 'absolute', right: (2.4 - fT.dx) + '%', top: px(e(96.5 + fT.dy)), textAlign: 'right',
        fontFamily: fonts.text, fontSize: px(e(0.82) * fT.scale), lineHeight: px(e(1.1) * fT.scale),
        color: cfg.textColor || '#2b2b2b', opacity: String(fT.opacity * 0.85), whiteSpace: 'nowrap',
      });
      if ((cfg.footer1 || '').trim()) foot.append(el('div', null, smartTypography(cfg.footer1)));
      if ((cfg.footer2 || '').trim()) foot.append(el('div', null, smartTypography(cfg.footer2)));
      sheet.append(mark(foot, 'el:' + P + 'Footer'));
    }
    const bT = elGet(options, P + 'Badge');
    if (cfg.showBadge !== false && !bT.hidden) {
      sheet.append(mark(img(resolveSrc(bT.src) || BADGE, {
        position: 'absolute', left: (A.sidebarW + 1.2 + bT.dx) + '%', bottom: px(e(1.2 - bT.dy)),
        width: (12.2 * bT.scale) + '%', opacity: String(bT.opacity),
      }), 'el:' + P + 'Badge'));
    }
  }

  for (const n of renderStickers(ctx.stickers, selected, false)) sheet.append(n);
  return sheet;
}
