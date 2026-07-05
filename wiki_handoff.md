# BOTC HOMEBREW WIKI — FULL HANDOFF DOCUMENT
*Feed this entire file to a new Claude instance to give it complete context to work on this website.*
*Last major update: migration from static GitHub Pages to a dynamic Cloudflare Workers + D1 + KV backend (Option B architecture), plus admin login and database-backed editing.*

---

## 0. TL;DR — WHAT CHANGED MOST RECENTLY (READ THIS FIRST)

The site was **migrated off GitHub Pages onto Cloudflare Workers**. This is the single biggest change and it reshapes how everything works:

- **Hosting:** Cloudflare Worker (`botc-homebrew-wiki`) now serves the whole site. GitHub Pages is retired (repo is still the code source).
- **Data source of truth:** A **Cloudflare D1 database** (`botc-wiki`), NOT `characters.json` anymore. The static `characters.json` / `collections.json` / `scripts.json` files still exist in the repo but are **stale backups** — the live site reads from D1.
- **How data is served:** The Worker intercepts `GET /characters.json`, `/collections.json`, `/scripts.json` and builds them live from D1. The frontend still fetches those same URLs, so most frontend code is UNCHANGED (this is the "Option B" approach — client-side rendering kept, only the data origin changed).
- **Admin login:** There is now a real auth system. `login.html` + Worker endpoints + a KV-stored session. Editing/creating/publishing is gated behind admin login.
- **Editing writes to D1:** `create.html` and `edit.html` POST character data to the Worker's `/api/character` endpoint (writes to D1, instant). Art images and the `c/{slug}.html` page file still go through the OLD GitHub proxy worker (`botc-wiki-proxy`).
- **Instant edits / no hard-refresh:** Editing existing characters is instant. Cache headers (`_headers`) make CSS/JS/HTML/images revalidate so changes show on a normal refresh.

**Architecture is "Option B":** dynamic data + auth via Worker, but pages still render client-side in the browser. A future "Option A" (server-side rendering in the Worker) was deliberately deferred; it would build ON TOP of this, not replace it.

---

## 1. PROJECT OVERVIEW

Fan-made wiki for **Blood on the Clocktower** (BotC) homebrew characters by **djclocktower** (GitHub username; Discord `dj_dj_dj`). Custom domain **botchomebrew.wiki**.

The owner (David) **cannot code** and works **primarily on mobile**, but has **PC access when needed** for setup tasks. He wants to be consulted before major architecture decisions or giving up features. Working style: implement → he reviews on live site via screenshots → concise directional feedback → iterate. He reverts aggressively when results deviate.

The site has:
- A dynamic homepage (collections grid + scripts + a Resources sidebar)
- Per-character pages at `c/{slug}.html`
- Browse/filter pages: all-characters, tags, creators, collections, teams
- A **Create Character** form (`create.html`) and **Edit Character** form (`edit.html`)
- A **Script Builder** (`script.html`) with randomize + SAO sort
- A collapsible official-schema JSON box on every character page
- **Admin login** (`login.html`)

---

## 2. INFRASTRUCTURE & ACCESS

### GitHub
- **Repo:** https://github.com/djclocktower/botc-homebrew-wiki  (owner `djclocktower`, branch `main`)
- Claude pushes via the GitHub Contents API + Git Trees API (for batch commits).
- **PAT** stored at `/home/claude/.ghtoken` (fine-grained, Contents: Read & write, this repo only). Provided by the user each session.
- `api.github.com` IS reachable from the Claude sandbox.

### Cloudflare (the live hosting)
- **Worker:** `botc-homebrew-wiki` — serves the whole site, deploys automatically from the GitHub repo via Cloudflare's Git integration.
- **Worker dev URL** (bypasses custom domain, useful for testing): `https://botc-homebrew-wiki.djclocktower.workers.dev`
- **D1 database:** `botc-wiki`, ID `1f49bdfc-cb4a-4a24-acbf-361a16612816` (binding `DB`)
- **KV namespace:** `botc-sessions`, ID `1216080cee4546068ebe742c95315e0b` (binding `SESSIONS`)
- **Static assets binding:** `ASSETS` (serves the repo files)
- **Custom domains** on the Worker: `botchomebrew.wiki` AND `www.botchomebrew.wiki` (both Proxied, both point to the Worker).
- **IMPORTANT:** Cloudflare is NOT reachable from the Claude sandbox (`workers.dev` egress is blocked). Claude cannot deploy, test the Worker, run D1 queries, or hit the live API directly. All Cloudflare-side actions must be done by the user in the dashboard.

