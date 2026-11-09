/* The filter box on pages whose cards are already drawn: collection pages
   (/collection/{id}), creator pages (/u/, /author), /favorites, /drafts and
   the Script Builder's Add sidebar.

   It is the All Characters box (assets/char-filters.js), one box with one
   set of rules everywhere: this file reads each card's data-* attributes
   into a row, hands the rows to CharFilters.mount(), and lays the cards it
   gets back out in the DOM (hidden, re-ordered, regrouped). No data is
   re-fetched, and with JavaScript off every card still shows.

   mountCardFilters({grid, bar, toggle, count, ...}) wires one box to one
   grid. Load char-filters.js first. The auto-init at the bottom mounts the
   collection page's box; the other pages call it once their cards are in. */
(function () {
  'use strict';

  var TEAMS = [
    ['townsfolk', 'Townsfolk'], ['outsider', 'Outsider'], ['minion', 'Minion'],
    ['demon', 'Demon'], ['traveller', 'Traveller'], ['fabled', 'Fabled'],
    ['loric', 'Loric'], ['other', 'Other']
  ];

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  // data-creator holds the whole credit string, which may name several people.
  function cardCredits(card) {
    return (card.getAttribute('data-creator') || '').split(',')
      .map(function (n) { return n.trim(); }).filter(Boolean);
  }
  function el(x) { return typeof x === 'string' ? document.getElementById(x) : x; }

  /* opts: {grid, bar, toggle, count} — elements or element ids — plus optional
     {label, noun, minCards, defaultSort: 'page', groupChoice: false,
      sourceChips: [[value, label]] over data-source, search: a name box}.

     The markup it filters is described by five selectors, defaulting to the
     card grid renderRosterCards() produces; the Script Builder's sidebar is a
     list of rows and passes its own. Anything it drives carries the same
     data-* attributes the cards do.

     Returns false when there is nothing worth filtering, so the caller can
     hide its filter box. */
  function mountCardFilters(opts) {
    opts = opts || {};
    var CF = window.CharFilters;
    var grid = el(opts.grid), bar = el(opts.bar), toggle = el(opts.toggle);
    var countEl = el(opts.count), searchEl = el(opts.search);
    if (!CF || !grid || !bar || !toggle) return false;
    // Mounting again over the same grid (the Script Builder rebuilds its
    // panel under a different grouping) takes the old box down first, or
    // the search box would answer to two sets of listeners.
    if (typeof grid._cfDestroy === 'function') grid._cfDestroy();

    var SEL = {
      section: opts.sectionSel || '.coll-team',
      inner: opts.innerSel || '.char-grid',
      card: opts.cardSel || '.char-card',
      count: opts.sectionCountSel || '.coll-team-count',
      ability: opts.abilitySel || '.char-card-ability'
    };
    var noun = opts.noun || 'character';
    var sections = [].slice.call(grid.querySelectorAll(SEL.section));
    var cards = [].slice.call(grid.querySelectorAll(SEL.card));
    var total = cards.length;
    if (!total || total < (opts.minCards || 1)) return false;

    // Each team grid's original card order: page order, and where a card
    // goes back to when grouped by team.
    sections.forEach(function (sec) {
      var g = sec.querySelector(SEL.inner);
      if (g) sec._origOrder = [].slice.call(g.querySelectorAll(SEL.card));
    });

    function teamOf(card) {
      var ct = card.getAttribute('data-team') || 'other';
      return TEAMS.some(function (x) { return x[0] === ct; }) ? ct : 'other';
    }
    function authorKey(card) { return (cardCredits(card)[0] || '').toLowerCase(); }
    function setKey(card) { return (card.getAttribute('data-set') || '').trim().toLowerCase(); }
    function distinct(fn) { var seen = {}; cards.forEach(function (c) { seen[fn(c)] = 1; }); return Object.keys(seen).length; }

    // One row per card, in the shape CharFilters filters and sorts.
    var rows = cards.map(function (card) {
      var ab = card.querySelector(SEL.ability);
      return {
        el: card,
        slug: card.getAttribute('data-slug') || '',
        name: card.getAttribute('data-name') || '',
        team: teamOf(card),
        tags: card.getAttribute('data-tags') || '',
        creator: card.getAttribute('data-creator') || '',
        ability: ab ? ab.textContent.trim() : '',
        source: card.getAttribute('data-source') || '',
        official: card.getAttribute('data-official') === '1',
        order: +card.getAttribute('data-order') || 0,
        _partial: card.getAttribute('data-partial') === '1',
        _curata: card.getAttribute('data-curata') === '1'
      };
    });

    // Group is offered on the card grids renderRosterCards() draws, with
    // the options that would change anything here.
    var groups = ['team'];
    if (opts.groupChoice !== false && !opts.sectionSel) {
      if (distinct(authorKey) > 1) groups.push('author');
      if (distinct(setKey) > 1) groups.push('set');
      if (sections.length > 1) groups.push('none');
    }
    var SOURCES = Array.isArray(opts.sourceChips) ? opts.sourceChips : [];

    var ctrl = CF.mount({
      bar: bar, toggle: toggle, list: rows, label: opts.label || 'Filter characters',
      sourceOf: SOURCES.length ? function (r) { return r.source || null; } : null,
      sourceLabels: SOURCES,
      // Where the page has an order worth keeping (a collection its author
      // arranged), it is offered and shown first.
      pageOrder: opts.defaultSort === 'page',
      defaultSort: opts.defaultSort === 'page' ? 'page' : 'name',
      groups: groups,
      order: function (r) { return r.order; },
      onChange: apply
    });

    var RANK = new Map();
    function cardVisible(card) { return RANK.has(card); }
    function sortArr(arr) {
      var keyed = arr.map(function (card, i) { return { card: card, i: i, r: RANK.has(card) ? RANK.get(card) : Infinity }; });
      keyed.sort(function (x, y) { return (x.r - y.r) || (x.i - y.i); });
      for (var i = 0; i < keyed.length; i++) arr[i] = keyed[i].card;
      return arr;
    }

    // The one grid "All together" uses, built the first time it is asked
    // for, above the team sections it empties. Not a .coll-team, so nothing
    // that reads the team sections mistakes it for one.
    var flat = null;
    function flatGrid() {
      if (!flat) {
        flat = document.createElement('section');
        flat.className = 'type-section cf-flat';
        flat.innerHTML = '<div class="char-grid"></div>';
        sections[0].parentNode.insertBefore(flat, sections[0]);
      }
      return flat.querySelector('.char-grid');
    }

    // "By author" / "By script or collection": one section per key, A–Z,
    // the cards with none last. Built the first time each is asked for,
    // above the team sections; like the flat grid, not a .coll-team.
    var KEYED = {
      author: { key: authorKey, name: function (c) { return cardCredits(c)[0] || ''; },
                href: function (n) { return '/author?a=' + encodeURIComponent(n); }, none: 'No creator listed' },
      set: { key: setKey, name: function (c) { return (c.getAttribute('data-set') || '').trim(); },
             href: null, none: 'Not in a script or collection' }
    };
    var keyedSecs = {};   // kind -> {key -> section}
    function keyedGrids(kind) {
      if (keyedSecs[kind]) return keyedSecs[kind];
      // Keyed by author and set names, so no prototype: a creator called
      // "Constructor" found Object's and threw.
      var spec = KEYED[kind], by = Object.create(null), keys = [];
      sections.forEach(function (sec) {
        (sec._origOrder || []).forEach(function (card) {
          var key = spec.key(card);
          if (!by[key]) { by[key] = { name: spec.name(card) }; keys.push(key); }
        });
      });
      keys.sort(function (a, b) {
        if (!a) return 1; if (!b) return -1;
        return by[a].name.localeCompare(by[b].name, undefined, { sensitivity: 'base' });
      });
      var wrap = document.createElement('div');
      wrap.className = 'cf-keyed cf-' + kind;
      var out = Object.create(null);
      keys.forEach(function (key) {
        var sec = document.createElement('section'), name = by[key].name;
        sec.className = 'type-section cf-author-sec';
        sec.innerHTML = '<h2 class="type-header">' + (!name ? spec.none
          : spec.href ? '<a class="team-header-link" href="' + esc(spec.href(name)) + '">' + esc(name) + '</a>'
          : esc(name)) +
          ' <span class="cf-author-count"></span></h2><div class="type-rule"></div><div class="char-grid"></div>';
        wrap.appendChild(sec);
        out[key] = sec;
      });
      sections[0].parentNode.insertBefore(wrap, sections[0]);
      keyedSecs[kind] = out;
      return out;
    }

    /* Cards are gathered into a DocumentFragment and put back with ONE
       append per grid. Appending them one at a time is one DOM mutation per
       card, and every MutationObserver on the page (the site-text overrides
       in site.js, the quick actions in card-actions.js) then has to look at
       each of them — on the Script Builder's sidebar that made one tap of
       a sort take seconds. Same order, same nodes, same listeners. */
    function appendAll(grid, cards) {
      var frag = document.createDocumentFragment();
      cards.forEach(function (card) { frag.appendChild(card); });
      grid.appendChild(frag);
    }

    function sortCards() {
      if (KEYED[ctrl.state.group]) {
        var everyone = [];
        sections.forEach(function (sec) { if (sec._origOrder) everyone = everyone.concat(sec._origOrder); });
        var secs = keyedGrids(ctrl.state.group), keyOf = KEYED[ctrl.state.group].key;
        var byKey = {}, keys = [];
        sortArr(everyone).forEach(function (card) {
          var k = keyOf(card);
          if (!byKey[k]) { byKey[k] = []; keys.push(k); }
          byKey[k].push(card);
        });
        keys.forEach(function (k) { appendAll(secs[k].querySelector('.char-grid'), byKey[k]); });
        return;
      }
      if (ctrl.state.group === 'none') {
        // _origOrder is the order the server rendered, which IS "page order";
        // the sections laid end to end keep it.
        var all = [];
        sections.forEach(function (sec) { if (sec._origOrder) all = all.concat(sec._origOrder); });
        appendAll(flatGrid(), sortArr(all));
        return;
      }
      // Grouped: every card goes back to its own team's grid, in order.
      sections.forEach(function (sec) {
        var g = sec.querySelector(SEL.inner);
        if (!g || !sec._origOrder) return;
        appendAll(g, sortArr(sec._origOrder.slice()));
      });
    }

    // searchAbility (a boolean, or a function asked on each pass) lets the
    // name box match ability text too.
    function abilitySearch() {
      return typeof opts.searchAbility === 'function' ? !!opts.searchAbility() : !!opts.searchAbility;
    }
    // Only a change of sort or group moves the cards. Re-appending 3,700
    // rows on every letter typed was most of the cost of the Script
    // Builder's search box. A sort made while a filter hid some cards is
    // done again on the next pass, since the hidden ones were not ranked.
    var sortedSig = null;
    function setDisplay(card, vis) {
      var want = vis ? '' : 'none';
      if (card.style.display !== want) card.style.display = want;
    }
    function apply() {
      clearTimeout(searchTimer); searchTimer = 0;
      var q = searchEl ? searchEl.value.trim().toLowerCase() : '';
      var ab = q && abilitySearch();
      var list = q ? rows.filter(function (r) {
        return r.name.toLowerCase().indexOf(q) !== -1 || (ab && r.ability.toLowerCase().indexOf(q) !== -1);
      }) : rows;
      RANK = new Map();
      var ranked = ctrl.apply(list);
      ranked.forEach(function (r, i) { RANK.set(r.el, i); });
      var sig = ctrl.state.sort + '|' + ctrl.state.dir + '|' + ctrl.state.group;
      if (sig !== sortedSig) {
        sortCards();
        sortedSig = ranked.length === rows.length ? sig : null;
      }
      var shown = 0;
      sections.forEach(function (sec) {
        var secShown = 0;
        [].slice.call(sec.querySelectorAll(SEL.card)).forEach(function (card) {
          var vis = cardVisible(card);
          setDisplay(card, vis);
          if (vis) { secShown++; shown++; }
        });
        sec.style.display = secShown ? '' : 'none';
        var cnt = sec.querySelector(SEL.count);
        if (cnt) cnt.textContent = '(' + secShown + ')';
      });
      Object.keys(keyedSecs).forEach(function (kind) { Object.keys(keyedSecs[kind]).forEach(function (key) {
        var sec = keyedSecs[kind][key], n = 0;
        [].slice.call(sec.querySelectorAll(SEL.card)).forEach(function (card) {
          var vis = cardVisible(card);
          card.style.display = vis ? '' : 'none';
          if (vis) { n++; shown++; }
        });
        sec.style.display = n ? '' : 'none';
        sec.querySelector('.cf-author-count').textContent = '(' + n + ')';
      }); });
      if (flat) {
        var flatShown = 0;
        [].slice.call(flat.querySelectorAll(SEL.card)).forEach(function (card) {
          var vis = cardVisible(card);
          card.style.display = vis ? '' : 'none';
          if (vis) { flatShown++; shown++; }
        });
        flat.style.display = flatShown ? '' : 'none';
      }
      var active = ctrl.activeCount() + (q ? 1 : 0);
      if (countEl) {
        countEl.textContent = (!active || shown === total)
          ? shown + ' ' + noun + (shown === 1 ? '' : 's')
          : shown + ' of ' + total + ' ' + noun + (total === 1 ? '' : 's');
      }
    }
    // On a long list the name box waits for a pause in the typing: each
    // pass re-lays out every row, and on the Script Builder's 3,700 the
    // keystrokes queued up behind each other. flush() runs a waiting pass.
    var searchTimer = 0;
    function onSearch() {
      clearTimeout(searchTimer);
      if (total < 400) { apply(); return; }
      searchTimer = setTimeout(apply, 160);
    }
    function flush() { if (searchTimer) apply(); }
    if (searchEl) searchEl.addEventListener('input', onSearch);
    var reset = bar.querySelector('#fc-reset');
    function onReset() { searchEl.value = ''; apply(); }
    if (reset && searchEl) reset.addEventListener('click', onReset);

    function destroy() {
      clearTimeout(searchTimer);
      if (searchEl) searchEl.removeEventListener('input', onSearch);
      if (reset) reset.removeEventListener('click', onReset);
      if (grid._cfDestroy === destroy) grid._cfDestroy = null;
    }
    grid._cfDestroy = destroy;

    apply();
    return { apply: apply, flush: flush, destroy: destroy, state: ctrl.state };
  }

  if (typeof window !== 'undefined') window.mountCardFilters = mountCardFilters;

  // Auto-init for SSR collection pages, which carry the filter box in their
  // server-rendered markup. Creator pages mount their own after rendering.
  if (typeof document !== 'undefined' && document.getElementById('coll-grid')) {
    var ok = mountCardFilters({
      grid: 'coll-grid', bar: 'coll-filter-bar',
      toggle: 'coll-filter-toggle', count: 'coll-chars-count',
      // A collection's roster order is the author's — set in the editor and
      // rendered by the server — so it is what a reader sees first.
      defaultSort: 'page',
      // The reader's saved characters (favorites.js loads before this file
      // on a collection page). Hidden until something here is saved.
      favChip: true
    });
    if (!ok) {   // empty collection — nothing to filter
      var fc = document.getElementById('coll-filters');
      if (fc) fc.style.display = 'none';
    }
  }
  // Script pages: the roster is rows grouped by team, in the author's order.
  if (typeof document !== 'undefined' && document.getElementById('sv-roster')) {
    var okS = mountCardFilters({
      grid: 'sv-roster', bar: 'sv-filter-bar', toggle: 'sv-filter-toggle',
      sectionSel: '.script-team-group', innerSel: '.script-char-list', cardSel: '.script-char-row',
      sectionCountSel: '.script-team-count', abilitySel: '.script-char-ability',
      defaultSort: 'page'
    });
    if (!okS) {
      var fs = document.getElementById('sv-filters');
      if (fs) fs.style.display = 'none';
    }
  }
})();
