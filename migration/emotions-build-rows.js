#!/usr/bin/env node
/*
 * Build the D1 rows for the Emotions import.
 *
 *   node migration/emotions-build-rows.js candidates
 *      -> prints ONE sql statement listing every identity candidate; run it
 *         against D1 and save the taken slugs (one per line) to
 *         migration/emotions-taken.txt (an empty file is fine — nothing on
 *         the wiki claimed any of these names when the set was imported).
 *
 *   node migration/emotions-build-rows.js rows
 *      -> reads emotions-taken.txt, assigns the first free identity per
 *         character (the wiki's slug-check ladder: base, base-emotions,
 *         numbered) and writes migration/emotions-sql/: characters-N.sql and
 *         collection.sql.
 *
 * Source: migration/emotions-import.json — the owner-supplied official-schema
 * export merged with the almanac Klutzbanana serves for the same project. The
 * two agree field for field on every mechanic; the almanac adds the prose.
 *
 * Ground rule, the same one The Menagerie import was held to: EVERY WORD ON
 * THESE PAGES COMES FROM THE SOURCE. Nothing is written here, and nothing is
 * tidied — the author's spellings ("Dissapointment", "Excietement", "speads")
 * stand as they were written. Where that leaves a wiki field empty it stays
 * empty: none of these characters has a flavour quote or tags, so all 16 land
 * Partial until somebody who knows the set tags them. The tags-open default
 * (defaultTagsOpen in worker.js) means anyone with an account can, without the
 * pages storing a sharing mode.
 *
 * The almanac prose is one markdown-ish blob per character, in a fixed shape:
 * a one-line summary, "## Examples", "## How to run", and the odd "> " aside.
 * mapAlmanac() is the whole mapping onto this wiki's fields, and it is
 * checked to be lossless — every non-heading source line lands in exactly one
 * field, in order.
 */
const fs = require('fs');
const path = require('path');

const IMP = require(path.join(__dirname, 'emotions-import.json'));

const kebab = s => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 80);
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const SET = 'Emotions';           // the collection's display name
const SET_KEBAB = 'emotions';     // its id, and the set segment of every address
const VERSION = '3.2';            // _meta.name is "Emotions v 3.2"
const CREATOR = IMP._meta.author; // "Moll"

function candidatesFor(name) {
  const base = kebab(name);
  const out = [base, base + '-' + SET_KEBAB];
  for (let i = 2; i <= 6; i++) out.push(base + '-' + SET_KEBAB + '-' + i);
  for (let i = 2; i <= 6; i++) out.push(base + '-' + i);
  return out;
}