### The OLD proxy worker (still in use!)
- `botc-wiki-proxy.djclocktower.workers.dev` — a pre-existing Cloudflare Worker that pushes files to GitHub on behalf of the browser (so no GitHub token lives in the browser).
- Still used by `create.html` / `edit.html` for: **art image uploads** (PNGs → `assets/art/`) and **creating the `c/{slug}.html` page file**. Only the character *data* moved to D1.

### Admin credentials
- Username: `admin`
- Temp password: `fgwp-6328-pdrb`  (⚠️ STILL THE TEMP PASSWORD — no password-change UI exists yet)
- Password hash in D1 (PBKDF2-SHA256, 100k iters): `pbkdf2_sha256$100000$72y4pbszibrNEgWCMu3Pog==$NU1D6tWropLLcqJSv9wD0xhGT+TjgyJHNgAKggquVSk=`

---

## 3. THE CLOUDFLARE WORKER (`worker/worker.js`)

The Worker is the heart of the dynamic backend. Routes:

| Method | Path | What it does |
|---|---|---|
| GET | `/characters.json` | Builds JSON array from D1 `characters` table. `Cache-Control: no-store`. |
| GET | `/collections.json` | Builds from D1 `collections` table. |
| GET | `/scripts.json` | Builds from D1 `scripts` table. |
| POST | `/api/login` | Verifies username + PBKDF2 password against `users` table; creates KV session; sets `botc_session` cookie (HttpOnly, Secure, SameSite=Lax, 30-day). |
| POST | `/api/logout` | Deletes the KV session, clears cookie. |
| GET | `/api/me` | Returns `{loggedIn, isAdmin}` based on session cookie. |
| POST | `/api/character` | **Admin only.** Upserts a character into D1 (INSERT … ON CONFLICT(slug) DO UPDATE). |
| POST | `/api/collection` | **Admin only.** Upserts a collection. |
| POST | `/api/script` | **Admin only.** Upserts a script. |
| POST | `/api/seed` | **Admin only.** One-time data load: reads `characters.json`/`collections.json`/`scripts.json` from static assets and bulk-inserts into D1. **GUARDED:** aborts if `characters` table is non-empty (prevents overwrite). |
| (any) | everything else | Falls through to `env.ASSETS.fetch(request)` — serves static files. |

### Key Worker implementation details
- **Password verify:** PBKDF2-SHA256, format `pbkdf2_sha256$iterations$salt_b64$hash_b64`, via WebCrypto `crypto.subtle.deriveBits`.
- **Sessions:** token = two `crypto.randomUUID()` concatenated; stored in KV as `sess:{token}` → `{userId, isAdmin, created}`; 30-day TTL.
- **D1 reads** build the JSON by `SELECT data FROM <table>` and `JSON.parse` each row's `data` blob.
- **D1 writes** use `INSERT … ON CONFLICT(slug) DO UPDATE SET …` and store the full object as a JSON string in `data`, with indexed columns (name, team, creator, tags, appears_in, owner_id) pulled out.
- The `run_worker_first` in `wrangler.toml` lists exactly the routes the Worker intercepts; everything else is static.

### wrangler.toml (current, IDs filled in)
```
name = "botc-homebrew-wiki"
main = "worker/worker.js"
compatibility_date = "2026-06-15"
[assets]
directory = "."
binding = "ASSETS"
run_worker_first = ["/characters.json", "/collections.json", "/scripts.json", "/api/*"]
[[d1_databases]]
binding = "DB"
database_name = "botc-wiki"
database_id = "1f49bdfc-cb4a-4a24-acbf-361a16612816"
[[kv_namespaces]]
binding = "SESSIONS"
id = "1216080cee4546068ebe742c95315e0b"
```

