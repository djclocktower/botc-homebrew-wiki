/* Fancy Scripts — the page controller.
 *
 * Owns everything around the pages: loading a script (a published wiki
 * script, an uploaded/pasted JSON, a sample), the option controls, the
 * page tabs, the scaled preview with its drag layer, undo/redo, autosave,
 * design files, uploads (images, fonts, per-character icons) and the
 * PNG/JPEG/PDF export. The pages themselves are sheet.js (the script
 * sheet), night.js (night order + jinx pages) and back.js (the back
 * cover); parsing, the option model and geometry are script.js.
 *
 * State is the truth and the DOM is a view of it: every control writes
 * into `options` and asks for a render, and render() rebuilds the current
 * page from scratch (a full build is a few milliseconds — cheap enough to
 * run per input event behind one rAF). Dragging is the one exception and
 * patches the live node until release (see drag.js).
 *
 * Uploaded files live in the ASSET STORE (a Map of id → data URL) and are
 * referenced from the options as 'asset:<id>', so an undo snapshot is a
 * few KB of JSON rather than a megabyte of PNG; the design file and the
 * autosave carry the store alongside.
 *
 * The export libraries (html-to-image, jspdf — assets/fancyscripts/vendor/)
 * are lazy-loaded on the first export, so an ordinary visit costs nothing.
 */

import {
  DEFAULT_OPTIONS, DEFAULT_BACK, DEFAULT_NIGHT, DEFAULT_JINX, DEFAULT_BG, PAGE_FORMATS, SHEET, SHEET_W, SHEET_H, U,
  FONTS, PRESETS, ELEMENTS, ELEMENT_BY_KEY, EL_DEFAULT, TEAM_ORDER, TEAM_NAMES,
  parseScript, setOfficialRoster, setSaoCompare, seedBackTexts, deriveScript, normalizeOptions, deepMerge, clone,
  pageList, pageKey, stickerOnPage, elGet, elSet, newTextElement, newImageElement, fontLabel,
} from './script.js';
import { layoutSheet, renderSheetPage, fitTitle } from './sheet.js';
import { buildNightSpec, buildJinxSpec, layoutList, renderListPage, fitListPage } from './night.js';
import { renderBack, backCanvas, backReady } from './back.js';
import { setAssetResolver } from './elements.js';
import { mountDrag, snapTo } from './drag.js';
import { fontsChanged, hexToRgb, rgbToHex, hslToHex, clamp } from './util.js';
import { pixelWorkerActive } from './jobs.js';

const $ = (id) => document.getElementById(id);

/* ── state ── */
let options = normalizeOptions({});
let rawJson = null;
let sourceLabel = '';
let scriptKey = '';
let parsed = { meta: { name: 'Untitled Script', author: '' }, characters: [], warnings: [] };
let derived = parsed;
let currentKey = 'front:0'; // which page the preview shows
let pages = [];
let selectedId = ''; // the selected draggable ('el:title', 'custom:x', 'back:2')
let lastScale = 1; // preview scale, for mapping drag pointer px to sheet px
let zoom = 'fit'; // 'fit' | number
let charSel = ''; // the character the Characters panel edits
let dragStart = null; // model values captured when a drag begins

/* the asset store */
const assets = new Map();
let assetSeq = 1;
function addAsset(dataUrl) {
  const id = 'a' + (assetSeq++).toString(36) + Math.random().toString(36).slice(2, 6);
  assets.set(id, dataUrl);
  return 'asset:' + id;
}
function resolveAsset(ref) {
  const s = String(ref || '');
  return s.startsWith('asset:') ? (assets.get(s.slice(6)) || '') : s;
}
setAssetResolver(resolveAsset);

/* uploaded fonts: family → data URL (registered as @font-face rules in a
   <style>, which is what lets html-to-image embed them in an export —
   a FontFace object added by script is invisible to it) */
const uploadedFonts = new Map();
function registerFont(family, dataUrl) {
  if (uploadedFonts.has(family)) return;
  uploadedFonts.set(family, dataUrl);
  const st = document.createElement('style');
  st.dataset.fsFont = family;
  st.textContent = `@font-face { font-family: "${family.replace(/["\\]/g, '')}"; src: url("${dataUrl}"); font-display: block; }`;
  document.head.append(st);
  document.fonts.load(`16px "${family}"`).then(() => { fontsChanged(); requestRender(); }).catch(() => {});
}

/* ── samples ── */
const SAMPLE_TROUBLE_BREWING = [
  { id: '_meta', name: 'Trouble Brewing', author: 'The Pandemonium Institute' },
  'washerwoman', 'librarian', 'investigator', 'chef', 'empath', 'fortuneteller',
  'undertaker', 'monk', 'ravenkeeper', 'virgin', 'slayer', 'soldier', 'mayor',
  'butler', 'drunk', 'recluse', 'saint',
  'poisoner', 'spy', 'scarletwoman', 'baron', 'imp',
];

/* The calibration reference sheet ("Harold Holt's Revenge") — a Sects & Violets
   era teensyville the whole layout was measured against. The {id, ability}
   overrides carry the exact wording of the reference render (its author's JSON
   used "and" where the official text uses "&"), so this demo wraps like it. */
const SAMPLE_HAROLD_HOLT = [
  { id: '_meta', name: "Harold Holt's Revenge", author: '' },
  'librarian', 'investigator', 'shugenja', 'balloonist',
  { id: 'dreamer', ability: 'Each night, choose a player (not yourself or Travellers): you learn 1 good and 1 evil character, 1 of which is correct.' },
  { id: 'snakecharmer', ability: 'Each night, choose an alive player: a chosen Demon swaps characters and alignments with you and is then poisoned.' },
  'towncrier', 'slayer',
  { id: 'savant', ability: 'Each day, you may visit the Storyteller to learn 2 things in private: 1 is true and 1 is false.' },
  'amnesiac', 'seamstress',
  { id: 'courtier', ability: 'Once per game, at night, choose a character: they are drunk for 3 nights and 3 days.' },
  'magician', 'mutant',
  { id: 'lunatic', ability: 'You think you are a Demon, but you are not. The Demon knows who you are and who you choose at night.' },
  'damsel',
  { id: 'politician', ability: 'If you were the player most responsible for your team losing, you change alignment and win, even if dead.' },
  { id: 'cerenovus', ability: 'Each night, choose a player and a good character: they are “mad” they are this character tomorrow, or might be executed.' },
  'baron', 'marionette',
  { id: 'pithag', ability: 'Each night*, choose a player and a character they become (if not in play). If a Demon is made, deaths tonight are arbitrary.' },
  { id: 'goblin', ability: 'If you publicly claim to be the Goblin when nominated and are executed that day, your team wins.' },
  'leviathan',
];

/* the night-order reference roster ("Blending In") — every step on the
   owner's reference night sheets, so the night pages can be checked
   against them line by line */
const SAMPLE_BLENDING_IN = [
  { id: '_meta', name: 'Blending In', author: '' },
  'boffin', 'magician', 'pixie', 'librarian', 'steward', 'bountyhunter', 'highpriestess', 'chambermaid',
  'farmer', 'undertaker', 'towncrier', 'seamstress', 'juggler', 'nightwatchman',
  'damsel', 'xaan', 'poisoner', 'scarletwoman', 'imp',
];

/* ── messages ── */
function note(text, kind) {
  const box = $('fs-note');
  box.textContent = text || '';
  box.className = 'fs-note' + (kind ? ' fs-note-' + kind : '');
  box.hidden = !text;
}

function showWarnings(list) {
  const box = $('fs-warnings');
  box.textContent = '';
  box.hidden = !list.length;
  for (const w of list) {
    const p = document.createElement('p');
    p.textContent = '• ' + w;
    box.append(p);
  }
}

function toast(text) {
  const t = $('fs-toast');
  if (!t) return;
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2200);
}

/* ── option paths ── */
function getPath(path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), options);
}
function setPath(path, value) {
  const keys = path.split('.');
  let o = options;
  for (let i = 0; i < keys.length - 1; i++) {
    if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
}

/* ── history (undo / redo) ── */
const history = { stack: [], idx: -1, max: 80 };
let lastSnapshot = '';
function snapshot() { return JSON.stringify(options); }
function pushHistory() {
  const s = snapshot();
  if (s === lastSnapshot) return;
  history.stack = history.stack.slice(0, history.idx + 1);
  history.stack.push(s);
  if (history.stack.length > history.max) history.stack.shift();
  history.idx = history.stack.length - 1;
  lastSnapshot = s;
  updateHistoryButtons();
  scheduleAutosave();
}
function restoreSnapshot(s) {
  options = normalizeOptions(JSON.parse(s));
  lastSnapshot = s;
  afterOptionsReplaced();
}
function undo() {
  if (history.idx <= 0) return;
  history.idx--;
  restoreSnapshot(history.stack[history.idx]);
  updateHistoryButtons();
  toast('Undone');
}
function redo() {
  if (history.idx >= history.stack.length - 1) return;
  history.idx++;
  restoreSnapshot(history.stack[history.idx]);
  updateHistoryButtons();
  toast('Redone');
}
function updateHistoryButtons() {
  if ($('fs-undo')) $('fs-undo').disabled = history.idx <= 0;
  if ($('fs-redo')) $('fs-redo').disabled = history.idx >= history.stack.length - 1;
}

/* everything that has to happen when `options` is swapped wholesale
   (undo, a preset, a loaded design, a restored autosave) */
function afterOptionsReplaced() {
  syncControls();
  buildElementPanel();
  buildCharPanel();
  buildBackPanel();
  requestRender();
  scheduleAutosave();
}

/* a discrete change that should be undoable */
function commit() {
  pushHistory();
  requestRender();
}

/* ── render loop (one rAF, coalescing) ── */
let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function reparse() {
  if (rawJson == null) return;
  try {
    parsed = parseScript(rawJson, options.proxyIcons);
    note('');
    showWarnings(parsed.warnings);
  } catch (e) {
    note(e && e.message ? e.message : 'Could not parse that JSON.', 'err');
  }
}

/* stickers for a page, and the drag id of the selection if it is one */
function stickersFor(p) {
  return (options.custom || []).filter((st) => stickerOnPage(st, p));
}

/* layouts are recomputed per render; the ones the tabs need for page
   counts are kept from the same pass */
let layouts = {};
function computeLayouts() {
  derived = deriveScript(parsed, options, resolveAsset);
  layouts = {};
  layouts.front = layoutSheet(derived, options, requestRender);
  const counts = { front: layouts.front.pages.length };
  if (options.jinxPage.enabled) {
    layouts.jinxSpec = buildJinxSpec(derived, options);
    layouts.jinx = layoutList(layouts.jinxSpec, options, requestRender);
    counts.jinx = layouts.jinx.pages.length;
  }
  const ni = options.night;
  if (ni.combined && (ni.first || ni.other)) {
    layouts.bothSpec = buildNightSpec(derived, options, 'both');
    layouts.both = layoutList(layouts.bothSpec, options, requestRender);
    counts.both = 1;
  } else {
    if (ni.first) {
      layouts.firstSpec = buildNightSpec(derived, options, 'first');
      layouts.first = layoutList(layouts.firstSpec, options, requestRender);
      counts.first = layouts.first.pages.length;
    }
    if (ni.other) {
      layouts.otherSpec = buildNightSpec(derived, options, 'other');
      layouts.other = layoutList(layouts.otherSpec, options, requestRender);
      counts.other = layouts.other.pages.length;
    }
  }
  pages = pageList(options, counts);
}

function currentPage() {
  return pages.find((p) => pageKey(p) === currentKey) || pages[0];
}

/* build one page's element. `ctx.forExport` renders without selection */
function renderPageNode(p, ctx) {
  ctx = { requestRender, selected: ctx && ctx.forExport ? '' : selectedId, stickers: stickersFor(p), ...(ctx || {}) };
  if (p.kind === 'front') return renderSheetPage(derived, options, layouts.front, p.index, ctx);
  if (p.kind === 'jinx') return renderListPage(derived, layouts.jinxSpec, options, layouts.jinx, p.index, ctx);
  if (p.kind === 'night') {
    const lay = layouts[p.which], spec = layouts[p.which + 'Spec'];
    return renderListPage(derived, spec, options, lay, p.index, ctx);
  }
  return renderBack(derived, options, requestRender, { selected: ctx.selected, stickers: ctx.stickers, forExport: ctx.forExport });
}

let lastTabsSig = '';
function render() {
  computeLayouts();
  if (!pages.some((p) => pageKey(p) === currentKey)) {
    // the page being shown went away (a night sheet unticked, a script
    // that now fits one sheet): fall back and rebuild the panel for it
    currentKey = pageKey(pages[0]);
    selectedId = '';
    buildElementPanel();
  }
  const sig = pages.map((p) => pageKey(p) + '=' + p.label).join('|') + '#' + currentKey;
  if (sig !== lastTabsSig) { buildTabs(); lastTabsSig = sig; showCardsFor(currentPage().kind); }
  const p = currentPage();
  if (p.kind === 'back') seedBackColor();
  const wrap = $('fs-sheet-wrap');
  wrap.textContent = '';
  const node = renderPageNode(p, {});
  wrap.append(node);
  if (p.kind === 'front') fitTitle(node, options);
  else if (p.kind !== 'back') fitListPage(node);
  showSolvedDensity(node, p);
  fitPreview();
  updateSelectionInfo();
}

/* ── tabs ── */
function buildTabs() {
  const box = $('fs-tabs');
  box.textContent = '';
  for (const p of pages) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fs-tab' + (pageKey(p) === currentKey ? ' on' : '');
    b.textContent = p.label;
    b.setAttribute('role', 'tab');
    b.addEventListener('click', () => {
      currentKey = pageKey(p);
      selectedId = '';
      buildElementPanel();
      requestRender();
    });
    box.append(b);
  }
}

