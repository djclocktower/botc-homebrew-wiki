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
  DEFAULT_OPTIONS, DEFAULT_BACK, TRIM_W_PT, TRIM_H_PT, SHEET_W, SHEET_H,
  parseScript, setOfficialRoster, seedBackTexts,
} from './script.js';
import { renderSheet, fitTitle } from './sheet.js';
import { renderBack, mountBackDrag, backCanvas, backReady } from './back.js';

const $ = (id) => document.getElementById(id);

/* ── state ── */
let options = { ...DEFAULT_OPTIONS };
options.back = { ...DEFAULT_BACK, texts: [] };
let view = 'front'; // which side the preview shows: 'front' | 'back'
let backSel = -1; // selected back-cover text element
let lastScale = 1; // preview scale, for mapping drag pointer px to sheet px
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
  wrap.textContent = '';
  if (view === 'back') {
    const backEl = renderBack(parsed, options, requestRender, { selected: backSel });
    mountBackDrag(backEl, options.back, {
      getScale: () => lastScale,
      // selection must not rebuild the preview — a rebuild mid-drag destroys
      // the element holding the pointer capture; the ring is drawn live
      onSelect: (i) => { backSel = i; buildBackChips(); buildBackElementPanel(); },
      onCommit: requestRender,
    });
    wrap.append(backEl);
  } else {
    const sheet = renderSheet(parsed, options, requestRender);
    wrap.append(sheet);
    fitTitle(sheet, options);
    showSolvedDensity(sheet);
  }
  fitPreview();
}

/* switch the preview side and show that side's controls */
function applyView(v) {
  view = v;
  $('fs-tab-front').classList.toggle('on', v === 'front');
  $('fs-tab-back').classList.toggle('on', v === 'back');
  document.querySelectorAll('.fs-front-card').forEach((el) => { el.hidden = v !== 'front'; });
  $('fs-back-card').hidden = v !== 'back';
  requestRender();
}

/* fit the fixed-size sheet into whatever width the preview box has */
function fitPreview() {
  const box = $('fs-preview');
  const outer = $('fs-scale-box');
  const wrap = $('fs-sheet-wrap');
  const scale = Math.min(1, (box.clientWidth - 12) / SHEET_W);
  lastScale = scale;
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
  options.back.texts = seedBackTexts(parsed.meta.name);
  backSel = options.back.texts.length ? 0 : -1; // the panel stays open
  buildBackChips();
  buildBackElementPanel();
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
  ['sidebarShade', 'Sidebar shading', 0, 1, 0.01, pct, 'colors'],
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
  ['includeBackCover', 'Back cover page in the PDF'],
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

function exportName(ext, suffix) {
  return (parsed.meta.name || 'script').replace(/[^\w\d]+/g, '_') + '_script' + (suffix || '') + '.' + ext;
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
async function captureNode(node, kind) {
  await loadScriptOnce('assets/fancyscripts/vendor/html-to-image.min.js', () => window.htmlToImage);
  await document.fonts.ready;
  if (!node) throw new Error('Nothing to export yet.');
  if (kind === 'jpeg') {
    return window.htmlToImage.toJpeg(node, { pixelRatio: 3, cacheBust: false, quality: 0.92 });
  }
  if (kind === 'share') {
    return window.htmlToImage.toJpeg(node, { pixelRatio: 1.5, cacheBust: false, quality: 0.85 });
  }
  return window.htmlToImage.toPng(node, { pixelRatio: 3, cacheBust: false });
}

/* Exports render the side they need OFFSCREEN when it is not the one on
   screen (the PDF always needs both), in a laid-out but invisible holder —
   fitTitle and the drag-free back both need real layout. The back render
   waits for its background canvas: the recolour/shading pass is async and
   an export must never carry a stale background. */
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
      if (Date.now() - t0 > 20000) return reject(new Error('The back cover background timed out.'));
      setTimeout(poll, 120);
    };
    poll();
  });
}

