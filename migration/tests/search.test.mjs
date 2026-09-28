// Run with Node 22.13+ / 24: node --test migration/tests/search.test.mjs
// The site search: the engine (assets/search-core.js), the Worker's
// /api/search-index, and the pieces the /search page shares with All Characters.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fixture } from './worker-fixture.mjs';

const require = createRequire(import.meta.url);
const S = require('../../assets/search-core.js');
const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8');

const chars = [
  { slug: 'the-drunk', page: 'c/set/the-drunk', name: 'the Drunk', team: 'outsider', ability: 'You think you are a Townsfolk.', tags: 'Drunkenness', creator: 'Øyvind' },
  { slug: 'poisoner-ish', page: 'c/set/poisoner-ish', name: 'Apothecary', team: 'minion', ability: 'Each night, choose a player: they are poisoned.', tags: 'Poison', creator: 'Tir-Far-Thóinn', curata: true, classification: 'curata' },
  { slug: 'prisoner', page: 'c/set/prisoner', name: 'Prisoner', team: 'townsfolk', ability: 'You may not nominate.', tags: 'Nominations', creator: 'Moll' },
  { slug: 'witcher', page: 'c/odyssey/witcher', name: 'Witcher', team: 'townsfolk', ability: 'Once per game, learn a character.', tags: 'Information', appearsIn: 'Odyssey', creator: 'Taiyi (太一)' },
  { slug: 'grimsby', page: 'c/set/grimsby', name: 'Grim Peeker Two', team: 'fabled', ability: 'The Storyteller may look.', tags: 'Grim Peeker', creator: 'Moll', classification: 'partial' },
  { slug: 'oeuvre', page: 'c/set/oeuvre', name: 'Œuvre Collector', team: 'demon', ability: 'Each night*, choose a player: they die.', tags: 'Death', creator: 'Moll' }
];
const scripts = [{ slug: 'fall-of-rome', name: 'Fall of Rome', author: 'Alex S.', characters: ['witcher'] }];
const collections = [{ id: 'odyssey', slug: 'Odyssey', displayName: 'Odyssey', author: 'Taiyi (太一)', match: ['odyssey'] }];
const extra = {
  creators: [{ name: 'Tir-Far-Thóinn', characters: 160, username: 'tir-far-thóinn', displayName: 'Tir-far-thóinn' }, { name: 'Moll', characters: 3 }],
  users: [{ username: 'tir-far-thóinn', displayName: 'Tir-far-thóinn' }, { username: 'lurker' }],
  pages: [{ slug: 'odyssey-attack', title: 'Attack', parentName: 'Odyssey', blurb: 'What an attack is.' }],
  news: [{ slug: 'jinx-update', title: 'Jinx update', summary: 'New jinxes.', publishedAt: '2026-08-21 02:42:04' }]
};
const index = S.createIndex({ characters: chars, scripts, collections, extra }, '/');
const names = (res, type) => (type ? res.byType[type] : res.mixed).map(r => r.item.name);

test('folding: accents and letters with no decomposition all count as their plain letters', () => {
  assert.equal(S.fold('öōø'), 'ooo');
  assert.equal(S.fold('Straße Þór ÆSIR Łódź'), 'strasse thor aesir lodz');
  assert.deepEqual(S.words("Tir-Far's Archive"), ['tir', 'fars', 'archive']);
  // The same query with and without the accents finds the same things.
  assert.deepEqual(names(index.search('tir far thoinn')), names(index.search('Tír-Fár-Thóinn')));
  assert.deepEqual(names(index.search('oyvind'), 'character'), ['the Drunk']);
  assert.deepEqual(names(index.search('oeuvre'), 'character'), ['Œuvre Collector']);
});

