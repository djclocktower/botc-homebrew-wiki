import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';
import { parseTags, pickExamples } from '../../worker/autotag.js';

const post = (id, body) => ({
  method: 'POST',
  headers: { Cookie: 'botc_session=user-' + id, 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

test('autotag: only listed tags survive, Joke never does', () => {
  assert.deepEqual(parseTags('sure {"tags":["poison","Made Up","Joke","Death","Poison"]}'), ['Poison', 'Death']);
  assert.deepEqual(parseTags('I would say "Information" and "Neighbor".'), ['Information', 'Neighbor']);
  assert.deepEqual(parseTags(''), []);
});

test('autotag: examples are similar tagged pages, never the page itself', () => {
  const rows = [
    { slug: 'me', name: 'Me', ability: 'Each night, choose a player: they are poisoned.', tags: 'Poison' },
    { slug: 'a', name: 'A', ability: 'Each night, choose a player: they are poisoned tonight.', tags: 'Poison' },
    { slug: 'b', name: 'B', ability: 'You start knowing a number.', tags: 'Information' },
    { slug: 'c', name: 'C', ability: 'Each night, poisoned players die.', tags: '' }
  ];
  assert.deepEqual(pickExamples(rows[0], rows).map(r => r.slug), ['a']);
});

test('autotag: /api/suggest-tags needs a login and an ability, and answers from the model', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  f.db.prepare("INSERT INTO users(id,username,password_hash) VALUES(1,'user-1','')").run();
  f.state.sessions.set('sess:user-1', { userId: 1, username: 'user-1' });
  f.insert('characters', 'pois', { slug: 'pois', name: 'Pois', team: 'minion', art: 'art/x.png', ability: 'Each night, choose a player: they are poisoned.', tags: 'Poison' });
  f.db.prepare("UPDATE characters SET tags='Poison' WHERE slug='pois'").run();

  assert.equal((await f.request('/api/suggest-tags', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await f.request('/api/suggest-tags', post(1, { name: 'X' }))).status, 400);
  // No binding yet: says so rather than failing blank.
  let r = await f.request('/api/suggest-tags', post(1, { name: 'X', ability: 'Each night, choose a player: they are poisoned.' }));
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /not switched on/);

  let seen = null;
  f.env.AI = { async run(model, input) { seen = input; return { response: '{"tags":["Poison","Nonsense"]}' }; } };
  r = await f.request('/api/suggest-tags', post(1, { name: 'X', team: 'minion', ability: 'Each night, choose a player: they are poisoned.' }));
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).tags, ['Poison']);
  assert.match(seen.messages[1].content, /Pois \(minion\)/);
});
