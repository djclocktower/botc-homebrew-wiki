/* storyteller-core.js: the rules behind Storyteller Mode (/storyteller).
 *
 * Pure logic, Browser + Node: no DOM, no fetch, no storage. The page
 * (assets/storyteller.js) owns the screen; this owns the answers to "how many
 * of each team", "what goes in the bag", "who wakes, in what order" and "which
 * jinxes and reminder tokens matter tonight", so every one of them can be
 * tested without a browser (migration/tests/storyteller.test.mjs).
 *
 * Two things here are deliberately NOT worked out again:
 *
 *   - The night order. nightSteps() takes PageRender.nightItems() (the list a
 *     script page renders and its export writes) and interleaves the
 *     night-order.json `meta` steps exactly as render-page.js nightSequences()
 *     does, so the runner, the page and the official app's night sheet agree.
 *   - A script's jinxes. jinxesInPlay() filters PageRender.scriptJinxes(),
 *     which already applies the script's own jinxEdits.
 *
 * Setup brackets ("[+2 Outsiders]") are read by parseSetupMods(). Only a plain
 * count is ever applied; anything that rewrites the rules ("[No Demon]",
 * "[-? to +? Outsiders]") comes back as a note for the Storyteller to handle,
 * because a guess there would be worse than saying so.
 *
 * The team order is one more hand copy of the wiki's list (see "Frontend
 * conventions" in CLAUDE.md).
 */
