# Icon Forge — Technical Guide & Integration Manual

> **Wiki note (read this first).** This is the handoff document that came with
> the original React app, kept because §2–§7 are the reference for how the
> engine works and what breaks when you change it. **§1 and §8 describe the
> original project, not this repo.** The wiki did not deploy the built React
> app at a subpath: the tool was rebuilt in vanilla JS on the wiki's own
> styling, the way Grimoire Forge was, because the wiki has no build step.
> What actually shipped:
>
> - `iconforge.html` — the page at `/iconforge`, all UI and page-local CSS.
> - `assets/iconforge/engine.js` — `iconEngine.ts` with the types stripped
>   (via `tsc`, comments kept). Behaviour unchanged; §2, §3 and §7 all still
>   apply verbatim, including `MASK_OPTS`, the clone-before-mutate rule and
>   the canvas-state-leak rule.
> - `assets/iconforge/{app,editor,textures,source,bgremoval}.js` — the wiki's
>   own replacements for `Home.tsx`, `ControlPanel.tsx`, `PreviewStage.tsx`,
>   `EditorOverlay.tsx`, `Dropzone.tsx`, `ChromaPicker.tsx` and the small libs.
> - `assets/iconforge/{textures,minipaint,vendor}/` — the sealed payload:
>   texture sheets, the miniPaint build, and the two vendored
>   background-removal modules (see `vendor/README.md`). The sample artwork
>   buttons of §1/§8 are not part of the wiki build.
>
> There is no React, no Tailwind, no router and no `dist/`. The three unused
> texture sheets mentioned in §7 were not copied over.

**What this is:** Icon Forge is a self-contained, fully client-side web app that turns clean line art / vectors / photos into icons that look like official *Blood on the Clocktower* character icons. It uses texture sheets reverse-engineered from the official icons (github.com/matteipis/Reverse-engineered-BotC-textures), a multi-stage canvas pipeline, an embedded paint editor (a customized miniPaint fork), and optional in-browser AI background removal. There is **no backend** — everything runs in the user's browser.

**What this document covers:**

1. Project layout & build
2. How the icon engine works (pipeline, stage by stage)
3. The performance model (stage caching + progressive preview)
4. The embedded editor (miniPaint fork + custom lasso tool)
5. AI background removal
6. Options reference (every knob and what it does)
7. Pitfalls — things that WILL bite you when modifying this code
8. How to integrate it into botchomebrew.wiki (step by step)
9. Acceptance checklist for the integration

---

## 1. Project layout & build

```
app/
├── index.html                  # Vite entry
├── vite.config.ts              # base: './' (relative — deployable under ANY subpath)
├── package.json
├── src/
│   ├── main.tsx                # React root; BrowserRouter already provided here
│   ├── App.tsx                 # routes (single route: Home)
│   ├── pages/Home.tsx          # page state, source loading, texture loading,
│   │                           # AI bg-removal orchestration, export (PNG download)
│   ├── sections/
│   │   ├── ControlPanel.tsx    # ALL the option UI (sections of sliders/toggles)
│   │   └── PreviewStage.tsx    # live preview canvas + progressive rendering +
│   │                           # backdrop switcher + paint-bucket tap handling
│   ├── components/
│   │   ├── Dropzone.tsx        # file drop / browse
│   │   ├── EditorOverlay.tsx   # fullscreen overlay hosting the miniPaint editor iframe
│   │   └── ChromaPicker.tsx    # eyedropper for chroma-key colour
│   └── lib/
│       ├── iconEngine.ts       # ★ THE ENGINE — pure canvas/TS, no React. ~1500 lines.
│       ├── textures.ts         # texture catalogue (character-type picker data)
│       ├── source.ts           # file → HTMLImageElement loading (SVG rasterizing, EXIF)
│       ├── bgRemoval.ts        # @imgly/background-removal wrapper + cleanup pass
│       └── minipaintTheme.ts   # CSS injected into the editor iframe to match the theme
├── public/
│   ├── textures/*.png          # the reverse-engineered BOTC texture sheets
│   ├── samples/*               # built-in sample artwork buttons
│   └── minipaint/              # ★ the editor: prebuilt, vendored, self-contained
│       ├── index.html
│       ├── js/bundle.js        # custom-built webpack bundle (NOT upstream miniPaint)
│       └── images/icons/*.svg  # toolbar icons (incl. our custom lasso.svg)
└── dist/                       # production build output (generated; deploy this)
```

