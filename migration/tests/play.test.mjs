// The pure halves of Script Check, Deal a Game and the Daily Puzzle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Setup = require('../../assets/setup-rules.js');
const Check = require('../../assets/script-check.js');
const Daily = require('../../assets/daily.js');
const roles = require('../../assets/roles.json');

const off = ids => ids.map(id => roles.find(r => r.id === id)).map(r => ({ slug: 'off-' + r.id, official: true, name: r.name, team: r.team, ability: r.ability }));
const TB = off(['washerwoman', 'librarian', 'investigator', 'chef', 'empath', 'fortuneteller', 'undertaker', 'monk',
  'ravenkeeper', 'virgin', 'slayer', 'soldier', 'mayor', 'butler', 'drunk', 'recluse', 'saint', 'poisoner', 'spy',
  'scarletwoman', 'baron', 'imp']);
// A seeded random, so a failure can be replayed.
function rng(seed) { return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648); }

test('setup rules: the official bracket text reads the way a Storyteller reads it', () => {
  assert.deepEqual(Setup.parseSetup('There are extra Outsiders in play. [+2 Outsiders]').mods, [{ team: 'outsider', options: [2], text: '+2 Outsiders' }]);
  assert.deepEqual(Setup.parseSetup('[-1 or +1 Outsider]').mods[0].options, [-1, 1]);
  assert.deepEqual(Setup.parseSetup('[−1 Outsider]').mods[0].options, [-1]);
  assert.deepEqual(Setup.parseSetup('[+0 to +2 Outsiders]').mods[0].options, [0, 1, 2]);
  assert.deepEqual(Setup.parseSetup('[+the King]').adds, ['King']);
  assert.deepEqual(Setup.parseSetup('[No evil characters]').notes, ['No evil characters']);
  const typhon = Setup.parseSetup('[Evil characters are in a line. +1 Minion. -? to +? Outsiders]');
  assert.deepEqual(typhon.mods.map(m => m.team), ['minion']);
  assert.equal(typhon.notes.length, 2);
  assert.equal(Setup.describeMod({ team: 'outsider', options: [0, 1] }), '+0 or +1 Outsider');
});

test('deal: every bag seats exactly the player count, modifiers applied, bluffs not in play', () => {
  const random = rng(7);
  for (let i = 0; i < 400; i++) {
    const players = 5 + (i % 11);
    const d = Setup.deal(TB, players, random);
    assert.equal(d.seats.length, players, 'seats at ' + players);
    assert.equal(d.short.length, 0);
    const c = d.counts;
    assert.equal(c.townsfolk + c.outsider + c.minion + c.demon, players);
    for (const team of ['townsfolk', 'outsider', 'minion', 'demon']) {
      assert.equal(d.seats.filter(s => s.team === team).length, c[team]);
    }
    const baron = d.seats.some(s => s.name === 'Baron');
    assert.equal(c.outsider, Setup.baseCounts(players).outsider + (baron ? 2 : 0));
    assert.ok(d.bluffs.every(b => !d.seats.includes(b) && (b.team === 'townsfolk' || b.team === 'outsider')));
    if (d.seats.some(s => s.name === 'Drunk')) assert.ok(d.notes.some(n => /thinks they are a Townsfolk/.test(n)));
  }
});

test('deal: a script too small for the table says which team ran out', () => {
  const d = Setup.deal(TB.filter(c => c.team !== 'outsider'), 15, rng(3));
  assert.deepEqual(d.short.map(s => s.team), ['outsider']);
});

