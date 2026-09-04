/* Fancy Scripts — the sheet renderer.
 *
 * Vanilla-DOM port of the handoff's ScriptSheet component: builds one
 * .script-sheet element (1242×1656 CSS px, the 3:4 reference trim) per
 * PAGE from a parsed script + options. Everything is inline-styled with
 * the calibrated values from script.js's SHEET — this element is also what
 * the PNG/PDF export captures, so its pixels ARE the product; nothing about
 * it may depend on the page's stylesheet.
 *
 * Two passes:
 *   layoutSheet()     — measures every row (word-wrap in the real fonts),
 *                       solves the density, and PACKS the sections onto
 *                       pages. A script that would have to shrink below
 *                       options.minFit continues onto a second sheet (a
 *                       team is split across the break and its label is
 *                       repeated) instead of becoming unreadable.
 *   renderSheetPage() — draws one of those pages: background, ribbon,
 *                       header band, sections, footnote, page number,
 *                       stickers. Every movable piece carries
 *                       data-fs-drag so drag.js can pick it up.
 *
 * Two async loops feed back into rendering, and both go through the caller's
 * requestRender callback instead of touching the DOM they built:
 *   - icon ink normalization: every icon's alpha bounding box is measured
 *     once (cached per url) and the artwork scaled/recentred so all icons
 *     carry the same visual weight, like the hand-laid official sheets;
 *   - the sidebar recolour and the fonts: word-wrap and the title width are
 *     measured with canvas/layout, so the caller re-renders once
 *     document.fonts.ready resolves.
 *
 * fitTitle(el) must be called after the element is in the document: the
 * swash title shrinks to the band between the skull and the right flourish,
 * and that needs real layout. Browser-only (canvas + DOM) — do not import
 * from the Worker.
 */

import {
  SHEET, SHEET_W, SHEET_H, U, SIDEBAR_BASE,
  TEAM_LABELS, TEAM_LABELS_SINGULAR, PLACEHOLDER_ICON,
  groupByTeam, splitColumns, proxied, smartTypography, teamColor, fontFamily, elGet,
} from './script.js';
import {
  el, img, px, clamp, hexHsl, shade, wrappedLineCount,
  normalizeIcons, iconFit, inkTransform, iconFilter, ICON_IDENTITY,
} from './util.js';
import {
  ART, pageFrame, renderBackground, renderStickers, resolveSrc, applyEl, markSelected,
} from './elements.js';
import { runPixelJob } from './jobs.js';

/* an icon <img> that falls back to the placeholder when its art 404s */
function iconImg(src, style, alt) {
  const n = img(src, style, alt);
  n.crossOrigin = 'anonymous';
  n.addEventListener('error', () => {
    if (n.src !== PLACEHOLDER_ICON) n.src = PLACEHOLDER_ICON;
  });
  return n;
}

/* ability text with typographic punctuation and the ornamental asterisk of
   the official sheets */
function abilityNodes(text, bracketStyle) {
  const parts = smartTypography(text).split('*');
  const out = [];
  const bracketed = (s) => {
    // "[+2 Outsiders]" setup notes, styled apart from the rule when asked
    if (!bracketStyle || bracketStyle === 'plain') return [document.createTextNode(s)];
    const nodes = [];
    const re = /\[[^\]\n]{1,60}\]/g;
    let last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) nodes.push(document.createTextNode(s.slice(last, m.index)));
      const span = el('span', bracketStyle === 'italic' ? { fontStyle: 'italic' }
        : bracketStyle === 'bold' ? { fontWeight: '700' }
          : { opacity: '0.72', fontStyle: 'italic' }, m[0]);
      nodes.push(span);
      last = m.index + m[0].length;
    }
    if (last < s.length) nodes.push(document.createTextNode(s.slice(last)));
    return nodes;
  };
  parts.forEach((p, i) => {
    for (const n of bracketed(p)) out.push(n);
    if (i < parts.length - 1) {
      out.push(img(ART + 'asterisk.png', {
        display: 'inline-block',
        height: '0.6em',
        width: 'auto',
        margin: '0 0.09em 0 0.05em',
        verticalAlign: '0.16em',
      }, '*'));
    }
  });
  return out;
}

/* ── sidebar ribbon recolour ────────────────────────────────────────────
   Re-tint the navy damask strip toward any picked colour — per pixel in
   real HSL (see pixel.js for why a CSS hue-rotate was not good enough).
   The recolour runs once per picked colour, in the pixel worker, and is
   cached: renderSheetPage() shows the newest canvas it has and asks for a
   re-render when a fresh one lands, exactly like the icon-ink
   measurements. */
const sidebarTint = {
  img: null, imgReady: false,
  color: '', canvas: null, // the newest finished recolour
  busy: false, want: '', notify: null,
};

/* newest recoloured canvas for `color`, or the best stale one while the
   fresh one is computed off this frame (null = show the plain navy art) */
function sidebarTintCanvas(color, requestRender) {
  const st = sidebarTint;
  st.notify = requestRender;
  if (st.color === color && st.canvas) return st.canvas;
  st.want = color;
  if (!st.img) {
    st.img = new Image();
    st.img.onload = () => { st.imgReady = true; pumpSidebarTint(); };
    st.img.src = ART + 'sidebar-flat.png';
  } else {
    pumpSidebarTint();
  }
  return st.canvas; // possibly a stale colour — better than flashing navy
}

function pumpSidebarTint() {
  const st = sidebarTint;
  if (st.busy || !st.imgReady || !st.want || st.want === st.color) return;
  const color = st.want;
  const t = hexHsl(color);
  if (!t) { st.want = st.color; return; }
  st.busy = true;
  const src = st.img;
  const c = document.createElement('canvas');
  c.width = src.naturalWidth;
  c.height = src.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0);
  const im = ctx.getImageData(0, 0, c.width, c.height);
  const job = {
    type: 'tint', buf: im.data.buffer,
    dH: t.h - SIDEBAR_BASE.h,
    sRatio: t.s < 0.06 ? 0 : t.s / SIDEBAR_BASE.s,
    lRatio: t.l / SIDEBAR_BASE.l,
  };
  runPixelJob(job, [im.data.buffer]).then((buf) => {
    ctx.putImageData(new ImageData(new Uint8ClampedArray(buf), c.width, c.height), 0, 0);
    st.canvas = c;
    st.color = color;
  }).catch(() => { st.want = st.color; }).then(() => {
    st.busy = false;
    if (st.notify) st.notify();
    pumpSidebarTint(); // the wanted colour may have moved on meanwhile
  });
}