(function () {
  'use strict';

  var TEAMS = ['townsfolk', 'outsider', 'minion', 'demon', 'traveller', 'fabled', 'loric'];
  // The teams the bag is drawn from. Travellers are chosen by the player,
  // Fabled and Loric by the Storyteller; none of them goes in the bag.
  var BAG_TEAMS = ['townsfolk', 'outsider', 'minion', 'demon'];
  var TEAM_PLURAL = {
    townsfolk: 'Townsfolk', outsider: 'Outsiders', minion: 'Minions', demon: 'Demons',
    traveller: 'Travellers', fabled: 'Fabled', loric: 'Loric'
  };
  var PLAYERS_MIN = 5, PLAYERS_MAX = 15, TRAVELLERS_MAX = 5;

  /* ── the official setup table ───────────────────────────────────── */
  // players -> [townsfolk, outsider, minion, demon]
  var BASE = {
    5: [3, 0, 1, 1], 6: [3, 1, 1, 1], 7: [5, 0, 1, 1], 8: [5, 1, 1, 1], 9: [5, 2, 1, 1],
    10: [7, 0, 2, 1], 11: [7, 1, 2, 1], 12: [7, 2, 2, 1],
    13: [9, 0, 3, 1], 14: [9, 1, 3, 1], 15: [9, 2, 3, 1]
  };
  function baseCounts(players) {
    if (typeof players !== 'number' || players % 1 !== 0 || !BASE[players]) return null;
    var b = BASE[players];
    return { townsfolk: b[0], outsider: b[1], minion: b[2], demon: b[3] };
  }

  function fold(s) {
    return String(s == null ? '' : s).toLowerCase().normalize('NFKD')
      .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
  }
  // official-roles.js's key(): how a roles.json id becomes an 'off-' slug.
  // Not exported there, so copied (one line).
  function officialKey(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  // PageRender.jinxKey, copied so this file needs nothing loaded beside it.
  // The test checks the two agree.
  function jinxKey(a, b) { return [a, b].sort().join('|'); }
  function teamIndex(t) { var i = TEAMS.indexOf(t); return i < 0 ? 99 : i; }

  /* ── setup brackets ─────────────────────────────────────────────── */
  var TEAM_WORD = '(townsfolk|outsiders?|minions?|demons?)';
  var RE_ONE = new RegExp('^([+-])\\s*(\\d+)\\s+' + TEAM_WORD + '$');
  var RE_OR = new RegExp('^([+-]\\s*\\d+)\\s+or\\s+([+-]\\s*\\d+)\\s+' + TEAM_WORD + '$');
  var RE_TO = new RegExp('^([+-]\\s*\\d+)\\s+to\\s+([+-]\\s*\\d+)\\s+' + TEAM_WORD + '$');
  var RE_PLUS_COPIES = /^\+\s*(\d+\s+to\s+\+?\d+\s+|\d+\s+)?(.+)$/;
  var RE_MINUS_COPIES = /^-\s*\d+\s+(.+)$/;
  var RE_REQUIRE = /^\+\s*(the\s+)?([^\d].*)$/i;

  function teamKey(w) {
    w = String(w).toLowerCase();
    return w === 'townsfolk' ? 'townsfolk' : w.replace(/s$/, '');
  }
  // '+ 2' -> 2, '-0' -> 0 (never -0, which would print as "-0").
  function signed(s) { return parseInt(String(s).replace(/\s+/g, ''), 10) || 0; }
  function sameName(text, name) {
    var t = fold(text), n = fold(name);
    if (!t || !n) return false;
    return t === n || t.replace(/s$/, '') === n;
  }

  function classifyClause(clause, entry) {
    var c = clause.trim(), l = c.toLowerCase(), m;
    if ((m = l.match(RE_ONE))) {
      return { kind: 'count', team: teamKey(m[3]), options: [signed(m[1] + m[2])], text: c };
    }
    if ((m = l.match(RE_OR))) {
      return { kind: 'count', team: teamKey(m[3]), options: [signed(m[1]), signed(m[2])], text: c };
    }
    if ((m = l.match(RE_TO))) {
      var a = signed(m[1]), b = signed(m[2]), step = a <= b ? 1 : -1, opts = [];
      for (var i = a; step > 0 ? i <= b : i >= b; i += step) opts.push(i);
      return { kind: 'count', team: teamKey(m[3]), options: opts, text: c };
    }
    // An unknown number, or a sentence rather than a sign: the Storyteller's.
    if (l.indexOf('?') !== -1 || !/^[+-]/.test(l)) return { kind: 'manual', text: c };
    var name = entry && entry.name;
    if ((m = l.match(RE_PLUS_COPIES)) && sameName(m[2], name)) return { kind: 'copies', text: c };
    if ((m = l.match(RE_MINUS_COPIES)) && sameName(m[1], name)) return { kind: 'copies', text: c };
    if ((m = c.match(RE_REQUIRE))) return { kind: 'require', name: m[2].trim(), text: c };
    return { kind: 'manual', text: c };
  }

  /* Every [...] in the ability, read clause by clause. Returns
       {kind:'count', team, options:[int], text}  apply one option to the counts
       {kind:'require', name, text}              this character needs another in play
       {kind:'copies', text}                     extra (or fewer) copies of itself
       {kind:'manual', text}                     anything else: the Storyteller's call
     Adjacent notes from one bracket are merged, so "Evil characters are in a
     line. You are in the middle" stays one sentence. */
  function parseSetupMods(entry) {
    if (!entry) return [];
    var ability = String(entry.ability || '');
    var brackets = ability.match(/\[[^\]]*\]/g) || [];
    var out = [];
    brackets.forEach(function (br) {
      var body = br.slice(1, -1)
        .replace(/[−–—]/g, '-')
        .replace(/\s+/g, ' ').trim();
      var clauses = body.split(/\.\s*|;\s*|,\s+/).map(function (s) { return s.trim(); }).filter(Boolean);
      var prevManual = null;
      clauses.forEach(function (cl) {
        var mod = classifyClause(cl, entry);
        if (mod.kind === 'manual' && prevManual) {
          prevManual.text += '. ' + mod.text;
          return;
        }
        out.push(mod);
        prevManual = mod.kind === 'manual' ? mod : null;
      });
    });
    // A setup character whose effect is not written in brackets. The Drunk and
    // friends are left out: their setup effect is the fake token, which the
    // Bag tab already handles.
    if (!brackets.length && entry.setup && !thinksTeam(entry)) {
      out.push({ kind: 'manual', text: 'Has a setup effect: read its ability.' });
    }
    return out;
  }

  /* The mods of the characters in play, flattened, each carrying its slug,
     name and index (the index is the key a choice is stored under). */
  function modsForBag(entries, bagSlugs) {
    var by = bySlugMap(entries), out = [];
    uniq(bagSlugs || []).forEach(function (slug) {
      var c = by[slug];
      if (!c) return;
      var mods = parseSetupMods(c).map(function (m, i) {
        var o = {};
        for (var k in m) o[k] = m[k];
        o.slug = slug; o.index = i;
        return o;
      });
      if (mods.length) out.push({ slug: slug, name: c.name || slug, mods: mods });
    });
    return out;
  }
  function flatMods(groups) {
    var out = [];
    (groups || []).forEach(function (g) { (g.mods || []).forEach(function (m) { out.push(m); }); });
    return out;
  }
  function choiceKey(slug, index) { return slug + '#' + index; }

  /* Start from the table and apply every count mod, in order. Moving a
     non-Townsfolk team moves Townsfolk the other way; a Townsfolk mod trades
     with the Outsiders. `choices` picks which option of an "X or Y" mod. */
  function adjustCounts(base, mods, choices) {
    var counts = { townsfolk: 0, outsider: 0, minion: 0, demon: 0 };
    for (var t in counts) counts[t] = (base && base[t]) || 0;
    var sources = [], warnings = [];
    choices = choices || {};
    (mods || []).forEach(function (m, pos) {
      if (!m || m.kind !== 'count' || !counts.hasOwnProperty(m.team)) return;
      var opts = m.options || [];
      if (!opts.length) return;
      var idx = Number(choices[choiceKey(m.slug, m.index != null ? m.index : pos)]) || 0;
      if (idx < 0 || idx >= opts.length) idx = 0;
      var d = opts[idx];
      if (!d) return;
      if (m.team === 'townsfolk') { counts.townsfolk += d; counts.outsider -= d; }
      else { counts[m.team] += d; counts.townsfolk -= d; }
      sources.push({ slug: m.slug, team: m.team, d: d });
    });
    BAG_TEAMS.forEach(function (t) {
      if (counts[t] < 0) {
        warnings.push('Setup needs fewer ' + TEAM_PLURAL[t] + ' than 0; check the modifiers.');
        counts[t] = 0;
      }
    });
    return { counts: counts, warnings: warnings, sources: sources };
  }

  /* ── helpers ────────────────────────────────────────────────────── */
  function bySlugMap(entries) {
    var m = {};
    (entries || []).forEach(function (c) { if (c && c.slug) m[c.slug] = c; });
    return m;
  }
  function uniq(list) {
    var seen = {}, out = [];
    (list || []).forEach(function (x) {
      if (typeof x !== 'string' || !x || seen[x]) return;
      seen[x] = 1; out.push(x);
    });
    return out;
  }
  function setOf(list) { var s = {}; (list || []).forEach(function (x) { s[x] = 1; }); return s; }
  // mulberry32: small, fast and the same everywhere, so a seed is a bag.
  function makeRng(seed) {
    var a = (Number(seed) >>> 0) || 1;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(list, rng) {
    var a = list.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function sortEntries(entries) {
    // Team first, the script's own order inside a team (Array.sort is stable),
    // the order script.html's rosterChars() uses.
    return (entries || []).slice().sort(function (a, b) { return teamIndex(a.team) - teamIndex(b.team); });
  }
  function teamCounts(entries) {
    var out = [];
    TEAMS.forEach(function (t) {
      var n = (entries || []).filter(function (c) { return c.team === t; }).length;
      if (n) out.push({ team: t, n: n });
    });
    return out;
  }
  function sameCounts(a, b) {
    return BAG_TEAMS.every(function (t) { return a[t] === b[t]; });
  }

  /* ── the bag ────────────────────────────────────────────────────── */
  /* opts: {players, locks, keep, exclude, choices, rng, also}
       locks    always stay (a hard keep)
       keep     stay unless the counts force them out (a soft keep)
       exclude  never drawn (a re-rolled slot)
       also     slugs in play outside the bag (Fabled, Loric) whose count
                modifiers apply too
     Fills demon, minion, outsider, then townsfolk, re-reading the modifiers
     after each pass (drawing a Baron changes the Outsider count), at most four
     passes. */
  function drawBag(entries, opts) {
    opts = opts || {};
    var rng = opts.rng || makeRng(1);
    var by = bySlugMap(entries);
    var pool = (entries || []).filter(function (c) { return BAG_TEAMS.indexOf(c.team) !== -1; });
    var inPool = {};
    pool.forEach(function (c) { inPool[c.slug] = c; });
    var locks = setOf(uniq(opts.locks).filter(function (s) { return inPool[s]; }));
    var exclude = setOf(opts.exclude);
    var bag = uniq((opts.locks || []).concat(opts.keep || [])).filter(function (s) { return inPool[s]; });
    var also = uniq(opts.also).filter(function (s) { return by[s]; });
    var base = baseCounts(opts.players);
    if (!base) return { bag: [], counts: null, warnings: ['Choose between ' + PLAYERS_MIN + ' and ' + PLAYERS_MAX + ' players.'], passes: 0 };

    var byName = {};
    pool.forEach(function (c) { var k = fold(c.name); if (k && !byName[k]) byName[k] = c.slug; });

    var counts, warnings, pass, stable = false;
    for (pass = 1; pass <= 4; pass++) {
      var adj = adjustCounts(base, flatMods(modsForBag(entries, bag.concat(also))), opts.choices);
      counts = adj.counts;
      warnings = adj.warnings.slice();
      // Characters another one needs ("+the King") join the bag and stay.
      var required = {};
      bag.slice().forEach(function (slug) {
        parseSetupMods(by[slug]).forEach(function (m) {
          if (m.kind !== 'require') return;
          var hit = byName[fold(m.name.replace(/^the\s+/i, ''))];
          if (!hit) {
            warnings.push(by[slug].name + ' needs ' + m.name + ', which is not on this script.');
            return;
          }
          required[hit] = 1;
          if (bag.indexOf(hit) === -1) bag.push(hit);
        });
      });
      ['demon', 'minion', 'outsider', 'townsfolk'].forEach(function (team) {
        var members = bag.filter(function (s) { return inPool[s].team === team; });
        while (members.length > counts[team]) {
          var removable = members.filter(function (s) { return !locks[s] && !required[s]; });
          if (!removable.length) {
            warnings.push('Locked characters exceed the ' + TEAM_PLURAL[team] + ' count.');
            break;
          }
          var out = removable[Math.floor(rng() * removable.length)];
          bag.splice(bag.indexOf(out), 1);
          members.splice(members.indexOf(out), 1);
        }
        var candidates = shuffle(pool.filter(function (c) {
          return c.team === team && bag.indexOf(c.slug) === -1 && !exclude[c.slug];
        }).map(function (c) { return c.slug; }).sort(), rng);
        while (members.length < counts[team] && candidates.length) {
          var add = candidates.shift();
          bag.push(add); members.push(add);
        }
        if (members.length < counts[team]) {
          var have = pool.filter(function (c) { return c.team === team; }).length;
          warnings.push('This script has only ' + have + ' ' + TEAM_PLURAL[team] +
            (have === 1 ? ' character' : ' characters') + '; setup needs ' + counts[team] + '.');
        }
      });
      var after = adjustCounts(base, flatMods(modsForBag(entries, bag.concat(also))), opts.choices).counts;
      if (sameCounts(after, counts)) { stable = true; break; }
    }
    if (!stable) { pass = 4; warnings.push('Setup modifiers disagree; check the counts by hand.'); }
    bag.sort(function (a, b) {
      return teamIndex(by[a].team) - teamIndex(by[b].team) ||
        String(by[a].name || '').localeCompare(String(by[b].name || ''));
    });
    return { bag: bag, counts: counts, warnings: uniq(warnings), passes: pass };
  }

  /* Who believes they are someone else. The official three by slug (the
     Marionette's "a good character" is taken as Townsfolk, the Storyteller can
     change the pick); homebrew by the official wording. */
  var THINKS_OFFICIAL = { 'off-drunk': 'townsfolk', 'off-lunatic': 'demon', 'off-marionette': 'townsfolk' };
  var THINKS_RE = /\byou (?:do not know you are the [^.]*\. you )?think you are (?:a|an|the) (townsfolk|outsider|minion|demon)\b/i;
  function thinksTeam(entry) {
    if (!entry) return null;
    if (THINKS_OFFICIAL[entry.slug]) return THINKS_OFFICIAL[entry.slug];
    var m = String(entry.ability || '').match(THINKS_RE);
    return m ? m[1].toLowerCase() : null;
  }
  function candidatesOf(entries, team, notIn) {
    return (entries || []).filter(function (c) {
      return c.team === team && !notIn[c.slug];
    }).map(function (c) { return c.slug; }).sort();
  }
  function pickFake(entries, bagSlugs, team, excludeSlugs, rng) {
    var notIn = setOf((bagSlugs || []).concat(excludeSlugs || []));
    var list = candidatesOf(entries, team, notIn);
    if (!list.length) return null;
    return list[Math.floor((rng || Math.random)() * list.length)];
  }
  /* Three good characters not in play: Townsfolk first, then Outsiders. */
  function pickBluffs(entries, bagSlugs, excludeSlugs, rng, n) {
    n = n == null ? 3 : n;
    rng = rng || Math.random;
    var notIn = setOf((bagSlugs || []).concat(excludeSlugs || []));
    var list = shuffle(candidatesOf(entries, 'townsfolk', notIn), rng)
      .concat(shuffle(candidatesOf(entries, 'outsider', notIn), rng));
    return list.slice(0, n);
  }
  function rerollBluff(entries, bagSlugs, current, index, excludeSlugs, rng) {
    var cur = (current || []).slice();
    var pick = pickBluffs(entries, bagSlugs, (excludeSlugs || []).concat(cur), rng, 1)[0];
    if (pick) cur[index] = pick;
    return cur;
  }

  /* ── prep ───────────────────────────────────────────────────────── */
  /* roles.json carries reminders and the setup flag; buildOfficialRoles()
     leaves them out on purpose (adding them would change how an official
     character exports in full). This page needs them, so it reads them here. */
  function officialExtras(roles) {
    var out = {};
    (roles || []).forEach(function (r) {
      if (!r || !r.id) return;
      out['off-' + officialKey(r.id)] = {
        reminders: Array.isArray(r.reminders) ? r.reminders.slice() : [],
        remindersGlobal: Array.isArray(r.remindersGlobal) ? r.remindersGlobal.slice() : [],
        setup: !!r.setup
      };
    });
    return out;
  }
  function tokensOf(c, extras, globalOnly) {
    var x = (extras && extras[c.slug]) || c;
    var list = globalOnly ? [] : (Array.isArray(x.reminders) ? x.reminders : []);
    list = list.concat(Array.isArray(x.remindersGlobal) ? x.remindersGlobal : []);
    return uniq(list.map(function (t) { return String(t || '').trim(); }));
  }
  function reminderChecklist(entries, inPlaySlugs, extras) {
    var inPlay = setOf(inPlaySlugs), a = [], g = [];
    (entries || []).forEach(function (c) {
      var on = !!inPlay[c.slug];
      var tokens = tokensOf(c, extras, !on);
      if (!tokens.length) return;
      (on ? a : g).push({ slug: c.slug, name: c.name || c.slug, tokens: tokens });
    });
    return { inPlay: a, global: g };
  }
  /* Official-to-official jinxes from assets/official-jinxes.json (a partial
     list, as its own note says), for pairs where both are on the script and
     the script has not switched the jinx off. */
  function officialJinxPairs(json, entries, jinxEdits) {
    var list = (json && (Array.isArray(json.jinxes) ? json.jinxes : (Array.isArray(json.pairs) ? json.pairs : []))) || [];
    var by = bySlugMap(entries);
    var off = setOf(jinxEdits && Array.isArray(jinxEdits.off) ? jinxEdits.off : []);
    var out = [];
    list.forEach(function (p) {
      if (!p) return;
      var a = by['off-' + officialKey(p.a)], b = by['off-' + officialKey(p.b)];
      if (!a || !b || a === b || off[jinxKey(a.slug, b.slug)]) return;
      out.push({ a: a, b: b, text: String(p.text || ''), official: true });
    });
    return out;
  }
  function jinxesInPlay(list, inPlaySlugs) {
    var inPlay = setOf(inPlaySlugs), seen = {}, out = [];
    (list || []).forEach(function (j) {
      if (!j || !j.a || !j.b || !inPlay[j.a.slug] || !inPlay[j.b.slug]) return;
      var k = jinxKey(j.a.slug, j.b.slug);
      if (seen[k]) return;
      seen[k] = 1;
      out.push(j);
    });
    return out;
  }

  /* ── the night ──────────────────────────────────────────────────── */
  // Used only if night-order.json could not be read: the same four steps.
  var DEFAULT_META = [
    { id: 'dusk', firstNight: 0, otherNight: 0 },
    { id: 'minioninfo', firstNight: 19 },
    { id: 'demoninfo', firstNight: 24 },
    { id: 'dawn', firstNight: 9999, otherNight: 9999 }
  ];
  /* items: PageRender.nightItems(entries, nightOrder)[which].
     The meta steps are interleaved over the FULL list first, exactly as
     nightSequences() does for the export, and only then are characters not in
     play taken out, so where Minion Info falls never depends on who is in the
     bag. inPlay: a set ({slug:1}) or an array, or null for everyone. */
  function nightSteps(items, meta, which, opts) {
    opts = opts || {};
    var field = which === 'first' ? 'firstNight' : 'otherNight';
    var marks = (Array.isArray(meta) && meta.length ? meta : DEFAULT_META).map(function (m) {
      return { id: m.id, n: Number(m[field]) };
    }).filter(function (m) { return m.id && isFinite(m.n); });
    marks.sort(function (a, b) { return a.n - b.n; });
    var steps = [], mi = 0;
    (items || []).forEach(function (it) {
      while (mi < marks.length && marks[mi].n <= it.n) steps.push({ kind: 'meta', id: marks[mi++].id });
      steps.push({ kind: 'char', slug: it.c.slug, c: it.c, reminder: it.r || '', n: it.n });
    });
    while (mi < marks.length) steps.push({ kind: 'meta', id: marks[mi++].id });
    var inPlay = opts.inPlay == null ? null
      : (Array.isArray(opts.inPlay) ? setOf(opts.inPlay) : opts.inPlay);
    var small = typeof opts.players === 'number' && opts.players < 7;
    return steps.filter(function (s) {
      if (s.kind === 'meta') return !(small && (s.id === 'minioninfo' || s.id === 'demoninfo'));
      return !inPlay || !!(typeof inPlay.has === 'function' ? inPlay.has(s.slug) : inPlay[s.slug]);
    });
  }

  /* ── state ──────────────────────────────────────────────────────── */
  var STATE_VERSION = 1;
  function newSeed() { return (Math.floor(Math.random() * 4294967296)) >>> 0; }
  function emptyState() {
    return {
      v: STATE_VERSION, players: 8, travellers: 0, seed: newSeed(),
      bag: [], locks: [], choices: {}, handled: {}, thinks: {},
      fabledOn: [], fabledSet: false, travellersOn: [], bluffs: [], tokensDone: {}, dead: [],
      night: { which: 'first', n: 1, step: 0, everyone: false }
    };
  }
  function clampInt(v, lo, hi, dflt) {
    var n = Math.round(Number(v));
    if (!isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  }
  /* A saved state against the script as it is now: anything that has left the
     roster is dropped, numbers are clamped, and a broken or foreign value falls
     back to the default. Returns a NEW object; the input is not touched. */
  function reconcileState(state, entries) {
    var s = (state && typeof state === 'object') ? state : {};
    var by = bySlugMap(entries);
    var on = function (x) { return typeof x === 'string' && !!by[x]; };
    var list = function (v) { return uniq(Array.isArray(v) ? v : []).filter(on); };
    var obj = function (v) { return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; };
    var out = emptyState();
    out.players = clampInt(s.players, PLAYERS_MIN, PLAYERS_MAX, 8);
    out.travellers = clampInt(s.travellers, 0, TRAVELLERS_MAX, 0);
    if (typeof s.seed === 'number' && isFinite(s.seed)) out.seed = s.seed >>> 0;
    out.bag = list(s.bag).filter(function (x) { return BAG_TEAMS.indexOf(by[x].team) !== -1; });
    out.locks = list(s.locks).filter(function (x) { return out.bag.indexOf(x) !== -1; });
    var ch = obj(s.choices);
    Object.keys(ch).forEach(function (k) {
      var n = Number(ch[k]);
      if (on(k.split('#')[0]) && n >= 0 && n % 1 === 0) out.choices[k] = n;
    });
    var hd = obj(s.handled);
    Object.keys(hd).forEach(function (k) { if (on(k.split('#')[0]) && hd[k]) out.handled[k] = true; });
    var th = obj(s.thinks);
    Object.keys(th).forEach(function (k) {
      if (out.bag.indexOf(k) !== -1 && on(th[k]) && out.bag.indexOf(th[k]) === -1) out.thinks[k] = th[k];
    });
    out.fabledOn = list(s.fabledOn).filter(function (x) { return by[x].team === 'fabled' || by[x].team === 'loric'; });
    out.fabledSet = !!s.fabledSet;
    out.travellersOn = list(s.travellersOn).filter(function (x) { return by[x].team === 'traveller'; });
    out.bluffs = list(s.bluffs).filter(function (x) { return out.bag.indexOf(x) === -1; }).slice(0, 3);
    var td = obj(s.tokensDone);
    Object.keys(td).forEach(function (k) { if (on(k.split('|')[0]) && td[k]) out.tokensDone[k] = true; });
    out.dead = list(s.dead);
    var n = obj(s.night);
    out.night = {
      which: n.which === 'other' ? 'other' : 'first',
      n: clampInt(n.n, 1, 99, 1),
      step: clampInt(n.step, 0, 999, 0),
      everyone: !!n.everyone
    };
    return out;
  }
  function storageKey(source) {
    if (source && source.slug) return 'botc_st:s:' + source.slug;
    return 'botc_st:builder';
  }

  var api = {
    TEAMS: TEAMS, BAG_TEAMS: BAG_TEAMS, TEAM_PLURAL: TEAM_PLURAL,
    PLAYERS_MIN: PLAYERS_MIN, PLAYERS_MAX: PLAYERS_MAX, TRAVELLERS_MAX: TRAVELLERS_MAX,
    baseCounts: baseCounts, adjustCounts: adjustCounts, parseSetupMods: parseSetupMods,
    modsForBag: modsForBag, flatMods: flatMods, choiceKey: choiceKey,
    makeRng: makeRng, drawBag: drawBag, thinksTeam: thinksTeam,
    pickFake: pickFake, pickBluffs: pickBluffs, rerollBluff: rerollBluff,
    officialExtras: officialExtras, reminderChecklist: reminderChecklist,
    officialJinxPairs: officialJinxPairs, jinxesInPlay: jinxesInPlay, jinxKey: jinxKey,
    nightSteps: nightSteps, DEFAULT_META: DEFAULT_META,
    sortEntries: sortEntries, teamCounts: teamCounts, fold: fold, officialKey: officialKey,
    STATE_VERSION: STATE_VERSION, emptyState: emptyState, reconcileState: reconcileState,
    storageKey: storageKey, newSeed: newSeed
  };
  if (typeof window !== 'undefined') { window.STCore = api; }
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})();
