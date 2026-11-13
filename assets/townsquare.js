/* townsquare.js: the Town Square (/townsquare), a storyteller's grimoire.
 *
 * Its whole input is a script in the official JSON schema, which is what
 * /api/page-json already serves for every script on the wiki, what the Script
 * Builder exports and what anybody's file holds. So the tool knows nothing
 * about the wiki's own character rows: official ids are looked up in
 * roles.json + night-order.json, everything else is read off the entry.
 *
 * A game is plain data (seats, reminders, bluffs, the phase) kept in
 * localStorage under STORE, newest first, with the script it was dealt from,
 * so a reload or a dead battery loses nothing and it works offline.
 * Nothing is sent anywhere.
 *
 * The page (townsquare.html) owns the markup shell and the CSS.
 */
(function () {
  'use strict';

  var STORE = 'botc_townsquare', HANDOFF = 'botc_townsquare_in';
  var MAX_SAVED = 6, MAX_SEATS = 20, TAGS_SHOWN = 4;
  var TEAMS = ['townsfolk', 'outsider', 'minion', 'demon', 'traveller', 'fabled', 'loric'];
  var TEAM_LABEL = { townsfolk: 'Townsfolk', outsider: 'Outsiders', minion: 'Minions', demon: 'Demons',
    traveller: 'Travellers', fabled: 'Fabled', loric: 'Loric' };
  var TEAM_ONE = { townsfolk: 'Townsfolk', outsider: 'Outsider', minion: 'Minion', demon: 'Demon',
    traveller: 'Traveller', fabled: 'Fabled', loric: 'Loric' };
  var ALIGN = { townsfolk: 'good', outsider: 'good', minion: 'evil', demon: 'evil' };
  var EDITIONS = [['tb', 'Trouble Brewing'], ['bmr', 'Bad Moon Rising'], ['snv', 'Sects & Violets']];
  // The official info tokens.
  var PHRASES = ['You are', 'This is the Demon', 'These are your Minions', 'These characters are not in play',
    'This character selected you', 'This player is', 'Use your ability?', 'Make a choice',
    'Did you vote today?', 'Did you nominate today?'];
  // The night's steps that are not characters; wording as on a script page
  // (NIGHT_MARK_TEXT in render-page.js), positions as in night-order.json.
  var META = [
    { id: '@dusk', name: 'Dusk', fn: 0, on: 0, r: 'Check that all eyes are closed. Some Travellers act.' },
    { id: '@minioninfo', name: 'Minion Info', fn: 20, r: 'Wake all Minions. Show them the Demon and each other.' },
    { id: '@demoninfo', name: 'Demon Info', fn: 24, r: 'Wake the Demon. Show them their Minions and three bluffs.' },
    { id: '@dawn', name: 'Dawn', fn: 9999, on: 9999, r: 'Wait a few seconds. Call for eyes open.' }
  ];
  var ICON = {
    undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
    eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
    eyeoff: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM4 4l16 16',
    card: 'M5 3h14v18H5zM9 8h6M9 12h6',
    menu: 'M4 6h16M4 12h16M4 18h16',
    left: 'M15 5l-7 7 7 7', right: 'M9 5l7 7-7 7', x: 'M5 5l14 14M19 5 5 19',
    moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
    sun: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12 1v3M12 20v3M1 12h3M20 12h3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1',
    list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01'
  };

  // The rules, for migration/tests/townsquare.test.mjs (run with no page).
  window.TownSquare = { baseCounts: baseCounts, outsiderShift: outsiderShift, randomBag: randomBag,
    parseScript: parseScript, orderSteps: orderSteps };
  if (typeof document === 'undefined' || !document.getElementById('ts-app')) return;

  var el = {
    start: document.getElementById('ts-start'), game: document.getElementById('ts-game'),
    bar: document.getElementById('ts-bar'), board: document.getElementById('ts-board'),
    strip: document.getElementById('ts-strip'), list: document.getElementById('ts-list'),
    dlg: document.getElementById('ts-dlg'), show: document.getElementById('ts-show'),
    hero: document.getElementById('ts-hero')
  };

  var saved = [];          // every kept game, newest first
  var game = null;         // the one on the table
  var byId = Object.create(null);           // game.chars by id
  var undo = [];
  var ui = { moving: -1, vote: null, cards: null, card: 0, dealt: false, died: -1 };

  /* ── small things ── */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function key(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function fold(s) { return String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
  function icon(n) {
    return '<svg class="ts-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="' + ICON[n] + '"/></svg>';
  }
  function shuffle(a) {
    a = a.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  // Creator marks on a name (the ∇ on Academy characters) stay off tokens,
  // as in the Token Tool.
  function tokenName(name) {
    return String(name || '').replace(/[\p{Sm}\p{So}\p{Sk}\uFE00-\uFE0F]/gu, '').replace(/\s+/g, ' ').trim();
  }
  // *YOU ARE* in a night reminder is the official sheet's bold.
  function reminderHTML(s) { return esc(s).replace(/\*([^*]+)\*/g, '<b>$1</b>'); }

  /* ── the official roster ── */
  var officialsP = null;
  function loadOfficials() {
    if (!officialsP) {
      officialsP = Promise.all([
        window.BotcData.json(window.BotcData.asset('roles.json')),
        window.BotcData.json(window.BotcData.asset('night-order.json')).catch(function () { return null; })
      ]).then(function (r) {
        var raw = Object.create(null);
        r[0].forEach(function (x) { if (x && x.id) raw[key(x.id)] = x; });
        var map = Object.create(null), list = [];
        window.OfficialRoles.buildOfficialRoles(r[0], r[1]).forEach(function (o) {
          var id = key(o.id), x = raw[id] || {};
          var c = { id: id, name: o.name, team: o.team, ability: o.ability,
            img: '/assets/icons-sm/' + id + '.webp', fb: o.image || '',
            rem: strings(x.reminders), remG: strings(x.remindersGlobal),
            fn: o.firstNight, on: o.otherNight, fnr: o.firstNightReminder, onr: o.otherNightReminder,
            ed: o.edition || '', off: 1 };
          map[id] = c; list.push(c);
        });
        return { map: map, list: list };
      });
      officialsP.catch(function () { officialsP = null; });
    }
    return officialsP;
  }

  /* ── a script JSON -> what the table needs ── */
  function teamOf(t) {
    t = String(t || '').toLowerCase();
    if (t === 'traveler') t = 'traveller';
    return TEAMS.indexOf(t) === -1 ? 'townsfolk' : t;
  }
  // Wiki art is drawn from its 192px thumbnail; anything else from where it is.
  function artOf(image) {
    var src = Array.isArray(image) ? image[0] : image;
    if (typeof src !== 'string' || !src) return ['', ''];
    var m = /^(?:https?:\/\/(?:www\.)?botchomebrew\.wiki)?\/assets\/art\/([^\/?#]+\.(?:png|jpe?g|webp))(?:[?#].*)?$/i.exec(src);
    if (m) return ['/assets/thumb/' + m[1] + '.webp', src];
    return /^https?:\/\//i.test(src) ? [src, ''] : ['', ''];
  }
  function parseScript(arr, off) {
    if (!Array.isArray(arr)) throw new Error('That is not a script JSON.');
    var out = { name: '', author: '', chars: [], nightOrder: null }, seen = Object.create(null);
    function nightIds(list) {
      if (!Array.isArray(list) || !list.length) return null;
      return list.map(function (x) {
        var k = key(x);
        return /^(dusk|minioninfo|demoninfo|dawn)$/.test(k) ? '@' + k : k;
      });
    }
    arr.forEach(function (e) {
      var o = typeof e === 'string' ? { id: e } : e;
      if (!o || typeof o !== 'object' || !o.id) return;
      if (o.id === '_meta') {
        out.name = String(o.name || '').slice(0, 120);
        out.author = String(o.author || '').slice(0, 120);
        var f = nightIds(o.firstNight), n = nightIds(o.otherNight);
        if (f || n) out.nightOrder = { first: f || [], other: n || [] };
        return;
      }
      var id = key(o.id);
      // The Script Builder's credits entry is not a character.
      if (!id || id === 'botchomebrewwiki' || seen[id]) return;
      var official = off.map[id], c;
      if (!o.name && !o.ability) {
        if (!official) return;            // an id nobody knows
        c = official;
      } else {
        var art = artOf(o.image);
        // An official character written out in full (a script gave it a jinx)
        // still draws from the small local icon.
        if (official && key(official.name) === key(o.name)) art = [official.img, official.fb];
        c = { id: id, name: String(o.name || o.id).slice(0, 80), team: teamOf(o.team),
          ability: String(o.ability || '').slice(0, 1200),
          img: art[0], fb: art[1],
          rem: strings(o.reminders), remG: strings(o.remindersGlobal),
          fn: Number(o.firstNight) || 0, on: Number(o.otherNight) || 0,
          fnr: String(o.firstNightReminder || '').slice(0, 1200), onr: String(o.otherNightReminder || '').slice(0, 1200) };
      }
      seen[id] = 1;
      out.chars.push(c);
    });
    if (!out.chars.length) throw new Error('No characters found in that script.');
    return out;
  }
  // The schema repeats a reminder once per printed token; the table needs each once.
  function strings(a) {
    var out = [];
    (Array.isArray(a) ? a : []).forEach(function (x) {
      if (typeof x !== 'string' || !x) return;
      x = x.slice(0, 60);
      if (out.indexOf(x) === -1 && out.length < 40) out.push(x);
    });
    return out;
  }

  /* ── setup numbers ── */
  function baseCounts(n) {
    n = clamp(n, 5, 15);
    if (n < 7) return { townsfolk: 3, outsider: n - 5, minion: 1, demon: 1 };
    var m = Math.floor((n - 7) / 3) + 1, o = (n - 7) % 3;
    return { townsfolk: n - 1 - m - o, outsider: o, minion: m, demon: 1 };
  }
  function setupNote(c) {
    var m = /\[([^\]]+)\]/.exec(c.ability || '');
    return m ? m[1] : '';
  }
  // ponytail: only "[+N Outsider]"-shaped setup text moves the bag ("+2",
  // "-1 or +1", "+0 to +2"). Anything else in brackets is shown to the
  // Storyteller as a note to settle by hand; teach this more shapes if
  // homebrew settles on them.
  function outsiderShift(c) {
    var m = /([+-]\s*\d+(?:\s*(?:or|to)\s*[+-]?\s*\d+)*)\s+Outsiders?/i.exec(setupNote(c).replace(/[\u2212\u2013]/g, '-'));
    if (!m) return 0;
    var nums = m[1].replace(/\s+(?=\d)/g, '').match(/[+-]?\d+/g).map(Number);
    if (/to/i.test(m[1]) && nums.length === 2) {
      var lo = Math.min(nums[0], nums[1]), hi = Math.max(nums[0], nums[1]);
      return lo + Math.floor(Math.random() * (hi - lo + 1));
    }
    return nums[Math.floor(Math.random() * nums.length)];
  }
  // `keep`: ids the Storyteller chose by hand. They stay, and the rest of
  // the bag is dealt round them.
  function randomBag(chars, players, keep) {
    var want = baseCounts(players), kept = Object.create(null), pool = {}, bag = [];
    (keep || []).forEach(function (id) { kept[id] = 1; });
    chars.forEach(function (c) { if (kept[c.id] && c.team !== 'traveller' && TEAMS.indexOf(c.team) < 5) bag.push(c); });
    TEAMS.forEach(function (t) { pool[t] = shuffle(chars.filter(function (c) { return c.team === t && !kept[c.id]; })); });
    function count(t) { return bag.filter(function (c) { return c.team === t; }).length; }
    function drop(t) {
      // Never trade away a hand-picked character, or one whose own setup
      // text is why the numbers are moving.
      var i = -1;
      bag.forEach(function (c, k) { if (c.team === t && !kept[c.id] && !setupNote(c)) i = k; });
      if (i === -1) return false;
      pool[t].push(bag.splice(i, 1)[0]);
      return true;
    }
    var byHand = count('outsider');
    ['demon', 'minion', 'outsider', 'townsfolk'].forEach(function (t) {
      bag = bag.concat(pool[t].splice(0, Math.max(0, want[t] - count(t))));
    });
    while (bag.length > players && drop('townsfolk')) { /* hand-picked extras take Townsfolk seats */ }
    // Outsiders chosen by hand mean the Storyteller has done this sum already.
    var shift = byHand ? 0 : bag.reduce(function (n, c) { return n + outsiderShift(c); }, 0);
    for (; shift > 0 && pool.outsider.length; shift--) { if (!drop('townsfolk')) break; bag.push(pool.outsider.shift()); }
    for (; shift < 0 && pool.townsfolk.length; shift++) { if (!drop('outsider')) break; bag.push(pool.townsfolk.shift()); }
    return bag.map(function (c) { return c.id; }).concat((keep || []).filter(function (id) {
      return !bag.some(function (c) { return c.id === id; });      // travellers, Fabled, Loric
    }));
  }

  /* ── storage ── */
  function readSaved() {
    try {
      var a = JSON.parse(localStorage.getItem(STORE));
      saved = Array.isArray(a) ? a.filter(function (g) { return g && g.key && Array.isArray(g.chars) && Array.isArray(g.seats); }) : [];
    } catch (e) { saved = []; }
  }
  function save() {
    if (!game) return;
    game.at = Date.now();
    saved = [game].concat(saved.filter(function (g) { return g.key !== game.key; })).slice(0, MAX_SAVED);
    try { localStorage.setItem(STORE, JSON.stringify(saved)); } catch (e) {}
  }
  function forget(k) {
    saved = saved.filter(function (g) { return g.key !== k; });
    try { localStorage.setItem(STORE, JSON.stringify(saved)); } catch (e) {}
  }
  var UNDO_KEYS = ['seats', 'bluffs', 'st', 'day', 'isNight', 'step'];
  // Call BEFORE changing the game: what is remembered is the state to go back to.
  function commit() {
    var snap = {};
    UNDO_KEYS.forEach(function (k) { snap[k] = game[k]; });
    undo.push(JSON.stringify(snap));
    if (undo.length > 60) undo.shift();
  }
  function changed() { save(); render(); }

  /* ── reading the game ── */
  function charOf(id) { return (id && byId[id]) || null; }
  function alignOf(s) { var c = charOf(s.c); return s.al || (c && ALIGN[c.team]) || ''; }
  function seatName(i) { return game.seats[i].name || 'Seat ' + (i + 1); }
  function playerCount() {
    return game.seats.filter(function (s) { var c = charOf(s.c); return !(c && c.team === 'traveller'); }).length;
  }
  function seatsOfTeam(t) {
    var out = [];
    game.seats.forEach(function (s, i) { var c = charOf(s.c); if (c && c.team === t) out.push(i); });
    return out;
  }
  function tally() {
    var alive = 0, votes = 0;
    game.seats.forEach(function (s) { if (!s.dead) { alive++; votes++; } else if (!s.voted) votes++; });
    return { alive: alive, votes: votes, need: Math.ceil(alive / 2) };
  }
  function tallyText() {
    var t = tally();
    return t.alive + ' alive · ' + t.votes + ' votes · ' + t.need + ' to execute';
  }
  // The night being run, or the one coming.
  function firstNight() { return game.isNight && game.day === 1; }
  function nightSteps() {
    var first = firstNight(), holders = Object.create(null), items = [];
    game.seats.forEach(function (s, i) { if (charOf(s.c)) (holders[s.c] = holders[s.c] || []).push(i); });
    var order = game.nightOrder && game.nightOrder[first ? 'first' : 'other'];
    var idx = Object.create(null);
    (order || []).forEach(function (id, i) { if (idx[id] == null) idx[id] = i; });
    META.forEach(function (m) {
      var n = first ? m.fn : m.on;
      if (n == null) return;
      if ((m.id === '@minioninfo' || m.id === '@demoninfo') && playerCount() < 7) return;
      items.push({ id: m.id, name: m.name, n: n, r: m.r, meta: 1, seats: [] });
    });
    Object.keys(holders).concat(game.st).forEach(function (id) {
      var c = charOf(id);
      if (!c) return;
      var n = first ? c.fn : c.on;
      if (!(n > 0) && idx[id] == null) return;
      items.push({ id: id, name: c.name, n: n, r: first ? c.fnr : c.onr, c: c, seats: holders[id] || [] });
    });
    return orderSteps(items, order);
  }
  // The script's own arrangement first; a step it does not list slots in
  // after the last listed one that acts before it (as on the script page).
  function orderSteps(items, order) {
    var idx = Object.create(null);
    (order || []).forEach(function (id, i) { if (idx[id] == null) idx[id] = i; });
    var arranged = items.filter(function (it) { return idx[it.id] != null; })
      .sort(function (a, b) { return idx[a.id] - idx[b.id]; });
    var keyed = arranged.map(function (it, i) { return { it: it, k: i }; });
    items.forEach(function (it) {
      if (idx[it.id] != null) return;
      var k = -0.5;
      arranged.forEach(function (a, i) { if (a.n <= it.n) k = i + 0.5; });
      keyed.push({ it: it, k: k });
    });
    return keyed.sort(function (a, b) {
      return a.k - b.k || a.it.n - b.it.n || (b.it.meta || 0) - (a.it.meta || 0) || a.it.name.localeCompare(b.it.name);
    }).map(function (x) { return x.it; });
  }

  /* ── tokens ── */
  function imgHTML(c) {
    if (!c || !c.img) return '';
    return '<img src="' + esc(c.img) + '" alt="" draggable="false" decoding="async"' +
      (c.fb ? ' data-fb="' + esc(c.fb) + '"' : '') + '>';
  }
  // opts: al (good|evil), back (text on a face-down token), inner (extra markup)
  function tokenHTML(c, opts) {
    opts = opts || {};
    if (!c) {
      return '<span class="ts-token ts-blank">' + (opts.back ? '<span class="ts-back">' + esc(opts.back) + '</span>' : '') +
        (opts.inner || '') + '</span>';
    }
    var name = tokenName(c.name).toUpperCase();
    var size = Math.min(12, 150 / Math.max(name.length, 1));
    return '<span class="ts-token' + (opts.al ? ' ' + opts.al : '') + '">' + imgHTML(c) +
      '<svg viewBox="0 0 100 100" aria-hidden="true"><text font-size="' + size.toFixed(1) + '">' +
      '<textPath href="#ts-arc" startOffset="50%" text-anchor="middle">' + esc(name) + '</textPath></text></svg>' +
      (opts.inner || '') + (opts.plate ? '<span class="ts-plate">' + esc(name) + '</span>' : '') + '</span>';
  }
  function miniHTML(c) {
    return '<span class="ts-mini">' + imgHTML(c) + '</span>';
  }

  /* ── drawing the table ── */
  function render() {
    if (!game) return;
    var town = game.view === 'town';
    el.game.classList.toggle('ts-night', !!game.isNight);
    el.game.classList.toggle('ts-town', town);

    var next = game.isNight ? 'Day ' + game.day : 'Night ' + (game.day + 1);
    el.bar.innerHTML =
      '<span class="ts-phase">' + icon(game.isNight ? 'moon' : 'sun') + (game.isNight ? 'Night ' : 'Day ') + game.day + '</span>' +
      '<button type="button" class="ts-next" data-act="phase">' + next + icon('right') + '</button>' +
      '<span class="ts-title">' + esc(game.name || 'Untitled script') + '</span>' +
      (town
        ? '<button type="button" class="ts-btn" data-act="view" aria-pressed="true" title="Show the grimoire" aria-label="Show the grimoire">' + icon('eyeoff') + '</button>'
        : '<button type="button" class="ts-btn" data-act="card" title="Show a card" aria-label="Show a card">' + icon('card') + '</button>') +
      '<button type="button" class="ts-btn" data-act="undo" title="Undo" aria-label="Undo"' + (undo.length ? '' : ' disabled') + '>' + icon('undo') + '</button>' +
      '<button type="button" class="ts-btn" data-act="menu" title="Menu" aria-label="Menu">' + icon('menu') + '</button>';

    var steps = nightSteps();
    game.step = clamp(game.step || 0, 0, Math.max(steps.length - 1, 0));
    var cur = game.isNight && !town ? steps[game.step] : null;
    var lit = {};
    if (cur) cur.seats.forEach(function (i) { lit[i] = 1; });

    var seats = game.seats.map(function (s, i) {
      var c = town ? null : charOf(s.c);
      var inner = s.dead ? '<i class="ts-shroud' + (ui.died === i ? ' ts-drop' : '') + '"></i><i class="ts-vote' + (s.voted ? ' used' : '') + '"></i>' : '';
      var tags = '';
      if (!town && s.rem.length) {
        tags = '<span class="ts-tags">' + s.rem.slice(0, TAGS_SHOWN).map(function (r) {
          return '<span class="ts-tag">' + imgHTML(charOf(r.c)) + '<span>' + esc(r.t) + '</span></span>';
        }).join('') + (s.rem.length > TAGS_SHOWN ? '<span class="ts-tag"><span>+' + (s.rem.length - TAGS_SHOWN) + '</span></span>' : '') + '</span>';
      }
      return '<button type="button" class="ts-seat' + (s.dead ? ' dead' : '') + (lit[i] ? ' lit' : '') +
        (ui.moving === i ? ' moving' : '') + (ui.vote && ui.vote.on === i ? ' block' : '') +
        (ui.vote && ui.vote.hands[i] ? ' hand' : '') + '" data-act="seat" data-i="' + i + '" style="--i:' + i + '" aria-label="' +
        esc(seatName(i) + (c ? ', ' + tokenName(c.name) : '') + (s.dead ? ', dead' : '')) + '">' +
        tokenHTML(c, { al: town ? '' : alignOf(s), back: String(i + 1), inner: inner, plate: true }) +
        '<span class="ts-pname">' + esc(seatName(i)) + '</span>' + tags + '</button>';
    }).join('');

    var centre = '<svg class="ts-sky" viewBox="0 0 24 24" aria-hidden="true"><path d="' + ICON[game.isNight ? 'moon' : 'sun'] + '"/></svg><div class="ts-centre">';
    if (!town && !ui.vote) {
      centre += '<button type="button" class="ts-bluffs" data-act="bluffs" title="Demon bluffs"><span>Bluffs</span>' +
        [0, 1, 2].map(function (k) { return miniHTML(charOf(game.bluffs[k])); }).join('') + '</button>';
      if (game.st.length) {
        centre += '<button type="button" class="ts-bluffs" data-act="st" title="Fabled and Loric">' +
          game.st.map(function (id) { return miniHTML(charOf(id)); }).join('') + '</button>';
      }
    }
    centre += '</div>';
    if (ui.vote && ui.vote.on >= 0) centre += '<i class="ts-hand"></i>';

    el.board.classList.toggle('ts-dealing', ui.dealt);
    el.board.innerHTML = seats + centre;
    ui.dealt = false; ui.died = -1;
    layout();

    // The strip under the table: the night's current step, or the day's count.
    var X = '<button type="button" class="ts-btn ts-btn-parch" data-act="unvote" aria-label="Cancel">' + icon('x') + '</button>';
    if (ui.moving >= 0) {
      el.strip.innerHTML = '<div class="ts-step ts-step-plain">Tap the seat to swap with ' + esc(seatName(ui.moving)) +
        '</div><button type="button" class="ts-btn ts-btn-parch" data-act="unmove" aria-label="Cancel">' + icon('x') + '</button>';
    } else if (ui.vote && ui.vote.on < 0) {
      el.strip.innerHTML = '<div class="ts-step ts-step-plain">Tap the player being voted on</div>' + X;
    } else if (ui.vote) {
      el.strip.innerHTML = X + '<div class="ts-step ts-step-plain ts-count"><b>' + Object.keys(ui.vote.hands).length + '</b>' +
        '<span>' + esc(seatName(ui.vote.on)) + ' · ' + tally().need + ' to execute</span></div>' +
        '<button type="button" class="ts-act ts-act-go" data-act="voted-done">Done</button>';
    } else if (cur) {
      el.strip.innerHTML =
        '<button type="button" class="ts-btn ts-btn-parch" data-act="step" data-d="-1" aria-label="Previous step"' + (game.step ? '' : ' disabled') + '>' + icon('left') + '</button>' +
        '<button type="button" class="ts-step" data-act="list">' + stepHTML(cur) + '</button>' +
        (cur.meta && /info$/.test(cur.id) ? '<button type="button" class="ts-btn ts-btn-parch" data-act="info" data-id="' + cur.id + '" title="Show the cards" aria-label="Show the cards">' + icon('card') + '</button>' : '') +
        '<span class="ts-step-n">' + (game.step + 1) + '/' + steps.length + '</span>' +
        (game.step < steps.length - 1
          ? '<button type="button" class="ts-btn ts-btn-parch" data-act="step" data-d="1" aria-label="Next step">' + icon('right') + '</button>'
          : '<button type="button" class="ts-btn ts-btn-parch" data-act="phase" title="' + next + '" aria-label="' + next + '">' + icon('sun') + '</button>');
    } else {
      el.strip.innerHTML = '<div class="ts-step ts-step-plain">' + tallyText() + '</div>' +
        (game.isNight ? '' : '<button type="button" class="ts-act" data-act="vote">Vote</button>') +
        (town ? '' : '<button type="button" class="ts-btn ts-btn-parch ts-list-open" data-act="list" title="Night order" aria-label="Night order">' + icon('list') + '</button>');
    }

    el.list.innerHTML =
      '<div class="ts-list-head"><h2>' + (firstNight() ? 'First night' : 'Other nights') + '</h2>' +
      '<button type="button" class="ts-btn ts-btn-parch ts-list-close" data-act="unlist" aria-label="Close">' + icon('x') + '</button></div>' +
      '<ol>' + steps.map(function (it, n) {
        var state = !game.isNight ? '' : n < game.step ? ' done' : n === game.step ? ' cur' : '';
        var allDead = it.seats.length && it.seats.every(function (i) { return game.seats[i].dead; });
        return '<li class="' + state + (allDead ? ' gone' : '') + '"><button type="button" class="ts-li" data-act="goto" data-n="' + n + '">' +
          stepHTML(it, true) + '</button></li>';
      }).join('') + '</ol>';
    var curLi = ui.listAt !== game.step && el.list.querySelector('li.cur');
    ui.listAt = game.step;
    if (curLi) el.list.scrollTop = Math.max(0, curLi.offsetTop - el.list.clientHeight / 2 + curLi.offsetHeight / 2);
  }
  function stepHTML(it, slot) {
    var who = it.seats.map(function (i) { return seatName(i) + (game.seats[i].dead ? ' (dead)' : ''); }).join(', ');
    return (it.c ? '<span class="ts-mini">' + imgHTML(it.c) + '</span>' : slot ? '<span class="ts-mini ts-mini-step"></span>' : '') +
      '<span class="ts-step-text"><b>' + esc(tokenName(it.name)) + '</b>' + (who ? '<i>' + esc(who) + '</i>' : '') +
      (it.r ? '<span>' + reminderHTML(it.r) + '</span>' : '') + '</span>';
  }

  /* Seats sit on a superellipse (a circle pulled toward the board's corners),
     evenly spaced by arc length, seat 1 at the top and clockwise from there:
     a phone's tall board gets about a third more rim than an ellipse would. */
  function ring(a, b, n, kx) {
    var P = 2 / 3.2, S = 720, xs = [], ys = [], cum = [0], i;
    for (i = 0; i <= S; i++) {
      var t = -Math.PI / 2 + i / S * 2 * Math.PI, c = Math.cos(t), s = Math.sin(t);
      xs.push(a * (c < 0 ? -1 : 1) * Math.pow(Math.abs(c), P));
      ys.push(b * (s < 0 ? -1 : 1) * Math.pow(Math.abs(s), P));
      // Sideways distance counts for more: neighbours along the top only
      // have to clear a token, neighbours down a side a token and a name.
      if (i) cum.push(cum[i - 1] + Math.hypot((xs[i] - xs[i - 1]) * kx, ys[i] - ys[i - 1]));
    }
    var out = [], j = 0;
    for (var k = 0; k < n; k++) {
      var target = cum[S] * k / n;
      while (cum[j] < target) j++;
      out.push([xs[j], ys[j]]);
    }
    return { pts: out, per: cum[S] };
  }
  function layout() {
    if (!game || el.game.hidden) return;
    var W = el.board.clientWidth, H = el.board.clientHeight, n = game.seats.length;
    if (!W || !H || !n) return;
    // A seat is its token with the player's name under it. The token is as
    // big as the rim allows, but never so wide that the two sides of a
    // phone's table leave no room between them for reminders.
    var LABEL = 19, GAP = 8, max = Math.min(124, W * 0.235, H * 0.24), d = max, r, a, b;
    for (var pass = 0; pass < 5; pass++) {
      a = W / 2 - d / 2 - 8; b = H / 2 - (d + LABEL) / 2 - 6;
      r = ring(a, b, n, (d + LABEL + GAP) / (d + GAP + 10));
      if (pass < 4) d = clamp(r.per / n - LABEL - GAP, 36, max);
    }
    el.board.style.setProperty('--d', d.toFixed(1) + 'px');
    el.board.classList.toggle('ts-small', d < 80);
    el.board.classList.toggle('ts-narrow', W < 560);
    var nodes = el.board.querySelectorAll('.ts-seat');
    r.pts.forEach(function (p, i) {
      var node = nodes[i];
      if (!node) return;
      node.style.setProperty('--x', p[0].toFixed(1) + 'px');
      node.style.setProperty('--y', p[1].toFixed(1) + 'px');
      // Reminders hang on the side of the token that faces the middle.
      var side = Math.abs(p[0]) / a > Math.abs(p[1]) / b ? (p[0] < 0 ? 'e' : 'w') : (p[1] < 0 ? 's' : 'n');
      node.setAttribute('data-in', side);
      // Near a corner they also lean toward the middle, off the next seat.
      node.setAttribute('data-lean', side === 'e' || side === 'w' || Math.abs(p[0]) < d / 2 ? '' : p[0] > 0 ? 'l' : 'r');
    });
    // The clock hand, from the middle of the table to the player being voted on.
    var hand = el.board.querySelector('.ts-hand'), to = ui.vote && r.pts[ui.vote.on];
    if (hand && to) {
      hand.style.width = Math.max(0, Math.hypot(to[0], to[1]) - d / 2 - 10).toFixed(1) + 'px';
      hand.style.transform = 'rotate(' + Math.atan2(to[1] - LABEL / 2, to[0]).toFixed(4) + 'rad)';
    }
  }
  if (window.ResizeObserver) new ResizeObserver(layout).observe(el.board);
  else window.addEventListener('resize', layout);

  /* ── the dialog ── */
  function openDlg(html, cls) {
    el.dlg.className = 'ts-dlg' + (cls ? ' ' + cls : '');
    el.dlg.innerHTML = html;
    if (!el.dlg.open) el.dlg.showModal();
    el.dlg.scrollTop = 0;
  }
  function closeDlg() { if (el.dlg.open) el.dlg.close(); }
  function headHTML(title, sub) {
    return '<div class="ts-dlg-head"><div><h2>' + title + '</h2>' + (sub ? '<p>' + sub + '</p>' : '') + '</div>' +
      '<button type="button" class="ts-btn ts-btn-parch" data-act="close" aria-label="Close">' + icon('x') + '</button></div>';
  }
  // A press that starts and ends on the backdrop closes it.
  var downOnBackdrop = false;
  el.dlg.addEventListener('pointerdown', function (e) { downOnBackdrop = e.target === el.dlg; });
  el.dlg.addEventListener('click', function (e) { if (e.target === el.dlg && downOnBackdrop) closeDlg(); });
  el.dlg.addEventListener('close', function () { if (!el.dlg.open) { pick = null; el.dlg.innerHTML = ''; } });

  /* ── one seat ── */
  var seatOpen = -1;
  function seatSheet(i) {
    var s = game.seats[i], c = charOf(s.c), al = alignOf(s);
    seatOpen = i;
    function tog(act, on, label) {
      return '<button type="button" class="ts-tog' + (on ? ' on' : '') + '" data-act="' + act + '" aria-pressed="' + !!on + '">' + label + '</button>';
    }
    openDlg(
      '<div class="ts-dlg-head ts-seat-head">' + tokenHTML(c, { al: al, back: String(i + 1) }) +
        '<div><h2>' + (c ? esc(c.name) : 'No character') + '</h2>' +
        (c ? '<p class="ts-team ' + (ALIGN[c.team] || '') + '">' + TEAM_ONE[c.team] + '</p>' : '') + '</div>' +
        '<button type="button" class="ts-btn ts-btn-parch" data-act="close" aria-label="Close">' + icon('x') + '</button></div>' +
      (c && c.ability ? '<p class="ts-ability">' + esc(c.ability) + '</p>' : '') +
      '<label class="ts-field"><span>Player</span><input id="ts-name" type="text" maxlength="30" autocomplete="off" value="' + esc(s.name) + '" placeholder="Seat ' + (i + 1) + '"></label>' +
      '<div class="ts-togs">' + tog('dead', s.dead, 'Dead') + (s.dead ? tog('voted', s.voted, 'Vote used') : '') +
        tog('good', al === 'good', 'Good') + tog('evil', al === 'evil', 'Evil') + '</div>' +
      '<div class="ts-rems">' + s.rem.map(function (r, k) {
        return '<button type="button" class="ts-tag ts-tag-big" data-act="unrem" data-k="' + k + '" title="Remove">' +
          imgHTML(charOf(r.c)) + '<span>' + esc(r.t) + '</span>' + icon('x') + '</button>';
      }).join('') + '<button type="button" class="ts-tag ts-tag-big ts-tag-add" data-act="rem">+ Reminder</button></div>' +
      '<div class="ts-acts">' +
        (c ? '<button type="button" class="ts-act" data-act="showseat">Show</button>' : '') +
        '<button type="button" class="ts-act" data-act="char">Character</button>' +
        (game.seats.length > 1 ? '<button type="button" class="ts-act" data-act="move">Move</button>' : '') +
        '<button type="button" class="ts-act ts-act-quiet" data-act="unseat">Remove</button></div>');
  }
  el.dlg.addEventListener('change', function (e) {
    if (e.target.id !== 'ts-name' || seatOpen < 0 || !game.seats[seatOpen]) return;
    var v = e.target.value.trim().slice(0, 30);
    if (v === game.seats[seatOpen].name) return;
    commit(); game.seats[seatOpen].name = v; changed();
  });

  function reminderSheet(i) {
    var inPlay = Object.create(null), groups = [[], []];
    game.seats.forEach(function (s) { if (s.c) inPlay[s.c] = 1; });
    game.st.forEach(function (id) { inPlay[id] = 1; });
    game.chars.forEach(function (c) {
      var here = inPlay[c.id];
      (here ? c.rem.concat(c.remG) : c.remG).forEach(function (t) { groups[0].push([c, t]); });
      if (!here) c.rem.forEach(function (t) { groups[1].push([c, t]); });
    });
    function rows(g) {
      return '<div class="ts-rems">' + g.map(function (p) {
        return '<button type="button" class="ts-tag ts-tag-big" data-act="addrem" data-c="' + esc(p[0].id) + '" data-t="' + esc(p[1]) + '">' +
          imgHTML(p[0]) + '<span>' + esc(p[1]) + '</span></button>';
      }).join('') + '</div>';
    }
    openDlg(headHTML('Reminder', esc(seatName(i))) +
      (groups[0].length ? rows(groups[0]) : '') +
      '<form class="ts-field ts-inline" data-form="rem"><input id="ts-rem-text" type="text" maxlength="40" autocomplete="off" placeholder="Your own"><button type="submit" class="ts-act">Add</button></form>' +
      (groups[1].length ? '<details class="ts-more"><summary>Not in play</summary>' + rows(groups[1]) + '</details>' : ''));
  }

  /* ── the character picker ──
     One grid for every choice of characters: the bag for a new game (with
     the player count and the numbers it wants), one seat's character, a
     bluff, the Fabled, the tokens on a card. */
  var pick = null;
  function picker(o) {
    pick = o;
    o.sel = (o.selected || []).slice();
    var teams = o.teams || TEAMS;
    var body = teams.map(function (t) {
      var cs = game.chars.filter(function (c) { return c.team === t && (!o.only || o.only(c)); });
      if (!cs.length) return '';
      return '<section class="ts-pick-team" data-team="' + t + '"><h3 class="' + (ALIGN[t] || t) + '">' + TEAM_LABEL[t] +
        ' <span class="ts-pick-n"></span></h3><div class="ts-pick-grid">' + cs.map(function (c) {
          return '<button type="button" class="ts-pick" data-act="pick" data-id="' + esc(c.id) + '" aria-pressed="false">' +
            '<span class="ts-mini">' + imgHTML(c) + '</span><span>' + esc(tokenName(c.name)) + '</span></button>';
        }).join('') + '</div></section>';
    }).join('');
    openDlg(headHTML(esc(o.title)) +
      (o.bag ? '<div class="ts-players"><span>Players</span>' +
        '<button type="button" class="ts-btn ts-btn-parch" data-act="players" data-d="-1" aria-label="Fewer players">−</button>' +
        '<b id="ts-players-n"></b>' +
        '<button type="button" class="ts-btn ts-btn-parch" data-act="players" data-d="1" aria-label="More players">+</button></div>' : '') +
      (body || '<p class="ts-empty">Nothing to choose from.</p>') +
      (o.multi ? '<div class="ts-foot"><p class="ts-notes" id="ts-notes"></p>' +
        (o.bag ? '<button type="button" class="ts-act" data-act="random">Random</button>' : '') +
        '<button type="button" class="ts-act ts-act-quiet" data-act="clear">Clear</button>' +
        '<button type="button" class="ts-act ts-act-go" data-act="done">' + esc(o.go || 'Done') + '</button></div>'
        : (o.none ? '<div class="ts-foot"><button type="button" class="ts-act ts-act-quiet" data-act="none">' + esc(o.none) + '</button></div>' : '')),
      'ts-pickdlg');
    paintPick();
  }
  function paintPick() {
    var o = pick, on = Object.create(null);
    o.sel.forEach(function (id) { on[id] = 1; });
    el.dlg.querySelectorAll('.ts-pick').forEach(function (b) {
      b.setAttribute('aria-pressed', on[b.getAttribute('data-id')] ? 'true' : 'false');
    });
    var want = o.bag ? baseCounts(o.players) : null;
    el.dlg.querySelectorAll('.ts-pick-team').forEach(function (sec) {
      var t = sec.getAttribute('data-team');
      var n = o.sel.filter(function (id) { return byId[id] && byId[id].team === t; }).length;
      var span = sec.querySelector('.ts-pick-n');
      span.textContent = want && want[t] != null ? n + '/' + want[t] : (o.multi && n ? String(n) : '');
      span.classList.toggle('ok', !!(want && want[t] === n));
    });
    var pn = document.getElementById('ts-players-n');
    if (pn) pn.textContent = String(o.players);
    var notes = o.bag ? o.sel.map(function (id) { var note = setupNote(byId[id] || {}); return note ? tokenName(byId[id].name) + ': ' + note : ''; }).filter(Boolean) : [];
    var box = document.getElementById('ts-notes');
    if (box) box.textContent = notes.join('  ·  ');
  }

  /* ── cards shown to a player ── */
  function showCards(cards) {
    cards = cards.filter(Boolean);
    if (!cards.length) return;
    closeDlg();
    ui.cards = cards; ui.card = 0;
    paintCard();
    el.show.hidden = false;
  }
  function paintCard() {
    var c = ui.cards[ui.card], chars = (c.chars || []).map(charOf).filter(Boolean);
    el.show.innerHTML = '<button type="button" class="ts-btn ts-show-x" data-act="unshow" aria-label="Close">' + icon('x') + '</button>' +
      '<div class="ts-show-in">' +
      (c.title ? '<h2>' + esc(c.title) + '</h2>' : '') +
      (chars.length ? '<div class="ts-show-tokens n' + Math.min(chars.length, 4) + '">' + chars.map(function (ch) {
        return '<div>' + tokenHTML(ch, {}) + '</div>';
      }).join('') + '</div>' : '') +
      (chars.length === 1 && c.ability ? '<p class="ts-show-ability">' + esc(chars[0].ability) + '</p>' : '') +
      (c.lines && c.lines.length ? '<p class="ts-show-lines">' + c.lines.map(esc).join('<br>') + '</p>' : '') +
      (ui.cards.length > 1 ? '<p class="ts-show-n">' + (ui.card + 1) + '/' + ui.cards.length + '</p>' : '') +
      '</div>';
  }
  function hideCards() { el.show.hidden = true; el.show.innerHTML = ''; ui.cards = null; }
  el.show.addEventListener('click', function (e) {
    if (e.target.closest('[data-act="unshow"]')) return;      // the delegate below closes
    if (ui.cards && ui.card < ui.cards.length - 1) { ui.card++; paintCard(); } else hideCards();
  });
  function names(list) { return list.map(seatName); }
  function infoCards(id) {
    var demons = seatsOfTeam('demon'), minions = seatsOfTeam('minion');
    var bluffs = game.bluffs.filter(charOf);
    if (id === '@minioninfo') {
      return [demons.length ? { title: 'This is the Demon', lines: names(demons) } : null,
        minions.length ? { title: 'These are your Minions', lines: names(minions) } : null];
    }
    return [minions.length ? { title: 'These are your Minions', lines: names(minions) } : null,
      bluffs.length ? { title: 'These characters are not in play', chars: bluffs } : null];
  }

  /* ── a new game ── */
  function setup() {
    var prev = game.seats.length ? playerCount() : 0;
    picker({ title: game.name || 'New game', bag: true, multi: true, go: 'Deal', players: clamp(prev || game.players || 8, 5, 15), selected: [] });
  }
  function deal(ids, players) {
    var seated = shuffle(ids.filter(function (id) { return TEAMS.indexOf(byId[id].team) < 5; }));
    var n = clamp(Math.max(players, seated.length), 1, MAX_SEATS);
    var old = game.seats;
    if (old.length) commit();
    game.players = players;
    game.seats = [];
    for (var i = 0; i < n; i++) {
      game.seats.push({ name: (old[i] && old[i].name) || '', c: seated[i] || '', dead: false, voted: false, al: '', rem: [] });
    }
    game.st = ids.filter(function (id) { return TEAMS.indexOf(byId[id].team) >= 5; });
    game.bluffs = randomBluffs();
    game.day = 1; game.isNight = true; game.step = 0;
    ui.dealt = true;
    closeDlg();
    openGame();
    changed();
  }
  function randomBluffs() {
    var used = Object.create(null);
    game.seats.forEach(function (s) { if (s.c) used[s.c] = 1; });
    return shuffle(game.chars.filter(function (c) { return ALIGN[c.team] === 'good' && !used[c.id]; }))
      .slice(0, 3).map(function (c) { return c.id; });
  }

  /* ── every button ── */
  var acts = {
    close: closeDlg,
    seat: function (b) {
      var i = Number(b.getAttribute('data-i'));
      if (ui.moving >= 0) {
        if (i !== ui.moving) {
          commit();
          var t = game.seats[i]; game.seats[i] = game.seats[ui.moving]; game.seats[ui.moving] = t;
        }
        ui.moving = -1;
        changed();
        return;
      }
      if (ui.vote) {
        var v = ui.vote, seat = game.seats[i];
        if (v.on < 0) v.on = i;
        else if (v.hands[i]) delete v.hands[i];
        else if (!seat.dead || !seat.voted) v.hands[i] = 1;      // no vote left, no hand
        render();
        return;
      }
      if (game.view === 'town') {
        // In front of the players a tap only ever marks a death or a spent vote.
        var s = game.seats[i];
        commit();
        if (!s.dead) { s.dead = true; ui.died = i; } else if (!s.voted) s.voted = true; else { s.dead = false; s.voted = false; }
        changed();
        return;
      }
      seatSheet(i);
    },
    dead: function () { var s = game.seats[seatOpen]; commit(); s.dead = !s.dead; s.voted = false; if (s.dead) ui.died = seatOpen; changed(); seatSheet(seatOpen); },
    voted: function () { var s = game.seats[seatOpen]; commit(); s.voted = !s.voted; changed(); seatSheet(seatOpen); },
    good: function () { setAlign('good'); },
    evil: function () { setAlign('evil'); },
    rem: function () { reminderSheet(seatOpen); },
    addrem: function (b) { addReminder(b.getAttribute('data-c'), b.getAttribute('data-t')); },
    unrem: function (b) { commit(); game.seats[seatOpen].rem.splice(Number(b.getAttribute('data-k')), 1); changed(); seatSheet(seatOpen); },
    showseat: function () { showCards([{ title: 'You are', chars: [game.seats[seatOpen].c], ability: true }]); },
    char: function () {
      var i = seatOpen;
      picker({ title: seatName(i), none: 'No character', selected: [game.seats[i].c], onPick: function (id) {
        commit(); game.seats[i].c = id; changed(); seatSheet(i);
      } });
    },
    move: function () { ui.moving = seatOpen; closeDlg(); render(); },
    unmove: function () { ui.moving = -1; render(); },
    unseat: function () { commit(); game.seats.splice(seatOpen, 1); closeDlg(); changed(); },

    pick: function (b) {
      var id = b.getAttribute('data-id'), o = pick;
      if (!o.multi) { o.onPick(id); return; }
      var at = o.sel.indexOf(id);
      if (at === -1) { if (!o.max || o.sel.length < o.max) o.sel.push(id); } else o.sel.splice(at, 1);
      paintPick();
    },
    none: function () { pick.onPick(''); },
    clear: function () { pick.sel = []; paintPick(); },
    random: function () { pick.sel = randomBag(game.chars, pick.players); paintPick(); },
    players: function (b) { pick.players = clamp(pick.players + Number(b.getAttribute('data-d')), 5, 15); paintPick(); },
    done: function () {
      var o = pick;
      if (o.bag) {
        var players = o.sel.filter(function (id) { return byId[id] && TEAMS.indexOf(byId[id].team) < 4; }).length;
        deal(players < o.players ? randomBag(game.chars, o.players, o.sel) : o.sel, o.players);
        return;
      }
      o.onDone(o.sel);
    },

    vote: function () { ui.moving = -1; ui.vote = { on: -1, hands: {} }; render(); },
    unvote: function () { ui.vote = null; render(); },
    'voted-done': function () {
      var v = ui.vote, n = Object.keys(v.hands).length, need = tally().need;
      commit();
      // A dead player's raised hand is their one vote, spent.
      Object.keys(v.hands).forEach(function (i) { if (game.seats[i].dead) game.seats[i].voted = true; });
      // "On the block" follows the rules: the most votes at or over the
      // number needed; a tie for the most frees the block.
      var held = -1, most = 0;
      game.seats.forEach(function (s, i) { s.rem.forEach(function (r) { if (r.b) { held = i; most = r.b; } }); });
      if (n >= need && n >= most) {
        if (held >= 0) game.seats[held].rem = game.seats[held].rem.filter(function (r) { return !r.b; });
        if (n > most) game.seats[v.on].rem.push({ c: '', t: 'On the block: ' + n, b: n });
      }
      ui.vote = null;
      changed();
    },
    phase: function () {
      commit();
      ui.vote = null; ui.moving = -1;
      // The block is the day's; night clears it.
      if (!game.isNight) game.seats.forEach(function (s) { s.rem = s.rem.filter(function (r) { return !r.b; }); });
      if (game.isNight) game.isNight = false; else { game.isNight = true; game.day++; }
      game.step = 0;
      changed();
    },
    step: function (b) { game.step += Number(b.getAttribute('data-d')); changed(); },
    goto: function (b) {
      el.list.classList.remove('open');
      if (!game.isNight) return;
      game.step = Number(b.getAttribute('data-n')); changed();
    },
    list: function () { el.list.classList.add('open'); },
    unlist: function () { el.list.classList.remove('open'); },
    info: function (b) { showCards(infoCards(b.getAttribute('data-id'))); },

    view: function () { closeDlg(); game.view = game.view === 'town' ? 'grim' : 'town'; ui.moving = -1; changed(); },
    undo: function () {
      if (!undo.length) return;
      ui.vote = null;
      var snap = JSON.parse(undo.pop());
      UNDO_KEYS.forEach(function (k) { game[k] = snap[k]; });
      ui.moving = -1;
      changed();
    },
    bluffs: function () {
      openDlg(headHTML('Demon bluffs') +
        '<div class="ts-bluff-row">' + [0, 1, 2].map(function (k) {
          var c = charOf(game.bluffs[k]);
          return '<button type="button" class="ts-bluff" data-act="bluff" data-k="' + k + '">' + tokenHTML(c, { al: 'good' }) + '</button>';
        }).join('') + '</div>' +
        '<div class="ts-acts"><button type="button" class="ts-act" data-act="rebluff">Random</button>' +
        '<button type="button" class="ts-act" data-act="showbluffs">Show</button></div>');
    },
    bluff: function (b) {
      var k = Number(b.getAttribute('data-k')), used = Object.create(null);
      game.seats.forEach(function (s) { if (s.c) used[s.c] = 1; });
      picker({ title: 'Bluff ' + (k + 1), none: 'Empty', selected: [game.bluffs[k]], teams: TEAMS.slice(0, 4),
        only: function (c) { return !used[c.id]; },
        onPick: function (id) { commit(); game.bluffs[k] = id; changed(); acts.bluffs(); } });
    },
    rebluff: function () { commit(); game.bluffs = randomBluffs(); changed(); acts.bluffs(); },
    showbluffs: function () { showCards([{ title: 'These characters are not in play', chars: game.bluffs.filter(charOf) }]); },
    st: function () {
      openDlg(headHTML('Fabled and Loric') + game.st.map(function (id) {
        var c = charOf(id);
        return c ? '<div class="ts-st-row">' + miniHTML(c) + '<div><b>' + esc(c.name) + '</b><p>' + esc(c.ability) + '</p></div></div>' : '';
      }).join('') + '<div class="ts-acts"><button type="button" class="ts-act" data-act="pickst">Change</button></div>');
    },
    pickst: function () {
      picker({ title: 'Fabled and Loric', multi: true, teams: ['fabled', 'loric'], selected: game.st,
        onDone: function (ids) { commit(); game.st = ids; closeDlg(); changed(); } });
    },

    card: function () {
      openDlg(headHTML('Show a card') +
        '<div class="ts-phrases">' + PHRASES.map(function (p) {
          return '<button type="button" class="ts-tag ts-tag-big" data-act="phrase">' + esc(p) + '</button>';
        }).join('') + '</div>' +
        '<form class="ts-field ts-inline" data-form="card"><input id="ts-card-text" type="text" maxlength="80" autocomplete="off" placeholder="Words on the card">' +
        '<button type="submit" class="ts-act ts-act-go">Show</button></form>' +
        '<div class="ts-acts"><button type="button" class="ts-act" data-act="cardchars">Add characters</button></div>');
    },
    phrase: function (b) { var inp = document.getElementById('ts-card-text'); inp.value = b.textContent; inp.focus(); },
    cardchars: function () {
      var text = document.getElementById('ts-card-text').value;
      picker({ title: text || 'Characters', multi: true, max: 4, go: 'Show', selected: [], onDone: function (ids) {
        showCards([{ title: text, chars: ids, ability: true }]);
      } });
    },
    unshow: hideCards,

    menu: function () {
      openDlg(headHTML(esc(game.name || 'Untitled script'), game.author ? 'by ' + esc(game.author) : '') +
        '<div class="ts-menu">' +
        '<button type="button" class="ts-act" data-act="names">Player names</button>' +
        '<button type="button" class="ts-act" data-act="view">' + (game.view === 'town' ? 'Show the grimoire' : 'Hide the characters') + '</button>' +
        '<button type="button" class="ts-act" data-act="bluffs">Demon bluffs</button>' +
        (game.seats.length < MAX_SEATS ? '<button type="button" class="ts-act" data-act="addseat">Add a seat</button>' : '') +
        (game.chars.some(function (c) { return c.team === 'fabled' || c.team === 'loric'; }) ? '<button type="button" class="ts-act" data-act="pickst">Fabled and Loric</button>' : '') +
        '<button type="button" class="ts-act" data-act="newgame">New game</button>' +
        (document.documentElement.requestFullscreen ? '<button type="button" class="ts-act" data-act="full">Full screen</button>' : '') +
        '<button type="button" class="ts-act ts-act-quiet" data-act="leave">Other scripts</button></div>');
    },
    names: function () {
      openDlg(headHTML('Player names', 'One a line, from seat 1') +
        '<form data-form="names"><textarea id="ts-names" rows="' + clamp(game.seats.length, 5, 14) + '" autocomplete="off" spellcheck="false">' +
        esc(game.seats.map(function (s) { return s.name; }).join('\n')) + '</textarea>' +
        '<div class="ts-acts"><button type="submit" class="ts-act ts-act-go">Save</button></div></form>');
    },
    addseat: function () {
      commit();
      game.seats.push({ name: '', c: '', dead: false, voted: false, al: '', rem: [] });
      closeDlg(); changed();
    },
    newgame: setup,
    full: function () {
      closeDlg();
      if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(function () {});
    },
    leave: function () { closeDlg(); history.pushState(null, '', location.pathname); route(); },

    // the start screen
    open: function (b) { go(b.getAttribute('data-key')); },
    forget: function (b) { forget(b.getAttribute('data-key')); renderStart(); },
    file: function () { document.getElementById('ts-file').click(); }
  };
  function setAlign(al) {
    var s = game.seats[seatOpen], c = charOf(s.c), natural = (c && ALIGN[c.team]) || '';
    commit();
    // Only a side the character does not already have is stored; pressing
    // the side it was moved to puts it back.
    s.al = alignOf(s) === al || natural === al ? '' : al;
    changed(); seatSheet(seatOpen);
  }
  function addReminder(c, t) {
    t = String(t || '').trim().slice(0, 40);
    if (!t) return;
    commit();
    game.seats[seatOpen].rem.push({ c: c || '', t: t });
    changed(); seatSheet(seatOpen);
  }
  document.addEventListener('click', function (e) {
    if (!e.target.closest) return;
    if (!e.target.closest('#ts-list, [data-act="list"]')) el.list.classList.remove('open');
    var b = e.target.closest('[data-act]');
    if (!b || b.disabled || !acts[b.getAttribute('data-act')]) return;
    if (!b.closest('#ts-app, #ts-dlg, #ts-show')) return;
    acts[b.getAttribute('data-act')](b, e);
  });
  document.addEventListener('submit', function (e) {
    var f = e.target.getAttribute && e.target.getAttribute('data-form');
    if (!f) return;
    e.preventDefault();
    if (f === 'rem') addReminder('', document.getElementById('ts-rem-text').value);
    if (f === 'card') {
      var text = document.getElementById('ts-card-text').value.trim();
      if (text) showCards([{ title: text }]);
    }
    if (f === 'names') {
      var lines = document.getElementById('ts-names').value.split('\n');
      commit();
      game.seats.forEach(function (s, i) { s.name = String(lines[i] || '').trim().slice(0, 30); });
      closeDlg(); changed();
    }
    if (f === 'find') { var first = el.start.querySelector('.ts-result'); if (first) first.click(); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !el.show.hidden) hideCards();
  });
  // A broken thumbnail falls back to the full picture once, then goes.
  document.addEventListener('error', function (e) {
    var img = e.target;
    if (!img || img.tagName !== 'IMG' || !img.closest('#ts-app, #ts-dlg, #ts-show')) return;
    var fb = img.getAttribute('data-fb');
    if (fb) { img.removeAttribute('data-fb'); img.src = fb; } else img.remove();
  }, true);

  /* ── the start screen ── */
  var scripts = null;
  function renderStart() {
    el.start.innerHTML =
      (saved.length ? '<div class="ts-panel"><h2 class="ts-h">Continue</h2>' + saved.map(function (g) {
        return '<div class="ts-row"><button type="button" class="ts-result" data-act="open" data-key="' + esc(g.key) + '">' +
          '<b>' + esc(g.name || 'Untitled script') + '</b><span>' + g.seats.length + ' players · ' + (g.isNight ? 'Night ' : 'Day ') + g.day + '</span></button>' +
          '<button type="button" class="ts-btn ts-btn-parch" data-act="forget" data-key="' + esc(g.key) + '" title="Delete this game" aria-label="Delete this game">' + icon('x') + '</button></div>';
      }).join('') + '</div>' : '') +
      '<div class="ts-panel"><h2 class="ts-h">Pick a script</h2>' +
      '<form data-form="find"><input id="ts-q" class="ts-q" type="search" placeholder="Find a script on the wiki…" autocomplete="off" enterkeyhint="search" aria-label="Find a script"></form>' +
      '<div id="ts-results" class="ts-results"></div>' +
      '<div class="ts-quick">' + EDITIONS.map(function (ed) {
        return '<button type="button" class="ts-act" data-act="open" data-key="ed:' + ed[0] + '">' + ed[1] + '</button>';
      }).join('') + '<button type="button" class="ts-act" data-act="file">Load a JSON file</button>' +
      '<input type="file" id="ts-file" accept=".json,application/json" hidden></div>' +
      '<p class="ts-msg" id="ts-msg" role="status"></p></div>';
    paintResults();
    if (!scripts) {
      window.BotcData.json('scripts.json?fields=browse').then(function (list) { scripts = list; paintResults(); })
        .catch(function () { var box = document.getElementById('ts-results'); if (box) box.textContent = 'Could not load the wiki’s scripts.'; });
    }
  }
  function paintResults() {
    var box = document.getElementById('ts-results'), inp = document.getElementById('ts-q');
    if (!box || !scripts) return;
    var q = fold(inp.value).trim();
    var hits = scripts.filter(function (s) {
      return (s.characters || []).length && (!q || fold(s.name + ' ' + (s.author || '')).indexOf(q) !== -1);
    });
    // Nothing typed: the Curata scripts first, as the wiki's own picks.
    if (!q) hits.sort(function (a, b) { return (b.curata ? 1 : 0) - (a.curata ? 1 : 0); });
    box.innerHTML = hits.slice(0, 8).map(function (s) {
      return '<button type="button" class="ts-result" data-act="open" data-key="s:' + esc(s.slug) + '"><b>' + esc(s.name) + '</b><span>' +
        (s.author ? esc(s.author) + ' · ' : '') + s.characters.length + ' characters</span></button>';
    }).join('') || '<p class="ts-empty">No script by that name.</p>';
  }
  el.start.addEventListener('input', function (e) { if (e.target.id === 'ts-q') paintResults(); });
  el.start.addEventListener('change', function (e) {
    if (e.target.id !== 'ts-file' || !e.target.files[0]) return;
    var file = e.target.files[0];
    file.text().then(function (text) {
      return begin('file:' + file.name, JSON.parse(text), file.name.replace(/\.json$/i, ''));
    }).catch(fail);
  });
  function fail(err) {
    var msg = document.getElementById('ts-msg');
    if (!msg) { renderStart(); showStart(); msg = document.getElementById('ts-msg'); }
    msg.textContent = (err && err.message) || 'That did not work.';
  }

  /* ── opening things ── */
  function showStart() {
    game = null; byId = Object.create(null); undo = [];
    el.game.hidden = true; el.start.hidden = false; el.hero.hidden = false;
    document.documentElement.classList.remove('ts-playing');
    releaseWake();
  }
  function openGame() {
    el.start.hidden = true; el.hero.hidden = true; el.game.hidden = false;
    document.documentElement.classList.add('ts-playing');
    window.scrollTo(0, 0);
    keepAwake();
  }
  function adopt(g) {
    game = g; byId = Object.create(null); undo = [];
    ui.moving = -1;
    g.chars.forEach(function (c) { byId[c.id] = c; });
    g.st = g.st || []; g.bluffs = g.bluffs || [];
  }
  // A script nobody has dealt yet: the bag picker over an empty table.
  function begin(k, json, fallbackName) {
    return loadOfficials().then(function (off) {
      var sc = parseScript(json, off);
      adopt({ key: k, name: sc.name || fallbackName || '', author: sc.author, chars: sc.chars, nightOrder: sc.nightOrder,
        players: 8, seats: [], bluffs: [], st: [], day: 1, isNight: true, step: 0, view: 'grim' });
      setup();
    });
  }
  function fetchScript(k) {
    if (k.indexOf('s:') === 0) {
      return fetch('/api/page-json?type=script&slug=' + encodeURIComponent(k.slice(2)), { credentials: 'same-origin' })
        .then(function (r) {
          if (!r.ok) throw new Error(r.status === 404 ? 'That script is not on the wiki.' : 'Could not load that script.');
          return r.json();
        });
    }
    if (k.indexOf('ed:') === 0) {
      return loadOfficials().then(function (off) {
        var ed = k.slice(3), label = EDITIONS.filter(function (e) { return e[0] === ed; })[0];
        var ids = off.list.filter(function (c) { return c.ed === ed && TEAMS.indexOf(c.team) < 5; }).map(function (c) { return c.id; });
        return [{ id: '_meta', name: label ? label[1] : '' }].concat(ids);
      });
    }
    return Promise.reject(new Error('That game is not saved on this device.'));
  }
  function go(k) {
    var url = k.indexOf('s:') === 0 ? '?s=' + encodeURIComponent(k.slice(2)) : '?g=' + encodeURIComponent(k);
    if (location.search !== url) history.pushState(null, '', location.pathname + url);
    open(k);
  }
  function open(k) {
    var kept = saved.filter(function (g) { return g.key === k; })[0];
    if (kept && kept.seats.length) {
      adopt(JSON.parse(JSON.stringify(kept)));
      openGame(); render();
      return;
    }
    var msg = document.getElementById('ts-msg');
    if (msg) msg.textContent = 'Loading…';
    fetchScript(k).then(function (json) { return begin(k, json); }).then(function () {
      var m = document.getElementById('ts-msg'); if (m) m.textContent = '';
    }).catch(fail);
  }
  // Leaving the bag picker without dealing leaves no table behind.
  el.dlg.addEventListener('close', function () {
    if (game && !game.seats.length && !el.start.hidden) { game = null; byId = Object.create(null); }
  });
  function route() {
    closeDlg(); hideCards();
    readSaved();
    renderStart(); showStart();
    var p = new URLSearchParams(location.search);
    if (p.get('from') === 'builder') {
      var raw = null;
      try { raw = localStorage.getItem(HANDOFF); localStorage.removeItem(HANDOFF); } catch (e) {}
      history.replaceState(null, '', location.pathname + (raw ? '?g=builder' : ''));
      if (raw) {
        try { begin('builder', JSON.parse(raw), 'Script Builder').catch(fail); } catch (e) { fail(e); }
      }
      return;
    }
    if (p.get('s')) open('s:' + p.get('s'));
    else if (p.get('g')) open(p.get('g'));
  }
  window.addEventListener('popstate', route);

  /* A phone on the table should not go to sleep mid-night. */
  var wake = null;
  function keepAwake() {
    if (!navigator.wakeLock || wake || document.visibilityState !== 'visible') return;
    navigator.wakeLock.request('screen').then(function (w) {
      wake = w; w.addEventListener('release', function () { wake = null; });
    }).catch(function () {});
  }
  function releaseWake() { if (wake) { wake.release().catch(function () {}); wake = null; } }
  document.addEventListener('visibilitychange', function () { if (game && !el.game.hidden) keepAwake(); });

  route();
})();
