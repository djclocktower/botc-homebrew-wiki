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
  var FILL = 0.70;          // figure's longest side spans FILL * TARGET
                            // (matches official wiki icons, whose figures fill
                            // ~62-74% of the 591px frame by their longest side)
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

        // Read pixels to locate the figure (trim transparent padding).
        var read = document.createElement('canvas');
        read.width = iw; read.height = ih;
        var rctx = read.getContext('2d');
        rctx.drawImage(img, 0, 0);
        var box;
        try {
          var pixels = rctx.getImageData(0, 0, iw, ih).data;
          box = alphaBBox(pixels, iw, ih);
        } catch (e) {
          // getImageData can throw on a tainted canvas (cross-origin art without
          // CORS headers). Fall back to using the whole image, contain-fit.
          box = null;
        }
        // No figure found (fully transparent or unreadable) -> use whole image.
        if (!box) box = { x: 0, y: 0, w: iw, h: ih };

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
})(typeof window !== 'undefined' ? window : this);
