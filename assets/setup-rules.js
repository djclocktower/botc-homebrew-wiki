/* setup-rules.js: how many of each team a game needs, and what a character's
 * [bracketed] setup text changes about that.
 *
 * Two features read this and nothing else about setup, so they cannot come to
 * different answers: the Script Builder's Script Check panel (can this script
 * seat 15? which characters move the Outsider count?) and Deal a Game (draw a
 * legal bag from a script and lay it out as a grimoire).
 *
 * The bracket text is the official convention every homebrew writer copies:
 *
 *   [+2 Outsiders]            Baron            a fixed change
 *   [-1 or +1 Outsider]       Godfather        one of two, the Storyteller's call
 *   [+0 to +2 Outsiders]      (homebrew)       a range, every value in it
 *   [+1 Minion]               Lil' Monsta      a change to another team
 *   [+the King]               Choirboy         a named character must be in play
 *   [No evil characters]      Atheist          anything else is a NOTE: it is
 *                                              shown, never simulated
 *
 * A change to Outsiders, Minions or Demons is paid for in Townsfolk, which is
 * how the official game does it (the Baron turns two Townsfolk into two
 * Outsiders). A change to Townsfolk is paid for in Outsiders.
 *
 * Browser + Worker (no DOM, no fetch): window.SetupRules and module.exports.
 */
