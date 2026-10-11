// Storyteller Mode (/storyteller): the pure core in assets/storyteller-core.js,
// checked against the real official data, plus the page's static wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8');
const plain = x => JSON.parse(JSON.stringify(x));

async function load() {
  const context = vm.createContext({ window: {}, console });
  for (const f of ['assets/reader.js', 'assets/render-wiki.js', 'assets/render.js',
    'assets/render-page.js', 'assets/official-roles.js', 'assets/storyteller-core.js']) {
    vm.runInContext(await read(f), context, { filename: f });
  }
  const w = context.window;
  const roles = JSON.parse(await read('assets/roles.json'));
  const nightOrder = JSON.parse(await read('assets/night-order.json'));
  const officialJinxes = JSON.parse(await read('assets/official-jinxes.json'));
  w.PageRender.setNightMeta(nightOrder.meta);
  const officials = w.OfficialRoles.buildOfficialRoles(roles, nightOrder);
  const extras = w.STCore.officialExtras(roles);
  // The page does the same: the setup flag and reminders that
  // buildOfficialRoles() leaves out, merged onto its own copies.
  officials.forEach(c => Object.assign(c, extras[c.slug] || {}));
  const off = id => officials.find(c => c.slug === 'off-' + id);
  return { C: w.STCore, P: w.PageRender, roles, nightOrder, officialJinxes, officials, extras, off };
}
const role = (roles, id) => ({ ...roles.find(r => r.id === id), slug: 'off-' + id });

const TB = ['washerwoman', 'librarian', 'investigator', 'chef', 'empath', 'fortuneteller', 'undertaker',
  'monk', 'ravenkeeper', 'virgin', 'slayer', 'soldier', 'mayor', 'butler', 'drunk', 'recluse', 'saint',
  'poisoner', 'spy', 'scarletwoman', 'baron', 'imp'];

test('storyteller: the official setup table, 5 to 15 players', async () => {
  const { C } = await load();
  const rows = { 5: [3, 0, 1, 1], 6: [3, 1, 1, 1], 7: [5, 0, 1, 1], 8: [5, 1, 1, 1], 9: [5, 2, 1, 1],
    10: [7, 0, 2, 1], 11: [7, 1, 2, 1], 12: [7, 2, 2, 1], 13: [9, 0, 3, 1], 14: [9, 1, 3, 1], 15: [9, 2, 3, 1] };
  for (const [p, r] of Object.entries(rows)) {
    assert.deepEqual(plain(C.baseCounts(Number(p))), { townsfolk: r[0], outsider: r[1], minion: r[2], demon: r[3] });
  }
  assert.equal(C.baseCounts(4), null);
  assert.equal(C.baseCounts(16), null);
  assert.equal(C.baseCounts(7.5), null);
});

