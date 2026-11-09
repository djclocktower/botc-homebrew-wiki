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
  COLUMN_SHEET, COLUMN_HEAD_INK, columnsFor, columnLists, balancedTeam, teamSize, FIT, SHEET, SHEET_W, SHEET_H, U, TEAM_LABELS, TEAM_LABELS_SINGULAR,
  PLACEHOLDER_ICON, footEm, groupByTeam, frontCharacters, proxied, smartTypography, fontFamily, elGet, nightLists, fitNameLines,
  withLook, teamColor, jinxNotes,
} from './script.js';
import {
  el, img, px, clamp, textWidth, wrappedLineCount, normalizeIcons, iconFit, inkTransform, iconFilter,
  ICON_IDENTITY, drawIcon, trimmedArt,
} from './util.js';
import { pageFrame, renderBackground, renderStickers, resolveSrc, applyEl, markSelected, watermark, ART } from './elements.js';
import { appendRibbon, abilityNodes } from './sheet.js';

const C = COLUMN_SHEET;
const sum = (a) => a.reduce((x, y) => x + y, 0);
/* one cell's width, % of the page: the grid's width over its columns, but a
   lone character (the Demon) keeps its text beside its icon rather than
   stretched across the page */
const cellPct = (cols, G) => Math.min(C.soloW, (G.x1 - G.x0) / cols);

/* the controls every script sheet style shares, read through this style's
   own look (DEFAULT_COLS): fonts, name case, inks */
function lookOf(options) {
  const o = withLook(options, 'columns');
  return {
    o,
    font: {
      title: fontFamily(o.fontTitle), name: fontFamily(o.fontName), text: fontFamily(o.fontAbility),
      label: fontFamily(o.fontLabel), author: fontFamily(o.fontAuthor), foot: fontFamily(o.fontFootnote),
    },
    nameCase: (n) => (o.nameCase === 'upper' ? n.toUpperCase() : n),
    variant: o.nameCase === 'smallcaps' ? 'small-caps ' : '',
    spacing: Number(o.nameSpacing) || 0,
    rowGap: (C.rowGap + (clamp(Number(o.rowGap) || 1, 0.5, 3) - 1) * 1.6),
  };
}
/* the column's width follows Ribbon width, and the grid, title and
   footnote move in with its edge */
function geom(o) {
  const colW = C.colW * clamp(Number(o.sidebarWidth) || 1, 0.6, 1.4);
  const dx = colW - C.colW;
  return { colW, x0: C.contentX0 + dx, x1: C.contentX1 - dx, headX: C.headX + dx, titleX0: C.titleX0 + dx, logoX1: C.logoX1 - dx, footRight: C.footnoteRight + dx };
}
// a width with letter spacing (em of the font's own size) added
const fontPx = (f) => Number((/([\d.]+)px/.exec(f) || [0, 16])[1]);
const spaced = (em) => (s, f) => textWidth(s, f) + (em ? em * fontPx(f) * [...s].length : 0);

function iconImg(src, style, alt) {
  const n = img(src, style, alt);
  n.crossOrigin = 'anonymous';
  n.decoding = 'sync';
  n.addEventListener('error', () => { if (n.src !== PLACEHOLDER_ICON) n.src = PLACEHOLDER_ICON; });
  return n;
}

