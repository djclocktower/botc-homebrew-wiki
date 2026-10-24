#!/usr/bin/env node
/*
 * The SCP Fragmented Veil import (legitch et al., Bloodstar).
 *
 *   node migration/scp-fragmented-veil/build.mjs candidates
 *       one SQL statement: which identity candidates are already taken.
 *       Save the answer, one slug per line, to taken.txt beside this file.
 *   node migration/scp-fragmented-veil/build.mjs targets
 *       one SQL statement: the wiki characters the almanac's jinxes name by
 *       an import id from another set. Save the answer to targets.json.
 *   node migration/scp-fragmented-veil/build.mjs rows
 *       writes rows.json and art.json.
 *   node migration/scp-fragmented-veil/through-worker.mjs
 *       saves rows.json through the Worker's own handlers on the test
 *       fixture and writes what it stored to sql/final-*.sql — what was run
 *       on D1 (owner_id NULL), followed by a content_version bump.
 *   python3 migration/scp-fragmented-veil/fetch-art.py
 *       copies the art into assets/ (then optimize-images.js thumbs).
 *   node migration/scp-fragmented-veil/checksum.mjs
 *       the SQL that checks the live rows against expected.txt.
 *
 * Source: script.json + almanac.html as published on bloodstar.xyz, both kept
 * beside this file. The mapping is the wiki's own Bloodstar importer
 * (worker/bloodstar.js reads, assets/bloodstar.js maps, default options), with
 * three things that project needs and the importer does not do:
 *
 *  - The almanac's How to Run boxes end in sections the importer flattens into
 *    How to Run lines: a "JSON" block (the character's app JSON, which is the
 *    only place its jinxes are written) and "Alternative JSON & How to Run"
 *    blocks (older or optional versions). The jinxes become the page's jinxes;
 *    each alternative becomes a side box spelling out that version (its prose,
 *    name, team, ability, reminders and jinxes) rather than raw JSON.
 *  - <strong>/<em> keep their marks ({{i|…}} is the italic links mode takes).
 *  - Credits: "Ability: @a. Image: @b" -> creator a, Icon by b; anything more
 *    than that (help, inspirations) is kept verbatim in a Credit box.
 *
 * The art is copied into assets/art/ (art.json lists it; fetch-art.mjs
 * downloads it), so the rows carry relative paths and no Bloodstar URL.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { parseAlmanac, buildBundle, htmlToLines, htmlToText } from '../../worker/bloodstar.js';

const require = createRequire(import.meta.url);
const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..', '..');
const BI = require(path.join(ROOT, 'assets', 'bloodstar.js'));
const roles = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'roles.json'), 'utf8'));

const BASE = 'https://www.bloodstar.xyz/p/legitch/SCP_Fragmented_Veil/';
const SET = 'SCP Fragmented Veil';
const SET_ID = 'scp-fragmented-veil';
const kebab = BI.slugify;
const key = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Two names are only glyphs; the identity falls back to the SCP they are.
const IDENTITY_FALLBACK = { '_scp_fragmented_veil': 'scp-1875', '1_scp_fragmented_veil': 'scp-1936' };

/* ---------- read ---------- */
const scriptJson = JSON.parse(fs.readFileSync(path.join(DIR, 'script.json'), 'utf8'));
let almanac = fs.readFileSync(path.join(DIR, 'almanac.html'), 'utf8');
// Marks the links-only character fields can carry. Applied to the character
// pages only: the synopsis/overview pages go to a collection page, whose
// prose is printed plain.
const cut = almanac.indexOf('<li class="page" id="abdominal_scp_fragmented_veil"');
if (cut < 0) throw new Error('almanac layout changed');
// Bold goes in as a placeholder: htmlToLines strips a leading '*' as a
// bullet, which turned a paragraph opening in bold into "*word**".
const BOLD = '\u0001';
const unbold = v => typeof v === 'string' ? v.split(BOLD).join('**')
  : Array.isArray(v) ? v.map(unbold)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unbold(x)])) : v;