test('storyteller: setup brackets on the real roles.json', async () => {
  const { C, roles } = await load();
  const mods = id => plain(C.parseSetupMods(role(roles, id))).map(m => { delete m.text; return m; });
  assert.deepEqual(mods('baron'), [{ kind: 'count', team: 'outsider', options: [2] }]);
  assert.deepEqual(mods('godfather'), [{ kind: 'count', team: 'outsider', options: [-1, 1] }]);
  assert.deepEqual(mods('balloonist'), [{ kind: 'count', team: 'outsider', options: [0, 1] }]);
  assert.deepEqual(mods('hermit'), [{ kind: 'count', team: 'outsider', options: [0, -1] }]);
  assert.ok(Object.is(C.parseSetupMods(role(roles, 'hermit'))[0].options[0], 0), '-0 parses to 0');
  assert.deepEqual(mods('vigormortis'), [{ kind: 'count', team: 'outsider', options: [-1] }]);
  assert.deepEqual(mods('fanggu'), [{ kind: 'count', team: 'outsider', options: [1] }]);
  assert.deepEqual(mods('lilmonsta'), [{ kind: 'count', team: 'minion', options: [1] }]);
  assert.deepEqual(plain(C.parseSetupMods(role(roles, 'lordoftyphon'))), [
    { kind: 'manual', text: 'Evil characters are in a line. You are in the middle' },
    { kind: 'count', team: 'minion', options: [1], text: '+1 Minion' },
    { kind: 'manual', text: '-? to +? Outsiders' }
  ]);
  assert.equal(C.parseSetupMods(role(roles, 'kazali')).length, 1);
  assert.equal(C.parseSetupMods(role(roles, 'kazali'))[0].kind, 'manual');
  assert.deepEqual(mods('choirboy'), [{ kind: 'require', name: 'King' }]);
  assert.deepEqual(mods('huntsman'), [{ kind: 'require', name: 'Damsel' }]);
  assert.deepEqual(plain(C.parseSetupMods(role(roles, 'villageidiot'))).map(m => m.kind), ['copies', 'manual']);
  for (const id of ['xaan', 'summoner', 'atheist', 'legion', 'marionette', 'bountyhunter']) {
    assert.deepEqual(plain(C.parseSetupMods(role(roles, id))).map(m => m.kind), ['manual'], id);
  }
  // The Drunk's setup effect is its fake token, which the Bag tab handles.
  assert.deepEqual(plain(C.parseSetupMods(role(roles, 'drunk'))), []);

  // Homebrew shapes.
  assert.deepEqual(plain(C.parseSetupMods({ name: 'Folie à Deux', ability: 'Hm. [+1 or +2 Outsiders, -1 Folie à Deux]' }))
    .map(m => [m.kind, m.options || null]), [['count', [1, 2]], ['copies', null]]);
  assert.deepEqual(plain(C.parseSetupMods({ name: 'Gladiator', ability: 'Fight. [+ Spartacus]' }))
    .map(m => [m.kind, m.name]), [['require', 'Spartacus']]);
  assert.deepEqual(plain(C.parseSetupMods({ name: 'X', ability: 'Fewer. [−1 Outsider]' }))[0].options, [-1]);
  assert.deepEqual(plain(C.parseSetupMods({ name: 'X', ability: 'No brackets.', setup: true })).map(m => m.kind), ['manual']);
  assert.deepEqual(plain(C.parseSetupMods({ name: 'X', ability: 'No brackets.' })), []);
  assert.deepEqual(plain(C.parseSetupMods({ name: 'Hannibal', ability: 'Eat. [+1 Hannibal]' })).map(m => m.kind), ['copies']);
  assert.deepEqual(plain(C.parseSetupMods({ name: 'X', ability: '[+1 to +3 Outsiders]' }))[0].options, [1, 2, 3]);
});

test('storyteller: modifiers move the counts, and a negative count is clamped with a warning', async () => {
  const { C, off } = await load();
  const mods = (...cs) => C.flatMods(C.modsForBag(cs, cs.map(c => c.slug)));
  let r = C.adjustCounts(C.baseCounts(7), mods(off('baron')), {});
  assert.equal(r.counts.townsfolk, 3); assert.equal(r.counts.outsider, 2);
  r = C.adjustCounts(C.baseCounts(8), mods(off('godfather')), { 'off-godfather#0': 1 });
  assert.equal(r.counts.outsider, 2); assert.equal(r.counts.townsfolk, 4);
  r = C.adjustCounts(C.baseCounts(8), mods(off('godfather')), {});
  assert.equal(r.counts.outsider, 0, 'the first option is the default');
  r = C.adjustCounts(C.baseCounts(7), mods(off('lilmonsta')), {});
  assert.equal(r.counts.minion, 2); assert.equal(r.counts.townsfolk, 4);
  r = C.adjustCounts(C.baseCounts(7), mods(off('vigormortis')), {});
  assert.equal(r.counts.outsider, 0);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /Outsiders/);
});

