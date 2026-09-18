/* Favorites — a reader's saved pages: characters, scripts and collections.

   One module for the whole browser side of the feature, so the button on a
   character page, the one on a script or collection page, the Favorites chip
   in every filter box and the account page all read and write ONE list:

     Favorites.lists()            -> Promise<{characters, scripts, collections,
                                     collectionIds} | null>  (null: logged out)
     Favorites.expanded()         -> the same plus `items` (name, status, link
                                     key per page) and `characterSlugs`
     Favorites.characterSlugs()   -> Promise<Set | null>: the saved characters
                                     PLUS every character on a saved script or
                                     collection. The SERVER resolves the
                                     rosters (rosterCharacterSlugs in
                                     worker.js), so this file never needs the
                                     membership rule.
     Favorites.has(type, slug)    -> Promise<boolean>
     Favorites.toggle(type, slug) -> Promise<{on, slug, key, name}>; rejects
                                     on failure
     Favorites.mountButton(opts)  -> the toggle button, its state filled in
                                     once the list is known
     Favorites.heartSVG()         -> the icon markup, for chips and labels
     Favorites.onChange(fn)       -> called after every toggle, with the
                                     response — the chips re-count through it
     Favorites.drop()             -> forget the cache (the logout button)

   The lists are one request per page for a logged-in reader and none at all
   for anyone else: login is read off the same sessionStorage entry site.js
   keeps for /api/me, so it usually costs nothing either. They are cached in
   sessionStorage for two minutes UNDER THE ACCOUNT'S NAME, so a second person
   logging in on the same tab never sees the first one's list, and a toggle
   rewrites the cache in place rather than dropping it, so the next page draws
   the right state without a round trip. Saving on another device shows up
   within those two minutes.

   Collections are keyed on their PK slug in the table but addressed by their
   kebab id on the page, and on a legacy row the two differ — so the server
   sends both lists and `has()` answers to either.

   Paths are absolute (/api/...) because this runs under /c/{set}/{character},
   two levels deep, as well as at the root. Links to pages go through
   BotcData.root(), the one answer to "what prefix does a link need here". */