/* control cards carry data-fs-for="front|night|jinx|back|all" */
function showCardsFor(kind) {
  document.querySelectorAll('.fs-card[data-fs-for]').forEach((card) => {
    const f = card.dataset.fsFor.split(' ');
    card.hidden = !(f.includes('all') || f.includes(kind));
  });
}

/* One-time colour handoff: the first time the back cover is actually shown
   (tabbing over — or a PDF export rendering it unseen), its background
   colour is copied from the sidebar ribbon so the two sides match. Once
   only: later sidebar changes never overwrite the back colour again. */
let backColorSeeded = false;
function seedBackColor() {
  if (backColorSeeded) return;
  backColorSeeded = true;
  if (options.sidebarColor && options.sidebarColor !== options.back.bgColor && options.back.bgColor === DEFAULT_BACK.bgColor) {
    options.back.bgColor = options.sidebarColor;
    buildBackPanel(); // the picker has to show the colour it now holds
  }
}

/* ── preview scale + zoom ── */
function fitPreview() {
  const box = $('fs-preview');
  const outer = $('fs-scale-box');
  const wrap = $('fs-sheet-wrap');
  let fitScale = Math.min(1, (box.clientWidth - 12) / SHEET_W);
  // on desktop the preview column is sticky and scrolls inside itself, so
  // "fit" means the whole page in view once the column is stuck: the box
  // then sits at the column's sticky top plus the tabs and toolbar above
  // it. Measured that way (never from the box's current place on screen)
  // so the answer is the same before and after the reader scrolls.
  if (window.innerWidth > 940) {
    const col = box.closest('.fs-preview-col');
    const within = col ? box.getBoundingClientRect().top - col.getBoundingClientRect().top : 0;
    const stuckTop = 70 + within;
    const maxH = Math.max(320, window.innerHeight - stuckTop - 44);
    fitScale = Math.min(fitScale, maxH / SHEET_H);
  }
  const scale = zoom === 'fit' ? fitScale : clamp(Number(zoom), 0.1, 3);
  lastScale = scale;
  outer.style.width = SHEET_W * scale + 'px';
  outer.style.height = SHEET_H * scale + 'px';
  wrap.style.transform = 'scale(' + scale + ')';
  const zv = $('fs-zoom-val');
  if (zv) zv.textContent = (zoom === 'fit' ? 'fit · ' : '') + Math.round(scale * 100) + '%';
}

function setZoom(z) {
  zoom = z;
  fitPreview();
}

/* ── loading scripts ── */
function keyFor(json, slug) {
  if (slug) return 'wiki:' + slug;
  const meta = Array.isArray(json) && json.find((e) => e && e.id === '_meta');
  return 'name:' + ((meta && meta.name) || 'untitled');
}

function loadJson(json, label, slug, keepDesign) {
  rawJson = json;
  sourceLabel = label || '';
  scriptKey = keyFor(json, slug);
  reparse();
  if (!keepDesign) {
    // a fresh script gets fresh overrides — the old title would stick otherwise
    options.titleOverride = '';
    options.authorOverride = '';
    options.chars = {};
    options.back.texts = seedBackTexts(parsed.meta.name);
    backColorSeeded = false;
  }
  selectedId = '';
  charSel = '';
  history.stack = []; history.idx = -1; lastSnapshot = '';
  pushHistory();
  syncControls();
  buildCharPanel();
  buildBackPanel();
  buildElementPanel();
  requestRender();
  if (label) note('Loaded ' + label + '.', 'ok');
}

function loadFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const json = JSON.parse(String(reader.result));
      if (json && json.app === 'fancyscripts' && json.options) { loadDesign(json); return; }
      loadJson(json, file.name);
    } catch {
      note('That file is not valid JSON.', 'err');
    }
  };
  reader.readAsText(file);
}

/* a published script (type 'script', by slug) or collection (type
   'collection', by its kebab id) — both come through /api/page-json, the
   same export their Download JSON buttons save */
async function loadWikiScript(slug, keepDesign, type) {
  const t = type === 'collection' ? 'collection' : 'script';
  note('Loading ' + t + '…');
  try {
    const r = await fetch('/api/page-json?type=' + t + '&slug=' + encodeURIComponent(slug));
    if (!r.ok) throw new Error('Could not load that ' + t + ' (HTTP ' + r.status + ').');
    loadJson(await r.json(), 'the ' + t + ' from this wiki', (t === 'collection' ? 'c:' : '') + slug, keepDesign);
  } catch (e) {
    note(e && e.message ? e.message : 'Could not load that ' + t + '.', 'err');
  }
}

/* the picker: every published script and collection on the wiki, by name */
async function fillScriptPicker(preselect) {
  const sel = $('fs-wiki-script');
  const group = (label) => {
    const g = document.createElement('optgroup');
    g.label = label;
    sel.append(g);
    return g;
  };
  try {
    const [scripts, colls] = await Promise.all([
      fetch('/scripts.json').then((r) => r.json()).catch(() => []),
      fetch('/collections.json').then((r) => r.json()).catch(() => []),
    ]);
    scripts.sort((a, b) => String(a.name || a.slug).localeCompare(String(b.name || b.slug)));
    const gs = group('Scripts');
    for (const s of scripts) {
      if (!s.slug) continue;
      const o = document.createElement('option');
      o.value = 'script:' + s.slug;
      o.textContent = (s.name || s.slug) + (s.author ? ' — ' + s.author : '');
      gs.append(o);
    }
    colls.sort((a, b) => String(a.displayName || a.id).localeCompare(String(b.displayName || b.id)));
    const gc = group('Collections');
    for (const c of colls) {
      const key = c.id || c.slug;
      if (!key) continue;
      const o = document.createElement('option');
      o.value = 'collection:' + key;
      o.textContent = (c.displayName || key) + (c.author ? ' — ' + c.author : '');
      gc.append(o);
    }
    if (preselect) sel.value = preselect;
  } catch {
    // the picker is a convenience; upload/paste still work without it
  }
}

/* ── autosave ── */
const AUTOSAVE_KEY = 'botc_fancy_v2';
let autosaveTimer = null;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(autosave, 900);
}
function designObject(includeScript) {
  const o = { v: 2, app: 'fancyscripts', key: scriptKey, options, assets: Object.fromEntries(assets), fonts: Object.fromEntries(uploadedFonts) };
  if (includeScript) { o.script = rawJson; o.sourceLabel = sourceLabel; }
  return o;
}
function autosave() {
  if (rawJson == null) return;
  const full = designObject(true);
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(full));
  } catch {
    // over quota (uploads are big): keep the design without the files
    try {
      const slim = { ...full, assets: {}, fonts: {} };
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(slim));
    } catch { /* storage unavailable — nothing to do */ }
  }
}
function readAutosave() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    return d && d.app === 'fancyscripts' ? d : null;
  } catch { return null; }
}
function clearAutosave() {
  try { localStorage.removeItem(AUTOSAVE_KEY); } catch { /* ignore */ }
}

/* ── design files ── */
function applyDesignData(d) {
  assets.clear();
  for (const [k, v] of Object.entries(d.assets || {})) assets.set(k, v);
  for (const [fam, url] of Object.entries(d.fonts || {})) registerFont(fam, url);
  options = normalizeOptions(d.options || {});
}
function loadDesign(d) {
  applyDesignData(d);
  if (d.script) {
    loadJson(d.script, d.sourceLabel || 'the design file', d.key && d.key.startsWith('wiki:') ? d.key.slice(5) : '', true);
  } else {
    afterOptionsReplaced();
  }
  buildFontSelects();
  note('Design loaded.', 'ok');
}
function saveDesign() {
  const d = designObject(true);
  const blob = new Blob([JSON.stringify(d)], { type: 'application/json' });
  downloadBlob(blob, exportName('fancy.json', ''));
  toast('Design saved');
}

/* ── controls ──
   Every control is built from get/set closures so the same builders serve
   the fixed option paths and the per-element/per-character panels. Each
   registers a refresh() in `bindings`; syncControls() pushes state back
   into the inputs (after Reset, undo, loading). */
const bindings = new Set();
const pct = (v) => Math.round(v * 100) + '%';
const signed = (dp, unit) => (v) => (v > 0 ? '+' : '') + Number(v).toFixed(dp) + (unit || '');
const fmtPx = (v) => Math.round(v) + 'px';
const fmtDeg = (v) => (v > 0 ? '+' : '') + Math.round(v) + '°';
const fmtEm = (v) => Number(v).toFixed(2) + 'em';
const fmtNum = (dp) => (v) => Number(v).toFixed(dp);

function bindPath(path) {
  return { get: () => getPath(path), set: (v) => setPath(path, v) };
}

function makeSlider(parent, label, min, max, step, format, b, extra) {
  const row = document.createElement('div');
  row.className = 'fs-slider';
  const head = document.createElement('div');
  head.className = 'fs-slider-head';
  const name = document.createElement('span');
  name.textContent = label;
  const val = document.createElement('span');
  val.className = 'fs-slider-val';
  head.append(name, val);
  const input = document.createElement('input');
  input.type = 'range';
  input.min = min; input.max = max; input.step = step;
  const refresh = () => {
    const v = b.get();
    input.value = v == null ? (extra && extra.fallback != null ? extra.fallback : min) : v;
    val.textContent = format(Number(input.value));
  };
  input.addEventListener('input', () => {
    if (extra && extra.onInput) extra.onInput();
    b.set(Number(input.value));
    val.textContent = format(Number(input.value));
    requestRender();
  });
  input.addEventListener('change', () => { pushHistory(); if (extra && extra.onChange) extra.onChange(); });
  // double-click the label to reset
  if (extra && extra.reset != null) {
    head.title = 'Double-click to reset';
    head.style.cursor = 'pointer';
    head.addEventListener('dblclick', () => { b.set(extra.reset); refresh(); commit(); });
  }
  row.append(head, input);
  parent.append(row);
  const binding = { refresh, el: row };
  bindings.add(binding);
  refresh();
  return binding;
}

function makeToggle(parent, label, b, extra) {
  const lab = document.createElement('label');
  lab.className = 'fs-toggle';
  const input = document.createElement('input');
  input.type = 'checkbox';
  const refresh = () => { input.checked = !!b.get(); };
  input.addEventListener('change', () => {
    b.set(input.checked);
    if (extra && extra.onChange) extra.onChange(input.checked);
    commit();
  });
  const span = document.createElement('span');
  span.textContent = label;
  lab.append(input, span);
  parent.append(lab);
  const binding = { refresh, el: lab };
  bindings.add(binding);
  refresh();
  return binding;
}

function makeSelect(parent, label, choices, b, extra) {
  const row = document.createElement('div');
  row.className = 'fs-row-between';
  const name = document.createElement('span');
  name.className = 'fs-lab';
  name.textContent = label;
  const sel = document.createElement('select');
  sel.className = 'fs-select';
  sel.style.width = 'auto';
  sel.style.maxWidth = '62%';
  const fill = () => {
    sel.textContent = '';
    for (const [v, text] of (typeof choices === 'function' ? choices() : choices)) {
      const o = document.createElement('option');
      o.value = v; o.textContent = text;
      sel.append(o);
    }
  };
  fill();
  const refresh = () => { if (extra && extra.dynamic) fill(); sel.value = String(b.get() == null ? '' : b.get()); };
  sel.addEventListener('change', () => {
    b.set(sel.value);
    if (extra && extra.onChange) extra.onChange(sel.value);
    commit();
  });
  row.append(name, sel);
  parent.append(row);
  const binding = { refresh, el: row, sel };
  bindings.add(binding);
  refresh();
  return binding;
}

function makeText(parent, label, b, extra) {
  const input = document.createElement(extra && extra.multiline ? 'textarea' : 'input');
  if (!(extra && extra.multiline)) input.type = 'text';
  input.className = 'fs-field';
  input.placeholder = label;
  input.setAttribute('aria-label', label);
  if (extra && extra.multiline) input.rows = extra.rows || 3;
  const refresh = () => { input.value = b.get() == null ? '' : String(b.get()); };
  let timer = null;
  input.addEventListener('input', () => {
    b.set(input.value);
    if (extra && extra.onInput) extra.onInput(input.value);
    requestRender();
    clearTimeout(timer);
    timer = setTimeout(pushHistory, 500);
  });
  parent.append(input);
  const binding = { refresh, el: input };
  bindings.add(binding);
  refresh();
  return binding;
}

function makeColor(parent, label, b, extra) {
  const row = document.createElement('div');
  row.className = 'fs-color';
  const picker = createColorPicker(b.get() || (extra && extra.fallback) || '#000000', (hex) => {
    b.set(hex);
    requestRender();
  }, () => pushHistory());
  const span = document.createElement('span');
  span.textContent = label;
  row.append(picker.root, span);
  if (extra && extra.clearable) {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'fs-mini';
    x.textContent = '×';
    x.title = 'Use the default colour';
    x.addEventListener('click', () => { b.set(''); picker.set(extra.fallback || '#000000'); commit(); });
    row.append(x);
  }
  parent.append(row);
  const refresh = () => { picker.set(String(b.get() || (extra && extra.fallback) || '#000000')); };
  const binding = { refresh, el: row };
  bindings.add(binding);
  return binding;
}

function makeButton(parent, label, fn, cls) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fs-btn' + (cls ? ' ' + cls : '');
  btn.textContent = label;
  btn.addEventListener('click', fn);
  parent.append(btn);
  return btn;
}

function makeRow(parent, cls) {
  const row = document.createElement('div');
  row.className = cls || 'fs-btn-row';
  parent.append(row);
  return row;
}

function makeLabel(parent, text) {
  const s = document.createElement('span');
  s.className = 'fs-lab';
  s.textContent = text;
  parent.append(s);
  return s;
}

function makeHint(parent, text) {
  const p = document.createElement('p');
  p.className = 'fs-hint';
  p.textContent = text;
  parent.append(p);
  return p;
}

