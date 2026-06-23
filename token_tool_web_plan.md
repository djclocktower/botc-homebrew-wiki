# Plan: Bringing the Token Toolkit to botchomebrew.wiki

*Draft for review. Goal: turn the Python/Pillow token generator into a usable tool on the
website. This plan is honest about what's hard and where it can break.*

---

## 1. The situation in one paragraph

The **token tool** is Python + Pillow + NumPy: it rasterises high-res PNGs with custom
fonts, per-glyph arced text, an engrave effect, optical kerning, leaf/flower compositing,
disk-clipping, and a black-background alpha key. The **website** runs on Cloudflare Workers
(JavaScript/V8) + D1 (SQLite) + KV, with static assets on GitHub and a `botc-wiki-proxy`
Worker for art/page uploads. **Cloudflare Workers cannot run Pillow or NumPy.** That single
fact drives the entire plan: the rendering has to happen somewhere other than the Worker —
either in the visitor's browser, or on a separate Python host, or ahead of time by me.

---

## 2. Where the rendering can actually happen

There are only four places image rendering can live. Everything below is a variation on one
of these.

| # | Where it runs | Reuses the Python? | Ongoing cost / ops | Fidelity to current output | Build effort | Mobile-friendly |
|---|---|---|---|---|---|---|
| 0 | **Pre-rendered by me, uploaded as files** | Yes (offline) | None | Identical | Tiny | N/A (just downloads) |
| 1 | **Browser, ported to JS/Canvas** | No (rewrite) | None | Close, needs re-tuning | Large | Yes, with care |
| 2 | **Browser, Python via Pyodide/WASM** | Yes (same code) | None | Identical-ish | Medium | Risky (heavy load) |
| 3 | **Separate Python backend API** | Yes | Real (host + deploy) | Identical | Small wrapper | Yes (phone just up/downloads) |

The trade is always the same: the more faithfully we reuse the existing Python, the more we
pay in either hosting/ops (option 3) or browser weight (option 2); the more we want a free,
self-contained tool on the current stack, the more we have to re-implement and re-tune
(option 1).

### Option 0 — Pre-rendered downloads (the quick win)
I render each script's sheets offline exactly as I do now, and we upload them so every
script page gets a **"Download token sheets (PDF/PNG)"** link. Zero new technology, works on
the current stack today, output is exactly what you've been approving.
*Limit:* only covers scripts I've rendered; not self-serve for a visitor's own pasted JSON;
each new/edited script needs me to re-render and re-upload.

### Option 1 — Port the renderer to browser JavaScript (Canvas)
A new static page (`tokens.html`) plus a `token-render.js` that reproduces `gen/deco/
reminder` with the Canvas 2D API. Fonts via `@font-face` (Dumbledor2 + Trade Gothic are
already self-hosted; add Open Sans). Assets (frame, flower, leaves) served as static files.
Output assembled client-side into a **print-ready PDF** (tokens placed at exact inches) and/
or a ZIP of PNGs.
*Strength:* lives on the existing free stack forever, no backend, scales to any number of
visitors, nothing leaves the browser.
*Limit:* it's the biggest build, and it will **not** be pixel-identical at first — Canvas
and Pillow differ in font rasterisation, antialiasing, and blur, so the engrave effect and
kerning need visual re-tuning. Mobile memory is a concern for full sheets (mitigated below).

### Option 2 — Run the exact Python in the browser via Pyodide (WASM)
Pyodide ships NumPy and Pillow, so the existing `gen/deco/reminder` can run almost unchanged
in the browser. High fidelity, no backend.
*Limit:* Pyodide + NumPy + Pillow is a multi-megabyte download (slow first load, heavy on
mobile data and memory); a 25-token sheet may take tens of seconds on a phone; and Pyodide's
Pillow may lack WebP, so the leaf assets would need pre-converting to PNG. Good for an
occasionally-used print tool, shaky as an everyday interactive one.

