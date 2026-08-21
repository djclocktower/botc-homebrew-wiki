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
  live from D1** (published rows only). Adding **`?drafts=1`** includes draft
  rows and stamps each row's `status` — but **only for a logged-in admin**;
  anyone else asking for it silently gets the normal published-only feed, so
  the site never reveals that unpublished pages exist. The repo copies of these files are
  stale seed backups kept only for `/api/seed` disaster recovery — never edit
  them expecting the site to change.
- `GET /c/{set}/{character}` (characters — nested, see "Character identity vs
  address"; `/c/{identity}` 301s to it), `GET /s/{slug}` (scripts) and
  `GET /collection/{id}` (collections) are all **server-side rendered** by the
  Worker from D1. Characters use `assets/render.js`; scripts/collections use
  `assets/render-page.js`. Both are bundled into the Worker via `import` and
  share the `pageShell()` HTML frame. There are **no static per-entity pages**.
  The `.html` form 301-redirects to the clean URL. Legacy `/script-view?s=`
  301-redirects to `/s/{slug}`. **Collection URLs use the kebab `id`**, not the
  PK `slug` (legacy rows have display-string slugs like `"The Academy"`);
  `findCollectionRow()` resolves either. Script and collection pages carry an
  **Edit button in the page itself** (`ownerBar()` in render-page.js) as well
  as the pencil in the top bar, but only for a reader who may actually edit
  it: the Worker passes `editHref` in when `canEditRow()` says yes and an
  empty one otherwise, which is safe because SSR responses are `no-store`.
  The pencil stays unconditional (the API is the enforcer); this one sits in
  the page, where a reader would take it as an invitation.
- `GET /news/{slug}` is **server-side rendered** too (`assets/render-news.js`,
  same `pageShell()`); `/news` itself is the static `news.html` index. News
  articles are admin-written and live in their own `news` table.
- `GET /p/{slug}` is a **custom wiki page** — a text-first page (rules, lore,
  a glossary, a storyteller guide) belonging to exactly one script or
  collection. SSR from the `pages` table via `assets/render-wiki.js`, same
  `pageShell()`. These are **deliberately unlisted**: `noindex`, no sitemap
  entry, no search, no browse list, no homepage strip. The only two links in
  are the "Pages" section on the parent script/collection page and the
  author's `/author?a=` + `/u/{username}` pages. Only the parent page's owner
  (or an admin) can create one; the page is then owned by whoever wrote it.
- `GET /assets/art|collections|scripts|tokens|pages|news|avatars/*` is served
  **from R2
  first**, falling back to committed files (`avatars/` is R2-only: profile
  pictures, uploaded via `/api/account/avatar`, never via `/api/upload`).
- `/api/*` — auth (signup/login/Discord OAuth/password reset), account
  management, content writes (`/api/character|collection|script|publish|
  delete|upload`), direct messages (`/api/messages*` — user↔user DMs backing
  the `/messages` page), **comments** (`/api/comments*` — the comment section on
  every character/script/collection/news/wiki page), **wiki pages**
  (`/api/wiki-page`, `/api/wiki-pages`), **news** (`/api/news*`,
  `/api/admin/news`), **jinxes** (`GET /api/jinxes` for the whole edge list,
  `POST /api/jinx` to add/edit/remove one), admin tools
  (dashboard, full activity log, report, revisions/rollback, comment
  moderation, Curata, wiki lock, backup, seed), plus the public page
  history (`/api/page-history`, `/api/page-revision`), owner rollback
  (`/api/page-rollback`) and suggested edits (`/api/suggest`,
  `/api/suggestions`, `/api/suggestion`); see "Public editing" below.
  Writes are ownership-checked (`owner_id`, admins bypass). All routes are
  listed in the header comment of `worker/worker.js`.
  **`POST /api/report-broken-link` is the one write that does not need a
  login**: it is the 404 page's report box, and the person following a dead
  link off Discord is the least likely of anyone to have an account. It writes
  a `messages` row like `/api/contact` (same dashboard inbox) with
  `user_id NULL`, which the inbox already renders as unrepliable; the form asks
  for a handle or an email in the body instead. Rate-limited per IP.
  A character's **identity** and its R2 art slot are both derived from its
  name, so both editors **and the mass uploader** ask `GET /api/slug-check`
  before uploading anything and take the first free one automatically, in the
  wiki's existing duplicate style (`illusionist-megalomania`, `witcher-odyssey`,
  then `-2`, `-3`). That identity is **not** the URL — see "Character identity
  vs address" below; the reader-facing address is `/c/{set}/{character}` and
  the Worker derives it on save. An identity only *parked* by a redirect counts
  as taken. The Worker is still the enforcer — the check only decides which
  slug the editor asks for.
  `mass-upload.html` additionally tracks the slugs **its own run** has just
  taken, so two characters with the same name in one file get two pages
  instead of the second overwriting the first.
  **Scripts and collections work the same way** (`publish-script.html`,
  `publish-collection.html`), with one difference: a page being *created*
  never lands on an existing URL, **not even one of your own**. There is no
  rename for these two — the URL is fixed once created and an edit carries
  `EDIT_SLUG`/`EDIT_KEY` — so a name that matches a page you already have
  means a second page, never a silent overwrite of the first (grimforge's
  "+ Add to Drafts" is strict for the same reason). The save says so when it
  happens. For **collections the key is the kebab `id`, not the PK slug**, so
  `/api/slug-check` resolves them through `findCollectionRow()` and counts
  both ids and PK slugs as taken — matching how `/api/collection` resolves a
  write. Checking only the PK would call a legacy id free and the save would
  then refuse it.
- **Creator pages are one page on two keys.** `/u/{username}` (an account) and
  `/author?a={name}` (the free-text `creator` field) both serve `profile.html`,
  which asks `GET /api/user?u=` or `?a=`. A name that belongs to an account
  302-redirects from `/author?a=` to `/u/{username}`; a name with no account
  renders in place, because half the wiki was bulk-imported under names that
  never had a login. See "Creator identity" below.
- `/random`, `/sitemap.xml`, and `/script-view?s=` (OG-meta injection) are also
  Worker routes.

## Repo map

