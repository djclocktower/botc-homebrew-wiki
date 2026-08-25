/* Wiki text renderer — the shared engine behind the text-first pages
   (/p/{slug}), the news articles and the site-wide announcement banner.

   Everything a writer types is PLAIN TEXT. It is escaped first and then a
   deliberately small, whitelisted set of marks is turned back into markup, so
   nothing anyone writes can ever become raw HTML on a page other people read.

   Block marks (one per line, blank line separates blocks):

     # / ## / ### / #### Heading   headings (anchored, feed the contents box)
     - item  /  * item             bullet list
     1. item                       numbered list
     > quoted line                 pull quote
     ---                           horizontal rule
     [toc]                         insert the table of contents here
     | a | b |                     table (an all-dashes row marks the header)
     ![caption](image.png|right)   image — |left |right |wide are optional
     ::: note Title                callout box (note/tip/warning/example/lore)
     …text…
     :::

   Inline marks:

     **bold**   *italic*   `code`   ~~strike~~
     [label](https://…)            link (href whitelisted, see safeHref; a
                                   bare 'example.com' becomes https, and
                                   '/c/imp' stays inside the wiki)
     [[Character Name]]            one of the game's OWN characters links to
                                   the official wiki; otherwise this wiki's
                                   page for it; otherwise a reminder token
                                   pill — the [[TOKEN]] convention character
                                   pages already used.
     [[Character Name|as written]] same, with your own label.
     {{blue|Undertaker}}           the name in the good team's blue
     {{red|Imp}}                   the name in the evil team's red
                                   ({{good|…}} and {{evil|…}} are the same two)

   The marks combine, and the colour mark is applied last precisely so that
   they can: {{red|[[Imp]]}} is a red link to the Imp, {{blue|[a rule](url)}}
   is a blue one to anywhere. A link inside a colour takes the colour (see
   `.wiki-red a` in styles.css) rather than the link colour.

   opts.marks === 'links' asks for a deliberately small part of that set —
   links, [[character links]] and the colour marks, and nothing a writer
   could type by accident. It is what a CHARACTER page's prose is rendered
   with (see assets/render.js): the official "Each night*" convention puts a
   lone asterisk through a great deal of that text, and two of them on one
   line would otherwise italicise everything in between.

   Browser + Worker, like render.js and render-page.js: no DOM access at
   module top level. The Worker imports it for SSR; the editors load it in the
   browser so the live preview is byte-identical to the published page. */