### Option 3 — Python backend API
Wrap the existing code in a tiny FastAPI/Flask service, host it (Cloud Run, Fly.io, Render,
or a Cloudflare Container), and have the main Worker proxy `/api/tokens` to it. The phone
just uploads JSON and downloads PNGs; the **server fetches the art** (no browser CORS
problems, and it can reach imgur, which the sandbox can't).
*Limit, and it's the big one for you:* this is a service that costs a little money and needs
deploying, monitoring, and updating — ops you can't do solo, and that I can't do for you
either without access to a cloud account. It's the fastest path to a faithful result but the
least sustainable given you don't code.

---

## 3. Recommended path (phased)

A single jump straight to a perfect self-serve renderer is the riskiest move. I recommend
shipping value early and adding capability in layers:

**Phase 1 — Pre-rendered sheets on script pages (Option 0).**
Immediate, faithful, zero new tech. Add a "Token sheets" section/button to each script (or
collection) page linking to the character + reminder PDFs I render. This alone makes the
tool "usable on the website" for your curated scripts while we build the interactive version.

**Phase 2 — In-browser renderer for the wiki's own scripts, powered by Pyodide (Option 2,
DECIDED).** A `tokens.html` page that loads the existing `gen/deco/reminder` Python verbatim
via Pyodide (WASM) — identical output, no re-tuning. Live single-token preview (half-res on
mobile) and a "Generate sheets" button, prefilled from a script's characters. Because wiki
characters store `image: https://botchomebrew.wiki/assets/art/{slug}.png` (**same origin**),
there are no CORS problems for the main use case. Output: PNG or print-ready PDF, Letter or
A4, with adjustable margins / padding / layout (see §4.1).

**Phase 3 — Arbitrary pasted/uploaded script JSON + external art.** *Deferred / out of
current scope.* The decision is that the tool works only off characters already in the wiki,
whose art is same-origin — so no external fetching, no CORS, and no `botc-wiki-proxy` image
proxy are needed right now. If self-serve rendering of pasted JSON with off-wiki art is ever
wanted, this is where it slots in (external art via the proxy Worker, which can also reach
imgur); until then we skip it entirely.

**Phase 4 (only if ever needed) — Python backend (Option 3).** Not on the path. The Pyodide
engine is faithful, so there's no fidelity reason to add a backend. Listed only so it's on
record as the escape hatch if some future need (e.g. server-side batch rendering) appears.

**Engine decided: Pyodide.** This keeps the existing Python as the single source of truth —
no second renderer to maintain, no fidelity re-tuning. The cost is a one-time ~15–20 MB first
load (CPython + NumPy + Pillow + our assets). We hide it by (a) lazy-loading Pyodide only when
the tool page is opened, not site-wide; (b) warming it in the background the moment the page
renders, while the user picks a script and sets options, so it's usually ready before they
click Generate; (c) self-hosting the Pyodide files + the NumPy/Pillow wheels on Cloudflare
(edge-cached, brotli) rather than a public CDN; and (d) a service-worker / Cache API store so
repeat visits skip the download and pay only a few seconds of init. Half-res mobile previews
cut per-token *render* time but not the load; the warm-in-background step is what makes the
load feel invisible.

---

## 4. Design detail for the recommended in-browser tool

**New page:** a standalone **Token Tool** page (`tokens.html`), modelled on the existing
Script Tool — its own destination with a persistent working set of characters, an options
panel, a live preview, and Generate/Download. It is not tied to any one script; you build up
a set of characters in it and render them.

**Renderer engine:** Pyodide runs the existing `gen.py` / `deco.py` / `reminder.py` /
`build_necro_margin.py` unchanged, via a thin JS ↔ Python bridge.
- On load, fetch the toolkit `.py` files + assets (frame, flower, leaves, fonts) and write
  them into Pyodide's virtual filesystem; `loadPackage(['numpy','Pillow'])`.
- JS hands Python the script JSON + an options object (margins, padding, layout, paper,
  format, DPI); Python renders the tokens and assembles the sheet exactly as the desktop tool
  does and returns PNG/PDF bytes, which JS turns into a preview or a download.
- Nothing is re-implemented, so the engrave effect, optical kerning, leaf clipping, and the
  conditional flower are pixel-for-pixel the desktop output — that's the entire point of
  choosing Pyodide over a JS re-port.

**Assets:** serve `frame_bare.png`, `reminder_blank.png`, `raw_Layer_2.png`, the leaf set,
and fonts. Convert the `.webp` leaves to `.png` to avoid engine quirks. Add
`@font-face` for Dumbledor2, Trade Gothic, Open Sans (confirm web-embedding licence).