test('every kind of page is searchable, each in its own group', () => {
  assert.deepEqual(names(index.search('odyssey'), 'collection'), ['Odyssey']);
  assert.deepEqual(names(index.search('fall of rome'), 'script'), ['Fall of Rome']);
  assert.deepEqual(names(index.search('attack'), 'wikipage'), ['Attack']);
  assert.deepEqual(names(index.search('jinx update'), 'news'), ['Jinx update']);
  assert.deepEqual(names(index.search('lurker'), 'user'), ['lurker']);
  assert.deepEqual(names(index.search('moll'), 'creator'), ['Moll']);
  assert.deepEqual(names(index.search('poison'), 'tag'), ['Poison']);
  assert.deepEqual(names(index.search('outsiders'), 'tag'), ['Outsider']);
  assert.deepEqual(names(index.search('token tool'), 'site'), ['Token Tool']);
  // Curata is a mark, not a word on the page, and can still be searched.
  assert.deepEqual(names(index.search('curata'), 'character'), ['Apothecary']);
  // A set's own page ranks above the characters that only mention it.
  assert.equal(index.search('odyssey').mixed[0].item.name, 'Odyssey');
});

test('ranking: a whole name first, a leading "the" never gets in the way', () => {
  assert.equal(index.search('drunk').mixed[0].item.name, 'the Drunk');
  assert.equal(index.search('witcher').mixed[0].item.name, 'Witcher');
});

test('typos are forgiven only for words that are not on the wiki', () => {
  // "poison" is a real word here, so it never also means "prison".
  assert.ok(!names(index.search('poison'), 'character').includes('Prisoner'));
  assert.deepEqual(names(index.search('wtcher'), 'character'), ['Witcher']);
  assert.deepEqual(names(index.search('apothecery'), 'character'), ['Apothecary']);
  assert.deepEqual(names(index.search('dunk'), 'character'), ['the Drunk']);
  // Three letters or fewer are never guessed at.
  assert.deepEqual(names(index.search('wtc'), 'character'), []);
});

test('run-together names match from the start, never from the middle', () => {
  assert.ok(names(index.search('grimpeek'), 'tag').includes('Grim Peeker'));
  assert.ok(!index.search('imp').results.some(r => r.item.name === 'Grim Peeker'));
  assert.ok(names(index.search('tirfar'), 'creator').includes('Tir-Far-Thóinn'));
});

test('every word has to match, except the small ones', () => {
  assert.deepEqual(names(index.search('witcher prisoner'), 'character'), []);
  assert.deepEqual(names(index.search('the witcher'), 'character'), ['Witcher']);
});

test('a creator with an account is one result in the mixed list, and both tabs keep theirs', () => {
  const res = index.search('tir far thoinn');
  assert.equal(res.byType.creator.length, 1);
  assert.equal(res.byType.user.length, 1);
  assert.equal(res.mixed.filter(r => r.item.href === '/u/' + encodeURIComponent('tir-far-thóinn')).length, 1);
  assert.equal(res.counts.user, 1);
});

test('every result knows when it was created and last changed, for the date sorts', () => {
  const idx = S.createIndex({
    characters: [{ slug: 'a', page: 'c/a', name: 'A', v: (1700000000).toString(36) }],
    scripts: [{ slug: 'fall', name: 'Fall', v: (1790000000).toString(36) }],
    collections: [{ id: 'odyssey', slug: 'Odyssey PK', displayName: 'Odyssey' }, { slug: 'Legacy', displayName: 'Legacy' }],
    extra: {
      dates: { script: { fall: 1600000000 }, collection: { odyssey: 1650000000, Legacy: 1500000000 } },
      users: [{ username: 'lurker', created: 1720000000 }],
      pages: [{ slug: 'p', title: 'P', created: 1710000000, updated: 1730000000 }],
      news: [{ slug: 'n', title: 'N', publishedAt: '2026-08-21 02:42:04' }]
    }
  }, '');
  const at = name => idx.items.find(it => it.name === name);
  assert.deepEqual([at('Fall').created, at('Fall').updated], [1600000000, 1790000000]);
  assert.equal(at('Odyssey').created, 1650000000);
  assert.equal(at('Legacy').created, 1500000000);
  assert.equal(at('A').updated, 1700000000);
  assert.equal(at('lurker').created, 1720000000);
  assert.deepEqual([at('P').created, at('P').updated], [1710000000, 1730000000]);
  assert.equal(at('N').created, Date.UTC(2026, 7, 21, 2, 42, 4) / 1000);
  // Nothing known is 0, never NaN, so a sort can put it last.
  assert.equal(at('Tools').created, 0);
});