(function () {
  'use strict';

  /* Character-name -> slug map, so [[Snake Charmer]] can become a real link.
     The Worker fills it per render from D1; the editors fill it from
     characters.json. Unknown names fall back to a reminder-token pill. */
  var charLinks = {};
  function setCharLinks(map) { charLinks = map || {}; }
  function normName(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }

  /* The official roster, keyed the same way, so [[Imp]] goes to the official
     wiki rather than to a homebrew page that happens to share the name.

     Official deliberately beats this wiki, which is the same order and the
     same reasoning as resolveJinxTarget() in render.js (see gotcha 8 in
     CLAUDE.md): there is more than one homebrew "Sculptor", and a writer who
     types a familiar name almost always means the character the whole game
     knows. A page here whose name matches an official one is by definition
     NOT that character — an exact match is refused on save and retired
     retroactively — so linking it as though it were would be wrong twice.
     Somebody who does mean a particular homebrew page can always name it
     outright with [label](/c/slug).

     Fed by Render.setOfficialNames() in the browser and by the Worker's
     officialNameMap() for SSR — one map, whichever way round. Unset, nothing
     resolves as official and [[Name]] behaves as it did. */
  var officialNames = {};
  function setOfficialNames(map) {
    officialNames = {};
    if (!map) return;
    for (var k in map) {
      if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
      var n = map[k];
      if (typeof n !== 'string' || !n) continue;
      // Both the key (an id like `plaguedoctor`) and the display name, so a
      // writer reaches it typing either.
      officialNames[normName(k)] = n;
      officialNames[normName(n)] = n;
    }
  }
  function officialWikiHref(name) {
    return 'https://wiki.bloodontheclocktower.com/' +
      String(name).trim().replace(/\s+/g, '_');
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function kebab(s) {
    return String(s || '').toLowerCase().normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  }

  /* Placeholders use NUL, which a <textarea> cannot produce, so they can
     never collide with something the writer actually typed. */
  var CODE_MARK = '\u0000c';
  var TOC_MARK = '\u0000toc\u0000';

  /* A bare domain typed without a scheme: 'example.com',
     'wiki.bloodontheclocktower.com/Imp', 'www.example.co.uk?x=1'. These used
     to become a site-relative link to a page that does not exist, so
     [text](example.com) looked broken. Deliberately narrow: the host must be
     dotted labels ending in a letters-only suffix that is not a file
     extension, so 'scripts', 'c/slug' and 'page.html' stay site-relative. */
  var FILE_EXT = /^(html?|json|php|aspx?|jpe?g|png|gif|webp|svg|js|css|txt|md|pdf|zip|xml|csv)$/i;
  function bareDomain(href) {
    var host = href.split(/[/?#]/)[0];
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)) return '';
    var tld = host.slice(host.lastIndexOf('.') + 1);
    if (!/^[a-z]{2,24}$/i.test(tld) || FILE_EXT.test(tld)) return '';
    return 'https://' + href;
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
    if (/^[#/]/.test(href)) return href;
    if (/^[a-z0-9+.-]*:/i.test(href)) return '';
    // No scheme and not rooted: an unschemed domain becomes https, anything
    // else stays a link relative to the site.
    return bareDomain(href) || href;
  }

  /* Image sources are tighter than links: a remote https image, or one of the
     wiki's own asset folders. Anything else is dropped.
     Keep this list in step with R2_SERVE_PREFIXES in worker/worker.js — a
     folder the site uploads into but doesn't list here goes to R2 fine and
     then renders as nothing, which is how news images were invisible. */
  var IMG_PATH_RE = /^(pages|news|art|scripts|collections|icons|tokens)\/[a-z0-9._ /-]+\.(png|jpe?g|webp|gif|svg)$/i;
  function safeImg(raw, root) {
    var src = String(raw || '').trim();
    if (!src) return '';
    if (/^https:\/\//i.test(src)) return src;
    src = src.replace(/^\/?assets\//, '');
    if (IMG_PATH_RE.test(src)) return (root || '') + 'assets/' + src;
    return '';
  }

  /* ── the colour marks ──
     {{blue|Undertaker}} / {{red|Imp}}, and the same two under the names the
     game gives them ({{good|…}} / {{evil|…}}). Writers colour the character
     names inside an example the way the official almanac does, and the
     alternative — asking them for a <span> — is the one thing this engine
     exists to make impossible.

     The body may not contain a brace, so the mark cannot swallow the rest of
     a paragraph when somebody forgets to close it. It is applied AFTER the
     link marks, so a coloured link and a linked colour both work. */
  var COLOR_CLASS = {
    red: 'wiki-red', evil: 'wiki-red', blue: 'wiki-blue', good: 'wiki-blue'
  };
  var COLOR_RE = /\{\{(red|blue|good|evil)\|([^{}\n]{1,300})\}\}/gi;

  /* ── inline marks ──────────────────────────────────────────────
     Order matters: code spans are pulled out first so their contents are
     never re-formatted, then links (whose labels are plain text), then the
     colour marks, then the symmetrical marks.

     opts.marks === 'links' stops after the colour marks — see the header. */
  function inlineFormat(text, opts) {
    opts = opts || {};
    var root = opts.linkRoot || '';
    var linksOnly = opts.marks === 'links';
    var out = esc(text);

    // `code` — stashed behind a placeholder so **bold** inside it stays literal
    var codes = [];
    if (!linksOnly) {
      out = out.replace(/`([^`\n]{1,300})`/g, function (m, code) {
        codes.push('<code class="wiki-code">' + code + '</code>');
        return CODE_MARK + (codes.length - 1) + '\u0000';
      });

      // ![caption](src) inline — only reached when an image is not on its own
      // line; block images are handled in renderBody.
      out = out.replace(/!\[([^\]\n]{0,160})\]\(([^)\s|]{1,400})(\|(?:left|right|wide))?\)/g,
        function (m, alt, src) {
          var url = safeImg(src.replace(/&amp;/g, '&'), root);
          if (!url) return alt;
          return '<img class="wiki-inline-img" src="' + esc(url) + '" alt="' + alt + '" loading="lazy" decoding="async">';
        });
    }

    // [label](href)
    out = out.replace(/\[([^\]\n]{1,160})\]\(([^)\s]{1,500})\)/g, function (m, label, href) {
      // esc() already ran, so &amp; inside a URL has to be put back.
      var url = safeHref(href.replace(/&amp;/g, '&'));
      if (!url) return label;
      var external = /^https?:\/\//i.test(url);
      // A site-relative link somebody typed without a leading slash ('c/slug',
      // 'scripts') means a place on the wiki, not a place under whatever
      // directory this page happens to sit in — so it takes the same root
      // prefix every other link here does. Without it a typed link worked on a
      // top-level page and pointed into nowhere from /c/{set}/{character},
      // /s/, /p/ and /news/.
      if (!external && !/^[#/]/.test(url) && !/^mailto:/i.test(url)) url = root + url;
      return '<a href="' + esc(url) + '"' +
        (external ? ' target="_blank" rel="noopener noreferrer"' : '') +
        '>' + label + '</a>';
    });

    // [[Character Name]] / [[Character Name|label]] — the official wiki if it
    // is one of the game's own characters (see setOfficialNames above), then
    // this wiki's page if it has one, and otherwise the reminder-token pill
    // that [[TOKEN]] has always rendered as.
    out = out.replace(/\[\[([^\]|\n]{1,80})(?:\|([^\]\n]{1,80}))?\]\]/g, function (m, target, label) {
      var key = normName(target);
      var shown = (label != null && label !== '') ? label : target;
      var official = officialNames[key];
      if (official) {
        return '<a class="wiki-charlink wiki-charlink-off" href="' +
          esc(officialWikiHref(official)) + '" target="_blank" rel="noopener noreferrer">' +
          shown + '</a>';
      }
      var slug = charLinks[key];
      if (!slug) return '<span class="tok">' + shown + '</span>';
      return '<a class="wiki-charlink" href="' + esc(root + 'c/' + slug) + '">' + shown + '</a>';
    });

    // {{red|Imp}} / {{blue|Undertaker}}
    out = out.replace(COLOR_RE, function (m, kind, body) {
      return '<span class="' + COLOR_CLASS[kind.toLowerCase()] + '">' + body + '</span>';
    });

    // Nothing below this line is offered in links mode: every one of these
    // marks can be typed by accident in ordinary character prose.
    if (linksOnly) return out;

    out = out.replace(/~~([^~\n]{1,200})~~/g, '<s>$1</s>');
    out = out.replace(/\*\*([^*\n]{1,300})\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]{1,300})\*(?!\*)/g, '$1<em>$2</em>');

    return out.replace(/\u0000c(\d+)\u0000/g, function (m, i) { return codes[+i]; });
  }

  /* ── the marks, taken back out ──
     For the places a writer's text has to leave the wiki as plain prose: the
     official-schema JSON a character page exports (the app renders no
     markup), and the meta description a search engine or Discord shows. The
     label survives, the syntax does not.

     Single *asterisks* are deliberately left alone — this is character text,
     where a lone one is the official "Each night*" convention rather than a
     mark, and links mode never rendered it as one either. */
  function plainText(text) {
    return String(text == null ? '' : text)
      .replace(COLOR_RE, '$2')
      .replace(/\[\[([^\]|\n]{1,80})(?:\|([^\]\n]{1,80}))?\]\]/g,
        function (m, target, label) { return (label != null && label !== '') ? label : target; })
      .replace(/!?\[([^\]\n]{1,160})\]\(([^)\s]{1,500})\)/g, '$1')
      .replace(/\*\*([^*\n]{1,300})\*\*/g, '$1')
      .replace(/~~([^~\n]{1,200})~~/g, '$1')
      .replace(/`([^`\n]{1,300})`/g, '$1');
  }

  /* ── table of contents ── */
  function tocHTML(headings, opts) {
    opts = opts || {};
    var items = headings.filter(function (h) { return h.level <= 3; });
    if (items.length < (opts.min || 2)) return '';
    var top = Math.min.apply(null, items.map(function (h) { return h.level; }));
    return '<nav class="wiki-toc" aria-label="Contents">' +
      '<div class="wiki-toc-head">Contents</div>' +
      '<ol class="wiki-toc-list">' + items.map(function (h) {
        return '<li class="wiki-toc-l' + (h.level - top) + '">' +
          '<a href="#' + esc(h.id) + '">' + esc(h.text) + '</a></li>';
      }).join('') + '</ol></nav>';
  }

  /* ── blocks ── */
  var CALLOUT_KINDS = { note: 'Note', tip: 'Tip', warning: 'Warning', example: 'Example', lore: 'Lore' };

  function listBlock(lines, ordered, opts) {
    var tag = ordered ? 'ol' : 'ul';
    var cls = ordered ? 'wiki-ol' : 'wiki-ul';
    return '<' + tag + ' class="' + cls + '">' + lines.map(function (l) {
      return '<li>' + inlineFormat(l.replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/, ''), opts) + '</li>';
    }).join('') + '</' + tag + '>';
  }

  function tableBlock(lines, opts) {
    var rows = lines.map(function (l) {
      return l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim(); });
    });
    // A row of dashes right under the first row marks it as the header.
    var hasHead = rows.length > 1 && rows[1].every(function (c) { return /^:?-{2,}:?$/.test(c); });
    var head = hasHead ? rows[0] : null;
    var body = hasHead ? rows.slice(2) : rows;
    var html = '<div class="wiki-table-wrap"><table class="wiki-table">';
    if (head) {
      html += '<thead><tr>' + head.map(function (c) {
        return '<th>' + inlineFormat(c, opts) + '</th>';
      }).join('') + '</tr></thead>';
    }
    html += '<tbody>' + body.map(function (r) {
      return '<tr>' + r.map(function (c) { return '<td>' + inlineFormat(c, opts) + '</td>'; }).join('') + '</tr>';
    }).join('') + '</tbody></table></div>';
    return html;
  }

  function imageBlock(line, opts) {
    var m = line.match(/^!\[([^\]\n]{0,160})\]\(([^)\s|]{1,400})(?:\|(left|right|wide))?\)\s*$/);
    if (!m) return null;
    var url = safeImg(m[2], (opts && opts.linkRoot) || '');
    if (!url) return '';
    var align = m[3] || '';
    var caption = m[1] || '';
    return '<figure class="wiki-figure' + (align ? ' wiki-figure-' + align : '') + '">' +
      '<img src="' + esc(url) + '" alt="' + esc(caption) + '" loading="lazy" decoding="async">' +
      (caption ? '<figcaption>' + inlineFormat(caption, opts) + '</figcaption>' : '') +
      '</figure>';
  }

  /* Turn a whole body of text into HTML.
     opts: {linkRoot, headings[] (filled in), toc:'auto'|false} */
  function renderBody(text, opts) {
    opts = opts || {};
    var headings = opts.headings || [];
    var seen = {};
    var src = String(text || '').replace(/\r\n/g, '\n').replace(/\t/g, '    ');
    var lines = src.split('\n');
    var html = '';
    var i = 0;

    function headingId(txt) {
      var base = 'sec-' + (kebab(txt) || 'section');
      var id = base, n = 2;
      while (seen[id]) { id = base + '-' + (n++); }
      seen[id] = 1;
      return id;
    }

    function flushPara(buf) {
      if (!buf.length) return '';
      return '<p>' + buf.map(function (l) { return inlineFormat(l, opts); }).join('<br>') + '</p>';
    }

    var para = [];
    function closePara() { html += flushPara(para); para = []; }

    while (i < lines.length) {
      var line = lines[i];
      var trimmed = line.trim();

      // blank line -> paragraph break
      if (!trimmed) { closePara(); i++; continue; }

      // ::: callout … :::
      var call = trimmed.match(/^:::\s*([a-z]+)?\s*(.*)$/i);
      if (call && trimmed.indexOf(':::') === 0 && !/^:::\s*$/.test(trimmed)) {
        closePara();
        var kind = String(call[1] || 'note').toLowerCase();
        if (!CALLOUT_KINDS[kind]) kind = 'note';
        var label = call[2].trim() || CALLOUT_KINDS[kind];
        var inner = [];
        i++;
        while (i < lines.length && !/^\s*:::\s*$/.test(lines[i])) { inner.push(lines[i]); i++; }
        i++; // skip the closing :::
        html += '<div class="wiki-callout wiki-callout-' + kind + '">' +
          '<div class="wiki-callout-head">' + esc(label) + '</div>' +
          '<div class="wiki-callout-body">' + renderBody(inner.join('\n'), {
            linkRoot: opts.linkRoot, headings: headings, nested: true
          }) + '</div></div>';
        continue;
      }

      // heading
      var h = trimmed.match(/^(#{1,4})\s+(.+?)\s*#*$/);
      if (h) {
        closePara();
        var level = h[1].length;
        var htext = h[2].trim();
        var id = headingId(htext);
        headings.push({ level: level, id: id, text: htext.replace(/[*`~]/g, '') });
        var tag = 'h' + Math.min(level + 1, 5);   // # -> h2, the page title is the h1
        html += '<' + tag + ' class="wiki-h wiki-h' + level + '" id="' + id + '">' +
          '<a class="sec-anchor" href="#' + id + '">' + inlineFormat(htext, opts) + '</a></' + tag + '>';
        i++; continue;
      }

      // [toc]
      if (/^\[toc\]$/i.test(trimmed)) {
        closePara();
        html += TOC_MARK;
        i++; continue;
      }

      // horizontal rule
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
        closePara();
        html += '<hr class="wiki-rule">';
        i++; continue;
      }

      // block image on its own line
      if (/^!\[/.test(trimmed)) {
        var fig = imageBlock(trimmed, opts);
        if (fig !== null) { closePara(); html += fig; i++; continue; }
      }

      // table
      if (/^\|.*\|\s*$/.test(trimmed)) {
        closePara();
        var trows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { trows.push(lines[i].trim()); i++; }
        html += tableBlock(trows, opts);
        continue;
      }

      // blockquote
      if (/^>\s?/.test(trimmed)) {
        closePara();
        var quote = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quote.push(lines[i].trim().replace(/^>\s?/, '')); i++;
        }
        html += '<blockquote class="wiki-quote">' +
          renderBody(quote.join('\n'), { linkRoot: opts.linkRoot, headings: headings, nested: true }) +
          '</blockquote>';
        continue;
      }

      // bullet / numbered list
      var bullet = /^[-*]\s+/.test(trimmed);
      var numbered = /^\d+[.)]\s+/.test(trimmed);
      if (bullet || numbered) {
        closePara();
        var items = [];
        var re = bullet ? /^\s*[-*]\s+/ : /^\s*\d+[.)]\s+/;
        while (i < lines.length && re.test(lines[i])) { items.push(lines[i].trim()); i++; }
        html += listBlock(items, numbered, opts);
        continue;
      }

      para.push(trimmed);
      i++;
    }
    closePara();

    // The contents box is built last, once every heading is known — including
    // headings inside callouts and quotes, which render through a nested call.
    // A nested call leaves the [toc] marker alone so the outer one fills it.
    if (opts.nested) return html;
    if (html.indexOf(TOC_MARK) !== -1) {
      html = html.split(TOC_MARK).join(tocHTML(headings, { min: 2 }));
    } else if (opts.toc === 'auto') {
      var auto = tocHTML(headings, { min: 3 });
      if (auto) html = auto + html;
    }
    return html;
  }

  /* First ~200 characters of the body, marks stripped — used for card
     summaries and the meta description when the author didn't write one. */
  function autoSummary(text, max) {
    var flat = String(text || '')
      .replace(/\r\n/g, '\n')
      .replace(/^\s*:::.*$/gm, '')
      .replace(/^\s*\|.*$/gm, '')
      .replace(/^\s*#{1,4}\s+/gm, '')
      .replace(/^\s*[-*]\s+/gm, '')
      .replace(/^\s*\d+[.)]\s+/gm, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(/!\[([^\]\n]*)\]\([^)\s]*\)/g, '')
      .replace(/\[\[([^\]|\n]*)(?:\|([^\]\n]*))?\]\]/g, function (m, a, b) { return b || a; })
      .replace(/\[([^\]\n]*)\]\([^)\s]*\)/g, '$1')
      .replace(/[*`~]/g, '')
      .replace(/\[toc\]/gi, '')
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

  /* ── side boxes ──
     The same {title, content} shape as the custom boxes on character pages,
     so one editor widget serves character, script, collection, wiki and news
     pages. Content goes through the full renderer, so a box can hold a list
     or a small table. */
  function renderBoxes(boxes, opts) {
    return (boxes || []).map(function (b) {
      var title = String((b && b.title) || '').trim();
      var content = String((b && b.content) || '');
      if (!title && !content.trim()) return '';
      return '<div class="card custom-box">' +
        (title ? '<h2 class="info-h custom-box-h">' + esc(title) + '</h2>' : '') +
        '<div class="custom-box-body">' + renderBody(content, { linkRoot: (opts || {}).linkRoot }) + '</div>' +
        '</div>';
    }).join('');
  }

  /* Fact box: a title, an optional image and any number of Label / value
     rows. Reuses the character info-card styling. */
  function renderInfobox(info, opts) {
    if (!info) return '';
    var rows = (info.rows || []).filter(function (r) { return r && (r.label || r.value); });
    var img = safeImg(info.image, (opts || {}).linkRoot);
    if (!rows.length && !img && !info.title) return '';
    return '<div class="card char-infocard wiki-infobox">' +
      (img ? '<img class="wiki-info-img" src="' + esc(img) + '" alt="" onerror="this.style.display=\'none\'">' : '') +
      '<h2 class="info-h">' + esc(info.title || 'Information') + '</h2>' +
      (rows.length ? '<dl class="info">' + rows.map(function (r) {
        return '<dt>' + esc(r.label || '') + '</dt><dd>' + inlineFormat(r.value || '', opts) + '</dd>';
      }).join('') + '</dl>' : '') +
      '</div>';
  }

  /* ── the /p/{slug} page body ──
     p: {slug, title, subtitle, body, author, header, infobox, boxes[], toc,
         parentType, parentSlug, parentName, updatedAt}
     opts: {linkRoot, isDraft} */
  function renderWikiPage(p, opts) {
    opts = opts || {};
    var root = opts.linkRoot || '';
    var io = { linkRoot: root };

    var parentHref = p.parentType === 'collection'
      ? root + 'collection/' + encodeURIComponent(p.parentKey || p.parentSlug || '')
      : root + 's/' + encodeURIComponent(p.parentKey || p.parentSlug || '');
    var crumb = p.parentName
      ? '<p class="wiki-crumb"><a href="' + esc(parentHref) + '">&larr; ' + esc(p.parentName) + '</a></p>'
      : '';

    var banner = p.header
      ? (function () {
          var url = safeImg(p.header, root);
          return url ? '<div class="wiki-banner-wrap"><img class="wiki-banner" src="' + esc(url) + '" alt=""></div>' : '';
        })()
      : '';

    var metaParts = [];
    if (p.author) {
      metaParts.push('by <a class="author-link" href="' + esc(root) + 'author?a=' +
        encodeURIComponent(p.author) + '">' + esc(p.author) + '</a>');
    }
    if (p.updatedAt) metaParts.push('updated ' + esc(formatDate(p.updatedAt)));
    if (opts.isDraft) metaParts.push('DRAFT');

    var headings = [];
    var bodyHTML = renderBody(p.body, {
      linkRoot: root, headings: headings, toc: p.toc === false ? false : 'auto'
    });

    var side = renderInfobox(p.infobox, io) + renderBoxes(p.boxes, io);

    return '<article class="wiki-page">' +
      crumb + banner +
      '<header class="wiki-page-head">' +
        '<h1 class="wiki-title">' + esc(p.title || 'Untitled') + '</h1>' +
        (p.subtitle ? '<p class="wiki-subtitle">' + esc(p.subtitle) + '</p>' : '') +
        (metaParts.length ? '<p class="wiki-meta">' + metaParts.join(' &middot; ') + '</p>' : '') +
      '</header>' +
      '<div class="wiki-layout' + (side ? '' : ' wiki-layout-full') + '">' +
        '<div class="wiki-body">' + bodyHTML + '</div>' +
        (side ? '<aside class="wiki-side">' + side + '</aside>' : '') +
      '</div>' +
    '</article>';
  }

  /* ── the "Pages" list shown on the parent script/collection page ──
     Each entry is a link with the author's own blurb underneath. Drafts are
     only ever passed in for someone who may see them. */
  function renderPageLinks(pages, opts) {
    opts = opts || {};
    var root = opts.linkRoot || '';
    if (!pages || !pages.length) return '';
    return '<div class="wiki-pagelinks">' + pages.map(function (p) {
      return '<a class="wiki-pagelink" href="' + esc(root + 'p/' + encodeURIComponent(p.slug)) + '">' +
        '<span class="wiki-pagelink-title">' + esc(p.title || 'Untitled') +
          (p.status === 'draft' ? '<span class="draft-mark" title="Unpublished — only its owner and the admins can see this page.">Draft</span>' : '') +
        '</span>' +
        (p.blurb ? '<span class="wiki-pagelink-blurb">' + esc(p.blurb) + '</span>' : '') +
      '</a>';
    }).join('') + '</div>';
  }

  var API = {
    setCharLinks: setCharLinks, setOfficialNames: setOfficialNames,
    esc: esc, kebab: kebab, safeHref: safeHref, safeImg: safeImg,
    inlineFormat: inlineFormat, plainText: plainText,
    renderBody: renderBody, tocHTML: tocHTML,
    autoSummary: autoSummary, formatDate: formatDate,
    renderBoxes: renderBoxes, renderInfobox: renderInfobox,
    renderWikiPage: renderWikiPage, renderPageLinks: renderPageLinks,
    CALLOUT_KINDS: CALLOUT_KINDS
  };

  if (typeof window !== 'undefined') window.WikiRender = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