**Sheet assembly:** done in Python (Pillow) so it matches the desktop pipeline. Each token is
rendered once, then placed on the page at its exact physical size per the layout options in
§4.1. For PNG output the page is a 400-DPI raster; for PDF, Pillow writes the page(s) to PDF
(multi-page when tokens overflow one sheet). Tokens are rendered and composited in a stream
rather than holding many big canvases at once, to keep phone memory in check.

### 4.1 Output & layout options (user controls)

Each control maps to a parameter passed into the Python renderer, so behaviour matches the
desktop tool exactly. None of these touch the renderer's hard parts — they're layout/format.
**Defaults: A4, grid, character margin 5%, reminder margin 5%, 400 DPI, small padding.**

- **Per-token margin** — the base-grow you did by hand earlier. Exposed as a control per token
  type; **defaults to 5% for characters and 5% for reminders.** Internally this is
  `CHAR_MARGIN` / `REM_MARGIN` from `build_necro_margin.py`: it grows the base + leaves +
  flowers around fixed art/text, so more margin = more punch tolerance. Guard ~0–25%.
- **Token padding (spacing)** — the gap *between* tokens on the sheet, in mm or inches. This is
  separate from the per-token margin: margin is *inside* the token (around the art), padding is
  *between* tokens. Defaults to a small gutter; 0 packs them as close as the layout allows.
- **Layout: grid (default) vs. alternating grid** —
  - *Grid (default):* the straight rows/columns I've been producing.
  - *Alternating (offset) grid:* every other row is shifted by half a token so the round
    tokens nestle into the gaps of the row above (hexagonal close-packing — exactly your
    felt-backed sheet). Rows alternate count (e.g. 4 then 3) and the vertical pitch tightens to
    ~0.87× because the offset lets rows sit closer, so it fits more tokens per page and wastes
    less paper between circles. Padding is still honoured as the minimum gap.
- **Paper size — A4 (default) or Letter** — A4 = 210×297 mm (≈3307×4677 px @ 400 DPI);
  Letter = 8.5×11″ (3400×4400 px @ 400 DPI). Token physical size stays fixed; the grid
  recomputes columns/rows for the chosen sheet and paginates to extra pages when needed.
- **Format — PNG or PDF** — PNG = one 400-DPI image per page (easy to preview/share); PDF =
  print-ready, multi-page, exact physical sizing (best for a print shop). Both come straight
  out of Pillow.
- **DPI** — default 400 (print); a lower value powers the fast half-res mobile preview.

The only piece with any subtlety is the alternating grid's offset/pitch math, which is a
small self-contained layout function.

**Data bridge:** the wiki already exposes `window.buildSchema(data)` and JSON endpoints
(`/characters.json`, `/collections.json`, `/scripts.json` from D1), and the token tool only
needs `name, team, ability, image, firstNight, otherNight, setup, reminders[]`. So characters
flow straight in with no schema translation, and same-origin art means an exportable canvas.

### 4.2 Getting characters into the tool

The Token Tool holds a working set of characters, filled three ways (mirroring how the Script
Tool works):

- **"Add to token tool" from a script/collection page, the Script Tool, and an individual
  collection page** — adds *all* that script/collection's characters to the tool in one click
  and opens it. Implementation: the button collects the character slugs (or collection id) and
  opens `tokens.html` with them — e.g. `tokens.html?collection={id}` or
  `tokens.html?chars=slug1,slug2,…`; the Token Tool then fetches their data from the wiki's
  same-origin JSON endpoints and loads them in. (Slugs/ids in the URL keep it shareable and
  avoid stuffing full JSON into the link; for very large sets we hand off via `sessionStorage`
  instead.)
- **Per-character "Add to token tool"** — a select/add control on character listings and pages
  so you can cherry-pick characters into the tool one at a time, exactly like adding a
  character to a script in the Script Tool.
- **In-tool character picker** — on the Token Tool page itself, a search/add box to pull any
  wiki character into the set, plus remove/reorder, so the set can be tuned before rendering.

The working set persists in `sessionStorage` so navigating in/out of the tool doesn't lose it.
Rendering still happens entirely client-side via Pyodide; these entry points only decide
*which* characters land in the set.

---

## 5. Honest limitations and risks

