/* Shared site behaviours: search, mobile nav, script-count badge.
   Root-aware: derives the path prefix from the stylesheet href so it works
   from the site root and from subdirectories like /c/. */
(function () {
  var ROOT = (function () {
    var s = document.querySelector('link[rel="stylesheet"]');
    if (!s) return '';
    return s.getAttribute('href').replace('assets/styles.css', '');
  })();

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Does this <a> point at the given page? Matches clean URLs ("script",
  // "../script", "/script") and the legacy .html form, but not other pages
  // that merely end with the same word (e.g. "create-script").
  function linkMatches(a, name) {
    var h = (a.getAttribute('href') || '').split(/[?#]/)[0];
    return new RegExp('(^|\\/)' + name + '(\\.html)?$').test(h);
  }
  function findLinks(name, scope) {
    return Array.prototype.filter.call(
      (scope || document).querySelectorAll('a[href]'),
      function (a) { return linkMatches(a, name); }
    );
  }
  var GOOD = { townsfolk: 1, outsider: 1 };
  var TEAM_LABEL = {
    townsfolk: 'Townsfolk', outsider: 'Outsider', minion: 'Minion',
    demon: 'Demon', traveller: 'Traveller', fabled: 'Fabled', loric: 'Loric'
  };

  /* ── Site-wide announcement banner (set on the admin dashboard) ── */
  (function () {
    var CACHE_KEY = 'botc_announce';
    var DISMISS_KEY = 'botc_announce_dismissed';
    function show(ann) {
      if (!ann || !ann.text) return;
      var dismissed = '';
      try { dismissed = localStorage.getItem(DISMISS_KEY) || ''; } catch (e) {}
      if (dismissed === ann.text) return; // this exact message was dismissed
      var bar = document.createElement('div');
      bar.className = 'site-announcement';
      var span = document.createElement('span');
      span.textContent = ann.text; // textContent — announcement is plain text
      var btn = document.createElement('button');
      btn.className = 'site-announcement-close';
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Dismiss announcement');
      btn.textContent = '×';
      btn.addEventListener('click', function () {
        try { localStorage.setItem(DISMISS_KEY, ann.text); } catch (e) {}
        bar.remove();
      });
      bar.appendChild(span);
      bar.appendChild(btn);
      document.body.insertBefore(bar, document.body.firstChild);
    }
    try {
      var cached = JSON.parse(sessionStorage.getItem(CACHE_KEY));
      if (cached && (Date.now() - cached.ts) < 60 * 1000) { show(cached.ann); return; }
    } catch (e) {}
    fetch('/api/announcement')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var ann = (d && d.announcement) || null;
        try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), ann: ann })); } catch (e) {}
        show(ann);
      })
      .catch(function () {});
  })();

  /* ── Script-count badge on Script Builder nav links ── */
  var SCRIPT_KEY = 'botc_script';
  function scriptCount() {
    try { return (JSON.parse(localStorage.getItem(SCRIPT_KEY)) || []).length; }
    catch (e) { return 0; }
  }
  function updateScriptBadge() {
    var n = scriptCount();
    // Find every link to the Script Builder (root or ../, clean or .html)
    var links = findLinks('script');
    links.forEach(function (a) {
      var badge = a.querySelector('.script-badge');
      if (n > 0) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'script-badge';
          a.appendChild(badge);
        }
        badge.textContent = n;
      } else if (badge) {
        badge.remove();
      }
    });
  }
  window.updateScriptBadge = updateScriptBadge;
  updateScriptBadge();
  window.addEventListener('storage', function (e) { if (e.key === SCRIPT_KEY) updateScriptBadge(); });

  /* ── Token Tool link in the crumb nav, mirroring Script Builder (desktop top bar) ── */
  (function () {
    document.querySelectorAll('.crumb').forEach(function (crumb) {
      if (findLinks('tokens', crumb).length) return;
      var sb = findLinks('script', crumb)[0];
      if (!sb) return;
      var sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '\u00b7';
      var link = document.createElement('a'); link.href = ROOT + 'tokens'; link.textContent = 'Token Tool';
      crumb.insertBefore(sep, sb.nextSibling);
      crumb.insertBefore(link, sep.nextSibling);
    });
  })();

  /* ── Account link (crumb bar + mobile nav), based on login state ── */
  (function () {
    var ME_KEY = 'botc_me';
    function cachedMe() {
      try {
        var raw = JSON.parse(sessionStorage.getItem(ME_KEY));
        if (raw && (Date.now() - raw.ts) < 5 * 60 * 1000) return Promise.resolve(raw.me);
      } catch (e) {}
      return fetch('/api/me', { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (me) {
          try { sessionStorage.setItem(ME_KEY, JSON.stringify({ ts: Date.now(), me: me })); } catch (e) {}
          return me;
        });
    }
    cachedMe().then(function (me) {
      var label = me && me.loggedIn ? 'My Account' : 'Log In';
      var href = ROOT + (me && me.loggedIn ? 'account' : 'login');
      // mobile nav dropdown
      var drop = document.getElementById('nav-dropdown');
      if (drop && !findLinks('account', drop).length && !findLinks('login', drop).length) {
        var a = document.createElement('a');
        a.href = href; a.textContent = label;
        drop.appendChild(a);
      }
      // desktop crumb bar (after Token Tool, like the Token Tool injection)
      document.querySelectorAll('.crumb').forEach(function (crumb) {
        if (findLinks('account', crumb).length || findLinks('login', crumb).length) return;
        var anchor = findLinks('tokens', crumb)[0] || findLinks('script', crumb)[0];
        if (!anchor) return;
        var sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '·';
        var link = document.createElement('a'); link.href = href; link.textContent = label;
        crumb.insertBefore(sep, anchor.nextSibling);
        crumb.insertBefore(link, sep.nextSibling);
      });
    }).catch(function () {});
  })();

  /* ── Search ── */
  (function () {
    var input = document.getElementById('search-input');
    var drop  = document.getElementById('search-drop');
    if (!input || !drop) return;
    var allChars = null, allScripts = [], allCollections = [], fetchPromise = null;

    function ensureData() {
      if (allChars) return Promise.resolve(allChars);
      if (fetchPromise) return fetchPromise;
      fetchPromise = Promise.all([
        fetch(ROOT + 'characters.json?_=' + Date.now()).then(function (r) { return r.json(); }),
        fetch(ROOT + 'scripts.json?_=' + Date.now()).then(function (r) { return r.json(); }).catch(function () { return []; }),
        fetch(ROOT + 'collections.json?_=' + Date.now()).then(function (r) { return r.json(); }).catch(function () { return []; })
      ]).then(function (res) {
        allChars = res[0] || [];
        allScripts = res[1] || [];
        allCollections = res[2] || [];
        return allChars;
      });
      return fetchPromise;
    }

    // Returns {type, item, field} entries — characters first, then scripts,
    // then collections. Caps at 8 results total.
    function search(q) {
      q = q.trim().toLowerCase();
      if (!q || !allChars) return [];
      var out = [];
      for (var i = 0; i < allChars.length && out.length < 8; i++) {
        var c = allChars[i];
        var field = null;
        if ((c.name || '').toLowerCase().indexOf(q) !== -1) field = 'name';
        else if ((c.ability || '').toLowerCase().indexOf(q) !== -1) field = 'ability';
        else if ((c.tags || '').toLowerCase().indexOf(q) !== -1) field = 'tag';
        else if ((c.appearsIn || '').toLowerCase().indexOf(q) !== -1) field = 'collection';
        else if ((c.creator || '').toLowerCase().indexOf(q) !== -1) field = 'creator';
        else if ((c.lede || '').toLowerCase().indexOf(q) !== -1) field = 'flavor';
        if (field) out.push({ type: 'character', c: c, field: field });
      }
      function matchPage(p) {
        return (p.name || p.displayName || '').toLowerCase().indexOf(q) !== -1 ||
               (p.tagline || '').toLowerCase().indexOf(q) !== -1 ||
               (p.description || '').toLowerCase().indexOf(q) !== -1 ||
               (p.author || '').toLowerCase().indexOf(q) !== -1;
      }
      for (var s = 0; s < allScripts.length && out.length < 8; s++) {
        if (matchPage(allScripts[s])) out.push({ type: 'script', c: allScripts[s] });
      }
      for (var k = 0; k < allCollections.length && out.length < 8; k++) {
        if (matchPage(allCollections[k])) out.push({ type: 'collection', c: allCollections[k] });
      }
      return out;
    }

    // On mobile the topbar dropdown (.search-wrap) is display:none, so the
    // nav search would render results invisibly. Mirror them into an in-flow
    // box inside the mobile nav instead.
    var navResults = null;
    function navResultsBox() {
      if (navResults) return navResults;
      var nav = document.getElementById('nav-dropdown');
      if (!nav) return null;
      navResults = document.createElement('div');
      navResults.className = 'nav-search-results';
      var ns = nav.querySelector('.nav-dropdown-search');
      if (ns && ns.nextSibling) nav.insertBefore(navResults, ns.nextSibling);
      else nav.appendChild(navResults);
      return navResults;
    }

    function render(results, q) {
      var html;
      if (!results.length) {
        html = '<div class="search-empty">Nothing found for \u201c' + esc(q) + '\u201d</div>';
      } else {
        html = resultsHTML(results);
      }
      drop.innerHTML = html;
      var nb = navResultsBox();
      if (nb) nb.innerHTML = html;
    }

    function pageThumb(p) {
      var img = p.logo || p.header;
      return img ? (ROOT + 'assets/' + img) : (ROOT + 'assets/favicon.png');
    }
    function resultsHTML(results) {
      return results.map(function (r) {
        if (r.type === 'script' || r.type === 'collection') {
          var p = r.c;
          var pname = p.name || p.displayName || '';
          var phref = r.type === 'script'
            ? ROOT + 's/' + encodeURIComponent(p.slug)
            : ROOT + 'collection/' + encodeURIComponent(p.id || p.slug);
          var psub = p.tagline || p.description || '';
          if (psub.length > 80) psub = psub.slice(0, 80) + '\u2026';
          return '<a class="search-result" href="' + esc(phref) + '" role="option">' +
            '<img class="search-result-thumb" src="' + esc(pageThumb(p)) + '" alt="" ' +
            'onerror="this.src=\'' + ROOT + 'assets/favicon.png\'">' +
            '<div class="search-result-info">' +
            '<span class="search-result-name">' + esc(pname) +
            '<span class="search-match">' + (r.type === 'script' ? 'Script' : 'Collection') + '</span></span>' +
            '<span class="search-result-ability">' + esc(psub) + '</span>' +
            '</div></a>';
        }
        var c = r.c;
        var typeClass = GOOD[c.team] ? ' good' : '';
        var ability = c.ability || '';
        if (ability.length > 80) ability = ability.slice(0, 80) + '…';
        var fieldTag = r.field !== 'name'
          ? '<span class="search-match">matched ' + esc(r.field) + '</span>' : '';
        return '<a class="search-result" href="' + esc(ROOT + c.page) + '" role="option">' +
          '<img class="search-result-thumb" src="' + esc(ROOT + 'assets/' + c.art) + '" alt="" ' +
          'onerror="this.src=\'' + ROOT + 'assets/favicon.png\'">' +
          '<div class="search-result-info">' +
          '<span class="search-result-name">' + esc(c.name) + fieldTag + '</span>' +
          '<span class="search-result-type' + typeClass + '">' + esc(TEAM_LABEL[c.team] || c.team) + '</span>' +
          '<span class="search-result-ability">' + esc(ability) + '</span>' +
          '</div></a>';
      }).join('');
    }

    function open() { drop.hidden = false; input.setAttribute('aria-expanded', 'true'); }
    function close() {
      drop.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      if (navResults) navResults.innerHTML = '';
    }

    var debTimer;
    input.addEventListener('input', function () {
      clearTimeout(debTimer);
      var q = input.value.trim();
      if (!q) { close(); return; }
      debTimer = setTimeout(function () {
        ensureData().then(function () { render(search(q), q); open(); });
      }, 150);
    });
    input.addEventListener('focus', function () { if (input.value.trim() && allChars) open(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { close(); input.blur(); return; }
      if (e.key === 'ArrowDown') { var f = drop.querySelector('.search-result'); if (f) { e.preventDefault(); f.focus(); } }
    });
    drop.addEventListener('keydown', function (e) {
      var cur = document.activeElement;
      if (e.key === 'ArrowDown') { e.preventDefault(); var n = cur.nextElementSibling; if (n) n.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); var p = cur.previousElementSibling; if (p) p.focus(); else input.focus(); }
      else if (e.key === 'Escape') { close(); input.focus(); }
    });
    document.addEventListener('click', function (e) {
      var w = document.getElementById('search-wrap');
      if (navResults && navResults.contains(e.target)) return; // tapping a mobile result
      if (w && !w.contains(e.target)) close();
    });
    var sw = document.getElementById('search-wrap');
    if (sw) sw.addEventListener('mouseenter', ensureData);
  })();

  /* ── Mobile nav ── */
  (function () {
    var btn = document.getElementById('hamburger');
    var drop = document.getElementById('nav-dropdown');
    if (!btn || !drop) return;
    // Inject the Token Tool link into the nav once, on every page (root-aware).
    if (!findLinks('tokens', drop).length) {
      var ttLink = document.createElement('a');
      ttLink.href = ROOT + 'tokens';
      ttLink.textContent = 'Token Tool';
      var sb = findLinks('script', drop)[0];
      if (sb) drop.insertBefore(ttLink, sb.nextSibling); else drop.appendChild(ttLink);
    }
    // Random Character link (/random is a Worker route, so the path is absolute).
    if (!drop.querySelector('a[href="/random"]')) {
      var rcLink = document.createElement('a');
      rcLink.href = '/random';
      rcLink.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><rect width="12" height="12" x="2" y="10" rx="2" ry="2"/><path d="m17.92 14 3.5-3.5a2.24 2.24 0 0 0 0-3l-5-4.92a2.24 2.24 0 0 0-3 0L10 6"/><path d="M6 18h.01"/><path d="M10 14h.01"/><path d="M15 6h.01"/><path d="M18 9h.01"/></svg>Random Character';
      var tt = findLinks('tokens', drop)[0];
      if (tt) drop.insertBefore(rcLink, tt.nextSibling); else drop.appendChild(rcLink);
    }
    var here = (location.pathname.split('/').pop() || 'index').replace(/\.html$/, '');
    drop.querySelectorAll('a').forEach(function (a) {
      var h = (a.getAttribute('href') || '').replace(/\.html$/, '');
      if (h === here || (here === 'index' && (h === '/' || h === '../' || h === './'))) a.classList.add('active');
    });
    function positionDrop() {
      var tb = document.querySelector('.topbar');
      if (tb) drop.style.top = tb.getBoundingClientRect().height + 'px';
    }
    btn.addEventListener('click', function () {
      positionDrop();
      var open = drop.classList.toggle('open');
      btn.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) { var ns = document.getElementById('nav-search-input'); if (ns) setTimeout(function () { ns.focus(); }, 80); }
    });
    var navSearch = document.getElementById('nav-search-input');
    var topSearch = document.getElementById('search-input');
    if (navSearch && topSearch) {
      navSearch.addEventListener('input', function () {
        topSearch.value = navSearch.value;
        topSearch.dispatchEvent(new Event('input'));
      });
      navSearch.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { drop.classList.remove('open'); btn.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); }
      });
    }
    window.addEventListener('resize', positionDrop);
    document.addEventListener('click', function (e) {
      if (!btn.contains(e.target) && !drop.contains(e.target)) {
        drop.classList.remove('open'); btn.classList.remove('open'); btn.setAttribute('aria-expanded', 'false');
      }
    });
  })();
})();
