/* Client-side enhancements for news article pages (/news/{slug}).

   The Worker sets window.PAGE_SLUG before loading this (the same value the
   comment widget reads). All this does is put the Edit button in the top bar,
   so an admin reading an article can get to the editor from the article
   itself — the way /c/, /s/, /collection/ and /p/ pages already work.

   Unlike those pages the button is NOT shown unconditionally. Character,
   script and wiki pages have many possible editors and let the server turn
   the write down; news is admin-only, so showing readers an Edit button would
   just walk them into the "Admins only" gate. One /api/me call decides it.

   That answer arrives after site.js has already placed the button, which is
   why it calls window.placeEditButton() again afterwards — see site.js. */
(function () {
  var ROOT = (typeof window !== 'undefined' && window.LINK_ROOT) || '';
  var SLUG = window.PAGE_SLUG || '';
  var editBtn = document.getElementById('edit-btn');
  if (!editBtn || !SLUG) return;

  fetch('/api/me', { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (me) {
      if (!me || !me.isAdmin) return;
      editBtn.href = ROOT + 'publish-news?n=' + encodeURIComponent(SLUG);
      editBtn.style.display = '';
      if (window.placeEditButton) window.placeEditButton();
    })
    .catch(function () { /* not logged in, or offline — leave it hidden */ });
})();