/* a font select with the built-in faces and every uploaded one */
const fontSelects = new Set();
function fontChoices() {
  const out = FONTS.map((f) => [f[0], f[1]]);
  for (const fam of uploadedFonts.keys()) out.push(['upload:' + fam, fam + ' (uploaded)']);
  return out;
}
function makeFont(parent, label, b) {
  const binding = makeSelect(parent, label, fontChoices, b, { dynamic: true });
  fontSelects.add(binding);
  return binding;
}
function buildFontSelects() {
  for (const bnd of fontSelects) bnd.refresh();
}

/* an upload button: reads the file and hands back a data URL (images are
   shrunk to a sane size first — a 12 MP phone photo is 30 MB of base64) */
function makeUpload(parent, label, accept, onData, cls) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.hidden = true;
  const btn = makeButton(parent, label, () => input.click(), cls);
  parent.append(input);
  input.addEventListener('change', async () => {
    const f = input.files && input.files[0];
    input.value = '';
    if (!f) return;
    try {
      if (accept.startsWith('image')) onData(await readImageFile(f), f);
      else onData(await readAsDataURL(f), f);
    } catch (e) {
      note('Could not read that file.', 'err');
    }
  });
  return btn;
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('read failed'));
    r.readAsDataURL(file);
  });
}

const UPLOAD_MAX_PX = 2000;
async function readImageFile(file) {
  const url = await readAsDataURL(file);
  if (/svg/i.test(file.type) || /gif/i.test(file.type)) return url;
  const im = new Image();
  await new Promise((res, rej) => { im.onload = res; im.onerror = rej; im.src = url; });
  const w = im.naturalWidth, h = im.naturalHeight;
  if (!w || !h) return url;
  const k = Math.min(1, UPLOAD_MAX_PX / Math.max(w, h));
  if (k === 1 && file.size < 2.5e6) return url;
  const c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
  const jpeg = /jpe?g/i.test(file.type);
  return c.toDataURL(jpeg ? 'image/jpeg' : 'image/png', 0.9);
}

function syncControls() {
  for (const b of bindings) { try { b.refresh(); } catch { /* a detached control */ } }
}

/* ── colour picker ──────────────────────────────────────────────────────
   Hand-rolled: a saturation/value square, a hue slider and a hex box in a
   little popover. Exists because <input type="color"> on Android Chrome is
   a grid of ~20 preset swatches with no free choice at all — the one place
   the owner actually reviews from. */
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return { h, s: mx ? d / mx : 0, v: mx };
}
function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

const RECENT_COLORS = [];
function rememberColor(hex) {
  const i = RECENT_COLORS.indexOf(hex);
  if (i >= 0) RECENT_COLORS.splice(i, 1);
  RECENT_COLORS.unshift(hex);
  if (RECENT_COLORS.length > 10) RECENT_COLORS.pop();
}

let openPickerClose = null; // at most one popover open at a time

function createColorPicker(initial, onChange, onDone) {
  const root = document.createElement('div');
  root.className = 'fs-cp';
  const swatch = document.createElement('button');
  swatch.type = 'button';
  swatch.className = 'fs-cp-swatch';
  swatch.setAttribute('aria-label', 'Pick a colour');
  const pop = document.createElement('div');
  pop.className = 'fs-cp-pop';
  pop.hidden = true;
  const sv = document.createElement('div');
  sv.className = 'fs-cp-sv';
  const dot = document.createElement('div');
  dot.className = 'fs-cp-dot';
  sv.append(dot);
  const hue = document.createElement('input');
  hue.type = 'range';
  hue.className = 'fs-cp-hue';
  hue.min = 0; hue.max = 360; hue.step = 1;
  const row = document.createElement('div');
  row.className = 'fs-cp-row';
  const hex = document.createElement('input');
  hex.type = 'text';
  hex.className = 'fs-cp-hex';
  hex.spellcheck = false;
  hex.autocapitalize = 'off';
  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'fs-cp-done';
  done.textContent = 'Done';
  row.append(hex, done);
  const recent = document.createElement('div');
  recent.className = 'fs-cp-recent';
  pop.append(sv, hue, row, recent);
  root.append(swatch, pop);

  const state = rgbToHsv(...(hexToRgb(initial) || [16, 16, 46]));

  const current = () => rgbToHex(...hsvToRgb(state.h, state.s, state.v));
  const paint = (skipHex) => {
    const c = current();
    swatch.style.background = c;
    sv.style.backgroundColor = 'hsl(' + Math.round(state.h) + ', 100%, 50%)';
    dot.style.left = (state.s * 100) + '%';
    dot.style.top = ((1 - state.v) * 100) + '%';
    hue.value = state.h;
    if (!skipHex) hex.value = c;
  };
  const paintRecent = () => {
    recent.textContent = '';
    for (const c of RECENT_COLORS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fs-cp-chip';
      b.style.background = c;
      b.title = c;
      b.addEventListener('click', () => {
        Object.assign(state, rgbToHsv(...hexToRgb(c)));
        emit();
      });
      recent.append(b);
    }
  };
  const emit = (skipHex) => { paint(skipHex); onChange(current()); };

  const svPick = (ev) => {
    const r = sv.getBoundingClientRect();
    state.s = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
    state.v = Math.min(1, Math.max(0, 1 - (ev.clientY - r.top) / r.height));
    emit();
  };
  sv.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    sv.setPointerCapture(ev.pointerId);
    svPick(ev);
  });
  sv.addEventListener('pointermove', (ev) => {
    if (sv.hasPointerCapture(ev.pointerId)) svPick(ev);
  });
  sv.addEventListener('pointerup', () => { if (onDone) onDone(); });
  hue.addEventListener('input', () => {
    state.h = Number(hue.value);
    emit();
  });
  hue.addEventListener('change', () => { if (onDone) onDone(); });
  hex.addEventListener('input', () => {
    const rgb = hexToRgb(hex.value);
    if (rgb) {
      Object.assign(state, rgbToHsv(...rgb));
      emit(true); // keep the half-typed text as the user wrote it
    }
  });
  hex.addEventListener('change', () => { if (onDone) onDone(); });

  const close = () => {
    pop.hidden = true;
    document.removeEventListener('pointerdown', onOutside, true);
    if (openPickerClose === close) openPickerClose = null;
    rememberColor(current());
    if (onDone) onDone();
  };
  const onOutside = (ev) => { if (!root.contains(ev.target)) close(); };
  swatch.addEventListener('click', () => {
    if (!pop.hidden) return close();
    if (openPickerClose) openPickerClose();
    openPickerClose = close;
    paint();
    paintRecent();
    pop.hidden = false;
    // keep the popover on screen for swatches near the right edge
    pop.style.left = '0';
    pop.style.right = 'auto';
    const pr = pop.getBoundingClientRect();
    if (pr.right > document.documentElement.clientWidth - 4) {
      pop.style.left = 'auto';
      pop.style.right = '0';
    }
    document.addEventListener('pointerdown', onOutside, true);
  });
  done.addEventListener('click', close);

  paint();
  return {
    root,
    set(hexValue) {
      const rgb = hexToRgb(hexValue);
      if (rgb) Object.assign(state, rgbToHsv(...rgb));
      paint();
    },
  };
}

/* while auto-fit is on, the density slider tracks the density it solved
   for — so the thumb is honest, and dragging it takes over from there */
let densityBinding = null;
let nightDensityBinding = null;
let jinxDensityBinding = null;
function showSolvedDensity(node, p) {
  const solved = Number(node.dataset.fsDensity);
  if (!solved) return;
  const show = (bnd, on) => {
    if (!bnd || !on) return;
    const input = bnd.el.querySelector('input');
    const val = bnd.el.querySelector('.fs-slider-val');
    input.value = solved;
    val.textContent = 'auto · ' + pct(solved);
  };
  if (p.kind === 'front') show(densityBinding, options.fitToContent);
  if (p.kind === 'night') show(nightDensityBinding, options.night.fit !== false);
  if (p.kind === 'jinx') show(jinxDensityBinding, options.jinxPage.fit !== false);
}

/* ── the fixed cards ─────────────────────────────────────────────────── */
function buildPagesCard() {
  const box = $('fs-pages-box');
  makeToggle(box, 'First Night sheet', bindPath('night.first'));
  makeToggle(box, 'Other Nights sheet', bindPath('night.other'));
  makeToggle(box, 'Both nights on one page (two columns)', bindPath('night.combined'));
  makeToggle(box, 'Jinxes & house rules page', bindPath('jinxPage.enabled'));
  makeToggle(box, 'Back cover', { get: () => options.exportOpts.pages.back, set: (v) => { options.exportOpts.pages.back = v; options.includeBackCover = v; } });
  makeHint(box, 'Ticked pages get a tab above the preview and a page in the PDF.');

  makeLabel(box, 'Look');
  const row = makeRow(box, 'fs-row-between');
  const sel = document.createElement('select');
  sel.className = 'fs-select';
  for (const p of PRESETS) {
    const o = document.createElement('option');
    o.value = p.key; o.textContent = p.name;
    sel.append(o);
  }
  row.append(sel);
  makeButton(row, 'Apply', () => applyPreset(sel.value));
  makeButton(row, 'Shuffle', shuffleColors);
  makeHint(box, 'A look changes colours and backgrounds; your layout, uploads and character edits stay. Shuffle rolls a fresh ribbon, title and back-cover colour family.');

  makeLabel(box, 'Design');
  const r2 = makeRow(box);
  makeButton(r2, 'Save design file', saveDesign);
  makeUpload(r2, 'Load design file', '.json,application/json', (_, file) => loadFile(file));
  makeButton(r2, 'Reset everything', () => {
    if (!confirm('Reset every setting for this script? Uploads are removed too.')) return;
    options = normalizeOptions({});
    options.back.texts = seedBackTexts(parsed.meta.name);
    assets.clear();
    backColorSeeded = false;
    commit();
    afterOptionsReplaced();
    buildFontSelects();
  });
  makeHint(box, 'Your work autosaves in this browser and comes back on the next visit. A design file carries the script, every setting and every upload — share it or keep it.');
}

/* a random colour family: one hue for the ribbon, title and back cover,
   with the good/evil inks nudged to sit well beside it */
function shuffleColors() {
  const h = Math.floor(Math.random() * 360);
  const s2 = 0.45 + Math.random() * 0.35;
  options.sidebarColor = hslToHex(h, s2, 0.13 + Math.random() * 0.12);
  options.titleColor = hslToHex(h, Math.min(0.8, s2 + 0.1), 0.1 + Math.random() * 0.08);
  options.titleStyle = 'emboss';
  options.back.bgColor = hslToHex((h + (Math.random() < 0.5 ? 0 : 180)) % 360, s2, 0.22 + Math.random() * 0.12);
  backColorSeeded = true;
  commit();
  afterOptionsReplaced();
  toast('New colours rolled — undo to go back');
}

function applyPreset(key) {
  const p = PRESETS.find((x) => x.key === key);
  if (!p) return;
  options = normalizeOptions(deepMerge(options, p.patch));
  if (p.patch.back && p.patch.back.bgColor) backColorSeeded = true;
  commit();
  afterOptionsReplaced();
  toast(p.name + ' applied');
}

function buildTitleCard() {
  const box = $('fs-title-box');
  makeText(box, 'Title (blank = the script’s own)', bindPath('titleOverride'), {
    onInput: (v) => { /* the back cover's words follow a retitle only via Reset layout */ },
  });
  makeText(box, 'Author (blank = the script’s own)', bindPath('authorOverride'));
  makeText(box, 'Credit prefix (“by ”)', bindPath('authorPrefix'));
  makeToggle(box, 'Show the title band (title, author, skull, flourishes)', bindPath('showHeader'));
  makeToggle(box, 'Use the script’s logo image as the title', bindPath('useLogo'));
  makeToggle(box, 'Author credit under the title', bindPath('showAuthor'));
  makeToggle(box, 'Skull', bindPath('showSkull'));
  makeToggle(box, 'Flourishes', bindPath('showFlourishes'));
  makeToggle(box, 'Slide the skull and flourishes in to meet a short title', bindPath('hugDecor'));
  makeSelect(box, 'Title style', [['classic', 'Classic (indigo emboss)'], ['emboss', 'Emboss from the title colour'],
    ['gradient', 'Two-colour gradient'], ['flat', 'Flat colour']], bindPath('titleStyle'));
  const colors = makeRow(box, 'fs-colors');
  makeColor(colors, 'Title', bindPath('titleColor'));
  makeColor(colors, 'Gradient 2nd', bindPath('titleColor2'));
  makeColor(colors, 'Bronze offset', bindPath('titleShadowColor'));
  makeSlider(box, 'Offset shadow strength', 0, 3, 0.05, fmtNum(2), bindPath('titleShadow'), { reset: 1 });
  makeFont(box, 'Title font', bindPath('fontTitle'));
  makeText(box, 'Footnote text (blank = “*Not the first night”)', bindPath('footnoteText'));
}

