/* The /search page: everything that matches, a tab per kind of result, and
   on the Characters tab the All Characters filter (assets/char-filters.js).
   The matching and ranking are assets/search-core.js, the same engine the
   top-bar box uses, so the preview and this page always agree. This file only
   draws.

   The URL carries the query and the tab (/search?q=imp&type=characters), so a
   search can be shared and the back button returns to it. Typing rewrites the
   address in place; changing tab adds a history entry. */
(function () {
  'use strict';
  var S = window.BotcSearch, CF = window.CharFilters, PR = window.PageRender;
  var esc = S.esc;
  var input = document.getElementById('sp-input');
  var form = document.getElementById('sp-form');
  var tabsEl = document.getElementById('sp-tabs');
  var bar = document.getElementById('filter-bar');
  var toggle = document.getElementById('filter-toggle');
  var sortbar = document.getElementById('sp-sortbar');
  var countEl = document.getElementById('sp-count');
  var out = document.getElementById('sp-results');
  if (!input || !out || !S) return;

  // URL value -> engine type, in tab order.
  var TABS = [
    ['all', null], ['characters', 'character'], ['scripts', 'script'],
    ['collections', 'collection'], ['creators', 'creator'], ['users', 'user'],
    ['pages', 'wikipage'], ['news', 'news'], ['tags', 'tag'], ['site', 'site']
  ];
  var TAB_TYPE = {}, TYPE_TAB = {};
  TABS.forEach(function (t) { TAB_TYPE[t[0]] = t[1]; if (t[1]) TYPE_TAB[t[1]] = t[0]; });
  var NOUN = {
    character: ['character', 'characters'], script: ['script', 'scripts'],
    collection: ['collection', 'collections'], creator: ['creator', 'creators'],
    user: ['user', 'users'], wikipage: ['wiki page', 'wiki pages'],
    news: ['news article', 'news articles'], tag: ['tag or team', 'tags and teams'],
    site: ['site page', 'site pages']
  };
  function noun(type, n) { return n + ' ' + NOUN[type][n === 1 ? 0 : 1]; }
  // How many of each kind the All tab shows before "See all".
  var ALL_LIMIT = { character: 6, script: 4, collection: 4, creator: 8, user: 8, wikipage: 4, news: 4, tag: 12, site: 6 };

  function readURL() {
    var p = new URLSearchParams(location.search);
    var tab = p.get('type');
    return { q: p.get('q') || '', tab: TAB_TYPE[tab] !== undefined ? tab : 'all' };
  }
  var state = readURL();
  // Sort and Curata-only for the tabs that are not Characters (which has the
  // whole filter box of its own).
  var other = { sort: 'relevance', curataOnly: false };
  input.value = state.q;

  function writeURL(push) {
    var p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.tab !== 'all') p.set('type', state.tab);
    var qs = p.toString();
    var url = location.pathname + (qs ? '?' + qs : '');
    try { history[push ? 'pushState' : 'replaceState'](null, '', url); } catch (e) { /* file:// or sandboxed */ }
    document.title = (state.q ? state.q + ' · ' : '') + 'Search — BOTC HomeBrew Wiki';
  }

  var index = null, res = null, filters = null, cancelCards = null, feedPos = null, members = {};

  function markFn(text) { return S.mark(text, res ? res.tokens : []); }

  /* ── tiles for each kind of result ──
     The script and collection tiles are the ones on /scripts and
     /all-collections (and the homepage and creator pages): banner is header,
     then logo, then the fallback. Change one, change all six. */
  function scriptTile(sc) {
    var n = (sc.characters || []).length;
    var banner = sc.header || sc.logo;
    var nch = Math.max(String(sc.name || '').replace(/\s+/g, ' ').trim().length, 4);
    var headerHTML = banner
      ? '<div class="script-card-header"><img loading="lazy" decoding="async" src="' + esc(PR.imgSrc('', banner, sc.v)) + '"' + PR.responsiveAttrs('', banner, sc.v, '(max-width: 640px) 94vw, 320px') + ' alt="' + esc(sc.name) + '"></div>'
      : '<div class="script-card-header script-card-header-empty"><span style="--nch:' + nch + '">' + esc(sc.name) + '</span></div>';
    var blurb = sc.tagline || sc.description || '';
    return '<a class="collection-tile script-tile" href="s/' + esc(encodeURIComponent(sc.slug)) + '">' +
      headerHTML +
      '<h3 class="collection-name">' + markFn(sc.name) + '</h3>' +
      (blurb ? '<p class="script-tile-desc">' + markFn(blurb) + '</p>' : '') +
      '<div class="collection-footer">' +
        '<span class="collection-count">' + n + ' character' + (n === 1 ? '' : 's') +
          (sc.author ? ' · ' + markFn(sc.author) : '') +
          (sc.curata ? window.classBadgeHTML('curata', { sep: true }) : '') + '</span>' +
        '<span class="collection-arrow">View →</span>' +
      '</div></a>';
  }
  function membersOf(coll) {
    var key = coll.id || coll.slug;
    if (!members[key]) members[key] = PR.resolveCollectionMembers(coll, index.data.characters);
    return members[key];
  }
  // A few member icons for a collection with no banner, one per team first.
  function pickIcons(list, n) {
    var withArt = list.filter(function (c) { return c.art; }), picked = [], seen = {}, i;
    for (i = 0; i < withArt.length && picked.length < n; i++) {
      if (!seen[withArt[i].team]) { picked.push(withArt[i]); seen[withArt[i].team] = 1; }
    }
    for (i = 0; i < withArt.length && picked.length < n; i++) {
      if (picked.indexOf(withArt[i]) === -1) picked.push(withArt[i]);
    }
    return picked;
  }
  function collectionTile(coll) {
    var name = coll.displayName || coll.name || coll.slug;
    var list = membersOf(coll), count = list.length;
    var banner = coll.header || coll.logo;
    var topHTML = banner
      ? '<div class="collection-tile-header"><img loading="lazy" decoding="async" src="' + esc(PR.imgSrc('', banner, coll.v)) + '"' + PR.responsiveAttrs('', banner, coll.v, '(max-width: 640px) 94vw, 320px') + ' alt="' + esc(name) + '"></div>'
      : '<div class="collection-icons">' + pickIcons(list, 8).map(function (c) {
          return '<img loading="lazy" decoding="async" class="collection-icon" src="' + esc(PR.thumbSrc(c, '')) + '" onerror="this.src=\'assets/favicon.png\'" alt="">';
        }).join('') + '</div>';
    return '<a class="collection-tile" href="collection/' + esc(encodeURIComponent(coll.id || coll.slug)) + '">' +
      topHTML +
      '<h3 class="collection-name">' + markFn(name) + '</h3>' +
      (coll.tagline ? '<p class="collection-tile-tagline">' + markFn(coll.tagline) + '</p>' : '') +
      '<div class="collection-footer">' +
        '<span class="collection-count">' + count + ' character' + (count === 1 ? '' : 's') +
          (coll.author ? ' · ' + markFn(coll.author) : '') +
          (coll.curata ? window.classBadgeHTML('curata', { sep: true }) : '') + '</span>' +
        '<span class="collection-arrow">Browse →</span>' +
      '</div></a>';
  }
  // Creators and users: the /creators index tile.
  function countLabel(c) {
    var bits = [];
    if (c.characters) bits.push(c.characters + ' char' + (c.characters === 1 ? '' : 's'));
    if (c.scripts) bits.push(c.scripts + ' script' + (c.scripts === 1 ? '' : 's'));
    if (c.collections) bits.push(c.collections + ' coll' + (c.collections === 1 ? '' : 's'));
    return bits.join(' · ');
  }
  function personTile(item) {
    var d = item.data, sym = '';
    if (item.type === 'creator' && window.CreatorSymbols) sym = window.CreatorSymbols.creatorSymbol(d.name) || '';
    var badge = d.avatarUrl
      ? '<img class="creator-av" loading="lazy" decoding="async" src="' + esc(d.avatarUrl) + '" alt="">'
      : '<span class="creator-sym">' + esc(sym || '·') + '</span>';
    var sub = item.type === 'creator' ? countLabel(d) : '';
    return '<a class="creator-pill creator-pill-wide" href="' + esc(item.href) + '">' + badge +
      '<span class="creator-name">' + markFn(item.type === 'creator' ? d.name : (d.displayName || d.username)) +
        (d.username ? '<span class="creator-at">@' + markFn(d.username) + '</span>' : '') +
        (sub ? '<span class="creator-count">' + esc(sub) + '</span>' : '') +
      '</span></a>';
  }
  function formatDate(s) {
    var d = new Date(String(s || '').replace(' ', 'T') + (/[zZ]$/.test(String(s)) ? '' : 'Z'));
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  // Wiki pages, news and the site's own pages: the news card.
  function textCard(item) {
    var d = item.data, top = '', body = '';
    if (item.type === 'wikipage') {
      top = [d.author ? 'by ' + d.author : '', d.parentName || ''].filter(Boolean).join(' · ');
      body = d.blurb || d.subtitle || '';
    } else if (item.type === 'news') {
      top = formatDate(d.publishedAt);
      body = d.summary || '';
    } else {
      top = d.kind;
      body = d.desc;
    }
    return '<a class="news-card" href="' + esc(item.href) + '">' +
      (top ? '<div class="news-card-date">' + esc(top) + '</div>' : '') +
      '<h3 class="news-card-title">' + markFn(item.name) + '</h3>' +
      (body ? '<p class="news-card-summary">' + markFn(body) + '</p>' : '') +
      '<span class="news-card-more">' + (item.type === 'site' ? 'Open →' : 'Read more →') + '</span>' +
    '</a>';
  }
  function tagPill(item) {
    var d = item.data;
    return '<a class="tag-pill' + (d.kind === 'team' ? ' sp-team-pill sp-team-' + esc(d.team) : '') + '"' +
      (d.kind === 'tag' ? ' data-tag="' + esc(item.name) + '"' : '') + ' href="' + esc(item.href) + '">' +
      markFn(item.name) +
      (d.kind === 'team' ? '<span class="sp-pill-kind">Team</span>' : '') +
      '<span class="tag-count">' + (d.count || 0) + '</span></a>';
  }
  function gridHTML(type, list) {
    if (type === 'character') {
      return '<div class="char-grid">' + list.map(function (r) { return CF.card(r.item.data, markFn); }).join('') + '</div>';
    }
    if (type === 'script') return '<div class="collections-grid">' + list.map(function (r) { return scriptTile(r.item.data); }).join('') + '</div>';
    if (type === 'collection') return '<div class="collections-grid">' + list.map(function (r) { return collectionTile(r.item.data); }).join('') + '</div>';
    if (type === 'creator' || type === 'user') {
      return '<div class="creators-page-grid sp-people">' +
        list.map(function (r) { return personTile(r.item); }).join('') + '</div>';
    }
    if (type === 'tag') return '<div class="tags-index sp-tags">' + list.map(function (r) { return tagPill(r.item); }).join('') + '</div>';
    return '<div class="news-grid">' + list.map(function (r) { return textCard(r.item); }).join('') + '</div>';
  }

  /* ── tabs ── */
  function drawTabs() {
    var q = state.q.trim();
    var html = TABS.map(function (t) {
      var key = t[0], type = t[1];
      var n = type ? res.counts[type] : res.mixed.length;
      // A kind with nothing in it is left out, unless it is the open tab.
      if (type && !n && state.tab !== key) return '';
      var label = type ? S.TYPE_LABEL[type] : 'All';
      var on = state.tab === key;
      return '<button type="button" class="filter-chip sp-tab' + (on ? ' active' : '') + '" role="tab"' +
        ' aria-selected="' + on + '" data-tab="' + key + '">' + esc(label) +
        (type || q ? ' <span class="sp-tab-n">' + n + '</span>' : '') + '</button>';
    }).join('');
    tabsEl.innerHTML = html;
    tabsEl.hidden = false;
  }
  tabsEl.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-tab]') : null;
    if (b) setTab(b.getAttribute('data-tab'));
  });
  function setTab(tab) {
    if (tab === state.tab) return;
    state.tab = tab;
    writeURL(true);
    drawTabs();
    drawBody();
    // Keep the tabs in view: on a phone they may have scrolled away.
    var top = tabsEl.getBoundingClientRect().top;
    if (top < 0) window.scrollTo(0, window.pageYOffset + top - 70);
  }

  /* ── the list for the open tab ── */
  function sortOther(list) {
    var l = other.curataOnly ? list.filter(function (r) { return r.item.curata; }) : list.slice();
    if (other.sort === 'name-asc' || other.sort === 'name-desc') {
      l.sort(function (a, b) {
        var x = a.item.name.toLowerCase(), y = b.item.name.toLowerCase();
        return x < y ? -1 : x > y ? 1 : 0;
      });
      if (other.sort === 'name-desc') l.reverse();
    }
    return l;
  }
  function drawSortbar(type, list) {
    if (!type || type === 'character' || list.length < 2) { sortbar.hidden = true; return; }
    var hasCurata = (type === 'script' || type === 'collection') && res.byType[type].some(function (r) { return r.item.curata; });
    var sorts = [['relevance', 'Best match'], ['name-asc', 'Name (A–Z)'], ['name-desc', 'Name (Z–A)']];
    sortbar.innerHTML =
      (hasCurata ? '<div class="filter-group"><span class="filter-group-label">Status</span><div class="filter-chips">' +
        '<button type="button" class="filter-chip filter-chip-curata' + (other.curataOnly ? ' active' : '') + '" id="sp-curata">Curata only</button></div></div>' : '') +
      '<div class="filter-group"><span class="filter-group-label">Sort</span><select class="filter-select" id="sp-sort">' +
      sorts.map(function (s) { return '<option value="' + s[0] + '"' + (other.sort === s[0] ? ' selected' : '') + '>' + s[1] + '</option>'; }).join('') +
      '</select></div>';
    sortbar.hidden = false;
  }
  sortbar.addEventListener('change', function (e) {
    if (e.target.id === 'sp-sort') { other.sort = e.target.value; drawBody(); }
  });
  sortbar.addEventListener('click', function (e) {
    if (e.target.id === 'sp-curata') { other.curataOnly = !other.curataOnly; drawBody(); }
  });

  function ensureFilters() {
    if (filters) return filters;
    feedPos = new Map();
    index.data.characters.forEach(function (c, i) { feedPos.set(c, i); });
    filters = CF.mount({
      bar: bar, toggle: toggle, list: index.data.characters,
      sourceOf: CF.makeSourceOf(index.data.collections, index.data.scripts),
      // A search is looking for something in particular, so an unfinished
      // page still shows (the chip hides them on request), as on the creator
      // pages.
      partialOn: true,
      sorts: [['relevance', 'Best match'], ['name-asc', 'Name (A–Z)'], ['name-desc', 'Name (Z–A)'], ['recent', 'Recently added']],
      defaultGroup: 'none',
      order: function (c) { return feedPos.get(c) || 0; },
      onChange: drawBody
    });
    return filters;
  }

  function emptyHTML(text) { return '<p class="sp-empty">' + text + '</p>'; }

  function drawBody() {
    if (cancelCards) { cancelCards(); cancelCards = null; }
    var type = TAB_TYPE[state.tab], q = state.q.trim();
    var showFilters = type === 'character';
    if (showFilters) {
      ensureFilters();
      filters.counts(res.byType.character.map(function (r) { return r.item.data; }));
    }
    bar.hidden = !showFilters;
    toggle.hidden = !showFilters;

    if (!type) { sortbar.hidden = true; drawAll(q); return; }
    if (type === 'character') { drawCharacters(q); return; }
    var list = sortOther(res.byType[type]);
    drawSortbar(type, res.byType[type]);
    countEl.hidden = false;
    countEl.textContent = noun(type, list.length) + (q ? ' for “' + q + '”' : '');
    out.innerHTML = list.length ? gridHTML(type, list)
      : emptyHTML(q ? 'No ' + NOUN[type][1] + ' match “' + esc(q) + '”.' : 'Nothing here yet.');
  }

  function drawAll(q) {
    if (!q) {
      countEl.hidden = true;
      out.innerHTML = emptyHTML('Search characters, scripts, collections, creators, users, wiki pages and news. ' +
        'Pick a tab above to browse everything of one kind.');
      return;
    }
    var mixed = res.mixed;
    countEl.hidden = false;
    countEl.textContent = mixed.length + ' result' + (mixed.length === 1 ? '' : 's') + ' for “' + q + '”';
    if (!mixed.length) {
      out.innerHTML = emptyHTML('Nothing found for “' + esc(q) + '”. Check the spelling, or try fewer words.');
      return;
    }
    // One section per kind, in the order of each kind's best match.
    var groups = {}, order = [];
    mixed.forEach(function (r) {
      var t = r.item.type;
      if (!groups[t]) { groups[t] = []; order.push(t); }
      groups[t].push(r);
    });
    out.innerHTML = order.map(function (t) {
      var list = groups[t], n = res.counts[t], shown = list.slice(0, ALL_LIMIT[t]);
      return '<section class="sp-section">' +
        '<div class="sp-section-head"><h2 class="type-header">' + esc(S.TYPE_LABEL[t]) + '</h2>' +
          (n > shown.length ? '<button type="button" class="sp-more" data-tab="' + TYPE_TAB[t] + '">See all ' + noun(t, n) + ' →</button>' : '') +
        '</div><div class="type-rule"></div>' + gridHTML(t, shown) + '</section>';
    }).join('');
  }
  out.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('.sp-more') : null;
    if (b) setTab(b.getAttribute('data-tab'));
  });

  function drawCharacters(q) {
    var all = res.byType.character.map(function (r) { return r.item.data; });
    var list = filters.apply(all);
    countEl.hidden = false;
    countEl.textContent = noun('character', list.length) +
      (all.length !== list.length ? ' (of ' + all.length + ')' : '') + (q ? ' for “' + q + '”' : '');
    if (!list.length) {
      out.innerHTML = all.length
        ? emptyHTML('No characters match these filters. <button type="button" class="filter-reset" id="sp-reset">Reset</button>')
        : emptyHTML('No characters match “' + esc(q) + '”.');
      var rb = document.getElementById('sp-reset');
      if (rb) rb.addEventListener('click', function () { filters.reset(); });
      return;
    }
    var card = function (c) { return CF.card(c, markFn); };
    var groups = [];
    if (filters.state.group === 'none') {
      groups.push({ selector: '.char-grid[data-team="all"]', items: list });
      out.innerHTML = '<section class="type-section" id="all"><div class="char-grid" data-team="all"></div></section>';
    } else {
      out.innerHTML = CF.TEAMS.map(function (t) {
        var chars = list.filter(function (c) { return c.team === t[0]; });
        if (!chars.length) return '';
        groups.push({ selector: '.char-grid[data-team="' + t[0] + '"]', items: chars });
        return '<section class="type-section" id="' + t[0] + '"><h2 class="type-header"><a href="team?t=' + t[0] + '" class="team-header-link">' + t[1] + '</a></h2><div class="type-rule"></div><div class="char-grid" data-team="' + t[0] + '"></div></section>';
      }).join('');
    }
    cancelCards = window.mountCardBatches(out, groups, card);
  }

  /* ── running a search ── */
  function run() {
    res = index.search(state.q);
    drawTabs();
    drawBody();
  }
  input.addEventListener('input', function () {
    state.q = input.value;
    writeURL(false);
    if (index) run();
  });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    state.q = input.value;
    writeURL(false);
    // On a phone, Enter is "I'm done typing": put the keyboard away so the
    // results can be seen.
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) input.blur();
    if (index) run();
  });
  window.addEventListener('popstate', function () {
    state = readURL();
    input.value = state.q;
    if (index) run();
  });
  // The top-bar box on this page searches here instead of reloading it.
  window.SearchPage = {
    set: function (q) {
      input.value = q;
      state.q = q;
      writeURL(false);
      if (index) run();
      input.focus();
    }
  };

  function load() {
    S.load().then(function (idx) {
      index = idx;
      run();
    }).catch(function () {
      out.innerHTML = emptyHTML('The search could not load. <button type="button" class="filter-reset" id="sp-retry">Try again</button>');
      document.getElementById('sp-retry').addEventListener('click', function () {
        out.innerHTML = '';
        load();
      });
    });
  }
  writeURL(false);
  load();
  // A desktop visitor with nothing searched yet can start typing at once.
  // Not on a phone, where focusing would throw the keyboard up uninvited.
  if (!state.q && window.matchMedia && window.matchMedia('(pointer: fine)').matches) input.focus();
})();
