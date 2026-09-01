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

/* The sidebar ribbon art's own colour (measured off sidebar.png: hue 243.7°,
   sat 0.62, light 0.135). The recolour filter in sheet.js works in ratios
   against these, so the picker's default IS the art untouched. */
export const SIDEBAR_BASE = { hex: '#0f0d37', h: 243.7, s: 0.62, l: 0.135 };

export const DEFAULT_OPTIONS = {
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
  texts: [],  // seeded from the script title by seedBackTexts()
};

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

export function setOfficialRoster(roles, jinxMap) {
  officialById = new Map();
  for (const r of roles || []) {
    officialById.set(r.id, {
      id: r.id,
      name: r.name,
      team: normalizeTeam(r.team),
      ability: r.ability || '',
      jinxes: (jinxMap && jinxMap[r.id]) || [],
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

    characters.push({
      id, name, team, ability, icon, jinxIcons,
      isOfficial: !!official,
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

export function groupByTeam(chars, sortMode) {
  const sorted = sortMode === 'official' ? officialSort(chars) : chars;
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
