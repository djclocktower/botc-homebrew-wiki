(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var query = $('wiki-query'), results = $('search-results'), status = $('search-status-text');
  var fields = ['team', 'creator', 'tag', 'set', 'status', 'sort'];
  var state = {}, serial = 0, frame, composing = false;
  var types = Array.from($('search-types').querySelectorAll('[data-type]'));
  var validTypes = types.map(function (b) { return b.dataset.type; });
  function readURL() {
    var params = new URLSearchParams(location.search);
    state = { q: (params.get('q') || '').slice(0, 200), type: params.get('type') || 'all', page: Math.max(1, parseInt(params.get('page'), 10) || 1) };
    if (!validTypes.includes(state.type)) state.type = 'all';
    fields.forEach(function (key) { state[key] = (params.get(key) || '').slice(0, 200); });
    if (!['townsfolk', 'outsider', 'minion', 'demon', 'traveller', 'fabled', 'loric'].includes(state.team)) state.team = '';
    if (!['curata', 'partial', 'standard'].includes(state.status)) state.status = '';
    if (state.sort !== 'name') state.sort = 'relevance';
    query.value = state.q;
    fields.forEach(function (key) { $('search-' + key).value = state[key]; });
    paintTypes();
  }
  function urlFor(next) {
    var params = new URLSearchParams();
    ['q', 'type'].concat(fields, ['page']).forEach(function (key) {
      var value = next[key];
      if (value && value !== 'all' && value !== 'relevance' && !(key === 'page' && value === 1)) params.set(key, value);
    });
    return '/search' + (params.size ? '?' + params.toString() : '');
  }
  function saveURL(push) {
    var url = urlFor(state);
    if (url !== location.pathname + location.search) history[push ? 'pushState' : 'replaceState']({}, '', url);
    document.title = (state.q ? state.q + ' | Search' : 'Search') + ' | BOTC HomeBrew Wiki';
  }
  function paintTypes(counts) {
    types.forEach(function (button) {
      var selected = button.dataset.type === state.type;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
      if (counts) button.querySelector('span').textContent = counts[button.dataset.type] || 0;
    });
  }
  function pagination(data) {
    var nav = $('search-pagination'), esc = window.BotcSearch.escape;
    nav.hidden = data.pages <= 1;
    function link(page, text) {
      return '<a class="filter-chip" href="' + esc(urlFor(Object.assign({}, state, { page: page }))) + '" data-page="' + page + '">' + text + '</a>';
    }
    nav.innerHTML = (data.page > 1 ? link(data.page - 1, '← Previous') : '') +
      '<span>Page ' + data.page + ' of ' + Math.max(1, data.pages) + '</span>' +
      (data.page < data.pages ? link(data.page + 1, 'Next →') : '');
  }
  function search() {
    var current = ++serial;
    results.setAttribute('aria-busy', 'true');
    $('search-error').hidden = true;
    window.BotcSearch.search(state).then(function (data) {
      if (current !== serial) return;
      state.page = data.page; saveURL(false);
      results.setAttribute('aria-busy', 'false');
      status.textContent = data.total.toLocaleString() + (data.total === 1 ? ' result' : ' results');
      paintTypes(data.counts);
      results.innerHTML = data.results.length ? data.results.map(function (d) { return window.BotcSearch.resultHTML(d, false); }).join('')
        : '<div class="search-page-empty">No results. Try another spelling or reset the filters.</div>';
      pagination(data);
    }).catch(function () {
      if (current !== serial) return;
      results.setAttribute('aria-busy', 'false');
      results.innerHTML = ''; status.textContent = 'Search unavailable';
      $('search-pagination').hidden = true; $('search-error').hidden = false;
    });
  }
  function change(push) {
    serial++; // Invalidate any pending response before the next animation frame.
    state.q = query.value.slice(0, 200); state.page = 1;
    fields.forEach(function (key) { state[key] = $('search-' + key).value; });
    saveURL(push); paintTypes();
    cancelAnimationFrame(frame); frame = requestAnimationFrame(search);
  }
  $('wiki-search-form').addEventListener('submit', function (e) { e.preventDefault(); change(true); });
  query.addEventListener('input', function (e) { if (!composing && !e.isComposing) change(false); });
  query.addEventListener('compositionstart', function () { composing = true; });
  query.addEventListener('compositionend', function () { composing = false; change(false); });
  types.forEach(function (button) {
    button.addEventListener('click', function () {
      state.type = button.dataset.type;
      if (state.type !== 'character' && state.type !== 'all') $('search-team').value = '';
      change(true);
    });
  });
  fields.forEach(function (key) {
    $('search-' + key).addEventListener('change', function () {
      if (key === 'team' && this.value) state.type = 'character';
      change(true);
    });
  });
  $('search-reset').addEventListener('click', function () {
    state.type = 'all';
    fields.forEach(function (key) { $('search-' + key).value = key === 'sort' ? 'relevance' : ''; });
    change(true);
  });
  $('search-pagination').addEventListener('click', function (e) {
    var link = e.target.closest('[data-page]');
    if (!link || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button) return;
    e.preventDefault(); cancelAnimationFrame(frame); state.page = Number(link.dataset.page); saveURL(true); search();
    status.scrollIntoView({ block: 'start' });
  });
  function warm() {
    window.BotcSearch.warm().then(function (data) {
      ['creator', 'tag', 'set'].forEach(function (key) {
        $('search-' + key + 's').innerHTML = data.facets[key].map(function (value) {
          return '<option value="' + window.BotcSearch.escape(value) + '"></option>';
        }).join('');
      });
    }).catch(function () {});
  }
  $('search-retry').addEventListener('click', function () { warm(); search(); });
  window.addEventListener('popstate', function () { cancelAnimationFrame(frame); readURL(); search(); });
  readURL(); warm(); search();
})();
