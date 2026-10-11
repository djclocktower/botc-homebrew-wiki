# Fonts

Every face the site uses is served from here. Nothing is loaded from Google
Fonts any more: `styles.css` used to `@import` seven families from
fonts.googleapis.com, which put two extra origins (the CSS host and the font
host) into the render-blocking path of every page — on a phone, half a second
before the first paint could even start.

## Self-hosted copies of the Google faces (SIL Open Font License)

`*-regular-latin-{hash}.woff2`, `*-italic-latin-{hash}.woff2` and their
`-latin-ext` twins are the latin and latin-extended subsets exactly as Google
serves them (`fonts.gstatic.com`), renamed. `{hash}` is the first 8 hex digits
of the file's MD5: this folder is cached immutable for a year, so a file whose
bytes change has to change its name. Where Google serves one variable file for
several weights the file is kept once and the `@font-face` rule in styles.css
declares the weight RANGE (`font-weight: 400 800`); a family whose weights are
separate files carries the weight in the filename too.

**Until 2026-10 most of these never drew a letter of English.** The script
split Google's CSS on `@font-face`, but Google writes each subset's label
comment BEFORE its block, so every file got the next block's label: the
"latin" files were really latin-ext, the "latin-ext" ones vietnamese, and
basic latin was never downloaded. Flavour quotes, Oswald headings and Libre
Franklin text all fell back to the phone's system fonts. The script now pairs
each label with the block after it; check a refresh by asking the browser
which font drew the text (DevTools → Computed → Rendered Fonts).
Each rule carries the subset's `unicode-range`, so a page only downloads a
`-latin-ext` file when it actually renders a character outside basic latin.

| Family | Files | Used for |
|---|---|---|
| Libre Franklin | regular 400–800, italic 400 | body text fallback, UI labels |
| Roboto | regular 400–700 | section headings, chips, labels, the homepage stats line (what an Android phone showed while Oswald never loaded; the owner preferred it) |
| Oswald | regular 500–700 | now only the "Oswald" theme-kit preset |
| Noto Serif | italic 400 | flavour quotes and jinx text (what Android drew while EB Garamond never loaded; the owner preferred it) |
| EB Garamond | italic 400–500 | pronunciation, descriptions, taglines |
| Cinzel, Pirata One, IM Fell English, Grenze Gotisch | one weight each | the script/collection theme kit (`FONT_PRESETS`) — only downloaded on a page whose theme picks them |

All nine are licensed under the SIL Open Font License 1.1, which permits
bundling and self-hosting. Refresh them by re-running
`migration/fetch-google-fonts.js` (it fetches Google's CSS with a modern
browser user-agent so the woff2 subsets come back, downloads the files under
these names and prints the `@font-face` block to paste into styles.css).

## The wiki's own faces

`dumbledor2`, `trade-gothic-lt-std`, `trade-gothic-lt-std-bold-condensed` and
`lhf-unlovable` are the display and body faces the wiki has always shipped
(licences: see the notes in styles.css and assets/script-studio/README.md).
Each now has a `.woff2` beside the original `.ttf`/`.otf` — the same glyphs,
roughly 55% smaller (`fontTools.ttLib` with `flavor = 'woff2'`). The
`@font-face` rules list the woff2 first and the original as a fallback.
The Token Tool has its own copies under `assets/tokens/fonts/` for Pyodide and
is not affected by anything here.

Everything in this folder is served `immutable` for a year (`_headers`), so a
changed font is a NEW filename, never an edit in place.
