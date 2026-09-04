/* Fancy Scripts ("The Grimoire Press") — the engine.
 *
 * Turns official script-tool JSON into the data the renderers draw:
 * parsing, team grouping, sorting, typography, the night order and the
 * calibrated sheet geometry — plus the OPTION MODEL every page shares
 * (DEFAULT_OPTIONS and the DEFAULT_* groups), the presets, the font
 * registry and the element registry the drag layer works from. Ported from
 * the handoff's React + TypeScript app to plain ES modules — the wiki has no
 * build step and no framework.
 *
 * No DOM access anywhere in this file: it is data + string work, checkable
 * with `node --input-type=module --check` and unit-testable with plain node.
 * The official roster is handed in through setOfficialRoster() (roles.json,
 * this tool's official-jinxes.json and assets/night-order.json), never
 * fetched here — same contract as official-roles.js.
 *
 * EVERY number in SHEET and NIGHT is calibration. SHEET was reverse-measured
 * from an official-style reference render ("Harold Holt's Revenge",
 * 1080×1440) as fractions of the sheet, then re-trued against the generator
 * family's own CSS (JohnForster/botc-fancy-script-generator). NIGHT was
 * measured the same way off the owner's reference night sheets ("Blending
 * In", 903×1225). Vertical unit: 1 em = 1% of sheet height; horizontal
 * positions are % of sheet width. Change one value at a time and compare
 * against a known-good render — nothing in here is a guess, including the
 * ones that look like one.
 */

export const SHEET = {
  ratio: 4 / 3, // height / width — the trim is exactly 3:4
  // vertical grid
  contentTop: 9.36, // first row top
  contentBottom: 86.23, // content must end above this (garland starts 89.25)
  rowPitch: 5.734,
  rowIcon: 4.9,
  sectionGap: 0.763,
  nameTop: 0.9, // name offset within a row
  abilityTop: 2.5, // ability first-line offset within a row
  abilityLine: 1.24, // ability line pitch
  nameSize: 1.318, // wrap-fidelity correction: reference names are 5.2% narrower
  abilitySize: 1.031, // wrap-fidelity correction: reference abilities are 3.6% wider
  jinxSize: 2.185,
  // horizontal grid
  col1IconX: 12.25,
  col2IconX: 51.45,
  textOffsetX: 7.8, // text left, relative to icon x
  textWidth: 30.64,
  // sidebar
  sidebarX: 0.967,
  sidebarY: 0.725,
  sidebarW: 7.788,
  sidebarH: 98.54,
  labelSize: 1.43, // 4mm at 210mm print width
  // the label shrinks to fit its band; this is as small as it may get.
  // A one-row TRAVELLERS band cannot hold the official size whatever we
  // do, but a label small enough to read as a smudge is worse than one
  // overhanging into the dead ribbon of the section gap. 2mm at print.
  labelSizeMin: 0.72,
  // header / footer
  titleCX: 56.07, // title text horizontal centre (between skull and right swirl)
  titleCY: 6.66,
  // header decor (skull + flourishes), positions measured from the reference trim
  skullX: 17.5, // % width
  skullY: 2.0, // em
  skullW: 15.5, // % width
  skullH: 7.8, // em
  flLX: 8.787,
  flLY: 5.32,
  flLW: 9.956,
  flLH: 3.204,
  flRX: 80.048,
  flRY: 5.32,
  flRW: 17.453,
  flRH: 3.295,
  footnoteCX: 53.21,
  footnoteTop: 95.03,
  footnoteLine: 1.15,
  // a page without the title band (page 2 of a long script, or the header
  // switched off) starts its first section here instead
  bareTop: 5.2,
};

/* CSS pixel size of the rendered sheet (3:4, matching the reference trim
   595.57 × 794.05 pt) and the em unit in px. */
export const SHEET_W = 1242;
export const SHEET_H = Math.round(SHEET_W * SHEET.ratio); // 1656
export const U = SHEET_H / 100;
/* reference trim in PDF points, for the PDF page size */
export const TRIM_W_PT = 595.57;
export const TRIM_H_PT = 794.05;

/* PDF page formats the export can lay the sheet onto. 'trim' is the sheet's
   own 3:4; the paper sizes centre the sheet with equal margins (the sheet
   keeps its aspect — a 3:4 sheet on A4 leaves a little top/bottom room). */
export const PAGE_FORMATS = {
  trim: { label: 'Sheet size (3:4)', w: TRIM_W_PT, h: TRIM_H_PT },
  a4: { label: 'A4', w: 595.28, h: 841.89 },
  letter: { label: 'US Letter', w: 612, h: 792 },
  a3: { label: 'A3', w: 841.89, h: 1190.55 },
};

/* ── the night order sheet ───────────────────────────────────────────────
   Calibrated from the owner's reference night sheets (see the header).
   Same units as SHEET: em = 1% of sheet height, x in % of sheet width. */
export const NIGHT = {
  titleX: 3.3, // "First Night" left edge
  titleCY: 6.9, // its vertical centre
  titleSize: 2.7, // em (Dumbledor)
  logoRight: 3.6, // % width from the right edge
  logoCY: 5.9,
  logoMaxH: 5.4, // em
  logoMaxW: 30, // % width
  listTop: 11.8, // first row top
  listBottom: 95.2, // rows must end above this
  iconX: 2.35, // % width
  iconSize: 3.55, // em
  textX: 8.05, // % width — name + reminder left edge
  textRight: 3.1, // % width from the right edge
  nameSize: 1.44, // em (Goudy bold)
  nameTop: 0.15, // within the row
  textTop: 1.62, // reminder first line top
  textSize: 1.04, // em (Trade Gothic)
  textLine: 1.2, // reminder line pitch (em)
  rowMin: 3.92, // one-line row pitch (name + one line + gap)
  rowGap: 0.95, // added under the last text line
  footerRight: 2.4,
  footerTop: 96.5,
  footerLine: 1.1,
  footerSize: 0.82,
  badgeX: 1.4,
  badgeBottom: 1.2,
  badgeW: 12.2,
  // the two-column layout (both nights on one page): each column is a
  // narrower copy of the single-column grid
  colGap: 2.4,
};

/* The non-character steps of a night, in the official app's own wording
   (this is also what the reference sheets print). Positions come from
   assets/night-order.json's `meta` list when it is handed in; these are the
   fallbacks so the steps still appear without it. */
export const NIGHT_STEPS = {
  dusk: {
    id: 'dusk', name: 'Dusk', icon: 'dusk', firstNight: 0, otherNight: 0,
    text: 'Start the Night Phase.',
  },
  minioninfo: {
    id: 'minioninfo', name: 'Minion Info', icon: 'minion', firstNight: 19, otherNight: null,
    text: 'If there are 7 or more players, wake all Minions: Show the *THIS IS THE DEMON* token. Point to the Demon. Show the *THESE ARE YOUR MINIONS* token. Point to the other Minions.',
  },
  demoninfo: {
    id: 'demoninfo', name: 'Demon Info', icon: 'demon', firstNight: 24, otherNight: null,
    text: 'If there are 7 or more players, wake the Demon: Show the *THESE ARE YOUR MINIONS* token. Point to all Minions. Show the *THESE CHARACTERS ARE NOT IN PLAY* token. Show 3 not-in-play good character tokens.',
  },
  dawn: {
    id: 'dawn', name: 'Dawn', icon: 'dawn', firstNight: 9999, otherNight: 9999,
    text: 'Wait for a few seconds. End the Night Phase.',
  },
};

/* The sidebar ribbon art's own colour (measured off sidebar.png: hue 243.7°,
   sat 0.62, light 0.135). The recolour filter in sheet.js works in ratios
   against these, so the picker's default IS the art untouched. */
export const SIDEBAR_BASE = { hex: '#0f0d37', h: 243.7, s: 0.62, l: 0.135 };

