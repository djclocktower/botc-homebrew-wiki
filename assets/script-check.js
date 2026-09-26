/* script-check.js: the Script Builder's "Script Check" panel.
 *
 * Everything a script designer usually works out on paper, from the roster
 * alone: is the team balance what players expect, how many people can this
 * script seat, which characters move the setup and what to, how busy the
 * nights are, what the tags say the script is about, and the handful of
 * mistakes that are easy to miss (no Demon, a name used twice, a Choirboy
 * with no King).
 *
 * It judges nothing it cannot count. The team targets are the two sizes the
 * official scripts come in — 13/4/4/4 for a full script, 6/2/2/1 for a
 * Teensyville one — and they are shown as what players expect, not as rules:
 * plenty of good homebrew scripts are neither.
 *
 * Setup text is read by assets/setup-rules.js, the same parser Deal a Game
 * uses, so the panel and the dealer never disagree about what a Baron does.
 *
 * ScriptCheck.html(chars, opts) is pure (no DOM) and is what the tests call;
 * ScriptCheck.mount(el, {getChars, getJinxCount}) draws it and redraws on
 * render(). Styles are .sc-* in assets/play.css.
 */
(function () {
  'use strict';

  var TEAMS = ['townsfolk', 'outsider', 'minion', 'demon'];
  var LABEL = { townsfolk: 'Townsfolk', outsider: 'Outsiders', minion: 'Minions', demon: 'Demons' };
  var FULL = { townsfolk: 13, outsider: 4, minion: 4, demon: 4 };
  var TEENSY = { townsfolk: 6, outsider: 2, minion: 2, demon: 1 };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function rules() {
    if (typeof window !== 'undefined' && window.SetupRules) return window.SetupRules;
    if (typeof require === 'function') { try { return require('./setup-rules.js'); } catch (e) { /* browser */ } }
    return null;
  }
  function tagList(c) {
    var t = c && c.tags;
    var list = Array.isArray(t) ? t : String(t || '').split(',');
    return list.map(function (x) { return String(x || '').trim(); }).filter(Boolean);
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  /* Everything the panel shows, as data. */
  function analyze(chars, opts) {
    opts = opts || {};
    var R = rules();
    var list = (chars || []).filter(Boolean);
    var pools = { townsfolk: [], outsider: [], minion: [], demon: [] };
    var extras = { traveller: 0, fabled: 0, loric: 0, other: 0 };
    list.forEach(function (c) {
      if (pools[c.team]) pools[c.team].push(c);
      else if (extras[c.team] !== undefined) extras[c.team]++;
      else extras.other++;
    });
    var counts = {};
    TEAMS.forEach(function (t) { counts[t] = pools[t].length; });
    var bagSize = counts.townsfolk + counts.outsider + counts.minion + counts.demon;
    var teensy = bagSize > 0 && bagSize <= 15;
    var target = teensy ? TEENSY : FULL;

    // Player counts: a count is 'ok' when every team can be filled from the
    // sheet, 'tight' when it can but an Outsider modifier on the script could
    // ask for more Outsiders than there are, and 'short' when it cannot.
    var seats = [];
    if (R) {
      for (var n = R.MIN_PLAYERS; n <= R.MAX_PLAYERS; n++) {
        var need = R.baseCounts(n);
        var range = R.outsiderRange(n, list);
        var cells = {};
        TEAMS.forEach(function (t) { cells[t] = counts[t] >= need[t] ? 'ok' : 'short'; });
        // A bag that needs more Outsiders than the script has can still be
        // dealt when a modifier would take them away — but it is tight.
        if (cells.outsider === 'ok' && range.max > counts.outsider) cells.outsider = 'tight';
        if (cells.outsider === 'short' && range.min <= counts.outsider) cells.outsider = 'tight';
        var status = TEAMS.some(function (t) { return cells[t] === 'short'; }) ? 'short'
          : TEAMS.some(function (t) { return cells[t] === 'tight'; }) ? 'tight' : 'ok';
        seats.push({ players: n, need: need, outsiders: range, cells: cells, status: status });
      }
    }
    var playable = seats.filter(function (s) { return s.status !== 'short'; }).map(function (s) { return s.players; });

    // Setup modifiers, as the dealer will read them.
    var names = {};
    list.forEach(function (c) { names[String(c.name || '').toLowerCase()] = c; });
    var setup = [];
    if (R) {
      list.forEach(function (c) {
        var p = R.parseSetup(c.ability);
        if (!p.mods.length && !p.adds.length && !p.notes.length) {
          if (c.setup === true) setup.push({ name: c.name, team: c.team, bits: [], flagOnly: true });
          return;
        }
        var bits = p.mods.map(function (m) { return { text: R.describeMod(m) }; });
        p.adds.forEach(function (a) {
          var there = !!names[String(a).toLowerCase()];
          bits.push({ text: '+the ' + a, warn: !there, note: there ? 'on this script' : 'not on this script' });
        });
        p.notes.forEach(function (x) { bits.push({ text: x, note: 'not simulated' }); });
        setup.push({ name: c.name, team: c.team, bits: bits });
      });
    }

    // Nights. Official characters carry their positions too (official-roles.js).
    var first = list.filter(function (c) { return Number(c.firstNight) > 0; }).length;
    var other = list.filter(function (c) { return Number(c.otherNight) > 0; }).length;

    // Tags, homebrew only (official characters carry none).
    var tagCount = {}, tagShown = {}, untagged = 0, homebrew = 0;
    list.forEach(function (c) {
      if (c.official) return;
      homebrew++;
      var tags = tagList(c);
      if (!tags.length) untagged++;
      tags.forEach(function (t) {
        var k = t.toLowerCase();
        tagCount[k] = (tagCount[k] || 0) + 1;
        if (!tagShown[k]) tagShown[k] = t;
      });
    });
    var tags = Object.keys(tagCount).sort(function (a, b) {
      return tagCount[b] - tagCount[a] || (a < b ? -1 : 1);
    }).map(function (k) { return { tag: tagShown[k], count: tagCount[k] }; });

    // Things worth a second look.
    var warnings = [];
    if (list.length) {
      if (!counts.demon) warnings.push('There is no Demon, so no game can be dealt.');
      if (!counts.minion) warnings.push('There are no Minions.');
      if (counts.townsfolk < 3) warnings.push('Even a 5-player game needs 3 Townsfolk.');
      var seenName = {}, dupes = [];
      list.forEach(function (c) {
        var k = String(c.name || '').toLowerCase().trim();
        if (!k) return;
        if (seenName[k] && dupes.indexOf(c.name) === -1) dupes.push(c.name);
        seenName[k] = true;
      });
      if (dupes.length) warnings.push('More than one character is called ' + dupes.map(function (d) { return '“' + d + '”'; }).join(', ') + '. Players will not be able to tell them apart.');
      var noAbility = list.filter(function (c) { return !String(c.ability || '').trim(); });
      if (noAbility.length) warnings.push(plural(noAbility.length, 'character has', 'characters have') + ' no ability text: ' + noAbility.map(function (c) { return c.name; }).join(', ') + '.');
      var partial = list.filter(function (c) { return !c.official && c.classification === 'partial'; });
      if (partial.length) warnings.push(plural(partial.length, 'character is', 'characters are') + ' still Partial on the wiki (missing tags or almanac text): ' + partial.map(function (c) { return c.name; }).join(', ') + '.');
      setup.forEach(function (s) {
        s.bits.forEach(function (b) { if (b.warn) warnings.push(s.name + ' adds a character (' + b.text.replace(/^\+the /, 'the ') + ') who is not on this script.'); });
      });
      var tightAt = seats.filter(function (s) { return s.cells.outsider === 'tight'; }).map(function (s) { return s.players; });
      if (tightAt.length) warnings.push('At ' + rangeText(tightAt) + ' players, whether the script has enough Outsiders (it has ' + counts.outsider + ') depends on which setup changes are in play.');
    }

    return {
      total: list.length, counts: counts, extras: extras, bagSize: bagSize,
      teensy: teensy, target: target, seats: seats, playable: playable,
      setup: setup, nights: { first: first, other: other },
      tags: tags, untagged: untagged, homebrew: homebrew,
      jinxes: Number(opts.jinxCount) || 0, warnings: warnings
    };
  }

  // [5,6,7,9,10] -> "5–7 and 9–10"
  function rangeText(nums) {
    var out = [], start = null, prev = null;
    nums.concat([null]).forEach(function (n) {
      if (start === null) { start = prev = n; return; }
      if (n !== null && n === prev + 1) { prev = n; return; }
      out.push(start === prev ? String(start) : start + '–' + prev);
      start = prev = n;
    });
    return out.length > 1 ? out.slice(0, -1).join(', ') + ' and ' + out[out.length - 1] : (out[0] || '');
  }

  function html(chars, opts) {
    var a = analyze(chars, opts);
    if (!a.total) return '<p class="sc-empty">Add characters to your script and this panel will check its balance, how many players it seats and what changes the setup.</p>';
    var h = '';

    // Headline.
    var seatLine = a.playable.length ? 'Seats ' + rangeText(a.playable) + ' players' : 'Cannot seat a game yet';
    h += '<div class="sc-head">' +
      '<span class="sc-head-big">' + plural(a.total, 'character') + '</span>' +
      '<span class="sc-head-sub">' + TEAMS.map(function (t) { return a.counts[t]; }).join(' / ') +
        (a.extras.traveller ? ' + ' + plural(a.extras.traveller, 'Traveller') : '') +
        (a.extras.fabled ? ' + ' + a.extras.fabled + ' Fabled' : '') +
        (a.extras.loric ? ' + ' + a.extras.loric + ' Loric' : '') + '</span>' +
      // The verdict pill, unless the caller already shows the same line as
      // the panel's heading (the Script Builder does).
      (opts && opts.noSeatPill ? '' : '<span class="sc-seat ' + (a.playable.length ? 'ok' : 'short') + '">' + esc(seatLine) + '</span>') +
      '</div>';

    // Team balance.
    h += '<h4 class="sc-h">Team balance <span class="sc-h-sub">compared with ' +
      (a.teensy ? 'a Teensyville script (6 / 2 / 2 / 1)' : 'a full script (13 / 4 / 4 / 4)') + '</span></h4>';
    h += '<div class="sc-bars">';
    TEAMS.forEach(function (t) {
      var have = a.counts[t], want = a.target[t];
      var pct = Math.min(100, Math.round(have / Math.max(want, 1) * 100));
      var state = have === want ? 'ok' : have > want ? 'over' : 'under';
      var say = have === want ? '✓' : have > want ? (have - want) + ' more than usual' : (want - have) + ' fewer than usual';
      h += '<div class="sc-bar sc-' + t + ' ' + state + '">' +
        '<span class="sc-bar-label">' + LABEL[t] + '</span>' +
        '<span class="sc-bar-track"><span class="sc-bar-fill" style="width:' + pct + '%"></span></span>' +
        '<span class="sc-bar-num">' + have + '<span class="sc-bar-of"> / ' + want + '</span></span>' +
        '<span class="sc-bar-say">' + say + '</span></div>';
    });
    h += '</div>';

    // Player counts, laid out like the official setup sheet.
    if (a.seats.length) {
      h += '<h4 class="sc-h">Player counts <span class="sc-h-sub">what the bag needs at each table size</span></h4>';
      h += '<div class="sc-table-wrap"><table class="sc-table"><thead><tr><th scope="col">Players</th>';
      a.seats.forEach(function (s) { h += '<th scope="col" class="sc-col-' + s.status + '">' + s.players + '</th>'; });
      h += '</tr></thead><tbody>';
      TEAMS.forEach(function (t) {
        h += '<tr><th scope="row">' + LABEL[t] + ' <span class="sc-have">(' + a.counts[t] + ')</span></th>';
        a.seats.forEach(function (s) {
          var cell = s.cells[t];
          var txt = String(s.need[t]), range = false;
          if (t === 'outsider' && (s.outsiders.max !== s.need[t] || s.outsiders.min !== s.need[t])) {
            range = s.outsiders.min !== s.outsiders.max;
            txt = range ? s.outsiders.min + '–' + s.outsiders.max : String(s.outsiders.max);
          }
          h += '<td class="sc-' + cell + (range ? ' sc-range' : '') + '"' + (cell !== 'ok' ? ' title="' + (cell === 'short' ? 'Not enough ' + LABEL[t] + ' on the script' : 'Could run short if a modifier asks for more') + '"' : '') + '>' + txt + '</td>';
        });
        h += '</tr>';
      });
      h += '</tbody></table></div>';
      h += '<p class="sc-legend"><span class="sc-key sc-ok"></span> enough <span class="sc-key sc-tight"></span> could run short <span class="sc-key sc-short"></span> not enough. Outsider ranges include the modifiers on this script.</p>';
    }

    // Setup.
    h += '<h4 class="sc-h">Setup changes</h4>';
    if (!a.setup.length) {
      h += '<p class="sc-quiet">Nothing on this script changes the setup. Every game uses the standard counts above.</p>';
    } else {
      h += '<ul class="sc-setup">';
      a.setup.forEach(function (s) {
        h += '<li><span class="sc-setup-name sc-t-' + esc(s.team) + '">' + esc(s.name) + '</span> ';
        if (s.flagOnly) h += '<span class="sc-setup-bit sc-note">changes setup (check its ability)</span>';
        s.bits.forEach(function (b) {
          h += '<span class="sc-setup-bit' + (b.warn ? ' sc-warn' : '') + (b.note === 'not simulated' ? ' sc-note' : '') + '">' + esc(b.text) +
            (b.note && b.note !== 'not simulated' ? ' <em>(' + esc(b.note) + ')</em>' : '') + '</span>';
        });
        h += '</li>';
      });
      h += '</ul>';
    }

    // Nights + jinxes.
    h += '<h4 class="sc-h">Nights</h4>';
    h += '<p class="sc-stats"><span><strong>' + a.nights.first + '</strong> wake on the first night</span>' +
      '<span><strong>' + a.nights.other + '</strong> wake on other nights</span>' +
      '<span><strong>' + a.jinxes + '</strong> ' + (a.jinxes === 1 ? 'jinx' : 'jinxes') + '</span></p>';

    // Tags.
    if (a.homebrew) {
      h += '<h4 class="sc-h">What the tags say <span class="sc-h-sub">homebrew characters only</span></h4>';
      if (a.tags.length) {
        h += '<p class="sc-tags">' + a.tags.slice(0, 14).map(function (t) {
          return '<span class="sc-tag">' + esc(t.tag) + ' <b>' + t.count + '</b></span>';
        }).join('') + '</p>';
      }
      if (a.untagged) h += '<p class="sc-quiet">' + plural(a.untagged, 'homebrew character has', 'homebrew characters have') + ' no tags yet.</p>';
    }

    // Warnings.
    if (a.warnings.length) {
      h += '<h4 class="sc-h">Worth a second look</h4><ul class="sc-warnings">' +
        a.warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>';
    } else {
      h += '<p class="sc-allgood">✓ Nothing obviously missing.</p>';
    }
    return h;
  }

  /* One line for a collapsed panel's heading, so the verdict shows without
     opening it: "Seats 5–15 players · 2 things to check". */
  function summary(chars, opts) {
    var a = analyze(chars, opts);
    if (!a.total) return 'Balance, player counts and setup, once your script has characters.';
    var bits = [a.playable.length ? 'Seats ' + rangeText(a.playable) + ' players' : 'Cannot seat a game yet'];
    bits.push(a.warnings.length ? plural(a.warnings.length, 'thing') + ' to check' : 'nothing obviously missing');
    return bits.join(' \u00b7 ');
  }

  function mount(el, o) {
    o = o || {};
    function render() {
      if (!el) return;
      var chars = typeof o.getChars === 'function' ? o.getChars() : [];
      var jinx = typeof o.getJinxCount === 'function' ? o.getJinxCount(chars) : 0;
      el.innerHTML = html(chars, { jinxCount: jinx, noSeatPill: !!o.summaryEl });
      if (o.summaryEl) o.summaryEl.textContent = summary(chars, { jinxCount: jinx });
    }
    render();
    return { render: render };
  }

  var api = { analyze: analyze, html: html, summary: summary, mount: mount, rangeText: rangeText, FULL: FULL, TEENSY: TEENSY };
  if (typeof window !== 'undefined') window.ScriptCheck = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
