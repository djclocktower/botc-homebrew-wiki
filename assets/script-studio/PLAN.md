# Script Studio — Feature Plan (Draft 1)

**Goal:** a visual script-sheet designer at `botchomebrew.wiki/script-studio` that turns any
script into a print-ready illustrated sheet in the "No Greater Joy" style — with every
element individually movable and editable, like the Token Tool's editor.

---

## 1. What it is

You feed it a script (from the Script Builder, a published wiki script, or pasted/uploaded
official JSON). It auto-lays-out a styled sheet: parchment background, purple night-order
bars, botanical corners, team sections with colored headers and dividers, character cells
(icon + name + ability), auto-computed first-night / other-nights columns, a styled title,
and the footnote. Then you can click any element and move, resize, restyle, or replace it —
and export a print-quality PNG or PDF.

## 2. Engine decision (the big call)

**Konva.js** — a mature, MIT-licensed, single-file canvas scene-graph library, self-hosted
like Pyodide. Not Pyodide/Python this time, and not raw hand-rolled canvas. Reasons:

- The Token Tool's job was *pixel-faithful reproduction of an existing Python renderer* —
  Pyodide was right. Script Studio has no existing renderer to be faithful to; it's a
  fresh interactive editor, which is exactly what a canvas scene graph is for.
- Konva gives us for free: draggable nodes, transform handles (resize/rotate), hit-testing,
  z-order, text with wrapping, event handling, JSON serialization of the whole scene, and
  `toDataURL({pixelRatio})` for lossless high-DPI export (2×–3× = print resolution).
- Single `konva.min.js` (~160 KB), no build step — fits the site's vanilla-JS architecture.
- Instant startup (vs. Pyodide's multi-second boot) — this tool is *interactive-first*.

PDF export via **jsPDF** (MIT, single file, self-hosted): place the exported PNG at exact
physical size on A4/Letter with margins. Same output options as the Token Tool.

## 3. Document model

The scene is data, not code: a JSON document (extending `template.json`'s schema) —
canvas, ordered layers, each `{id, type: image|text|group, x, y, w, h, rotation, opacity,
visible, style}`. The renderer draws the document; the editor mutates it; save/load/share
is just JSON. This mirrors how the Token Tool's editor state works, but is the whole page.

Auto-layout is a function: `script JSON → document`. Manual edits then live on top; a
"re-flow" action regenerates layout while preserving styling overrides.

## 4. Auto-layout engine

- **Team sections** in official order (Townsfolk → Outsiders → Minions → Demon → optional
  Travellers/Fabled), colored header + divider each, column count adapting to team size
  (3-col townsfolk, 2-col mid, 1-col demon, as in the design).
- **Character cells**: icon left, name + centered ability right. Icons come from wiki art
  (`assets/art/{slug}.png`, same-origin) or external URLs for imported JSON (direct fetch →
  `botc-wiki-proxy /fetch` fallback, same flow as the Token Tool's Phase 4).
- **Night order columns auto-computed** — wiki characters already carry `firstNight` /
  `otherNight` numbers, and official JSON has global night order. Moon at dusk, minis
  sorted by night number, sun at dawn. This is the feature's party trick: nobody hand-
  places night columns again.
- **Vertical budget**: measure text, scale cell heights; if a script overflows one page,
  split into **multi-page documents** (page 2 gets chrome but no title block) and/or offer
  a global "compact" density. Teensyville scripts get a roomier spread.

## 5. Editor UX (Token-Tool-familiar)

- **Tap to select** → transform handles (move/resize/rotate), long-press or handle-drag on
  mobile. Double-tap text → edit in place.
- **Element panel** (the Token Tool modal pattern): sliders/fields for the selected
  element — position, scale, rotation, opacity; font size / color / alignment for text;
  replace-image for icons and chrome.
- **"Adjust All" panel**: global font scale, team colors, ability text size, icon size,
  density, show/hide night columns, background/botanical swaps.
- **Layers strip**: reorder, hide, lock chrome so dragging a name doesn't grab the parchment.
- **Undo/redo** (document snapshots — cheap since the doc is JSON).
- Sharp-cornered UI, parchment cards, left sidebar — same visual language as `/tokens`.

## 6. Inputs & outputs

**In:** current Script Builder working set (localStorage `botc_script`), any published wiki
script (`?s=slug`), pasted/uploaded official JSON (reuse Token Tool's import + matching
code), or a blank sheet.

**Out:** PNG (1×/2×/3×), print PDF (A4/Letter, margins), and **saved designs** —
localStorage autosave always; "Attach design to script" for published scripts, stored in
the script's D1 `data` blob (schema needs no migration — the hybrid JSON design pays off
again). Script pages then get a "View sheet" render.

## 7. Assets & licensing (done this session)

Everything extracted from the PSD into `assets/script-studio/` (see `README.md`):
chrome, demo icons, night minis, 29 hidden alternates, `template.json` with exact
coordinates, reference render. OptimusPrinceps (free) pushed to `assets/fonts/`. LHF
Unlovable (title) and Helvetica are commercial and not shipped — titles render in
Dumbledor with a canvas gradient/bevel treatment; ability text uses Trade Gothic. If the
exact title look matters enough, buying an LHF Unlovable web license is a later option.

## 8. Build phases (each ends in a working push)

- **Phase 1 — Renderer.** `script-studio.html` + `assets/script-studio.js`. Konva stage,
  load `template.json`, auto-layout from a script, wiki art, night columns, PNG export.
  Opens with the No Greater Joy demo so it demos itself. *No editing yet.*
- **Phase 2 — Editor.** Selection, transforms, text editing, element panel, layers strip,
  undo, autosave.
- **Phase 3 — Global controls + export.** Adjust-All panel, multi-page, PDF, density modes.
- **Phase 4 — Integration.** JSON import + proxy art, save-to-script (D1), buttons on
  Script Builder / script pages, custom asset uploads (swap botanicals/background/title).
- **Phase 5 (stretch).** Theme presets (recolored bar/botanical sets — the alt/ layers are
  a head start), Icon Studio integration to restyle arbitrary art into the watercolor look,
  shareable design links.

## 9. Risks / open questions for David

1. **Konva.js vs. hand-rolled canvas** — Konva is my strong recommendation; veto if you
   want zero dependencies.
2. **Mobile transform ergonomics** — phase 2's hardest part; expect an iteration loop.
3. **Default icon look**: raw wiki art won't match the watercolor style until Icon Studio
   exists. Acceptable for v1?
4. **Fonts**: OK with Dumbledor titles + Trade Gothic abilities, or buy LHF Unlovable?
5. Sheet is portrait 5:7 — also want a landscape/two-column-page variant eventually?