function headingText(options, team, n) {
  const own = (options.teamLabels && options.teamLabels[team] || '').trim();
  return (own || (n === 1 ? TEAM_LABELS_SINGULAR : TEAM_LABELS)[team]).toUpperCase() + (options.labelCounts ? ' · ' + n : '');
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
  const L = lookOf(options), o = L.o, G = geom(o);
  const iconSize = options.iconSize || 1, nameSize = options.nameSize || 1, textSize = options.textSize || 1;
  const lineMul = options.abilityLine || 1;
  const gapPx = (C.iconGap / 100) * SHEET_W;
  const nameW = spaced(L.spacing);
  const notes = options.jinxText ? jinxNotes(script.characters) : null;
  const labelsOn = options.showLabels !== false;

  const measureSection = (g, d) => {
    const n = g.characters.length;
    const cols = columnsFor(n);
    const [iconB, nameB, textB] = C.cell[cols];
    const k = teamSize(options, g.team); // this team's own size slider
    const nameEm = nameB * nameSize * k * d, textEm = textB * textSize * k * d;
    const cellW = (cellPct(cols, G) / 100) * SHEET_W;
    const nameFontAt = (s) => `${L.variant}400 ${(nameEm * U * s).toFixed(2)}px ${L.font.name}`;
    // the icon grows with the page but never past a share of its cell, or a
    // short script squeezes its abilities into a strip a few words wide
    let iconPx = Math.min(iconB * iconSize * k * d * U, cellW * C.iconMaxShare);
    /* and it gives up width (to C.iconYield of itself) when the team's
       longest word of a name would not fit beside it: otherwise a name that
       already fills its column cannot grow, and the Name size slider did
       nothing on a short script */
    const widest = Math.max(0, ...g.characters.flatMap((c) =>
      L.nameCase(smartTypography(c.name)).split(/\s+/).map((w) => nameW(w, nameFontAt(1)))));
    const room = cellW - iconPx - gapPx * 2;
    if (widest > room) iconPx = Math.max(iconPx * C.iconYield, cellW - widest - gapPx * 2);
    const iconEm = iconPx / U;
    const textW = Math.max(40, cellW - iconPx - gapPx * 2);
    const textFont = `400 ${(textEm * U).toFixed(2)}px ${L.font.text}`;
    const noteEm = textEm * 0.86;
    const noteFont = `italic 400 ${(noteEm * U).toFixed(2)}px ${L.font.text}`;
    const jinxPx = textEm * U * 1.5 * (options.jinxIconSize || 1);
    const cells = g.characters.map((c) => {
      const name = L.nameCase(smartTypography(c.name));
      // a long name takes more lines before it shrinks
      const nm = fitNameLines(name, textW, nameW, nameFontAt, { maxLines: 3, minScale: 0.3 });
      const nameScale = nm.scale;
      const lines = c.ability ? wrappedLineCount(smartTypography(c.ability), textFont, textW) : 0;
      const nameH = nameEm * nameScale * C.nameLine * nm.lines.length;
      const textH = lines * textEm * C.abilityLine * lineMul;
      /* under the ability, as on the other styles: the jinxed partners'
         icons (and marks), then each jinx rule or mark note in small italic
         behind its partner's icon */
      const marks = c.marks || [];
      const icons = [...(options.showJinxes ? c.jinxIcons : []), ...marks.filter((m) => !m.note)];
      const noteList = [...((notes && notes.get(c.id)) || []).map((j) => ({ icon: j.icon, name: j.name, text: j.reason })),
        ...marks.filter((m) => m.note).map((m) => ({ icon: m.icon, name: m.name, text: m.note }))];
      // the icons wrap onto as many rows as they need under the ability
      const perRow = Math.max(1, Math.floor(textW / (jinxPx * 1.12)));
      const iconsH = icons.length ? Math.ceil(icons.length / perRow) * jinxPx / U + 0.25 * d : 0;
      const noteLines = noteList.map((n) => wrappedLineCount(smartTypography(n.text), noteFont, textW - noteEm * U * C.abilityLine * lineMul * 0.95 * 1.12));
      const notesH = sum(noteLines) * noteEm * C.abilityLine * lineMul + (noteList.length ? 0.25 * d : 0);
      const blockH = nameH + textH + iconsH + notesH;
      return { c, name, nameLines: nm.lines, nameScale, nameH, textH, icons, iconsH, noteList, blockH, h: Math.max(iconEm, blockH) };
    });
    const gap = L.rowGap * d, cellPctW = cellPct(cols, G);
    let bodyH, slots, place;
    // which column each character goes in, in the reading order asked for
    const down = options.colOrder === 'down';
    const lists = columnLists(n, cols, down ? 'down' : 'across').map((l) => l.map((i) => cells[i]));
    const colX = (k) => G.x0 + k * cellPctW;
    if (balancedTeam(options, g.team) && cols > 1 && n > cols) {
      /* balanced: each column spreads its rows so every column of the team
         ends on the same line, rather than a short row left at the bottom */
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
            out.push({ m, left: colX(k), topEm: y, slotEm: slot });
            y += slot;
          }
        });
        return { placed: out, h: H };
      };
    } else {
      // rows: each as tall as its tallest cell, so a row's cells line up
      const rows = [];
      for (let r = 0; r < lists[0].length; r++) {
        const part = lists.map((l, k) => (l[r] ? { m: l[r], k } : null)).filter(Boolean);
        rows.push({ cells: part, h: Math.max(...part.map((x) => x.m.h)) + gap });
      }
      bodyH = sum(rows.map((r) => r.h));
      slots = rows.length;
      place = (y0, per) => {
        const out = [];
        let y = y0;
        for (const r of rows) {
          // read across, a short last row is centred under the full ones;
          // read down, every cell stays in its own column
          const x0 = G.x0 + (G.x1 - G.x0 - r.cells.length * cellPctW) / 2;
          r.cells.forEach((x, i) => out.push({ m: x.m, left: down && cols > 1 ? colX(x.k) : x0 + i * cellPctW, topEm: y, slotEm: r.h + per }));
          y += r.h + per;
        }
        return { placed: out, h: y - y0 };
      };
    }
    return {
      team: g.team, cols, slots, place, iconEm, nameEm, textEm, noteEm, jinxPx, textW, gap,
      label: headingText(options, g.team, n),
      headEm: labelsOn ? C.headBand * d : 0,
      need: (labelsOn ? C.headBand * d : 0) + bodyH,
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
  return { style: 'columns', pages: [page], d, nights, look: L, G };
}

