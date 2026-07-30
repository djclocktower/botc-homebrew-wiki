/* News article renderer + the tiny text formatter shared with the
   announcement banner.

   Admins write articles in a plain textarea. Rather than accept HTML (which
   would be an XSS hole on a page anyone can read) the text is escaped first
   and then a deliberately small set of marks is turned back into markup:

     ## Heading          -> <h2>
     - item              -> <ul><li>
     blank line          -> new paragraph
     [label](https://…)  -> <a>
     **bold**            -> <strong>
     *italic*            -> <em>

   Link targets are whitelisted to http(s), mailto and site-relative paths,
   so `javascript:` and `data:` URLs can never survive. inlineFormat() is
   exported on its own because assets/site.js uses it to allow text links in
   the site-wide announcement banner.

   Browser + Worker, like render.js — no DOM at module top level. */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* Only these can ever come out the other side of a [label](href). */
  function safeHref(raw) {
    var href = String(raw || '').trim();
    if (!href) return '';
    if (/^https?:\/\//i.test(href)) return href;
    if (/^mailto:[^\s<>]+@[^\s<>]+$/i.test(href)) return href;
    // '//evil.example' is protocol-relative, i.e. off-site in disguise.
    if (href.indexOf('//') === 0) return '';
    // Site-relative: '/scripts', 'c/slug', '#sec-x'. Reject anything with a
    // scheme (a colon before the first slash) — that's how javascript: hides.
    if (/^[#/]/.test(href) || !/^[a-z0-9+.-]*:/i.test(href)) return href;
    return '';
  }

  /* Inline marks inside one already-escaped line. */
  function inlineFormat(text) {
    var out = esc(text);
    // [label](href) — label is plain text, href is whitelisted.
    out = out.replace(/\[([^\]\n]{1,120})\]\(([^)\s]{1,500})\)/g, function (m, label, href) {
      // esc() already ran, so &amp; inside a URL has to be put back.
      var url = safeHref(href.replace(/&amp;/g, '&'));
      if (!url) return label;
      var external = /^https?:\/\//i.test(url);
      return '<a href="' + esc(url) + '"' +
        (external ? ' target="_blank" rel="noopener noreferrer"' : '') +
        '>' + label + '</a>';
    });
    out = out.replace(/\*\*([^*\n]{1,200})\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]{1,200})\*(?!\*)/g, '$1<em>$2</em>');
    return out;
  }

  /* Full article body: blocks separated by blank lines. */
  function renderBody(text) {
    var blocks = String(text || '').replace(/\r\n/g, '\n').split(/\n{2,}/);
    var html = '';
    blocks.forEach(function (block) {
      var lines = block.split('\n').filter(function (l) { return l.trim() !== ''; });
      if (!lines.length) return;
      // A block of "- " lines becomes one list.
      if (lines.every(function (l) { return /^\s*[-*]\s+/.test(l); })) {
        html += '<ul>' + lines.map(function (l) {
          return '<li>' + inlineFormat(l.replace(/^\s*[-*]\s+/, '')) + '</li>';
        }).join('') + '</ul>';
        return;
      }
      // Headings stand alone; anything else in the block follows as a paragraph.
      var paraLines = [];
      lines.forEach(function (l) {
        var h = l.match(/^\s*##\s+(.+)$/);
        if (h) {
          if (paraLines.length) { html += '<p>' + paraLines.join('<br>') + '</p>'; paraLines = []; }
          html += '<h2>' + inlineFormat(h[1]) + '</h2>';
        } else {
          paraLines.push(inlineFormat(l));
        }
      });
      if (paraLines.length) html += '<p>' + paraLines.join('<br>') + '</p>';
    });
    return html;
  }

  /* First ~200 characters of the body, marks stripped — used for the card
     summary and the meta description when the author didn't write one. */
  function autoSummary(text, max) {
    var flat = String(text || '')
      .replace(/\r\n/g, '\n')
      .replace(/^\s*##\s+/gm, '')
      .replace(/^\s*[-*]\s+/gm, '')
      .replace(/\[([^\]\n]*)\]\([^)\s]*\)/g, '$1')
      .replace(/\*\*?/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    var n = max || 200;
    return flat.length > n ? flat.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : flat;
  }

  function formatDate(ts) {
    if (!ts) return '';
    var d = new Date(String(ts).replace(' ', 'T') + (/[Z+]/.test(String(ts)) ? '' : 'Z'));
    if (isNaN(d)) return String(ts).slice(0, 10);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  /* The article page body (everything inside <main>). `linkRoot` is '' on the
     static index page and '../' on the server-rendered /news/{slug} page. */
  function renderArticle(a, opts) {
    opts = opts || {};
    var root = opts.linkRoot || '';
    var hero = a.image
      ? '<img class="news-hero" src="' + esc(/^https?:\/\//i.test(a.image) ? a.image : root + 'assets/' + a.image) +
        '" alt="" loading="lazy" decoding="async">'
      : '';
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
      '<div class="news-body">' + renderBody(a.body) + '</div>' +
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
    esc: esc, safeHref: safeHref, inlineFormat: inlineFormat,
    renderBody: renderBody, renderArticle: renderArticle, renderCard: renderCard,
    autoSummary: autoSummary, formatDate: formatDate
  };

  if (typeof window !== 'undefined') window.NewsRender = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