/* ── fonts ───────────────────────────────────────────────────────────────
   Every text role picks a font by KEY; fontFamily() turns the key into the
   CSS stack. The first five are the sheet's own faces (registered by
   fancyscripts.html with font-display: block); the site's other faces and a
   few web-safe stacks follow. An uploaded font is 'upload:<family>' — the
   page registers it as an @font-face with a data: URL so the export can
   embed it (see app.js). */
export const FONTS = [
  ['unlovable', 'LHF Unlovable', '"LHF Unlovable", "Goudy Text MT", serif'],
  ['dumbledor', 'Dumbledor', '"Dumbledor", "Pirata One", serif'],
  ['goudy', 'Goudy Old Style', '"Goudy Old Style", "Goudy Bookletter 1911", Georgia, serif'],
  ['trade', 'Trade Gothic', '"Trade Gothic", "Archivo Narrow", sans-serif'],
  ['tradebold', 'Trade Gothic Bold Condensed', '"Trade Gothic Bold Condensed", "Trade Gothic", sans-serif'],
  ['dumbledor2', 'Dumbledor 2', '"Dumbledor2", "Dumbledor", serif'],
  ['optimus', 'Optimus Princeps', '"OptimusPrinceps", "Cinzel", serif'],
  ['optimusbold', 'Optimus Princeps Semibold', '"OptimusPrincepsSemiBold", "OptimusPrinceps", serif'],
  ['pirata', 'Pirata One', '"Pirata One", "Dumbledor", serif'],
  ['imfell', 'IM Fell English', '"IM Fell English", Georgia, serif'],
  ['grenze', 'Grenze Gotisch', '"Grenze Gotisch", "Dumbledor", serif'],
  ['cinzel', 'Cinzel', '"Cinzel", Georgia, serif'],
  ['garamond', 'EB Garamond', '"EB Garamond", Georgia, serif'],
  ['georgia', 'Georgia', 'Georgia, "Times New Roman", serif'],
  ['times', 'Times New Roman', '"Times New Roman", Times, serif'],
  ['arial', 'Arial / Helvetica', 'Arial, Helvetica, sans-serif'],
  ['mono', 'Typewriter', 'ui-monospace, "Courier New", monospace'],
];

const FONT_BY_KEY = new Map(FONTS.map((f) => [f[0], f]));

