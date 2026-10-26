import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';
import { parseTags, pickExamples, cueTags, exampleTags, buildMessages, applyChecks } from '../../worker/autotag.js';

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
  assert.ok(c.sure.includes('Duplication'));
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
  assert.ok(cueTags({ ability: 'Each night, your neighbour gets reversed info.' }).sure.includes('Reverse'));
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
  assert.deepEqual(pickExamples(rows[0], rows).filter(r => !r.official).map(r => r.slug), ['a']);
});

test('autotag: up to 3 official characters join the examples, tagged by the official categories', () => {
  const me = { name: 'Abbot', team: 'townsfolk', ability: 'Each night*, choose a player (not yourself): they are safe from the Demon tonight.' };
  const ex = pickExamples(me, []);
  assert.ok(ex.length > 0 && ex.length <= 3 && ex.every(r => r.official));
  const monk = ex.find(r => r.id === 'monk');
  assert.ok(monk && exampleTags(monk).includes('Protection'));
  // A page named like an official character never gets that character as its own example.
  assert.ok(!pickExamples({ name: 'Monk', ability: me.ability }, []).some(r => r.id === 'monk'));
  assert.match(buildMessages(me, ex)[1].content, /Monk \(townsfolk, official\)/);
});

test('autotag: examples are shown with the sure cues their taggers missed', () => {
  assert.deepEqual(exampleTags({ ability: 'Each night*, choose a player: they die. [+1 Outsider]', tags: 'Single-Kill' }).sort(),
    ['Death', 'Outsider Modification', 'Setup', 'Single-Kill']);
});

test('autotag: "you think you are" is Think, "you become the Imp" is Character Change, becoming an alignment is not', () => {
  assert.ok(cueTags({ ability: 'You do not know you are the Drunk. You think you are a Townsfolk character, but you are not.' }).sure.includes('Think'));
  assert.ok(cueTags({ ability: 'If there are 5 or more players alive & the Demon dies, you become the Demon.' }).sure.includes('Character Change'));
  assert.ok(!cueTags({ ability: 'Each night, you become the alignment of an alive neighbor.' }).sure.includes('Character Change'));
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
  // Thinking is off and the answer short: that is most of the wait.
  assert.deepEqual(seen.chat_template_kwargs, { enable_thinking: false });
  assert.equal(seen.max_tokens, 300);

  // quick: the wording rules alone, without asking the model.
  seen = null;
  r = await f.request('/api/suggest-tags', post(1, { quick: true, name: 'X', ability: 'Each night, choose a player: they are poisoned.' }));
  assert.deepEqual((await r.json()).tags, ['Poison']);
  assert.equal(seen, null);
});

test('Magic is not read off "the Storyteller may" alone', () => {
  const hints = c => cueTags(c).hint.map(h => h.tag);
  assert.ok(!hints({ team: 'townsfolk', ability: 'Once per game, at night, the storyteller may prompt a good player making a bad choice to choose differently.' }).includes('Magic'));
  assert.ok(hints({ team: 'townsfolk', ability: 'The Storyteller can break the game rules.' }).includes('Magic'));
});

test('choosing and then learning is Information; someone else learning is not', () => {
  const sure = c => cueTags(c).sure;
  assert.ok(sure({ team: 'minion', ability: 'You start by choosing 3 characters & learning which are in play. Each night, choose 1: you poison them & might register as they would.' }).includes('Information'));
  assert.ok(sure({ team: 'townsfolk', ability: 'Each night, choose a player: learn their alignment.' }).includes('Information'));
  assert.ok(!sure({ team: 'minion', ability: 'Once per game, at night, choose a Minion: they lose their ability & learn you.' }).includes('Information'));
});

test('autotag: a Chinese-edition page counts as an official example, with its official tags added', () => {
  const abbot = { slug: 'abbot', name: 'Abbot', team: 'townsfolk', tags: '',
    ability: 'Each night, the 1st time an evil ability begins affecting one of your alive neighbors, it fails: you learn when this happens.' };
  const me = { slug: 'me', name: 'Me', ability: 'Each night, the 1st time an ability affects your alive neighbors, it fails.' };
  const ex = pickExamples(me, [abbot]).find(r => r.slug === 'abbot');
  assert.ok(ex && ex.official, 'an untagged page still serves, through its official tags');
  assert.ok(exampleTags(ex).includes('Neighbor'));
});

