/* Fancy Scripts ("The Grimoire Press") — the engine.
 *
 * Turns official script-tool JSON into the data the sheet renderer draws:
 * parsing, team grouping, sorting, typography and the calibrated sheet
 * geometry. Ported from the handoff's React + TypeScript app to plain ES
 * modules — the wiki has no build step and no framework.
 *
 * No DOM access anywhere in this file: it is data + string work, checkable
 * with `node --input-type=module --check`. The official roster is handed in
 * through setOfficialRoster() (roles.json + this tool's official-jinxes.json),
 * never fetched here — same contract as official-roles.js.
 *
 * EVERY number in SHEET is calibration. The whole layout was reverse-measured
 * from an official-style reference render ("Harold Holt's Revenge", 1080×1440)
 * as fractions of the sheet, then re-trued against the generator family's own
 * CSS (JohnForster/botc-fancy-script-generator). Vertical unit: 1 em = 1% of
 * sheet height; horizontal positions are % of sheet width. Change one value
 * at a time and compare against a known-good render — nothing in here is a
 * guess, including the ones that look like one (see the handoff notes in the
 * repo history of that project).
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
};

/* CSS pixel size of the rendered sheet (3:4, matching the reference trim
   595.57 × 794.05 pt) and the em unit in px. */
export const SHEET_W = 1242;
export const SHEET_H = Math.round(SHEET_W * SHEET.ratio); // 1656
export const U = SHEET_H / 100;
/* reference trim in PDF points, for the PDF page size */
export const TRIM_W_PT = 595.57;
export const TRIM_H_PT = 794.05;

/* ── the two styles ──────────────────────────────────────────────────────
   'classic' is the 3:4 fancy-script sheet above. 'teensy' is the owner's
   "No Greater Joy" PSD (1500×2100, a 5:7 trim — see TEENSY below). Every
   piece of geometry the page needs to know about a style comes from
   sheetSize(): the CSS pixel size the sheet is built at, and the PDF page
   it prints to (A4 width for the teensy trim, so a 5:7 sheet lands on a
   familiar page). The back cover takes the same trim as its front. */
export function sheetSize(mode) {
  if (mode === 'teensy') {
    return { w: TEENSY.w, h: TEENSY.h, trimW: 595.28, trimH: 833.39 };
  }
  return { w: SHEET_W, h: SHEET_H, trimW: TRIM_W_PT, trimH: TRIM_H_PT };
}

/* The sidebar ribbon art's own colour (measured off sidebar.png: hue 243.7°,
   sat 0.62, light 0.135). The recolour filter in sheet.js works in ratios
   against these, so the picker's default IS the art untouched. */
export const SIDEBAR_BASE = { hex: '#0f0d37', h: 243.7, s: 0.62, l: 0.135 };

/* The teensy ribbons' own colour (measured off the PSD's purple side bands
   after their gradient/paper/stroke effects: hue 285.1°, sat 0.55,
   light 0.326) — same job as SIDEBAR_BASE for the classic strip. */
export const TEENSY_RIBBON_BASE = { hex: '#6a2581', h: 285.1, s: 0.552, l: 0.326 };

/* The colours a style starts from. Switching style swaps a colour ONLY when
   it still reads the other style's default — a colour the person picked by
   hand stays (applyModeColors). The teensy set is read straight off the
   PSD: the title gradient's light stop, the TOWNSFOLK and DEMON headings. */
export const MODE_COLORS = {
  classic: { titleColor: '#10102e', goodColor: '#0d6c97', evilColor: '#731d1f', sidebarColor: SIDEBAR_BASE.hex },
  teensy: { titleColor: '#a132de', goodColor: '#0064ac', evilColor: '#d00000', sidebarColor: TEENSY_RIBBON_BASE.hex },
};

export function applyModeColors(options, from, to) {
  if (from === to) return;
  for (const key of Object.keys(MODE_COLORS[to])) {
    const cur = String(options[key] || '').toLowerCase();
    if (cur === MODE_COLORS[from][key].toLowerCase()) options[key] = MODE_COLORS[to][key];
  }
}

