# SCRIPT STUDIO — HANDOFF DOCUMENT
*For a Claude instance building the Script Studio feature on botchomebrew.wiki. Read fully before writing any code.*

---

## 0. WHO YOU'RE WORKING WITH

David (GitHub: **djclocktower**) owns and runs botchomebrew.wiki, a Blood on the Clocktower homebrew wiki. He does not code — **you are the hands-on implementer for everything**. He works on mobile, reviews on the live site, and gives concise iterative feedback. Workflow rules:

- Draft plans before complex features; get approval before building. (The plan below is **already approved** — you can build.)
- Straightforward tasks: decide and push, don't ask.
- One change at a time when debugging; revert aggressively when experiments fail.
- After pushing, he'll usually prompt you separately to verify the deployment.
- **Request the GitHub PAT from David at the start of the session. Never write the PAT into any file or commit.**

---

## 1. THE MISSION

Build **Script Studio**: a visual script-sheet designer at `botchomebrew.wiki/script-studio.html` that turns any script into a print-ready illustrated sheet in the "No Greater Joy" style — parchment background, purple night-order side bars, botanical corners, colored team sections, character cells (icon + name + centered ability), auto-computed night-order columns, styled title, footnote. Every element is individually selectable, movable, resizable, and restylable — the same editing philosophy as the existing Token Tool (`/tokens`). Export: high-DPI PNG and print PDF.

**Phase 0 is complete**: all assets are extracted from the design PSD and pushed (commit `0a26d6d`). The reference render is at `assets/script-studio/demo/reference.jpg` — that image is the visual target.

---

## 2. RATIFIED DECISIONS (approved by David — do not relitigate)

1. **Engine: Konva.js** (MIT, single file, ~160 KB). Self-host it (e.g. `assets/konva.min.js`), no CDN, no build step. Rationale: built-in drag/transform handles, hit-testing, text wrapping, z-order, JSON scene serialization, `toDataURL({pixelRatio})` for print-resolution export, instant startup. PDF via self-hosted **jsPDF** (MIT).
2. **Fonts**: titles in **Dumbledor** (`assets/fonts/dum2.ttf` — note: this file is actually Dumbledor 1, the correct wiki font) with a canvas gradient/bevel treatment; names/headers in **OptimusPrinceps** (`assets/fonts/OptimusPrinceps.ttf` + SemiBold, already pushed); ability text in **Trade Gothic LT Std** (already self-hosted). The PSD's title font (LHF Unlovable) and Helvetica are commercial — **never ship them**; the demo title exists only as a rasterized image.
3. **Raw wiki character art is acceptable for v1** icons. The watercolor restyling comes later via the planned Icon Studio (a designed-but-undeployed Pyodide/Pillow pipeline: palette grading, watercolor texture, white stroke, drop shadow).
4. **Portrait 5:7 sheet only for now** (canvas 1500×2100). Landscape variants are a someday-maybe.
5. UI style: match the Token Tool — **sharp corners** (site-wide aesthetic), parchment cards, left sidebar, mobile-first.

---

## 3. THE ASSET PACK (already in the repo)

Everything lives in `assets/script-studio/`:

- **`template.json`** — THE key file. Machine-readable layout manifest with exact PSD coordinates for every element: canvas, palette, font specs, text styles, all chrome layers, night-column geometry, team section definitions, and the full No Greater Joy demo layout (11 characters with icon/name/ability boxes, night-order icon sequences). This is the seed of your document model and the default template. Read it before designing the data structures.
- **`template/`** — reusable chrome: `bg-parchment.jpg`, `bar-left/right.png`, 4× `botanical-*.png` corners + `botanical-berries-left.png`, `clock.png`, 4× `divider-*.png`, `night-moon-left/right.png`, `night-sun-left/right.png`.
- **`template/alt/`** — 29 hidden PSD layers (alternate icons, botanicals, frames). Future theme material; ignore for v1.
- **`demo/`** — 11 watercolor `icon-*.png`, the `night-mini-*.png` icons, `title-nogreaterjoy.jpg` (rasterized styled title), `reference.jpg` (visual target).
- **`README.md`** — asset inventory + licensing. **`PLAN.md`** — the approved plan.

