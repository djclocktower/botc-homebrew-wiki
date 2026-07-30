/* Shared on-page card filtering — the collapsed "Filter characters" box.

   Used by SSR collection pages (/collection/{id}) and by creator pages
   (/u/{username}, /author?a=Name). Both render the same .char-card markup via
   renderRosterCards() in render-page.js, so both can be filtered by the same
   code: no data is re-fetched, every card carries data-team / data-tags /
   data-creator / data-name / data-order / data-partial / data-starlight, and
   the page still works with JavaScript off (all cards shown).

   mountCardFilters({grid, bar, toggle, count, ...}) wires one filter box to one
   grid. The auto-init at the bottom mounts the collection page's box when it is
   present, so collection pages need no changes of their own; creator pages call
   it themselves once their cards are in the DOM. */
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
  function titleCase(s) {
    return String(s || '').trim().toLowerCase()
      .replace(/(^|[\s-])[a-z]/g, function (m) { return m.toUpperCase(); });
  }
  function cardTags(card) {
    return (card.getAttribute('data-tags') || '').split(',')
      .map(function (t) { return titleCase(t); }).filter(Boolean);
  }
  function el(x) { return typeof x === 'string' ? document.getElementById(x) : x; }

  /* opts: {grid, bar, toggle, count} — elements or element ids — plus optional
     {label, noun, partialChip, starlightChip, minCards}. Returns false when
     there is nothing worth filtering, so the caller can hide its filter box. */
  function mountCardFilters(opts) {
    opts = opts || {};
    var grid = el(opts.grid), bar = el(opts.bar), toggle = el(opts.toggle);
    var countEl = el(opts.count);
    if (!grid || !bar || !toggle) return false;

    var label = opts.label || 'Filter characters';
    var noun = opts.noun || 'character';
    var sections = [].slice.call(grid.querySelectorAll('.coll-team'));
    var cards = [].slice.call(grid.querySelectorAll('.char-card'));
    var total = cards.length;
    if (!total || total < (opts.minCards || 1)) return false;

    // Remember each team grid's original card order for the "recently added"
    // and default sorts (cards are laid out team-by-team, name A–Z).
    sections.forEach(function (sec) {
      var g = sec.querySelector('.char-grid');
      if (g) sec._origOrder = [].slice.call(g.querySelectorAll('.char-card'));
    });

    function freshState() {
      return { inTeams: [], exTeams: [], inTags: [], exTags: [], creator: '',
               showPartial: false, starlightOnly: false, sort: 'name-asc' };
    }
    var STATE = freshState();

    function teamOf(card) {
      var ct = card.getAttribute('data-team') || 'other';
      var known = TEAMS.some(function (x) { return x[0] !== 'other' && x[0] === ct; });
      return known ? ct : 'other';
    }

    // ── build the filter bar from what is actually present ──
    var teamsPresent = TEAMS.filter(function (t) {
      return cards.some(function (c) { return teamOf(c) === t[0]; });
    });
    var tagSet = {}, creatorSet = {}, nPartial = 0, nStar = 0;
    cards.forEach(function (c) {
      cardTags(c).forEach(function (t) { tagSet[t] = 1; });
      var cr = (c.getAttribute('data-creator') || '').trim();
      if (cr) creatorSet[cr] = 1;
      if (c.getAttribute('data-partial') === '1') nPartial++;
      if (c.getAttribute('data-starlight') === '1') nStar++;
    });
    var tags = Object.keys(tagSet).sort();
    var creators = Object.keys(creatorSet).sort(function (a, b) {
      return a.toLowerCase() < b.toLowerCase() ? -1 : 1;
    });

    var html = '';
    html += '<div class="filter-group"><span class="filter-group-label">Team</span><div class="filter-chips" id="cf-teams">';
    teamsPresent.forEach(function (t) {
      html += '<button type="button" class="filter-chip" data-team="' + t[0] + '">' + esc(t[1]) + '</button>';
    });
    html += '</div></div>';
    if (tags.length) {
      html += '<div class="filter-group"><span class="filter-group-label">Tag</span><div class="filter-chips" id="cf-tags">';
      tags.forEach(function (t) { html += '<button type="button" class="filter-chip" data-tag="' + esc(t) + '">' + esc(t) + '</button>'; });
      html += '</div></div>';
    }
    // Status chips are opt-in, and only appear when there is something for them
    // to do. Off by default because turning the Partial chip on also *hides*
    // Partial cards until it is ticked — right for a creator page (which the
    // wiki hides Partial from) and wrong for a collection page (which lists
    // whatever its author put in it). See "Page classification" in CLAUDE.md.
    var wantPartial = !!opts.partialChip && nPartial > 0;
    var wantStar = !!opts.starlightChip && nStar > 0;
    if (wantPartial || wantStar) {
      html += '<div class="filter-group"><span class="filter-group-label">Status</span><div class="filter-chips" id="cf-status">';
      if (wantPartial) {
        html += '<button type="button" class="filter-chip" id="cf-partial" title="Unfinished pages: an ability and an icon, but no tags, no almanac text and no mechanics. Hidden unless you tick this.">Show Partial (' + nPartial + ')</button>';
      }
      if (wantStar) {
        html += '<button type="button" class="filter-chip" id="cf-starlight" title="Pages the wiki admins have marked as Starlight.">&#10022; Starlight only (' + nStar + ')</button>';
      }
      html += '</div></div>';
    }
    if (creators.length > 1) {
      html += '<div class="filter-group"><span class="filter-group-label">Creator</span><select class="filter-select" id="cf-creator"><option value="">All creators</option>';
      creators.forEach(function (c) { html += '<option value="' + esc(c) + '">' + esc(c) + '</option>'; });
      html += '</select></div>';
    }
    html += '<div class="filter-group"><span class="filter-group-label">Sort</span><select class="filter-select" id="cf-sort">' +
      '<option value="name-asc">Name (A–Z)</option>' +
      '<option value="name-desc">Name (Z–A)</option>' +
      '<option value="recent">Recently added</option>' +
      '</select></div>';
    html += '<div class="filter-group"><span class="filter-group-label">&nbsp;</span><button type="button" class="filter-reset" id="cf-reset">Reset filters</button></div>';
    bar.innerHTML = html;
    // Visibility is governed by the .open class, not the [hidden] attribute
    // (the [hidden] rule is !important and would beat .open on mobile).
    bar.hidden = false;

    // ── collapse/expand (collapsed by default, works on every screen size) ──
    toggle.addEventListener('click', function () {
      var open = bar.classList.toggle('open');
      toggle.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    // ── 3-state chip helper (unset → include → exclude → unset) ──
    // The arrays are read through a getter because Reset swaps STATE wholesale.
    function wireChips(selector, pick) {
      bar.querySelectorAll(selector).forEach(function (btn) {
        var v = btn.getAttribute('data-team') || btn.getAttribute('data-tag');
        btn.addEventListener('click', function () {
          var arrs = pick();
          var ii = arrs.inArr.indexOf(v), ei = arrs.exArr.indexOf(v);
          if (ii === -1 && ei === -1) { arrs.inArr.push(v); btn.classList.add('active'); btn.classList.remove('active-exclude'); }
          else if (ii !== -1) { arrs.inArr.splice(ii, 1); arrs.exArr.push(v); btn.classList.remove('active'); btn.classList.add('active-exclude'); }
          else { arrs.exArr.splice(ei, 1); btn.classList.remove('active-exclude'); }
          apply();
        });
      });
    }
    wireChips('[data-team]', function () { return { inArr: STATE.inTeams, exArr: STATE.exTeams }; });
    wireChips('[data-tag]', function () { return { inArr: STATE.inTags, exArr: STATE.exTags }; });

    var partialBtn = bar.querySelector('#cf-partial');
    if (partialBtn) partialBtn.addEventListener('click', function () {
      STATE.showPartial = !STATE.showPartial;
      partialBtn.classList.toggle('active', STATE.showPartial);
      apply();
    });
    var starBtn = bar.querySelector('#cf-starlight');
    if (starBtn) starBtn.addEventListener('click', function () {
      STATE.starlightOnly = !STATE.starlightOnly;
      starBtn.classList.toggle('active', STATE.starlightOnly);
      apply();
    });
    var crSel = bar.querySelector('#cf-creator');
    if (crSel) crSel.addEventListener('change', function () { STATE.creator = crSel.value; apply(); });
    var sortSel = bar.querySelector('#cf-sort');
    sortSel.addEventListener('change', function () { STATE.sort = sortSel.value; apply(); });
    bar.querySelector('#cf-reset').addEventListener('click', function () {
      STATE = freshState();
      bar.querySelectorAll('.filter-chip').forEach(function (b) { b.classList.remove('active', 'active-exclude'); });
      if (crSel) crSel.value = '';
      sortSel.value = 'name-asc';
      apply();
    });

    function cardVisible(card) {
      // Partial pages are unfinished and stay out of the listing until the
      // reader asks for them — the same rule the browse pages use. Only where
      // the chip exists to turn them back on, though: without it they would be
      // hidden with no way to reveal them.
      if (wantPartial && !STATE.showPartial && card.getAttribute('data-partial') === '1') return false;
      if (STATE.starlightOnly && card.getAttribute('data-starlight') !== '1') return false;
      var team = teamOf(card);
      if (STATE.inTeams.length && STATE.inTeams.indexOf(team) === -1) return false;
      if (STATE.exTeams.indexOf(team) !== -1) return false;
      var ctags = cardTags(card);
      if (STATE.inTags.length && !STATE.inTags.every(function (t) { return ctags.indexOf(t) !== -1; })) return false;
      if (STATE.exTags.length && !STATE.exTags.every(function (t) { return ctags.indexOf(t) === -1; })) return false;
      if (STATE.creator && (card.getAttribute('data-creator') || '').trim() !== STATE.creator) return false;
      return true;
    }

    function sortCards() {
      sections.forEach(function (sec) {
        var g = sec.querySelector('.char-grid');
        if (!g || !sec._origOrder) return;
        var arr = sec._origOrder.slice();
        if (STATE.sort === 'name-asc') arr.sort(function (a, b) { return (a.getAttribute('data-name') || '').localeCompare(b.getAttribute('data-name') || ''); });
        else if (STATE.sort === 'name-desc') arr.sort(function (a, b) { return (b.getAttribute('data-name') || '').localeCompare(a.getAttribute('data-name') || ''); });
        else if (STATE.sort === 'recent') arr.sort(function (a, b) { return (+b.getAttribute('data-order') || 0) - (+a.getAttribute('data-order') || 0); });
        arr.forEach(function (card) { g.appendChild(card); });
      });
    }

    function apply() {
      sortCards();
      var shown = 0;
      sections.forEach(function (sec) {
        var secShown = 0;
        [].slice.call(sec.querySelectorAll('.char-card')).forEach(function (card) {
          var vis = cardVisible(card);
          card.style.display = vis ? '' : 'none';
          if (vis) { secShown++; shown++; }
        });
        sec.style.display = secShown ? '' : 'none';
        var cnt = sec.querySelector('.coll-team-count');
        if (cnt) cnt.textContent = '(' + secShown + ')';
      });
      var active = STATE.inTeams.length + STATE.exTeams.length + STATE.inTags.length +
        STATE.exTags.length + (STATE.creator ? 1 : 0) +
        (STATE.showPartial ? 1 : 0) + (STATE.starlightOnly ? 1 : 0);
      if (countEl) {
        // At rest, count what the reader can actually see: Partial pages are
        // hidden by default, and "15 of 16" with nothing filtered just reads
        // like something is broken. "x of y" appears once a chip is on.
        countEl.textContent = (!active || shown === total)
          ? shown + ' ' + noun + (shown === 1 ? '' : 's')
          : shown + ' of ' + total + ' ' + noun + (total === 1 ? '' : 's');
      }
      // Update only the label text node, keeping the arrow <span> intact.
      if (toggle.childNodes[0]) {
        toggle.childNodes[0].nodeValue = label + (active ? ' (' + active + ') ' : ' ');
      }
    }

    apply();
    return true;
  }

  if (typeof window !== 'undefined') window.mountCardFilters = mountCardFilters;

  // Auto-init for SSR collection pages, which carry the filter box in their
  // server-rendered markup. Creator pages mount their own after rendering.
  if (typeof document !== 'undefined' && document.getElementById('coll-grid')) {
    var ok = mountCardFilters({
      grid: 'coll-grid', bar: 'coll-filter-bar',
      toggle: 'coll-filter-toggle', count: 'coll-chars-count'
    });
    if (!ok) {   // empty collection — nothing to filter
      var fc = document.getElementById('coll-filters');
      if (fc) fc.style.display = 'none';
    }
  }
})();
