// Run with Node 22.13+ / 24: node --test migration/tests/feeds-summary.test.mjs
// The small public answers that replaced whole-feed downloads (/tags,
// /all-collections, the 404 page), the public feeds' status rule, and the
// site search's sliced index build ranking exactly as the one-pass build did.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fixture } from './worker-fixture.mjs';
import { corpus, rankings, rankingsOf } from './search-corpus.mjs';
import PageRender from '../../assets/render-page.js';

const require = createRequire(import.meta.url);
const S = require('../../assets/search-core.js');
const DYM = require('../../assets/did-you-mean.js');
const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8');

function seed(f) {
  f.insert('characters', 'sculptor', { slug: 'sculptor', name: 'Sculptor', team: 'townsfolk', art: 'art/sculptor.png',
    tags: 'Information, poison, Poison , ', appearsIn: 'Odyssey', creator: 'Moll', ability: 'Learn.', status: 'published' });
  f.insert('characters', 'warden', { slug: 'warden', name: 'Warden', team: 'minion', art: 'art/warden.png',
    tags: 'win/loss condition', creator: 'Moll', ability: 'Each night, choose.' });
  f.insert('characters', 'imp-two', { slug: 'imp-two', name: 'Imp Two', team: 'demon', tags: 'multi-kill', creator: '', ability: 'Kill.' });
  f.insert('characters', 'oracle', { slug: 'oracle', name: 'Oracle', team: 'townsfolk', art: 'art/oracle.png', appearsIn: 'Odyssey', tags: '' , ability: 'Learn.' });
  f.insert('characters', 'baker', { slug: 'baker', name: 'Baker', team: 'outsider', art: 'art/baker.png', appearsIn: 'Odyssey', ability: 'Bake.' });
  f.insert('characters', 'secret', { slug: 'secret', name: 'Secret Draft', team: 'demon', art: 'art/secret.png', tags: 'Information', appearsIn: 'Odyssey' }, 'draft');
  f.insert('collections', 'Odyssey', { id: 'odyssey', slug: 'Odyssey', displayName: 'Odyssey', author: 'Taiyi', match: ['odyssey'],
    include: ['imp-two'], exclude: ['baker'], curata: true, header: '', logo: 'collections/odyssey-logo.png' });
  f.insert('collections', 'empty', { id: 'empty', slug: 'empty', displayName: 'Nobody Home', match: ['nowhere'] });
}

test('public feeds never carry a status, even one stored inside the page data', async t => {
  const f = await fixture(); t.after(() => f.finish());
  seed(f);
  for (const fields of ['grid', 'card', '']) {
    const body = await (await f.request('/characters.json' + (fields ? '?fields=' + fields : ''))).text();
    assert.doesNotMatch(body, /"status"/, fields || 'full');
    assert.doesNotMatch(body, /Secret Draft/);
  }
});

test('/api/tag-counts counts exactly what the tags page used to count from the grid feed', async t => {
  const f = await fixture(); t.after(() => f.finish());
  seed(f);
  // The page's own former rule, over the grid feed it used to download.
  const grid = await (await f.request('/characters.json?fields=grid')).json();
  const expected = {};
  const titleCase = s => String(s || '').trim().toLowerCase().replace(/(^|[\s\-\/])[a-z]/g, m => m.toUpperCase());
  grid.forEach(c => (c.tags || '').split(',').forEach(tag => {
    if (!tag.trim()) return;
    expected[titleCase(tag)] = (expected[titleCase(tag)] || 0) + 1;
  }));
  const res = await f.request('/api/tag-counts');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Cache-Control'), /private, max-age=0/);
  const body = await res.json();
  assert.deepEqual(body.tags, expected);
  assert.deepEqual(body.tags, { Information: 1, Poison: 2, 'Win/Loss Condition': 1, 'Multi-Kill': 1 });
  // A returning browser gets a 304; a character edit rolls the ETag.
  const etag = res.headers.get('ETag');
  assert.equal((await f.request('/api/tag-counts', { headers: { 'If-None-Match': etag } })).status, 304);
  f.insert('characters', 'new-one', { slug: 'new-one', name: 'New One', tags: 'Setup', ability: 'x' });
  await f.hooks.logActivity(f.env, null, 'create', 'character', 'new-one', 'New One');
  const changed = await f.request('/api/tag-counts', { headers: { 'If-None-Match': etag } });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).tags.Setup, 1);
});