**Build:**

```bash
npm install        # once
npm run dev        # local dev server
npm run build      # → dist/  (tsc typecheck + vite build)
npm run preview    # serve dist/ locally
```

Node 18+ works. No environment variables, no secrets, no server code.

**Key facts:**

- `vite.config.ts` sets `base: './'`, so the built site works from any subpath (`/icon-forge/`, `/tools/icon/`) without rebuilding. Keep it that way.
- The app is one route (`/`). `BrowserRouter` is already in `main.tsx` — do not add another router in `App.tsx`.
- TypeScript strictness is real: `npm run build` runs `tsc -b` first, so type errors fail the build.

---

## 2. How the icon engine works

File: `src/lib/iconEngine.ts`. It is **pure canvas code** — no React — and exports:

- `renderIcon(source, opts, textures, outputSize, supersample?)` — one-shot render (used for PNG export)
- `createIconRenderer()` — a stateful renderer with stage caching (used by the live preview)
- `probeBucket(source, opts, fx, fy)` — paint-bucket hit test (`'open' | 'solid' | 'enclosed'`)
- `DEFAULT_OPTIONS`, `EngineOptions`, `TextureImages`, `BucketFill`

### 2.1 The mental model

An official BOTC icon is a **"sticker"**: a white border ring around a silhouette, the silhouette filled with a graded colour texture (blue = good, red = evil…), white parchment texture for detail lines, and a soft drop shadow. Crucially, border, body, and details are **crops of one continuous texture sheet**, so the texture flows seamlessly across the whole icon.

The engine reproduces this exactly: it builds **alpha masks** from the artwork (colour-body mask, white-detail mask, border ring), renders **continuous texture fields** the size of the canvas, then clips the fields with the masks and composites the stack.

### 2.2 Pipeline stages (in order)

All work happens on a square working canvas of side `W = outputSize × supersample` (supersample = 2 for quality, 1 for fast interactive previews). Everything is drawn at W and progressively downscaled at the end, which is what makes edges look hand-inked rather than jagged.

**Stage A — `prepSource(source, W, opts)`**
Rasterizes the input into the padded square working canvas: optional auto-crop of empty margins (`trim`), optional white-key or chroma-key background removal, then fit-and-center with `padding`.

**Stage B — `buildMasks(fitted, opts, ss)` → `Masks`**
The heavy pixel stage. Produces:

| Mask | Meaning |
|---|---|
| `color` | Where the colour texture goes (the ink/body). Soft-edged by `edgeOuter`. |
| `white` | Where parchment-white detail goes. Soft-edged by `edgeInner`. |
| `union` | color ∪ white — the silhouette. Basis for border, shadow, divider clipping. |
| `shade` | Optional multiply layer (rim-light shadow band, 3D bevel shading). |
| `open` / `exterior` | Byte maps for flood-fill logic (paint bucket, hole filling). |
| `hatch` | Optional: bucket-picked regions where hatching applies. |

Classification depends on mode:
- **Ink & paper (auto):** luminance threshold splits ink (→ colour) from paper (→ white detail). `invert` swaps it.
- **Silhouette:** the whole shape becomes colour body; interior dark/bright *line* details can still be extracted into the white mask.
- **Line extraction** (`lineDetails`): local-contrast detector — anything much darker/brighter than its blurred neighbourhood (handle wraps, stitching) becomes white detail. Works on scans and photos.
- **Colour edges** (`colorEdges`): white line where neighbouring *hues* differ even at equal brightness.
- **Hole filling:** `fillHoles` floods every fully-enclosed open space with white; `innerDetails` keeps enclosed whites as detail; the **paint bucket** (`bucketFills`) floods user-tapped enclosed regions with white, colour, or marks them for hatching.
- **Line thickness** (`lineThicken`): positive dilates the colour mask (blur + levels grow, white detail yields), negative erodes it (blur + levels cut).
- **Procedural lighting:** `buildLighting` adds rim-highlight crescents to the white mask and a shadow band to `shade`; `buildBevel` treats the silhouette as a heightfield for fake-3D shading (spec → white, shade → `shade`).

