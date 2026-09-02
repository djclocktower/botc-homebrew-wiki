/* Fancy Scripts — the teensy sheet.
 *
 * The owner's "No Greater Joy" PSD as a live template: a 1500×2100 (5:7)
 * parchment with engraved clockwork, purple ribbons down both edges carrying
 * the night order as icon strips (moon, one icon per waking character, sun),
 * watercolour berries in the corners, the title stacked in LHF Unlovable
 * with a purple gradient and a hard drop shadow, a clock (or the script's
 * logo) beside it, OptimusPrinceps team headings ruled across to the right
 * ribbon, and the characters in a grid that gets coarser as the teams get
 * smaller — three columns of townsfolk, two of outsiders and minions, one
 * big row for the demon. Every coordinate is in script.js's TEENSY table,
 * measured off the PSD in its own pixels: this sheet is built at the PSD's
 * size, so the numbers can be checked against the file directly.
 *
 * The grid's density is solved the same way sheet.js does it (rows measured
 * with the real fonts, scaled to fill the page — never past the template's
 * own sizes), the ribbons are recoloured through tint.js, and the icon-ink
 * normalization is sheet.js's. Everything is inline-styled: the element is
 * what the export captures. Browser-only — do not import from the Worker.
 */

import {
  TEENSY, TEENSY_RIBBON_BASE, TEAM_LABELS, TEAM_LABELS_SINGULAR,
  groupByTeam, backTeams, proxied, smartTypography, nightLists,
  playersText, bootleggerRules,
} from './script.js';
import { tintedCanvas, wantsTint, hexHsl, hslHex } from './tint.js';
import {
  el, img, iconImg, px, clamp, lineCount, measureWidth, abilityNodes,
  bootleggerBox, nightColumn, nightColumnHeight, fitNightSizes, fontsFor,
} from './panels.js';
import { iconFit, normalizeIcons, inkTransform } from './sheet.js';

const ART = '/assets/fancyscripts/art/';
const T = TEENSY;
const F = fontsFor('teensy');

/* the heading colours: townsfolk and demon are the picked good/evil inks;
   outsiders and minions are the same hues darkened the way the PSD did
   (#0064ac → #0a3e64, #d00000 → #640a0a) */
function headingColor(team, options) {
  const good = hexHsl(options.goodColor) || { h: 205, s: 1, l: 0.34 };
  const evil = hexHsl(options.evilColor) || { h: 0, s: 1, l: 0.41 };
  switch (team) {
    case 'townsfolk': return options.goodColor;
    case 'outsider': return hslHex(good.h, good.s * 0.85, good.l * 0.65);
    case 'minion': return hslHex(evil.h, evil.s * 0.82, evil.l * 0.55);
    case 'demon': return options.evilColor;
    case 'traveller': return '#5b3a1a';
    case 'fabled': return '#8a6d1f';
    default: return '#3e5a2a';
  }
}

/* columns per team: the PSD's 3 / 2 / 1, widened for bigger rosters */
function colsFor(team, n, options) {
  if (team === 'townsfolk') {
    const forced = Number(options.townsfolkCols) || 0;
    if (forced >= 2 && forced <= 4) return forced;
    return n >= 10 ? 4 : 3;
  }
  if (team === 'demon') return n === 1 ? 1 : n <= 4 ? 2 : 3;
  return n <= 4 ? 2 : 3;
}

/* the title stack: one word to a line, each sized to the band, overlapping
   like the PSD (NO / Greater / JOY). Returns [{text, size, top, cx}] with
   `top` relative to the stack's own top, and the stack height. */
function titleStack(title, maxW, maxH, baseSize, capsShort) {
  const words = String(title || '').trim().split(/\s+/).filter(Boolean).slice(0, 6);
  if (!words.length) words.push('Untitled');
  const fontOf = (size) => `400 ${size}px ${F.title}`;
  const widthOf = (w, size) => {
    const m = measureWidth(w, fontOf(size));
    return m > 0 ? m * 0.98 : 0.43 * size * Math.max(2, w.length);
  };
  const rows = words.map((w, i) => {
    let text = w;
    const edge = i === 0 || i === words.length - 1;
    if (capsShort && words.length > 1 && edge && w.length <= 3 && /^[a-z]+$/i.test(w)) text = w.toUpperCase();
    let size = baseSize;
    // the PSD sets a short opening word smaller (NO before Greater / JOY)
    if (words.length > 1 && i === 0 && w.length <= 3) size *= 0.8;
    const wid = widthOf(text, size);
    if (wid > maxW) size *= maxW / wid;
    return { text, size };
  });
  const pitch = T.title.pitch + 0.12; // ascender-to-ascender, LHF's swashes overlap
  let total = rows.reduce((n, r) => n + r.size * pitch, 0) + rows[rows.length - 1].size * 0.42;
  if (total > maxH) {
    const k = maxH / total;
    rows.forEach((r) => { r.size *= k; });
    total = maxH;
  }
  const stagger = [-18, 0, 16, -10, 8, 0];
  let y = 0;
  rows.forEach((r, i) => {
    r.top = y;
    r.dx = rows.length > 1 ? stagger[i % stagger.length] : 0;
    y += r.size * pitch;
  });
  return { rows, height: total };
}

