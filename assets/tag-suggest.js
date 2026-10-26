/* "Suggest tags" under the tag picker on create.html and edit.html (the same
   form, so one file). Asks /api/suggest-tags for the tags the ability reads
   as, ticks the ones not already picked and outlines them, so the writer
   sees exactly what was added and can untick it before saving. Never
   unticks anything, never saves. Needs window.setTagPickerValue, which
   both editors' tag picker defines.
   window.tagSuggestLog() hands the save what was offered (every tag the
   suggester said) and what was ticked before the first press, so the Worker
   can record what the writer kept, removed and added. */
(function () {
  var picker = document.getElementById('tag-picker');
  if (!picker || !window.setTagPickerValue) return;
  var val = function (id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; };

  var row = document.createElement('div');
  row.className = 'tag-suggest';
  // A strip on top of the tag box, so it reads as part of the picker.
  var ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>';
  var LABEL = 'Suggest tags from the ability', HELP = 'Picks tags for you to check.';
  row.innerHTML = '<button type="button" class="tag-suggest-btn">' + ICON + '<span>' + LABEL + '</span></button> <span class="tag-suggest-note">' + HELP + '</span>';
  picker.parentNode.insertBefore(row, picker);
  var btn = row.querySelector('button'), note = row.querySelector('.tag-suggest-note'), label = btn.querySelector('span');
  var offered = [], before = null;
  var tagsNow = function () { return val('tags').split(',').map(function (s) { return s.trim(); }).filter(Boolean); };
  // Read once per save, then cleared, so a second save does not count twice.
  window.tagSuggestLog = function () {
    if (before === null) return null;
    var log = { suggested: offered.slice(), before: before.slice() };
    offered = []; before = null;
    return log;
  };

  btn.addEventListener('click', function () {
    if (!val('ability')) { note.textContent = 'Write the ability first: the suggestions are read off it.'; return; }
    btn.disabled = true; label.textContent = 'Suggesting…'; note.textContent = '';
    if (before === null) before = tagsNow();
    var char = {
      name: val('name'), team: val('team'), ability: val('ability'), lede: val('lede'),
      summaryBullets: val('bullets').split('\n').map(function (s) { return s.trim(); }).filter(Boolean)
    };
    var ask = function (quick) {
      return fetch('/api/suggest-tags', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(quick ? Object.assign({ quick: true }, char) : char)
      }).then(function (r) { return r.json(); });
    };
    // Every tag this press has ticked, across both answers.
    var added = [];
    var tick = function (tags) {
      (tags || []).forEach(function (t) { if (offered.indexOf(t) === -1) offered.push(t); });
      var have = val('tags').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      var lower = have.map(function (s) { return s.toLowerCase(); });
      var fresh = (tags || []).filter(function (t) { return lower.indexOf(t.toLowerCase()) === -1; });
      if (!fresh.length) return;
      added = added.concat(fresh);
      window.setTagPickerValue(have.concat(fresh).join(', '));
      picker.querySelectorAll('.tag-pick-btn').forEach(function (b) {
        if (added.indexOf(b.getAttribute('data-tag')) !== -1) b.classList.add('suggested');
      });
      // The editors redraw their preview on input; this nudges it the way a keystroke would.
      document.getElementById('ability').dispatchEvent(new Event('input'));
    };
    var said = function () {
      return added.length ? 'Ticked ' + added.length + ': ' + added.join(', ') + '.' : '';
    };
    // The wording rules answer at once; the model's judgement follows.
    var quick = ask(true).then(function (d) {
      if (d.error) return;
      tick(d.tags);
      if (added.length) note.textContent = said() + ' Looking for more…';
    }).catch(function () {});
    ask(false).then(function (d) {
      return quick.then(function () {
        // The surest tags may already be ticked: say the rest did not come.
        if (d.error) { note.textContent = said() ? said() + ' Only the surest tags were ticked this time. ' + d.error : d.error; return; }
        tick(d.tags);
        note.textContent = (said() || ((d.tags || []).length ? 'Nothing to add: every suggestion is already ticked.' : 'No suggestions for this one.')) +
          (d.capped ? ' (Only the surest tags are suggested for the rest of today.)' : '');
      });
    }).catch(function () {
      return quick.then(function () { note.textContent = said() || 'No suggestions right now. Try again in a minute.'; });
    }).then(function () { btn.disabled = false; label.textContent = LABEL; });
  });
  // Touching a chip by hand settles it: the outline only marks what is untouched.
  picker.addEventListener('click', function (e) {
    var b = e.target.closest('.tag-pick-btn');
    if (b) b.classList.remove('suggested');
  });
})();
