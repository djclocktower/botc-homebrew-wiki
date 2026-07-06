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
})();