export function fontFamily(key) {
  const k = String(key || '');
  if (k.startsWith('upload:')) {
    const fam = k.slice(7).replace(/["\\]/g, '');
    return '"' + fam + '", "Goudy Old Style", serif';
  }
  const f = FONT_BY_KEY.get(k);
  return f ? f[2] : FONT_BY_KEY.get('goudy')[2];
}

export function fontLabel(key) {
  const k = String(key || '');
  if (k.startsWith('upload:')) return k.slice(7) + ' (uploaded)';
  const f = FONT_BY_KEY.get(k);
  return f ? f[1] : k;
}

/* ── the option model ───────────────────────────────────────────────────
   One nested object holds every choice on every page. Renderers read it,
   the controls write it, undo snapshots it, autosave and the design file
   serialise it. normalizeOptions() merges anything loaded over these
   defaults so a design saved by an older version still has every key. */

/* one movable element: offsets from its calibrated place (dx in % of
   sheet width, dy in em), a scale, a rotation, an opacity, hidden, and
   optionally its own art (an upload replaces the built-in image) */
export const EL_DEFAULT = { dx: 0, dy: 0, scale: 1, rot: 0, opacity: 1, hidden: false, src: '' };

/* every draggable, tunable element the pages draw, with the label the
   Elements panel shows. `page` says which preview it lives on; `kind`
   says which extra controls apply (image: art upload; text: colour/font). */
export const ELEMENTS = [
  { key: 'title', label: 'Title', page: 'front', kind: 'text' },
  { key: 'author', label: 'Author credit', page: 'front', kind: 'text' },
  { key: 'skull', label: 'Skull', page: 'front', kind: 'image' },
  { key: 'fll', label: 'Left flourish', page: 'front', kind: 'image' },
  { key: 'flr', label: 'Right flourish', page: 'front', kind: 'image' },
  { key: 'sidebar', label: 'Sidebar ribbon', page: 'front', kind: 'image', fixed: true },
  { key: 'labels', label: 'Team labels', page: 'front', kind: 'text', fixed: true },
  { key: 'content', label: 'Character grid', page: 'front', kind: 'block' },
  { key: 'col1', label: 'Left column', page: 'front', kind: 'block' },
  { key: 'col2', label: 'Right column', page: 'front', kind: 'block' },
  { key: 'dividers', label: 'Section dividers', page: 'front', kind: 'image', fixed: true },
  { key: 'footnote', label: 'Footnote', page: 'front', kind: 'text' },
  { key: 'pageno', label: 'Page number', page: 'front', kind: 'text' },
  { key: 'nightTitle', label: 'Night title', page: 'night', kind: 'text' },
  { key: 'nightLogo', label: 'Script logo', page: 'night', kind: 'image' },
  { key: 'nightList', label: 'Night list', page: 'night', kind: 'block' },
  { key: 'nightFooter', label: 'Footer', page: 'night', kind: 'text' },
  { key: 'nightBadge', label: 'Content badge', page: 'night', kind: 'image' },
  { key: 'jinxTitle', label: 'Jinx page title', page: 'jinx', kind: 'text' },
  { key: 'jinxLogo', label: 'Script logo', page: 'jinx', kind: 'image' },
  { key: 'jinxList', label: 'Jinx list', page: 'jinx', kind: 'block' },
  { key: 'jinxFooter', label: 'Footer', page: 'jinx', kind: 'text' },
  { key: 'jinxBadge', label: 'Content badge', page: 'jinx', kind: 'image' },
];

export const ELEMENT_BY_KEY = new Map(ELEMENTS.map((e) => [e.key, e]));

/* a page background: the built-in parchment, a plain colour, or an upload;
   plus the adjustments that are applied as a CSS filter, and a vignette */
export const DEFAULT_BG = {
  mode: 'parchment', // parchment | light | plain | custom
  color: '#ece2c8',
  src: '',
  brightness: 1,
  contrast: 1,
  saturate: 1,
  sepia: 0,
  hue: 0,
  vignette: 0,
  fit: 'cover', // custom uploads: cover | contain | stretch
};

export const DEFAULT_NIGHT = {
  first: false, // the tick boxes — a night page exists only when it is ticked
  other: false,
  combined: false, // both nights on ONE page, two columns
  twoColumns: false, // one night split over two columns (long lists on one page)
  showMeta: true, // dusk / minion info / demon info / dawn
  showReminders: true,
  useScriptOrder: true, // follow _meta.firstNight / otherNight when the file has them
  numbered: false,
  titleFirst: 'First Night',
  titleOther: 'Other Nights',
  showLogo: true,
  showName: true, // the script's name at the top right when it has no logo
  iconSize: 1,
  nameSize: 1,
  textSize: 1,
  rowGap: 1,
  density: 1,
  fit: true,
  minFit: 0.68,
  goodColor: '', // '' inherits the sheet's colours
  evilColor: '',
  neutralColor: '',
  metaColor: '#1c1c1c',
  textColor: '#2b2b2b',
  titleColor: '#1c1c1c',
  fontTitle: 'dumbledor',
  fontName: 'goudy',
  fontText: 'trade',
  fontToken: 'tradebold',
  dotStyle: 'dot', // dot | token | none — how ':reminder:' is drawn
  tokenStyle: 'caps', // caps | bold | plain — how *YOU ARE* tokens are drawn
  showFooter: true,
  footer1: '© Steven Medway · bloodontheclocktower.com',
  footer2: 'Pressed with Fancy Scripts · botchomebrew.wiki',
  showBadge: true,
  iconShadow: 1,
  stepIcons: { dusk: '', minion: '', demon: '', dawn: '' }, // uploads replacing the built-in step icons
  bg: { ...DEFAULT_BG, mode: 'light', vignette: 0.28 },
};

export const DEFAULT_JINX = {
  enabled: false,
  title: 'Jinxes',
  showHouseRules: true,
  houseTitle: 'House Rules',
  notes: '', // free text printed under the list
  notesTitle: 'Notes',
  iconSize: 1,
  nameSize: 1,
  textSize: 1,
  density: 1,
  fit: true,
  minFit: 0.68,
  showLogo: true,
  showName: true,
  showFooter: true,
  showBadge: true,
  titleColor: '#1c1c1c',
  textColor: '#2b2b2b',
  fontTitle: 'dumbledor',
  fontName: 'goudy',
  fontText: 'trade',
  bg: { ...DEFAULT_BG, mode: 'light', vignette: 0.28 },
};

export const DEFAULT_EXPORT = {
  pageSize: 'trim', // key of PAGE_FORMATS
  marginColor: '#ffffff', // paper showing around the sheet on A4/Letter
  printScale: 3, // pixelRatio of the print exports (3 = 3726 px wide)
  shareScale: 1.5,
  jpegQuality: 0.92,
  pages: { front: true, jinx: true, night: true, back: true }, // what the PDF carries
};

export const DEFAULT_OPTIONS = {
  sortMode: 'script', // 'script' (as in the JSON) | 'official' | 'sao' | 'alpha'
  columnLayout: 'even', // 'even' (both columns fill the section, official style)
  //                       | 'shared' (classic: col 2 staggered under the title)
  showJinxes: true,
  showFootnote: true,
  footnoteText: '', // blank = "*Not the first night"
  titleOverride: '',
  authorOverride: '',
  authorPrefix: 'by ',
  // colours
  titleColor: '#10102e',
  titleStyle: 'classic', // classic | flat | emboss | gradient
  titleColor2: '#3d3e88', // second stop for the gradient style
  titleShadowColor: '#ad9069',
  titleShadow: 1, // multiplier on the bronze offset duplicate (0 = none)
  goodColor: '#0d6c97',
  evilColor: '#731d1f',
  neutralColor: '#7a5230', // travellers + loric
  teamColors: { townsfolk: '', outsider: '', minion: '', demon: '', traveller: '', fabled: '#8a6d1f', loric: '' },
  teamLabels: { townsfolk: '', outsider: '', minion: '', demon: '', traveller: '', fabled: '', loric: '' },
  inkColor: '#222222',
  authorColor: '#5a4632',
  labelColor: '#eeeeee',
  footnoteColor: '#786254',
  sidebarColor: SIDEBAR_BASE.hex,
  sidebarMode: 'damask', // damask | flat | none
  // how much of the parchment frame's shading is laid over the ribbon.
  // 0 = a solid, even strip (the default); 1 = the old baked-in blend,
  // which puts a strong left-to-right lightness ramp through it.
  sidebarShade: 0,
  // fonts (keys into FONTS)
  fontTitle: 'unlovable',
  fontName: 'goudy',
  fontAbility: 'trade',
  fontLabel: 'dumbledor',
  fontAuthor: 'goudy',
  fontFootnote: 'goudy',
  // layout
  density: 1, // used when fitToContent is off
  fitToContent: true, // auto-scale the grid to fill the page
  iconSize: 1,
  textSize: 1,
  nameSize: 1,
  abilityLine: 1, // ability line-height multiplier
  nameSpacing: 0.02, // em
  labelSize: 1,
  labelSpacing: -0.15, // em (Chromium ignores line-height in upright vertical text)
  showLabels: true,
  labelCounts: false, // "TOWNSFOLK · 13"
  showDividers: true,
  dividerOpacity: 1,
  columnWidth: 1, // multiplier on the text column width
  nameCase: 'normal', // normal | upper | smallcaps
  abilityAlign: 'left', // left | justify
  bracketStyle: 'plain', // how "[+2 Outsiders]" setup notes print: plain | italic | bold | muted
  iconShadow: 1,
  iconEffect: 'none', // none | grayscale | sepia | engraved
  iconFrame: 'none', // none | disc | ring — a token-style backing behind every icon
  normalizeIcons: true,
  hideTeams: { townsfolk: false, outsider: false, minion: false, demon: false, traveller: false, fabled: false, loric: false },
  // long scripts: when auto-fit would have to shrink below minFit, the
  // sheet continues on a second page instead
  paginate: true,
  minFit: 0.62,
  repeatHeader: false, // title band on every page, not just the first
  showPageNumbers: true,
  // header
  showHeader: true, // the whole title band (title/logo, author, skull, flourishes)
  showSkull: true,
  showFlourishes: true,
  hugDecor: true, // slide the skull and flourishes in to meet a short title
  // background
  bg: { ...DEFAULT_BG },
  // movable elements: key -> partial EL_DEFAULT
  el: {},
  // stickers: custom text/image elements on any page
  custom: [],
  // per-character overrides: id -> {hidden, name, ability, icon, team, color, iconScale, iconDX, iconDY}
  chars: {},
  proxyIcons: true, // route off-site images through a CORS proxy so export never taints
  useLogo: true, // render _meta.logo as the title when present
  showAuthor: true, // "by <author>" credit under the title
  night: { ...DEFAULT_NIGHT, bg: { ...DEFAULT_NIGHT.bg } },
  jinxPage: { ...DEFAULT_JINX, bg: { ...DEFAULT_JINX.bg } },
  exportOpts: { ...DEFAULT_EXPORT, pages: { ...DEFAULT_EXPORT.pages } },
  includeBackCover: true,
};

/* ── the back cover ─────────────────────────────────────────────────────
   Template constants measured from the owner's PSD ("Clockback", A4
   2480×3508): the pattern's base colour for the recolour ratios, and the
   title treatment — gold fill rgb(190,168,129), 3px outside black stroke,
   black drop shadow cast downward — scaled to the sheet's 1242px space. */
/* The lightness here is the template's dark green ×g, the pattern gain the
   CAL constants in back.js were divided by — so a picked back colour paints
   true to its swatch (the pattern's midtone IS the picked colour) and the
   default still reproduces the template exactly. See back.js. */
export const BACK_BASE = { hex: '#1d893c', h: 137.1, s: 0.652, l: 0.325 };

export const DEFAULT_BACK = {
  bgColor: BACK_BASE.hex,
  bgGradient: false, // two-colour background ramp along bgGradAngle
  bgColor2: '#11294a',
  bgGradAngle: 180,
  brightness: 1,
  saturation: 1,
  shading: 1, // 0 = flat pattern, 1 = the template's glow + vignette, 2 = stronger
  patScale: 1, // pattern tile size (1 = the template's own scale)
  patRot: 0, // pattern rotation, degrees
  // how deeply the pattern reads: 0 = flat colour, 1 = the template's own
  // depth, above that bolder. The template's modulation is a small
  // MULTIPLE of the picked lightness (±7%), so on a dark cover it comes out
  // to a couple of RGB steps and all but disappears — this is the way back.
  patStrength: 1,
  bgMode: 'pattern', // pattern | custom (an uploaded image) | plain
  bgSrc: '',
  texts: [],  // seeded from the script title by seedBackTexts()
};

/* a fresh text element (a back-cover word or a front-page sticker) */
export function newTextElement(patch) {
  return Object.assign({
    type: 'text', text: 'New text', x: 50, y: 50, size: 120, font: 'goudy',
    fill: '#bea881', fillGrad: false, fill2: '#e8d9a0', gradAngle: 180,
    strokeW: 0, strokeColor: '#000000',
    shadowX: 0, shadowY: 2, shadowBlur: 4, shadowColor: '#000000',
    rotate: 0, spacing: 0, opacity: 1, align: 'center', lineHeight: 1,
    blend: 'normal', // normal | multiply
  }, patch || {});
}

/* a fresh image element (a sticker) */
export function newImageElement(patch) {
  return Object.assign({
    type: 'image', src: '', x: 50, y: 50, w: 24, rotate: 0, opacity: 1,
    shadow: 0, flip: false, behind: false, blend: 'normal', round: 0,
  }, patch || {});
}

const BACK_SMALL_WORDS = new Set(['of', 'the', 'a', 'an', 'and', 'in', 'on', 'to', 'at', '&', 'or']);

/* One element per word, stacked and staggered like the template (Axiom /
   of / Logic): connector words small and offset right, the rest large,
   sizes shrunk until the tallest word fits the width and the stack fits
   the page. Pure — the page hands the result to options.back.texts. */
export function seedBackTexts(title) {
  const words = String(title || '').trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!words.length) words.push('Untitled');
  const rows = words.map((w) => ({ text: w, small: BACK_SMALL_WORDS.has(w.toLowerCase()) }));
  // base sizes from the template: big ≈ 31–37% of width, small ≈ 22%
  let big = rows.length <= 3 ? 400 : rows.length <= 5 ? 330 : 260;
  const sizeOf = (r) => Math.min(
    r.small ? big * 0.58 : big,
    // LHF Unlovable advances ≈ 0.43 em — keep every word inside the page
    (1242 * 0.88) / (0.43 * Math.max(2, r.text.length)),
  );
  // overlapping stack like the template (pitch ≈ 0.62 of the glyph size)
  let total = rows.reduce((n, r) => n + sizeOf(r) * 0.62, 0);
  if (total > 1656 * 0.62) big *= (1656 * 0.62) / total;
  const heights = rows.map((r) => sizeOf(r) * 0.62);
  total = heights.reduce((a, b) => a + b, 0);
  let y = 46 - ((total / 1656) * 100) / 2;
  const stagger = [-2, 4, 2, -3, 3, -2, 2, 0];
  return rows.map((r, i) => {
    const h = (heights[i] / 1656) * 100;
    y += h;
    return newTextElement({
      text: r.text,
      x: 50 + (r.small ? 5 : stagger[i % stagger.length]),
      y: y - h / 2,
      size: Math.round(sizeOf(r)),
      font: 'unlovable',
      fill: '#bea881',
      fillGrad: false,
      fill2: '#e8d9a0',
      gradAngle: 180,
      strokeW: 1.5,
      strokeColor: '#000000',
      shadowX: 0,
      shadowY: 2,
      shadowBlur: 5,
      shadowColor: '#000000',
      rotate: 0,
      spacing: 0,
    });
  });
}

export const TEAM_ORDER = [
  'townsfolk', 'outsider', 'minion', 'demon', 'traveller', 'fabled', 'loric'
];

export const TEAM_LABELS = {
  townsfolk: 'townsfolk',
  outsider: 'outsiders',
  minion: 'minions',
  demon: 'demons',
  traveller: 'travellers',
  fabled: 'fabled',
  loric: 'loric',
};

/* singular forms for one-character sections (the reference sheet prints
   "DEMON" beside a lone demon) */
export const TEAM_LABELS_SINGULAR = {
  townsfolk: 'townsfolk',
  outsider: 'outsider',
  minion: 'minion',
  demon: 'demon',
  traveller: 'traveller',
  fabled: 'fabled',
  loric: 'loric',
};

export const TEAM_NAMES = {
  townsfolk: 'Townsfolk', outsider: 'Outsider', minion: 'Minion', demon: 'Demon',
  traveller: 'Traveller', fabled: 'Fabled', loric: 'Loric',
};

/* typographic polish: curly quotes/apostrophes and en dashes, like the
   official typeset sheets */
export function smartTypography(s) {
  return String(s)
    .replace(/(\w)'(\w)/g, '$1’$2')
    .replace(/"([^"\n]*)"/g, '“$1”')
    .replace(/(^|[\s(“])'(?=\S)/g, '$1‘')
    .replace(/'/g, '’')
    .replace(/ - /g, ' – ');
}

/* team ink colors for names and for the engraved placeholder icons */
export const TEAM_INK = {
  townsfolk: '#0d6c97',
  outsider: '#0d6c97',
  minion: '#731d1f',
  demon: '#731d1f',
  traveller: '#7a5230',
  fabled: '#8a6d1f',
  loric: '#7a5230',
};

export const EVIL_TEAMS = ['minion', 'demon'];
export const NEUTRAL_TEAMS = ['traveller', 'fabled', 'loric'];

/* the ink a team's names are printed in: the per-team pick when set, else
   the good/evil/neutral colour the team falls under */
export function teamColor(options, team) {
  const tc = options.teamColors || {};
  if (tc[team]) return tc[team];
  if (EVIL_TEAMS.includes(team)) return options.evilColor;
  if (NEUTRAL_TEAMS.includes(team)) return options.neutralColor || '#7a5230';
  return options.goodColor;
}

/* engraved, team-inked medallion for homebrew characters without art */
export function placeholderIconFor(team) {
  const ink = TEAM_INK[team] || '#6b7ba0';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<g fill="none" stroke="${ink}" opacity="0.88">` +
    `<circle cx="50" cy="50" r="41" stroke-width="2.6"/>` +
    `<circle cx="50" cy="50" r="35.5" stroke-width="1"/>` +
    `</g>` +
    `<path d="M50 11 l3.2 6 -3.2 6 -3.2 -6 z M50 89 l3.2 -6 -3.2 -6 -3.2 6 z M11 50 l6 3.2 6 -3.2 -6 -3.2 z M89 50 l-6 3.2 -6 -3.2 6 -3.2 z" fill="${ink}" opacity="0.65"/>` +
    `<text x="50" y="65.5" font-family="Georgia, 'Times New Roman', serif" font-style="italic" font-size="42" text-anchor="middle" fill="${ink}" opacity="0.92">?</text>` +
    `</svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

/* decorative fallback for icons that fail to load */
export const PLACEHOLDER_ICON =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="none" stroke="#6b7ba0" stroke-width="3" opacity="0.8"/><circle cx="50" cy="50" r="33" fill="none" stroke="#6b7ba0" stroke-width="1.4" opacity="0.6"/><text x="50" y="68" font-family="Georgia, 'Times New Roman', serif" font-style="italic" font-size="52" text-anchor="middle" fill="#6b7ba0">?</text></svg>`,
  );

/* the night sheet's own step icons, drawn to match the official set: a
   navy moon disc for dusk, a gold sun for dawn, and the ringed M and D of
   the minion/demon info steps. SVG data URLs — no font is needed, the
   letters are paths. */
function discIcon(inner, fill, ring) {
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<circle cx="50" cy="50" r="46" fill="${fill}" stroke="${ring}" stroke-width="3"/>` + inner + `</svg>`);
}
export const STEP_ICONS = {
  dusk: discIcon(
    `<path d="M62 22a31 31 0 1 0 15 47 24 24 0 0 1-15-47z" fill="#f4f0e2"/>` +
    `<circle cx="66" cy="30" r="2.6" fill="#f4f0e2"/><circle cx="76" cy="44" r="1.8" fill="#f4f0e2"/><circle cx="34" cy="70" r="1.6" fill="#f4f0e2" opacity=".8"/>`,
    '#25305f', '#151a3a'),
  dawn: discIcon(
    `<circle cx="50" cy="50" r="16" fill="#fff4cf" stroke="#b98a25" stroke-width="3"/>` +
    `<g stroke="#b98a25" stroke-width="4" stroke-linecap="round">` +
    `<path d="M50 14v11M50 75v11M14 50h11M75 50h11M24.5 24.5l7.8 7.8M67.7 67.7l7.8 7.8M24.5 75.5l7.8-7.8M67.7 32.3l7.8-7.8"/></g>`,
    '#e9c25a', '#a9791a'),
  minion: discIcon(
    `<circle cx="50" cy="50" r="38" fill="none" stroke="#1c1c1c" stroke-width="3"/>` +
    `<path d="M28 68V33h8l14 22 14-22h8v35h-8V45L50 65 36 45v23z" fill="#1c1c1c"/>`,
    '#f6f1e3', '#1c1c1c'),
  demon: discIcon(
    `<circle cx="50" cy="50" r="38" fill="none" stroke="#1c1c1c" stroke-width="3"/>` +
    `<path d="M32 68V33h15c12 0 21 7 21 17.5S59 68 47 68zm8-7h7c8 0 13-4 13-10.5S55 40 47 40h-7z" fill="#1c1c1c"/>`,
    '#f6f1e3', '#1c1c1c'),
  rule: discIcon(
    `<path d="M32 26h30l10 10v38H32z" fill="#f6f1e3" stroke="#1c1c1c" stroke-width="3"/>` +
    `<path d="M62 26v10h10" fill="none" stroke="#1c1c1c" stroke-width="3"/>` +
    `<path d="M39 46h22M39 54h22M39 62h14" stroke="#1c1c1c" stroke-width="3" stroke-linecap="round"/>`,
    '#e6dcc3', '#1c1c1c'),
  jinx: discIcon(
    `<path d="M30 34c0-6 6-10 12-8l8 4 8-4c6-2 12 2 12 8v6c0 8-8 14-20 26C38 54 30 48 30 40z" fill="#8a1d21" stroke="#4a0e10" stroke-width="3"/>` +
    `<path d="M50 30v36" stroke="#f6f1e3" stroke-width="3" stroke-linecap="round"/>`,
    '#f6f1e3', '#1c1c1c'),
};

export function normalizeTeam(t) {
  const s = String(t || '').toLowerCase().trim();
  if (s === 'traveler' || s === 'traveller') return 'traveller';
  if (s === 'fabled') return 'fabled';
  if (s === 'loric') return 'loric';
  if (s === 'outsider') return 'outsider';
  if (s === 'minion') return 'minion';
  if (s === 'demon') return 'demon';
  return 'townsfolk';
}

/* same fold as render.js's slugId — lets a jinx that names a partner by its
   display name find the partner's entry */
function slugId(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/* Official icons: the tool bundles the REAL official painted icons
   (assets/fancyscripts/icons/{id}.webp — one per roles.json id). The wiki's
   own assets/icons/ set is deliberately NOT used here: those are flat
   recreations (fine at 20px in a jinx pill, wrong on a print sheet), and the
   reference sheets this layout was calibrated against use the real art. */
export function bundledIcon(id) {
  return '/assets/fancyscripts/icons/' + id + '.webp';
}

/* Route off-site images through a resizing CORS proxy so the PNG/PDF capture
   is never tainted. The wiki's OWN art never goes through it: same-origin
   images cannot taint a canvas, and proxying them would break drafts (the
   proxy cannot see an unpublished page's art) for zero gain. Data URLs
   (uploads) never need it either. */
export function proxied(url, enabled) {
  if (!enabled) return url;
  if (!/^https?:\/\//i.test(url)) return url; // relative or data: = safe
  if (/^https?:\/\/(www\.)?botchomebrew\.wiki\//i.test(url)) {
    return url.replace(/^https?:\/\/(www\.)?botchomebrew\.wiki/i, '');
  }
  const stripped = url.replace(/^https?:\/\//i, '');
  return 'https://images.weserv.nl/?url=' + encodeURIComponent(stripped) +
    '&w=256&h=256&fit=inside&output=png';
}

/* ── official roster ─────────────────────────────────────────────────────
   Handed in once by the page: roles.json rows, this tool's
   official-jinxes.json map ({id: [{id, reason}]}) — roles.json itself
   carries no jinxes — and assets/night-order.json for the wake positions
   (roles.json carries the reminder TEXT but not the positions, exactly the
   split official-roles.js bridges for the rest of the wiki). */
let officialById = new Map();
let nightMeta = null; // [{id, firstNight, otherNight}] from night-order.json

function nameKey(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

export function setOfficialRoster(roles, jinxMap, nightOrder) {
  officialById = new Map();
  const nights = new Map();
  for (const r of (nightOrder && nightOrder.characters) || []) {
    if (r && r.name) nights.set(nameKey(r.name), r);
  }
  for (const r of roles || []) {
    const n = nights.get(nameKey(r.name)) || nights.get(nameKey(r.id)) || {};
    officialById.set(r.id, {
      id: r.id,
      name: r.name,
      team: normalizeTeam(r.team),
      ability: r.ability || '',
      jinxes: (jinxMap && jinxMap[r.id]) || [],
      firstNight: Number(n.firstNight) || 0,
      otherNight: Number(n.otherNight) || 0,
      firstNightReminder: r.firstNightReminder || '',
      otherNightReminder: r.otherNightReminder || '',
      reminders: Array.isArray(r.reminders) ? r.reminders : [],
      setup: !!r.setup,
      edition: r.edition || '',
    });
  }
  nightMeta = (nightOrder && Array.isArray(nightOrder.meta)) ? nightOrder.meta : null;
}

export function officialRole(id) {
  return officialById.get(String(id || '').toLowerCase().trim()) || null;
}

export function officialRosterSize() { return officialById.size; }

function firstImage(img) {
  if (!img) return null;
  if (Array.isArray(img)) return img[0] || null;
  return img;
}

const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };

/* parseScript(json, proxyIcons) →
     { meta: {name, author, logo, ...}, characters: [...], warnings: [...] }
   Accepts the official script-tool array: a _meta object, official ids as
   bare strings, and/or full custom character objects. Throws on anything
   that is not an array. Every character carries what every page needs: its
   night positions and reminders, its full jinx list (for the jinx page) and
   the partner icons for the ones also on this script. */
export function parseScript(json, proxyIcons) {
  const warnings = [];
  const meta = { name: 'Untitled Script', author: '' };
  if (!Array.isArray(json)) {
    throw new Error('Script JSON must be an array of character entries.');
  }

  /* pre-scan: every id and slugified name on the script, for jinx pairing.
     Wiki exports write a jinx partner as a page slug or a slugified name,
     so both are indexed. */
  const present = new Map(); // key -> raw entry object (or null for strings)
  const keysOf = (e) => {
    const ks = [];
    if (typeof e === 'string') ks.push(e.toLowerCase().trim());
    else if (e && typeof e === 'object' && e.id && e.id !== '_meta') {
      ks.push(String(e.id).toLowerCase().trim());
      if (e.name) ks.push(slugId(e.name));
    }
    return ks;
  };
  for (const e of json) {
    for (const k of keysOf(e)) if (k && !present.has(k)) present.set(k, typeof e === 'string' ? null : e);
  }

  const characters = [];

  for (const raw of json) {
    if (typeof raw === 'object' && raw !== null && raw.id === '_meta') {
      meta.name = raw.name || meta.name;
      meta.author = raw.author || '';
      meta.logo = firstImage(raw.logo) || undefined;
      meta.background = typeof raw.background === 'string' ? raw.background : undefined;
      meta.almanac = typeof raw.almanac === 'string' ? raw.almanac : undefined;
      meta.hideTitle = !!raw.hideTitle;
      meta.bootlegger = Array.isArray(raw.bootlegger)
        ? raw.bootlegger.map((s) => String(s || '').trim()).filter(Boolean) : [];
      meta.firstNight = Array.isArray(raw.firstNight)
        ? raw.firstNight.map((s) => String(s || '').toLowerCase().trim()).filter(Boolean) : null;
      meta.otherNight = Array.isArray(raw.otherNight)
        ? raw.otherNight.map((s) => String(s || '').toLowerCase().trim()).filter(Boolean) : null;
      continue;
    }

    const entry = typeof raw === 'string' ? { id: raw } : raw;
    if (!entry || !entry.id) {
      warnings.push('Skipped an entry with no id.');
      continue;
    }
    const id = String(entry.id).toLowerCase().trim();
    /* the Script Builder's credits Fabled is the export's signature, not a
       character — every importer on the wiki skips it, and so does the sheet */
    if (id === 'botchomebrewwiki') continue;
    const official = officialById.get(id);

    const team = normalizeTeam(entry.team || (official && official.team) || 'townsfolk');
    const name = entry.name || (official && official.name) || entry.id;
    const ability = entry.ability != null ? entry.ability : ((official && official.ability) || '');
    if (!official && typeof raw === 'string') {
      warnings.push('"' + raw + '" is not a known official character id — rendered as-is.');
    }

    // icon resolution: custom image > bundled official > engraved placeholder
    const customImg = firstImage(entry.image);
    let icon;
    if (customImg) icon = proxied(customImg, proxyIcons);
    else if (official) icon = bundledIcon(id);
    else icon = placeholderIconFor(team);

    // jinx partners that are also on this script
    const jinxes = entry.jinxes != null ? entry.jinxes : ((official && official.jinxes) || []);
    const jinxIcons = [];
    const jinxList = [];
    for (const j of (Array.isArray(jinxes) ? jinxes : [])) {
      if (!j || !j.id) continue;
      const pid = String(j.id).toLowerCase().trim();
      const reason = j.reason || j.text || '';
      const key = present.has(pid) ? pid : (present.has(slugId(pid)) ? slugId(pid) : null);
      if (key === null) {
        // a jinx with a character not on this script: kept for the jinx
        // page's "also jinxed with" option, never drawn beside the name
        const off = officialById.get(pid);
        jinxList.push({ id: pid, name: (off && off.name) || j.name || j.id, onScript: false,
          icon: off ? bundledIcon(pid) : placeholderIconFor('townsfolk'), team: (off && off.team) || 'townsfolk', reason });
        continue;
      }
      const pRaw = present.get(key);
      const partner = officialById.get(key);
      const pImg = firstImage(pRaw && pRaw.image);
      const pTeam = normalizeTeam((pRaw && pRaw.team) || (partner && partner.team) || 'townsfolk');
      const pIcon = pImg
        ? proxied(pImg, proxyIcons)
        : partner
          ? bundledIcon(key)
          : placeholderIconFor(pTeam);
      const pName = (pRaw && pRaw.name) || (partner && partner.name) || j.id;
      jinxIcons.push({ id: key, name: pName, icon: pIcon, reason });
      jinxList.push({ id: key, name: pName, icon: pIcon, team: pTeam, onScript: true, reason });
    }

    // night order: the entry's own numbers win; an official id falls back to
    // the official sheet. A 0 (or nothing) means the character does not wake.
    const firstNight = entry.firstNight != null ? num(entry.firstNight) : ((official && official.firstNight) || 0);
    const otherNight = entry.otherNight != null ? num(entry.otherNight) : ((official && official.otherNight) || 0);
    const firstNightReminder = entry.firstNightReminder != null
      ? String(entry.firstNightReminder) : ((official && official.firstNightReminder) || '');
    const otherNightReminder = entry.otherNightReminder != null
      ? String(entry.otherNightReminder) : ((official && official.otherNightReminder) || '');

    characters.push({
      id, name, team, ability, icon, jinxIcons, jinxList,
      isOfficial: !!official,
      firstNight, otherNight, firstNightReminder, otherNightReminder,
      reminders: Array.isArray(entry.reminders) ? entry.reminders.map(String)
        : ((official && official.reminders) || []),
      setup: entry.setup != null ? !!entry.setup : !!(official && official.setup),
      rawIcon: customImg || '',
    });
  }

  return { meta, characters, warnings };
}

/* official-style ability category for the "Official style" sort */
function abilityCategory(ability) {
  const a = String(ability).trim();
  if (/^you start knowing/i.test(a)) return 0;
  if (/^each night\*/i.test(a)) return 1;
  if (/^each night/i.test(a)) return 2;
  if (/^each day/i.test(a) || /during the day/i.test(a)) return 3;
  if (/^once per game/i.test(a)) return 4;
  if (/^(if|when) /i.test(a)) return 5;
  return 6; // pure passive
}

export function officialSort(chars) {
  return [...chars].sort((a, b) => {
    const ca = abilityCategory(a.ability);
    const cb = abilityCategory(b.ability);
    if (ca !== cb) return ca - cb;
    if (a.ability.length !== b.ability.length) return a.ability.length - b.ability.length;
    if (a.name.length !== b.name.length) return a.name.length - b.name.length;
    return a.name.localeCompare(b.name);
  });
}

/* Steven Approved Order — the wiki's own sort (assets/sao.js), handed in by
   the page so this file stays dependency-free; without it 'sao' falls back
   to the official-style sort, which is the same idea with a shorter list */
let saoCompare = null;
export function setSaoCompare(fn) { saoCompare = typeof fn === 'function' ? fn : null; }

export function sortCharacters(chars, sortMode) {
  if (sortMode === 'official') return officialSort(chars);
  if (sortMode === 'sao') return saoCompare ? [...chars].sort(saoCompare) : officialSort(chars);
  if (sortMode === 'alpha') return [...chars].sort((a, b) => a.name.localeCompare(b.name));
  return chars;
}

export function groupByTeam(chars, sortMode) {
  const sorted = sortCharacters(chars, sortMode);
  return TEAM_ORDER.map((team) => ({
    team,
    characters: sorted.filter((c) => c.team === team),
  })).filter((g) => g.characters.length > 0);
}

/* split a team's characters into two balanced columns (left gets the extra) */
export function splitColumns(items) {
  const half = Math.ceil(items.length / 2);
  return [items.slice(0, half), items.slice(half)];
}

/* ── per-character overrides ────────────────────────────────────────────
   options.chars[id] = {hidden, name, ability, icon, team, color, iconScale,
   iconDX, iconDY, order}. deriveScript() applies them to a parsed script
   and hands back a new one; the original parse is never touched, so
   clearing an override is a re-derive, not a re-parse. `resolveSrc` maps
   an 'asset:' reference to its data URL (the app's asset store). */
export function deriveScript(parsed, options, resolveSrc) {
  const ov = (options && options.chars) || {};
  const hideTeams = (options && options.hideTeams) || {};
  const res = (v) => (resolveSrc ? resolveSrc(v) : v);
  const iconOf = new Map();
  const out = [];
  for (const c of parsed.characters) {
    const o = ov[c.id] || {};
    if (o.hidden) continue;
    const team = o.team ? normalizeTeam(o.team) : c.team;
    if (hideTeams[team]) continue;
    const icon = o.icon ? res(o.icon) : (c.rawIcon ? c.icon : (c.isOfficial ? c.icon : placeholderIconFor(team)));
    const d = {
      ...c,
      team,
      icon,
      name: o.name != null && String(o.name).trim() ? String(o.name) : c.name,
      ability: o.ability != null && String(o.ability).trim() ? String(o.ability) : c.ability,
      color: o.color || '',
      iconScale: Number(o.iconScale) || 1,
      iconDX: Number(o.iconDX) || 0,
      iconDY: Number(o.iconDY) || 0,
      firstNight: o.firstNight != null && o.firstNight !== '' ? num(o.firstNight) : c.firstNight,
      otherNight: o.otherNight != null && o.otherNight !== '' ? num(o.otherNight) : c.otherNight,
      firstNightReminder: o.firstNightReminder != null && String(o.firstNightReminder).trim()
        ? String(o.firstNightReminder) : c.firstNightReminder,
      otherNightReminder: o.otherNightReminder != null && String(o.otherNightReminder).trim()
        ? String(o.otherNightReminder) : c.otherNightReminder,
      order: Number(o.order) || 0,
    };
    iconOf.set(c.id, { icon: d.icon, name: d.name, team: d.team });
    out.push(d);
  }
  // a partner's replaced art or name follows it into the jinx pills
  for (const d of out) {
    d.jinxIcons = d.jinxIcons.filter((j) => iconOf.has(j.id)).map((j) => {
      const p = iconOf.get(j.id);
      return { ...j, icon: p.icon, name: p.name };
    });
    d.jinxList = d.jinxList.map((j) => {
      const p = iconOf.get(j.id);
      return p ? { ...j, icon: p.icon, name: p.name, team: p.team, onScript: true }
        : { ...j, onScript: false };
    });
  }
  // hand-arranged order (the per-character `order` field) — stable sort so
  // untouched characters keep their file order
  if (out.some((d) => d.order)) {
    out.sort((a, b) => (a.order || 0) - (b.order || 0));
  }
  return { meta: parsed.meta, characters: out, warnings: parsed.warnings };
}

/* ── the night order ─────────────────────────────────────────────────────
   nightLists(script, nightOpts) → {first: [...], other: [...]}
   Each item: {kind: 'char'|'step', id, name, team, icon, text, n}.

   Who acts is the character's own business: it is on a list because its
   firstNight / otherNight is above zero. The ORDER is the file's when it
   carries _meta.firstNight / _meta.otherNight sequences (the official
   app's format, which the wiki writes for an arranged script) and the
   option is on; otherwise the positions sort it, with the non-character
   steps slotted in front of the first character that acts after them —
   the same rule render-page.js uses to write those sequences. */
export function nightLists(script, night) {
  const opts = night || DEFAULT_NIGHT;
  const build = (which) => {
    const field = which === 'first' ? 'firstNight' : 'otherNight';
    const remField = field + 'Reminder';
    const items = [];
    for (const c of script.characters) {
      const n = num(c[field]);
      if (n <= 0) continue;
      items.push({ kind: 'char', id: c.id, name: c.name, team: c.team, icon: c.icon,
        color: c.color || '', text: c[remField] || '', n });
    }
    const steps = [];
    if (opts.showMeta !== false) {
      for (const s of Object.values(NIGHT_STEPS)) {
        const meta = (nightMeta || []).find((m) => m.id === s.id);
        const pos = meta && meta[field] != null ? num(meta[field]) : s[field];
        if (pos == null || !isFinite(pos)) continue;
        const custom = opts.stepIcons && opts.stepIcons[s.icon];
        steps.push({ kind: 'step', id: s.id, name: s.name, team: 'step', icon: custom || STEP_ICONS[s.icon],
          text: s.text, n: pos });
      }
    }
    const seq = script.meta && script.meta[field];
    if (opts.useScriptOrder !== false && Array.isArray(seq) && seq.length) {
      const byId = new Map();
      for (const it of items) byId.set(it.id, it);
      for (const st of steps) byId.set(st.id, st);
      const out = [];
      const used = new Set();
      for (const id of seq) {
        const it = byId.get(id);
        if (it && !used.has(id)) { out.push(it); used.add(id); }
      }
      // anything the sequence left out slots in by its number, after the
      // last listed item that acts before it
      const rest = [...items, ...steps].filter((it) => !used.has(it.id)).sort((a, b) => a.n - b.n);
      for (const it of rest) {
        let at = out.length;
        for (let i = out.length - 1; i >= 0; i--) {
          if (out[i].n <= it.n) { at = i + 1; break; }
          at = i;
        }
        out.splice(at, 0, it);
      }
      return out;
    }
    items.sort((a, b) => a.n - b.n || a.name.localeCompare(b.name));
    steps.sort((a, b) => a.n - b.n);
    const out = [];
    let si = 0;
    for (const it of items) {
      while (si < steps.length && steps[si].n <= it.n) out.push(steps[si++]);
      out.push(it);
    }
    while (si < steps.length) out.push(steps[si++]);
    return out;
  };
  return { first: build('first'), other: build('other') };
}

/* reminder text → parts: plain runs, *INFO TOKEN* names (the official
   texts mark them with asterisks) and ':reminder:' token placements.
   [{t:'text', s}, {t:'token', s}, {t:'dot'}]. Unpaired asterisks stay
   literal, so a homebrew reminder that says "Each night*" is untouched. */
export function reminderParts(text) {
  const src = String(text || '');
  const out = [];
  const re = /:reminder:|\*([^*\n]{1,80}?)\*/g;
  let last = 0, m;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ t: 'text', s: src.slice(last, m.index) });
    if (m[0] === ':reminder:') out.push({ t: 'dot' });
    else out.push({ t: 'token', s: m[1] });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ t: 'text', s: src.slice(last) });
  return out;
}

/* the same text with the markers taken out, for measuring and for plain
   surfaces (a dot is a token-sized gap, a token is its own words) */
export function reminderPlain(text, dotStyle) {
  return reminderParts(text).map((p) => (p.t === 'dot' ? (dotStyle === 'none' ? '' : '●') : p.s))
    .join('').replace(/\s{2,}/g, ' ').trim();
}

/* ── presets ────────────────────────────────────────────────────────────
   Each is a patch deep-merged over the current options (applyPreset in
   app.js), so a preset changes the look and leaves the layout, the
   uploads and the per-character work alone. */
export const PRESETS = [
  { key: 'classic', name: 'Classic Navy', patch: {
    sidebarColor: SIDEBAR_BASE.hex, titleColor: '#10102e', titleStyle: 'classic',
    goodColor: '#0d6c97', evilColor: '#731d1f', neutralColor: '#7a5230',
    bg: { mode: 'parchment', brightness: 1, contrast: 1, sepia: 0, hue: 0, saturate: 1, vignette: 0 },
    sidebarMode: 'damask', labelColor: '#eeeeee', inkColor: '#222222',
    back: { bgColor: BACK_BASE.hex, bgGradient: false },
  } },
  { key: 'crimson', name: 'Crimson', patch: {
    sidebarColor: '#4a0f14', titleColor: '#3a0a0d', titleStyle: 'emboss',
    goodColor: '#1f5f8b', evilColor: '#8a1b1f', neutralColor: '#6b4a2a',
    back: { bgColor: '#5a1218' },
  } },
  { key: 'forest', name: 'Forest', patch: {
    sidebarColor: '#0f3d22', titleColor: '#0d2e1b', titleStyle: 'emboss',
    goodColor: '#1b6f5c', evilColor: '#7a2a1c', neutralColor: '#6b5a2a',
    back: { bgColor: '#1d893c' },
  } },
  { key: 'midnight', name: 'Midnight', patch: {
    sidebarColor: '#07070f', titleColor: '#0a0a14', titleStyle: 'classic',
    goodColor: '#2b5d8c', evilColor: '#7a1c1c', neutralColor: '#4d4d4d',
    bg: { mode: 'parchment', brightness: 0.92, contrast: 1.05, sepia: 0.15, hue: 0, saturate: 0.9, vignette: 0.25 },
    back: { bgColor: '#0d1230' },
  } },
  { key: 'royal', name: 'Royal Purple', patch: {
    sidebarColor: '#3a0f4a', titleColor: '#2a0b36', titleStyle: 'emboss',
    goodColor: '#2a5a9c', evilColor: '#8a1a2e', neutralColor: '#6a4a8a',
    back: { bgColor: '#3d1150' },
  } },
  { key: 'gold', name: 'Antique Gold', patch: {
    sidebarColor: '#6e5216', titleColor: '#3f2f0b', titleStyle: 'emboss',
    goodColor: '#1f5f8b', evilColor: '#7a1c1c', neutralColor: '#6b4a2a',
    bg: { mode: 'parchment', brightness: 1.03, contrast: 1, sepia: 0.25, hue: 0, saturate: 1.05, vignette: 0.1 },
    back: { bgColor: '#7a5a14' },
  } },
  { key: 'slate', name: 'Slate & Copper', patch: {
    sidebarColor: '#2b3440', titleColor: '#1f262e', titleStyle: 'emboss',
    goodColor: '#2f6f8f', evilColor: '#a0431f', neutralColor: '#7a5230',
    back: { bgColor: '#2b3440' },
  } },
  { key: 'ink', name: 'Ink Saver (plain paper)', patch: {
    bg: { mode: 'plain', color: '#ffffff', vignette: 0 },
    sidebarMode: 'flat', sidebarColor: '#e9e4d8', labelColor: '#3a3a3a',
    titleStyle: 'flat', titleColor: '#111111', titleShadow: 0,
    goodColor: '#0d5c87', evilColor: '#8a1b1f', inkColor: '#111111',
    dividerOpacity: 0.7, iconShadow: 0,
    night: { bg: { mode: 'plain', color: '#ffffff', vignette: 0 } },
    jinxPage: { bg: { mode: 'plain', color: '#ffffff', vignette: 0 } },
  } },
];

/* ── option plumbing ────────────────────────────────────────────────────── */
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/* deep merge `patch` into a clone of `base`. Arrays and non-objects are
   replaced whole; objects recurse. Keys the base does not know are kept. */
export function deepMerge(base, patch) {
  const out = isObj(base) ? { ...base } : {};
  if (!isObj(patch)) return out;
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v);
    else if (isObj(v)) out[k] = deepMerge({}, v);
    else if (Array.isArray(v)) out[k] = v.map((x) => (isObj(x) ? deepMerge({}, x) : x));
    else out[k] = v;
  }
  return out;
}

