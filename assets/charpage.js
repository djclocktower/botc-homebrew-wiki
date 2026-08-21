/* Character page enhancements — loaded by every server-rendered /c/{slug}
   page (the Worker renders the HTML from D1; see worker/worker.js).
   Adds the Edit button, the "Add to Script" / "Add to Token Tool" buttons,
   title auto-fit, and #hash scrolling. */
(function () {
  var SLUG = window.CHAR_SLUG;
  if (!document.getElementById('content') || !SLUG) return;

  // Generic localStorage-backed toggle button appended to the info card.
  function mountToggleButton(storageKey, extraClass, onLabel, offLabel, onChange) {
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
      btn.textContent = on ? onLabel : offLabel;
    }
    btn.addEventListener('click', function () {
      var list = getList();
      var i = list.indexOf(SLUG);
      if (i === -1) list.push(SLUG); else list.splice(i, 1);
      try { localStorage.setItem(storageKey, JSON.stringify(list)); } catch (e) {}
      sync();
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

  mountToggleButton('botc_script', '', '✓ On Your Script', '+ Add to Script',
    function () { if (window.updateScriptBadge) window.updateScriptBadge(); });
  mountToggleButton('botc_token_set', 'add-to-token-btn', '✓ In Token Tool', '+ Add to Token Tool');

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
