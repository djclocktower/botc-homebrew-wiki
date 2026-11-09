/* range-type.js: every slider on the page gets a box its number can be typed
   into. Loaded by the tool and editor pages; it finds the sliders itself,
   including ones built later (a MutationObserver), so no tool has to call it.

   A slider that already shows its value (an <output>, .if-val, .fs-slider-val
   and the rest of READOUT, in its own row) keeps that readout as the source of
   truth: the readout is hidden and a text box shows what it says, so a tool
   goes on writing "96%" or "Off" exactly as before. A slider with no readout
   gets a box showing its value.

   A typed number is set on the slider and an input and a change event are
   fired, so the tool's own listeners do the rest. When the readout's number
   is not the slider's value (Fancy Scripts shows 0.96 as 96%), the tool puts
   its formatter on the slider as `rtFmt` and the number is mapped back
   through it (all the formats are linear). Colour picker hue strips are
   skipped (SKIP); so is anything marked data-no-type. */
(function () {
  if (window.RangeType || typeof document === 'undefined') return;
  var READOUT = 'output, .if-val, .fs-slider-val, .aa-val, [data-stv], .th-state, .thx-state';
  var SKIP = '.fs-cp-hue, .bgm-hue, [data-no-type]';
  var VALUE = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');

  function num(s) {
    var m = String(s == null ? '' : s).replace(/−/g, '-').replace(/,/g, '.').match(/[-+]?\d*\.?\d+/);
    return m ? Number(m[0]) : NaN;
  }
  function attr(r, k, d) { var v = Number(r.getAttribute(k)); return isFinite(v) && r.getAttribute(k) !== null && r.getAttribute(k) !== '' ? v : d; }

  function readoutOf(r) {
    for (var p = r.parentElement, i = 0; p && i < 2; p = p.parentElement, i++) {
      if (p.querySelectorAll('input[type=range]').length > 1) return null;
      var o = p.querySelector(READOUT);
      if (o) return o;
    }
    return null;
  }

  // typed number -> slider value, through the tool's formatter when it has one
  function toValue(r, t) {
    var fmt = r.rtFmt, min = attr(r, 'min', 0), max = attr(r, 'max', 100);
    if (typeof fmt !== 'function' || max <= min) return t;
    var pts = [];
    for (var i = 0; i <= 8 && pts.length < 2; i++) {
      var v = min + (max - min) * i / 8, n;
      try { n = num(fmt(v)); } catch (e) { n = NaN; }
      if (isFinite(n) && (!pts.length || n !== pts[0][1])) pts.push([v, n]);
    }
    if (pts.length < 2) return t;
    return pts[0][0] + (t - pts[0][1]) * (pts[1][0] - pts[0][0]) / (pts[1][1] - pts[0][1]);
  }

  /* The formats round ("63" for 62.5), so the line through two samples can
     land a step off. Look at the steps around it and keep the one whose
     readout says the typed number, the nearest one on a tie. */
  function refine(r, t, v) {
    var fmt = r.rtFmt, s = Number(r.getAttribute('step'));
    if (typeof fmt !== 'function' || !(s > 0)) return v;
    var best = v, bestD = Infinity;
    for (var k = 0; k <= 60; k++) {
      for (var sign = 1; sign >= -1; sign -= 2) {
        var c = snap(r, v + sign * k * s), d;
        try { d = Math.abs(num(fmt(c)) - t); } catch (e) { d = NaN; }
        if (d < bestD - 1e-9) { best = c; bestD = d; }
        if (!k) break;
      }
    }
    return best;
  }

  function snap(r, v) {
    var min = attr(r, 'min', 0), max = attr(r, 'max', 100), step = r.getAttribute('step');
    v = Math.min(max, Math.max(min, v));
    if (step !== 'any') {
      var s = Number(step) || 1, dp = (String(s).split('.')[1] || '').length;
      v = Number((min + Math.round((v - min) / s) * s).toFixed(dp));
      if (v > max) v = Number((v - s).toFixed(dp));
    }
    return v;
  }

  function attach(r) {
    if (r.rtBox || r.matches(SKIP)) return;
    var out = readoutOf(r);
    var box = document.createElement('input');
    box.type = 'text';
    box.className = 'rt-num';
    box.autocomplete = 'off';
    box.spellcheck = false;
    box.setAttribute('inputmode', attr(r, 'min', 0) < 0 ? 'text' : 'decimal');
    box.setAttribute('aria-label', (r.getAttribute('aria-label') || 'Value') + ', type a number');
    r.rtBox = box;

    function text() { return out ? out.textContent.trim() : VALUE.get.call(r); }
    function paint() {
      if (document.activeElement === box) return;
      var t = text();
      box.value = t;
      box.size = Math.max(3, t.length);
      box.disabled = r.disabled;
    }

    if (out) {
      var cs = getComputedStyle(out);
      ['fontFamily', 'fontSize', 'fontWeight', 'color', 'letterSpacing', 'textAlign'].forEach(function (k) { box.style[k] = cs[k]; });
      out.insertAdjacentElement('afterend', box);
      out.hidden = true;
      out.style.display = 'none';
      new MutationObserver(paint).observe(out, { childList: true, characterData: true, subtree: true });
    } else {
      r.insertAdjacentElement('afterend', box);
      Object.defineProperty(r, 'value', {
        configurable: true,
        get: function () { return VALUE.get.call(this); },
        set: function (v) { VALUE.set.call(this, v); paint(); }
      });
      r.addEventListener('input', paint);
    }
    new MutationObserver(paint).observe(r, { attributes: true, attributeFilter: ['disabled'] });

    var cancel = false;
    function commit() {
      var t = num(box.value);
      if (cancel || !isFinite(t) || box.value.trim() === text()) { cancel = false; paint(); return; }
      VALUE.set.call(r, String(refine(r, t, snap(r, toValue(r, t)))));
      r.dispatchEvent(new Event('input', { bubbles: true }));
      r.dispatchEvent(new Event('change', { bubbles: true }));
      paint();
    }
    box.addEventListener('focus', function () { box.select(); });
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); box.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel = true; box.blur(); }
      e.stopPropagation(); // the tools' own shortcuts must not see typing
    });
    box.addEventListener('blur', commit);
    box.addEventListener('click', function (e) { e.stopPropagation(); });
    paint();
  }

  function scan(root) {
    if (root.nodeType !== 1) return;
    if (root.matches('input[type=range]')) attach(root);
    else root.querySelectorAll('input[type=range]').forEach(attach);
  }
  function start() {
    scan(document.body);
    new MutationObserver(function (recs) {
      recs.forEach(function (rec) { rec.addedNodes.forEach(scan); });
    }).observe(document.body, { childList: true, subtree: true });
  }
  window.RangeType = { attach: attach };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
