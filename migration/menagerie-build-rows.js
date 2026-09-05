#!/usr/bin/env node
/*
 * Build the D1 rows for The Menagerie import from the scraped archives.
 * Two steps, because identities must be checked against the live database:
 *
 *   node migration/menagerie-build-rows.js candidates
 *      -> prints ONE sql statement listing every identity candidate; run it
 *         against D1 and save the taken slugs (one per line) to
 *         migration/menagerie-taken.txt
 *
 *   node migration/menagerie-build-rows.js rows
 *      -> reads menagerie-taken.txt, assigns the first free identity per
 *         character (the wiki's slug-check ladder: base, base-the-menagerie,
 *         numbered), and writes migration/menagerie-sql/ batch files:
 *         characters-N.sql, collection.sql, scripts.sql, and a
 *         menagerie-slugs.json map for the script rosters.
 *
 * The data objects mirror what POST /api/character (and /api/collection,
 * /api/script) would have stored: same fields, same normalisations
 * (mass-upload.html's entry shape plus the almanac prose fields).
 */
const fs = require('fs');
const path = require('path');

const IMP = require(path.join(__dirname, 'menagerie-import.json'));
const SCR = require(path.join(__dirname, 'menagerie-scripts-import.json'));
const ROLES = require(path.join(__dirname, '..', 'assets', 'roles.json'));

const kebab = s => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 80);
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const SET = 'The Menagerie';
const SET_KEBAB = 'the-menagerie';

const officialById = new Map(ROLES.map(r => [norm(r.id), r]));
const menByNorm = new Map();
for (const c of IMP.characters) { menByNorm.set(norm(c.id), c); menByNorm.set(norm(c.name), c); }

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

const taken = new Set(
  fs.readFileSync(path.join(__dirname, 'menagerie-taken.txt'), 'utf8')
    .split('\n').map(s => s.trim()).filter(Boolean));