export function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

/* whatever was loaded (autosave, a design file, an older version's
   options), over the defaults — every key present, legacy keys folded */
export function normalizeOptions(o) {
  const src = isObj(o) ? o : {};
  const out = deepMerge(deepMerge({}, DEFAULT_OPTIONS), src);
  out.back = deepMerge(deepMerge({}, DEFAULT_BACK), isObj(src.back) ? src.back : {});
  if (!Array.isArray(out.back.texts)) out.back.texts = [];
  if (!Array.isArray(out.custom)) out.custom = [];
  if (!isObj(out.el)) out.el = {};
  if (!isObj(out.chars)) out.chars = {};
  // the first version's header sliders → element offsets
  const legacy = [['titleDX', 'title', 'dx'], ['titleDY', 'title', 'dy'], ['titleSize', 'title', 'scale'], ['skullDX', 'skull', 'dx'],
    ['skullDY', 'skull', 'dy'], ['skullScale', 'skull', 'scale'], ['flourishScale', 'fll', 'scale'],
    ['flourishScale', 'flr', 'scale'], ['flourishDY', 'fll', 'dy'], ['flourishDY', 'flr', 'dy']];
  for (const [k, el, f] of legacy) {
    if (src[k] != null && Number(src[k]) !== (f === 'scale' ? 1 : 0)) {
      out.el[el] = { ...(out.el[el] || {}), [f]: Number(src[k]) };
    }
    delete out[k];
  }
  if (src.flourishSpread) {
    out.el.fll = { ...(out.el.fll || {}), dx: (out.el.fll && out.el.fll.dx || 0) - Number(src.flourishSpread) };
    out.el.flr = { ...(out.el.flr || {}), dx: (out.el.flr && out.el.flr.dx || 0) + Number(src.flourishSpread) };
    delete out.flourishSpread;
  }
  if (src.includeBackCover != null) out.exportOpts.pages.back = !!src.includeBackCover;
  out.includeBackCover = out.exportOpts.pages.back;
  return out;
}

