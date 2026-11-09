/* Fancy Scripts — the night columns style.
 *
 * The owner's own Photoshop script sheets (Axiom of Logic, No Greater Joy,
 * Laissez Un Where?, The Hermetic Order of the Golden Dawn), as a third
 * style for the script sheet (options.sheetStyle = 'columns'):
 *
 *   [col]  Title              Logo   [col]
 *   FIRST  TOWNSFOLK ─────────────── OTHER
 *   NIGHT  icon NAME   icon NAME     NIGHTS
 *    ●       ability     ability      ●
 *    ●     OUTSIDERS ─────────────    ●
 *    …     ────────── DEMON ───────   …
 *                  *Not the first night
 *
 * The night order is IN the sheet: a damask column down each edge carries
 * a stack of icons, first night on the left, other nights on the right.
 * Each team sits under a heading in its own ink with a rule running from
 * it to the column; its characters are a grid (columnsFor: a lone Demon
 * full width, two or four in pairs, the rest in threes) of icon, name and
 * a centred ability. Geometry is COLUMN_SHEET in script.js.
 *
 * The same contracts as the other renderers: inline styles only (the
 * export captures these nodes), data-fs-drag on what moves, a layout pass
 * that measures and solves the density, then a render pass. Rows are not
 * reordered by dragging here (a grid is not a column); the Characters card
 * still orders them. Browser-only (canvas + DOM).
 */

import {
  COLUMN_SHEET, COLUMN_HEAD_INK, columnsFor, FIT, SHEET, SHEET_W, SHEET_H, U, TEAM_LABELS, TEAM_LABELS_SINGULAR,
  PLACEHOLDER_ICON, footEm, groupByTeam, frontCharacters, proxied, smartTypography, fontFamily, elGet, nightLists, fitNameLines,
} from './script.js';
import {
  el, img, px, clamp, textWidth, wrappedLineCount, normalizeIcons, iconFit, inkTransform, iconFilter,
  ICON_IDENTITY, drawIcon, trimmedArt,
} from './util.js';
import { pageFrame, renderBackground, renderStickers, resolveSrc, applyEl, markSelected, watermark } from './elements.js';
import { appendRibbon } from './sheet.js';

const C = COLUMN_SHEET;
const sum = (a) => a.reduce((x, y) => x + y, 0);
/* one cell's width, % of the page: the grid's width over its columns, but a
   lone character (the Demon) keeps its text beside its icon rather than
   stretched across the page */
const cellPct = (cols) => Math.min(C.soloW, (C.contentX1 - C.contentX0) / cols);
const FONT = { title: fontFamily('unlovable'), serif: fontFamily('optimus'), text: fontFamily('arial') };

function iconImg(src, style, alt) {
  const n = img(src, style, alt);
  n.crossOrigin = 'anonymous';
  n.decoding = 'sync';
  n.addEventListener('error', () => { if (n.src !== PLACEHOLDER_ICON) n.src = PLACEHOLDER_ICON; });
  return n;
}

function headingText(options, team, n) {
  const own = (options.teamLabels && options.teamLabels[team] || '').trim();
  return (own || (n === 1 ? TEAM_LABELS_SINGULAR : TEAM_LABELS)[team]).toUpperCase();
}

/* logos that failed to load: the title takes the whole width instead */
const failedArt = new Set();

/* the logo: an upload on the Logo element, else the script's own */
function logoArt(script, options) {
  const t = elGet(options, 'colLogo');
  if (t.hidden) return '';
  const art = resolveSrc(t.src) || (script.meta.logo && options.useLogo ? proxied(script.meta.logo, options.proxyIcons) : '');
  return art && !failedArt.has(art) ? trimmedArt(art) : '';
}

/* layoutColumnsSheet(script, options, requestRender) → {style:'columns', pages, d, …}
   One page, as every script sheet is: each team is a heading band and grid
   rows measured at a density, the density solved to fill the room between
   the header and the footnote, and what is left dealt out as space under
   the rows (to spreadEm) with a little of the rest above the first heading. */
