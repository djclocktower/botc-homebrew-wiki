/* similar.js: the "More Like This" strip at the foot of a character page.
 *
 * Six published characters whose ability, tags and team are most like the
 * one being read, from GET /api/similar (worker/similar.js does the scoring).
 * It is fetched as the reader nears the end of the page, not on load: the
 * suggestions are for someone who has finished reading, and most visits end
 * before that. A page with nothing close enough shows nothing at all.
 *
 * Drawn in the browser rather than by the server so the /c/ HTML stays one
 * shared cache entry that does not change when some OTHER character is
 * edited. The cards reuse the homepage's Recently Added card, quick actions
 * included (assets/card-actions.js fills the empty .cq slot), so the strip
 * looks like the rest of the wiki rather than like a widget bolted on.
 */
(function () {
  'use strict';
  var slug = window.CHAR_SLUG;
  if (!slug || window.PAGE_DRAFT || !window.BotcData) return;

  var TEAM_LABEL = { townsfolk: 'Townsfolk', outsider: 'Outsider', minion: 'Minion', demon: 'Demon',
    traveller: 'Traveller', traveler: 'Traveller', fabled: 'Fabled', loric: 'Loric' };
  var GOOD = { townsfolk: true, outsider: true };
  var root = window.BotcData.root();

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  // The 192px card thumbnail when the art is ours, as every card grid does
  // (the Worker falls back to the original when no thumbnail exists yet).
  function thumb(c) {
    var v = c.v ? '?v=' + encodeURIComponent(c.v) : '';
    if (c.art && /^art\/[^/]+$/.test(c.art)) return root + 'assets/thumb/' + c.art.slice(4) + '.webp' + v;
    if (c.art) return root + 'assets/' + c.art + v;
    var img = Array.isArray(c.image) ? c.image[0] : c.image;
    return img || (root + 'assets/favicon.png');
  }
  function cardHTML(c) {
    var team = String(c.team || '').toLowerCase();
    var slot = window.CardActions ? window.CardActions.slotHTML(c) : '';
    return '<a class="recent-card similar-card" href="' + esc(root + String(c.page || ('c/' + c.slug)).replace(/^\//, '')) + '">' +
      '<img loading="lazy" decoding="async" class="recent-thumb" src="' + esc(thumb(c)) + '" alt=""' +
        ' onerror="this.onerror=null;this.src=\'' + esc(root) + 'assets/favicon.png\'">' +
      '<div class="recent-name">' + esc(c.name) + '</div>' +
      '<div class="recent-type' + (GOOD[team] ? ' good' : '') + '">' + esc(TEAM_LABEL[team] || team) + '</div>' +
      (c.ability ? '<div class="similar-ability">' + esc(c.ability) + '</div>' : '') +
      slot +
      '</a>';
  }

  var main = document.getElementById('content');
  if (!main) return;
  var sec = document.createElement('section');
  sec.className = 'similar-section';
  sec.id = 'similar';
  var comments = document.getElementById('comments');
  if (comments && comments.parentNode === main) main.insertBefore(sec, comments);
  else main.appendChild(sec);

  var started = false, observer = null;
  function load() {
    if (started) return;
    started = true;
    if (observer) observer.disconnect();
    fetch(root + 'api/similar?slug=' + encodeURIComponent(slug), { credentials: 'omit' })
      .then(function (r) { return r.ok ? r.json() : { items: [] }; })
      .then(function (data) {
        var items = (data && Array.isArray(data.items)) ? data.items : [];
        if (!items.length) { sec.remove(); return; }
        sec.setAttribute('aria-labelledby', 'similar-title');
        sec.innerHTML = '<h2 class="type-header" id="similar-title">More Like This</h2>' +
          '<div class="type-rule"></div>' +
          '<div class="recent-strip similar-strip">' + items.map(cardHTML).join('') + '</div>';
      })
      .catch(function () { sec.remove(); });
  }
  if (location.hash === '#similar') load();
  if (typeof IntersectionObserver === 'function') {
    observer = new IntersectionObserver(function (entries) {
      if (entries.some(function (e) { return e.isIntersecting; })) load();
    }, { rootMargin: '700px 0px' });
    observer.observe(sec);
  } else {
    load();
  }
})();