/* title in the swash face: the default keeps the reference's exact
   indigo→near-black ramp over a bronze offset duplicate; other styles
   build the same two layers from the picked colour(s) */
function swashTitle(text, options, shadowDX, shadowDY) {
  const color = options.titleColor || '#10102e';
  const style = options.titleStyle || 'classic';
  let gradient;
  if (style === 'flat') gradient = null;
  else if (style === 'gradient') gradient = `linear-gradient(180deg, ${options.titleColor2 || '#3d3e88'} 0%, ${color} 100%)`;
  else if (style === 'classic' && color.toLowerCase() === '#10102e') {
    gradient = 'linear-gradient(180deg, #3d3e88 0%, #2c2a70 34%, #141244 55%, #0e0e20 74%, #10102e 100%)';
  } else gradient = `linear-gradient(-20deg, ${shade(color, 0.18)} 50%, ${shade(color, -0.14)})`;
  const wrap = el('span', { position: 'relative', display: 'inline-block' });
  const sh = clamp(Number(options.titleShadow == null ? 1 : options.titleShadow), 0, 3);
  if (sh > 0) {
    const back = el('span', {
      position: 'absolute',
      left: '0',
      top: '0',
      color: options.titleShadowColor || '#ad9069',
      transform: `translate(${shadowDX * sh}px, ${shadowDY * sh}px)`,
      zIndex: '0',
    }, text);
    back.setAttribute('aria-hidden', 'true');
    wrap.append(back);
  }
  const front = el('span', { position: 'relative', zIndex: '1' }, text);
  if (gradient) {
    Object.assign(front.style, { background: gradient, backgroundClip: 'text', color: 'transparent' });
    front.style.setProperty('-webkit-background-clip', 'text');
  } else {
    front.style.color = color;
  }
  wrap.append(front);
  return wrap;
}

/* one character row: icon, name (+ jinx partner icons), ability */
function characterEntry(char, options, heightEm, iconEm, ed, e, fonts, widthMul) {
  const { textSize, nameSize } = options;
  const colW = SHEET.textOffsetX + SHEET.textWidth * widthMul; // column width in % of sheet
  const textLeftPct = (SHEET.textOffsetX / colW) * 100;
  const textWidthPct = ((SHEET.textWidth * widthMul) / colW) * 100;
  const abilityTopEff = SHEET.nameTop + (SHEET.abilityTop - SHEET.nameTop) * nameSize;
  const fit = options.normalizeIcons ? iconFit(char.icon) : ICON_IDENTITY;
  const color = char.color || teamColor(options, char.team);

  const row = el('div', { position: 'relative', height: px(ed(heightEm)) });
  row.dataset.fsChar = char.id;

  const iconPx = ed(iconEm) * (char.iconScale || 1);
  const iconLeft = ((char.iconDX || 0) / 100) * SHEET_W;
  const iconTop = ed((heightEm - iconEm) / 2 + 0.5) - (iconPx - ed(iconEm)) / 2 + e(char.iconDY || 0);
  if (options.iconFrame && options.iconFrame !== 'none') {
    // a token-style backing: a parchment disc, or just its ring
    const pad = iconPx * 0.1;
    row.append(el('div', {
      position: 'absolute',
      left: px(iconLeft - pad), top: px(iconTop - pad),
      width: px(iconPx + pad * 2), height: px(iconPx + pad * 2),
      borderRadius: '50%',
      background: options.iconFrame === 'disc' ? 'rgba(248, 242, 226, 0.92)' : 'transparent',
      border: `${Math.max(1, ed(0.09))}px solid rgba(90, 70, 40, 0.55)`,
      boxSizing: 'border-box',
      boxShadow: options.iconFrame === 'disc' ? `0 ${ed(0.1)}px ${ed(0.25)}px rgba(32,20,8,0.35)` : 'none',
    }));
  }
  const icon = iconImg(char.icon, {
    position: 'absolute',
    left: px(iconLeft),
    top: px(iconTop),
    width: px(iconPx),
    height: px(iconPx),
    objectFit: 'contain',
    transform: inkTransform(fit),
    transformOrigin: 'center',
    filter: iconFilter(options.iconEffect, options.iconShadow, ed),
  });
  if (options.iconEffect === 'engraved') icon.style.mixBlendMode = 'multiply';
  row.append(icon);

  const nameRow = el('div', {
    position: 'absolute',
    left: textLeftPct + '%',
    top: px(ed(SHEET.nameTop)),
    width: textWidthPct + '%',
    display: 'flex',
    alignItems: 'center',
    gap: px(ed(0.14)),
    fontFamily: fonts.name,
    fontWeight: '700',
    fontSize: px(ed(SHEET.nameSize * nameSize)),
    lineHeight: '1',
    color,
    letterSpacing: (options.nameSpacing == null ? 0.02 : options.nameSpacing) + 'em',
    whiteSpace: 'nowrap',
    textTransform: options.nameCase === 'upper' ? 'uppercase' : 'none',
    fontVariant: options.nameCase === 'smallcaps' ? 'small-caps' : 'normal',
  }, el('span', null, smartTypography(char.name)));

  if (options.showJinxes) {
    for (const j of char.jinxIcons) {
      const jf = options.normalizeIcons ? iconFit(j.icon) : ICON_IDENTITY;
      const ji = iconImg(j.icon, {
        height: px(ed(SHEET.jinxSize * nameSize) * 0.72),
        width: px(ed(SHEET.jinxSize * nameSize) * 0.72),
        objectFit: 'contain',
        flexShrink: '0',
        transform: inkTransform(jf),
        transformOrigin: 'center',
        filter: iconFilter(options.iconEffect, options.iconShadow * 0.7, ed),
      }, j.name);
      ji.title = 'Jinxed: ' + j.name + (j.reason ? ' — ' + j.reason : '');
      nameRow.append(ji);
    }
  }
  row.append(nameRow);

  row.append(el('div', {
    position: 'absolute',
    left: textLeftPct + '%',
    top: px(ed(abilityTopEff)),
    width: textWidthPct + '%',
    fontFamily: fonts.ability,
    fontWeight: '400',
    fontSize: px(ed(SHEET.abilitySize * textSize)),
    lineHeight: String((SHEET.abilityLine / SHEET.abilitySize) * (options.abilityLine || 1)),
    color: options.inkColor || '#222222',
    mixBlendMode: 'multiply',
    textAlign: options.abilityAlign === 'justify' ? 'justify' : 'left',
  }, ...abilityNodes(char.ability, options.bracketStyle)));

  return row;
}

