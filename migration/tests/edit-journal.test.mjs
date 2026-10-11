// assets/edit-journal.js: the pure diff/merge helpers behind the conflict
// panel, and the per-account local journal, run in a vm with a fake
// localStorage (no DOM: mount() must work without one).
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8');
const plain = x => JSON.parse(JSON.stringify(x));
function fakeStorage() {
  const m = new Map();
  return {
    get length() { return m.size; },
    key(i) { return [...m.keys()][i] ?? null; },
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { m.set(k, String(v)); },
    removeItem(k) { m.delete(k); },
    _map: m
  };
}
async function load(storage = fakeStorage()) {
  const context = vm.createContext({ window: { localStorage: storage }, Date, JSON });
  vm.runInContext(await read('assets/edit-journal.js'), context);
  return { EJ: context.window.EditJournal, storage };
}

test('strip drops data: URLs at any depth and keeps text and asset paths', async () => {
  const { EJ } = await load();
  const out = plain(EJ.strip({
    art: 'art/x.png', icon: 'data:image/png;base64,AAAA',
    boxes: [{ title: 'T', img: 'data:image/gif;base64,BB' }, 'data:x'],
    deep: { deeper: { pic: 'data:image/webp;base64,CC', text: 'kept' } }
  }));
  assert.deepEqual(out, { art: 'art/x.png', boxes: [{ title: 'T' }], deep: { deeper: { text: 'kept' } } });
  assert.equal(EJ.strip('x'.repeat(100001)), undefined);
});

test('same treats every kind of empty alike and ignores key order', async () => {
  const { EJ } = await load();
  for (const [a, b] of [['', []], [null, undefined], ['', null], [[], undefined], [{}, '']]) {
    assert.equal(EJ.same(a, b), true, JSON.stringify([a, b]));
  }
  assert.equal(EJ.same({ a: 1, b: [2] }, { b: [2], a: 1 }), true);
  assert.equal(EJ.same(['x'], ['y']), false);
  assert.equal(EJ.same('a', ''), false);
});

test('diffFields: mine, theirs, both, neither; ignored keys never reported', async () => {
  const { EJ } = await load();
  const base = { name: 'A', lede: 'one', ability: 'x', tags: 'T', status: 'draft', curata: false };
  const mine = { name: 'A', lede: 'two', ability: 'x', tags: 'U', status: 'published', curata: true };
  const theirs = { name: 'A', lede: 'one', ability: 'y', tags: 'V', status: 'published', curata: true, updatedAt: 'z' };
  const rows = plain(EJ.diffFields(base, mine, theirs));
  const by = Object.fromEntries(rows.map(r => [r.key, r]));
  assert.deepEqual(Object.keys(by).sort(), ['ability', 'lede', 'tags']);
  assert.deepEqual([by.lede.mine, by.lede.theirs], [true, false]);
  assert.deepEqual([by.ability.mine, by.ability.theirs], [false, true]);
  assert.deepEqual([by.tags.mine, by.tags.theirs], [true, true]);
  assert.equal(by.lede.label, 'Flavour line');

  // No base: every differing key is "both" — there is nobody to blame.
  const nb = plain(EJ.diffFields(null, { a: 1, b: 2, c: 3 }, { a: 1, b: 5, c: 4 }));
  assert.deepEqual(nb.map(r => [r.key, r.mine, r.theirs]), [['b', true, true], ['c', true, true]]);
});

test('diffFields keeps the two shapes apart through mineBase', async () => {
  const { EJ } = await load();
  // The form gives callout as a list; the server row holds a bare string.
  const serverBase = { callout: 'Note', lede: 'L' };
  const formBase = { callout: ['Note'], lede: 'L' };
  const mine = { callout: ['Note'], lede: 'Mine' };
  const theirs = { callout: 'Note', lede: 'L' };
  const rows = plain(EJ.diffFields(serverBase, mine, theirs, { mineBase: formBase }));
  assert.deepEqual(rows.map(r => [r.key, r.mine, r.theirs]), [['lede', true, false]]);
});

test('merge takes my changed keys and their others, mine winning on both, inputs untouched', async () => {
  const { EJ } = await load();
  const base = { lede: 'one', ability: 'x', tags: 'T', art: 'a.png' };
  const mine = { lede: 'two', ability: 'x', tags: 'U' };
  const theirs = { lede: 'one', ability: 'y', tags: 'V', art: 'b.png' };
  const copies = plain({ base, mine, theirs });
  const out = plain(EJ.merge(base, mine, theirs));
  assert.deepEqual(out, { lede: 'two', ability: 'y', tags: 'U', art: 'b.png' });
  assert.deepEqual(plain({ base, mine, theirs }), copies);
});