/* the title: the script's name in the swash face, on one, two or three
   lines, whichever lets it be largest inside its box */
function titleLines(title, boxW, boxH, fam) {
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
    const widest = Math.max(...lines.map((l) => textWidth(l, `400 100px ${fam}`) / 100));
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
  const L = layout.look || lookOf(options), o = L.o, G = layout.G || geom(o);
  const FONT = L.font;
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
  const ox = (G.colW + C.colRule - 0.2 - artEdge * z) / (1 - z);
  const paper = el('div', { position: 'absolute', inset: '0', transform: `scale(${z})`, transformOrigin: `${ox}% 50%` });
  for (const n of renderBackground(options.bg, 'front', { scriptBg, noGarland: true })) paper.append(n);
  sheet.append(paper);
  for (const n of renderStickers(ctx.stickers, selected, 'back')) sheet.append(n);

  // the two columns: the sheet's ribbon art (its colour, its mode), with a
  // black edge on the inside
  const ribT = elGet(options, 'sidebar');
  if (options.sidebarMode !== 'none' && !ribT.hidden) {
    for (const side of ['left', 'right']) {
      appendRibbon(sheet, {
        mode: options.sidebarMode || 'damask', color: options.sidebarColor, contrast: options.sidebarContrast,
        src: resolveSrc(ribT.src), opacity: ribT.opacity, shade: 0, widthPct: G.colW, side,
      }, { requestRender: ctx.requestRender, forExport: ctx.forExport });
      sheet.append(el('div', {
        position: 'absolute', top: '0', height: '100%', width: C.colRule + '%', background: '#000',
        [side]: G.colW + '%',
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
      const cx = side === 'left' ? G.colW / 2 : 100 - G.colW / 2;
      const lab = el('div', {
        position: 'absolute', left: cx + '%', top: px(e(stackTop)), transform: 'translateX(-50%)',
        width: (G.colW + 1) + '%', textAlign: 'center', fontFamily: FONT.label, fontSize: px(e(C.labelSize)),
        lineHeight: '1.15', color: o.labelColor || '#ffffff', pointerEvents: 'auto', textShadow: `0 ${e(0.1)}px ${e(0.3)}px rgba(0,0,0,0.9)`,
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
    const tx0 = G.titleX0, tx1 = logo ? C.titleX1 : 100 - G.titleX0;
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
        width: (G.logoX1 - C.logoX0) + '%', height: px(e(logoH)), objectFit: 'contain', objectPosition: '50% 100%',
      }, title);
      lg.crossOrigin = 'anonymous';
      lg.addEventListener('error', () => { failedArt.add(logo); if (ctx.requestRender) ctx.requestRender(); });
      applyEl(lg, lT, '', U, SHEET_W);
      sheet.append(mark(lg, 'el:colLogo'));
    }
    const tT = elGet(options, 'colTitle');
    if (title && !tT.hidden) {
      const boxW = ((tx1 - tx0) / 100) * SHEET_W, boxH = e(titleBottom - C.titleTop);
      const fit = titleLines(title, boxW, boxH, FONT.title);
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
        textAlign: 'center', fontFamily: FONT.author, fontSize: px(e(C.authorSize)), lineHeight: '1.2', whiteSpace: 'nowrap', color: o.authorColor || ink,
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
  const ruleL = G.colW + C.colRule, ruleR = 100 - G.colW - C.colRule;
  const kw = options.colorKeywords ? { good: options.headingColor || COLUMN_HEAD_INK.townsfolk, evil: options.headingColor || COLUMN_HEAD_INK.demon } : null;
  const align = ['left', 'center', 'justify'].includes(o.abilityAlign) ? o.abilityAlign : 'center';
  const labelSp = Number(o.labelSpacing) || 0;
  for (const s of page.sections) {
    if (s.headEm) {
      // the heading, and the rule from it to the column (both ways for a
      // Demon, whose heading is centred)
      const fs = e(C.headSize * d) * (options.labelSize || 1);
      const headFont = `400 ${fs.toFixed(2)}px ${FONT.label}`;
      const wPct = (spaced(labelSp)(s.label, headFont) / SHEET_W) * 100;
      const color = options.headingColor || COLUMN_HEAD_INK[s.team] || ink;
      const centred = s.team === 'demon';
      const headX = centred ? 50 - wPct / 2 : G.headX;
      const ruleY = s.topEm + C.headBand * d * 0.42;
      /* the classic and app sheets' divider: a line with a knot at one
         end, fading out along it. Here the knot sits against the heading
         (mirrored on the Demon's left side), drawn a little thicker. */
      const ruleH = Math.max(6, e(C.ruleH * d));
      const rule = (x0, x1, mirror) => {
        if (options.showDividers !== false && x1 - x0 > 0.5) wrap.append(img(ART + 'divider-taper.png', {
          position: 'absolute', left: x0 + '%', width: (x1 - x0) + '%', top: px(e(ruleY) - ruleH / 2),
          height: px(ruleH), objectFit: 'fill', mixBlendMode: 'multiply',
          transform: mirror ? 'scaleX(-1)' : 'none',
          opacity: String(clamp(options.dividerOpacity == null ? 1 : options.dividerOpacity, 0, 1)),
        }));
      };
      if (centred) rule(ruleL, headX - 0.4, true);
      rule(headX + wPct + 0.4, ruleR, false);
      const head = el('div', {
        position: 'absolute', left: headX + '%', top: px(e(ruleY)), transform: 'translateY(-50%)',
        fontFamily: FONT.label, fontSize: px(fs), lineHeight: '1', whiteSpace: 'nowrap', color,
        letterSpacing: labelSp + 'em',
      }, s.label);
      head.dataset.fsHead = s.team;
      wrap.append(head);
    }

    for (const p of s.placed) {
      const { m, left } = p;
      const c = m.c;
      const rowMid = p.topEm + (p.slotEm - s.gap) / 2;
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
        top: px(e(rowMid - m.blockH / 2)), textAlign: align === 'justify' ? 'left' : align, color: ink, pointerEvents: 'auto',
      });
      block.dataset.fsChar = c.id;
      block.append(el('div', {
        fontFamily: FONT.name, fontSize: px(e(s.nameEm * m.nameScale)), lineHeight: String(C.nameLine),
        fontVariant: o.nameCase === 'smallcaps' ? 'small-caps' : 'normal', letterSpacing: L.spacing + 'em',
        whiteSpace: 'nowrap', color: c.color || teamColor(o, c.team),
      }, ...m.nameLines.map((ln) => el('div', null, ln))));
      const lh = String(C.abilityLine * (options.abilityLine || 1));
      if (c.ability) {
        block.append(el('div', {
          fontFamily: FONT.text, fontSize: px(e(s.textEm)), lineHeight: lh,
          whiteSpace: 'pre-line', textAlign: align,
        }, ...abilityNodes(c.ability, options.bracketStyle, kw, true)));
      }
      const tiny = (src, w, name, va) => {
        const f = options.normalizeIcons ? iconFit(src) : ICON_IDENTITY;
        const n = iconImg(drawIcon(src), {
          display: 'inline-block', width: px(w), height: px(w), verticalAlign: va || 'middle', objectFit: 'contain', flexShrink: '0',
          transform: inkTransform(f), margin: `0 ${px(w * 0.06)}`,
        }, name);
        n.title = name;
        return n;
      };
      if (m.icons.length) {
        block.append(el('div', {
          height: px(e(m.iconsH)), paddingTop: px(e(0.25 * d)), boxSizing: 'border-box',
          display: 'flex', flexWrap: 'wrap', alignContent: 'flex-start',
          justifyContent: align === 'center' ? 'center' : 'flex-start',
        }, ...m.icons.map((j) => tiny(j.icon, s.jinxPx, j.name))));
      }
      if (m.noteList.length) {
        // the partner's icon no taller than the line, so a note keeps the
        // line height it was measured at
        const nw = e(s.noteEm) * C.abilityLine * (options.abilityLine || 1) * 0.95;
        block.append(el('div', {
          fontFamily: FONT.text, fontStyle: 'italic', fontSize: px(e(s.noteEm)), lineHeight: lh,
          paddingTop: px(e(0.25 * d)), textAlign: align,
        }, ...m.noteList.map((n) => el('div', null, tiny(n.icon, nw, n.name, 'top'), smartTypography(n.text)))));
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
      position: 'absolute', right: G.footRight + '%', top: px(e(footEm(C.footnoteTop))),
      fontFamily: FONT.foot, fontSize: px(e(C.footnoteSize)), fontVariant: 'small-caps',
      whiteSpace: 'nowrap', color: o.footnoteColor || ink,
    }, custom || '*Not the first night');
    applyEl(foot, fT, '', U, SHEET_W);
    sheet.append(mark(foot, 'el:footnote'));
  }

  // the footnote has the bottom right corner here, so the mark takes the
  // bottom left of the paper, just past the column
  if (ctx.forExport) {
    const wm = watermark(0, 0.5);
    Object.assign(wm.style, { right: 'auto', left: (G.colW + C.colRule + 1.2) + '%' });
    sheet.append(wm);
  }
  for (const n of renderStickers(ctx.stickers, selected, 'front')) sheet.append(n);
  return sheet;
}
