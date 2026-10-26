/* "Suggest tags" under the tag picker on create.html and edit.html (the same
   form, so one file). Asks /api/suggest-tags for the tags the ability reads
   as, ticks the ones not already picked and outlines them, so the writer
   sees exactly what was added and can untick it before saving. Never
   unticks anything, never saves. Needs window.setTagPickerValue, which
   both editors' tag picker defines. */
(function () {
  var picker = document.getElementById('tag-picker');
  if (!picker || !window.setTagPickerValue) return;
  var val = function (id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; };

  var row = document.createElement('div');
  row.className = 'tag-suggest';
  row.innerHTML = '<button type="button" class="btn btn-blue btn-sm">Suggest tags</button> <span class="hint"></span>';
  picker.parentNode.insertBefore(row, picker);
  var btn = row.querySelector('button'), note = row.querySelector('.hint');

  btn.addEventListener('click', function () {
    if (!val('ability')) { note.textContent = 'Write the ability first: the suggestions are read off it.'; return; }
    btn.disabled = true; note.textContent = 'Reading the ability…';
    fetch('/api/suggest-tags', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: val('name'), team: val('team'), ability: val('ability'), lede: val('lede'),
        summaryBullets: val('bullets').split('\n').map(function (s) { return s.trim(); }).filter(Boolean)
      })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) { note.textContent = d.error; return; }
      var have = val('tags').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      var lower = have.map(function (s) { return s.toLowerCase(); });
      var added = (d.tags || []).filter(function (t) { return lower.indexOf(t.toLowerCase()) === -1; });
      if (!added.length) { note.textContent = (d.tags || []).length ? 'Nothing to add: every suggestion is already ticked.' : 'No suggestions for this one.'; return; }
      window.setTagPickerValue(have.concat(added).join(', '));
      picker.querySelectorAll('.tag-pick-btn').forEach(function (b) {
        b.classList.toggle('suggested', added.indexOf(b.getAttribute('data-tag')) !== -1);
      });
      note.textContent = 'Ticked ' + added.length + ': ' + added.join(', ') + '. Outlined, so you can check them; untick any that are wrong before saving.';
      // The editors redraw their preview on input; this nudges it the way a keystroke would.
      document.getElementById('ability').dispatchEvent(new Event('input'));
    }).catch(function () {
      note.textContent = 'No suggestions right now. Try again in a minute.';
    }).then(function () { btn.disabled = false; });
  });
  // Touching a chip by hand settles it: the outline only marks what is untouched.
  picker.addEventListener('click', function (e) {
    var b = e.target.closest('.tag-pick-btn');
    if (b) b.classList.remove('suggested');
  });
})();