/* the gradient title word: PSD gradient overlay "reflected", light purple at
   the centre falling to dark at both ends along -67°, plus a 4 px black
   drop shadow. Built from the picked title colour. */
function titleWord(text, size, color) {
  const c = hexHsl(color) || { h: 277, s: 0.72, l: 0.53 };
  const dark = hslHex(c.h, c.s * 0.62, c.l * 0.42);
  const w = el('div', {
    fontFamily: F.title,
    fontSize: px(size),
    lineHeight: '1',
    whiteSpace: 'nowrap',
    letterSpacing: '-0.015em',
    backgroundImage: `linear-gradient(157deg, ${dark} 0%, ${color} 50%, ${dark} 100%)`,
    webkitBackgroundClip: 'text',
    backgroundClip: 'text',
    color: 'transparent',
    filter: 'drop-shadow(0 4px 2px rgba(0,0,0,0.95))',
    padding: '0 0.35em',
    margin: '0 -0.35em',
  }, text);
  w.style.setProperty('-webkit-background-clip', 'text');
  return w;
}

/* one character in a `cols`-column team grid */
function entry(char, g, colW, rowH, d, options, iconEm) {
  const iconPx = g.icon * d * iconEm;
  const namePx = g.name * d * options.nameSize;
  const abilityPx = g.ability * d * options.textSize;
  const textLeft = g.textLeft * d;
  const textW = colW - textLeft - g.textRight * d;
  const lines = lineCount(smartTypography(char.ability), F.ability, abilityPx, textW);
  const blockH = namePx * 1.1 + lines * abilityPx * T.abilityLine;
  const fit = iconFit(char.icon);
  const row = el('div', { position: 'absolute', width: px(colW), height: px(rowH) });
  row.append(iconImg(char.icon, {
    position: 'absolute',
    left: px(g.iconLeft * d),
    top: px((rowH - iconPx) / 2),
    width: px(iconPx),
    height: px(iconPx),
    objectFit: 'contain',
    transform: inkTransform(fit),
    transformOrigin: 'center',
    filter: `drop-shadow(${px(d)} ${px(2 * d)} ${px(3 * d)} rgba(32, 20, 8, 0.45))`,
  }, char.name));
  const text = el('div', {
    position: 'absolute',
    left: px(textLeft),
    top: px(Math.max(0, (rowH - blockH) / 2)),
    width: px(textW),
    textAlign: 'center',
  });
  text.append(el('div', {
    fontFamily: F.name,
    fontSize: px(namePx),
    lineHeight: '1.1',
    color: '#111111',
    textAlign: 'left',
    whiteSpace: 'nowrap',
    letterSpacing: '0.005em',
  }, smartTypography(char.name)));
  text.append(el('div', {
    fontFamily: F.ability,
    fontSize: px(abilityPx),
    lineHeight: String(T.abilityLine),
    color: '#111111',
  }, ...abilityNodes(char.ability, false)));
  row.append(text);
  return row;
}

/* ── the sheet ─────────────────────────────────────────────────────────
   renderTeensy(script, options, requestRender, ui) → the .script-sheet
   element (1500×2100). `ui` carries the in-place bootlegger editing hooks
   for the live preview; the export passes nothing. */
