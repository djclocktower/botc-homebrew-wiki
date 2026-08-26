/* The three character art slots, named for the character being written.

   The official script schema (ThePandemoniumInstitute/botc-release) gives
   `image` one to three entries, and what each position MEANS depends on the
   team:

     non-traveller   [regular, flipped]
     traveller       [unaligned, good, evil]

   A traveller therefore has a good token and an evil token, which is the
   whole reason the third slot exists — and a field labelled "Alternate art"
   tells the person filling it in none of that. So the labels follow the team
   dropdown, and slot three is drawn only for a traveller, because nobody
   else has a third entry to put anything in.

   This lives in its own file rather than in redesign-create.js, whose
   contract is layout alone and whose CSS is scoped to html.create-redesign
   so a failed load leaves the plain form standing. A missing label here
   would be worse than the plain form: the field would be there, and mean
   something other than what it says.

   create.html and edit.html are the same form — this is what stops the two
   drifting apart. Mounted by both. */
(function () {
  /* Only the TRAVELLER wording lives here. The other half is whatever the
     page already wrote, snapshotted on the first paint and put back — so
     create.html keeps its required-marker asterisk and edit.html its "leave
     blank to keep existing", neither of which this file knows about, and
     neither of which has to be repeated here to survive. */
  var TRAVELLER = {
    main: ['Character art', 'the unaligned icon &mdash; what the wiki shows, and the first entry in the JSON'],
    alt:  ['Good art', 'the token a good traveller gets; the second entry in the JSON'],
    alt2: ['Evil art', 'the token an evil traveller gets; the third entry in the JSON']
  };

  /* Both spellings. Nothing validates a team on save, the importers
     normalise 'traveler' and other files already defend against it. */
  function isTraveller(t) { return /^travell?er$/i.test(String(t == null ? '' : t)); }

  var original = {};   // slot key -> the label the page shipped

  function paint() {
    var teamEl = document.getElementById('team');
    var trav = isTraveller(teamEl && teamEl.value);
    Object.keys(TRAVELLER).forEach(function (key) {
      var fld = document.querySelector('.fld[data-art-slot="' + key + '"]');
      if (!fld) return;
      /* Slot three is a traveller's evil token and nothing else's. Hidden
         rather than removed, so a character retyped as a Traveller grows the
         field without the page being rebuilt — and, more importantly, so
         that a character retyped OFF Traveller keeps whatever is already in
         it. Hiding a field must never silently drop art somebody uploaded. */
      if (key === 'alt2') fld.style.display = trav ? '' : 'none';

      var label = fld.querySelector('label');
      if (!label) return;
      if (original[key] == null) original[key] = label.innerHTML;
      if (!trav) { label.innerHTML = original[key]; return; }
      var pair = TRAVELLER[key];
      label.innerHTML = pair[0] + ' <span class="hint">(' + pair[1] + ')</span>';
    });
  }

  /* Two ways in, because the event alone is not enough: edit.html sets
     #team.value from the stored row without dispatching anything, so a
     listener would never fire for a traveller being EDITED — the one case
     the labels matter most in — while create.html does dispatch after its
     JSON autofill. The exported function is how populateForm says so.
     (The same pairing as window.refreshNightOrderPickers.) */
  function mount() {
    var teamEl = document.getElementById('team');
    if (teamEl) teamEl.addEventListener('change', paint);
    paint();
  }

  window.refreshArtLabels = paint;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