test('a stale restore diffs against the base it was written on, not the current copy', async () => {
  const { EJ } = await load();
  const v1 = { name: 'A', lede: 'old', ability: 'Old rule.' };
  const restored = { name: 'A', lede: 'my new lede', ability: 'Old rule.' };
  const v2 = { name: 'A', lede: 'old', ability: 'Their new rule.' };
  const rows = plain(EJ.diffFields(v1, restored, v2));
  assert.deepEqual(rows.map(r => [r.key, r.mine, r.theirs]), [['lede', true, false], ['ability', false, true]]);
  assert.equal(EJ.merge(v1, restored, v2).ability, 'Their new rule.');
  assert.equal(EJ.merge(v1, restored, v2).lede, 'my new lede');
  // With their copy as the base (what the journal's baseData prevents), my
  // stale ability would read as my edit and be written over theirs.
  const wrong = plain(EJ.diffFields(v2, restored, v2));
  assert.ok(wrong.find(r => r.key === 'ability' && r.mine));
});

test('ago reads plainly at the boundaries', async () => {
  const { EJ } = await load();
  const now = 10 * 24 * 3600e3;
  assert.equal(EJ.ago(now - 10e3, now), 'just now');
  assert.equal(EJ.ago(now - 60e3, now), '1 minute ago');
  assert.equal(EJ.ago(now - 4 * 60e3, now), '4 minutes ago');
  assert.equal(EJ.ago(now - 3600e3, now), '1 hour ago');
  assert.equal(EJ.ago(now - 5 * 3600e3, now), '5 hours ago');
  assert.equal(EJ.ago(now - 30 * 3600e3, now), 'yesterday');
  assert.equal(EJ.ago(now - 3 * 24 * 3600e3, now), '3 days ago');
});

test('rosterReplaced: an edit is not a replacement, a new roster is', async () => {
  const { EJ } = await load();
  const twenty = Array.from({ length: 20 }, (_, i) => 'c' + i);
  assert.equal(EJ.rosterReplaced(twenty, twenty.concat(['x', 'y', 'z'])), false);
  assert.equal(EJ.rosterReplaced(twenty, twenty.slice(3)), false);
  assert.equal(EJ.rosterReplaced(twenty, ['n1', 'n2', 'n3']), true);
  assert.equal(EJ.rosterReplaced(twenty.join(','), []), true);
  assert.equal(EJ.rosterReplaced('', ['a']), false);
  assert.equal(EJ.rosterReplaced(undefined, ['a']), false);
});

test('prune drops entries over 14 days, keeps the newest 20, leaves other keys alone', async () => {
  const { EJ, storage } = await load();
  const now = Date.now();
  for (let i = 0; i < 25; i++) {
    storage.setItem('botc_journal:u:p' + i, JSON.stringify({ v: 1, at: now - i * 60e3, data: {} }));
  }
  storage.setItem('botc_journal:u:old', JSON.stringify({ v: 1, at: now - 15 * 24 * 3600e3, data: {} }));
  storage.setItem('botc_script', '["a"]');
  EJ.prune(now);
  const keys = [...storage._map.keys()];
  assert.equal(keys.filter(k => k.startsWith('botc_journal:')).length, 20);
  assert.ok(!keys.includes('botc_journal:u:old'));
  assert.ok(keys.includes('botc_journal:u:p0'));
  assert.ok(!keys.includes('botc_journal:u:p24'));
  assert.ok(keys.includes('botc_script'));
  EJ.clearAll();
  assert.deepEqual([...storage._map.keys()], ['botc_script']);
});

test('the journal is per account, and writes nothing without one', async () => {
  const { EJ, storage } = await load();
  let form = { lede: 'loaded' };
  const opts = user => ({ key: 'character:wiretap', user, gather: () => form, base: () => '2026-09-09 00:00:00', baseData: () => ({ lede: 'loaded' }) });

  const a = EJ.mount(opts('Alice'));
  form = { lede: 'typed by Alice', icon: 'data:image/png;base64,AA' };
  a.flush();
  const key = 'botc_journal:alice:character:wiretap';
  const stored = JSON.parse(storage.getItem(key));
  assert.deepEqual(stored.data, { lede: 'typed by Alice' });
  assert.equal(stored.base, '2026-09-09 00:00:00');
  assert.deepEqual(stored.baseData, { lede: 'loaded' });
  assert.deepEqual(stored.baseForm, { lede: 'loaded' });

  form = { lede: 'loaded' };
  const b = EJ.mount(opts('Bob'));
  assert.equal(b.check('2026-09-09 00:00:00'), null);

  const nobody = EJ.mount(opts(''));
  form = { lede: 'anonymous' };
  nobody.flush();
  assert.equal([...storage._map.keys()].filter(k => k.startsWith('botc_journal:')).length, 1);

  // Alice comes back: her entry is offered, and restoring puts it back with
  // the base it was written on.
  form = { lede: 'loaded' };
  let applied = null, restoredEntry = null;
  const a2 = EJ.mount({ ...opts('alice'), apply: d => { applied = d; form = d; }, onRestore: e => { restoredEntry = e; } });
  const offered = a2.check('2026-09-10 00:00:00');
  assert.equal(offered.data.lede, 'typed by Alice');
  // Typing while the offer waits does not overwrite the entry being offered.
  form = { lede: 'something else' };
  a2.flush();
  assert.equal(JSON.parse(storage.getItem(key)).data.lede, 'typed by Alice');
  a2.restore();
  assert.equal(applied.lede, 'typed by Alice');
  assert.equal(restoredEntry.base, '2026-09-09 00:00:00');
  assert.deepEqual(plain(a2.cleanData()), { lede: 'loaded' });
  assert.equal(a2.isDirty(), true);
  // Saving clears it.
  a2.markClean();
  assert.equal(storage.getItem(key), null);
  assert.equal(a2.isDirty(), false);
});