async function withSideNode(side, fn) {
  const live = document.querySelector(
    side === 'back' ? '#fs-sheet-wrap .script-back' : '#fs-sheet-wrap .script-sheet');
  if (live && side === 'front') return fn(live);
  // the back always re-renders for export: the live copy may carry the
  // selection ring, and the singleton background canvas travels with it
  let holder = null;
  try {
    if (side === 'back') await waitBackReady();
    holder = offscreenHolder();
    let node;
    if (side === 'back') {
      node = renderBack(parsed, options, requestRender, { selected: -1 });
    } else {
      node = renderSheet(parsed, options, requestRender);
    }
    holder.append(node);
    if (side === 'front') fitTitle(node, options);
    await new Promise((r) => setTimeout(r, 250)); // let layout + images settle
    return await fn(node);
  } finally {
    if (holder) holder.remove();
    requestRender(); // hand the back's singleton canvas to the preview again
  }
}

function download(href, name) {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.click();
}

async function exportPNG() {
  const url = await withSideNode(view, (n) => captureNode(n, 'png'));
  download(url, exportName('png', view === 'back' ? '_back' : ''));
}

async function exportShare() {
  const url = await withSideNode(view, (n) => captureNode(n, 'share'));
  download(url, exportName('jpg', view === 'back' ? '_back' : ''));
}

async function exportPDF() {
  const front = await withSideNode('front', (n) => captureNode(n, 'jpeg'));
  await loadScriptOnce('assets/fancyscripts/vendor/jspdf.umd.min.js', () => window.jspdf);
  const pdf = new window.jspdf.jsPDF({
    orientation: 'portrait',
    unit: 'pt',
    format: [TRIM_W_PT, TRIM_H_PT],
  });
  pdf.addImage(front, 'JPEG', 0, 0, TRIM_W_PT, TRIM_H_PT);
  if (options.includeBackCover) {
    const back = await withSideNode('back', (n) => captureNode(n, 'jpeg'));
    pdf.addPage([TRIM_W_PT, TRIM_H_PT], 'portrait');
    pdf.addImage(back, 'JPEG', 0, 0, TRIM_W_PT, TRIM_H_PT);
  }
  pdf.save(exportName('pdf'));
}

/* ── back cover controls ────────────────────────────────────────────────
   The card rebuilds around the selection: chips name the text elements,
   the panel below edits the selected one. Everything writes straight into
   options.back and asks for a render, like every other control. */
function makeSlider(parent, label, min, max, step, format, get, set) {
  const row = document.createElement('div');
  row.className = 'fs-slider';
  const head = document.createElement('div');
  head.className = 'fs-slider-head';
  const name = document.createElement('span');
  name.textContent = label;
  const val = document.createElement('span');
  val.className = 'fs-slider-val';
  val.textContent = format(get());
  head.append(name, val);
  const input = document.createElement('input');
  input.type = 'range';
  input.min = min; input.max = max; input.step = step;
  input.value = get();
  input.addEventListener('input', () => {
    set(Number(input.value));
    val.textContent = format(get());
    requestRender();
  });
  row.append(head, input);
  parent.append(row);
}

const fmtPx = (v) => Math.round(v) + 'px';
const fmtDeg = (v) => (v > 0 ? '+' : '') + Math.round(v) + '°';
const fmtEm = (v) => v.toFixed(2) + 'em';

