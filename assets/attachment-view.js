/* Small display-only attachment gallery; the uploader loads on interaction. */
(function () {
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* The reading half: the gallery under a comment or a message. Every path
     has already been whitelisted server-side (sanitizeAttachments), so this
     is a plain attribute copy — but it is escaped anyway, because a renderer
     that trusts its input is one schema change away from not being able to.
     The image links to itself: a full-size look is a new tab, not a lightbox
     nobody can close on a phone. */
  function attachmentsHTML(list) {
    if (!list || !list.length) return '';
    return '<div class="att-shots">' + list.map(function (p) {
      var src = esc(p);
      return '<a class="att-shot" href="' + src + '" target="_blank" rel="noopener">' +
        '<img src="' + src + '" alt="Attached image" loading="lazy" decoding="async">' +
      '</a>';
    }).join('') + '</div>';
  }

  window.attachmentsHTML = attachmentsHTML;
})();
