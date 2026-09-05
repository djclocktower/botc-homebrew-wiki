/* script-builder-tools.js — the Script Builder's pure half.
 *
 * Everything here takes characters and settings in and gives data or text
 * back: the script's shape (how many of each team it is aiming for), the
 * random fill that reaches it, the analysis the Analyse tab draws, and the
 * text formats Copy as text writes. No DOM, no fetch, no storage — so it can
 * be `node --check`ed and unit-tested with plain node
 * (migration/script-builder-test.mjs), and so the page controller
 * (script-builder.js) stays the only file that knows what a click is.
 *
 * Same split as grimforge.js and assets/bloodstar.js: the rules are worth
 * reading without a page of markup around them.
 */
(function (global) {
  'use strict';

  var TEAMS = ['townsfolk', 'outsider', 'minion', 'demon', 'traveller', 'fabled', 'loric'];
  var TEAM_LABEL = {
    townsfolk: 'Townsfolk', outsider: 'Outsider', minion: 'Minion', demon: 'Demon',
    traveller: 'Traveller', fabled: 'Fabled', loric: 'Loric'
  };
  var TEAM_INDEX = {};
  TEAMS.forEach(function (t, i) { TEAM_INDEX[t] = i; });

  /* ── the script's shape ──────────────────────────────────────────────
     How many of each team the script is aiming for. The official editions
     are all 13 / 4 / 4 / 4; Teensyville is the small-game format. A shape
     equal to the default is stored as nothing (shapeStore), so a script
     nobody touched keeps following the site's rule. */
  var SHAPES = [
    { key: 'standard', label: 'Standard', hint: '13 · 4 · 4 · 4, like every official edition',
      shape: { townsfolk: 13, outsider: 4, minion: 4, demon: 4, traveller: 0, fabled: 0, loric: 0 } },
    { key: 'travellers', label: 'Standard + Travellers', hint: 'the same, with three Travellers',
      shape: { townsfolk: 13, outsider: 4, minion: 4, demon: 4, traveller: 3, fabled: 0, loric: 0 } },
    { key: 'teensy', label: 'Teensyville', hint: '6 · 2 · 2 · 1, for five to six players',
      shape: { townsfolk: 6, outsider: 2, minion: 2, demon: 1, traveller: 0, fabled: 0, loric: 0 } },
    { key: 'big', label: 'Big', hint: '15 · 5 · 5 · 5, for a script with more than usual',
      shape: { townsfolk: 15, outsider: 5, minion: 5, demon: 5, traveller: 0, fabled: 0, loric: 0 } },
    { key: 'none', label: 'No targets', hint: 'just count',
      shape: { townsfolk: 0, outsider: 0, minion: 0, demon: 0, traveller: 0, fabled: 0, loric: 0 } }
  ];
  var DEFAULT_SHAPE = SHAPES[0].shape;

  function normShape(s) {
    var out = {};
    TEAMS.forEach(function (t) {
      var n = s && s[t] != null ? Number(s[t]) : DEFAULT_SHAPE[t];
      if (!isFinite(n) || n < 0) n = 0;
      out[t] = Math.min(99, Math.round(n));
    });
    return out;
  }
  function shapeOf(meta) { return normShape(meta && meta.shape); }
  function shapeIsDefault(s) {
    s = normShape(s);
    return TEAMS.every(function (t) { return s[t] === DEFAULT_SHAPE[t]; });
  }
  /* What to store on the meta: nothing for the default. */
  function shapeStore(s) { return shapeIsDefault(s) ? null : normShape(s); }
  function shapeTotal(s) {
    s = normShape(s);
    return TEAMS.reduce(function (n, t) { return n + s[t]; }, 0);
  }
  function shapeKey(s) {
    s = normShape(s);
    for (var i = 0; i < SHAPES.length; i++) {
      var p = SHAPES[i].shape;
      if (TEAMS.every(function (t) { return p[t] === s[t]; })) return SHAPES[i].key;
    }
    return 'custom';
  }

  /* ── the official player-count table ──────────────────────────────────
     Townsfolk / Outsiders / Minions / Demon for 5 to 15 players, from the
     official rulebook (Outsider modifiers such as the Baron move the first
     two; that is noted, not modelled). setups() says, for each count,
     whether the script can fill every seat — a script with two Minions
     cannot seat thirteen players. */
  var PLAYER_TABLE = {
    5: [3, 0, 1, 1], 6: [3, 1, 1, 1], 7: [5, 0, 1, 1], 8: [5, 1, 1, 1], 9: [5, 2, 1, 1],
    10: [7, 0, 2, 1], 11: [7, 1, 2, 1], 12: [7, 2, 2, 1], 13: [9, 0, 3, 1], 14: [9, 1, 3, 1], 15: [9, 2, 3, 1]
  };
  var SEAT_TEAMS = ['townsfolk', 'outsider', 'minion', 'demon'];
  function setups(chars) {
    var have = countTeams(chars);
    var rows = [], maxOk = 0, minOk = 0;
    Object.keys(PLAYER_TABLE).map(Number).sort(function (a, b) { return a - b; }).forEach(function (n) {
      var need = PLAYER_TABLE[n];
      var short = [];
      SEAT_TEAMS.forEach(function (t, i) { if (have[t] < need[i]) short.push(t); });
      rows.push({ players: n, need: need, short: short, ok: !short.length });
      if (!short.length) { maxOk = n; if (!minOk) minOk = n; }
    });
    return { rows: rows, minOk: minOk, maxOk: maxOk };
  }

  /* ── counting ── */
  function countTeams(chars) {
    var c = {};
    TEAMS.forEach(function (t) { c[t] = 0; });
    (chars || []).forEach(function (ch) {
      if (ch && c[ch.team] != null) c[ch.team]++;
    });
    return c;
  }

  /* ── filling a script at random ──────────────────────────────────────
     fillPlan(): the slugs to ADD so every team reaches its target, drawn
     from `pool` (the characters the panel is showing), never one already on
     the script. randomPlan(): a whole new script — everyone unlocked goes,
     the locked ones stay, and the rest is drawn to the shape. Both take an
     `rng` so a test can be deterministic; Math.random is the default. */
  function shuffle(arr, rng) {
    rng = rng || Math.random;
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  function fillPlan(pool, current, shape, rng) {
    shape = normShape(shape);
    var have = countTeams(current);
    var on = {};
    (current || []).forEach(function (c) { if (c) on[c.slug] = 1; });
    var byTeam = {};
    (pool || []).forEach(function (c) {
      if (!c || on[c.slug] || TEAM_INDEX[c.team] == null) return;
      (byTeam[c.team] = byTeam[c.team] || []).push(c);
    });
    var add = [], short = {};
    TEAMS.forEach(function (t) {
      var need = shape[t] - (have[t] || 0);
      if (need <= 0) return;
      var draw = shuffle((byTeam[t] || []).slice(), rng).slice(0, need);
      add = add.concat(draw.map(function (c) { return c.slug; }));
      if (draw.length < need) short[t] = need - draw.length;
    });
    return { add: add, short: short };
  }
  function randomPlan(pool, current, shape, locks, rng) {
    var lockSet = {};
    (locks || []).forEach(function (s) { lockSet[s] = 1; });
    var kept = (current || []).filter(function (c) { return c && lockSet[c.slug]; });
    var plan = fillPlan(pool, kept, shape, rng);
    return { slugs: kept.map(function (c) { return c.slug; }).concat(plan.add), short: plan.short, kept: kept.length };
  }

  /* ── analysis ─────────────────────────────────────────────────────────
     What the Analyse tab says about a script. `ctx` carries what only the
     page can compute: jinxes (PageRender.scriptJinxes), night
     (PageRender.nightItems), the shape, the locks, and `allBySlug` for the
     jinx suggestions. Everything comes back as plain data; the controller
     draws it. */
  function tagsOf(c) {
    return String((c && c.tags) || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean);
  }
  function hasTag(c, names) {
    var mine = tagsOf(c).map(function (t) { return t.toLowerCase(); });
    return names.some(function (n) { return mine.indexOf(n.toLowerCase()) !== -1; });
  }
  function isSetup(c) {
    if (!c) return false;
    if (Array.isArray(c.special) && c.special.some(function (s) { return s && s.name === 'setup'; })) return true;
    if (c.setup === true) return true;
    return /\[[^\]]+\]/.test(String(c.ability || ''));
  }
  function creditNames(c) {
    if (!c || c.official) return c && c.official ? ['The Pandemonium Institute'] : [];
    var raw = String(c.creator || '');
    if (typeof global.splitCreators === 'function') {
      try { return global.splitCreators(raw); } catch (e) { /* fall through */ }
    }
    return raw.split(',').map(function (n) { return n.trim(); }).filter(Boolean);
  }

  function analyse(chars, ctx) {
    chars = (chars || []).filter(Boolean);
    ctx = ctx || {};
    var shape = normShape(ctx.shape);
    var counts = countTeams(chars);
    var total = chars.length;
    var official = chars.filter(function (c) { return c.official; }).length;

    // teams against the shape
    var teams = TEAMS.map(function (t) {
      return { team: t, label: TEAM_LABEL[t], have: counts[t], want: shape[t] };
    });

    // night
    var first = 0, other = 0, never = 0;
    chars.forEach(function (c) {
      var f = Number(c.firstNight) > 0, o = Number(c.otherNight) > 0;
      if (f) first++;
      if (o) other++;
      if (!f && !o) never++;
    });

    // tags
    var tagCount = {};
    chars.forEach(function (c) {
      tagsOf(c).forEach(function (t) { tagCount[t] = (tagCount[t] || 0) + 1; });
    });
    var tags = Object.keys(tagCount).map(function (t) { return { tag: t, n: tagCount[t] }; })
      .sort(function (a, b) { return b.n - a.n || a.tag.localeCompare(b.tag); });

    // creators
    var credit = {};
    chars.forEach(function (c) {
      creditNames(c).forEach(function (n) { credit[n] = (credit[n] || 0) + 1; });
    });
    var creators = Object.keys(credit).map(function (n) { return { name: n, n: credit[n] }; })
      .sort(function (a, b) { return b.n - a.n || a.name.localeCompare(b.name); });

    // the things worth saying
    var info = chars.filter(function (c) { return hasTag(c, ['Information', 'You Start Knowing', 'True Info', 'Binary Info']); }).length;
    var misinfo = chars.filter(function (c) { return hasTag(c, ['False Info', 'Drunkenness', 'Poison', 'Misregistration']); }).length;
    var killers = chars.filter(function (c) { return hasTag(c, ['Death', 'Single-Kill', 'Multi-Kill']); }).length;
    var protect = chars.filter(function (c) { return hasTag(c, ['Protection', 'Safety Net', 'Execution Survival', 'Resurrection']); }).length;
    var setup = chars.filter(isSetup);
    var outsiderMods = chars.filter(function (c) { return hasTag(c, ['Outsider Modification']); });
    var partial = chars.filter(function (c) {
      if (c.official) return false;
      if (typeof global.isPartial === 'function') return global.isPartial(c);
      return c.classification === 'partial';
    });
    var noArt = chars.filter(function (c) { return !c.official && !c.art && !c.image; });

    // duplicate names: two pages answering to one name export as one id
    // unless the ids are qualified, and confuse a table either way
    var byName = {};
    chars.forEach(function (c) {
      var k = String(c.name || '').trim().toLowerCase();
      if (k) (byName[k] = byName[k] || []).push(c);
    });
    var dupes = Object.keys(byName).filter(function (k) { return byName[k].length > 1; })
      .map(function (k) { return byName[k][0].name; });

    // jinxes with somebody NOT on the script — the ones worth adding
    var on = {};
    chars.forEach(function (c) { on[c.slug] = 1; });
    var suggest = [];
    var seen = {};
    if (ctx.allBySlug && typeof global.resolveJinxTarget === 'function') {
      chars.forEach(function (c) {
        (c.jinxes || []).forEach(function (j) {
          var t;
          try { t = global.resolveJinxTarget(j, '', c); } catch (e) { t = null; }
          var slug = t && t.slug;
          if (!slug || on[slug] || !ctx.allBySlug[slug]) return;
          var k = c.slug + '|' + slug;
          if (seen[k]) return;
          seen[k] = 1;
          suggest.push({ from: c, to: ctx.allBySlug[slug], text: j.text || j.reason || '' });
        });
      });
    }

    var warnings = [];
    function warn(level, text, list) { warnings.push({ level: level, text: text, list: list || null }); }
    if (total && !counts.demon) warn('bad', 'There is no Demon on this script.');
    if (counts.demon > 1 && shape.demon <= 1) warn('note', counts.demon + ' Demons: the app will still pick one, but say so if that is not the plan.');
    if (total && !counts.minion) warn('bad', 'There is no Minion on this script.');
    if (total && counts.townsfolk < 5 && total >= 8) warn('warn', 'Only ' + counts.townsfolk + ' Townsfolk — the good team will be short of abilities.');
    teams.forEach(function (t) {
      if (t.want && t.have > t.want) warn('note', t.have + ' ' + t.label + ' against a target of ' + t.want + '.');
    });
    if (dupes.length) warn('warn', 'Two characters share a name: ' + dupes.join(', ') + '. The exported ids are qualified, but players will still mix them up.');
    if (partial.length) warn('warn', partial.length + ' character' + (partial.length === 1 ? ' is' : 's are') + ' unfinished on this wiki (no icon, tags or almanac text).', partial.map(function (c) { return c.name; }));
    if (noArt.length) warn('warn', noArt.length + ' character' + (noArt.length === 1 ? ' has' : 's have') + ' no icon, so the app and the sheets will show a blank.', noArt.map(function (c) { return c.name; }));
    if (total >= 10 && !info) warn('warn', 'Nobody on this script learns anything — no Information, You Start Knowing or True Info tags.');
    if (total >= 10 && !misinfo) warn('note', 'Nothing here makes information false — no Poison, Drunkenness, False Info or Misregistration.');
    if (total >= 8 && official && official / total > 0.7) warn('note', 'Mostly official characters (' + official + ' of ' + total + ').');
    if (outsiderMods.length > 3) warn('note', outsiderMods.length + ' characters change the Outsider count; setups will vary a lot.');

    var seats = setups(chars);
    if (total >= 5 && !seats.maxOk) warn('warn', 'No player count can be seated from this script: every table needs at least a Demon, a Minion and three Townsfolk.');

    return {
      total: total, official: official, homebrew: total - official,
      teams: teams, shape: shape, shapeTotal: shapeTotal(shape),
      seats: seats,
      night: { first: first, other: other, never: never },
      tags: tags, creators: creators,
      info: info, misinfo: misinfo, killers: killers, protect: protect,
      setup: setup.map(function (c) { return c.name; }),
      outsiderMods: outsiderMods.map(function (c) { return c.name; }),
      partial: partial.map(function (c) { return c.name; }),
      dupes: dupes,
      jinxes: (ctx.jinxes || []).length,
      suggest: suggest,
      warnings: warnings
    };
  }

  /* ── text formats ─────────────────────────────────────────────────────
     textExport(chars, meta, opts): the script as text, for a Discord post,
     a wiki, a plain note. opts.format: 'plain' | 'markdown' | 'discord' |
     'names'. opts.abilities / jinxes / night / rules say what to include;
     opts.jinxList and opts.nightItems are the page's own lists. */
  function textExport(chars, meta, opts) {
    chars = (chars || []).filter(Boolean);
    meta = meta || {};
    opts = opts || {};
    var fmt = opts.format || 'plain';
    var md = fmt === 'markdown' || fmt === 'discord';
    var names = fmt === 'names';
    function b(s) { return md ? '**' + s + '**' : s; }
    function h(s) { return fmt === 'markdown' ? '## ' + s : (md ? '__' + s.toUpperCase() + '__' : s.toUpperCase()); }
    var lines = [];
    var title = (meta.name || '').trim() || 'Untitled Script';
    lines.push(fmt === 'markdown' ? '# ' + title : b(title));
    if (meta.author) lines.push((md ? '*by ' + meta.author + '*' : 'by ' + meta.author));
    lines.push('');
    TEAMS.forEach(function (t) {
      var group = chars.filter(function (c) { return c.team === t; });
      if (!group.length) return;
      lines.push(h(TEAM_LABEL[t] + (names ? ' (' + group.length + ')' : '')));
      if (names) {
        lines.push(group.map(function (c) { return c.name; }).join(', '));
      } else {
        group.forEach(function (c) {
          var ab = opts.abilities !== false && c.ability ? (md ? ' — ' : ': ') + c.ability : '';
          lines.push((md ? '• ' : '- ') + b(c.name) + ab);
        });
      }
      lines.push('');
    });
    if (opts.jinxes && opts.jinxList && opts.jinxList.length) {
      lines.push(h('Jinxes'));
      opts.jinxList.forEach(function (j) {
        lines.push((md ? '• ' : '- ') + b(j.a.name + ' & ' + j.b.name) + (md ? ' — ' : ': ') + (j.text || ''));
      });
      lines.push('');
    }
    if (opts.rules && Array.isArray(meta.bootlegger) && meta.bootlegger.length) {
      lines.push(h('House rules'));
      meta.bootlegger.forEach(function (r) { if (r) lines.push((md ? '• ' : '- ') + r); });
      lines.push('');
    }
    if (opts.night && opts.nightItems) {
      [['first', 'First night'], ['other', 'Other nights']].forEach(function (col) {
        var items = opts.nightItems[col[0]] || [];
        if (!items.length) return;
        lines.push(h(col[1]));
        items.forEach(function (it, i) {
          lines.push((i + 1) + '. ' + it.c.name + (opts.reminders && it.r ? (md ? ' — ' : ': ') + it.r : ''));
        });
        lines.push('');
      });
    }
    if (opts.notes && (meta.notes || '').trim()) {
      lines.push(h('Notes'));
      lines.push(meta.notes.trim());
      lines.push('');
    }
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  }

  /* ── a share-friendly summary line, for the library and the toasts ── */
  function summary(chars) {
    var c = countTeams(chars);
    var bits = [];
    TEAMS.forEach(function (t) { if (c[t]) bits.push(c[t] + ' ' + TEAM_LABEL[t]); });
    return bits.join(', ');
  }

  global.SBTools = {
    TEAMS: TEAMS, TEAM_LABEL: TEAM_LABEL,
    SHAPES: SHAPES, DEFAULT_SHAPE: DEFAULT_SHAPE,
    normShape: normShape, shapeOf: shapeOf, shapeStore: shapeStore,
    shapeIsDefault: shapeIsDefault, shapeTotal: shapeTotal, shapeKey: shapeKey,
    countTeams: countTeams,
    fillPlan: fillPlan, randomPlan: randomPlan,
    analyse: analyse, isSetup: isSetup, tagsOf: tagsOf,
    PLAYER_TABLE: PLAYER_TABLE, setups: setups,
    textExport: textExport, summary: summary
  };
})(typeof window !== 'undefined' ? window : this);
