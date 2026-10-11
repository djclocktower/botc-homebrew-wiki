// The edit-conflict stamp on every save route: a save posting the updated_at
// it loaded is refused with a 409 (`conflict: true`) once somebody else has
// saved over it, and every save answers with the new stamp so the editor's
// next save from the same tab is not refused as stale.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';

const STALE = '2026-01-01 00:00:00';
const SEEDED = '2026-09-09 00:00:00';

const post = (id, body) => ({
  method: 'POST',
  headers: { Cookie: 'botc_session=user-' + id, 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});
function users(f) {
  for (const id of [1, 2, 3]) {
    f.db.prepare("INSERT INTO users(id,username,password_hash) VALUES(?,?,'')").run(id, 'user-' + id);
    f.state.sessions.set('sess:user-' + id, { userId: id, username: 'user-' + id });
  }
}
const stampOf = (f, table, slug) => f.db.prepare(`SELECT updated_at FROM ${table} WHERE slug=?`).get(slug).updated_at;
const dataOf = (f, table, slug) => JSON.parse(f.db.prepare(`SELECT data FROM ${table} WHERE slug=?`).get(slug).data);
const count = (f, sql, ...v) => f.db.prepare(sql).get(...v).n;

test('script: stale base is refused, the returned stamp saves again, no base still saves', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  users(f);
  f.insert('scripts', 'demo', { slug: 'demo', name: 'Demo', author: 'One', characters: ['off-imp'] });
  f.db.prepare('UPDATE scripts SET owner_id=1 WHERE slug=?').run('demo');
  const before = dataOf(f, 'scripts', 'demo');
  const revs = () => count(f, 'SELECT count(*) n FROM revisions');

  // A stranger with a stale stamp is told 403, never 409: the stamp says
  // when the page was last saved, which is nothing a stranger may probe.
  let r = await f.request('/api/script', post(2, { slug: 'demo', name: 'X', author: 'Two', baseUpdatedAt: STALE }));
  assert.equal(r.status, 403);

  const revBefore = revs();
  r = await f.request('/api/script', post(1, { slug: 'demo', name: 'Changed', author: 'One', baseUpdatedAt: STALE }));
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.equal(body.conflict, true);
  assert.equal(body.savedAt, SEEDED);
  assert.deepEqual(dataOf(f, 'scripts', 'demo'), before);
  assert.equal(revs(), revBefore);

  r = await f.request('/api/script', post(1, { slug: 'demo', name: 'Changed', author: 'One', baseUpdatedAt: SEEDED }));
  assert.equal(r.status, 200);
  const saved = await r.json();
  assert.ok(saved.updatedAt);
  assert.equal(saved.updatedAt, stampOf(f, 'scripts', 'demo'));
  assert.equal(dataOf(f, 'scripts', 'demo').baseUpdatedAt, undefined);

  // The editor's second save from the same tab posts what the first returned.
  r = await f.request('/api/script', post(1, { slug: 'demo', name: 'Again', author: 'One', baseUpdatedAt: saved.updatedAt }));
  assert.equal(r.status, 200);

  // No stamp at all is the importers' opt-out, and it must keep working.
  r = await f.request('/api/script', post(1, { slug: 'demo', name: 'Imported', author: 'One' }));
  assert.equal(r.status, 200);
  assert.equal(dataOf(f, 'scripts', 'demo').name, 'Imported');
});

test('collection: legacy PK saved by id, stale base 409, returned stamp, creation clash has no conflict flag', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  users(f);
  f.insert('collections', 'The Academy', { id: 'the-academy', slug: 'The Academy', displayName: 'The Academy', match: ['academy'] });
  f.db.prepare('UPDATE collections SET owner_id=1 WHERE slug=?').run('The Academy');

  let r = await f.request('/api/collection', post(2, { id: 'the-academy', displayName: 'X', baseUpdatedAt: STALE }));
  assert.equal(r.status, 403);

  r = await f.request('/api/collection', post(1, { id: 'the-academy', displayName: 'Mine', baseUpdatedAt: STALE }));
  assert.equal(r.status, 409);
  assert.equal((await r.json()).conflict, true);
  assert.equal(dataOf(f, 'collections', 'The Academy').displayName, 'The Academy');

  r = await f.request('/api/collection', post(1, { id: 'the-academy', displayName: 'Mine', baseUpdatedAt: SEEDED }));
  assert.equal(r.status, 200);
  const saved = await r.json();
  assert.equal(saved.slug, 'The Academy');
  assert.equal(saved.updatedAt, stampOf(f, 'collections', 'The Academy'));

  r = await f.request('/api/collection', post(1, { id: 'the-academy', displayName: 'Mine again', baseUpdatedAt: saved.updatedAt }));
  assert.equal(r.status, 200);
  r = await f.request('/api/collection', post(1, { id: 'the-academy', displayName: 'No stamp' }));
  assert.equal(r.status, 200);

  // Creating one whose name another collection already has is a 409 too, but
  // not a conflict: the editors must show it as the plain error it is.
  f.insert('collections', 'other', { id: 'taken-name', slug: 'other', displayName: 'Taken Name' });
  r = await f.request('/api/collection', post(2, { slug: 'fresh', displayName: 'Taken Name' }));
  assert.equal(r.status, 409);
  assert.notEqual((await r.json()).conflict, true);
});

