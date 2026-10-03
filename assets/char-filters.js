/* The All Characters filter box: team, tag, source, status and creator chips,
   plus Sort and Group. Data-driven: it filters an ARRAY of characters (the
   grid feed rows) and hands back the list to draw, so the page can draw only
   what is on screen (viewport.js) instead of 2,400 cards.

   Used by all-characters.html and by the /search page, so the two offer one
   filter with one set of rules. card-filters.js is the other filter box: it
   filters cards already in the DOM (collection and creator pages) and stays
   separate for that reason.

   CharFilters.mount(opts) -> controller
     opts.bar, opts.toggle   the #filter-bar box and its mobile "Filters" button
     opts.list               the characters the chips are built from
     opts.sourceOf(c)        'collection' | 'script' | null, for the Source chips
     opts.partialOn          Show Partial starts ticked (the search page)
     opts.sorts              [[value, label]] offered in Sort, in order:
                             'relevance' | 'name' | 'recent' | 'ability'
     opts.defaultSort        defaults to the first sort
     opts.defaultGroup       'team' (a section per team), 'none', 'author' or 'set'
     opts.order(c)           the row's feed position, for "Recently added"
     opts.onChange()         called after every change; the page redraws
   controller
     state, apply(list), activeCount(), reset(), counts(list)
   counts(list) re-counts the status chips against a new list, which the
   search page does after every query.

   Sort is two boxes: WHAT to sort by, and Ascending / Descending. Picking a
   sort puts the direction on the way that sort is usually read (names A–Z,
   newest first, shortest ability first), and the second box flips it. Best
   match has one direction, so the box is greyed out for it.

   sections(list, group, setOf) lays a filtered list out as the page draws
   it: one section per team, one grid, one section per author, or one per
   script or collection (makeSetOf() builds `setOf`). Both pages that mount
   this box draw through it, so the layouts cannot drift. */
