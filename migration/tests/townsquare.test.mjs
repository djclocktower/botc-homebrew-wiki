// assets/townsquare.js: the rules behind /townsquare, run in a vm with no page.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8');
async function load() {
  const context = vm.createContext({ window: {} });
  vm.runInContext(await read('assets/townsquare.js'), context);
  return context.window.TownSquare;
}
const off = { map: Object.assign(Object.create(null), {
  imp: { id: 'imp', name: 'Imp', team: 'demon', ability: 'x', img: '/assets/icons-sm/imp.webp', fb: 'https://cdn/imp.webp', rem: ['Dead'], remG: [], fn: 0, on: 24, off: 1 }
}), list: [] };

test('town square: the official setup numbers', async () => {
  const T = await load();
  const row = n => { const c = T.baseCounts(n); return [c.townsfolk, c.outsider, c.minion, c.demon].join('/'); };
  assert.deepEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map(row),
    ['3/0/1/1', '3/1/1/1', '5/0/1/1', '5/1/1/1', '5/2/1/1', '7/0/2/1', '7/1/2/1', '7/2/2/1', '9/0/3/1', '9/1/3/1', '9/2/3/1']);
  assert.equal(row(20), '9/2/3/1');
});

test('town square: setup text that moves the Outsider count', async () => {
  const T = await load();
  const shift = ability => T.outsiderShift({ ability });
  assert.equal(shift('There are extra Outsiders in play. [+2 Outsiders]'), 2);
  assert.equal(shift('x [−1 Outsider]'), -1);
  assert.equal(shift('x [+1 Hannibal]'), 0);
  assert.equal(shift('No brackets, +2 Outsiders'), 0);
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(shift('x [-1 or +1 Outsider]'));
  assert.deepEqual([...seen].sort(), [-1, 1]);
  seen.clear();
  for (let i = 0; i < 300; i++) seen.add(shift('x [+0 to +2 Outsiders]'));
  assert.deepEqual([...seen].sort(), [0, 1, 2]);
});

test('town square: a random bag is legal, and a Baron brings two Outsiders', async () => {
  const T = await load();
  const mk = (team, n, extra) => Array.from({ length: n }, (_, i) => ({ id: team + i, name: team + i, team, ability: '' , ...extra }));
  const chars = [...mk('townsfolk', 13), ...mk('outsider', 4), ...mk('minion', 3), ...mk('demon', 1), ...mk('traveller', 2)];
  const teams = bag => bag.reduce((m, id) => { const t = id.replace(/\d+$/, ''); m[t] = (m[t] || 0) + 1; return m; }, {});
  for (let n = 5; n <= 15; n++) {
    const bag = T.randomBag(chars, n), want = T.baseCounts(n);
    assert.equal(bag.length, n);
    assert.equal(new Set(bag).size, n);
    assert.deepEqual(teams(bag), JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(want).filter(e => e[1])))));
  }
  const baron = chars.map(c => c.team === 'minion' ? { ...c, ability: '[+2 Outsiders]' } : c);
  for (let i = 0; i < 20; i++) {
    const t = teams(T.randomBag(baron, 7));          // 5/0/1/1 becomes 3/2/1/1
    assert.deepEqual([t.townsfolk, t.outsider, t.minion, t.demon], [3, 2, 1, 1]);
  }
  // Picks made by hand stay, and the bag is dealt round them.
  for (let i = 0; i < 20; i++) {
    const bag = T.randomBag(baron, 7, ['minion2', 'traveller0']);
    const t = teams(bag);
    assert.ok(bag.includes('minion2') && bag.includes('traveller0'));
    assert.deepEqual([t.townsfolk, t.outsider, t.minion, t.demon, t.traveller], [3, 2, 1, 1, 1]);
    // Outsiders chosen by hand: the sum is the Storyteller's, nothing is added to it.
    const own = teams(T.randomBag(baron, 7, ['minion2', 'outsider0', 'outsider1']));
    assert.deepEqual([own.townsfolk, own.outsider, own.minion, own.demon], [3, 2, 1, 1]);
  }
  // Nothing to trade for: the bag stays as it was rather than breaking.
  const none = baron.filter(c => c.team !== 'outsider');
  assert.equal(T.randomBag(none, 7).length, 7);
});

test('town square: reading a script JSON', async () => {
  const T = await load();
  const sc = T.parseScript([
    { id: '_meta', name: 'Set', author: 'Me', firstNight: ['dusk', 'Sister_Circus', 'minioninfo', 'dawn'] },
    'imp', 'nobody-knows-this',
    { id: 'Sister_Circus', name: 'Worker ∇', team: 'Traveler', ability: 'Rule.', image: ['https://botchomebrew.wiki/assets/art/worker.png?v=1'],
      firstNight: 12, reminders: ['A', 7, '', 'A', 'A'], firstNightReminder: 'Wake.' },
    { id: 'evil', name: '<b>x</b>', team: 'wizard', ability: 'x', image: 'javascript:alert(1)' },
    { id: 'imp', name: 'Imp again', team: 'demon', ability: 'x' },
    { id: 'constructor', name: 'Constructor', team: 'outsider', ability: 'x', image: 'https://elsewhere.example/c.png' },
    { id: 'botchomebrewwiki', name: 'Credits', team: 'fabled', ability: 'x' }
  ], off);
  assert.equal(sc.name, 'Set');
  assert.deepEqual(JSON.parse(JSON.stringify(sc.nightOrder)), { first: ['@dusk', 'sistercircus', '@minioninfo', '@dawn'], other: [] });
  assert.deepEqual([...sc.chars.map(c => c.id)], ['imp', 'sistercircus', 'evil', 'constructor']);
  const [imp, worker, evil, ctor] = sc.chars;
  assert.equal(imp.off, 1);
  assert.equal(worker.team, 'traveller');
  assert.equal(worker.img, '/assets/thumb/worker.png.webp');
  assert.deepEqual([...worker.rem], ['A']);
  assert.equal(evil.team, 'townsfolk');
  assert.equal(evil.img, '');
  assert.equal(ctor.img, 'https://elsewhere.example/c.png');
  assert.throws(() => T.parseScript({}, off));
  assert.throws(() => T.parseScript([{ id: '_meta', name: 'Empty' }], off));
});

test('town square: the night follows the script\'s arrangement, and slots in what it does not list', async () => {
  const T = await load();
  const it = (id, n, meta) => ({ id, name: id, n, meta });
  const items = [it('@dawn', 9999, 1), it('late', 50), it('early', 5), it('@dusk', 0, 1), it('mid', 20), it('constructor', 30)];
  assert.deepEqual([...T.orderSteps(items, null).map(x => x.id)], ['@dusk', 'early', 'mid', 'constructor', 'late', '@dawn']);
  // The script lists late before early; mid and constructor are new to it.
  assert.deepEqual([...T.orderSteps(items, ['@dusk', 'late', 'early', '@dawn']).map(x => x.id)],
    ['@dusk', 'late', 'early', 'mid', 'constructor', '@dawn']);
});