/* the fonts every text role uses, resolved once per render */
function fontsOf(options) {
  return {
    title: fontFamily(options.fontTitle),
    name: fontFamily(options.fontName),
    ability: fontFamily(options.fontAbility),
    label: fontFamily(options.fontLabel),
    author: fontFamily(options.fontAuthor),
    footnote: fontFamily(options.fontFootnote),
  };
}

/* the band the title/logo and author occupy, in em below contentTop —
   the first section starts under it (even layout; fixed, because the
   title does not scale with density) */
function headerExtraEm(script, options) {
  if (!options.showHeader) return 0;
  const t = elGet(options, 'title');
  const a = elGet(options, 'author');
  const bottoms = [];
  if (!t.hidden) {
    if (script.meta.logo && options.useLogo) {
      bottoms.push(SHEET.titleCY + t.dy + (9.4 * t.scale) / 2);
    } else {
      // the swash title's ink reaches ~3.05 em below its centre at size 1
      bottoms.push(SHEET.titleCY + t.dy + 3.05 * t.scale);
    }
  }
  const author0 = ((options.authorOverride || '').trim() || script.meta.author || '').trim();
  if (options.showAuthor && author0 && !a.hidden) bottoms.push(10.8 + t.dy + a.dy + 0.75 * a.scale);
  if (!bottoms.length) return 0;
  return Math.max(0, Math.max(...bottoms) - SHEET.contentTop + 0.35);
}

/* ── layout ─────────────────────────────────────────────────────────────
   layoutSheet(script, options, requestRender) → {pages, d, iconEm, ...}
   Measured layout: rows grow to fit wrapped ability text. Constant row
   pitch like the reference — up to 3 ability lines fit inside one pitch;
   only genuine spill grows a row. fitToContent solves for the density
   that fills contentTop..contentBottom (3 iterations converge). */