---

## 4. THE DATABASE (Cloudflare D1 — SQLite)

Source of truth for all character/collection/script data. **D1 is SQLite**, so local SQLite testing is an accurate validation method.

### Schema (5 tables) — see `migration/schema.sql`
- **users**: `id` (PK autoincr), `username` (unique), `password_hash`, `email`, `is_admin` (0/1), `created_at`
- **characters**: `slug` (PK), `name`, `team`, `creator`, `owner_id` (→users.id), `tags`, `appears_in`, `data` (full JSON object), `updated_at`. Indexes on team, creator, owner_id.
- **collections**: `slug` (PK), `display_name`, `owner_id`, `data` (JSON), `updated_at`
- **scripts**: `slug` (PK), `name`, `author`, `owner_id`, `data` (JSON), `updated_at`
- **sessions**: NOT a table — lives in KV.

### The "hybrid JSON blob" design (IMPORTANT)
Queryable/indexed fields are real columns; the **entire object** is also stored as a JSON string in the `data` column. This means **new character fields NEVER require a schema migration** — they just go in the JSON. The owner has added fields like `translatedBy`, `bluffing`, `fighting` over time; all work automatically. Only filter by team/tags/creator/collection (the real columns).

### Ownership model
Every row has `owner_id`. Currently everything is owned by `admin` (id=1). The schema is built for full multi-user creator accounts later — adding them is a feature flip, not a migration.

### Migration files in `migration/`
- `schema.sql` — the 5-table schema (has `--` comments)
- `schema_console.sql`, `schema_oneline.sql` — comment-free / one-statement-per-line versions for the D1 web console
- `seed_console.sql`, `seed_oneline.sql` — the admin-user INSERT, console-friendly
- `import_data.sql` — 320KB of INSERTs for all 96 chars / 5 cols / 2 scripts (NOT used for the live seed — too big for console; superseded by the `/api/seed` endpoint)
- `schema_explanation.md` — plain-English schema doc
- `DEPLOY_GUIDE.md` — the step-by-step Stage 1 deploy guide

---

## 5. DATA LOADING / SEED

Data was loaded into D1 via the Worker's `/api/seed` endpoint (the "Option 3" approach), NOT via SQL console paste (the 320KB import was too big for the console). Process: deploy Worker → log in as admin → click "Seed Database" button on `login.html` → POST `/api/seed` → reads the static JSON files → bulk inserts into D1. The endpoint refuses to run if `characters` already has rows.

`login.html` has a one-click **"Seed Database (first-time setup)"** button (only shown when logged in) because `/api/seed` needs a POST and can't be triggered by typing the URL in a browser.

---

## 6. EDIT / CREATE FLOW (Stage 2 — current behaviour)

### create.html (publish a NEW character)
1. Upload art PNG to `assets/art/{slug}.png` via the OLD proxy worker.
2. **POST the character object to `/api/character`** (writes to D1, instant). Gated: 403 if not admin.
3. Create the static `c/{slug}.html` page file via the OLD proxy worker (needed so the URL exists).
4. On load, calls `/api/me`; if not admin, shows "log in to publish" and disables the publish button.

### edit.html (edit an EXISTING character)
1. If art changed, upload new PNG via the OLD proxy worker.
2. Build the entry (preserving original fields) and **POST to `/api/character`** (D1, instant).
3. Best-effort update of the `c/{slug}.html` page file via proxy (the page reads data live from D1, so this is only needed if name/ability/team/art in the page template changed).
4. On load, calls `/api/me`; if not admin, warns + disables save.

### Why this works
Every `c/{slug}.html` page reads `window.CHAR_SLUG`, fetches `../characters.json` (served live from D1 by the Worker with `no-store`), and renders via `render.js`. So **editing a character's data updates the live page instantly** — no page rebuild needed. Only brand-new characters need the one-time page-file creation + deploy.

