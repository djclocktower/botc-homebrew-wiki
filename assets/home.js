/* Homepage enhancements.

   The page arrives SERVER-RENDERED (worker/home-page.js): the stats, the
   collection and script tiles (re-picked per visit by the small inline script
   after each grid), News, Articles, Recently Added and the Featured
   Character are all in the HTML. Nothing here redraws them. The Favorites /
   Add to Script buttons on the cards are empty slots that card-actions.js
   finds and fills by itself, so there is nothing to adopt either.

   What is left is the FALLBACK: if the Worker could not build the page it
   serves the static index.html, whose regions still say "Loading…". Then
   this fills them from /api/home?format=panels — the same server-rendered
   markup as JSON, so there is no second renderer in the browser. */
(function () {
  var grid = document.getElementById('collections-grid');
  // A server-rendered grid always has at least the "All Collections" tile.
  if (!grid || grid.querySelector('.collection-tile')) return;
  var IDS = {
    stats: 'landing-stats', 'bc-team': 'bc-team', 'bc-creator': 'bc-creator', 'bc-tag': 'bc-tag', 'bc-jinx': 'bc-jinx',
    collections: 'collections-grid', scripts: 'scripts-grid', recent: 'recent-strip', featured: 'featured-wrap',
    news: 'news-grid', articles: 'articles-grid'
  };
  BotcData.json('/api/home?format=panels').then(function (data) {
    var regions = data.regions || {};
    Object.keys(IDS).forEach(function (name) {
      var el = document.getElementById(IDS[name]);
      if (el && typeof regions[name] === 'string') el.innerHTML = regions[name];
    });
    // News and Articles stay hidden while there is nothing in them.
    [['news', 'news-section'], ['articles', 'articles-section']].forEach(function (p) {
      var sec = document.getElementById(p[1]);
      if (sec && regions[p[0]]) sec.hidden = false;
    });
  }).catch(function () {
    var stats = document.getElementById('landing-stats');
    if (stats) stats.textContent = 'Could not load homepage data. Please refresh to retry.';
  });
})();

(function () {
  var box = document.getElementById('home-rules');
  if (box && typeof window.renderRulesHTML === 'function') {
    box.innerHTML = window.renderRulesHTML();
  }
})();