test('autotag: the eval compares the same pages with and without thinking', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  f.db.prepare("INSERT INTO users(id,username,password_hash,is_admin) VALUES(1,'user-1','',1)").run();
  f.state.sessions.set('sess:user-1', { userId: 1, username: 'user-1', isAdmin: true });
  for (const s of ['a', 'b', 'c']) {
    f.insert('characters', s, { slug: s, name: s.toUpperCase(), team: 'townsfolk', art: 'art/x.png', ability: 'Each night*, choose a player: they are safe from the Demon.', tags: 'Protection' });
    f.db.prepare("UPDATE characters SET tags='Protection' WHERE slug=?").run(s);
  }
  const asked = [];
  f.env.AI = { async run(model, input) {
    asked.push(input.chat_template_kwargs.enable_thinking);
    return { response: input.chat_template_kwargs.enable_thinking ? '{"tags":["Protection"]}' : '{"tags":["Quiet"]}' };
  } };
  const r = await f.request('/api/admin/autotag-eval', post(1, { n: 3, compare: true }));
  const d = await r.json();
  assert.equal(d.n, 3);
  assert.deepEqual(d.runs.map(x => x.model), ['phrases', '@cf/google/gemma-4-26b-a4b-it', '@cf/google/gemma-4-26b-a4b-it:think']);
  assert.deepEqual(d.runs.map(x => x.recall), [0, 0, 100]);
  assert.deepEqual(asked.sort(), [false, false, false, true, true, true]);
  assert.ok(d.results.every(x => x.got.length === 3));
});

test('autotag: the eval compares the model in use with a typed one', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  f.db.prepare("INSERT INTO users(id,username,password_hash,is_admin) VALUES(1,'user-1','',1)").run();
  f.state.sessions.set('sess:user-1', { userId: 1, username: 'user-1', isAdmin: true });
  f.insert('characters', 'a', { slug: 'a', name: 'A', team: 'townsfolk', art: 'art/x.png', ability: 'Each night*, choose a player: they are safe from the Demon.', tags: 'Protection' });
  f.db.prepare("UPDATE characters SET tags='Protection' WHERE slug='a'").run();
  const asked = [];
  f.env.AI = { async run(model) { asked.push(model); return { response: '{"tags":["Protection"]}' }; } };
  const r = await f.request('/api/admin/autotag-eval', post(1, { n: 1, compare: true, model: '@cf/meta/other' }));
  const d = await r.json();
  assert.deepEqual(d.runs.map(x => x.model), ['phrases', '@cf/google/gemma-4-26b-a4b-it', '@cf/meta/other']);
  assert.deepEqual(asked, ['@cf/google/gemma-4-26b-a4b-it', '@cf/meta/other']);
});

test('autotag: an ability with nothing to choose, wake for or learn is Passive', () => {
  assert.ok(cueTags({ ability: 'If you die, 1 alive neighbor might die tonight.' }).sure.includes('Passive'));
  assert.ok(!cueTags({ ability: 'Players who are mad that they want to live or die (you start by choosing which) might be executed.' }).sure.includes('Passive'));
  assert.ok(!cueTags({ ability: 'Each night, choose a player: they are poisoned.' }).sure.includes('Passive'));
});

test('autotag: a page checked by hand is the first example, with exactly its checked tags', () => {
  const rows = [
    { slug: 'a', name: 'A', team: 'townsfolk', ability: 'Each night, choose a player: they are safe from the Demon.', tags: 'Protection, Death' },
    { slug: 'b', name: 'B', team: 'townsfolk', ability: 'Each night, choose a player: they are safe from the Demon tonight.', tags: 'Protection' }
  ];
  const checked = applyChecks(rows, new Map([['a', ['Protection', 'Safe']]]));
  assert.equal(checked[0].tags, 'Protection, Safe');
  assert.ok(checked[0].checked && !checked[1].checked);
  const ex = pickExamples({ slug: 'me', name: 'Me', ability: 'Each night, choose a player: they are safe.' }, checked);
  assert.equal(ex[0].slug, 'a');
  assert.deepEqual(exampleTags(ex[0]), ['Protection', 'Safe']);
  assert.ok(buildMessages({ name: 'Me', team: 'townsfolk', ability: 'x' }, ex)[1].content.includes('(townsfolk, checked)'));
});