test('script check: Trouble Brewing seats everybody and has nothing to flag', () => {
  const a = Check.analyze(TB);
  assert.deepEqual(a.counts, { townsfolk: 13, outsider: 4, minion: 4, demon: 1 });
  assert.deepEqual(a.playable, [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.deepEqual(a.warnings, []);
  assert.equal(a.setup.length, 1);
  assert.match(Check.summary(TB), /^Seats 5–15 players/);
  assert.equal(Check.rangeText([5, 6, 7, 9, 12, 13]), '5–7, 9 and 12–13');
});

test('script check: the easy mistakes are found', () => {
  const a = Check.analyze([
    { name: 'Twin', team: 'townsfolk', ability: 'x', tags: 'Information' },
    { name: 'Twin', team: 'townsfolk', ability: '[+the Queen]', tags: ['Information', 'Setup'] },
    { name: 'Ghost', team: 'outsider', ability: '' }
  ]);
  assert.ok(a.warnings.some(w => /no Demon/.test(w)));
  assert.ok(a.warnings.some(w => /called “Twin”/.test(w)));
  assert.ok(a.warnings.some(w => /no ability text/.test(w)));
  assert.ok(a.warnings.some(w => /Queen/.test(w)));
  assert.deepEqual(a.tags[0], { tag: 'Information', count: 2 });
  assert.equal(a.playable.length, 0);
  // Every string that reaches the page is escaped.
  assert.doesNotMatch(Check.html([{ name: '<b>x</b>', team: 'demon', ability: '[+the <i>]' }]), /<b>x<\/b>|<i>/);
});

test('daily: one answer per day for everybody, redacted and compared fairly', () => {
  const chars = [
    { slug: 'rat-king', name: 'Rat King', team: 'demon', art: 'art/a.png', creator: 'Ann', tags: 'Death, Madness', appearsIn: 'Sewers',
      ability: 'Each night*, choose a player: they die. The Rat King is mad about it.' },
    { slug: 'rat', name: 'Rat', team: 'minion', art: 'art/b.png', creator: 'Ann, Bo', tags: 'Madness', ability: 'You start knowing which player is the Demon and more.' },
    { slug: 'saint2', name: 'Saint', team: 'outsider', art: 'art/c.png', creator: 'Cy', tags: 'Win/Loss Condition', ability: 'If you die by execution, your team loses the game today.' },
    { slug: 'draft', name: 'Draft', team: 'demon', art: 'art/d.png', status: 'draft', ability: 'Long enough to be a clue for anyone.' },
    { slug: 'partial', name: 'Part', team: 'demon', art: 'art/e.png', classification: 'partial', ability: 'Long enough to be a clue for anyone.' },
    { slug: 'noart', name: 'Bare', team: 'demon', ability: 'Long enough to be a clue for anyone.' }
  ];
  const day = Daily.dayNumber(Date.UTC(2026, 9, 1, 12));
  const a = Daily.pick(chars, day);
  assert.ok(['rat-king', 'rat', 'saint2'].includes(a.slug));
  // Same day, same answer, in any order.
  assert.equal(Daily.pick(chars.slice().reverse(), day).slug, a.slug);
  assert.equal(Daily.puzzleNumber(Daily.EPOCH_DAY), 1);

  assert.equal(Daily.redact(chars[0].ability, 'Rat King'), 'Each night*, choose a player: they die. The ████████ is mad about it.');
  assert.equal(Daily.letterHint('Rat King'), 'R _ _ \u00a0\u00a0 _ _ _ _');

  const r = Daily.compare(chars[1], chars[0]);
  assert.equal(r.correct, false);
  assert.equal(r.team.v, 'near');       // both evil
  assert.equal(r.creator.v, 'hit');     // Ann is on both credits
  assert.equal(r.set.v, 'miss');
  assert.equal(r.tags.v, 'near');
  assert.equal(Daily.compare(chars[0], chars[0]).correct, true);
  assert.equal(Daily.compare(chars[2], chars[0]).team.v, 'miss');
  const share = Daily.shareText(4, [r, Daily.compare(chars[0], chars[0])], true);
  assert.equal(share.split('\n')[0], 'BOTC Homebrew Daily #4 — 2/6');
  assert.ok(!share.includes('Rat'), 'the result never names the answer');
});
