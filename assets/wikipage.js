/* Client-side enhancements for the custom wiki pages (/p/{slug}).
   The Worker sets window.WIKI_PAGE_SLUG before loading this. Like the other
   SSR pages, the Edit button is shown unconditionally — the server enforces
   ownership on every write. */
(function () {
  var ROOT = (typeof window !== 'undefined' && window.LINK_ROOT) || '';
  var SLUG = window.WIKI_PAGE_SLUG || '';

  var editBtn = document.getElementById('edit-btn');
  if (editBtn && SLUG) {
    editBtn.href = ROOT + 'publish-page?p=' + encodeURIComponent(SLUG);
    editBtn.style.display = '';
  }

  /* Smooth-scroll the contents box, and keep the heading clear of the topbar. */
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('.wiki-toc a, .sec-anchor');
    if (!a) return;
    var id = (a.getAttribute('href') || '').replace(/^#/, '');
    var target = id && document.getElementById(id);
    if (!target) return;
    e.preventDefault();
    var y = target.getBoundingClientRect().top + window.pageYOffset - 70;
    window.scrollTo({ top: y, behavior: 'smooth' });
    if (history.replaceState) history.replaceState(null, '', '#' + id);
  });

  /* Landing on a #anchor: same offset, once the page has laid out. */
  if (location.hash.length > 1) {
    window.addEventListener('load', function () {
      var target = document.getElementById(location.hash.slice(1));
      if (!target) return;
      window.scrollTo(0, target.getBoundingClientRect().top + window.pageYOffset - 70);
    });
  }
})();
