/* Icon Forge — the page.

   The engine (engine.js) is a straight port of the handoff's TypeScript and
   knows nothing about the wiki; everything that makes this a wiki page lives
   here. The markup in iconforge.html is declarative: every knob carries
   data-opt="<option name>", so this file binds controls generically rather
   than naming each one twice.

   Two rendering rules from the engine's design, both load-bearing:
     · The preview keeps ONE cached renderer (createIconRenderer). Stages are
       cached by the exact options they read, so dragging a texture slider
       skips the expensive mask rebuild.
     · Every change draws a fast pass at supersample 1 immediately, then a
       crisp pass at 2 once the input settles. Export always renders one-shot
       at full quality.
   See the engine's header and the handoff guide before changing either. */

import { DEFAULT_OPTIONS, createIconRenderer, probeBucket, renderIcon } from './engine.js';
import { COLOR_TEXTURES, TRAVELLER_SPLIT_ID, loadTexturesFor } from './textures.js';
import { loadSourceFile, thumbDataUrl } from './source.js';
import { applyCleanup, removeImageBackground } from './bgremoval.js';
import { openEditor } from './editor.js';

const $ = (id) => document.getElementById(id);

/* The wiki's starting point. engine.js keeps the original tool's defaults so
   it stays a clean port; these are the settings the wiki opens on, chosen by
   djclocktower for icons that sit next to the official ones. In short: much
   sharper edges, slightly bolder ink, a tighter margin, a wider texture crop,
   and the procedural extras (rim light, line detection, colour edges) off —
   so what you see is your own drawing until you ask for more. "Reset every
   setting" comes back here, not to the engine's defaults. */
const WIKI_DEFAULTS = {
  threshold: 151,
  edgeOuter: 0.2,
  edgeInner: 0.2,
  lineThicken: 1,
  padding: 0.05,
  highlights: 0,
  lineDetails: 0,
  colorEdges: 0,
  texScale: 0.5,
  borderEdge: 0
};

function startingOptions() {
  return Object.assign({}, DEFAULT_OPTIONS, WIKI_DEFAULTS, { bucketFills: [] });
}

/* ── state ──────────────────────────────────────────────────────── */
let opts = startingOptions();
let source = null; // the artwork as loaded (HTMLImageElement)
let sourceKind = 'raster';
let sourceName = '';
let textures = null;
let colorTexId = 'blue';
let bgMode = 'keep'; // keep | ai | key | chroma
let aiCanvas = null; // cleaned-up AI cutout, when Smart AI is on
let aiBusy = false;
let bucketMode = 'off';
let zoom = 0.86;
let exportUrl = null;

const renderer = createIconRenderer();
let rafId = 0;
let crispTimer = 0;
let aiReq = 0;
let texReq = 0;
/** Raw (uncleaned) AI cutout for the current source, so the cleanup slider
 *  re-applies instantly instead of re-running the model. */
let rawCutout = null;
/** Kills a Smart AI run in flight (the Stop button, and anything that makes
 *  the run pointless: new artwork, leaving the mode). Terminating the worker
 *  matters — an abandoned one keeps a core busy until it finishes. */
let cancelAI = null;
function stopAI() {
  if (!cancelAI) return;
  const cancel = cancelAI;
  cancelAI = null;
  cancel();
}

/** What the engine actually reads: the AI cutout when Smart AI produced one. */
function effectiveSource() {
  return bgMode === 'ai' && aiCanvas ? aiCanvas : source;
}

/* ── value formatting ───────────────────────────────────────────── */
const pct = (v) => Math.round(v * 100) + '%';
const offPct = (v) => (v <= 0.001 ? 'Off' : pct(v));
const px1 = (v) => v.toFixed(1) + 'px';
const px0 = (v) => Math.round(v) + 'px';
const deg = (v) => Math.round(v) + '°';

