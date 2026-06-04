# BOTC HomeBrew Wiki — Full Handoff Document
*Feed this entire file to a new Claude instance to give it complete context to work on this website.*
*Last updated: June 2026 — reflects all changes through script builder, hamburger nav, Fall of Rome import, and almanac visual overhaul.*

---

## 1. PROJECT OVERVIEW

Fan-made wiki for **Blood on the Clocktower** (BotC) homebrew characters by **djclocktower** (GitHub username). Static website hosted on **GitHub Pages** with a custom domain at **botchomebrew.wiki**.

The site has:
- A dynamic homepage with a fixed left Creator Icons sidebar and character grid
- Individual character pages for each homebrew character
- A **Create Character** page (`create.html`) — form-based authoring with live preview and one-click publish via Cloudflare Worker proxy
- An **Edit Character** page (`edit.html`) — same as create but pre-filled for existing characters
- A **Script Builder** page (`script.html`) — localStorage-based, instant, exports JSON for the official BotC script tool
- A collapsible **JSON export box** on every character page showing official-schema JSON
- Index pages: `tags.html`, `tag.html?t=`, `team.html?t=`, `author.html?a=`, `authors.html`, `creators.html`

---

## 2. REPOSITORY & GITHUB ACCESS

- **GitHub:** https://github.com/djclocktower/botc-homebrew-wiki
- **Owner:** djclocktower | **Repo:** botc-homebrew-wiki | **Branch:** main
- **Live site:** https://botchomebrew.wiki (CNAME file, custom domain via GitHub Pages)
- **GitHub Pages URL:** https://djclocktower.github.io/botc-homebrew-wiki/
- **Cloudflare Worker proxy:** https://botc-wiki-proxy.djclocktower.workers.dev/gh — handles all writes from create.html and edit.html (no GitHub token needed by users)

### GitHub API access (for Claude)
Claude pushes changes directly using the GitHub Contents API. The user provides a fine-grained PAT (Contents: Read and write, scoped to this repo only) at the start of each session, stored at `/home/claude/.ghtoken`.

```python
import base64, json, urllib.request

TOKEN = open('/home/claude/.ghtoken').read().strip()
OWNER, REPO, BRANCH = 'djclocktower', 'botc-homebrew-wiki', 'main'

def get_file(path):
    req = urllib.request.Request(
        f'https://api.github.com/repos/{OWNER}/{REPO}/contents/{path}?ref={BRANCH}')
    req.add_header('Authorization', f'Bearer {TOKEN}')
    req.add_header('Accept', 'application/vnd.github+json')
    with urllib.request.urlopen(req) as r:
        data = json.loads(r.read())
    return base64.b64decode(data['content'].replace('\n','')), data['sha']

def put_file(path, content_bytes, message, sha=None):
    req = urllib.request.Request(
        f'https://api.github.com/repos/{OWNER}/{REPO}/contents/{path}', method='PUT')
    req.add_header('Authorization', f'Bearer {TOKEN}')
    req.add_header('Accept', 'application/vnd.github+json')
    req.add_header('Content-Type', 'application/json')
    body = {'message': message,
            'content': base64.b64encode(content_bytes).decode(),
            'branch': BRANCH}
    if sha: body['sha'] = sha
    req.data = json.dumps(body).encode()
    with urllib.request.urlopen(req): pass
```

### CRITICAL LESSONS (hard-won, do not skip)

1. **CRITICAL srcdoc bug — #1 hazard.** `create.html` and `edit.html` contain a JavaScript srcdoc template string for the live preview iframe. This string contains `</header>`, `</body>`, `</html>`, and `<script>` as JS string literals. **Never use naive str.replace() targeting these tags** — it matches inside the JS string and injects code into the iframe, breaking the form. Always use unique surrounding context (e.g. the crumb nav text, or `'\n</body>\n</html>'` as the real document closing) to target only real HTML. After any injection, verify: the injected JS must appear **AFTER** `"$('preview').srcdoc"` in the file.

2. **Always verify string replacements.** `str.replace()` silently no-ops if the target has shifted. Always fetch, confirm the target string is present, then commit. Re-fetch after push to verify.

3. **SHA required for updates.** Always GET the file first to retrieve its current SHA before PUTting an update.

4. **GitHub Pages rebuild time.** ~60 seconds after a commit. Cached CSS/JS may need a hard refresh.

