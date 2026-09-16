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

  /* The heart: a tribal flame heart with a heart-shaped hole, after the
     owner's reference art, in whatever colour the text around it is. Two
     subpaths under fill-rule evenodd, so the same path is an outline when
     unsaved and a filled shape with the hole showing through when saved
     (.fav-btn.on fills it; see styles.css). The left half was authored and
     the right half is its mirror, so the licks match; it is tuned to still
     read at the 14px the Copy link tab draws it. */
  var HEART_PATH = 'M16 8.8 C14.2 5.6 12.2 3.8 10 3.5 C7.6 3.2 5.4 2 3.4 0.6 C4.6 2.6 5.4 4 6.2 5 C3.4 6.2 1.6 9.4 2 13 C2.4 15.8 4 17.8 5.8 19.2 C4.8 20.2 4 21 2.8 21.8 C4.8 21.4 6.4 21.6 7.6 22.2 C10.4 24.4 13.6 27.2 16 31.6 C18.4 27.2 21.6 24.4 24.4 22.2 C25.6 21.6 27.2 21.4 29.2 21.8 C28 21 27.2 20.2 26.2 19.2 C28 17.8 29.6 15.8 30 13 C30.4 9.4 28.6 6.2 25.8 5 C26.6 4 27.4 2.6 28.6 0.6 C26.6 2 24.4 3.2 22 3.5 C19.8 3.8 17.8 5.6 16 8.8 Z M16 13.2 C14.9 11.4 12.8 10.7 11.3 11.9 C9.5 13.3 10 16 11.8 18 C13.3 19.7 14.9 21 16 22.6 C17.1 21 18.7 19.7 20.2 18 C22 16 22.5 13.3 20.7 11.9 C19.2 10.7 17.1 11.4 16 13.2 Z';
  function heartSVG() {
    return '<svg class="fav-ico" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="1em" height="1em" aria-hidden="true" focusable="false">' +
      '<path d="' + HEART_PATH + '" fill-rule="evenodd" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>';
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
      btn.innerHTML = heartSVG() + (opts.compact ? '' : '<span class="fav-label">' + label + '</span>');
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
        btn.classList.add('fav-pop');
        setTimeout(function () { btn.classList.remove('fav-pop'); }, 450);
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
