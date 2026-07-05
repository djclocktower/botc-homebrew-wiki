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
    var allChars = null, fetchPromise = null;

    function ensureData() {
      if (allChars) return Promise.resolve(allChars);
      if (fetchPromise) return fetchPromise;
      fetchPromise = fetch(ROOT + 'characters.json?_=' + Date.now())
        .then(function (r) { return r.json(); })
        .then(function (l) { allChars = l; return l; });
      return fetchPromise;
    }

    // Returns {char, field} so we can show which field matched
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
        if (field) out.push({ c: c, field: field });
      }
      return out;
    }

    function render(results, q) {
      if (!results.length) {
        drop.innerHTML = '<div class="search-empty">No characters found for \u201c' + esc(q) + '\u201d</div>';
        return;
      }
      drop.innerHTML = results.map(function (r) {
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
    function close() { drop.hidden = true; input.setAttribute('aria-expanded', 'false'); }

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
      rcLink.textContent = '🎲 Random Character';
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