export function layoutSheet(script, options, requestRender) {
  const groups = groupByTeam(script.characters, options.sortMode);
  const { iconSize, textSize, nameSize } = options;
  const fonts = fontsOf(options);

  // kick off icon ink measurement for anything new
  if (options.normalizeIcons) {
    const urls = new Set();
    script.characters.forEach((c) => {
      urls.add(c.icon);
      c.jinxIcons.forEach((j) => urls.add(j.icon));
    });
    normalizeIcons([...urls], requestRender);
  }

  const abilityTopEff = SHEET.nameTop + (SHEET.abilityTop - SHEET.nameTop) * nameSize;
  /* 'single' puts every character in one column that runs the width of
     both — the second column's icon x plus its text width, over the first
     column's text width */
  const single = options.columnLayout === 'single';
  const widthMul = (options.columnWidth || 1) *
    (single ? (SHEET.col2IconX - SHEET.col1IconX + SHEET.textWidth) / SHEET.textWidth : 1);
  const maxTextW = ((SHEET.textWidth * widthMul) / 100) * SHEET_W;
  const availableEm = SHEET.contentBottom - SHEET.contentTop;
  const bareAvailEm = SHEET.contentBottom - SHEET.bareTop;
  // the icon must never spill into the text gutter, whatever the density
  const gutterEm = ((SHEET.textOffsetX - 0.05) / 100) * (SHEET_W / U);
  const iconEmFor = (density) => Math.min(SHEET.rowIcon * iconSize, gutterEm / density);
  const lineMul = options.abilityLine || 1;

  const rowHeightEm = (char, density) => {
    let need = Math.max(SHEET.rowPitch, iconEmFor(density) * (char ? (char.iconScale || 1) : 1) + 0.2);
    if (char) {
      const fontPx = SHEET.abilitySize * textSize * U * density;
      const lines = wrappedLineCount(smartTypography(char.ability), `400 ${fontPx}px ${fonts.ability}`, maxTextW);
      // 0.7 margin keeps 3-line rows inside one pitch (1.0 broke it)
      need = Math.max(need, abilityTopEff + (lines - 1) * SHEET.abilityLine * textSize * lineMul + 0.7);
    }
    return need;
  };

  const layoutEven = options.columnLayout !== 'shared';
  const sum = (a) => a.reduce((x, y) => x + y, 0);

  /* Two column layouts:

     'shared' — the classic reference layout: the two columns share one row
     grid (each row as tall as its taller side), and the title occupies the
     first row slot of the SECOND column in the first section, so col 2
     starts one row lower than col 1 (hence shift = 1 there).

     'even' — the official printed sheets: both columns start together and
     both END together. Each column keeps every row's needed height and the
     section's leftover space is dealt out evenly between its rows, so a
     7/6 townsfolk split gives the 6-row column a slightly wider pitch
     instead of a hole at the bottom. The title no longer takes a column
     slot, so the first section starts below the title/author ink instead
     (headerExtra — fixed, because the title does not scale with density). */
  const measureSection = (chars, density, shift) => {
    const [left, right] = single ? [chars, []] : splitColumns(chars);
    if (layoutEven) {
      const leftNeeds = left.map((ch) => rowHeightEm(ch, density));
      const rightNeeds = right.map((ch) => rowHeightEm(ch, density));
      return { left, right, leftNeeds, rightNeeds, need: Math.max(sum(leftNeeds), sum(rightNeeds)) };
    }
    const rows = Math.max(left.length, right.length + shift);
    const rowHeights = [];
    for (let i = 0; i < rows; i++) {
      rowHeights.push(Math.max(
        rowHeightEm(left[i], density),
        rowHeightEm(right[i - shift], density),
      ));
    }
    return { left, right, rowHeights, need: sum(rowHeights), shift };
  };

  const headerExtra = headerExtraEm(script, options);
  const pageHasHeader = (i) => options.showHeader && (i === 0 || options.repeatHeader);
  const availFor = (i) => (pageHasHeader(i)
    ? availableEm - (layoutEven ? headerExtra : 0)
    : bareAvailEm);
  const topFor = (i) => (pageHasHeader(i) ? SHEET.contentTop + (layoutEven ? headerExtra : 0) : SHEET.bareTop);

  /* pack every section onto pages at density d. A team that does not fit
     the room left on a page is split: as many of its characters as fit
     stay, the rest open the next page under a repeated label. */
  const pack = (d, single) => {
    const pages = [];
    let page = { sections: [], used: 0, index: 0 };
    // sections are measured in layout em and drawn at `d` of that, so a
    // page holds availFor / d of them
    const avail = () => availFor(page.index) / d;
    const gapEm = SHEET.sectionGap;
    const pushSection = (team, chars, cont, total) => {
      const shift = (!layoutEven && page.index === 0 && page.sections.length === 0 && pageHasHeader(0)) ? 1 : 0;
      const m = measureSection(chars, d, shift);
      page.sections.push({ team, chars, cont, total, ...m });
      page.used += m.need + (page.sections.length > 1 ? gapEm : 0);
    };
    const newPage = () => { pages.push(page); page = { sections: [], used: 0, index: pages.length }; };
    for (const g of groups) {
      let chars = g.characters;
      let cont = false;
      while (chars.length) {
        const gap = page.sections.length ? gapEm : 0;
        const room = avail() - page.used - gap;
        const shift = (!layoutEven && page.index === 0 && page.sections.length === 0 && pageHasHeader(0)) ? 1 : 0;
        const whole = measureSection(chars, d, shift).need;
        if (single || whole <= room + 0.001) {
          pushSection(g.team, chars, cont, g.characters.length);
          chars = [];
          break;
        }
        // split: the largest prefix that fits the room left
        let n = 0;
        if (room > avail() * 0.22 || page.sections.length === 0) {
          for (let k = chars.length - 1; k >= 1; k--) {
            if (measureSection(chars.slice(0, k), d, shift).need <= room + 0.001) { n = k; break; }
          }
        }
        if (n === 0) {
          if (page.sections.length === 0) {
            // a single team taller than an empty page: force the biggest
            // prefix that fits, or one character, so we always make progress
            for (let k = chars.length - 1; k >= 1; k--) {
              if (measureSection(chars.slice(0, k), d, shift).need <= room + 0.001) { n = k; break; }
            }
            if (n === 0) n = 1;
          } else {
            newPage();
            continue;
          }
        }
        pushSection(g.team, chars.slice(0, n), cont, g.characters.length);
        chars = chars.slice(n);
        cont = true;
        newPage();
      }
    }
    if (page.sections.length || !pages.length) pages.push(page);
    return pages;
  };

  // ── solve the density ──
  const totalNeedAt = (d) => {
    let need = 0;
    groups.forEach((g, i) => {
      need += measureSection(g.characters, d, (!layoutEven && i === 0 && pageHasHeader(0)) ? 1 : 0).need;
    });
    return need + Math.max(0, groups.length - 1) * SHEET.sectionGap;
  };

  let d = options.fitToContent ? 1 : clamp(Number(options.density) || 1, 0.3, 2);
  let pages;
  const minFit = clamp(Number(options.minFit) || 0.62, 0.3, 1);
  if (options.fitToContent) {
    // single-page fit first, as the original tool did
    let fit = 1;
    for (let iter = 0; iter < 3; iter++) {
      const neededEm = totalNeedAt(fit);
      const f = clamp(availFor(0) / neededEm, 0.42, 1.55);
      if (Math.abs(f - fit) < 0.002) { fit = f; break; }
      fit = f;
    }
    if (fit >= minFit || !options.paginate || groups.length === 0) {
      d = fit;
      pages = pack(d, true);
    } else {
      // continue onto more sheets: pack at 1, then relax the density so the
      // pages fill evenly (never above 1 — the reference pitch is the cap)
      d = 1;
      pages = pack(d, false);
      // if one sheet fewer would hold it at a density still above minFit,
      // take that: a last sheet carrying three characters is a waste of
      // paper and reads as a mistake. The density is solved for the smaller
      // page count (rows wrap more as they shrink, so it iterates), then
      // stepped down a little at a time to cover the space the splits waste
      for (let iter = 0; iter < 4 && pages.length > 1; iter++) {
        const n = pages.length - 1;
        let avail = 0;
        for (let i = 0; i < n; i++) avail += availFor(i);
        let d2 = d;
        for (let k = 0; k < 3; k++) d2 = clamp(avail / (totalNeedAt(d2) + (n - 1) * SHEET.sectionGap * 0.5), minFit, 1);
        let found = null;
        for (let tries = 0; tries < 8 && d2 >= minFit - 1e-9; tries++, d2 -= 0.025) {
          const p2 = pack(d2, false);
          if (p2.length <= n) { found = { d: d2, pages: p2 }; break; }
        }
        if (!found) break;
        d = found.d;
        pages = found.pages;
      }
    }
  } else {
    pages = pack(d, !options.paginate);
  }

  const ed = (em) => em * U * d; // density-scaled px
  const iconEm = iconEmFor(d);

  // deal a section's leftover height evenly between one column's rows
  const dealEven = (needs, needEm) => {
    if (!needs.length) return [];
    const per = (needEm - sum(needs)) / needs.length;
    return needs.map((n) => n + per);
  };

  pages.forEach((page) => {
    let cursorPx = topFor(page.index) * U;
    page.header = pageHasHeader(page.index);
    page.topEm = topFor(page.index);
    page.sections.forEach((m, i) => {
      const topPx = cursorPx;
      const heightPx = ed(m.need);
      cursorPx += heightPx + ed(SHEET.sectionGap);
      m.topPx = topPx;
      m.heightPx = heightPx;
      m.leftHeights = layoutEven ? dealEven(m.leftNeeds, m.need) : m.rowHeights;
      m.rightHeights = layoutEven
        ? dealEven(m.rightNeeds, m.need)
        : m.rowHeights.slice(m.shift ? 1 : 0);
      m.rightTopPx = (!layoutEven && m.shift) ? topPx + ed(m.rowHeights[0] || 0) : topPx;
      m.first = i === 0;
    });
  });

  return { pages, d, iconEm, layoutEven, fonts, groups, widthMul };
}

