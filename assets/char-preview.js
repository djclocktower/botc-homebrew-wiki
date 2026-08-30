/* char-preview.js: the live character preview on create.html + edit.html.
 *
 * The preview is an iframe carrying the wiki's own stylesheet, so what a
 * writer sees while typing is the page they will publish. It used to be
 * rebuilt by assigning `srcdoc` on every keystroke, which tears the document
 * down and loads it again: the frame went black (its own dark background,
 * with nothing painted over it yet) and flashed on every edit, and the
 * preview scroll position jumped back to the top each time.
 *
 * So the frame is written ONCE and then patched in place: only the contents
 * of <main> are replaced. No reload, no flash, no lost scroll position, and
 * the stylesheet and fonts are parsed a single time.
 *
 *   var pv = CharPreview.mount(iframeEl, {siteRoot: SITE_ROOT});
 *   pv.paint(window.renderCharacter(d, artSrc));
 *
 * Browser only. Both editors are the same form, so this is the one preview.
 */
(function (global) {
  'use strict';

  var ROOT_ID = 'cp-root';

  /* Runs INSIDE the frame. Two jobs: the little bits of interactivity a
     character page has (the JSON box, the jinx dropdown, Copy JSON), and
     fitting the title to the width the way render.js's fitCharTitle does on
     the real page. Both survive a repaint: the click handler is on the
     document, and __cpFit is called again after each one. */
  function frameScript() {
    return '<scr' + 'ipt>' +
      'document.addEventListener("click",function(e){' +
        'var t=e.target.closest&&e.target.closest(".json-bar-toggle");' +
        'if(t){var b=t.closest(".json-box");var o=b.classList.toggle("open");b.querySelector(".json-body").hidden=!o;}' +
        'var j=e.target.closest&&e.target.closest(".jinx-drop-bar");' +
        'if(j){var jb=j.closest(".jinx-drop");var jo=jb.classList.toggle("open");jb.querySelector(".jinx-drop-body").hidden=!jo;}' +
        'var c=e.target.closest&&e.target.closest(".json-copy");' +
        'if(c){var cb=c.closest(".json-box");navigator.clipboard&&navigator.clipboard.writeText(cb.querySelector("code").textContent);}' +
      '});' +
      /* The icon's other versions — a traveller's good and evil tokens, and
         the printable token. render.js binds tap, drag and the arrow keys on
         the real page's document, which is not this frame's; the frame is
         same-origin, so it mounts the same code on its own document rather
         than carrying a second copy of it in this string. Without it an
         author uploading evil art could not see it in the preview at all.
         __cpEmb runs after every repaint, because each keystroke replaces
         <main> and the new stack's other pictures arrive as data-src. The
         mount is in there too and costs nothing the second time, so a frame
         written before the parent had render.js still ends up wired. */
      'window.__cpEmb=function(){try{parent.mountEmblemGallery(document);' +
        'parent.hydrateEmblems(document);}catch(e){}};window.__cpEmb();' +
      'window.__cpFit=function(){var e=document.querySelector(".gen-title");if(!e)return;' +
        'e.style.whiteSpace="nowrap";var vw=window.innerWidth||800,m=vw<=420?66:vw<=640?78:144;' +
        'e.style.fontSize=m+"px";var a=e.clientWidth;' +
        'if(a&&e.scrollWidth>a){e.style.fontSize=Math.max(m*(a*0.99)/e.scrollWidth,14).toFixed(1)+"px";}};' +
      'window.addEventListener("resize",window.__cpFit);' +
      'if(document.fonts&&document.fonts.ready)document.fonts.ready.then(window.__cpFit);' +
      '<\/scr' + 'ipt>';
  }

  function shell(siteRoot, inner) {
    return '<!doctype html><html><head><meta charset="utf-8">' +
      '<base href="' + siteRoot + '">' +
      '<link rel="stylesheet" href="assets/styles.css">' +
      '</head><body>' +
      '<header class="topbar"><a class="brand"><img class="brand-skull" src="assets/logo_skull.png" alt="">' +
      '<span class="brand-text"><b>BOTC</b><br>HomeBrew Wiki</span>' +
      '<img class="topbar-badge" src="assets/ccc-parchment.png" alt=""></a></header>' +
      '<main class="wrap" id="' + ROOT_ID + '">' + (inner || '') + '</main>' +
      frameScript() + '</body></html>';
  }

  function mount(frame, opts) {
    opts = opts || {};
    var siteRoot = opts.siteRoot || '';
    var ready = false;
    var pending = null;
    var booted = false;

    function root() {
      // srcdoc frames are same-origin, so this is readable. If a browser ever
      // disagrees, paint() falls back to rewriting the whole document.
      try {
        var doc = frame.contentDocument;
        return doc ? doc.getElementById(ROOT_ID) : null;
      } catch (e) { return null; }
    }

    function paint(inner) {
      if (ready) {
        var el = root();
        if (el) {
          el.innerHTML = inner;
          try { if (frame.contentWindow.__cpFit) frame.contentWindow.__cpFit(); } catch (e) { /* fine */ }
          try { if (frame.contentWindow.__cpEmb) frame.contentWindow.__cpEmb(); } catch (e) { /* fine */ }
          return;
        }
        // Unreadable frame: the old way, flash and all, but never no preview.
        frame.srcdoc = shell(siteRoot, inner);
        return;
      }
      pending = inner;
      if (booted) return;
      booted = true;
      frame.addEventListener('load', function () {
        ready = true;
        if (pending != null) { var p = pending; pending = null; paint(p); }
      });
      // The first write carries the content, so the frame is never shown empty.
      frame.srcdoc = shell(siteRoot, inner);
      pending = null;
    }

    return { paint: paint };
  }

  global.CharPreview = { mount: mount };
})(typeof window !== 'undefined' ? window : this);