/* the effective transform of one element */
export function elGet(options, key) {
  const o = (options.el && options.el[key]) || {};
  return {
    dx: Number(o.dx) || 0,
    dy: Number(o.dy) || 0,
    scale: o.scale != null && isFinite(Number(o.scale)) ? Number(o.scale) : 1,
    rot: Number(o.rot) || 0,
    opacity: o.opacity != null && isFinite(Number(o.opacity)) ? Number(o.opacity) : 1,
    hidden: !!o.hidden,
    src: o.src || '',
  };
}

export function elSet(options, key, patch) {
  if (!options.el) options.el = {};
  options.el[key] = { ...(options.el[key] || {}), ...patch };
  return options.el[key];
}

/* the CSS transform an element gets for its offsets, rotation and scale;
   `extra` is any transform the element already carries (translate(-50%…)) */
export function elTransform(t, extra) {
  const parts = [];
  if (extra) parts.push(extra);
  if (t.rot) parts.push(`rotate(${t.rot}deg)`);
  if (t.scale !== 1) parts.push(`scale(${t.scale})`);
  return parts.join(' ');
}

/* the CSS filter for a background's adjustments ('' when untouched) */
export function bgFilter(bg) {
  const f = [];
  const b = bg || DEFAULT_BG;
  if (b.brightness != null && Number(b.brightness) !== 1) f.push(`brightness(${Number(b.brightness)})`);
  if (b.contrast != null && Number(b.contrast) !== 1) f.push(`contrast(${Number(b.contrast)})`);
  if (b.saturate != null && Number(b.saturate) !== 1) f.push(`saturate(${Number(b.saturate)})`);
  if (b.sepia) f.push(`sepia(${Number(b.sepia)})`);
  if (b.hue) f.push(`hue-rotate(${Number(b.hue)}deg)`);
  return f.join(' ');
}