(function () {
  'use strict';

  var TEAMS = [
    ['townsfolk', 'Townsfolk'], ['outsider', 'Outsider'],
    ['minion', 'Minion'], ['demon', 'Demon'],
    ['traveller', 'Traveller'], ['fabled', 'Fabled'],
    ['loric', 'Loric']
  ];
  var SOURCE_LABELS = [['collection', 'From Collection'], ['script', 'From Script']];
  var NAME_SORTS = [['name', 'Name'], ['recent', 'Date added'], ['ability', 'Ability length']];
  // The direction each sort starts in when it is picked.
  var NATURAL_DIR = { relevance: 'asc', name: 'asc', recent: 'desc', ability: 'asc' };
  // Callers from before the direction box passed the direction inside the
  // sort ('name-desc'); read those as the two halves they now are.
  var LEGACY_SORT = { 'name-asc': ['name', 'asc'], 'name-desc': ['name', 'desc'] };
  function cmpName(a, b) { return (a.name || '').localeCompare(b.name || ''); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function splitTags(c) { return (c.tags || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean); }
  function titleCase(s) {
    return String(s || '').trim().toLowerCase().replace(/(^|[\s\-\/])[a-z]/g, function (m) { return m.toUpperCase(); })
      .replace(/(^|[\s\-\/])St(?=$|[\s\-\/])/g, '$1ST'); // the ST in "ST Decided Info"
  }
  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }

  // Hybrid membership: a character belongs if its "Appears in" matches a
  // collection's match[] OR it's explicitly in include[], minus exclude[].
  function inCollection(c, coll) {
    if ((coll.exclude || []).indexOf(c.slug) !== -1) return false;
    if ((coll.include || []).indexOf(c.slug) !== -1) return true;
    return (coll.match || []).indexOf(norm(c.appearsIn)) !== -1;
  }
  // A character's source category: a collection (Appears in matches a
  // collection) takes precedence over a script (listed in a homebrew script).
  function makeSourceOf(collections, scripts) {
    var inScript = {};
    (scripts || []).forEach(function (s) { (s.characters || []).forEach(function (sl) { inScript[norm(sl)] = true; }); });
    var colls = (collections || []).filter(function (c) { return !c.standalone; });
    return function (c) {
      for (var i = 0; i < colls.length; i++) if (inCollection(c, colls[i])) return 'collection';
      if (inScript[norm(c.slug)]) return 'script';
      return null;
    };
  }

  var GOOD = { townsfolk: 1, outsider: 1 };
  var TEAM_LABEL = {};
  TEAMS.forEach(function (t) { TEAM_LABEL[t[0]] = t[1]; });

  // A card's picture: the 192px WebP thumbnail beside the art
  // (thumb/{file}.webp — the Worker serves the original where there is none
  // yet), versioned by the row's `v` so it caches for a year. Same order as
  // PageRender.thumbSrc(); a remote `image` or a missing icon falls back.
  function thumb(c) {
    var ver = c.v ? '?v=' + encodeURIComponent(String(c.v)) : '';
    if (c.art && /^art\/[^/]+$/.test(c.art)) return 'assets/thumb/' + c.art.slice(4) + '.webp' + ver;
    if (c.art) return 'assets/' + c.art + ver;
    if (typeof c.image === 'string' && c.image) return c.image;
    if (Array.isArray(c.image) && c.image[0]) return c.image[0];
    return 'assets/favicon.png';
  }
  // One character card, as the browse pages draw it. `mark` (optional) turns
  // plain text into HTML with the search words highlighted; without it the
  // text is only escaped.
  function card(c, mark) {
    var m = mark || esc;
    var typeClass = GOOD[c.team] ? ' good' : '';
    return '<a class="char-card" href="' + esc(c.page) + '">' +
      // The icon, and under it the Favorites / Add to Script quick actions
      // (assets/card-actions.js fills the slot).
      '<span class="card-side">' +
      '<img loading="lazy" decoding="async" class="char-card-thumb" src="' + esc(thumb(c)) + '" alt="' + esc(c.name) + ' art" onerror="this.src=\'assets/favicon.png\'">' +
      (window.CardActions ? window.CardActions.slotHTML(c) : '') + '</span>' +
      '<div class="char-card-info">' +
      '<div class="char-card-name">' + m(c.name) +
        window.classBadgeHTML(window.classifyCharacter(c), { from: c.curataFrom }) + '</div>' +
      '<div class="char-card-type' + typeClass + '">' + esc(TEAM_LABEL[c.team] || c.team) + '</div>' +
      '<div class="char-card-ability">' + m(c.ability || '') + '</div>' +
      '<span class="char-card-link">View Character →</span>' +
      '</div></a>';
  }

  function mount(opts) {
    opts = opts || {};
    var bar = opts.bar, toggle = opts.toggle;
    var list = opts.list || [];
    var sourceOf = opts.sourceOf || function () { return null; };
    var sorts = (opts.sorts || NAME_SORTS).map(function (s) {
      return LEGACY_SORT[s[0]] ? [LEGACY_SORT[s[0]][0], s[0] === 'name-asc' ? 'Name' : null] : s;
    }).filter(function (s) { return s[1]; });
    if (!sorts.some(function (s) { return s[0] === 'ability'; })) sorts.push(['ability', 'Ability length']);
    var legacyDefault = LEGACY_SORT[opts.defaultSort];
    var DEFAULT_SORT = legacyDefault ? legacyDefault[0] : (opts.defaultSort || sorts[0][0]);
    var DEFAULT_DIR = legacyDefault ? legacyDefault[1] : (NATURAL_DIR[DEFAULT_SORT] || 'asc');
    var DEFAULT_GROUP = opts.defaultGroup || 'team';
    var onChange = opts.onChange || function () {};
    var countList = list;

    // Creators use the same 3-state include/exclude model as tags and teams
    // (click = include, click again = exclude, third click = off) — there are
    // far too many creators for a dropdown, so they get a search box instead
    // of a chip wall. `showPartial` reveals unfinished pages, which are hidden
    // from browsing by default; `curataOnly` narrows to admin-picked pages.
    function blankState() {
      return {
        includeTeams: [], excludeTeams: [], includeTags: [], excludeTags: [],
        includeSources: [], excludeSources: [], includeCreators: [], excludeCreators: [],
        creatorQuery: '', showPartial: !!opts.partialOn, curataOnly: false, favOnly: false,
        sort: DEFAULT_SORT, dir: DEFAULT_DIR,
        // 'team': one section per team; 'none': every card in one grid, so
        // the sort runs across all of them at once; 'author': one section
        // per creator (see sections()).
        group: DEFAULT_GROUP
      };
    }
    var ctrl = { state: blankState() };
    // The reader's saved characters (assets/favorites.js): the ones saved
    // directly plus every character on a saved script or collection. A Set
    // once known; null while loading, when logged out, or when nothing here
    // is saved — and then the chip is simply not shown.
    var FAV_SET = null;
    var ALL_CREATORS = [];

    // Collect tags & creators (canonical tag list lives in assets/tags.js).
    // Only offer tag chips for tags that appear in the list — on a
    // collection view this keeps the bar from being a wall of unused chips.
    var tagSet = {}, creatorSet = {};
    list.forEach(function (c) {
      splitTags(c).forEach(function (t) { tagSet[titleCase(t)] = 1; });
      // Co-credited pages ("Taiyi (太一), Saki") give every name its own chip.
      window.splitCreators(c.creator).forEach(function (n) { creatorSet[n] = 1; });
    });
    var tags = Object.keys(tagSet).sort();
    var creators = Object.keys(creatorSet).sort(function (a, b) { return a.toLowerCase() < b.toLowerCase() ? -1 : 1; });

    var html = '';
    // Teams
    html += '<div class="filter-group"><span class="filter-group-label">Team</span><div class="filter-chips" id="fc-teams">';
    TEAMS.forEach(function (t) {
      if (!list.some(function (c) { return c.team === t[0]; })) return;
      html += '<button type="button" class="filter-chip" data-team="' + t[0] + '">' + t[1] + '</button>';
    });
    html += '</div></div>';
    // Tags
    if (tags.length) {
      html += '<div class="filter-group"><span class="filter-group-label">Tag</span><div class="filter-chips" id="fc-tags">';
      tags.forEach(function (t) { html += '<button type="button" class="filter-chip" data-tag="' + esc(t) + '">' + esc(t) + '</button>'; });
      html += '</div></div>';
    }
    // Source (From Collection / From Script) — collection takes precedence.
    // Only offer the chips whose source actually appears in the list.
    var srcSet = {};
    list.forEach(function (c) { var s = sourceOf(c); if (s) srcSet[s] = 1; });
    var srcPresent = SOURCE_LABELS.filter(function (s) { return srcSet[s[0]]; });
    if (srcPresent.length) {
      html += '<div class="filter-group"><span class="filter-group-label">Source</span><div class="filter-chips" id="fc-sources">';
      srcPresent.forEach(function (s) { html += '<button type="button" class="filter-chip" data-source="' + esc(s[0]) + '">' + esc(s[1]) + '</button>'; });
      html += '</div></div>';
    }
    // Status (Partial / Curata). Partial pages are hidden until the
    // reader asks for them; Curata is a narrowing filter.
    var nPartial = list.filter(function (c) { return window.isPartial(c); }).length;
    var nCurata = list.filter(function (c) { return window.isCurata(c); }).length;
    // The Favorites chip is built hidden: the saved list arrives after the
    // bar does, and the chip shows once something on the page is in it.
    var wantFav = !!window.Favorites;
    if (nPartial || nCurata || wantFav) {
      html += '<div class="filter-group" id="fc-status-group"' + (nPartial || nCurata ? '' : ' hidden') + '><span class="filter-group-label">Status</span><div class="filter-chips" id="fc-status">';
      if (nPartial) {
        html += '<button type="button" class="filter-chip' + (opts.partialOn ? ' active' : '') + '" id="fc-partial" title="Unfinished pages, missing tags or almanac text. Hidden unless ticked.">Show Partial (' + nPartial + ')</button>';
      }
      if (nCurata) {
        html += '<button type="button" class="filter-chip filter-chip-curata" id="fc-curata" title="Curata: pages the wiki admins have picked out.">Curata only (' + nCurata + ')</button>';
      }
      if (wantFav) {
        html += '<button type="button" class="filter-chip filter-chip-fav" id="fc-fav" hidden title="Characters you saved, plus those on scripts and collections you saved.">' + window.Favorites.heartSVG() + ' Favorites</button>';
      }
      html += '</div></div>';
    }
    // Creator — a search box plus 3-state chips. The full creator list is
    // hundreds long, so only matches for the current search are shown;
    // anything already picked stays pinned above the search results.
    ALL_CREATORS = creators;
    if (creators.length > 1) {
      html += '<div class="filter-group filter-group-creators"><span class="filter-group-label">Creator</span>' +
        '<div class="filter-chip-selected-row" id="fc-creator-selected"></div>' +
        '<input type="search" class="filter-search" id="fc-creator-search" ' +
          'placeholder="Search ' + creators.length + ' creators…" autocomplete="off" aria-label="Search creators">' +
        '<div class="filter-chips-scroll" id="fc-creator-list"></div>' +
        '</div>';
    }
    // Sort
    html += '<div class="filter-group"><span class="filter-group-label">Sort</span><select class="filter-select" id="fc-sort">' +
      sorts.map(function (s) {
        return '<option value="' + esc(s[0]) + '"' + (s[0] === DEFAULT_SORT ? ' selected' : '') + '>' + esc(s[1]) + '</option>';
      }).join('') +
      '</select></div>';
    // Ascending / descending, right beside Sort.
    html += '<div class="filter-group"><span class="filter-group-label">Order</span><select class="filter-select" id="fc-dir" aria-label="Sort direction"' +
      (DEFAULT_SORT === 'relevance' ? ' disabled' : '') + '>' +
      '<option value="asc"' + (DEFAULT_DIR === 'asc' ? ' selected' : '') + '>Ascending</option>' +
      '<option value="desc"' + (DEFAULT_DIR === 'desc' ? ' selected' : '') + '>Descending</option>' +
      '</select></div>';
    // Group — by team (a section each), all together in one grid, or by author.
    html += '<div class="filter-group"><span class="filter-group-label">Group</span><select class="filter-select" id="fc-group">' +
      '<option value="team"' + (DEFAULT_GROUP === 'team' ? ' selected' : '') + '>By team</option>' +
      '<option value="author"' + (DEFAULT_GROUP === 'author' ? ' selected' : '') + '>By author</option>' +
      '<option value="set"' + (DEFAULT_GROUP === 'set' ? ' selected' : '') + '>By script or collection</option>' +
      '<option value="none"' + (DEFAULT_GROUP === 'none' ? ' selected' : '') + '>All together</option>' +
      '</select></div>';
    // Reset
    html += '<div class="filter-group"><span class="filter-group-label">&nbsp;</span><button type="button" class="filter-reset" id="fc-reset">Reset filters</button></div>';

    bar.innerHTML = html;
    bar.hidden = false;

    // Mobile: the bar starts collapsed behind a "Filters" toggle (CSS hides
    // the bar below 640px unless .open is set; the button is display:none
    // on desktop, so this changes nothing there).
    if (toggle) {
      toggle.hidden = false;
      toggle.addEventListener('click', function () {
        var open = bar.classList.toggle('open');
        toggle.classList.toggle('open', open);
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    }

    function byId(id) { return bar.querySelector('#' + id); }
    function changed() { updateToggle(); onChange(); }

    // unset → include → exclude → unset, for teams, tags and sources alike.
    function cycle(btn, inc, exc, v) {
      var ii = inc.indexOf(v), ei = exc.indexOf(v);
      if (ii === -1 && ei === -1) {
        inc.push(v);
        btn.classList.add('active');
        btn.classList.remove('active-exclude');
      } else if (ii !== -1) {
        inc.splice(ii, 1);
        exc.push(v);
        btn.classList.remove('active');
        btn.classList.add('active-exclude');
      } else {
        exc.splice(ei, 1);
        btn.classList.remove('active-exclude');
      }
    }
    // Wire events
    bar.querySelectorAll('[data-team]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        cycle(btn, ctrl.state.includeTeams, ctrl.state.excludeTeams, btn.getAttribute('data-team'));
        changed();
      });
    });
    bar.querySelectorAll('[data-tag]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        cycle(btn, ctrl.state.includeTags, ctrl.state.excludeTags, btn.getAttribute('data-tag'));
        changed();
      });
    });
    bar.querySelectorAll('[data-source]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        cycle(btn, ctrl.state.includeSources, ctrl.state.excludeSources, btn.getAttribute('data-source'));
        changed();
      });
    });
    // ── Status chips ──
    var partialBtn = byId('fc-partial');
    if (partialBtn) partialBtn.addEventListener('click', function () {
      ctrl.state.showPartial = !ctrl.state.showPartial;
      partialBtn.classList.toggle('active', ctrl.state.showPartial);
      changed();
    });
    var curataBtn = byId('fc-curata');
    if (curataBtn) curataBtn.addEventListener('click', function () {
      ctrl.state.curataOnly = !ctrl.state.curataOnly;
      curataBtn.classList.toggle('active', ctrl.state.curataOnly);
      changed();
    });
    // ── Favorites chip ──
    // Counted against the current list, so a collection-scoped view (or a
    // search) says how many of its characters are saved. Re-counted after a
    // toggle elsewhere on the page through onChange. ?favorites=1 opens the
    // page on the chip; the account page links here that way.
    var favBtn = byId('fc-fav');
    var favLoad = function () {};
    if (favBtn) {
      favBtn.addEventListener('click', function () {
        ctrl.state.favOnly = !ctrl.state.favOnly;
        favBtn.classList.toggle('active', ctrl.state.favOnly);
        changed();
      });
      // Only re-draws the list when the list depends on the answer (the
      // chip is on, or has just been switched on or off). Every heart on
      // the cards (assets/card-actions.js) calls this through onChange,
      // and re-drawing 1,500 cards for one of them would throw the reader
      // back to the top of the page.
      favLoad = function (quiet) {
        window.Favorites.characterSlugs().then(function (set) {
          var wasOn = ctrl.state.favOnly;
          FAV_SET = set;
          var n = set ? countList.filter(function (c) { return set.has(c.slug); }).length : 0;
          favBtn.hidden = !n;
          favBtn.innerHTML = window.Favorites.heartSVG() + ' Favorites' + (n ? ' (' + n + ')' : '');
          var group = byId('fc-status-group');
          if (group && !partialBtn && !curataBtn) group.hidden = !n;
          if (!n && ctrl.state.favOnly) { ctrl.state.favOnly = false; favBtn.classList.remove('active'); }
          if (n && !ctrl.state.favOnly && /[?&]favorites=1(&|$)/.test(location.search) && !favLoad.opened) {
            favLoad.opened = true;
            ctrl.state.favOnly = true; favBtn.classList.add('active');
          }
          if (!quiet && (wasOn || ctrl.state.favOnly)) changed();
        });
      };
      favLoad();
      window.Favorites.onChange(function () { favLoad(); });
    }

    // ── Creator search + 3-state chips ──
    /* Creators matching the search box, capped so a blank search doesn't
       paint every creator on the wiki. Picked creators are drawn separately. */
    var CREATOR_LIST_CAP = 40;
    function matchingCreators() {
      var q = ctrl.state.creatorQuery.trim().toLowerCase();
      return ALL_CREATORS.filter(function (c) {
        if (ctrl.state.includeCreators.indexOf(c) !== -1) return false;
        if (ctrl.state.excludeCreators.indexOf(c) !== -1) return false;
        return !q || c.toLowerCase().indexOf(q) !== -1;
      });
    }
    function cycleCreator(name) {
      var st = ctrl.state;
      var ii = st.includeCreators.indexOf(name);
      var ei = st.excludeCreators.indexOf(name);
      if (ii === -1 && ei === -1) st.includeCreators.push(name);
      else if (ii !== -1) { st.includeCreators.splice(ii, 1); st.excludeCreators.push(name); }
      else st.excludeCreators.splice(ei, 1);
    }
    function creatorChipHTML(name, cls) {
      return '<button type="button" class="filter-chip' + (cls ? ' ' + cls : '') +
        '" data-creator="' + esc(name) + '">' + esc(name) + '</button>';
    }
    function renderCreatorChips() {
      var selected = byId('fc-creator-selected');
      var listEl = byId('fc-creator-list');
      if (!selected || !listEl) return;
      var st = ctrl.state;
      selected.innerHTML =
        st.includeCreators.map(function (c) { return creatorChipHTML(c, 'active'); }).join('') +
        st.excludeCreators.map(function (c) { return creatorChipHTML(c, 'active-exclude'); }).join('');
      var matches = matchingCreators();
      var shown = matches.slice(0, CREATOR_LIST_CAP);
      listEl.innerHTML = shown.map(function (c) { return creatorChipHTML(c, ''); }).join('') +
        (matches.length > shown.length
          ? '<span class="filter-more">+' + (matches.length - shown.length) + ' more (keep typing)</span>'
          : '') +
        (!matches.length && st.creatorQuery.trim()
          ? '<span class="filter-more">No creator matches “' + esc(st.creatorQuery.trim()) + '”</span>'
          : '');
      // Re-wire: both rows are rebuilt on every keystroke.
      bar.querySelectorAll('[data-creator]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          cycleCreator(btn.getAttribute('data-creator'));
          renderCreatorChips();
          changed();
        });
      });
    }
    var crSearch = byId('fc-creator-search');
    if (crSearch) {
      crSearch.addEventListener('input', function () {
        ctrl.state.creatorQuery = crSearch.value;
        renderCreatorChips();
      });
      // Enter picks the only match, which makes the search usable one-handed
      // on a phone without hunting for the chip.
      crSearch.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        var matches = matchingCreators();
        if (matches.length === 1) { cycleCreator(matches[0]); crSearch.value = ''; ctrl.state.creatorQuery = ''; }
        renderCreatorChips();
        changed();
      });
      renderCreatorChips();
    }

    var sortSel = byId('fc-sort'), groupSel = byId('fc-group'), dirSel = byId('fc-dir');
    sortSel.addEventListener('change', function (e) {
      ctrl.state.sort = e.target.value;
      ctrl.state.dir = NATURAL_DIR[ctrl.state.sort] || 'asc';
      dirSel.value = ctrl.state.dir;
      dirSel.disabled = ctrl.state.sort === 'relevance';
      changed();
    });
    dirSel.addEventListener('change', function (e) { ctrl.state.dir = e.target.value; changed(); });
    groupSel.addEventListener('change', function (e) { ctrl.state.group = e.target.value; changed(); });
    ctrl.reset = function () {
      ctrl.state = blankState();
      bar.querySelectorAll('.filter-chip').forEach(function (b) { b.classList.remove('active', 'active-exclude'); });
      if (partialBtn && ctrl.state.showPartial) partialBtn.classList.add('active');
      if (crSearch) crSearch.value = '';
      renderCreatorChips();
      sortSel.value = DEFAULT_SORT;
      dirSel.value = DEFAULT_DIR;
      dirSel.disabled = DEFAULT_SORT === 'relevance';
      groupSel.value = DEFAULT_GROUP;
      changed();
    };
    byId('fc-reset').addEventListener('click', ctrl.reset);

    ctrl.activeCount = function () {
      var st = ctrl.state;
      return st.includeTeams.length + st.excludeTeams.length +
        st.includeTags.length + st.excludeTags.length +
        st.includeSources.length + st.excludeSources.length +
        st.includeCreators.length + st.excludeCreators.length +
        (st.showPartial !== !!opts.partialOn ? 1 : 0) + (st.curataOnly ? 1 : 0) + (st.favOnly ? 1 : 0);
    };
    function updateToggle() {
      if (!toggle) return;
      var n = ctrl.activeCount();
      toggle.innerHTML = 'Filters' + (n ? ' (' + n + ')' : '') +
        ' <span class="filter-toggle-arrow">&#9662;</span>';
    }

    ctrl.apply = function (input) {
      var st = ctrl.state, out = input.slice();
      // Partial (unfinished) pages are out of the list unless asked for.
      if (!st.showPartial) out = out.filter(function (c) { return !window.isPartial(c); });
      if (st.curataOnly) out = out.filter(function (c) { return window.isCurata(c); });
      if (st.favOnly) out = out.filter(function (c) { return !!(FAV_SET && FAV_SET.has(c.slug)); });
      if (st.includeTeams.length) out = out.filter(function (c) { return st.includeTeams.indexOf(c.team) !== -1; });
      if (st.excludeTeams.length) out = out.filter(function (c) { return st.excludeTeams.indexOf(c.team) === -1; });
      if (st.includeTags.length) out = out.filter(function (c) {
        var ct = splitTags(c).map(titleCase);
        return st.includeTags.every(function (t) { return ct.indexOf(t) !== -1; });
      });
      if (st.excludeTags.length) out = out.filter(function (c) {
        var ct = splitTags(c).map(titleCase);
        return st.excludeTags.every(function (t) { return ct.indexOf(t) === -1; });
      });
      if (st.includeSources.length) out = out.filter(function (c) { return st.includeSources.indexOf(sourceOf(c)) !== -1; });
      if (st.excludeSources.length) out = out.filter(function (c) { return st.excludeSources.indexOf(sourceOf(c)) === -1; });
      // Creators: include = must be one of these; exclude = must be none of them.
      if (st.includeCreators.length) out = out.filter(function (c) {
        return window.splitCreators(c.creator).some(function (n) { return st.includeCreators.indexOf(n) !== -1; });
      });
      if (st.excludeCreators.length) out = out.filter(function (c) {
        return !window.splitCreators(c.creator).some(function (n) { return st.excludeCreators.indexOf(n) !== -1; });
      });
      // sort ('relevance' keeps the order it was handed, best match first)
      var flip = st.dir === 'desc' ? -1 : 1;
      if (st.sort === 'name') out.sort(function (a, b) { return flip * cmpName(a, b); });
      else if (st.sort === 'ability') out.sort(function (a, b) {
        // Ties (and every blank ability) fall back to the name, A–Z.
        return flip * ((a.ability || '').length - (b.ability || '').length) || cmpName(a, b);
      });
      else if (st.sort === 'recent') {
        // The feed is oldest first. Without a position function every step
        // above was a filter, which keeps that order, so ascending is the
        // order as it stands and descending is it reversed.
        if (opts.order) out.sort(function (a, b) { return flip * (opts.order(a) - opts.order(b)); });
        else if (flip < 0) out.reverse();
      }
      return out;
    };

    // Re-count the status chips against another list (the search page's
    // current results). The chips stay put even at zero, so they do not
    // jump around while somebody types.
    ctrl.counts = function (next) {
      countList = next;
      if (partialBtn) partialBtn.textContent = 'Show Partial (' + next.filter(function (c) { return window.isPartial(c); }).length + ')';
      if (curataBtn) curataBtn.textContent = 'Curata only (' + next.filter(function (c) { return window.isCurata(c); }).length + ')';
      if (favBtn && FAV_SET) favLoad(true);
    };

    updateToggle();
    return ctrl;
  }

  /* Which script or collection a character belongs to, for "Group: By script
     or collection": {key, name, href} or null. The same order the Worker
     files a character's address in (characterQualifier()), so the section a
     card lands in is the set its URL is under:
       1. a collection named in its "Appears in" (id, slug, display name or a
          match term, ignoring case and punctuation),
       2. a script named there,
       3. the set named there even when this wiki has no page for it,
       4. a collection that lists it by hand (appearsInFrom, or include[]),
       5. a script whose roster lists it.
     A character in several is filed under the first, so it appears once. */
  function makeSetOf(collections, scripts) {
    var colls = (collections || []).filter(function (c) { return c && !c.standalone; });
    var scs = scripts || [];
    function collRef(c) { return { key: 'c:' + (c.id || c.slug), name: c.displayName || c.slug, href: 'collection/' + encodeURIComponent(c.id || c.slug) }; }
    function scriptRef(s) { return { key: 's:' + s.slug, name: s.name || s.slug, href: 's/' + encodeURIComponent(s.slug) }; }
    var collByKey = {}, scriptByKey = {}, collById = {}, scriptBySlug = {};
    colls.forEach(function (c) {
      [c.id, c.slug, c.displayName].concat(c.match || []).forEach(function (k) {
        k = norm(k); if (k && !collByKey[k]) collByKey[k] = c;
      });
      if (c.id) collById[c.id] = c;
    });
    scs.forEach(function (s) {
      [s.name, s.slug].forEach(function (k) { k = norm(k); if (k && !scriptByKey[k]) scriptByKey[k] = s; });
      (s.characters || []).forEach(function (sl) { if (!scriptBySlug[sl]) scriptBySlug[sl] = s; });
    });
    return function (c) {
      var segs = String(c.appearsIn || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
      var i, hit;
      for (i = 0; i < segs.length; i++) {
        hit = collByKey[norm(segs[i])];
        if (hit && (hit.exclude || []).indexOf(c.slug) === -1) return collRef(hit);
      }
      for (i = 0; i < segs.length; i++) { hit = scriptByKey[norm(segs[i])]; if (hit) return scriptRef(hit); }
      if (segs.length) return { key: 't:' + norm(segs[0]), name: segs[0], href: '' };
      var from = (c.appearsInFrom || [])[0];
      if (from && collById[from.id]) return collRef(collById[from.id]);
      if (from && from.name) return { key: 'c:' + (from.id || norm(from.name)), name: from.name, href: from.id ? 'collection/' + encodeURIComponent(from.id) : '' };
      for (i = 0; i < colls.length; i++) {
        if ((colls[i].include || []).indexOf(c.slug) !== -1 && (colls[i].exclude || []).indexOf(c.slug) === -1) return collRef(colls[i]);
      }
      hit = scriptBySlug[c.slug];
      return hit ? scriptRef(hit) : null;
    };
  }

  // One heading per group of sections: a name, linked when it has a page.
  function bucketSections(list, keyOf, groups, emptyLabel) {
    var by = {}, keys = [], none = [];
    list.forEach(function (c) {
      var k = keyOf(c);
      if (!k) { none.push(c); return; }
      if (!by[k.key]) { by[k.key] = { name: k.name, href: k.href, items: [] }; keys.push(k.key); }
      by[k.key].items.push(c);
    });
    keys.sort(function (a, b) { return by[a].name.localeCompare(by[b].name, undefined, { sensitivity: 'base' }); });
    var secs = keys.map(function (k) { return by[k]; });
    if (none.length) secs.push({ name: '', items: none });
    return secs.map(function (sec, i) {
      groups.push({ selector: '.char-grid[data-group="g' + i + '"]', items: sec.items });
      var head = !sec.name ? emptyLabel
        : sec.href ? '<a href="' + esc(sec.href) + '" class="team-header-link">' + esc(sec.name) + '</a>'
        : esc(sec.name);
      return '<section class="type-section cf-author-sec"><h2 class="type-header">' + head +
        ' <span class="coll-team-count">(' + sec.items.length + ')</span></h2><div class="type-rule"></div>' +
        '<div class="char-grid" data-group="g' + i + '"></div></section>';
    }).join('');
  }

  /* A filtered list laid out the way `group` says: {html, groups}, where
     `groups` is what viewport.js's mountCardBatches() takes. Each section
     keeps the order the list arrived in, so the sort runs inside it.

     By author, a character credited to several people ("Taiyi, Saki") is
     filed under the FIRST name only: one card per character, and the count
     still adds up to the list. Authors run A–Z, uncredited pages last. */
  function sections(list, group, setOf) {
    var groups = [], html;
    if (group === 'none') {
      groups.push({ selector: '.char-grid[data-group="all"]', items: list });
      return { html: '<section class="type-section" id="all"><div class="char-grid" data-group="all"></div></section>', groups: groups };
    }
    if (group === 'author') {
      var html2 = bucketSections(list, function (c) {
        var first = (window.splitCreators ? window.splitCreators(c.creator) : [String(c.creator || '').trim()])[0];
        return first ? { key: first.toLowerCase(), name: first, href: 'author?a=' + encodeURIComponent(first) } : null;
      }, groups, 'No creator listed');
      return { html: html2, groups: groups };
    }
    if (group === 'set' && setOf) {
      return { html: bucketSections(list, setOf, groups, 'Not in a script or collection'), groups: groups };
    }
    html = TEAMS.map(function (t) {
      var chars = list.filter(function (c) { return c.team === t[0]; });
      if (!chars.length) return '';
      groups.push({ selector: '.char-grid[data-group="' + t[0] + '"]', items: chars });
      return '<section class="type-section" id="' + t[0] + '"><h2 class="type-header"><a href="team?t=' + t[0] + '" class="team-header-link">' + t[1] + '</a></h2><div class="type-rule"></div><div class="char-grid" data-group="' + t[0] + '"></div></section>';
    }).join('');
    return { html: html, groups: groups };
  }

  window.CharFilters = {
    mount: mount, card: card, thumb: thumb, makeSourceOf: makeSourceOf, makeSetOf: makeSetOf, sections: sections,
    inCollection: inCollection, norm: norm, TEAMS: TEAMS, TEAM_LABEL: TEAM_LABEL, GOOD: GOOD
  };
})();
