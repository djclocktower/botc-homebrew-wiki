# BOTC Homebrew Wiki — Claude guide

Fan-made wiki for **Blood on the Clocktower** homebrew characters, live at
**https://botchomebrew.wiki**. Owner: djclocktower (Discord `dj_dj_dj`).
He can't code and mostly reviews on mobile via the live site — keep changes
mobile-friendly, explain things plainly, and consult him before big
architecture changes or removing features.

## Architecture in one paragraph

A **Cloudflare Worker** (`worker/worker.js`, config in `wrangler.toml`) serves
everything. Content lives in a **D1 database** (`botc-wiki` — SQLite); login
sessions and rate-limit counters live in **KV** (`SESSIONS`); uploaded images
and nightly backups live in **R2** (`ART` binding, bucket `botc-wiki-art`).
The repo's HTML/CSS/JS are uploaded as static assets on deploy. The Worker
intercepts the routes in `run_worker_first` (wrangler.toml); everything else
falls through to the static files. Deploys happen **automatically when main is
pushed** (Cloudflare Git integration, ~30–60 s). There is no build step and no
framework — plain HTML/CSS/JS everywhere.

Key dynamic behavior:

- `GET /characters.json`, `/collections.json`, `/scripts.json` are **built
  live from D1** (published rows only). The repo copies of these files are
  stale seed backups kept only for `/api/seed` disaster recovery — never edit
  them expecting the site to change.
- `GET /c/{slug}` (characters), `GET /s/{slug}` (scripts) and
  `GET /collection/{id}` (collections) are all **server-side rendered** by the
  Worker from D1. Characters use `assets/render.js`; scripts/collections use
  `assets/render-page.js`. Both are bundled into the Worker via `import` and
  share the `pageShell()` HTML frame. There are **no static per-entity pages**.
  The `.html` form 301-redirects to the clean URL. Legacy `/script-view?s=`
  301-redirects to `/s/{slug}`. **Collection URLs use the kebab `id`**, not the
  PK `slug` (legacy rows have display-string slugs like `"The Academy"`);
  `findCollectionRow()` resolves either.
- `GET /assets/art|collections|scripts|tokens/*` is served **from R2 first**,
  falling back to committed files.
- `/api/*` — auth (signup/login/Discord OAuth/password reset), account
  management, content writes (`/api/character|collection|script|publish|
  delete|upload`), admin tools (dashboard, wiki lock, backup, seed). Writes
  are ownership-checked (`owner_id`, admins bypass). All routes are listed in
  the header comment of `worker/worker.js`.
- `/u/{username}` public profiles, `/random`, `/sitemap.xml`, and
  `/script-view?s=` (OG-meta injection) are also Worker routes.

## Repo map

```
worker/worker.js       The Worker: data endpoints, auth, SSR, uploads, backup cron
wrangler.toml          Worker config: D1/KV/R2 bindings, run_worker_first, cron
_headers               Cache rules for static assets (order matters; later wins)
.assetsignore          Files excluded from asset upload — CRITICAL, see Gotchas
assets/
  styles.css           ALL shared CSS (no per-page stylesheets)
  site.js              Shared topbar behavior: search dropdown, mobile nav,
                       script-count badge, Token Tool + Account link injection.
                       Every page with a topbar loads this — never inline-copy it.
  render.js            Shared character renderer + official-schema JSON builder.
                       Used by create/edit previews AND imported by the Worker
                       for SSR — must stay browser+module compatible, no DOM at
                       top level.
  charpage.js          /c/ page enhancements (edit button, add-to-script/token)
  tags.js              Canonical tag list + descriptions + hover tooltips +
                       tag-picker builder. Adding a tag = edit ONLY this file.
  render-page.js       Shared script+collection page renderer (synopsis, gameplay,
                       roster, jinxes, night order, credits, infobox, JSON export,
                       theming). Browser+Worker like render.js; init(Render) injects
                       render.js's exports. resolveCollectionMembers() (hybrid
                       match[]/include[]/exclude[]), sanitizeTheme(), FONT_PRESETS.
  sao.js               SAO sort (single source of truth): SAO_PREFIXES, saoCompare,
                       sortRosterSAO(). Used by script.html, publish-script.html,
                       steven-approved-order.html, and safe in the Worker.
  pageview.js          Client enhancements for /s/ and /collection/ SSR pages
                       (edit button, JSON download).
  theme-editor.js      Shared theme-kit form controls (font + color pickers) for
                       publish-script.html and publish-collection.html.
  icons/               Official BotC role icons (never change; long-cached)
  art/, collections/, scripts/  Committed images (new uploads go to R2)
  fonts/, pyodide/, tokens/     Fonts; Token Tool engine (Pyodide) + assets
index.html             Homepage (collections grid, scripts, browse cards, sidebar)
all-characters.html    Browse/filter (3-state team+tag chips; ?collection= view)
team/tag/tags/creators/author/authors.html   Browse pages
create.html, edit.html Character editor (POSTs to /api/character; R2 uploads)
script.html            Script Builder — roster only (localStorage botc_script;
                       randomize/SAO sort/export/copy/share/import/clear). Naming
                       + publishing live on publish-script.html; links there.
publish-script.html    Script publishing page: name/author/tagline/version/
                       difficulty/description + wiki sections (synopsis, gameplay,
                       strategy) + theme kit (logo/background/font/colors), header,
                       SAO sort (localStorage botc_script_meta). Publish + Save as
                       Draft (/api/script status=draft|published), ?s={slug} edit.
publish-collection.html Collection maker/editor (replaces register-/edit-collection,
                       now redirect stubs). Same fields as publish-script + hybrid
                       membership manager (match terms + manual include/exclude).
                       Publish/Draft via /api/collection; ?c={id} edit mode.
scripts.html, script-view.html (legacy; /s/ is SSR now), create-script.html (→script), edit-script.html (→publish-script)
tokens.html            Token Tool (Pyodide in a Web Worker; token-tool.js,
                       token-worker.js, assets/tokens/manifest.json versioning)
mass-upload.html       Bulk import from official-schema JSON
login.html, account.html, dashboard.html, profile.html, reset-password.html
character.html         Legacy ?c=slug redirect → /c/{slug} (keep; old links)
characters/*.html      3 legacy redirect stubs → /c/{slug} (keep; old links)
migration/             D1 schema reference (schema.sql, accounts_migration.sql,
                       schema_explanation.md, ACCOUNTS_SETUP.md)
```