export function layoutColumnsSheet(script, options, requestRender) {
  const groups = groupByTeam(frontCharacters(script, options), options.sortMode);
  const nights = nightLists(script, options.night);
  if (options.normalizeIcons) {
    const urls = new Set(script.characters.map((c) => c.icon));
    for (const it of [...nights.first, ...nights.other]) urls.add(it.icon);
    normalizeIcons([...urls], requestRender);
  }
  const iconSize = options.iconSize || 1, nameSize = options.nameSize || 1, textSize = options.textSize || 1;
  const lineMul = options.abilityLine || 1;
  const gapPx = (C.iconGap / 100) * SHEET_W;

  const measureSection = (g, d) => {
    const n = g.characters.length;
    const cols = columnsFor(n);
    const [iconB, nameB, textB] = C.cell[cols];
    const nameEm = nameB * nameSize * d, textEm = textB * textSize * d;
    const cellW = (cellPct(cols) / 100) * SHEET_W;
    // the icon grows with the page but never past a share of its cell, or a
    // short script squeezes its abilities into a strip a few words wide
    const iconEm = Math.min(iconB * iconSize * d, (cellW * C.iconMaxShare) / U);
    const textW = Math.max(40, cellW - iconEm * U - gapPx * 2);
    const nameFontAt = (k) => `400 ${(nameEm * U * k).toFixed(2)}px ${FONT.serif}`;
    const textFont = `400 ${(textEm * U).toFixed(2)}px ${FONT.text}`;
    const cells = g.characters.map((c) => {
      const name = smartTypography(c.name).toUpperCase();
      // a long name takes more lines before it shrinks
      const nm = fitNameLines(name, textW, textWidth, nameFontAt, { maxLines: 3, minScale: 0.3 });
      const nameScale = nm.scale;
      const lines = c.ability ? wrappedLineCount(smartTypography(c.ability), textFont, textW) : 0;
      const nameH = nameEm * nameScale * C.nameLine * nm.lines.length;
      const textH = lines * textEm * C.abilityLine * lineMul;
      return { c, name, nameLines: nm.lines, nameScale, nameH, textH, blockH: nameH + textH, h: Math.max(iconEm, nameH + textH) };
    });
    const gap = C.rowGap * d, cellPctW = cellPct(cols);
    let bodyH, slots, place;
    if (options.colBalance && cols > 1 && n > cols) {
      /* "Balance the columns": the team runs DOWN each column (the first
         ones one longer), and each column spreads its rows so every column
         ends on the same line, rather than rows across with a short one left
         at the bottom */
      const lists = [];
      for (let k = 0, i = 0; k < cols; k++) {
        const cnt = Math.floor(n / cols) + (k < n % cols ? 1 : 0);
        lists.push(cells.slice(i, i + cnt));
        i += cnt;
      }
      const colH = lists.map((l) => sum(l.map((x) => x.h + gap)));
      bodyH = Math.max(...colH);
      slots = Math.max(...lists.map((l) => l.length));
      place = (y0, per) => {
        const H = bodyH + per * slots, out = [];
        lists.forEach((l, k) => {
          const extra = (H - colH[k]) / l.length;
          let y = y0;
          for (const m of l) {
            const slot = m.h + gap + extra;
            out.push({ m, left: C.contentX0 + k * cellPctW, topEm: y, slotEm: slot });
            y += slot;
          }
        });
        return { placed: out, h: H };
      };
    } else {
      const rows = [];
      for (let i = 0; i < cells.length; i += cols) {
        const part = cells.slice(i, i + cols);
        rows.push({ cells: part, h: Math.max(...part.map((x) => x.h)) + gap });
      }
      bodyH = sum(rows.map((r) => r.h));
      slots = rows.length;
      place = (y0, per) => {
        const out = [];
        let y = y0;
        for (const r of rows) {
          // a short last row is centred under the full ones
          const x0 = C.contentX0 + (C.contentX1 - C.contentX0 - r.cells.length * cellPctW) / 2;
          r.cells.forEach((m, i) => out.push({ m, left: x0 + i * cellPctW, topEm: y, slotEm: r.h + per }));
          y += r.h + per;
        }
        return { placed: out, h: y - y0 };
      };
    }
    return {
      team: g.team, cols, slots, place, iconEm, nameEm, textEm, textW,
      label: headingText(options, g.team, n),
      headEm: C.headBand * d,
      need: C.headBand * d + bodyH,
    };
  };

  const header = options.showHeader !== false;
  const top = header ? C.contentTop : 2.5;
  const avail = footEm(C.contentBottom) - top;
  const needAt = (d) => sum(groups.map((g) => measureSection(g, d).need)) + Math.max(0, groups.length - 1) * C.sectionGap * d;

  let d = options.fitToContent ? 1 : clamp(Number(options.density) || 1, 0.3, 2);
  /* The largest density that fits, by halving. Not solveFit: here the
     height jumps as the density moves (lines re-wrap, and the text column
     narrows while the icons grow), and its ratio steps settled well short
     of the room, leaving a band of empty page under the header. */
  if (options.fitToContent && groups.length) {
    let lo = 0.01, hi = FIT.growMax;
    if (needAt(hi) <= avail) lo = hi;
    else for (let k = 0; k < 22; k++) { const mid = (lo + hi) / 2; if (needAt(mid) <= avail) lo = mid; else hi = mid; }
    d = lo;
  }
  const sections = groups.map((g) => measureSection(g, d));

  // the space left over: first under the rows, then split above and below
  const slots = sum(sections.map((s) => s.slots)) + Math.max(0, sections.length - 1);
  let spare = Math.max(0, avail - needAt(d));
  // (generously, and little of it above: the first heading should start
  // close to the same place on every script, not float half way down)
  const per = slots ? Math.min(spare / slots, C.spreadEm) : 0;
  spare -= per * slots;
  let y = top + spare * C.topShare;
  sections.forEach((s, i) => {
    if (i) y += C.sectionGap * d + per;
    s.topEm = y;
    y += s.headEm;
    const body = s.place(y, per);
    s.placed = body.placed;
    y += body.h;
  });

  const page = { sections, header, index: 0 };
  return { style: 'columns', pages: [page], d, nights };
}