const FORMAT = {
  threshold: (v) => String(Math.round(v)),
  edgeOuter: px1,
  edgeInner: px1,
  lineThicken: (v) =>
    Math.abs(v) <= 0.001 ? 'Default' : v > 0 ? '+' + v.toFixed(1) + 'px bolder' : v.toFixed(1) + 'px finer',
  padding: (v) => Math.round(v * 100) + '%',
  aiTolerance: (v) => String(Math.round(v)),
  bgTolerance: (v) => String(Math.round(v)),
  highlights: offPct,
  highlightAngle: deg,
  highlightWidth: px1,
  bevel: offPct,
  bevelSize: px0,
  lineDetails: offPct,
  lineRadius: px0,
  colorEdges: offPct,
  splitPosition: (v) => Math.round(v) + '%',
  splitThickness: (v) => (v <= 0 ? 'Off' : v + 'px'),
  hatchIntensity: offPct,
  hatchAngle: deg,
  colorSat: pct,
  colorBright: pct,
  colorVib: offPct,
  colorGrad: offPct,
  whiteSat: pct,
  whiteBright: pct,
  whiteVib: offPct,
  whiteGrad: offPct,
  texScale: (v) => v.toFixed(2) + '×',
  texRotation: deg,
  texOffsetX: (v) => v.toFixed(2),
  texOffsetY: (v) => v.toFixed(2),
  borderWidth: px1,
  borderEdge: px1,
  shadowOpacity: offPct,
  shadowAngle: deg,
  shadowDistance: px0,
  shadowBlur: px0,
  rotate: (v) => (Math.abs(v) < 0.5 ? '0°' : (v > 0 ? '+' : '') + Math.round(v) + '°')
};

/* ── toast ──────────────────────────────────────────────────────── */
let toastTimer = 0;
function toast(text, kind) {
  const box = $('if-toast');
  // Both live at the bottom of the viewport; stack rather than overlap.
  box.style.bottom = $('if-busy').hidden ? '18px' : '110px';
  box.textContent = text;
  box.className = 'if-toast' + (kind ? ' ' + kind : '');
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.hidden = true;
  }, kind === 'err' ? 7000 : 4500);
}

/* ── control binding ────────────────────────────────────────────── */
const sliderRows = Array.from(document.querySelectorAll('.if-row[data-opt]'));
const switchRows = Array.from(document.querySelectorAll('.if-switch[data-opt]'));

sliderRows.forEach((row) => {
  const key = row.dataset.opt;
  const input = row.querySelector('input[type=range]');
  input.addEventListener('input', () => {
    setOpts({ [key]: parseFloat(input.value) });
  });
});

switchRows.forEach((row) => {
  const key = row.dataset.opt;
  const input = row.querySelector('input[type=checkbox]');
  input.addEventListener('change', () => {
    // A switch usually drives a boolean; borderStyle is the one that maps
    // onto two strings, declared as data-on / data-off in the markup.
    const on = row.dataset.on;
    setOpts({ [key]: on ? (input.checked ? on : row.dataset.off) : input.checked });
  });
});

/** Segmented pickers: one pressed button per group. */
function segment(id, onPick) {
  const box = $(id);
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-value]');
    if (!btn || btn.disabled) return;
    onPick(btn.dataset.value);
  });
  return {
    set(value) {
      box.querySelectorAll('button[data-value]').forEach((b) => {
        b.setAttribute('aria-pressed', String(b.dataset.value === value));
      });
    },
    box
  };
}

const linemodeSeg = segment('if-linemode', (v) => setOpts({ lineMode: v }));
const bgSeg = segment('if-bgmode', (v) => setBgMode(v));
const bucketSeg = segment('if-bucket', (v) => {
  bucketMode = v;
  syncControls();
});
const backdropSeg = segment('if-backdrop', (v) => {
  const stage = $('if-stage');
  stage.classList.toggle('is-checker', v === 'checker');
  $('if-ring').hidden = v !== 'token';
  backdropSeg.set(v);
  sizeStage();
});

document.querySelectorAll('.if-mode').forEach((btn) => {
  btn.addEventListener('click', () => setOpts({ mode: btn.dataset.mode }));
});

/** Push an options patch, refresh every control that shows it, re-render. */
function setOpts(patch) {
  opts = Object.assign({}, opts, patch);
  syncControls();
  scheduleRender();
}

/** Write the current state back into every control. One direction only:
 *  state is the truth, the DOM is a view of it. */