5. **api.github.com IS on the sandbox allowlist** — Claude can push directly using urllib.

6. **After any successful edit, earlier views of that file are stale** — re-fetch before further edits to the same file.

---

## 3. ARCHITECTURE

### Static pages (hand-built from PSDs)
Three character pages with pixel-exact Dumbledor font headings rasterised as PNGs:
- `characters/folie-a-deux.html`
- `characters/la-revolution.html`
- `characters/hemomagus.html`

These load `../assets/render.js` and fetch their entry from `characters.json` to populate the JSON box only. Their layout is fully hardcoded HTML.

### Dynamic pages (form-created or bulk-imported)
New characters are stored in `characters.json` and rendered on-demand by `character.html?c={slug}`. Use Dumbledor 1 (self-hosted) for headings in mixed case (not uppercase — CSS handles the transform).

### The manifest: characters.json
Single source of truth. 43 characters as of this writing. The homepage reads it to list all characters. `create.html` upserts to it via the Worker proxy.

### Shared renderer: assets/render.js
`window.renderCharacter(data, artSrc)` generates character page HTML. Used by `character.html` (live) and `create.html`/`edit.html` (live preview).

Also exports: `window.renderJsonBox(data)`, `window.buildSchema(data)`, `window.schemaJSON(data)`, `window.slugId(name)`, `window.TEAM_LABEL`.

### Script Builder (localStorage)
`script.html` — entirely client-side, no GitHub commits. Uses `localStorage` key `botc_script` (array of slugs). The "Add to Script" button on every character page toggles the character in/out instantly.

---

## 4. FILE STRUCTURE

```
botchomebrew.wiki/
  CNAME                          ← custom domain
  README.md
  index.html                     ← homepage (creator sidebar + character grid)
  character.html                 ← dynamic character renderer (?c=slug)
  create.html                    ← authoring form: live preview + Worker publish
  edit.html                      ← edit existing character
  script.html                    ← script builder (localStorage, instant)
  characters.json                ← manifest of ALL characters (source of truth)
  tags.html                      ← all tags index
  tag.html                       ← characters for a specific tag (?t=tag)
  team.html                      ← characters for a specific team (?t=team)
  authors.html                   ← all authors index
  author.html                    ← characters by a specific author (?a=name)
  creators.html                  ← creator icons page (wide grid)
  characters/
    folie-a-deux.html            ← hand-built static page (Minion)
    la-revolution.html           ← hand-built static page (Townsfolk)
    hemomagus.html               ← hand-built static page (Demon)
  assets/
    styles.css                   ← ALL shared CSS for the entire site
    render.js                    ← shared character renderer + JSON schema builder
    bg.jpg                       ← purple textured background
    parchment.jpg                ← parchment texture for content panels (1200×1600)
    headertext.png               ← "BOTC HomeBrew Wiki" header logo image (transparent PNG, 82×44px)
    logo_skull.png               ← skull logo for topbar (transparent)
    favicon.png                  ← 64×64 skull favicon
    ccc-parchment.png            ← "Community Created Content" badge (topbar, 32px tall)
    emblem.png                   ← Folie à Deux character art
    larev_char_art.png           ← La Révolution character art
    hemo_char_art.png            ← Hemomagus character art
    h_*.png                      ← Folie à Deux rasterised Dumbledor headings
    larev_h_*.png                ← La Révolution rasterised headings
    hemo_h_*.png                 ← Hemomagus rasterised headings
    jinx_*.png                   ← Folie à Deux jinx token icons
    hemo_jinx_*.png              ← Hemomagus jinx token icons
    night_*.png                  ← Night order token icons (Folie à Deux)
    fonts/
      dumbledor2.ttf             ← Dumbledor 1 font (named dumbledor2.ttf — do NOT rename)
      trade-gothic-lt-std.otf   ← Trade Gothic LT Std regular
      trade-gothic-lt-std-bold-condensed.otf
    art/                         ← artwork uploaded via create.html or directly
      *.png                      ← character art files (slug-based names)
```

---

## 5. CSS DESIGN SYSTEM

All CSS in `assets/styles.css`. Pages in root reference `assets/styles.css`; pages in `characters/` reference `../assets/styles.css`. URL paths inside the CSS file are relative to `assets/` (e.g. `url('parchment.jpg')` resolves to `assets/parchment.jpg`). **Never write `url('assets/parchment.jpg')` inside styles.css — that resolves to `assets/assets/parchment.jpg` which doesn't exist.**