test('an entry for an existing page with no base is thrown away; undoing an edit removes the entry', async () => {
  const { EJ, storage } = await load();
  storage.setItem('botc_journal:u:script:demo', JSON.stringify({ v: 1, at: Date.now(), base: null, data: { name: 'x' } }));
  let form = { name: 'Demo' };
  const h = EJ.mount({ key: 'script:demo', user: 'u', gather: () => form, base: () => 's' });
  assert.equal(h.check('s'), null);
  assert.equal(storage.getItem('botc_journal:u:script:demo'), null);

  // A NEW page legitimately has no base.
  storage.setItem('botc_journal:u:script:new', JSON.stringify({ v: 1, at: Date.now(), base: null, data: { name: 'draft' } }));
  const n = EJ.mount({ key: 'script:new', user: 'u', gather: () => ({ name: '' }) });
  assert.equal(n.check(null).data.name, 'draft');

  form = { name: 'Changed' };
  h.flush();
  assert.ok(storage.getItem('botc_journal:u:script:demo'));
  form = { name: 'Demo' };
  h.flush();
  assert.equal(storage.getItem('botc_journal:u:script:demo'), null);

  // rekey after a first save: later edits land where the editor will look.
  let f2 = { name: 'Fresh' };
  const c = EJ.mount({ key: 'character:new', user: 'u', gather: () => f2 });
  f2 = { name: 'Fresh!' };
  c.flush();
  assert.ok(storage.getItem('botc_journal:u:character:new'));
  c.rekey('character:fresh');
  c.markClean();
  assert.equal(storage.getItem('botc_journal:u:character:new'), null);
  f2 = { name: 'Fresh again' };
  c.flush();
  assert.ok(storage.getItem('botc_journal:u:character:fresh'));
});

test('prune also holds every entry together under TOTAL_MAX, dropping the oldest', async () => {
  const { EJ, storage } = await load();
  const now = Date.now();
  const big = 'x'.repeat(250000);
  for (let i = 0; i < 8; i++) {
    storage.setItem('botc_journal:u:b' + i, JSON.stringify({ v: 1, at: now - i * 60e3, data: { body: big } }));
  }
  EJ.prune(now);
  const kept = [...storage._map.keys()].filter(k => k.startsWith('botc_journal:'));
  const total = kept.reduce((n, k) => n + storage.getItem(k).length, 0);
  assert.ok(total <= EJ.TOTAL_MAX, 'under the budget');
  assert.ok(kept.includes('botc_journal:u:b0'), 'the newest stays');
  assert.ok(!kept.includes('botc_journal:u:b7'), 'the oldest goes first');
});

test('handleConflict re-sends silently only when their side changed nothing that matters', async () => {
  const { EJ } = await load();
  const base = { name: 'Wiretap', lede: 'loaded' };
  const run = (theirs, opts = {}) => {
    let retried = false;
    const b = 'base' in opts ? opts.base : base;
    return EJ.handleConflict({
      fetchTheirs: () => Promise.resolve({ data: theirs, updatedAt: 'T2', status: 'published' }),
      base: b, mineBase: b,
      mine: { name: 'Wiretap', lede: 'mine' },
      allowSilent: opts.allowSilent !== false,
      retry: () => { retried = true; },
      combine: () => {}, takeTheirs: () => {}, cancel: () => {}
    }).then(() => retried);
  };
  // A Publish toggle or a Curata grant elsewhere: only ignored keys moved.
  assert.equal(await run({ ...base, status: 'published', curata: true }), true);
  // Their lede moved: the panel, never a silent re-send.
  assert.equal(await run({ name: 'Wiretap', lede: 'theirs' }), false);
  // A second refusal in a row is never silent.
  assert.equal(await run({ ...base }, { allowSilent: false }), false);
  // A restored copy with no snapshot of its old base (the editors drop their
  // base for it): whatever differs from their copy goes to the panel.
  assert.equal(await run({ name: 'Wiretap', lede: 'theirs' }, { base: null }), false);
  assert.equal(await run({ name: 'Wiretap', lede: 'mine' }, { base: null }), true);
});

test('every editor drops a stale base it has no snapshot of, and can replace after a confirm', async () => {
  for (const page of ['edit.html', 'publish-collection.html', 'publish-page.html', 'publish-script.html']) {
    const html = await read(page);
    assert.match(html, /else if \(entry\.base && entry\.base !== was\)/, page + ' forgets a base it cannot diff against');
    assert.match(html, /\breplace: /, page + ' offers "Replace theirs with mine" when there is no base');
  }
});