```
worker/worker.js       The Worker: data endpoints, auth, SSR, uploads, backup cron
wrangler.toml          Worker config: D1/KV/R2 bindings, run_worker_first, cron
_headers               Cache rules for static assets (order matters; later wins)
.assetsignore          Files excluded from asset upload — CRITICAL, see Gotchas
assets/
  styles.css           ALL shared CSS (no per-page stylesheets)
  site.js              Shared topbar behavior: search dropdown, mobile nav,
                       script-count badge, Tools + Create + Account link injection.
                       Every page with a topbar loads this — never inline-copy it.
                       The nav entry is "Tools" (→ /tools), NOT "Token Tool":
                       change it here and every page's top bar and hamburger
                       follow, because no page hardcodes it.
  render.js            Shared character renderer + official-schema JSON builder.
                       Used by create/edit previews AND imported by the Worker
                       for SSR, so it must stay browser+module compatible with
                       no DOM at top level. Takes the wiki text engine through
                       init(WikiRender) for the two formatted character fields,
                       `pronunciation` (the quiet line under the flavour quote)
                       and jinx rule text; without it both still render, escaped
                       and unformatted.
                       Also owns buildCreditsFabled() — the botchomebrew.wiki
                       credits Fabled the Script Builder appends to its exports
                       (see script.html below).
  official-jinxes.json Jinxes between two OFFICIAL characters, for the opt-in
                       base-game layer on /jinxes. Generated, partial, with a
                       `source` field inside; same treatment as night-order.json.
  jinx-picker.js       The "Jinxed character" search box: one combobox over the
                       official roster AND this wiki's, mounted on a field with
                       mountJinxPicker(). Records WHICH character was picked
                       (`slug` for one of ours, `id` for an official one) so the
                       jinx no longer depends on the typed name matching later.
                       Shaped like night-order-picker.js on purpose. Used by
                       create.html, edit.html and /jinxes.
  jinx-graph.js        The relationship map on /jinxes: hand-rolled SVG plus a
                       small spring layout, no library and no CDN. Positions are
                       seeded from a hash of the node id so the map looks the
                       same every visit, and the simulation runs a fixed number
                       of ticks and STOPS rather than animating forever. Read the
                       header before touching the physics: REPEL_CAP, the
                       DRAG_SLOP threshold and MIN_ICON_PX all exist because of
                       specific bugs. NODE_GAP/LINK_REST set how far apart the
                       icons sit; MIN_ICON_PX stops the opening view zooming out
                       past legibility (fitting 172 nodes to a phone gives 8px
                       icons), so the map may overflow and pan; "Fit all" is
                       the deliberate way to see the whole shape. Every node
                       keeps its computed homeX/homeY so resetLayout() can undo
                       dragging without re-running the simulation. Link mode
                       (setLinkMode + onPair) reuses the ordinary click to pick
                       two characters. A long press or two-finger gesture would
                       be both harder to find and easier to hit by accident.
  charpage.js          /c/ page enhancements (edit button, add-to-script/token)
  tags.js              Canonical tag list + descriptions + hover tooltips +
                       tag-picker builder. Adding a tag = edit ONLY this file.
  render-page.js       Shared script+collection page renderer (synopsis, gameplay,
                       roster, jinxes, night order, credits, infobox, JSON export,
                       theming). Browser+Worker like render.js; init(Render) injects
                       render.js's exports. resolveCollectionMembers() (hybrid
                       match[]/include[]/exclude[]), sortCollectionMembers()
                       (the roster order — team first, then the author's
                       `order[]`, then name; the single source of truth, used by
                       the page AND by publish-collection.html so the editor's
                       list IS the page's list), sanitizeTheme(), FONT_PRESETS.
                       Also renderRosterCards() + filterBoxHTML(), reused by the
                       creator page so its cards match a collection page's.
  card-filters.js      The collapsed filter box (3-state team/tag chips, Show
                       Partial, Curata only, creator, sort). Sort offers Page
                       order / A–Z / Z–A / Recently added / Steven Approved
                       Order; SAO needs sao.js loaded first or the option is not
                       built, and it reads the ability off the card rather than
                       a repeated data-* attribute. mountCardFilters()
                       wires one box to one grid; auto-mounts on SSR collection
                       pages with defaultSort:'page' so the author's arranged
                       order is what a reader sees first, and profile.html
                       mounts its own (no page order there — the creator feed is
                       newest-first, so it stays on A–Z). Reads the card
                       data-* attributes renderRosterCards() writes — one filter
                       implementation, not one per page. The Script Builder's
                       Add sidebar mounts it too, over its own compact rows
                       rather than cards: sectionSel/innerSel/cardSel/
                       sectionCountSel/abilitySel name the markup, `search`
                       hands it the name box so the chips and the text box
                       narrow one list instead of fighting, and `partialOn`
                       leaves Partial characters visible (hiding one there
                       would put it out of reach of the script you are
                       building).
  jinx-editor.js       One script's jinxes: switch off one the characters
                       carry, or write one only this script has. Stores
                       `jinxEdits{off[],add[]}` and resolves through
                       PageRender.scriptJinxes, which the page and the export
                       also go through. Mounted by script.html and
                       publish-script.html.
  night-order-editor.js  The two night lists, arranged by hand: drag a row
                       (pointer events, so mouse and touch are one path) or use
                       ▲▼. Mounted by script.html AND publish-script.html over
                       PageRender.nightItems, so both write the same
                       `nightOrder` and neither can disagree with the page. The
                       dragged row leaves the flow (position:fixed) and a
                       placeholder holds its slot; lifting it but leaving it
                       IN the flow re-shifts the rows under the pointer on
                       every insert and walks the wrong character to the
                       bottom. On a phone the drag starts from the grip so the
                       list can still be scrolled with a finger.
  classify.js          Partial / Standard / Curata rules — SINGLE SOURCE OF
                       TRUTH. hasIcon/hasAlmanac/isPartial/classifyPage, the
                       badge builder, and the Curata weighting used by
                       Featured, /random and the homepage strips. Browser+Worker.
  comments.js          Comment section widget for /c/, /s/, /collection/, /news/
                       and /p/ (reads window.PAGE_TYPE + PAGE_SLUG), incl. the
                       one-time "be respectful" agreement modal and the
                       "new since you last looked" dot (per page, per browser,
                       localStorage botc_cmt_seen; nothing is new on a first
                       visit, your own comments never are, and the mark
                       advances once the section has been on screen).
  render-wiki.js       THE TEXT ENGINE — single source of truth for the wiki
                       markup subset (headings, lists, tables, quotes, rules,
                       images, ::: callouts, [toc], **bold**, *italic*, `code`,
                       ~~strike~~, [label](url), [[Character Name]]) plus the
                       /p/ page layout, the contents box, custom boxes and the
                       fact box. Escapes first, whitelists hrefs and image
                       paths — nothing a writer types can become raw HTML.
                       safeHref() takes http(s), mailto, site-relative AND a
                       bare domain ('example.com' -> https), because writers
                       type those constantly and used to get a link to a wiki
                       page that does not exist. The domain test is narrow on
                       purpose: dotted labels ending in a letters-only suffix
                       that is not a file extension, so 'scripts', 'c/slug'
                       and a stray 'page.html' all stay site-relative.
                       Browser + Worker. Used by /p/, news, custom boxes and
                       (through render-news) the announcement banner.
  render-news.js       News article shape (head, hero, cards) around
                       render-wiki.js; re-exports inlineFormat() because
                       site.js lazy-loads it for links in announcements.
                       In the Worker it gets the engine through init().
  editor-notices.js    Post-save modals for create/edit: "this page is Partial"
                       and "saved as a draft because there's no icon".
  char-preview.js      The live preview iframe on create.html + edit.html.
                       Written ONCE and then patched in place (only <main>'s
                       contents are replaced): assigning `srcdoc` per keystroke
                       reloads the frame, which flashed the frame's dark
                       background black on every edit and threw away the
                       preview's scroll position. The in-frame script keeps the
                       JSON box, the jinx dropdown and the title fit working;
                       __cpFit() is re-run after each repaint. Browser only.
  art-normalize.js     The "Resize icon" button: trims the transparent margin
                       to find the figure and scales it to 70% of the 591×591
                       frame. artTrimBox() (the trim on its own) is exported
                       for art-adjust.js. Browser only (canvas).
  art-adjust.js        "Adjust by hand": the same frame with the art in your
                       hands. Drag to move (pointer events, so mouse and touch
                       are one path), a slider or a pinch for how much of the
                       token the figure fills, a rotate slider, Start over.
                       Opens on the automatic answer, so every change is a
                       nudge from what Resize would have given you. Both
                       editors pass it the file AS PICKED, not the 600px
                       working copy, so zooming in stays sharp and a second
                       visit re-places the original instead of resizing an
                       already-resized icon. ArtAdjust.open(src) resolves with
                       a 591×591 PNG or null (cancelled), and rejects only
                       when the canvas can't be read back: art hosted on
                       another site taints it, and the editors say so.
                       Styles are .aa-* in styles.css; this file is DOM only.
  redesign-create.css/.js  The shared layout of the two character editors
                       (create.html + edit.html). The JS groups the flat field
                       run into Basics / The Page / Tags sections, folds credits,
                       alt art, jinxes, sidebar boxes and custom JSON into an
                       "Advanced Options" panel, and puts the save buttons in a
                       sticky bar; the CSS is scoped to html.create-redesign,
                       which the JS adds only after it has actually restructured
                       the form, so a failed load leaves the plain form behind.
                       Both editors are the same form — change one, change both.
  night-order-picker.js  The "I want the X to act directly after…" search on the
                       wake-priority fields. Picking an official character fills
                       the field with that character's night position plus a
                       random four-digit fraction (Poisoner is 33 → 33.5691), so
                       homebrew pages that chose the same anchor still sort
                       apart. Reads assets/night-order.json; pages that fill the
                       fields after load call window.refreshNightOrderPickers().
  night-order.json     Official night-order positions, only characters that wake.
                       Generated from GrayPockets/Released-as-Homebrew (the
                       `source` field inside the file says where); roles.json has
                       no night order, which is why this is separate. Read by
                       night-order-picker.js AND official-roles.js.
  official-roles.js    roles.json + night-order.json -> wiki character objects
                       for the official roster ('off-{id}' slugs). The one
                       conversion, shared by the Worker (SSR /s/ pages),
                       script.html and publish-script.html. It used to be
                       copied per caller, and every copy left firstNight and
                       otherNight at 0 because roles.json has no positions, so
                       official characters were silently absent from a script
                       page's Night Order box. Also cleans `:reminder:` (a
                       token-placement marker with nothing to place in a list)
                       out of the official night reminders. Browser + Worker;
                       the two JSON files are handed in, never fetched here.
  special-editor.js    The `special[]` repeater on create.html + edit.html — the
                       official schema's per-character behaviour flags ("cannot
                       go in the bag", "show the Storyteller the grimoire"), of
                       which `setup` was long the only one the wiki understood.
                       Anything else was dropped on import and therefore missing
                       from the wiki's own JSON export. Now carried through by
                       mass-upload.html, create.html's JSON autofill and both
                       editors, and validated + exported by render.js
                       (`sanitizeSpecial`, the owner of the shape — the widget
                       only collects). The name box is a datalist, never a
                       closed list: the official vocabulary grows, and a name
                       this repo has never seen still belongs to the character.
                       It is a plain <fieldset>, which is all redesign-create.js
                       needs to file it under Advanced Options.
  sao.js               SAO sort (single source of truth): SAO_PREFIXES, saoCompare,
                       sortRosterSAO(). Used by script.html, publish-script.html,
                       steven-approved-order.html, and safe in the Worker.
  pageview.js          Client enhancements for /s/ and /collection/ SSR pages
                       (edit button, JSON download).
  theme-editor.js      Shared theme-kit form controls (font + color pickers) for
                       publish-script/-collection/-page/-news.html.
  wiki-editor.js       Shared editor widgets: the formatting toolbar, the
                       {title, content} custom-box repeater, the fact-box row
                       repeater, grow-with-content textareas, the image picker
                       and loadCharLinks() (feeds [[Name]] links to previews).
  wikipage.js          Client enhancements for /p/ pages (edit button, offset
                       anchor scrolling from the contents box).
  grimforge.js         Grimoire Forge ruleset + linter (the ability syntax
                       checker behind /grimforge). lint() returns span-anchored
                       `issues` and whole-text `notices`; normalise() tidies the
                       suggested output. Rules carry sev fix|warn|off — only
                       `fix` rules are ever applied in bulk. Pure strings, no
                       DOM: `node --check`-able and Worker-safe.
  system-text.js       The prose the WORKER prints into pages (the Partial
                       banner, the draft bars). It lives in assets/ because the
                       text editor builds its list by fetching the site's own
                       files in the browser, and worker.js is not one of them
                       (.assetsignore). New server-rendered wording goes here,
                       not inline in worker.js, or it cannot be edited.
                       {placeholder} marks a slot the site fills in.
  text-live.js         Live text editing: browse the wiki and double-click any
                       of its own wording to rewrite it in place. Lazy-loaded
                       by site.js ONLY when localStorage botc_text_edit=1 and
                       /api/me says admin. Its guard is the catalogue —
                       text nothing in the site's files produced is never
                       offered — plus a rule that a short string is only
                       editable when it IS the text you clicked ("Each night"
                       is a sort rule in sao.js *and* the opening of half the
                       abilities on the wiki). Styles live in styles.css under
                       html.textedit-on.
  text-scan.js         The scanner behind /text-editor: fetches every static
                       page and assets/*.js, pulls the human-readable strings
                       out (a small JS lexer, not a regex — comments,
                       apostrophes and regex literals would fool one), and
                       merges identical text into one entry. Browser only
                       (DOMParser). SEED_PAGES/SEED_ASSETS are the known
                       files; anything newer is found by crawling <a href>
                       and <script src>.
  iconforge/           Icon Forge (/iconforge) — the whole tool, as ES modules.
                       engine.js is the handoff's iconEngine.ts with the types
                       stripped; app.js is the wiki's own UI controller (the
                       React app's Home/ControlPanel/PreviewStage rebuilt in
                       vanilla JS); editor.js frames the vendored miniPaint;
                       textures.js, source.js, bgremoval.js are the small libs.
                       Subfolders textures/ minipaint/ vendor/ are the
                       sealed payload — see the section below, and
                       migration/icon-forge-guide.md for the engine reference.
  icons/               Official BotC role icons (never change; long-cached)
  art/, collections/, scripts/  Committed images (new uploads go to R2)
  fonts/, pyodide/, tokens/     Fonts (Dumbledor2, Trade Gothic, OptimusPrinceps,
                       LHF Unlovable); Token Tool engine (Pyodide) + assets
index.html             Homepage (collections grid, scripts, browse cards, sidebar).
                       Featured Character rotates **Curata pages only**,
                       seeded by the day number so it is stable for 24 h.
                       Browse cards include Grimoire Forge and Icon Forge; the old Creator Icons
                       pill wall was removed (it lives on /creators, linked from
                       the "By Creator" card and /tools).
all-characters.html    Browse/filter (3-state team+tag chips; ?collection= view)
team/tag/tags.html     Browse pages
creators.html          The one creator index: every name that has published
                       something, with its symbol, account (if any) and counts,
                       from /api/creators. authors.html is a redirect stub to it.
create.html, edit.html Character editor (POSTs to /api/character; R2 uploads)
script.html            Script Builder — roster only (localStorage botc_script;
                       randomize/SAO sort/export/copy/share/import/clear). Naming
                       + publishing live on publish-script.html; links there.
                       The Add sidebar holds the official roster as well as the
                       homebrew one, told apart by a Source chip pair;
                       Randomize stays homebrew-only on purpose (180 official
                       characters would swamp the pool). Export goes through
                       PageRender.buildPageExport, the same call the published
                       page's JSON box makes, so the two cannot drift.
                       The Add sidebar carries the shared filter box (team/tag
                       chips, creator, sort) over the name search, so it is
                       built ONCE and filtered in place, so adding a character
                       only repaints the ticks, because re-rendering the list
                       would throw away whatever the reader filtered to. A
                       Night Order panel sits under the roster, the same
                       widget publish-script.html uses.
                       Jinx and Night Order panels sit under the roster
                       (shared widgets; see "Jinxes" and "Night order").
                       Every export/copy from HERE gets one extra entry, and
                       nowhere else does: the **botchomebrew.wiki credits
                       Fabled** (the site's pirate skull, id
                       `botchomebrewwiki`), whose ability reads "This script was
                       made on botchomebrew.wiki and contains characters by: …".
                       The "Detailed credits" tick (localStorage
                       botc_script_credits_detail) swaps the plain name list for
                       one naming each creator's characters; the page shows the
                       exact line above the publish CTA. buildCreditsFabled() in
                       render.js builds the object and buildPageExport takes it
                       as `opts.credits`, which ONLY this page passes — a
                       published /s/ or /collection/ JSON box is the author's own
                       script and must never carry the wiki's signature. The
                       builder's Import, mass-upload.html and the Token Tool all
                       skip the id, so a round-trip neither reports it missing,
                       nor turns it into a character page, nor prints a token
                       for it.
publish-script.html    Script publishing page: name/author/tagline/version/
                       difficulty/description + wiki sections (synopsis, gameplay,
                       strategy) + theme kit (logo/background/font/colors), header,
                       SAO sort (localStorage botc_script_meta). The roster
                       summary lists every character with ▲▼ to arrange it by
                       hand; that order IS characters[], which the script page
                       already renders in. Moves are within a team only (the
                       page draws one section per team) and roster slugs this
                       wiki has no character for are carried along untouched,
                       never dropped. A Night Order panel arranges the two
                       night lists the same way (see "Night order" below).
                       Publish + Save as
                       Draft (/api/script status=draft|published), ?s={slug} edit.
publish-collection.html Collection maker/editor (replaces register-/edit-collection,
                       now redirect stubs). Same fields as publish-script + hybrid
                       membership manager (match terms + manual include/exclude)
                       plus roster arranging: ▲▼ per character, a Sort (SAO)
                       button and Reset order, saved as `order[]`.
                       Publish/Draft via /api/collection; ?c={id} edit mode.
publish-page.html      Custom wiki page editor (/p/): title/subtitle/blurb/author,
                       markdown-ish body with toolbar + live preview, banner and
                       body images (R2 pages/), fact box, custom boxes, theme kit,
                       contents + comments toggles. ?p={slug} edits,
                       ?parentType=&parentSlug= starts a new one.
jinxes.html            /jinxes: every jinx on the wiki, as a grouped list and an
                       interactive map, both built from GET /api/jinxes so they
                       cannot disagree. Creators can add a jinx to a character
                       they own (POST /api/jinx). Linked from tools.html and the
                       homepage browse cards; in the sitemap's staticPages.
news.html              /news index (client-rendered from /api/news)
publish-news.html      Admin-only news editor: the same kit as publish-page
                       (toolbar, images, boxes, fact box, theme) plus
                       summary/hero/pin, and preview/publish/delete
scripts.html, script-view.html (legacy; /s/ is SSR now), create-script.html (→script), edit-script.html (→publish-script)
tools.html             /tools — the toolbox hub: Script Builder, Token Tool,
                       Grimoire Forge, Icon Forge, Jinxes, Creator Icons. This
                       is what the "Tools" nav entry points at.
grimforge.html         Grimoire Forge (/grimforge) — ability syntax checker.
                       Tool by Ma'ayan, rebuilt in vanilla JS on the wiki's
                       parchment styling (the original was React + Tailwind via
                       CDN — do not reintroduce a framework here). Engine lives
                       in assets/grimforge.js; the page owns only the UI.
                       ?a={text} pre-fills the box — create.html/edit.html use
                       it for their "Check with Grimforge" link. The editor is
                       one box: a transparent textarea over a backdrop that
                       paints the issue marks, behind a "Highlight issues"
                       toggle that is OFF by default (a plain editor until
                       asked). Both layers must keep identical font/padding/
                       wrapping metrics or the marks drift off the text. A name
                       field with a Check Name button looks the name up in
                       characters.json against the picked type (same-type
                       clash first, other types listed after) and against the
                       official roster (red warning — reusing an official name
                       is a mistake), and
                       "+ Add to Drafts" POSTs name + ability to /api/character
                       as status=draft, using the picked type. A counter
                       panel (characters/words/sentences/lines + Count Spaces)
                       sits above the input; the length badge always judges the
                       real with-spaces length, whatever the box displays. Rule
                       toggles, the draft text and the Count Spaces choice
                       persist in localStorage (botc_grimforge_*).
iconforge.html         Icon Forge (/iconforge) — turns line art, a scan or a
                       photo into an official-style character icon. Same
                       treatment as Grimoire Forge: the handoff shipped a React
                       + Tailwind + shadcn app, and it was rebuilt in vanilla JS
                       on the wiki's parchment/purple styling — do not
                       reintroduce a framework. The page owns the UI and its
                       page-local CSS; everything else is in assets/iconforge/.
                       See "Icon Forge" below.
tokens.html            Token Tool (Pyodide in a Web Worker; token-tool.js,
                       token-worker.js, assets/tokens/manifest.json versioning)
mass-upload.html       Bulk import from official-schema JSON
login.html, account.html, dashboard.html, reset-password.html
                       account.html shows the newest 10 of Your Recent Edits
                       behind a "Show all N edits" toggle; a busy month used
                       to put fifty lines between the top of the page and the
                       settings below it.
text-editor.html       /text-editor — admin-only. Every string the SITE writes
                       about itself, in one searchable list: filter to the em
                       dashes / curly quotes / any character you type, sort by
                       page or by length, rewrite any of it. See "System text"
                       below. Linked from a dashboard card; not in any nav.
suggestions.html       /suggestions?type=&slug=: one page's suggested edits,
                       with the owner's Approve/Decline; /suggestions with no
                       page is the owner's inbox of everything waiting.
history.html           /history?type=&slug=: one page's edit log, who changed
                       what and when, with the owner's rollback. Public for a
                       published page (drafts have no history at all).
drafts.html            /drafts — your own unpublished pages as cards (the same
                       renderRosterCards markup the browse and collection pages
                       use, with the shared filter box). Characters come from
                       /api/account, enriched from characters.json?drafts=1 when
                       the reader is an admin; scripts/collections/wiki pages
                       have no card art so they get a plain tile. Linked from
                       the Your Drafts panel on the account page, which keeps
                       its own table — the two are deliberately both there.
404.html               The custom Not Found page. Nothing links to it: the
                       Worker serves it AT the address that failed (no
                       redirect) with a 404 status, via assetsOrNotFound(),
                       which every "page does not exist" branch now returns.
                       so all its paths must be root-absolute or they resolve
                       against /c/whatever. Shows the broken address, a
                       "Did you mean…" list (edit distance against the JSON
                       feed the address implies; /c/, /s/ and /collection/
                       only, so a missing favicon costs no fetch) and a report
                       box posting to /api/report-broken-link. Only HTML
                       Only HTML requests get it; images and JSON keep the bare 404.
                       The design is a character token on the page background
                       ("NOT IN THE BAG" curved along its bottom rim, which is
                       an SVG textPath; sweep-flag 0 is what keeps the words
                       upright).
profile.html           The creator page, served at BOTH /u/{username} and
                       /author?a={name} (there is no author.html any more).
                       Hero + pinned strip + characters (shared filter bar) +
                       scripts + collections + a drafts section for the owner
                       and admins, plus an admin box for linking a creator name
                       to an account. Every section heading is a collapse
                       toggle carrying its own count — a creator with 300+
                       characters put Scripts a very long scroll away. All
                       start open; what you collapse is remembered per browser
                       in localStorage botc_prof_sections.
messages.html         Direct messages (/messages): conversation list + thread UI
                      over /api/messages*; ?to={username} opens/starts a thread.
                      Message buttons live on /u/ profiles + dashboard user rows;
                      site.js adds an unread-mail icon to the "My Account" nav
                      link (no standalone Messages tab — owner's preference).
character.html         Legacy ?c=slug redirect → /c/{slug} (keep; old links)
characters/*.html      3 legacy redirect stubs → /c/{slug} (keep; old links)
migration/             D1 schema reference (schema.sql, accounts_migration.sql,
                       schema_explanation.md, ACCOUNTS_SETUP.md)
```