### STILL ON THE OLD FLOW (not yet migrated to D1)
- **Collections editing** (`edit-collection.html`) and **script publishing** (`script.html` / `create-script.html` / `edit-script.html`) may still push to GitHub via the proxy. The Worker endpoints `/api/collection` and `/api/script` EXIST but the forms aren't wired to them yet. If a collection/script edit doesn't show live, this is why — repoint them the same way create/edit were done.

---

## 7. CACHING (`_headers` file)

Cloudflare reads `_headers` for cache rules. Current rules:
- `/assets/*.css`, `/assets/*.js`, `/*.html` → `no-cache, must-revalidate` (edits show on normal refresh)
- `/assets/art/*.png`, `/assets/art/*.jpg`, `/assets/*.png`, `/assets/*.jpg` → `no-cache, must-revalidate` (**art updates show immediately** — changed from a 24h cache after a stale-art bug, see Bugs section)
- `/assets/*.ttf`, `/assets/*.woff2` → `public, max-age=604800` (fonts cached a week; they don't change)

The Worker also sets `Cache-Control: no-store` on the JSON endpoints.

---

## 8. DEPLOYMENT MODEL & THE DELAY

- The Worker **auto-deploys from the GitHub repo** when Cloudflare's Git integration detects a push.
- This deploy pipeline (Initialize → Clone → Install → Deploy) takes ~15-40s, similar in spirit to the old GitHub Pages rebuild but usually faster.
- **What's instant vs delayed:**
  - Editing existing character DATA (→ D1) = **instant**.
  - Creating a BRAND-NEW character's page FILE (`c/{slug}.html`, a static file) = **needs one deploy cycle** before its URL works (~30-60s). The data is instant; just the new URL waits.
- Eliminating even that delay would require Option A (Worker renders pages dynamically from D1, no static file). Deferred as not worth it for a once-per-new-character wait.

### `.assetsignore` (REQUIRED — prevents deploy failure)
Cloudflare uploads ALL repo files as static assets unless excluded. `.assetsignore` (gitignore syntax, lives in repo root) excludes: `.git` (a 40.6 MiB pack file caused an "Asset too large" failure — the #1 deploy gotcha), `worker/`, `wrangler.toml`, `migration/`, `README.md`, `wiki_handoff.md`, `.DS_Store`. Do NOT ignore `_headers` (Cloudflare reads it as config).

---

## 9. REPO FILE STRUCTURE

```
botc-homebrew-wiki/
  .assetsignore                  ← excludes .git etc. from Worker upload (CRITICAL)
  _headers                       ← Cloudflare cache rules
  wrangler.toml                  ← Worker config (D1 + KV + assets bindings)
  CNAME                          ← botchomebrew.wiki (legacy; Cloudflare handles domain now)
  login.html                     ← admin login + one-click DB seed button
  index.html                     ← homepage (collections grid, scripts, Resources sidebar)
  all-characters.html            ← browse/filter all chars (3-state team+tag chips)
  character.html                 ← legacy dynamic renderer (?c=slug); c/ pages are primary
  create.html                    ← create form → POSTs to /api/character (D1)
  edit.html                      ← edit form → POSTs to /api/character (D1)
  create-script.html / edit-script.html / script.html / script-view.html / scripts.html
  edit-collection.html
  tags.html / tag.html / creators.html / author.html / authors.html / team.html
  steven-approved-order.html     ← SAO reference page
  characters.json                ← STALE BACKUP (D1 is source of truth)
  collections.json               ← STALE BACKUP
  scripts.json                   ← STALE BACKUP
  c/
    {slug}.html                  ← 97 static character pages (read data live from D1)
  characters/                    ← legacy redirect pages
  worker/
    worker.js                    ← THE Cloudflare Worker (data API + auth + seed)
  migration/
    schema.sql, schema_console.sql, schema_oneline.sql
    seed_console.sql, seed_oneline.sql
    import_data.sql              ← 320KB bulk INSERTs (not used live)
    schema_explanation.md, DEPLOY_GUIDE.md
  assets/
    styles.css                   ← ALL shared CSS
    render.js                    ← shared character renderer + JSON schema builder
    charpage.js                  ← per-c/{slug}.html bootstrap (reads CHAR_SLUG, fetches data, renders)
    site.js                      ← shared nav/topbar JS + script-count badge
    bg.jpg, purple.jpg, parchment.jpg, parchment_tall.jpg
    logo.png, logo_skull.png, favicon.png, headertext.png, ccc-parchment.png
    fonts/                       ← Dumbledor2, Trade Gothic LT, etc.
    icons/                       ← 191 official BotC role PNGs (for script tool, jinx fallback)
    jinx-icons/
    art/                         ← form-created character art (art/{slug}.png)
    collections/                 ← collection header/icon art
    scripts/                     ← script art
    h_*.png / hemo_* / larev_* / night_* / jinx_*  ← static-page rasterised headings & tokens
```

---

## 10. FRONTEND ARCHITECTURE (mostly unchanged by migration)

Hybrid client-rendered site. Pages fetch `characters.json` / `collections.json` / `scripts.json` (now served live from D1 by the Worker) and render in the browser via `render.js`.

- **Character pages** (`c/{slug}.html`): set `window.CHAR_SLUG`, load `render.js` + `charpage.js` + `site.js`. `charpage.js` reads the slug, fetches `../characters.json`, finds the entry, renders via `render.js`, and **dynamically overwrites the `#crumb` breadcrumb** (this overrides any static crumb HTML — a known gotcha).
- **render.js exports:** `renderCharacter(data, artSrc)`, `renderJsonBox(data)`, `buildSchema(data)`, `schemaJSON(data)`, `slugId(name)`, `TEAM_LABEL`.
- **site.js:** shared topbar/nav behaviour; adds a script-count badge to any `a[href*="script.html"]`.
- **buildCharPage()** in create.html/edit.html generates the `c/{slug}.html` template (includes the topbar, crumb with Script Builder link, OG meta, and the CHAR_SLUG bootstrap).

### Teams: `townsfolk, outsider, minion, demon, traveller, fabled` (also `loric` in TEAM_LABEL).

---

## 11. KEY FEATURES & RECENT WORK (pre- and post-migration)

- **Resources sidebar** on homepage (right-pinned, parchment card). After MANY layout iterations, the working approach: `.home-layout { position:relative; width:100%; }`, content panel `max-width:1180px; margin:0 auto`, sidebar `position:absolute; right:clamp(16px,3vw,48px); width:320px`. Below 1100px sidebar goes static/full-width. CRITICAL past bug: the base `.home-panel` rule (used by ALL list pages) was accidentally scoped to `.home-layout > .home-panel`, making every list page full-width — keep a bare `.home-panel { max-width:1440px; margin:0 auto }` rule intact.
- **Sidebar title** uses `text-transform: uppercase`.
- **Resources links:** Main Rulebook, Official Wiki, TB/BMR/SAV/TAF/KS almanacs (botclinks.page/*), Night Order List JSON (→ ThePandemoniumInstitute/botc-release/blob/main/resources/data/nightsheet.json), Squ4ll's Guide, The Kitchen Discord, Steven Approved Order.
- **Script Builder** (`script.html`): "⚄ Randomize" (13/4/4/4 Fisher-Yates) and "⇅ SAO Sort" (Steven Approved Order). `$` = `getElementById`. localStorage key `botc_script`. `bySlug` from characters.json. CRITICAL: `renderScript()` previously force-sorted alphabetically, discarding stored order — that forced sort was REMOVED so SAO sort persists; the SIDEBAR (`renderSidebar`) still sorts alphabetically and that's intentional.
- **SAO Sort logic:** groups by team order, then within team sorts by ability-prefix bucket (43-item ordered list matching steven-approved-order.html), then ability-text length, then name length, then alphabetical. `<Anything else>` bucket sits just before "Atheist". NOTE: more-specific prefixes like "Each night*" must precede "Each night" or they mismatch — a known subtlety.
- **Tag system:** 40 canonical tags in `KNOWN_TAGS` (in tags.html, all-characters.html, create.html, edit.html). Most recent additions: **Nonconformist**, **Think**. all-characters.html uses 3-state filter chips (unset → include[maroon] → exclude[red strikethrough]) for both teams and tags. create/edit use a button-grid tag picker (`.tag-picker`/`.tag-pick-btn` + hidden `#tags` input; `window.setTagPickerValue()` for edit prefill).
- **"Translated by" field** in render.js info dl + create/edit forms (set to "Eliderad" on all Temple Fair + Storm Is Coming characters).
- **Auto-expanding textareas** in create.html/edit.html: ALL textareas (not just `.fld textarea`) auto-grow; dynamically-added jinx rows are wired too. CSS has `resize:none; overflow-y:hidden` and JS sets height to scrollHeight on input.
- **Script Builder link in topbar** on ALL pages — added to every root page's crumb, every `c/` page, `buildCharPage()`, AND `charpage.js`'s crumb template (which overwrites the crumb at runtime: `Home › Characters · Script Builder › {Team} › {Name}`).
- **Homepage "All Characters" tile** (formerly "Standalone Characters") links to `all-characters.html`, count = `list.length` (total).
- **Homepage hero:** h1 = "Homebrew characters &amp; scripts for Blood on the Clocktower"; intro = "Welcome to the BOTC homebrew wiki. Here you can add your own custom characters, make scripts, find characters by author or tag, or add your own collection of characters."
- **JSON box** on every character page: collapsible, official-schema JSON. `renderJsonBox()` + `buildSchema()`. With jinxes → in sidebar aside; without → inside infocard.

---

## 12. BUGS & GOTCHAS ENCOUNTERED (hard-won — DO NOT REPEAT)

### Migration / Cloudflare bugs
1. **"Asset too large" deploy failure** — Cloudflare tried to upload the `.git` folder (40.6 MiB pack file > 25 MiB limit). FIX: `.assetsignore` excluding `.git` and other non-asset files. This is the #1 deploy gotcha.
2. **"PLACEHOLDER_FILLED_DURING_DEPLOY is not valid" (KV/D1)** — `wrangler.toml` shipped with placeholder IDs. FIX: fill in the real D1 (`1f49bdfc-…`) and KV (`1216080c…`) IDs. (Now done.)
3. **D1 console "Requests without any query are not supported"** — the web console chokes on `--` SQL comments and large multi-statement pastes. FIX: comment-free, one-statement-at-a-time SQL (`*_console.sql` / `*_oneline.sql`). Big imports go via `/api/seed`, not the console.
4. **`/api/seed` returns 404 when visited in browser** — it's POST-only; a browser address-bar visit is a GET, which falls through to static and 404s. FIX: the one-click Seed button on login.html (sends a proper POST). This is EXPECTED, not a bug in the Worker.
5. **"Add Domain" → "Hostname already has externally managed DNS records"** — the domain still had the old GitHub Pages A records (185.199.108-111.153) + a `www` CNAME to djclocktower.github.io. FIX: delete all 5 old DNS records, then add the custom domain to the Worker (Cloudflare auto-creates the right Worker record).
6. **Error 1016 "Origin DNS error"** — transient state after deleting old DNS records but before adding the new Worker custom domain. FIX: finish adding the custom domain; resolves in minutes.
7. **DNS_PROBE / "site can't be reached" on ONE network only** — after the DNS switch, the user's home network had the old (deleted) record cached; mobile data + incognito worked fine. FIX: `ipconfig /flushdns` (Windows) / `sudo killall -HUP mDNSResponder` (Mac), or just wait for propagation. NOT a code bug — Stage 2 code cannot break DNS.
8. **New character page 404s for ~30-60s after creation** — the `c/{slug}.html` static file needs one Worker deploy cycle. EXPECTED, not a bug. The data is in D1 instantly; only the new URL waits.
9. **Stale art after updating an image** — art PNGs were set to `Cache-Control: max-age=86400` (24h), so updated art kept showing the old cached copy (incognito worked because empty cache). FIX: changed art images to `no-cache, must-revalidate` in `_headers`. A copy cached under the OLD rule before the fix may persist until it ages out.

### Pre-migration code gotchas (still relevant)
10. **Silent `str.replace()` no-ops** — if the target string has shifted, replace silently does nothing. ALWAYS confirm the target exists in fetched content before replacing; re-fetch and check after.
11. **False-negative verify asserts** — verification `assert`s frequently throw even when the push SUCCEEDED, due to Unicode/escaping/newline mismatches. Don't trust the assert failure; re-fetch and check `'string' in content` instead. (Happened repeatedly this session — every "AssertionError" after a "Pushed!" was a false alarm; the content was correct.)
12. **Always validate `<script>` blocks with `node --check` before pushing** any HTML with JS changes.
13. **GET fresh SHA immediately before any PUT;** never reuse a cached SHA.
14. **charpage.js overwrites `#crumb` at runtime** — editing static crumb HTML in `c/` pages does nothing; the crumb template lives in charpage.js.
15. **Git Trees API for batch commits** (e.g. all 96/97 `c/` pages at once): GET ref → GET commit → POST blobs → POST tree (with base_tree) → POST commit → PATCH ref.
16. **The CRITICAL srcdoc bug (legacy create.html/edit.html preview):** a JS srcdoc preview string contains literal `</body>`, `<script>` etc. — never naively replace those tags; use unique surrounding context.

### Sandbox limits (for the Claude instance)
17. **Cloudflare is unreachable from the sandbox** (`workers.dev` egress blocked). Claude CANNOT deploy, test the Worker, query D1, hit the live API, or verify the live site. All Cloudflare actions go through the user. `api.github.com` IS reachable.
18. The user is on **mobile** mostly (test responsive behaviour) but has **PC for setup**. The Cloudflare mobile app lacks Worker-binding UI; binding/deploy steps need the PC dashboard.

---

## 14. CHARACTER DATA SCHEMA (the JSON object stored in D1 `data` and in the backup JSON files)

Full form-created entry shape:
```json
{
  "slug": "my-character",
  "name": "My Character",
  "team": "townsfolk",
  "ability": "Bold ability line (also JSON ability).",
  "art": "art/my-character.png",
  "page": "c/my-character.html",
  "image": "https://botchomebrew.wiki/assets/art/my-character.png",
  "creator": "DJ_DJ_DJ",
  "lede": "One flavour sentence.",
  "summaryBullets": ["Rule 1.", "Rule 2."],
  "howToRun": ["Para 1. Use [[TOKEN]] for reminder pills.", "Para 2."],
  "callout": "Optional callout box text.",
  "examples": ["Example 1."],
  "tips": ["Tip 1."],
  "bluffing": ["Bluff tip."],
  "fighting": ["Counter-play tip."],
  "quote": "Flavour quote (also JSON flavor).",
  "appearsIn": "Script name",
  "tags": "Information, Setup",
  "translatedBy": "Eliderad",
  "edition": "experimental",
  "firstNight": 0,
  "firstNightReminder": "ST instructions.",
  "otherNight": 10,
  "otherNightReminder": "ST instructions.",
  "reminders": ["Poisoned"],
  "remindersGlobal": [],
  "setup": false,
  "jinxes": [{"name": "Goon", "align": "good", "text": "Jinx rule text."}]
}
```
- `art` is relative to `assets/`; form-created use `art/{slug}.png`.
- `[[TOKEN]]` in howToRun/callout renders as `<span class="tok">TOKEN</span>`.
- Jinx names auto-link to `wiki.bloodontheclocktower.com/{Name_With_Underscores}`.
- Official-schema JSON box derives `id` from name (lowercase, NFD, alphanumeric, ≤50 chars).

---

## 15. ON THE HORIZON / NOT YET DONE

- **Change the admin password** (still the temp `fgwp-6328-pdrb`). No password-change UI yet — small feature to build.
- **Wire collections & scripts editing to D1** — `/api/collection` and `/api/script` endpoints exist; `edit-collection.html` / `script.html` / `create-script.html` / `edit-script.html` aren't repointed yet (still use the GitHub proxy).
- **Full creator accounts** — schema supports it (owner_id everywhere); currently admin-only. Future: registration, per-user ownership, edit-button gating by owner.
- **Turn off GitHub Pages** in repo settings (optional cleanup; Cloudflare serves the site now).
- **Optional future "Option A"** — server-side rendering in the Worker (reads D1 per request, no static `c/` files). Would make new-character URLs instant and improve SEO. Deferred; builds on top of current setup.
- **Keep the backup JSON files fresh** — `characters.json` etc. are now stale snapshots. Consider a periodic export from D1 if a git-readable backup is wanted.

---

## 16. BotC DESIGN PRINCIPLES (for content/character help)
- "Legate philosophy": fuse two source characters so each transforms the other → structural dilemmas, no clean choice.
- Avoid player-disempowering effects (involuntary resource loss, unfun mechanics). Demons must offer upside over a vanilla kill.
- Tag semantics: Single/Multi-Kill = evil-only; Duplication = self-copying; Reverse needs the literal keyword; Ping = Widow/Lunatic-style "one player learns this character is in play"; Consult = private ST visit; Social = affects talk/behaviour; Passive = always-on; Safe needs the literal word "safe"; Information = tells the player anything. Target 3 tags, max 5.
- Informed by Squ4ll's "Anyone Can Cook!" and Taiyi's framework. Key community people: Alex S. (Fall of Rome), Eliderad (translator), Squ4ll, Taiyi.

---

## 17. JULY 2026 FEATURE BATCH (character-pages-cleanup branch)

- **Clean URLs (no .html):** Cloudflare Workers Assets already served `/tags` for `tags.html` and 307-redirected the `.html` form. This batch finished the job: all internal links across every root page + site.js/charpage.js/render.js are now extensionless; the Worker 301-redirects `/c/{slug}.html` → `/c/{slug}`, serves `/script-view` (added to `run_worker_first` so meta injection works on the clean URL), emits clean URLs in the sitemap/canonicals, and strips `.html` from the `page` field when building `/characters.json`. Stored D1 data still says `c/x.html` — only the served JSON is rewritten.
- **assets/tags.js (NEW):** single source of truth for the canonical tag list (`window.KNOWN_TAGS`), per-tag descriptions (`window.TAG_INFO`), a hover-tooltip binder (any element with `data-tag` gets a styled `.tag-tip` hover box), and `window.buildTagPicker()`. tags.html / all-characters.html read `window.KNOWN_TAGS`; create/edit generate their picker buttons from it — adding a tag is now a ONE-file change. New tag added: **You Start Knowing**.
- **Tag casing fix:** title-casing is now hyphen-aware everywhere ("Multi-Kill" no longer splits into a duplicate "Multi-kill" pill with separate counts).
- **Collection JSON:** collection pages (all-characters.html?collection=…) show a collapsible "Collection JSON" box + download button with the full official-schema array of every character in the collection (render.js is now loaded there for buildSchema).
- **Token credit-mark strip:** some characters carry a credit symbol in their NAME (`∇` on Academy characters, `♊︎` on Herbalist — they are in the D1 name field, not the art). token-tool.js `stripCreditMarks()` removes Unicode symbol glyphs from the name in `payloadFor()` only, so tokens are clean but the wiki keeps them.
- **Custom JSON override:** new `customJson` field (create/edit textarea) replaces the auto-generated JSON box content on the character page (pretty-printed if valid JSON, raw otherwise).
- **Alternate art:** create/edit accept a second image, uploaded to R2 as `art/{slug}-alt.png`, stored as `artAlt`/`imageAlt`. It's appended to the schema `image` array and the page emblem becomes click-to-swap (`.emblem.has-alt`, handler in render.js).
- **Mass upload (NEW page `mass-upload.html`):** paste/upload a whole script JSON or master list (official schema); creates a page per character via `/api/character` sequentially, with per-row status, batch creator/appearsIn fields, draft-or-publish choice, art fetched from `image` URLs into R2 when CORS allows (falls back to hot-linking the remote URL — the Worker SSR template + cards now fall back to `d.image` when there is no local `art`). Skips bare string ids (no data to build a page from). Linked from create.html's import box.
