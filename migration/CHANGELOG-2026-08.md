# Changelog — since 11 August 2026

Two sections: what is **live** (merged to `main`, deployed), and what is
**pending** on the unmerged jinx update branch (PR #79,
`claude/jinx-update-bug-test-nskew5`, which contains PR #64's work).
Small bug fixes are omitted.

---

## Live on the site

### Tags
- **Nine new character tags.** Confirmation, then False Info, True Info,
  Sober & Healthy, Grim Peeker, Demonsbane, Extra Evil, Binary Info and
  Subjective Info — added to `assets/tags.js`, so they appear on `/tags`,
  the browse filters and both editors' tag pickers automatically.

### Editors and publishing
- **Duplicate names never overwrite a page any more.** The mass uploader,
  `publish-script.html` and `publish-collection.html` now resolve a free URL
  through `/api/slug-check` before uploading anything. A character keeps its
  name and gets its own address (`witcher-odyssey`, then `-2`, `-3`); a
  script or collection being *created* never lands on an existing URL, not
  even one of your own. The mass uploader also tracks the slugs its own run
  has taken, so two same-named characters in one file make two pages.
- **Official `special[]` flags are carried through.** `setup` was the only
  behaviour flag the wiki understood; "cannot go in the bag", the grimoire
  signals and the rest were dropped on import and missing from the wiki's own
  JSON export. Now imported, editable by hand in both character editors
  through a new repeater, and validated and exported by `render.js`.
- **Authors can arrange a roster by hand.** Collections store an `order[]` of
  slugs (separate from membership); scripts already ordered `characters[]` and
  now get the same ▲▼ controls, with unknown roster slugs carried along rather
  than dropped. The editor's list is the list the page draws.

### Reading and browsing
- **Steven Approved Order and Page order** added to the filter box on
  collection and creator pages. Collection pages default to Page order, so an
  author's arrangement is what a reader sees first.
- **The card feed no longer hid finished characters.** The trimmed
  `?fields=card` feed dropped the very fields `isPartial()` reads, so 17
  complete pages (The Matchmaker and Baron (Traveller) among them) were
  filtered out of All Characters, the team/tag pages and Recently Added. The
  Worker now stamps `standard` on trimmed rows instead of leaving it to be
  recomputed.

### News
- **News articles are editable from the article.** A published `/news/{slug}`
  gained an Edit button (`assets/newspage.js`, admin-gated), `/news` shows each
  article's state with an Edit link for admins, and the editor's draft button
  reads **Unpublish** on a live article instead of "Save as Draft".
- **Body images in news articles work.** The text engine's image whitelist was
  missing `news/`, the folder the news editor uploads into, so every body and
  fact-box image was silently dropped.

### Admin and accounts
- **Admins can reply to contact-form messages.** `POST /api/admin/message`
  takes `{action:'reply', body}` and delivers the answer as a DM from that
  admin, so it rides the unread count, the mail flag on "My Account", and can
  be replied to. Previously a bug report was a dead end for whoever sent it.
- **Write rate limits sized for real imports.** 60 uploads / 40 characters an
  hour was used up by an ordinary 30-character collection; now 400 uploads,
  200 characters, 200 publishes (scripts/collections/wiki pages 20 → 40). The
  importer also stops cleanly on a 429, says how many landed and what is left,
  and skips already-created pages when you press Create All Pages again.

### Content imported
| Collection / script | Characters |
|---|---|
| Circus Music (collection) | 35 |
| Charged Dinner (script) | 26 |
| Of Manors & Mayhem (collection) | 34 |
| The Potato Patch (collection) | 153 |
| High Seas of Mutiny (script + collection) | 30 |
| The Bazaar (collection) | — |
| The Princess' Requiem (script) | 30 |
| The Last Cull (script) | 34 |

---

## Pending — the jinx update branch (not deployed)

### Jinxes
- **Jinxes between wiki characters work like official ones.** They rendered as
  a raw slug with no icon and a dead link to the official wiki;
  `resolveJinxTarget()` is now the single answer for every consumer (official
  characters keep precedence). A `/c/` page also shows jinxes that *other*
  characters declare with it, from a cached `jinxIndex()` keyed on
  `contentVersion` — no new table.
- **The jinx field is a search picker** over both rosters in both editors, so a
  typo can no longer point a jinx at nothing. The editors warn when the other
  character already describes the same pair.
- **`/jinxes`: every jinx on the wiki, plus a connection map.** Hand-rolled SVG
  with a small spring layout (no CDN dependency), stable across visits.
  Click to focus, drag, zoom, search, A–Z jump strip, filters for wiki-only /
  official-only / by creator, reset layout, `?c={slug}` deep links, and
  "link two characters" to add a jinx from the map. Base-game jinxes
  (71 pairs) are an opt-in layer.
- **Per-script jinx edits.** A script can carry `jinxEdits{off[],add[]}` to
  drop a jinx or write a rule that only holds there, without writing back to
  the characters. Script and collection pages also flag jinxes with official
  characters on the same script, which were previously invisible.
- **Jinx health report** (admin, dashboard card): jinxes pointing at nothing,
  and pairs where both characters wrote a rule so one wording is invisible.
- Jinx rule text now goes through the wiki text engine (`**bold**`,
  `[[Character Name]]`), escaping unchanged.

### Public editing
- **Four "Who can edit" modes** on characters, scripts and collections: only
  me, tags only, suggested edits, or open to anyone with an account.
  `editPermission()` is the single answer in the Worker; drafts,
  admin-protected pages and pages nobody opted in are never open, and a guest
  can never rename, publish, delete or unpublish. Owners are notified through
  the same DM row comments use.
- **Suggested edits** (`/suggestions`): propose a whole version with a note,
  the creator sees a field-by-field diff against the page as it stands and
  Approves or Declines with a reply. Approving is an ordinary save, so it
  snapshots and can be rolled back. Art inputs are disabled for a suggester.
- **Page history** (`/history?type=&slug=`): the revisions table finally has a
  page — every edit, who made it, which fields changed, before/after text, and
  "Put this version back" for the owner (itself undoable). Public on published
  pages, owner-only otherwise. Drafts are not tracked; kept revisions 20 → 50.

### Script tools
- **Official characters in the Script Builder and on script pages**, told apart
  by a Source chip and linking to the official wiki. Randomize stays
  homebrew-only.
- **Night order the owner controls.** Official characters finally have wake
  positions (`assets/official-roles.js` merges `roles.json` with
  `night-order.json`); a script stores `nightOrder{first[],other[]}`, edited
  through one shared widget (`assets/night-order-editor.js`) on both the
  builder and the publish page, with drag as well as ▲▼. Who acts is still
  never a choice.
- **The Add sidebar gained the full filter box** — team and tag chips, creator,
  sort, Curata — with the name box wired in as its search.
- **The exported JSON now says everything the official app reads**
  (background, hideTitle, almanac, bootlegger house rules, night order as
  id sequences). House rules also show on the script page.

### Elsewhere
- **A custom 404 page.** A miss used to hand back Cloudflare's blank Not Found.
  It now serves the wiki's own page at the address that failed, with the broken
  URL, a "Did you mean…" list matched by edit distance, quick links, and a
  report-to-admins box (`POST /api/report-broken-link`) that works without an
  account and lands in the dashboard inbox.
- **Starlight is rebranded Curata**, with a laurel wreath in place of the star
  (a CSS mask over `currentColor`, so it still inherits text colour; fixed at
  15px). The stored flag moves `starlight` → `curata` with no migration —
  `foldLegacyCurata()` folds the old key on read, permanently, so revisions
  and R2 backups restore correctly.
- **Icon adjuster** (`assets/art-adjust.js`): "Adjust by hand" beside "Resize
  icon" in both character editors — drag, zoom, rotate, start over, working
  from the file as picked so zooming stays sharp.
- **Log in with the name the site shows you.** A Discord signup was called by
  their display name everywhere but could only log in with the derived handle.
  Display name and Discord username now work as identifiers when exactly one
  account matches; username and email are still tried first.
- **The live preview no longer flashes black.** The editor preview iframe was
  rebuilt on every keystroke; it is now written once and patched in place
  (shared as `assets/char-preview.js`), so scroll position holds too.
- Smaller ones: "Appears in" fills itself in from manual collection membership,
  `[text](example.com)` becomes an https link, script and collection pages
  carry an in-page Edit button for those who may use it, and the account
  page's Your Recent Edits collapses to the newest 10.