const cleanRem = s => String(s || '').replace(/:reminder:/g, '').replace(/\s+/g, ' ').trim();
const httpsify = u => String(u || '').replace(/^http:\/\//, 'https://');

// ---- assign identities ----
const slugFor = new Map(); // menagerie id -> wiki identity
for (const c of IMP.characters) {
  const pick = candidatesFor(c.name).find(s => !taken.has(s));
  if (!pick) throw new Error('no free slug for ' + c.name);
  taken.add(pick);
  slugFor.set(c.id, pick);
}

// ---- character rows ----
function jinxRow(j, hostName) {
  const text = String(j.text || j.reason || '');
  const tgt = menByNorm.get(norm(j.id));
  if (tgt) return { name: tgt.name, align: 'good', text, slug: slugFor.get(tgt.id) };
  const off = officialById.get(norm(j.id));
  if (off) return { name: off.name, align: 'good', text, id: off.id };
  console.warn('  ? jinx target "' + j.id + '" on ' + hostName + ' is neither Menagerie nor official; kept by id');
  return { name: String(j.id), align: 'good', text, id: kebab(j.id) };
}

const rows = [];
for (const c of IMP.characters) {
  const slug = slugFor.get(c.id);
  const team = c.team === 'traveler' ? 'traveller' : String(c.team || '').toLowerCase();
  const images = (Array.isArray(c.image) ? c.image : [c.image]).filter(Boolean).map(httpsify);
  const flavor = String(c.flavor || '');
  const credit = c.credit || (flavor.match(/\(additional credit:?\s*([^)]+)\)/i)
    ? 'Additional credit: ' + flavor.match(/\(additional credit:?\s*([^)]+)\)/i)[1].trim() : '');
  const quote = flavor.replace(/\s*\(additional credit:[^)]*\)/i, '')
    .trim().replace(/^["']|["']$/g, '');
  const d = {
    slug,
    name: String(c.name),
    team,
    ability: String(c.ability),
    creator: 'Goodpart',
    appearsIn: SET,
    quote,
    lede: c.lede || '',
    howToRun: c.howToRun || [],
    tips: c.tips || [],
    bluffing: c.bluffing || [],
    fighting: c.fighting || [],
    examples: c.examples || [],
    firstNight: Number(c.firstNight) || 0,
    firstNightReminder: cleanRem(c.firstNightReminder),
    otherNight: Number(c.otherNight) || 0,
    otherNightReminder: cleanRem(c.otherNightReminder),
    reminders: Array.isArray(c.reminders) ? c.reminders : [],
    remindersGlobal: Array.isArray(c.remindersGlobal) ? c.remindersGlobal : [],
    setup: !!c.setup,
    special: Array.isArray(c.special) ? c.special : [],
    jinxes: (Array.isArray(c.jinxes) ? c.jinxes : []).map(j => jinxRow(j, c.name)),
    image: images[0] || '',
    curata: false
  };
  if (images[1]) d.imageAlt = images[1];
  if (images[2]) d.imageAlt2 = images[2];
  if (!d.jinxes.length) delete d.jinxes;
  if (!d.special.length) delete d.special;
  if (!d.remindersGlobal.length) delete d.remindersGlobal;
  if (credit) d.customBoxes = [{ title: 'Credit', content: credit }];
  rows.push({
    slug, name: d.name, team, creator: 'Goodpart', appears_in: SET,
    url_slug: SET_KEBAB + '/' + kebab(d.name), data: d
  });
}

// url_slug uniqueness inside the run (names are unique, but be safe)
{
  const seen = new Set();
  for (const r of rows) {
    let u = r.url_slug, n = 2;
    while (seen.has(u)) u = r.url_slug + '-' + n++;
    seen.add(u); r.url_slug = u; r.data.urlSlug = undefined;
  }
}

// ---- SQL ----
const q = s => "'" + String(s).replace(/'/g, "''") + "'";
const outDir = path.join(__dirname, 'menagerie-sql');
fs.mkdirSync(outDir, { recursive: true });
const BATCH = 8;
let nb = 0;
for (let i = 0; i < rows.length; i += BATCH) {
  const vals = rows.slice(i, i + BATCH).map(r =>
    '(' + [q(r.slug), q(r.name), q(r.team), q('Goodpart'), 'NULL', 'NULL',
           q(SET), q(JSON.stringify(r.data)), q('published'), q(r.url_slug)].join(',') +
    ",datetime('now'),datetime('now'))"
  ).join(',\n');
  fs.writeFileSync(path.join(outDir, 'characters-' + (++nb) + '.sql'),
    'INSERT INTO characters (slug,name,team,creator,owner_id,tags,appears_in,data,status,url_slug,created_at,updated_at) VALUES\n' + vals + ';');
}

// ---- the collection ----
const homeIntro = (SCR.home || []).filter(t =>
  /^The Menagerie is an almanac|^Please contact me on Discord|^Thanks to all the players/.test(t));
const coll = {
  slug: SET_KEBAB,
  id: SET_KEBAB,
  displayName: SET,
  creator: 'Goodpart',
  synopsis: homeIntro.join('\n\n'),
  logo: httpsify(IMP._meta.logo || ''),
  match: [norm(SET)],
  include: rows.map(r => r.slug),
  exclude: [],
  curata: false
};
fs.writeFileSync(path.join(outDir, 'collection.sql'),
  'INSERT INTO collections (slug,display_name,owner_id,data,status,created_at,updated_at) VALUES (' +
  [q(coll.slug), q(SET), 'NULL', q(JSON.stringify(coll)), q('published')].join(',') +
  ",datetime('now'),datetime('now'));");

// ---- the scripts ----
// Each script JSON was downloaded next to this file as menagerie-scripts/<file>.
const scrDir = path.join(__dirname, 'menagerie-scripts');
const META_STEPS = new Set(['dusk', 'dawn', 'minioninfo', 'demoninfo']);
const sqlScripts = [];
for (const s of SCR.scripts) {
  const file = decodeURIComponent(s.json.split('/').pop());
  const raw = JSON.parse(fs.readFileSync(path.join(scrDir, file), 'utf8'));
  const meta = raw.find(e => e && e.id === '_meta') || {};
  const roster = [];
  for (const e of raw) {
    if (!e || e.id === '_meta') continue;
    if (typeof e === 'string') {
      const off = officialById.get(norm(e));
      if (off) roster.push('off-' + off.id);
      else console.warn('  ? unknown official id in ' + file + ': ' + e);
      continue;
    }
    const men = menByNorm.get(norm(e.id)) || menByNorm.get(norm(e.name));
    if (men) roster.push(slugFor.get(men.id));
    else console.warn('  ? roster entry in ' + file + ' matches nothing: ' + e.id);
  }
  const mapNight = list => (Array.isArray(list) ? list : [])
    .filter(x => !META_STEPS.has(norm(x)))
    .map(x => {
      const men = menByNorm.get(norm(x));
      if (men) return slugFor.get(men.id);
      const off = officialById.get(norm(x));
      if (off) return 'off-' + off.id;
      return null;
    }).filter(Boolean);
  const slug = kebab(s.name);
  const d = {
    slug,
    name: s.name,
    author: meta.author || 'Goodpart',
    creator: meta.author || 'Goodpart',
    characters: roster,
    synopsis: (s.description || []).join('\n\n'),
    logo: httpsify(meta.logo || ''),
    almanac: meta.almanac || '',
    curata: false
  };
  if (meta.hideTitle) d.hideTitle = true;
  if (Array.isArray(meta.bootlegger) && meta.bootlegger.length) d.bootlegger = meta.bootlegger;
  const nf = mapNight(meta.firstNight), no = mapNight(meta.otherNight);
  if (nf.length || no.length) d.nightOrder = { first: nf, other: no };
  sqlScripts.push('(' + [q(slug), q(s.name), q(d.author), 'NULL',
    q(JSON.stringify(d)), q('published')].join(',') + ",datetime('now'),datetime('now'))");
}
fs.writeFileSync(path.join(outDir, 'scripts.sql'),
  'INSERT INTO scripts (slug,name,author,owner_id,data,status,created_at,updated_at) VALUES\n' +
  sqlScripts.join(',\n') + ';');

fs.writeFileSync(path.join(__dirname, 'menagerie-slugs.json'),
  JSON.stringify(Object.fromEntries(slugFor), null, 1));
console.log('rows:', rows.length, '| batches:', nb, '| scripts:', sqlScripts.length);
console.log('identities off the plain name:',
  rows.filter(r => r.slug !== kebab(r.name)).map(r => r.slug).join(', '));