**Stage C — `buildBorder(union, width, edge)`**
Stamps the silhouette around a circle to grow the ring, then blurs for edge softness.

**Stage D — texture fields (`textureField` + `adjustField`)**
Each texture PNG is tiled (mirror-tiled, so joins are seamless) over a W×W canvas under a DOMMatrix transform (`texScale`, `texRotation`, `texOffsetX/Y`). `adjustField` then applies per-pixel saturation / brightness / vibrance / vertical-gradient grading. One field per texture means border/body/details line up like crops of one sheet — this is the core fidelity trick; don't replace it with per-region tiling.

**Stage E — composite (in draw order)**
1. Drop shadow: silhouette (union ∪ border) filled black, blurred, offset.
2. `borderFill`: border ring clipped from pure white (official style) or the cream field.
3. Optional `whiteUnderlay`: white-texture layer under the whole silhouette (the "Krita method" — soft edges always have white behind them).
4. `colorFill`: colour field clipped to the colour mask, with `shade` multiplied in (re-clipped afterwards — multiply makes the canvas opaque), then **hatching** multiplied in (dashed ink lines from `buildHatch`, clipped to bucket regions or the whole body).
5. `whiteFill`: raw (ungraded) white field clipped to the white-detail mask.
6. **Traveller split divider** (if active): a clean white vertical line spanning the sticker.

**Stage F — finish**
`downscale` (progressive halving — much crisper than one big resize), then **orientation** (`flipH`, `rotate`) applied on the final output with corner-safe shrinking so nothing crops at 45°.

### 2.3 The Traveller split style

`TextureImages.color2` set (character-type "Traveller II") = graded blue field left of the divider, red field right of it, white divider line over body *and* details, drawn against the silhouette. `splitPosition` (%) and `splitThickness` (px) are user-controllable.

### 2.4 Hatching

`buildHatch(W, angle, intensity, ss)` draws deterministic pseudo-random dashed ink lines (seeded RNG = stable across renders), multiplied into the colour fill. If the user tapped regions with the bucket in Hatch mode, hatching is clipped to those (`masks.hatch`); otherwise the whole colour body is hatched ("automatic" mode). `hatchIntensity` 0 = off, `hatchAngle` rotates the pattern.

---

## 3. The performance model — read this before touching rendering

A full pipeline run at preview size is **~750ms**; naive re-render-per-slider-tick made the UI unusable. Two mechanisms fix this. **Do not bypass them.**

### 3.1 Stage caching (`createIconRenderer`)

`renderCached()` splits the pipeline into cached stages, each keyed on *exactly* the options it reads:

```
prep (prepSource)  ← source identity + W + trim/padding/keys
masks (buildMasks) ← prep key + MASK_OPTS[] + bucketFills      ← most expensive
border             ← mask key + borderWidth/Edge
rawColor/rawWhite/rawColor2 (textureField) ← texture identity + W + tex placement opts
colorField/whiteField (adjustField + split) ← raw key + grading opts
hatch pattern      ← W + angle + intensity
composite          ← always runs (cheap-ish, mostly drawImage)
```

So dragging a texture/hatch/shadow slider is ~45ms (composite only); mask-affecting sliders rebuild masks at 1× (~150–250ms) and upgrade after.

**Rules when adding options:**
1. If your new option is read by `prepSource`/`buildMasks`/`buildLighting`/`buildBevel`, add its name to `MASK_OPTS` (and the prep key list if `prepSource` reads it). **Forgetting this means stale masks — the slider will appear to do nothing intermittently.**
2. If it's read by `textureField`, add to `TEX_OPTS`; if by grading/split, extend the field keys.
3. If it's composite-only (like `flipH`/`rotate`), do nothing — you get caching for free.
4. Object identity (source image, texture images) is keyed via a WeakMap id map — new image objects invalidate correctly, no key strings to manage.

