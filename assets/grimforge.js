/* Grimoire Forge — Blood on the Clocktower ability syntax checker.

   The original tool was written by Ma'ayan; this is the wiki build of it.
   The ruleset below is the consolidated v2 set, derived from the official
   corpus (182 abilities), the BOTC Main Rulebook, the Ability Writing Guide
   and the Homebrewer's Field Guide.

   Every rule carries a severity:
     'fix'   autofix — zero false positives across the whole official corpus,
             so "Apply all fixes" is allowed to rewrite it.
     'warn'  flag only, never rewritten in bulk. Either the official corpus
             contains counterexamples, or the call is semantic and a linter
             cannot resolve it. The user can still accept one individually.
     'off'   correct, but too noisy to enable by default. Shown in the rules
             panel, unticked.

   Two kinds of finding come out of lint():
     issues   anchored to a span of the text — highlighted inline, and
              individually acceptable.
     notices  whole-text observations (structure, typography, design). There
              is nothing to swap in, so they are listed, not highlighted.

   No DOM access anywhere in this file: it is plain data + string work, so it
   runs in the browser, in Node (`node --check`) and would run in the Worker
   unchanged if a server-side check is ever wanted. */
(function () {
  'use strict';

  /* ══ 1. Data ═════════════════════════════════════════════════════ */

  /* Team/rules words that are proper nouns on a card. */
  var CAPS_TERMINOLOGY = [
    'Demon', 'Minion', 'Outsider', 'Townsfolk', 'Traveller',
    'Storyteller', 'Grimoire', 'Fabled', 'Loric'
  ];

  /* The full official roster, exact casing, multi-word names intact.
     Apostrophes are stored straight ('), not curly (’), because normalise()
     straightens apostrophes in the suggested output — a name suggestion that
     used a curly one would immediately be undone. Matching accepts both. */
  var OFFICIAL_NAMES = [
    // Trouble Brewing
    'Washerwoman', 'Librarian', 'Investigator', 'Chef', 'Empath', 'Fortune Teller', 'Undertaker',
    'Monk', 'Ravenkeeper', 'Virgin', 'Slayer', 'Soldier', 'Mayor', 'Butler', 'Drunk', 'Recluse', 'Saint',
    'Poisoner', 'Spy', 'Scarlet Woman', 'Baron', 'Imp',
    // Bad Moon Rising
    'Grandmother', 'Sailor', 'Chambermaid', 'Exorcist', 'Innkeeper', 'Gambler', 'Gossip', 'Courtier',
    'Professor', 'Minstrel', 'Tea Lady', 'Pacifist', 'Fool', 'Tinker', 'Moonchild', 'Goon', 'Lunatic',
    'Godfather', "Devil's Advocate", 'Assassin', 'Mastermind', 'Zombuul', 'Pukka', 'Shabaloth', 'Po',
    // Sects & Violets
    'Clockmaker', 'Dreamer', 'Snake Charmer', 'Mathematician', 'Flowergirl', 'Town Crier', 'Oracle',
    'Savant', 'Seamstress', 'Philosopher', 'Artist', 'Juggler', 'Sage', 'Mutant', 'Sweetheart', 'Barber',
    'Klutz', 'Evil Twin', 'Witch', 'Cerenovus', 'Pit-Hag', 'Fang Gu', 'Vigormortis', 'No Dashii', 'Vortox',
    // Experimental
    'Noble', 'Bounty Hunter', 'Pixie', 'General', 'Preacher', 'King', 'Balloonist', 'Cult Leader',
    'Lycanthrope', 'Amnesiac', 'Nightwatchman', 'Engineer', 'Fisherman', 'Huntsman', 'Alchemist',
    'Farmer', 'Magician', 'Choirboy', 'Poppy Grower', 'Banshee', 'Alsaahir', 'Atheist', 'Cannibal',
    'Snitch', 'Acrobat', 'Steward', 'Knight', 'Shugenja', 'Village Idiot', 'High Priestess',
    'Damsel', 'Golem', 'Politician', 'Puzzlemaster', 'Plague Doctor', 'Heretic', 'Ogre', 'Zealot',
    'Hatter', 'Boomdandy', 'Fearmonger', 'Psychopath', 'Goblin', 'Mezepheles', 'Marionette',
    'Boffin', 'Xaan', 'Organ Grinder', 'Widow', 'Wizard', 'Summoner', 'Harpy', 'Vizier', "Lil' Monsta",
    'Al-Hadikhia', 'Lleech', 'Legion', 'Leviathan', 'Riot', 'Yaggababble', 'Kazali', 'Lord of Typhon',
    'Ojo', 'Pope', 'Deviant', 'Doomsayer', 'Wraith', "Hell's Librarian", 'Bureaucrat', 'Thief',
    // Travellers
    'Scapegoat', 'Gunslinger', 'Beggar', 'Apprentice', 'Matron', 'Judge', 'Bishop', 'Voudon',
    'Barista', 'Harlot', 'Butcher', 'Bone Collector', 'Gangster', 'Gnome', 'Cacklejack',
    // Fabled
    'Angel', 'Buddhist', 'Revolutionary', 'Fiddler', 'Toymaker',
    'Fibbin', 'Duchess', 'Sentinel', 'Spirit of Ivory', 'Djinn', 'Storm Catcher', 'Bootlegger',
    'Deus ex Fiasco', 'Ferryman', 'Gardener',
    // Loric
    'Big Wig', 'God of Ug', 'Knaves', 'Tor', 'Zenomancer', 'Hindu', 'Ug'
  ];

  /* Canonical opening clauses (Ability Writing Guide §2.1). Anything else
     opens with a soft warning, never a fix. */
  var TIMING_PREFIXES = [
    /^You start knowing\b/, /^You do not know\b/, /^You think\b/, /^You have\b/, /^You are\b/,
    /^You may\b/, /^You get\b/, /^You must\b/, /^You win\b/, /^You & \b/,
    /^On your 1st (night|day)\b/, /^Each night\*/, /^Each night\b/, /^Each day\b/,
    /^Each dusk\b/, /^At dusk\b/, /^Each (nominee|Minion|player)\b/,
    /^Once per game\b/, /^Once per day\b/, /^The 1st time\b/, /^On the \d/,
    /^If\b/, /^When\b/, /^While\b/, /^All (players|Minions|evil|good)\b/,
    /^Only\b/, /^Minions\b/, /^There (is|are)\b/, /^This script\b/, /^Something\b/,
    /^The (Demon|Storyteller|1st|final)\b/, /^Evil players\b/, /^Good players\b/,
    /^For the first\b/, /^One or more\b/, /^Use\b/, /^Whoever\b/
  ];

  /* ══ 2. Token-level word rules ════════════════════════════════════

     `from` is matched against the whole text; `to(match, capture)` returns the
     replacement, '' to delete, or null when there is nothing to suggest and
     the rule is purely advisory. `label` is what the rules panel shows. */

  var WORD_RULES = [
    /* ── clean autofixes: zero hits in the official corpus ── */
    { id: 'pick', sev: 'fix', cat: 'Terminology', label: 'pick / select → choose',
      from: /\b(pick|picks|picked|picking|select|selects|selected|selecting)\b/gi,
      to: function (m) {
        return { pick: 'choose', picks: 'chooses', picked: 'chose', picking: 'choosing',
                 select: 'choose', selects: 'chooses', selected: 'chose', selecting: 'choosing' }[m.toLowerCase()];
      },
      note: '"choose" is the only official selection verb' },

    { id: 'person', sev: 'fix', cat: 'Terminology', label: 'person / people → player',
      from: /\b(person|persons|people)\b/gi,
      to: function (m) { return m.toLowerCase() === 'person' ? 'player' : 'players'; },
      note: 'cards say player(s), never person or people' },

    { id: 'role', sev: 'fix', cat: 'Terminology', label: 'role → character',
      from: /\brole(s)?\b/gi,
      to: function (m, s) { return s ? 'characters' : 'character'; },
      note: 'the game calls them characters, not roles' },

    { id: 'traveler', sev: 'fix', cat: 'Spelling', label: 'traveler → Traveller',
      from: /\btraveler(s)?\b/gi,
      to: function (m, s) { return s ? 'Travellers' : 'Traveller'; },
      note: 'UK spelling on this word only' },

    { id: 'neighbour', sev: 'fix', cat: 'Spelling', label: 'neighbour → neighbor',
      from: /\bneighbour(s|ing)?\b/gi,
      to: function (m, s) { return 'neighbor' + (s || ''); },
      note: 'US spelling on this word only' },

    { id: 'anticlock', sev: 'fix', cat: 'Terminology', label: 'counterclockwise → anti-clockwise',
      from: /\b(counterclockwise|counter-clockwise|anticlockwise)\b/gi,
      to: function () { return 'anti-clockwise'; },
      note: 'Shugenja phrasing' },

    { id: 'learnwhether', sev: 'fix', cat: 'Terminology', label: 'learn whether → learn if',
      from: /\blearn whether\b/gi, to: function () { return 'learn if'; },
      note: 'Flowergirl precedent' },

    { id: 'betold', sev: 'fix', cat: 'Terminology', label: 'are told / find out → learn',
      from: /\b(are told|is told|be told|find out|finds out)\b/gi,
      to: function () { return 'learn'; },
      note: '"learn" is the information verb' },

    { id: 'beginlearn', sev: 'fix', cat: 'Terminology', label: 'begin by learning → start knowing',
      from: /\bbegin by learning\b/gi, to: function () { return 'start knowing'; },
      note: 'Washerwoman precedent' },

    { id: 'voteout', sev: 'fix', cat: 'Terminology', label: 'voted out / hanged → executed',
      from: /\b(voted out|vote out|hanged|hang|lynched|lynch)\b/gi,
      to: function () { return 'executed'; },
      note: 'exile is not execution; neither is "hang"' },

    { id: 'diffrom', sev: 'fix', cat: 'Terminology', label: 'different from → different to',
      from: /\bdifferent from\b/gi, to: function () { return 'different to'; },
      note: "Devil's Advocate precedent" },

    { id: 'fromthenon', sev: 'fix', cat: 'Terminology', label: 'from then on → from now on',
      from: /\bfrom then on\b/gi, to: function () { return 'from now on'; },
      note: 'Sweetheart precedent' },

    { id: 'duskorder', sev: 'fix', cat: 'Terminology', label: 'until tomorrow dusk → until dusk tomorrow',
      from: /\buntil tomorrow dusk\b/gi, to: function () { return 'until dusk tomorrow'; },
      note: 'Minstrel is canonical' },

    { id: 'yesorno', sev: 'fix', cat: 'Terminology', label: 'yes-or-no → yes/no',
      from: /\byes[- ]or[- ]no\b/gi, to: function () { return 'yes/no'; },
      note: 'Artist precedent' },

    { id: 'ifright', sev: 'fix', cat: 'Terminology', label: 'if right → if correct',
      from: /\bif right\b/gi, to: function () { return 'if correct'; },
      note: 'Gambler "guess wrong" precedent' },

    { id: 'lastday', sev: 'fix', cat: 'Terminology', label: 'the last day → the final day',
      from: /\b(the last day|Judgment Day|Judgement Day)\b/gi,
      to: function () { return 'the final day'; },
      note: 'the corpus is unanimous on "the final day"' },

    { id: 'feign', sev: 'fix', cat: 'Terminology', label: 'feign death → live but register as dead',
      from: /\bfeign(s|ed|ing)? death\b/gi,
      to: function () { return 'live but register as dead'; },
      note: 'Zombuul is the only fake-death wording' },

    { id: 'handin', sev: 'fix', cat: 'Terminology', label: 'hand in → give up',
      from: /\bhand(s|ed)? in\b/gi, to: function () { return 'give up'; },
      note: 'coined ritual term' },

    { id: 'interrogate', sev: 'fix', cat: 'Terminology', label: 'interrogate → ask their character',
      from: /\binterrogate(s|d)?\b/gi, to: function () { return 'ask their character'; },
      note: 'coined mechanic term' },

    { id: 'enthrone', sev: 'fix', cat: 'Terminology', label: 'enthrone → publicly name',
      from: /\benthrone(s|d)?\b/gi, to: function () { return 'publicly name'; },
      note: 'coined mechanic term' },

    { id: 'noone', sev: 'fix', cat: 'Spelling', label: 'no one → no-one',
      from: /\bno one\b/gi, to: function () { return 'no-one'; },
      note: 'Vortox precedent' },

    { id: 'notyou', sev: 'fix', cat: 'Terminology', label: '(not you) → (not yourself)',
      from: /\(not you\)/gi, to: function () { return '(not yourself)'; },
      note: 'Butler / Exorcist precedent' },

    { id: 'thirdperson', sev: 'fix', cat: 'Structure', label: 'the cardholder → you',
      from: /\b(the cardholder|the holder|the player with this ability)\b/gi,
      to: function () { return 'you'; },
      note: 'card text is always second person' },

    { id: 'designer', sev: 'fix', cat: 'Terminology', label: 'definitely / permanently / (stackable)',
      from: /\s*\b(definitely|permanently|\(stackable\))\b/gi, to: function () { return ''; },
      note: 'designer-speak; certainty is implied by the absence of "might"' },

    { id: 'droisoned', sev: 'fix', cat: 'Terminology', label: 'droisoned → drunk or poisoned',
      from: /\bdroisoned\b/gi, to: function () { return 'drunk or poisoned'; },
      note: 'community shorthand, never card text' },

    { id: 'insane', sev: 'fix', cat: 'Terminology', label: 'insane / crazy → mad',
      from: /\b(insane|crazy)\b/gi, to: function () { return 'mad'; },
      note: 'madness has a fixed template' },

    { id: 'stleak', sev: 'fix', cat: 'Structure', label: 'the Storyteller tells you → you learn',
      from: /\bthe Storyteller tells you\b/gi, to: function () { return 'you learn'; },
      note: 'Storyteller-voice leakage' },

    { id: 'onceever', sev: 'fix', cat: 'Structure', label: 'once ever → Once per game',
      from: /\b(once ever|1 time per game|one time per game)\b/gi,
      to: function () { return 'Once per game'; },
      note: 'canonical form' },

    { id: 'power', sev: 'fix', cat: 'Terminology', label: 'power → ability',
      from: /\bpower(s)?\b/gi,
      to: function (m, s) { return s ? 'abilities' : 'ability'; },
      note: 'cards say ability, never power' },

    { id: 'revive', sev: 'warn', cat: 'Terminology', label: 'revive / resurrect → rise',
      from: /\b(revive|revived|revival|resurrect|resurrects)\b/gi,
      to: function () { return 'rise'; },
      note: '"rise" is corpus standard, but the Professor says "resurrected"' },

    /* ── numbers: split by sense ── */
    { id: 'cardinal', sev: 'fix', cat: 'Numbering', label: 'two, three, four… → 2, 3, 4…',
      from: /\b(two|three|four|five|six|seven|eight|nine|ten)\b/gi,
      to: function (m) {
        return { two: '2', three: '3', four: '4', five: '5', six: '6',
                 seven: '7', eight: '8', nine: '9', ten: '10' }[m.toLowerCase()];
      },
      note: 'numerals only' },

    { id: 'one', sev: 'warn', cat: 'Numbering', label: 'one → 1',
      from: /\bone\b/gi, to: function () { return '1'; },
      note: '"one" is correct for an unspecified single member (Lycanthrope, Harpy, Knaves); "1" is for counts' },

    { id: 'ordinal', sev: 'warn', cat: 'Numbering', label: 'first, second… → 1st, 2nd…',
      from: /\b(first|second|third|fourth|fifth)\b/gi,
      to: function (m) {
        return { first: '1st', second: '2nd', third: '3rd', fourth: '4th', fifth: '5th' }[m.toLowerCase()];
      },
      note: '1st for an ordinal of occurrence; "first" is correct before a plural count (Buddhist, Hindu)' },

    /* ── team vs alignment (Guide §6.4) ── */
    { id: 'teamside', sev: 'fix', cat: 'Terminology', label: 'their team → their alignment',
      from: /\b(the same team|the opposing team|on the same team|their team|your team)\b(?!\s+(wins?|loses?|win|lose|winning|losing))/gi,
      to: function (m) { return m.replace(/team/i, 'alignment'); },
      note: 'a player’s side is their "alignment"; "your team" is reserved for winning and losing' },

    { id: 'faction', sev: 'fix', cat: 'Terminology', label: 'faction / side → alignment',
      from: /\b(faction|side)\b/gi, to: function () { return 'alignment'; },
      note: 'cards say alignment' },

    /* ── warnings: the official corpus contains counterexamples ── */
    { id: 'living', sev: 'warn', cat: 'Terminology', label: 'living → alive',
      from: /\bliving\b/gi, to: function () { return 'alive'; },
      note: 'prefer "alive"; official keeps "living" in fixed phrases (King, Huntsman, Harlot)' },

    { id: 'every', sev: 'warn', cat: 'Terminology', label: 'every → each',
      from: /\bevery\b/gi, to: function () { return 'each'; },
      note: '"every nomination" is official (Zealot); only "every night" is wrong' },

    { id: 'contraction', sev: 'warn', cat: 'Contraction', label: "can't, don't, you're…",
      from: /\b(can't|don't|doesn't|won't|isn't|aren't|you're|they're|it's|you'd|they'd|you'll|you've|cannot)\b/gi,
      to: function () { return null; },
      note: 'the corpus is split — 13 cards contract, Vizier and Deviant expand. Pick one style per set; never autofixed' },

    { id: 'ampersand', sev: 'warn', cat: 'Typography', label: 'and → &',
      from: /\band\b/gi, to: function () { return '&'; },
      note: '35 official cards use &, 8 use "and", none mix. Suggestion only — "sober and healthy" and "1 and only 1" are official' },

    { id: 'bluffs', sev: 'warn', cat: 'Terminology', label: 'bluffs → not-in-play characters',
      from: /\bbluffs\b/gi, to: function () { return 'not-in-play characters'; },
      note: 'official on Snitch/Summoner/Pope; prefer the long form where space allows' },

    { id: 'another', sev: 'warn', cat: 'Semantics', label: '"another player" is a different player',
      from: /\banother player\b/gi, to: function () { return null; },
      note: '"another player" means a DIFFERENT player. If re-choosing the same target is legal, write "& choose again"' },

    { id: 'wouldkill', sev: 'warn', cat: 'Semantics', label: 'kills vs would kill',
      from: /\bif the Demon kills\b/gi, to: function () { return null; },
      note: '"kills" is a successful kill; "would kill" is the attempt. Confirm which you mean' },

    { id: 'evenifdead', sev: 'warn', cat: 'Semantics', label: '"even if dead" — whose death?',
      from: /\beven if dead\b/gi, to: function () { return null; },
      note: '"even if dead" refers to the subject; "even if you are dead" refers to the cardholder' },

    { id: 'maymight', sev: 'off', cat: 'May/Might', label: 'may vs might',
      from: /\b(may|might)\b/gi, to: function () { return null; },
      note: 'may = a player decides; might = the Storyteller or chance decides' }
  ];

  /* ══ 3. Structural & typographic checks ═══════════════════════════ */

  var FORBIDDEN_SYMBOLS = [
    ['>', 'greater-than'], ['<', 'less-than'], ['$', 'dollar'],
    ['#', 'hash'], ['@', 'at'], ['!', 'exclamation'], ['_', 'underscore'],
    ['×', 'multiplication sign'], ['÷', 'division sign'], ['=', 'equals'], [';', 'semicolon']
  ];

  /* Split into sentences without a lookbehind. `(?<=\.)\s+` is not safe on
     older iOS Safari, and for every check here only the pieces matter, not
     the trailing full stops. */
  function sentences(t) {
    return String(t).split(/\.\s+/);
  }

  var STRUCTURAL = [
    { id: 'semicolon', sev: 'fix', cat: 'Typography', label: 'semicolons',
      test: function (t) { return t.indexOf(';') !== -1; },
      note: 'no official ability uses a semicolon — split into sentences or join with &' },

    { id: 'symbols', sev: 'warn', cat: 'Typography', label: 'symbols not used on cards',
      note: 'official card text uses no < > $ # @ ! _ = ; × ÷',
      scan: function (t, opts) {
        // The semicolon rule already says its piece when it is switched on;
        // repeating it here would show the same character twice.
        var quiet = opts && opts.semicolonOn;
        return FORBIDDEN_SYMBOLS.filter(function (p) {
          return t.indexOf(p[0]) !== -1 && !(quiet && p[0] === ';');
        }).map(function (p) {
          return '"' + p[0] + '" (' + p[1] + ') does not appear in official card text';
        });
      } },

    { id: 'killasterisk', sev: 'fix', cat: 'Structure', label: 'night kill needs the asterisk',
      test: function (t) { return /Each night,[^.]*choose[^.:]*:\s*(they|you) die\b/.test(t); },
      note: 'a direct night kill must be "Each night*" — no kill ability works on the first night' },

    { id: 'nestedcolon', sev: 'fix', cat: 'Structure', label: 'two colons in one sentence',
      test: function (t) {
        return sentences(t).some(function (s) { return (s.match(/:/g) || []).length > 1; });
      },
      note: 'two colons in one sentence is unparsable — restructure into separate sentences' },

    { id: 'colonchoice', sev: 'fix', cat: 'Structure', label: 'choice clause takes a colon',
      note: '"choose a player: they die", never "choose a player, they die"',
      scan: function (t) {
        var m = t.match(/\bchoose[^:.]{0,45}?,\s*(they|you|it)\b/gi);
        return m ? m.map(function (x) {
          return '"' + x.trim() + '" — a choice clause takes a colon, not a comma';
        }) : [];
      } },

    { id: 'timingcomma', sev: 'fix', cat: 'Structure', label: 'comma after the timing prefix',
      test: function (t) { return /^(Each night\*?|Each day|Once per game)\s+[a-z]/.test(t); },
      note: 'the timing prefix needs a comma after it' },

    { id: 'setupbrackets', sev: 'fix', cat: 'Structure', label: 'setup changes go in brackets',
      test: function (t) {
        return /\(\s*[+−-]\s*\d+\s*(Outsider|Minion|Demon|Townsfolk)/i.test(t) ||
               /(^|\.\s)[^[\]]*\b[+−-]\s?\d\s?(Outsider|Minion)s?\b(?![^[]*\])/i.test(t);
      },
      note: 'setup modifications go in [square brackets] at the end' },

    { id: 'bracketposition', sev: 'fix', cat: 'Structure', label: 'brackets belong last',
      test: function (t) { return /\][^\]]*[a-zA-Z]{3}/.test(t) && !/\]\s*$/.test(t.trim()); },
      note: 'setup brackets belong at the very end of the text' },

    { id: 'timingprefix', sev: 'warn', cat: 'Structure', label: 'canonical opening clause',
      test: function (t) {
        return !TIMING_PREFIXES.some(function (p) { return p.test(t); });
      },
      note: 'does not open with a canonical timing or passive clause (Guide §2.1)' },

    { id: 'ampmix', sev: 'warn', cat: 'Typography', label: 'mixing & and "and"',
      test: function (t) { return t.indexOf('&') !== -1 && /\band\b/i.test(t); },
      note: 'no official card mixes "&" and "and" — pick one' },

    { id: 'flavour', sev: 'warn', cat: 'Style', label: 'flavour words',
      note: 'atmosphere words belong in the almanac quote, not on the card',
      scan: function (t) {
        var m = t.match(/\b(mysterious|shadowy|ancient|terrible|dark|cursed|wicked|sinister|eerie)\b/gi);
        return m ? m.map(function (x) {
          return '"' + x + '" — flavour belongs in the almanac quote, not on the card';
        }) : [];
      } },

    /* Off by default: normalise() silently straightens all of these in the
       suggested output, and the official corpus is itself inconsistent
       (the Sailor uses a straight apostrophe, the Lycanthrope a curly one). */
    { id: 'encoding', sev: 'off', cat: 'Typography', label: 'curly quotes, dashes, ellipses',
      scan: function (t) {
        var out = [];
        if (/[‘’]/.test(t)) out.push('curly apostrophe — normalised to a straight one');
        if (/[“”]/.test(t)) out.push('curly quotes — normalised to straight ones');
        if (/[–—]/.test(t)) out.push('en/em dash — official text uses neither');
        if (/…/.test(t)) out.push('ellipsis glyph — spell it out or cut it');
        if (/ /.test(t)) out.push('non-breaking space');
        return out;
      } }
  ];

  /* Design lint — the Field Guide's Four Physical Laws. Warnings only: these
     are judgement calls about what an ability does, not how it is written. */
  var DESIGN_LINT = [
    { id: 'design-selfconfirm', rx: /learn that you are|\bprove\b|\bconfirm\b/i,
      note: 'possible self-confirmation — a Townsfolk must look identical to the Drunk' },
    { id: 'design-memory', rx: /\bforget\b|thinks they already know/i,
      note: 'memory editing — corrupt at the source instead (droison, madness)' },
    { id: 'design-hidden', rx: /without them knowing/i,
      note: 'hiding an event from its subject — a player always experiences what happens to them' },
    { id: 'design-speech', rx: /must say|cannot say|can’t say|can't say|may not speak/i,
      note: 'speech control — only madness can enforce silence' },
    { id: 'design-publicinfo', rx: /vote tally is secret|votes are hidden/i,
      note: 'public-info tampering — legal but rare (the Organ Grinder is the sanctioned exception)' }
  ];

  /* ══ 4. Casing (case-sensitive, multi-word aware) ═════════════════ */

  function escRx(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  /* Apostrophes compare equal whichever way they curl. */
  function flatApos(s) { return String(s).replace(/’/g, "'"); }
  /* A name regex that accepts either apostrophe in the input. */
  function nameRx(name, flags) {
    return new RegExp('\\b' + escRx(name).replace(/'/g, "['’]") + '\\b', flags);
  }

  var TERM_RX = new RegExp('\\b(' + CAPS_TERMINOLOGY.join('|') + ')(s|’s|\'s)?\\b', 'gi');

  function casingIssues(text, customNames) {
    var issues = [];
    customNames = customNames || [];

    // Team terms are proper nouns — force the capital.
    text.replace(TERM_RX, function (m, w, suf, off) {
      var want = w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() + (suf || '');
      if (m !== want) {
        issues.push({ sev: 'fix', cat: 'Casing', rule: 'casing-term', prio: 1,
                      found: m, suggest: want, note: want.replace(/[’']s$/, '') + ' is a proper noun',
                      start: off, end: off + m.length });
      }
      return m;
    });

    // Official names are matched case-INSENSITIVELY but only flagged when the
    // casing is genuinely wrong, so "drunk" the state is never confused with
    // the Drunk the Outsider. Names the user registered are strict: they are
    // homebrew, so any lowercase spelling of them is a mistake.
    var custom = {}, known = {};
    customNames.forEach(function (n) { if (n) { custom[n] = 1; known[n] = 1; } });
    OFFICIAL_NAMES.forEach(function (n) { known[n] = 1; });

    Object.keys(known).forEach(function (name) {
      var rx = nameRx(name, 'gi'), m;
      while ((m = rx.exec(text)) !== null) {
        var hit = m[0];
        if (flatApos(hit) === flatApos(name)) continue;         // already correct
        if (!custom[name] && flatApos(hit).toLowerCase() === flatApos(hit)) continue; // ordinary word
        issues.push({ sev: 'fix', cat: 'Casing', rule: 'casing-name', prio: 1,
                      found: hit, suggest: name, note: 'official character name casing',
                      start: m.index, end: m.index + hit.length });
        if (rx.lastIndex === m.index) rx.lastIndex++;
      }
    });

    // Sentence starts: . ! [ only. '(' is NOT a boundary — official
    // parentheticals are lowercase ("(not yourself)", "Minion(s)").
    sentenceStarts(text).forEach(function (s) {
      if (s >= text.length || !/[a-z]/.test(text.charAt(s))) return;
      var w = (text.slice(s).match(/^\w+/) || [''])[0];
      if (!w) return;
      issues.push({ sev: 'fix', cat: 'Casing', rule: 'casing-sentence', prio: 2,
                    found: w, suggest: w.charAt(0).toUpperCase() + w.slice(1),
                    note: 'a sentence should start capitalised',
                    start: s, end: s + w.length });
    });

    return issues;
  }

  /* Index of the first non-space character of every sentence. */
  function sentenceStarts(text) {
    var raw = [0], i, out = [], seen = {};
    for (i = 0; i < text.length; i++) if ('.!['.indexOf(text.charAt(i)) !== -1) raw.push(i + 1);
    raw.forEach(function (s) {
      while (s < text.length && /\s/.test(text.charAt(s))) s++;
      if (!seen[s]) { seen[s] = 1; out.push(s); }
    });
    return out;
  }

  /* ══ 5. Length ════════════════════════════════════════════════════ */

  function lengthBadge(text) {
    var n = String(text).length;
    if (n > 250) return { level: 'error', n: n, note: 'over 250 — the official app’s hard limit' };
    if (n > 140) return { level: 'error', n: n, note: 'over 140 — hard cap' };
    if (n > 138) return { level: 'warn', n: n, note: 'over 138 — this is a design problem; simplify rather than compress' };
    if (n > 127) return { level: 'warn', n: n, note: 'over 127 — the longest official ability is exactly 127' };
    return { level: 'ok', n: n, note: '' };
  }

  /* ══ 6. Main ══════════════════════════════════════════════════════ */

  var ALL_RULES = WORD_RULES.map(function (r) {
    return { id: r.id, sev: r.sev, cat: r.cat, label: r.label, note: r.note };
  }).concat(STRUCTURAL.map(function (r) {
    return { id: r.id, sev: r.sev, cat: r.cat, label: r.label, note: r.note || '' };
  })).concat([
    { id: 'casing-term', sev: 'fix', cat: 'Casing', label: 'Demon, Minion, Storyteller…', note: 'team and rules words are proper nouns' },
    { id: 'casing-name', sev: 'fix', cat: 'Casing', label: 'character name casing', note: 'official (and your own) character names keep their capitals' },
    { id: 'casing-sentence', sev: 'fix', cat: 'Casing', label: 'sentence capitalisation', note: 'every sentence starts with a capital' },
    { id: 'design', sev: 'warn', cat: 'Design', label: 'the Four Physical Laws', note: 'flags abilities that fight the game’s design rules' }
  ]);

  var CATEGORIES = ['Terminology', 'Spelling', 'Casing', 'Numbering', 'Structure',
                    'Typography', 'Contraction', 'Semantics', 'Style', 'Design', 'May/Might'];

  function defaultEnabled() {
    var out = {};
    ALL_RULES.forEach(function (r) { out[r.id] = r.sev !== 'off'; });
    return out;
  }

  function isOn(enabled, rule) {
    if (enabled && Object.prototype.hasOwnProperty.call(enabled, rule.id)) return !!enabled[rule.id];
    return rule.sev !== 'off';
  }

  /* Overlapping findings can't both be highlighted, and applying both would
     corrupt the text. Keep the earliest, then the most specific: a word rule
     beats a casing rule at the same spot, and a whole-name fix beats a
     single-letter one. */
  function dedupe(issues) {
    var sorted = issues.slice().sort(function (a, b) {
      if (a.start !== b.start) return a.start - b.start;
      if ((a.prio || 0) !== (b.prio || 0)) return (a.prio || 0) - (b.prio || 0);
      return (b.end - b.start) - (a.end - a.start);
    });
    var out = [], reach = -1;
    sorted.forEach(function (i) {
      if (i.start < reach) return;
      out.push(i);
      reach = i.end;
    });
    return out;
  }

  /* lint(text, { enabled, customNames }) -> { issues, notices, length }

     issues  span-anchored, each { id, rule, sev, cat, found, suggest, note,
             start, end }. `suggest` is null when the rule only flags.
     notices whole-text, each { id, rule, sev, cat, note }. */
  function lint(text, opts) {
    text = String(text == null ? '' : text);
    opts = opts || {};
    var enabled = opts.enabled || {};
    var issues = [], notices = [];

    WORD_RULES.forEach(function (r) {
      if (!isOn(enabled, r)) return;
      var rx = new RegExp(r.from.source, r.from.flags), m;
      while ((m = rx.exec(text)) !== null) {
        var sug = r.to ? r.to(m[0], m[1]) : null;
        if (sug !== null && sug !== undefined && String(sug).toLowerCase() === m[0].toLowerCase()) {
          if (rx.lastIndex === m.index) rx.lastIndex++;
          continue;
        }
        issues.push({ sev: r.sev, cat: r.cat, rule: r.id, prio: 0,
                      found: m[0], suggest: (sug === undefined ? null : sug), note: r.note,
                      start: m.index, end: m.index + m[0].length });
        if (rx.lastIndex === m.index) rx.lastIndex++;
      }
    });

    var semicolonOn = isOn(enabled, { id: 'semicolon', sev: 'fix' });
    STRUCTURAL.forEach(function (c) {
      if (!isOn(enabled, c)) return;
      if (c.test && c.test(text)) {
        notices.push({ sev: c.sev, cat: c.cat, rule: c.id, note: c.note });
      }
      if (c.scan) {
        c.scan(text, { semicolonOn: semicolonOn }).forEach(function (n) {
          notices.push({ sev: c.sev, cat: c.cat, rule: c.id, note: n });
        });
      }
    });

    if (isOn(enabled, { id: 'design', sev: 'warn' })) {
      DESIGN_LINT.forEach(function (d) {
        if (d.rx.test(text)) notices.push({ sev: 'warn', cat: 'Design', rule: 'design', note: d.note });
      });
    }

    casingIssues(text, opts.customNames).forEach(function (i) {
      if (isOn(enabled, { id: i.rule, sev: 'fix' })) issues.push(i);
    });

    issues = dedupe(issues);

    /* A replacement that lands at the start of a sentence keeps the capital:
       "Pick a player" must become "Choose a player", not "choose a player".
       The rules themselves are written lowercase, so this is applied here
       rather than in forty separate `to` functions. */
    var starts = {};
    sentenceStarts(text).forEach(function (s) { starts[s] = 1; });
    issues.forEach(function (i) {
      if (starts[i.start] && i.suggest && /^[a-z]/.test(i.suggest)) {
        i.suggest = i.suggest.charAt(0).toUpperCase() + i.suggest.slice(1);
      }
      i.id = i.rule + '@' + i.start + '-' + i.end;
      // Stable across edits, so dismissing "and → &" once dismisses it while
      // you keep typing instead of resurfacing on the next keystroke.
      i.key = i.rule + '|' + i.found + '|' + (i.suggest === null ? '' : i.suggest);
    });
    notices.forEach(function (n) { n.id = n.rule + '|' + n.note; n.key = n.id; });

    return { issues: issues, notices: notices, length: lengthBadge(text) };
  }

  /* Rewrite the text with the given issues applied (right to left, so earlier
     positions stay valid). */
  function applyFixes(text, issues) {
    var sorted = issues.slice().sort(function (a, b) { return b.start - a.start; });
    sorted.forEach(function (i) {
      if (i.suggest === null || i.suggest === undefined) return;
      text = text.slice(0, i.start) + i.suggest + text.slice(i.end);
    });
    return text;
  }

  /* Silent tidy-up, applied to the suggested output only. */
  function normalise(text) {
    var t = String(text == null ? '' : text)
      .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
      .replace(/ /g, ' ').replace(/\s+/g, ' ').trim()
      .replace(/\.\s*\]/g, ']').replace(/\]\s*\./g, ']')
      .replace(/\s+([,.:])/g, '$1').replace(/,(?=\S)/g, ', ')
      // Deleting a word ("definitely", "permanently") can strand a second
      // full stop next to the first one.
      .replace(/\.(\s*\.)+/g, '.');
    if (!t) return '';
    // Terminal full stop, bracket-aware: the setup clause takes no full stop,
    // but the sentence in front of it must have one.
    var b = t.lastIndexOf('[');
    if (b > 0 && /\]$/.test(t)) {
      var head = t.slice(0, b).trim();
      t = (/[.!]$/.test(head) ? head : head + '.') + ' ' + t.slice(b);
    } else if (!/[.\]]$/.test(t)) {
      t += '.';
    }
    return t;
  }

  var API = {
    lint: lint,
    normalise: normalise,
    applyFixes: applyFixes,
    lengthBadge: lengthBadge,
    sentenceStarts: sentenceStarts,
    RULES: ALL_RULES,
    CATEGORIES: CATEGORIES,
    defaultEnabled: defaultEnabled,
    WORD_RULES: WORD_RULES,
    STRUCTURAL: STRUCTURAL,
    DESIGN_LINT: DESIGN_LINT,
    OFFICIAL_NAMES: OFFICIAL_NAMES,
    CAPS_TERMINOLOGY: CAPS_TERMINOLOGY
  };

  if (typeof window !== 'undefined') window.Grimforge = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