function syncControls() {
  sliderRows.forEach((row) => {
    const key = row.dataset.opt;
    const input = row.querySelector('input[type=range]');
    const out = row.querySelector('.if-val');
    const v = opts[key];
    if (document.activeElement !== input) input.value = String(v);
    if (out) out.textContent = (FORMAT[key] || String)(v);
    // A row can be dimmed because the feature above it is off, or because it
    // only applies in one artwork mode.
    let live = true;
    if (row.dataset.needs) live = opts[row.dataset.needs] > 0.001;
    if (row.dataset.onlyMode) live = live && opts.mode === row.dataset.onlyMode;
    row.classList.toggle('is-off', !live);
  });

  switchRows.forEach((row) => {
    const key = row.dataset.opt;
    const input = row.querySelector('input[type=checkbox]');
    input.checked = row.dataset.on ? opts[key] === row.dataset.on : !!opts[key];
  });

  document.querySelectorAll('.if-mode').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === opts.mode));
  });
  linemodeSeg.set(opts.lineMode);
  $('if-linemode').classList.toggle('is-off', !(opts.lineDetails > 0.001));

  bgSeg.set(bgMode);
  $('if-bg-ai').hidden = bgMode !== 'ai';
  $('if-bg-key').hidden = bgMode !== 'key';
  $('if-bg-chroma').hidden = bgMode !== 'chroma';
  // The tolerance slider is shared by the two manual keys.
  document.querySelector('.if-row[data-opt=bgTolerance]').hidden = !(bgMode === 'key' || bgMode === 'chroma');
  // Smart AI is for rasters; a vector already has a transparent background.
  const aiBtn = $('if-bgmode').querySelector('button[data-value=ai]');
  aiBtn.disabled = !source || sourceKind !== 'raster';
  aiBtn.title = aiBtn.disabled
    ? 'Smart remove is for photos and scans — vector art already has a transparent background'
    : '';

  const swatch = $('if-chroma-swatch');
  if (opts.chromaKey) {
    swatch.hidden = false;
    swatch.style.background = 'rgb(' + opts.chromaKey.join(',') + ')';
    swatch.title = 'Background colour: rgb(' + opts.chromaKey.join(', ') + ')';
  } else {
    swatch.hidden = true;
  }

  bucketSeg.set(bucketMode);
  $('if-bucket').querySelectorAll('button').forEach((b) => {
    b.disabled = !source;
  });
  $('if-stage').classList.toggle('is-bucket', bucketMode !== 'off' && !!source);
  $('if-bucket-hint').textContent =
    bucketMode === 'off'
      ? 'Fill enclosed spaces by hand: pick Colour or Parchment, then tap a space in the preview. Unlike “Fill enclosed spaces”, you choose each region and its fill. Hatch adds shading lines to whatever you tap instead.'
      : bucketMode === 'hatch'
        ? 'Now tap an ink area or an enclosed space in the preview — it gets hand-drawn hatching. Tune the lines under Hatching.'
        : 'Now tap an enclosed space in the preview — it fills with ' +
          (bucketMode === 'color' ? 'the colour texture' : 'parchment') +
          '. Only spaces fully surrounded by ink can be filled.';

  $('if-split').hidden = colorTexId !== TRAVELLER_SPLIT_ID;
  document.querySelectorAll('.if-tex').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.tex === colorTexId));
  });

  renderFills();

  $('if-export').disabled = !source || aiBusy;
  $('if-edit').hidden = !source;
  $('if-save').disabled = !source || aiBusy || !$('if-save-pick').value;
}

/* ── the paint-bucket list ──────────────────────────────────────── */
const FILL_SWATCH = {
  color: '#2C7BD0',
  white: '#f0e8d5',
  hatch: 'repeating-linear-gradient(45deg,#33241a 0 2px,#f0e8d5 2px 4px)'
};

let fillsShown = '';

function renderFills() {
  // syncControls runs on every slider tick; only touch the DOM when the fills
  // themselves changed.
  const sig = JSON.stringify(opts.bucketFills);
  if (sig === fillsShown) return;
  fillsShown = sig;
  const list = $('if-fills');
  list.innerHTML = '';
  opts.bucketFills.forEach((f, idx) => {
    const li = document.createElement('li');
    const dot = document.createElement('i');
    dot.style.background = FILL_SWATCH[f.fill];
    const label = document.createElement('span');
    label.textContent =
      (f.fill === 'color' ? 'Colour' : f.fill === 'hatch' ? 'Hatch' : 'Parchment') +
      ' ' + (f.fill === 'hatch' ? 'region ' : 'fill ') + (idx + 1);
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '×';
    del.title = 'Remove this fill';
    del.addEventListener('click', () => {
      setOpts({ bucketFills: opts.bucketFills.filter((_, j) => j !== idx) });
    });
    li.appendChild(dot);
    li.appendChild(label);
    li.appendChild(del);
    list.appendChild(li);
  });
  $('if-fills-clear').hidden = opts.bucketFills.length === 0;
  drawPins();
}

