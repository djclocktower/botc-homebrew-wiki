/* Stars — the reader-facing like system.

   One button, mounted into the [data-star-mount] div that render.js and
   render-page.js leave in the page header. Only runs on server-rendered
   character / script / collection pages, which are the only places
   window.PAGE_TYPE and window.PAGE_SLUG are set — so the same renderers can
   keep powering the create/edit previews without growing a Star button there.

   The mark is the same bare ✦ as Starlight (.starlight-star). They are told
   apart by the number: Starlight is a mark and never carries one, a Star is a
   button and always does.

   Counts come from the server on every toggle rather than being incremented
   locally, so two tabs (or two people) can never drift apart. The initial
   count is handed over in window.PAGE_STARS by the Worker, so the button draws
   correctly on first paint instead of flashing a zero. */
(function () {
  'use strict';

  var STARRABLE = { character: 1, collection: 1, script: 1 };

  var type = typeof window !== 'undefined' ? window.PAGE_TYPE : null;
  var slug = typeof window !== 'undefined' ? window.PAGE_SLUG : null;
  if (!type || !slug || !STARRABLE[type]) return;

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else fn();
  }

  ready(function () {
    var mount = document.querySelector('[data-star-mount]');
    if (!mount) return;

    var count = Number(window.PAGE_STARS) || 0;
    var starred = false;
    var loggedIn = false;
    var busy = false;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'star-btn';
    mount.appendChild(btn);

    function label() {
      return count === 1 ? '1 star' : count + ' stars';
    }

    function paint() {
      btn.classList.toggle('is-starred', starred);
      btn.setAttribute('aria-pressed', starred ? 'true' : 'false');
      btn.disabled = busy;
      btn.title = !loggedIn
        ? 'Log in to star this page'
        : (starred ? 'Remove your star' : 'Star this page');
      btn.innerHTML =
        '<span class="starlight-star" aria-hidden="true">✦</span>' +
        '<span class="star-btn-count">' + label() + '</span>';
    }
    paint();

    // Who has starred what, in one request for the whole account rather than
    // one per page. Logged-out readers get empty lists and a 200, so the
    // button simply stays unfilled and there is no console noise.
    fetch('/api/stars', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        loggedIn = !!(d && d.loggedIn);
        var list = d && d.starred && d.starred[type];
        if (list && list.indexOf(slug) !== -1) starred = true;
        paint();
      })
      .catch(function () { /* leave the button in its unstarred default */ });

    btn.addEventListener('click', function () {
      if (busy) return;
      busy = true; paint();
      fetch('/api/star', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ type: type, slug: slug })
      })
        .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
        .then(function (res) {
          busy = false;
          if (res.status === 401) {
            // Send them to log in and bring them straight back here.
            window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
            return;
          }
          if (!res.body || res.body.error) {
            paint();
            if (res.body && res.body.error) alert(res.body.error);
            return;
          }
          starred = !!res.body.starred;
          count = Number(res.body.stars) || 0;
          paint();
        })
        .catch(function () { busy = false; paint(); });
    });
  });
})();