test('storyteller: the bag draw', async () => {
  const { C, off, officials } = await load();
  const tb = TB.map(off);
  const draw = (seed, extra = {}) => C.drawBag(tb, { players: 8, rng: C.makeRng(seed), ...extra });
  const teamOf = slug => officials.find(c => c.slug === slug).team;
  const tally = bag => bag.reduce((t, s) => { t[teamOf(s)] = (t[teamOf(s)] || 0) + 1; return t; }, {});

  assert.deepEqual(plain(draw(7).bag), plain(draw(7).bag), 'same seed, same bag');
  for (const players of [5, 8, 12]) {
    for (let seed = 1; seed < 20; seed++) {
      const r = C.drawBag(tb, { players, rng: C.makeRng(seed) });
      const t = tally(r.bag);
      assert.equal(r.bag.length, players, 'one character per player');
      assert.deepEqual(plain(r.counts), { townsfolk: t.townsfolk || 0, outsider: t.outsider || 0, minion: t.minion || 0, demon: t.demon || 0 });
      const base = C.baseCounts(players);
      const baron = r.bag.includes('off-baron') ? 2 : 0;
      assert.equal(r.counts.outsider, base.outsider + baron);
      assert.equal(r.counts.townsfolk, base.townsfolk - baron);
    }
  }
  // A lock always stays.
  for (let seed = 1; seed < 15; seed++) assert.ok(draw(seed, { locks: ['off-spy'] }).bag.includes('off-spy'));

  // The only Minion is the Baron: two more Outsiders.
  const baronOnly = TB.filter(id => !['poisoner', 'spy', 'scarletwoman'].includes(id)).map(off);
  const r = C.drawBag(baronOnly, { players: 8, rng: C.makeRng(3) });
  assert.ok(r.bag.includes('off-baron'));
  assert.equal(r.counts.outsider, 3);
  assert.equal(tally(r.bag).outsider, 3);

  // The Choirboy brings the King.
  const withChoir = ['choirboy', 'king', 'chef', 'empath', 'monk', 'saint', 'recluse', 'poisoner', 'imp'].map(off);
  const c = C.drawBag(withChoir, { players: 5, locks: ['off-choirboy'], rng: C.makeRng(9) });
  assert.ok(c.bag.includes('off-king'));
  assert.equal(c.bag.length, 5, 'the King takes a Townsfolk slot');

  // The Huntsman's Damsel is one more Outsider, even at 7 players (none by
  // the table), and a Huntsman drawn in the last pass still brings it.
  const hunt = ['huntsman', 'damsel', 'chef', 'empath', 'monk', 'mayor', 'soldier', 'slayer', 'saint', 'poisoner', 'imp'].map(off);
  for (let seed = 1; seed < 30; seed++) {
    const h = C.drawBag(hunt, { players: 7, rng: C.makeRng(seed), ...(seed % 2 ? { locks: ['off-huntsman'] } : {}) });
    const t = tally(h.bag);
    assert.equal(h.bag.length, 7, 'seed ' + seed + ': ' + h.bag.join(','));
    assert.equal(h.bag.includes('off-huntsman'), h.bag.includes('off-damsel'), 'seed ' + seed + ': the pair is drawn together');
    if (h.bag.includes('off-huntsman')) {
      assert.equal(t.outsider, 1); assert.equal(t.townsfolk, 4);
      assert.deepEqual(plain(h.counts), { townsfolk: 4, outsider: 1, minion: 1, demon: 1 });
    }
  }
  // A [[Name]] mark is not a setup bracket.
  assert.deepEqual(plain(C.parseSetupMods({ name: 'X', ability: 'Learn the [[POISONED]] player.' })), []);

  // Not enough Outsiders on the script.
  const short = ['chef', 'empath', 'monk', 'mayor', 'soldier', 'slayer', 'saint', 'recluse', 'baron', 'imp'].map(off);
  const s = C.drawBag(short, { players: 9, rng: C.makeRng(1) });
  assert.ok(s.warnings.some(w => /only 2 Outsiders characters?; setup needs 4/.test(w)), s.warnings.join(' / '));

  // Never more than four passes, over a mixed script with several modifiers.
  const mixed = TB.concat(['godfather', 'fanggu', 'vigormortis', 'balloonist', 'hermit', 'lilmonsta', 'choirboy', 'king', 'zombuul', 'sweetheart'])
    .map(off).filter(Boolean);
  for (let seed = 1; seed <= 50; seed++) {
    const m = C.drawBag(mixed, { players: 9 + (seed % 6), rng: C.makeRng(seed), choices: { 'off-godfather#0': seed % 2, 'off-balloonist#0': seed % 2 } });
    assert.ok(m.passes >= 1 && m.passes <= 4);
  }

  // A re-rolled slot does not come straight back.
  const first = draw(11);
  const out = first.bag.find(s => teamOf(s) === 'townsfolk');
  const keep = first.bag.filter(s => s !== out);
  for (let seed = 1; seed < 15; seed++) {
    const re = draw(seed, { keep, exclude: [out] });
    assert.ok(!re.bag.includes(out));
    assert.equal(re.bag.length, 8);
  }
});

