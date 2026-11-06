// assets/importer.js: the rules behind /mass-upload, run in a vm with no page.
// The bundle half (worker/bloodstar.js buildBundle) is real, so a script JSON
// and a Bloodstar project are tested through the same reader the Worker uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { buildBundle } from '../../worker/bloodstar.js';

const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8');
const plain = x => JSON.parse(JSON.stringify(x));
async function load() {
  const context = vm.createContext({ window: {} });
  vm.runInContext(await read('assets/importer.js'), context);
  return context.window.Importer;
}
const official = [{ id: 'spy', name: 'Spy', team: 'minion', ability: 'Each night, you see the Grimoire.' }];

const page = {
  slug: 'wiretap', status: 'published', updatedAt: '2026-09-17 01:31:31',
  data: {
    slug: 'wiretap', name: 'Wiretap', team: 'outsider', ability: 'Old rule.', creator: 'Besjbo',
    appearsIn: 'Old Set', quote: 'Typed on the wiki.', tags: 'Information', lede: 'A lede.',
    howToRun: ['Mine.'], art: 'art/wiretap.png', token: 'art/wiretap-token.png', tokenArt: true,
    publicEdit: 'approved', editors: [{ id: 3, username: 'x' }],
    firstNight: 40, reminders: ['Old'], jinxes: [{ id: 'imp', reason: 'old' }], appearsInFrom: [{ name: 'X' }]
  }
};

test('importer: a script JSON and its official characters', async () => {
  const I = await load();
  const bundle = buildBundle([
    { id: '_meta', name: 'Set' }, 'spy',
    { id: 'wiretap', name: 'Wiretap', team: 'townsfolk', ability: 'New rule.', jinxes: [{ id: 'spy', reason: 'Spy rule.' }, { id: 'echo', reason: 'Echo rule.' }] },
    { id: 'echo', name: 'Echo', team: 'demon', ability: 'Echoes.' },
    { id: 'botchomebrewwiki', name: 'Credits', team: 'fabled', ability: 'x' },
    { name: 'No Id', team: 'other', ability: '' }
  ], null, {}, official);
  const rows = I.plan(bundle, I.ownIndex([{ slug: 'wiretap-x', name: 'Wiretap', created_at: '1' }]));
  assert.deepEqual(rows.map(r => [r.name, r.kind, r.include, r.target]), [
    ['Spy', 'official', true, ''], ['Wiretap', 'update', true, 'wiretap-x'],
    ['Echo', 'new', true, ''], ['No Id', 'new', false, '']]);
  assert.equal(rows[3].team, 'other');
  rows[1].slug = 'wiretap-x'; rows[2].slug = 'echo';
  const j = I.jinxes(bundle, rows, 'script', { spy: 'Spy' });
  assert.deepEqual(plain(j.byOwner['wiretap-x']), [
    { name: 'Spy', text: 'Spy rule.', id: 'spy' }, { name: 'Echo', text: 'Echo rule.', slug: 'echo' }]);
  assert.deepEqual(plain(j.byName), []);
  assert.deepEqual(plain(I.roster(rows, 'script')), ['off-spy', 'wiretap-x', 'echo']);
  assert.deepEqual(plain(I.roster(rows, 'collection')), ['wiretap-x', 'echo']);
  const c = I.character(rows[1].entry, { keepJson: true }, ['Information']);
  assert.equal(c.tags, 'Information');
  assert.equal(JSON.parse(c.customJson)[1].id, 'wiretap');
});

test('importer: Bloodstar pairs, two official ends become the script\'s own rule', async () => {
  const I = await load();
  const bundle = { characters: [
    { id: 'spy', name: 'Spy', bare: true, official: { id: 'spy', match: 'exact' } },
    { id: 'imp', name: 'Imp', bare: true, official: { id: 'imp', match: 'exact' } },
    { id: 'a', name: 'Aye', team: 'townsfolk', ability: 'x' }
  ], jinxes: [{ a: 'Spy', b: 'Imp', text: 'both' }, { a: 'Aye', b: 'Warden', text: 'loose' }, { a: 'Imp', b: 'Spy', text: 'dupe' }] };
  const rows = I.plan(bundle, {});
  rows[2].slug = 'aye';
  const j = I.jinxes(bundle, rows, 'script', {});
  assert.deepEqual(plain(j.scriptAdds), [{ a: 'off-spy', b: 'off-imp', text: 'both' }]);
  assert.deepEqual(plain(j.byOwner.aye), [{ name: 'Warden', text: 'loose', id: 'warden' }]);
  assert.deepEqual(plain(j.byName), ['Aye / Warden (no page here by that name)']);
  assert.deepEqual(plain(I.jinxes(bundle, rows, 'collection', {}).dropped), ['Spy / Imp']);
});

