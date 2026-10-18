#!/usr/bin/env node
/*
 * Run rows.json through the Worker's own save handlers (/api/collection, then
 * /api/character for each character) on the test fixture's SQLite, and write
 * the rows exactly as the Worker stored them to sql/final-*.sql. Writing the
 * built rows straight to D1 would skip every sanitizer and the official-
 * character guard; this way the live rows are what a save would have made.
 * The fixture's admin owns them here; the SQL writes owner_id NULL, as the
 * other seeded sets are (an admin assigns an owner later and the characters
 * follow — see "Assigning an owner").
 *
 *   node migration/scp-fragmented-veil/through-worker.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fixture } from '../tests/worker-fixture.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const { collection, rows } = JSON.parse(fs.readFileSync(path.join(DIR, 'rows.json'), 'utf8'));
const f = await fixture();
f.db.prepare("INSERT INTO users(id,username,password_hash,is_admin) VALUES(1,'importer','',1)").run();
f.state.sessions.set('sess:importer', { userId: 1, username: 'importer', isAdmin: true });
const post = (p, body) => f.request(p, { method: 'POST',
  headers: { Cookie: 'botc_session=importer', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function must(p, body) {
  const r = await post(p, body);
  const t = await r.text();
  if (r.status !== 200) throw new Error(p + ' ' + (body.name || body.displayName) + ': ' + r.status + ' ' + t);
  return JSON.parse(t);
}
await must('/api/collection', { ...collection, status: 'published' });
for (const r of rows) await must('/api/character', { ...r.data, status: 'published' });

// A page renders, and nothing in the stored rows still points at Bloodstar.
for (const p of ['/collection/' + collection.id, '/c/' + rows[0].url_slug]) {
  const res = await f.request(p);
  if (res.status !== 200) throw new Error(p + ' ' + res.status);
}
const chars = f.db.prepare("SELECT * FROM characters ORDER BY rowid").all();
const coll = f.db.prepare("SELECT * FROM collections").all();
if (chars.length !== rows.length || coll.length !== 1) throw new Error('row count');
for (const c of chars) {
  if (c.status !== 'published') throw new Error(c.name + ' saved as ' + c.status);
  if (/bloodstar\.xyz\/p\/legitch\/[^"]*\.png/.test(c.data)) throw new Error(c.name + ' still names Bloodstar art');
}

const q = v => v == null ? 'NULL' : typeof v === 'number' ? String(v) : "'" + String(v).replace(/'/g, "''") + "'";
const out = path.join(DIR, 'sql');
for (const old of fs.readdirSync(out)) fs.unlinkSync(path.join(out, old));
fs.writeFileSync(path.join(out, 'final-00-collection.sql'),
  'INSERT INTO collections (slug,display_name,owner_id,data,updated_at,created_at,status) VALUES (' +
  [coll[0].slug, coll[0].display_name, null, coll[0].data].map(q).join(',') +
  ",datetime('now'),datetime('now'),'published');\n");
// D1 takes a statement of up to 100 KB; batches are kept well under it.
let batch = [], size = 0, n = 1;
const flush = () => {
  if (!batch.length) return;
  fs.writeFileSync(path.join(out, 'final-' + String(n++).padStart(2, '0') + '-characters.sql'),
    'INSERT INTO characters (slug,name,team,creator,owner_id,tags,appears_in,data,url_slug,status,updated_at,created_at) VALUES\n' +
    batch.join(',\n') + ';\n');
  batch = []; size = 0;
};
for (const c of chars) {
  const v = '(' + [c.slug, c.name, c.team, c.creator, null, c.tags || '', c.appears_in, c.data, c.url_slug].map(q).join(',') +
    ",'published',datetime('now'),datetime('now'))";
  if (size + v.length > 20000) flush();
  batch.push(v); size += v.length;
}
flush();
fs.writeFileSync(path.join(DIR, 'stored.json'), JSON.stringify({ collection: coll[0], characters: chars }, null, 1));
console.log('ok:', chars.length, 'characters; addresses e.g.', chars.slice(0, 3).map(c => c.url_slug).join(' '));
await f.finish();