test('an empty query lists every item of a kind, A to Z', () => {
  const res = index.search('', { types: ['character'] });
  assert.equal(res.total, chars.length);
  assert.deepEqual(names(res, 'character'), [...names(res, 'character')].sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1));
  assert.equal(index.search('   ').total, index.n);
});

test('highlighting maps folded matches back onto the original letters and escapes the rest', () => {
  assert.equal(S.mark('Tir-Far-Thóinn’s Œuvre', S.words('thoinn oeuvre')),
    'Tir-Far-<mark class="sr-hl">Thóinn</mark>’s <mark class="sr-hl">Œuvre</mark>');
  assert.equal(S.mark('<b>imp</b>', ['imp']), '&lt;b&gt;<mark class="sr-hl">imp</mark>&lt;/b&gt;');
  // Two letters only light up at the start of a word.
  assert.equal(S.mark('Imp Chimp', ['im']), '<mark class="sr-hl">Im</mark>p Chimp');
});

test('a keystroke stays cheap with a wiki-sized index', () => {
  const many = [];
  for (let i = 0; i < 2500; i++) {
    const c = chars[i % chars.length];
    many.push({ ...c, slug: c.slug + i, name: c.name + ' ' + i, ability: c.ability + ' ' + 'lorem ipsum dolor sit amet '.repeat(4) });
  }
  const built = S.createIndex({ characters: many, scripts, collections, extra }, '');
  const started = performance.now();
  for (const q of ['w', 'wi', 'wit', 'witc', 'witch', 'witche', 'witcher', 'witcher 1', 'witcher 12']) built.search(q);
  // Nine keystrokes, generously bounded so a slow CI box does not flake.
  assert.ok(performance.now() - started < 400, 'nine keystrokes took ' + (performance.now() - started) + 'ms');
});

test('/api/search-index lists people, published wiki pages and news, and answers a repeat with 304', async () => {
  const f = await fixture();
  f.insert('characters', 'imp', { name: 'Imp', team: 'demon', ability: 'Each night*, choose a player: they die.' });
  f.insert('scripts', 'fall', { name: 'Fall', characters: ['imp'] });
  f.insert('scripts', 'hidden-script', { name: 'Hidden' }, 'draft');
  f.insert('collections', 'Odyssey PK', { id: 'odyssey', displayName: 'Odyssey' });
  f.db.exec(`ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0;
    INSERT INTO users(username,email,password_hash,display_name,avatar_url,banned) VALUES
      ('tir-far-thóinn','a@x.y','x','Tir-far-thóinn','/assets/avatars/u1.png',0),
      ('lurker','b@x.y','x',NULL,NULL,0),
      ('suspended','c@x.y','x','Bad',NULL,1)`);
  await f.hooks.ensurePagesTable(f.env);
  f.db.exec(`INSERT INTO pages(slug,title,parent_type,parent_slug,author,data,status) VALUES
    ('odyssey-attack','Attack','collection','Odyssey PK','Someone','{"blurb":"What an attack is."}','published'),
    ('by-id','By Id','collection','odyssey',NULL,'{"body":"Long body text here."}','published'),
    ('a-draft','Draft','collection','Odyssey PK',NULL,'{}','draft'),
    ('under-draft','Under a draft','script','hidden-script',NULL,'{}','published'),
    ('orphan','Orphan','script','gone',NULL,'{}','published')`);
  f.db.exec(`CREATE TABLE news (slug TEXT PRIMARY KEY, title TEXT NOT NULL, owner_id INTEGER, data TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft', created_at TEXT, updated_at TEXT, published_at TEXT);
    INSERT INTO news(slug,title,data,status,published_at,updated_at) VALUES
      ('live','Live article','{"summary":"Out now."}','published','2026-08-21 02:42:04','2026-08-21 02:42:04'),
      ('secret','Secret article','{}','draft',NULL,'2026-08-22 00:00:00')`);
  const res = await f.request('/api/search-index');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'private, max-age=0, must-revalidate');
  const body = await res.json();
  assert.deepEqual(body.users.map(u => u.username).sort(), ['lurker', 'tir-far-thóinn']);
  const { created: joined, ...tir } = body.users.find(u => u.username === 'tir-far-thóinn');
  assert.deepEqual(tir, { username: 'tir-far-thóinn', displayName: 'Tir-far-thóinn', avatarUrl: '/assets/avatars/u1.png' });
  assert.ok(joined > 0, 'the join date the profile page already shows');
  assert.ok(!JSON.stringify(body).includes('@x.y'), 'no email address ever leaves');
  assert.deepEqual(body.pages.map(p => p.slug).sort(), ['by-id', 'odyssey-attack']);
  const attack = body.pages.find(p => p.slug === 'odyssey-attack');
  assert.equal(attack.parentName, 'Odyssey');
  assert.equal(attack.parentKey, 'odyssey');
  assert.equal(body.pages.find(p => p.slug === 'by-id').blurb, 'Long body text here.');
  assert.deepEqual(body.news.map(n => n.slug), ['live']);
  assert.ok(Array.isArray(body.creators));
  // Creation dates for the Newest / Oldest sorts: scripts by slug,
  // collections by their kebab id and PK slug, pages and accounts on the row.
  assert.ok(body.dates.script.fall > 0);
  assert.equal(body.dates.script['hidden-script'], undefined, 'no date for a draft');
  assert.ok(body.dates.collection.odyssey > 0);
  assert.equal(body.dates.collection['Odyssey PK'], body.dates.collection.odyssey);
  assert.ok(body.users.every(u => u.created > 0));
  assert.ok(attack.created > 0 && attack.updated > 0);
  const again = await f.request('/api/search-index', { headers: { 'If-None-Match': res.headers.get('etag') } });
  assert.equal(again.status, 304);
  // A content edit rolls the ETag.
  await f.hooks.bumpContentVersion(f.env, 'wikipage');
  const after = await f.request('/api/search-index', { headers: { 'If-None-Match': res.headers.get('etag') } });
  assert.equal(after.status, 200);
  await f.finish();
});

