/* ── Card thumbnails: the browser makes them, the Worker serves them ──────
   Every card grid, search result and roster row draws thumb/{file}.webp — a
   192px WebP twin of art/{file} (~8 KB against the original's ~150 KB, and up
   to 700 KB). The Worker cannot resize an image, so the thumbnail is made HERE,
   in the browser that has just uploaded the art, and uploaded beside it:
   ArtThumb.upload(artKey, source) after every successful art upload.

   Rules that keep this safe to bolt onto any upload path:
     - fire and forget. It never blocks or fails the save it follows; a thumb
       that did not get made costs a card the original picture until the
       dashboard's backfill card makes one, nothing more (the Worker serves the
       original at the thumbnail URL when there is none — serveThumb()).
     - WebP or nothing. A browser whose canvas cannot encode WebP (older
       Safari) gets a PNG back from toDataURL and the Worker would refuse
       `thumb/x.png.webp` carrying image/png — so the helper checks the
       result's type and simply skips, rather than uploading a mislabelled file.
     - only art/ keys. Collection banners and tokens have no thumbnail slot.

   The same permission as the art applies on the server (uploadSlotDenied maps
   the key back), so this cannot write where the art upload could not.
   The dashboard's "Card thumbnails" card uses uploadFromUrl() to backfill
   every character that still lacks one. */
(function () {
  var SIZE = 192;
  var ART_RE = /^art\/[^/]+\.(png|jpe?g|webp|gif)$/i;

  function thumbKey(artKey) {
    var k = String(artKey || '').replace(/^\/+/, '').replace(/^assets\//, '');
    return ART_RE.test(k) ? 'thumb/' + k.slice(4) + '.webp' : '';
  }

  /* Draw `src` (a data: URL, a blob URL or a same-origin/CORS image URL) into
     a SIZE×SIZE box, keeping its aspect ratio and transparency. Resolves with
     a WebP data URL, or '' when this browser cannot encode WebP. */
  function make(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        if (!w || !h) return reject(new Error('empty image'));
        var scale = Math.min(1, SIZE / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
        var cv = document.createElement('canvas');
        cv.width = cw; cv.height = ch;
        var ctx = cv.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, cw, ch);
        var out;
        try { out = cv.toDataURL('image/webp', 0.8); } catch (e) { return reject(e); }
        resolve(/^data:image\/webp/i.test(out) ? out : '');
      };
      img.onerror = function () { reject(new Error('image failed to load')); };
      img.src = src;
    });
  }

  function post(key, dataUrl) {
    return fetch((window.LINK_ROOT || '/') + 'api/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify({ key: key, data: dataUrl })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || j.error) throw new Error((j && j.error) || 'thumbnail upload failed');
      return j;
    });
  }

  /* Make and upload the thumbnail for `artKey` from `src`. Resolves true when
     a thumbnail was stored, false when it was skipped or failed — never
     rejects, so callers can drop the promise. */
  function upload(artKey, src) {
    var key = thumbKey(artKey);
    if (!key || !src) return Promise.resolve(false);
    return make(src).then(function (dataUrl) {
      if (!dataUrl) return false;
      return post(key, dataUrl).then(function () { return true; });
    }).catch(function () { return false; });
  }

  /* The same, reading the art back from the site (for art the browser never
     held: a server-side Bloodstar copy, or the backfill). `?v=` busts any
     cached copy so a just-replaced icon is what gets thumbnailed. */
  function uploadFromUrl(artKey, url) {
    var u = url || ((window.LINK_ROOT || '/') + 'assets/' + String(artKey).replace(/^\/+/, '').replace(/^assets\//, ''));
    u += (u.indexOf('?') === -1 ? '?' : '&') + 'v=' + Date.now().toString(36);
    return upload(artKey, u);
  }

  window.ArtThumb = { SIZE: SIZE, thumbKey: thumbKey, make: make, upload: upload, uploadFromUrl: uploadFromUrl };
})();
