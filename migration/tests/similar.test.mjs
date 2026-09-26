import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';
import { buildSimilarIndex, similarTo, abilityTerms } from '../../worker/similar.js';

// Curata lifts a page out of Partial, which is the one thing a test character
// with no almanac text needs to be suggested at all.
const ch = (slug, team, ability, tags, extra = {}) => ({ slug, name: slug[0].toUpperCase() + slug.slice(1), team, ability, tags, art: 'art/' + slug + '.png', curata: true, ...extra });

test('similar: ability words and tags decide, partial pages and exact copies never appear', () => {
  const idx = buildSimilarIndex([
    { ...ch('poisoner', 'minion', 'Each night, choose a player: they are poisoned tonight and tomorrow day.', 'Poison'), creator: 'A' },
    { ...ch('witch', 'minion', 'Each night, choose a player: they are poisoned until dusk.', 'Poison'), creator: 'B' },
    { ...ch('empath', 'townsfolk', 'Each night, you learn how many of your alive neighbours are evil.', 'Information'), creator: 'C' },
    { ...ch('unfinished', 'minion', 'Each night, choose a player: they are poisoned.', 'Poison'), classification: 'partial' },
    { ...ch('copy', 'minion', 'Each night, choose a player: they are poisoned tonight and tomorrow day.', 'Poison') },
    { ...ch('seer', 'townsfolk', 'Each night, you learn how many evil players are alive.', 'Information'), creator: 'D' }
  ]);
  const near = similarTo(idx, 'poisoner');
  assert.equal(near[0].slug, 'witch');
  assert.ok(!near.some(c => c.slug === 'unfinished'), 'a Partial page is never suggested');
  assert.ok(!near.some(c => c.slug === 'copy'), 'a word-for-word copy of the ability is not a suggestion');
  assert.ok(!near.some(c => c.slug === 'poisoner'), 'never itself');
  assert.equal(similarTo(idx, 'empath')[0].slug, 'seer');
  assert.deepEqual(similarTo(idx, 'nobody'), []);
  // Consistent stems: "votes", "voted" and "vote" are one word.
  assert.ok(abilityTerms('votes voted vote').get('vot') === 3);
});

test('similar: at most two suggestions from one creator', () => {
  const list = [ch('q', 'demon', 'Each night*, choose a player: they die.', 'Death')];
  for (let i = 0; i < 5; i++) list.push({ ...ch('a' + i, 'demon', 'Each night*, choose a player: they die. Minions learn this.', 'Death'), creator: 'Prolific' });
  list.push({ ...ch('b', 'demon', 'Each night*, choose a player: they die.  You may choose twice.', 'Death'), creator: 'Other' });
  const near = similarTo(buildSimilarIndex(list), 'q');
  assert.equal(near.filter(c => c.creator === 'Prolific').length, 2);
  assert.ok(near.some(c => c.slug === 'b'));
});

test('GET /api/similar: published only, version-keyed ETag, drafts and junk get an empty list', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  f.insert('characters', 'poisoner', ch('poisoner', 'minion', 'Each night, choose a player: they are poisoned tonight and tomorrow day.', 'Poison'));
  f.insert('characters', 'witch', ch('witch', 'minion', 'Each night, choose a player: they are poisoned until dusk.', 'Poison'));
  f.insert('characters', 'hidden', ch('hidden', 'minion', 'Each night, choose a player: they are poisoned tonight.', 'Poison'), 'draft');

  let r = await f.request('/api/similar?slug=poisoner');
  assert.equal(r.status, 200);
  const etag = r.headers.get('ETag');
  assert.match(etag, /^W\/"similar-poisoner-v/);
  const body = await r.json();
  assert.deepEqual(body.items.map(c => c.slug), ['witch']);
  // The card carries the address, not the identity, as its link.
  assert.equal(body.items[0].page, 'c/test-set/witch');
  assert.equal(body.items[0].data, undefined);

  // A draft is neither suggested nor answered for.
  r = await f.request('/api/similar?slug=hidden');
  assert.deepEqual((await r.json()).items, []);
  // Anything that is not an identity is refused quietly.
  assert.deepEqual((await (await f.request('/api/similar?slug=' + encodeURIComponent('../x'))).json()).items, []);
  assert.deepEqual((await (await f.request('/api/similar')).json()).items, []);

  // A repeat visit is a 304 until the content changes.
  r = await f.request('/api/similar?slug=poisoner', { headers: { 'If-None-Match': etag } });
  assert.equal(r.status, 304);
  await f.hooks.bumpContentVersion(f.env, 'character');
  r = await f.request('/api/similar?slug=poisoner', { headers: { 'If-None-Match': etag } });
  assert.equal(r.status, 200);
});