test('storyteller: bluffs, fakes and who thinks they are someone else', async () => {
  const { C, off } = await load();
  const tb = TB.map(off);
  const bag = C.drawBag(tb, { players: 8, rng: C.makeRng(5) }).bag;
  for (let seed = 1; seed < 20; seed++) {
    const bl = C.pickBluffs(tb, bag, ['off-chef'], C.makeRng(seed));
    assert.equal(bl.length, 3);
    for (const s of bl) {
      assert.ok(!bag.includes(s) && s !== 'off-chef');
      assert.equal(off(s.slice(4)).team, 'townsfolk', 'Townsfolk first');
    }
    const re = C.rerollBluff(tb, bag, bl, 1, [], C.makeRng(seed));
    assert.equal(re[0], bl[0]); assert.equal(re[2], bl[2]);
    assert.ok(!bl.includes(re[1]) && !bag.includes(re[1]));
    const fake = C.pickFake(tb, bag, 'townsfolk', bl, C.makeRng(seed));
    assert.ok(fake && !bag.includes(fake) && !bl.includes(fake));
  }
  assert.equal(C.thinksTeam(off('drunk')), 'townsfolk');
  assert.equal(C.thinksTeam(off('lunatic')), 'demon');
  assert.equal(C.thinksTeam(off('marionette')), 'townsfolk');
  assert.equal(C.thinksTeam(off('magician')), null);
  assert.equal(C.thinksTeam({ slug: 'mole', ability: 'You think you are a Minion, but you are not.' }), 'minion');
  assert.equal(C.thinksTeam(off('chef')), null);
});

test('storyteller: the night runner agrees with the page and the export', async () => {
  const { C, P, off, nightOrder } = await load();
  const entries = C.sortEntries(TB.concat(['lunatic']).map(off));
  const items = P.nightItems(entries, {});
  // An arranged order (the owner swapped the Poisoner behind the Spy).
  const first = items.first.map(it => it.c.slug);
  const pi = first.indexOf('off-poisoner'), si = first.indexOf('off-spy');
  [first[pi], first[si]] = [first[si], first[pi]];
  const arranged = { first, other: items.other.map(it => it.c.slug) };
  const arrangedItems = P.nightItems(entries, arranged);

  const steps = C.nightSteps(arrangedItems.first, nightOrder.meta, 'first', { inPlay: null, players: 8 });
  assert.deepEqual(steps.filter(s => s.kind === 'char').map(s => s.slug), arrangedItems.first.map(it => it.c.slug));
  const exported = JSON.parse(P.buildPageExport('x', '', '', entries, { nightOrder: arranged }))[0];
  const ids = steps.map(s => s.kind === 'meta' ? s.id : s.c.jsonId);
  assert.deepEqual(plain(ids), plain(exported.firstNight));
  assert.equal(steps[0].id, 'dusk');
  assert.equal(steps[steps.length - 1].id, 'dawn');

  const other = C.nightSteps(arrangedItems.other, nightOrder.meta, 'other', { players: 8 });
  const otherIds = other.map(s => s.kind === 'meta' ? s.id : s.c.jsonId);
  assert.deepEqual(plain(otherIds), plain(exported.otherNight));
  assert.ok(!otherIds.includes('minioninfo') && !otherIds.includes('demoninfo'));

  // Six players: no minion or demon info.
  const six = C.nightSteps(arrangedItems.first, nightOrder.meta, 'first', { players: 6 }).map(s => s.id || s.slug);
  assert.ok(!six.includes('minioninfo') && !six.includes('demoninfo'));

  // A filter takes characters out and leaves the meta steps where they were
  // relative to everyone left.
  const inPlay = new Set(['off-poisoner', 'off-washerwoman', 'off-imp', 'off-butler']);
  const some = C.nightSteps(arrangedItems.first, nightOrder.meta, 'first', { inPlay, players: 8 }).map(s => s.id || s.slug);
  const full = ids.map((id, i) => steps[i].kind === 'meta' ? id : steps[i].slug)
    .filter(x => !x.startsWith('off-') || inPlay.has(x));
  assert.deepEqual(plain(some), plain(full));
  assert.ok(some.indexOf('minioninfo') < some.indexOf('demoninfo'));
});