/* ── one page ─────────────────────────────────────────────────────────── */
export function renderSheetPage(script, options, layout, pageIndex, ctx) {
  ctx = ctx || {};
  const requestRender = ctx.requestRender;
  const selected = ctx.selected || '';
  const page = layout.pages[Math.min(pageIndex, layout.pages.length - 1)];
  const { d, iconEm, fonts } = layout;
  const ed = (em) => em * U * d; // density-scaled px
  const e = (em) => em * U; // fixed px
  const isLastPage = pageIndex === layout.pages.length - 1;

  const title = (options.titleOverride || '').trim() || script.meta.name;
  const author = ((options.authorOverride || '').trim() || script.meta.author || '').trim();
  const hasNightStar = script.characters.some((c) => c.ability.includes('night*'));
  const widthMul = layout.widthMul || options.columnWidth || 1;
  const colWPct = SHEET.textOffsetX + SHEET.textWidth * widthMul;

  const sheet = pageFrame(SHEET_W, SHEET_H, U, 'script-sheet');
  sheet.dataset.fsPage = String(pageIndex);
  // the density auto-fit actually solved for — the page reads this to show
  // it on the (always live) density slider
  sheet.dataset.fsDensity = d.toFixed(3);

  const mark = (node, id) => {
    node.dataset.fsDrag = id;
    if (id === selected) markSelected(node);
    return node;
  };

  // background: the baked parchment (texture + garland), or what was chosen
  for (const n of renderBackground(options.bg, 'front')) sheet.append(n);

  /* ── the ribbon ──
     The ribbon art is FULL-BLEED: it spans from the sheet's left edge to
     the strip's right edge (sidebarX + sidebarW) over the full height. It
     used to be drawn inset at sidebarX/sidebarY like the handoff, which
     left the parchment's black frame showing as a bare gap along the top,
     left and bottom — invisible against the navy art, glaring the moment
     the ribbon was recoloured. sidebarX/sidebarW still position the LABELS.

     The art is FLAT damask, and the parchment frame's shading is a
     SEPARATE overlay (sidebar-shade.png: black, alpha = 1 - the parchment
     column's normalized luminance) drawn over it at `sidebarShade`. Baking
     that shading into the ribbon put a hard left-to-right lightness ramp
     through it — barely readable in navy, an obvious band in any other
     colour — so the default is 0 (a solid, even ribbon) and the slider
     dials the old blend back in; at 1 it reproduces the baked composite
     exactly, because opacity over black IS the multiply that baked it. */
  const sbT = elGet(options, 'sidebar');
  const sidebarStyle = {
    position: 'absolute',
    left: '0',
    top: '0',
    width: (SHEET.sidebarX + SHEET.sidebarW) + '%',
    height: '100%',
  };
  const sidebarMode = options.sidebarMode || 'damask';
  if (sidebarMode !== 'none' && !sbT.hidden) {
    const customArt = resolveSrc(sbT.src);
    if (customArt) {
      sheet.append(img(customArt, { ...sidebarStyle, objectFit: 'cover', opacity: String(sbT.opacity) }));
    } else if (sidebarMode === 'flat') {
      sheet.append(el('div', { ...sidebarStyle, background: options.sidebarColor || SIDEBAR_BASE.hex, opacity: String(sbT.opacity) }));
    } else {
      const wantsTint = options.sidebarColor &&
        options.sidebarColor.toLowerCase() !== SIDEBAR_BASE.hex && hexHsl(options.sidebarColor);
      const tinted = wantsTint ? sidebarTintCanvas(options.sidebarColor, requestRender) : null;
      if (tinted) {
        // the singleton canvas is adopted by each new sheet; the old sheet is
        // already detached, so moving it is safe. An export render that runs
        // while the preview is up gets a COPY, so the preview keeps its ribbon.
        let node = tinted;
        if (tinted.parentNode && ctx.forExport) {
          node = document.createElement('canvas');
          node.width = tinted.width; node.height = tinted.height;
          node.getContext('2d').drawImage(tinted, 0, 0);
        }
        Object.assign(node.style, sidebarStyle, { opacity: String(sbT.opacity) });
        sheet.append(node);
      } else {
        sheet.append(img(ART + 'sidebar-flat.png', { ...sidebarStyle, opacity: String(sbT.opacity) }));
      }
    }
    // only fetched when it is actually asked for — it is a 1.6 MB overlay
    const shadeAmt = clamp(Number(options.sidebarShade) || 0, 0, 1);
    if (shadeAmt > 0 && sidebarMode === 'damask') {
      sheet.append(img(ART + 'sidebar-shade.png',
        { ...sidebarStyle, opacity: String(shadeAmt) }));
    }
  }

  /* ── header band ── */
  if (page.header) {
    const skT = elGet(options, 'skull');
    const flLT = elGet(options, 'fll');
    const flRT = elGet(options, 'flr');
    const tT = elGet(options, 'title');
    const aT = elGet(options, 'author');
    /* header decor geometry (movable / scalable). Verticals are settled
       here; the HORIZONTAL positions set below are only the calibrated
       full-width fallback — fitTitle() re-places the skull and flourishes
       against the title's measured width so they come in to meet a short
       name (see the hug pass there). */
    const skullW = SHEET.skullW * skT.scale;
    const skullLeft = SHEET.skullX + (SHEET.skullW - skullW) / 2 + skT.dx;
    const skullTop = SHEET.skullY + (SHEET.skullH * (1 - skT.scale)) / 2 + skT.dy;
    const flLW = SHEET.flLW * flLT.scale;
    const flLLeft = SHEET.flLX + SHEET.flLW - flLW + flLT.dx;
    const flLTop = SHEET.flLY + (SHEET.flLH * (1 - flLT.scale)) / 2 + flLT.dy;
    const flRW = SHEET.flRW * flRT.scale;
    const flRLeft = SHEET.flRX + flRT.dx;
    const flRTop = SHEET.flRY + (SHEET.flRH * (1 - flRT.scale)) / 2 + flRT.dy;

    if (options.showSkull && !skT.hidden) {
      const skullEl = img(resolveSrc(skT.src) || ART + 'skull.png', {
        position: 'absolute', left: skullLeft + '%', top: px(e(skullTop)), width: skullW + '%',
        opacity: String(skT.opacity), transform: skT.rot ? `rotate(${skT.rot}deg)` : '',
      });
      skullEl.dataset.fsDecor = 'skull';
      if (resolveSrc(skT.src)) skullEl.crossOrigin = 'anonymous';
      sheet.append(mark(skullEl, 'el:skull'));
    }
    if (options.showFlourishes) {
      if (!flLT.hidden) {
        const flLEl = img(resolveSrc(flLT.src) || ART + 'flourish-left.png', {
          position: 'absolute', left: flLLeft + '%', top: px(e(flLTop)), width: flLW + '%',
          opacity: String(flLT.opacity), transform: flLT.rot ? `rotate(${flLT.rot}deg)` : '',
        });
        flLEl.dataset.fsDecor = 'fll';
        sheet.append(mark(flLEl, 'el:fll'));
      }
      if (!flRT.hidden) {
        const flREl = img(resolveSrc(flRT.src) || ART + 'flourish-right.png', {
          position: 'absolute', left: flRLeft + '%', top: px(e(flRTop)), width: flRW + '%',
          opacity: String(flRT.opacity), transform: flRT.rot ? `rotate(${flRT.rot}deg)` : '',
        });
        flREl.dataset.fsDecor = 'flr';
        sheet.append(mark(flREl, 'el:flr'));
      }
    }

    // title: an uploaded title image, else the script's logo when provided,
    // else the swash text title
    if (!tT.hidden) {
      const titleArt = resolveSrc(tT.src) || (script.meta.logo && options.useLogo ? proxied(script.meta.logo, options.proxyIcons) : '');
      if (titleArt) {
        const logoEl = iconImg(titleArt, {
          position: 'absolute',
          left: (SHEET.titleCX + tT.dx) + '%',
          top: px(e(SHEET.titleCY + tT.dy)),
          transform: `translate(-50%, -50%)${tT.rot ? ` rotate(${tT.rot}deg)` : ''}`,
          maxWidth: px(0.4911 * SHEET_W * tT.scale),
          maxHeight: px(e(9.4) * tT.scale),
          objectFit: 'contain',
          opacity: String(tT.opacity),
          filter: `drop-shadow(${e(0.09)}px ${e(0.13)}px ${e(0.11)}px rgba(40, 26, 10, 0.45))`,
        }, title);
        logoEl.dataset.fsTbox = '1';
        // the logo's width is only known once it loads — re-hug the decor then
        logoEl.addEventListener('load', () => fitTitle(sheet, options));
        sheet.append(mark(logoEl, 'el:title'));
      } else {
        const titleEl = el('div', {
          position: 'absolute',
          left: (SHEET.titleCX + tT.dx) + '%',
          top: px(e(SHEET.titleCY + tT.dy)),
          transform: `translate(-50%, -50%)${tT.rot ? ` rotate(${tT.rot}deg)` : ''}`,
          fontFamily: fonts.title,
          fontSize: px(e(8.35) * tT.scale),
          lineHeight: '1',
          whiteSpace: 'nowrap',
          wordSpacing: (options.fontTitle || 'unlovable') === 'unlovable' ? '-0.21em' : '0',
          opacity: String(tT.opacity),
          mixBlendMode: 'multiply',
        }, swashTitle(title, options, e(0.11), e(0.13)));
        titleEl.dataset.fsTitle = String(e(8.35) * tT.scale);
        titleEl.dataset.fsTbox = '1';
        sheet.append(mark(titleEl, 'el:title'));
      }
    }

    // author credit, hand-set beneath the title
    if (options.showAuthor && author && !aT.hidden) {
      const authorEl = el('div', {
        position: 'absolute',
        left: (SHEET.titleCX + tT.dx + aT.dx) + '%',
        top: px(e(10.8 + tT.dy + aT.dy)),
        transform: `translate(-50%, -50%)${aT.rot ? ` rotate(${aT.rot}deg)` : ''}`,
        fontFamily: fonts.author,
        fontStyle: 'italic',
        fontSize: px(e(1.42) * aT.scale),
        letterSpacing: '0.05em',
        color: options.authorColor || '#5a4632',
        opacity: String(aT.opacity),
        mixBlendMode: 'multiply',
        whiteSpace: 'nowrap',
      }, (options.authorPrefix == null ? 'by ' : options.authorPrefix) + smartTypography(author));
      sheet.append(mark(authorEl, 'el:author'));
    }
  }

  /* ── team sections ── */
  const cT = elGet(options, 'content');
  const c1T = elGet(options, 'col1');
  const c2T = elGet(options, 'col2');
  const lT = elGet(options, 'labels');
  const dvT = elGet(options, 'dividers');
  const contentWrap = el('div', {
    position: 'absolute', inset: '0',
    opacity: String(cT.opacity),
    display: cT.hidden ? 'none' : 'block',
  });
  applyEl(contentWrap, { ...cT, opacity: 1, hidden: false, scale: 1 }, '', U, SHEET_W);
  if (cT.scale !== 1) {
    contentWrap.style.transformOrigin = '50% 0';
    contentWrap.style.transform = (contentWrap.style.transform || '') + ` scale(${cT.scale})`;
  }
  mark(contentWrap, 'el:content');
  contentWrap.style.pointerEvents = 'none'; // only the rows themselves grab the pointer

  page.sections.forEach((sec, si) => {
    const { team, chars, left, right, leftHeights, rightHeights, rightTopPx, topPx, heightPx } = sec;
    const wrap = el('div');

    // divider above every section except the first, plus the cap on the
    // ribbon. divider-taper.png is drawn to the official sheet's shape —
    // a hairline with a small knot where it meets the ribbon, near-constant
    // thickness, fading to fully transparent by the right end (the old
    // spindle art was thin at both ends and fat in the middle, which is
    // not how the print rules them). One multiply pass; the colour and the
    // fade are baked into the art's alpha.
    if (si > 0 && options.showDividers && !dvT.hidden) {
      const divH = 0.5 * dvT.scale;
      const divTop = topPx - ed(SHEET.sectionGap) + ed(0.7962 - divH / 2) + e(dvT.dy);
      const op = String(clamp((options.dividerOpacity == null ? 1 : options.dividerOpacity) * dvT.opacity, 0, 1));
      wrap.append(img(resolveSrc(dvT.src) || ART + 'divider-taper.png', {
        position: 'absolute', left: (8.3 + dvT.dx) + '%', top: px(divTop),
        width: '89.35%', height: px(ed(divH)),
        objectFit: 'fill', mixBlendMode: 'multiply', opacity: op,
      }));
      wrap.append(img(ART + 'divider-cap.png', {
        position: 'absolute', left: (2.337 + dvT.dx) + '%', top: px(divTop),
        width: '6.26%', height: px(ed(divH * 0.56)),
        objectFit: 'fill', opacity: op,
        marginTop: px(ed(divH * 0.22)),
      }));
    }

    // sidebar label, centred on the section span including the trailing gap
    // (last section: down to 87.5 em); singular when the section holds one
    if (options.showLabels && !lT.hidden) {
      const custom = (options.teamLabels && options.teamLabels[team] || '').trim();
      const label = (custom || (sec.total === 1
        ? TEAM_LABELS_SINGULAR[team]
        : TEAM_LABELS[team])).toUpperCase() + (options.labelCounts ? ' · ' + sec.total : '');
      const baseFs = e(SHEET.labelSize) * (options.labelSize || 1) * lT.scale;
      const isLast = si === page.sections.length - 1;
      /* The band a label is centred on and shrinks to fit: its own section
         plus the trailing gap. The LAST section owns the ribbon on down to
         the garland — but only ever as a BONUS. Taking that run as the band
         outright measured it from a fixed bottom (87.5 em) against a top
         that moves with the density, so the last label shrank as the sheet
         filled and the span went NEGATIVE once the rows reached past 87.5
         em (any density above the auto fit) — flooring the last label at
         the minimum whatever it said. It is positional, not a long-word
         problem: a five-letter LORIC collapsed exactly like TRAVELLERS did. */
      const ownH = heightPx + ed(SHEET.sectionGap);
      const spanH = isLast ? Math.max(ownH, 87.5 * U - topPx) : ownH;
      // upright vertical letters advance ≈ font-size (Chromium ignores
      // line-height in vertical-rl/upright) — shrink-to-fit uses 0.85/letter
      const fitFs = (spanH - e(0.2)) / (label.length * 0.85);
      const labelEl = el('div', {
        position: 'absolute',
        left: (SHEET.sidebarX + SHEET.sidebarW / 2 + 0.3 + lT.dx) + '%',
        top: px(topPx + spanH / 2 + e(lT.dy)),
        transform: 'translate(-50%, -50%)',
        writingMode: 'vertical-rl',
        textOrientation: 'upright',
        fontFamily: fonts.label,
        fontSize: px(clamp(fitFs, e(SHEET.labelSizeMin), baseFs)),
        lineHeight: '1',
        letterSpacing: (options.labelSpacing == null ? -0.15 : options.labelSpacing) + 'em',
        color: options.labelColor || '#eeeeee',
        opacity: String(lT.opacity),
        filter:
          'drop-shadow(0.6px 0.6px 1.8px rgba(34,34,34,0.66)) drop-shadow(-0.6px 0.6px 1.8px rgba(34,34,34,0.53)) drop-shadow(0.6px -0.6px 1.8px rgba(34,34,34,0.66)) drop-shadow(-0.6px -0.6px 1.8px rgba(34,34,34,0.66))',
        whiteSpace: 'nowrap',
      }, label);
      wrap.append(labelEl);
    }

    // columns
    const colL = el('div', {
      position: 'absolute',
      left: (SHEET.col1IconX + c1T.dx) + '%',
      top: px(topPx + e(c1T.dy)),
      width: colWPct + '%',
      opacity: String(c1T.opacity),
      display: c1T.hidden ? 'none' : 'block',
      pointerEvents: 'auto',
    });
    left.forEach((c, i) => colL.append(
      characterEntry(c, options, leftHeights[i], iconEm, ed, e, fonts, widthMul),
    ));
    wrap.append(colL);

    // rightTopPx: same as topPx, except the classic layout's first section,
    // where the title takes the second column's first row slot
    const colR = el('div', {
      position: 'absolute',
      left: (SHEET.col2IconX + c2T.dx) + '%',
      top: px(rightTopPx + e(c2T.dy)),
      width: colWPct + '%',
      opacity: String(c2T.opacity),
      display: c2T.hidden ? 'none' : 'block',
      pointerEvents: 'auto',
    });
    right.forEach((c, i) => colR.append(
      characterEntry(c, options, rightHeights[i], iconEm, ed, e, fonts, widthMul),
    ));
    wrap.append(colR);

    contentWrap.append(wrap);
  });
  sheet.append(contentWrap);

  // "*Not the first night" footnote inside the garland circle
  const fT = elGet(options, 'footnote');
  if (options.showFootnote && (hasNightStar || (options.footnoteText || '').trim()) &&
      !fT.hidden && (isLastPage || options.footnoteEveryPage)) {
    const custom = (options.footnoteText || '').trim();
    const star = el('span', {
      display: 'inline-block',
      width: px(e(0.819)),
      height: '0',
      lineHeight: '0',
      verticalAlign: 'baseline',
      position: 'relative',
      overflow: 'visible',
    }, img(ART + 'asterisk.png', {
      position: 'absolute',
      left: '0',
      bottom: px(e(0.428)),
      height: px(e(0.705)),
      width: px(e(0.743)),
    }, '*'));
    const foot = el('div', {
      position: 'absolute',
      left: (SHEET.footnoteCX + fT.dx) + '%',
      top: px(e(SHEET.footnoteTop + fT.dy)),
      transform: `translateX(-50%)${fT.rot ? ` rotate(${fT.rot}deg)` : ''}${fT.scale !== 1 ? ` scale(${fT.scale})` : ''}`,
      transformOrigin: '50% 0',
      textAlign: 'center',
      fontFamily: fonts.footnote,
      color: options.footnoteColor || '#786254',
      opacity: String(fT.opacity),
      mixBlendMode: 'multiply',
      fontSize: px(e(1.1964)),
      lineHeight: px(e(SHEET.footnoteLine)),
      whiteSpace: 'nowrap',
    });
    if (custom) {
      const lines = custom.split('\n');
      lines.forEach((ln, i) => {
        const withStar = i === 0 && ln.startsWith('*');
        foot.append(el('div', null, withStar ? star : null, withStar ? ln.slice(1) : ln));
      });
    } else {
      foot.append(el('div', null, star, 'Not the'), el('div', null, 'first night'));
    }
    sheet.append(mark(foot, 'el:footnote'));
  }

  // page number, when the script runs to more than one sheet
  const pT = elGet(options, 'pageno');
  if (layout.pages.length > 1 && options.showPageNumbers && !pT.hidden) {
    const pn = el('div', {
      position: 'absolute',
      right: (3.0 - pT.dx) + '%',
      top: px(e(96.2 + pT.dy)),
      fontFamily: fonts.author,
      fontStyle: 'italic',
      fontSize: px(e(1.05) * pT.scale),
      color: options.footnoteColor || '#786254',
      opacity: String(pT.opacity),
      mixBlendMode: 'multiply',
      whiteSpace: 'nowrap',
    }, (pageIndex + 1) + ' / ' + layout.pages.length);
    sheet.append(mark(pn, 'el:pageno'));
  }

  // stickers last, over everything (an image marked `behind` sits under
  // the content via z-index — the content wrap has none)
  for (const n of renderStickers(ctx.stickers, selected)) sheet.append(n);

  return sheet;
}

