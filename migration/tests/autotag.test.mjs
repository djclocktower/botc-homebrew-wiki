import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';
import { parseTags, pickExamples, cueTags } from '../../worker/autotag.js';

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

test('autotag: wording cues, sure and hinted', () => {
  const c = cueTags({ name: 'Legionary', team: 'townsfolk', ability: 'Each night, you learn how many evil players are sat clockwise to the next Legionary. Once per game, you may visit the Storyteller. [+0 to +2 Legionary]' });
  for (const t of ['Information', 'Once Per Game', 'Consult', 'Setup']) assert.ok(c.sure.includes(t), t);
  assert.ok(c.hint.some(h => h.tag === 'Duplication'));
  assert.ok(c.hint.some(h => h.tag === 'Neighbor' && /clockwise/i.test(h.words)));
  // An escalating demon is Multi-Kill, so its "choose a player: they die" is no longer sure Single-Kill.
  const d = cueTags({ team: 'demon', ability: 'Each night*, choose a player: they die. Once 3 players die this way, choose 2 players: they die.' });
  assert.ok(!d.sure.includes('Single-Kill'));
  assert.ok(cueTags({ team: 'demon', ability: 'Each night*, choose a player: they die.' }).sure.includes('Single-Kill'));
  // Any team, and a once-per-game kill counts; "might die" never does.
  assert.ok(cueTags({ team: 'townsfolk', ability: 'Once per game, choose a player: they die.' }).sure.includes('Single-Kill'));
  assert.ok(!cueTags({ team: 'demon', ability: 'Each night*, a player might die.' }).sure.includes('Single-Kill'));
  // The owner's rulings: "false" is always False Info, a win on a set day is Timer, someone else learning is Ping.
  assert.ok(cueTags({ ability: 'You learn 2 players, 1 is false.' }).sure.includes('False Info'));
  assert.ok(cueTags({ ability: 'If you are alive, evil wins after day 4.' }).sure.includes('Timer'));
  assert.ok(!cueTags({ ability: 'On night 3, choose a player.' }).sure.includes('Timer'));
  assert.ok(cueTags({ ability: 'Each day, you may privately learn a statement.' }).sure.includes('Information'));
  assert.ok(cueTags({ ability: 'You start by choosing 2 characters: you know how many are in play.' }).sure.includes('Information'));
  assert.ok(cueTags({ ability: 'Twice per game, choose 2 players: they swap characters.' }).sure.includes('Character Change'));
  const p = cueTags({ ability: 'Each night, choose a player: they learn the Perfumer is in play.' });
  assert.ok(!p.sure.includes('Information') && p.hint.some(h => h.tag === 'Ping'));
  // "even if you die" keeps working after death; it is not an on-death trigger.
  const e = cueTags({ ability: 'Your neighbour is drunk, even if you die.' });
  assert.ok(e.sure.includes('Even If Dead') && !e.sure.includes('On Death'));
  assert.ok(!cueTags({ ability: 'You lose your ability.' }).sure.includes('Win/Loss Condition'));
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
  // No binding yet: says so rather than failing blank, unless the wording alone settles something.
  let r = await f.request('/api/suggest-tags', post(1, { name: 'X', ability: 'Each night, choose a player.' }));
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /not switched on/);
  r = await f.request('/api/suggest-tags', post(1, { name: 'X', ability: 'Each night, choose a player: they are poisoned.' }));
  assert.deepEqual((await r.json()).tags, ['Poison']);

  let seen = null;
  f.env.AI = { async run(model, input) { seen = input; return { response: '{"tags":["Protection","Nonsense"]}' }; } };
  r = await f.request('/api/suggest-tags', post(1, { name: 'X', team: 'minion', ability: 'Each night, choose a player: they are poisoned.' }));
  assert.equal(r.status, 200);
  // The sure cue is kept even though the model left it out.
  assert.deepEqual((await r.json()).tags, ['Poison', 'Protection']);
  assert.match(seen.messages[1].content, /Pois \(minion\)/);
  assert.match(seen.messages[1].content, /Already certain from its wording \(do not repeat\): Poison/);
});