test('autotag: check tags by hand, then score against the answers', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  f.db.prepare("INSERT INTO users(id,username,password_hash,is_admin) VALUES(1,'user-1','',1)").run();
  f.state.sessions.set('sess:user-1', { userId: 1, username: 'user-1', isAdmin: true });
  f.db.prepare("INSERT INTO users(id,username,password_hash,is_admin) VALUES(2,'user-2','',0)").run();
  f.state.sessions.set('sess:user-2', { userId: 2, username: 'user-2', isAdmin: false });
  f.insert('characters', 'a', { slug: 'a', name: 'A', team: 'townsfolk', art: 'art/x.png', ability: 'Each night*, choose a player: they are safe from the Demon.', tags: 'Protection, Death' });
  f.db.prepare("UPDATE characters SET tags='Protection, Death' WHERE slug='a'").run();
  f.env.AI = { async run() { return { response: '{"tags":["Protection","Poison"]}' }; } };
  assert.equal((await f.request('/api/admin/tag-check', post(2, { action: 'next' }))).status, 403);
  const next = await (await f.request('/api/admin/tag-check', post(1, { action: 'next' }))).json();
  assert.equal(next.slug, 'a');
  assert.deepEqual(next.stored, ['Protection', 'Death']);
  assert.ok(next.suggested.includes('Poison'));
  const saved = await (await f.request('/api/admin/tag-check', post(1, { action: 'save', slug: 'a', tags: ['protection', 'Safe', 'Made Up'], stored: next.stored, suggested: next.suggested }))).json();
  assert.equal(saved.checked, 1);
  assert.deepEqual(JSON.parse(f.db.prepare("SELECT tags FROM tag_checks WHERE slug='a'").get().tags), ['Protection', 'Safe']);
  assert.equal(f.db.prepare("SELECT tags FROM characters WHERE slug='a'").get().tags, 'Protection, Death', 'the page is not touched');
  assert.ok((await (await f.request('/api/admin/tag-check', post(1, { action: 'next' }))).json()).done);
  const d = await (await f.request('/api/admin/autotag-eval', post(1, { n: 5, checked: true }))).json();
  assert.deepEqual(d.results[0].gold, ['Protection', 'Safe']);
  const got = d.results[0].got;
  assert.ok(got.includes('Poison'));
  assert.equal(d.precision, Math.round(100 * got.filter(x => ['Protection', 'Safe'].includes(x)).length / got.length));
  assert.deepEqual(d.oldTags, { precision: 50, recall: 50 });
  const undone = await (await f.request('/api/admin/tag-check', post(1, { action: 'undo', slug: 'a' }))).json();
  assert.equal(undone.checked, 0);
});

test('autotag: Win/Loss Condition is a keyword, but losing an ability is not', () => {
  const wl = a => cueTags({ ability: a }).sure.includes('Win/Loss Condition');
  assert.ok(wl('If you are executed, evil wins.'));
  assert.ok(wl('All Actors jointly reverse the victory conditions.'));
  assert.ok(wl('If you nominate & execute a player, ending the game, the Demon becomes your alignment.'));
  assert.ok(wl('You join the losing team.'));
  assert.ok(!wl('If just 3 players live, you lose this ability.'));
  assert.ok(!wl('Dead players who vote with you do not lose their vote tokens.'));
});

