/* Fancy Scripts engine self-test.
 *
 *   node migration/fancyscripts-test.mjs
 *
 * Runs the pure engine (assets/fancyscripts/script.js) against the wiki's
 * own data files and checks the things that are easy to break without
 * noticing: the night order of the owner's reference sheets ("Blending
 * In", line for line), the file's own _meta sequences, reminder marks,
 * the option model's legacy folding, page lists, per-character overrides,
 * and the ribbon-style night sheet's defaults and bundled step icons.
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

// the preview twin of a wiki icon
check('preview icon: absolute wiki art', S.previewIcon('https://botchomebrew.wiki/assets/art/witcher-odyssey.png?v=abc'), 'https://botchomebrew.wiki/assets/thumb/witcher-odyssey.png.webp?v=abc');
check('preview icon: site-relative art', S.previewIcon('/assets/art/x.jpg'), '/assets/thumb/x.jpg.webp');
check('preview icon: everything else untouched', [S.previewIcon('/assets/fancyscripts/icons/imp.webp'), S.previewIcon('data:image/png;base64,AA'), S.previewIcon('https://images.weserv.nl/?url=x'), S.previewIcon('')],
  ['/assets/fancyscripts/icons/imp.webp', 'data:image/png;base64,AA', 'https://images.weserv.nl/?url=x', '']);

// the Bootlegger tick: added, taken out, and the team it prints under
check('bootlegger: absent by default', S.hasBootlegger(['imp', 'baron']), false);
check('bootlegger: added as a fabled', S.withBootlegger(['imp'], true), ['imp', { id: 'bootlegger', team: 'fabled' }]);
check('bootlegger: adding twice does not', S.withBootlegger(S.withBootlegger(['imp'], true), true).length, 2);
check('bootlegger: taken out again', S.withBootlegger(S.withBootlegger(['imp'], true), false), ['imp']);
check('bootlegger: a file that carries one is found', S.hasBootlegger(['imp', 'bootlegger']), true);
check("bootlegger: a file's bare id is filed under fabled too",
  S.withBootlegger(['imp', 'bootlegger'], true), ['imp', { id: 'bootlegger', team: 'fabled' }]);
check("bootlegger: a file's own team is left alone",
  S.withBootlegger(['imp', { id: 'bootlegger', team: 'loric' }], true), ['imp', { id: 'bootlegger', team: 'loric' }]);
check('bootlegger: unticking takes out one the file came with', S.withBootlegger(['imp', 'bootlegger'], false), ['imp']);
check('bootlegger: off leaves a script without one untouched', S.withBootlegger(['imp'], false), ['imp']);
const bootParsed = S.parseScript(S.withBootlegger(['imp'], true), true).characters;
check('bootlegger: name, ability and team off the roster',
  bootParsed.map((c) => c.id + '/' + c.team + '/' + (c.name === 'Bootlegger' && /homebrew/i.test(c.ability))),
  ['imp/demon/false', 'bootlegger/fabled/true']);
check('bootlegger: does not wake', bootParsed[1].firstNight + bootParsed[1].otherNight, 0);
check('bootlegger: the default option is off', S.normalizeOptions({}).bootlegger, false);

// the app view: the style switch, its defaults, and the line setting it
// does itself. The measure here is one unit per character, so the breaks
// can be read off the strings.
const unit = (s) => s.length;
const plain = S.normalizeOptions({});
check('app view: both pages start classic', [S.pageStyle(plain, 'front'), S.pageStyle(plain, 'night'), S.pageStyle(plain, 'jinx')],
  ['classic', 'classic', 'classic']);
const appOn = S.normalizeOptions({ sheetStyle: 'app', night: { style: 'app' } });
check('app view: each page switches on its own', [S.pageStyle(appOn, 'front'), S.pageStyle(appOn, 'night'), S.pageStyle(appOn, 'jinx'),
  S.pageStyle(S.normalizeOptions({ night: { style: 'app' } }), 'front')], ['app', 'app', 'classic', 'classic']);
check('app view: a design saved before it existed gets its defaults',
  [plain.app.sidebarColor, plain.app.fontName, plain.app.bg.mode, plain.night.appTitle], ['#670818', 'tradebold', 'parchment', false]);
check('app view: element keys are unique and styled', (() => {
  const keys = S.ELEMENTS.map((e) => e.key);
  return keys.length === new Set(keys).size && S.ELEMENTS.every((e) => !e.only || e.only === 'classic' || e.only === 'app');
})(), true);
const lineText = (lines) => lines.map((l) => l.items.map((it) => (it.lead ? ' ' : '') + (it.kind === 'dot' ? '●' : it.s)).join(''));
check('break: words wrap at the width', lineText(S.breakRuns([{ s: 'aaa bbb ccc ddd', font: 'f' }], 7, unit)), ['aaa bbb', 'ccc ddd']);
check('break: a line never starts with a space', S.breakRuns([{ s: 'aaa bbb ccc', font: 'f' }], 7, unit)[1].items[0].lead || 0, 0);
check('break: a token run is set in its own font', S.breakRuns([{ s: 'show the ', font: 'f' }, { s: 'YOU ARE', font: 'b', kind: 'token' }], 40, unit)[0].items.map((i) => i.font),
  ['f', 'f', 'b', 'b']);
check('break: a bracket goes down with its word', lineText(S.breakRuns(
  [{ s: 'the (or ', font: 'f' }, { s: 'RED', font: 'b', kind: 'token' }, { s: ').', font: 'f' }], 10, unit)), ['the (or', 'RED).']);
const dotted = S.breakRuns([{ s: 'chooses.', font: 'f' }, { s: ' ', font: 'f' }, { kind: 'dot', font: 'f' }, { s: ' then more', font: 'f' }], 12, unit, { dotW: 2 });
check('break: a reminder disc is one item and marks its line', [lineText(dotted), dotted.map((l) => l.dot)], [['chooses. ●', 'then more'], [true, false]]);
const fontAt = (s) => String(s);
const scaled = (t, f) => t.length * Number(f);
check('name: fits on one line', S.fitNameLines('Chef', 10, scaled, fontAt), { scale: 1, lines: ['Chef'] });
check('name: wraps at its spaces', S.fitNameLines('Fortune Teller', 10, scaled, fontAt).lines, ['Fortune', 'Teller']);
check('name: one long word shrinks instead of being cut', S.fitNameLines('Washerwoman', 8, scaled, fontAt), { scale: 8 / 11, lines: ['Washerwoman'] });
check('name: a night name shrinks a little before it wraps', S.fitNameLines('Scarlet Woman', 12, scaled, fontAt, { shrinkFirst: 0.8 }),
  { scale: 12 / 13, lines: ['Scarlet Woman'] });

// the ribbon-style night sheet (the default) and what it retired
const dn = S.normalizeOptions({});
check('night: ribbon style by default', [dn.night.style, dn.night.ribbon, dn.night.hang, dn.jinxPage.style], ['ribbon', true, true, 'ribbon']);
check('night: every-icon offsets default to nothing', [dn.iconShiftX, dn.iconShiftY, dn.night.iconShiftX, dn.night.iconShiftY, dn.jinxPage.iconShiftX, dn.jinxPage.iconShiftY], [0, 0, 0, 0, 0, 0]);
const oldDesign = S.normalizeOptions({ night: { showFooter: true, footer1: 'x', footer2: 'y', showBadge: true }, jinxPage: { showFooter: false, showBadge: true }, el: { nightBadge: { dx: 2 }, nightFooter: { dy: 1 }, jinxBadge: {}, jinxFooter: {}, nightTitle: { dy: 3 } } });
check('night: an old design drops the footer and badge', [Object.keys(oldDesign.night).filter((k) => /footer|badge/i.test(k)), Object.keys(oldDesign.jinxPage).filter((k) => /footer|badge/i.test(k)), Object.keys(oldDesign.el)], [[], [], ['nightTitle']]);
check('night: no footer or badge element', S.ELEMENTS.filter((e) => /Footer|Badge/.test(e.key)).length, 0);
check('night: the step icons are the bundled discs', ['dusk', 'dawn', 'minion', 'demon'].map((k) => S.STEP_ICONS[k]),
  ['dusk', 'dawn', 'minion', 'demon'].map((k) => '/assets/fancyscripts/art/night-' + k + '.webp'));
check('night: the step icon files exist', ['dusk', 'dawn', 'minion', 'demon'].every((k) => fs.existsSync(path.join(root, 'assets/fancyscripts/art/night-' + k + '.webp'))), true);
check('night: dusk and dawn in the printed sheets\' wording', [S.NIGHT_STEPS.dusk.text, S.NIGHT_STEPS.dawn.text],
  ['Check that all eyes are closed. Some Travellers & Fabled act.', 'Wait a few seconds. Call for eyes open.']);

console.log(failures ? '\n' + failures + ' failure(s)' : '\nall good');
process.exit(failures ? 1 : 0);