function buildBackControls() {
  const box = $('fs-back-bgbox');
  box.textContent = '';
  const b = options.back;

  const colorRow = document.createElement('div');
  colorRow.className = 'fs-back-colors';
  const addPicker = (parent, label, get, set) => {
    const row = document.createElement('div');
    row.className = 'fs-color';
    const picker = createColorPicker(get() || '#000000', (hex) => { set(hex); requestRender(); });
    const span = document.createElement('span');
    span.textContent = label;
    row.append(picker.root, span);
    parent.append(row);
  };
  addPicker(colorRow, 'Color', () => b.bgColor, (h) => { b.bgColor = h; });
  const gradLab = document.createElement('label');
  gradLab.className = 'fs-toggle';
  const gradTick = document.createElement('input');
  gradTick.type = 'checkbox';
  gradTick.checked = !!b.bgGradient;
  gradTick.addEventListener('change', () => {
    b.bgGradient = gradTick.checked;
    buildBackControls(); // the gradient rows come and go with the tick
    requestRender();
  });
  const gradSpan = document.createElement('span');
  gradSpan.textContent = 'Gradient';
  gradLab.append(gradTick, gradSpan);
  colorRow.append(gradLab);
  if (b.bgGradient) addPicker(colorRow, 'Color 2', () => b.bgColor2, (h) => { b.bgColor2 = h; });
  box.append(colorRow);
  if (b.bgGradient) {
    makeSlider(box, 'Gradient angle', 0, 360, 5, fmtDeg,
      () => b.bgGradAngle || 0, (v) => { b.bgGradAngle = v; });
  }
  makeSlider(box, 'Brightness', 0.4, 1.8, 0.02, pct, () => b.brightness, (v) => { b.brightness = v; });
  makeSlider(box, 'Saturation', 0, 2, 0.02, pct, () => b.saturation, (v) => { b.saturation = v; });
  makeSlider(box, 'Border shading', 0, 2, 0.02, pct, () => b.shading, (v) => { b.shading = v; });
  makeSlider(box, 'Pattern size', 0.4, 3, 0.02, pct, () => b.patScale, (v) => { b.patScale = v; });
  makeSlider(box, 'Pattern rotation', -180, 180, 1, fmtDeg, () => b.patRot, (v) => { b.patRot = v; });
}

function buildBackChips() {
  const box = $('fs-back-chips');
  if (!box) return;
  box.textContent = '';
  (options.back.texts || []).forEach((t, i) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'fs-chip' + (i === backSel ? ' on' : '');
    chip.textContent = (t.text || '…').slice(0, 14);
    chip.addEventListener('click', () => {
      backSel = i;
      buildBackChips();
      buildBackElementPanel();
      requestRender();
    });
    box.append(chip);
  });
}

const BACK_FONTS = [
  ['unlovable', 'LHF Unlovable (title)'],
  ['goudy', 'Goudy Old Style'],
  ['trade', 'Trade Gothic'],
  ['dumbledor', 'Dumbledor'],
];

