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

  // Download the official-schema JSON as {slug}.json.
  //
  // The button ships as href="#" and the download is attached here. It used to
  // be built entirely inside a click handler, which meant every way that
  // handler could fail to act — a browser that won't honour a synthetic click
  // on a just-created <a>, a tap the page swallowed — left the plain "#" href
  // to run instead, so the tap only jumped to the top of the page and stuck a
  // # on the URL. Making the button a real download link removes that whole
  // class of failure: the href IS the file, so a normal tap saves it, and so
  // does long-press → "Download linked file".
  var dl = document.getElementById('json-download');
  // One JSON panel per page; the collection layout drops the .script-json-panel
  // wrapper, so match the code block directly rather than by container.
  var code = document.querySelector('.json-body code');
  if (dl && code) {
    dl.href = URL.createObjectURL(new Blob([code.textContent], { type: 'application/json' }));
    dl.setAttribute('download', (SLUG || TYPE || 'script') + '.json');
    // Browsers with no download attribute (old iOS Safari) would paint the
    // JSON over this page instead of saving it. Its own tab is the closest
    // they can manage, and it leaves the page the reader was on alone.
    if (!('download' in document.createElement('a'))) {
      dl.target = '_blank';
      dl.rel = 'noopener';
    }
  } else if (dl) {
    // Nothing to hand over — better no button than one that only jumps to the
    // top of the page.
    dl.style.display = 'none';
  }
})();
