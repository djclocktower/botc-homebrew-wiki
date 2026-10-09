// Run with Node 22.13+ / 24: node --test migration/tests/fix-frontend.test.mjs
// Regressions in the shared browse/search code: words and names that collide
// with Object.prototype, a partial search index that was kept for the whole
// visit, and characters with a team nobody draws.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { featuredPick } from '../../worker/home-data.js';

const require = createRequire(import.meta.url);
const S = require('../../assets/search-core.js');
const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8');

const chars = [
  { slug: 'constructor', page: 'c/set/constructor', name: 'Constructor', team: 'townsfolk', ability: 'You build things.', tags: 'Constructor', creator: 'Moll' },
  { slug: 'drunk', page: 'c/set/drunk', name: 'Drunk', team: 'outsider', ability: 'You think you are a Townsfolk.', creator: 'Moll' }
];

test('search: a typed word that is also an Object property is searched for, not dropped', () => {
  const index = S.createIndex({ characters: chars, scripts: [], collections: [], extra: {} }, '/');
  const res = index.search('constructor');
  // It used to read as a small word ("the", "of"): optional, so nothing was
  // required and the query listed everything A to Z.
  assert.deepEqual(res.tokens, ['constructor']);
  assert.deepEqual(res.byType.character.map(r => r.item.name), ['Constructor']);
  assert.ok(res.byType.tag.some(r => r.item.name === 'Constructor'));
  for (const q of ['toString', 'hasOwnProperty', '__proto__ drunk', 'valueOf']) {
    assert.doesNotThrow(() => index.search(q), q);
  }
  assert.deepEqual(index.search('drunk constructor drunk').tokens, ['drunk', 'constructor']);
});

test('search: a partial index is used but not kept, and the missing parts are fetched again', async () => {
  let fail = true, calls = {};
  const window = {
    BotcData: {
      root: () => '/',
      json(url) {
        calls[url] = (calls[url] || 0) + 1;
        if (url.startsWith('/characters.json')) return Promise.resolve(chars);
        if (url.startsWith('/scripts.json')) return fail ? Promise.reject(new Error('offline')) : Promise.resolve([{ slug: 'rome', name: 'Fall of Rome' }]);
        if (url.startsWith('/collections.json')) return Promise.resolve([]);
        return Promise.resolve({});
      }
    }
  };
  const context = vm.createContext({ window, Map, Float32Array, Promise });
  vm.runInContext(await read('assets/search-core.js'), context);
  const B = window.BotcSearch;
  const first = await B.load('/');
  assert.equal(first.partial, true);
  assert.equal(B.ready(), null, 'a partial index is not cached for the page');
  assert.equal(first.search('rome').byType.script.length, 0);
  fail = false;
  const second = await B.load('/');
  assert.equal(second.partial, false);
  assert.equal(second.search('rome').byType.script.length, 1);
  assert.equal(calls['/scripts.json?fields=browse'], 2);
  // Complete now: kept, and not fetched a third time.
  assert.equal(await B.load('/'), second);
  assert.equal(calls['/scripts.json?fields=browse'], 2);
});

async function charFilters() {
  const context = vm.createContext({ window: {} });
  vm.runInContext(await read('assets/creators.js'), context);
  vm.runInContext(await read('assets/char-filters.js'), context);
  return context.window.CharFilters;
}

test('char filters: a character with a blank or unknown team is drawn under Other, not lost', async () => {
  const CF = await charFilters();
  const list = [
    { name: 'A', team: 'townsfolk' }, { name: 'B', team: '' }, { name: 'C', team: 'wizard' },
    { name: 'D', team: 'constructor' }, { name: 'E' }
  ];
  const laid = CF.sections(list, 'team');
  const drawn = laid.groups.reduce((n, g) => n + g.items.length, 0);
  assert.equal(drawn, list.length);
  assert.equal(JSON.stringify(laid.groups.at(-1).items.map(c => c.name)), JSON.stringify(['B', 'C', 'D', 'E']));
  assert.match(laid.html, /data-group="other"/);
  // No Other section when every team is known.
  assert.doesNotMatch(CF.sections([{ name: 'A', team: 'demon' }], 'team').html, /data-group="other"/);
});

test('char filters: authors and sets named like Object properties group normally', async () => {
  const CF = await charFilters();
  const list = [
    { name: 'One', creator: 'Constructor', team: 'demon', slug: 'one', appearsIn: 'Constructor' },
    { name: 'Two', creator: '__proto__', team: 'demon', slug: 'two', appearsIn: 'toString' },
    { name: 'Three', creator: 'toString', team: 'demon', slug: 'constructor' }
  ];
  const laid = CF.sections(list, 'author');
  assert.equal(laid.groups.reduce((n, g) => n + g.items.length, 0), 3);
  assert.equal(laid.groups.length, 3);
  const setOf = CF.makeSetOf([{ id: 'constructor', slug: 'Constructor', displayName: 'Constructor', match: ['constructor'] }],
    [{ slug: 'tostring', name: 'toString', characters: ['constructor'] }]);
  assert.equal(setOf(list[0]).href, 'collection/constructor');
  assert.equal(setOf(list[1]).href, 's/tostring');
  assert.equal(setOf(list[2]).href, 's/tostring');
  assert.equal(setOf({ slug: 'hasOwnProperty' }), null);
  const bySet = CF.sections(list, 'set', setOf);
  assert.equal(bySet.groups.reduce((n, g) => n + g.items.length, 0), 3);
  // Source chips: a slug like "constructor" is on a script only if one lists it.
  assert.equal(CF.makeSourceOf([], [])({ slug: 'constructor' }), null);
});

test('featured character: a creator named like an Object property takes a turn like anyone', () => {
  const list = ['Constructor', 'toString', 'Moll'].map((creator, i) => ({
    slug: 'c' + i, name: 'C' + i, creator, art: 'art/c.png', ability: 'Learn.', classification: 'standard'
  }));
  const seen = new Set();
  for (let day = 20000; day < 20012; day++) seen.add(featuredPick(list, day).creator);
  assert.deepEqual([...seen].sort(), ['Constructor', 'Moll', 'toString']);
});
