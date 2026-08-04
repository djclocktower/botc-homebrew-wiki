/* News article renderer.

   The text formatting itself lives in assets/render-wiki.js — the single
   engine shared by news articles, the custom wiki pages (/p/{slug}) and the
   site-wide announcement banner. This file is the article-shaped wrapper
   around it: the head block, hero image, side boxes and list cards.

   Everything an admin types is escaped first and only a whitelisted set of
   marks becomes markup (see render-wiki.js for the full list), so an article
   can never inject HTML into a page other people read.

   inlineFormat() is re-exported because assets/site.js uses it for links in
   the announcement banner; it simply forwards to the shared engine.

   Browser + Worker, like render.js — no DOM at module top level. In the
   browser load assets/render-wiki.js first; the Worker passes it in through
   init(). */
(function () {
  'use strict';

  var wiki = null;
  function init(w) { wiki = w || null; }
  function W() {
    if (wiki) return wiki;
    if (typeof window !== 'undefined' && window.WikiRender) return window.WikiRender;
    return null;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* Every one of these forwards to the shared engine. If it somehow isn't
     loaded the text is escaped rather than dropped — never rendered raw. */
  function safeHref(raw) { var w = W(); return w ? w.safeHref(raw) : ''; }
  function inlineFormat(text, opts) { var w = W(); return w ? w.inlineFormat(text, opts) : esc(text); }
  function renderBody(text, opts) { var w = W(); return w ? w.renderBody(text, opts) : '<p>' + esc(text) + '</p>'; }
  function autoSummary(text, max) {
    var w = W();
    if (w) return w.autoSummary(text, max);
    var flat = String(text || '').replace(/\s+/g, ' ').trim();
    var n = max || 200;
    return flat.length > n ? flat.slice(0, n - 1) + '…' : flat;
  }
  function formatDate(ts) {
    var w = W();
    if (w) return w.formatDate(ts);
    return ts ? String(ts).slice(0, 10) : '';
  }

  /* The article page body (everything inside <main>). `linkRoot` is '' on the
     static index page and '../' on the server-rendered /news/{slug} page. */
  function renderArticle(a, opts) {
    opts = opts || {};
    var root = opts.linkRoot || '';
    var w = W();
    var hero = a.image
      ? '<img class="news-hero" src="' + esc(/^https?:\/\//i.test(a.image) ? a.image : root + 'assets/' + a.image) +
        '" alt="" loading="lazy" decoding="async">'
      : '';

    var body = renderBody(a.body, { linkRoot: root, toc: a.toc ? 'auto' : false });
    // Optional side boxes — the same {title, content} widget the character,
    // script and collection editors use.
    var side = w ? (w.renderInfobox(a.infobox, { linkRoot: root }) +
                    w.renderBoxes(a.boxes, { linkRoot: root })) : '';
    var main = side
      ? '<div class="wiki-layout"><div class="wiki-body news-body">' + body + '</div>' +
        '<aside class="wiki-side">' + side + '</aside></div>'
      : '<div class="news-body">' + body + '</div>';

    return '<article class="news-article">' +
      '<div class="news-article-head">' +
        '<div class="news-meta">' + esc(formatDate(a.publishedAt || a.updatedAt)) +
          (a.author ? ' &middot; ' + esc(a.author) : '') +
          (opts.isDraft ? ' &middot; DRAFT' : '') +
        '</div>' +
        '<h1>' + esc(a.title || 'Untitled') + '</h1>' +
        (a.summary ? '<p class="news-card-summary">' + esc(a.summary) + '</p>' : '') +
      '</div>' +
      hero +
      main +
    '</article>';
  }

  /* One card in the /news list and the homepage panel. */
  function renderCard(a, opts) {
    opts = opts || {};
    var root = opts.linkRoot || '';
    var summary = a.summary || autoSummary(a.body, 160);
    return '<a class="news-card" href="' + root + 'news/' + encodeURIComponent(a.slug) + '">' +
      '<div class="news-card-date">' + esc(formatDate(a.publishedAt || a.updatedAt)) + '</div>' +
      '<h3 class="news-card-title">' + esc(a.title || 'Untitled') + '</h3>' +
      (summary ? '<p class="news-card-summary">' + esc(summary) + '</p>' : '') +
      '<span class="news-card-more">Read more →</span>' +
    '</a>';
  }

  var API = {
    init: init,
    esc: esc, safeHref: safeHref, inlineFormat: inlineFormat,
    renderBody: renderBody, renderArticle: renderArticle, renderCard: renderCard,
    autoSummary: autoSummary, formatDate: formatDate
  };

  if (typeof window !== 'undefined') window.NewsRender = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