/** The numbered markers over the preview, matching the list above. */
function drawPins() {
  const inner = $('if-stage-inner');
  inner.querySelectorAll('.if-pin').forEach((p) => p.remove());
  opts.bucketFills.forEach((f, idx) => {
    const pin = document.createElement('span');
    pin.className = 'if-pin';
    pin.textContent = String(idx + 1);
    pin.style.left = f.x * 100 + '%';
    pin.style.top = f.y * 100 + '%';
    pin.style.background = f.fill === 'color' ? '#2C7BD0' : f.fill === 'hatch' ? '#33241a' : '#f0e8d5';
    pin.style.color = f.fill === 'white' ? '#5B1F21' : '#ffe9ad';
    inner.appendChild(pin);
  });
}

/* ── preview ────────────────────────────────────────────────────── */
function sizeStage() {
  const inner = $('if-stage-inner');
  inner.style.width = Math.round(zoom * 100) + '%';
  const ring = $('if-ring');
  if (!ring.hidden) {
    const w = inner.getBoundingClientRect().width;
    const d = Math.max(60, w * 1.06);
    ring.style.width = d + 'px';
    ring.style.height = d + 'px';
  }
}

function scheduleRender() {
  const src = effectiveSource();
  $('if-stage-empty').hidden = !!src;
  $('if-stage-inner').hidden = !src;
  if (!src || !textures) return;
  cancelAnimationFrame(rafId);
  clearTimeout(crispTimer);
  // Fast pass now so drags stay fluid, crisp pass once the input settles.
  rafId = requestAnimationFrame(() => {
    draw(1);
    crispTimer = setTimeout(() => draw(2), 220);
  });
}

function draw(supersample) {
  const src = effectiveSource();
  if (!src || !textures) return;
  try {
    const out = renderer.render(src, opts, textures, 591, supersample);
    const canvas = $('if-canvas');
    canvas.width = out.width;
    canvas.height = out.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(out, 0, 0);
    sizeStage();
  } catch (e) {
    toast('The forge could not render that: ' + (e && e.message ? e.message : e), 'err');
  }
}

/** The Smart remove progress card. `sub` explains what the wait is for; the Stop
 *  button is wired per run by maybeRunAI. */
function busy(on, fraction, label, sub) {
  $('if-busy').hidden = !on;
  if (!on) return;
  const f = Math.max(0, Math.min(1, fraction || 0));
  $('if-busy-label').textContent =
    (label || 'Working…') + (f > 0 && f < 1 ? '  ' + Math.round(f * 100) + '%' : '');
  $('if-busy-bar').style.width = Math.round(f * 100) + '%';
  if (sub != null) $('if-busy-sub').textContent = sub;
}

/* ── loading artwork ────────────────────────────────────────────── */
function setSource(img, name, kind) {
  aiReq++;
  stopAI();
  rawCutout = null;
  aiCanvas = null;
  aiBusy = false;
  busy(false);
  source = img;
  sourceKind = kind || 'raster';
  if (name != null) sourceName = name;
  // New artwork — the old paint-bucket taps do not map onto it.
  opts = Object.assign({}, opts, { bucketFills: [] });

  const box = $('if-loaded');
  box.hidden = false;
  const thumb = thumbDataUrl(img, 128);
  if (thumb) $('if-loaded-thumb').src = thumb;
  $('if-loaded-name').textContent = sourceName || 'untitled';
  $('if-loaded-sub').textContent =
    (img.naturalWidth || img.width) + '×' + (img.naturalHeight || img.height) + ' · before the forge';
  $('if-drop').classList.add('is-compact');
  $('if-drop').querySelector('b').textContent = 'Drop different artwork, or tap to browse';

  if (sourceKind !== 'raster' && bgMode === 'ai') setBgMode('keep');
  syncControls();
  scheduleRender();
  maybeRunAI();
}