test('importer: an update keeps everything the source does not own', async () => {
  const I = await load();
  const c = { name: 'Wiretap', team: 'townsfolk', ability: 'New rule.', quote: '', lede: 'From source.',
    howToRun: ['Theirs.'], summaryBullets: ['A bullet.'], firstNight: 12, reminders: ['Tapped'], jinxes: [], tags: 'information, Kill' };
  const out = I.merge(page, c, { creator: '', appearsIn: 'New Set', status: 'draft' });
  assert.equal(out.ability, 'New rule.'); assert.equal(out.firstNight, 12); assert.deepEqual(plain(out.jinxes), []);
  assert.equal(out.quote, 'Typed on the wiki.'); assert.equal(out.lede, 'A lede.');
  assert.deepEqual(plain(out.howToRun), ['Mine.']); assert.deepEqual(plain(out.summaryBullets), ['A bullet.']);
  assert.equal(out.tags, 'Information, Kill');
  assert.equal(out.token, 'art/wiretap-token.png'); assert.equal(out.publicEdit, 'approved');
  assert.equal(out.creator, 'Besjbo'); assert.equal(out.appearsIn, 'New Set');
  assert.equal(out.status, 'published'); assert.equal(out.baseUpdatedAt, '2026-09-17 01:31:31');
  assert.equal(out.appearsInFrom, undefined);
  const fresh = I.merge(null, c, { creator: 'Me', status: 'draft', publicEdit: 'closed' });
  assert.equal(fresh.status, 'draft'); assert.equal(fresh.creator, 'Me'); assert.equal(fresh.publicEdit, 'closed');
  assert.deepEqual(plain(I.artPlan(page, false)), { main: false, alt: true, alt2: true });
  assert.deepEqual(plain(I.artPlan(page, true)), { main: true, alt: true, alt2: true });
  assert.deepEqual(plain(I.artPlan(null, false)), { main: true, alt: true, alt2: true });
});

test('importer: re-importing a set updates it rather than making a second', async () => {
  const I = await load();
  const bundle = { meta: { name: 'Set', bootlegger: ['Rule'] }, prose: { synopsis: { plain: 'Syn.' } }, characters: [] };
  const fresh = I.setPage(bundle, { destination: 'script', status: 'draft' }, 'set', ['a', 'off-spy'], { nightOrder: { first: ['a'] } });
  assert.deepEqual(plain(fresh.characters), ['a', 'off-spy']); assert.deepEqual(plain(fresh.bootlegger), ['Rule']);
  const old = { slug: 'set', status: 'published', updatedAt: 't', data: { name: 'Set', synopsis: 'Mine.', theme: { accent: '#ffffff' }, characters: ['z'] } };
  const out = I.mergeSetPage(old, fresh);
  assert.deepEqual(plain(out.characters), ['a', 'off-spy']); assert.equal(out.synopsis, 'Mine.');
  assert.equal(out.theme.accent, '#ffffff'); assert.equal(out.status, 'published'); assert.equal(out.baseUpdatedAt, 't');
  const coll = I.setPage(bundle, { destination: 'collection' }, 'set', ['a'], {});
  const merged = I.mergeSetPage({ slug: 'Set', data: { id: 'set', include: ['hand'], order: ['hand'] } }, coll);
  assert.deepEqual(plain(merged.include), ['hand', 'a']); assert.equal(merged.id, 'set'); assert.equal(merged.slug, 'Set');
});

test('importer: where the almanac text goes is the person\'s choice', async () => {
  const I = await load();
  const e = { name: 'X', team: 'townsfolk', ability: 'a', flavour: '"Hush."', overview: ['One.', 'Two.'], tips: ['Tip.'], howToRun: ['Run.'] };
  let c = I.character(e, {});
  assert.equal(c.quote, 'Hush.'); assert.equal(c.lede, 'One.'); assert.deepEqual(plain(c.summaryBullets), ['Two.']);
  assert.deepEqual(plain(c.tips), ['Tip.']); assert.equal(c.callout, '');
  c = I.character(e, { flavour: 'lede', overview: 'howto', tips: 'callout' });
  assert.equal(c.quote, ''); assert.equal(c.lede, 'Hush.'); assert.deepEqual(plain(c.howToRun), ['One.', 'Two.', 'Run.']);
  assert.deepEqual(plain(c.tips), []); assert.equal(c.callout, 'Tip.');
  c = I.character(e, { flavour: 'skip', overview: 'skip', tips: 'skip' });
  assert.equal(c.quote, ''); assert.equal(c.lede, ''); assert.deepEqual(plain(c.summaryBullets), []);
  const bundle = { meta: { name: 'S' }, script: [{ id: '_meta', name: 'S' }, 'spy'],
    prose: { synopsis: { plain: 'Syn.' }, overview: { plain: 'Ov.' }, changelog: { plain: 'v2', wiki: 'v2' } }, characters: [] };
  let p = I.setPage(bundle, { destination: 'script', synopsis: 'description', projectOverview: 'synopsis', changelog: 'box', keepJson: true }, 's', [], {});
  assert.equal(p.description, 'Syn.'); assert.equal(p.synopsis, 'Ov.'); assert.equal(p.customBoxes[0].title, 'Changelog');
  assert.deepEqual(JSON.parse(p.customJson), bundle.script);
  assert.equal(I.changelogPage(bundle, { changelog: 'box' }, 'script', 's'), null);
  assert.ok(I.changelogPage(bundle, {}, 'script', 's'));
  p = I.setPage(bundle, { destination: 'script' }, 's', [], {});
  assert.equal(p.customJson, undefined);
  assert.equal(I.mergeSetPage({ slug: 's', data: { name: 'S' } }, { customJson: '[]' }).customJson, '[]');
});