export function renderTeensy(script, options, requestRender, ui) {
  const W = T.w, H = T.h;
  const groups = groupByTeam(script.characters, options.sortMode, backTeams(options));
  const { iconSize, textSize, nameSize } = options;
  ui = ui || {};

  const urls = new Set();
  script.characters.forEach((c) => urls.add(c.icon));
  normalizeIcons([...urls], requestRender);

  const title = options.titleOverride.trim() || script.meta.name;
  const author = (options.authorOverride.trim() || script.meta.author || '').trim();
  const showAuthor = options.showAuthor && !!author;
  const hasLogo = !!(script.meta.logo && options.useLogo);
  const rules = options.bootleggerBox ? bootleggerRules(script, options) : null;
  // the bootlegger box takes the clock's slot: the clock is decoration,
  // the rules are content. With a logo it goes to the corner instead.
  const bootInSlot = !!rules && !hasLogo;
  const showClock = options.clockArt && !hasLogo && !bootInSlot;
  const somethingRight = hasLogo || showClock || bootInSlot;

  /* ── measure the grid ── */
  const sections = groups.map((g) => {
    const cols = colsFor(g.team, g.characters.length, options);
    return { g, cols, geo: T.grid[cols], rows: Math.ceil(g.characters.length / cols) };
  });
  const contentW = T.contentRight - T.contentLeft;
  const rowHeights = (s, d) => {
    const geo = s.geo;
    const colW = contentW / s.cols;
    const iconPx = geo.icon * d * iconSize;
    const namePx = geo.name * d * nameSize;
    const abilityPx = geo.ability * d * textSize;
    const textW = colW - geo.textLeft * d - geo.textRight * d;
    const out = [];
    for (let r = 0; r < s.rows; r++) {
      // the row is the text block's pitch; a tall icon reaches past it into
      // the gaps like the PSD's, but never past the icon's own box + a hair
      let need = Math.max(geo.row * d, iconPx * 0.9);
      for (let c = 0; c < s.cols; c++) {
        const ch = s.g.characters[r * s.cols + c];
        if (!ch) continue;
        const lines = lineCount(smartTypography(ch.ability), F.ability, abilityPx, textW);
        need = Math.max(need, namePx * 1.1 + lines * abilityPx * T.abilityLine + 14 * d);
      }
      out.push(need);
    }
    return out;
  };
  // the gap in FRONT of a section and the run from its heading's top to
  // its first row — the demon's differ (a full rule, heading centred on it)
  const gapBefore = (s, d) => (s.g.team === 'demon' ? T.demonGap : T.sectionGap) * d;
  const rowsFrom = (s, d) => (s.g.team === 'demon' ? T.demonRowsFrom : T.rowsFrom) * d;
  const measure = (d) => sections.map((s) => {
    const heights = rowHeights(s, d);
    return { heights, need: rowsFrom(s, d) + heights.reduce((a, b) => a + b, 0) };
  });
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const totalAt = (m, d) => sum(m.map((x) => x.need)) + sum(sections.slice(1).map((s) => gapBefore(s, d)));

  // the author line (and the players line under it) push the grid down
  let extraTop = 0;
  if (showAuthor) extraTop += 44;
  const availPx = T.contentBottom - T.contentTop - extraTop;

  let d = options.fitToContent ? 1 : options.density;
  let measured = measure(d);
  if (options.fitToContent) {
    for (let iter = 0; iter < 5; iter++) {
      // everything measured is already scaled by d, so the ratio corrects
      // the CURRENT d rather than replacing it. Never past the template's
      // own sizes: a small roster keeps them and spreads out, it does not
      // balloon.
      const fit = clamp((availPx / totalAt(measured, d)) * d, 0.42, 1.0);
      if (Math.abs(fit - d) < 0.002) { d = fit; break; }
      d = fit;
      measured = measure(d);
    }
  }
  // slack, when the grid does not fill the page: dealt between sections,
  // capped so a six-character script does not drift apart
  const usedPx = totalAt(measured, d);
  const slack = Math.max(0, availPx - usedPx);
  const extraGap = sections.length > 1 ? Math.min(40, slack / (sections.length - 1)) : 0;

  const sheet = el('div', {
    position: 'relative',
    width: px(W),
    height: px(H),
    overflow: 'hidden',
    background: '#eee6d0',
    userSelect: 'none',
    textRendering: 'optimizeLegibility',
    fontKerning: 'normal',
  });
  sheet.className = 'script-sheet script-sheet-teensy';
  sheet.dataset.fsDensity = d.toFixed(3);

  // parchment with the engraved clockwork
  sheet.append(img(ART + 'teensy-parchment.jpg', {
    position: 'absolute', inset: '0', width: '100%', height: '100%',
  }));

  // the ribbons, recoloured when asked
  const tint = wantsTint(options.sidebarColor, TEENSY_RIBBON_BASE.hex);
  for (const [file, left] of [['teensy-ribbon-l.png', 0], ['teensy-ribbon-r.png', W - T.ribbonArtW]]) {
    const style = { position: 'absolute', left: px(left), top: '0', width: px(T.ribbonArtW), height: px(H) };
    const canvas = tint ? tintedCanvas(ART + file, TEENSY_RIBBON_BASE, options.sidebarColor, requestRender) : null;
    if (canvas) {
      Object.assign(canvas.style, style);
      sheet.append(canvas);
    } else {
      sheet.append(img(ART + file, style));
    }
  }

  /* ── header ── */
  const stackTop = T.title.top + options.titleDY * (H / 100);
  const cx = (somethingRight ? T.title.cx : T.title.cxAlone) + options.titleDX * (W / 100);
  const stack = titleStack(title, T.title.maxW * options.titleSize, T.title.maxH * options.titleSize,
    T.title.size * options.titleSize, options.titleCapsShort);
  stack.rows.forEach((r) => {
    const w = titleWord(r.text, r.size, options.titleColor);
    Object.assign(w.style, {
      position: 'absolute',
      left: px(cx + r.dx),
      top: px(stackTop + r.top),
      transform: 'translateX(-50%)',
    });
    sheet.append(w);
  });
  let headerBottom = stackTop + stack.height;

  if (showAuthor) {
    sheet.append(el('div', {
      position: 'absolute',
      left: px(cx),
      top: px(Math.max(headerBottom - 4, 400)),
      transform: 'translateX(-50%)',
      fontFamily: F.heading,
      fontSize: px(30),
      lineHeight: '1',
      color: '#2a1b10',
      whiteSpace: 'nowrap',
      letterSpacing: '0.04em',
    }, 'by ' + smartTypography(author)));
  }

  // the clock, the logo, or the bootlegger box in that slot
  if (hasLogo) {
    const logo = iconImg(proxied(script.meta.logo, options.proxyIcons), {
      position: 'absolute',
      left: px(T.logo.cx),
      top: px(T.logo.cy),
      transform: 'translate(-50%, -50%)',
      maxWidth: px(T.logo.w),
      maxHeight: px(T.logo.h),
      objectFit: 'contain',
      filter: 'drop-shadow(1px 2px 2px rgba(40, 26, 10, 0.45))',
    }, title);
    sheet.append(logo);
  } else if (showClock) {
    sheet.append(img(ART + 'teensy-clock.png', {
      position: 'absolute', left: px(789), top: px(76), width: px(384), height: px(390),
    }));
  }

  /* ── the grid ── */
  let cursor = T.contentTop + extraTop;
  const rulesInk = '#000000';
  sections.forEach((s, si) => {
    const m = measured[si];
    if (si > 0) cursor += gapBefore(s, d) + extraGap;
    const wrap = el('div', { position: 'absolute', left: px(T.contentLeft), top: px(cursor), width: px(contentW) });
    const n = s.g.characters.length;
    const label = (n === 1 ? TEAM_LABELS_SINGULAR[s.g.team] : TEAM_LABELS[s.g.team]).toUpperCase();
    const color = headingColor(s.g.team, options);
    const playersLine = options.showPlayersFront && si === 0 ? playersText(script, options).toUpperCase() : '';

    if (s.g.team === 'demon') {
      // a full-width rule with the heading centred on it: the rule runs
      // through the heading band's middle, the word sits over it on a
      // parchment-coloured ground so the rule reads as broken by the word
      const bandH = T.demonHeadingSize * d;
      wrap.append(el('div', {
        position: 'absolute', left: px(-9), top: px(bandH / 2 - (T.demonRule * d) / 2), width: px(contentW + 9),
        height: px(T.demonRule * d), background: rulesInk,
      }));
      wrap.append(el('div', {
        position: 'absolute', left: '0', top: '0', width: '100%', height: px(bandH),
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }, el('div', {
        fontFamily: F.heading, fontSize: px(T.demonHeadingSize * d), lineHeight: '1',
        color, letterSpacing: '0.02em', padding: `0 ${px(18 * d)}`,
        background: 'rgba(240, 232, 212, 0.92)',
      }, label)));
    } else {
      const head = el('div', {
        position: 'absolute', left: px(T.headingX - T.contentLeft), top: '0',
        width: px(contentW - (T.headingX - T.contentLeft)),
        height: px(T.headingH * d),
        display: 'flex', alignItems: 'center', gap: px(12 * d),
      });
      head.append(el('div', {
        fontFamily: F.heading, fontSize: px(T.headingSize * d), lineHeight: '1',
        color, whiteSpace: 'nowrap', letterSpacing: '0.02em', flexShrink: '0',
      }, label));
      head.append(el('div', { flex: '1', height: px(T.headingRule * d), background: rulesInk }));
      if (playersLine) {
        head.append(el('div', {
          fontFamily: F.heading, fontSize: px(T.headingSize * d * 0.72), lineHeight: '1',
          color: '#111111', whiteSpace: 'nowrap', letterSpacing: '0.03em', flexShrink: '0',
          paddingRight: px(6 * d),
        }, playersLine));
      }
      wrap.append(head);
    }

    const colW = contentW / s.cols;
    let y = rowsFrom(s, d);
    s.g.characters.forEach((ch, i) => {
      const r = Math.floor(i / s.cols), c = i % s.cols;
      if (i && c === 0) y += m.heights[r - 1];
      const e = entry(ch, s.geo, colW, m.heights[r], d, options, iconSize);
      e.style.left = px(c * colW);
      e.style.top = px(y);
      wrap.append(e);
    });
    sheet.append(wrap);
    cursor += m.need;
  });

  /* ── night strips on the ribbons ── */
  if (options.nightStrips) {
    const lists = nightLists(script, options.nightInfoSteps);
    const S = T.strip;
    const drawStrip = (items, labelText, cxPx, limit) => {
      if (!items.length) return;
      const natural = { iconPx: S.icon, pitchPx: S.pitch, moonPx: S.moon, sunPx: S.sun, labelPx: S.labelSize, hasLabel: true };
      let top = S.labelTop;
      const need = nightColumnHeight(items, natural);
      // a long night starts higher (never over the top corner art), then
      // closes up evenly — moon, icons and sun together — to fit
      if (top + need > limit) top = Math.max(S.minTop, limit - need);
      const sizes = fitNightSizes([items], natural, limit - top, 30);
      const col = nightColumn({
        items, label: labelText, fonts: F,
        iconPx: sizes.iconPx, pitchPx: sizes.pitchPx, moonPx: sizes.moonPx, sunPx: sizes.sunPx,
        names: false, width: T.ribbonArtW, labelPx: S.labelSize,
        labelColor: '#ffffff', labelShadow: true, iconFit,
      });
      Object.assign(col.style, { position: 'absolute', left: px(cxPx - T.ribbonArtW / 2), top: px(top) });
      sheet.append(col);
    };
    drawStrip(lists.first, 'First\nnight', S.leftCX, S.leftLimit);
    drawStrip(lists.other, 'Other\nnights', S.rightCX, S.rightLimit);
  }

  /* ── corners, on top of everything like the PSD ── */
  if (options.cornerArt) {
    for (const [key, file] of [['tl', 'teensy-corner-tl.png'], ['tr', 'teensy-corner-tr.png'], ['bl', 'teensy-corner-bl.png'], ['br', 'teensy-corner-br.png']]) {
      const [l, t, w, h] = T.corners[key];
      sheet.append(img(ART + file, {
        position: 'absolute', left: px(l), top: px(t), width: px(w), height: px(h), pointerEvents: 'none',
      }));
    }
  }

  // the bootlegger box goes on AFTER the corners: the top-right berries
  // would otherwise cover it, and rules are content where the art is not
  if (rules) {
    const box = bootleggerBox({
      rules,
      fonts: F,
      basePx: 26,
      scale: options.bootleggerSize,
      editable: !!ui.editable,
      onEdit: ui.onBootleggerEdit,
      onCommit: ui.onBootleggerCommit,
    });
    if (bootInSlot) {
      Object.assign(box.style, { position: 'absolute', left: px(800), top: px(70), width: px(590), maxHeight: px(395) });
    } else {
      Object.assign(box.style, { position: 'absolute', left: px(1120), top: px(24), width: px(270) });
    }
    box.dataset.fsBootlegger = '1';
    sheet.append(box);
  }

  // "*Not the first night", bottom right
  const hasNightStar = script.characters.some((c) => c.ability.includes('night*'));
  if (options.showFootnote && hasNightStar) {
    sheet.append(el('div', {
      position: 'absolute',
      right: px(W - T.footnote.right),
      top: px(T.footnote.baseline - T.footnote.size),
      fontFamily: F.heading,
      fontSize: px(T.footnote.size),
      lineHeight: '1',
      color: '#000000',
      whiteSpace: 'nowrap',
      webkitTextStroke: '0.6px rgba(0,0,0,0.6)',
    }, '*Not the first night'));
  }

  return sheet;
}