/* ── the teensy template ────────────────────────────────────────────────
   Measured off the owner's PSD ("nogreaterjoy.psd", 1500×2100 px), in the
   PSD's own pixels — the sheet is built at exactly that size, so every
   number here is a coordinate you can check against the file. Layer
   positions are the art's bounding boxes; type positions are the text
   layers' boxes; sizes are the text layers' font size × their transform.

   The character grid comes in three densities in the PSD — three columns
   for the townsfolk, two for outsiders and minions, one big row for the
   demon — and `grid` carries each one's icon size, text inset, name and
   ability sizes and row pitch. The sheet picks the column count per team
   (see teensy.js) and everything scales together under the density solve. */
export const TEENSY = {
  w: 1500,
  h: 2100,
  // the side ribbons: the art is 100 px wide at each edge; its ink stops
  // 96 px in, and the content grid clears it
  ribbonArtW: 100,
  contentLeft: 106,
  contentRight: 1400,
  contentTop: 480, // first heading's top (TOWNSFOLK's text box)
  contentBottom: 2020, // last row must end above this (footnote at 2046)
  // team heading: OptimusPrinceps 50, left at x 116, a 5 px rule from the
  // word's end to the right ribbon through the text's middle. The rows
  // start `rowsFrom` under the heading's top (text top 480 → first name
  // top 598, with the icon reaching up into that gap), and the next
  // heading follows the last row by `sectionGap` (1026 → 1074).
  headingX: 116,
  headingSize: 50,
  headingH: 50, // the heading's own band
  headingRule: 5,
  rowsFrom: 70, // rows start this far under the heading's top
  sectionGap: 48,
  // the demon section: a full-width 7 px rule with the heading centred ON
  // it (DEMON 1652–1708 over the rule at 1679–1686), rows 100 px under the
  // heading's top, and a shorter gap in front of it (1650 → 1652)
  demonHeadingSize: 72,
  demonRule: 7,
  demonGap: 30,
  demonRowsFrom: 100,
  // the title stack (NO / Greater / JOY): LHF Unlovable, centred at x 604
  // beside the clock; centred on the page when nothing sits to its right.
  // The PSD's words are 141 / 144 / 179 px and fill 415..792 × 14..467.
  // (top is the first word's line box, not its ink: LHF's cap swashes
  // reach up to ~0.3 em above it — a T's flourish more than an N's — so
  // the box starts lower than the PSD's ink at 14 to keep every title on
  // the sheet)
  title: { cx: 604, cxAlone: 750, top: 48, maxW: 400, maxH: 418, size: 190, pitch: 0.66 },
  // the clock art / the script's logo: a 384×390 box centred at (981, 271)
  logo: { cx: 981, cy: 271, w: 400, h: 392 },
  // night strips on the ribbons: label (2 lines of OptimusPrinceps 25),
  // the moon, one icon per waking character, the sun
  strip: {
    leftCX: 49, rightCX: 1452,
    labelTop: 651, labelSize: 25, labelLine: 25,
    moon: 84, icon: 72, pitch: 84, sun: 66,
    minTop: 470, // never above the top corner art
    leftLimit: 1670, rightLimit: 1495, // the bottom corner art starts here
  },
  // corner flourishes: [left, top, width, height] of each PNG
  corners: { tl: [0, 0, 470, 445], tr: [1125, 0, 375, 425], bl: [0, 1685, 295, 415], br: [1258, 1508, 242, 512] },
  footnote: { right: 1379, baseline: 2079, size: 43 },
  // Row heights are the TEXT block's pitch (the PSD's icons are taller than
  // their rows and reach into the gaps around them — the Drunk's tankard is
  // 257 px tall in a row whose text runs 205): 3-col names 598 → 837 apart,
  // the 2-col outsider text 1153..1358, the Imp's 1778..1970.
  // The PSD's text starts INSIDE its icons' boxes (the Investigator's
  // magnifier reaches under "You start knowing…" because its handle points
  // away) — a hand-laid liberty a layout cannot take, so here the text
  // clears the icon box, whose ink the normalization fills to ~88%.
  grid: {
    1: { icon: 262, iconLeft: 117, textLeft: 380, textRight: 80, name: 92, ability: 42, row: 205 },
    2: { icon: 236, iconLeft: 0, textLeft: 244, textRight: 20, name: 50, ability: 33, row: 215 },
    3: { icon: 164, iconLeft: 0, textLeft: 170, textRight: 10, name: 34, ability: 25, row: 238 },
    4: { icon: 122, iconLeft: 0, textLeft: 127, textRight: 6, name: 27, ability: 20, row: 200 },
  },
  abilityLine: 1.2, // Helvetica leading 50/41.67
};