(function () {
  'use strict';

  var TEAMS = ['townsfolk', 'outsider', 'minion', 'demon'];
  var LABEL = { townsfolk: 'Townsfolk', outsider: 'Outsider', minion: 'Minion', demon: 'Demon' };
  var PLURAL = { townsfolk: 'Townsfolk', outsider: 'Outsiders', minion: 'Minions', demon: 'Demons' };

  /* The official setup sheet, 5 to 15 players. Past 15 the extra seats are
     Travellers, which a bag does not hold. */
  var BASE = {
    5: [3, 0, 1, 1], 6: [3, 1, 1, 1], 7: [5, 0, 1, 1], 8: [5, 1, 1, 1],
    9: [5, 2, 1, 1], 10: [7, 0, 2, 1], 11: [7, 1, 2, 1], 12: [7, 2, 2, 1],
    13: [9, 0, 3, 1], 14: [9, 1, 3, 1], 15: [9, 2, 3, 1]
  };
  var MIN_PLAYERS = 5, MAX_PLAYERS = 15;

  function baseCounts(players) {
    var n = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, Math.round(Number(players) || 0)));
    var b = BASE[n];
    return { townsfolk: b[0], outsider: b[1], minion: b[2], demon: b[3] };
  }

  function teamOf(word) {
    var w = String(word || '').toLowerCase();
    if (w.indexOf('townsfolk') === 0) return 'townsfolk';
    if (w.indexOf('outsider') === 0) return 'outsider';
    if (w.indexOf('minion') === 0) return 'minion';
    if (w.indexOf('demon') === 0) return 'demon';
    return '';
  }

  // Writers type every dash there is; the official cards use a real minus.
  function num(s) {
    var t = String(s || '').replace(/[−–—]/g, '-').replace(/\s+/g, '');
    var n = parseInt(t, 10);
    return isFinite(n) ? n : null;
  }

  var DELTA_RE = /([+\-−–—]\s*\d+)(?:\s*(or|to)\s*([+\-−–—]?\s*\d+))?\s+(townsfolk|outsiders?|minions?|demons?)\b/i;
  var ADD_RE = /\+\s*the\s+([^\].,;]+)/i;

  /* One ability -> what it does to setup.
       mods[]    {team, options[], text}   options are the possible deltas
       adds[]    'King'                     a named character that must be in
       notes[]   'No evil characters'       everything the rules above do not
                                            cover, word for word
     A character with no brackets returns empty lists. */
  function parseSetup(ability) {
    var out = { mods: [], adds: [], notes: [] };
    var text = String(ability || '');
    var re = /\[([^\]]*)\]/g, m;
    while ((m = re.exec(text))) {
      var inner = m[1].trim();
      if (!inner) continue;
      // A bracket can hold several sentences (Lord of Typhon has three) or
      // clauses ("+1 or +2 Outsiders, -1 Folie à Deux"), and each is judged
      // on its own, so one note does not hide a real change.
      inner.split(/[.;,]\s*/).forEach(function (sentence) {
        var s = sentence.trim();
        if (!s) return;
        var d = DELTA_RE.exec(s);
        if (d) {
          var team = teamOf(d[4]);
          var a = num(d[1]);
          var options = [a];
          if (d[3] != null) {
            // "+1 or 2" reads as "+1 or +2": the second number inherits the sign.
            var bRaw = String(d[3]).trim();
            var b = num(/^[+\-−–—]/.test(bRaw) ? bRaw : (a < 0 ? '-' : '+') + bRaw);
            if (String(d[2]).toLowerCase() === 'to') {
              options = [];
              var lo = Math.min(a, b), hi = Math.max(a, b);
              for (var v = lo; v <= hi && options.length < 7; v++) options.push(v);
            } else if (b !== a) {
              options.push(b);
            }
          }
          out.mods.push({ team: team, options: options, text: s });
          return;
        }
        var add = ADD_RE.exec(s);
        if (add) { out.adds.push(add[1].trim()); return; }
        out.notes.push(s);
      });
    }
    return out;
  }

  function signed(n) { return (n < 0 ? '−' : '+') + Math.abs(n); }

  /* "+2 Outsiders", "−1 or +1 Outsider", "+0 to +2 Outsiders". */
  function describeMod(mod) {
    var o = mod.options || [];
    var noun = function (n) { return Math.abs(n) === 1 ? LABEL[mod.team] : PLURAL[mod.team]; };
    if (o.length === 1) return signed(o[0]) + ' ' + noun(o[0]);
    if (o.length === 2) return signed(o[0]) + ' or ' + signed(o[1]) + ' ' + noun(Math.max(Math.abs(o[0]), Math.abs(o[1])));
    return signed(o[0]) + ' to ' + signed(o[o.length - 1]) + ' ' + PLURAL[mod.team];
  }

  /* Apply one change to a set of counts, the official way round: a non-
     Townsfolk team is paid for in Townsfolk, Townsfolk in Outsiders. */
  function applyDelta(counts, team, delta) {
    if (!delta || typeof counts[team] !== 'number') return;
    counts[team] += delta;
    if (team === 'townsfolk') counts.outsider -= delta;
    else counts.townsfolk -= delta;
  }

  /* The most (and fewest) Outsiders a game at `players` could ask for, given
     every modifier on the script — the Script Check's "could this script run
     out of Outsiders" question. Each modifier is counted once, which is the
     realistic worst case: two Barons are never both in play. */
  function outsiderRange(players, chars) {
    var base = baseCounts(players).outsider;
    var up = 0, down = 0;
    (chars || []).forEach(function (c) {
      parseSetup(c && c.ability).mods.forEach(function (mod) {
        if (mod.team !== 'outsider') return;
        var hi = Math.max.apply(null, mod.options), lo = Math.min.apply(null, mod.options);
        // Only one evil modifier is usually in play, so the largest wins
        // rather than the sum; a good one (the Balloonist) can stack on it.
        if (c.team === 'minion' || c.team === 'demon') {
          up = Math.max(up, hi); down = Math.min(down, lo);
        } else {
          up += Math.max(0, hi); down += Math.min(0, lo);
        }
      });
    });
    return { min: Math.max(0, base + down), max: base + up, base: base };
  }

  /* ── dealing a bag ──
     `roster` is a list of {slug, name, team, ability, ...}; anything that is
     not one of the four bag teams (Travellers, Fabled, Loric) is ignored.
     `rng` is Math.random unless a test hands in its own.
     Returns {counts, seats[], bluffs[], applied[], notes[], short[]}:
       seats    the characters in play, shuffled into seat order
       bluffs   up to three good characters NOT in play, for the Demon
       applied  "Baron: +2 Outsiders" — the modifiers that moved the counts
       notes    setup text this does not simulate, and "thinks they are"
       short    teams the script could not fill ({team, want, have})        */
  function deal(roster, players, rng) {
    var random = typeof rng === 'function' ? rng : Math.random;
    var pools = { townsfolk: [], outsider: [], minion: [], demon: [] };
    var seen = {};
    (roster || []).forEach(function (c) {
      if (!c || !pools[c.team]) return;
      var key = c.slug || c.name;
      if (seen[key]) return;
      seen[key] = true;
      pools[c.team].push(c);
    });
    function shuffle(a) {
      for (var i = a.length - 1; i > 0; i--) {
        var j = Math.floor(random() * (i + 1));
        var t = a[i]; a[i] = a[j]; a[j] = t;
      }
      return a;
    }
    var bags = {};
    TEAMS.forEach(function (t) { bags[t] = shuffle(pools[t].slice()); });
    var counts = baseCounts(players);
    var chosen = { townsfolk: [], outsider: [], minion: [], demon: [] };
    var pinned = {};          // a modifier, or a character something asked for by name
    var applied = [], notes = [], short = [];

    function inPlay(c) { return chosen[c.team].indexOf(c) !== -1; }
    function draw(team) {
      var bag = bags[team];
      for (var i = 0; i < bag.length; i++) if (!inPlay(bag[i])) return bag[i];
      return null;
    }
    // Bring a team up or down to its count. Dropping never takes a pinned one.
    function settle(team) {
      var want = Math.max(0, counts[team]);
      while (chosen[team].length < want) {
        var c = draw(team);
        if (!c) break;
        chosen[team].push(c);
      }
      for (var i = chosen[team].length - 1; chosen[team].length > want && i >= 0; i--) {
        if (!pinned[key(chosen[team][i])]) chosen[team].splice(i, 1);
      }
    }
    function key(c) { return c.slug || c.name; }
    // Only the options that leave every team at zero or more: a Godfather at
    // seven players has no Outsider to remove, so it has to add one — which
    // is exactly the call the Storyteller would make.
    function validOptions(mod) {
      return mod.options.filter(function (d) {
        var c = { townsfolk: counts.townsfolk, outsider: counts.outsider, minion: counts.minion, demon: counts.demon };
        applyDelta(c, mod.team, d);
        return c.townsfolk >= 0 && c.outsider >= 0 && c.minion >= 0 && c.demon >= 0;
      });
    }
    // Additions before removals: a Vigormortis beside a Baron at ten players
    // has the Baron's two Outsiders to take one from, whichever was drawn first.
    function reach(c) {
      return parseSetup(c.ability).mods.reduce(function (m, mod) {
        return Math.max(m, Math.max.apply(null, mod.options));
      }, -Infinity);
    }
    function applyFrom(list) {
      var any = false;
      list.slice().sort(function (a, b) { return reach(b) - reach(a); }).forEach(function (c) {
        if (pinned[key(c)]) return;
        var p = parseSetup(c.ability);
        if (!p.mods.length) return;
        pinned[key(c)] = true;
        any = true;
        var said = [];
        p.mods.forEach(function (mod) {
          if (!LABEL[mod.team]) return;
          var ok = validOptions(mod);
          if (!ok.length) { said.push(describeMod(mod) + ' (not possible at this player count)'); return; }
          var d = ok[Math.floor(random() * ok.length)];
          applyDelta(counts, mod.team, d);
          said.push(signed(d) + ' ' + (Math.abs(d) === 1 ? LABEL[mod.team] : PLURAL[mod.team]) +
            (mod.options.length > 1 ? ' (could be ' + describeMod(mod) + ')' : ''));
        });
        applied.push(c.name + ': ' + said.join(', '));
      });
      return any;
    }

    // Evil first: the Demon and the Minions decide the Outsider count. A
    // Minion drawn because of another's modifier ([+1 Minion]) may carry a
    // modifier of its own, so this repeats until nothing new turns up.
    settle('demon'); settle('minion');
    for (var pass = 0; pass < 4; pass++) {
      if (!applyFrom(chosen.demon.concat(chosen.minion))) break;
      settle('demon'); settle('minion');
    }
    settle('outsider'); settle('townsfolk');
    // Then good modifiers (the Balloonist, the Hermit), once. Their own
    // change is applied and the two good teams settle around it.
    if (applyFrom(chosen.outsider.concat(chosen.townsfolk))) { settle('outsider'); settle('townsfolk'); }

    // "+the King": whoever asks for a character gets it, swapped in for an
    // unpinned character of its team.
    var byName = {};
    TEAMS.forEach(function (t) { pools[t].forEach(function (c) { byName[String(c.name).toLowerCase()] = c; }); });
    TEAMS.forEach(function (t) {
      chosen[t].slice().forEach(function (c) {
        parseSetup(c.ability).adds.forEach(function (name) {
          var want = byName[String(name).toLowerCase()];
          if (!want) { notes.push(c.name + ' adds the ' + name + ', who is not on this script.'); return; }
          if (inPlay(want)) { pinned[key(want)] = true; return; }
          var team = chosen[want.team];
          for (var i = team.length - 1; i >= 0; i--) {
            if (!pinned[key(team[i])] && team[i] !== c) {
              team.splice(i, 1, want);
              pinned[key(want)] = true;
              applied.push(c.name + ': +the ' + want.name);
              return;
            }
          }
          notes.push(c.name + ' adds the ' + want.name + ', but there was no seat to give them.');
        });
      });
    });

    TEAMS.forEach(function (t) {
      var want = Math.max(0, counts[t]);
      if (chosen[t].length < want) short.push({ team: t, want: want, have: chosen[t].length });
      counts[t] = want;
    });

    // What is not simulated is said, word for word, rather than silently lost.
    var seats = TEAMS.reduce(function (all, t) { return all.concat(chosen[t]); }, []);
    seats.forEach(function (c) {
      parseSetup(c.ability).notes.forEach(function (n) { notes.push(c.name + ': ' + n); });
      var think = /you think you are (?:a|an|the) ([A-Za-z' -]+?)(?:[.,;]|$| character)/i.exec(String(c.ability || ''));
      if (think) {
        var y = think[1].trim();
        var token = /^(good|evil)$/i.test(y) ? y + ' character' : y;
        notes.push('The ' + c.name + ' thinks they are a ' + token + ': show them a ' + token + ' token that is not in play.');
      }
    });

    // Bluffs: good characters not in play, Townsfolk first.
    var bluffPool = shuffle(pools.townsfolk.filter(function (c) { return !inPlay(c); }))
      .concat(shuffle(pools.outsider.filter(function (c) { return !inPlay(c); })));
    var bluffs = bluffPool.slice(0, 3);

    var n = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, Math.round(Number(players) || 0)));
    return { players: n, counts: counts, seats: shuffle(seats), bluffs: bluffs,
      applied: applied, notes: notes, short: short };
  }

  var api = {
    TEAMS: TEAMS, LABEL: LABEL, PLURAL: PLURAL, BASE: BASE,
    MIN_PLAYERS: MIN_PLAYERS, MAX_PLAYERS: MAX_PLAYERS,
    baseCounts: baseCounts, parseSetup: parseSetup, describeMod: describeMod,
    applyDelta: applyDelta, outsiderRange: outsiderRange, deal: deal
  };
  if (typeof window !== 'undefined') window.SetupRules = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