**Mutation rule (critical):** several engine helpers **mutate their input canvas** (`clipToMask` does `destination-in` on the field; `adjustField` edits pixels in place). Any cached canvas must be `cloneCanvas()`-ed before being fed to a mutating step. The current code is correct — keep the clones when refactoring. Feeding a cached canvas straight into `clipToMask` corrupts the cache and produces bizarre double-hatched / half-clipped output on the next render.

### 3.2 Progressive preview (`PreviewStage.tsx`)

On every options change: fast pass at `supersample = 1` immediately (rAF), crisp pass at `supersample = 2` after a 220 ms idle debounce. Export always renders one-shot at full quality via `renderIcon()`.

---

## 4. The embedded editor (miniPaint fork)

The "Edit artwork" / "Draw your own" buttons open `EditorOverlay.tsx`, which iframes **`public/minipaint/index.html`** — a vendored, customized build of miniPaint (MIT license, `public/minipaint/MIT-LICENSE.txt`), themed to match and extended with a **freehand lasso selection tool** (create/move/delete/copy/cut/fill, marching-ants overlay, undoable, keyboard: Esc/Delete/Ctrl+X/F/Alt+Backspace). The overlay passes the current artwork in and receives the flattened edit back via `postMessage`; the returned image becomes the new pipeline source.

**The editor is a prebuilt bundle.** `public/minipaint/js/bundle.js` is the output of building a modified miniPaint source tree (webpack). The miniPaint source is NOT in this repo — only the built artifact and assets are. If you need to change editor internals, clone miniPaint separately, re-apply the customizations (lasso tool registration in `config.js`, lasso menu entries in `config-menu.js`, copy delegation in `modules/edit/copy.js`, fill hook in `modules/edit/edit/selection.js`, icon CSS), `npm run build`, and copy `dist/bundle.js` back over `public/minipaint/js/bundle.js`. For the integration you can treat `public/minipaint/` as a sealed black box.

**Theming:** `src/lib/minipaintTheme.ts` is injected into the iframe; editor chrome uses the same purple/parchment/gold palette as the app.

---

## 5. AI background removal

`src/lib/bgRemoval.ts` wraps `@imgly/background-removal` (ONNX Runtime Web, WASM). The "Smart AI" background mode downloads the model on first use (public CDN), runs entirely on-device, and caches the raw cutout so the cleanup-tolerance slider re-applies instantly without re-running the network. Progress events drive the busy overlay. The ~400 KB `ort.*` bundles and WASM files in `dist/assets/` come from this — they must be deployed with the site (they are, automatically, if you copy all of `dist/`). If the model download fails (offline), the app catches it, toasts, and falls back to "Keep" mode.

---

## 6. Options reference

`EngineOptions` in `iconEngine.ts`; defaults in `DEFAULT_OPTIONS`. Grouped by UI section:

**Artwork** — `mode` (auto/silhouette), `threshold` (ink cut-off 0–255), `edgeOuter`/`edgeInner` (mask softening px), `lineThicken` (−10…+10 px, negative = thinner), `padding` (canvas margin), `invert`, background removal (`removeWhiteBg` white-key / `chromaKey` / Smart AI), `innerDetails` (keep enclosed whites), `fillHoles` (fill enclosed spaces), `whiteUnderlay`, `highlights` + `highlightAngle` + `highlightWidth` (rim light), `bevel` + `bevelSize` (3D shading), `lineDetails` + `lineRadius` + `lineMode` (line extraction), `colorEdges`, `trim`.

**Orientation** — `flipH`, `rotate` (−180…180°, corner-safe).

**Paint bucket** — `bucketFills[]` (tap-to-fill regions: white / colour / hatch).

**Hatching** — `hatchIntensity` (0=off), `hatchAngle`.

**Character type** — texture choice: blue (Good), red (Evil), brown (Traveller), Traveller II split (blue/red + divider, `splitPosition`, `splitThickness`), yellow (Fabled), green (Loric), white (Monochrome).

**Grading** — `colorSat/Bright/Vib/Grad`, `whiteSat/Bright/Vib/Grad`.

**Texture placement** — `texScale`, `texRotation`, `texOffsetX/Y`.