## Database (D1, SQLite)

Tables: `users`, `characters`, `collections`, `scripts`, `settings`,
`activity_log`, plus Worker-auto-created (no manual migrations, ever):
`news` (admin-written articles: slug PK, title, JSON `data`, status,
`published_at` stamped once so editing an old article doesn't jump it to the
top), `comments` + `comment_reports` (keyed by `entity_type`+`slug`; threads are
**one level deep** — `parent_id` is NULL or a top-level id, never another
reply, and the API flattens a reply-to-a-reply onto its thread. `pinned` is
set only on top-level rows, by the page owner or an admin, and sorts first.
Comment `status` is `visible` | `removed` (taken down on its own) |
`hidden` (a reply that went down with its parent); restoring a parent
un-hides exactly the `hidden` ones and leaves individually-removed replies
alone. Purge deletes a comment and its replies for good) and a lazily ALTERed `users.comment_terms` column
holding the comment-guidelines version that account agreed to,
`revisions` (every content save snapshots the replaced version, 20 kept per
page, for admin rollback), `messages` (contact-the-admins form → dashboard
inbox — NOT user DMs. An admin answers one with
`POST /api/admin/message {action:'reply', body}`, which DELIVERS the answer as
a `dms` row from that admin to the message's author — so it rides the unread
count, the mail flag on "My Account", and can be replied to. The lazily-ALTERed
`last_reply`/`replied_at`/`replied_by` columns are only the dashboard's record
that it happened; blocks are deliberately not checked, as everywhere else an
admin messages a user), `dms` + `dm_blocks` + `dm_reports` (user↔user direct
messages with per-side conversation hiding and per-user block lists; blocks
don't apply to admin senders; unread count rides on `/api/me`; a `dm_reports`
row is what unlocks that one conversation for admin reading via
`/api/admin/dm-thread` — un-reported DMs are never admin-readable. **Comment
notifications ride this table**: commenting on a page inserts a `dms` row from
the commenter to the page's owner — and to the author of the comment being
replied to — so the notification is the one the site already has, the unread
count on `/api/me` and the mail flag site.js puts on "My Account". The row is
written with `sender_deleted=1`, which keeps it out of the *commenter's* own
conversation list: they wrote a comment, not a message. See `notifyComment()`
in worker.js; a block stops the notification too), `page_views` (per-page daily
view counts, bots filtered, 180-day retention), `pages` (the custom wiki
pages: `slug` PK, title, `parent_type`+`parent_slug` pointing at the script or
collection they belong to, author, owner_id, JSON `data`, status — see the
section below), `redirects` (`entity_type`+`from_slug` PK → `to_slug`: the URLs
a renamed page used to live at — for characters `to_slug` is the page's
**identity**, never another address, see "Character identity vs address" below),
`site_text` (the rewrites made on /text-editor — only strings that were
actually CHANGED, keyed `(scope, original)`; see "System text" below), and a
lazily ALTERed `users.banned` column. `settings` also holds
`announcement` (site-wide banner JSON) and `protected:{type}:{slug}` keys
(admin page protection — only admins may edit/publish/delete those pages).
Bans and admin promote/demote take effect immediately: POST requests and
admin GETs re-read `is_admin`/`banned` from D1 instead of trusting the
30-day session cookie. Content tables use the **hybrid JSON blob** design: a few
indexed columns (slug PK, name, team, creator, owner_id, tags, appears_in,
status — plus a lazily-ALTERed `characters.url_slug`, the page's address)
plus the **full object as JSON in `data`**. New character fields never
need a migration — just put them in the JSON; render.js decides what shows.
`status` is `published` or `draft`; public JSON and SSR only expose published
rows (drafts visible to owner/admin). Character data schema: see the sample
object in `migration/schema_explanation.md` or any `/characters.json` entry.

Scripts and collections carry rich page fields in their `data` JSON (all
optional, no migration): `tagline, version, difficulty, synopsis, gameplay,
strategyGood, strategyEvil, logo, theme{}`. Collections also have hybrid
membership — `match[]` (auto, normalized `appearsIn`) plus manual `include[]` /
`exclude[]` slug lists (see `resolveCollectionMembers` in render-page.js), and
an optional `order[]` of slugs — the author's hand-arranged roster order, kept
as a SEPARATE list from membership on purpose: a slug in `order[]` that is no
longer a member just never matches, and a member missing from it falls to the
end of its team alphabetically, so neither list has to be kept in step with the
other. Team grouping always wins over it (the page draws one section per team).

A character listed in a collection's `include[]` gets that collection as its
**"Appears in"** without anyone typing it. `applyCollectionAppearsIn()` in
worker.js fills `appearsInFrom` (up to 3, `{name, id}`) on read, for characters
whose own `appearsIn` is blank, in `buildPublicJSON` and on the SSR `/c/` page.
It is a SEPARATE field on purpose: writing it into `appearsIn` would feed the
`match[]` rule that resolves membership, so a collection whose match term
happened to equal another collection's name would start swallowing that
collection's characters. Nothing is stored (the save handler deletes any
`appearsInFrom` a client sends back), so removing a character from a collection
takes the line off its page. `render.js`'s `appearsInRow()` prints the typed
line or the derived links; charpage.js's `linkAppearsIn()` leaves a row that is
already linked alone.

