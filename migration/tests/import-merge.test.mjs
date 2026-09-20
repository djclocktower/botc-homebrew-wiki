import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8');
// Objects made inside the vm carry that realm's prototypes, which a strict
// deep comparison rejects; compare their plain shape instead.
const plain = x => JSON.parse(JSON.stringify(x));
async function load() {
  const context = vm.createContext({ window: {} });
  vm.runInContext(await read('assets/import-merge.js'), context);
  return context.window.ImportMerge;
}
const fromFile = {
  slug: 'wiretap', name: 'Wiretap', team: 'townsfolk', ability: 'New rule.', quote: '', edition: '',
  firstNight: 12, firstNightReminder: 'Wake', otherNight: 0, otherNightReminder: '',
  reminders: ['Tapped'], remindersGlobal: [], setup: false, special: [], jinxes: []
};
const run = { creator: 'Besjbo', appearsIn: 'New World Chaos', status: 'draft' };
const page = {
  slug: 'wiretap', status: 'published', updatedAt: '2026-09-17 01:31:31',
  data: {
    slug: 'wiretap', name: 'Wiretap', team: 'outsider', ability: 'Old rule.', creator: 'Besjbo',
    appearsIn: 'New World Chaos 2.999', quote: 'Typed on the wiki.', tags: 'Information', lede: 'A lede.',
    art: 'art/wiretap.png', image: 'https://botchomebrew.wiki/assets/art/wiretap.png',
    token: 'art/wiretap-token.png', tokenArt: true, artScale: 120,
    publicEdit: 'approved', editors: [{ id: 3, username: 'x' }],
    firstNight: 40, reminders: ['Old'], jinxes: [{ id: 'imp', reason: 'old' }],
    special: [{ name: 'bag-disabled', type: 'reveal' }], appearsInFrom: [{ name: 'X', id: 'x' }]
  }
};

test('import-merge: a new page is exactly what the file says, under the run options', async () => {
  const M = await load();
  assert.deepEqual(plain(M.merge(null, fromFile, run)), { ...fromFile, creator: 'Besjbo', appearsIn: 'New World Chaos', status: 'draft' });
  assert.equal(M.merge(null, fromFile, {}).status, 'published');
  assert.deepEqual(plain(M.artPlan(null, {})), { main: true, alt: true, alt2: true });
});

test('import-merge: a page that exists keeps everything the file does not carry', async () => {
  const M = await load();
  const out = M.merge(page, fromFile, { creator: '', appearsIn: '', status: 'draft' });
  // Mechanics from the file, the empties included.
  assert.equal(out.team, 'townsfolk'); assert.equal(out.ability, 'New rule.'); assert.equal(out.firstNight, 12);
  assert.deepEqual(plain(out.reminders), ['Tapped']); assert.deepEqual(plain(out.jinxes), []); assert.deepEqual(plain(out.special), []);
  // The page's own fields stay: this is what one re-import used to strip.
  assert.equal(out.quote, 'Typed on the wiki.'); assert.equal(out.tags, 'Information'); assert.equal(out.lede, 'A lede.');
  assert.equal(out.art, 'art/wiretap.png'); assert.equal(out.token, 'art/wiretap-token.png'); assert.equal(out.tokenArt, true);
  assert.equal(out.artScale, 120); assert.equal(out.publicEdit, 'approved'); assert.deepEqual(plain(out.editors), [{ id: 3, username: 'x' }]);
  // Empty run boxes leave the page's creator and set alone; filled ones win.
  assert.equal(out.creator, 'Besjbo'); assert.equal(out.appearsIn, 'New World Chaos 2.999');
  assert.equal(M.merge(page, fromFile, run).appearsIn, 'New World Chaos');
  // Its publish state is its own, whatever the form says for new pages.
  assert.equal(out.status, 'published');
  assert.equal(M.merge({ ...page, status: 'draft' }, fromFile, { status: 'published' }).status, 'draft');
  // A flavour line in the file replaces the page's; none leaves it.
  assert.equal(M.merge(page, { ...fromFile, quote: 'From the file.' }, {}).quote, 'From the file.');
  // The save can tell a stale copy, and nothing derived rides back.
  assert.equal(out.baseUpdatedAt, '2026-09-17 01:31:31'); assert.equal(out.appearsInFrom, undefined);
  assert.equal(out.slug, 'wiretap');
});

test('import-merge: the icon is kept unless asked, or the page has none', async () => {
  const M = await load();
  assert.deepEqual(plain(M.artPlan(page, {})), { main: false, alt: true, alt2: true });
  assert.deepEqual(plain(M.artPlan(page, { replaceArt: true })), { main: true, alt: true, alt2: true });
  assert.equal(M.artPlan({ ...page, data: { ...page.data, art: '', image: '' } }, {}).main, true);
  const withAlt = { ...page, data: { ...page.data, imageAlt: 'https://elsewhere.example/alt.png' } };
  assert.deepEqual(plain(M.artPlan(withAlt, {})), { main: false, alt: false, alt2: true });
});
