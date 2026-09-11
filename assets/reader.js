/* DOM enhancements shared by published pages and editor previews. */
(function () {
  /* ── The icon gallery ──────────────────────────────────────────────────
     A character can have up to four pictures: the icon, a traveller's good
     and evil tokens, and the printable token. They used to be ONE <img>
     whose `src` was rewritten on every click, and that is why the gallery
     was both slow and ugly:

       - R2 serves art `no-cache, must-revalidate`, so every switch — back
         to a picture already seen included — cost a round trip to
         revalidate before a single pixel could be painted. That is the
         half-second pause after each click, and the second the printable
         token took the first time.
       - While that request was in flight the <img> had no image to show,
         so the picture blinked out and the card's background flashed
         through it.

     So each version is now its OWN <img>, stacked one on top of another,
     and switching is a transform — no request, no repaint of anything but
     the transform, nothing to wait for. Only the version on screen carries
     a `src` in the HTML; the rest carry `data-src` and are fetched when the
     stack approaches the viewport (or the moment the reader touches it,
     whichever comes first), so the pictures nobody may look at never race
     the one everybody does.

     Nothing ever moves SIDEWAYS. A drag used to carry the pictures across
     and clip them at the edge of the stack, the way a carousel does — but a
     carousel is cut off by something a reader can see, a screen edge or the
     side of a card, and this icon floats in the middle of a parchment panel
     with no edge anywhere near it. A picture sliced off in open space does
     not read as "there is more this way", it reads as a page drawn wrong.
     So a swipe dissolves one picture into the next instead: the one leaving
     fades and shrinks a little, the one arriving grows into place, both of
     them centred and whole. The gesture still follows the finger exactly —
     how far you have dragged is how far through the change you are — and
     nothing can be cut off, because nothing ever reaches an edge. */
  var EM_SLOP = 8;      // a pointer that moved less than this was a tap
  var EM_SPAN = 0.5;    // dragging half the width is a whole change
  var EM_COMMIT = 0.5;  // ... and letting go past halfway keeps it
  var EM_FLICK = 0.35;  // ... as does letting go this fast (px per ms)
  var EM_DIP = 0.06;    // how far a picture shrinks on its way out

  function emImgs(stack) { return stack.querySelectorAll('.emblem'); }
  function emPips(stack) {
    return stack.parentNode ? stack.parentNode.querySelector('.emblem-versions') : null;
  }
  function emAt(stack) { return Number(stack.getAttribute('data-at')) || 0; }
  /* The other pictures, fetched. Called on approach and again on first touch,
     and it costs nothing the second time — every <img> it can do anything
     with loses its data-src. */
  function emHydrate(stack) {
    var imgs = stack.querySelectorAll('.emblem[data-src]');
    for (var i = 0; i < imgs.length; i++) {
      imgs[i].setAttribute('src', imgs[i].getAttribute('data-src'));
      imgs[i].removeAttribute('data-src');
    }
  }
  function hydrateEmblems(doc) {
    if (!doc) return;
    var st = doc.querySelectorAll('.emblem-stack');
    for (var i = 0; i < st.length; i++) emHydrate(st[i]);
  }
  /* Paint one moment of the gallery: version `at` on screen, version `to`
     coming in behind it, and `p` how far the change has got — 0 for "not
     started", 1 for "done". `to` is -1 when nothing is being pulled in.

     Every picture is drawn in the same place, so the whole state is how
     solid each one is; the shrink is tied to that rather than tracked
     separately, which is what keeps the two from ever disagreeing. */
  function emPaint(stack, at, to, p, animate) {
    var imgs = emImgs(stack), n = imgs.length;
    if (!n) return;
    for (var i = 0; i < n; i++) {
      var o = i === at ? 1 - p : (i === to ? p : 0);
      imgs[i].style.transition = animate ? '' : 'none';
      imgs[i].style.opacity = o;
      imgs[i].style.transform = 'scale(' + (1 - EM_DIP * (1 - o)).toFixed(4) + ')';
    }
  }
  /* Show one version — the single door, so the picture and the pips can
     never end up disagreeing about which one is on screen. */
  function emShow(stack, at, animate) {
    var imgs = emImgs(stack), n = imgs.length;
    if (!n) return;
    at = ((at % n) + n) % n;
    stack.setAttribute('data-at', at);
    emPaint(stack, at, -1, 0, animate !== false);
    for (var i = 0; i < n; i++) imgs[i].classList.toggle('is-on', i === at);
    var pips = emPips(stack);
    if (!pips) return;
    var btns = pips.querySelectorAll('.emblem-ver');
    for (var k = 0; k < btns.length; k++) {
      var on = k === at;
      btns[k].classList.toggle('is-on', on);
      btns[k].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }
  /* Wire one document's icon galleries: tap to walk through, drag or swipe
     to pull the next one across, arrow keys from the pips.

     It takes the document rather than assuming `document` because the live
     preview in the two character editors is an iframe with a document of
     its own. That copy used to be hand-duplicated inside a string in
     char-preview.js, with a comment saying it had to be changed in both
     places; the frame calls this instead. */
  function mountEmblemGallery(doc) {
    if (!doc || doc.__emblemGallery) return;
    doc.__emblemGallery = true;
    var win = doc.defaultView;

    /* Pull the other pictures in when the stack approaches the viewport — doing it up front
       would make them race the one actually on screen. Not on a metered or
       very slow connection, though: there the reader has asked us to spend
       their data on what they came for, and the first tap still fetches. */
    var conn = win && win.navigator ? (win.navigator.connection || null) : null;
    var thrifty = !!conn && (conn.saveData === true || /(^|-)2g$/.test(conn.effectiveType || ''));
    if (win && !thrifty && typeof win.IntersectionObserver === 'function') {
      var observer = new win.IntersectionObserver(function(entries) {
        entries.forEach(function(entry) { if (entry.isIntersecting) { emHydrate(entry.target); observer.unobserve(entry.target); } });
      }, { rootMargin: '100px' });
      doc.querySelectorAll('.emblem-stack').forEach(function(stack) { observer.observe(stack); });
    }

    var drag = null;
    /* A drag ends in a click too, and that click must not ALSO walk the
       gallery on. Cleared on the next pointerdown as well as on the click
       itself, so a release the click never follows cannot swallow the
       reader's next tap. */
    var swallow = false;

    function stackOf(e) {
      return e.target.closest ? e.target.closest('.emblem-stack') : null;
    }
    function endDrag(commit) {
      if (!drag) return null;
      var d = drag;
      drag = null;
      d.stack.classList.remove('is-dragging');
      /* Past halfway it sticks; short of that the picture coming in fades
         back out and the one you started on comes back. A flick counts as
         well however short it was, and has to: a thumb flicked across a
         phone is how this gesture is actually made, and it covers nowhere
         near a quarter of the icon before it lifts. */
      var flick = d.v * (d.dx < 0 ? -1 : 1) > EM_FLICK;
      var took = commit && d.to != null && (d.p >= EM_COMMIT || flick);
      emShow(d.stack, took ? d.to : d.at, true);
      return d;
    }

    doc.addEventListener('pointerdown', function (e) {
      swallow = false;
      var stack = stackOf(e);
      if (!stack || (e.button != null && e.button > 0)) return;
      if (emImgs(stack).length < 2) return;
      emHydrate(stack);   // nothing can be dragged in that has not been fetched
      drag = { stack: stack, id: e.pointerId, x: e.clientX, y: e.clientY,
               dx: 0, p: 0, v: 0, t: e.timeStamp, to: null,
               at: emAt(stack), lock: '' };
      // Capture, so a finger that leaves the picture still finishes its drag.
      try { stack.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }
    });

    doc.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      /* Which gesture is this? A drag that starts downwards is the page
         being scrolled and is none of our business — touch-action: pan-y
         means the browser is already scrolling it, so all we do is let go.
         Decided ONCE and then held, or a diagonal flick would hand the
         gesture back and forth mid-drag. */
      if (!drag.lock) {
        if (Math.abs(dx) > EM_SLOP && Math.abs(dx) > Math.abs(dy)) {
          drag.lock = 'x';
          drag.stack.classList.add('is-dragging');
        } else if (Math.abs(dy) > EM_SLOP) {
          /* Theirs, not ours. Swallow the click it may still end in, so a
             page scrolled by a finger that happened to land on the icon
             does not also change which icon that is. */
          endDrag(false);
          swallow = true;
          return;
        } else return;
      }
      // How fast it is going right now, not on average over the whole drag —
      // a slow hunt that ends in a flick is a flick.
      var ms = e.timeStamp - drag.t;
      if (ms > 0) { drag.v = (dx - drag.dx) / ms; drag.t = e.timeStamp; }
      drag.dx = dx;
      var n = emImgs(drag.stack).length;
      var span = (drag.stack.clientWidth || 1) * EM_SPAN;
      drag.p = Math.min(Math.abs(dx) / span, 1);
      drag.to = ((drag.at + (dx < 0 ? 1 : -1)) % n + n) % n;
      emPaint(drag.stack, drag.at, drag.to, drag.p, false);
    });

    doc.addEventListener('pointerup', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var moved = drag.lock === 'x' && Math.abs(drag.dx) > EM_SLOP;
      endDrag(true);
      if (moved) swallow = true;
    });
    doc.addEventListener('pointercancel', function (e) {
      if (drag && e.pointerId === drag.id) endDrag(false);
    });

    doc.addEventListener('click', function (e) {
      var pip = e.target.closest && e.target.closest('.emblem-ver');
      if (pip) {
        var group = pip.parentNode;
        var st = group.parentNode && group.parentNode.querySelector('.emblem-stack');
        if (!st) return;
        var bs = group.querySelectorAll('.emblem-ver'), idx = 0;
        for (var i = 0; i < bs.length; i++) if (bs[i] === pip) idx = i;
        emHydrate(st);
        emShow(st, idx, true);
        return;
      }
      var stack = stackOf(e);
      if (!stack || emImgs(stack).length < 2) return;
      // That click was the end of a drag, which has already had its say.
      if (swallow) { swallow = false; return; }
      emHydrate(stack);
      emShow(stack, emAt(stack) + 1, true);
    });

    // Arrow keys from the pips — they are the gallery's only tab stop.
    doc.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      var pip = e.target.closest && e.target.closest('.emblem-ver');
      if (!pip) return;
      var group = pip.parentNode;
      var st = group.parentNode && group.parentNode.querySelector('.emblem-stack');
      if (!st) return;
      e.preventDefault();
      emHydrate(st);
      var bs = group.querySelectorAll('.emblem-ver'), n = bs.length;
      if (!n) return;
      var to = ((emAt(st) + (e.key === 'ArrowRight' ? 1 : -1)) % n + n) % n;
      emShow(st, to, true);
      bs[to].focus();
    });
  }
  /* ── Fit the character title to its width ──
     Glyph widths vary too much between names for a CSS char-count formula to be
     safe (e.g. "MOON" is ~0.76/char, "ENLIGHTENED ONE" ~0.57), so measure the
     rendered text and scale the font down until the single line fits. Never
     wraps (white-space:nowrap in CSS); short names stay at the cap. */
  /* The measuring is done on a hidden copy, never on the title itself. The
     title is white-space:nowrap, so blowing it up to the cap size to measure
     made it wider than a phone screen: the document reflowed around the
     overflow and the browser dragged the reader hundreds of pixels back up the
     page — worst at the comment section, where a fast scroll and the URL bar
     retracting (which fires resize) land together. Measuring off-layout also
     makes the answer stable, because clientWidth was being read while the page
     was overflowing: the same title fitted to 50.9px one moment and 60.2px the
     next. The probe is position:fixed + hidden, so it never touches layout. */
  var fitProbe = null;
  function textWidthAt(el, px) {
    if (!fitProbe) {
      fitProbe = document.createElement('span');
      fitProbe.setAttribute('aria-hidden', 'true');
      fitProbe.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;' +
        'white-space:nowrap;pointer-events:none;';
      document.body.appendChild(fitProbe);
    }
    var cs = window.getComputedStyle(el);
    fitProbe.style.fontFamily = cs.fontFamily;
    fitProbe.style.fontWeight = cs.fontWeight;
    fitProbe.style.fontStyle = cs.fontStyle;
    fitProbe.style.letterSpacing = cs.letterSpacing;
    fitProbe.style.textTransform = cs.textTransform;
    fitProbe.style.fontSize = px + 'px';
    fitProbe.textContent = el.textContent;
    return fitProbe.getBoundingClientRect().width;
  }

  function fitCharTitle() {
    if (typeof document === 'undefined' || !document.body) return;
    var els = document.querySelectorAll('.gen-title');
    var vw = window.innerWidth || 1000;
    fitCharTitle._w = vw;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      el.style.whiteSpace = 'nowrap';
      var maxPx = vw <= 420 ? 66 : vw <= 640 ? 78 : 144;   // "large & in charge", bounded on mobile
      var avail = el.clientWidth;                            // block fills its container
      var wide = textWidthAt(el, maxPx);
      var size = (avail && wide > avail)                     // single line overflows → shrink to fit
        ? Math.max(maxPx * (avail * 0.99) / wide, 14)
        : maxPx;
      // Write only when it actually changes: an unchanged font-size is a
      // reflow the page does not need.
      var next = size.toFixed(1) + 'px';
      if (el.style.fontSize !== next) el.style.fontSize = next;
      // The probe is a copy, so trust it but verify: now that the fitted size
      // is on the real title it can be measured directly and trimmed once.
      // This only ever shrinks, so it can never blow the page out sideways.
      if (avail && el.scrollWidth > avail) {
        var exact = Math.max(size * (avail * 0.99) / el.scrollWidth, 14).toFixed(1) + 'px';
        if (el.style.fontSize !== exact) el.style.fontSize = exact;
      }
    }
    // The web font (Dumbledor2) changes glyph widths; re-fit once it loads so an
    // early measurement against the fallback font doesn't leave the title wrong.
    if (document.fonts && document.fonts.status !== 'loaded' && !fitCharTitle._waiting) {
      fitCharTitle._waiting = true;
      document.fonts.ready.then(function () { fitCharTitle._waiting = false; fitCharTitle(); });
    }
  }

  /* ── one-time delegated handlers for JSON box toggle + copy ── */
  if (typeof document !== 'undefined' && !window.__jsonBoxBound) {
    window.__jsonBoxBound = true;
    // The icon gallery keeps its own handlers — tap, drag and arrow keys are
    // one gesture set, and the live preview mounts them on its own document.
    mountEmblemGallery(document);
    document.addEventListener('click', function (e) {
      // Copy-link button
      var cl = e.target.closest && e.target.closest('.copy-link-btn');
      if (cl) {
        var url = location.href.split('#')[0];
        if (navigator.clipboard) {
          navigator.clipboard.writeText(url).then(function () {
            cl.innerHTML = '\u2713 Copied!';
            setTimeout(function () { cl.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg> Copy link'; }, 1500);
          });
        }
        return;
      }
      var tg = e.target.closest && e.target.closest('.json-bar-toggle');
      if (tg) {
        var box = tg.closest('.json-box');
        var open = box.classList.toggle('open');
        tg.setAttribute('aria-expanded', open ? 'true' : 'false');
        box.querySelector('.json-body').hidden = !open;
        return;
      }
      var jd = e.target.closest && e.target.closest('.jinx-drop-bar');
      if (jd) {
        var jbox = jd.closest('.jinx-drop');
        var jopen = jbox.classList.toggle('open');
        jd.setAttribute('aria-expanded', jopen ? 'true' : 'false');
        jbox.querySelector('.jinx-drop-body').hidden = !jopen;
        return;
      }
      var cp = e.target.closest && e.target.closest('.json-copy');
      if (cp) {
        var b = cp.closest('.json-box');
        var txt = b.querySelector('code').textContent;
        if (navigator.clipboard) {
          navigator.clipboard.writeText(txt).then(function () {
            cp.textContent = 'Copied!'; setTimeout(function () { cp.textContent = 'Copy JSON'; }, 1500);
          }, function () {
            cp.textContent = 'Copy failed'; setTimeout(function () { cp.textContent = 'Copy JSON'; }, 1500);
          });
        }
      }
    });
    // Keyboard toggle for the collapsible jinx dropdown (Enter / Space).
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      var jd = e.target.closest && e.target.closest('.jinx-drop-bar');
      if (!jd) return;
      e.preventDefault();
      var jbox = jd.closest('.jinx-drop');
      var jopen = jbox.classList.toggle('open');
      jd.setAttribute('aria-expanded', jopen ? 'true' : 'false');
      jbox.querySelector('.jinx-drop-body').hidden = !jopen;
    });
    // Re-fit the title on viewport resize / orientation change (debounced).
    // Width is the only thing the fit depends on, and on a phone every scroll
    // that hides or shows the URL bar fires resize with the width unchanged —
    // so ignore those outright rather than re-measure on every flick.
    var fitTimer;
    window.addEventListener('resize', function () {
      if (fitCharTitle._w === (window.innerWidth || 1000)) return;
      clearTimeout(fitTimer);
      fitTimer = setTimeout(fitCharTitle, 120);
    });
  }

  var api = { mountEmblemGallery: mountEmblemGallery, hydrateEmblems: hydrateEmblems, fitCharTitle: fitCharTitle };
  if (typeof window !== 'undefined') { window.Reader = api; Object.assign(window, api); }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