test('storyteller: jinxes in play', async () => {
  const { C, P, off, officialJinxes } = await load();
  const entries = ['chambermaid', 'mathematician', 'chef', 'imp'].map(off);
  const pairs = C.officialJinxPairs(officialJinxes, entries, {});
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].text.length > 10, true);
  const all = P.scriptJinxes(entries, {}).concat(pairs);
  assert.equal(C.jinxesInPlay(all, ['off-chambermaid', 'off-mathematician']).length, 1);
  assert.equal(C.jinxesInPlay(all, ['off-chambermaid', 'off-chef']).length, 0);
  // A script can switch an official jinx off.
  const offKey = P.jinxKey('off-chambermaid', 'off-mathematician');
  assert.equal(offKey, C.jinxKey('off-mathematician', 'off-chambermaid'));
  assert.equal(C.officialJinxPairs(officialJinxes, entries, { off: [offKey] }).length, 0);
  // A script's own jinx comes through PageRender.scriptJinxes and is filtered
  // the same way; it wins over the official file's text for the same pair.
  const edits = { add: [{ a: 'off-chef', b: 'off-imp', text: 'House rule.' }, { a: 'off-chambermaid', b: 'off-mathematician', text: 'Ours.' }] };
  const list = P.scriptJinxes(entries, edits).concat(C.officialJinxPairs(officialJinxes, entries, edits));
  const on = C.jinxesInPlay(list, entries.map(c => c.slug));
  assert.deepEqual(plain(on.map(j => j.text)), ['House rule.', 'Ours.']);
  assert.equal(C.jinxesInPlay(list, ['off-chef']).length, 0);
});

test('storyteller: a saved state is reconciled with the roster', async () => {
  const { C, off } = await load();
  const entries = ['chef', 'empath', 'drunk', 'imp', 'poisoner', 'gunslinger', 'sentinel'].map(off);
  const saved = {
    players: 99, travellers: -3, seed: 42,
    bag: ['off-chef', 'off-gone', 'off-drunk', 'off-imp', 'off-gunslinger'],
    locks: ['off-chef', 'off-gone', 'off-empath'],
    choices: { 'off-chef#0': 1, 'off-gone#0': 1 }, handled: { 'off-gone#0': true, 'off-imp#0': true },
    thinks: { 'off-drunk': 'off-empath', 'off-gone': 'off-chef' },
    fabledOn: ['off-sentinel', 'off-gone'], travellersOn: ['off-gunslinger', 'off-chef'],
    bluffs: ['off-empath', 'off-gone', 'off-chef', 'off-poisoner'], tokensDone: { 'off-imp|Dead': true, 'off-gone|X': true },
    dead: ['off-imp', 'off-gone'], night: { which: 'other', n: 3, step: 4, everyone: 1 }
  };
  const copy = JSON.parse(JSON.stringify(saved));
  const s = C.reconcileState(saved, entries);
  assert.deepEqual(saved, copy, 'the input is not mutated');
  assert.equal(s.players, 15); assert.equal(s.travellers, 0); assert.equal(s.seed, 42);
  assert.deepEqual(plain(s.bag), ['off-chef', 'off-drunk', 'off-imp'], 'gone, and a traveller is never in the bag');
  assert.deepEqual(plain(s.locks), ['off-chef']);
  assert.deepEqual(plain(s.choices), { 'off-chef#0': 1 });
  assert.deepEqual(plain(s.handled), { 'off-imp#0': true });
  assert.deepEqual(plain(s.thinks), { 'off-drunk': 'off-empath' });
  assert.deepEqual(plain(s.fabledOn), ['off-sentinel']);
  assert.deepEqual(plain(s.travellersOn), ['off-gunslinger']);
  assert.deepEqual(plain(s.bluffs), ['off-empath']);
  assert.deepEqual(plain(s.tokensDone), { 'off-imp|Dead': true });
  assert.deepEqual(plain(s.dead), ['off-imp']);
  assert.deepEqual(plain(s.night), { which: 'other', n: 3, step: 4, everyone: true });
  assert.equal(C.reconcileState(null, entries).players, 8);
  assert.equal(C.reconcileState('garbage', entries).bag.length, 0);
  assert.equal(C.storageKey({ slug: 'trouble' }), 'botc_st:s:trouble');
  assert.equal(C.storageKey({ builder: true }), 'botc_st:builder');
});

