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
  row.innerHTML = '<button type="button" class="btn btn-blue btn-sm">Suggest tags</button> <span class="hint"></span>';
  picker.parentNode.insertBefore(row, picker);
  var btn = row.querySelector('button'), note = row.querySelector('.hint');
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
    btn.disabled = true; note.textContent = 'Reading the ability…';
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
        if (d.error) { note.textContent = said() || d.error; return; }
        tick(d.tags);
        note.textContent = said() || ((d.tags || []).length ? 'Nothing to add: every suggestion is already ticked.' : 'No suggestions for this one.');
      });
    }).catch(function () {
      return quick.then(function () { note.textContent = said() || 'No suggestions right now. Try again in a minute.'; });
    }).then(function () { btn.disabled = false; });
  });
  // Touching a chip by hand settles it: the outline only marks what is untouched.
  picker.addEventListener('click', function (e) {
    var b = e.target.closest('.tag-pick-btn');
    if (b) b.classList.remove('suggested');
  });
})();