async function onFile(file) {
  try {
    const img = await loadSourceFile(file);
    const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
    setSource(img, file.name.replace(/\.[^.]+$/, ''), isSvg ? 'svg' : 'raster');
  } catch (e) {
    toast('Could not read that file: ' + (e && e.message ? e.message : e), 'err');
  }
}

$('if-file').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) onFile(f);
  e.target.value = '';
});
$('if-drop').addEventListener('click', () => $('if-file').click());
['dragenter', 'dragover'].forEach((ev) =>
  $('if-drop').addEventListener(ev, (e) => {
    e.preventDefault();
    $('if-drop').classList.add('is-over');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  $('if-drop').addEventListener(ev, () => $('if-drop').classList.remove('is-over'))
);
$('if-drop').addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) onFile(f);
});

/* Editor */
$('if-edit').addEventListener('click', () => openArtEditor('edit'));
$('if-draw').addEventListener('click', () => openArtEditor('draw'));

function openArtEditor(mode) {
  openEditor({
    image: mode === 'edit' ? source : null,
    thumb: mode === 'edit' && source ? thumbDataUrl(source, 96) : null,
    title: mode === 'edit' ? 'Edit artwork' : 'Draw your own',
    hint:
      mode === 'edit'
        ? 'Pen, eraser, lasso, move — then bring it straight back to the forge.'
        : 'A blank page. Black ink on white works best in the forge.',
    onApply: (img) => {
      const name = mode === 'draw' ? 'drawing' : sourceName ? sourceName + ' (edited)' : 'edited';
      setSource(img, name, 'raster');
    }
  });
}

/* ── background modes ───────────────────────────────────────────── */
function setBgMode(mode) {
  bgMode = mode;
  opts = Object.assign({}, opts, {
    removeWhiteBg: mode === 'key',
    // Keep the picked colour so returning to Chroma restores it.
    chromaKey: mode === 'chroma' ? opts.chromaKey : null
  });
  if (mode !== 'ai') {
    aiReq++;
    stopAI();
    aiCanvas = null;
    aiBusy = false;
    busy(false);
  }
  syncControls();
  scheduleRender();
  maybeRunAI();
}

$('if-busy-stop').addEventListener('click', stopAI);

function maybeRunAI() {
  if (bgMode !== 'ai' || !source || sourceKind !== 'raster') return;
  if (rawCutout && rawCutout.src === source) {
    aiCanvas = applyCleanup(rawCutout.canvas, opts.aiTolerance);
    scheduleRender();
    return;
  }
  const req = ++aiReq;
  aiBusy = true;
  syncControls();
  busy(true, 0, 'Removing', 'Keep using the page — this runs in the background.');
  removeImageBackground(
    source,
    (fraction, phase) => {
      if (aiReq !== req) return;
      // The heading stays one word start to finish; only the line underneath
      // changes, because the first-run download is the long wait and without
      // saying so it looks like nothing is happening.
      busy(
        true,
        fraction,
        'Removing',
        phase === 'fetch'
          ? 'Fetching what it needs — about 45 MB, once per browser. It is kept for next time.'
          : 'Keep using the page — this runs in the background.'
      );
    },
    (cancel) => {
      if (aiReq === req) cancelAI = cancel;
    }
  )
    .then((raw) => {
      if (aiReq !== req) return;
      rawCutout = { src: source, canvas: raw };
      aiCanvas = applyCleanup(raw, opts.aiTolerance);
      aiBusy = false;
      cancelAI = null;
      busy(false);
      syncControls();
      scheduleRender();
    })
    .catch((e) => {
      if (aiReq !== req) return;
      aiBusy = false;
      cancelAI = null;
      busy(false);
      setBgMode('keep');
      if (e && e.cancelled) {
        toast('Stopped. Background left as it was.');
        return;
      }
      toast(
        'Smart remove could not run: ' +
          (e && e.message ? e.message : 'the model could not be downloaded') +
          '. Falling back to Keep.',
        'err'
      );
    });
}

/* The cleanup slider re-applies on the cached cutout — never re-runs the model. */
document.querySelector('.if-row[data-opt=aiTolerance] input').addEventListener('input', () => {
  if (bgMode === 'ai' && rawCutout && rawCutout.src === source) {
    aiCanvas = applyCleanup(rawCutout.canvas, opts.aiTolerance);
    scheduleRender();
  }
});

