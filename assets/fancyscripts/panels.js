/* Fancy Scripts — the pieces both sheets and the back cover share.
 *
 * The DOM helpers (el/img/iconImg), text measurement, the ability text
 * with its asterisk, and the three kinds of box the tool can draw anywhere:
 *   - bootleggerBox(): the script's house rules in a framed panel, editable
 *     on the sheet itself;
 *   - nightColumn(): one night's order as a strip of icons — the moon, one
 *     icon per waking character (and the info steps), the sun — the way the
 *     teensy template runs them down its ribbons; names beside them when
 *     asked;
 *   - panelFrame() + teamRows(): a parchment panel with a heading, and a
 *     team's characters as icon/name/ability rows inside it, for the teams
 *     moved onto the back cover.
 *
 * Everything is inline-styled: these elements are captured by the export,
 * and nothing in them may depend on the page's stylesheet. Fonts come from
 * the FONTS table so the classic and teensy styles each keep their own
 * faces. Browser-only (canvas + DOM) — do not import from the Worker.
 */

import { PLACEHOLDER_ICON, smartTypography } from './script.js';

const ART = '/assets/fancyscripts/art/';

export const FONTS = {
  classic: {
    title: '"LHF Unlovable", "Goudy Text MT", serif',
    heading: '"Dumbledor", "Hallowen", "Pirata One", serif',
    name: '"Goudy Old Style", "Goudy Bookletter 1911", serif',
    ability: '"Trade Gothic", "Archivo Narrow", sans-serif',
    label: '"Goudy Old Style", "Goudy Bookletter 1911", serif',
    ornamentAsterisk: true,
    nameWeight: '700',
  },
  teensy: {
    title: '"LHF Unlovable", "Goudy Text MT", serif',
    heading: '"OptimusPrinceps", "Trajan Pro", "Cinzel", serif',
    name: '"OptimusPrinceps", "Trajan Pro", "Cinzel", serif',
    ability: '"Liberation Sans", "Helvetica Neue", Helvetica, Arial, sans-serif',
    label: '"OptimusPrinceps", "Trajan Pro", "Cinzel", serif',
    ornamentAsterisk: false,
    nameWeight: '400',
  },
};

export function fontsFor(mode) {
  return FONTS[mode === 'teensy' ? 'teensy' : 'classic'];
}

export const px = (v) => v + 'px';
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* tiny element builder: tag, style object, then children (nodes/strings) */
export function el(tag, style, ...children) {
  const n = document.createElement(tag);
  if (style) Object.assign(n.style, style);
  for (const c of children) {
    if (c == null) continue;
    n.append(c);
  }
  return n;
}

export function img(src, style, alt) {
  const n = document.createElement('img');
  n.src = src;
  n.alt = alt || '';
  n.draggable = false;
  if (style) Object.assign(n.style, style);
  return n;
}

/* an icon <img> that falls back to the placeholder when its art 404s */
export function iconImg(src, style, alt) {
  const n = img(src, style, alt);
  n.crossOrigin = 'anonymous';
  n.addEventListener('error', () => {
    if (n.src !== PLACEHOLDER_ICON) n.src = PLACEHOLDER_ICON;
  });
  return n;
}

/* shared canvas context for word-wrap measurement */
let measureCtx = null;
export function measureWidth(text, fontCss) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return 0;
  measureCtx.font = fontCss;
  return measureCtx.measureText(text).width;
}

/* how many lines `text` wraps to at `fontPx` in `family` inside `maxW` */
export function lineCount(text, family, fontPx, maxW, weight) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx || !text.trim()) return 1;
  measureCtx.font = `${weight || 400} ${fontPx}px ${family}`;
  const words = text.split(/\s+/).filter(Boolean);
  let lines = 1;
  let line = '';
  for (const w of words) {
    const trial = line ? line + ' ' + w : w;
    if (line && measureCtx.measureText(trial).width > maxW) {
      lines++;
      line = w;
    } else {
      line = trial;
    }
  }
  return lines;
}

/* ability text with typographic punctuation; the classic sheet draws the
   ornamental asterisk of the official sheets, the teensy one a plain '*' */