Every
Both also take `customBoxes[]` — the same `{title, content}` widget as the
character pages, rendered through render-wiki.js so a box can hold a list, a
link or a `[[Character Name]]`. Every one of these is length-capped and
theme-validated server-side in `sanitizePageFields()` (worker.js). `theme` is `{font, accent, panel, text,
link, background}` — colors must be `#rrggbb`, font a `FONT_PRESETS` key,
background only the entity's own `{scripts|collections}/{key}-bg.{ext}` slot;
`sanitizeTheme()` drops anything else and it's applied as CSS custom properties
on `<body>` (never raw CSS). Seeded collections have `owner_id NULL` — admins
assign an owner via the dashboard (`/api/admin/assign-owner`) so a user can edit.

## Night order (script pages)

Two questions, answered in two places, and keeping them apart is the design:

- **Who acts** belongs to the character: it is on a night list because its own
  `firstNight` / `otherNight` is above zero, and nothing on the script can add
  or remove anyone. Official characters take their positions from
  `assets/night-order.json` through `official-roles.js`; without that merge
  they carry 0 ("does not wake") and drop out of every script's Night Order box.
- **What order** belongs to the script's owner, as
  `nightOrder: {first: [slug], other: [slug]}` in the script's `data`.
  `sanitizeNightOrder()` caps each list at 200 and drops the key when empty.

`PageRender.nightItems(entries, nightOrder)` in render-page.js is the single
source of truth. The SSR page renders through it and both arranging panels (the
Script Builder's and publish-script.html's, one widget in
`night-order-editor.js`) arrange through it, so the owner's list IS the reader's
list. A character the arrangement has not seen, added since it was last saved,
is not dumped at the end: `sortNightItems()` slots it in after the last
arranged character that acts before it does. An untouched script stores no key
and keeps following the characters' own numbers, so fixing a character's wake
position still moves it everywhere that never overrode it.

## Jinxes on one script

A jinx normally belongs to the characters: both character editors write it into
the character's own `jinxes`, and any script holding both ends shows it. That is
right for a rule the character carries everywhere, and no help to a script that
wants to drop one or add a rule that only holds here. So a script may carry
`jinxEdits: {off: ["slugA|slugB"], add: [{a, b, text}]}`, capped by
`sanitizeJinxEdits()`.

`PageRender.scriptJinxes(entries, edits)` is the single source of truth: the
page renders through it, `jinx-editor.js` edits through it, the export is built
from it. **Nothing is written back to the characters**, so another script keeps
whatever they say. The pair key is the two slugs sorted and joined with `|`, so
it reads the same whichever end wrote the jinx.

The export is the fiddly half, because the official app reads jinxes off the
CHARACTERS. `jinxExportMap()` rebuilds the list of only those characters whose
jinxes actually changed; one the script never touched exports byte-for-byte as
before, and a jinx it carries with someone *not* on this script is left alone.
An official character normally exports as a bare id, but if this script gives it
a jinx the bare id has nowhere to carry it, so that one is written out in full.

## The official app's script JSON (`_meta`)

The export follows the schema at
`github.com/ThePandemoniumInstitute/botc-release`. Beyond `name`/`author`/
`logo`:

- **`background`**: the page background (`theme.background`) as an absolute
  URL. One upload serves both the wiki page and the app.
- **`hideTitle`**, **`almanac`**, **`bootlegger[]`**: set on publish-script's
  "In the Official App" panel. Bootlegger rules also show on the script page as
  *House Rules*, or a reader would only find them inside the JSON.
- **`firstNight` / `otherNight`**: the arranged night order as ids. Only written
  when the owner arranged one. Left out, the app orders by each character's own
  number and reaches the same answer, so writing it anyway would freeze today's
  answer into the file.

The night is not only characters: dusk opens it, dawn closes it, and the first
night has the minion and demon info steps in the middle. Those live in
`assets/night-order.json` under `meta`, positioned from their neighbours on the
official sheet (minion info between the Magician and the Snitch, demon info
between the Summoner and the King). Whoever loads that file hands them to
`PageRender.setNightMeta()`; **without them the sequences are not written at
all**, rather than publish a night order those steps are missing from.

## Public editing, and page history

A page belongs to whoever made it. Its creator may open it to other people,
stored on the page's `data` as `publicEdit`:

- **`'all'`**: anyone with an account may edit the page.
- **`'tags'`**: anyone with an account may change the tags and nothing else.
  Characters only; on a script or collection it is treated as closed.
- **`'suggest'`**: anyone with an account may PROPOSE a version for the creator
  to approve. Not write access: every save handler asks `permCanWrite()`, and
  'suggest' is not a writing mode, so it can never be mistaken for an edit.
- **`'approved'`**: only the accounts the creator NAMED may edit — see below.

`editPermission(env, sess, type, row)` is the single answer to "what may this
session do to this row": `'owner'`, `'approved'`, `'all'`, `'tags'` or `''`.
Never open whatever the setting says: a **draft** (except approved editing), an
**admin-protected** page, and a page whose creator never opted in.
`canEditRow()` still means ownership, and everything belonging to the creator
goes through it: renaming, publishing, unpublishing, deleting, rolling back, and
the setting itself. `/api/publish` and `/api/delete` are deliberately left on
`canEditRow`.

The save handlers enforce the rest:

- **Tags-only writes are rebuilt, not diffed.** The stored page *is* the save
  and only `tags` comes from what was posted, so nothing else a client sends
  can reach the row. Capped at `PUBLIC_EDIT_TAGS_MAX`.
- A non-owner save carries the stored `publicEdit`, `curata` and `status`
  forward: a guest can neither open a page further nor close it behind
  themselves, and cannot publish or unpublish it. A guest save that would fail
  `missingForPublish()` is **refused**, not demoted to draft, or clearing one
  field would unpublish somebody else's live page.
- A non-owner payload over `PUBLIC_EDIT_MAX_BYTES` is refused (413).
- The editor makes the **name read-only** for a guest: renaming moves the URL,
  and that stays with the creator.