function buildLayoutCard() {
  const box = $('fs-layout-box');
  makeSelect(box, 'Character order', [['script', 'As in the script'], ['official', 'Official style'],
    ['sao', 'Steven Approved Order'], ['alpha', 'Alphabetical']], bindPath('sortMode'));
  makeSelect(box, 'Columns', [['even', 'Two, even (official)'], ['shared', 'Two, classic (col 2 under the title)'], ['single', 'One wide column']],
    bindPath('columnLayout'));
  makeToggle(box, 'Auto-fit text to fill the page', bindPath('fitToContent'), { onChange: () => syncControls() });
  makeToggle(box, 'Continue onto a second sheet when the script is too long', bindPath('paginate'));
  makeToggle(box, 'Title band on every sheet', bindPath('repeatHeader'));
  makeToggle(box, 'Page numbers on a multi-sheet script', bindPath('showPageNumbers'));
  makeToggle(box, 'Jinx icons beside names', bindPath('showJinxes'));
  makeToggle(box, '“*Not the first night” footnote', bindPath('showFootnote'));
  makeToggle(box, 'Team labels on the ribbon', bindPath('showLabels'));
  makeToggle(box, 'Character counts in the team labels', bindPath('labelCounts'));
  makeToggle(box, 'Section dividers', bindPath('showDividers'));
  makeToggle(box, 'Even out icon sizes (ink normalisation)', bindPath('normalizeIcons'));
  makeToggle(box, 'Route off-site icons through a proxy (safer export)', bindPath('proxyIcons'), { onChange: () => reparse() });
  densityBinding = makeSlider(box, 'Text density', 0.5, 1.5, 0.01, pct, bindPath('density'), {
    // touching the density slider IS choosing manual density — a disabled
    // slider just read as broken, so auto-fit unticks itself instead
    onInput: () => { if (options.fitToContent) { options.fitToContent = false; syncControls(); } },
    reset: 1,
  });
  makeSlider(box, 'Smallest auto-fit before a second sheet', 0.4, 1, 0.01, pct, bindPath('minFit'), { reset: 0.62 });
  makeSlider(box, 'Icon size', 0.6, 1.6, 0.01, pct, bindPath('iconSize'), { reset: 1 });
  makeSlider(box, 'Text size', 0.7, 1.4, 0.01, pct, bindPath('textSize'), { reset: 1 });
  makeSlider(box, 'Name size', 0.6, 1.5, 0.01, pct, bindPath('nameSize'), { reset: 1 });
  makeSlider(box, 'Jinx icon size', 0.5, 2, 0.01, pct, bindPath('jinxIconSize'), { reset: 1 });
  makeSlider(box, 'Ability line spacing', 0.8, 1.5, 0.01, pct, bindPath('abilityLine'), { reset: 1 });
  makeSlider(box, 'Name letter spacing', -0.05, 0.2, 0.005, fmtEm, bindPath('nameSpacing'), { reset: 0.02 });
  makeSlider(box, 'Column text width', 0.7, 1.15, 0.01, pct, bindPath('columnWidth'), { reset: 1 });
  makeSlider(box, 'Team label size', 0.5, 1.6, 0.01, pct, bindPath('labelSize'), { reset: 1 });
  makeSlider(box, 'Team label spacing', -0.3, 0.3, 0.01, fmtEm, bindPath('labelSpacing'), { reset: -0.15 });
  makeSlider(box, 'Divider strength', 0, 1, 0.01, pct, bindPath('dividerOpacity'), { reset: 1 });
  makeSlider(box, 'Icon shadow', 0, 2, 0.05, fmtNum(2), bindPath('iconShadow'), { reset: 1 });
  makeSelect(box, 'Icon effect', [['none', 'None'], ['vivid', 'Vivid'], ['sepia', 'Sepia'], ['grayscale', 'Grayscale'],
    ['engraved', 'Engraved (ink)']], bindPath('iconEffect'));
  makeSelect(box, 'Icon backing', [['none', 'None'], ['disc', 'Parchment token'], ['ring', 'Ring']], bindPath('iconFrame'));
  makeSelect(box, 'Name style', [['normal', 'As written'], ['smallcaps', 'Small caps'], ['upper', 'CAPITALS']], bindPath('nameCase'));
  makeSelect(box, 'Ability alignment', [['left', 'Left'], ['justify', 'Justified']], bindPath('abilityAlign'));
  makeSelect(box, 'Setup notes [+2 Outsiders]', [['plain', 'Plain'], ['italic', 'Italic'], ['bold', 'Bold'], ['muted', 'Muted']], bindPath('bracketStyle'));
  makeLabel(box, 'Hide a whole team');
  const hide = makeRow(box, 'fs-colors');
  for (const t of TEAM_ORDER) makeToggle(hide, TEAM_NAMES[t], { get: () => options.hideTeams[t], set: (v) => { options.hideTeams[t] = v; } });
  makeLabel(box, 'Team labels (blank = the official wording)');
  for (const t of TEAM_ORDER) makeText(box, TEAM_NAMES[t], { get: () => options.teamLabels[t], set: (v) => { options.teamLabels[t] = v; } });
}

function buildColorsCard() {
  const box = $('fs-colors-box');
  const main = makeRow(box, 'fs-colors');
  makeColor(main, 'Good names', bindPath('goodColor'));
  makeColor(main, 'Evil names', bindPath('evilColor'));
  makeColor(main, 'Travellers / Loric', bindPath('neutralColor'));
  makeColor(main, 'Ability text', bindPath('inkColor'));
  makeColor(main, 'Author', bindPath('authorColor'));
  makeColor(main, 'Team labels', bindPath('labelColor'));
  makeColor(main, 'Footnote', bindPath('footnoteColor'));
  makeLabel(box, 'Per team (× = follow good/evil)');
  const teams = makeRow(box, 'fs-colors');
  for (const t of TEAM_ORDER) {
    makeColor(teams, TEAM_NAMES[t], { get: () => options.teamColors[t], set: (v) => { options.teamColors[t] = v; } },
      { clearable: true, fallback: t === 'minion' || t === 'demon' ? options.evilColor : t === 'townsfolk' || t === 'outsider' ? options.goodColor : options.neutralColor });
  }
  makeLabel(box, 'Sidebar ribbon');
  makeSelect(box, 'Ribbon', [['damask', 'Damask art (tinted)'], ['flat', 'Flat colour'], ['none', 'No ribbon']], bindPath('sidebarMode'));
  const sb = makeRow(box, 'fs-colors');
  makeColor(sb, 'Ribbon colour', bindPath('sidebarColor'));
  makeSlider(box, 'Ribbon shading', 0, 1, 0.01, pct, bindPath('sidebarShade'), { reset: 0 });
  const up = makeRow(box);
  makeUpload(up, 'Upload ribbon art', 'image/*', (url) => { elSet(options, 'sidebar', { src: addAsset(url) }); commit(); });
  makeButton(up, 'Built-in art', () => { elSet(options, 'sidebar', { src: '' }); commit(); });
}

function buildFontsCard() {
  const box = $('fs-fonts-box');
  makeFont(box, 'Character names', bindPath('fontName'));
  makeFont(box, 'Ability text', bindPath('fontAbility'));
  makeFont(box, 'Team labels', bindPath('fontLabel'));
  makeFont(box, 'Author credit', bindPath('fontAuthor'));
  makeFont(box, 'Footnote', bindPath('fontFootnote'));
  makeLabel(box, 'Your own font');
  const row = makeRow(box);
  makeUpload(row, 'Upload a font (.ttf / .otf / .woff2)', '.ttf,.otf,.woff,.woff2,font/*', (url, file) => {
    const fam = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/[^\w \-]/g, '').trim() || 'Uploaded font';
    registerFont(fam, url);
    buildFontSelects();
    toast('Font “' + fam + '” added to every font list');
    scheduleAutosave();
  });
  makeHint(box, 'An uploaded font appears in every font menu on every page, and is embedded in the exports.');
}

function bgControls(box, path, page) {
  makeSelect(box, 'Background', page === 'front'
    ? [['parchment', 'Aged parchment (with garland)'], ['light', 'Light parchment'], ['plain', 'Plain colour'], ['custom', 'Your own image'], ['script', 'The script’s own background image']]
    : [['parchment', 'Aged parchment'], ['light', 'Light parchment'], ['plain', 'Plain colour'], ['custom', 'Your own image'], ['script', 'The script’s own background image']],
  bindPath(path + '.mode'));
  const row = makeRow(box, 'fs-colors');
  makeColor(row, 'Paper colour', bindPath(path + '.color'));
  const up = makeRow(box);
  makeUpload(up, 'Upload background', 'image/*', (url) => { setPath(path + '.src', addAsset(url)); setPath(path + '.mode', 'custom'); commit(); syncControls(); });
  makeSelect(box, 'Fit', [['cover', 'Fill the page'], ['contain', 'Fit inside'], ['stretch', 'Stretch']], bindPath(path + '.fit'));
  makeSlider(box, 'Brightness', 0.5, 1.5, 0.01, pct, bindPath(path + '.brightness'), { reset: 1 });
  makeSlider(box, 'Contrast', 0.5, 1.6, 0.01, pct, bindPath(path + '.contrast'), { reset: 1 });
  makeSlider(box, 'Saturation', 0, 2, 0.01, pct, bindPath(path + '.saturate'), { reset: 1 });
  makeSlider(box, 'Sepia', 0, 1, 0.01, pct, bindPath(path + '.sepia'), { reset: 0 });
  makeSlider(box, 'Hue shift', -180, 180, 1, fmtDeg, bindPath(path + '.hue'), { reset: 0 });
  makeSlider(box, 'Vignette', 0, 1, 0.01, pct, bindPath(path + '.vignette'), { reset: 0 });
}

function buildBgCard() {
  bgControls($('fs-bg-box'), 'bg', 'front');
}

function buildNightCard() {
  const box = $('fs-night-box');
  makeText(box, 'First night title', bindPath('night.titleFirst'));
  makeText(box, 'Other nights title', bindPath('night.titleOther'));
  makeToggle(box, 'Split one night over two columns', bindPath('night.twoColumns'));
  makeToggle(box, 'Dusk, Minion Info, Demon Info and Dawn', bindPath('night.showMeta'));
  const stepRow = makeRow(box, 'fs-colors');
  for (const [k, label] of [['dusk', 'Hide Dusk'], ['minioninfo', 'Hide Minion Info'], ['demoninfo', 'Hide Demon Info'], ['dawn', 'Hide Dawn']]) {
    makeToggle(stepRow, label, { get: () => options.night.hideSteps[k], set: (v) => { options.night.hideSteps[k] = v; } });
  }
  makeToggle(box, 'Reminder text under each name', bindPath('night.showReminders'));
  makeToggle(box, 'Follow the script’s own night order when the file has one', bindPath('night.useScriptOrder'));
  const ord = makeRow(box);
  makeButton(ord, 'Reset the night order', () => { options.night.order = { first: null, other: null }; commit(); toast('Night order reset'); });
  makeHint(box, 'Drag any step on the night sheet up or down to reorder it; this puts the official order back.');
  makeToggle(box, 'Number the steps', bindPath('night.numbered'));
  makeToggle(box, 'Script logo at the top right', bindPath('night.showLogo'));
  makeToggle(box, 'Script name when there is no logo', bindPath('night.showName'));
  makeToggle(box, 'Footer lines', bindPath('night.showFooter'));
  makeToggle(box, 'Community Created Content badge', bindPath('night.showBadge'));
  makeToggle(box, 'Auto-fit the list to the page', bindPath('night.fit'), { onChange: () => syncControls() });
  nightDensityBinding = makeSlider(box, 'List density', 0.5, 1.5, 0.01, pct, bindPath('night.density'), {
    onInput: () => { if (options.night.fit !== false) { options.night.fit = false; syncControls(); } }, reset: 1,
  });
  makeSlider(box, 'Smallest auto-fit before a second page', 0.4, 1, 0.01, pct, bindPath('night.minFit'), { reset: 0.68 });
  makeSlider(box, 'Icon size', 0.6, 1.6, 0.01, pct, bindPath('night.iconSize'), { reset: 1 });
  makeSlider(box, 'Name size', 0.6, 1.5, 0.01, pct, bindPath('night.nameSize'), { reset: 1 });
  makeSlider(box, 'Reminder text size', 0.7, 1.4, 0.01, pct, bindPath('night.textSize'), { reset: 1 });
  makeSlider(box, 'Space between steps', 0, 2.5, 0.05, fmtNum(2), bindPath('night.rowGap'), { reset: 1 });
  makeSlider(box, 'Icon shadow', 0, 2, 0.05, fmtNum(2), bindPath('night.iconShadow'), { reset: 1 });
  makeSelect(box, 'Reminder token mark', [['dot', 'Dot ●'], ['token', 'Little token with the icon'], ['none', 'None']], bindPath('night.dotStyle'));
  makeSelect(box, 'Info tokens (YOU ARE)', [['caps', 'Bold condensed caps'], ['bold', 'Bold'], ['plain', 'Plain']], bindPath('night.tokenStyle'));
  makeLabel(box, 'Colours (× = follow the sheet)');
  const colors = makeRow(box, 'fs-colors');
  makeColor(colors, 'Good names', bindPath('night.goodColor'), { clearable: true, fallback: options.goodColor });
  makeColor(colors, 'Evil names', bindPath('night.evilColor'), { clearable: true, fallback: options.evilColor });
  makeColor(colors, 'Travellers / Fabled', bindPath('night.neutralColor'), { clearable: true, fallback: options.neutralColor });
  makeColor(colors, 'Dusk / Info / Dawn', bindPath('night.metaColor'));
  makeColor(colors, 'Reminder text', bindPath('night.textColor'));
  makeColor(colors, 'Page title', bindPath('night.titleColor'));
  makeLabel(box, 'Fonts');
  makeFont(box, 'Page title', bindPath('night.fontTitle'));
  makeFont(box, 'Names', bindPath('night.fontName'));
  makeFont(box, 'Reminder text', bindPath('night.fontText'));
  makeFont(box, 'Info tokens', bindPath('night.fontToken'));
  makeLabel(box, 'Step icons (upload your own)');
  const steps = makeRow(box);
  for (const [k, label] of [['dusk', 'Dusk'], ['minion', 'Minion Info'], ['demon', 'Demon Info'], ['dawn', 'Dawn']]) {
    makeUpload(steps, label, 'image/*', (url) => { options.night.stepIcons[k] = addAsset(url); commit(); });
  }
  makeButton(steps, 'Built-in icons', () => { options.night.stepIcons = { dusk: '', minion: '', demon: '', dawn: '' }; commit(); });
  makeLabel(box, 'Footer');
  makeText(box, 'Footer line 1', bindPath('night.footer1'));
  makeText(box, 'Footer line 2', bindPath('night.footer2'));
  makeLabel(box, 'Background');
  bgControls(box, 'night.bg', 'list');
}

