/* Client-side enhancements for SSR script/collection pages (/s/, /collection/).
   The Worker sets window.PAGE_TYPE ('script'|'collection') and window.PAGE_SLUG
   before loading this. The edit button is shown unconditionally (like character
   pages) — the server enforces ownership on every write. */
(function () {
  var ROOT = (typeof window !== 'undefined' && window.LINK_ROOT) || '';
  var TYPE = window.PAGE_TYPE || '';
  var SLUG = window.PAGE_SLUG || '';

  var editBtn = document.getElementById('edit-btn');
  if (editBtn && TYPE && SLUG) {
    editBtn.href = ROOT + (TYPE === 'collection'
      ? 'publish-collection?c=' + encodeURIComponent(SLUG)
      : 'publish-script?s=' + encodeURIComponent(SLUG));
    editBtn.style.display = '';
  }

  // The Download JSON button is a plain link to /api/page-json now — the
  // server builds that JSON to render this page anyway, so nothing here has to
  // attach it. It used to be an href="#" that this file turned into a blob:
  // URL on load, which meant any way this script failed to run in time (an
  // extension, a slow load, an error further up) left the bare "#" for the
  // click: the page jumped to the top and saved nothing, with no error to see.
  // A real href cannot fail that way, works with JavaScript off, and can be
  // long-pressed or "save link as"-ed like any other link.
})();