/* ── chroma picker ──────────────────────────────────────────────── */
$('if-chroma-pick').addEventListener('click', () => {
  if (!source) {
    toast('Load some artwork first.', 'err');
    return;
  }
  const overlay = document.createElement('div');
  overlay.className = 'if-modal';
  const card = document.createElement('div');
  card.className = 'if-card if-modal-card';
  card.innerHTML =
    '<h2 class="if-card-title">Pick the background colour</h2>' +
    '<p class="if-hint">Tap the part of your artwork that should disappear.</p>';
  const canvas = document.createElement('canvas');
  const w = source.naturalWidth || source.width;
  const h = source.naturalHeight || source.height;
  const scale = Math.min(1, 520 / Math.max(w, h));
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  canvas.style.cssText = 'display:block;width:100%;height:auto;cursor:crosshair;border:1px solid var(--parch-frame);background:#fff';
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  card.appendChild(canvas);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'sb-btn if-btn-quiet';
  close.textContent = 'Cancel';
  close.style.marginTop = '12px';
  card.appendChild(close);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  const done = () => overlay.remove();
  close.addEventListener('click', done);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) done();
  });
  canvas.addEventListener('click', (e) => {
    const r = canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * canvas.width);
    const y = Math.floor(((e.clientY - r.top) / r.height) * canvas.height);
    const d = canvas.getContext('2d').getImageData(x, y, 1, 1).data;
    done();
    setOpts({ chromaKey: [d[0], d[1], d[2]] });
  });
});

/* ── paint bucket taps ──────────────────────────────────────────── */
$('if-stage-inner').addEventListener('pointerdown', (e) => {
  if (bucketMode === 'off') return;
  const src = effectiveSource();
  if (!src) return;
  const r = e.currentTarget.getBoundingClientRect();
  const fx = (e.clientX - r.left) / r.width;
  const fy = (e.clientY - r.top) / r.height;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return;
  const probe = probeBucket(src, opts, fx, fy);
  if (bucketMode === 'hatch') {
    if (probe === 'open') {
      toast('That spot is outside the artwork — tap ink or an enclosed space to hatch it.');
      return;
    }
  } else if (probe === 'solid') {
    toast('That spot is ink. Tap an empty enclosed space to fill it.');
    return;
  } else if (probe === 'open') {
    toast('That space is not enclosed — it connects to the outside, so it cannot be filled.');
    return;
  }
  setOpts({ bucketFills: opts.bucketFills.concat([{ x: fx, y: fy, fill: bucketMode }]) });
});

$('if-fills-clear').addEventListener('click', () => setOpts({ bucketFills: [] }));

/* ── texture picker ─────────────────────────────────────────────── */
COLOR_TEXTURES.forEach((t) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'if-tex';
  b.dataset.tex = t.id;
  b.title = t.label + ' — ' + t.sub;
  b.setAttribute('aria-pressed', String(t.id === colorTexId));
  const sw = document.createElement('div');
  sw.className = 'if-tex-swatch';
  if (t.id === TRAVELLER_SPLIT_ID) {
    // No sheet of its own: show the two halves it actually renders.
    const l = document.createElement('i');
    l.style.backgroundImage = 'url(' + t.file + ')';
    const r = document.createElement('i');
    r.style.backgroundImage = 'url(' + t.file.replace('blue.png', 'red.png') + ')';
    sw.appendChild(l);
    sw.appendChild(r);
  } else {
    sw.style.backgroundImage = 'url(' + t.file + ')';
  }
  const cap = document.createElement('div');
  cap.className = 'if-tex-cap';
  const name = document.createElement('b');
  name.textContent = t.label;
  const sub = document.createElement('span');
  sub.textContent = t.sub;
  cap.appendChild(name);
  cap.appendChild(sub);
  b.appendChild(sw);
  b.appendChild(cap);
  b.addEventListener('click', () => pickTexture(t.id));
  $('if-textures').appendChild(b);
});

function pickTexture(id) {
  colorTexId = id;
  syncControls();
  const req = ++texReq;
  loadTexturesFor(id)
    .then((tex) => {
      if (texReq !== req) return;
      textures = tex;
      scheduleRender();
    })
    .catch((e) => toast(e && e.message ? e.message : 'A texture failed to load', 'err'));
}