test('autotag: the keywords the owner approved', () => {
  const has = (a, t) => cueTags({ ability: a }).sure.includes(t);
  assert.ok(has('Each day, you may publicly make a wish.', 'Magic'));
  assert.ok(!has('give out as many vats of sake as you wish', 'Magic'));
  assert.ok(has("You think you're a Townsfolk.", 'Think'));
  assert.ok(has('1 Townsfolk thinks they are an Outsider.', 'Think'));
  assert.ok(!has('learn the player the Storyteller thinks is the best kill', 'Think'));
  assert.ok(has('learn the player the Storyteller thinks is the best kill', 'Subjective Info'));
  assert.ok(has('the Storyteller believes evil is winning', 'Subjective Info'));
  assert.ok(has('Dead evil players might rise.', 'Resurrection'));
  assert.ok(has("Each night*, today's executee is raised.", 'Resurrection'));
  assert.ok(!has('Players who raise their hand at night turn evil.', 'Resurrection'));
  assert.ok(has('Each night, become the alignment of the player you nominated.', 'Alignment Change'));
  assert.ok(has('Each night*, choose 2 players: they die.', 'Multi-Kill'));
  assert.ok(has('Each night, you may choose a player: all players learn their character.', 'Loud'));
  assert.ok(has('You have an unlisted Minion ability.', 'Nonconformist'));
  assert.ok(has('Setup modifications might happen at any time.', 'Setup'));
  assert.ok(has('If a majority of players agree, they are executed.', 'Votes'));
  assert.ok(has('When you learn that you died, publicly choose a player.', 'On Death'));
  assert.ok(has('Each night, choose a player to protect.', 'Protection'));
  assert.ok(!has('They are safe from evil until dusk.', 'Protection'));
  assert.ok(has('If you die at night, learn 1 evil player.', 'Demonsbane'));
  assert.ok(!has('Outsiders are drunk, even if you die at night.', 'Demonsbane'));
  assert.ok(has('If you die today or tonight, a player becomes a Lab Rat.', 'Character Change'));
  assert.ok(!has('You become a good player.', 'Character Change'));
  assert.ok(has('If you are executed, a good player learns this.', 'Ping'));
});

test('autotag: the second round of keywords the owner approved', () => {
  const has = (a, t, team) => cueTags({ ability: a, team }).sure.includes(t);
  assert.ok(has('Each night, you learn. [+0 to +2 Legionary]', 'Duplication'));
  assert.ok(!has('Each night, you learn. [+0 to +2 Outsiders]', 'Duplication'));
  assert.ok(has('Choose a player: if executed, they don\'t die.', 'Execution Survival'));
  assert.ok(has('Players may not speak to each other.', 'Social'));
  assert.ok(has('If everyone sings it together, they are sober.', 'Social'));
  assert.ok(!has('Choose a single player.', 'Social'));
  assert.ok(has('Choose a player: if they are evil, choose another player: both die.', 'Multi-Kill'));
  assert.ok(has('Each night, choose a player: you learn their alignment.', 'Binary Info'));
  assert.ok(has('If the Demon dies, a Minion becomes the Demon.', 'Safety Net'));
  assert.ok(has('Executions fail if only evil voted.', 'Execution Failure'));
  assert.ok(has('If they nominate another player tomorrow, that player dies at dusk.', 'Day Deaths'));
  assert.ok(!has('You cannot die at dusk.', 'Day Deaths'));
  assert.ok(has('If your neighbors die, they register as alive.', 'Death Modification'));
  assert.ok(has('Visit the Storyteller to learn a cryptic hint.', 'Subjective Info'));
  assert.ok(has('If they guess correctly, they learn you are the Rockstar.', 'Confirmation'));
  assert.ok(has('You think you are a Townsfolk.', 'Hidden', 'outsider'));
  assert.ok(!has('You think you are a Townsfolk.', 'Hidden', 'minion'));
  assert.ok(has('When you die, they may declare a new rule.', 'Nonconformist'));
  assert.ok(has('Minions know an Official is in play.', 'Ping'));
  assert.ok(has('The Demon learns who you are.', 'Ping'));
  assert.ok(!has('All players learn their character.', 'Ping'));
});

