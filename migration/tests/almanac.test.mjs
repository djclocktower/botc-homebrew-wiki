import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';

function seed(f) {
  f.insert('characters', 'seer', { slug: 'seer', name: 'Seer', team: 'townsfolk', art: 'art/seer.png',
    ability: 'Each night, you learn a thing.', lede: 'The Seer sees.', examples: ['Alex is the Seer.'],
    howToRun: ['Wake the [[SEEN]] player.'], reminders: ['Seen'], creator: 'Writer' });
  f.insert('characters', 'brute', { slug: 'brute', name: 'Brute', team: 'demon', art: 'art/brute.png',
    ability: 'Each night*, choose a player: they die.', tips: ['Kill early.'] });
  f.insert('characters', 'secret', { slug: 'secret', name: 'Secret', team: 'minion', ability: 'Hidden.' }, 'draft');
  f.insert('scripts', 'demo', { slug: 'demo', name: 'Demo Script', author: 'Writer', characters: ['brute', 'seer', 'secret', 'off-imp'] });
  f.insert('scripts', 'wip', { slug: 'wip', name: 'Work in Progress', characters: ['seer'] }, 'draft');
  f.insert('collections', 'Demo Coll', { id: 'demo-coll', slug: 'Demo Coll', displayName: 'Demo Coll', include: ['seer', 'brute'] });
}

test('almanac: every published character of a script on one page, officials linked out', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  seed(f);

  const r = await f.request('/s/demo/almanac');
  assert.equal(r.status, 200);
  const html = await r.text();
  // Grouped by team, so the Townsfolk comes before the Demon whatever the roster order.
  assert.ok(html.indexOf('id="alm-seer"') > 0 && html.indexOf('id="alm-seer"') < html.indexOf('id="alm-brute"'));
  // The page's prose, through the same marks as the character page.
  assert.match(html, /The Seer sees\./);
  assert.match(html, /Alex is the Seer\./);
  assert.match(html, /Kill early\./);
  // A draft on the roster is never shown.
  assert.doesNotMatch(html, /Hidden\./);
  assert.doesNotMatch(html, /alm-secret/);
  // The official character is named and linked to the official wiki, not copied.
  assert.match(html, /wiki\.bloodontheclocktower\.com\/Imp/);
  // Its own stylesheet, a way back, and relative paths two levels deep.
  assert.match(html, /almanac\.[a-f0-9]{20}\.css|almanac\.css/);
  assert.match(html, /href="\.\.\/\.\.\/s\/demo"/);
  assert.match(html, /src="\.\.\/\.\.\/assets\/art\/seer\.png/);

  // The script page links to it.
  const page = await (await f.request('/s/demo')).text();
  assert.match(page, /href="\.\.\/s\/demo\/almanac"/);
});

test('almanac: drafts stay private, collections resolve by id, junk is a 404', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  seed(f);
  assert.equal((await f.request('/s/wip/almanac')).status, 404);
  assert.equal((await f.request('/s/nope/almanac')).status, 404);
  assert.equal((await f.request('/s/demo/almanac/extra')).status, 404);

  const r = await f.request('/collection/demo-coll/almanac');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /id="alm-seer"/);
  assert.match(html, /id="alm-brute"/);
  assert.match(html, /href="\.\.\/\.\.\/collection\/demo-coll"/);
  const coll = await (await f.request('/collection/demo-coll')).text();
  assert.match(coll, /href="\.\.\/collection\/demo-coll\/almanac"/);
});