/* ── texture placement pad ──────────────────────────────────────── */
document.querySelectorAll('.if-pad button[data-nudge]').forEach((b) => {
  b.addEventListener('click', () => {
    const [dx, dy] = b.dataset.nudge.split(',').map(Number);
    setOpts({
      texOffsetX: Math.max(-1, Math.min(1, opts.texOffsetX + dx)),
      texOffsetY: Math.max(-1, Math.min(1, opts.texOffsetY + dy))
    });
  });
});
$('if-tex-random').addEventListener('click', () =>
  setOpts({
    texOffsetX: Math.random() * 2 - 1,
    texOffsetY: Math.random() * 2 - 1,
    texRotation: Math.floor(Math.random() * 360) - 180
  })
);
$('if-tex-reset').addEventListener('click', () =>
  setOpts({ texScale: 1, texRotation: 0, texOffsetX: 0, texOffsetY: 0 })
);
$('if-reset-all').addEventListener('click', () => {
  opts = startingOptions();
  bucketMode = 'off';
  setBgMode('keep');
});

/* ── stage furniture ────────────────────────────────────────────── */
$('if-zoom').addEventListener('input', (e) => {
  zoom = parseFloat(e.target.value);
  sizeStage();
});
window.addEventListener('resize', sizeStage);

/* ── export ─────────────────────────────────────────────────────── */
/** Render the finished icon at full quality. size 0 = match the artwork. */
function renderFinal(size) {
  const src = effectiveSource();
  const sw = src instanceof HTMLImageElement ? src.naturalWidth : src.width;
  const sh = src instanceof HTMLImageElement ? src.naturalHeight : src.height;
  const px = size > 0 ? size : Math.min(4096, Math.max(sw, sh) || 591);
  return renderIcon(src, opts, textures, px, 2);
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the PNG'))), 'image/png');
  });
}

$('if-export').addEventListener('click', () => {
  if (!effectiveSource() || !textures || aiBusy) return;
  const btn = $('if-export');
  btn.disabled = true;
  btn.textContent = 'Forging…';
  // Let the button paint its busy state before the heavy render.
  requestAnimationFrame(async () => {
    try {
      const size = parseInt($('if-size').value, 10) || 0;
      const out = renderFinal(size);
      const blob = await canvasToBlob(out);
      const fileName = 'Icon_' + (sourceName || 'custom').replace(/[^\w-]+/g, '_') + '_' + out.width + 'px.png';
      if (exportUrl) URL.revokeObjectURL(exportUrl);
      exportUrl = URL.createObjectURL(blob);
      // Programmatic download works in a normal tab; in-app browsers sometimes
      // block it silently, so the dialog below always offers a manual save.
      const a = document.createElement('a');
      a.href = exportUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      showExportDialog(exportUrl, fileName);
    } catch (e) {
      toast('Export failed: ' + (e && e.message ? e.message : e), 'err');
    } finally {
      btn.textContent = 'Download PNG';
      btn.disabled = false;
    }
  });
});

function showExportDialog(url, fileName) {
  const overlay = document.createElement('div');
  overlay.className = 'if-modal';
  const card = document.createElement('div');
  card.className = 'if-card if-modal-card';
  const title = document.createElement('h2');
  title.className = 'if-card-title';
  title.textContent = 'Your icon is ready';
  const hint = document.createElement('p');
  hint.className = 'if-hint';
  hint.textContent =
    'The download should have started. If it did not, press and hold the image (or right-click it) to save, or use the button below.';
  const shot = document.createElement('div');
  shot.className = 'if-shot';
  const img = document.createElement('img');
  img.src = url;
  img.alt = 'The finished icon';
  shot.appendChild(img);
  const name = document.createElement('p');
  name.className = 'if-hint';
  name.textContent = fileName;
  const row = document.createElement('div');
  row.className = 'if-btn-row';
  const save = document.createElement('a');
  save.className = 'sb-btn if-btn-go';
  save.href = url;
  save.download = fileName;
  save.textContent = 'Save PNG';
  save.style.textAlign = 'center';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'sb-btn if-btn-quiet';
  close.textContent = 'Close';
  row.appendChild(close);
  row.appendChild(save);
  card.appendChild(title);
  card.appendChild(hint);
  card.appendChild(shot);
  card.appendChild(name);
  card.appendChild(row);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  const done = () => overlay.remove();
  close.addEventListener('click', done);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) done();
  });
}