test('importer: a character already on the wiki is pointed at, not copied', async () => {
  const I = await load();
  const bundle = buildBundle([
    { id: '_meta', name: 'Necro', firstNight: ['dusk', 'godfather', 'observer_x', 'dawn'], otherNight: ['dusk', 'merc', 'observer_x', 'chupa', 'dawn'] },
    { id: 'merc', name: 'Mercenary', team: 'townsfolk', ability: 'Once per game, publicly choose a Minion character: they die tonight.', otherNight: 58 },
    { id: 'observer_x', name: 'Observer', team: 'demon', ability: 'Each night*, choose a player: they die.', otherNightReminder: 'Wake &amp; kill. :reminder: :reminder:' },
    { id: 'chupa', name: 'Chupacabra', team: 'minion', ability: 'Each night*, you may kill.', otherNight: 60,
      jinxes: [{ id: 'matsuraid_hbl', reason: 'M.' }, { id: 'wolf_x', reason: 'W.' }] },
    { id: 'fetch_x', name: 'Fetch', team: 'townsfolk', ability: 'Fetch rule.', jinxes: [{ id: 'leviathan', reason: 'L.' }] },
    'godfather'
  ], null, {}, [{ id: 'godfather', name: 'Godfather', team: 'minion', ability: 'G.' }]);
  const wiki = I.wikiIndex([
    { slug: 'mercenary', name: 'Mercenary', creator: "Ma'ayan", ability: 'once per game publicly choose a minion character: they die tonight' },
    { slug: 'fetch', name: 'Fetch', ability: 'Fetch rule.' },
    { slug: 'matsuraid', name: 'Matsuraid', ability: 'x' },
    { slug: 'wolf-a', name: 'Wolf', ability: 'a' }, { slug: 'wolf-b', name: 'Wolf', ability: 'b' }
  ]);
  const rows = I.plan(bundle, {}, wiki);
  assert.deepEqual(rows.map(r => [r.name, r.kind, r.target]), [
    ['Mercenary', 'existing', 'mercenary'], ['Observer', 'new', ''], ['Chupacabra', 'new', ''],
    ['Fetch', 'existing', 'fetch'], ['Godfather', 'official', '']]);
  assert.match(rows[0].note, /Ma'ayan/);
  // An export's HTML entities and the app's token marks are not a sentence.
  assert.equal(rows[1].entry.otherNightReminder, 'Wake & kill.');
  rows[1].slug = 'observer'; rows[2].slug = 'chupacabra';
  assert.deepEqual(plain(I.roster(rows, 'script')), ['mercenary', 'observer', 'chupacabra', 'fetch', 'off-godfather']);
  const j = I.jinxes(bundle, rows, 'script', { leviathan: 'Leviathan' }, wiki);
  // One page answers to Matsuraid: pointed at it. Two answer to Wolf: by name, warned.
  assert.deepEqual(plain(j.byOwner.chupacabra), [
    { name: 'Matsuraid', text: 'M.', slug: 'matsuraid' }, { name: 'Wolf', text: 'W.', id: 'wolf_x' }]);
  assert.deepEqual(plain(j.byName), ['Chupacabra / wolf_x (2 pages have that name)']);
  // Fetch is already here and carries its own jinxes: nothing to write, nothing dropped.
  assert.deepEqual(plain(j.dropped), []); assert.deepEqual(plain(j.scriptAdds), []);
  const n = I.metaNight(bundle, rows, { dusk: { firstNight: 0, otherNight: 0 }, dawn: { firstNight: 9999, otherNight: 9999 }, godfather: { firstNight: 38 } });
  assert.deepEqual(plain(n.nightOrder), {
    first: ['@dusk', 'off-godfather', 'observer', '@dawn'],
    other: ['@dusk', 'mercenary', 'observer', 'chupacabra', '@dawn'] });
  // Listed but unnumbered: placed after the last number before it, never towards dawn's 9999.
  assert.equal(n.positions.observer_x.firstNight, 38.01);
  assert.equal(n.positions.observer_x.otherNight, 59);
  assert.equal(n.positions.chupa, undefined);
});