- Every public edit notifies the owner (`notifyPageEdit`) through the same `dms`
  row comments use, so it rides the unread count and the mail flag.

### Approved editing (`publicEdit: 'approved'`)

The mode that shares a page with **named accounts** instead of opening it to
everyone. They edit it as the creator would; the creator keeps the page.

- **The list lives on the page's `data` as `editors`**, one `{id, username}`
  per account. The **id is the authority** — it is what every permission check
  reads, it costs no lookup (a session already carries `userId`) and it
  survives a change of handle. The **username** is only what the owner's editor
  shows back. `sanitizeEditors()` resolves whatever a client posts (pairs, or
  the bare names the owner typed) through `selectUserByName()`, so a name
  nobody answers to can never become a permission; what it could not resolve
  comes back as `editorsUnknown` and the editor says so rather than dropping it
  in silence. Capped at `PAGE_EDITORS_MAX` (20). The owner is never on their
  own list.
- **`editors` never goes on the wire.** `buildPublicJSON` deletes it: it is the
  creator's administration, it holds account ids, and nothing public reads it —
  an editor loads the page through `/api/page` like the owner does. The page's
  Editing row says *shared* and stops there; who the editors are is not
  announced.
- **An approved editor reaches a DRAFT**, which no other mode does. A
  collaborator is most use before the page goes live, and there is no stranger
  to hide it from. `canEditPage()` is that gate — ownership **or** an approved
  editor — and it is what the `/c/`, `/s/` and `/collection/` draft checks and
  `/api/page` ask. `canEditRow()` is untouched and still means ownership.
- **They cannot publish it.** Every save handler pins `status` from the stored
  row for anyone but the owner, so a shared draft stays a draft until its
  creator publishes it. The editors say so instead of showing a Publish button.
- **They cannot change who else may edit.** `publicEdit` *and* `editors` are
  both carried forward from the stored row for a non-owner save, so an editor
  can neither add a friend nor take the others off.
- **They can replace the page's art.** `/api/upload` checks the image slot's
  page with `canEditPage()`, and a slot whose page said yes skips the
  "somebody else's file is already here" catch-all — otherwise a shared
  character could never get the icon that is keeping it out of drafts.
- **They can rename**, unlike an `'all'` guest (whose name field the editor
  locks). Renaming is an address change and nothing else now, and this is
  somebody the creator picked by hand.
- Being added arrives as the notification the site already has: a `dms` row
  (`notifyEditorsAdded`) that rides the unread count and the mail flag. It
  scrolls away, so **`GET /api/shared-pages`** is the standing list, shown as
  *Shared With You* on the account page. Without it there is no way back to a
  shared draft: by design it is in no feed, no search and no browse page.
- `assets/approved-editors.js` is the one naming widget, mounted by all four
  editors (`create.html`, `edit.html`, `publish-script.html`,
  `publish-collection.html`) so the three page types cannot drift apart. It
  confirms a handle through `GET /api/account-lookup` as it is typed; the
  Worker resolves the list again on save regardless — the lookup is a courtesy,
  never the check.

Wiki pages (`/p/`) are deliberately outside all of this: they are owner-only
across the board on every route, and giving them `publicEdit` would mean
teaching `/api/wiki-page` the whole machinery.

**History is public and drafts have none.** `saveRevision()` skips any row whose
stored status is not `published`: a draft is saved over constantly while it is
written and nobody wants those versions back, so a page's history starts at the
version that went live. What is snapshotted is the version being *replaced*, so
taking a published page back to draft still records what was live.
`REVISIONS_KEEP` is 50.

- `GET /api/page-history`: the log, one entry per revision with who saved over
  it, when, and **what changed** (`diffFieldLabels` compares the top-level keys
  of the two blobs; `FIELD_LABELS` names them). Public for a published page,
  owner-only otherwise.
- `GET /api/page-revision`: one entry in detail, every changed field with its
  before and after text (`diffFieldValues`).
- `POST /api/page-rollback`: put a version back. Owner or admin, and it
  snapshots the current version first, so a rollback is itself undoable.

## Suggested edits

A page set to `publicEdit: 'suggest'` collects proposed versions in the
lazily-created `suggestions` table (`entity_type`+`slug`, the suggester, an
optional `note`, the whole proposed page as `data`, `base_updated_at`, and a
`status` of open/approved/declined/withdrawn). A suggestion is the same object
the editor would have saved, stored rather than applied.

- `POST /api/suggest`: propose one. Refused for the page's own owner (they just
  save), a page not in suggest mode, a protected or unpublished page, and a
  proposal identical to the page as it stands. Owner-only fields (`publicEdit`,
  `curata`, `status`, `slug`) are stripped on the way in.
- `GET /api/suggestions?type=&slug=`: a page's suggestions, each with the
  field-by-field difference from the page **as it stands now**, and a `stale`
  flag when that differs from what it was written against. Visible to the owner,
  to admins, and to each suggester for their own.
- `GET /api/suggestions?inbox=1`: everything open on pages this account owns.
- `POST /api/suggestion`: `approve` / `decline` (owner or admin, with an
  optional reply) or `withdraw` (the suggester). **Approving is an ordinary
  save**: `saveRevision()` snapshots the current version first, so it shows up
  in the history and can be rolled back, and owner-only fields are re-pinned
  from the row rather than taken from the suggestion.

`suggestions.html` serves both `/suggestions?type=&slug=` (one page's queue,
with Approve / Decline / Withdraw) and `/suggestions` (the owner's inbox).

**Only characters can be suggested against so far.** `POST /api/suggest` is
called from `edit.html` alone: the full form, a note box, the name locked and
**the art inputs disabled**, because an upload would write into the page's own
R2 slot, which is the one thing an unapproved suggestion must not touch.
publish-script.html and publish-collection.html have no send path, so they go
read-only in suggest mode and say so. A script or collection set to 'suggest'
therefore advertises a queue nobody can add to; either wire the send path into
those two editors or take 'suggest' out of their dropdowns.

`history.html` (`/history?type=&slug=`) is the reader-facing page: the current
version, every edit under it, "What changed" per entry, and "Put this version
back" for the owner. Linked from the page itself (only an opened page
advertises itself, via `openEditRow()` in render.js and `openEditRows()` in
render-page.js), from the account page's row actions, and from the guest banner
in the editor.

## Character identity vs address (`/c/{set}/{character}`)

A character has **two** strings and they do different jobs:

| | column | example | changes? |
|---|---|---|---|
| **identity** | `characters.slug` (PK) | `witcher-odyssey` | never |
| **address** | `characters.url_slug` | `odyssey/witcher` | freely |

**Everything that points at a character points at the identity** — `comments`,
`page_views`, `revisions`, `activity_log`, the roster slugs in
`scripts.data.characters`, collection `include[]`/`exclude[]`, profile pins,
admin protection, and the art objects in R2 (`art/{identity}.png`). So renaming
a page is an address change and **nothing else**: one `UPDATE` plus one
`redirects` row. A new feature can store a character reference without
registering itself anywhere — the old `rewriteSlugRefs()` warning is gone,
because nothing has to be rewritten.

`url_slug` is a lazily-ALTERed column (`ensureUrlSlugColumn()`), unique-indexed.
A row without one still resolves at `/c/{identity}`, so a half-finished backfill
can never 404 a page.

**The two namespaces cannot collide**: an address always carries a slash and an
identity never does. `/c/{one-segment}` is therefore always an identity (or a
flat address from before nesting) and **301s** to the canonical nested URL — no
redirect row needed, the primary key does that job. Old *addresses* live in
`redirects` and always point at the **identity**, never at another address, so a
page that moves twice needs no chain rewriting.

### Which set a character is filed under

`characterQualifier()` in worker.js, in this order:

1. a **collection** named in `appearsIn` → `odyssey/witcher`
2. a **script** named in `appearsIn` → `fall-of-rome/actor`
3. the set named in `appearsIn` even when this wiki has **no page for it** —
   "Master Observatory Character Collection" is a real set nobody registered,
   and its 38 characters read better under it than scattered under six authors
4. a collection's `include[]`, then a **script roster** that lists it (this is
   what catches the Blood on the TARDIS cast: 71 characters with no `appearsIn`
   that plainly belong to one script)
5. the **author** (`creditNames()[0]`) → `gobinator/archer`
6. their account, then `misc`

Steps 1–2 match **loosely** (case, punctuation and apostrophes ignored, and
`display_name` counts) because `appearsIn` is free text people typed: "Tales
from Tir-Far's Archive" has to find `tales-from-tir-fars-archive`, and
"Trouble Homebrewing" is the display name of the `imppreposterous` collection.
Collections beat scripts outright. Two characters with the same name in the same
set get `.../carpenter` and `.../carpenter-2`; there is nothing left to tell
them apart by.

The address is recomputed on **every save** — that is what makes renaming
automatic, and it also means moving a character into a collection moves its URL,
with a 301 left behind. A save that changed neither the name nor the set keeps
the address it has, numbered suffix included, so nothing shuffles when a sibling
moves away.

### Retroactive nesting

