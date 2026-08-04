/* One-time text cleanup for the Odyssey almanacs (Taiyi's 119 characters).
 *
 * Two artefacts of the English translation, on Odyssey pages only:
 *   1. em dashes used as a catch-all connector -> commas (or dropped)
 *   2. gendered pronouns in the prose -> they/them/their
 * plus normalising the inconsistent "If you are the …" tips opener.
 *
 * `ability` is never touched. The flavour `quote` gets em-dash treatment only:
 * its pronouns are in-character voice and several point at other named figures.
 *
 * Every rule below was derived from a scan of the actual text rather than
 * guessed, and anything the tables do not cover is FLAGGED instead of changed —
 * see flagsFor(). Lives in migration/ (see .assetsignore) so it is never served;
 * worker.js imports it for POST /api/admin/cleanup-odyssey, and it is plain
 * CommonJS so the same code can be dry-run locally against /characters.json.
 *
 * Delete this file, the route and the dashboard card once the cleanup has run.
 */
(function () {
  'use strict';

  // Fields carrying almanac prose. `ability`, `name`, `tags`, `creator`,
  // `iconBy`, `appearsIn`, night-order numbers and `reminders[]` are never touched.
  var TEXT_FIELDS = ['lede', 'callout', 'firstNightReminder', 'otherNightReminder'];
  var LIST_FIELDS = ['summaryBullets', 'howToRun', 'examples', 'tips', 'bluffing', 'fighting'];

  /* ── em dashes ───────────────────────────────────────────────────────────
     1141 spaced " — ", 70 tight "x—y", a handful of one-sided ones. A comma is
     the default; where one would stack on punctuation that is already there,
     the dash is simply dropped. The en dash "–" (numeric ranges) is left alone. */
  function fixDashes(s) {
    return String(s == null ? '' : s)
      // dash hard against punctuation that already closes the clause
      .replace(/([,;:!?(])\s*—\s*/g, '$1 ')
      // dash immediately before punctuation, or at the very end
      .replace(/\s*—\s*([),.;:!?])/g, '$1')
      .replace(/\s*—\s*$/g, '')
      // the ordinary cases: spaced, tight and one-sided all become a comma
      .replace(/\s*—\s*/g, ', ')
      // tidy anything the above stacked up
      .replace(/,\s*,/g, ',')
      .replace(/\s+,/g, ',')
      .replace(/,\s*([.!?;:])/g, '$1')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/^\s*,\s*/, '');
  }

  /* ── pronouns ──────────────────────────────────────────────────────────── */

  // Adverbs that can sit between the pronoun and its verb ("he still has").
  var ADVERBS = ['still', 'only', 'also', 'never', 'always', 'just', 'already',
    'then', 'now', 'immediately', 'actually', 'definitely', 'really', 'certainly',
    'probably', 'likely', 'simply', 'usually', 'generally', 'permanently',
    'directly', 'easily', 'previously', 'even', 'instead'];

  // 3rd-person singular -> base form. Every verb that actually follows he/she
  // anywhere in the corpus is listed, so an unlisted one means new text.
  var VERBS = {
    is: 'are', has: 'have', does: 'do', was: 'were',
    "doesn't": "don't", "isn't": "aren't", "wasn't": "weren't", "hasn't": "haven't",
    learns: 'learn', chooses: 'choose', dies: 'die', loses: 'lose', gets: 'get',
    acts: 'act', points: 'point', wants: 'want', thinks: 'think', becomes: 'become',
    uses: 'use', lives: 'live', nods: 'nod', shakes: 'shake', gives: 'give',
    stays: 'stay', sits: 'sit', keeps: 'keep', wishes: 'wish', kills: 'kill',
    knows: 'know', experiences: 'experience', offers: 'offer', needs: 'need',
    finishes: 'finish', reads: 'read', lets: 'let', hates: 'hate', likes: 'like',
    votes: 'vote', rises: 'rise', leaves: 'leave', deserves: 'deserve',
    differs: 'differ', declares: 'declare', attacks: 'attack', touches: 'touch',
    survives: 'survive', combines: 'combine', judges: 'judge', ends: 'end',
    triggers: 'trigger', functions: 'function', counts: 'count',
    registers: 'register', appears: 'appear', starts: 'start', performs: 'perform',
    seeks: 'seek', hits: 'hit', decides: 'decide'
  };
  // Modals and past-tense forms that are already correct for "they".
  var KEEP_VERB = ['can', 'may', 'cannot', "can't", 'must', 'might', 'should',
    'will', "won't", 'would', 'could', 'chose', 'died', 'used', 'learned',
    'caused', 'killed', 'nominated', 'received', 'sowed', 'guessed', 'read',
    'were', 'saved', 'checked', 'delayed', 'survived', 'no', 'neither'];

  // "her" is the only genuinely ambiguous pronoun. A following noun from this
  // list always means the possessive ("their"); it beats the verb list below,
  // which is what keeps "do not wake her chosen player" possessive.
  var HER_POSSESSIVE_NEXT = ['ability', 'own', 'head', 'bow', 'information',
    'distance', 'chosen', 'character', 'place', 'night', 'death', 'neighbors',
    'eyes', 'action', 'advantages', 'role', 'trigger', 'acceptance', 'protection',
    'true', 'last', 'once', 'wished', '"'];
  // Verbs and prepositions that take a person as their object, so anything not
  // in the list above is the object pronoun ("them").
  var HER_OBJECT_PREV = ['have', 'let', 'wake', 'tell', 'put', 'putting', 'kill',
    'attack', 'attacks', 'attacking', 'attacked', 'mark', 'deceive', 'deceiving',
    'give', 'show', 'poison', 'executing', 'killed', 'differentiates', 'keep',
    'fear', 'praise', 'avoid', 'be', 'as', 'with', 'of', 'to', 'for'];
  // "her first" splits on what comes before it: "deal with her first" (object)
  // against "also her first night dead" (possessive).
  var HER_FIRST_OBJECT_PREV = ['with', 'deal'];

  function inList(list, w) { return list.indexOf(String(w || '').toLowerCase()) !== -1; }

  // Preserve the original word's capitalisation.
  function like(sample, word) {
    return /^[A-Z]/.test(sample) ? word.charAt(0).toUpperCase() + word.slice(1) : word;
  }

  function fixPronouns(s) {
    var out = String(s == null ? '' : s);

    // contractions first, so "he's" is not eaten by the bare "he" rule
    out = out.replace(/\b([Hh]e|[Ss]he)'s\s+(become|becomes)\b/g, function (m, p, v) {
      return like(p, 'they') + "'ve become";
    });
    out = out.replace(/\b([Hh]e|[Ss]he)'s\b/g, function (m, p) { return like(p, 'they') + "'re"; });
    out = out.replace(/\b([Hh]e|[Ss]he)'(ll|d)\b/g, function (m, p, t) { return like(p, 'they') + "'" + t; });

    // himself / herself -> themself (the wiki already prefers "themself")
    out = out.replace(/\b([Hh])imself\b|\b([Hh])erself\b/g, function (m, a, b) {
      return like(a || b, 'themself');
    });

    // her -> their / them, decided by the tables above
    out = out.replace(/([\w']+)?(\s*)\b([Hh]er)\b(\s+([\w']+)|\s*(["']))?/g,
      function (m, prev, gap, her, tail, nextWord, nextPunct) {
        var next = (nextWord || nextPunct || '').toLowerCase();
        var possessive;
        if (next === 'first') possessive = !inList(HER_FIRST_OBJECT_PREV, prev);
        else if (inList(HER_POSSESSIVE_NEXT, next)) possessive = true;
        else if (inList(HER_OBJECT_PREV, prev)) possessive = false;
        else possessive = true;   // bare "her <noun>" reads as possessive
        return (prev || '') + (gap || '') + like(her, possessive ? 'their' : 'them') + (tail || '');
      });

    // his -> their (never predicate "theirs" anywhere in this corpus)
    out = out.replace(/\b([Hh])is\b/g, function (m, c) { return like(c, 'their'); });
    // him -> them
    out = out.replace(/\b([Hh])im\b/g, function (m, c) { return like(c, 'them'); });

    // he / she -> they, carrying the verb into the plural
    var advRe = ADVERBS.join('|');
    out = out.replace(
      new RegExp("\\b([Hh]e|[Ss]he)\\b(\\s+(?:" + advRe + ")\\b)?(\\s+([\\w']+))?", 'g'),
      function (m, p, advPart, vPart, verb) {
        var head = like(p, 'they') + (advPart || '');
        if (!verb) return head + (vPart || '');
        var lower = verb.toLowerCase();
        if (Object.prototype.hasOwnProperty.call(VERBS, lower)) {
          return head + vPart.replace(verb, like(verb, VERBS[lower]));
        }
        return head + (vPart || '');   // modal/past/unknown: left as-is, flagged later
      });

    return out;
  }

  /* ── coordination repairs ────────────────────────────────────────────────
     Two sentences hang a second verb off the pronoun's verb ("She is woken …,
     is not woken …"), so turning "she is" into "they are" strands the later
     verb in the singular. Every sentence in the corpus that coordinates a bare
     is/was/has/does after a "they" was reviewed; these are the only two where
     the subject is the pronoun rather than a singular noun. */
  var COORDINATION_FIXES = [
    ['may get false information, is not woken during',
     'may get false information, are not woken during'],
    ['easier to hide, and has no final-circle restriction',
     'easier to hide, and have no final-circle restriction']
  ];
  function fixCoordination(s) {
    var out = String(s == null ? '' : s);
    COORDINATION_FIXES.forEach(function (p) { out = out.split(p[0]).join(p[1]); });
    return out;
  }

  /* ── tips opener ─────────────────────────────────────────────────────── */
  function fixOpener(s) {
    return String(s == null ? '' : s).replace(/\bIf you are\b/g, "If you're");
  }

  /* ── flags: anything the tables above could not decide ────────────────── */
  function flagsFor(before, after, field) {
    var f = [];
    if (after.indexOf('—') !== -1) f.push('em dash survived');
    if (field !== 'quote' && /\b(he|him|his|she|her|hers|himself|herself)\b/i.test(after))
      f.push('gendered pronoun survived');
    // agreement artefacts
    if (/\bthey\s+(is|was|has|does|doesn't|isn't|wasn't|hasn't)\b/i.test(after))
      f.push('they + singular verb');
    // An adverb after "they" is not the verb, and plural nouns are not verbs.
    var m = after.match(new RegExp('\\bthey\\s+(?:(?:' + ADVERBS.join('|') + ')\\s+)?([a-z]+s)\\b'));
    if (m && KEEP_VERB.indexOf(m[1]) === -1 && ADVERBS.indexOf(m[1]) === -1 &&
        !/^(is|was|has|does|their|players|characters|abilities|this|its)$/.test(m[1]))
      f.push('they + "' + m[1] + '" (unlisted verb)');
    if (/,\s*,|,,|\s,|^,|,$|,\s*[.!?]/.test(after)) f.push('comma artefact');
    // "at their point in the night order" is a correct noun, so only the verb
    // readings are worth flagging.
    if (/\btheir\s+(choose|die|learn)\b/.test(after)) f.push('their + verb');
    return f;
  }

  /* ── per-character transform ─────────────────────────────────────────── */
  // Returns { data, changed, flags:[{field,flag,before,after}] } and never
  // mutates the object it is given.
  function cleanCharacter(src) {
    var d = JSON.parse(JSON.stringify(src));
    var flags = [], changed = 0;
    var abilityBefore = d.ability;

    function run(value, field, prose) {
      var before = String(value == null ? '' : value);
      var after = fixDashes(before);
      if (prose) after = fixOpener(fixCoordination(fixPronouns(after)));
      if (after !== before) changed++;
      flagsFor(before, after, field).forEach(function (fl) {
        flags.push({ field: field, flag: fl, before: before, after: after });
      });
      return after;
    }

    if (d.quote) d.quote = run(d.quote, 'quote', false);   // dashes only
    TEXT_FIELDS.forEach(function (f) { if (d[f]) d[f] = run(d[f], f, true); });
    LIST_FIELDS.forEach(function (f) {
      if (Array.isArray(d[f])) d[f] = d[f].map(function (v, i) { return run(v, f + '[' + i + ']', true); });
    });
    (d.customBoxes || []).forEach(function (b, i) {
      if (b && b.content) b.content = run(b.content, 'customBoxes[' + i + '].content', true);
    });
    (d.jinxes || []).forEach(function (j, i) {
      if (j && j.text) j.text = run(j.text, 'jinxes[' + i + '].text', true);
    });

    if (d.ability !== abilityBefore) {
      flags.push({ field: 'ability', flag: 'ABILITY CHANGED - must never happen', before: abilityBefore, after: d.ability });
    }
    return { data: d, changed: changed, flags: flags };
  }

  var api = {
    cleanCharacter: cleanCharacter,
    fixDashes: fixDashes, fixPronouns: fixPronouns, fixOpener: fixOpener,
    fixCoordination: fixCoordination,
    flagsFor: flagsFor,
    TEXT_FIELDS: TEXT_FIELDS, LIST_FIELDS: LIST_FIELDS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.OdysseyCleanup = api;
})();
