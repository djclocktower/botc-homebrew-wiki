/* Quick actions on a character card — the two small buttons under the icon:
   the heart (Favorites) and the page (Add to Script).

   The owner asked for them on EVERY character card, so they go wherever a
   character is drawn as a card or a row: the browse grids (All Characters,
   team, tag), collection and creator rosters, /favorites, a script page's
   roster, the homepage's Featured Character and Recently Added strip, and the
   top-bar search results. They are the info card's buttons in miniature — the
   same glyphs (.tog-ico: an outline that fills in when the button is on), the
   same faint .tog-pop swell, the same two stores: botc_script in localStorage
   (what the /c/ page's Add to Script writes) and the account's favorites
   through assets/favorites.js (what its Favorite button writes). So a heart
   tapped on a card is the heart on the character's own page, and the other
   way round.

   Two halves, because one of the renderers is the Worker:

     CardActions.slotHTML(c)  -> '<span class="cq" data-cq-slug="…"></span>',
                                 an EMPTY slot, or '' for anything that
                                 cannot be saved or scripted here (no slug, a
                                 draft, an official character). Pure string;
                                 render-page.js calls it on the server too
                                 (PageRender.setCardActions in worker.js).
     CardActions.glyph(name)  -> the 'script' / 'token' outline glyphs, the
                                 one copy of them — charpage.js draws the info
                                 card's buttons with these. The heart stays
                                 Favorites.heartSVG(), its own single source.

   The browser half fills every slot it finds, now and as cards arrive (a
   MutationObserver, because cards are drawn in batches on approach, re-drawn
   by every filter and rebuilt by the search box on each keystroke), and
   answers the clicks with ONE delegated listener. The slot is empty in the
   markup rather than carrying its buttons for three reasons: the published
   /collection/ and /s/ HTML is one shared cache entry for every reader (see
   "Caching" in CLAUDE.md), so saved/unsaved has to be painted in the browser
   anyway; the heart glyph lives in favorites.js, which the Worker does not
   load; and styles.css gives the empty slot its full height, so filling it
   moves nothing.

   The buttons sit INSIDE the card's link — the whole card is an <a> — so the
   click is caught in the capture phase and both its default (following the
   link) and its propagation are stopped. Nothing else on the page sees a tap
   on a quick action as a tap on the card. */