### CSS Variables
```css
--purple-deep: #1a0820    --purple-mid: #4a2548
--parch:       #F0E8D5    --parch-edge: #e0d0b0    --parch-frame: #bda89a
--card:        #F7F6F2    --card-edge:  #d7c9ab
--ex-bg:       #ded3cd    --ex-frame:   #bcae93
--maroon:      #5B1F21    --ink:        #000
--good:        #2C7BD0    --good-name:  #2f6fb8    --evil: #9A0D12
--rule:        #b79c6f
```

### Fonts
- **Dumbledor 1** (file: `assets/fonts/dumbledor2.ttf`, CSS name: `'Dumbledor2'`) — character names and all Dumbledor-style headings. Mixed case (lowercase letters are the round, wiki-matching ones). CSS applies `text-transform: uppercase` via the rule, but the font renders uppercase from both cases.
- **Trade Gothic LT Std** (self-hosted, regular + bold condensed) — all body text. CSS name: `'TradeGothicLT'`. Falls back to `'Libre Franklin'`.
- **Oswald** — jinx names, reminder pills, form labels. Google Fonts.
- **EB Garamond** italic — jinx descriptions, flavour quotes. Google Fonts.

### All corners are sharp
`border-radius: 0` everywhere — this matches the almanac aesthetic. Do not add rounded corners.

### Border style
All cards and panels use `border: 4px solid var(--parch-frame)` (`#bda89a`). No gradients, no inset shadows for borders. The parchment panel additionally has a drop shadow.

### Parchment background
All content panels use:
```css
background-color: var(--parch);
background-image: url('parchment.jpg');
background-size: cover;
background-repeat: no-repeat;
```

### Key layout classes
- `.topbar` — sticky header with hamburger menu on mobile
- `.brand` — skull img + headertext.png + CCC badge (all in one `<a>`)
- `.brand-group` — wraps brand link + edit button on character pages (flex, nowrap)
- `.hamburger` — mobile nav trigger (hidden on desktop)
- `.nav-dropdown` — mobile slide-down nav with search input + links
- `.creator-sidebar` — fixed left sidebar (220px wide, full height, scrollable)
- `.wrap` — main content wrapper (max-width 1240px, centered)
- `.char-layout` — CSS grid: col1=parchment(span2rows), col2=infocard(row1)+side(row2)
- `.char-parchment` — main parchment panel
- `.char-infocard` — white/parchment info card (grid col2 row1)
- `.char-side` — sidebar stack (grid col2 row2, flex column)
- `.gen-title` — Dumbledor1 character title (large, mixed case, tight margin below)
- `.gen-sech-wrap` — section heading with flanking rules (flex, ::before and ::after)
- `.gen-sech` — section heading text (Dumbledor1, uppercase via CSS)
- `.sb-layout` — script builder two-column grid (add sidebar + main)
- `.sb-add-sidebar` — scrollable character picker sidebar
- `.sb-script-item` — character card in current script
- `.home-layout` — homepage uses body+creator sidebar+home-hero+home-panel (sidebar is position:fixed)
- `.creator-sidebar` — fixed left, pushes page content via `body:has(.creator-sidebar) .home-hero` etc.

### Responsive breakpoints
- `≤880px` — single column char layout, crumb hidden, infocard order:-1, mobile hamburger shows
- `≤820px` — script builder sidebar becomes slide-in panel
- `≤860px` — creator sidebar hidden, mobile creator bar shown at bottom of homepage
- `≤480px` — example boxes shrink

---

## 6. TOPBAR STRUCTURE (all pages)