test('wiki page: created with a stamp, stale base 409, approved editor checked too, delete unchecked', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  users(f);
  await f.hooks.ensurePagesTable(f.env);
  f.insert('scripts', 'parent', { slug: 'parent', name: 'Parent', author: 'One', characters: [],
    publicEdit: 'approved', editors: [{ id: 3, username: 'user-3' }] });
  f.db.prepare('UPDATE scripts SET owner_id=1 WHERE slug=?').run('parent');

  let r = await f.request('/api/wiki-page', post(1, { title: 'Rules', body: 'First text.', parentType: 'script', parentSlug: 'parent', status: 'published' }));
  assert.equal(r.status, 200);
  const made = await r.json();
  assert.ok(made.slug);
  assert.ok(made.updatedAt);
  const slug = made.slug;
  f.db.prepare('UPDATE pages SET updated_at=? WHERE slug=?').run(SEEDED, slug);

  r = await f.request('/api/wiki-page', post(2, { slug, title: 'Rules', body: 'Stranger.', baseUpdatedAt: STALE }));
  assert.equal(r.status, 403);

  r = await f.request('/api/wiki-page', post(1, { slug, title: 'Rules', body: 'Mine.', baseUpdatedAt: STALE }));
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.equal(body.conflict, true);
  assert.equal(body.savedAt, SEEDED);
  assert.equal(dataOf(f, 'pages', slug).body, 'First text.');

  r = await f.request('/api/wiki-page', post(3, { slug, title: 'Rules', body: 'Editor.', baseUpdatedAt: STALE }));
  assert.equal(r.status, 409);

  r = await f.request('/api/wiki-page', post(1, { slug, title: 'Rules', body: 'Mine.', baseUpdatedAt: SEEDED }));
  assert.equal(r.status, 200);
  const saved = await r.json();
  assert.equal(saved.updatedAt, stampOf(f, 'pages', slug));
  assert.equal(dataOf(f, 'pages', slug).baseUpdatedAt, undefined);

  r = await f.request('/api/wiki-page', post(1, { slug, title: 'Rules', body: 'Second.', baseUpdatedAt: saved.updatedAt }));
  assert.equal(r.status, 200);
  r = await f.request('/api/wiki-page', post(1, { slug, title: 'Rules', body: 'No stamp.' }));
  assert.equal(r.status, 200);

  // Deleting is not a save over somebody's text, and is not checked.
  r = await f.request('/api/wiki-page', post(1, { action: 'delete', slug, baseUpdatedAt: STALE }));
  assert.equal(r.status, 200);
  assert.equal(count(f, 'SELECT count(*) n FROM pages WHERE slug=?', slug), 0);
});

test('character: the stale-base 409 and the returned stamp still hold', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  users(f);
  f.insert('characters', 'wiretap', { slug: 'wiretap', name: 'Wiretap', team: 'townsfolk', art: 'art/demo.png', ability: 'Does a thing.' });
  f.db.prepare('UPDATE characters SET owner_id=1 WHERE slug=?').run('wiretap');
  const base = { slug: 'wiretap', name: 'Wiretap', team: 'townsfolk', art: 'art/demo.png', ability: 'Does a thing.' };

  let r = await f.request('/api/character', post(1, { ...base, lede: 'Mine', baseUpdatedAt: STALE }));
  assert.equal(r.status, 409);
  assert.equal((await r.json()).conflict, true);

  r = await f.request('/api/character', post(1, { ...base, lede: 'Mine', baseUpdatedAt: SEEDED }));
  assert.equal(r.status, 200);
  const saved = await r.json();
  assert.equal(saved.updatedAt, stampOf(f, 'characters', 'wiretap'));
});