(function () {
  'use strict';

  var SCRIPT_KEY = 'botc_script';
  // 24-box paths, stroked in currentColor and left unfilled; styles.css fills
  // them once the button is on. A page with a folded corner for the script, a
  // disc for the token. Both subpaths of the page wind the same way, or the
  // fold would cut a notch out of the filled shape.
  var GLYPHS = {
    script: 'M7 3h7l4 4v14H7Zm7 0l4 4h-4Z',
    token: 'M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 1 1 0-17Z'
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function glyph(name) {
    return '<svg class="tog-ico" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" focusable="false">' +
      '<path d="' + (GLYPHS[name] || '') + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
  }

  /* The empty slot a renderer puts under a card's icon. A draft cannot be
     saved (favorites are published pages only) and is not what a script is
     built from; an official character has no page here to save. */
  function slotHTML(c) {
    if (!c || !c.slug || c.official || c.status === 'draft' || /^off-/.test(String(c.slug))) return '';
    return '<span class="cq" data-cq-slug="' + esc(c.slug) + '"></span>';
  }

  var api = { slotHTML: slotHTML, glyph: glyph };

  if (typeof window !== 'undefined' && typeof document !== 'undefined') installBrowser();
  if (typeof window !== 'undefined') window.CardActions = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  function installBrowser() {
    // [off label, on label] — the info card's wording, so a card and the
    // page say the same thing.
    var LABEL = {
      fav: ['Add to Favorites', 'In Your Favorites'],
      script: ['Add to Script', 'On Your Script']
    };
    var TITLE = {
      fav: ['Save to your favorites', 'Remove from your favorites'],
      script: ['Add to your script', 'Remove from your script']
    };

    var favSet = null;          // the account's saved characters, once known
    var favBusy = {};           // slug -> a save is in flight
    var favLoading = null;

    function getScript() {
      try { var a = JSON.parse(localStorage.getItem(SCRIPT_KEY)); return Array.isArray(a) ? a : []; }
      catch (e) { return []; }
    }
    function setScript(list) {
      try { localStorage.setItem(SCRIPT_KEY, JSON.stringify(list)); } catch (e) { /* private mode */ }
    }
    function root() {
      return (window.BotcData && window.BotcData.root) ? window.BotcData.root() : (window.LINK_ROOT || '');
    }

    /* favorites.js is on every page that draws cards from the start; the
       search box can open on any page, so where it is missing it is fetched
       once (and never twice — a second copy would be a second list with its
       own listeners, and two hearts for one page could disagree). */
    function favoritesReady() {
      if (window.Favorites) return Promise.resolve(window.Favorites);
      if (favLoading) return favLoading;
      favLoading = (window.BotcData && window.BotcData.script
        ? window.BotcData.script('favorites.js')
        : Promise.reject(new Error('no loader')))
        .then(function () { return window.Favorites || null; })
        // A failure stays failed for this page: scan() runs on every change
        // to the DOM, and retrying the download each time would hammer it.
        .catch(function () { return null; });
      return favLoading;
    }

    function paintButton(btn, on) {
      var kind = btn.getAttribute('data-cq');
      var i = on ? 1 : 0;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.setAttribute('aria-label', LABEL[kind][i]);
      btn.title = TITLE[kind][i];
    }

    /* Repaint every slot, or only the slots of one character: the same
       character can be on the page twice (a search result over a grid). */
    function paint(onlySlug, only) {
      var script = getScript();
      var slots = only || document.querySelectorAll('.cq[data-cq-ready]');
      for (var i = 0; i < slots.length; i++) {
        var slug = slots[i].getAttribute('data-cq-slug');
        if (onlySlug && slug !== onlySlug) continue;
        var btns = slots[i].querySelectorAll('.cq-btn');
        for (var j = 0; j < btns.length; j++) {
          var kind = btns[j].getAttribute('data-cq');
          paintButton(btns[j], kind === 'script'
            ? script.indexOf(slug) !== -1
            : !!(favSet && favSet.has(slug)));
        }
      }
    }

    function buttonHTML(kind, svg) {
      return '<button type="button" class="cq-btn cq-' + kind + '" data-cq="' + kind + '" aria-pressed="false">' + svg + '</button>';
    }

    var listening = false;
    function loadFavorites(F) {
      if (listening) return;
      listening = true;
      // A heart tapped anywhere — a card, the character's own page, the
      // account page — keeps every card for that character in step.
      F.onChange(function (body) {
        if (!body || body.type !== 'character' || !body.slug) return;
        if (!favSet) favSet = new Set();
        if (body.on) favSet.add(body.slug); else favSet.delete(body.slug);
        paint(body.slug);
      });
      // A logged-out reader resolves null here without a request.
      F.lists().then(function (data) {
        if (!data) return;
        favSet = new Set(data.characters || []);
        paint();
      });
    }

    /* Fill the slots nobody has filled yet. The slot keeps its reserved size
       until the heart glyph is here, so nothing on the card moves. */
    function scan() {
      var slots = document.querySelectorAll('.cq:not([data-cq-ready])');
      if (!slots.length) return;
      favoritesReady().then(function (F) {
        if (!F) return;
        var fresh = document.querySelectorAll('.cq:not([data-cq-ready])');
        for (var i = 0; i < fresh.length; i++) {
          fresh[i].innerHTML = buttonHTML('fav', F.heartSVG()) + buttonHTML('script', glyph('script'));
          fresh[i].setAttribute('data-cq-ready', '1');
        }
        loadFavorites(F);
        paint(null, fresh);     // only the new ones: a batch of cards must not
                                // repaint the hundreds already on screen
      });
    }

    function pop(btn) {
      btn.classList.add('tog-pop');
      setTimeout(function () { btn.classList.remove('tog-pop'); }, 450);
    }

    function toggleScript(slug, btn) {
      var list = getScript();
      var i = list.indexOf(slug);
      if (i === -1) list.push(slug); else list.splice(i, 1);
      setScript(list);
      paint(slug);
      pop(btn);
      if (window.updateScriptBadge) window.updateScriptBadge();
      // The Script Builder and the publish page redraw their roster on this.
      try { window.dispatchEvent(new CustomEvent('botc-script-change', { detail: { slug: slug, on: i === -1 } })); }
      catch (e) { /* very old browser: they catch up on the next visit */ }
    }

    function toggleFav(slug, btn) {
      // Held from the first tap, before anything async: a double tap must not
      // become two saves that cancel each other out.
      if (favBusy[slug]) return;
      favBusy[slug] = true;
      function done() { delete favBusy[slug]; }
      favoritesReady().then(function (F) {
        if (!F) return done();
        return F.me().then(function (m) {
          if (!m) {
            done();
            // Same as the page's own heart: a button that does nothing is
            // worse than one that asks you to sign in and brings you back.
            var next = location.pathname.replace(/^\/+/, '') + location.search;
            location.href = root() + 'login?next=' + encodeURIComponent(next);
            return;
          }
          if (!favSet) favSet = new Set();
          var was = favSet.has(slug);
          if (was) favSet.delete(slug); else favSet.add(slug);   // optimistic
          paint(slug);
          pop(btn);
          return F.toggle('character', slug, !was).catch(function (err) {
            if (was) favSet.add(slug); else favSet.delete(slug);
            paint(slug);
            alert((err && err.message) || 'Could not update your favorites.');
          }).then(done);
        });
      }).catch(done);
    }

    // Capture phase: the card is a link, and this has to win before anything
    // else hears the click — the link's own navigation included.
    document.addEventListener('click', function (e) {
      var t = e.target;
      var btn = t && t.closest ? t.closest('.cq-btn') : null;
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      var slot = btn.closest('.cq');
      var slug = slot && slot.getAttribute('data-cq-slug');
      if (!slug) return;
      if (btn.getAttribute('data-cq') === 'script') toggleScript(slug, btn);
      else toggleFav(slug, btn);
    }, true);

    // Another tab changed the script; the Back button restored this page
    // from the cache with yesterday's state painted on it.
    window.addEventListener('storage', function (e) { if (e.key === SCRIPT_KEY) paint(); });
    window.addEventListener('pageshow', function (e) { if (e.persisted) paint(); });

    if (typeof MutationObserver === 'function') {
      new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
    }
    scan();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan);
  }
})();