function buildJinxCard() {
  const box = $('fs-jinx-box');
  makeText(box, 'Page title', bindPath('jinxPage.title'));
  makeToggle(box, 'House rules from the script (_meta.bootlegger)', bindPath('jinxPage.showHouseRules'));
  makeText(box, 'House rules heading', bindPath('jinxPage.houseTitle'));
  makeText(box, 'Notes heading', bindPath('jinxPage.notesTitle'));
  makeText(box, 'Notes — free text printed under the jinxes (blank line = new paragraph)', bindPath('jinxPage.notes'), { multiline: true, rows: 4 });
  makeToggle(box, 'Script logo at the top right', bindPath('jinxPage.showLogo'));
  makeToggle(box, 'Script name when there is no logo', bindPath('jinxPage.showName'));
  makeToggle(box, 'Footer lines (shared with the night sheets)', bindPath('jinxPage.showFooter'));
  makeToggle(box, 'Community Created Content badge', bindPath('jinxPage.showBadge'));
  makeToggle(box, 'Auto-fit the list to the page', bindPath('jinxPage.fit'), { onChange: () => syncControls() });
  jinxDensityBinding = makeSlider(box, 'List density', 0.5, 1.5, 0.01, pct, bindPath('jinxPage.density'), {
    onInput: () => { if (options.jinxPage.fit !== false) { options.jinxPage.fit = false; syncControls(); } }, reset: 1,
  });
  makeSlider(box, 'Icon size', 0.6, 1.6, 0.01, pct, bindPath('jinxPage.iconSize'), { reset: 1 });
  makeSlider(box, 'Name size', 0.6, 1.5, 0.01, pct, bindPath('jinxPage.nameSize'), { reset: 1 });
  makeSlider(box, 'Text size', 0.7, 1.4, 0.01, pct, bindPath('jinxPage.textSize'), { reset: 1 });
  const colors = makeRow(box, 'fs-colors');
  makeColor(colors, 'Text', bindPath('jinxPage.textColor'));
  makeColor(colors, 'Page title', bindPath('jinxPage.titleColor'));
  makeFont(box, 'Page title font', bindPath('jinxPage.fontTitle'));
  makeFont(box, 'Names', bindPath('jinxPage.fontName'));
  makeFont(box, 'Text', bindPath('jinxPage.fontText'));
  makeLabel(box, 'Background');
  bgControls(box, 'jinxPage.bg', 'list');
}

function buildExportCard() {
  const box = $('fs-export-box');
  makeSelect(box, 'PDF page size', Object.entries(PAGE_FORMATS).map(([k, v]) => [k, v.label]), bindPath('exportOpts.pageSize'));
  const row = makeRow(box, 'fs-colors');
  makeColor(row, 'Paper around the sheet (A4 / Letter)', bindPath('exportOpts.marginColor'));
  makeSelect(box, 'Print resolution', [['2', '2× (2484 px wide)'], ['3', '3× (3726 px wide, print)'], ['4', '4× (4968 px — large files)']],
    { get: () => String(options.exportOpts.printScale), set: (v) => { options.exportOpts.printScale = Number(v); } });
  makeSelect(box, 'Share image size', [['1', '1× (1242 px)'], ['1.5', '1.5× (1863 px)'], ['2', '2× (2484 px)']],
    { get: () => String(options.exportOpts.shareScale), set: (v) => { options.exportOpts.shareScale = Number(v); } });
  makeSlider(box, 'JPEG quality', 0.6, 1, 0.01, pct, bindPath('exportOpts.jpegQuality'), { reset: 0.92 });
  makeLabel(box, 'Pages in the PDF');
  makeToggle(box, 'Script sheet(s)', bindPath('exportOpts.pages.front'));
  makeToggle(box, 'Night order sheets', bindPath('exportOpts.pages.night'));
  makeToggle(box, 'Jinx page', bindPath('exportOpts.pages.jinx'));
  makeHint(box, 'Share Image and Print PNG download the page you are looking at; “All pages” downloads each one; Print PDF is every ticked page in order.');
}

/* ── the Elements panel ───────────────────────────────────────────────
   Pick anything on the current page (or tap it on the preview) and move,
   size, turn, fade or hide it; replace a decor image with an upload; add
   free text or images anywhere. The same panel serves the back cover's
   title words, which are text stickers in all but name. */
function selectableOnPage(p) {
  const list = [];
  if (p.kind === 'back') {
    (options.back.texts || []).forEach((t, i) => list.push({ id: 'back:' + i, label: 'Word: ' + (t.text || '…').slice(0, 16), kind: 'text' }));
  } else {
    for (const e of ELEMENTS) {
      if (e.page !== p.kind) continue;
      if (p.kind === 'front' && p.index > 0 && !options.repeatHeader && ['title', 'author', 'skull', 'fll', 'flr'].includes(e.key)) continue;
      list.push({ id: 'el:' + e.key, label: e.label, kind: e.kind, fixed: e.fixed, el: e });
    }
  }
  for (const st of stickersFor(p)) {
    list.push({ id: 'custom:' + st.id, label: (st.type === 'image' ? 'Image: ' : 'Text: ') + (st.type === 'image' ? (st.name || 'sticker') : (st.text || '…').slice(0, 16)), kind: st.type, sticker: st });
  }
  return list;
}

function findSticker(id) {
  return (options.custom || []).find((s) => 'custom:' + s.id === id);
}

let elementPanelBindings = [];
function buildElementPanel() {
  const box = $('fs-elements-box');
  if (!box) return;
  for (const b of elementPanelBindings) bindings.delete(b);
  elementPanelBindings = [];
  box.textContent = '';
  const p = currentPage();
  if (!p) return;
  const list = selectableOnPage(p);

  // the picker
  const sel = document.createElement('select');
  sel.className = 'fs-select';
  const none = document.createElement('option');
  none.value = ''; none.textContent = 'Pick an element (or tap it on the preview)…';
  sel.append(none);
  for (const it of list) {
    const o = document.createElement('option');
    o.value = it.id; o.textContent = it.label;
    sel.append(o);
  }
  sel.value = list.some((it) => it.id === selectedId) ? selectedId : '';
  sel.addEventListener('change', () => { setSelected(sel.value); });
  box.append(sel);

  const addRow = makeRow(box);
  addRow.style.marginTop = '8px';
  makeButton(addRow, '+ Text', () => addSticker('text'));
  makeUpload(addRow, '+ Image', 'image/*', (url, file) => addSticker('image', url, file.name));
  if (p.kind === 'back') {
    makeButton(addRow, '+ Title word', () => {
      options.back.texts.push(newTextElement({ text: 'Word', x: 50, y: 85, size: 160, font: 'unlovable', fill: '#bea881', strokeW: 1.5, shadowY: 2, shadowBlur: 5 }));
      setSelected('back:' + (options.back.texts.length - 1));
      commit();
    });
  }

  const it = list.find((x) => x.id === selectedId);
  if (!it) {
    if (selectedId.startsWith('char:')) {
      const c = parsed.characters.find((x) => x.id === selectedId.slice(5));
      makeHint(box, 'Icon of ' + (c ? c.name : 'a character') + ' — drag it to nudge it into place (arrow keys too). Its size, art and colour are in the Characters card below.');
    } else if (selectedId.startsWith('crow:')) {
      makeHint(box, 'A character row — drag it up or down (or across the columns) to reorder the team.');
    } else if (selectedId.startsWith('nrow:')) {
      makeHint(box, 'A night-order step — drag it up or down to reorder the night. “Reset the night order” in the night sheet card puts the official order back.');
    } else {
      makeHint(box, 'Tap anything on the preview to select it, then drag to move: decor, text, stickers, character icons (to nudge) and rows (to reorder). Arrow keys nudge the selection (Shift for bigger steps); Delete removes a sticker.');
    }
    return;
  }
  const tools = makeRow(box);
  tools.style.margin = '10px 0 4px';
  const b = { get: null, set: null };
  const track = (bnd) => { elementPanelBindings.push(bnd); return bnd; };

  if (it.id.startsWith('el:')) {
    const key = it.id.slice(3);
    const t = () => elGet(options, key);
    const w = (patch) => elSet(options, key, patch);
    if (!it.fixed) {
      track(makeSlider(box, 'Horizontal', -60, 60, 0.1, signed(1, '%'), { get: () => t().dx, set: (v) => w({ dx: v }) }, { reset: 0 }));
      track(makeSlider(box, 'Vertical', -60, 60, 0.1, signed(1, '%'), { get: () => t().dy, set: (v) => w({ dy: v }) }, { reset: 0 }));
    } else if (key === 'labels' || key === 'dividers') {
      track(makeSlider(box, 'Horizontal', -10, 10, 0.1, signed(1, '%'), { get: () => t().dx, set: (v) => w({ dx: v }) }, { reset: 0 }));
      track(makeSlider(box, 'Vertical', -10, 10, 0.1, signed(1, '%'), { get: () => t().dy, set: (v) => w({ dy: v }) }, { reset: 0 }));
    }
    if (key !== 'sidebar') track(makeSlider(box, 'Size', 0.3, 2.5, 0.01, pct, { get: () => t().scale, set: (v) => w({ scale: v }) }, { reset: 1 }));
    if (!it.fixed && it.kind !== 'block') track(makeSlider(box, 'Rotation', -180, 180, 1, fmtDeg, { get: () => t().rot, set: (v) => w({ rot: v }) }, { reset: 0 }));
    track(makeSlider(box, 'Opacity', 0, 1, 0.01, pct, { get: () => t().opacity, set: (v) => w({ opacity: v }) }, { reset: 1 }));
    track(makeToggle(box, 'Hidden', { get: () => t().hidden, set: (v) => w({ hidden: v }) }));
    if (it.kind === 'image' || key === 'title') {
      const up = makeRow(box);
      makeUpload(up, key === 'title' ? 'Use an image as the title' : 'Replace with your own image', 'image/*',
        (url) => { w({ src: addAsset(url) }); commit(); });
      makeButton(up, key === 'title' ? 'Text title' : 'Built-in art', () => { w({ src: '' }); commit(); });
    }
    makeButton(tools, 'Reset this element', () => { if (options.el) delete options.el[key]; commit(); buildElementPanel(); });
  } else if (it.id.startsWith('back:')) {
    const idx = Number(it.id.slice(5));
    const get = () => options.back.texts[idx];
    textStickerControls(box, get, track);
    makeButton(tools, 'Remove word', () => {
      options.back.texts.splice(idx, 1);
      setSelected('');
      commit();
    });
    makeButton(tools, 'Duplicate', () => {
      options.back.texts.splice(idx + 1, 0, { ...clone(get()), y: Math.min(95, get().y + 6) });
      setSelected('back:' + (idx + 1));
      commit();
    });
  } else {
    const st = it.sticker;
    const get = () => findSticker(it.id);
    const pageChoices = [[pageKey(p), 'This page only'], [p.kind, 'Every ' + (p.kind === 'front' ? 'script sheet' : p.kind === 'night' ? 'night sheet' : p.kind + ' page')], ['all', 'All pages']];
    track(makeSelect(box, 'Shown on', pageChoices, { get: () => get().page || pageKey(p), set: (v) => { get().page = v; } }));
    if (st.type === 'image') {
      track(makeSlider(box, 'Horizontal', -10, 110, 0.1, (v) => v.toFixed(1) + '%', { get: () => get().x, set: (v) => { get().x = v; } }, { reset: 50 }));
      track(makeSlider(box, 'Vertical', -10, 110, 0.1, (v) => v.toFixed(1) + '%', { get: () => get().y, set: (v) => { get().y = v; } }, { reset: 50 }));
      track(makeSlider(box, 'Width', 2, 120, 0.5, (v) => v.toFixed(1) + '%', { get: () => get().w, set: (v) => { get().w = v; } }, { reset: 24 }));
      track(makeSlider(box, 'Rotation', -180, 180, 1, fmtDeg, { get: () => get().rotate, set: (v) => { get().rotate = v; } }, { reset: 0 }));
      track(makeSlider(box, 'Opacity', 0, 1, 0.01, pct, { get: () => get().opacity, set: (v) => { get().opacity = v; } }, { reset: 1 }));
      track(makeSlider(box, 'Shadow', 0, 3, 0.05, fmtNum(2), { get: () => get().shadow, set: (v) => { get().shadow = v; } }, { reset: 0 }));
      track(makeSlider(box, 'Rounded corners', 0, 50, 1, (v) => v + '%', { get: () => get().round, set: (v) => { get().round = v; } }, { reset: 0 }));
      track(makeToggle(box, 'Flip horizontally', { get: () => get().flip, set: (v) => { get().flip = v; } }));
      track(makeToggle(box, 'Behind the sheet’s own content', { get: () => get().behind, set: (v) => { get().behind = v; } }));
      track(makeSelect(box, 'Blend', [['normal', 'Normal'], ['multiply', 'Multiply (ink on paper)']], { get: () => get().blend || 'normal', set: (v) => { get().blend = v; } }));
      const up = makeRow(box);
      makeUpload(up, 'Replace image', 'image/*', (url) => { get().src = addAsset(url); commit(); });
    } else {
      textStickerControls(box, get, track);
    }
    makeButton(tools, 'Remove', () => {
      options.custom = options.custom.filter((s) => s !== get());
      setSelected('');
      commit();
    });
    makeButton(tools, 'Duplicate', () => {
      const copy = { ...clone(get()), id: newId(), y: Math.min(95, get().y + 6) };
      options.custom.push(copy);
      setSelected('custom:' + copy.id);
      commit();
    });
    const al = makeRow(box);
    al.style.marginTop = '8px';
    makeButton(al, 'Centre ↔', () => { get().x = 50; commit(); syncControls(); });
    makeButton(al, 'Centre ↕', () => { get().y = 50; commit(); syncControls(); });
    const swap = (dir) => {
      const i = options.custom.indexOf(get());
      const j = i + dir;
      if (i < 0 || j < 0 || j >= options.custom.length) return;
      [options.custom[i], options.custom[j]] = [options.custom[j], options.custom[i]];
      commit();
    };
    makeButton(al, 'Bring forward', () => swap(1));
    makeButton(al, 'Send back', () => swap(-1));
  }
}

