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

  // Delete button — shown only to accounts that may edit this page (owner or
  // admin). Soft-delete: the page drops off the site but an admin can restore
  // it from the dashboard.
  var delBtn = document.getElementById('delete-btn');
  if (delBtn && TYPE && SLUG) {
    fetch('/api/page?type=' + encodeURIComponent(TYPE) + '&slug=' + encodeURIComponent(SLUG), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.canEdit) return;
        delBtn.style.display = '';
        delBtn.addEventListener('click', function () {
          var label = document.title.split('—')[0].trim() || ('this ' + TYPE);
          if (!confirm('Delete "' + label + '"?\n\nIt will be removed from the site. An admin can restore it from the dashboard.')) return;
          delBtn.disabled = true; delBtn.textContent = 'Deleting…';
          fetch('/api/delete', {
            method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: TYPE, slug: SLUG })
          }).then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); })
            .then(function (res) {
              if (res.status === 200 && res.body.ok) { location.href = ROOT + (TYPE === 'collection' ? '' : 'scripts'); }
              else { alert((res.body && res.body.error) || 'Delete failed.'); delBtn.disabled = false; delBtn.innerHTML = '&#128465;&#65039; Delete'; }
            }).catch(function () { alert('Network error.'); delBtn.disabled = false; delBtn.innerHTML = '&#128465;&#65039; Delete'; });
        });
      }).catch(function () {});
  }

  // Download the official-schema JSON as {slug}.json
  var dl = document.getElementById('json-download');
  if (dl) {
    dl.addEventListener('click', function (e) {
      e.preventDefault();
      var code = document.querySelector('.script-json-panel .json-body code');
      if (!code) return;
      var blob = new Blob([code.textContent], { type: 'application/json' });
      var u = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = u; a.download = (SLUG || 'script') + '.json';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(u); }, 1000);
    });
  }
})();
