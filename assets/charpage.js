/* Character page enhancements — loaded by every server-rendered /c/{slug}
   page (the Worker renders the HTML from D1; see worker/worker.js).
   Adds the Edit button, the "Add to Script" / "Add to Token Tool" buttons,
   title auto-fit, and #hash scrolling. The two buttons are drawn with the
   same markup as the Favorites button under them (assets/favorites.js): a
   .tog-ico glyph that is an outline until the button is on and filled
   after, a .tog-label, and the .tog-pop swell on toggle — one skin for the
   three (styles.css), because the owner asked for parity between them. */
(function () {
  var SLUG = window.CHAR_SLUG;
  if (!document.getElementById('content') || !SLUG) return;

  // One glyph per button, the shape of Favorites.heartSVG(): a 24-box path
  // stroked in currentColor and left unfilled, which styles.css fills in once
  // the button is on. A page with a folded corner for the script, a disc for
  // the token. Both subpaths of the page wind the same way, or the fold would
  // cut a notch out of the filled shape.
  function glyphSVG(d) {
    return '<svg class="tog-ico" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" focusable="false">' +
      '<path d="' + d + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
  }
  var SCRIPT_GLYPH = 'M7 3h7l4 4v14H7Zm7 0l4 4h-4Z';
  var TOKEN_GLYPH = 'M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 1 1 0-17Z';

  // Generic localStorage-backed toggle button appended to the info card.
  // Same markup, state class, aria-pressed and swell as the Favorites button
  // (favorites.js mountButton), so the three stacked buttons look and move
  // as one set.
  function mountToggleButton(storageKey, extraClass, glyph, onLabel, offLabel, onChange) {
    var infocard = document.querySelector('.char-infocard');
    if (!infocard) return;
    function getList() {
      try { return JSON.parse(localStorage.getItem(storageKey)) || []; } catch (e) { return []; }
    }
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'add-to-script-btn' + (extraClass ? ' ' + extraClass : '');
    function sync() {
      var on = getList().indexOf(SLUG) !== -1;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.innerHTML = glyph + '<span class="tog-label">' + (on ? onLabel : offLabel) + '</span>';
    }
    btn.addEventListener('click', function () {
      var list = getList();
      var i = list.indexOf(SLUG);
      if (i === -1) list.push(SLUG); else list.splice(i, 1);
      try { localStorage.setItem(storageKey, JSON.stringify(list)); } catch (e) {}
      sync();
      btn.classList.add('tog-pop');
      setTimeout(function () { btn.classList.remove('tog-pop'); }, 450);
      if (onChange) onChange();
    });
    sync();
    infocard.appendChild(btn);
  }

  var editBtn = document.getElementById('edit-btn');
  if (editBtn) {
    editBtn.href = (window.LINK_ROOT || '') + 'edit?c=' + SLUG;
    editBtn.style.display = '';
  }

  mountToggleButton('botc_script', '', glyphSVG(SCRIPT_GLYPH), 'On Your Script', 'Add to Script',
    function () { if (window.updateScriptBadge) window.updateScriptBadge(); });
  mountToggleButton('botc_token_set', 'add-to-token-btn', glyphSVG(TOKEN_GLYPH), 'In Token Tool', 'Add to Token Tool');

  // Favorite — the third button in the same stack, under the JSON bar with
  // the other two, but this one is stored on the ACCOUNT (assets/favorites.js),
  // not in localStorage: a saved character is meant to be there on your
  // phone as well as your laptop, and the Favorites filter on the browse
  // pages reads the same list. It draws unsaved at once and fills its state
  // in when the list arrives; logged-out readers are sent to log in and come
  // straight back. A draft gets no button: only a published page can be
  // saved.
  if (window.Favorites && !window.PAGE_DRAFT) {
    var infocardFav = document.querySelector('.char-infocard');
    if (infocardFav) {
      infocardFav.appendChild(window.Favorites.mountButton({
        type: 'character', slug: SLUG,
        className: 'add-to-script-btn',
        onLabel: 'In Your Favorites', offLabel: 'Add to Favorites'
      }));
    }
  }

  if (window.fitCharTitle) window.fitCharTitle();
  if (location.hash) {
    var target = document.getElementById(location.hash.slice(1));
    if (target) target.scrollIntoView();
  }

  // Turn the "Appears in" value into a link to the page it names — a
  // collection or a script. Collections resolve the way the collection pages
  // themselves do (match[] normalized, then id / slug / displayName), so a
  // match-term variant still lands; scripts resolve on name or slug.
  //
  // Collections are tried first, which is the precedence characterQualifier()
  // in worker.js already uses when it decides which set a character is filed
  // under, so a name that is both reaches the same place in both.
  //
  // Scripts used to be left out here, and this function is the only thing that
  // links the row: a character whose "Appears in" named a script — every
  // character of an imported Bloodstar project, since the project usually
  // becomes a script — printed a set name as dead text on the page, next to a
  // Type and a Creator that were both links.
  //
  // Still deliberately plain: a value naming two sets ("A, B"). It is matched
  // whole, so it simply finds nothing, which is what it did before.
  (function linkAppearsIn() {
    // SSR resolved this, including an intentional plain-text no-match. A
    // failed server lookup leaves the flag unset so this fallback can retry.
    if (window.APPEARS_IN_RESOLVED) return;
    var dd = document.querySelector('.info-appears-in');
    if (!dd) return;
    // A row derived from collection membership is rendered as links already,
    // and can name more than one collection, so collapsing it to a single
    // looked-up link would throw the rest away.
    if (dd.querySelector('a')) return;
    var raw = dd.getAttribute('data-appears-in') || dd.textContent || '';
    if (!raw.trim()) return;
    function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
    var key = norm(raw);
    if (!key) return;
    var root = window.LINK_ROOT || '';
    function feed(name) {
      return fetch(root + name, { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : []; })
        .catch(function () { return []; });
    }
    // Both feeds at once: scripts.json is already in the browser's cache on
    // most visits (site.js reads it for the script-count badge), so the second
    // request usually costs nothing, and asking in series would leave the row
    // plain for two round trips instead of one.
    Promise.all([feed('collections.json'), feed('scripts.json')])
      .then(function (res) {
        var cols = res[0], scripts = res[1];
        if (!Array.isArray(cols)) cols = (cols && cols.collections) || [];
        if (!Array.isArray(scripts)) scripts = (scripts && scripts.scripts) || [];
        var href = '';
        for (var i = 0; i < cols.length && !href; i++) {
          var c = cols[i]; if (!c) continue;
          var matches = (c.match || []).map(norm);
          if (matches.indexOf(key) !== -1 || norm(c.id) === key ||
              norm(c.slug) === key || norm(c.displayName) === key) {
            href = root + 'collection/' + encodeURIComponent(c.id || c.slug || '');
          }
        }
        for (var j = 0; j < scripts.length && !href; j++) {
          var sc = scripts[j]; if (!sc || !sc.slug) continue;
          if (norm(sc.name) === key || norm(sc.slug) === key) {
            href = root + 's/' + encodeURIComponent(sc.slug);
          }
        }
        if (!href) return;
        var a = document.createElement('a');
        a.className = 'appears-in-link';
        a.href = href;
        a.textContent = raw;
        dd.textContent = '';
        dd.appendChild(a);
      })
      .catch(function () { /* leave as plain text on any error */ });
  })();
})();