function textStickerControls(box, get, track) {
  track(makeText(box, 'Text (Enter for a new line)', { get: () => get().text, set: (v) => { get().text = v; } }, { multiline: true, rows: 2 }));
  track(makeFont(box, 'Font', { get: () => get().font, set: (v) => { get().font = v; } }));
  track(makeSlider(box, 'Horizontal', -10, 110, 0.1, (v) => v.toFixed(1) + '%', { get: () => get().x, set: (v) => { get().x = v; } }, { reset: 50 }));
  track(makeSlider(box, 'Vertical', -10, 110, 0.1, (v) => v.toFixed(1) + '%', { get: () => get().y, set: (v) => { get().y = v; } }, { reset: 50 }));
  track(makeSlider(box, 'Size', 12, 640, 1, fmtPx, { get: () => get().size, set: (v) => { get().size = v; } }, { reset: 120 }));
  track(makeSlider(box, 'Rotation', -180, 180, 1, fmtDeg, { get: () => get().rotate || 0, set: (v) => { get().rotate = v; } }, { reset: 0 }));
  track(makeSlider(box, 'Letter spacing', -0.1, 0.5, 0.01, fmtEm, { get: () => get().spacing || 0, set: (v) => { get().spacing = v; } }, { reset: 0 }));
  track(makeSlider(box, 'Line spacing', 0.7, 2, 0.02, fmtNum(2), { get: () => get().lineHeight || 1, set: (v) => { get().lineHeight = v; } }, { reset: 1 }));
  track(makeSlider(box, 'Opacity', 0, 1, 0.01, pct, { get: () => get().opacity == null ? 1 : get().opacity, set: (v) => { get().opacity = v; } }, { reset: 1 }));
  track(makeSelect(box, 'Anchor', [['center', 'Centre'], ['left', 'Left'], ['right', 'Right']], { get: () => get().align || 'center', set: (v) => { get().align = v; } }));
  track(makeSelect(box, 'Blend', [['normal', 'Normal'], ['multiply', 'Multiply (ink on paper)']], { get: () => get().blend || 'normal', set: (v) => { get().blend = v; } }));
  track(makeSlider(box, 'Stroke width', 0, 8, 0.25, (v) => Number(v).toFixed(2) + 'px', { get: () => get().strokeW || 0, set: (v) => { get().strokeW = v; } }, { reset: 0 }));
  track(makeSlider(box, 'Shadow across', -25, 25, 1, fmtPx, { get: () => get().shadowX || 0, set: (v) => { get().shadowX = v; } }, { reset: 0 }));
  track(makeSlider(box, 'Shadow down', -25, 25, 1, fmtPx, { get: () => get().shadowY || 0, set: (v) => { get().shadowY = v; } }, { reset: 0 }));
  track(makeSlider(box, 'Shadow blur', 0, 50, 1, fmtPx, { get: () => get().shadowBlur || 0, set: (v) => { get().shadowBlur = v; } }, { reset: 0 }));
  track(makeToggle(box, 'Gradient fill', { get: () => get().fillGrad, set: (v) => { get().fillGrad = v; } }, { onChange: () => buildElementPanel() }));
  if (get().fillGrad) {
    track(makeSlider(box, 'Fill gradient angle', 0, 360, 5, fmtDeg, { get: () => get().gradAngle ?? 180, set: (v) => { get().gradAngle = v; } }, { reset: 180 }));
  }
  const colors = makeRow(box, 'fs-colors');
  track(makeColor(colors, 'Fill', { get: () => get().fill, set: (v) => { get().fill = v; } }));
  if (get().fillGrad) track(makeColor(colors, 'Fill 2', { get: () => get().fill2 || '#e8d9a0', set: (v) => { get().fill2 = v; } }));
  track(makeColor(colors, 'Stroke', { get: () => get().strokeColor || '#000000', set: (v) => { get().strokeColor = v; } }));
  track(makeColor(colors, 'Shadow', { get: () => get().shadowColor || '#000000', set: (v) => { get().shadowColor = v; } }));
}

function newId() { return Math.random().toString(36).slice(2, 9); }

function addSticker(type, url, name) {
  const p = currentPage();
  const dark = p.kind === 'back';
  let st;
  if (type === 'image') {
    st = newImageElement({ id: newId(), page: pageKey(p), src: addAsset(url), name: (name || 'image').slice(0, 20), x: 50, y: 50, w: 24 });
  } else {
    st = newTextElement({
      id: newId(), page: pageKey(p), text: 'Your text', x: 50, y: p.kind === 'back' ? 80 : 50, size: 64,
      font: dark ? 'unlovable' : 'goudy', fill: dark ? '#bea881' : '#2b2b2b',
      strokeW: dark ? 1.5 : 0, shadowY: dark ? 2 : 0, shadowBlur: dark ? 5 : 0, blend: dark ? 'normal' : 'multiply',
    });
  }
  options.custom.push(st);
  setSelected('custom:' + st.id);
  commit();
}

function setSelected(id) {
  selectedId = id || '';
  // re-ring the live preview without a rebuild
  const wrap = $('fs-sheet-wrap');
  wrap.querySelectorAll('[data-fs-selected]').forEach((n) => {
    n.style.outline = ''; n.style.outlineOffset = ''; delete n.dataset.fsSelected;
    n.querySelectorAll('[data-fs-handle]').forEach((g) => { g.style.display = 'none'; });
  });
  if (selectedId) {
    const node = wrap.querySelector(`[data-fs-drag="${CSS.escape(selectedId)}"]`);
    if (node) {
      node.style.outline = '2px dashed rgba(91,31,33,0.85)';
      node.style.outlineOffset = '5px';
      node.dataset.fsSelected = '1';
      node.querySelectorAll('[data-fs-handle]').forEach((g) => { g.style.display = 'block'; });
    }
  }
  buildElementPanel();
  updateSelectionInfo();
}

function updateSelectionInfo() {
  const info = $('fs-sel-info');
  if (!info) return;
  if (!selectedId) { info.textContent = ''; return; }
  const p = currentPage();
  const it = selectableOnPage(p).find((x) => x.id === selectedId);
  info.textContent = it ? 'Selected: ' + it.label + ' — drag to move, arrows to nudge' : '';
}

/* ── drag wiring ── */
function elementModel(id) {
  // → {getX, getY, setX, setY, snapX (targets in %), snapY} in sheet %
  if (id.startsWith('el:')) {
    const key = id.slice(3);
    return {
      get: () => { const t = elGet(options, key); return { x: t.dx, y: t.dy }; },
      set: (x, y) => elSet(options, key, { dx: x, dy: y }),
      snapX: [0], snapY: [0], guide: false,
    };
  }
  if (id.startsWith('back:')) {
    const t = options.back.texts[Number(id.slice(5))];
    if (!t) return null;
    return { get: () => ({ x: t.x, y: t.y }), set: (x, y) => { t.x = x; t.y = y; }, snapX: [50], snapY: [50], guide: true };
  }
  if (id.startsWith('custom:')) {
    const st = findSticker(id);
    if (!st) return null;
    return { get: () => ({ x: st.x, y: st.y }), set: (x, y) => { st.x = x; st.y = y; }, snapX: [50], snapY: [50], guide: true };
  }
  if (id.startsWith('char:')) {
    // an icon nudge: the per-character iconDX (% width) / iconDY (em)
    const cid = id.slice(5);
    const ov = () => (options.chars[cid] = options.chars[cid] || {});
    return {
      get: () => ({ x: Number(ov().iconDX) || 0, y: Number(ov().iconDY) || 0 }),
      set: (x, y) => { ov().iconDX = x; ov().iconDY = y; },
      snapX: [0], snapY: [0], guide: false,
    };
  }
  if (id.startsWith('crow:') || id.startsWith('nrow:')) {
    // a row: it moves with the pointer and is REORDERED on release
    return { get: () => ({ x: 0, y: 0 }), set: () => {}, snapX: [], snapY: [], guide: false, reorder: true };
  }
  return null;
}

/* ── reordering by drag ──
   A script-sheet row dropped somewhere else in its team takes that slot
   (the whole team is renumbered through options.chars[id].order, which
   deriveScript sorts by); a night-sheet row dropped elsewhere in its list
   rewrites options.night.order[list] as an id sequence, which nightLists
   follows above the file's own. Both work from the layout the page was
   drawn with, so the drop lands where the row was let go. */
function reorderFront(cid, d) {
  const p = currentPage();
  const layout = layouts.front;
  const page = layout.pages[p.index];
  if (!page) return;
  const ed = (em) => em * U * layout.d;
  for (const sec of page.sections) {
    const li = sec.left.findIndex((c) => c.id === cid);
    const ri = sec.right.findIndex((c) => c.id === cid);
    if (li < 0 && ri < 0) continue;
    const inLeft = li >= 0;
    const idx = inLeft ? li : ri;
    const heights = inLeft ? sec.leftHeights : sec.rightHeights;
    const top = inLeft ? sec.topPx : sec.rightTopPx;
    let y0 = top;
    for (let i = 0; i < idx; i++) y0 += ed(heights[i]);
    const cy = y0 + ed(heights[idx]) / 2 + (d.dy / 100) * SHEET_H;
    const cx = ((inLeft ? SHEET.col1IconX : SHEET.col2IconX) + d.dx) / 100 * SHEET_W;
    const single = options.columnLayout === 'single';
    const toLeft = single || cx < ((SHEET.col1IconX + SHEET.col2IconX) / 2 / 100) * SHEET_W;
    const tHeights = toLeft ? sec.leftHeights : sec.rightHeights;
    const tTop = toLeft ? sec.topPx : sec.rightTopPx;
    const tList = toLeft ? sec.left : sec.right;
    // the slot: how many rows of the target column (the moved one aside)
    // have their centre above the drop point
    let y = tTop, slot = 0;
    for (let i = 0; i < tList.length; i++) {
      const h = ed(tHeights[i]);
      if (tList[i].id !== cid && y + h / 2 < cy) slot++;
      y += h;
    }
    // team-wide order for this page's portion of the team
    const portion = sec.chars.filter((c) => c.id !== cid);
    const insertAt = toLeft ? slot : sec.left.filter((c) => c.id !== cid).length + slot;
    portion.splice(Math.min(insertAt, portion.length), 0, sec.chars.find((c) => c.id === cid));
    // renumber the whole derived list, with this portion in its new order
    const team = derived.characters.filter((c) => c.team === sec.team);
    const start = team.findIndex((c) => c.id === sec.chars[0].id);
    const before = team.slice(0, Math.max(0, start));
    const after = team.slice(Math.max(0, start) + sec.chars.length);
    const newTeam = [...before, ...portion, ...after];
    const others = derived.characters.filter((c) => c.team !== sec.team);
    const all = [...others, ...newTeam];
    // keep every other team where it was; teams are grouped anyway
    all.forEach((c, i) => { options.chars[c.id] = options.chars[c.id] || {}; options.chars[c.id].order = (i + 1) * 10; });
    if (options.sortMode !== 'script') { options.sortMode = 'script'; syncControls(); toast('Character order set to “As in the script”'); }
    return;
  }
}

function reorderNight(list, rid, d) {
  const p = currentPage();
  const which = p.which === 'both' ? 'both' : p.which;
  const lay = layouts[which];
  if (!lay) return;
  const page = lay.pages[p.index];
  const ed = (em) => em * U * lay.d;
  for (const pc of page.columns) {
    const units = pc.units.filter((u) => u.type === 'row');
    const idx = pc.units.findIndex((u) => u.type === 'row' && u.row.id === rid && u.row.list === list);
    if (idx < 0) continue;
    let y = lay.listTop * U, y0 = 0, h0 = 0;
    const centres = [];
    pc.units.forEach((u, i) => {
      const h = ed(u.hEm);
      if (i === idx) { y0 = y; h0 = h; }
      if (u.type === 'row') centres.push({ id: u.row.id, c: y + h / 2 });
      y += h;
    });
    const cy = y0 + h0 / 2 + (d.dy / 100) * SHEET_H;
    let slot = 0;
    for (const c of centres) if (c.id !== rid && c.c < cy) slot++;
    // the full sequence of this list (every page), in its current order
    const spec = lay === layouts.both ? layouts.bothSpec : layouts[which + 'Spec'];
    const seq = [];
    spec.columns.forEach((col) => col.blocks.forEach((b) => b.rows.forEach((r) => { if (r.list === list) seq.push(r.id); })));
    // the slot counted within this page's column; pages before it carry
    // their own rows, so offset by how many of the list came earlier
    let offset = 0;
    for (let pi = 0; pi < p.index; pi++) {
      lay.pages[pi].columns.forEach((c2) => c2.units.forEach((u) => { if (u.type === 'row' && u.row.list === list) offset++; }));
    }
    const without = seq.filter((id) => id !== rid);
    without.splice(Math.min(offset + slot, without.length), 0, rid);
    options.night.order = options.night.order || { first: null, other: null };
    options.night.order[list] = without;
    return;
  }
}