Team palette: Townsfolk `#0064AC`, Outsider `#0A3E64`, Minion `#640A0A`, Demon `#D00000`, ink black, night labels white.

---

## 4. BUILD PHASES (each ends in a working push)

**Phase 1 — Renderer.** `script-studio.html` + `assets/script-studio.js`. Konva stage sized responsively to the 1500×2100 canvas. Load `template.json`, implement auto-layout (§5), load a script's characters with wiki art, compute night columns, PNG export button. Opens with the No Greater Joy demo sheet so the page demos itself. No editing yet.

**Phase 2 — Editor.** Tap-to-select with Konva Transformer (move/resize/rotate), double-tap text to edit in place, per-element panel (Token Tool modal pattern: sliders for position/scale/rotation/opacity, font size/color/align for text, replace-image), layers strip (reorder/hide/**lock chrome** so dragging a name can't grab the parchment), undo/redo via document snapshots, localStorage autosave.

**Phase 3 — Global controls + export.** "Adjust All" panel (global font scale, team colors, ability size, icon size, density, toggle night columns, swap background/botanicals), multi-page for overflowing scripts (page 2+ gets chrome but no title block), print PDF (A4/Letter at exact physical size, 2×–3× pixelRatio ≈ 300 DPI), density modes (Teensyville scripts get a roomy spread).

**Phase 4 — Integration.** Official-JSON import (reuse the Token Tool's import/matching/proxy-art flow), "Attach design to script" persisting the document JSON inside the script's D1 `data` blob (no schema migration needed — hybrid blob design), buttons on Script Builder (`script.html`) and script pages (`script-view.html`), custom asset uploads.

**Phase 5 (stretch).** Theme presets (the `alt/` layers are a head start), Icon Studio integration, shareable design links.

Get David's go-ahead between phases; he'll review each on the live site.

---

## 5. CORE ARCHITECTURE

**Document model.** The scene is data: a JSON document extending `template.json`'s schema — canvas + ordered layers, each `{id, type: image|text, x, y, w, h, rotation, opacity, visible, style, src|text}`. Renderer draws the document; editor mutates it; save/share is just JSON. Auto-layout is a pure function `script → document`; manual edits sit on top, and a "re-flow" action regenerates layout while preserving style overrides.

**Auto-layout.** Team sections in official order (Townsfolk → Outsiders → Minions → Demon → Travellers/Fabled if present), colored header + divider each, adaptive column counts (3-col townsfolk, 2-col mid teams, 1-col demon, per the reference). Character cell = icon left, name above centered wrapped ability. Measure text to budget vertical space; overflow → multi-page or compact density.

**Night columns (the party trick).** Wiki characters carry `firstNight` / `otherNight` numbers; official JSON has global night order. Left bar: moon → minis sorted by `firstNight` (skip 0) → sun. Right bar: same with `otherNight`. Mini icons for v1 are the character's wiki art scaled small.

**Script sources.**
- Script Builder working set: localStorage key **`botc_script`** (array of slugs) + its meta.
- Published scripts: `scripts.json` live endpoint / `script-view.html?s={slug}`; D1 `scripts` table (`slug`, `name`, `author`, `data` JSON blob).
- Character data: fetch **live** `https://botchomebrew.wiki/characters.json` (Worker serves it from D1 — the repo's static copy is a STALE backup, never use it). Art at `assets/art/{slug}.png`, same-origin so no CORS.
- Imported official JSON: `_meta` header object + character entries; external art fetched direct-URL first, then via the `botc-wiki-proxy` Worker `/fetch?url=` route (NOTE: that route was drafted but David may not have pasted it into the Cloudflare dashboard yet — check before relying on it).

---

## 6. SITE / DEPLOY ESSENTIALS

- Stack: **Cloudflare Workers + D1 (SQLite) + KV (sessions) + R2 (art)**; static assets via `env.ASSETS`. Repo `djclocktower/botc-homebrew-wiki`, branch `main`, **auto-deploys to Cloudflare on every push** — no manual deploy step.
- Build status: Cloudflare dashboard → Workers & Pages → botc-homebrew-wiki → Deployments (David checks; Cloudflare posts nothing back to GitHub). Rapid back-to-back commits can drop intermediate builds — a nudge commit retriggers.
- Cloudflare per-asset cap: 25 MB. Konva + jsPDF are far under.
- Verify live pages with `curl -L` against the **clean URL path** (`.html` paths return an empty 307 body).
- The authoritative visual test loop is **Playwright + Chromium** in your sandbox: binary `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, env `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`. Screenshot the rendered page and compare to `demo/reference.jpg`. (Known quirk from the token work: headless canvas can differ from real browsers on exotic transforms — screenshot-verify anything transform-heavy.)

---

## 7. GITHUB API RULES (hard-won — follow exactly)

- Multi-file commits: **Git Trees API**, atomic: fresh HEAD ref → resolve commit → base tree SHA → create blobs (base64) → create tree with `base_tree` → create commit → PATCH ref.
- **Fetch a fresh HEAD SHA immediately before creating the commit** — never reuse one from earlier; David's own pushes can advance HEAD mid-session.
- Single-file edits via Contents API: `GET` a fresh SHA immediately before every `PUT`.
- After pushing, **re-fetch the file and check `'target_string' in content`**. Assert-before-replace routinely throws false-negative `AssertionError`s (Unicode/escaping/newline mismatches) — every "AssertionError" after a successful push has historically been a false alarm; the re-fetch check is the truth.
- Validate all JS with `node --check` before pushing.
- Set a browser User-Agent on all authenticated calls (Cloudflare bot detection blocks default Python urllib UA on `/api/*` POSTs).

---

## 8. SITE-SPECIFIC GOTCHAS

- `index.html` and several root pages do **NOT** load `assets/site.js` — they use inline scripts. Any nav link to Script Studio must be **static HTML edited into each root page**, not JS-injected.
- Character pages: `charpage.js` overwrites `#crumb` at runtime — links that must survive there go inside `charpage.js`'s template string.
- **CRITICAL srcdoc bug**: `create.html` and `edit.html` contain a JS srcdoc preview string holding `</header>`, `</body>`, `<script>` as *literals*. Never string-replace those tags naively in these files — anchor on unique surrounding context (e.g. `'\n</body>\n</html>'`), and verify injected code lands AFTER `"$('preview').srcdoc"` in the file.
- D1 is the live source of truth; verify D1 writes against the live `characters.json`/`scripts.json` endpoints, never repo files.
- D1 database id `1f49bdfc-cb4a-4a24-acbf-361a16612816`; Cloudflare MCP tools available for D1 queries and Worker code inspection (`workers_get_worker_code`, scriptName `botc-homebrew-wiki`, confirms deploy propagation). R2 bucket: `botc-wiki-art`.
- The manifest-version-bump rule (`m['v'] = ...`) applies to the **Token Tool's Python toolkit files only** — not to Script Studio.

---

## 9. DEFINITION OF DONE (per phase)

1. `node --check` passes on every JS file pushed.
2. Pushed via one atomic Trees-API commit; re-fetched and content-verified.
3. Playwright screenshot of the live (or locally-served) page looks right; Phase 1's demo render visually matches `demo/reference.jpg` in composition (fonts will differ per §2.2 — that's expected).
4. Works at phone width — David reviews on mobile first.
5. Tell David it's pushed and what to look at; he'll verify the Cloudflare build.