**Border & shadow** — `borderWidth`, `borderStyle` (white/cream), `borderEdge`, `shadowOpacity/Blur/Distance/Angle`.

Export: size presets up to matching source resolution (cap 4096), always full quality, PNG with transparency.

---

## 7. Pitfalls — each of these cost real debugging time

**Canvas 2D state leaks (the nastiest one).** `canvas.getContext('2d')` returns the *same* context every call. If any function leaves a transform (`translate`/`rotate`), composite mode, or `filter` set, the next unrelated draw on that canvas inherits it. This is why hatching initially rendered as a weird dome at the canvas edge: `buildHatch` left its rotation active and the mask drawn by `clipToMask` was silently displaced. **Rule: any function that sets a transform resets it (`ctx.setTransform(1,0,0,1,0,0)`) before returning; `clipToMask` defensively resets first.** Keep both habits when writing new canvas helpers.

**`clipToMask` and `adjustField` mutate their input.** See §3.1 — clone cached canvases before feeding them to mutating steps. If the preview ever looks right on first render but degrades on the *second* render after a change, you have a cache-mutation bug.

**Multiply blend + transparency.** Canvas `multiply` leaves fully-transparent destination pixels untouched and makes opaque output where the source is opaque. Every multiply pass in the engine is therefore followed by a `destination-in` re-clip to the mask. If you add a new multiply effect, copy that pattern or the fill will grow an opaque black rectangle.

**Blob URLs get revoked.** Loaded source images can't be displayed later via their original `.src` (revoked after load). All thumbnails (the "Forging:" bar, the editor header) re-encode through a canvas → `toDataURL`. Don't try to reuse `img.src`.

**Hosting that eats `dist/` folders.** Some static hosts silently drop directories named `dist` — which is exactly why the editor lives at `public/minipaint/js/bundle.js` and not in a folder called `dist`. If you ever vendor new prebuilt assets, do not put them in any directory named `dist` (other than the top-level build output itself).

**Test pages at the project root.** Temporary harness pages (e.g. `foo-test.html`) at the app root get served by the dev server and are easy to forget — always delete them before `npm run build`. There should be no `*-test.html` files in the delivered tree.

**Dev-server module caching in the browser.** When testing engine changes through a harness page, the browser caches TS modules aggressively — bump a `?v=N` query on the import URL (and the page URL) after every edit or you'll debug stale code.

**Vite dev vs preview.** Pages importing `/src/*.ts` only work on the **dev** server; `vite preview`/`dist` serves the built bundle. Don't point a test harness at the wrong one.

**The mask cache key.** Adding a mask-affecting option without adding it to `MASK_OPTS` = intermittent stale masks (see §3.1). This is the single most likely regression when extending the engine.

**miniPaint toolbar icons are black-on-transparent.** They are recolored to white by a CSS `invert` filter. New icon SVGs must be drawn in **black**; a white SVG inverts to black and looks broken.

**Router.** `BrowserRouter` is already mounted in `main.tsx`. Adding a second one in `App.tsx` (or anywhere) breaks the app. Static hosting has no SPA rewrites — keep everything reachable from `/` (the app currently is).

**Don't import new libraries without installing them.** Obvious, but a missing import fails the whole bundle to a blank screen.

**Editor is a black box for integration purposes.** The lasso and theme customizations live in a separately-built bundle (§4). Don't try to "quickly patch" `public/minipaint/js/bundle.js` by hand — it's minified; change the source workflow or leave it alone.

**Unused texture files.** `public/textures/` still contains `green_big_wig.png`, `white_politician.png`, `yellow_buddhist.png` — removed from the character-type picker by design. They're harmless; delete them if you want a leaner deploy, but nothing references them.

---

## 8. Integrating into botchomebrew.wiki

The wiki is a plain static site (root-level HTML pages, one global `assets/styles.css`, data via `fetch`). Icon Forge is also fully static. **Recommended integration: host Icon Forge as a self-contained sub-app at a subpath, linked from the wiki nav.** This is clean, zero-risk to existing pages, and matches how the wiki's other tools (Token Tool, Script Builder) are separate pages.

### Step 1 — Choose the subpath

