/* On-page filtering for SSR collection pages (/collection/{id}).
   The browse-and-filter view that used to live at all-characters?collection=
   is now folded into the collection page: this script reads the server-rendered
   character cards, builds a collapsed filter box (team / tag / creator / sort),
   and shows, hides and reorders the cards client-side. No data is re-fetched —
   every card carries data-team / data-tags / data-creator / data-name /
   data-order, so the page still works with JavaScript off (all cards shown). */
(function () {
  var grid = document.getElementById('coll-grid');
  var bar = document.getElementById('coll-filter-bar');
  var toggle = document.getElementById('coll-filter-toggle');
  var countEl = document.getElementById('coll-chars-count');
  if (!grid || !bar || !toggle) return;

  var TEAMS = [
    ['townsfolk', 'Townsfolk'], ['outsider', 'Outsider'], ['minion', 'Minion'],
    ['demon', 'Demon'], ['traveller', 'Traveller'], ['fabled', 'Fabled'], ['other', 'Other']
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

  var sections = [].slice.call(grid.querySelectorAll('.coll-team'));
  var cards = [].slice.call(grid.querySelectorAll('.char-card'));
  var total = cards.length;
  if (!total) {  // empty collection — nothing to filter
    var fc = document.getElementById('coll-filters');
    if (fc) fc.style.display = 'none';
    return;
  }

  // Remember each team grid's original card order for the "recently added" and
  // default sorts (cards are laid out team-by-team, name A–Z, on the server).
  sections.forEach(function (sec) {
    var g = sec.querySelector('.char-grid');
    if (g) sec._origOrder = [].slice.call(g.querySelectorAll('.char-card'));
  });

  var STATE = { inTeams: [], exTeams: [], inTags: [], exTags: [], creator: '', sort: 'name-asc' };

  // ── build the filter bar from what's actually present ──
  var teamsPresent = TEAMS.filter(function (t) {
    return cards.some(function (c) { return teamOf(c) === t[0]; });
  });

  var tagSet = {}, creatorSet = {};
  cards.forEach(function (c) {
    cardTags(c).forEach(function (t) { tagSet[t] = 1; });
    var cr = (c.getAttribute('data-creator') || '').trim();
    if (cr) creatorSet[cr] = 1;
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
  // Visibility is now governed by the .open class, not the [hidden] attribute
  // (the [hidden] rule is !important and would beat .open on mobile).
  bar.hidden = false;

  // ── collapse/expand (collapsed by default, works on every screen size) ──
  toggle.addEventListener('click', function () {
    var open = bar.classList.toggle('open');
    toggle.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  // ── 3-state chip helper (unset → include → exclude → unset) ──
  function wireChips(selector, inArr, exArr) {
    bar.querySelectorAll(selector).forEach(function (btn) {
      var v = btn.getAttribute('data-team') || btn.getAttribute('data-tag');
      btn.addEventListener('click', function () {
        var ii = inArr.indexOf(v), ei = exArr.indexOf(v);
        if (ii === -1 && ei === -1) { inArr.push(v); btn.classList.add('active'); btn.classList.remove('active-exclude'); }
        else if (ii !== -1) { inArr.splice(ii, 1); exArr.push(v); btn.classList.remove('active'); btn.classList.add('active-exclude'); }
        else { exArr.splice(ei, 1); btn.classList.remove('active-exclude'); }
        apply();
      });
    });
  }
  wireChips('[data-team]', STATE.inTeams, STATE.exTeams);
  wireChips('[data-tag]', STATE.inTags, STATE.exTags);
  var crSel = document.getElementById('cf-creator');
  if (crSel) crSel.addEventListener('change', function () { STATE.creator = crSel.value; apply(); });
  var sortSel = document.getElementById('cf-sort');
  sortSel.addEventListener('change', function () { STATE.sort = sortSel.value; apply(); });
  document.getElementById('cf-reset').addEventListener('click', function () {
    STATE = { inTeams: [], exTeams: [], inTags: [], exTags: [], creator: '', sort: 'name-asc' };
    bar.querySelectorAll('.filter-chip').forEach(function (b) { b.classList.remove('active', 'active-exclude'); });
    if (crSel) crSel.value = '';
    sortSel.value = 'name-asc';
    apply();
  });

  function teamOf(card) {
    var ct = card.getAttribute('data-team') || 'other';
    var known = TEAMS.some(function (x) { return x[0] !== 'other' && x[0] === ct; });
    return known ? ct : 'other';
  }
  function cardVisible(card) {
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
    if (countEl) {
      countEl.textContent = shown === total
        ? total + ' character' + (total === 1 ? '' : 's')
        : shown + ' of ' + total + ' character' + (total === 1 ? '' : 's');
    }
    var active = STATE.inTeams.length + STATE.exTeams.length + STATE.inTags.length +
      STATE.exTags.length + (STATE.creator ? 1 : 0);
    // Update only the label text node, keeping the arrow <span> intact.
    if (toggle.childNodes[0]) {
      toggle.childNodes[0].nodeValue = 'Filter characters' + (active ? ' (' + active + ') ' : ' ');
    }
  }

  apply();
})();
