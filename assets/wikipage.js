/* Client-side enhancements for the custom wiki pages (/p/{slug}).
   The Worker sets window.WIKI_PAGE_SLUG before loading this. Like the other
   SSR pages, the Edit button is shown unconditionally — the server enforces
   ownership on every write. */
(function () {
  var ROOT = (typeof window !== 'undefined' && window.LINK_ROOT) || '';
  var SLUG = window.WIKI_PAGE_SLUG || '';

  var editBtn = document.getElementById('edit-btn');
  if (editBtn && SLUG) {
    editBtn.href = ROOT + 'publish-page?p=' + encodeURIComponent(SLUG);
    editBtn.style.display = '';
  }

  /* Admins: put this page on (or take it off) Featured Articles, the cards
     under News on the homepage and on /news. It is the one list these pages
     can appear on, so the button is an admin's and nobody else ever sees it.
     Drawn in the browser, never by the server: the published HTML is one
     shared cache entry for every reader. site.js sets botcMePromise and loads
     after this file, hence DOMContentLoaded. A draft cannot be featured. */
  function featureButton(me) {
    if (!me || !me.isAdmin) return;
    var head = document.querySelector('.wiki-page-head');
    if (!head || head.querySelector('.wiki-feature')) return;
    fetch('/api/featured-articles?all=1', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function (d) {
        var on = ((d && d.articles) || []).some(function (a) { return a.slug === SLUG; });
        var wrap = document.createElement('p');
        wrap.className = 'wiki-feature';
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wiki-feature-btn';
        function paint() {
          btn.textContent = on ? '★ In Featured Articles · remove' : '☆ Add to Featured Articles';
          btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        paint();
        btn.addEventListener('click', function () {
          btn.disabled = true;
          fetch('/api/admin/featured-article', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slug: SLUG, on: !on })
          }).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (res) {
              if (!r.ok) throw new Error(res.error || 'That did not save. Try again.');
              on = !!res.featured;
              paint();
            });
          }).catch(function (err) { alert(err.message); })
            .then(function () { btn.disabled = false; });
        });
        wrap.appendChild(btn);
        head.appendChild(wrap);
      })
      .catch(function () { /* offline or not an admin after all: no button */ });
  }
  if (SLUG && !window.WIKI_PAGE_DRAFT) {
    var whenMe = function () {
      if (window.botcMePromise) window.botcMePromise.then(featureButton).catch(function () {});
    };
    if (window.botcMePromise) whenMe();
    else document.addEventListener('DOMContentLoaded', whenMe);
  }

  /* Smooth-scroll the contents box, and keep the heading clear of the topbar. */
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('.wiki-toc a, .sec-anchor');
    if (!a) return;
    var id = (a.getAttribute('href') || '').replace(/^#/, '');
    var target = id && document.getElementById(id);
    if (!target) return;
    e.preventDefault();
    var y = target.getBoundingClientRect().top + window.pageYOffset - 70;
    window.scrollTo({ top: y, behavior: 'smooth' });
    if (history.replaceState) history.replaceState(null, '', '#' + id);
  });

  /* Landing on a #anchor: same offset, once the page has laid out. */
  if (location.hash.length > 1) {
    window.addEventListener('load', function () {
      var target = document.getElementById(location.hash.slice(1));
      if (!target) return;
      window.scrollTo(0, target.getBoundingClientRect().top + window.pageYOffset - 70);
    });
  }
})();
