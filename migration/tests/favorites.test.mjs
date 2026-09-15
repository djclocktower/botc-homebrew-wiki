import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';

const member = id => ({ headers: { Cookie: 'botc_session=user-' + id } });
const post = (id, body) => ({
  method: 'POST',
  headers: { Cookie: 'botc_session=user-' + id, 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});
function users(f) {
  for (const id of [1, 2]) {
    f.db.prepare("INSERT INTO users(id,username,password_hash) VALUES(?,?,'')").run(id, 'user-' + id);
    f.state.sessions.set('sess:user-' + id, { userId: id, username: 'user-' + id });
  }
}
function seed(f) {
  for (const slug of ['a', 'b', 'c', 'd']) {
    f.insert('characters', slug, { slug, name: slug.toUpperCase(), team: 'townsfolk', art: 'art/demo.png', ability: 'Does a thing.' });
  }
  f.insert('characters', 'e', { slug: 'e', name: 'E', team: 'minion' }, 'draft');
  f.insert('scripts', 'demo', { slug: 'demo', name: 'Demo', characters: ['b', 'off-imp'] });
  f.insert('collections', 'coll', { id: 'coll-id', slug: 'coll', include: ['c'], displayName: 'Coll' });
}

test('favorites: save by address or id, list, expand through rosters, unsave', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  users(f); seed(f);

  // Logged out: nothing to read, nothing to write.
  assert.equal((await f.request('/api/favorites')).status, 401);
  assert.equal((await f.request('/api/favorite', { method: 'POST', body: '{}' })).status, 401);

  // A character saved by its ADDRESS is stored under its identity.
  let r = await f.request('/api/favorite', post(1, { type: 'character', slug: 'test-set/a', on: true }));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).slug, 'a');
  // A draft is not a page a reader was shown.
  r = await f.request('/api/favorite', post(1, { type: 'character', slug: 'e', on: true }));
  assert.equal(r.status, 400);
  assert.equal((await f.request('/api/favorite', post(1, { type: 'character', slug: 'nope', on: true }))).status, 404);
  assert.equal((await f.request('/api/favorite', post(1, { type: 'news', slug: 'a', on: true }))).status, 400);
  // A script by slug, a collection by its kebab id (stored under the PK).
  assert.equal((await f.request('/api/favorite', post(1, { type: 'script', slug: 'demo', on: true }))).status, 200);
  r = await f.request('/api/favorite', post(1, { type: 'collection', slug: 'coll-id', on: true }));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, on: true, type: 'collection', slug: 'coll', key: 'coll-id', name: 'Coll' });
  // Saving twice is one row.
  assert.equal((await f.request('/api/favorite', post(1, { type: 'character', slug: 'a', on: true }))).status, 200);

  const list = await (await f.request('/api/favorites', member(1))).json();
  assert.deepEqual(list.characters, ['a']);
  assert.deepEqual(list.scripts, ['demo']);
  assert.deepEqual(list.collections, ['coll']);
  // The kebab id rides along: the button on the collection page knows only that.
  assert.deepEqual(list.collectionIds, ['coll-id']);
  assert.equal(list.total, 3);
  assert.equal(list.characterSlugs, undefined);

  // ?expand=1: the saved character, the script's roster (an off- slug is not
  // a page here) and the collection's members.
  const exp = await (await f.request('/api/favorites?expand=1', member(1))).json();
  assert.deepEqual(new Set(exp.characterSlugs), new Set(['a', 'b', 'c']));
  assert.equal(exp.items.characters[0].page, 'test-set/a');
  assert.equal(exp.items.scripts[0].count, 1);
  assert.equal(exp.items.collections[0].key, 'coll-id');
  assert.equal(exp.items.collections[0].count, 1);

  // Another account sees none of it.
  const other = await (await f.request('/api/favorites?expand=1', member(2))).json();
  assert.deepEqual(other.characters, []);
  assert.deepEqual(other.characterSlugs, []);

  // Unsaving the script takes its roster out of the filter.
  r = await f.request('/api/favorite', post(1, { type: 'script', slug: 'demo', on: false }));
  assert.equal((await r.json()).on, false);
  const after = await (await f.request('/api/favorites?expand=1', member(1))).json();
  assert.deepEqual(after.scripts, []);
  assert.deepEqual(new Set(after.characterSlugs), new Set(['a', 'c']));
});