/* the title: the script's name in the swash face, on one, two or three
   lines, whichever lets it be largest inside its box */
function titleLines(title, boxW, boxH) {
  const words = title.split(/\s+/).filter(Boolean);
  const tries = [];
  for (let n = 1; n <= Math.min(3, words.length); n++) {
    // n lines of roughly equal length
    const target = title.length / n;
    const lines = [];
    let cur = '';
    for (const w of words) {
      if (cur && lines.length < n - 1 && (cur + ' ' + w).length > target * 1.15) { lines.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w;
    }
    lines.push(cur);
    const widest = Math.max(...lines.map((l) => textWidth(l, `400 100px ${FONT.title}`) / 100));
    const size = Math.min(boxW / Math.max(1, widest), boxH / (lines.length * 0.92));
    tries.push({ lines, size });
  }
  return tries.sort((a, b) => b.size - a.size)[0] || { lines: [title], size: boxH };
}

export function renderColumnsSheetPage(script, options, layout, pageIndex, ctx) {
  ctx = ctx || {};
  const selected = ctx.selected || '';
  const page = layout.pages[0];
  const { d } = layout;
  const e = (em) => em * U;
  const mark = (node, id) => {
    node.dataset.fsDrag = id;
    if (id === selected) markSelected(node);
    return node;
  };
  const ink = options.inkColor || '#222222';

  const sheet = pageFrame(SHEET_W, SHEET_H, U, 'script-sheet script-columns');
  sheet.dataset.fsPage = String(pageIndex);
  sheet.dataset.fsDensity = d.toFixed(3);

  const scriptBg = script.meta.background ? proxied(script.meta.background, options.proxyIcons) : '';
  /* the classic paper without its garland (the grid runs to the foot). Its
     dark left frame and the gold edge beside it are sized for the classic
     ribbon, wider than this column, so the whole picture is zoomed in a
     little until both sit under the column. One picture: renderBackground's squeezeLeft
     overlays a squeezed copy of the left strip, and where the copy ends the
     texture jumped, a visible seam down the page. */
  // zoomed in evenly, from the point that puts the frame and its gold edge
  // just under the column: x' = ox + (x - ox) * z, solved for ox
  const z = C.paperZoom, artEdge = SHEET.sidebarX + SHEET.sidebarW + C.paperBand;
  const ox = (C.colW + C.colRule - 0.2 - artEdge * z) / (1 - z);
  const paper = el('div', { position: 'absolute', inset: '0', transform: `scale(${z})`, transformOrigin: `${ox}% 50%` });
  for (const n of renderBackground(options.bg, 'front', { scriptBg, noGarland: true })) paper.append(n);
  sheet.append(paper);
  for (const n of renderStickers(ctx.stickers, selected, 'back')) sheet.append(n);

  // the two columns: the sheet's ribbon art (its colour, its mode), with a
  // black edge on the inside
  if (options.sidebarMode !== 'none') {
    for (const side of ['left', 'right']) {
      appendRibbon(sheet, {
        mode: options.sidebarMode || 'damask', color: options.sidebarColor, contrast: options.sidebarContrast,
        shade: 0, widthPct: C.colW, side,
      }, { requestRender: ctx.requestRender, forExport: ctx.forExport });
      sheet.append(el('div', {
        position: 'absolute', top: '0', height: '100%', width: C.colRule + '%', background: '#000',
        [side]: C.colW + '%',
      }));
    }
  }
  for (const n of renderStickers(ctx.stickers, selected, 'mid')) sheet.append(n);

  // the night order down the columns
  const nT = elGet(options, 'colNight');
  if (!nT.hidden) {
    const box = el('div', { position: 'absolute', inset: '0', pointerEvents: 'none' });
    const night = options.night || {};
    const lists = [['left', night.titleFirst || 'First Night', layout.nights.first],
      ['right', night.titleOther || 'Other Nights', layout.nights.other]];
    /* Both stacks share one pitch and one top, so the two labels always sit
       level; the taller stack (label, gap, icons) is centred on the page. */
    const words = lists.map(([, label]) => String(label).toUpperCase().split(/\s+/));
    const labelH = Math.max(...words.map((w) => w.length)) * C.labelSize * 1.15;
    const most = Math.max(1, ...lists.map((l) => l[2].length));
    const pageEm = footEm(100);
    const room = pageEm - 2 * C.nightMargin - labelH - C.labelGap;
    const pitch = Math.min(C.nightPitch, room / most);
    const size = Math.min(C.nightIcon, pitch * 0.9);
    const stackTop = (pageEm - (labelH + C.labelGap + most * pitch)) / 2;
    const iconsTop = stackTop + labelH + C.labelGap;
    lists.forEach(([side, , items], li) => {
      const cx = side === 'left' ? C.colW / 2 : 100 - C.colW / 2;
      const lab = el('div', {
        position: 'absolute', left: cx + '%', top: px(e(stackTop)), transform: 'translateX(-50%)',
        width: (C.colW + 1) + '%', textAlign: 'center', fontFamily: FONT.serif, fontSize: px(e(C.labelSize)),
        lineHeight: '1.15', color: '#ffffff', pointerEvents: 'auto', textShadow: `0 ${e(0.1)}px ${e(0.3)}px rgba(0,0,0,0.9)`,
      });
      for (const w of words[li]) lab.append(el('div', null, w));
      box.append(lab);
      items.forEach((it, i) => {
        const fit = options.normalizeIcons ? iconFit(it.icon) : ICON_IDENTITY;
        const ic = iconImg(drawIcon(it.icon), {
          position: 'absolute', left: `calc(${cx}% - ${px(e(size) / 2)})`, top: px(e(iconsTop + i * pitch + (pitch - size) / 2)),
          width: px(e(size)), height: px(e(size)), objectFit: 'contain', pointerEvents: 'auto',
          transform: inkTransform(fit), filter: `drop-shadow(0 ${e(0.08)}px ${e(0.25)}px rgba(0,0,0,0.6))`,
        }, it.name);
        ic.title = it.name;
        box.append(ic);
      });
    });
    applyEl(box, { ...nT, hidden: false }, '', U, SHEET_W);
    sheet.append(mark(box, 'el:colNight'));
  }

  /* the header: title, logo beside it, author under it. It sits on the
     content, not the top of the page: the author line just above the first
     heading and the title right on top of the author, so there is no empty
     band inside the header or between it and the grid (and on a short
     script, whose grid starts lower, the header comes down with it). */
  if (page.header) {
    const title = (options.titleOverride || '').trim() || script.meta.name || '';
    const logo = logoArt(script, options);
    const tx0 = C.titleX0, tx1 = logo ? C.titleX1 : 100 - C.titleX0;
    const first = page.sections[0];
    const headerBottom = (first ? first.topEm : C.contentTop) - C.headerGap;
    const author = ((options.authorOverride || '').trim() || script.meta.author || '').trim();
    const aT = elGet(options, 'colAuthor');
    const authorOn = !!(options.showAuthor && author && !aT.hidden);
    const authorTop = headerBottom - C.authorSize * 1.2;
    const titleBottom = authorOn ? authorTop - C.authorGap : headerBottom;
    if (logo) {
      const lT = elGet(options, 'colLogo');
      const logoH = Math.min(C.logoBottom - C.titleTop, headerBottom - C.titleTop);
      const lg = img(logo, {
        position: 'absolute', left: C.logoX0 + '%', top: px(e(headerBottom - logoH)),
        width: (C.logoX1 - C.logoX0) + '%', height: px(e(logoH)), objectFit: 'contain', objectPosition: '50% 100%',
      }, title);
      lg.crossOrigin = 'anonymous';
      lg.addEventListener('error', () => { failedArt.add(logo); if (ctx.requestRender) ctx.requestRender(); });
      applyEl(lg, lT, '', U, SHEET_W);
      sheet.append(mark(lg, 'el:colLogo'));
    }
    const tT = elGet(options, 'colTitle');
    if (title && !tT.hidden) {
      const boxW = ((tx1 - tx0) / 100) * SHEET_W, boxH = e(titleBottom - C.titleTop);
      const fit = titleLines(title, boxW, boxH);
      const size = Math.min(fit.size, e(C.titleSize));
      const t = el('div', {
        position: 'absolute', left: tx0 + '%', width: (tx1 - tx0) + '%',
        top: px(e(titleBottom) - size * 0.92 * fit.lines.length),
        textAlign: 'center', fontFamily: FONT.title, fontSize: px(size), lineHeight: '0.92', whiteSpace: 'nowrap',
        color: options.titleColor || '#10102e',
        textShadow: `0 ${e(0.12)}px ${e(0.25)}px rgba(0,0,0,0.35)`,
      });
      for (const ln of fit.lines) t.append(el('div', null, ln));
      applyEl(t, tT, '', U, SHEET_W);
      sheet.append(mark(t, 'el:colTitle'));
    }
    if (authorOn) {
      const a = el('div', {
        position: 'absolute', left: tx0 + '%', width: (tx1 - tx0) + '%', top: px(e(authorTop)),
        textAlign: 'center', fontFamily: FONT.serif, fontSize: px(e(C.authorSize)), lineHeight: '1.2', whiteSpace: 'nowrap', color: ink,
      }, (options.authorPrefix == null ? 'by ' : options.authorPrefix) + smartTypography(author));
      applyEl(a, aT, '', U, SHEET_W);
      sheet.append(mark(a, 'el:colAuthor'));
    }
  }

  // the teams
  const cT = elGet(options, 'content');
  // the grid covers the page, so it takes no clicks itself: the title and
  // logo under it stay reachable, and its icons and text blocks opt back in
  const wrap = el('div', { position: 'absolute', inset: '0', pointerEvents: 'none' });
  applyEl(wrap, { ...cT, scale: 1 }, '', U, SHEET_W);
  if (cT.scale !== 1) {
    wrap.style.transformOrigin = '50% 0';
    wrap.style.transform = (wrap.style.transform || '') + ` scale(${cT.scale})`;
  }
  wrap.dataset.fsEl = 'content';
  const ruleL = C.colW + C.colRule, ruleR = 100 - C.colW - C.colRule;
  for (const s of page.sections) {
    // the heading, and the rule from it to the column (both ways for a
    // Demon, whose heading is centred)
    const fs = e(C.headSize * d) * (options.labelSize || 1);
    const headFont = `400 ${fs.toFixed(2)}px ${FONT.serif}`;
    const wPct = (textWidth(s.label, headFont) / SHEET_W) * 100;
    const color = options.headingColor || COLUMN_HEAD_INK[s.team] || ink;
    const centred = s.team === 'demon';
    const headX = centred ? 50 - wPct / 2 : C.headX;
    const ruleY = s.topEm + C.headBand * d * 0.42;
    const rule = (x0, x1) => {
      if (x1 - x0 > 0.5) wrap.append(el('div', {
        position: 'absolute', left: x0 + '%', width: (x1 - x0) + '%', top: px(e(ruleY) - e(C.ruleH) / 2),
        height: px(Math.max(1.5, e(C.ruleH))), background: '#000',
      }));
    };
    if (centred) rule(ruleL, headX - 0.8);
    rule(headX + wPct + 0.8, ruleR);
    const head = el('div', {
      position: 'absolute', left: headX + '%', top: px(e(ruleY)), transform: 'translateY(-50%)',
      fontFamily: FONT.serif, fontSize: px(fs), lineHeight: '1', whiteSpace: 'nowrap', color,
    }, s.label);
    head.dataset.fsHead = s.team;
    wrap.append(head);

    for (const p of s.placed) {
      const { m, left } = p;
      const c = m.c;
      const rowMid = p.topEm + (p.slotEm - C.rowGap * d) / 2;
      const iconEm = s.iconEm * (c.iconScale || 1);
      const fit = options.normalizeIcons ? iconFit(c.icon) : ICON_IDENTITY;
      const icon = iconImg(drawIcon(c.icon), {
        position: 'absolute',
        left: (left + C.iconGap + (c.iconDX || 0) + (Number(options.iconShiftX) || 0)) + '%',
        top: px(e(rowMid - iconEm / 2 + (c.iconDY || 0) + (Number(options.iconShiftY) || 0))),
        width: px(e(iconEm)), height: px(e(iconEm)), objectFit: 'contain', pointerEvents: 'auto',
        transform: inkTransform(fit), transformOrigin: 'center',
        filter: iconFilter(options.iconEffect, options.iconShadow == null ? 1 : options.iconShadow, (em) => e(em)),
      }, c.name);
      if (options.iconEffect === 'engraved') icon.style.mixBlendMode = 'multiply';
      wrap.append(mark(icon, 'char:' + c.id));

      const textLeftPx = (left / 100) * SHEET_W + e(s.iconEm) + ((C.iconGap * 2) / 100) * SHEET_W;
      const block = el('div', {
        position: 'absolute', left: px(textLeftPx), width: px(s.textW),
        top: px(e(rowMid - m.blockH / 2)), textAlign: 'center', color: ink, pointerEvents: 'auto',
      });
      block.dataset.fsChar = c.id;
      block.append(el('div', {
        fontFamily: FONT.serif, fontSize: px(e(s.nameEm * m.nameScale)), lineHeight: String(C.nameLine),
        whiteSpace: 'nowrap', color: c.color || ink,
      }, ...m.nameLines.map((ln) => el('div', null, ln))));
      if (c.ability) {
        block.append(el('div', {
          fontFamily: FONT.text, fontSize: px(e(s.textEm)), lineHeight: String(C.abilityLine * (options.abilityLine || 1)),
          whiteSpace: 'pre-line',
        }, smartTypography(c.ability)));
      }
      wrap.append(block);
    }
  }
  sheet.append(wrap);

  // "*Not the first night", bottom right
  const fT = elGet(options, 'footnote');
  const custom = (options.footnoteText || '').trim();
  const hasStar = script.characters.some((c) => (c.ability || '').includes('night*'));
  if (options.showFootnote && (hasStar || custom) && !fT.hidden) {
    const foot = el('div', {
      position: 'absolute', right: C.footnoteRight + '%', top: px(e(footEm(C.footnoteTop))),
      fontFamily: FONT.serif, fontSize: px(e(C.footnoteSize)), fontVariant: 'small-caps',
      whiteSpace: 'nowrap', color: ink,
    }, custom || '*Not the first night');
    applyEl(foot, fT, '', U, SHEET_W);
    sheet.append(mark(foot, 'el:footnote'));
  }

  // the footnote has the bottom right corner here, so the mark takes the
  // bottom left of the paper, just past the column
  if (ctx.forExport) {
    const wm = watermark(0, 0.5);
    Object.assign(wm.style, { right: 'auto', left: (C.colW + C.colRule + 1.2) + '%' });
    sheet.append(wm);
  }
  for (const n of renderStickers(ctx.stickers, selected, 'front')) sheet.append(n);
  return sheet;
}