const marks = html => html
  .replace(/<strong>(\s*)([\s\S]*?)(\s*)<\/strong>/g, (m, a, t, b) => t.trim() && !t.includes('*') ? a + BOLD + t + BOLD + b : a + t + b)
  .replace(/<em>(\s*)([\s\S]*?)(\s*)<\/em>/g, (m, a, t, b) =>
    t.trim() && !/[{}\n]/.test(t) ? a + '{{i|' + t + '}}' + b : a + t + b);
almanac = almanac.slice(0, cut) + marks(almanac.slice(cut));
const alm = parseAlmanac(almanac, BASE);
const bundle = buildBundle(scriptJson, alm, { base: BASE }, roles);
if (bundle.warnings.length) console.error(bundle.warnings);

const pages = {};
for (const p of almanac.split('<li class="page" id="').slice(1)) pages[p.slice(0, p.indexOf('"'))] = p;

// Lenient: the author's JSON has the odd trailing or missing comma.
function parseJson(s) {
  const t = s.trim().replace(/,\s*$/, '');
  const tries = [t, t.replace(/,(\s*[\]}])/g, '$1'),
    t.replace(/,(\s*[\]}])/g, '$1').replace(/("|\d|true|false|\]|\})(\s*\n\s*")/g, '$1,$2')];
  for (const x of tries) { try { return JSON.parse(x); } catch {} try { return JSON.parse('[' + x + ']'); } catch {} }
  throw new Error('unreadable JSON: ' + t.slice(0, 120));
}
const decode = s => htmlToText('<p>' + s + '</p>', 'plain');

/* The How to Run box, split at its <h3>s. */
function howToRunParts(id) {
  const p = pages[id];
  const i = p.indexOf('<div class="how-to-run">');
  if (i < 0) return { lines: [], sections: [] };
  const body = p.slice(i + 24, p.indexOf('</div>', i));
  if (/<div\b/.test(body)) throw new Error('nested div in how-to-run: ' + id);
  const bits = body.split(/<h3>([\s\S]*?)<\/h3>/);
  // A JSON block with no heading of its own (Basement Cat) is the main one.
  if (/<pre><code>/.test(bits[0])) {
    const lead = bits[0].replace(/<pre><code>[\s\S]*?<\/code><\/pre>/g, '');
    const code = bits[0].match(/<pre><code>[\s\S]*?<\/code><\/pre>/g).join('');
    bits.splice(0, 1, lead, 'JSON', code);
  }
  const sections = [];
  for (let k = 1; k < bits.length; k += 2) {
    const html = bits[k + 1];
    const json = [];
    const prose = html.replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/g, (m, code) => {
      const o = parseJson(decode(code.replace(/\n/g, '<br>')));
      json.push(...(Array.isArray(o) ? o : [o]));
      return '\n';
    });
    sections.push({ title: htmlToText(bits[k], 'plain').trim(), lines: htmlToLines(prose, 'plain'), json });
  }
  return { lines: htmlToLines(bits[0], 'plain'), sections };
}

/* ---------- identities ---------- */
const chars = bundle.characters;
const baseOf = c => IDENTITY_FALLBACK[c.id] || kebab(c.name);
const candidates = c => [baseOf(c), baseOf(c) + '-' + SET_ID];