- **The Worker can't render.** Non-negotiable; rendering is browser-side or on a separate
  host. There is no "just run it on Cloudflare" path that includes Pillow.
- **Pyodide first load.** ~15–20 MB one-time download plus a few seconds of WASM/Python init
  (≈5–10 s on desktop, ≈10–20 s on typical mobile, more on slow connections). Mitigated by
  lazy-load + background warming + self-hosting + a service-worker cache (see §3); repeat
  visits skip the download. Output fidelity is *not* a concern — it's the exact Python.
- **Mobile performance.** You work on mobile; full sheets are heavy and Pyodide adds memory
  pressure. Half-res previews and stream-compositing help, but very large scripts (40+
  characters, dozens of reminders) may still be slow or memory-tight on older phones; the
  fallback is to render fewer tokens per page or step the preview DPI down.
- **CORS / art hosts.** Not an issue in the current scope — the tool renders only wiki
  characters, whose art is same-origin (`botchomebrew.wiki/assets/...`), so canvases export
  cleanly. (This only resurfaces if pasted-JSON / off-wiki art is added later, which is the
  deferred Phase 3.)
- **Public + client-side = low cost/abuse.** Because every render runs in the visitor's own
  browser, opening the tool to all visitors adds no per-render server cost and nothing to
  overload — Cloudflare only serves the static Pyodide files + assets (edge-cached). The one
  shared cost is that bandwidth on first loads; on Cloudflare's static/edge tiers that's
  negligible at wiki scale.
- **I can't deploy anything from here.** Whatever we build, wiring it into Cloudflare/GitHub
  is done by you (with copy-paste-ready files and click-by-click steps from me) or via the
  existing PAT/proxy flow. Steps that require the Cloudflare dashboard or a `wrangler deploy`
  are on you to trigger; that's a genuine adoption risk for anything beyond Option 0.
- **Fonts licensing.** Serving Dumbledor2 / Trade Gothic as web fonts is a licensing
  question; they're already self-hosted on the wiki, so likely fine, but worth confirming.
- **Stale repo handoff.** The website handoff doc predates the Cloudflare migration; this
  plan assumes the current Workers + D1 + KV stack. If that's wrong, parts of §4 shift.
- **Single source of truth (a Pyodide upside).** Because Pyodide runs the actual Python,
  there's no second renderer to drift out of sync — the desktop toolkit and the web tool are
  the same code. Updating one updates both.

---

## 6. Decisions made & questions still open

**Decided so far**
- **Engine: Pyodide** — run the existing Python in the browser; identical output, no backend.
- **Audience: all visitors** — and since rendering is fully client-side, that adds no server
  cost or abuse surface (no shared backend to overload).
- **Input: wiki characters only (for now)** — the tool renders scripts/collections already in
  the wiki, using their same-origin art. No pasted JSON, no external-art fetching, no proxy
  work. (Pasted-JSON support stays parked as the deferred Phase 3.)
- **Fidelity:** moot — it's the exact desktop renderer.
- **Output format:** both **PNG and PDF**, selectable; **Letter or A4**, selectable.
- **Token sizing:** **adjustable** — per-token margin, plus token padding, plus grid vs.
  alternating-grid layout (§4.1).
- **Entry points:** a **standalone Token Tool page** (like the Script Tool), plus **"Add to
  token tool"** on the Script Tool and on script/collection pages (adds the whole set), plus
  **per-character add** from listings, plus an in-tool character picker (§4.2).
- **Defaults:** **A4, grid, character margin 5%, reminder margin 5%, 400 DPI**, small padding.

**Still open (one content caveat)**
1. **Icon source** — the tool uses each character's stored wiki `image`. Where that's full
   character art rather than a clean token-style icon, the token will look different from the
   desktop sets (which used dedicated alignment-coloured icons). Fine to accept for now, or do
   you want an optional separate token-icon per character down the line?

---

## 7. Suggested immediate next step

Ship **Phase 1 (Option 0)** now: I render the current scripts' sheets as print-ready PDFs and
we add a download link per script page. It delivers a usable tool on the website immediately
with zero new tech, and it buys time to settle the open questions above before the Pyodide
build. In parallel I can stand up a bare `tokens.html` that just boots Pyodide and renders one
token, to prove the load/preload flow and the in-browser render end-to-end before wiring in
the full options UI and the script integration.
