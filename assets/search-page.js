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
  var otherToggle = document.getElementById('sp-filter-toggle');
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

  /* ── filters for the tabs that are not Characters ──
     Characters have the whole All Characters box (char-filters.js). Every
     other kind gets a smaller box built from TAB_FILTERS: an Author chip list
     where the kind has authors (include, then exclude, then off, like the
     Creator chips), yes/no chips, and the sorts that mean something for it.
     Each tab keeps its own choices while the page is open. */
  var SORT_LABEL = {
    relevance: 'Best match', newest: 'Newest first', oldest: 'Oldest first',
    updated: 'Recently updated', 'name-asc': 'Name (A–Z)', 'name-desc': 'Name (Z–A)',
    count: 'Most characters', pages: 'Most pages'
  };
  var DATE_SORTS = ['newest', 'oldest', 'updated'];
  var NAME_SORTS = ['name-asc', 'name-desc'];
  var TAB_FILTERS = {
    script: { author: true, chips: ['curata', 'teensy'], sorts: ['relevance'].concat(DATE_SORTS, NAME_SORTS, ['count']) },
    collection: { author: true, chips: ['curata'], sorts: ['relevance'].concat(DATE_SORTS, NAME_SORTS, ['count']) },
    creator: { chips: ['account'], sorts: ['relevance', 'pages'].concat(NAME_SORTS) },
    user: { chips: ['published'], sorts: ['relevance', 'newest', 'oldest'].concat(NAME_SORTS) },
    wikipage: { author: true, sorts: ['relevance'].concat(DATE_SORTS, NAME_SORTS) },
    news: { sorts: ['relevance', 'newest', 'oldest'].concat(NAME_SORTS) },
    tag: { kinds: [['tag', 'Tags'], ['team', 'Teams']], sorts: ['relevance', 'count'].concat(NAME_SORTS) },
    site: { kinds: [['Browse', 'Browse'], ['Tool', 'Tools'], ['Your account', 'Your account']], sorts: ['relevance'].concat(NAME_SORTS) }
  };
  // Same size rule as the Teensyville chip on /scripts.
  var TEENSY_MAX = 15;
  var CHIP = {
    curata: { group: 'Status', label: 'Curata only', cls: ' filter-chip-curata',
      title: 'Curata: pages the wiki admins have picked out.',
      test: function (r) { return r.item.curata; } },
    teensy: { group: 'Size', label: 'Teensyville', cls: '',
      title: 'Teensyville: small scripts of 15 characters or fewer.',
      test: function (r) { return (r.item.data.characters || []).length <= TEENSY_MAX; } },
    account: { group: 'Show', label: 'Has an account', cls: '',
      test: function (r) { return !!r.item.data.username; } },
    published: { group: 'Show', label: 'Has published', cls: '',
      title: 'People with at least one published character, script or collection.',
      test: function (r) { return !!publishedUsers()[r.item.data.username]; } }
  };
  var AUTHOR_CAP = 40;
  var tabState = {}, authorCache = {}, published = null, barType = null;
  function stateFor(type) {
    return tabState[type] || (tabState[type] = {
      sort: 'relevance', on: {}, kinds: {}, inAuthors: [], exAuthors: [], authorQuery: ''
    });
  }
  function publishedUsers() {
    if (published) return published;
    published = {};
    (index.data.extra.creators || []).forEach(function (c) { if (c.username) published[c.username] = 1; });
    return published;
  }
  function authorsOf(item) { return window.splitCreators(item.data.author || ''); }
  // Every author of this kind on the wiki, not only in the current results,
  // so the list does not shift while somebody types.
  function allAuthors(type) {
    if (authorCache[type]) return authorCache[type];
    var seen = {};
    index.items.forEach(function (it) {
      if (it.type === type) authorsOf(it).forEach(function (n) { seen[n] = 1; });
    });
    return (authorCache[type] = Object.keys(seen).sort(function (a, b) {
      return a.toLowerCase() < b.toLowerCase() ? -1 : 1;
    }));
  }
  function countOf(r) {
    var d = r.item.data;
    if (r.item.type === 'script') return (d.characters || []).length;
    if (r.item.type === 'collection') return membersOf(d).length;
    if (r.item.type === 'creator') return (d.characters || 0) + (d.scripts || 0) + (d.collections || 0);
    return d.count || 0;
  }
  function byItemName(a, b) {
    var x = a.item.name.toLowerCase(), y = b.item.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  // "Best match" means nothing with nothing typed: the list is then A to Z.
  // Minus words only take things away ("-poison"), so a query of nothing but
  // those has nothing to rank by either.
  function hasTerms() { return !!S.parseQuery(state.q).text.trim(); }
  function sortFor(type) {
    var st = stateFor(type), sorts = TAB_FILTERS[type].sorts;
    var sort = sorts.indexOf(st.sort) === -1 ? 'relevance' : st.sort;
    return sort === 'relevance' && !hasTerms() ? 'name-asc' : sort;
  }
  var UNKNOWN = 9e15;   // a page with no date sorts after every dated one
  var SORTS = {
    newest: function (a, b) { return (b.item.created - a.item.created) || byItemName(a, b); },
    oldest: function (a, b) { return ((a.item.created || UNKNOWN) - (b.item.created || UNKNOWN)) || byItemName(a, b); },
    updated: function (a, b) { return (b.item.updated - a.item.updated) || byItemName(a, b); },
    'name-asc': byItemName,
    'name-desc': function (a, b) { return byItemName(b, a); },
    count: function (a, b) { return (countOf(b) - countOf(a)) || byItemName(a, b); },
    pages: function (a, b) { return (countOf(b) - countOf(a)) || byItemName(a, b); }
  };
  function activeCount(type) {
    var st = stateFor(type), n = st.inAuthors.length + st.exAuthors.length, k;
    for (k in st.on) if (st.on[k]) n++;
    for (k in st.kinds) if (st.kinds[k]) n++;
    return n;
  }
  function applyOther(type, list) {
    var st = stateFor(type);
    var chips = Object.keys(st.on).filter(function (k) { return st.on[k]; });
    var kinds = Object.keys(st.kinds).filter(function (k) { return st.kinds[k]; });
    var out = list.filter(function (r) {
      for (var i = 0; i < chips.length; i++) if (!CHIP[chips[i]].test(r)) return false;
      if (kinds.length && kinds.indexOf(r.item.data.kind) === -1) return false;
      if (st.inAuthors.length || st.exAuthors.length) {
        var names = authorsOf(r.item);
        if (st.inAuthors.length && !names.some(function (n) { return st.inAuthors.indexOf(n) !== -1; })) return false;
        if (names.some(function (n) { return st.exAuthors.indexOf(n) !== -1; })) return false;
      }
      return true;
    });
    var sort = sortFor(type);
    // 'relevance' keeps the engine's order, best match first.
    if (SORTS[sort]) out.sort(SORTS[sort]);
    return out;
  }

  function groupHTML(label, inner) {
    return '<div class="filter-group"><span class="filter-group-label">' + esc(label) + '</span>' + inner + '</div>';
  }
  function sortOptions(type) {
    var q = hasTerms(), current = sortFor(type);
    return TAB_FILTERS[type].sorts.filter(function (s) { return q || s !== 'relevance'; }).map(function (s) {
      return '<option value="' + s + '"' + (s === current ? ' selected' : '') + '>' + esc(SORT_LABEL[s]) + '</option>';
    }).join('');
  }
  // Built once per tab, then only its counts and chips change, so the author
  // search box keeps its focus and the bar does not jump while typing.
  function buildOtherBar(type) {
    var cfg = TAB_FILTERS[type], st = stateFor(type), html = '', groups = [], byGroup = {};
    if (cfg.kinds) {
      html += groupHTML('Kind', '<div class="filter-chips">' + cfg.kinds.map(function (k) {
        return '<button type="button" class="filter-chip' + (st.kinds[k[0]] ? ' active' : '') + '" data-kind="' + esc(k[0]) + '">' +
          esc(k[1]) + ' <span class="sp-chip-n"></span></button>';
      }).join('') + '</div>');
    }
    (cfg.chips || []).forEach(function (k) {
      var c = CHIP[k];
      if (!byGroup[c.group]) { byGroup[c.group] = []; groups.push(c.group); }
      byGroup[c.group].push('<button type="button" class="filter-chip' + c.cls + (st.on[k] ? ' active' : '') + '" data-chip="' + k + '"' +
        (c.title ? ' title="' + esc(c.title) + '"' : '') + '>' + esc(c.label) + ' <span class="sp-chip-n"></span></button>');
    });
    groups.forEach(function (g) { html += groupHTML(g, '<div class="filter-chips">' + byGroup[g].join('') + '</div>'); });
    var authors = cfg.author ? allAuthors(type) : [];
    if (authors.length > 1) {
      html += '<div class="filter-group filter-group-creators"><span class="filter-group-label">Author</span>' +
        '<div class="filter-chip-selected-row" id="sp-au-selected"></div>' +
        '<input type="search" class="filter-search" id="sp-au-search" value="' + esc(st.authorQuery) + '" ' +
          'placeholder="Search ' + authors.length + ' authors…" autocomplete="off" aria-label="Search authors">' +
        '<div class="filter-chips-scroll" id="sp-au-list"></div></div>';
    }
    html += groupHTML('Sort', '<select class="filter-select" id="sp-sort">' + sortOptions(type) + '</select>');
    html += groupHTML(' ', '<button type="button" class="filter-reset" id="sp-other-reset">Reset filters</button>');
    sortbar.innerHTML = html;
    sortbar.setAttribute('data-type', type);
    barType = type;
    drawAuthorChips(type);
  }
  function matchingAuthors(type) {
    var st = stateFor(type), q = S.fold(st.authorQuery.trim());
    return allAuthors(type).filter(function (n) {
      if (st.inAuthors.indexOf(n) !== -1 || st.exAuthors.indexOf(n) !== -1) return false;
      return !q || S.fold(n).indexOf(q) !== -1;
    });
  }
  function authorChip(name, cls) {
    return '<button type="button" class="filter-chip' + (cls ? ' ' + cls : '') + '" data-author="' + esc(name) + '">' + esc(name) + '</button>';
  }
  function drawAuthorChips(type) {
    var selected = document.getElementById('sp-au-selected'), listEl = document.getElementById('sp-au-list');
    if (!selected || !listEl) return;
    var st = stateFor(type), matches = matchingAuthors(type), shown = matches.slice(0, AUTHOR_CAP);
    selected.innerHTML = st.inAuthors.map(function (n) { return authorChip(n, 'active'); }).join('') +
      st.exAuthors.map(function (n) { return authorChip(n, 'active-exclude'); }).join('');
    listEl.innerHTML = shown.map(function (n) { return authorChip(n, ''); }).join('') +
      (matches.length > shown.length ? '<span class="filter-more">+' + (matches.length - shown.length) + ' more (keep typing)</span>' : '') +
      (!matches.length && st.authorQuery.trim() ? '<span class="filter-more">No author matches “' + esc(st.authorQuery.trim()) + '”</span>' : '');
  }
  // unset -> include -> exclude -> unset, like the Creator chips.
  function cycleAuthor(type, name) {
    var st = stateFor(type), ii = st.inAuthors.indexOf(name), ei = st.exAuthors.indexOf(name);
    if (ii === -1 && ei === -1) st.inAuthors.push(name);
    else if (ii !== -1) { st.inAuthors.splice(ii, 1); st.exAuthors.push(name); }
    else st.exAuthors.splice(ei, 1);
  }
  // Counts on the chips, against what the search found (before the chips).
  function refreshOtherBar(type, found) {
    sortbar.querySelectorAll('[data-chip]').forEach(function (b) {
      var test = CHIP[b.getAttribute('data-chip')].test;
      b.querySelector('.sp-chip-n').textContent = '(' + found.filter(test).length + ')';
    });
    sortbar.querySelectorAll('[data-kind]').forEach(function (b) {
      var k = b.getAttribute('data-kind');
      b.querySelector('.sp-chip-n').textContent = '(' + found.filter(function (r) { return r.item.data.kind === k; }).length + ')';
    });
    var sel = document.getElementById('sp-sort');
    if (sel) sel.innerHTML = sortOptions(type);
    var n = activeCount(type);
    otherToggle.innerHTML = 'Filters' + (n ? ' (' + n + ')' : '') + ' <span class="filter-toggle-arrow">&#9662;</span>';
  }
  function showOtherBar(type, found) {
    // Nothing to sort or narrow, unless a filter is what emptied it.
    var show = !!type && type !== 'character' && (found.length > 1 || activeCount(type) > 0);
    sortbar.hidden = !show;
    otherToggle.hidden = !show;
    if (!show) return;
    if (barType !== type) buildOtherBar(type);
    refreshOtherBar(type, found);
  }
  otherToggle.addEventListener('click', function () {
    var open = sortbar.classList.toggle('open');
    otherToggle.classList.toggle('open', open);
    otherToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  sortbar.addEventListener('change', function (e) {
    if (e.target.id !== 'sp-sort' || !barType) return;
    stateFor(barType).sort = e.target.value;
    drawBody();
  });
  sortbar.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('button') : null, type = barType;
    if (!t || !type) return;
    var st = stateFor(type);
    if (t.hasAttribute('data-chip')) {
      var k = t.getAttribute('data-chip');
      st.on[k] = !st.on[k];
      t.classList.toggle('active', st.on[k]);
    } else if (t.hasAttribute('data-kind')) {
      var kind = t.getAttribute('data-kind');
      st.kinds[kind] = !st.kinds[kind];
      t.classList.toggle('active', st.kinds[kind]);
    } else if (t.hasAttribute('data-author')) {
      cycleAuthor(type, t.getAttribute('data-author'));
      drawAuthorChips(type);
    } else if (t.id === 'sp-other-reset') {
      tabState[type] = null;
      buildOtherBar(type);
    } else return;
    drawBody();
  });
  sortbar.addEventListener('input', function (e) {
    if (e.target.id !== 'sp-au-search' || !barType) return;
    stateFor(barType).authorQuery = e.target.value;
    drawAuthorChips(barType);
  });
  // Enter picks the only match, as in the Creator box on All Characters.
  sortbar.addEventListener('keydown', function (e) {
    if (e.target.id !== 'sp-au-search' || e.key !== 'Enter' || e.isComposing || !barType) return;
    e.preventDefault();
    var matches = matchingAuthors(barType);
    if (matches.length === 1) {
      cycleAuthor(barType, matches[0]);
      stateFor(barType).authorQuery = '';
      e.target.value = '';
    }
    drawAuthorChips(barType);
    drawBody();
  });

  function ensureFilters() {
    if (filters) return filters;
    feedPos = new Map();
    index.data.characters.forEach(function (c, i) { feedPos.set(c, i); });
    filters = CF.mount({
      bar: bar, toggle: toggle, list: index.data.characters,
      sourceOf: CF.makeSourceOf(index.data.collections, index.data.scripts),
      sorts: [['relevance', 'Best match'], ['name', 'Name'], ['recent', 'Date added'], ['ability', 'Ability length']],
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

    var found = type ? res.byType[type] : [];
    showOtherBar(type, found);
    if (!type) { drawAll(q); return; }
    if (type === 'character') { drawCharacters(q); return; }
    var list = applyOther(type, found);
    countEl.hidden = false;
    countEl.textContent = noun(type, list.length) +
      (found.length !== list.length ? ' (of ' + found.length + ')' : '') + (q ? ' for “' + q + '”' : '');
    if (list.length) { out.innerHTML = gridHTML(type, list); return; }
    out.innerHTML = found.length
      ? emptyHTML('No ' + NOUN[type][1] + ' match these filters. <button type="button" class="filter-reset" id="sp-reset">Reset</button>')
      : emptyHTML(q ? 'No ' + NOUN[type][1] + ' match “' + esc(q) + '”.' : 'Nothing here yet.');
    var rb = document.getElementById('sp-reset');
    if (rb) rb.addEventListener('click', function () { tabState[type] = null; barType = null; drawBody(); });
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

  var setOf = null;   // "Group: By script or collection", built once
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
    if (!setOf) setOf = CF.makeSetOf(index.data.collections, index.data.scripts);
    var laid = CF.sections(list, filters.state.group, setOf);
    out.innerHTML = laid.html;
    var groups = laid.groups;
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
