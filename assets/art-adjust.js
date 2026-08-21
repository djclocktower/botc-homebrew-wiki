/* art-adjust.js: place a character icon inside the 591x591 frame by hand.
 *
 * "Resize icon" (art-normalize.js) trims the transparent margin and scales the
 * figure to a fixed 70% of the frame. That is the right answer most of the
 * time and the wrong one whenever the art is not a single tidy figure (a
 * signature in a corner, a wisp of smoke, a stray pixel), because the trim
 * measures all of it and the character ends up small. This is the manual way
 * out: drag the art where you want it, set how much of the token it fills,
 * rotate it if the scan was crooked, and take the result.
 *
 * It starts from the automatic answer, so the adjuster opens on exactly what
 * the Resize button would have produced and everything is a nudge from there.
 *
 *   ArtAdjust.open(src, {title})  ->  Promise<pngDataUrl | null>
 *
 * Resolves with a 591x591 transparent PNG, or null when cancelled. Rejects
 * only when the image can't be loaded or can't be read back out of the canvas
 * (art hosted on another site without CORS headers taints it; the caller
 * shows that message and the writer uploads the file instead).
 *
 * Browser-only. Loaded by create.html and edit.html, which are the same form
 * twice over, so wire anything here into both. Needs art-normalize.js first
 * (artTrimBox); without it the whole image counts as the figure, which is
 * still a usable starting point.
 *
 * Styles live in styles.css under .aa-*; this file only builds the DOM.
 */
