/* ── Card thumbnails and display copies: the browser makes them, the Worker
   serves them ──────────────────────────────────────────────────────────
   Every card grid, search result and roster row draws thumb/{file}.webp — a
   192px WebP twin of art/{file} (~8 KB against the original's ~150 KB, and up
   to 700 KB). The pages that show ONE icon large (the /c/ emblem, the
   homepage's Featured card) draw media/full/art/{file}.webp — the DISPLAY
   copy: the same picture at its own size as WebP q85 (~37 KB against the
   PNG's ~166 KB). The original PNG stays exactly as it was, and stays what
   every export, the official script tool and the Token Tool read. The Worker
   cannot resize or re-encode an image, so both are made HERE, in the browser
   that has just uploaded the art, and uploaded beside it:
   ArtThumb.upload(artKey, source) after every successful art upload.

   Rules that keep this safe to bolt onto any upload path:
     - fire and forget. It never blocks or fails the save it follows; a copy
       that did not get made costs a page the original picture until the
       dashboard's backfill card makes one, nothing more (the Worker serves the
       original at the copy's URL when there is none — serveThumb()/serveMedia()).
     - WebP or nothing. A browser whose canvas cannot encode WebP (older
       Safari) gets a PNG back from toDataURL and the Worker would refuse
       `thumb/x.png.webp` carrying image/png — so the helper checks the
       result's type and simply skips, rather than uploading a mislabelled file.
     - a picture or nothing. A thumbnail that drew nothing is far worse than
       one that was never made: the fallback only fires when the file is
       ABSENT, so a blank one is served as a real image, `onerror` never
       fires (it IS a valid image), and the card is an empty tile while the
       character's own page — which draws the full art — looks perfect. One
       character on the wiki carried a 172-byte, entirely transparent
       thumbnail that way. So the render is checked before it is uploaded.
     - never enlarged. Script/collection banners and logos use media/
       variants at the 320/640/1280 slots, each the source at min(slot,
       source width): an enlarged copy is bigger than the original and no
       sharper (a 400px logo came out as a 77 KB "1280" file against a 24 KB
       original), and the srcset would claim a width the file does not have.
       The Worker refuses an enlarged copy and records the source's width on
       the page (imageW) so PageRender.responsiveAttrs() lists true widths.
     - bound to the original. A media/ copy (banner sizes and the art display
       copy) carries the ETag of the original it was made from, and the
       Worker serves it only while that still matches. The publish pages pass
       the ETag their upload returned; for art, which the editors upload
       themselves, it is read back with one HEAD request.
       Publish pages await the banner variants before saving the new row.

   The same permission as the art applies on the server (uploadSlotDenied maps
   the key back), so this cannot write where the art upload could not.
   The dashboard's "Card thumbnails" card uses uploadFromUrl() to backfill
   every character that still lacks one or the other. */