function mountPreviewDrag() {
  const wrap = $('fs-sheet-wrap');
  mountDrag(wrap, {
    getScale: () => lastScale,
    onSelect: (id) => {
      const m = elementModel(id);
      dragStart = m ? { id, ...m.get(), m } : null;
      if (id.startsWith('char:')) {
        // an icon: the Characters card follows it
        charSel = id.slice(5);
        buildCharPanel();
        const card = $('fs-chars-box') && $('fs-chars-box').closest('details');
        if (card) card.open = true;
      }
      if (selectedId !== id) setSelected(id);
    },
    onMove: (id, d) => {
      if (!dragStart || dragStart.id !== id) return null;
      const m = dragStart.m;
      let x = dragStart.x + d.dx;
      let y = dragStart.y + d.dy;
      let guideX = null, guideY = null;
      const sx = snapTo(x, m.snapX, 0.7);
      const sy = snapTo(y, m.snapY, 0.7);
      if (sx != null) { x = sx; if (m.guide) guideX = sx; }
      if (sy != null) { y = sy; if (m.guide) guideY = sy; }
      m.set(x, y);
      syncElementPanel();
      return { dx: x - dragStart.x, dy: y - dragStart.y, guideX, guideY };
    },
    onCommit: (id, d) => {
      const m = dragStart && dragStart.m;
      dragStart = null;
      if (m && m.reorder) {
        if (id.startsWith('crow:')) reorderFront(id.slice(5), d);
        else { const parts = id.split(':'); reorderNight(parts[1], parts.slice(2).join(':'), d); }
        selectedId = '';
      }
      commit();
    },
    onResize: (id, d, done) => {
      const st = findSticker(id);
      if (!st) return null;
      if (!dragStart || dragStart.id !== id || dragStart.w == null) dragStart = { ...(dragStart || { id }), w: st.w, size: st.size };
      if (st.type === 'image') st.w = clamp(dragStart.w + d.dx * 2, 2, 200);
      else st.size = clamp(dragStart.size * (1 + d.dx / 15), 8, 900);
      if (done) { dragStart = null; commit(); } else requestRender();
      return { applied: true };
    },
    onBackground: () => { if (selectedId) setSelected(''); },
  });
}

function syncElementPanel() {
  for (const b of elementPanelBindings) { try { b.refresh(); } catch { /* detached */ } }
}

/* keyboard: nudge, delete, undo/redo */
function onKey(ev) {
  const tag = (ev.target && ev.target.tagName) || '';
  const typing = /INPUT|TEXTAREA|SELECT/.test(tag) && ev.target.type !== 'range' && ev.target.type !== 'checkbox';
  if ((ev.ctrlKey || ev.metaKey) && !typing) {
    if (ev.key === 'z' && !ev.shiftKey) { ev.preventDefault(); undo(); return; }
    if (ev.key === 'y' || (ev.key === 'z' && ev.shiftKey)) { ev.preventDefault(); redo(); return; }
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key === 's') { ev.preventDefault(); saveDesign(); return; }
  if (typing) return;
  if (!selectedId) return;
  const m = elementModel(selectedId);
  if (!m || m.reorder) return;
  const step = ev.shiftKey ? 1 : 0.2;
  const cur = m.get();
  if (ev.key === 'ArrowLeft') { m.set(cur.x - step, cur.y); }
  else if (ev.key === 'ArrowRight') { m.set(cur.x + step, cur.y); }
  else if (ev.key === 'ArrowUp') { m.set(cur.x, cur.y - step); }
  else if (ev.key === 'ArrowDown') { m.set(cur.x, cur.y + step); }
  else if (ev.key === 'Delete' || ev.key === 'Backspace') {
    if (selectedId.startsWith('custom:')) options.custom = options.custom.filter((s) => 'custom:' + s.id !== selectedId);
    else if (selectedId.startsWith('back:')) options.back.texts.splice(Number(selectedId.slice(5)), 1);
    else return;
    setSelected('');
  } else if (ev.key === 'Escape') { setSelected(''); return; }
  else return;
  ev.preventDefault();
  syncElementPanel();
  commit();
}

/* ── the Characters panel ─────────────────────────────────────────────── */
let charPanelBindings = [];
function buildCharPanel() {
  const box = $('fs-chars-box');
  if (!box) return;
  for (const b of charPanelBindings) bindings.delete(b);
  charPanelBindings = [];
  box.textContent = '';
  const chars = parsed.characters;
  if (!chars.length) { makeHint(box, 'Load a script first.'); return; }
  const sel = document.createElement('select');
  sel.className = 'fs-select';
  const none = document.createElement('option');
  none.value = ''; none.textContent = 'Pick a character…';
  sel.append(none);
  for (const c of chars) {
    const ov = options.chars[c.id] || {};
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = (ov.hidden ? '(hidden) ' : '') + (ov.name || c.name) + ' — ' + TEAM_NAMES[ov.team || c.team];
    sel.append(o);
  }
  sel.value = chars.some((c) => c.id === charSel) ? charSel : '';
  sel.addEventListener('change', () => { charSel = sel.value; buildCharPanel(); });
  box.append(sel);
  const c = chars.find((x) => x.id === charSel);
  const track = (bnd) => { charPanelBindings.push(bnd); return bnd; };
  const bulk = makeRow(box);
  bulk.style.marginTop = '8px';
  makeButton(bulk, 'Show all', () => { for (const k of Object.keys(options.chars)) delete options.chars[k].hidden; commit(); buildCharPanel(); });
  makeButton(bulk, 'Clear all edits', () => { options.chars = {}; commit(); buildCharPanel(); });
  if (!c) {
    makeHint(box, 'Hide a character, rename it, rewrite its ability, swap its icon for your own, recolour its name, or move it up and down its team. Night positions and reminders can be set here too.');
    return;
  }
  const ov = () => (options.chars[c.id] = options.chars[c.id] || {});
  const g = (k, d) => (options.chars[c.id] && options.chars[c.id][k] != null ? options.chars[c.id][k] : d);
  track(makeToggle(box, 'Hide from every page', { get: () => g('hidden', false), set: (v) => { ov().hidden = v; } }, { onChange: () => buildCharPanel() }));
  track(makeText(box, 'Name (blank = ' + c.name + ')', { get: () => g('name', ''), set: (v) => { ov().name = v; } }));
  track(makeText(box, 'Ability (blank = the script’s)', { get: () => g('ability', ''), set: (v) => { ov().ability = v; } }, { multiline: true, rows: 3 }));
  track(makeSelect(box, 'Team', [['', 'As in the script (' + TEAM_NAMES[c.team] + ')'], ...TEAM_ORDER.map((t) => [t, TEAM_NAMES[t]])],
    { get: () => g('team', ''), set: (v) => { ov().team = v; } }, { onChange: () => buildCharPanel() }));
  const colors = makeRow(box, 'fs-colors');
  track(makeColor(colors, 'Name colour', { get: () => g('color', ''), set: (v) => { ov().color = v; } }, { clearable: true, fallback: '#0d6c97' }));
  const icon = makeRow(box);
  icon.style.marginTop = '8px';
  makeUpload(icon, 'Upload an icon', 'image/*', (url) => { ov().icon = addAsset(url); commit(); });
  makeButton(icon, 'Original icon', () => { delete ov().icon; commit(); });
  track(makeSlider(box, 'Icon size', 0.5, 1.8, 0.01, pct, { get: () => g('iconScale', 1), set: (v) => { ov().iconScale = v; } }, { reset: 1 }));
  track(makeSlider(box, 'Icon left / right', -4, 4, 0.05, signed(2, '%'), { get: () => g('iconDX', 0), set: (v) => { ov().iconDX = v; } }, { reset: 0 }));
  track(makeSlider(box, 'Icon up / down', -3, 3, 0.05, signed(2), { get: () => g('iconDY', 0), set: (v) => { ov().iconDY = v; } }, { reset: 0 }));
  const order = makeRow(box);
  order.style.marginTop = '8px';
  makeButton(order, '▲ Move up', () => moveChar(c.id, -1));
  makeButton(order, '▼ Move down', () => moveChar(c.id, 1));
  makeLabel(box, 'Night order (blank = the script’s)');
  track(makeText(box, 'First night position (0 = does not wake) — now ' + (c.firstNight || 0), { get: () => g('firstNight', ''), set: (v) => { ov().firstNight = v; } }));
  track(makeText(box, 'First night reminder', { get: () => g('firstNightReminder', ''), set: (v) => { ov().firstNightReminder = v; } }, { multiline: true, rows: 2 }));
  track(makeText(box, 'Other nights position — now ' + (c.otherNight || 0), { get: () => g('otherNight', ''), set: (v) => { ov().otherNight = v; } }));
  track(makeText(box, 'Other nights reminder', { get: () => g('otherNightReminder', ''), set: (v) => { ov().otherNightReminder = v; } }, { multiline: true, rows: 2 }));
  makeHint(box, 'Reminders take *INFO TOKEN* for bold caps and :reminder: for a token dot, like the official text.');
}

/* move a character one step within its team (a hand-arranged order is
   kept as `order` numbers on every character, so it survives a sort) */
function moveChar(id, dir) {
  const list = derived.characters.filter((c) => c.team === (derived.characters.find((x) => x.id === id) || {}).team);
  const idx = list.findIndex((c) => c.id === id);
  if (idx < 0) return;
  const j = idx + dir;
  if (j < 0 || j >= list.length) return;
  // number everyone by their current derived order, then swap the two
  derived.characters.forEach((c, i) => { options.chars[c.id] = options.chars[c.id] || {}; options.chars[c.id].order = (i + 1) * 10; });
  const a = options.chars[list[idx].id].order, b = options.chars[list[j].id].order;
  options.chars[list[idx].id].order = b;
  options.chars[list[j].id].order = a;
  // a hand-arranged order only shows under the script's own order
  if (options.sortMode !== 'script') { options.sortMode = 'script'; syncControls(); toast('Character order set to “As in the script”'); }
  commit();
}

/* ── the Back cover panel ─────────────────────────────────────────────── */
let backBindings = [];
function buildBackPanel() {
  const box = $('fs-back-box');
  if (!box) return;
  for (const b of backBindings) bindings.delete(b);
  backBindings = [];
  box.textContent = '';
  const b = options.back;
  const track = (bnd) => { backBindings.push(bnd); return bnd; };
  track(makeSelect(box, 'Background', [['pattern', 'Damask pattern'], ['plain', 'Plain colour'], ['custom', 'Your own image']],
    bindPath('back.bgMode'), { onChange: () => buildBackPanel() }));
  const colorRow = makeRow(box, 'fs-colors');
  track(makeColor(colorRow, 'Colour', bindPath('back.bgColor')));
  track(makeToggle(box, 'Gradient', bindPath('back.bgGradient'), { onChange: () => buildBackPanel() }));
  if (b.bgGradient) {
    const r = makeRow(box, 'fs-colors');
    track(makeColor(r, 'Colour 2', bindPath('back.bgColor2')));
    track(makeSlider(box, 'Gradient angle', 0, 360, 5, fmtDeg, bindPath('back.bgGradAngle'), { reset: 180 }));
  }
  if ((b.bgMode || 'pattern') === 'pattern') {
    track(makeSlider(box, 'Brightness', 0.4, 1.8, 0.02, pct, bindPath('back.brightness'), { reset: 1 }));
    track(makeSlider(box, 'Saturation', 0, 2, 0.02, pct, bindPath('back.saturation'), { reset: 1 }));
    track(makeSlider(box, 'Border shading', 0, 2, 0.02, pct, bindPath('back.shading'), { reset: 1 }));
    track(makeSlider(box, 'Pattern strength', 0, 5, 0.05, pct, bindPath('back.patStrength'), { reset: 1 }));
    track(makeSlider(box, 'Pattern size', 0.4, 3, 0.02, pct, bindPath('back.patScale'), { reset: 1 }));
    track(makeSlider(box, 'Pattern rotation', -180, 180, 1, fmtDeg, bindPath('back.patRot'), { reset: 0 }));
  }
  if (b.bgMode === 'custom') {
    const up = makeRow(box);
    makeUpload(up, 'Upload background image', 'image/*', (url) => { options.back.bgSrc = addAsset(url); commit(); });
  }
  const row = makeRow(box);
  row.style.marginTop = '10px';
  makeButton(row, 'Re-stack the title words', () => {
    options.back.texts = seedBackTexts((options.titleOverride || '').trim() || parsed.meta.name || 'Untitled');
    setSelected(options.back.texts.length ? 'back:0' : '');
    commit();
  });
  makeHint(box, 'The title words are elements: tap one on the preview, or pick it in the Elements card, to restyle or move it.');
}

/* ── export ── */
/* load a vendor script once — `ready` reads the global it defines, which is
   the one signal that cannot lie about whether it already loaded */
function loadScriptOnce(src, ready) {
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.addEventListener('load', resolve);
    s.addEventListener('error', () => reject(new Error('Could not load ' + src)));
    document.head.append(s);
  });
}

function exportName(ext, suffix) {
  return (parsed.meta.name || 'script').replace(/[^\w\d]+/g, '_') + (suffix != null ? suffix : '_script') + '.' + ext;
}

const EXPORT_BUTTONS = ['fs-export-share', 'fs-export-png', 'fs-export-pdf', 'fs-export-all', 'fs-export-copy'];
let exporting = false;
function progress(text) {
  const p = $('fs-progress');
  if (!p) return;
  p.textContent = text || '';
  p.hidden = !text;
}
async function withExport(btn, fn) {
  if (exporting) return;
  exporting = true;
  const old = btn.textContent;
  btn.textContent = 'Exporting…';
  for (const id of EXPORT_BUTTONS) if ($(id)) $(id).disabled = true;
  try {
    await fn();
  } catch (e) {
    console.error(e);
    note('Export failed. If the script uses off-site icon images, tick the proxy option and try again.', 'err');
  } finally {
    exporting = false;
    btn.textContent = old;
    progress('');
    for (const id of EXPORT_BUTTONS) if ($(id)) $(id).disabled = false;
  }
}

/* Capture grades:
   - 'png'   print PNG at the print scale — lossless, ~30 MB at 3×
   - 'jpeg'  print JPEG at the print scale — the PDF page; the sheet is
             opaque, and jsPDF stores an RGBA PNG this size as ~90 MB of
             raw pixels where the JPEG lands under 10
   - 'share' JPEG at the share scale (1863 px wide, ~1 MB) — crisp on any
             screen and small enough for Discord */
async function captureNode(node, kind) {
  await loadScriptOnce('assets/fancyscripts/vendor/html-to-image.min.js', () => window.htmlToImage);
  await document.fonts.ready;
  if (!node) throw new Error('Nothing to export yet.');
  const x = options.exportOpts;
  const q = clamp(Number(x.jpegQuality) || 0.92, 0.5, 1);
  if (kind === 'jpeg') {
    return window.htmlToImage.toJpeg(node, { pixelRatio: x.printScale || 3, cacheBust: false, quality: q });
  }
  if (kind === 'share') {
    return window.htmlToImage.toJpeg(node, { pixelRatio: x.shareScale || 1.5, cacheBust: false, quality: Math.min(q, 0.9) });
  }
  return window.htmlToImage.toPng(node, { pixelRatio: x.printScale || 3, cacheBust: false });
}

