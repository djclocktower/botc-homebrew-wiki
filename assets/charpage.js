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

  // Turn the "Appears in" value into a link to its collection page, when one
  // exists. Resolves the same way the collection pages do (match[] normalized,
  // then id / slug / displayName) so it works for match variants, and leaves
  // the text plain when no collection matches (e.g. a bare script name).
  (function linkAppearsIn() {
    var dd = document.querySelector('.info-appears-in');
    if (!dd) return;
    var raw = dd.getAttribute('data-appears-in') || dd.textContent || '';
    if (!raw.trim()) return;
    function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
    var key = norm(raw);
    if (!key) return;
    var root = window.LINK_ROOT || '';
    fetch(root + 'collections.json', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (cols) {
        if (!Array.isArray(cols)) cols = (cols && cols.collections) || [];
        var hit = null;
        for (var i = 0; i < cols.length; i++) {
          var c = cols[i]; if (!c) continue;
          var matches = (c.match || []).map(norm);
          if (matches.indexOf(key) !== -1 || norm(c.id) === key ||
              norm(c.slug) === key || norm(c.displayName) === key) { hit = c; break; }
        }
        if (!hit) return;
        var a = document.createElement('a');
        a.className = 'appears-in-link';
        a.href = root + 'collection/' + encodeURIComponent(hit.id || hit.slug || '');
        a.textContent = raw;
        dd.textContent = '';
        dd.appendChild(a);
      })
      .catch(function () { /* leave as plain text on any error */ });
  })();
})();