(function () {
  var SIZE = 192;
  var MEDIA_RE = /^(scripts|collections)\/[^/]+\.(png|jpe?g|webp)$/i;
  var WIDTHS = [320, 640, 1280];
  var ART_RE = /^art\/[^/]+\.(png|jpe?g|webp|gif)$/i;
  // The display copy: the icon at its own size, capped (MEDIA_FULL_MAX in
  // worker.js). Not for a GIF (a canvas keeps frame one) and not for the
  // printable token (-token), which is shown small and never as an icon.
  var DISPLAY_RE = /^art\/[^/]+\.(png|jpe?g|webp)$/i;
  var DISPLAY_MAX = 1024;
  var DISPLAY_QUALITY = 0.85;

  function clean(k) { return String(k || '').replace(/^\/+/, '').replace(/^assets\//, ''); }
  function thumbKey(artKey) {
    var k = clean(artKey);
    return ART_RE.test(k) ? 'thumb/' + k.slice(4) + '.webp' : '';
  }
  function displayKey(artKey) {
    var k = clean(artKey);
    return DISPLAY_RE.test(k) && !/-token\.[a-z]+$/i.test(k) ? 'media/full/' + k + '.webp' : '';
  }

  /* Is every pixel of what was just drawn fully transparent? That is the
     shape a failed draw takes — the canvas is the right size and completely
     empty — and it is the one case worth refusing outright, since no icon on
     this wiki is invisible. A tainted canvas cannot be read back, so that
     answers "not blank" and toDataURL below rejects it a line later, which is
     the same outcome by the route that was already there. */
  function isBlank(ctx, w, h) {
    var d;
    try { d = ctx.getImageData(0, 0, w, h).data; } catch (e) { return false; }
    for (var i = 3; i < d.length; i += 4) if (d[i]) return false;
    return true;
  }

  /* Draw a DECODED image, keeping its aspect ratio and transparency, and
     NEVER larger than it is:
       {width: W}  — a banner slot: W wide, or the source's own width if that
                     is narrower;
       {box: B}    — fit inside B×B (the 192px thumbnail, the display copy).
     Returns a WebP data URL, or '' when this browser cannot encode WebP;
     throws when the render came out empty. */
  function render(img, opts) {
    opts = typeof opts === 'number' ? { width: opts } : (opts || {});
    var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    if (!w || !h) throw new Error('empty image');
    var scale = opts.width ? Math.min(1, opts.width / w) : Math.min(1, (opts.box || SIZE) / Math.max(w, h));
    var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
    if (cw * ch > 16 * 1024 * 1024) throw new Error('image aspect ratio is too large');
    var cv = document.createElement('canvas');
    cv.width = cw; cv.height = ch;
    var ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, cw, ch);
    if (isBlank(ctx, cw, ch)) throw new Error('blank render');
    var out = cv.toDataURL('image/webp', opts.quality || 0.8);
    return /^data:image\/webp/i.test(out) ? out : '';
  }

  /* Load and DECODE `src` (a data: URL, a blob URL or a same-origin/CORS
     image URL). Resolves with the <img>.

     `onload` says the bytes arrived, NOT that the bitmap is ready to paint,
     and a drawImage that lands in that gap paints nothing — which is the most
     likely way a fully transparent thumbnail was ever stored. decode() is the
     promise that closes the gap; a browser without it (or one whose decode
     rejects) draws on load exactly as before, where isBlank() is the backstop. */
  function load(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        if (typeof img.decode === 'function') img.decode().then(function () { resolve(img); }, function () { resolve(img); });
        else resolve(img);
      };
      img.onerror = function () { reject(new Error('image failed to load')); };
      img.src = src;
    });
  }
  /* Load `src` and render it (see render() for `opts`; a bare number is a
     banner slot width, nothing at all is the 192px thumbnail). Resolves with
     a WebP data URL, or '' when this browser cannot encode WebP. */
  function make(src, opts) {
    return load(src).then(function (img) { return render(img, opts); });
  }

  function post(key, dataUrl, sourceETag) {
    return fetch((window.LINK_ROOT || '/') + 'api/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify({ key: key, data: dataUrl, sourceETag: sourceETag })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || j.error) throw new Error((j && j.error) || 'thumbnail upload failed');
      return j;
    });
  }

  /* The ETag of the original as stored right now — what a media/ copy is
     bound to. One HEAD request (the Worker answers it from R2 without
     reading the picture); '' when it cannot be had, and then no display copy
     is made, which only costs the page the original picture. */
  function originalETag(key) {
    var u = (window.LINK_ROOT || '/') + 'assets/' + key;
    return fetch(u, { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) { return r.ok ? (r.headers.get('ETag') || '') : ''; })
      .catch(function () { return ''; });
  }

  /* The banner sizes. Each slot is the source at min(slot, source width) —
     never enlarged — so a narrow logo fills its upper slots with the same
     picture (rendered once, uploaded per slot: an older page's srcset may
     still name every slot). Resolves true when every slot was stored. */
  function uploadMedia(artKey, img, sourceETag) {
    var made = {};
    return WIDTHS.reduce(function (chain, width) {
      return chain.then(function (ok) {
        var w = img.naturalWidth || img.width;
        var target = Math.min(width, w);
        var data = made[target] !== undefined ? made[target] : (made[target] = render(img, { width: target }));
        if (!data) return false;
        return post('media/' + width + '/' + artKey + '.webp', data, sourceETag).then(function () { return ok; });
      });
    }, Promise.resolve(true));
  }

  /* The display copy of a character's art (see DISPLAY_RE). */
  function uploadDisplay(artKey, img, sourceETag) {
    var key = displayKey(artKey);
    if (!key) return Promise.resolve(false);
    return (sourceETag ? Promise.resolve(sourceETag) : originalETag(clean(artKey))).then(function (etag) {
      if (!etag) return false;
      var data = render(img, { box: DISPLAY_MAX, quality: DISPLAY_QUALITY });
      if (!data) return false;
      return post(key, data, etag).then(function () { return true; });
    });
  }

  /* Make and upload the copies for `artKey` from `src`:
       art/…              the 192px thumbnail, then the display copy;
       scripts|collections the three banner sizes (needs `sourceETag`).
     `opts` ({thumb, display}, both on by default) lets the backfill make only
     what is missing. Resolves true when the thumbnail (or, for a banner,
     every size) was stored, false when it was skipped or failed — never
     rejects, so callers can drop the promise. The display copy is made after
     the thumbnail and never changes the answer: a card is what a missing
     thumbnail costs, and that is what callers count. */
  function upload(artKey, src, sourceETag, opts) {
    artKey = clean(artKey);
    opts = opts || {};
    if (MEDIA_RE.test(artKey) && !/-bg\./.test(artKey)) {
      if (!sourceETag || !src) return Promise.resolve(false);
      // Publish waits for these variants, so the new row version never names
      // a partly-written set. Failures keep the original-image fallback.
      return load(src).then(function (img) { return uploadMedia(artKey, img, sourceETag); })
        .catch(function () { return false; });
    }
    var tKey = opts.thumb === false ? '' : thumbKey(artKey);
    var wantDisplay = opts.display !== false && !!displayKey(artKey);
    if ((!tKey && !wantDisplay) || !src) return Promise.resolve(false);
    return load(src).then(function (img) {
      var thumb = Promise.resolve(false);
      if (tKey) {
        var data = '';
        try { data = render(img); } catch (e) { /* blank: no thumbnail, as before */ }
        if (data) thumb = post(tKey, data).then(function () { return true; });
      }
      return thumb.catch(function () { return false; }).then(function (ok) {
        if (!wantDisplay) return ok;
        return uploadDisplay(artKey, img, sourceETag).then(function (shown) {
          return tKey ? ok : shown;
        }, function () { return tKey ? ok : false; });
      });
    }).catch(function () { return false; });
  }

  /* The same, reading the image back from the site (for art the browser
     never held: a server-side Bloodstar copy, or the backfill). `?v=` busts
     any cached copy so a just-replaced icon is what gets copied, and the
     response's ETag is the original the copies are bound to. */
  function uploadFromUrl(artKey, url, opts) {
    artKey = clean(artKey);
    var u = url || ((window.LINK_ROOT || '/') + 'assets/' + artKey);
    u += (u.indexOf('?') === -1 ? '?' : '&') + 'v=' + Date.now().toString(36);
    return fetch(u, { cache: 'no-store', credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('image unavailable');
      var etag = r.headers.get('ETag') || '';
      return r.blob().then(function (blob) {
        var src = URL.createObjectURL(blob);
        return upload(artKey, src, etag, opts).then(function (ok) {
          URL.revokeObjectURL(src); return ok;
        }, function () { URL.revokeObjectURL(src); return false; });
      });
    }).catch(function () { return false; });
  }

  window.ArtThumb = {
    SIZE: SIZE, thumbKey: thumbKey, displayKey: displayKey, make: make,
    upload: upload, uploadFromUrl: uploadFromUrl
  };
})();
