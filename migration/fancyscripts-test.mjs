/* Fancy Scripts engine self-test.
 *
 *   node migration/fancyscripts-test.mjs
 *
 * Runs the pure engine (assets/fancyscripts/script.js) against the wiki's
 * own data files and checks the things that are easy to break without
 * noticing: the night order of the owner's reference sheets ("Blending
 * In", line for line), the file's own _meta sequences, reminder marks,
 * the option model's legacy folding, page lists, per-character overrides.
 * No browser needed — the engine has no DOM. Exits non-zero on a failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const S = await import(path.join(root, 'assets/fancyscripts/script.js'));
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

let failures = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log('ok   ' + name); return; }
  failures++;
  console.log('FAIL ' + name + '\n     got      ' + a + '\n     expected ' + e);
}

S.setOfficialRoster(read('assets/roles.json'), read('assets/fancyscripts/official-jinxes.json'), read('assets/night-order.json'));

// the reference night sheets
const blending = [{ id: '_meta', name: 'Blending In' },
  'boffin', 'magician', 'pixie', 'librarian', 'steward', 'bountyhunter', 'highpriestess', 'chambermaid',
  'farmer', 'undertaker', 'towncrier', 'seamstress', 'juggler', 'nightwatchman', 'damsel', 'xaan', 'poisoner', 'scarletwoman', 'imp'];
const derived = S.deriveScript(S.parseScript(blending, true), S.normalizeOptions({}));
const lists = S.nightLists(derived, S.DEFAULT_NIGHT);
check('first night order', lists.first.map((i) => i.name),
  ['Dusk', 'Boffin', 'Magician', 'Minion Info', 'Demon Info', 'Xaan', 'Poisoner', 'Pixie', 'Damsel', 'Librarian',
    'Seamstress', 'Steward', 'Bounty Hunter', 'Nightwatchman', 'High Priestess', 'Chambermaid', 'Dawn']);
check('other nights order', lists.other.map((i) => i.name),
  ['Dusk', 'Xaan', 'Poisoner', 'Scarlet Woman', 'Imp', 'Damsel', 'Farmer', 'Undertaker', 'Town Crier', 'Seamstress',
    'Juggler', 'Bounty Hunter', 'Nightwatchman', 'High Priestess', 'Chambermaid', 'Dawn']);

// a homebrew character on the official scale, and the wiki's own reminder marks
const hb = S.deriveScript(S.parseScript([...blending, { id: 'hb', name: 'Homebrew', team: 'townsfolk', ability: 'x',
  firstNight: 33.5, firstNightReminder: 'The Homebrew chooses a player. :reminder: Show the *YOU ARE* token.' }], true), S.normalizeOptions({}));
check('homebrew slots in after the Poisoner', S.nightLists(hb, S.DEFAULT_NIGHT).first.map((i) => i.id).slice(5, 9), ['xaan', 'poisoner', 'hb', 'pixie']);
check('reminder marks', S.reminderParts('A :reminder: b *YOU ARE* c'),
  [{ t: 'text', s: 'A ' }, { t: 'dot' }, { t: 'text', s: ' b ' }, { t: 'token', s: 'YOU ARE' }, { t: 'text', s: ' c' }]);

// the file's own sequence, a hand-arranged one, hidden steps
const seq = S.deriveScript(S.parseScript([{ id: '_meta', name: 'Seq', firstNight: ['dusk', 'poisoner', 'minioninfo', 'demoninfo', 'boffin', 'dawn'] },
  'boffin', 'poisoner', 'magician'], true), S.normalizeOptions({}));
check('_meta sequence honoured', S.nightLists(seq, S.DEFAULT_NIGHT).first.map((i) => i.id), ['dusk', 'poisoner', 'minioninfo', 'demoninfo', 'boffin', 'magician', 'dawn']);
// a hand-arranged sequence beats the file's; a character it does not list
// (added to the script since) slots in by its own number
check('hand-arranged order wins', S.nightLists(seq, { ...S.DEFAULT_NIGHT, order: { first: ['dusk', 'boffin', 'poisoner'], other: null } }).first.map((i) => i.id),
  ['dusk', 'boffin', 'magician', 'minioninfo', 'demoninfo', 'poisoner', 'dawn']);
check('hidden steps', S.nightLists(seq, { ...S.DEFAULT_NIGHT, useScriptOrder: false, hideSteps: { dusk: true, minioninfo: false, demoninfo: true, dawn: false } }).first.map((i) => i.id), ['boffin', 'magician', 'minioninfo', 'poisoner', 'dawn']);

// the option model
const n = S.normalizeOptions({ titleDX: 3, skullScale: 1.2, flourishSpread: 2, includeBackCover: false, night: { first: true } });
check('legacy sliders fold into elements', n.el, { title: { dx: 3 }, skull: { scale: 1.2 }, fll: { dx: -2 }, flr: { dx: 2 } });
check('legacy back-cover tick', n.exportOpts.pages.back, false);
check('every default present', [n.night.titleOther, n.bg.mode, n.jinxPage.title, n.exportOpts.pageSize], ['Other Nights', 'parchment', 'Jinxes', 'trim']);
check('page list', S.pageList(n, { front: 2 }).map(S.pageKey), ['front:0', 'front:1', 'night:first']);
check('page list with everything', S.pageList(S.normalizeOptions({ night: { first: true, other: true }, jinxPage: { enabled: true } }), { front: 1, first: 2, other: 1, jinx: 1 }).map(S.pageKey),
  ['front:0', 'night:first', 'night:first:1', 'night:other', 'jinx', 'back']);

// per-character overrides and team hiding
const ov = S.deriveScript(S.parseScript(blending, true), S.normalizeOptions({ chars: { poisoner: { hidden: true }, imp: { name: 'The Imp!', color: '#ff0000', team: 'minion' } }, hideTeams: { outsider: true } }));
check('override + hide', ov.characters.filter((c) => c.id === 'imp' || c.id === 'poisoner' || c.team === 'outsider').map((c) => c.name + '/' + c.color + '/' + c.team), ['The Imp!/#ff0000/minion']);
check('alphabetical sort', S.sortCharacters(derived.characters, 'alpha').slice(0, 3).map((c) => c.name), ['Boffin', 'Bounty Hunter', 'Chambermaid']);
check('team colours', [S.teamColor(n, 'fabled'), S.teamColor(n, 'minion'), S.teamColor(n, 'townsfolk')], ['#8a6d1f', '#731d1f', '#0d6c97']);
check('font stacks', [S.fontFamily('upload:My Font').startsWith('"My Font"'), S.fontLabel('tradebold')], [true, 'Trade Gothic Bold Condensed']);
check('background filter', S.bgFilter({ brightness: 0.9, sepia: 0.2 }), 'brightness(0.9) sepia(0.2)');
check('credits Fabled skipped', S.parseScript(['imp', 'botchomebrewwiki'], true).characters.map((c) => c.id), ['imp']);
check('not an array throws', (() => { try { S.parseScript({}, true); return 'no'; } catch (e) { return 'threw'; } })(), 'threw');

console.log(failures ? '\n' + failures + ' failure(s)' : '\nall good');
process.exit(failures ? 1 : 0);
