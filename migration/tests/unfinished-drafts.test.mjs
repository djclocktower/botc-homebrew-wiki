import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';

/* A character draft can be put away unfinished — no name, no ability, no
   icon — and finished later. Publishing still needs all three. */

const post = (f, path, body) => f.request(path, {
  method: 'POST',
  headers: { Cookie: 'botc_session=user-1', 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});
async function setup(t) {
  const f = await fixture();
  t.after(() => f.finish());
  f.db.prepare("INSERT INTO users(id,username,password_hash) VALUES(1,'user-1','')").run();
  f.state.sessions.set('sess:user-1', { userId: 1, username: 'user-1' });
  return f;
}
const row = (f, slug) => f.db.prepare('SELECT name, status, data FROM characters WHERE slug=?').get(slug);

test('a draft saves with no name, no ability and no icon', async t => {
  const f = await setup(t);
  const r = await post(f, '/api/character', { slug: 'untitled-abc123', team: 'townsfolk', status: 'draft' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.status, 'draft');
  const saved = row(f, 'untitled-abc123');
  assert.equal(saved.status, 'draft');
  assert.equal(saved.name, '');
  assert.deepEqual(j.missingForPublish, ['a name', 'an icon', 'an ability']);

  // Naming it later is an ordinary save of the same identity.
  const r2 = await post(f, '/api/character', { slug: 'untitled-abc123', team: 'townsfolk', name: 'Lamplighter',
    ability: 'Each night, learn something.', status: 'draft' });
  assert.equal(r2.status, 200);
  assert.equal(row(f, 'untitled-abc123').name, 'Lamplighter');
});

test('an unfinished character cannot be published', async t => {
  const f = await setup(t);
  // No name or no ability on a publish is refused outright...
  let r = await post(f, '/api/character', { slug: 'nameless', team: 'townsfolk', ability: 'Does a thing.', art: 'art/nameless.png' });
  assert.equal(r.status, 400);
  r = await post(f, '/api/character', { slug: 'blank', name: 'Blank', team: 'townsfolk', art: 'art/blank.png' });
  assert.equal(r.status, 400);
  assert.equal(row(f, 'blank'), undefined);

  // ...and a draft without them cannot be pushed live through /api/publish.
  await post(f, '/api/character', { slug: 'half', team: 'townsfolk', status: 'draft' });
  r = await post(f, '/api/publish', { type: 'character', slug: 'half', status: 'published' });
  assert.notEqual(r.status, 200);
  assert.equal(row(f, 'half').status, 'draft');

  // A publish with no icon is still kept, as a draft.
  r = await post(f, '/api/character', { slug: 'iconless', name: 'Iconless', team: 'townsfolk', ability: 'Does a thing.' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, 'draft');
});

test('a draft published later counts as recently added, by either door', async t => {
  const f = await setup(t);
  const full = (slug, status) => ({ slug, name: slug, team: 'townsfolk', ability: 'Does a thing.',
    art: 'art/' + slug + '.png', status });
  await post(f, '/api/character', full('early', 'draft'));
  await post(f, '/api/character', full('saved', 'draft'));
  await post(f, '/api/character', full('live', 'published'));
  const recent = async () => (await (await f.request('/api/home')).json()).recent.map(c => c.slug);
  assert.deepEqual(await recent(), ['live']);
  // Publishing from the editor, then through /api/publish: each goes to the top.
  assert.equal((await post(f, '/api/character', full('saved', 'published'))).status, 200);
  assert.deepEqual(await recent(), ['saved', 'live']);
  assert.equal((await post(f, '/api/publish', { type: 'character', slug: 'early', status: 'published' })).status, 200);
  assert.deepEqual(await recent(), ['early', 'saved', 'live']);
  // An ordinary save of a live page does not move it.
  await post(f, '/api/character', full('saved', 'published'));
  assert.deepEqual(await recent(), ['early', 'saved', 'live']);
});