/* ── save straight onto one of your own characters ──────────────── */
/* The icon goes to the character's art slot in R2 (art/{slug}.png, the same
   slot the character editor writes) and the row is saved back with that path,
   so a page whose art lived somewhere else still picks it up. Ownership is
   enforced by the Worker on both calls; this only decides what to ask for. */

const savePick = $('if-save-pick');
const saveMsg = $('if-save-msg');

function setSaveMsg(kind, html) {
  saveMsg.className = 'if-msg' + (kind ? ' ' + kind : '');
  saveMsg.innerHTML = html;
}

savePick.addEventListener('change', syncControls);

fetch('/api/me', { credentials: 'same-origin' })
  .then((r) => r.json())
  .then((me) => {
    if (!me || !me.loggedIn) {
      setSaveMsg(
        '',
        'Download the PNG and add it in the <a href="create">character editor</a>. ' +
          '<a href="login?next=iconforge">Sign in</a> and you can put it straight onto a character you already have.'
      );
      return;
    }
    return fetch('/api/account', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((acc) => {
        const chars = (acc && acc.characters) || [];
        if (!chars.length) {
          setSaveMsg(
            '',
            'You have no characters yet. Download the PNG and start one in the <a href="create">character editor</a>.'
          );
          return;
        }
        savePick.innerHTML = '<option value="">Choose a character…</option>';
        chars.forEach((c) => {
          const o = document.createElement('option');
          o.value = c.slug;
          o.textContent = c.name + (c.status === 'draft' ? ' (draft)' : '');
          savePick.appendChild(o);
        });
        $('if-save-body').hidden = false;
        setSaveMsg('', 'Saved icons are 591 px, the size the wiki uses everywhere.');
        syncControls();
      });
  })
  .catch(() => {
    setSaveMsg('', 'Download the PNG and add it in the <a href="create">character editor</a>.');
  });

$('if-save').addEventListener('click', async () => {
  const slug = savePick.value;
  if (!slug || !effectiveSource() || !textures) return;
  const btn = $('if-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  setSaveMsg('', 'Forging the icon at 591 px…');
  try {
    const out = renderFinal(591);
    const dataUrl = out.toDataURL('image/png');

    setSaveMsg('', 'Uploading…');
    const page = await fetch('/api/page?type=character&slug=' + encodeURIComponent(slug), {
      credentials: 'same-origin'
    }).then((r) => r.json());
    if (!page || page.error) throw new Error(page && page.error ? page.error : 'Could not load that character.');
    if (!page.canEdit) throw new Error('That character belongs to another account.');

    const key = 'art/' + page.slug + '.png';
    const up = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ key, data: dataUrl })
    }).then((r) => r.json());
    if (!up || up.error) throw new Error((up && up.error) || 'The upload failed.');
    // The card thumbnail rides along with the art (assets/art-thumb.js is
    // loaded by iconforge.html); never awaited.
    if (window.ArtThumb) window.ArtThumb.upload(key, dataUrl);

    // Point the row at the slot we just wrote. Everything else on the page is
    // sent back unchanged, including its published/draft status.
    const entry = Object.assign({}, page.data, {
      slug: page.slug,
      art: key,
      image: 'https://botchomebrew.wiki/assets/' + key,
      status: page.status
    });
    const saved = await fetch('/api/character', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(entry)
    }).then((r) => r.json());
    if (!saved || saved.error) throw new Error((saved && saved.error) || 'The character could not be saved.');

    setSaveMsg(
      'ok',
      '✓ Saved. It is live on <a href="/c/' + page.slug + '" target="_blank">/c/' + page.slug + '</a>' +
        ' — give it a refresh if you still see the old icon.'
    );
  } catch (e) {
    setSaveMsg('err', '✗ ' + (e && e.message ? e.message : 'Something went wrong.'));
  } finally {
    btn.textContent = 'Save as its icon';
    syncControls();
  }
});

/* ── go ─────────────────────────────────────────────────────────── */
pickTexture(colorTexId);
syncControls();
sizeStage();