/* Exports render every page OFFSCREEN in a laid-out but invisible holder —
   fitTitle and the drag-free back both need real layout — and wait for
   the page's images (and the back's background pass) before capturing. */
function offscreenHolder() {
  const holder = document.createElement('div');
  Object.assign(holder.style, {
    position: 'fixed', left: '-99999px', top: '0',
    width: SHEET_W + 'px', height: SHEET_H + 'px', overflow: 'hidden',
  });
  document.body.append(holder);
  return holder;
}

function waitBackReady() {
  backCanvas(options.back, requestRender); // kick the pass if it is not cached
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = () => {
      if (backReady(options.back)) return resolve();
      if (Date.now() - t0 > 30000) return reject(new Error('The back cover background timed out.'));
      setTimeout(poll, 120);
    };
    poll();
  });
}

function waitImages(node) {
  const imgs = [...node.querySelectorAll('img')];
  return Promise.all(imgs.map((im) => (im.complete ? Promise.resolve() : new Promise((res) => {
    im.addEventListener('load', res, { once: true });
    im.addEventListener('error', res, { once: true });
    setTimeout(res, 8000);
  })))).then(() => new Promise((r) => setTimeout(r, 60)));
}

async function withPageNode(p, fn) {
  if (p.kind === 'back') { seedBackColor(); await waitBackReady(); }
  const holder = offscreenHolder();
  try {
    computeLayouts();
    const node = renderPageNode(p, { forExport: true });
    holder.append(node);
    if (p.kind === 'front') fitTitle(node, options);
    else if (p.kind !== 'back') fitListPage(node);
    await waitImages(node);
    if (p.kind === 'front') fitTitle(node, options); // the logo's width is known now
    return await fn(node);
  } finally {
    holder.remove();
    requestRender(); // hand the singleton canvases back to the preview
  }
}

function dataUrlToBlob(url) {
  const [head, data] = url.split(',');
  const mime = /data:([^;]+)/.exec(head)[1];
  const bin = atob(data);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function download(dataUrl, name) {
  downloadBlob(dataUrlToBlob(dataUrl), name);
}

function pageSuffix(p) {
  if (p.kind === 'front') return p.of > 1 ? '_sheet' + (p.index + 1) : '_script';
  if (p.kind === 'night') return '_' + (p.which === 'both' ? 'night_order' : p.which === 'first' ? 'first_night' : 'other_nights') + (p.of > 1 ? (p.index + 1) : '');
  if (p.kind === 'jinx') return '_jinxes' + (p.of > 1 ? (p.index + 1) : '');
  return '_back';
}

async function exportPNG() {
  const p = currentPage();
  const url = await withPageNode(p, (n) => captureNode(n, 'png'));
  download(url, exportName('png', pageSuffix(p)));
}

async function exportShare() {
  const p = currentPage();
  const url = await withPageNode(p, (n) => captureNode(n, 'share'));
  download(url, exportName('jpg', pageSuffix(p)));
}

/* the share image straight to the clipboard (PNG — the clipboard takes
   no JPEG), for pasting into Discord without a file in between */
async function copyImage() {
  if (!navigator.clipboard || !window.ClipboardItem) throw new Error('This browser cannot copy images.');
  const p = currentPage();
  await loadScriptOnce('assets/fancyscripts/vendor/html-to-image.min.js', () => window.htmlToImage);
  const url = await withPageNode(p, (n) => window.htmlToImage.toPng(n, { pixelRatio: options.exportOpts.shareScale || 1.5, cacheBust: false }));
  const blob = dataUrlToBlob(url);
  await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]);
  toast('Copied — paste it anywhere');
}

function exportPages() {
  const x = options.exportOpts.pages;
  return pages.filter((p) => (p.kind === 'front' ? x.front !== false : p.kind === 'night' ? x.night !== false
    : p.kind === 'jinx' ? x.jinx !== false : true));
}

async function exportAll() {
  const list = exportPages();
  for (let i = 0; i < list.length; i++) {
    progress('Rendering ' + list[i].label + ' (' + (i + 1) + ' of ' + list.length + ')…');
    const url = await withPageNode(list[i], (n) => captureNode(n, 'png'));
    download(url, exportName('png', pageSuffix(list[i])));
    await new Promise((r) => setTimeout(r, 400)); // let the browser start each download
  }
}

async function exportPDF() {
  await loadScriptOnce('assets/fancyscripts/vendor/jspdf.umd.min.js', () => window.jspdf);
  const fmt = PAGE_FORMATS[options.exportOpts.pageSize] || PAGE_FORMATS.trim;
  const list = exportPages();
  if (!list.length) throw new Error('No pages ticked for the PDF.');
  const pdf = new window.jspdf.jsPDF({ orientation: 'portrait', unit: 'pt', format: [fmt.w, fmt.h] });
  // the sheet keeps its aspect and centres on the paper
  const k = Math.min(fmt.w / SHEET_W, fmt.h / SHEET_H);
  const w = SHEET_W * k, h = SHEET_H * k;
  const x = (fmt.w - w) / 2, y = (fmt.h - h) / 2;
  const margin = options.exportOpts.marginColor || '#ffffff';
  for (let i = 0; i < list.length; i++) {
    progress('Rendering ' + list[i].label + ' (' + (i + 1) + ' of ' + list.length + ')…');
    const img = await withPageNode(list[i], (n) => captureNode(n, 'jpeg'));
    if (i > 0) pdf.addPage([fmt.w, fmt.h], 'portrait');
    if (x > 0.5 || y > 0.5) {
      const rgb = hexToRgb(margin) || [255, 255, 255];
      pdf.setFillColor(rgb[0], rgb[1], rgb[2]);
      pdf.rect(0, 0, fmt.w, fmt.h, 'F');
    }
    pdf.addImage(img, 'JPEG', x, y, w, h);
  }
  pdf.save(exportName('pdf', ''));
}

/* ── boot ── */
async function boot() {
  buildPagesCard();
  buildTitleCard();
  buildLayoutCard();
  buildColorsCard();
  buildFontsCard();
  buildBgCard();
  buildNightCard();
  buildJinxCard();
  buildExportCard();
  buildBackPanel();
  buildCharPanel();
  buildElementPanel();
  syncControls();
  mountPreviewDrag();
  document.addEventListener('keydown', onKey);

  // the official roster: roles.json + this tool's jinx map + the night
  // positions, handed to the engine
  try {
    const [roles, jinxes, night] = await Promise.all([
      fetch('assets/roles.json').then((r) => r.json()),
      fetch('assets/fancyscripts/official-jinxes.json').then((r) => r.json()),
      fetch('assets/night-order.json').then((r) => r.json()),
    ]);
    setOfficialRoster(roles, jinxes, night);
  } catch {
    note('Could not load the official roster — official character ids will render bare.', 'err');
  }
  if (window.saoCompare) setSaoCompare(window.saoCompare);

  // wire the static inputs
  $('fs-file').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) loadFile(f);
    e.target.value = '';
  });
  $('fs-upload-btn').addEventListener('click', () => $('fs-file').click());
  $('fs-paste-toggle').addEventListener('click', () => {
    const box = $('fs-paste-box');
    box.hidden = !box.hidden;
    $('fs-paste-toggle').textContent = box.hidden ? '…or paste JSON directly' : 'Hide the paste box';
  });
  $('fs-paste-load').addEventListener('click', () => {
    try {
      loadJson(JSON.parse($('fs-paste-text').value), 'the pasted JSON');
      $('fs-paste-box').hidden = true;
      $('fs-paste-toggle').textContent = '…or paste JSON directly';
    } catch {
      note('Pasted text is not valid JSON.', 'err');
    }
  });
  $('fs-wiki-script').addEventListener('change', (e) => {
    const v = e.target.value;
    if (!v) return;
    const i = v.indexOf(':');
    loadWikiScript(v.slice(i + 1), false, v.slice(0, i));
  });
  $('fs-sample-tb').addEventListener('click', () => loadJson(SAMPLE_TROUBLE_BREWING, 'Trouble Brewing'));
  $('fs-sample-hh').addEventListener('click', () => loadJson(SAMPLE_HAROLD_HOLT, "Harold Holt's Revenge"));
  $('fs-sample-bi').addEventListener('click', () => {
    loadJson(SAMPLE_BLENDING_IN, 'Blending In (night-order demo)');
    options.night.first = true; options.night.other = true;
    syncControls(); commit();
  });

  $('fs-export-share').addEventListener('click', (e) => withExport(e.currentTarget, exportShare));
  $('fs-export-png').addEventListener('click', (e) => withExport(e.currentTarget, exportPNG));
  $('fs-export-pdf').addEventListener('click', (e) => withExport(e.currentTarget, exportPDF));
  $('fs-export-all').addEventListener('click', (e) => withExport(e.currentTarget, exportAll));
  $('fs-export-copy').addEventListener('click', (e) => withExport(e.currentTarget, async () => {
    try { await copyImage(); } catch (err) { note((err && err.message) || 'Could not copy.', 'err'); }
  }));
  $('fs-undo').addEventListener('click', undo);
  $('fs-redo').addEventListener('click', redo);
  $('fs-zoom-in').addEventListener('click', () => setZoom(Math.min(3, (zoom === 'fit' ? lastScale : zoom) * 1.25)));
  $('fs-zoom-out').addEventListener('click', () => setZoom(Math.max(0.15, (zoom === 'fit' ? lastScale : zoom) / 1.25)));
  $('fs-zoom-fit').addEventListener('click', () => setZoom('fit'));
  $('fs-zoom-100').addEventListener('click', () => setZoom(1));
  // ctrl+wheel and pinch zoom the preview
  $('fs-preview').addEventListener('wheel', (ev) => {
    if (!ev.ctrlKey && !ev.metaKey) return;
    ev.preventDefault();
    const cur = zoom === 'fit' ? lastScale : zoom;
    setZoom(clamp(cur * (ev.deltaY < 0 ? 1.1 : 0.9), 0.15, 3));
  }, { passive: false });
  let pinch = null;
  $('fs-preview').addEventListener('touchstart', (ev) => {
    if (ev.touches.length === 2) pinch = { d: Math.hypot(ev.touches[0].clientX - ev.touches[1].clientX, ev.touches[0].clientY - ev.touches[1].clientY), z: zoom === 'fit' ? lastScale : zoom };
  }, { passive: true });
  $('fs-preview').addEventListener('touchmove', (ev) => {
    if (!pinch || ev.touches.length !== 2) return;
    const d = Math.hypot(ev.touches[0].clientX - ev.touches[1].clientX, ev.touches[0].clientY - ev.touches[1].clientY);
    setZoom(clamp(pinch.z * (d / pinch.d), 0.15, 3));
  }, { passive: true });
  $('fs-preview').addEventListener('touchend', () => { pinch = null; }, { passive: true });

  new ResizeObserver(fitPreview).observe($('fs-preview'));
  window.addEventListener('resize', fitPreview);
  // wraps and the title width both change once the real fonts arrive
  document.fonts.ready.then(() => { fontsChanged(); reparse(); requestRender(); });
  // and warm the sheet's faces so the first render already measures right
  for (const f of ['LHF Unlovable', 'Dumbledor', 'Goudy Old Style', 'Trade Gothic', 'Trade Gothic Bold Condensed']) {
    document.fonts.load(`16px "${f}"`).catch(() => {});
  }

  // ?s={slug} / ?c={id} deep links — the "Fancy Sheet" buttons on /s/ and
  // /collection/ pages — and ?from=builder, the Script Builder's hand-off
  // (the roster waits in localStorage, written by script.html)
  const params = new URLSearchParams(location.search);
  const slug = params.get('s');
  const coll = params.get('c');
  const wikiKey = slug ? 'wiki:' + slug : coll ? 'wiki:c:' + coll : '';
  fillScriptPicker(slug ? 'script:' + slug : coll ? 'collection:' + coll : '');
  const saved = readAutosave();
  let incoming = null;
  if (params.get('from') === 'builder') {
    try {
      const raw = localStorage.getItem('botc_fancy_incoming');
      if (raw) { incoming = JSON.parse(raw); localStorage.removeItem('botc_fancy_incoming'); }
    } catch { incoming = null; }
  }
  if (incoming) {
    loadJson(incoming, 'your Script Builder roster');
  } else if (wikiKey) {
    const same = !!(saved && saved.key === wikiKey);
    if (same) applyDesignData(saved);
    await loadWikiScript(slug || coll, same, slug ? 'script' : 'collection');
    if (same) { buildFontSelects(); toast('Your last design for this ' + (slug ? 'script' : 'collection') + ' is back'); }
  } else if (saved && saved.script) {
    applyDesignData(saved);
    loadJson(saved.script, saved.sourceLabel || 'your last session', saved.key && saved.key.startsWith('wiki:') ? saved.key.slice(5) : '', true);
    buildFontSelects();
    note('Restored your last design from this browser. Pick a script or a sample to start fresh.', 'ok');
  }
  if (rawJson == null) loadJson(SAMPLE_TROUBLE_BREWING);
}

/* a small handle for the console and the render harness: read or patch
   the options, load a script, jump to a page, select an element */
window.FancyScripts = {
  options: () => options,
  patch(p) { options = normalizeOptions(deepMerge(options, p)); pushHistory(); afterOptionsReplaced(); },
  load: (json, label) => loadJson(json, label),
  page(key) { currentKey = key; selectedId = ''; requestRender(); },
  pages: () => pages.map(pageKey),
  select: (id) => setSelected(id),
  render: () => render(),
  derived: () => derived,
  layouts: () => layouts,
  workerActive: () => pixelWorkerActive(),
};

boot();