test('/api/creators still answers after its list moved into a shared builder', async () => {
  const f = await fixture();
  f.db.exec(`INSERT INTO characters(slug,name,data,status,creator,team) VALUES
    ('a','A','{}','published','Moll, Saki','townsfolk'), ('b','B','{}','published','Moll','demon'), ('c','C','{}','draft','Ghost','demon')`);
  const body = await (await f.request('/api/creators')).json();
  assert.deepEqual(body.creators.map(c => [c.name, c.characters]), [['Moll', 2], ['Saki', 1]]);
  await f.finish();
});

test('the shared character card and Source rule match the All Characters page', async () => {
  const context = vm.createContext({
    window: { classBadgeHTML: cls => cls === 'curata' ? '<span class="curata-mark"></span>' : '', classifyCharacter: c => c.classification || 'standard' }
  });
  vm.runInContext(await read('assets/char-filters.js'), context);
  const CF = context.window.CharFilters;
  const html = CF.card({ slug: 'w', page: 'c/odyssey/witcher', name: 'Witcher <3', team: 'townsfolk', ability: 'Learn.', art: 'art/witcher.png', v: 'v1', classification: 'curata' });
  assert.match(html, /^<a class="char-card" href="c\/odyssey\/witcher">/);
  assert.match(html, /src="assets\/thumb\/witcher\.png\.webp\?v=v1"/);
  assert.match(html, /Witcher &lt;3<span class="curata-mark">/);
  assert.match(html, /class="char-card-type good">Townsfolk</);
  const marked = CF.card({ slug: 'w', page: 'c/w', name: 'Witcher', team: 'demon' }, t => S.mark(t, ['wit']));
  assert.match(marked, /<mark class="sr-hl">Wit<\/mark>cher/);
  const sourceOf = CF.makeSourceOf(
    [{ match: ['odyssey'], include: ['incl'], exclude: ['out'] }, { slug: 'Standalone', standalone: true, match: [] }],
    [{ characters: ['on-script', 'out'] }]
  );
  assert.equal(sourceOf({ slug: 'a', appearsIn: 'Odyssey' }), 'collection');
  assert.equal(sourceOf({ slug: 'incl' }), 'collection');
  assert.equal(sourceOf({ slug: 'out', appearsIn: 'Odyssey' }), 'script');
  assert.equal(sourceOf({ slug: 'on-script' }), 'script');
  assert.equal(sourceOf({ slug: 'nowhere' }), null);
});