const mode = process.argv[2];
const lit = a => a.map(s => "'" + String(s).replace(/'/g, "''") + "'").join(',');

// Everything that would make a candidate taken: a page with that identity or
// flat address, a redirect from it, or a page sharing its art file
// (artSlotClash: x-alt is x's second icon, and x's own -alt slot).
const artKeys = s => [s, s + '-alt', s + '-alt2', s + '-token', s.replace(/-(alt2?|token)$/, '')];
if (mode === 'candidates') {
  const all = [...new Set(chars.flatMap(candidates))];
  console.log('WITH b(s) AS (VALUES ' + all.map(x => '(' + lit([x]) + ')').join(',') + ') ' +
    'SELECT group_concat(s, char(10)) AS taken FROM b WHERE ' +
    "EXISTS (SELECT 1 FROM characters c WHERE c.slug IN (b.s, b.s||'-alt', b.s||'-alt2', b.s||'-token') OR c.url_slug=b.s) OR " +
    "EXISTS (SELECT 1 FROM redirects r WHERE r.entity_type='character' AND r.from_slug=b.s)");
  process.exit(0);
}

/* ---------- jinx targets ---------- */
const officialById = new Map(roles.map(r => [key(r.id), r]));
const setById = new Map(chars.map(c => [c.id, c]));
const allJinxIds = new Set();
const parts = {};
for (const c of chars) {
  parts[c.id] = howToRunParts(c.id);
  for (const s of parts[c.id].sections) for (const o of s.json) for (const j of (o.jinxes || [])) allJinxIds.add(j.id);
}
const foreign = [...allJinxIds].filter(id => !setById.has(id) && !officialById.has(key(id)));

if (mode === 'targets') {
  // targets.json is the answer: the names of the published pages these keys match.
  const keys = [...new Set(foreign.map(id => key(id.split('_')[0])))];
  console.log("SELECT DISTINCT name FROM characters WHERE status='published' AND replace(replace(replace(replace(replace(" +
    "lower(name),' ',''),'-',''),'''',''),'\u2019',''),'.','') IN (" + lit(keys) + ')');
  process.exit(0);
}
if (mode !== 'rows') { console.error('usage: candidates | targets | rows'); process.exit(1); }

const taken = new Set(fs.readFileSync(path.join(DIR, 'taken.txt'), 'utf8').split('\n').map(s => s.trim()).filter(Boolean));
const slugById = {};
for (const c of chars) {
  const pick = candidates(c).find(s => !artKeys(s).some(k => taken.has(k)));
  if (!pick) throw new Error('no free identity for ' + c.name);
  taken.add(pick);
  slugById[c.id] = pick;
}
const targets = JSON.parse(fs.readFileSync(path.join(DIR, 'targets.json'), 'utf8'));
// Names of the wiki characters those ids belong to (looked up by the id's
// name half). The id is still what is stored: the jinx resolver matches it
// against name + set, which is what picks the right one of several.
const wikiName = new Map(Object.keys(targets).map(n => [key(n.normalize('NFD').replace(/[\u0300-\u036f]/g, '')), n]));
const setByKey = new Map(chars.map(c => [key(c.id.replace(/_scp_fragmented_veil$/, '')), c]));

const EVIL = new Set(['minion', 'demon']);
// A name for a character from another set the wiki does not have: the id up
// to its set suffix, as the author's own project would title it.
const guessName = id => String(id).split('_')[0].replace(/^./, ch => ch.toUpperCase());
const unresolved = new Set();

// The author's own typos for official ids.
const ID_ALIAS = { politican: 'politician' };
function jinxTarget(id) {
  id = ID_ALIAS[id] || id;
  const set = setById.get(id);
  if (set) return { name: set.name, team: set.team, slug: slugById[id] };
  const off = officialById.get(key(id));
  if (off) return { name: off.name, team: off.team, id: off.id };
  const m = /^(.*)_scp_fragmented_veil$/.exec(id);
  const renamed = m && setByKey.get(key(m[1]));
  if (renamed) return { name: renamed.name, team: renamed.team, slug: slugById[renamed.id] };
  const bits = String(id).normalize('NFD').replace(/[\u0300-\u036f]/g, '').split('_');
  for (let n = bits.length; n > 0; n--) {
    const w = wikiName.get(key(bits.slice(0, n).join('')));
    if (w) return { name: w, team: targets[w] || '', id };
  }
  unresolved.add(id);
  return { name: guessName(id), team: '', id };
}
function jinxList(list) {
  return (list || []).filter(j => j && j.id && j.reason).map(j => {
    const t = jinxTarget(j.id);
    const out = { name: t.name, align: t.team ? (EVIL.has(t.team) ? 'evil' : 'good') : '', text: String(j.reason) };
    if (t.slug) out.slug = t.slug;
    else out.id = String(t.id).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
    return out;
  });
}

/* An alternative version, written out for a side box (links-only marks). */
const TEAM_LABEL = { townsfolk: 'Townsfolk', outsider: 'Outsider', minion: 'Minion', demon: 'Demon',
  traveller: 'Traveller', traveler: 'Traveller', fabled: 'Fabled', loric: 'Loric' };
function versionText(o) {
  const out = [];
  const head = [];
  if (o.name) head.push('**' + o.name + '**' + (o.team ? ' (' + (TEAM_LABEL[o.team] || o.team) + ')' : ''));
  if (o.ability) head.push(o.ability);
  if (head.length) out.push(head.join('\n'));
  const meta = [];
  if (o.firstNightReminder) meta.push('**First night:** ' + o.firstNightReminder);
  if (o.otherNightReminder) meta.push('**Other nights:** ' + o.otherNightReminder);
  const rem = [].concat(o.reminders || [], o.remindersGlobal || []);
  if (rem.length) meta.push('**Reminders:** ' + rem.join(', '));
  if (o.setup) meta.push('**Setup:** yes');
  if (o.attribution) meta.push('**Credit:** ' + o.attribution);
  if (meta.length) out.push(meta.join('\n'));
  const jx = jinxList(o.jinxes);
  if (jx.length) out.push('**Jinxes:**\n' + jx.map(j => j.name + ': ' + j.text).join('\n'));
  return out.join('\n\n');
}

/* Credits. */
function credits(attr) {
  const a = String(attr || '');
  const m = /^Ability:\s*(.*?)\.\s*Image:\s*(.*?)\.?\s*(?:Help:\s*(.*?)\.?)?$/.exec(a);
  const handles = s => s.split(/,|&/).map(x => x.trim()).filter(Boolean);
  if (!m) return { creator: '', iconBy: '', box: a };
  const ab = handles(m[1]);
  const people = ab.filter(x => /^@/.test(x)).map(x => x.slice(1));
  const plain = ab.length === people.length && !m[3] && /^@[\w.]+$/.test(m[2].trim());
  return { creator: people.join(', '), iconBy: m[2].trim().replace(/^@/, ''), box: plain ? '' : a };
}
const ATTR_ODD = /^Ability spawned/;

/* ---------- rows ---------- */
const opts = Object.assign(BI.defaultOptions(), { destination: 'collection', status: 'published', appearsIn: SET });
const planned = BI.plan(bundle, opts);
const art = [];
const rows = [];
const usedAddr = new Set();
for (const r of planned.rows) {
  if (r.action !== 'create') throw new Error('unexpected action for ' + r.name + ': ' + r.action);
  const c = r.entry;
  const slug = slugById[c.id];
  const parts_ = parts[c.id];
  const cr = ATTR_ODD.test(c.attribution)
    ? { creator: 'legitch', iconBy: 'harryandco', box: c.attribution }
    : credits(c.attribution);
  const p = BI.characterPayload(Object.assign({}, c, { howToRun: parts_.lines }),
    Object.assign({}, opts, { creator: cr.creator || 'legitch', credit: false }), slug, 'art/' + slug + '.png', []);
  // Two flavour lines carry pasted HTML (Living Room's <b style>, Duende's
  // <pre><code>); the quote is escaped text here, so the tags would print.
  if (p.quote) p.quote = p.quote.replace(/<b\b[^>]*>([\s\S]*?)<\/b>/g, '**$1**')
    .replace(/<img\b[^>]*>/g, tag => {
      const at = k => ((new RegExp('\\b' + k + '="([^"]*)"')).exec(tag) || [])[1] || '';
      return at('src') ? '[' + (at('alt') || 'image') + '](' + at('src') + ')' : '';
    })
    .replace(/<[^>]+>/g, '').trim();
  delete p.image; // relative art only: artVersions builds the export URL from it
  delete p.status;
  p.iconBy = cr.iconBy;
  p.jsonId = c.id;

  const boxes = [];
  if (cr.box) boxes.push({ title: 'Credit', content: cr.box });
  for (const s of parts_.sections) {
    const isMain = /^JSON( \(Older\))?$/.test(s.title) && s.json.length === 1; // its id is sometimes an older spelling (red_sea_stone_…)
    if (isMain) {
      const o = s.json[0];
      p.jinxes = jinxList(o.jinxes);
      // The almanac's JSON is the author's app JSON. Its night positions are
      // on the official sheet's scale (the fraction is the SCP number:
      // Abdominal 18.007), where script.json's are ranks within this one
      // project, so they are what a character on this wiki should carry —
      // for the nights the published character actually wakes. Its app flags
      // fill in where script.json has none. Any other wording it gives
      // differently is kept in a box rather than chosen between.
      for (const n of ['firstNight', 'otherNight']) {
        if (p[n] > 0 && Number(o[n]) > 0) p[n] = Number(o[n]);
      }
      if (!(p.special && p.special.length) && Array.isArray(o.special) && o.special.length) p.special = o.special;
      const differ = [];
      const fmt = v => Array.isArray(v) ? v.join(', ') : String(v);
      const cmp = (label, mine, theirs) => {
        if (theirs == null || theirs === '' || (Array.isArray(theirs) && !theirs.length)) return;
        if (fmt(mine || '').trim() !== fmt(theirs).trim()) differ.push('**' + label + ':** ' + fmt(theirs));
      };
      cmp('Ability', c.ability, o.ability);
      cmp('First night', p.firstNightReminder, o.firstNightReminder);
      cmp('Other nights', p.otherNightReminder, o.otherNightReminder);
      cmp('Reminders', p.reminders, o.reminders);
      cmp('Global reminders', p.remindersGlobal, o.remindersGlobal);
      if (differ.length) boxes.push({ title: 'In the almanac JSON', content: differ.join('\n') });
      if (s.lines.length) boxes.push({ title: s.title, content: s.lines.join('\n\n') });
      continue;
    }
    const content = s.lines.concat(s.json.map(versionText)).filter(Boolean).join('\n\n');
    if (content) boxes.push({ title: s.title.replace(/^Alternative /, 'Alternative ').trim(), content });
  }
  p.customBoxes = boxes;
  if (!p.jinxes.length) delete p.jinxes;
  for (const k of ['callout', 'edition']) if (!p[k]) delete p[k];
  for (const k of ['summaryBullets', 'examples', 'tips', 'reminders', 'remindersGlobal', 'special', 'customBoxes']) {
    if (Array.isArray(p[k]) && !p[k].length) delete p[k];
  }
  if (!p.tags) delete p.tags;
  for (const k of ['firstNightReminder', 'otherNightReminder', 'quote', 'lede', 'iconBy']) if (!p[k]) delete p[k];
  p.curata = false;

  let addr = SET_ID + '/' + (kebab(p.name) || slug), n = 2;
  while (usedAddr.has(addr)) addr = SET_ID + '/' + (kebab(p.name) || slug) + '-' + n++;
  usedAddr.add(addr);
  rows.push({ slug, name: p.name, team: p.team, creator: p.creator, url_slug: addr, data: unbold(p) });
  art.push({ url: c.image, dest: 'assets/art/' + slug + '.png' });
  if (c.imageAlt || c.imageAlt2) throw new Error('alt art not handled: ' + c.name);
}

/* The collection. */
const meta = bundle.meta;
const order = rows.map(r => r.slug);
const prose = bundle.prose;
const overview = (prose.overview.plain || '').split(/\n+/).map(s => s.trim())
  .filter(s => s && s !== '•').join('\n\n');
const collection = {
  id: SET_ID, slug: SET_ID, displayName: SET,
  author: meta.author.replace(/@/g, '').replace(/,?\s*&\s*/g, ', '),
  description: '', tagline: '', version: '', difficulty: '',
  synopsis: prose.synopsis.plain.trim(),
  gameplay: overview,
  strategyGood: '', strategyEvil: '',
  match: [key(SET)], include: [], exclude: [], order,
  header: '', logo: 'collections/' + SET_ID + '-logo.png',
  theme: { background: 'collections/' + SET_ID + '-bg.jpg' },
  customBoxes: [{ title: 'Source', content: '[The almanac on Bloodstar](' + meta.almanac + ')' }],
  curata: false
};
art.push({ url: meta.logo, dest: 'assets/collections/' + SET_ID + '-logo.png' });
art.push({ url: bundle.background, dest: 'assets/collections/' + SET_ID + '-bg.jpg', any: true });

/* ---------- write ---------- */
fs.writeFileSync(path.join(DIR, 'rows.json'), JSON.stringify({ collection, rows }, null, 1));
fs.writeFileSync(path.join(DIR, 'art.json'), JSON.stringify(art, null, 1));
console.log(rows.length, 'characters;', [...unresolved].length, 'jinx targets not on the wiki:', [...unresolved].join(' '));