(function (global) {
  'use strict';

  var TARGET = 591;   // output canvas, the official icon size
  var FILL = 0.70;    // the standard: figure spans 70% of the frame
  var MIN_FILL = 15;  // slider range, in percent of the frame
  var MAX_FILL = 130;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('Could not load that image.')); };
      img.src = src;
    });
  }

  function open(src, opts) {
    opts = opts || {};
    return loadImage(src).then(function (img) {
      return new Promise(function (resolve, reject) {
        var iw = img.naturalWidth || img.width;
        var ih = img.naturalHeight || img.height;
        if (!iw || !ih) { reject(new Error('That image has no size.')); return; }

        var box = (global.artTrimBox && global.artTrimBox(img)) || { x: 0, y: 0, w: iw, h: ih };
        if (!box.w || !box.h) box = { x: 0, y: 0, w: iw, h: ih };
        // The scale at which the figure fills FILL of the frame. The whole
        // adjustment is expressed relative to it, so "100%" on the slider is
        // the wiki's house size rather than some property of this one file.
        var fitScale = (FILL * TARGET) / Math.max(box.w, box.h);
        var figX = box.x + box.w / 2;   // the figure's centre, in image pixels
        var figY = box.y + box.h / 2;

        // State: where the figure's centre sits in the frame, how much of the
        // frame it fills, and its rotation. Scaling and rotating both happen
        // about that centre, so the art turns and grows in place instead of
        // swinging off the canvas.
        var st = { x: TARGET / 2, y: TARGET / 2, fill: FILL * 100, rot: 0 };

        /* ── DOM ── */
        var back = el('div', 'aa-backdrop');
        back.setAttribute('role', 'dialog');
        back.setAttribute('aria-modal', 'true');
        back.setAttribute('aria-label', opts.title || 'Adjust icon');
        var panel = el('div', 'aa-panel');
        panel.appendChild(el('h2', 'aa-title', opts.title || 'Adjust icon'));
        panel.appendChild(el('p', 'aa-hint',
          'Drag the art to move it. The circle is the token edge; the dashed ring is the size most icons on the wiki are.'));

        var stage = el('div', 'aa-stage');
        var canvas = el('canvas', 'aa-canvas');
        canvas.width = TARGET; canvas.height = TARGET;
        var ctx = canvas.getContext('2d');
        var guides = el('div', 'aa-guides');
        guides.setAttribute('aria-hidden', 'true');
        guides.appendChild(el('span', 'aa-guide-token'));
        guides.appendChild(el('span', 'aa-guide-fill'));
        stage.appendChild(canvas);
        stage.appendChild(guides);
        panel.appendChild(stage);

        function slider(label, min, max, value, suffix) {
          var row = el('div', 'aa-row');
          var lab = el('label', 'aa-lab');
          var val = el('b', 'aa-val', value + suffix);
          lab.appendChild(document.createTextNode(label + ' '));
          lab.appendChild(val);
          var input = document.createElement('input');
          input.type = 'range'; input.className = 'aa-range';
          input.min = min; input.max = max; input.step = 1; input.value = value;
          input.setAttribute('aria-label', label);
          lab.setAttribute('for', input.id = 'aa-' + label.toLowerCase().replace(/[^a-z]+/g, ''));
          row.appendChild(lab); row.appendChild(input);
          return { row: row, input: input, val: val };
        }

        var size = slider('Size on the token', MIN_FILL, MAX_FILL, Math.round(st.fill), '%');
        var rot = slider('Rotate', -180, 180, 0, '°');
        var controls = el('div', 'aa-controls');
        controls.appendChild(size.row);
        controls.appendChild(rot.row);
        var reset = el('button', 'aa-mini', '↺ Start over');
        reset.type = 'button';
        var btnRow = el('div', 'aa-btns');
        btnRow.appendChild(reset);
        controls.appendChild(btnRow);
        panel.appendChild(controls);

        var actions = el('div', 'aa-actions');
        var cancel = el('button', 'aa-btn aa-cancel', 'Cancel');
        cancel.type = 'button';
        var ok = el('button', 'aa-btn aa-ok', 'Use this icon');
        ok.type = 'button';
        actions.appendChild(cancel);
        actions.appendChild(ok);
        panel.appendChild(actions);
        back.appendChild(panel);

        /* ── drawing ──
           Only the art is ever drawn on the canvas: the checkerboard is the
           canvas's own CSS background and the guides are an overlay, so what
           is exported is the transparent PNG and nothing else. */
        function draw() {
          ctx.clearRect(0, 0, TARGET, TARGET);
          ctx.save();
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          var s = fitScale * (st.fill / (FILL * 100));
          ctx.translate(st.x, st.y);
          if (st.rot) ctx.rotate(st.rot * Math.PI / 180);
          ctx.scale(s, s);
          ctx.translate(-figX, -figY);
          ctx.drawImage(img, 0, 0);
          ctx.restore();
        }

        size.input.addEventListener('input', function () {
          st.fill = Number(size.input.value) || MIN_FILL;
          size.val.textContent = Math.round(st.fill) + '%';
          draw();
        });
        rot.input.addEventListener('input', function () {
          st.rot = Number(rot.input.value) || 0;
          rot.val.textContent = Math.round(st.rot) + '°';
          draw();
        });
        reset.addEventListener('click', function () {
          st.x = TARGET / 2; st.y = TARGET / 2; st.fill = FILL * 100; st.rot = 0;
          size.input.value = Math.round(st.fill); size.val.textContent = Math.round(st.fill) + '%';
          rot.input.value = 0; rot.val.textContent = '0°';
          draw();
        });

        /* ── dragging and pinching ──
           The canvas is 591 px of art shown at whatever width the screen
           allows, so every pointer distance is converted through that ratio:
           otherwise a drag on a phone would move the art half as far as the
           finger. Pointer events cover mouse, pen and touch in one path;
           touch-action:none on the stage stops the browser scrolling the page
           out from under a drag. */
        var pointers = {};       // id -> {x, y}
        var pinchStart = 0;      // finger distance when the pinch began
        var pinchFill = 0;       // st.fill when the pinch began

        function ratio() {
          var r = stage.getBoundingClientRect();
          return r.width ? TARGET / r.width : 1;
        }
        function ids() { return Object.keys(pointers); }
        function spread() {
          var k = ids();
          if (k.length < 2) return 0;
          var a = pointers[k[0]], b = pointers[k[1]];
          return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2));
        }
        function setFill(v) {
          st.fill = Math.max(MIN_FILL, Math.min(MAX_FILL, v));
          size.input.value = Math.round(st.fill);
          size.val.textContent = Math.round(st.fill) + '%';
        }

        stage.addEventListener('pointerdown', function (e) {
          pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
          if (ids().length === 2) { pinchStart = spread(); pinchFill = st.fill; }
          if (stage.setPointerCapture) { try { stage.setPointerCapture(e.pointerId); } catch (err) { /* fine */ } }
          stage.classList.add('aa-dragging');
          e.preventDefault();
        });
        stage.addEventListener('pointermove', function (e) {
          var prev = pointers[e.pointerId];
          if (!prev) return;
          var k = ratio();
          if (ids().length >= 2) {
            pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
            var now = spread();
            if (pinchStart > 8 && now > 8) setFill(pinchFill * (now / pinchStart));
          } else {
            st.x += (e.clientX - prev.x) * k;
            st.y += (e.clientY - prev.y) * k;
            pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
          }
          draw();
          e.preventDefault();
        });
        function endPointer(e) {
          delete pointers[e.pointerId];
          if (ids().length < 2) { pinchStart = 0; }
          if (!ids().length) stage.classList.remove('aa-dragging');
        }
        stage.addEventListener('pointerup', endPointer);
        stage.addEventListener('pointercancel', endPointer);
        stage.addEventListener('wheel', function (e) {
          setFill(st.fill * (e.deltaY < 0 ? 1.06 : 1 / 1.06));
          draw();
          e.preventDefault();
        }, { passive: false });

        /* ── finish ── */
        var done = false;
        function close(value, err) {
          if (done) return;
          done = true;
          document.removeEventListener('keydown', onKey, true);
          if (back.parentNode) back.parentNode.removeChild(back);
          if (err) reject(err); else resolve(value);
        }
        function onKey(e) {
          if (e.key === 'Escape') { e.stopPropagation(); close(null); }
        }
        document.addEventListener('keydown', onKey, true);
        cancel.addEventListener('click', function () { close(null); });
        back.addEventListener('click', function (e) { if (e.target === back) close(null); });
        ok.addEventListener('click', function () {
          var out;
          try { out = canvas.toDataURL('image/png'); }
          catch (e) {
            close(null, new Error('This art is hosted on another site, so the browser will not let it be edited here. Save the file and upload it instead.'));
            return;
          }
          close(out);
        });

        document.body.appendChild(back);
        draw();
        ok.focus();
      });
    });
  }

  global.ArtAdjust = { open: open, TARGET: TARGET, FILL: FILL };
})(typeof window !== 'undefined' ? window : this);
