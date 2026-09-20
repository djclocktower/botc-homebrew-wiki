import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';

const post = (id, body) => ({
  method: 'POST',
  headers: { Cookie: 'botc_session=user-' + id, 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});
function member(f, id) {
  f.db.prepare("INSERT INTO users(id,username,password_hash) VALUES(?,?,'')").run(id, 'user-' + id);
  f.state.sessions.set('sess:user-' + id, { userId: id, username: 'user-' + id });
}
const page = { team: 'townsfolk', ability: 'Does a thing.', art: 'art/demo.png', tags: 'Information', appearsIn: 'Test Set' };
async function save(f, body) {
  const r = await f.request('/api/character', post(1, { ...page, ...body }));
  const text = await r.text();
  assert.equal(r.status, 200, text);
  return JSON.parse(text);
}
const redirectFor = (f, from) =>
  f.db.prepare("SELECT to_slug FROM redirects WHERE entity_type='character' AND from_slug=?").get(from)?.to_slug;

test('addresses: an address parked by a live page is still taken', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  member(f, 1);
  // A page named Cryptographer, renamed to Anthropologist: its old address
  // becomes a redirect to it, and the page it points at is live.
  assert.equal((await save(f, { slug: 'anthropologist-test', name: 'Cryptographer' })).page, 'c/test-set/cryptographer');
  assert.equal((await save(f, { slug: 'anthropologist-test', name: 'Anthropologist' })).page, 'c/test-set/anthropologist');
  assert.equal(redirectFor(f, 'test-set/cryptographer'), 'anthropologist-test');
  // So a new Cryptographer in the same set is a numbered duplicate: the
  // links posted to the old address keep reaching the page that moved.
  assert.equal((await save(f, { slug: 'cryptographer', name: 'Cryptographer' })).page, 'c/test-set/cryptographer-2');
  assert.equal(redirectFor(f, 'test-set/cryptographer'), 'anthropologist-test');
});

test('addresses: a redirect left by a deleted page does not park the address', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  member(f, 1);
  assert.equal((await save(f, { slug: 'anthropologist-test', name: 'Cryptographer' })).page, 'c/test-set/cryptographer');
  assert.equal((await save(f, { slug: 'anthropologist-test', name: 'Anthropologist' })).page, 'c/test-set/anthropologist');
  const r = await f.request('/api/delete', post(1, { type: 'character', slug: 'anthropologist-test' }));
  const text = await r.text();
  assert.equal(r.status, 200, text);
  // The parked address now leads nowhere...
  assert.equal((await f.request('/c/test-set/cryptographer')).status, 404);
  // ...so the next page whose name and set ask for it takes it, unnumbered,
  // and the dead redirect row goes with it.
  assert.equal((await save(f, { slug: 'cryptographer', name: 'Cryptographer' })).page, 'c/test-set/cryptographer');
  assert.equal(f.db.prepare("SELECT url_slug FROM characters WHERE slug='cryptographer'").get().url_slug, 'test-set/cryptographer');
  assert.equal(redirectFor(f, 'test-set/cryptographer'), undefined);
  assert.equal((await f.request('/c/test-set/cryptographer')).status, 200);
  // The deleted page is still deleted and still unreachable.
  assert.equal((await f.request('/c/anthropologist-test')).status, 404);
  assert.equal((await f.request('/c/test-set/anthropologist')).status, 404);
});
