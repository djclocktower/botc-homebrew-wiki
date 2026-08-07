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
- `GET /c/{slug}` (characters), `GET /s/{slug}` (scripts) and
  `GET /collection/{id}` (collections) are all **server-side rendered** by the
  Worker from D1. Characters use `assets/render.js`; scripts/collections use
  `assets/render-page.js`. Both are bundled into the Worker via `import` and
  share the `pageShell()` HTML frame. There are **no static per-entity pages**.
  The `.html` form 301-redirects to the clean URL. Legacy `/script-view?s=`
  301-redirects to `/s/{slug}`. **Collection URLs use the kebab `id`**, not the
  PK `slug` (legacy rows have display-string slugs like `"The Academy"`);
  `findCollectionRow()` resolves either.
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
  `/api/admin/news`), admin tools (dashboard, full activity log, report,
  revisions/rollback, comment moderation, Starlight, wiki lock, backup, seed).
  Writes are ownership-checked (`owner_id`, admins bypass). All routes are
  listed in the header comment of `worker/worker.js`.
  A character's URL **and its R2 art slot** are both derived from its name, so
  both editors ask `GET /api/slug-check` before uploading anything and take the
  first free URL automatically, in the wiki's existing duplicate style
  (`illusionist-megalomania`, `witcher-odyssey`, then `-2`, `-3`). No prompt,
  no dialog — the character keeps its name, the page just gets its own address.
  A URL that is only *parked* by a redirect counts as taken. The Worker is
  still the enforcer — the check only decides which slug the editor asks for.
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
                       for SSR — must stay browser+module compatible, no DOM at
                       top level. Takes the wiki text engine through
                       init(WikiRender) for the one formatted character field,
                       `pronunciation` — the quiet line under the flavour quote
                       (**bold**/*italic*); without it that text still renders,
                       escaped and unformatted.
  charpage.js          /c/ page enhancements (edit button, add-to-script/token)
  tags.js              Canonical tag list + descriptions + hover tooltips +
                       tag-picker builder. Adding a tag = edit ONLY this file.
  render-page.js       Shared script+collection page renderer (synopsis, gameplay,
                       roster, jinxes, night order, credits, infobox, JSON export,
                       theming). Browser+Worker like render.js; init(Render) injects
                       render.js's exports. resolveCollectionMembers() (hybrid
                       match[]/include[]/exclude[]), sanitizeTheme(), FONT_PRESETS.
                       Also renderRosterCards() + filterBoxHTML(), reused by the
                       creator page so its cards match a collection page's.
  card-filters.js      The collapsed filter box (3-state team/tag chips, Show
                       Partial, Starlight only, creator, sort). mountCardFilters()
                       wires one box to one grid; auto-mounts on SSR collection
                       pages, and profile.html mounts its own. Reads the card
                       data-* attributes renderRosterCards() writes — one filter
                       implementation, not one per page.
  classify.js          Partial / Standard / Starlight rules — SINGLE SOURCE OF
                       TRUTH. hasIcon/hasAlmanac/isPartial/classifyPage, the
                       badge builder, and the Starlight weighting used by
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
                       Browser + Worker. Used by /p/, news, custom boxes and
                       (through render-news) the announcement banner.
  render-news.js       News article shape (head, hero, cards) around
                       render-wiki.js; re-exports inlineFormat() because
                       site.js lazy-loads it for links in announcements.
                       In the Worker it gets the engine through init().
  editor-notices.js    Post-save modals for create/edit: "this page is Partial"
                       and "saved as a draft because there's no icon".
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
                       no night order, which is why this is separate.
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
  iconforge/           Icon Forge (/iconforge) — the whole tool, as ES modules.
                       engine.js is the handoff's iconEngine.ts with the types
                       stripped; app.js is the wiki's own UI controller (the
                       React app's Home/ControlPanel/PreviewStage rebuilt in
                       vanilla JS); editor.js frames the vendored miniPaint;
                       textures.js, source.js, bgremoval.js are the small libs.
                       Subfolders textures/ samples/ minipaint/ vendor/ are the
                       sealed payload — see the section below, and
                       migration/icon-forge-guide.md for the engine reference.
  icons/               Official BotC role icons (never change; long-cached)
  art/, collections/, scripts/  Committed images (new uploads go to R2)
  fonts/, pyodide/, tokens/     Fonts; Token Tool engine (Pyodide) + assets
index.html             Homepage (collections grid, scripts, browse cards, sidebar).
                       Featured Character rotates **Starlight pages only**,
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
publish-script.html    Script publishing page: name/author/tagline/version/
                       difficulty/description + wiki sections (synopsis, gameplay,
                       strategy) + theme kit (logo/background/font/colors), header,
                       SAO sort (localStorage botc_script_meta). Publish + Save as
                       Draft (/api/script status=draft|published), ?s={slug} edit.
publish-collection.html Collection maker/editor (replaces register-/edit-collection,
                       now redirect stubs). Same fields as publish-script + hybrid
                       membership manager (match terms + manual include/exclude).
                       Publish/Draft via /api/collection; ?c={id} edit mode.
publish-page.html      Custom wiki page editor (/p/): title/subtitle/blurb/author,
                       markdown-ish body with toolbar + live preview, banner and
                       body images (R2 pages/), fact box, custom boxes, theme kit,
                       contents + comments toggles. ?p={slug} edits,
                       ?parentType=&parentSlug= starts a new one.
news.html              /news index (client-rendered from /api/news)
publish-news.html      Admin-only news editor: the same kit as publish-page
                       (toolbar, images, boxes, fact box, theme) plus
                       summary/hero/pin, and preview/publish/delete
scripts.html, script-view.html (legacy; /s/ is SSR now), create-script.html (→script), edit-script.html (→publish-script)
tools.html             /tools — the toolbox hub: Script Builder, Token Tool,
                       Grimoire Forge, Icon Forge, Creator Icons. This is what
                       the "Tools" nav entry points at.
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
drafts.html            /drafts — your own unpublished pages as cards (the same
                       renderRosterCards markup the browse and collection pages
                       use, with the shared filter box). Characters come from
                       /api/account, enriched from characters.json?drafts=1 when
                       the reader is an admin; scripts/collections/wiki pages
                       have no card art so they get a plain tile. Linked from
                       the Your Drafts panel on the account page, which keeps
                       its own table — the two are deliberately both there.
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
inbox — NOT user DMs), `dms` + `dm_blocks` + `dm_reports` (user↔user direct
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
a renamed page used to live at — see "Renaming a character" below), and a
lazily ALTERed `users.banned` column. `settings` also holds
`announcement` (site-wide banner JSON) and `protected:{type}:{slug}` keys
(admin page protection — only admins may edit/publish/delete those pages).
Bans and admin promote/demote take effect immediately: POST requests and
admin GETs re-read `is_admin`/`banned` from D1 instead of trusting the
30-day session cookie. Content tables use the **hybrid JSON blob** design: a few
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
Both also take `customBoxes[]` — the same `{title, content}` widget as the
character pages, rendered through render-wiki.js so a box can hold a list, a
link or a `[[Character Name]]`. Every one of these is length-capped and
theme-validated server-side in `sanitizePageFields()` (worker.js). `theme` is `{font, accent, panel, text,
link, background}` — colors must be `#rrggbb`, font a `FONT_PRESETS` key,
background only the entity's own `{scripts|collections}/{key}-bg.{ext}` slot;
`sanitizeTheme()` drops anything else and it's applied as CSS custom properties
on `<body>` (never raw CSS). Seeded collections have `owner_id NULL` — admins
assign an owner via the dashboard (`/api/admin/assign-owner`) so a user can edit.

## Renaming a character (the old link keeps working)

A character's URL is built from its name, so `edit.html` renames the page when
the name changes: it works out the URL the new name wants, asks
`/api/slug-check` for a free one, and posts `renameFrom` alongside the save.
`renameCharacter()` in worker.js does the move, and **everything that points at
the page moves with it** — comments, `page_views`, `revisions`, the activity
log, admin protection, the art objects in R2 (and the `art`/`image` paths in
the row), the roster slugs inside `scripts.data.characters`, collection
`include[]`/`exclude[]`, and profile pins. Add any new place a character slug
is stored to `rewriteSlugRefs()`, or a rename will silently drop the page out
of it.

The old slug is kept in the `redirects` table and `/c/{old}` **301s** to the
new page forever — bookmarks, Discord posts and forum links must not rot.
`/api/page` follows a redirect too, so `edit?c={old}` still opens the editor.
Renaming A→B→C leaves A *and* B pointing straight at C (no chains), and a slug
that becomes a live page again stops being a redirect. Details worth keeping:

- Rename only fires when the **name actually changed** in that editing session
  (compared against the loaded row, not against the slug) — otherwise every
  save of `sculptor-fall-of-rome` would try to move it to `sculptor`.
- A disambiguating suffix is **preserved**: "Sculptor" at
  `/c/sculptor-fall-of-rome` renamed to "Stonecutter" becomes
  `/c/stonecutter-fall-of-rome`.
- A name that slugifies to nothing (a fully non-Latin name) never renames.
- A rename never moves a page onto a live URL, **including one of your own**
  (`mine` from slug-check is not a free pass here, unlike on the create page).
- When a rename and an art upload happen in the same save, the **row moves
  first** — the move carries the old art to the new slot, so new art has to
  land after it or it gets overwritten. `edit.html` orders it that way.

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
- **Smart AI runs in a Web Worker** (`bg-worker.js`) and must stay there. The
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
  that patch on any upgrade or Smart AI dies. The ONNX wasm (~12 MB) and the
  model (~44 MB) are fetched from imgly's CDN on first use; they can never be
  committed (the model alone exceeds Cloudflare's 25 MiB per-asset limit and
  would fail the whole deploy). If that fetch fails the tool toasts and falls
  back to "Keep".
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
- Textures, samples and the editor are pinned content and cached `immutable`
  in `_headers`; the tool's own `.js` modules — and `vendor/`, which carries
  that local patch — are deliberately left on the site-wide revalidate rule so
  a change shows on a normal refresh.

## Page classification (Partial / Standard / Starlight)

`assets/classify.js` is the **single source of truth**, shared by the browser
and the Worker (which stamps `classification` + `starlight` onto every row in
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
- **Starlight** — admin-only, on characters, collections **and** scripts.
  Weighted `STARLIGHT_WEIGHT` (5×) in Featured, `/random` and the homepage
  strips, and filterable on its own (a "Starlight only" chip on All
  Characters, All Collections and Scripts).
  A Starlight **collection lends the status to every character in it**
  (`applyCollectionStarlight()` in worker.js, applied on read in
  `buildPublicJSON` and on the SSR `/c/` page). Inherited status is never
  written to the character row, so un-starring the collection takes it off
  the characters too; a character's own flag always wins and carries
  `starlightFrom` for the tooltip.
  The visible mark is a bare `✦` that inherits the surrounding text colour
  (`.starlight-star`) — deliberately not a coloured pill. On collection
  tiles it sits after the character count behind a hairline `.coll-star-sep`.
  On a `/c/` page it sits at the end of the **Tags** row behind the same
  hairline (`.info-star-sep`) — it is a mark, never a link, so it can't be
  mistaken for a clickable tag; a Starlight page with no tags of its own
  shows an em dash (`.tag-none`) on the tags side. There is **no Status row
  in the character info box** any more: Starlight is that star, and Partial
  is shown only to people who can act on it — the Worker renders a
  `.page-notice-partial` banner above the topbar (`partialNoticeHTML()` in
  worker.js) for the page's owner and admins, and nobody else. Scripts and
  collections still carry a Status row (`starlightRow()` in render-page.js);
  they have no tags row to hang the star off.

Only `starlight` is stored (a boolean in the page's `data` JSON, writable
**only** through `POST /api/admin/starlight` or the bulk action — every save
handler overwrites whatever the client sent with the stored value). Partial vs
Standard is derived on every read, so nothing ever needs migrating. If you add
a new almanac prose field to `render.js`, add it to `ALMANAC_LIST_FIELDS` /
`ALMANAC_TEXT_FIELDS` in `classify.js` too, or pages using it stay Partial.

`isPartial()` self-guards on `d.ability` so a collection or script can never
be flagged Partial — do not remove that check.

**A character that misses `PUBLISH_REQUIREMENTS` cannot be published** (Fabled
excepted, above). `/api/character` silently saves it as a draft (and says what
is missing, via `editor-notices.js`), and `/api/publish` refuses.
`POST /api/admin/demote-incomplete` (old alias: `demote-no-icon`) sweeps pages
that went live before the bar was raised; the dashboard card scans first and
reports the count and the reasons before anything moves. Always dry-run it.
`POST /api/admin/starlight-owner` ({username, dryRun}) grants Starlight to
every character one account owns. `GET /api/admin/pages` also takes
`?collection={id}`, resolved through `resolveCollectionMembers()` — combined
with `?owner=none` and the `assign-owner` bulk action, that is how a whole
collection's unowned pages get handed to an account. Starlight lifts a page out of Partial, so
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
8. Jinx icons resolve by slugified id against `assets/icons/`; missing icons
   hide gracefully via onerror. Don't rename icon files.
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