test('autotag: a save after Suggest tags records what was kept, removed and added', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  f.db.prepare("INSERT INTO users(id,username,password_hash,is_admin) VALUES(1,'user-1','',1)").run();
  f.state.sessions.set('sess:user-1', { userId: 1, username: 'user-1', isAdmin: true });
  const r = await f.request('/api/character', post(1, { slug: 'zed', name: 'Zed', team: 'townsfolk', ability: 'Each night, learn a number.',
    tags: 'Information, Neighbor', status: 'draft',
    _tagSuggest: { suggested: ['Information', 'Poison', 'Made Up'], before: [] } }));
  assert.equal(r.status, 200);
  const data = JSON.parse(f.db.prepare("SELECT data FROM characters WHERE slug='zed'").get().data);
  assert.equal(data._tagSuggest, undefined, 'never stored on the page');
  const d = await (await f.request('/api/admin/tag-check', post(1, { action: 'feedback' }))).json();
  assert.equal(d.saves, 1);
  assert.deepEqual(d.perTag.Information, { offered: 1, kept: 1, removed: 0, addedByHand: 0 });
  assert.deepEqual(d.perTag.Poison, { offered: 1, kept: 0, removed: 1, addedByHand: 0 });
  assert.equal(d.perTag.Neighbor.addedByHand, 1);
  assert.equal(d.perTag['Made Up'], undefined);
});

test('autotag: past the daily AI ceiling the button gives the wording rules alone', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  f.db.prepare("INSERT INTO users(id,username,password_hash,is_admin) VALUES(1,'user-1','',1)").run();
  f.state.sessions.set('sess:user-1', { userId: 1, username: 'user-1', isAdmin: true });
  f.insert('characters', 'a', { slug: 'a', name: 'A', team: 'townsfolk', art: 'art/x.png', ability: 'Each night, choose a player: they are poisoned.', tags: 'Poison' });
  f.db.prepare("UPDATE characters SET tags='Poison' WHERE slug='a'").run();
  let asked = 0;
  f.env.AI = { async run() { asked++; return { response: '{"tags":["Poison"]}' }; } };
  const ask = () => f.request('/api/suggest-tags', post(1, { name: 'X', team: 'townsfolk', ability: 'You start knowing 1 drunk player.' })).then(r => r.json());
  const first = await ask();
  assert.ok(first.tags.includes('Poison') && !first.capped && asked === 1);
  // The first call was charged from its usage (none given here: the most it could have cost).
  const key = 'ai:spend:' + new Date().toISOString().slice(0, 10);
  const charged = f.db.prepare('SELECT n FROM rate_limits WHERE key = ?').get(key).n;
  assert.ok(charged > 0 && charged < 2000, 'a Gemma call is a fraction of a cent: ' + charged + ' millionths');
  f.db.prepare('UPDATE rate_limits SET n = 25000000 WHERE key = ?').run(key);
  const second = await ask();
  assert.ok(second.capped && asked === 1, 'no AI call past the ceiling');
  assert.ok(second.tags.includes('Drunkenness') && !second.tags.includes('Poison'));
  const ev = await f.request('/api/admin/autotag-eval', post(1, { n: 5 }));
  assert.equal(ev.status, 429, 'a run that does not fit is refused up front');
  assert.equal((await f.request('/api/admin/autotag-eval', post(1, { n: 5, model: 'phrases' }))).status, 200, 'the wording rules cost nothing');
});

test('autotag: each AI call is charged its real token cost', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  f.db.prepare("INSERT INTO users(id,username,password_hash,is_admin) VALUES(1,'user-1','',0)").run();
  f.state.sessions.set('sess:user-1', { userId: 1, username: 'user-1', isAdmin: false });
  f.env.AI = { async run() { return { response: '{"tags":["Poison"]}', usage: { prompt_tokens: 1000, completion_tokens: 100 } }; } };
  await f.request('/api/suggest-tags', post(1, { name: 'X', team: 'townsfolk', ability: 'Each night, choose a player.' }));
  const key = 'ai:spend:' + new Date().toISOString().slice(0, 10);
  // Gemma: 1,000 x $0.10/M + 100 x $0.30/M = $0.00013
  assert.equal(f.db.prepare('SELECT n FROM rate_limits WHERE key = ?').get(key).n, 130);
});