```html
<header class="topbar">
  <a class="brand" href="[prefix]index.html">
    <img class="brand-skull" src="[prefix]logo_skull.png" alt="">
    <img class="brand-header-text" src="[prefix]headertext.png" alt="BOTC HomeBrew Wiki">
    <img class="topbar-badge" src="[prefix]ccc-parchment.png" alt="Community Created Content">
  </a>
  <nav class="crumb" aria-label="Breadcrumb">
    <!-- breadcrumb links — hidden on mobile -->
  </nav>
  <div class="search-wrap" id="search-wrap">
    <input class="search-input" id="search-input" ...>
    <div class="search-drop" id="search-drop" ...></div>
  </div>
  <button class="hamburger" id="hamburger" ...>
    <span></span><span></span><span></span>
  </button>
</header>
<nav class="nav-dropdown" id="nav-dropdown">
  <div class="nav-dropdown-search">
    <input type="search" id="nav-search-input" ...>
  </div>
  <a href="index.html">All Characters</a>
  <a href="tags.html">Tags</a>
  <a href="creators.html">Creators</a>
  <a href="script.html">Script Builder</a>
  <a href="create.html">Create a Character</a>
</nav>
<!-- hamburger JS follows -->
<script>
(function(){
  var btn=document.getElementById('hamburger');
  var drop=document.getElementById('nav-dropdown');
  // ... positions dropdown dynamically, wires nav search to topbar search
})();
</script>
```

- Root pages: prefix = `assets/`
- Pages in `characters/`: prefix = `../assets/`
- Search bar is hidden on mobile (`≤880px`) — the nav-dropdown search input takes its place
- The hamburger JS dynamically positions the dropdown using `getBoundingClientRect().height` so it always sits flush under the topbar regardless of height
- Nav search input mirrors its value to the topbar search input and fires its `input` event

**character.html additionally** wraps brand + edit button in `.brand-group`:
```html
<div class="brand-group">
  <a class="brand" href="index.html">...</a>
  <img class="topbar-badge" ...>
  <a class="edit-link" id="edit-btn" style="display:none" href="#">✎ Edit</a>
</div>
```

---

## 7. JSON BOX SYSTEM

Every character page has a collapsible JSON export box. The exported JSON is in official script tool format:
```json
[
  { "id": "_meta", "name": "" },
  {
    "id": "characterid",
    "name": "Character Name",
    "image": ["https://botchomebrew.wiki/assets/art/slug.png"],
    ...
  }
]
```

Key `buildSchema` behaviour:
- `image` is always an **array** `["url"]`
- `firstNightReminder` and `otherNightReminder` are **omitted when empty**
- `flavor` uses `data.flavor || data.quote`
- `jinxes[].id` is derived from jinx name via `slugId()`

### JSON box placement
- **Characters WITH jinxes**: JSON box is last item in `<aside class="char-side">`
- **Characters WITHOUT jinxes**: JSON box is inside `.char-infocard`, appended after `<dl class="info">` with `margin-top:14px`. NO `.char-side` aside exists.

---

## 8. CHARACTER DATA SCHEMA (characters.json)

### Full entry (form-created or bulk-imported)
```json
{
  "slug": "my-character",
  "name": "My Character",
  "team": "townsfolk",
  "ability": "Bold ability line.",
  "art": "art/my-character.png",
  "page": "character.html?c=my-character",
  "image": "https://botchomebrew.wiki/assets/art/my-character.png",
  "creator": "DJ_DJ_DJ",
  "lede": "One flavour sentence.",
  "summaryBullets": ["Rule 1.", "Rule 2."],
  "howToRun": ["Para 1. Use [[TOKEN]] for reminder pills.", "Para 2."],
  "callout": "Optional callout box text.",
  "examples": ["Example 1.", "Example 2."],
  "tips": ["Tip 1.", "Tip 2."],
  "bluffing": ["Bluffing tip 1."],
  "fighting": ["Fighting tip 1."],
  "quote": "Flavour quote (also JSON flavor).",
  "appearsIn": "Script name",
  "tags": "Wincon, Setup",
  "edition": "experimental",
  "firstNight": 0,
  "firstNightReminder": "ST instructions.",
  "otherNight": 10,
  "otherNightReminder": "ST instructions for other nights.",
  "reminders": ["Poisoned", "Dead"],
  "remindersGlobal": [],
  "setup": false,
  "jinxes": [{"name": "Goon", "align": "good", "text": "Jinx rule text."}]
}
```

- `bluffing` field shown on good character pages (townsfolk/outsider), `fighting` on evil pages
- `quote` vs `flavor`: form calls it `quote` for display, `buildSchema` uses `data.flavor || data.quote`
- Art path: relative to `assets/` — hand-built use top-level filenames, form-created use `art/slug.png`
- Teams: `townsfolk`, `outsider`, `minion`, `demon`, `traveller`, `fabled`