const mode = process.argv[2];
if (mode === 'candidates') {
  const all = [];
  for (const c of IMP.characters) all.push(...candidatesFor(c.name));
  const lits = all.map(s => "'" + s.replace(/'/g, "''") + "'").join(',');
  console.log(
    'SELECT group_concat(s, char(10)) AS taken FROM (' +
    'SELECT slug AS s FROM characters WHERE slug IN (' + lits + ') ' +
    "UNION SELECT from_slug FROM redirects WHERE entity_type='character' AND from_slug IN (" + lits + '))');
  process.exit(0);
}
if (mode !== 'rows') { console.error('usage: candidates | rows'); process.exit(1); }

const takenFile = path.join(__dirname, 'emotions-taken.txt');
const taken = new Set(
  (fs.existsSync(takenFile) ? fs.readFileSync(takenFile, 'utf8') : '')
    .split('\n').map(s => s.trim()).filter(Boolean));

/* ── the almanac blob -> this wiki's character fields ──
   The wiki's character prose takes the links-only mark set (see "Formatting on
   a character page"), which has no headings, no lists and no blockquotes — so
   the structure has to become fields rather than survive as markup:

     the opening line   -> lede      (the bold one-liner every page here opens with)
     ## Examples        -> examples[]
     ## How to run      -> howToRun[]
     "> " asides        -> tips[]    (Storyteller advice, which is what Tips is)

   Two conversions, neither of which changes a word: a markdown list marker is
   dropped (each step becomes its own How to Run paragraph — there is no list
   mark in this field set), and _emphasis_ becomes {{i|…}}, the wiki's italic,
   which links mode does offer. Left alone it would print its underscores. */
function mapAlmanac(txt, who) {
  const out = { lede: '', examples: [], howToRun: [], tips: [] };
  const HEADINGS = { 'examples': 'examples', 'example': 'examples', 'how to run': 'howToRun' };
  let sec = 'intro';
  for (const block of String(txt || '').trim().split(/\n\s*\n/)) {
    let lines = block.split('\n');
    if (/^#/.test(lines[0] || '')) {
      const h = lines[0].replace(/^#+/, '').trim().toLowerCase();
      sec = HEADINGS[h];
      if (!sec) throw new Error('unknown almanac heading on ' + who + ': ' + lines[0]);
      lines = lines.slice(1);
    }
    for (let ln of lines) {
      ln = ln.trim();
      if (!ln) continue;
      if (ln.startsWith('>')) { out.tips.push(ln.replace(/^>\s*/, '')); continue; }
      ln = ln.replace(/^[-*]\s+/, '').replace(/_([^_\n]+)_/g, '{{i|$1}}');
      if (sec === 'intro') {
        if (out.lede) throw new Error('a second opening line on ' + who + ': ' + ln);
        out.lede = ln;
      } else out[sec].push(ln);
    }
  }
  return out;
}

/* Nothing may be dropped: every non-heading source line must come back out,
   in order, once the two conversions above are undone. */
function checkLossless(txt, p, who) {
  const got = [p.lede, ...p.examples, ...p.howToRun, ...p.tips]
    .map(s => s.replace(/\{\{i\|([^}]*)\}\}/g, '_$1_'));
  const src = String(txt).split('\n')
    .map(l => l.replace(/^[-*>]\s*/, '').trim())
    .filter(l => l && !l.startsWith('#'));
  if (src.length !== got.length || src.some((l, i) => l !== got[i])) {
    throw new Error('almanac text lost on ' + who);
  }
}

// ---- assign identities ----
const slugFor = new Map();
for (const c of IMP.characters) {
  const pick = candidatesFor(c.name).find(s => !taken.has(s));
  if (!pick) throw new Error('no free slug for ' + c.name);
  taken.add(pick);
  slugFor.set(c.id, pick);
}

// ---- character rows ----
const rows = [];
for (const c of IMP.characters) {
  const slug = slugFor.get(c.id);
  const team = c.team === 'traveler' ? 'traveller' : String(c.team || '').toLowerCase();
  const images = (Array.isArray(c.image) ? c.image : [c.image]).filter(Boolean);
  const p = mapAlmanac(c.almanacDetails, c.name);
  checkLossless(c.almanacDetails, p, c.name);

  const d = {
    slug,
    name: String(c.name),
    team,
    ability: String(c.ability),
    creator: CREATOR,
    appearsIn: SET,
    lede: p.lede,
    howToRun: p.howToRun,
    examples: p.examples,
    firstNight: Number(c.firstNight) || 0,
    firstNightReminder: String(c.firstNightReminder || ''),
    otherNight: Number(c.otherNight) || 0,
    otherNightReminder: String(c.otherNightReminder || ''),
    reminders: Array.isArray(c.reminders) ? c.reminders : [],
    remindersGlobal: Array.isArray(c.remindersGlobal) ? c.remindersGlobal : [],
    setup: !!c.setup,
    special: Array.isArray(c.special) ? c.special : [],
    // Art stays where the author hosts it, as absolute URLs — the same thing
    // every bulk import on this wiki does (see "A character's three icons").
    // For the traveller the three slots ARE unaligned / good / evil.
    image: images[0] || '',
    curata: false
  };
  if (images[1]) d.imageAlt = images[1];
  if (images[2]) d.imageAlt2 = images[2];
  if (p.tips.length) d.tips = p.tips;
  if (!d.special.length) delete d.special;
  if (!d.remindersGlobal.length) delete d.remindersGlobal;
  if (!d.reminders.length) delete d.reminders;
  if (!d.firstNightReminder) delete d.firstNightReminder;
  if (!d.otherNightReminder) delete d.otherNightReminder;

  rows.push({
    slug, name: d.name, team, appears_in: SET,
    url_slug: SET_KEBAB + '/' + kebab(d.name), data: d
  });
}

// url_slug uniqueness inside the run (the names are unique, but be safe)
{
  const seen = new Set();
  for (const r of rows) {
    let u = r.url_slug, n = 2;
    while (seen.has(u)) u = r.url_slug + '-' + n++;
    seen.add(u); r.url_slug = u;
  }
}

// ---- SQL ----
const q = s => "'" + String(s).replace(/'/g, "''") + "'";
const outDir = path.join(__dirname, 'emotions-sql');
fs.mkdirSync(outDir, { recursive: true });
const BATCH = 8;
let nb = 0;
for (let i = 0; i < rows.length; i += BATCH) {
  const vals = rows.slice(i, i + BATCH).map(r =>
    '(' + [q(r.slug), q(r.name), q(r.team), q(CREATOR), 'NULL', 'NULL',
           q(SET), q(JSON.stringify(r.data)), q('published'), q(r.url_slug)].join(',') +
    ",datetime('now'),datetime('now'))"
  ).join(',\n');
  fs.writeFileSync(path.join(outDir, 'characters-' + (++nb) + '.sql'),
    'INSERT INTO characters (slug,name,team,creator,owner_id,tags,appears_in,data,status,url_slug,created_at,updated_at) VALUES\n' + vals + ';\n');
}

// ---- the collection ----
/* _meta.almanacIntroduction is one markdown blob with two headings. A
   collection's synopsis is rendered by render-page.js's prose(), which knows
   paragraphs and nothing else, so the Synopsis body becomes the synopsis and
   the Thanks becomes a custom box — those DO go through render-wiki.js. */
function introSections(txt) {
  const out = {};
  let key = null, buf = [];
  for (const line of String(txt || '').split('\n')) {
    const h = line.match(/^##\s*(.+)$/);
    if (h) { if (key) out[key] = buf.join('\n').trim(); key = h[1].trim(); buf = []; }
    else buf.push(line);
  }
  if (key) out[key] = buf.join('\n').trim();
  return out;
}
const intro = introSections(IMP._meta.almanacIntroduction);
const coll = {
  slug: SET_KEBAB,
  id: SET_KEBAB,
  displayName: SET,
  name: SET,
  author: CREATOR,
  creator: CREATOR,
  version: VERSION,
  synopsis: intro.Synopsis || '',
  logo: IMP._meta.logo || '',
  almanac: IMP._meta.almanac || '',
  match: [norm(SET)],
  include: rows.map(r => r.slug),
  exclude: [],
  // The author's own arrangement, as the roster stands in the script file.
  // Team grouping still wins over it (the page draws one section per team).
  order: rows.map(r => r.slug),
  curata: false
};
if (intro.Thanks) coll.customBoxes = [{ title: 'Thanks', content: intro.Thanks }];
fs.writeFileSync(path.join(outDir, 'collection.sql'),
  'INSERT INTO collections (slug,display_name,owner_id,data,status,created_at,updated_at) VALUES (' +
  [q(coll.slug), q(SET), 'NULL', q(JSON.stringify(coll)), q('published')].join(',') +
  ",datetime('now'),datetime('now'));\n");

console.log('characters:', rows.length, '| batches:', nb);
console.log('identities off the plain name:',
  rows.filter(r => r.slug !== kebab(r.name)).map(r => r.slug).join(', ') || '(none)');
console.log('addresses:', rows.map(r => r.url_slug).join(', '));
