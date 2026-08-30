/* Fancy Scripts — the page controller.
 *
 * Owns everything around the sheet: loading a script (a published wiki
 * script, an uploaded/pasted JSON, a sample), the option controls, the
 * scaled preview, and the PNG/PDF export. The sheet itself is sheet.js;
 * parsing and geometry are script.js. State is the truth and the DOM is a
 * view of it: every control writes into `options` and asks for a render,
 * and render() rebuilds the sheet from scratch (a full build is a few
 * milliseconds — cheap enough to run per input event behind one rAF).
 *
 * The export libraries (html-to-image, jspdf — assets/fancyscripts/vendor/)
 * are lazy-loaded on the first export, so an ordinary visit costs nothing.
 */

import {
  DEFAULT_OPTIONS, TRIM_W_PT, TRIM_H_PT, SHEET_W, SHEET_H,
  parseScript, setOfficialRoster,
} from './script.js';
import { renderSheet, fitTitle } from './sheet.js';

const $ = (id) => document.getElementById(id);

/* ── state ── */
let options = { ...DEFAULT_OPTIONS };
let rawJson = null;
let parsed = { meta: { name: 'Untitled Script', author: '' }, characters: [], warnings: [] };

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

function render() {
  const wrap = $('fs-sheet-wrap');
  const sheet = renderSheet(parsed, options, requestRender);
  wrap.textContent = '';
  wrap.append(sheet);
  fitTitle(sheet, options);
  showSolvedDensity(sheet);
  fitPreview();
}

/* fit the fixed-size sheet into whatever width the preview box has */
function fitPreview() {
  const box = $('fs-preview');
  const outer = $('fs-scale-box');
  const wrap = $('fs-sheet-wrap');
  const scale = Math.min(1, (box.clientWidth - 12) / SHEET_W);
  outer.style.width = SHEET_W * scale + 'px';
  outer.style.height = SHEET_H * scale + 'px';
  wrap.style.transform = 'scale(' + scale + ')';
}

/* ── loading scripts ── */
function loadJson(json, sourceLabel) {
  rawJson = json;
  reparse();
  // a fresh script gets fresh overrides — the old title would stick otherwise
  options.titleOverride = '';
  options.authorOverride = '';
  syncControls();
  requestRender();
  if (sourceLabel) note('Loaded ' + sourceLabel + '.', 'ok');
}

function loadFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      loadJson(JSON.parse(String(reader.result)), file.name);
    } catch {
      note('That file is not valid JSON.', 'err');
    }
  };
  reader.readAsText(file);
}

async function loadWikiScript(slug) {
  note('Loading script…');
  try {
    const r = await fetch('/api/page-json?type=script&slug=' + encodeURIComponent(slug));
    if (!r.ok) throw new Error('Could not load that script (HTTP ' + r.status + ').');
    loadJson(await r.json(), 'the script from this wiki');
  } catch (e) {
    note(e && e.message ? e.message : 'Could not load that script.', 'err');
  }
}

/* the picker: every published script on the wiki, by name */
async function fillScriptPicker(preselect) {
  const sel = $('fs-wiki-script');
  try {
    const r = await fetch('/scripts.json');
    const rows = await r.json();
    rows.sort((a, b) => String(a.name || a.slug).localeCompare(String(b.name || b.slug)));
    for (const s of rows) {
      if (!s.slug) continue;
      const o = document.createElement('option');
      o.value = s.slug;
      o.textContent = (s.name || s.slug) + (s.author ? ' — ' + s.author : '');
      sel.append(o);
    }
    if (preselect) sel.value = preselect;
  } catch {
    // the picker is a convenience; upload/paste still work without it
  }
}

/* ── controls ──
   Built from a schema so there is exactly one binding path. Each row writes
   options[key] and requests a render; syncControls() pushes state back into
   the inputs (after Reset or loading a script). */
const pct = (v) => Math.round(v * 100) + '%';
const signed = (dp, unit) => (v) => (v > 0 ? '+' : '') + v.toFixed(dp) + (unit || '');

