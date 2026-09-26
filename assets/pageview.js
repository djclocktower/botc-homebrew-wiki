/* Client-side enhancements for SSR script/collection pages (/s/, /collection/).
   The Worker sets window.PAGE_TYPE ('script'|'collection') and window.PAGE_SLUG
   before loading this. The edit button is shown unconditionally (like character
   pages) — the server enforces ownership on every write. */
(function () {
  var ROOT = (typeof window !== 'undefined' && window.LINK_ROOT) || '';
  var TYPE = window.PAGE_TYPE || '';
  var SLUG = window.PAGE_SLUG || '';

  var editBtn = document.getElementById('edit-btn');
  if (editBtn && TYPE && SLUG) {
    editBtn.href = ROOT + (TYPE === 'collection'
      ? 'publish-collection?c=' + encodeURIComponent(SLUG)
      : 'publish-script?s=' + encodeURIComponent(SLUG));
    editBtn.style.display = '';
  }

  // The Favorite button, under the title block beside the (possibly empty)
  // owner-controls slot. Mounted here rather than rendered by the server
  // because the published HTML is shared by every reader (see "Caching" in
  // CLAUDE.md) and a saved/unsaved state is one reader's own. Saving a script
  // or a collection also puts every character on it behind the Favorites
  // filter on the browse pages — the server resolves the roster.
  // A draft gets no button: only a published page can be saved.
  if (window.Favorites && !window.PAGE_DRAFT && (TYPE === 'script' || TYPE === 'collection') && SLUG) {
    var slot = document.getElementById('page-owner-controls');
    if (slot) {
      var bar = document.createElement('p');
      bar.className = 'page-fav-bar';
      bar.appendChild(window.Favorites.mountButton({
        type: TYPE, slug: SLUG,
        className: 'cta-secondary page-fav-btn',
        onLabel: 'In Your Favorites', offLabel: 'Add to Favorites'
      }));
      slot.parentNode.insertBefore(bar, slot.nextSibling);
    }
  }

  // Deal a Game: a collapsed panel under the roster that draws a legal bag
  // for 5-15 players and lays it out as a grimoire (assets/deal.js). Built
  // here rather than by the server so the published HTML stays one shared
  // cache entry; the dealer, its rules and its stylesheet load only when a
  // reader opens it. It reads the roster rows the page already drew, so a
  // script with no Demon on it gets no panel at all.
  if (TYPE === 'script' && window.BotcData && document.querySelector('.script-char-row[data-team="demon"]')) {
    var firstGroup = document.querySelector('.script-chars-panel .script-team-group');
    var section = firstGroup && firstGroup.closest('.sv-section');
    if (section) {
      var panel = document.createElement('details');
      panel.className = 'deal-panel';
      panel.id = 'sec-deal';
      panel.innerHTML = '<summary>Deal a Game <span class="deal-panel-arrow">&#9662;</span>' +
        '<span class="deal-panel-sub">Draw a random bag from this script for 5&ndash;15 players, setup changes included, and see it laid out as a grimoire.</span></summary>' +
        '<div class="deal-panel-body"><p class="dl-empty">Loading&hellip;</p></div>';
      section.parentNode.insertBefore(panel, section.nextSibling);
      var started = false;
      var start = function () {
        if (!panel.open || started) return;
        started = true;
        window.BotcData.style('play.css');
        var body = panel.querySelector('.deal-panel-body');
        window.BotcData.script('setup-rules.js')
          .then(function () { return window.BotcData.script('deal.js'); })
          .then(function () {
            window.Deal.mount(body, {
              getRoster: function () { return window.Deal.rosterFromPage(document); },
              name: document.title.replace(/\s+\u2014\s+BOTC HomeBrew Wiki$/, '')
            });
          })
          .catch(function () {
            started = false;
            body.innerHTML = '<p class="dl-empty">Could not load the dealer. Close and open this panel to try again.</p>';
          });
      };
      panel.addEventListener('toggle', start);
      if (location.hash === '#sec-deal') { panel.open = true; start(); }
    }
  }

  // The Download JSON button is a plain link to /api/page-json now — the
  // server builds that JSON to render this page anyway, so nothing here has to
  // attach it. It used to be an href="#" that this file turned into a blob:
  // URL on load, which meant any way this script failed to run in time (an
  // extension, a slow load, an error further up) left the bare "#" for the
  // click: the page jumped to the top and saved nothing, with no error to see.
  // A real href cannot fail that way, works with JavaScript off, and can be
  // long-pressed or "save link as"-ed like any other link.
})();