/* which pages a design produces, in export order. `counts` says how many
   pages each part laid out to ({front, jinx, first, other, both} — a long
   script continues onto a second sheet, a long night onto a second page). */
export function pageList(options, counts) {
  const c = counts || {};
  const pages = [];
  const nFront = Math.max(1, c.front || 1);
  for (let i = 0; i < nFront; i++) {
    pages.push({ kind: 'front', index: i, of: nFront, label: nFront > 1 ? 'Sheet ' + (i + 1) : 'Script Sheet' });
  }
  const ni = options.night || DEFAULT_NIGHT;
  const nightPages = (which, label) => {
    const n = Math.max(1, c[which] || 1);
    for (let i = 0; i < n; i++) {
      pages.push({ kind: 'night', which, index: i, of: n, label: label + (n > 1 ? ' ' + (i + 1) : '') });
    }
  };
  if (ni.combined && (ni.first || ni.other)) {
    nightPages('both', 'Night Order');
  } else {
    if (ni.first) nightPages('first', ni.titleFirst || 'First Night');
    if (ni.other) nightPages('other', ni.titleOther || 'Other Nights');
  }
  if (options.jinxPage && options.jinxPage.enabled) {
    const n = Math.max(1, c.jinx || 1);
    for (let i = 0; i < n; i++) {
      pages.push({ kind: 'jinx', index: i, of: n, label: (options.jinxPage.title || 'Jinxes') + (n > 1 ? ' ' + (i + 1) : '') });
    }
  }
  if (options.exportOpts && options.exportOpts.pages && options.exportOpts.pages.back) {
    pages.push({ kind: 'back', index: 0, of: 1, label: 'Back Cover' });
  }
  return pages;
}

export function pageKey(p) {
  if (!p) return '';
  if (p.kind === 'front') return 'front:' + p.index;
  if (p.kind === 'night') return 'night:' + p.which + (p.index ? ':' + p.index : '');
  if (p.kind === 'jinx') return 'jinx' + (p.index ? ':' + p.index : '');
  return p.kind;
}

/* does a sticker belong on this page? `page` on a sticker is 'all', a
   page kind ('front', 'night', 'jinx', 'back') or an exact pageKey */
export function stickerOnPage(st, p) {
  const where = st.page || 'front';
  if (where === 'all') return true;
  if (where === p.kind) return true;
  return where === pageKey(p);
}
