// Run with Node 22.13+ / 24: node --test migration/tests/scale.test.mjs
// Growth and spikes: a database outage must not take down pages the edge
// already holds, and one edit must not cost two whole-catalogue builds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';

test('cached pages keep serving while D1 is unreachable', async () => {
  const f = await fixture();
  f.insert('characters', 'keeper', { name: 'Keeper', team: 'townsfolk', ability: 'You keep things.', art: 'art/keeper.png' });
  const first = await f.request('/c/test-set/keeper');
  assert.equal(first.status, 200);
  const html = await first.text();
  await Promise.all(f.background);
  // The last good version is also stored for the colo's fresh isolates.
  assert.ok(f.cache.has('https://feed.internal/content-version.json'));

  const realNow = Date.now;
  Date.now = () => realNow() + 6000;   // past the 5 s version memo
  f.state.intercept = () => { throw new Error('D1 overloaded'); };
  try {
    const again = await f.request('/c/test-set/keeper');
    assert.equal(again.status, 200);
    assert.equal(await again.text(), html);
  } finally { Date.now = realNow; f.state.intercept = null; }
  await f.finish();
});

test('the grid feed is cut from the card feed: one table read, same rows', async () => {
  const f = await fixture();
  f.insert('characters', 'gridder', { name: 'Gridder', team: 'minion', ability: 'Grid things.', art: 'art/gridder.png',
    tags: 'Information', lede: 'A lede.', summaryBullets: ['x'], jinxes: [{ id: 'imp', reason: 'r' }] });
  const [grid, card] = await Promise.all([
    f.request('/characters.json?fields=grid').then(r => r.json()),
    f.request('/characters.json?fields=card').then(r => r.json())
  ]);
  const reads = f.calls.filter(c => /SELECT data, status, slug, url_slug/.test(c.sql));
  assert.equal(reads.length, 1);
  assert.equal(card[0].lede, 'A lede.');
  assert.equal(grid[0].lede, undefined);
  assert.equal(grid[0].jinxCount, 1);
  assert.equal(grid[0].name, 'Gridder');
  await f.finish();
});
