# Import plan: The Menagerie (by Goodpart)

Source: https://sites.google.com/view/botcmenagerie — "A homebrew almanac for
the board game Blood on the Clocktower", by **Goodpart** (Discord
`@Goodpart`). The site's JSON files and images are served from
**menagerie.towerrangers.net**. Current version: **1.17** (4 August 2026).

Ground rule for this whole import, set by the wiki's owner: **every word on
the imported pages comes from the site or its JSON files. Nothing is written
by us.** Where that leaves a wiki field empty, it stays empty, and the
consequences are called out below rather than papered over.

---

## 1. What is out there (survey)

### The master JSON — `The Menagerie 1.17.json`

**83 characters**, all with `name`, `team`, `ability`, `flavor` and art:

| team | count |
|---|---|
| Townsfolk | 31 |
| Outsider | 14 |
| Minion | 16 |
| Demon | 14 |
| Traveller | 3 (Mad Scientist, Tactician, Taxidermist) |
| Fabled | 2 (Peanut Gallery, Mercy Society) |
| Loric | 3 (Pyro, Parasitoid, Santa Claus) |

Also in the file: night positions and reminder text (41 first-night, 62
other-night), reminder tokens (61 characters), `setup` flags, **38 characters
carrying 111 jinxes** (targets are a mix of official characters and other
Menagerie characters), and **8 characters with `special[]`** behaviour flags
(bag-disabled, bag-duplicate, grimoire signals, Pyro's day-pointing ability).
`_meta` carries the set name, author, logo (`unnamed.png`), background
(`cockatrice2 copy.jpg`) and the almanac link.

### The almanac pages (the site itself)

**78 of the 83 characters have their own page** on the Google Site, in a
fixed shape that maps almost one-to-one onto this wiki's character page:

- flavour quote (some carry "(Additional credit: …)" inline)
- **ABILITY**
- **STORYTELLER NOTES**
- **"Playing as the X"** + an Example
- **"Bluffing as the X"** (good characters) or **"Fighting the X"** (evil
  characters) + an Example
- **Jinxes** (when any)

A ⭐ on the index pages marks a character as play-tested.

**5 characters exist only in the JSON** — Present Peeker, Party Pooper,
La Befana, Krampus and Santa Claus, the cast of an unlisted holiday script
("Secret Satan"). They have flavour + ability + mechanics and no almanac
prose. (Checked: no hidden pages for them.)

### Art

Most characters have **two icons** (regular + flipped) and the three
travellers have **three** (unaligned / good / evil) — exactly this wiki's
three art slots, in the same positions, so nothing needs re-interpreting.
The three Loric characters carry `image` as a plain string rather than an
array (normalised during import). All art is on menagerie.towerrangers.net.

### Scripts

**22 scripts are published on the site's Scripts page**, each with a
one-to-two-paragraph description and a JSON download: Game Changer, Balance
in All Things, Belly Up, Sweet Nothings, Are We... the Bad Guys?, Resident
Evil, Shadow of the Colossus, In Death – Is Life, Tag You're It, When the
Music Stops, Tick Tock, True Colours, Way of the Samurai, Choose Your Own
Adventure, Firestarter, The Fix Is Sin, Secret Ballot, Who Do You Think You
Are?, Wispr In The Wind, The Imperial Palace, Stayin' Alive, Switcheroo.

Each script JSON's roster mixes **bare official ids** (chef, lleech, …) with
full Menagerie entries, and its `_meta` carries a logo, a background,
`hideTitle`, a `bootlegger[]` house rule, the almanac link and **arranged
first/other night orders** — all things this wiki's script pages already
store and render.

The repo folder also holds **5 unlisted script JSONs** (Secret Satan, Host
with the Most, Out and About, Star-Crossed, The End Is Not Death) plus old
versions of everything. The site does not present these.

### The rest of the site

- **Community Scripts**: empty (a placeholder template, no scripts yet).
- **Development Log**: one entry reading "Coming soon!" — no content.
- **How To**: instructions for the official script tool, not Menagerie
  content.
- **Home**: the intro text, the version history, acknowledgments, and the
  licensing note — *"These characters are provided 'as-is', freely available
  to anyone who wishes to use them. If you wish to retool these characters,
  please ask me prior to any edits."*

---

## 2. What it becomes on this wiki

### One collection

**The Menagerie** at `/collection/the-menagerie`:

- name + author from `_meta`; creator **Goodpart**
- synopsis = the site's own introduction text, verbatim
- logo and background from `_meta`, copied into the collection's own R2 slots
- membership: `match` on "The Menagerie" **and** `include[]` of all 83
  identities (belt and braces — membership survives even if an `appearsIn`
  line is later edited)

### 83 character pages

Each imported via `POST /api/character` (the one door every import goes
through, so the official-character guard, jinx sanitising and `special[]`
validation all apply automatically). Field mapping:

| the site / JSON | this wiki | note |
|---|---|---|
| name, team, ability | name, team, ability | `traveler` → `traveller` via `normTeam` |
| `flavor` | the quote | "(Additional credit: …)" kept verbatim |
| ABILITY (page) | — | same text as JSON `ability`; JSON wins |
| STORYTELLER NOTES | `howToRun` | renders as "How to Run" |
| "Playing as the X" | `tips` | renders as "Tips & Tricks" — closest existing section; the text itself is untouched |
| "Bluffing as the X" | `bluffing` | the wiki renders this heading **verbatim** ("Bluffing as the {Name}") |
| "Fighting the X" | `fighting` | same — exact heading match |
| the Examples | `examples[]` | the wiki's Examples section |
| night data, reminders, setup, `special[]` | same fields | pass-through |
| `jinxes` | `jinxes` | see below |
| `image[0..2]` | art slots 1–3 | positions already match (traveller = unaligned/good/evil) |
| — | `creator: "Goodpart"`, `appearsIn: "The Menagerie"` | from `_meta` |

**What stays empty, and what that means.** The site has no flavour-line
*lede*, no summary bullets and no tags, and we may not write any. By
`classify.js` rules every imported character will therefore read as
**Partial** — visible at its own URL, on the creator page and in the
collection, but hidden from All Characters / team / tag pages unless the
reader ticks "Show Partial". That is the honest outcome of "only their
words". Section 4 lists the levers if you want them surfaced anyway.

**Name clashes.** 31 of the 83 names already exist on this wiki (Banker,
Martyr, Ronin, Shogun, Arbiter, …). This is routine: `/api/slug-check`'s
duplicate ladder gives each its own identity, and because every page carries
`appearsIn: "The Menagerie"`, `characterQualifier()` files them all at
**`/c/the-menagerie/{name}`** — the set nesting exists for exactly this.

**Jinxes.** The 111 jinx rows are imported as stored. Official targets
(alchemist, general, …) resolve to the official wiki as always. In-set
targets are the reason "Appears in" must be filled during the import run:
the set-qualified jinx resolution (`jinxQualKeys`/`jinxLookupKeys`) is what
keeps "Firebug" pointing at *the Menagerie's* Firebug rather than a
same-named page from another set. The mass-upload jinx warning already
reports the handful of genuinely ambiguous cases before anything is written.

**Official-character check.** No Menagerie ability matches an official one
(they are original designs), and `/api/character` enforces the exact-match
refusal on every save regardless.

### 22 script pages

One `/s/` page per published script:

- name + author from `_meta`; synopsis = **the Scripts-page description,
  verbatim**
- roster: Menagerie entries → the identities created above; bare official
  ids → `off-{id}` (links out to the official wiki, as script pages already
  do)
- `_meta.firstNight`/`otherNight` → the page's arranged `nightOrder`
  (dusk/dawn/minion-info/demon-info markers dropped from storage — the
  export re-adds them via `setNightMeta`, per the night-order rules)
- `hideTitle`, `bootlegger[]` (renders as House Rules), `almanac` → the
  "In the Official App" fields
- logo + background copied into each script's own R2 theme slots

The two ambiguous filenames resolve to what the site links: `Are We... The
Bad Guys_.json` and `When The Music Stops(1).json` are the current versions.

### Deliberately not imported

- The **5 unlisted script JSONs** (incl. Secret Satan) — the author has not
  published them on the site; their holiday characters still arrive via the
  master JSON. (Reversible: they can be imported later in one small run.)
- **Development Log** ("Coming soon"), **How To** (about the official script
  tool), **Community Scripts** (empty).
- The ⭐ tested markers — no wiki field means "tested", and inventing one is
  out of scope.

---

## 3. How the import runs

**Phase 0 — a message to Goodpart (recommended).** The site says the
characters are freely available, but also "please ask me prior to any
edits". A short Discord message saying the wiki would like to mirror the
Menagerie with full credit — and that they can claim the pages with an
account later — costs nothing and matches how this wiki treats creators.
Their "ask before edits" note also argues for leaving `publicEdit` closed
(the default).

**Phase 1 — scrape and build (Claude, in this repo).** A one-off script,
`migration/menagerie-scrape.js`, fetches the master JSON, crawls the five
category index pages for the real almanac URLs (crawled, never guessed),
scrapes each character page, and merges everything into two archives
committed alongside the repo's other `*-import.json` files:

- `migration/menagerie-import.json` — the 83 characters, official schema
  plus the wiki's prose fields filled from the almanac pages
- `migration/menagerie-scripts-import.json` — the 22 scripts with their
  descriptions and `_meta`

Text handling in the scraper: Google Sites boilerplate stripped; emphasis
converted to plain text exactly as the Bloodstar importer does (character
fields take only the links-only mark subset — typed asterisks would print);
`image` strings normalised to arrays; `traveler` → `traveller`. The
`:reminder:` markers in some night reminders are stripped the way
`official-roles.js` strips them from the official ones (formatting artifact,
not content) — flagged as a decision below in case you'd rather keep them.

**Phase 2 — two small code changes (Claude).**

1. **`mass-upload.html` learns to pass prose through.** Its `createOne()`
   builds a fixed entry; ~10 lines let it carry `lede`, `howToRun`, `tips`,
   `bluffing`, `fighting`, `examples` and friends when the file has them.
   Official-schema files never do, so nothing changes for normal use — and
   every future rich import benefits. (`/api/character` already stores any
   field posted; this is the hybrid-JSON design working as intended.)
2. **Art into R2.** mass-upload fetches art through a canvas, which needs
   the source host to send CORS headers — untestable from this sandbox, to
   be checked at implementation. If towerrangers.net allows it, nothing to
   build. If not: a small admin-only server-side copy in the Worker, modeled
   on `/api/bloodstar-art` (same `uploadSlotDenied()` permission check) with
   menagerie.towerrangers.net on a pinned host allowlist — so ~200 images
   land in R2 without round-tripping through a phone, and the art survives
   if towerrangers.net ever goes away. Fallback either way: the absolute
   URLs, which bulk imports have always been allowed to keep.

For the **22 scripts** there are two options:

- **A (recommended): a one-off runner** — a small admin page modeled on the
  `/bloodstar` runner that loads the two committed archives and imports
  characters → collection → scripts in order, with a progress table and
  resume (re-running updates its own pages, the mass-upload rule). One
  click for you; the page is removed after the import.
- **B (zero new code): by hand** — characters through the extended
  mass-upload, then each script via Script Builder Import → publish-script
  with the description pasted in. Works, but is ~22 rounds of mobile form
  work.

**Phase 3 — the run (you, logged in as admin).** Order matters and the
runner enforces it: characters first (with "Appears in: The Menagerie" set,
which settles the jinxes), then the collection, then the scripts. Everything
goes through the public API, so rate-limit handling, `content_version`
bumps, the official guard and revision history all come for free.

**Phase 4 — the after-pass (one dashboard sitting).**

- **Pin the creator name**: the import account will own every page credited
  to "Goodpart", so proof-by-ownership would 302 `/author?a=Goodpart` to the
  admin profile — the documented bulk-import trap. One
  `creator_alias:goodpart` row (set from the admin box on the creator page)
  gives Goodpart their own creator page; if they later make an account, the
  same box links it and `assign-owner` hands the whole set over, characters
  included, via the waterfall.
- Run the **Jinx health** dashboard card; spot-check a few pages, the
  collection roster, one script's night order and JSON export.
- Confirm the Partial decision from section 4.

---

## 4. Decisions for you

1. **Scripts** — import all 22 published ones? (Recommended: yes — each is
   one roster + one verbatim paragraph, and they give the characters their
   script context.) The 5 unlisted JSONs stay out unless you say otherwise.
2. **Partial visibility** — the imported characters will be Partial (no
   tags, no lede, no summary — the site has none and we write nothing).
   Options, none of which add our words to pages:
   - leave them Partial (default; "Show Partial" reveals them, and the
     collection + creator pages show everything regardless);
   - grant **Curata** to the collection or selected characters (admin's
     call; lifts pages out of Partial);
   - set **`publicEdit: 'tags'`** on the set so readers can supply tags
     (the `tags-open-owner` bulk tool does exactly this);
   - ask **Goodpart** for short blurbs/tags — author's words, not ours.
3. **Contact Goodpart first?** Recommended yes (Phase 0).
4. **Art** — copy into R2 (recommended) or keep hotlinking
   towerrangers.net.
5. **`:reminder:` markers** in night reminder text — strip (recommended,
   matches official-roles.js) or keep verbatim.

## 5. Numbers and risks

Scale: 83 character pages, ~170 character art files (+ token art none — the
site has no separate token art), 1 collection, 22 script pages, ~40 script
logos/backgrounds. All through the existing API with resume support.

Risks: Google Sites markup changing mid-scrape (low — one afternoon's run);
CORS unknown until tested (both fallbacks above); the wiki's hourly write
limits (runner pauses and resumes); 3 genuinely ambiguous jinxes reported by
the existing warning before anything is written (the "Appears in" box
settles them). Nothing here is destructive: every save is revisioned, and a
re-run updates rather than duplicates.