export const DEFAULT_OPTIONS = {
  mode: 'classic', // 'classic' (the fancy script sheet) | 'teensy' (the PSD template)
  sortMode: 'script', // 'script' (as in the JSON) | 'official' (ability-shape sort)
  columnLayout: 'even', // 'even' (both columns fill the section, official style)
  //                       | 'shared' (classic: col 2 staggered under the title)
  showJinxes: true,
  showFootnote: true,
  titleOverride: '',
  authorOverride: '',
  titleColor: '#10102e',
  goodColor: '#0d6c97',
  evilColor: '#731d1f',
  sidebarColor: SIDEBAR_BASE.hex,
  // how much of the parchment frame's shading is laid over the ribbon.
  // 0 = a solid, even strip (the default); 1 = the old baked-in blend,
  // which puts a strong left-to-right lightness ramp through it.
  sidebarShade: 0,
  density: 1, // used when fitToContent is off
  fitToContent: true, // auto-scale the grid to fill the page
  iconSize: 1,
  textSize: 1,
  nameSize: 1,
  titleSize: 1,
  titleDX: 0, // % width
  titleDY: 0, // em
  skullScale: 1,
  skullDX: 0,
  skullDY: 0,
  flourishScale: 1,
  flourishSpread: 0, // % width, positive = further apart
  flourishDY: 0,
  proxyIcons: true, // route off-site images through a CORS proxy so export never taints
  includeBackCover: true,
  useLogo: true, // render _meta.logo as the title when present
  showAuthor: true, // "by <author>" credit under the title
  // one colour for the sidebar/ribbon, the title and the back cover: while
  // this is on, picking any of the three moves all three
  linkColors: false,
  // the script's bootlegger rules (_meta.bootlegger) in a box at the top
  // right of the sheet. The text is editable ON the sheet; '' means "the
  // script's own rules", anything else is what was typed there.
  bootleggerBox: false,
  bootleggerText: '',
  bootleggerSize: 1,
  // "7–15 players": '' = worked out from the roster (playersGuess)
  players: '',
  showPlayersFront: false, // the line on the front sheet (under the credit / at the first rule)
  // the Minion Info / Demon Info steps on the night lists. Reset from the
  // roster on load: a teensyville (5–6 players) has neither.
  nightInfoSteps: true,
  // teensy style only
  clockArt: true, // the template's clock beside the title (when there is no logo)
  cornerArt: true, // the watercolour corner flourishes
  nightStrips: true, // the night-order icon strips on the ribbons
  townsfolkCols: 0, // 0 = automatic (3, or 4 for a big roster), else 2–4
  // the PSD sets its short title words in capitals (NO / Greater / JOY):
  // a first or last word of up to three letters is set that way too
  titleCapsShort: true,
};

/* the teams a back-cover box has taken off the front sheet */
export function backTeams(options) {
  const b = options.back || {};
  const out = [];
  if (b.travellers) out.push('traveller');
  if (b.fabled) out.push('fabled');
  if (b.loric) out.push('loric');
  return out;
}

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
  texts: [],  // seeded from the script title by seedBackTexts()
  // the boxes drawn on the back under the title — each one is a panel on
  // the damask (see back.js): the player count, the night order as icon
  // strips (moon → icons → sun, like the template's ribbons), and whole
  // teams moved off the front sheet
  playersBox: false, // the official setup table (players 5..15+ × team counts)
  nightOrder: false, // the night order down BOTH edges, like the reference sheets
  nightNames: false, // names beside the night-order icons
  nightBacking: false, // a parchment panel behind each night strip
  travellers: false,
  fabled: false,
  loric: false,
  // one size slider per element, so a strip, the table and the team boxes
  // can each be tuned without moving the others
  nightScale: 1,
  playersScale: 1,
  panelScale: 1, // the team boxes' text and icon size
  panelTop: 30, // % of height where the centre boxes start (the title sits above)
};

export function backHasPanels(back) {
  return !!(back && (back.playersBox || back.nightOrder || back.travellers || back.fabled || back.loric));
}