## Database (D1, SQLite)

Tables: `users`, `characters`, `collections`, `scripts`, `settings`,
`activity_log`. Content tables use the **hybrid JSON blob** design: a few
indexed columns (slug PK, name, team, creator, owner_id, tags, appears_in,
status) plus the **full object as JSON in `data`**. New character fields never
need a migration — just put them in the JSON; render.js decides what shows.
`status` is `published` or `draft`; public JSON and SSR only expose published
rows (drafts visible to owner/admin). Character data schema: see the sample
object in `migration/schema_explanation.md` or any `/characters.json` entry.

Scripts and collections carry rich page fields in their `data` JSON (all
optional, no migration): `tagline, version, difficulty, synopsis, gameplay,
strategyGood, strategyEvil, logo, theme{}`. Collections also have hybrid
membership — `match[]` (auto, normalized `appearsIn`) plus manual `include[]` /
`exclude[]` slug lists (see `resolveCollectionMembers` in render-page.js). Every
one of these is length-capped and theme-validated server-side in
`sanitizePageFields()` (worker.js). `theme` is `{font, accent, panel, text,
link, background}` — colors must be `#rrggbb`, font a `FONT_PRESETS` key,
background only the entity's own `{scripts|collections}/{key}-bg.{ext}` slot;
`sanitizeTheme()` drops anything else and it's applied as CSS custom properties
on `<body>` (never raw CSS). Seeded collections have `owner_id NULL` — admins
assign an owner via the dashboard (`/api/admin/assign-owner`) so a user can edit.

## Frontend conventions

- Pages fetch `characters.json` etc. and render client-side; `/c/` pages are
  the exception (SSR). Keep `esc()`-style HTML escaping for any user data.
- Clean URLs everywhere: internal links have no `.html` (Workers assets serve
  `/tags` for `tags.html` and redirect the `.html` form).
- Shared topbar markup is copied per page (no template system). If you change
  it, change it on **all** pages — use `scripts.html` as the canonical
  example. Behavior belongs in `site.js`, not inline.
- Teams: `townsfolk, outsider, minion, demon, traveller, fabled` (+ `loric`
  label). `[[TOKEN]]` in howToRun/callout text renders as a reminder pill.
- SAO sort lives in `assets/sao.js` (`SAO_PREFIXES` / `sortRosterSAO`), the
  single source of truth used by script.html, publish-script.html, and rendered
  into steven-approved-order.html. More-specific prefixes ("Each night*") must
  come before less-specific ("Each night") in the array — do not reorder.
- Grid/list `<img>` tags get `loading="lazy" decoding="async"`.

## Caching

- `_headers`: HTML/CSS/JS/art revalidate on every load (edits show on normal
  refresh); icons, fonts, pyodide, token assets are immutable long-cache.
  Later rules override earlier ones — keep the generic rules at the top.
- Worker responses: JSON endpoints and SSR pages send `no-store`; R2 images
  send `no-cache, must-revalidate` (+ ETag) so replaced art shows immediately.

## Verifying changes (no local server needed)

- `node --check` every `.js` file you touch, and extract+check inline
  `<script>` blocks after editing HTML.
- The Cloudflare dashboard, live site, and D1 are **not reachable from the
  sandbox** in some sessions — if `botchomebrew.wiki` is unreachable, ask the
  user to verify on the live site after deploy instead of guessing.
- D1 is SQLite, so local `sqlite3` is an accurate way to sanity-check SQL.

## Gotchas (hard-won — do not repeat)

1. **`.assetsignore` must keep excluding `.git`, `worker/`, `wrangler.toml`,
   `migration/`, docs.** Cloudflare uploads everything else as assets; a
   >25 MiB file (e.g. the git pack) fails the whole deploy.
2. **Don't scope `.home-panel` inside `.home-layout`** in styles.css — every
   list page uses the bare `.home-panel { max-width; margin auto }` rule.
3. **`run_worker_first` in wrangler.toml is the routing contract.** A new
   Worker route does nothing until its path pattern is added there.
4. **render.js runs in the Worker too** — no `document`/`window` access at
   module top level outside the existing `typeof` guards.
5. New-character URLs are live instantly (SSR), but changes to repo files
   (CSS/JS/HTML) need a deploy cycle after push (~30–60 s).
6. `/api/seed` refuses to run when the characters table is non-empty; it
   reads the repo's stale JSON backups. Nightly cron also dumps every table
   to R2 `backups/{date}/` (30-day retention) — that's the real backup.
7. Some character names carry credit marks (`∇`, `♊︎`) in the D1 name field;
   token-tool.js strips them for tokens only. Don't "fix" the names.
8. Jinx icons resolve by slugified id against `assets/icons/`; missing icons
   hide gracefully via onerror. Don't rename icon files.