test('favorites: a saved page that stops being public leaves the filter but stays saved', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  users(f); seed(f);
  assert.equal((await f.request('/api/favorite', post(1, { type: 'character', slug: 'a', on: true }))).status, 200);
  assert.equal((await f.request('/api/favorite', post(1, { type: 'collection', slug: 'coll', on: true }))).status, 200);
  f.db.prepare("UPDATE characters SET status='draft' WHERE slug='a'").run();
  f.db.prepare("UPDATE collections SET status='draft' WHERE slug='coll'").run();
  const exp = await (await f.request('/api/favorites?expand=1', member(1))).json();
  assert.deepEqual(exp.characters, ['a']);
  assert.equal(exp.items.characters[0].status, 'draft');
  assert.equal(exp.items.collections[0].status, 'draft');
  assert.deepEqual(exp.characterSlugs, []);
  // Back to published: back in the filter, nothing re-saved.
  f.db.prepare("UPDATE characters SET status='published' WHERE slug='a'").run();
  f.db.prepare("UPDATE collections SET status='published' WHERE slug='coll'").run();
  const again = await (await f.request('/api/favorites?expand=1', member(1))).json();
  assert.deepEqual(new Set(again.characterSlugs), new Set(['a', 'c']));
  // A purged page takes its bookmarks with it.
  f.db.prepare("UPDATE characters SET status='deleted' WHERE slug='a'").run();
  f.state.sessions.set('sess:admin', { userId: 1, username: 'user-1', isAdmin: true });
  f.db.prepare('UPDATE users SET is_admin=1 WHERE id=1').run();
  const purge = await f.request('/api/admin/purge', {
    method: 'POST', headers: { Cookie: 'botc_session=admin', 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'character', slug: 'a' })
  });
  assert.equal(purge.status, 200);
  const gone = await (await f.request('/api/favorites', member(1))).json();
  assert.deepEqual(gone.characters, []);
});

test('favorites: the per-account cap', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  users(f); seed(f);
  assert.equal((await f.request('/api/favorite', post(1, { type: 'character', slug: 'a', on: true }))).status, 200);
  const fill = f.db.prepare("INSERT OR IGNORE INTO favorites(user_id, entity_type, slug) VALUES(1, 'character', ?)");
  for (let i = 0; i < 500; i++) fill.run('filler-' + i);
  const r = await f.request('/api/favorite', post(1, { type: 'character', slug: 'b', on: true }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /limit/);
  // Re-saving one already there is not a new row and is not refused.
  assert.equal((await f.request('/api/favorite', post(1, { type: 'character', slug: 'a', on: true }))).status, 200);
  // Removing still works past the cap.
  assert.equal((await f.request('/api/favorite', post(1, { type: 'character', slug: 'a', on: false }))).status, 200);
});

test('favorites: the server-rendered pages load favorites.js before the scripts that mount the button', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  seed(f);
  // The script tags in document order, by their unversioned names.
  const order = html => (html.match(/<script src="[^"]*"/g) || [])
    .map(tag => tag.replace(/^.*assets\/(?:immutable\/)?([a-z-]+)\..*$/, '$1'));
  const before = (list, a, b) => list.indexOf(a) !== -1 && list.indexOf(a) < list.indexOf(b);
  const char = order(await (await f.request('/c/test-set/a', { headers: { Accept: 'text/html' } })).text());
  assert.ok(before(char, 'favorites', 'charpage'), 'character page order: ' + char);
  const script = order(await (await f.request('/s/demo', { headers: { Accept: 'text/html' } })).text());
  assert.ok(before(script, 'favorites', 'pageview'), 'script page order: ' + script);
  const collHTML = await (await f.request('/collection/coll-id', { headers: { Accept: 'text/html' } })).text();
  const coll = order(collHTML);
  assert.ok(before(coll, 'favorites', 'pageview') && before(coll, 'favorites', 'card-filters'), 'collection page order: ' + coll);
  // Roster cards carry the identity the Favorites chip filters on.
  assert.match(collHTML, /data-slug="c"/);
});
