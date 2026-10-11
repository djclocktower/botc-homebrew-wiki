/* storyteller.js: the Storyteller Mode page (storyteller.html).
 *
 * The page controller: loading, the four tabs, localStorage, the wake lock,
 * swipes and keys. Every rule (setup counts, the bag, the night) is in
 * assets/storyteller-core.js; this file only draws it and remembers it.
 *
 * Sources:
 *   /storyteller?s={slug}  a script on the wiki, read through /api/page
 *                          (the one public route that returns its arranged
 *                          nightOrder and jinxEdits; a draft works for its
 *                          owner and approved editors)
 *   /storyteller           the Script Builder's roster in localStorage
 *                          (botc_script + botc_script_meta), READ ONLY
 *
 * Nothing is sent to the server. The game lives in localStorage under
 * botc_st:s:{slug} / botc_st:builder, so a reload, a locked phone or a
 * closed tab never loses the Storyteller's place.
 */
(function () {
  'use strict';
  var C = window.STCore, P = window.PageRender, O = window.OfficialRoles;
  if (!C || !P || !O) return;
  var ROOT = (window.BotcData && window.BotcData.root) ? window.BotcData.root() : '';
  var TEAM_LABEL = window.TEAM_LABEL || {
    townsfolk: 'Townsfolk', outsider: 'Outsider', minion: 'Minion', demon: 'Demon',
    traveller: 'Traveller', fabled: 'Fabled', loric: 'Loric'
  };
  var TABS = ['setup', 'bag', 'prep', 'night'];
  var INDEX_KEY = 'botc_st_index', INDEX_MAX = 10;

  /* The night's fixed steps. Kept as constants so /text-editor finds them. */
  var META_STEPS = {
    dusk: { title: 'Dusk', text: 'Check that every player has their eyes closed. Then begin.' },
    minioninfo: { title: 'Minion Info', text: 'Wake all Minions. Show them the THIS IS THE DEMON token and point to the Demon. If there is more than 1 Minion, let them see each other. Put them to sleep.' },
    demoninfo: { title: 'Demon Info', text: 'Wake the Demon. Show THESE ARE YOUR MINIONS and point to each Minion. Then show THESE CHARACTERS ARE NOT IN PLAY with 3 bluffs.' },
    dawn: { title: 'Dawn', text: 'Wait a few seconds. Call for eyes open, and announce who died.' }
  };
  var TXT = {
    notFound: 'We could not find that script.',
    emptyBuilder: 'Your Script Builder is empty.',
    loadFailed: 'Could not load the characters. Check your connection and reload.',
    countsHint: 'Counts follow the setup brackets we could read. Check the notes below.',
    noBag: 'No bag drawn yet.',
    everyoneForced: 'No bag drawn, so showing everyone.',
    wakeOn: 'Screen stays on while the Night tab is open.',
    travellersHint: 'Travellers are chosen by the player, not drawn.',
    officialJinxHint: 'Official jinxes may be incomplete.',
    bluffHint: 'Shown to the Demon during Demon Info.',
    stateLost: 'This browser cannot save the game, so a reload starts over.'
  };

  var S = {
    entries: [], by: {}, missing: [], source: null, key: '', state: null,
    meta: null, extras: {}, officialJinxes: null, nightOrder: {}, jinxEdits: {},
    name: '', author: '', logo: '', backHref: '', warnings: [], note: '',
    tab: 'setup', wake: null, stepsOpen: false, canSave: true
  };
  var main = document.querySelector('main.st-page');

  /* ── small helpers ────────────────────────────────────────────── */
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  // Night reminders: [[TOKEN]] is the wiki's pill, *X* the official text's
  // way of marking an info token. Escaped first, so nothing typed is markup.
  function reminderHTML(s) {
    return esc(String(s || '').replace(/:reminder:/g, '').replace(/\s{2,}/g, ' ').trim())
      .replace(/\[\[(.+?)\]\]/g, '<span class="tok">$1</span>')
      .replace(/\*([^*\n]+)\*/g, '<b>$1</b>');
  }
  function charHref(c) {
    // render-page.js charHref(), which is not exported.
    var p = c.page || ('c/' + c.slug);
    if (/^https?:/i.test(p)) return p;
    return ROOT + p.replace(/\.html$/, '');
  }
  function offsite(c) { return c && c.official ? ' target="_blank" rel="noopener"' : ''; }
  function thumb(c) { return esc(P.thumbSrc(c, ROOT)); }
  function art(c) { return esc(P.artSrc(c, ROOT)); }
  function img(c, cls, big) {
    return '<img class="' + cls + '" src="' + (big ? art(c) : thumb(c)) + '" alt="" loading="lazy" decoding="async" onerror="this.style.visibility=\'hidden\'">';
  }
  function nameHTML(c) {
    return '<span class="st-t-' + esc(c.team) + '">' + esc(c.name || c.slug) + '</span>';
  }
  function aTeam(team) { return (team === 'outsider' ? 'an ' : 'a ') + TEAM_LABEL[team]; }
  function setOf(list) { var s = {}; (list || []).forEach(function (x) { s[x] = 1; }); return s; }
  function rng() { return C.makeRng(C.newSeed()); }
  function teamOf(slug) { return S.by[slug] ? S.by[slug].team : ''; }

  /* ── storage ───────────────────────────────────────────────────── */
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { window.localStorage.removeItem(k); } catch (e) { /* nothing to do */ } }
  function readJSON(k) { try { return JSON.parse(lsGet(k)); } catch (e) { return null; } }
  function save() {
    S.canSave = lsSet(S.key, JSON.stringify(S.state));
    // The 10 most recent games are kept; older ones are dropped, so storage
    // does not grow with every script ever run.
    var idx = readJSON(INDEX_KEY);
    if (!Array.isArray(idx)) idx = [];
    idx = [S.key].concat(idx.filter(function (k) { return k !== S.key && typeof k === 'string'; }));
    idx.slice(INDEX_MAX).forEach(lsDel);
    lsSet(INDEX_KEY, JSON.stringify(idx.slice(0, INDEX_MAX)));
  }

  /* ── what is in play ─────────────────────────────────────────── */
  function st() { return S.state; }
  function inPlayList() {
    var s = st();
    return s.bag.concat(s.fabledOn, s.travellersOn);
  }
  function fakes() {
    var t = st().thinks;
    return Object.keys(t).map(function (k) { return t[k]; });
  }
  // Who has a night step: everyone in play, plus whoever a Drunk-like
  // player THINKS they are, because that player wakes as that character.
  function nightInPlay() { return setOf(inPlayList().concat(fakes())); }
  function modGroups() { return C.modsForBag(S.entries, st().bag.concat(st().fabledOn)); }
  function counts() {
    return C.adjustCounts(C.baseCounts(st().players), C.flatMods(modGroups()), st().choices);
  }
  function tally() {
    var t = { townsfolk: 0, outsider: 0, minion: 0, demon: 0 };
    st().bag.forEach(function (s) { var tm = teamOf(s); if (t.hasOwnProperty(tm)) t[tm]++; });
    return t;
  }
  function bagDrifted() {
    if (!st().bag.length) return false;
    var c = counts().counts, t = tally();
    return C.BAG_TEAMS.some(function (tm) { return c[tm] !== t[tm]; });
  }

  /* After any change to the bag: fakes for whoever thinks they are someone
     else, and three bluffs that are neither in the bag nor a fake. */
  function fixExtras() {
    var s = st(), bag = s.bag, inBag = setOf(bag);
    Object.keys(s.thinks).forEach(function (k) {
      if (!inBag[k] || inBag[s.thinks[k]] || !S.by[s.thinks[k]]) delete s.thinks[k];
    });
    bag.forEach(function (slug) {
      var team = C.thinksTeam(S.by[slug]);
      if (!team || s.thinks[slug]) return;
      var f = C.pickFake(S.entries, bag, team, fakes().concat(s.bluffs), rng());
      if (f) s.thinks[slug] = f;
    });
    var fk = setOf(fakes());
    s.bluffs = s.bluffs.filter(function (b) { return !inBag[b] && !fk[b] && S.by[b]; });
    if (bag.length && s.bluffs.length < 3) {
      s.bluffs = s.bluffs.concat(C.pickBluffs(S.entries, bag, s.bluffs.concat(fakes()), rng(), 3 - s.bluffs.length));
    }
  }
  function runDraw(opts) {
    var s = st();
    var r = C.drawBag(S.entries, {
      players: s.players, choices: s.choices, also: s.fabledOn,
      locks: opts.locks || s.locks, keep: opts.keep || [], exclude: opts.exclude || [],
      rng: C.makeRng(s.seed)
    });
    s.bag = r.bag;
    s.locks = (opts.locks || s.locks).filter(function (x) { return r.bag.indexOf(x) !== -1; });
    S.warnings = r.warnings;
    fixExtras();
  }

  /* ── loading ───────────────────────────────────────────────────── */
  function getJSON(path) {
    return fetch(path, { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }
  function loadSource() {
    var slug = new URLSearchParams(location.search).get('s');
    if (slug) {
      return getJSON('/api/page?type=script&slug=' + encodeURIComponent(slug)).then(function (res) {
        if (!res || !res.data) return { error: TXT.notFound, slug: slug };
        var d = res.data;
        return {
          slug: res.slug || slug, roster: Array.isArray(d.characters) ? d.characters : [],
          name: d.name || res.slug || slug, author: d.author || '', logo: d.logo || '',
          nightOrder: d.nightOrder || {}, jinxEdits: d.jinxEdits || {},
          back: ROOT + 's/' + encodeURIComponent(res.slug || slug), backLabel: 'Back to the script page'
        };
      });
    }
    var roster = readJSON('botc_script');
    var meta = readJSON('botc_script_meta') || {};
    if (!Array.isArray(roster) || !roster.length) return Promise.resolve({ error: TXT.emptyBuilder, builder: true });
    return Promise.resolve({
      builder: true, roster: roster.filter(function (x) { return typeof x === 'string'; }),
      name: meta.name || 'Your Script Builder script', author: meta.author || '', logo: '',
      nightOrder: (meta.nightOrder && typeof meta.nightOrder === 'object') ? meta.nightOrder : {},
      jinxEdits: (meta.jinxEdits && typeof meta.jinxEdits === 'object') ? meta.jinxEdits : {},
      back: ROOT + 'script', backLabel: 'Back to the Script Builder'
    });
  }

  function showError(msg, builder) {
    document.getElementById('st-head').innerHTML =
      '<h1 style="font-family:Dumbledor2,serif;font-weight:400;margin:0 0 8px">Storyteller Mode</h1>' +
      '<p>' + esc(msg) + '</p>' +
      '<div class="st-row-btns">' +
        (builder ? '<a class="st-btn" href="' + esc(ROOT) + 'script">Open the Script Builder</a>'
          : '<a class="st-btn" href="' + esc(ROOT) + 'scripts">Browse scripts</a><a class="st-btn" href="' + esc(ROOT) + 'script">Script Builder</a>') +
      '</div>';
  }

  function start() {
    var asset = function (p) { return ROOT + 'assets/' + p; };
    Promise.all([
      (window.BotcData ? window.BotcData.json('characters.json?fields=card') : getJSON('characters.json?fields=card')).catch(function () { return null; }),
      getJSON(asset('roles.json')),
      getJSON(asset('night-order.json')),
      getJSON(asset('official-jinxes.json')),
      loadSource()
    ]).then(function (all) {
      var src = all[4];
      if (src.error) { showError(src.error, src.builder); return; }
      if (!Array.isArray(all[0]) && !all[1]) { showError(TXT.loadFailed); return; }
      S.source = src;
      S.extras = C.officialExtras(all[1] || []);
      S.meta = all[2] && Array.isArray(all[2].meta) ? all[2].meta : null;
      if (S.meta) P.setNightMeta(S.meta);
      S.officialJinxes = all[3];
      var by = {};
      (Array.isArray(all[0]) ? all[0] : []).forEach(function (c) { if (c && c.slug) by[c.slug] = c; });
      // buildOfficialRoles() drops the reminders and the setup flag on
      // purpose; this page needs them, so they go onto its own copies.
      O.buildOfficialRoles(all[1] || [], all[2]).forEach(function (c) {
        var x = S.extras[c.slug];
        if (x) { c.reminders = x.reminders; c.remindersGlobal = x.remindersGlobal; c.setup = x.setup; }
        by[c.slug] = c;
      });
      var seen = {};
      S.missing = src.roster.filter(function (slug) { return !by[slug]; });
      S.entries = C.sortEntries(src.roster.filter(function (slug) {
        if (!by[slug] || seen[slug]) return false;
        seen[slug] = 1; return true;
      }).map(function (slug) { return by[slug]; }));
      S.by = {};
      S.entries.forEach(function (c) { S.by[c.slug] = c; });
      S.nightOrder = src.nightOrder; S.jinxEdits = src.jinxEdits;
      S.key = C.storageKey(src.builder ? { builder: true } : { slug: src.slug });
      var s = C.reconcileState(readJSON(S.key), S.entries);
      if (!s.fabledSet) {
        s.fabledOn = S.entries.filter(function (c) { return c.team === 'fabled' || c.team === 'loric'; })
          .map(function (c) { return c.slug; });
        s.fabledSet = true;
      }
      S.state = s;
      fixExtras();
      save();
      document.title = src.name + ': Storyteller Mode — BOTC HomeBrew Wiki';
      renderHead();
      document.getElementById('st-tabs').hidden = false;
      var h = (location.hash || '').slice(1);
      setTab(TABS.indexOf(h) !== -1 ? h : (s.bag.length ? 'bag' : 'setup'), true);
    });
  }

  /* ── header ────────────────────────────────────────────────────── */
  function renderHead() {
    var src = S.source;
    var logo = src.logo ? P.imgSrc(ROOT, src.logo) : '';
    var mk = C.teamCounts(S.entries).map(function (t) {
      return t.n + ' ' + (t.n === 1 ? TEAM_LABEL[t.team] : C.TEAM_PLURAL[t.team]);
    }).join(' · ');
    document.getElementById('st-head').innerHTML =
      '<div class="st-head">' +
        (logo ? '<img class="st-head-logo" src="' + esc(logo) + '" alt="" onerror="this.remove()">' : '') +
        '<div><p class="st-muted" style="margin:0">Storyteller Mode</p>' +
        '<h1>' + esc(src.name) + '</h1>' +
        (src.author ? '<p class="st-head-by">by ' + esc(src.author) + '</p>' : '') +
        '<a href="' + esc(src.back) + '">&larr; ' + esc(src.backLabel) + '</a></div>' +
      '</div>' +
      '<p class="st-note">' + esc(mk || 'No characters.') + '</p>' +
      (S.missing.length ? '<p class="st-missing">Not on the wiki: ' + esc(S.missing.join(', ')) + '</p>' : '') +
      (S.canSave ? '' : '<p class="st-missing">' + esc(TXT.stateLost) + '</p>');
  }

  /* ── tabs ──────────────────────────────────────────────────────── */
  /* The site's topbar is sticky too, and its height changes with the
     screen, so the tab bar is pinned just under wherever it ends. */
  function topbarHeight() {
    var tb = document.querySelector('.topbar');
    return tb ? Math.round(tb.getBoundingClientRect().height) : 0;
  }
  function pinTabs() {
    document.getElementById('st-tabs').style.top = topbarHeight() + 'px';
  }
  pinTabs();
  window.addEventListener('resize', pinTabs);
  if (window.ResizeObserver && document.querySelector('.topbar')) {
    new ResizeObserver(pinTabs).observe(document.querySelector('.topbar'));
  }
  function setTab(tab, initial) {
    S.tab = tab;
    TABS.forEach(function (t) {
      var b = document.getElementById('st-tab-' + t);
      b.setAttribute('aria-selected', t === tab ? 'true' : 'false');
      b.tabIndex = t === tab ? 0 : -1;
      document.getElementById('st-' + t).hidden = t !== tab;
    });
    try { history.replaceState(history.state, '', location.pathname + location.search + '#' + tab); } catch (e) { /* ignore */ }
    render();
    wantWake(tab === 'night');
    if (!initial) {
      var top = main.getBoundingClientRect().top + window.pageYOffset +
        document.getElementById('st-head').offsetHeight - topbarHeight();
      if (window.pageYOffset > top) window.scrollTo(0, top);
    }
  }

  /* Re-draw everything, keeping focus on the control that had it (each
     control carries a data-key that survives the redraw). */
  function render() {
    if (!S.state) return;
    var a = document.activeElement, key = a && a.getAttribute && a.getAttribute('data-key');
    renderSetup(); renderBag(); renderPrep(); renderNight();
    if (key) {
      var again = main.querySelector('[data-key="' + key.replace(/"/g, '') + '"]');
      if (again && again !== a) { try { again.focus({ preventScroll: true }); } catch (e) { again.focus(); } }
    }
  }
  function change() { save(); render(); }

  /* ── Setup ─────────────────────────────────────────────────────── */
  function stepper(id, label, value, act, lessLabel, moreLabel, min, max) {
    return '<div class="st-stepper" role="group" aria-labelledby="' + id + '-l">' +
      '<span class="st-stepper-label" id="' + id + '-l">' + esc(label) + '</span>' +
      '<button type="button" class="st-btn st-step-btn" data-act="' + act + '" data-d="-1" data-key="' + act + '-" aria-label="' + esc(lessLabel) + '"' + (value <= min ? ' disabled' : '') + '>&minus;</button>' +
      '<output id="' + id + '" aria-live="polite" aria-labelledby="' + id + '-l">' + value + '</output>' +
      '<button type="button" class="st-btn st-step-btn" data-act="' + act + '" data-d="1" data-key="' + act + '+" aria-label="' + esc(moreLabel) + '"' + (value >= max ? ' disabled' : '') + '>+</button>' +
      '</div>';
  }
  function modRows() {
    var s = st(), html = '';
    modGroups().forEach(function (g) {
      g.mods.forEach(function (m) {
        var k = C.choiceKey(m.slug, m.index), body = '';
        if (m.kind === 'count') {
          if (m.options.length > 1) {
            var cur = Number(s.choices[k]) || 0;
            body = '<div class="st-chips" role="group" aria-label="' + esc(g.name + ': ' + m.text) + '">' +
              m.options.map(function (o, i) {
                var lab = (o > 0 ? '+' : o < 0 ? '−' : '±') + Math.abs(o) + ' ' + (Math.abs(o) === 1 ? TEAM_LABEL[m.team] : C.TEAM_PLURAL[m.team]);
                return '<button type="button" class="st-btn st-btn-small" data-act="choice" data-k="' + esc(k) + '" data-i="' + i + '" data-key="ch-' + esc(k) + '-' + i + '" aria-pressed="' + (i === cur ? 'true' : 'false') + '">' + esc(lab) + '</button>';
              }).join('') + '</div>';
          } else {
            body = '<div class="st-muted">' + esc(m.text) + ' (applied)</div>';
          }
        } else if (m.kind === 'require') {
          var want = C.fold(m.name.replace(/^the\s+/i, ''));
          var hit = S.entries.filter(function (c) { return C.fold(c.name) === want; })[0];
          var on = hit && s.bag.indexOf(hit.slug) !== -1;
          body = '<div>' + (on ? '✓ ' : '⚠ ') + 'Needs <b>' + esc(m.name) + '</b> in play' +
            (hit ? (on ? '.' : ': not in the bag yet.') : ', which is not on this script.') + '</div>';
        } else {
          body = '<label class="st-check"><input type="checkbox" data-act="handled" data-k="' + esc(k) + '" data-key="hd-' + esc(k) + '"' + (s.handled[k] ? ' checked' : '') + '> <span>' + esc(m.text) + ' <span class="st-muted">(handled)</span></span></label>';
        }
        html += '<div class="st-mod"><div class="st-mod-who">' + nameHTML(S.by[m.slug]) + '</div>' + body + '</div>';
      });
    });
    return html;
  }
  function renderSetup() {
    var s = st(), base = C.baseCounts(s.players), adj = counts();
    var why = {};
    adj.sources.forEach(function (x) {
      (why[x.team] = why[x.team] || []).push((S.by[x.slug] || {}).name + ' ' + (x.d > 0 ? '+' : '−') + Math.abs(x.d));
      var other = x.team === 'townsfolk' ? 'outsider' : 'townsfolk';
      (why[other] = why[other] || []).push((S.by[x.slug] || {}).name + ' ' + (x.d > 0 ? '−' : '+') + Math.abs(x.d));
    });
    var rows = C.BAG_TEAMS.map(function (t) {
      var a = base[t], b = adj.counts[t];
      return '<tr><th scope="row" class="st-t-' + t + '">' + esc(C.TEAM_PLURAL[t]) +
        (why[t] ? '<span class="why">' + esc(why[t].join(', ')) + '</span>' : '') + '</th>' +
        '<td class="n">' + a + '</td><td class="n' + (a !== b ? ' chg' : '') + '">' + b + '</td></tr>';
    }).join('');
    var mods = modRows();
    var hasBag = s.bag.length > 0;
    document.getElementById('st-setup').innerHTML =
      '<div class="st-card"><h2>At the table</h2>' +
        stepper('st-players', 'Players', s.players, 'players', 'Fewer players', 'More players', C.PLAYERS_MIN, C.PLAYERS_MAX) +
        stepper('st-travellers', 'Travellers', s.travellers, 'travellers', 'Fewer travellers', 'More travellers', 0, C.TRAVELLERS_MAX) +
        '<p class="st-muted" style="margin:0">Total at the table: ' + (s.players + s.travellers) + '</p></div>' +
      '<div class="st-card"><h2>Setup counts</h2>' +
        '<table class="st-counts"><thead><tr><th scope="col">Team</th><th scope="col" class="n">Table</th><th scope="col" class="n">This game</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '<p class="st-note">' + esc(TXT.countsHint) + '</p>' +
        adj.warnings.map(function (w) { return '<p class="st-note"><b>' + esc(w) + '</b></p>'; }).join('') +
      '</div>' +
      (mods ? '<div class="st-card"><h2>Modifiers in play</h2>' + mods + '</div>'
        : (hasBag ? '' : '<div class="st-card"><p class="st-muted" style="margin:0">Setup modifiers (like the Baron’s) show here once a bag is drawn.</p></div>')) +
      '<div class="st-actions">' +
        '<button type="button" class="st-btn st-btn-primary" data-act="draw" data-key="draw">' + (hasBag ? 'Redraw the bag' : 'Draw a bag →') + '</button>' +
        (hasBag ? '<button type="button" class="st-btn" data-act="goto" data-tab="bag" data-key="go-bag">See the bag →</button>' : '') +
        '<button type="button" class="st-btn" data-act="newgame" data-key="newgame">Start a new game</button>' +
      '</div>';
  }

  /* ── Bag ───────────────────────────────────────────────────────── */
  function renderBag() {
    var s = st(), c = counts().counts, t = tally(), html = '';
    var notes = S.warnings.slice();
    if (S.note) notes.unshift(S.note);
    if (notes.length) html += '<div class="st-warn" role="status"><ul>' + notes.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul></div>';
    if (bagDrifted()) {
      html += '<div class="st-warn" role="status">The bag no longer matches the counts.' +
        '<div><button type="button" class="st-btn" data-act="fix" data-key="fix">Fix the bag</button></div></div>';
    }
    if (!s.bag.length) {
      html += '<div class="st-card"><p style="margin:0 0 10px">' + esc(TXT.noBag) + '</p>' +
        '<button type="button" class="st-btn st-btn-primary" data-act="draw" data-key="draw2">Draw a bag →</button></div>';
    }
    var locks = setOf(s.locks);
    C.BAG_TEAMS.forEach(function (team) {
      var onScript = S.entries.filter(function (x) { return x.team === team; });
      if (!onScript.length && !c[team]) return;
      var inBag = s.bag.filter(function (x) { return teamOf(x) === team; });
      var ok = inBag.length === c[team];
      html += '<div class="st-card"><div class="st-team-head"><h2 class="st-t-' + team + '">' + esc(C.TEAM_PLURAL[team]) + '</h2>' +
        '<span class="' + (ok ? '' : 'bad') + '">' + inBag.length + ' / ' + c[team] + '</span></div>';
      inBag.forEach(function (slug) {
        var ch = S.by[slug], locked = !!locks[slug];
        html += '<div class="st-char">' + img(ch, 'st-ico') + '<div class="st-char-body">' +
          '<div class="st-char-name">' + nameHTML(ch) + '</div>' +
          '<p class="st-char-ab">' + esc(ch.ability) + '</p>' +
          thinksRow(slug) +
          '<div class="st-row-btns">' +
            '<button type="button" class="st-btn st-btn-small" data-act="lock" data-slug="' + esc(slug) + '" data-key="lk-' + esc(slug) + '" aria-pressed="' + locked + '" aria-label="Lock ' + esc(ch.name) + '">' + (locked ? 'Locked' : 'Lock') + '</button>' +
            '<button type="button" class="st-btn st-btn-small" data-act="reroll" data-slug="' + esc(slug) + '" data-key="rr-' + esc(slug) + '" aria-label="Re-roll ' + esc(ch.name) + '"' + (locked ? ' disabled' : '') + '>Re-roll</button>' +
            '<button type="button" class="st-btn st-btn-small" data-act="remove" data-slug="' + esc(slug) + '" data-key="rm-' + esc(slug) + '" aria-label="Remove ' + esc(ch.name) + '">Remove</button>' +
          '</div></div></div>';
      });
      var spare = onScript.filter(function (x) { return s.bag.indexOf(x.slug) === -1; });
      if (spare.length && s.bag.length) {
        html += '<div class="st-add"><select class="st-select" data-act="add" data-key="add-' + team + '" aria-label="Add ' + esc(aTeam(team)) + ' to the bag">' +
          '<option value="">Add ' + esc(aTeam(team)) + '…</option>' +
          spare.map(function (x) { return '<option value="' + esc(x.slug) + '">' + esc(x.name) + '</option>'; }).join('') +
          '</select></div>';
      }
      html += '</div>';
    });
    html += chipCard('Fabled and Loric', ['fabled', 'loric'], 'fabledOn', '');
    html += chipCard('Travellers', ['traveller'], 'travellersOn', TXT.travellersHint);
    if (s.bag.length) {
      html += '<div class="st-actions">' +
        '<button type="button" class="st-btn" data-act="redraw" data-key="redraw">Redraw unlocked</button>' +
        '<button type="button" class="st-btn st-btn-primary" data-act="goto" data-tab="prep" data-key="go-prep">Next: Prep →</button></div>';
    }
    document.getElementById('st-bag').innerHTML = html;
  }
  function thinksRow(slug) {
    var team = C.thinksTeam(S.by[slug]);
    if (!team) return '';
    var s = st(), cur = s.thinks[slug] || '';
    var used = setOf(s.bag.concat(s.bluffs, fakes()));
    var opts = S.entries.filter(function (x) { return x.team === team && (!used[x.slug] || x.slug === cur); });
    return '<div class="st-thinks"><span>Thinks they are:</span>' +
      '<select class="st-select" data-act="fake" data-slug="' + esc(slug) + '" data-key="fk-' + esc(slug) + '" aria-label="' + esc(S.by[slug].name) + ' thinks they are">' +
        '<option value="">(choose)</option>' +
        opts.map(function (x) { return '<option value="' + esc(x.slug) + '"' + (x.slug === cur ? ' selected' : '') + '>' + esc(x.name) + '</option>'; }).join('') +
      '</select>' +
      '<button type="button" class="st-btn st-btn-small" data-act="fakereroll" data-slug="' + esc(slug) + '" data-key="fr-' + esc(slug) + '">Re-roll</button></div>';
  }
  function chipCard(title, teams, field, hint) {
    var list = S.entries.filter(function (x) { return teams.indexOf(x.team) !== -1; });
    if (!list.length) return '';
    var on = setOf(st()[field]);
    return '<div class="st-card"><h2>' + esc(title) + '</h2><div class="st-chips">' +
      list.map(function (x) {
        return '<button type="button" class="st-btn st-btn-small" data-act="toggle" data-field="' + field + '" data-slug="' + esc(x.slug) + '" data-key="tg-' + esc(x.slug) + '" aria-pressed="' + !!on[x.slug] + '">' +
          img(x, 'st-ico st-ico-sm') + esc(x.name) + (on[x.slug] ? ': in play' : '') + '</button>';
      }).join('') + '</div>' + (hint ? '<p class="st-note">' + esc(hint) + '</p>' : '') + '</div>';
  }

  /* ── Prep ──────────────────────────────────────────────────────── */
  function allJinxes() {
    return P.scriptJinxes(S.entries, S.jinxEdits)
      .concat(C.officialJinxPairs(S.officialJinxes, S.entries, S.jinxEdits));
  }
  function renderPrep() {
    var s = st(), html = '';
    if (!s.bag.length) {
      html += '<div class="st-card"><p style="margin:0 0 10px">' + esc(TXT.noBag) + ' Draw one first.</p>' +
        '<button type="button" class="st-btn" data-act="goto" data-tab="setup" data-key="go-setup">Go to Setup</button></div>';
    }
    if (s.bag.length) {
      html += '<div class="st-card"><h2>Demon bluffs</h2><div class="st-bluffs">' +
        s.bluffs.map(function (b, i) {
          var ch = S.by[b];
          return '<div class="st-bluff">' + img(ch, '', false) + '<span class="st-bluff-name">' + nameHTML(ch) + '</span>' +
            '<button type="button" class="st-btn st-btn-small" data-act="bluff" data-i="' + i + '" data-key="bl-' + i + '" aria-label="Re-roll ' + esc(ch.name) + '">Re-roll</button></div>';
        }).join('') + '</div>' +
        (s.bluffs.length < 3 ? '<p class="st-note">Not enough good characters left out of the bag for 3 bluffs.</p>' : '') +
        '<div class="st-row-btns"><button type="button" class="st-btn" data-act="bluffall" data-key="blall">Re-roll all</button></div>' +
        '<p class="st-note">' + esc(TXT.bluffHint) + '</p></div>';
    }
    // Reminder tokens.
    var r = C.reminderChecklist(S.entries, inPlayList().concat(fakes()), S.extras);
    function group(list) {
      return list.map(function (g) {
        return '<div class="st-tokens-who">' + nameHTML(S.by[g.slug]) + '</div><ul class="st-tokens">' +
          g.tokens.map(function (tk) {
            var k = g.slug + '|' + tk;
            return '<li><label class="st-check"><input type="checkbox" data-act="token" data-k="' + esc(k) + '" data-key="tk-' + esc(k) + '"' + (s.tokensDone[k] ? ' checked' : '') + '> <span>' + esc(tk) + '</span></label></li>';
          }).join('') + '</ul>';
      }).join('');
    }
    if (s.bag.length || r.global.length) {
      html += '<div class="st-card"><h2>Reminder tokens</h2>' +
        (r.inPlay.length ? '<h3>In play</h3>' + group(r.inPlay) : (s.bag.length ? '<p class="st-muted">No reminder tokens for the characters in play.</p>' : '')) +
        (r.global.length ? '<h3>Can be needed even when not in play</h3>' + group(r.global) : '') +
        (Object.keys(s.tokensDone).length ? '<div class="st-row-btns"><button type="button" class="st-btn st-btn-small" data-act="cleartokens" data-key="cleartk">Clear ticks</button></div>' : '') +
        '</div>';
    }
    // Jinxes in play.
    if (s.bag.length) {
      var jx = C.jinxesInPlay(allJinxes(), inPlayList());
      html += '<div class="st-card"><h2>Jinxes in play</h2>' +
        (jx.length ? jx.map(function (j) {
          return '<div class="st-jinx"><div class="st-jinx-pair">' + img(j.a, '') + nameHTML(j.a) + ' + ' + img(j.b, '') + nameHTML(j.b) + '</div>' +
            '<p>' + reminderHTML(j.text) + '</p></div>';
        }).join('') : '<p class="st-muted" style="margin:0">No jinxes between the characters in play.</p>') +
        '<p class="st-note">' + esc(TXT.officialJinxHint) + '</p></div>';
      // Setup notes nobody has ticked yet.
      var open = [];
      modGroups().forEach(function (g) {
        g.mods.forEach(function (m) {
          if ((m.kind === 'manual' || m.kind === 'copies') && !s.handled[C.choiceKey(m.slug, m.index)]) open.push({ g: g, m: m });
        });
      });
      if (open.length) {
        html += '<div class="st-card"><h2>Setup notes still to handle</h2>' +
          open.map(function (o) {
            var k = C.choiceKey(o.m.slug, o.m.index);
            return '<label class="st-check"><input type="checkbox" data-act="handled" data-k="' + esc(k) + '" data-key="hp-' + esc(k) + '"> <span><b>' + esc(o.g.name) + ':</b> ' + esc(o.m.text) + '</span></label>';
          }).join('') + '</div>';
      }
      html += '<div class="st-actions"><button type="button" class="st-btn st-btn-primary" data-act="firstnight" data-key="go-night">Start the first night →</button></div>';
    }
    document.getElementById('st-prep').innerHTML = html;
  }

  /* ── Night ─────────────────────────────────────────────────────── */
  function steps() {
    var s = st(), which = s.night.which;
    var everyone = s.night.everyone || !s.bag.length;
    var items = P.nightItems(S.entries, S.nightOrder)[which];
    return C.nightSteps(items, S.meta, which, { inPlay: everyone ? null : nightInPlay(), players: s.players });
  }
  function fakeOwner(slug) {
    var t = st().thinks;
    return Object.keys(t).filter(function (k) { return t[k] === slug; }).map(function (k) { return S.by[k]; });
  }
  function bagNames(team) {
    return st().bag.filter(function (x) { return teamOf(x) === team; })
      .map(function (x) { return S.by[x].name; });
  }
  function stepCard(step) {
    var s = st();
    if (step.kind === 'meta') {
      var m = META_STEPS[step.id] || { title: step.id, text: '' };
      var extra = '';
      if (step.id === 'minioninfo' || step.id === 'demoninfo') {
        var dm = bagNames('demon'), mn = bagNames('minion');
        if (dm.length || mn.length) {
          extra += '<p class="st-step-who">Demon: <b>' + esc(dm.join(', ') || '?') + '</b><br>Minions: <b>' + esc(mn.join(', ') || '?') + '</b></p>';
        }
      }
      if (step.id === 'demoninfo') {
        extra += s.bluffs.length ? '<div class="st-step-bluffs">' + s.bluffs.map(function (b) {
          return '<span>' + img(S.by[b], '') + nameHTML(S.by[b]) + '</span>';
        }).join('') + '</div>' : '<p class="st-step-who">No bluffs chosen yet (Prep tab).</p>';
      }
      var show = step.id === 'demoninfo' ? '<button type="button" class="st-btn" data-act="show" data-what="bluffs" data-key="show">Show to player</button>'
        : step.id === 'minioninfo' ? '<button type="button" class="st-btn" data-act="show" data-what="demon" data-key="show">Show to player</button>' : '';
      return '<p class="st-step-team">Step</p><h2 class="st-step-name">' + esc(m.title) + '</h2>' +
        '<p class="st-step-text">' + esc(m.text) + '</p>' + extra +
        (show ? '<div class="st-step-btns">' + show + '</div>' : '');
    }
    var c = step.c, dead = s.dead.indexOf(c.slug) !== -1;
    var badges = '';
    if (dead) badges += '<span class="st-badge">Dead</span>';
    var owners = fakeOwner(c.slug);
    var inPlay = setOf(inPlayList());
    if (s.bag.length && !inPlay[c.slug] && !owners.length) badges += '<span class="st-badge">Not in play</span>';
    var fakeNote = owners.length ? '<p class="st-step-who">Not really in play: the ' +
      owners.map(function (o) { return '<b>' + esc(o.name) + '</b>'; }).join(' and the ') +
      ' thinks they are this character.</p>' : '';
    if (C.thinksTeam(c) && s.thinks[c.slug] && S.by[s.thinks[c.slug]]) {
      fakeNote += '<p class="st-step-who">Thinks they are the <b>' + esc(S.by[s.thinks[c.slug]].name) + '</b>.</p>';
    }
    return img(c, 'st-step-art', true) +
      (badges ? '<div>' + badges + '</div>' : '') +
      '<h2 class="st-step-name">' + nameHTML(c) + '</h2>' +
      '<p class="st-step-team">' + esc(TEAM_LABEL[c.team] || c.team) + '</p>' + fakeNote +
      '<p class="st-step-text">' + (step.reminder ? reminderHTML(step.reminder) : esc(c.ability)) + '</p>' +
      '<div class="st-step-btns">' +
        '<button type="button" class="st-btn" data-act="dead" data-slug="' + esc(c.slug) + '" data-key="dead" aria-pressed="' + dead + '">' + (dead ? 'Dead' : 'Mark dead') + '</button>' +
        '<a class="st-btn" href="' + esc(charHref(c)) + '"' + offsite(c) + '>Character page ↗</a>' +
      '</div>';
  }
  function stepLabel(step) {
    if (step.kind === 'meta') return (META_STEPS[step.id] || { title: step.id }).title;
    return step.c.name;
  }
  function renderNight() {
    var s = st(), list = steps(), n = s.night;
    if (n.step >= list.length) n.step = Math.max(0, list.length - 1);
    var cur = list[n.step], last = n.step >= list.length - 1;
    var forced = !s.bag.length;
    var inPlay = setOf(inPlayList().concat(fakes()));
    var html = '<div class="st-night">' +
      '<div class="st-night-top">' +
        '<div class="st-seg" role="group" aria-label="Which night">' +
          '<button type="button" class="st-btn st-btn-small" data-act="which" data-w="first" data-key="w-first" aria-pressed="' + (n.which === 'first') + '">First night</button>' +
          '<button type="button" class="st-btn st-btn-small" data-act="which" data-w="other" data-key="w-other" aria-pressed="' + (n.which === 'other') + '">Other nights</button>' +
        '</div>' +
        '<span class="st-night-n">Night ' + n.n + '</span>' +
      '</div>' +
      '<label class="st-check"><input type="checkbox" data-act="everyone" data-key="everyone"' + (n.everyone || forced ? ' checked' : '') + (forced ? ' disabled' : '') + '> <span>Everyone on the script</span></label>' +
      (forced ? '<p class="st-night-note">' + esc(TXT.everyoneForced) + '</p>' : '') +
      '<p class="st-night-note" id="st-wake-note"' + (S.wake ? '' : ' hidden') + '>' + esc(TXT.wakeOn) + '</p>' +
      '<div aria-live="polite">' +
      (cur ? '<div class="st-step fade' + (cur.kind === 'char' && s.dead.indexOf(cur.slug) !== -1 ? ' dead' : '') + '" role="group" aria-roledescription="step" aria-label="Step ' + (n.step + 1) + ' of ' + list.length + '">' + stepCard(cur) + '</div>'
        : '<div class="st-step"><p>Nobody acts on this night.</p></div>') +
      '</div>' +
      '<details class="st-steps"' + (S.stepsOpen ? ' open' : '') + '><summary>All steps (' + list.length + ')</summary><ol>' +
        list.map(function (x, i) {
          var off = x.kind === 'char' && s.bag.length && !inPlay[x.slug];
          var dead = x.kind === 'char' && s.dead.indexOf(x.slug) !== -1;
          return '<li><button type="button" data-act="jump" data-i="' + i + '" data-key="j-' + i + '"' + (i === n.step ? ' aria-current="step"' : '') + '>' +
            '<span class="' + (off ? 'off' : '') + '">' + (i + 1) + '. ' + esc(stepLabel(x)) + (dead ? ' (dead)' : '') + '</span></button></li>';
        }).join('') + '</ol></details>' +
      '<div class="st-bar">' +
        '<button type="button" class="st-btn" data-act="prev" data-key="prev"' + (n.step <= 0 ? ' disabled' : '') + '>◀ Prev</button>' +
        '<span class="st-bar-pos">' + (list.length ? (n.step + 1) + ' / ' + list.length : '0 / 0') + '</span>' +
        (last ? '<button type="button" class="st-btn" data-act="nextnight" data-key="next">Start night ' + (n.n + 1) + ' →</button>'
          : '<button type="button" class="st-btn" data-act="next" data-key="next">Next ▶</button>') +
      '</div></div>';
    document.getElementById('st-night').innerHTML = html;
  }
  function go(d) {
    var n = st().night, len = steps().length;
    var to = Math.max(0, Math.min(len - 1, n.step + d));
    if (to === n.step) return;
    n.step = to;
    change();
  }

  /* ── show to player ────────────────────────────────────────────── */
  var showEl = document.getElementById('st-show');
  function openShow(what) {
    var s = st(), html;
    if (what === 'bluffs') {
      html = '<h2>These characters are not in play</h2><div class="st-show-bluffs">' +
        s.bluffs.map(function (b) { return '<span>' + img(S.by[b], '', true) + esc(S.by[b].name) + '</span>'; }).join('') + '</div>';
    } else {
      html = '<h2>This is the Demon</h2>';
    }
    showEl.innerHTML = html + '<p class="st-show-hint">Tap anywhere to close</p>';
    showEl.hidden = false;
    try { history.pushState({ stShow: 1 }, '', location.href); } catch (e) { /* ignore */ }
    showEl.focus();
  }
  function closeShow(fromPop) {
    if (showEl.hidden) return;
    showEl.hidden = true;
    showEl.innerHTML = '';
    if (!fromPop && history.state && history.state.stShow) history.back();
    var b = main.querySelector('[data-act="show"]');
    if (b) b.focus();
  }
  showEl.addEventListener('click', function () { closeShow(false); });
  window.addEventListener('popstate', function () { closeShow(true); });

  /* ── wake lock ─────────────────────────────────────────────────── */
  function wakeNote() {
    var el = document.getElementById('st-wake-note');
    if (el) el.hidden = !S.wake;
  }
  function wantWake(on) {
    var wl = navigator.wakeLock;
    if (on) {
      if (!wl || S.wake || document.visibilityState !== 'visible') return;
      try {
        wl.request('screen').then(function (lock) {
          S.wake = lock;
          lock.addEventListener('release', function () { S.wake = null; wakeNote(); });
          if (S.tab !== 'night') { wantWake(false); return; }
          wakeNote();
        }).catch(function () { /* low battery, or not allowed: say nothing */ });
      } catch (e) { /* unsupported */ }
    } else if (S.wake) {
      var l = S.wake;
      S.wake = null;
      try { l.release().catch(function () {}); } catch (e) { /* already gone */ }
      wakeNote();
    }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && S.tab === 'night') wantWake(true);
  });

  /* ── input ─────────────────────────────────────────────────────── */
  main.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el || !S.state || el.disabled) return;
    var act = el.getAttribute('data-act'), s = st(), slug = el.getAttribute('data-slug');
    if (el.tagName === 'SELECT' || el.tagName === 'INPUT') return;   // handled on change
    S.note = '';
    switch (act) {
      case 'tab': case 'goto':
        setTab(el.getAttribute('data-tab'));
        if (act === 'goto') { var tb = document.getElementById('st-tab-' + el.getAttribute('data-tab')); if (tb) tb.focus(); }
        return;
      case 'players':
        s.players = Math.max(C.PLAYERS_MIN, Math.min(C.PLAYERS_MAX, s.players + Number(el.getAttribute('data-d'))));
        break;
      case 'travellers':
        s.travellers = Math.max(0, Math.min(C.TRAVELLERS_MAX, s.travellers + Number(el.getAttribute('data-d'))));
        break;
      case 'choice':
        s.choices[el.getAttribute('data-k')] = Number(el.getAttribute('data-i')) || 0;
        break;
      case 'draw':
        if (s.bag.length && s.locks.length &&
          !window.confirm('Redraw the bag? Locked characters stay; everything else is drawn again.')) return;
        s.seed = C.newSeed();
        runDraw({ keep: [] });
        save();
        setTab('bag');
        document.getElementById('st-tab-bag').focus();
        return;
      case 'redraw':
        s.seed = C.newSeed();
        runDraw({ keep: [] });
        break;
      case 'fix':
        s.seed = C.newSeed();
        runDraw({ keep: s.bag.slice() });
        break;
      case 'lock':
        if (s.locks.indexOf(slug) === -1) s.locks.push(slug);
        else s.locks = s.locks.filter(function (x) { return x !== slug; });
        break;
      case 'reroll':
        s.seed = C.newSeed();
        runDraw({ keep: s.bag.filter(function (x) { return x !== slug; }), exclude: [slug] });
        if (s.bag.indexOf(slug) !== -1) S.note = S.by[slug].name + ' stays: another character in the bag needs it.';
        break;
      case 'remove':
        // Taken out, not replaced: the "Fix the bag" bar, or an Add, fills
        // the gap the way the Storyteller wants.
        s.bag = s.bag.filter(function (x) { return x !== slug; });
        s.locks = s.locks.filter(function (x) { return x !== slug; });
        S.warnings = [];
        fixExtras();
        break;
      case 'fakereroll': {
        var team = C.thinksTeam(S.by[slug]);
        var others = fakes().filter(function (f) { return f !== s.thinks[slug]; });
        var f = C.pickFake(S.entries, s.bag, team, others.concat(s.bluffs, [s.thinks[slug]]), rng());
        if (f) s.thinks[slug] = f;
        fixExtras();
        break;
      }
      case 'toggle': {
        var field = el.getAttribute('data-field');
        if (s[field].indexOf(slug) === -1) s[field].push(slug);
        else s[field] = s[field].filter(function (x) { return x !== slug; });
        break;
      }
      case 'bluff':
        s.bluffs = C.rerollBluff(S.entries, s.bag, s.bluffs, Number(el.getAttribute('data-i')), fakes(), rng());
        break;
      case 'bluffall':
        s.bluffs = C.pickBluffs(S.entries, s.bag, fakes().concat(s.bluffs), rng(), 3);
        if (s.bluffs.length < 3) s.bluffs = C.pickBluffs(S.entries, s.bag, fakes(), rng(), 3);
        break;
      case 'cleartokens':
        s.tokensDone = {};
        break;
      case 'firstnight':
        s.night.which = 'first'; s.night.n = 1; s.night.step = 0;
        save();
        setTab('night');
        document.getElementById('st-tab-night').focus();
        return;
      case 'which':
        if (el.getAttribute('data-w') === 'first') { s.night.which = 'first'; s.night.n = 1; }
        else { s.night.which = 'other'; s.night.n = Math.max(2, s.night.n); }
        s.night.step = 0;
        break;
      case 'prev': go(-1); return;
      case 'next': go(1); return;
      case 'jump':
        s.night.step = Number(el.getAttribute('data-i')) || 0;
        break;
      case 'nextnight':
        s.night.which = 'other'; s.night.n += 1; s.night.step = 0;
        break;
      case 'dead':
        if (s.dead.indexOf(slug) === -1) s.dead.push(slug);
        else s.dead = s.dead.filter(function (x) { return x !== slug; });
        break;
      case 'show':
        openShow(el.getAttribute('data-what'));
        return;
      case 'newgame': {
        if (!window.confirm('Start a new game? The bag, bluffs, ticks and night progress are cleared.')) return;
        var fresh = C.emptyState();
        fresh.players = s.players; fresh.travellers = s.travellers;
        fresh.fabledOn = s.fabledOn.slice(); fresh.fabledSet = true;
        S.state = fresh; S.warnings = [];
        change();
        setTab('setup');
        return;
      }
      default: return;
    }
    change();
  });
  main.addEventListener('change', function (e) {
    var el = e.target, act = el.getAttribute && el.getAttribute('data-act');
    if (!act || !S.state) return;
    var s = st(), k = el.getAttribute('data-k'), slug = el.getAttribute('data-slug');
    S.note = '';
    if (act === 'handled') { if (el.checked) s.handled[k] = true; else delete s.handled[k]; }
    else if (act === 'token') { if (el.checked) s.tokensDone[k] = true; else delete s.tokensDone[k]; }
    else if (act === 'everyone') s.night.everyone = !!el.checked;
    else if (act === 'fake') { if (el.value) s.thinks[slug] = el.value; else delete s.thinks[slug]; fixExtras(); }
    else if (act === 'add') {
      var x = el.value;
      if (!x) return;
      // A hand pick is locked, so the draw makes room for it rather than
      // taking it straight back out.
      runDraw({ keep: s.bag.concat([x]), locks: s.locks.concat([x]) });
    } else return;
    change();
  });
  // <details> 'toggle' does not bubble; a capturing listener still hears it.
  main.addEventListener('toggle', function (e) {
    if (e.target.classList && e.target.classList.contains('st-steps')) S.stepsOpen = e.target.open;
  }, true);

  // Arrow keys step the night; Escape closes the player view.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !showEl.hidden) { e.preventDefault(); closeShow(false); return; }
    if (S.tab !== 'night' || !S.state || e.altKey || e.ctrlKey || e.metaKey || !showEl.hidden) return;
    var t = e.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
    if (t && t.getAttribute && t.getAttribute('role') === 'tab') return;   // the tab bar's own keys
    if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
  });
  // The tab bar: arrow keys move between tabs (the ARIA tabs pattern).
  document.getElementById('st-tabs').addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    var i = TABS.indexOf(S.tab) + (e.key === 'ArrowRight' ? 1 : -1);
    i = (i + TABS.length) % TABS.length;
    e.preventDefault();
    setTab(TABS[i]);
    document.getElementById('st-tab-' + TABS[i]).focus();
  });

  /* A swipe on the step card: sideways past 50px, or a flick faster than
     0.5px/ms measured from the last move. Up and down is left to the page
     (touch-action: pan-y on the card). */
  var sw = null;
  main.addEventListener('pointerdown', function (e) {
    if (!e.target.closest('.st-step') || e.target.closest('button, a, input, select')) return;
    sw = { id: e.pointerId, x: e.clientX, y: e.clientY, lx: e.clientX, lt: e.timeStamp, v: 0 };
  });
  main.addEventListener('pointermove', function (e) {
    if (!sw || e.pointerId !== sw.id) return;
    var dt = e.timeStamp - sw.lt;
    if (dt > 0) sw.v = (e.clientX - sw.lx) / dt;
    sw.lx = e.clientX; sw.lt = e.timeStamp;
  });
  main.addEventListener('pointerup', function (e) {
    if (!sw || e.pointerId !== sw.id) return;
    var dx = e.clientX - sw.x, dy = e.clientY - sw.y, v = sw.v;
    sw = null;
    if (Math.abs(dx) <= Math.abs(dy)) return;
    if (Math.abs(dx) > 50 || Math.abs(v) > 0.5) go(dx < 0 ? 1 : -1);
  });
  main.addEventListener('pointercancel', function () { sw = null; });

  start();
})();