export function abilityNodes(text, ornament) {
  const typed = smartTypography(text);
  if (!ornament) return [document.createTextNode(typed)];
  const parts = typed.split('*');
  const out = [];
  parts.forEach((p, i) => {
    out.push(document.createTextNode(p));
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

/* warm printer's ink for body text on parchment */
export const INK = '#222222';
const FRAME = '#2a1b10';

/* ── the bootlegger box ─────────────────────────────────────────────────
   A framed parchment panel: "Bootlegger" over the rules, one line each.
   `editable` makes the rules editable in place on the preview: typing
   calls onEdit(text) with the whole box's text and rebuilds NOTHING (a
   rebuild would destroy the caret); leaving the box calls onCommit(). The
   export renders its own copy with editable off. */
export function bootleggerBox({ rules, fonts, basePx, scale, editable, onEdit, onCommit }) {
  const s = (v) => px(v * scale);
  const box = el('div', {
    boxSizing: 'border-box',
    background: 'rgba(255, 250, 236, 0.86)',
    border: `${Math.max(1.5, 2.2 * scale)}px solid ${FRAME}`,
    borderRadius: s(4),
    boxShadow: `0 ${s(2)} ${s(8)} rgba(20, 10, 4, 0.35)`,
    padding: `${s(basePx * 0.45)} ${s(basePx * 0.7)} ${s(basePx * 0.55)}`,
    color: INK,
    textAlign: 'left',
  });
  box.append(el('div', {
    fontFamily: fonts.heading,
    fontSize: s(basePx * 1.05),
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    lineHeight: '1.1',
    marginBottom: s(basePx * 0.25),
    color: FRAME,
  }, 'Bootlegger'));
  const body = el('div', {
    fontFamily: fonts.ability,
    fontSize: s(basePx),
    lineHeight: '1.25',
    whiteSpace: 'pre-wrap',
    outline: 'none',
    minHeight: s(basePx * 1.25),
  });
  const list = rules.length ? rules : ['(no house rules yet — tap here to write one)'];
  body.textContent = list.join('\n');
  if (editable) {
    body.contentEditable = 'true';
    body.spellcheck = false;
    body.style.cursor = 'text';
    // a tap on the placeholder line replaces it rather than appending to it
    body.addEventListener('focus', () => {
      if (!rules.length) {
        body.textContent = '';
      }
    });
    body.addEventListener('input', () => { if (onEdit) onEdit(body.innerText); });
    body.addEventListener('blur', () => { if (onCommit) onCommit(); });
    body.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  }
  box.append(body);
  return box;
}

/* ── one night's order as a column of icons ─────────────────────────────
   items come from nightLists(): dusk first, dawn last, characters and info
   steps between. Icons carry the template's heavy drop shadow. The column
   is `width` wide; icons are centred in it unless `names` is on, in which
   case each row is [icon] Name, left-aligned. Returns the element; its
   height is the sum of what it draws. */
export function nightColumn({
  items, label, fonts, iconPx, pitchPx, moonPx, sunPx, names, width,
  labelPx, labelColor, labelShadow, nameColor, namePx, iconFit,
}) {
  const col = el('div', { position: 'relative', width: px(width), boxSizing: 'border-box' });
  if (label) {
    const lab = el('div', {
      fontFamily: fonts.label,
      fontSize: px(labelPx),
      lineHeight: '1',
      textAlign: 'center',
      color: labelColor || '#ffffff',
      textTransform: 'uppercase',
      whiteSpace: 'pre-line',
      marginBottom: px(iconPx * 0.08),
      letterSpacing: '0.01em',
      textShadow: labelShadow ? '0 2px 5px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,0.5)' : 'none',
      webkitTextStroke: labelShadow ? '0.5px rgba(0,0,0,0.4)' : '',
    }, label);
    col.append(lab);
  }
  const shadow = `drop-shadow(0 ${px(Math.max(1, iconPx * 0.03))} ${px(Math.max(2, iconPx * 0.06))} rgba(0,0,0,0.9))`;
  items.forEach((it, i) => {
    const size = it.kind === 'dusk' ? moonPx : it.kind === 'dawn' ? sunPx : iconPx;
    const rowH = it.kind === 'dusk' ? moonPx + iconPx * 0.1
      : it.kind === 'dawn' ? sunPx
        : pitchPx;
    const row = el('div', {
      position: 'relative',
      height: px(rowH),
      display: 'flex',
      alignItems: 'center',
      justifyContent: names ? 'flex-start' : 'center',
      gap: px(iconPx * 0.22),
    });
    const fit = iconFit ? iconFit(it.icon) : null;
    const ic = iconImg(it.icon, {
      width: px(size),
      height: px(size),
      objectFit: 'contain',
      flexShrink: '0',
      filter: shadow,
      transform: fit ? `translate(${(fit.dx * 100).toFixed(2)}%, ${(fit.dy * 100).toFixed(2)}%) scale(${fit.s.toFixed(3)})` : '',
      transformOrigin: 'center',
    }, it.name);
    ic.title = it.name;
    row.append(ic);
    if (names) {
      row.append(el('div', {
        fontFamily: fonts.name,
        fontWeight: fonts.nameWeight,
        fontSize: px(namePx),
        lineHeight: '1.05',
        color: nameColor || INK,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        minWidth: '0',
        letterSpacing: '0.01em',
      }, it.kind === 'char' ? smartTypography(it.name) : it.name));
    }
    col.append(row);
  });
  return col;
}

/* natural height of a nightColumn() for `n` items at these sizes */
export function nightColumnHeight(items, { iconPx, pitchPx, moonPx, sunPx, labelPx, hasLabel }) {
  let h = hasLabel ? labelPx * 2 + iconPx * 0.08 : 0;
  for (const it of items) {
    h += it.kind === 'dusk' ? moonPx + iconPx * 0.1 : it.kind === 'dawn' ? sunPx : pitchPx;
  }
  return h;
}

/* The sizes that fit `lists` (one or more columns, the tallest decides)
   into `availH`: everything below the label — moon, icons, pitch, sun —
   scales by one factor, so a long night closes up evenly instead of the
   icons shrinking under a moon that stays full size. Never scales UP past
   the sizes given; `minIcon` is the floor. */
export function fitNightSizes(lists, sizes, availH, minIcon) {
  const labelH = sizes.hasLabel ? sizes.labelPx * 2 : 0;
  const tallest = Math.max(...lists.map((l) => nightColumnHeight(l, sizes)));
  if (tallest <= availH) return { ...sizes };
  const k = clamp((availH - labelH) / Math.max(1, tallest - labelH), minIcon / sizes.iconPx, 1);
  return {
    ...sizes,
    iconPx: sizes.iconPx * k,
    pitchPx: sizes.pitchPx * k,
    moonPx: sizes.moonPx * k,
    sunPx: sizes.sunPx * k,
  };
}

/* ── a parchment panel with a heading ──────────────────────────────────
   The frame the back cover draws its boxes in. `parchment` is the sheet's
   own parchment art (the classic garland sheet, the teensy engraved one),
   shown from its top so the garland never lands inside a box. */
export function panelFrame({ title, fonts, parchment, scale, headingPx, width, left, top, height, burnt, pad }) {
  const padX = pad != null ? pad : 18 * scale;
  const padY = pad != null ? pad : 10 * scale;
  const root = el('div', {
    position: 'absolute',
    left: px(left),
    top: px(top),
    width: px(width),
    height: height != null ? px(height) : 'auto',
    boxSizing: 'border-box',
    backgroundColor: '#e7dcc3',
    backgroundImage: `url(${parchment})`,
    // the panel textures are garland-free interior crops of the sheet
    // parchments (art/parchment-panel.jpg, teensy-parchment-panel.jpg), so
    // a tall strip backing never repeats a garland through its middle
    backgroundSize: 'cover',
    backgroundPosition: '50% 40%',
    border: `${px(Math.max(2, 3 * scale))} solid ${FRAME}`,
    borderRadius: px(6 * scale),
    // `burnt`: the official setup table's scorched edges — a heavy dark
    // vignette inside the frame instead of the light one
    boxShadow: burnt
      ? `0 ${px(6 * scale)} ${px(18 * scale)} rgba(0,0,0,0.55), inset 0 0 ${px(80 * scale)} ${px(18 * scale)} rgba(34, 19, 7, 0.86), inset 0 0 ${px(30 * scale)} rgba(70, 40, 10, 0.65)`
      : `0 ${px(6 * scale)} ${px(18 * scale)} rgba(0,0,0,0.55), inset 0 0 ${px(30 * scale)} rgba(70, 40, 10, 0.18)`,
    padding: `${px(padY)} ${px(padX)} ${px(pad != null ? pad : 14 * scale)}`,
    color: INK,
    overflow: 'hidden',
  });
  if (title) {
    root.append(el('div', {
      fontFamily: fonts.heading,
      fontSize: px(headingPx),
      lineHeight: '1.1',
      textAlign: 'center',
      textTransform: 'uppercase',
      letterSpacing: '0.09em',
      color: FRAME,
      paddingBottom: px(4 * scale),
      marginBottom: px(8 * scale),
      borderBottom: `${px(Math.max(1, 1.5 * scale))} solid rgba(42, 27, 16, 0.55)`,
    }, title));
  }
  const body = el('div', { position: 'relative' });
  root.append(body);
  return { root, body };
}

/* ── the official setup table ───────────────────────────────────────────
   Players 5 to 15+ across, townsfolk / outsiders / minions / demons down,
   the counts the rulebook gives: the back-of-the-box table. Drawn to the
   reference: right-aligned small-cap labels, the players row and the evil
   rows in dark red, the good rows in blue, faint rules between the
   columns, and a scorched parchment frame. `width` decides everything
   else (the reference is ~2.9:1). */
export const SETUP_TABLE = {
  players: ['5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15+'],
  rows: [
    ['Townsfolk', [3, 3, 5, 5, 5, 7, 7, 7, 9, 9, 9], 'good'],
    ['Outsiders', [0, 1, 0, 1, 2, 0, 1, 2, 0, 1, 2], 'good'],
    ['Minions', [1, 1, 1, 1, 1, 2, 2, 2, 3, 3, 3], 'evil'],
    ['Demons', [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 'evil'],
  ],
};

export function setupTableHeight(width) {
  return width * 0.345;
}

export function setupTable({ fonts, parchment, width, left, top, scale, good, evil }) {
  const u = width / 900; // the reference's own pixel space
  const height = setupTableHeight(width);
  const { root, body } = panelFrame({
    title: '', fonts, parchment, scale: u * 1.4, headingPx: 0,
    width, left, top, height, burnt: true, pad: 14 * u,
  });
  const cols = SETUP_TABLE.players.length;
  const grid = el('div', {
    display: 'grid',
    gridTemplateColumns: `${px(150 * u)} repeat(${cols}, 1fr)`,
    gridAutoRows: px(52 * u),
    alignItems: 'center',
    padding: `${px(8 * u)} ${px(18 * u)} ${px(2 * u)} ${px(6 * u)}`,
    boxSizing: 'border-box',
  });
  const label = (text, color) => el('div', {
    fontFamily: fonts.heading,
    fontSize: px(19 * u),
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color,
    textAlign: 'right',
    paddingRight: px(20 * u),
    lineHeight: '1',
  }, text);
  const cell = (text, color, big, first) => {
    const c = el('div', {
      fontFamily: fonts.heading,
      fontSize: px((big ? 38 : 34) * u),
      lineHeight: '1',
      color,
      textAlign: 'center',
      height: px(52 * u),
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      borderLeft: first ? 'none' : `${px(Math.max(1, 1.2 * u))} solid rgba(90, 68, 40, 0.32)`,
      letterSpacing: '-0.01em',
    });
    // OptimusPrinceps draws its zero slashed (it reads as a theta at this
    // size), so a 0 is set as the face's round capital O — which is what
    // the reference table's zeros look like
    const digits = String(text).replace(/0/g, 'O');
    if (digits.endsWith('+')) {
      c.append(digits.slice(0, -1), el('span', {
        fontSize: '0.5em', verticalAlign: 'top', position: 'relative', top: '-0.55em', marginLeft: '0.05em',
      }, '+'));
    } else {
      c.textContent = digits;
    }
    return c;
  };
  grid.append(label('Players', evil));
  SETUP_TABLE.players.forEach((p, i) => grid.append(cell(p, evil, true, i === 0)));
  for (const [name, counts, side] of SETUP_TABLE.rows) {
    const color = side === 'good' ? good : evil;
    grid.append(label(name, color));
    counts.forEach((n, i) => grid.append(cell(n, color, false, i === 0)));
  }
  body.append(grid);
  return root;
}

/* ── a team's characters as rows inside a panel ─────────────────────────
   [icon] Name / ability, in `cols` columns. Row heights are measured (the
   ability wraps), so teamRowsHeight() can be asked before anything is
   drawn — the back cover budgets its panels from it. */
export function teamRowGeometry(scale, cols, namePx, abilityPx, iconPx, width) {
  const colW = width / cols;
  const textLeft = iconPx * 1.12;
  const textW = colW - textLeft - 8 * scale;
  return { colW, textLeft, textW, namePx, abilityPx, iconPx };
}

export function teamRowsHeight(chars, g, fonts, cols) {
  const rows = Math.ceil(chars.length / cols);
  const heights = [];
  for (let r = 0; r < rows; r++) {
    let h = g.iconPx + 6;
    for (let c = 0; c < cols; c++) {
      const ch = chars[r * cols + c];
      if (!ch) continue;
      const lines = lineCount(smartTypography(ch.ability), fonts.ability, g.abilityPx, g.textW);
      h = Math.max(h, g.namePx * 1.15 + lines * g.abilityPx * 1.22 + 6);
    }
    heights.push(h);
  }
  return { rows, heights, total: heights.reduce((a, b) => a + b, 0) };
}

export function teamRows(chars, g, fonts, cols, colorFor, ornament) {
  const wrap = el('div', { position: 'relative' });
  const { heights } = teamRowsHeight(chars, g, fonts, cols);
  chars.forEach((ch, i) => {
    const r = Math.floor(i / cols), c = i % cols;
    const top = heights.slice(0, r).reduce((a, b) => a + b, 0);
    const row = el('div', {
      position: 'absolute',
      left: px(c * g.colW),
      top: px(top),
      width: px(g.colW),
      height: px(heights[r]),
    });
    row.append(iconImg(ch.icon, {
      position: 'absolute',
      left: '0',
      top: px((heights[r] - g.iconPx) / 2),
      width: px(g.iconPx),
      height: px(g.iconPx),
      objectFit: 'contain',
      filter: `drop-shadow(0 ${px(g.iconPx * 0.02)} ${px(g.iconPx * 0.04)} rgba(32,20,8,0.42))`,
    }, ch.name));
    const lines = lineCount(smartTypography(ch.ability), fonts.ability, g.abilityPx, g.textW);
    const blockH = g.namePx * 1.15 + lines * g.abilityPx * 1.22;
    const text = el('div', {
      position: 'absolute',
      left: px(g.textLeft),
      top: px(Math.max(0, (heights[r] - blockH) / 2)),
      width: px(g.textW),
    });
    text.append(el('div', {
      fontFamily: fonts.name,
      fontWeight: fonts.nameWeight,
      fontSize: px(g.namePx),
      lineHeight: '1.15',
      color: colorFor(ch.team),
      letterSpacing: '0.02em',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    }, smartTypography(ch.name)));
    text.append(el('div', {
      fontFamily: fonts.ability,
      fontSize: px(g.abilityPx),
      lineHeight: '1.22',
      color: INK,
    }, ...abilityNodes(ch.ability, ornament)));
    row.append(text);
    wrap.append(row);
  });
  wrap.style.height = px(heights.reduce((a, b) => a + b, 0));
  return wrap;
}