const BACK_SMALL_WORDS = new Set(['of', 'the', 'a', 'an', 'and', 'in', 'on', 'to', 'at', '&', 'or']);

/* One element per word, stacked and staggered like the template (Axiom /
   of / Logic): connector words small and offset right, the rest large,
   sizes shrunk until the tallest word fits the width and the stack fits
   the page. Pure — the page hands the result to options.back.texts.
   `size` is the sheet the back is drawn at ({w, h}); `compact` stacks the
   title in the top band instead of the middle, for a back that carries
   panels under it. */
export function seedBackTexts(title, size, compact, widthFrac) {
  const W = (size && size.w) || 1242;
  const H = (size && size.h) || 1656;
  // how much of the width the stack may take: less when night strips run
  // down the edges, so a wide word does not land on them
  const band = widthFrac || 0.88;
  const words = String(title || '').trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!words.length) words.push('Untitled');
  const rows = words.map((w) => ({ text: w, small: BACK_SMALL_WORDS.has(w.toLowerCase()) }));
  // base sizes from the template: big ≈ 31–37% of width, small ≈ 22%
  let big = (rows.length <= 3 ? 400 : rows.length <= 5 ? 330 : 260) * (W / 1242);
  if (compact) big *= 0.55;
  const bandH = compact ? H * 0.26 : H * 0.62;
  const sizeOf = (r) => Math.min(
    r.small ? big * 0.58 : big,
    // LHF Unlovable advances ≈ 0.43 em — keep every word inside the page
    (W * band) / (0.43 * Math.max(2, r.text.length)),
  );
  // overlapping stack like the template (pitch ≈ 0.62 of the glyph size)
  let total = rows.reduce((n, r) => n + sizeOf(r) * 0.62, 0);
  if (total > bandH) big *= bandH / total;
  const heights = rows.map((r) => sizeOf(r) * 0.62);
  total = heights.reduce((a, b) => a + b, 0);
  const centreY = compact ? 15 : 46;
  let y = centreY - ((total / H) * 100) / 2;
  const stagger = [-2, 4, 2, -3, 3, -2, 2, 0];
  return rows.map((r, i) => {
    const h = (heights[i] / H) * 100;
    y += h;
    return {
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
    };
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

function normalizeTeam(t) {
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
   proxy cannot see an unpublished page's art) for zero gain. */
export function proxied(url, enabled) {
  if (!enabled) return url;
  if (!/^https?:\/\//i.test(url)) return url; // relative = same-origin
  if (/^https?:\/\/(www\.)?botchomebrew\.wiki\//i.test(url)) {
    return url.replace(/^https?:\/\/(www\.)?botchomebrew\.wiki/i, '');
  }
  const stripped = url.replace(/^https?:\/\//i, '');
  return 'https://images.weserv.nl/?url=' + encodeURIComponent(stripped) +
    '&w=256&h=256&fit=inside&output=png';
}

/* ── official roster ─────────────────────────────────────────────────────
   Handed in once by the page: roles.json rows plus this tool's
   official-jinxes.json map ({id: [{id, reason}]}) — roles.json itself
   carries no jinxes. */
let officialById = new Map();
/* the non-character night steps (dusk, minion info, demon info, dawn) with
   their positions, from night-order.json's `meta` */
let nightMeta = [];

/* `nightOrder` is assets/night-order.json — the official night positions
   keyed by NAME (roles.json carries none), folded to the roles' ids through
   the same slugId fold ("Fortune Teller" → fortuneteller). Without it every
   official character sits at 0 and the night strips come out empty. */
export function setOfficialRoster(roles, jinxMap, nightOrder) {
  officialById = new Map();
  const nightByKey = new Map();
  for (const c of (nightOrder && nightOrder.characters) || []) {
    nightByKey.set(slugId(c.name), { first: Number(c.firstNight) || 0, other: Number(c.otherNight) || 0 });
  }
  nightMeta = ((nightOrder && nightOrder.meta) || []).map((m) => ({
    id: String(m.id), first: Number(m.firstNight), other: Number(m.otherNight),
  }));
  for (const r of roles || []) {
    const night = nightByKey.get(r.id) || nightByKey.get(slugId(r.name)) || { first: 0, other: 0 };
    officialById.set(r.id, {
      id: r.id,
      name: r.name,
      team: normalizeTeam(r.team),
      ability: r.ability || '',
      jinxes: (jinxMap && jinxMap[r.id]) || [],
      firstNight: night.first,
      otherNight: night.other,
    });
  }
}

function firstImage(img) {
  if (!img) return null;
  if (Array.isArray(img)) return img[0] || null;
  return img;
}

/* parseScript(json, proxyIcons) →
     { meta: {name, author, logo}, characters: [...], warnings: [...] }
   Accepts the official script-tool array: a _meta object, official ids as
   bare strings, and/or full custom character objects. Throws on anything
   that is not an array. */
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
      // house rules, and the owner's arranged night order (lists of ids,
      // dusk/dawn/minioninfo/demoninfo included — the botc-release schema)
      meta.bootlegger = (Array.isArray(raw.bootlegger) ? raw.bootlegger : [])
        .map((r) => String(r || '').trim()).filter(Boolean);
      meta.nightFirst = Array.isArray(raw.firstNight) ? raw.firstNight.map((x) => String(x).toLowerCase()) : null;
      meta.nightOther = Array.isArray(raw.otherNight) ? raw.otherNight.map((x) => String(x).toLowerCase()) : null;
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
    for (const j of jinxes) {
      if (!j || !j.id) continue;
      const pid = String(j.id).toLowerCase().trim();
      const key = present.has(pid) ? pid : (present.has(slugId(pid)) ? slugId(pid) : null);
      if (key === null) continue;
      const pRaw = present.get(key);
      const partner = officialById.get(key);
      const pImg = firstImage(pRaw && pRaw.image);
      jinxIcons.push({
        id: key,
        name: (pRaw && pRaw.name) || (partner && partner.name) || j.id,
        icon: pImg
          ? proxied(pImg, proxyIcons)
          : partner
            ? bundledIcon(key)
            : placeholderIconFor(normalizeTeam((pRaw && pRaw.team) || 'townsfolk')),
        reason: j.reason || j.text || '',
      });
    }

    // night positions: the entry's own numbers, else the official sheet's
    const nightNum = (v, off) => {
      const n = Number(v);
      if (v != null && isFinite(n)) return n;
      return off || 0;
    };
    const firstNight = nightNum(entry.firstNight, official && official.firstNight);
    const otherNight = nightNum(entry.otherNight, official && official.otherNight);

    characters.push({
      id, name, team, ability, icon, jinxIcons,
      isOfficial: !!official,
      firstNight, otherNight,
    });
  }

  if (!meta.bootlegger) meta.bootlegger = [];
  return { meta, characters, warnings };
}

/* ── the night order ────────────────────────────────────────────────────
   nightLists(script, infoSteps) → { first: [item], other: [item] }, each
   item {kind, id, name, icon, char?}: kind 'dusk' | 'dawn' | 'minioninfo' |
   'demoninfo' | 'char'. Dusk opens and dawn closes both lists (the moon and
   the sun on the strips); the two info steps sit where the official sheet
   puts them, and only when asked (a teensyville has neither).

   The owner's arranged order (_meta.firstNight / otherNight, lists of ids)
   wins when the file carries one — matched on the id as written, then on
   the slugified name, so a wiki export's qualified ids and a hand-written
   file both resolve. A waking character the list forgot is slotted in by
   its own number rather than dropped. Without a list, the characters' own
   numbers decide. */
export const NIGHT_ICONS = {
  dusk: '/assets/fancyscripts/art/teensy-moon.png',
  dawn: '/assets/fancyscripts/art/teensy-sun.png',
  minioninfo: '/assets/icons/minion.png',
  demoninfo: '/assets/icons/demon.png',
};
const NIGHT_NAMES = { dusk: 'Dusk', dawn: 'Dawn', minioninfo: 'Minion info', demoninfo: 'Demon info & bluffs' };

export function nightLists(script, infoSteps) {
  const build = (which) => {
    const field = which === 'first' ? 'firstNight' : 'otherNight';
    const metaField = which === 'first' ? 'first' : 'other';
    const wakers = script.characters.filter((c) => Number(c[field]) > 0);
    const step = (id) => ({ kind: id, id, name: NIGHT_NAMES[id] || id, icon: NIGHT_ICONS[id] });
    const wantStep = (id) => id === 'dusk' || id === 'dawn' || (infoSteps && (id === 'minioninfo' || id === 'demoninfo'));
    const seq = which === 'first' ? script.meta.nightFirst : script.meta.nightOther;
    let items = [];
    if (seq && seq.length) {
      const byId = new Map();
      for (const c of wakers) {
        byId.set(c.id, c);
        if (!byId.has(slugId(c.name))) byId.set(slugId(c.name), c);
      }
      const placed = new Set();
      for (const id of seq) {
        if (wantStep(id)) { items.push(step(id)); continue; }
        const c = byId.get(id) || byId.get(slugId(id));
        if (!c || placed.has(c)) continue;
        placed.add(c);
        items.push({ kind: 'char', id: c.id, name: c.name, icon: c.icon, char: c, n: c[field] });
      }
      // anything the list forgot goes in by its own number
      const missing = wakers.filter((c) => !placed.has(c)).sort((a, b) => a[field] - b[field]);
      for (const c of missing) {
        const it = { kind: 'char', id: c.id, name: c.name, icon: c.icon, char: c, n: c[field] };
        let at = items.findIndex((x) => x.kind === 'char' && x.n > c[field]);
        if (at < 0) at = items.findIndex((x) => x.kind === 'dawn');
        if (at < 0) items.push(it); else items.splice(at, 0, it);
      }
      if (!items.some((x) => x.kind === 'dusk')) items.unshift(step('dusk'));
      if (!items.some((x) => x.kind === 'dawn')) items.push(step('dawn'));
    } else {
      const marks = nightMeta
        .map((m) => ({ id: m.id, n: m[metaField] }))
        .filter((m) => isFinite(m.n) && wantStep(m.id))
        .sort((a, b) => a.n - b.n);
      const sorted = [...wakers].sort((a, b) => a[field] - b[field] || a.name.localeCompare(b.name));
      let mi = 0;
      for (const c of sorted) {
        while (mi < marks.length && marks[mi].n <= c[field]) items.push(step(marks[mi++].id));
        items.push({ kind: 'char', id: c.id, name: c.name, icon: c.icon, char: c, n: c[field] });
      }
      while (mi < marks.length) items.push(step(marks[mi++].id));
      if (!items.some((x) => x.kind === 'dusk')) items.unshift(step('dusk'));
      if (!items.some((x) => x.kind === 'dawn')) items.push(step('dawn'));
    }
    return items;
  };
  return { first: build('first'), other: build('other') };
}

/* ── player count ───────────────────────────────────────────────────────
   A teensyville is 6 townsfolk, 2 outsiders, 2 minions, 1 demon (or
   fewer) and seats 5–6; anything bigger is a 7–15 script. Travellers,
   fabled and loric never count. */
export function isTeensyville(chars) {
  const n = (team) => chars.filter((c) => c.team === team).length;
  return n('townsfolk') <= 6 && n('outsider') <= 2 && n('minion') <= 2 && n('demon') <= 1
    && n('townsfolk') + n('outsider') + n('minion') + n('demon') > 0;
}

export function playersGuess(chars) {
  return isTeensyville(chars) ? '5–6 players' : '7–15 players';
}

export function playersText(script, options) {
  const typed = String(options.players || '').trim();
  return typed || playersGuess(script.characters);
}

/* the bootlegger rules to print: what was typed on the sheet, else the
   script's own */
export function bootleggerRules(script, options) {
  const typed = String(options.bootleggerText || '');
  if (typed.trim()) return typed.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return (script.meta.bootlegger || []).slice();
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

/* `exclude` names teams the sheet must leave out (the ones a back-cover box
   has taken — see backTeams) */
export function groupByTeam(chars, sortMode, exclude) {
  const sorted = sortMode === 'official' ? officialSort(chars) : chars;
  const skip = new Set(exclude || []);
  return TEAM_ORDER.filter((t) => !skip.has(t)).map((team) => ({
    team,
    characters: sorted.filter((c) => c.team === team),
  })).filter((g) => g.characters.length > 0);
}

/* split a team's characters into two balanced columns (left gets the extra) */
export function splitColumns(items) {
  const half = Math.ceil(items.length / 2);
  return [items.slice(0, half), items.slice(half)];
}