function buildBackElementPanel() {
  const box = $('fs-back-el');
  if (!box) return;
  box.textContent = '';
  const t = (options.back.texts || [])[backSel];
  if (!t) {
    const hint = document.createElement('p');
    hint.className = 'fs-back-hint';
    hint.textContent = 'Tap a word on the preview (or a chip above) to edit it — then drag it to move.';
    box.append(hint);
    return;
  }
  const text = document.createElement('input');
  text.type = 'text';
  text.className = 'fs-field';
  text.value = t.text;
  text.setAttribute('aria-label', 'Text');
  text.addEventListener('input', () => {
    t.text = text.value;
    buildBackChips();
    requestRender();
  });
  box.append(text);

  const fontSel = document.createElement('select');
  fontSel.className = 'fs-select';
  fontSel.style.margin = '8px 0';
  for (const [v, label] of BACK_FONTS) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    fontSel.append(o);
  }
  fontSel.value = t.font || 'unlovable';
  fontSel.addEventListener('change', () => { t.font = fontSel.value; requestRender(); });
  box.append(fontSel);

  makeSlider(box, 'Size', 40, 640, 2, fmtPx, () => t.size, (v) => { t.size = v; });
  makeSlider(box, 'Rotation', -45, 45, 1, fmtDeg, () => t.rotate || 0, (v) => { t.rotate = v; });
  makeSlider(box, 'Letter spacing', -0.1, 0.4, 0.01, fmtEm, () => t.spacing || 0, (v) => { t.spacing = v; });
  makeSlider(box, 'Stroke width', 0, 8, 0.25, (v) => v.toFixed(2) + 'px', () => t.strokeW || 0, (v) => { t.strokeW = v; });
  makeSlider(box, 'Shadow across', -25, 25, 1, fmtPx, () => t.shadowX || 0, (v) => { t.shadowX = v; });
  makeSlider(box, 'Shadow down', -25, 25, 1, fmtPx, () => t.shadowY || 0, (v) => { t.shadowY = v; });
  makeSlider(box, 'Shadow blur', 0, 50, 1, fmtPx, () => t.shadowBlur || 0, (v) => { t.shadowBlur = v; });

  const gradLab = document.createElement('label');
  gradLab.className = 'fs-toggle';
  const gradTick = document.createElement('input');
  gradTick.type = 'checkbox';
  gradTick.checked = !!t.fillGrad;
  gradTick.addEventListener('change', () => {
    t.fillGrad = gradTick.checked;
    buildBackElementPanel(); // the second colour + angle come and go
    requestRender();
  });
  const gradSpan = document.createElement('span');
  gradSpan.textContent = 'Gradient fill';
  gradLab.append(gradTick, gradSpan);
  box.append(gradLab);
  if (t.fillGrad) {
    makeSlider(box, 'Fill gradient angle', 0, 360, 5, fmtDeg,
      () => t.gradAngle ?? 180, (v) => { t.gradAngle = v; });
  }

  const colors = document.createElement('div');
  colors.className = 'fs-back-colors';
  const colorRows = [
    ['Fill', () => t.fill, (h) => { t.fill = h; }],
  ];
  if (t.fillGrad) colorRows.push(['Fill 2', () => t.fill2 || '#e8d9a0', (h) => { t.fill2 = h; }]);
  colorRows.push(
    ['Stroke', () => t.strokeColor, (h) => { t.strokeColor = h; }],
    ['Shadow', () => t.shadowColor, (h) => { t.shadowColor = h; }],
  );
  for (const [label, get, set] of colorRows) {
    const row = document.createElement('div');
    row.className = 'fs-color';
    const picker = createColorPicker(get() || '#000000', (hex) => { set(hex); requestRender(); });
    const span = document.createElement('span');
    span.textContent = label;
    row.append(picker.root, span);
    colors.append(row);
  }
  box.append(colors);
}

function backTitleNow() {
  return options.titleOverride.trim() || parsed.meta.name || 'Untitled';
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

  $('fs-tab-front').addEventListener('click', () => applyView('front'));
  $('fs-tab-back').addEventListener('click', () => applyView('back'));
  buildBackControls();
  buildBackChips();
  buildBackElementPanel();
  $('fs-back-add').addEventListener('click', () => {
    options.back.texts.push({
      text: 'New text', x: 50, y: 85, size: 120, font: 'goudy',
      fill: '#bea881', strokeW: 0, strokeColor: '#000000',
      shadowX: 0, shadowY: 2, shadowBlur: 4, shadowColor: '#000000',
      rotate: 0, spacing: 0,
    });
    backSel = options.back.texts.length - 1;
    buildBackChips();
    buildBackElementPanel();
    requestRender();
  });
  $('fs-back-remove').addEventListener('click', () => {
    if (backSel < 0) return;
    options.back.texts.splice(backSel, 1);
    backSel = Math.min(backSel, options.back.texts.length - 1);
    buildBackChips();
    buildBackElementPanel();
    requestRender();
  });
  $('fs-back-reset').addEventListener('click', () => {
    options.back.texts = seedBackTexts(backTitleNow());
    backSel = options.back.texts.length ? 0 : -1;
    buildBackChips();
    buildBackElementPanel();
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