(function () {
  'use strict';

  var CACHE_KEY = 'botc_favs';
  var CACHE_TTL = 120 * 1000;
  var LIST_OF = { character: 'characters', script: 'scripts', collection: 'collections' };
  var memo = {};        // 'plain' | 'expanded' -> Promise of the payload
  var listeners = [];
  var currentUser = '';

  function root() {
    if (window.BotcData && typeof window.BotcData.root === 'function') return window.BotcData.root();
    return window.LINK_ROOT || '';
  }

  /* Who is reading. The same 60-second sessionStorage entry site.js writes
     for /api/me, so a page that already asked does not ask twice. site.js
     may load AFTER this file (the SSR pages put it last), so botcMePromise is
     used when it exists and otherwise this asks for itself. Resolves to the
     /api/me object, or null when logged out or unreachable. */
  function me() {
    if (window.botcMePromise) {
      return window.botcMePromise.then(function (m) { return (m && m.loggedIn) ? m : null; }).catch(function () { return null; });
    }
    try {
      var raw = JSON.parse(sessionStorage.getItem('botc_me'));
      if (raw && (Date.now() - raw.ts) < 60 * 1000) return Promise.resolve((raw.me && raw.me.loggedIn) ? raw.me : null);
    } catch (e) { /* no cache */ }
    return fetch('/api/me', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (m) {
        try { sessionStorage.setItem('botc_me', JSON.stringify({ ts: Date.now(), me: m })); } catch (e) { /* private mode */ }
        return (m && m.loggedIn) ? m : null;
      })
      .catch(function () { return null; });
  }

  function readCache(kind, user) {
    try {
      var raw = JSON.parse(sessionStorage.getItem(CACHE_KEY + ':' + kind));
      if (raw && raw.data && raw.user === user && (Date.now() - raw.ts) < CACHE_TTL) return raw.data;
    } catch (e) { /* nothing cached */ }
    return null;
  }
  function writeCache(kind, user, data) {
    try { sessionStorage.setItem(CACHE_KEY + ':' + kind, JSON.stringify({ ts: Date.now(), user: user, data: data })); }
    catch (e) { /* quota or private mode: the next page just asks again */ }
  }
  function dropCache() {
    memo = {};
    try { sessionStorage.removeItem(CACHE_KEY + ':plain'); sessionStorage.removeItem(CACHE_KEY + ':expanded'); }
    catch (e) { /* nothing to drop */ }
  }

  function load(kind) {
    if (memo[kind]) return memo[kind];
    memo[kind] = me().then(function (m) {
      if (!m) return null;
      currentUser = m.username || '';
      var cached = readCache(kind, currentUser);
      if (cached) return cached;
      return fetch('/api/favorites' + (kind === 'expanded' ? '?expand=1' : ''), { credentials: 'same-origin', cache: 'no-store' })
        .then(function (r) {
          if (r.status === 401) return null;
          if (!r.ok) throw new Error('favorites ' + r.status);
          return r.json();
        })
        .then(function (data) { if (data) writeCache(kind, currentUser, data); return data; });
    }).catch(function () {
      // A failed read is not "no favorites": forget it so the next caller
      // asks again instead of drawing every button as unsaved.
      delete memo[kind];
      return null;
    });
    return memo[kind];
  }

  function lists() { return load('plain'); }
  function expanded() { return load('expanded'); }
  function characterSlugs() {
    return expanded().then(function (data) {
      return data ? new Set(data.characterSlugs || []) : null;
    });
  }
  function inLists(data, type, slug) {
    if (!data) return false;
    if ((data[LIST_OF[type]] || []).indexOf(slug) !== -1) return true;
    return type === 'collection' && (data.collectionIds || []).indexOf(slug) !== -1;
  }
  function has(type, slug) {
    return lists().then(function (data) { return inLists(data, type, slug); });
  }

  /* Save or unsave. The plain cache is patched in place (the button on the
     next page is right at once); the expanded one is dropped, because the
     character set it carries depends on rosters this file cannot resolve. */
  function toggle(type, slug, force) {
    return has(type, slug).then(function (on) {
      var want = (force === undefined) ? !on : !!force;
      return fetch('/api/favorite', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: type, slug: slug, on: want })
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (body) {
          if (!r.ok) {
            var err = new Error((body && body.error) || ('Could not update favorites (' + r.status + ')'));
            err.status = r.status;
            throw err;
          }
          return body;
        });
      }).then(function (body) {
        var plain = readCache('plain', currentUser);
        if (plain) {
          var key = body.slug || slug;
          var arr = plain[LIST_OF[type]] || (plain[LIST_OF[type]] = []);
          var i = arr.indexOf(key);
          if (body.on && i === -1) { arr.unshift(key); plain.total = (plain.total || 0) + 1; }
          if (!body.on && i !== -1) { arr.splice(i, 1); plain.total = Math.max(0, (plain.total || 1) - 1); }
          if (type === 'collection') {
            var ids = plain.collectionIds || (plain.collectionIds = []);
            var id = body.key || slug, j = ids.indexOf(id);
            if (body.on && j === -1) ids.unshift(id);
            if (!body.on && j !== -1) ids.splice(j, 1);
          }
          writeCache('plain', currentUser, plain);
          memo.plain = Promise.resolve(plain);
        } else {
          delete memo.plain;
        }
        delete memo.expanded;
        try { sessionStorage.removeItem(CACHE_KEY + ':expanded'); } catch (e) { /* nothing cached */ }
        listeners.forEach(function (fn) { try { fn(body); } catch (e) { /* one listener must not stop the rest */ } });
        return body;
      });
    });
  }

  function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }

  /* The heart: a plain outline in whatever colour the text around it is,
     filled once the page is saved (.on .tog-ico path in styles.css — the
     same rule, class names and swell the Add to Script and Add to Token
     Tool buttons use, so the three read as one set; see charpage.js). */
  function heartSVG() {
    return '<svg class="tog-ico" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" focusable="false">' +
      '<path d="M12 20.6 4.2 12.9a4.6 4.6 0 0 1 6.5-6.5L12 7.7l1.3-1.3a4.6 4.6 0 0 1 6.5 6.5Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
  }

  /* opts: {type, slug, className, onLabel, offLabel, title, compact}
     The button is drawn at once in its "unsaved" look and corrected when
     the list arrives, so the page never waits on the request. Logged-out
     readers are sent to the login page and come back here afterwards: a
     button that does nothing is worse than one that asks you to sign in.
     `compact` draws the icon alone (the label goes on aria-label + title). */
  function mountButton(opts) {
    opts = opts || {};
    var type = opts.type, slug = opts.slug;
    var onLabel = opts.onLabel || 'In Your Favorites';
    var offLabel = opts.offLabel || 'Add to Favorites';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fav-btn' + (opts.className ? ' ' + opts.className : '') + (opts.compact ? ' fav-btn-compact' : '');
    btn.setAttribute('data-fav-type', type);
    btn.setAttribute('data-fav-slug', slug);
    var state = false, busy = false;
    function paint() {
      btn.classList.toggle('on', state);
      btn.setAttribute('aria-pressed', state ? 'true' : 'false');
      var label = state ? onLabel : offLabel;
      btn.innerHTML = heartSVG() + (opts.compact ? '' : '<span class="tog-label">' + label + '</span>');
      btn.title = opts.title || (state ? 'Remove from your favorites' : 'Save to your favorites');
      btn.setAttribute('aria-label', label);
    }
    paint();
    has(type, slug).then(function (on) { state = !!on; paint(); });
    btn.addEventListener('click', function () {
      if (busy) return;
      me().then(function (m) {
        if (!m) {
          var next = location.pathname.replace(/^\/+/, '') + location.search;
          location.href = root() + 'login?next=' + encodeURIComponent(next);
          return;
        }
        busy = true;
        var was = state;
        state = !was; paint();                // optimistic: the tap answers at once
        btn.classList.add('tog-pop');
        setTimeout(function () { btn.classList.remove('tog-pop'); }, 450);
        return toggle(type, slug, !was).then(function (body) {
          state = !!body.on; paint();
        }).catch(function (err) {
          state = was; paint();
          alert((err && err.message) || 'Could not update your favorites.');
        }).then(function () { busy = false; });
      });
    });
    // Another control for the same page toggled it (the account page's
    // Remove, a second mount): follow, so two hearts never disagree.
    onChange(function (body) {
      if (!body || body.type !== type) return;
      if (body.slug === slug || body.key === slug) { state = !!body.on; paint(); }
    });
    return btn;
  }

  window.Favorites = {
    lists: lists, expanded: expanded, characterSlugs: characterSlugs,
    has: has, toggle: toggle, onChange: onChange,
    mountButton: mountButton, heartSVG: heartSVG, drop: dropCache
  };
})();