test('storyteller: the reminder-token checklist', async () => {
  const { C, roles } = await load();
  const extras = C.officialExtras(roles);
  // Bare official objects carry no reminders: the extras supply them.
  const entries = [{ slug: 'off-poisoner', name: 'Poisoner' }, { slug: 'off-drunk', name: 'Drunk' },
    { slug: 'off-fortuneteller', name: 'Fortune Teller' },
    { slug: 'hb', name: 'Homebrew', reminders: ['Mark', 'Mark', ' '], remindersGlobal: ['Everywhere'] }];
  const r = C.reminderChecklist(entries, ['off-poisoner', 'off-fortuneteller', 'hb'], extras);
  assert.deepEqual(plain(r.inPlay), [
    { slug: 'off-poisoner', name: 'Poisoner', tokens: ['Poisoned'] },
    { slug: 'off-fortuneteller', name: 'Fortune Teller', tokens: ['Red Herring'] },
    { slug: 'hb', name: 'Homebrew', tokens: ['Mark', 'Everywhere'] }
  ]);
  assert.deepEqual(plain(r.global), [{ slug: 'off-drunk', name: 'Drunk', tokens: ['Is The Drunk'] }]);
});

test('storyteller: the page and its three ways in', async () => {
  const html = await read('storyteller.html');
  assert.match(html, /id="search-input"/, 'the topbar is copied');
  assert.match(html, /<script src="assets\/site\.js"><\/script>/);
  const order = f => html.indexOf('src="assets/' + f + '"');
  for (const f of ['reader.js', 'render.js', 'render-page.js', 'official-roles.js', 'storyteller-core.js', 'storyteller.js']) {
    assert.ok(order(f) > 0, f + ' is loaded');
  }
  assert.ok(order('reader.js') < order('render.js'));
  assert.ok(order('render.js') < order('render-page.js'));
  assert.ok(order('storyteller-core.js') < order('storyteller.js'));
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(m[1]);
  new vm.Script(await read('assets/storyteller.js'));
  // Every form control carries a label.
  for (const m of html.matchAll(/<(input|select|textarea)\b[^>]*>/g)) {
    const tag = m[0];
    const id = (tag.match(/\bid="([^"]+)"/) || [])[1];
    const labelled = /aria-label(ledby)?=/.test(tag) || (id && html.includes('for="' + id + '"'));
    assert.ok(labelled, 'unlabelled control: ' + tag);
  }
  assert.match(await read('script.html'), /href="storyteller"/);
  assert.match(await read('assets/pageview.js'), /storyteller\?s=/);
  assert.match(await read('tools.html'), /href="storyteller"/);
});

test('storyteller: the page is in the sitemap', async t => {
  const { fixture } = await import('./worker-fixture.mjs');
  const f = await fixture();
  t.after(() => f.finish());
  const sm = await (await f.request('/sitemap.xml')).text();
  assert.match(sm, /\/storyteller</);
});
