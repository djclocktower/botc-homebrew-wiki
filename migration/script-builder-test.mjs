/* Unit checks for assets/script-builder-tools.js (the Script Builder's pure
   half) and assets/script-builder-view.js's normaliser. Plain node, no
   browser:  node migration/script-builder-test.mjs  */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const win = { matchMedia: null };
const ctx = vm.createContext({ window: win, document: undefined, console });
for (const f of ['assets/script-builder-tools.js', 'assets/script-builder-view.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });
}
const T = win.SBTools, V = win.SBView;

let fails = 0;
function ok(cond, label) {
  console.log((cond ? 'ok   ' : 'FAIL ') + label);
  if (!cond) fails++;
}
function eq(a, b, label) { ok(JSON.stringify(a) === JSON.stringify(b), label + (JSON.stringify(a) === JSON.stringify(b) ? '' : '  got ' + JSON.stringify(a))); }

// ── shapes ──
eq(T.shapeOf({}), T.DEFAULT_SHAPE, 'no shape on the meta is the standard shape');
ok(T.shapeStore(T.DEFAULT_SHAPE) === null, 'the default shape stores as nothing');
eq(T.shapeStore({ townsfolk: 6, outsider: 2, minion: 2, demon: 1 }).townsfolk, 6, 'a custom shape stores');
eq(T.shapeKey({ townsfolk: 6, outsider: 2, minion: 2, demon: 1 }), 'teensy', 'Teensyville is recognised');
eq(T.shapeKey({ townsfolk: 7, outsider: 2, minion: 2, demon: 1 }), 'custom', 'anything else is custom');
eq(T.normShape({ townsfolk: -3, outsider: 'x', demon: 500 }).townsfolk, 0, 'negative targets clamp to 0');
eq(T.normShape({ demon: 500 }).demon, 99, 'targets cap at 99');
eq(T.shapeTotal(T.DEFAULT_SHAPE), 25, 'standard total is 25');

// ── filling ──
const mk = (slug, team, extra) => Object.assign({ slug, name: slug, team, ability: 'x' }, extra || {});
const pool = [];
['townsfolk', 'outsider', 'minion', 'demon'].forEach(t => { for (let i = 0; i < 20; i++) pool.push(mk(t + i, t)); });
let seed = 1;
const rng = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const plan = T.fillPlan(pool, [mk('townsfolk0', 'townsfolk')], T.DEFAULT_SHAPE, rng);
eq(plan.add.length, 24, 'fill adds what is missing (25 minus the one on it)');
ok(!plan.add.includes('townsfolk0'), 'fill never adds a character already on the script');
eq(Object.keys(plan.short).length, 0, 'a big enough pool leaves nothing short');
const shortPlan = T.fillPlan(pool.filter(c => c.team !== 'demon'), [], T.DEFAULT_SHAPE, rng);
eq(shortPlan.short, { demon: 4 }, 'a pool without demons reports the shortfall');
const rp = T.randomPlan(pool, [mk('demon3', 'demon'), mk('minion1', 'minion')], T.DEFAULT_SHAPE, ['demon3'], rng);
ok(rp.slugs[0] === 'demon3' && rp.kept === 1, 'random keeps the locked character first');
ok(!rp.slugs.includes('minion1') || rp.slugs.filter(s => s === 'minion1').length <= 1, 'the unlocked one may go');
eq(rp.slugs.length, 25, 'random draws to the shape');
eq(new Set(rp.slugs).size, 25, 'no duplicates in a random draw');
// deterministic under the same seed
seed = 7; const a1 = T.fillPlan(pool, [], T.DEFAULT_SHAPE, rng).add;
seed = 7; const a2 = T.fillPlan(pool, [], T.DEFAULT_SHAPE, rng).add;
eq(a1, a2, 'the same rng gives the same draw');

// ── analysis ──
const script = [
  mk('a', 'townsfolk', { tags: 'Information, You Start Knowing', firstNight: 12, creator: 'Ann' }),
  mk('b', 'townsfolk', { tags: 'Protection', otherNight: 9, creator: 'Ann, Bob' }),
  mk('c', 'outsider', { tags: 'Drunkenness', classification: 'partial' }),
  mk('d', 'minion', { tags: 'Poison', otherNight: 20, ability: 'Each night, poison [+1 Outsider]' }),
  mk('d2', 'minion', { name: 'd', tags: '' }),
  mk('e', 'demon', { tags: 'Single-Kill', otherNight: 30, official: true })
];
const an = T.analyse(script, { shape: T.DEFAULT_SHAPE, jinxes: [{}] });
eq(an.total, 6, 'counts the roster');
eq(an.official, 1, 'counts officials');
eq(an.night, { first: 1, other: 3, never: 2 }, 'night counts');
eq(an.info, 1, 'information count');
eq(an.misinfo, 2, 'misinformation count');
eq(an.setup, ['d'], 'setup-changers are read off the ability brackets');
eq(an.dupes, ['d'], 'two characters sharing a name are reported');
eq(an.partial, ['c'], 'a stamped partial row is reported');
eq(an.creators.map(c => c.name + c.n), ['Ann2', 'Bob1', 'The Pandemonium Institute1'], 'creators are split and counted');
eq(an.tags[0], { tag: 'Drunkenness', n: 1 }, 'tags are counted and sorted (ties alphabetical)');
ok(an.warnings.some(w => /share a name/.test(w.text)), 'warns about the duplicate name');
ok(an.warnings.some(w => /unfinished/.test(w.text)), 'warns about a partial page');
const noDemon = T.analyse(script.filter(c => c.team !== 'demon'), {});
ok(noDemon.warnings.some(w => w.level === 'bad' && /no Demon/.test(w.text)), 'no demon is flagged bad');
eq(T.analyse([], {}).warnings.length, 0, 'an empty script has nothing to say');

// ── text ──
const meta = { name: 'My Script', author: 'Me', bootlegger: ['No Fortune Teller herring'], notes: 'be nice' };
const plain = T.textExport(script.slice(0, 3), meta, { format: 'plain' });
ok(plain.startsWith('My Script\nby Me\n\nTOWNSFOLK\n- a: x'), 'plain text shape');
const md = T.textExport(script.slice(0, 3), meta, { format: 'markdown', rules: true, notes: true });
ok(md.startsWith('# My Script\n*by Me*\n\n## Townsfolk\n• **a** — x'), 'markdown shape');
ok(/## House rules\n• No Fortune/.test(md) && /## Notes\nbe nice/.test(md), 'markdown carries rules and notes');
const disc = T.textExport(script.slice(0, 3), meta, { format: 'discord', abilities: false });
ok(/__TOWNSFOLK__\n• \*\*a\*\*\n/.test(disc), 'discord: bold names, no abilities when off');
const names = T.textExport(script, meta, { format: 'names' });
ok(/TOWNSFOLK \(2\)\na, b/.test(names), 'names only lists per team');
const night = T.textExport(script.slice(0, 2), meta, { format: 'plain', night: true, nightItems: { first: [{ c: script[0], r: 'wake' }], other: [] }, reminders: true });
ok(/FIRST NIGHT\n1\. a: wake/.test(night), 'night order rides along with reminders');
ok(!/OTHER NIGHTS/.test(night), 'an empty night list is left out');
eq(T.summary(script), '2 Townsfolk, 1 Outsider, 2 Minion, 1 Demon', 'summary line');

// ── view normaliser ──
const v = V.normalize({ layout: 'bogus', icon: 1000, text: '90', showAbility: 0, extra: 1 });
eq(v.layout, 'sheet', 'an unknown layout falls back');
eq(v.icon, 96, 'icon clamps to the max');
eq(v.text, 90, 'a numeric string is fine');
eq(v.showAbility, false, 'checks coerce to booleans');
ok(!('extra' in v), 'unknown keys are dropped');
ok(V.isDefault(V.normalize({})), 'an empty view is the default');
ok(!V.isDefault(V.normalize({ icon: 50 })), 'a changed size is not');
eq(V.teamHeading('townsfolk', 'Townsfolk', { teamLabel: 'short' }), 'TF', 'short headings');
eq(V.teamHeading('townsfolk', 'Townsfolk', { teamLabel: 'none' }), '', 'no headings');
ok(V.SCHEMA.every(s => s.key in V.DEFAULTS), 'every schema row has a default');
ok(V.PRESETS.every(p => Object.keys(p.view).every(k => k in V.DEFAULTS)), 'presets only name real settings');

console.log(fails ? '\n' + fails + ' FAILED' : '\nall good');
process.exit(fails ? 1 : 0);