---

## 9. CREATE/EDIT TOOLS

### create.html
Publishes directly to GitHub via the Cloudflare Worker proxy (no user token needed).

**Key features:**
- Import from JSON (official script tool format) — autofills ability, flavor, team, night order, reminders, jinxes
- Live preview iframe (same renderer as published pages)
- Auto-expanding textareas (no scrollbars)
- Character counter on ability field
- Bluffing/Fighting perspective fields (team-conditional: shown for good/evil respectively)
- Night Order & Tokens fieldset (edition, firstNight/otherNight priority, reminders, setup checkbox)
- Jinx rows (name + alignment + text)
- Publish button: resizes art (max 600px PNG), uploads to `assets/art/{slug}.png`, upserts `characters.json`

### edit.html
Same as create but pre-filled via `?c=slug` URL parameter. Fetches entry from `characters.json` on load.

### CRITICAL: srcdoc safety
Both pages contain a JS srcdoc template string for the preview iframe. This string includes `</header>`, `</body>`, `</html>`, and `<script>` as literals inside the JS string. When injecting code into these files, **always target unique surrounding text** that cannot appear in the JS string. After injection, always verify the new code appears **after** `"$('preview').srcdoc"` in the file.

### Publish flow
1. Resize art via canvas (max 600px, PNG output)
2. POST to Worker proxy → PUT `assets/art/{slug}.png`
3. GET `characters.json` → parse → upsert entry by slug → PUT with SHA
4. Success: show link to `character.html?c={slug}`, note ~60s rebuild

---

## 10. SCRIPT BUILDER (script.html)

Entirely client-side. No GitHub commits. No backend.

- **localStorage key:** `botc_script` — array of slugs
- **Add to Script button:** on every character page (`.add-to-script-btn`), injected by `character.html` after `renderCharacter()` is called. Mounted into `.char-infocard`. Toggles instantly.
- **Script Builder page:** left sidebar with all wiki characters (grouped by team, alphabetical, filterable) + main area showing current script. Export downloads `homebrew-script.json` in official format `[{_meta}, char1, ...]`.
- **Mobile:** sidebar becomes a slide-in panel triggered by `+ Add Characters` sticky button.

---

## 11. CREATOR ICONS SIDEBAR (homepage)

The homepage has a **fixed left sidebar** (220px wide, full height, scrollable) listing all 63 registered creators. It pushes page content right on desktop via:
```css
body:has(.creator-sidebar) .home-hero,
body:has(.creator-sidebar) .home-panel,
body:has(.creator-sidebar) .foot {
  margin-left: 220px;
}
```

On mobile (≤860px) the sidebar is hidden and replaced by a `+ View All Creator Icons →` bar at the bottom of the homepage.

The sidebar title links to `creators.html` — a dedicated wide-grid page with all 63 creators in a responsive `auto-fill, minmax(180px, 1fr)` grid.

---

## 12. CURRENT CHARACTERS (43 total)

### Hand-built static pages
- **Folie à Deux** (Minion) — `characters/folie-a-deux.html` — has jinxes, night order card
- **La Révolution** (Townsfolk) — `characters/la-revolution.html` — no jinxes, JSON box in infocard
- **Hemomagus** (Demon) — `characters/hemomagus.html` — has jinxes, QR code card

### Dynamic character pages (form-created or imported)
**Townsfolk (15):** La Révolution*, Herbalist ♊︎, Perfumer, Jackal, Sculptor, Vestal Virgin, Physician, Legionary, Trumpeter, Mortician, Standard Bearer, Centurion, Merchant, Gladiator, Actor, Blacksmith, Scholar, Bard
**Outsider (7):** Martyr, Pozzo, Acolyte, The Twins, Winemaker, Spartacus, Bad Omen
**Minion (5):** Folie à Deux*, Temptress, Haruspex, Glykon, Augur
**Demon (6):** Hemomagus*, Cleopatra, Crassus, Hannibal, Caesar, Archlich
**Traveller (6):** Mercenary, Architect, Sibyl, High Priest (Pontifex Maximus), High Priest (Pontiff), Emperor
**Fabled (1):** "I Am Spartacus!"

*These also have static hand-built pages in `characters/`.