/* convenience: layout + first page, for callers that only want one sheet */
export function renderSheet(script, options, requestRender, ctx) {
  const layout = layoutSheet(script, options, requestRender);
  return renderSheetPage(script, options, layout, (ctx && ctx.pageIndex) || 0, { ...(ctx || {}), requestRender });
}

/* Two jobs that both need real layout, so the caller runs this AFTER the
   sheet is in the document (and again when the logo image loads):

   1. Shrink the swash title to the band between the skull and the right
      flourish — scrollWidth at the natural size gives the true width in
      one pass, no iteration.

   2. THE HUG PASS: slide the skull (with the left flourish riding along)
      and the right flourish in against the title's measured width, the way
      the official sheets set them — a short name like "Biota" pulls the
      decor in to meet it instead of leaving it stranded at the calibrated
      full-width positions. The three inset constants below are derived
      from the calibration itself (skull overlaps the title box's left
      bearing by 1.49%, the left flourish tucks 1.24% under the skull, the
      right flourish starts 0.58% inside the title box), so a title at the
      full band width reproduces the reference positions exactly. Switched
      off by options.hugDecor, every piece stays at its calibrated place
      (plus whatever it was dragged by). */
export function fitTitle(sheet, options) {
  const titleEl = sheet.querySelector('[data-fs-title]');
  if (titleEl) {
    const naturalFs = Number(titleEl.dataset.fsTitle);
    const bandW = 0.4911 * SHEET_W; // reference title ink width (skull → right swirl)
    titleEl.style.fontSize = px(naturalFs);
    const trueW = titleEl.scrollWidth;
    if (trueW > bandW) titleEl.style.fontSize = px(naturalFs * (bandW / trueW));
  }
  if (!options || options.hugDecor === false) return;

  const tbox = sheet.querySelector('[data-fs-tbox]');
  const skullEl = sheet.querySelector('[data-fs-decor="skull"]');
  const flLEl = sheet.querySelector('[data-fs-decor="fll"]');
  const flREl = sheet.querySelector('[data-fs-decor="flr"]');
  if (!tbox) return;
  const sheetRect = sheet.getBoundingClientRect();
  const tRect = tbox.getBoundingClientRect();
  if (!sheetRect.width || !tRect.width) return; // logo not loaded yet
  const tT = elGet(options, 'title');
  const skT = elGet(options, 'skull');
  const flLT = elGet(options, 'fll');
  const flRT = elGet(options, 'flr');
  // rects survive the preview's scale transform because both are scaled alike
  const wPct = (tRect.width / sheetRect.width) * 100;
  const centerPct = SHEET.titleCX + tT.dx;
  const leftPct = centerPct - wPct / 2;
  const rightPct = centerPct + wPct / 2;

  const skullW = SHEET.skullW * skT.scale;
  const flLW = SHEET.flLW * flLT.scale;
  const flRW = SHEET.flRW * flRT.scale;
  // never ride onto the ribbon, however long the name gets
  const skullLeft = Math.max(9.2, leftPct + 1.49 - skullW + skT.dx);
  const flLLeft = skullLeft - skT.dx + 1.24 - flLW + flLT.dx;
  const flRLeft = Math.min(97.65 - flRW, rightPct - 0.58 + flRT.dx);
  if (skullEl) skullEl.style.left = skullLeft + '%';
  if (flLEl) flLEl.style.left = flLLeft + '%';
  if (flREl) flREl.style.left = flRLeft + '%';
}