const SLIDERS = [
  // [key, label, min, max, step, format, section]
  ['density', 'Text density', 0.5, 1.5, 0.01, pct, 'layout'],
  ['iconSize', 'Icon size', 0.6, 1.6, 0.01, pct, 'layout'],
  ['textSize', 'Text size', 0.7, 1.4, 0.01, pct, 'layout'],
  ['nameSize', 'Name size', 0.6, 1.5, 0.01, pct, 'layout'],
  ['titleSize', 'Title size', 0.5, 1.6, 0.01, pct, 'decor'],
  ['titleDX', 'Title horizontal', -15, 15, 0.1, signed(1, '%'), 'decor'],
  ['titleDY', 'Title vertical', -4, 4, 0.05, signed(2), 'decor'],
  ['skullScale', 'Skull size', 0.5, 1.5, 0.01, pct, 'decor'],
  ['skullDX', 'Skull horizontal', -10, 10, 0.1, signed(1, '%'), 'decor'],
  ['skullDY', 'Skull vertical', -3, 3, 0.05, signed(2), 'decor'],
  ['flourishScale', 'Flourish size', 0.5, 1.5, 0.01, pct, 'decor'],
  ['flourishSpread', 'Flourish spread', -8, 8, 0.1, signed(1, '%'), 'decor'],
  ['flourishDY', 'Flourish vertical', -3, 3, 0.05, signed(2), 'decor'],
];

const TOGGLES = [
  ['fitToContent', 'Auto-fit text to fill the page'],
  ['showJinxes', 'Jinx icons beside names'],
  ['showFootnote', '“*Not the first night” footnote'],
  ['useLogo', 'Use the script’s logo image as the title'],
  ['showAuthor', 'Author credit under the title'],
  ['includeBackCover', 'Damask back cover in the PDF'],
  ['proxyIcons', 'Route off-site icons through a proxy (safer export)'],
];

const COLORS = [
  ['titleColor', 'Title'],
  ['goodColor', 'Good names'],
  ['evilColor', 'Evil names'],
  ['sidebarColor', 'Sidebar'],
];

const controlEls = {}; // key -> input element

function buildControls() {
  for (const [key, label, min, max, step, format, section] of SLIDERS) {
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
    input.addEventListener('input', () => {
      // touching the density slider IS choosing manual density — a disabled
      // slider just read as broken, so auto-fit unticks itself instead
      if (key === 'density' && options.fitToContent) {
        options.fitToContent = false;
        if (controlEls.fitToContent) controlEls.fitToContent.input.checked = false;
      }
      options[key] = Number(input.value);
      val.textContent = format(options[key]);
      requestRender();
    });
    row.append(head, input);
    $('fs-' + section + '-sliders').append(row);
    controlEls[key] = { input, val, format };
  }

  for (const [key, label] of TOGGLES) {
    const lab = document.createElement('label');
    lab.className = 'fs-toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.addEventListener('change', () => {
      options[key] = input.checked;
      if (key === 'fitToContent') syncControls(); // density goes (in)active
      if (key === 'proxyIcons') reparse(); // icon urls are chosen at parse time
      requestRender();
    });
    const span = document.createElement('span');
    span.textContent = label;
    lab.append(input, span);
    $('fs-toggles').append(lab);
    controlEls[key] = { input };
  }

  for (const [key, label] of COLORS) {
    const row = document.createElement('div');
    row.className = 'fs-color';
    const picker = createColorPicker(options[key], (hex) => {
      options[key] = hex;
      requestRender();
    });
    const span = document.createElement('span');
    span.textContent = label;
    row.append(picker.root, span);
    $('fs-colors').append(row);
    controlEls[key] = { picker };
  }
}

/* ── colour picker ──────────────────────────────────────────────────────
   Hand-rolled: a saturation/value square, a hue slider and a hex box in a
   little popover. Exists because <input type="color"> on Android Chrome is
   a grid of ~20 preset swatches with no free choice at all — the one place
   the owner actually reviews from. */
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r, g, b) {
  const to = (v) => Math.round(v).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}
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

let openPickerClose = null; // at most one popover open at a time