`POST /api/admin/nest-urls` ({dryRun:true} first; dashboard card "Nested
character URLs") files every existing character. It builds its lookup maps
**once** and holds `taken` in memory — 1,647 characters times a collection scan
each would be thousands of queries — and reserves every address it touches,
including ones it vacates, so nothing in a run can hijack another page's
redirect. Re-runnable: settled rows are skipped, so a second pass after
registering a collection only moves the pages that collection just claimed.
It bumps `content_version` (see Gotcha 13) — without that the feeds keep
serving the old addresses.

### Other things worth keeping

- `/api/page` resolves a character by identity **or** address, so `edit?c=` works
  from a copied URL.
- The canonical 301 in the `/c/` route fires **after** the draft and deleted
  gates. A 301 where a stranger should get a 404 would reveal that an
  unpublished page exists.
- `pageShell({root})`: every path in the shell is relative. `/s/`, `/collection/`,
  `/news/` and `/p/` are one level deep and default to `../`; a nested character
  page passes `../../`, computed from the address depth. `window.LINK_ROOT`
  carries the same value, and `site.js` derives its own `ROOT` from the
  stylesheet href, so both follow automatically.
- `/api/slug-check` is about the **identity** (the PK and the art slot), not the
  URL. Its suffix ladder still looks like a URL and still matters, because
  identities name the art slot. For scripts and collections the slug **is** still
  the URL and nothing about them changed.
- `renameCharacter()` still exists for the one case that moves a primary key (an
  admin re-keying a row). An ordinary rename never goes through it.

## Creator identity (which names belong to which account)

A page's **Creator** is free text; an account is a row in `users`. They are not
the same thing and never will be — roughly half the wiki was bulk-imported with
a creator string and `owner_id NULL`. The creator page needs to know when a name
and an account are the same person, and decides it two ways
(`resolveCreatorAccount()` / `creatorNamesFor()` in worker.js):

1. **Proof by ownership** — the account owns at least one **published** page
   credited to that name; whoever owns the most wins, ties on lowest user id.
   Published is load-bearing: counting drafts would let anyone claim any name by
   saving an unpublished page credited to it. Do not relax it.
2. **Admin override** — a `settings` row, key `creator_alias:{lower(name)}`,
   value = the username. An **empty value** pins the name as deliberately
   unlinked, overruling a wrong ownership match. This is the only way to attach
   bulk-imported pages, which can never prove anything. Set from the admin box
   on the creator page itself (`POST /api/admin/creator-alias`).

A creator page then shows the union of *pages the account owns* and *pages
credited to any name it has claimed*, so a page counts either way round.
Nothing is written to the pages, so it all stays correct as pages change hands.

Extra profile fields (links + up to 3 pinned pages) live in one lazily-ALTERed
`users.profile_json` column — same hybrid-JSON reasoning as the content tables.
`sanitizeProfileExtra()` caps and validates them (http(s) links only, Discord is
a handle not a URL); pins are re-checked against what the account actually owns
on save **and** on read, so a pin that goes draft quietly drops out.

A credit can name several people ("Taiyi (太一), Saki") and each of them gets
their own creator page, so every match is done one comma-separated segment at a
time — `creditMatchSQL()` / `creditNames()` in worker.js, `splitCreators()` in
creators.js. Never compare a whole `creator` column against a single name.

**Proof by ownership needs pinning where a bulk import owns the pages.** The
admin account owns most of the imported wiki, so every name credited on those
pages resolved to it and `/author?a=` 302'd the lot to `/u/admin` — Taiyi, Gstone
Games, Hystrex and the rest all landed on one profile. Twenty-eight names are
now pinned unlinked (empty `creator_alias:` rows), so each renders its own
creator page; the same thing had happened to seven co-credits and attribution
fragments under christoph-ehm ("idea by Lins", "based on TPI"), plus one each
under teobius and dashieswag92. `DJ_DJ_DJ` is deliberately left resolving to
`admin`. **Any future bulk import owned by one account needs the same pass**, or
it quietly swallows every name it is credited to.

## Jinxes

A jinx is a rule about a **pair** of characters, but it is stored on one side
only: `data.jinxes` on the character whose editor typed it, as
`{name, align, text}` plus **one** of `slug` (a character on this wiki) or `id`
(an official character). Older rows use the official-schema `{id, reason}`
shape and bulk imports use `{id, name, text}`; every reader normalizes with
`j.name || j.id` and `j.text || j.reason`, and `sanitizeJinxes()` in worker.js
caps and whitelists the fields on save.

- **`resolveJinxTarget()` (render.js) answers "who is this jinx with"** for
  every consumer: the `/c/` sidebar box, the script and collection lists, and
  `/jinxes`. See gotcha 8 for the resolution order and why official wins.
  It needs two registries, injected the same way `setOfficialIconUrls()` is:
  `setWikiChars()` (this wiki's characters) and `setOfficialNames()` (so a
  jinx typed as "leviathan" prints as Leviathan). Unset, jinxes still render:
  official ones resolve, homebrew ones fall back to plain text.
- **Mirroring is derived on read, never stored.** A `/c/` page shows its own
  jinxes plus every jinx another character declares with it
  (`mergeMirroredJinxes()`), flagged `mirrored` so the renderer can say which
  page to go to to edit it. A pair both sides declare is shown once, and the
  character's **own** entry wins, because that is the text its owner wrote.
- **`jinxIndex(env, ctx)` is where "who points at me" comes from.** A single
  page view cannot scan every character (see the comment above
  `charactersForCollection` for why that was removed), so the whole edge list
  is derived once and cached in-isolate **and** in `caches.default` under a key
  carrying `contentVersion()`. `logActivity()` bumps that on every content
  write, so it self-invalidates. No table, no migration, no rebuild tooling.
  `buildJinxIndex()` is pure and can be tested without a database.
- **`POST /api/jinx`** adds, edits or removes one jinx. You need to own (or
  admin) **one** of the two characters; it is stored on the side you own and
  the other page gets it by mirroring. The other side must exist: an official
  id is checked against roles.json, a wiki slug against the table.
- **Jinx rule text goes through `render-wiki.js`** like every other
  writer-supplied string, so `**bold**` and `[[Character Name]]` work in it.
  The `/c/` route therefore has to call `WikiRender.setCharLinks()`.
- **`assets/official-jinxes.json`** holds jinxes between two OFFICIAL
  characters (71 pairs; the `source` field says where from, and it is
  partial). They are an **opt-in layer** on `/jinxes`, off by default: the
  base game's own rules would drown what this wiki made. Served in
  `/api/jinxes` as `baseEdges`, drawn hidden so switching them on does not
  move the layout.
- **`GET /api/admin/jinx-health`** counts jinxes that point at nothing (a
  typo, or a bulk import naming a character never brought over) and pairs
  where both characters wrote a rule, since only one wording is ever shown and the
  other is invisible. Dashboard card: "Jinx health".

## Custom wiki pages (`/p/{slug}`)

Text-first pages hanging off one script or collection — modelled on the
official wiki's reference pages (States, Night Order and friends). The `pages`
table holds them; `data` carries `{title, subtitle, blurb, author, body,
header, images[], boxes[], infobox{}, theme{}, toc, comments}` — all optional
except title and body, all capped and validated by `sanitizeWikiFields()`.

- **Unlisted by design.** `/p/` sends `noindex`, is absent from
  `sitemap.xml`, the JSON feeds, site search, `/random`, the homepage strips
  and every browse page. Exactly two things link to one: the **Pages** section
  on its parent script/collection page, and its author's `/author?a=` and
  `/u/{username}` pages. If you add a new listing anywhere, do **not** add
  wiki pages to it — being unlisted is the feature.
- **Who may write one:** the owner of the parent script/collection (or an
  admin). Ownership then belongs to the writer, and only they or an admin can
  edit it afterwards. Parentage is frozen at creation — moving a page would
  break its links.
- **Slug** is derived from the title once and frozen, with a `-2`, `-3` …
  suffix if that slug is taken. Slugs are global across all wiki pages.
- Images live in R2 under `pages/{slug}-*`; the banner is
  `pages/{slug}-header.png`, the background `pages/{slug}-bg.png`. The upload
  route pins that prefix to the page's owner (longest matching slug wins).
- Comments work like every other page type (`entity_type='wikipage'`), and can
  be switched off per page.
- Deleting one is **permanent** — unlike scripts/characters there is no soft
  delete, so the account page offers Edit only and the editor owns the rest.
- The first set of these is the **Odyssey glossary**: nine pages (Attack,
  Delay, The Final Day, Variable X, Other (Players), From the Storyteller,
  Use Vote Token / Give Up Vote Token, The Traveller Exclusion Principle,
  Jinxes) hanging off the `odyssey` collection, each carrying a fact box and
  a nav box linking the other eight. Their slugs are **collection-prefixed**
  (`/p/odyssey-attack`, `/p/odyssey-jinxes`, …) because slugs are global and
  a term like "attack" belongs to no one collection — prefix any future
  glossary the same way. They live in D1 like all page content;
  `migration/odyssey-glossary-pages.json` is a copy of the rows as written,
  kept for reference the same way the `*-import.json` files are. Their text
  follows the Odyssey house style set by `migration/odyssey-cleanup.js`: no
  em dashes, they/them pronouns. 审判日 is **"the final day"** throughout, the
  wording the character almanacs already use — not "judgment day", which is
  what the source wiki's subtitle says, and not "last day".

The **same text engine and editor kit** power news articles: `publish-news.html`
and `publish-page.html` share `render-wiki.js`, `wiki-editor.js` and
`theme-editor.js`, so a formatting mark added in one place works in both (and
in custom boxes). News backgrounds live in R2 under `news/{slug}-bg.png`;
`news/` uploads are admin-only, like `tokens/`.

## System text (`/text-editor`)

The wiki's own wording — page copy, buttons, labels, notices, the banners the
Worker prints — listed in one admin-only page so it can be searched, filtered
and rewritten without a deploy. **Not** anything anyone typed into an editor:
characters, scripts, collections, wiki pages, news and comments belong to
whoever wrote them (the admin account included) and are edited on their own
pages. The tool never fetches D1 content.

How the three pieces fit:

1. **The catalogue is derived, never stored.** `assets/text-scan.js` runs in
   the admin's browser, fetches every static page and every `assets/*.js`, and
   pulls the human-readable strings out. Nothing is written to the database
   until something is actually changed, and every visit re-scans, so text
   added by a later deploy is simply there — that is what keeps the list
   current with no upkeep. New pages/assets are found by crawling `<a href>`
   and `<script src>` on top of the seed lists.
2. **Only the changes are stored.** `POST /api/admin/site-text` writes one row
   per rewritten string into `site_text` (`scope`, `original`, `replacement`).
   Saving a replacement equal to the original — or Undo — deletes the row and
   hands control back to the source file. The public `GET /api/site-text`
   serves the map; it is usually empty, is cached per isolate for a minute and
   sent `max-age=120`.
3. **`site.js` applies them in the browser.** It rewrites text nodes and the
   reader-visible attributes only — never `innerHTML`, never markup — with a
   MutationObserver so client-rendered content is covered too, and a
   localStorage cache so a repeat visit never flashes the old wording. Put
   `data-no-text-override` on anything that must show text verbatim (the text
   editor's own results list does).

**Live mode** (`assets/text-live.js`) is the same three pieces worn differently:
switched on from /text-editor, it lets the owner browse the wiki normally and
double-click (double-tap) any of the site's own wording to rewrite it where it
stands. The catalogue is cached in localStorage (`botc_text_catalog`, text +
scope only, ~100 KB, rescanned in the background after 12 h) so every page
knows instantly what is editable. Two things keep it honest:

- **Nothing outside the catalogue is offered.** That is what stops anyone's
  ability text or comment being rewritten from the page it sits on.
- **A short string is only editable when it IS the text that was clicked.**
  "Each night" is genuinely in `sao.js` *and* opens half the abilities on the
  wiki; a site-wide override of it from a character page would be a disaster.
  Anything the guard turns away is still in the list on /text-editor, where
  the source file is shown beside it.

A click on an editable link or button is held ~320 ms and replayed if no
second click follows, so double-click can reach a nav label without the first
click navigating away. Anything NOT editable is never intercepted, so ordinary
browsing keeps its normal speed. `SiteText.setItems()` also builds **undo
rules** (replacement → original) from what the page currently shows, so
pressing Undo — or editing the same words twice — repaints instead of leaving
the old wording behind.

Two rules worth knowing before changing any of this:

- **Scope.** A string found in a shared `assets/*.js`, or on more than one
  page (the topbar and footer are hand-copied into every page), is edited
  **once** and applies site-wide. A string found on exactly one page is scoped
  to that page, so a short label can be changed without touching a page that
  happens to use the same word. Matching is by substring inside a text node —
  a whole node is not required, because the site builds a lot of its sentences
  by concatenation.
- **`{placeholder}`** in an original marks a slot the site fills in
  ("Add {missing} to fix."). It compiles to a capture group, so the filled-in
  value survives; a replacement must keep the placeholder.

**The Worker's own page text lives in `assets/system-text.js`**, not inline in
worker.js — the scanner fetches the site's files as static assets and
`worker/worker.js` is excluded from the asset upload. Add new server-rendered
wording there and reference it, or the owner cannot edit it. API error
messages are deliberately out of scope: they come back as JSON, usually into
an `alert()`, and there is no DOM to patch.

## Icon Forge (`/iconforge`)

A client-side icon maker: line art, a scan or a photo in, an official-style
character icon out (textured body, parchment details, white border,
transparent PNG). It is a **static page** — no Worker route, no D1, nothing
uploaded — except for the one opt-in save described below.

- **The engine is ported, not rewritten.** `assets/iconforge/engine.js` is the
  handoff's `iconEngine.ts` with its types stripped by `tsc` (comments kept).
  Two rules from its design are load-bearing and easy to break:
  1. Any new option read by `prepSource`/`buildMasks`/`buildLighting`/
     `buildBevel` **must be added to `MASK_OPTS`**, or the mask cache goes
     stale and the control appears to do nothing intermittently.
  2. `clipToMask()` and `adjustField()` **mutate their input canvas**. Cached
     stages are `cloneCanvas()`d before being fed to them — keep the clones.
     Also: any helper that sets a canvas transform resets it before returning.
  The full reasoning is in `migration/icon-forge-guide.md` (§2, §3, §7), which
  is the reference for the pipeline. Its §1 and §8 describe the original React
  project and do **not** apply to this repo.
- **The page owns the UI.** `iconforge.html` carries the markup and all
  page-local CSS (sliders, switches, segmented pickers and the preview stage,
  all rebuilt in wiki furniture). Every control declares
  `data-opt="<option name>"` and `assets/iconforge/app.js` binds them
  generically — state is the truth, the DOM is a view of it, so a new knob is
  one markup block plus (if it needs one) a formatter in `FORMAT`.
- **The preview keeps one cached renderer** and draws a fast pass at
  supersample 1 immediately, then a crisp pass at 2 after 220 ms idle. Export
  always renders one-shot at full quality. Do not "simplify" that into a
  single render — a full pipeline run is ~750 ms.
- **"Smart remove" runs in a Web Worker** (`bg-worker.js`) and must stay there. The
  segmentation is one uninterruptible burst of CPU: on the main thread it
  froze the whole tab — no scrolling, no clicking, and the progress bar could
  not even repaint, so it read as a crash. `bgremoval.js` keeps a main-thread
  fallback **only** for browsers without module workers (Firefox < 114,
  Safari < 15); it is chosen solely when the worker fails to start, and it
  still freezes. The progress card (`#if-busy`) is fixed to the viewport, not
  parked in the preview stage, because on a phone the stage is scrolled far
  off screen while you are using the Background controls — and it carries a
  Stop button, which terminates the worker (an abandoned one keeps a core
  busy).
- **`assets/iconforge/vendor/` is third-party** (see its README):
  `@imgly/background-removal` and the `onnxruntime-web` wasm build, both
  vendored from npm because there is no bundler. The imgly file carries a
  documented two-line patch pointing its ONNX imports at the vendored file
  instead of the bare specifier `onnxruntime-web` — **import maps do not
  apply inside workers**, so a bare specifier there is unresolvable. Re-apply
  that patch on any upgrade or Smart remove dies. The ONNX wasm (~12 MB) and the
  model (~44 MB) are fetched from imgly's CDN on first use; they can never be
  committed (the model alone exceeds Cloudflare's 25 MiB per-asset limit and
  would fail the whole deploy). If that fetch fails the tool toasts and falls
  back to "Keep". **The page never says "AI"** — the control is "Smart
  remove" and the progress card just says "Removing". That is deliberate; keep
  it that way in anything reader-facing. These notes stay technical.
  `minipaint/` is likewise sealed — a prebuilt, minified miniPaint bundle with
  a custom lasso tool. It is only re-skinned (CSS variables injected into the
  same-origin iframe by `editor.js`); never hand-patch `js/bundle.js`.
- **Save to a character** is the only server call. It uploads the 591 px
  render to `art/{slug}.png` — the same R2 slot the character editor uses —
  and then re-saves the row through `/api/character` with `art`/`image`
  pointing at it, so a page whose art lived elsewhere still picks it up. The
  Worker is the enforcer on both calls (`canEditRow`); the page only decides
  what to ask for. It sends the row's existing `status` back so saving an icon
  never publishes a draft.
- Textures and the editor are pinned content and cached `immutable`
  in `_headers`; the tool's own `.js` modules — and `vendor/`, which carries
  that local patch — are deliberately left on the site-wide revalidate rule so
  a change shows on a normal refresh.


## Page classification (Partial / Standard / Curata)

`assets/classify.js` is the **single source of truth**, shared by the browser
and the Worker (which stamps `classification` + `curata` onto every row in
`/characters.json`, `/collections.json`, `/scripts.json`).

- **Two bars, both in `classify.js`.** `PUBLISH_REQUIREMENTS` is what a page
  needs to leave drafts at all — **name, icon, ability**. Tags are
  deliberately NOT in it: no tags makes a page Partial, never unpublished
  (tags were the sole reason 231 of 619 published pages failed the old bar).
  `STANDARD_REQUIREMENTS` is that plus **tags, a flavour line (`lede`), a
  summary (`summaryBullets`), how-to-run text (`howToRun`) and at least one
  example**.
  Both are `[label, test]` tables; the labels carry their own articles ("an
  icon", "tags") because they are read straight into "Add ___ to fix." on the
  Partial banner and "needs ___" in the editor. `missingForPublish()` /
  `missingBits()` return the failing labels, `listPhrase()` joins them.
- **Partial** — characters only: anything short of `STANDARD_REQUIREMENTS`.
  Hidden from All Characters, the tag/team/creator pages, Featured and the
  homepage unless the *reader* ticks the "Show Partial" chip. Filling the gap
  upgrades it instantly — nothing is stored.
  `hasMechanics()` no longer gates Partial (night order alone is not a
  finished almanac entry) but is still exported and still used to describe a
  page; don't delete it.
- **No team is exempt any more.** Fabled used to be, because it held this
  wiki's rules constructs (States, Conditions, Calls, Alignments, Properties).
  Those 18 pages are now wiki pages under Imppreposterous Syncretastrophy
  (`POST /api/admin/concepts-to-pages`), and all 31 Fabled characters left
  have icons — so the exemption was only letting real characters skip the bar.
  `isRulesPage()`/`needsIcon()` survive as functions (the Worker calls them,
  and a future "this team is different" belongs there) but no longer exempt
  anything.
- **Standard** — the default. No badge, nothing to earn.
- **Curata** — admin-only, on characters, collections **and** scripts.
  Weighted `CURATA_WEIGHT` (5×) in Featured, `/random` and the homepage
  strips, and filterable on its own (a "Curata only" chip on All
  Characters, All Collections and Scripts).
  A Curata **collection lends the status to every character in it**
  (`applyCollectionCurata()` in worker.js, applied on read in
  `buildPublicJSON` and on the SSR `/c/` page). Inherited status is never
  written to the character row, so un-starring the collection takes it off
  the characters too; a character's own flag always wins and carries
  `curataFrom` for the tooltip.
  The visible mark is a bare **laurel wreath** that inherits the surrounding
  text colour (`.curata-mark`) — deliberately not a coloured pill. It is
  painted as a CSS **mask over `currentColor`**, not as an `<img>`: an image
  would need a fixed fill and would go wrong on every surface that changes
  text colour (theme kits, draft bars, the dark topbar). The span it lives in
  is empty — the wreath *is* the element's background.
  Three details there are load-bearing. The element is `display: inline` with a
  left **padding** for its width, never an inline-block with a width: an
  inline-block is a line break opportunity, so on a narrow collection tile the
  wreath wraps onto a line of its own and leaves the hairline stranded at the
  end of the line above (this was measured, not guessed — it is the same
  reasoning as `.coll-mark-sep` below). Its size is a **fixed 15px**, not a
  multiple of the surrounding text: the wreath is *outlined*, and its leaves
  need about that much room before the strokes between them fall below a pixel
  and smear the whole thing into a ring — scaled to the text it would land at
  11px on a collection tile. `font-size` sets the height (an inline box takes
  its height from the font's content area) and `padding-left` the width, so the
  two always move together. The one cost is that a 15px mark on 12.8px tile
  text raises that line box by ~3px; every tile in a grid row grows with it, so
  they stay aligned. And the wreath's SVG is inlined as a
  `data:` URI in styles.css, so it carries no `"`, `#` or `%`; the shape is
  generated, not hand-drawn — two mirrored branches of stem arc, leaves and a
  tied knot, re-tuned and re-emitted with `node migration/curata-wreath.js`
  rather than edited as path data. That script's `VIEWBOX` is deliberately
  tight around the artwork *including stroke*: the mark is drawn with
  `mask-size: contain`, so slack in the viewBox shows up as the wreath
  rendering smaller than the 15px it was asked for.
  On collection tiles the mark sits after the character count behind a
  hairline `.coll-mark-sep`.
  On a `/c/` page it sits at the end of the **Tags** row behind the same
  hairline (`.info-mark-sep`) — it is a mark, never a link, so it can't be
  mistaken for a clickable tag; a Curata page with no tags of its own
  shows an em dash (`.tag-none`) on the tags side. There is **no Status row
  in the character info box** any more: Curata is that wreath, and Partial
  is shown only to people who can act on it — the Worker renders a
  `.page-notice-partial` banner above the topbar (`partialNoticeHTML()` in
  worker.js) for the page's owner and admins, and nobody else. Scripts and
  collections still carry a Status row (`curataRow()` in render-page.js);
  they have no tags row to hang the wreath off.
  The **`<select>` on the dashboard is the one place with no mark** — an
  `<option>` cannot carry markup — so those read as plain words.

Only `curata` is stored (a boolean in the page's `data` JSON, writable
**only** through `POST /api/admin/curata` or the bulk action — every save
handler overwrites whatever the client sent with the stored value). Partial vs
Standard is derived on every read, so nothing ever needs migrating. If you add
a new almanac prose field to `render.js`, add it to `ALMANAC_LIST_FIELDS` /
`ALMANAC_TEXT_FIELDS` in `classify.js` too, or pages using it stay Partial.

`isPartial()` self-guards on `d.ability` so a collection or script can never
be flagged Partial — do not remove that check.

**Curata was called Starlight**, and the stored flag was called `starlight`.
Rows written before the rename still carry the old key, and **no D1 migration
was run**: `foldLegacyCurata()` in worker.js folds `starlight` into `curata` on
read, so every reader sees one name, and the next save of a row writes the new
key and drops the old one — the database migrates itself a page at a time.
Everything that parses a row's `data` blob itself, rather than going through
`parseData()`, has to call it; revision snapshots and the nightly R2 backups
predate the rename too and are restored through the same path, so **this stays
even once every live row has been rewritten**. The `activity_log` keeps its old
`starlight`/`unstarlight` action rows for the same reason — nothing writes them
any more, and the dashboard's action filter lists them so history stays
searchable. Anything else still saying "Starlight" on the wiki is *content*
(the "Travel by Starlight" collection, the `"starlight": false` keys in the
`migration/*-import.json` archives) and must be left alone.

**A character that misses `PUBLISH_REQUIREMENTS` cannot be published** (Fabled
excepted, above). `/api/character` silently saves it as a draft (and says what
is missing, via `editor-notices.js`), and `/api/publish` refuses.
`POST /api/admin/demote-incomplete` (old alias: `demote-no-icon`) sweeps pages
that went live before the bar was raised; the dashboard card scans first and
reports the count and the reasons before anything moves. Always dry-run it.
`POST /api/admin/curata-owner` ({username, dryRun}) grants Curata to
every character one account owns. `GET /api/admin/pages` also takes
`?collection={id}`, resolved through `resolveCollectionMembers()` — combined
with `?owner=none` and the `assign-owner` bulk action, that is how a whole
collection's unowned pages get handed to an account. Curata lifts a page out of Partial, so
this is how admin-written pages stop being hidden for want of a tag.

## Frontend conventions

- Pages fetch `characters.json` etc. and render client-side; `/c/` pages are
  the exception (SSR). Keep `esc()`-style HTML escaping for any user data.
- Clean URLs everywhere: internal links have no `.html` (Workers assets serve
  `/tags` for `tags.html` and redirect the `.html` form).
- Shared topbar markup is copied per page (no template system). If you change
  it, change it on **all** pages — use `scripts.html` as the canonical
  example. Behavior belongs in `site.js`, not inline.
- Teams: `townsfolk, outsider, minion, demon, traveller, fabled, loric` — always
  in that order. There is **no** single source of truth: the list is re-declared
  by hand as a `TEAMS` array or `TEAM_LABEL` map in `sao.js` (`TEAM_ORDER`),
  `render-page.js`, `card-filters.js`, `render.js`, `site.js`,
  `token-tool.js`, and inline in `all-characters/team/index/author/tag/profile/
  script/publish-script/script-view.html`, plus the `<select id="team">` in
  `create.html`/`edit.html`/`grimforge.html`, the `normTeam()` whitelist in `mass-upload.html`
  and `TEAM_COLORS` in `dashboard.html`. **Adding a team means editing every
  one of them.** `GOOD`/`GOOD_TEAMS` maps hold only `townsfolk`+`outsider`
  (drives the blue `.good` class) — Traveller/Fabled/Loric are in neither.
  `[[TOKEN]]` in howToRun/callout text renders as a reminder pill.
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
8. **`resolveJinxTarget()` in render.js is the only place a jinx target is
   worked out.** Order is: an explicit `slug` written by the jinx picker, then
   an official character (icon from roles.json, link to the official wiki),
   then a character on this wiki (its own art, link to `/c/{slug}`), then the
   committed `assets/icons/{slugid}.png` with onerror hiding it. Official
   deliberately beats this wiki: 291 of the ~320 jinxes on the site name an
   official character, and a homebrew page sharing a name (there is more than
   one "Sculptor") must not steal their link. Don't rename icon files.
9. `run_worker_first` now includes `/news/*` but **not** `/news` — the index is
   the static `news.html` and must stay that way, or the Worker swallows it.
10. Announcements, news bodies, wiki pages and custom boxes all go through
   `WikiRender` (`NewsRender.inlineFormat()` forwards to it), which escapes
   first and whitelists hrefs (http/https/mailto/site-relative only) and image
   paths. Never switch any of them to `innerHTML` with raw text, and never add
   a mark that emits an attribute the writer controls.
   `site.js` loads `render-wiki.js` **before** `render-news.js` — the news
   renderer is a wrapper and formats nothing on its own.
11. Worker env vars (`DISCORD_CLIENT_ID`, `RESEND_API_KEY`, …) are set in the
   Cloudflare dashboard, NOT in the repo, and MUST be type "Secret" — Git
   deploys delete dashboard vars of type "Text" (that once silently broke
   Discord login). `keep_vars = true` would also fix it but Workers Builds
   rejects that key (build fails in 0s) — don't add it to wrangler.toml.
   **The Discord sign-in health check is `GET /api/admin/discord-check`** (a
   card on the dashboard's Health tab): it asks Discord whether the client
   id/secret pair is still good and prints the exact callback URL that has to
   be registered. Run it after touching either side; it is the only way to
   see this break without a reader hitting it.
11a. **The Discord `redirect_uri` is pinned to `CANONICAL_ORIGIN`
   (`https://botchomebrew.wiki`) and must never be built from the request
   again.** Cloudflare answers on every hostname pointed at the Worker — the
   apex, `www.`, workers.dev, any preview name — and the OAuth routes used to
   derive their `redirect_uri` from `url.origin`. Discord only accepts a
   `redirect_uri` that is registered on the application **character for
   character**, so a reader who arrived on `www.` got a bare
   "Invalid OAuth2 redirect_uri" screen and could not sign in at all, while
   the apex kept working — the login was broken for some people and fine for
   others, with nothing in the repo to show for it. Now `/api/auth/discord`
   redirects any other hostname to the canonical one before the flow starts,
   and both the authorize call and the token exchange take their URL from
   `discordRedirectUri(env)` — one function, so the two can never disagree
   (Discord compares them and rejects a mismatch). If the domain ever moves,
   set `SITE_ORIGIN` (or `DISCORD_REDIRECT_URI`) as a Secret **and** add the
   new callback URL in the Discord Developer Portal → OAuth2 → Redirects in
   the same sitting. Adding a hostname needs no code change and no second
   portal entry — that is the point.
12. **Usernames carry their own letters — fadas included — and identity is
   `users.username_key`, never `lower(username)`.** `@tir-far-thóinn` keeps its
   fada; the account code was once ASCII-only and turned it into
   `@tir-far-th-inn`. Three helpers in worker.js: `normUsername()` (NFC + trim,
   what gets STORED and displayed), `usernameKey()` (`foldLatin()` then
   lower-case, what gets COMPARED) and `foldLatin()` (NFD minus the combining
   marks, plus a small map for ø/æ/ß). `username_key` is a lazily-ALTERed
   UNIQUE column, backfilled in JS, and **every lookup goes through
   `selectUserByName()`** — do not write `lower(username)=lower(?)` again. D1's
   SQLite has no ICU, so `lower('Ó')` is `'Ó'`: comparing handles in SQL would
   make `Tir-far-thÓinn` and `tir-far-thóinn` two accounts with one name.
   Folding the accents *into* the key does three jobs at once — the case fold
   SQLite cannot do, "type it with or without the accent and you still find the
   account", and a block on registering the near-identical `@tir-far-thoinn`
   beside `@tir-far-thóinn`. `mixesScripts()` refuses a handle that mixes Latin
   with another alphabet (one Cyrillic `е` inside a Latin name is impersonation
   the key cannot fold away); a wholly Greek or wholly Han handle is fine, and
   `uniqueUsername()` applies the same rule to Discord display names. Any new
   place that turns a typed name into a handle needs all of this, which is why
   it should call the existing helpers rather than roll its own.
   **The handle is not the name people know themselves by.** A Discord signup
   is handed `@scape` while the whole site calls them Cellscape (the Discord
   display name), so logging in with "the name I see everywhere" failed and
   read as a broken login. `findUserByLogin()` therefore tries username, then
   email, then `findUserByShownName()`: `display_name` and `discord_username`,
   folded through `usernameKey()`, and **only when exactly one account
   matches**. That order is the safety rule: a handle or an email always beats
   somebody else's display name, and a display name two people share matches
   nobody. Do not reorder it, and do not relax the uniqueness check.
13. **Writing to D1 directly bypasses `bumpContentVersion()` — bump
   `settings.content_version` yourself.** The JSON feeds and several in-isolate
   caches are keyed on that counter, so a row written straight to the database
   (dashboard, API, MCP) is served from a stale cache until it happens to
   expire, and the staleness does not look like caching. Importing a collection
   without bumping left it out of `collections.json`, so `linkAppearsIn()` in
   charpage.js found no match and every one of its characters showed "Appears
   in" as plain text instead of a link. Granting that collection Curata
   without bumping left `_curataCollCache` holding the pre-Curata list, so
   `applyCollectionCurata()` lent the status to none of its members while the
   collection itself already read as Curata. Both looked like bugs in the
   feature and were neither. One
   `INSERT INTO settings (key,value) VALUES ('content_version','1') ON CONFLICT
   (key) DO UPDATE SET value = CAST(CAST(settings.value AS INTEGER) + 1 AS TEXT)`
   after the write is the whole fix.