### Fall of Rome set (32 characters by Alex)
All 32 imported from the bloodstar.xyz almanac. Art placeholders pending upload to `assets/art/[slug]-fall-of-rome.png`. Characters are: Sculptor, Vestal Virgin, Physician, Legionary, Trumpeter, Mortician, Standard Bearer, Centurion, Merchant, Gladiator, Actor, Blacksmith, Scholar (TF); The Twins, Winemaker, Spartacus, Bad Omen (OS); Temptress, Haruspex, Glykon, Augur (MN); Cleopatra, Crassus, Hannibal, Caesar (DM); Mercenary, Architect, Sibyl, High Priest ×2, Emperor (TR); "I Am Spartacus!" (FB).

### Intentional typos (preserve verbatim)
"Plauge Doctor" (Folie jinx), "Saftey Net" (La Révolution tags), "accours", "singnals"

---

## 13. KNOWN ISSUES & GOTCHAS

1. **srcdoc injection bug** — see Section 9. The #1 recurring hazard. Always verify.
2. **parchment.jpg URL in CSS** — must be `url('parchment.jpg')` not `url('assets/parchment.jpg')`. The CSS file lives in `assets/` so relative paths resolve from there.
3. **characters.json SHA** — always GET first, then PUT with the returned SHA.
4. **La Révolution has no `.char-side` aside** — its JSON box is inside `.char-infocard`. Don't add a sidebar.
5. **Fall of Rome art** — 32 characters have placeholder art. Real art files go in `assets/art/[slug]-fall-of-rome.png`.
6. **Font file naming** — `assets/fonts/dumbledor2.ttf` is actually Dumbledor **1** (the rounder, wiki-matching font). Do not rename the file — the CSS references it as `dumbledor2.ttf`.
7. **`quote` vs `flavor`** — stored as `quote` in characters.json, `buildSchema` uses `data.flavor || data.quote`.
8. **Script builder uses localStorage** — not available in Claude's artifact sandbox, but works fine in real browsers.
9. **Hamburger menu** — positioned dynamically in JS using `getBoundingClientRect().height`. The dropdown is a sibling of `<header>`, positioned `fixed` on mobile.
10. **Static page jinxes** — display is hardcoded HTML. `characters.json` jinxes are only used for the JSON box. Edit static HTML directly to change jinx display.
11. **Martyr test entry** — a `martyr` entry exists from an earlier test. Works fine, can be deleted if unwanted.

---

## 14. CLOUDFLARE WORKER PROXY

URL: `https://botc-wiki-proxy.djclocktower.workers.dev/gh`

Handles all GitHub API write operations from `create.html` and `edit.html`. Accepts POST requests with the file path, content, and message. The Worker holds the GitHub token server-side — users never see it. The `edit.html` and `create.html` files use `workerPut()` instead of direct GitHub API calls.

---

## 15. CREATOR ICONS (63 registered creators)

In alphabetical order with symbols:
⁛ Aba, ∞ Alex, ψ Amelia, 𐂂 Arbalest, 𐑣 Autumn, ★ BakedIce, ⍼ Barko, † The Bazaar, β Brewulation & Boilers, ☠ Bio, ◮ Chal, ± chloeispink, ⊕ Coda, ¢ ctlq, ☭ Comrade, ξ Dark, D Darrivis, 𖤓 Drossel, ⁂ Elden Thorn, 灯 Eliderad, § Elluna, π FakeTier, ⟁ Galexy, 🜚 Geebs, ꙮ Gobinator, ♊ Harry & Co. & Bendan, ⍨ Haunted, ∇ Hystrex, Ϟ Imze, ⦿ J.C., ֎ Lady Mist, ¥ Lawrence, ✦ Luis, Ω Ma'ayan, ⸸ Maja, 𐚁 Margs, ∑ Nerdguy, ф Nycto, ☾ Nyla, ₽ ODE, ¶ Panfex, ∻ Parceval, Φ Pixlate, ✸ Procyon, ♣︎ Pynstripe, 🜲 Rams, α Requiem, ⏻ Robo, ⛧ Safterix, 𝄡 Sally, █ SCP: Fragmented Veil, » Schemer, Ꝥ Skadoosher, ♪ Soothslayer, ¬ Super, ₳ Squ4ll, ꩜ Sy, ¿ Taco, ╦ Temporary, ♄ Tir, ℵ thelast19digitsofpi, ♡ Varii, ♠ Wrendle