e.g. `botchomebrew.wiki/icon-forge/`. Because the app builds with `base: './'`, **no rebuild is needed** — the included `dist/` works from any subpath as-is.

### Step 2 — Deploy the files

Copy the **entire contents** of `app/dist/` into `/<subpath>/` on the wiki host:

```
/icon-forge/
├── index.html
├── assets/           # hashed JS/CSS + ort WASM bundles (ALL required)
├── textures/         # texture sheets (required)
├── samples/          # sample art buttons (required)
└── minipaint/        # the editor (required — including images/icons/)
```

**Verify after upload:** `assets/` contains `ort-wasm-simd-threaded.jsep-*.wasm` and the `ort.*` bundles (AI background removal); `minipaint/js/bundle.js` exists (~1 MB); `minipaint/images/icons/lasso.svg` exists. Missing pieces fail silently — check the browser network tab for 404s after the first real run. Also confirm your host didn't drop a folder named `dist` anywhere in the path (§7).

**MIME types:** the host must serve `.wasm` as `application/wasm` for AI background removal (most static hosts do; if Smart AI mode fails with a WASM error, this is why). Everything else works regardless.

### Step 3 — Link it from the wiki

Add a nav entry ("Icon Forge" or "Icon Tool") pointing to `/icon-forge/` next to the existing Token Tool / Script Builder links in the header markup (the `.crumb` nav — note the wiki homepage has an inline `<style>` override that force-hides the crumb nav on desktop; add the link in the hamburger menu markup too, or fix that override while you're there).

Alternatively/additionally, add a card or button on the homepage and on character pages ("Make an icon for this character →").

### Step 4 — Visual fit

The app already ships in the wiki's palette (deep purples `#1a0820/#2c1333`, parchment `#f0e8d5`, maroon `#5B1F21/#8a3526`, gold `#d6c496/#ffe9ad`). It will look native next to the wiki. If you want the wiki header/footer *around* the tool, use an iframe embed instead:

```html
<iframe src="/icon-forge/" style="width:100%;border:0;min-height:1400px"
        title="Icon Forge"></iframe>
```

Caveats of iframe embedding: the PNG export uses a programmatic download (fine in a normal iframe; some sandboxed preview iframes block it — the app already shows a manual-save dialog as fallback), and the fullscreen editor overlay fills the iframe, not the whole page — give the iframe generous height. **Recommendation: start with the standalone subpath (simplest, best UX); only iframe if the site chrome is a hard requirement.**

### Step 5 — Optional future deep integration

Architecturally feasible, not required now: the engine is pure TS (`iconEngine.ts` has no React/DOM-framework dependencies beyond canvas), so the wiki could later import it directly to auto-generate icons server-side-at-build or in-page for character entries. If you go there, respect §3 (caching, mutation rules) and §7.

---

## 9. Acceptance checklist

After integration, verify on the live wiki URL:

- [ ] App loads at the subpath with no 404s (network tab), no console errors.
- [ ] All four sample buttons render an icon.
- [ ] Upload a PNG/SVG — preview renders and slider drags are fluid (fast pass) then sharpen (crisp pass).
- [ ] Character-type picker shows: Good / Evil / Traveller / Traveller II (split, with divider sliders) / Fabled / Loric / Monochrome — and nothing else.
- [ ] "Edit artwork" opens the themed editor; lasso tool works; applying returns the flattened image.
- [ ] "Smart AI" background mode downloads the model and removes a photo background (needs `.wasm` MIME + the `ort` assets).
- [ ] Export downloads a transparent PNG at the chosen size; flip/rotate/hatching/split all appear in the export.
- [ ] Wiki nav links to the tool from desktop and mobile menus.

---

## Appendix — provenance & licensing

- Textures: reverse-engineered from official BOTC icons by matteipis (github.com/matteipis/Reverse-engineered-BotC-textures) — fan-made, like the wiki itself; not for commercial use.
- Editor: miniPaint (MIT), vendored with license file at `public/minipaint/MIT-LICENSE.txt`.
- AI background removal: `@imgly/background-removal` (its own license + model terms apply), runs fully on-device.
- Everything else (`src/`) was written for this project.