test('/api/collection-tiles matches the collections page’s own counting and icon choice', async t => {
  const f = await fixture(); t.after(() => f.finish());
  seed(f);
  const [grid, colls] = await Promise.all([
    f.request('/characters.json?fields=grid').then(r => r.json()),
    f.request('/collections.json?fields=browse').then(r => r.json())
  ]);
  const res = await f.request('/api/collection-tiles');
  const body = await res.json();
  // Only collections with members; the empty one is left out like before.
  assert.deepEqual(body.collections.map(c => c.id), ['odyssey']);
  const tile = body.collections[0];
  const members = PageRender.resolveCollectionMembers(colls.find(c => c.id === 'odyssey'), grid);
  assert.equal(tile.count, members.length);
  assert.equal(tile.count, 3);   // sculptor + oracle by match, imp-two by hand; baker excluded, the draft never
  // One icon per team first, then the rest, art only, in feed order — the
  // page's pickIcons() as it was.
  function pickIcons(list, n) {
    const withArt = list.filter(c => c.art), out = [], seen = {};
    for (const c of withArt) if (out.length < n && !seen[c.team]) { out.push(c); seen[c.team] = 1; }
    for (const c of withArt) if (out.length < n && !out.includes(c)) out.push(c);
    return out;
  }
  assert.deepEqual(tile.icons.map(i => i.art), pickIcons(members, 4).map(c => c.art));
  assert.deepEqual(tile.icons.map(i => i.art), ['art/sculptor.png', 'art/oracle.png']);
  assert.ok(tile.icons.every(i => i.v));
  assert.equal(tile.displayName, 'Odyssey');
  assert.equal(tile.logo, 'collections/odyssey-logo.png');
  assert.equal(tile.curata, true);
  assert.equal(tile.header, undefined);
  assert.equal(tile.match, undefined);
  assert.doesNotMatch(JSON.stringify(body), /Secret|secret/);
  const etag = res.headers.get('ETag');
  assert.equal((await f.request('/api/collection-tiles', { headers: { 'If-None-Match': etag } })).status, 304);
});

test('the browse pages ask for the small answers, not the character feed', async () => {
  const tags = await read('tags.html'), colls = await read('all-collections.html');
  for (const html of [tags, colls]) assert.doesNotMatch(html, /characters\.json/);
  assert.match(tags, /rel="preload" href="api\/tag-counts"/);
  assert.match(colls, /rel="preload" href="api\/collection-tiles"/);
  const nf = await read('404.html');
  assert.doesNotMatch(nf, /characters\.json|scripts\.json|collections\.json/);
  assert.match(nf, /api\/did-you-mean/);
  // The Script Builder draws from the grid first; the card feed is fetched
  // after the first paint.
  const sb = await read('script.html');
  assert.match(sb, /rel="preload" href="characters\.json\?fields=grid"/);
  assert.ok(sb.indexOf("feed('characters.json?fields=grid')") > sb.indexOf("feed('characters.json?fields=card')"));
  assert.match(sb, /requestAnimationFrame\(function \(\) \{ setTimeout\(after, 0\); \}\)/);
  assert.match(sb, /Promise.all\(\[feed\(.characters.json\?fields=card.\), painted\]\)/);
});

test('/api/did-you-mean answers with the four best published rows, matched like the 404 page', async t => {
  const f = await fixture(); t.after(() => f.finish());
  seed(f);
  for (let i = 0; i < 6; i++) f.insert('characters', 'sculptor-' + i, { slug: 'sculptor-' + i, name: 'Sculptor ' + i, ability: 'x' });
  const rows = async p => (await (await f.request('/api/did-you-mean?path=' + encodeURIComponent(p))).json()).rows;
  const hits = await rows('/c/odyssey/sculpter');
  assert.equal(hits.length, 4);
  assert.equal(hits[0].slug, 'sculptor');
  assert.deepEqual(Object.keys(hits[0]).sort(), ['art', 'creator', 'name', 'page', 'slug', 'team']);
  // Same answer the page's old in-browser matcher gave over the whole feed.
  const grid = await (await f.request('/characters.json?fields=grid')).json();
  assert.deepEqual(hits.map(h => h.slug), DYM.best(grid, 'sculpter', ['slug', 'name']).map(c => c.slug));
  assert.deepEqual(await rows('/c/secret-draft'), []);
  assert.deepEqual(await rows('/favicon.ico'), []);
  assert.deepEqual((await rows('/collection/odysey')).map(c => c.id), ['odyssey']);
  assert.deepEqual(await rows('/c/%E0%A4%A'), []);   // a malformed escape is no match, not a crash
});

test('the sliced search index ranks every query exactly as the one-pass build did', async () => {
  const golden = JSON.parse(await read('migration/tests/search-ranking.golden.json'));
  assert.deepEqual(rankings(S), golden);
  // Tiny slices, so the build is genuinely split into many pieces.
  let slices = 0;
  const index = await S.createIndexAsync(corpus(), '/', {
    budget: 0.0001, yieldFn: () => new Promise(resolve => setImmediate(resolve)), onSlice: () => { slices++; }
  });
  assert.ok(slices > 5, 'built in ' + slices + ' slices');
  assert.deepEqual(rankingsOf(index), golden);
});