function createColorPicker(initial, onChange) {
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
  pop.append(sv, hue, row);
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
  hue.addEventListener('input', () => {
    state.h = Number(hue.value);
    emit();
  });
  hex.addEventListener('input', () => {
    const rgb = hexToRgb(hex.value);
    if (rgb) {
      Object.assign(state, rgbToHsv(...rgb));
      emit(true); // keep the half-typed text as the user wrote it
    }
  });

  const close = () => {
    pop.hidden = true;
    document.removeEventListener('pointerdown', onOutside, true);
    if (openPickerClose === close) openPickerClose = null;
  };
  const onOutside = (ev) => { if (!root.contains(ev.target)) close(); };
  swatch.addEventListener('click', () => {
    if (!pop.hidden) return close();
    if (openPickerClose) openPickerClose();
    openPickerClose = close;
    paint();
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

function syncControls() {
  for (const [key, entry] of Object.entries(controlEls)) {
    const v = options[key];
    if (entry.picker) { entry.picker.set(String(v)); continue; }
    if (entry.input.type === 'checkbox') entry.input.checked = !!v;
    else entry.input.value = v;
    if (entry.val) entry.val.textContent = entry.format(Number(v));
  }
  $('fs-title-override').value = options.titleOverride;
  $('fs-author-override').value = options.authorOverride;
  $('fs-sort-mode').value = options.sortMode;
  $('fs-column-layout').value = options.columnLayout;
}

/* while auto-fit is on, the density slider tracks the density it solved
   for — so the thumb is honest, and dragging it takes over from there */
function showSolvedDensity(sheet) {
  if (!options.fitToContent) return;
  const dens = controlEls.density;
  const solved = Number(sheet.dataset.fsDensity);
  if (!dens || !solved) return;
  dens.input.value = solved;
  dens.val.textContent = 'auto · ' + dens.format(solved);
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

function exportName(ext) {
  return (parsed.meta.name || 'script').replace(/[^\w\d]+/g, '_') + '_script.' + ext;
}

const EXPORT_BUTTONS = ['fs-export-share', 'fs-export-png', 'fs-export-pdf'];
let exporting = false;
async function withExport(btn, fn) {
  if (exporting) return;
  exporting = true;
  const old = btn.textContent;
  btn.textContent = 'Exporting…';
  for (const id of EXPORT_BUTTONS) $(id).disabled = true;
  try {
    await fn();
  } catch (e) {
    console.error(e);
    note('Export failed. If the script uses off-site icon images, tick the proxy option and try again.', 'err');
  } finally {
    exporting = false;
    btn.textContent = old;
    for (const id of EXPORT_BUTTONS) $(id).disabled = false;
  }
}

/* Three capture grades:
   - 'png'   print PNG, pixelRatio 3 (3726 px wide) — lossless, ~30 MB
   - 'jpeg'  print JPEG, pixelRatio 3 — the PDF page; the sheet is fully
             opaque, and jsPDF stores an RGBA PNG this size as ~90 MB of
             raw pixels where the JPEG lands under 10
   - 'share' JPEG at pixelRatio 1.5 (1863 px wide, ~1 MB) — crisp on any
             screen and small enough for Discord */
async function captureSheet(kind) {
  await loadScriptOnce('assets/fancyscripts/vendor/html-to-image.min.js', () => window.htmlToImage);
  await document.fonts.ready;
  const node = document.querySelector('#fs-sheet-wrap .script-sheet');
  if (!node) throw new Error('Nothing to export yet.');
  if (kind === 'jpeg') {
    return window.htmlToImage.toJpeg(node, { pixelRatio: 3, cacheBust: false, quality: 0.92 });
  }
  if (kind === 'share') {
    return window.htmlToImage.toJpeg(node, { pixelRatio: 1.5, cacheBust: false, quality: 0.85 });
  }
  return window.htmlToImage.toPng(node, { pixelRatio: 3, cacheBust: false });
}

function download(href, name) {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.click();
}

async function exportPNG() {
  download(await captureSheet('png'), exportName('png'));
}

async function exportShare() {
  download(await captureSheet('share'), exportName('jpg'));
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not load ' + src));
    image.src = src;
  });
}

/* The damask back cover: the pattern inset like the reference (26.5 pt
   margin) with the title in gold blackletter over it, composed into ONE
   flattened canvas and embedded as JPEG. jsPDF stores anything with an
   alpha channel as raw pixels — two full-page RGBA layers made the PDF
   ~35 MB; this lands around 1. */
async function backCoverDataUrl() {
  const titleStr = options.titleOverride.trim() || parsed.meta.name;
  const damask = await loadImage('assets/fancyscripts/art/damask.jpg');
  const cv = document.createElement('canvas');
  cv.width = SHEET_W * 2;
  cv.height = SHEET_H * 2;
  const ctx = cv.getContext('2d');
  ctx.scale(2, 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, SHEET_W, SHEET_H);
  const m = (26.5 / TRIM_W_PT) * SHEET_W;
  ctx.drawImage(damask, m, m, SHEET_W - 2 * m, SHEET_H - 2 * m);

  const maxW = SHEET_W * 0.62;
  // shrink-to-fit font size, then word-wrap
  let fontPx = 110;
  const wrap = (size) => {
    ctx.font = size + 'px "LHF Unlovable", "Goudy Text MT", serif';
    const lines = [];
    let cur = '';
    for (const w of titleStr.split(/\s+/)) {
      const t = cur ? cur + ' ' + w : w;
      if (ctx.measureText(t).width > maxW && cur) {
        lines.push(cur);
        cur = w;
      } else cur = t;
    }
    if (cur) lines.push(cur);
    return lines;
  };
  let lines = wrap(fontPx);
  while (fontPx > 40 && lines.some((l) => ctx.measureText(l).width > maxW)) {
    fontPx -= 4;
    lines = wrap(fontPx);
  }
  const lh = fontPx * 1.18;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((ln, i) => {
    const y = SHEET_H / 2 + (i - (lines.length - 1) / 2) * lh;
    ctx.fillStyle = 'rgba(46, 36, 10, 0.6)';
    ctx.fillText(ln, SHEET_W / 2 + 4, y + 4);
    ctx.fillStyle = '#c1a52e';
    ctx.fillText(ln, SHEET_W / 2, y);
  });
  return cv.toDataURL('image/jpeg', 0.85);
}

async function exportPDF() {
  const dataUrl = await captureSheet('jpeg');
  await loadScriptOnce('assets/fancyscripts/vendor/jspdf.umd.min.js', () => window.jspdf);
  const pdf = new window.jspdf.jsPDF({
    orientation: 'portrait',
    unit: 'pt',
    format: [TRIM_W_PT, TRIM_H_PT],
  });
  pdf.addImage(dataUrl, 'JPEG', 0, 0, TRIM_W_PT, TRIM_H_PT);
  if (options.includeBackCover) {
    pdf.addPage([TRIM_W_PT, TRIM_H_PT], 'portrait');
    pdf.addImage(await backCoverDataUrl(), 'JPEG', 0, 0, TRIM_W_PT, TRIM_H_PT);
  }
  pdf.save(exportName('pdf'));
}

/* ── boot ── */
async function boot() {
  buildControls();
  syncControls();

  // the official roster: roles.json + this tool's jinx map, handed to the engine
  try {
    const [roles, jinxes] = await Promise.all([
      fetch('assets/roles.json').then((r) => r.json()),
      fetch('assets/fancyscripts/official-jinxes.json').then((r) => r.json()),
    ]);
    setOfficialRoster(roles, jinxes);
  } catch {
    note('Could not load the official roster — official character ids will render bare.', 'err');
  }

  // wire the static inputs
  $('fs-title-override').addEventListener('input', (e) => {
    options.titleOverride = e.target.value;
    requestRender();
  });
  $('fs-author-override').addEventListener('input', (e) => {
    options.authorOverride = e.target.value;
    requestRender();
  });
  $('fs-sort-mode').addEventListener('change', (e) => {
    options.sortMode = e.target.value;
    requestRender();
  });
  $('fs-column-layout').addEventListener('change', (e) => {
    options.columnLayout = e.target.value;
    requestRender();
  });
  $('fs-decor-reset').addEventListener('click', () => {
    for (const k of ['titleSize', 'titleDX', 'titleDY', 'skullScale', 'skullDX',
      'skullDY', 'flourishScale', 'flourishSpread', 'flourishDY']) {
      options[k] = DEFAULT_OPTIONS[k];
    }
    syncControls();
    requestRender();
  });

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
    if (e.target.value) loadWikiScript(e.target.value);
  });
  $('fs-sample-tb').addEventListener('click', () => loadJson(SAMPLE_TROUBLE_BREWING, 'Trouble Brewing'));
  $('fs-sample-hh').addEventListener('click', () => loadJson(SAMPLE_HAROLD_HOLT, "Harold Holt's Revenge"));

  $('fs-export-share').addEventListener('click', (e) => withExport(e.target, exportShare));
  $('fs-export-png').addEventListener('click', (e) => withExport(e.target, exportPNG));
  $('fs-export-pdf').addEventListener('click', (e) => withExport(e.target, exportPDF));

  new ResizeObserver(fitPreview).observe($('fs-preview'));
  // wraps and the title width both change once the real fonts arrive
  document.fonts.ready.then(() => { reparse(); requestRender(); });

  // ?s={slug} deep link — the "Fancy script sheet" button on /s/ pages
  const slug = new URLSearchParams(location.search).get('s');
  fillScriptPicker(slug || '');
  if (slug) await loadWikiScript(slug);
  if (rawJson == null) loadJson(SAMPLE_TROUBLE_BREWING);
}

boot();
