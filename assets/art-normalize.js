/* art-normalize.js — standardize character art onto a fixed square canvas.
 *
 * Character art PNGs are uploaded at wildly different sizes and, worse, with
 * wildly different amounts of transparent padding around the figure. That makes
 * the *visible* figure look huge for tightly-cropped art and tiny for art that
 * floats in a big transparent canvas (see Archlich vs Herb Doctor). This module
 * fixes that at the source: it trims the transparent margin to find the figure,
 * then scales + centers the figure to a consistent size on a standard 591x591
 * transparent canvas — matching the official wiki's icon frame.
 *
 * Browser-only (uses <canvas>). Loaded by create.html, edit.html and the admin
 * bulk tool. Deliberately NOT part of render.js (which the Worker imports and
 * must stay DOM-free).
 *
 * Exposes window.normalizeArtDataURL(src, opts) -> Promise<pngDataUrl>.
 */
(function (global) {
  'use strict';

  var TARGET = 591;          // output canvas is TARGET x TARGET px (official size)
  var FILL = 0.60;           // figure's longest side spans FILL * TARGET
  /* Why 0.60 and not more: this frame is what every consumer draws the icon
     INTO, with contain-fit, so the transparent margin IS the icon's size —
     on the wiki's cards, on the /c/ page, and above all in the official
     script tool, which prints the file it is handed at the same box size as
     its own icons. Measured (alpha bounding box, longest side / frame):
       the 191 official icons in assets/icons/ ....... median 0.63, mean 0.64
       the script tool's own bundled icons ........... median 0.61, mean 0.62
     and the tool's PDF then scales every NON-bundled image by a further
     1.1× (its "Custom Icon Size" default) — so wiki art at the old 0.70
     printed a quarter larger than the official character beside it, and
     art that was never standardized (a sixth of the live wiki, some at
     0.9+) printed at half again the size. 0.60 × 1.1 lands on the tool's
     own 0.62–0.66, and on the wiki it is within the official icons' own
     spread. Keep art-adjust.js reading ART_FILL, never a copy of it.
     ART_FILL_TOLERANCE is how far off the standard an already-square
     image may be before a re-run of the bulk tool rewrites it. */
  var FILL_TOLERANCE = 0.02;
  var CENTER_TOLERANCE = 4;  // px the figure's centre may sit off the frame's
  var ALPHA_THRESHOLD = 16;  // pixels with alpha above this count as "figure"

  // Find the bounding box of non-transparent pixels. Returns null if the image
  // is effectively empty (fully transparent).
  function alphaBBox(data, w, h) {
    var minX = w, minY = h, maxX = -1, maxY = -1;
    for (var y = 0; y < h; y++) {
      var row = y * w * 4;
      for (var x = 0; x < w; x++) {
        if (data[row + x * 4 + 3] > ALPHA_THRESHOLD) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX || maxY < minY) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  /* The figure's box inside an already-loaded <img>: the transparent margin
     trimmed away. Falls back to the whole image when the pixels can't be read
     (a tainted canvas: cross-origin art without CORS headers) or the art is
     fully transparent. Exported because art-adjust.js measures the figure the
     same way, so the hand adjuster opens on exactly what this function would
     have produced and every change there is a nudge from it. */
  function artTrimBox(img) {
    var iw = img.naturalWidth || img.width;
    var ih = img.naturalHeight || img.height;
    var whole = { x: 0, y: 0, w: iw, h: ih };
    if (!iw || !ih) return whole;
    var read = document.createElement('canvas');
    read.width = iw; read.height = ih;
    var rctx = read.getContext('2d');
    rctx.drawImage(img, 0, 0);
    try {
      return alphaBBox(rctx.getImageData(0, 0, iw, ih).data, iw, ih) || whole;
    } catch (e) {
      return whole;
    }
  }

  /* Is this image already the standard frame with the figure at the standard
     size? True only for a target×target image whose figure's longest side is
     within FILL_TOLERANCE of fill×target and whose centre sits on the frame's.
     Exported so a bulk re-run can leave standard art alone (every pass
     resamples, and every upload retires a thumbnail). */
  function isStandardFrame(iw, ih, box, target, fill) {
    if (iw !== target || ih !== target) return false;
    var side = Math.max(box.w, box.h) / target;
    if (Math.abs(side - fill) > FILL_TOLERANCE) return false;
    var cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    return Math.abs(cx - target / 2) <= CENTER_TOLERANCE && Math.abs(cy - target / 2) <= CENTER_TOLERANCE;
  }

  /* opts.ifNeeded: resolve null instead of a data URL when the image is
     already standard (see isStandardFrame). */
  function normalizeArtDataURL(src, opts) {
    opts = opts || {};
    var target = opts.target || TARGET;
    var fill = opts.fill || FILL;

    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        var iw = img.naturalWidth || img.width;
        var ih = img.naturalHeight || img.height;
        if (!iw || !ih) { reject(new Error('Image has no dimensions.')); return; }

        // Locate the figure (trim transparent padding). An unreadable or
        // fully transparent image comes back as the whole frame, contain-fit.
        var box = artTrimBox(img);
        if (opts.ifNeeded && isStandardFrame(iw, ih, box, target, fill)) { resolve(null); return; }

        // Scale so the figure's longest side spans fill * target, centered.
        var scale = (fill * target) / Math.max(box.w, box.h);
        var dw = Math.round(box.w * scale);
        var dh = Math.round(box.h * scale);
        var dx = Math.round((target - dw) / 2);
        var dy = Math.round((target - dh) / 2);

        var out = document.createElement('canvas');
        out.width = target; out.height = target;
        var octx = out.getContext('2d');
        octx.imageSmoothingEnabled = true;
        octx.imageSmoothingQuality = 'high';
        // Draw just the figure region, scaled+centered onto the square.
        octx.drawImage(img, box.x, box.y, box.w, box.h, dx, dy, dw, dh);

        try { resolve(out.toDataURL('image/png')); }
        catch (e) { reject(e); }
      };
      img.onerror = function () { reject(new Error('Could not load image for normalization.')); };
      img.src = src;
    });
  }

  global.normalizeArtDataURL = normalizeArtDataURL;
  global.artTrimBox = artTrimBox;
  global.ART_TARGET = TARGET;
  global.ART_FILL = FILL;
  global.ART_FILL_TOLERANCE = FILL_TOLERANCE;
})(typeof window !== 'undefined' ? window : this);
