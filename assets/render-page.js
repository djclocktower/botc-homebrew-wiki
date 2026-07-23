/* Shared script/collection page renderer.
   Used in the browser by publish-script.html / publish-collection.html (live
   status + shared helpers) and bundled into the Worker (worker/worker.js
   imports this file) to server-side render /s/{slug} and /collection/{id}
   pages. Because both sides share this code, the editor and the published
   page are guaranteed to match. No DOM access at module top level.

   Depends on render.js (buildSchema, findScriptJinxes, TEAM_LABEL, slugId):
   the Worker passes them via init(Render); in the browser they're read from
   window as a fallback, so load render.js first. */
(function () {
  var deps = {};
  function init(render) { deps = render || {}; }
  function dep(name) {
    if (deps[name]) return deps[name];
    if (typeof window !== 'undefined' && window[name]) return window[name];
    return null;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function tok(s) {
    return esc(s).replace(/\[\[(.+?)\]\]/g, '<span class="tok">$1</span>');
  }
  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }

  var TEAMS = [
    ['townsfolk', 'Townsfolk'], ['outsider', 'Outsider'], ['minion', 'Minion'],
    ['demon', 'Demon'], ['traveller', 'Traveller'], ['fabled', 'Fabled']
  ];
  var GOOD = { townsfolk: 1, outsider: 1 };
  var DIFFICULTY_LABEL = {
    beginner: 'Beginner', intermediate: 'Intermediate', veteran: 'Veteran'
  };

  /* ── Theme ──
     Stored as data.theme = {font, accent, panel, text, link, background}.
     Every value is validated by sanitizeTheme (server AND client) and only
     ever applied as CSS custom properties / whitelisted class names — never
     raw CSS. Font stacks live in styles.css (.theme-font-*). */
  var FONT_PRESETS = {
    'default':   'Dumbledor (wiki default)',
    'trade':     'Trade Gothic',
    'oswald':    'Oswald',
    'garamond':  'EB Garamond',
    'cinzel':    'Cinzel',
    'pirata':    'Pirata One',
    'imfell':    'IM Fell English',
    'grenze':    'Grenze Gotisch'
  };

  function sanitizeTheme(theme, allowedBgBase) {
    if (!theme || typeof theme !== 'object') return null;
    var out = {};
    if (typeof theme.font === 'string' &&
        Object.prototype.hasOwnProperty.call(FONT_PRESETS, theme.font) &&
        theme.font !== 'default') {
      out.font = theme.font;
    }
    ['accent', 'panel', 'text', 'link'].forEach(function (k) {
      var v = theme[k];
      if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim())) {
        out[k] = v.trim().toLowerCase();
      }
    });
    if (typeof theme.background === 'string' && allowedBgBase) {
      var m = theme.background.match(/^([a-z0-9/-]+)-bg\.(png|jpe?g|webp)$/i);
      if (m && m[1] === allowedBgBase) out.background = theme.background;
    }
    return Object.keys(out).length ? out : null;
  }

  /* Build the class list + inline style for <main> from a sanitized theme.
     Callers MUST pass the theme through sanitizeTheme first (the Worker does
     this on save and again at render time). */
  function themeAttrs(theme, linkRoot) {
    if (!theme) return { cls: '', style: '' };
    var cls = ['page-themed'];
    var style = [];
    if (theme.font) cls.push('theme-font-' + theme.font);
    if (theme.accent) { cls.push('theme-accent'); style.push('--pg-accent:' + theme.accent); }
    if (theme.panel)  { cls.push('theme-panel');  style.push('--pg-panel:' + theme.panel); }
    if (theme.text)   { cls.push('theme-text');   style.push('--pg-text:' + theme.text); }
    if (theme.link)   { cls.push('theme-link');   style.push('--pg-link:' + theme.link); }
    if (theme.background) {
      cls.push('theme-bg');
      style.push('--pg-bg:url("' + (linkRoot || '') + 'assets/' + theme.background + '")');
    }
    return { cls: cls.join(' '), style: style.join(';') };
  }

  /* ── Hybrid collection membership ──
     Auto-matched by the character's "Appears in" text (normalized against
     match[]), plus explicit include[] slugs, minus explicit exclude[] slugs. */
  function resolveCollectionMembers(coll, allChars) {
    var match = (coll.match || []).map(norm).filter(Boolean);
    var include = {}, exclude = {};
    (coll.include || []).forEach(function (s) { include[s] = 1; });
    (coll.exclude || []).forEach(function (s) { exclude[s] = 1; });
    return (allChars || []).filter(function (c) {
      if (exclude[c.slug]) return false;
      if (include[c.slug]) return true;
      return match.indexOf(norm(c.appearsIn)) !== -1;
    });
  }

  /* ── helpers ── */
  function b64url(str) {
    var b64 = '';
    if (typeof btoa === 'function') {
      b64 = btoa(unescape(encodeURIComponent(str)));
    } else if (typeof Buffer !== 'undefined') {
      b64 = Buffer.from(str, 'utf8').toString('base64');
    } else {
      return '';
    }
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function artSrc(c, root) {
    if (c.art) return root + 'assets/' + c.art;
    if (typeof c.image === 'string' && c.image) return c.image;
    if (Array.isArray(c.image) && c.image[0]) return c.image[0];
    return root + 'assets/favicon.png';
  }
  function charHref(c, root) {
    var p = c.page || ('c/' + c.slug);
    if (/^https?:/i.test(p)) return p;
    return root + p.replace(/\.html$/, '');
  }

  function sech(id, title) {
    return '<div class="gen-sech-wrap" id="' + id + '"><h2 class="gen-sech">' +
      '<a class="sec-anchor" href="#' + id + '">' + esc(title) + '</a></h2></div>';
  }
  function prose(text) {
    return String(text || '').split(/\n{2,}/).map(function (p) {
      p = p.replace(/\s+$/, '');
      return p.trim() ? '<p>' + tok(p).replace(/\n/g, '<br>') + '</p>' : '';
    }).join('');
  }

  /* ── page sections ── */
  function renderRoster(entries, root) {
    if (!entries.length) {
      return '<p style="color:var(--ink);opacity:.7;padding:8px 0">No characters on this page yet.</p>';
    }
    var html = '';
    TEAMS.forEach(function (t) {
      var grp = entries.filter(function (c) { return c.team === t[0]; });
      if (!grp.length) return;
      html += '<div class="script-team-group"><h3 class="script-team-head' + (GOOD[t[0]] ? ' good' : '') + '">' +
        t[1] + ' <span class="script-team-count">(' + grp.length + ')</span></h3>' +
        '<div class="script-char-list">';
      grp.forEach(function (c) {
        html += '<a class="script-char-row" href="' + esc(charHref(c, root)) + '">' +
          '<img loading="lazy" decoding="async" class="script-char-thumb" src="' + esc(artSrc(c, root)) + '" alt="" onerror="this.src=\'' + esc(root) + 'assets/favicon.png\'">' +
          '<div class="script-char-text"><span class="script-char-name">' + esc(c.name) + '</span>' +
          '<span class="script-char-ability">' + esc(c.ability || '') + '</span></div></a>';
      });
      html += '</div></div>';
    });
    // Characters with unrecognized teams still get listed rather than vanishing
    var other = entries.filter(function (c) {
      return !TEAMS.some(function (t) { return t[0] === c.team; });
    });
    if (other.length) {
      html += '<div class="script-team-group"><h3 class="script-team-head">Other <span class="script-team-count">(' + other.length + ')</span></h3><div class="script-char-list">';
      other.forEach(function (c) {
        html += '<a class="script-char-row" href="' + esc(charHref(c, root)) + '">' +
          '<img loading="lazy" decoding="async" class="script-char-thumb" src="' + esc(artSrc(c, root)) + '" alt="">' +
          '<div class="script-char-text"><span class="script-char-name">' + esc(c.name) + '</span>' +
          '<span class="script-char-ability">' + esc(c.ability || '') + '</span></div></a>';
      });
      html += '</div></div>';
    }
    return html;
  }

  /* Collection roster as a full-width card grid grouped by team, with a team
     header above each group (like all-characters). Cards reuse the .char-card
     styles and carry data-* attributes so collection-filters.js can filter and
     sort them client-side. orderMap gives each slug its index in the full
     character list, for the "recently added" sort. */
  function renderRosterCards(entries, root, orderMap) {
    if (!entries.length) {
      return '<p style="color:var(--ink);opacity:.7;padding:8px 0">No characters on this page yet.</p>';
    }
    orderMap = orderMap || {};
    function cardHTML(c) {
      var label = '';
      for (var i = 0; i < TEAMS.length; i++) { if (TEAMS[i][0] === c.team) { label = TEAMS[i][1]; break; } }
      if (!label) label = c.team || '';
      return '<a class="char-card" href="' + esc(charHref(c, root)) + '"' +
        ' data-team="' + esc(c.team || '') + '"' +
        ' data-tags="' + esc(c.tags || '') + '"' +
        ' data-creator="' + esc((c.creator || '').trim()) + '"' +
        ' data-name="' + esc(c.name || '') + '"' +
        ' data-order="' + (orderMap[c.slug] != null ? orderMap[c.slug] : 0) + '">' +
        '<img loading="lazy" decoding="async" class="char-card-thumb" src="' + esc(artSrc(c, root)) + '" alt="" onerror="this.src=\'' + esc(root) + 'assets/favicon.png\'">' +
        '<div class="char-card-info">' +
        '<div class="char-card-name">' + esc(c.name) + '</div>' +
        '<div class="char-card-type' + (GOOD[c.team] ? ' good' : '') + '">' + esc(label) + '</div>' +
        '<div class="char-card-ability">' + esc(c.ability || '') + '</div>' +
        '<span class="char-card-link">View Character &rarr;</span>' +
        '</div></a>';
    }
    function section(key, label, grp) {
      return '<section class="type-section coll-team" data-team="' + esc(key) + '">' +
        '<h2 class="type-header' + (GOOD[key] ? ' good' : '') + '">' +
        '<a class="team-header-link" href="' + esc(root) + 'team?t=' + encodeURIComponent(key) + '">' + esc(label) + '</a>' +
        ' <span class="coll-team-count">(' + grp.length + ')</span></h2>' +
        '<div class="type-rule"></div>' +
        '<div class="char-grid">' + grp.map(cardHTML).join('') + '</div></section>';
    }
    var html = '';
    TEAMS.forEach(function (t) {
      var grp = entries.filter(function (c) { return c.team === t[0]; });
      if (grp.length) html += section(t[0], t[1], grp);
    });
    var other = entries.filter(function (c) {
      return !TEAMS.some(function (t) { return t[0] === c.team; });
    });
    if (other.length) html += section('other', 'Other', other);
    return html;
  }

  function renderJinxGroup(entries) {
    var findScriptJinxes = dep('findScriptJinxes');
    var jinxes = findScriptJinxes ? findScriptJinxes(entries) : [];
    if (!jinxes.length) return '';
    var html = '<div class="script-team-group" id="sec-jinxes"><h3 class="script-team-head">Jinxes <span class="script-team-count">(' + jinxes.length + ')</span></h3>' +
      '<div class="script-char-list">';
    jinxes.forEach(function (j) {
      html += '<div class="script-char-row"><div class="script-char-text">' +
        '<span class="script-char-name">' + esc(j.a.name) + ' ↔ ' + esc(j.b.name) + '</span>' +
        '<span class="script-char-ability">' + esc(j.text) + '</span></div></div>';
    });
    return html + '</div></div>';
  }

  function renderNightOrder(entries, root) {
    var buildSchema = dep('buildSchema');
    if (!buildSchema) return '';
    var first = [], other = [];
    entries.forEach(function (c) {
      var s;
      try { s = buildSchema(c); } catch (e) { return; }
      if (s.firstNight > 0) first.push({ c: c, n: s.firstNight, r: s.firstNightReminder || '' });
      if (s.otherNight > 0) other.push({ c: c, n: s.otherNight, r: s.otherNightReminder || '' });
    });
    if (!first.length && !other.length) return '';
    function cmp(a, b) { return a.n - b.n || (a.c.name || '').localeCompare(b.c.name || ''); }
    first.sort(cmp); other.sort(cmp);
    function list(items) {
      if (!items.length) return '<p class="sv-night-empty">No characters act.</p>';
      return '<ol class="sv-night-list">' + items.map(function (it) {
        return '<li class="sv-night-item">' +
          '<img loading="lazy" decoding="async" class="sv-night-thumb" src="' + esc(artSrc(it.c, root)) + '" alt="" onerror="this.style.display=\'none\'">' +
          '<div class="sv-night-text"><a class="sv-night-name" href="' + esc(charHref(it.c, root)) + '">' + esc(it.c.name) + '</a>' +
          (it.r ? '<span class="sv-night-reminder">' + esc(it.r) + '</span>' : '') +
          '</div></li>';
      }).join('') + '</ol>';
    }
    return '<div class="jinx-drop sv-night" id="sec-nightorder">' +
      '<div class="jinx-drop-bar" role="button" tabindex="0" aria-expanded="false">' +
      '<span class="jinx-drop-title">Night Order</span>' +
      '<span class="jinx-drop-arrow">&#9662;</span></div>' +
      '<div class="jinx-drop-body" hidden><div class="sv-night-cols">' +
      '<div class="sv-night-col"><h4 class="sv-night-head">First Night</h4>' + list(first) + '</div>' +
      '<div class="sv-night-col"><h4 class="sv-night-head">Other Nights</h4>' + list(other) + '</div>' +
      '</div></div></div>';
  }

  function renderCredits(entries, root) {
    var counts = {};
    entries.forEach(function (c) {
      if (c.official) return;
      var cr = (c.creator || '').trim();
      if (!cr) return;
      counts[cr] = (counts[cr] || 0) + 1;
    });
    var names = Object.keys(counts);
    if (!names.length) return '';
    names.sort(function (a, b) { return counts[b] - counts[a] || a.localeCompare(b); });
    return '<div class="card sv-credits" id="sec-credits">' +
      '<h2 class="info-h">Character Credits</h2>' +
      '<p class="sv-credits-sub">Creators with characters on this page</p>' +
      '<ul class="sv-credits-list">' + names.map(function (n) {
        return '<li><a class="author-link" href="' + esc(root) + 'author?a=' + encodeURIComponent(n) + '">' + esc(n) + '</a>' +
          ' <span class="sv-credits-count">(' + counts[n] + ')</span></li>';
      }).join('') + '</ul></div>';
  }

  function teamCounts(entries) {
    var out = [];
    TEAMS.forEach(function (t) {
      var n = entries.filter(function (c) { return c.team === t[0]; }).length;
      if (n) out.push([t[1], n]);
    });
    return out;
  }

  function renderInfobox(opts) {
    // opts: {root, logoPath, author, version, difficulty, entries, extraRows[],
    //        authorProminent} — authorProminent shows the author as a bold
    //        credit line at the top of the box instead of a plain table row.
    var root = opts.root;
    var authorLink = opts.author
      ? '<a class="author-link" href="' + esc(root) + 'author?a=' + encodeURIComponent(opts.author) + '">' + esc(opts.author) + '</a>'
      : '';
    var rows = '';
    if (opts.author && !opts.authorProminent) {
      rows += '<dt>Author:</dt><dd>' + authorLink + '</dd>';
    }
    if (opts.version) rows += '<dt>Version:</dt><dd>' + esc(opts.version) + '</dd>';
    if (opts.difficulty && DIFFICULTY_LABEL[opts.difficulty]) {
      rows += '<dt>Difficulty:</dt><dd><span class="sv-difficulty sv-difficulty-' + esc(opts.difficulty) + '">' + DIFFICULTY_LABEL[opts.difficulty] + '</span></dd>';
    }
    teamCounts(opts.entries).forEach(function (tc) {
      rows += '<dt>' + tc[0] + ':</dt><dd>' + tc[1] + '</dd>';
    });
    rows += '<dt>Total:</dt><dd>' + opts.entries.length + ' character' + (opts.entries.length === 1 ? '' : 's') + '</dd>';
    (opts.extraRows || []).forEach(function (r) { rows += r; });
    return '<div class="card char-infocard sv-infobox">' +
      (opts.logoPath ? '<img class="sv-info-logo" src="' + esc(root) + 'assets/' + esc(opts.logoPath) + '" alt="" onerror="this.style.display=\'none\'">' : '') +
      '<h2 class="info-h">Information</h2>' +
      (opts.author && opts.authorProminent ? '<p class="sv-info-author">by ' + authorLink + '</p>' : '') +
      '<dl class="info">' + rows + '</dl></div>';
  }

  function renderJsonPanel(jsonText, actions, label, collapsed) {
    return '<div class="json-box' + (collapsed ? '' : ' open') + '">' +
      '<div class="json-bar">' +
      '<span class="json-bar-toggle" role="button" tabindex="0" aria-expanded="' + (collapsed ? 'false' : 'true') + '">' + esc(label || 'Script JSON') + ' <span class="json-arrow">&#9662;</span></span>' +
      '<button type="button" class="json-copy">Copy JSON</button>' +
      '</div>' +
      '<pre class="json-body"' + (collapsed ? ' hidden' : '') + '><code>' + esc(jsonText) + '</code></pre>' +
      '</div>' + (actions || []).map(function (a) {
        return '<a class="cta-secondary" style="display:block;text-align:center;margin-top:10px"' +
          (a.id ? ' id="' + a.id + '"' : '') + ' href="' + esc(a.href) + '">' + a.label + '</a>';
      }).join('');
  }

  /* Official-schema export: [_meta, ...characters]. Official roles export as
     their bare id; homebrew characters as full objects (same as the builder). */
  function buildPageExport(name, author, headerPath, entries) {
    var buildSchema = dep('buildSchema');
    var meta = { id: '_meta', name: name || 'Homebrew Script' };
    if (author) meta.author = author;
    if (headerPath) meta.logo = 'https://botchomebrew.wiki/assets/' + headerPath;
    var arr = [meta];
    entries.forEach(function (c) {
      if (c.official) { arr.push(String(c.slug).replace(/^off-/, '')); return; }
      if (buildSchema) arr.push(buildSchema(c));
    });
    return JSON.stringify(arr, null, 2);
  }

  /* ── shared page body ── */
  function renderPageBody(cfg) {
    /* cfg: {root, name, header, logo, tagline, author, version, difficulty,
             synopsis, gameplay, strategyGood, strategyEvil, description,
             entries, missing[], jsonText, actions[], extraInfoRows[],
             creditsEntries} */
    var root = cfg.root;
    var top = cfg.header
      ? '<div class="script-header-wrap"><img class="script-header-img" src="' + esc(root) + 'assets/' + esc(cfg.header) + '" alt="' + esc(cfg.name) + '"></div>'
      : ((cfg.logo ? '<div class="sv-logo-wrap"><img class="sv-logo" src="' + esc(root) + 'assets/' + esc(cfg.logo) + '" alt="" onerror="this.style.display=\'none\'"></div>' : '') +
         '<h1 class="script-title-fallback">' + esc(cfg.name) + '</h1>');
    if (cfg.tagline) top += '<p class="sv-tagline">' + esc(cfg.tagline) + '</p>';
    if (cfg.description) top += '<p class="script-desc">' + esc(cfg.description) + '</p>';

    var metaParts = [cfg.entries.length + ' character' + (cfg.entries.length === 1 ? '' : 's')];
    if (cfg.author) metaParts.push('by ' + esc(cfg.author));
    if (cfg.version) metaParts.push('v' + esc(String(cfg.version).replace(/^v/i, '')));
    if (cfg.difficulty && DIFFICULTY_LABEL[cfg.difficulty]) metaParts.push(DIFFICULTY_LABEL[cfg.difficulty]);
    top += '<p class="script-meta-line">' + metaParts.join(' · ') + '</p>';

    var main = '';
    if (cfg.synopsis) main += '<div class="sv-section">' + sech('sec-synopsis', 'Synopsis') + prose(cfg.synopsis) + '</div>';
    var gameplay = '';
    if (cfg.gameplay) gameplay += prose(cfg.gameplay);
    if (cfg.strategyGood) gameplay += '<h3 class="sv-subhead good">Playing Good</h3>' + prose(cfg.strategyGood);
    if (cfg.strategyEvil) gameplay += '<h3 class="sv-subhead">Playing Evil</h3>' + prose(cfg.strategyEvil);
    if (gameplay) main += '<div class="sv-section">' + sech('sec-gameplay', 'Gameplay') + gameplay + '</div>';

    main += '<div class="sv-section">' +
      (main ? sech('sec-characters', 'Characters') : '') +
      renderRoster(cfg.entries, root) +
      renderJinxGroup(cfg.entries) + '</div>';
    main += renderNightOrder(cfg.entries, root);
    if (cfg.missing && cfg.missing.length) {
      main += '<p class="script-missing">⚠ ' + cfg.missing.length + ' character' + (cfg.missing.length === 1 ? '' : 's') + ' on this page ' +
        (cfg.missing.length === 1 ? 'is' : 'are') + ' not in the wiki: ' + cfg.missing.map(esc).join(', ') + '</p>';
    }

    var aside = renderInfobox({
      root: root, logoPath: cfg.logo, author: cfg.author, version: cfg.version,
      difficulty: cfg.difficulty, entries: cfg.entries, extraRows: cfg.extraInfoRows
    });
    aside += renderCredits(cfg.creditsEntries || cfg.entries, root);
    aside += '<div class="sv-json-wrap">' + renderJsonPanel(cfg.jsonText, cfg.actions, cfg.jsonLabel) + '</div>';

    return top +
      '<div class="script-view-layout">' +
      '<section class="script-chars-panel">' + main + '</section>' +
      '<aside class="script-json-panel">' + aside + '</aside>' +
      '</div>';
  }

  /* ── collection page body ──
     A distinct layout from scripts: the characters show as a full-width card
     grid (like the browse view), and there is no night-order box or character
     credits list. Synopsis/gameplay prose sits in a parchment panel above the
     grid; the information box + JSON export sit in a meta row below it. */
  function renderCollectionBody(cfg) {
    var root = cfg.root;
    var n = cfg.entries.length;

    // Header graphic — big and front-and-centre. Falls back to logo + title.
    var top = cfg.header
      ? '<div class="coll-header-wrap"><img class="coll-header-img" src="' + esc(root) + 'assets/' + esc(cfg.header) + '" alt="' + esc(cfg.name) + '"></div>'
      : ((cfg.logo ? '<div class="sv-logo-wrap"><img class="sv-logo" src="' + esc(root) + 'assets/' + esc(cfg.logo) + '" alt="" onerror="this.style.display=\'none\'"></div>' : '') +
         '<h1 class="coll-title">' + esc(cfg.name) + '</h1>');
    if (cfg.tagline) top += '<p class="sv-tagline">' + esc(cfg.tagline) + '</p>';
    if (cfg.description) top += '<p class="script-desc">' + esc(cfg.description) + '</p>';

    // Information + JSON/tokens boxes — moved to the top. The author credit
    // lives prominently inside the Information box (linked to their page).
    var infobox = renderInfobox({
      root: root, logoPath: cfg.logo, author: cfg.author, version: cfg.version,
      difficulty: cfg.difficulty, entries: cfg.entries, extraRows: cfg.extraInfoRows,
      authorProminent: true
    });
    var json = '<div class="sv-json-wrap">' + renderJsonPanel(cfg.jsonText, cfg.actions, cfg.jsonLabel, true) + '</div>';
    var meta = '<div class="coll-meta-row">' + infobox + json + '</div>';

    // Prose sections (synopsis / gameplay) in a parchment panel.
    var proseHTML = '';
    if (cfg.synopsis) proseHTML += '<div class="sv-section">' + sech('sec-synopsis', 'Synopsis') + prose(cfg.synopsis) + '</div>';
    var gameplay = '';
    if (cfg.gameplay) gameplay += prose(cfg.gameplay);
    if (cfg.strategyGood) gameplay += '<h3 class="sv-subhead good">Playing Good</h3>' + prose(cfg.strategyGood);
    if (cfg.strategyEvil) gameplay += '<h3 class="sv-subhead">Playing Evil</h3>' + prose(cfg.strategyEvil);
    if (gameplay) proseHTML += '<div class="sv-section">' + sech('sec-gameplay', 'Gameplay') + gameplay + '</div>';
    var prosePanel = proseHTML ? '<section class="script-chars-panel coll-prose">' + proseHTML + '</section>' : '';

    // Optional collapsed filter box (built client-side by collection-filters.js).
    var filters =
      '<div class="coll-filters" id="coll-filters">' +
      '<button type="button" class="filter-toggle coll-filter-toggle" id="coll-filter-toggle" aria-expanded="false" aria-controls="coll-filter-bar">' +
      'Filter characters <span class="filter-toggle-arrow">&#9662;</span></button>' +
      '<div class="filter-bar coll-filter-bar" id="coll-filter-bar" hidden></div>' +
      '</div>';

    // A single character count (updates as filters are applied).
    var count = '<p class="coll-chars-count" id="coll-chars-count">' + n + ' character' + (n === 1 ? '' : 's') + '</p>';

    var chars = '<section class="coll-chars" id="sec-characters">' + count +
      '<div id="coll-grid">' + renderRosterCards(cfg.entries, root, cfg.orderMap) + '</div></section>';

    var jinx = renderJinxGroup(cfg.entries);
    var jinxPanel = jinx ? '<section class="script-chars-panel coll-jinx">' + jinx + '</section>' : '';

    return top + meta + prosePanel + filters + chars + jinxPanel;
  }

  /* ── public renderers ── */
  function renderScriptPage(sc, allChars, opts) {
    opts = opts || {};
    var root = opts.linkRoot || '';
    var bySlug = {};
    (allChars || []).forEach(function (c) { bySlug[c.slug] = c; });
    var entries = (sc.characters || []).map(function (s) { return bySlug[s]; }).filter(Boolean);
    var missing = (sc.characters || []).filter(function (s) { return !bySlug[s]; });
    var jsonText = buildPageExport(sc.name, sc.author, sc.header, entries);

    var share = b64url(JSON.stringify({ n: sc.name || '', a: sc.author || '', c: (sc.characters || []) }));
    var actions = [
      { id: 'json-download', href: '#', label: '⬇ Download JSON' },
      { href: root + 'script' + (share ? '?share=' + share : ''), label: 'Open in Script Builder' },
      { href: root + 'tokens?script=' + encodeURIComponent(sc.slug || ''), label: 'Print Tokens' }
    ];
    return renderPageBody({
      root: root, name: sc.name || 'Untitled Script', header: sc.header, logo: sc.logo,
      tagline: sc.tagline, author: sc.author, version: sc.version, difficulty: sc.difficulty,
      synopsis: sc.synopsis, gameplay: sc.gameplay, strategyGood: sc.strategyGood,
      strategyEvil: sc.strategyEvil, description: sc.description,
      entries: entries, missing: missing, jsonText: jsonText, actions: actions,
      jsonLabel: 'Script JSON'
    });
  }

  function renderCollectionPage(coll, allChars, opts) {
    opts = opts || {};
    var root = opts.linkRoot || '';
    var members = resolveCollectionMembers(coll, allChars || []);
    // stable order: team, then name
    var teamOrder = {};
    TEAMS.forEach(function (t, i) { teamOrder[t[0]] = i; });
    members.sort(function (a, b) {
      var ta = teamOrder[a.team] != null ? teamOrder[a.team] : 99;
      var tb = teamOrder[b.team] != null ? teamOrder[b.team] : 99;
      return ta !== tb ? ta - tb : (a.name || '').localeCompare(b.name || '');
    });
    var name = coll.displayName || coll.slug || 'Collection';
    var jsonText = buildPageExport(name, coll.author, coll.header, members);
    // orderMap: each slug's index in the full character list, for "recently
    // added" sorting in the on-page filter (higher index = more recent).
    var orderMap = {};
    (allChars || []).forEach(function (c, i) { orderMap[c.slug] = i; });
    // Browse/filter now lives on this page, so that action is gone.
    var actions = [
      { id: 'json-download', href: '#', label: '⬇ Download JSON' },
      { href: root + 'tokens?collection=' + encodeURIComponent(coll.slug || coll.id || ''), label: 'Print Tokens' }
    ];
    return renderCollectionBody({
      root: root, name: name, header: coll.header, logo: coll.logo,
      tagline: coll.tagline, author: coll.author, version: coll.version, difficulty: coll.difficulty,
      synopsis: coll.synopsis, gameplay: coll.gameplay, strategyGood: coll.strategyGood,
      strategyEvil: coll.strategyEvil, description: coll.description,
      entries: members, orderMap: orderMap, jsonText: jsonText, actions: actions,
      jsonLabel: 'Collection JSON'
    });
  }

  var api = {
    init: init,
    renderScriptPage: renderScriptPage,
    renderCollectionPage: renderCollectionPage,
    resolveCollectionMembers: resolveCollectionMembers,
    sanitizeTheme: sanitizeTheme,
    themeAttrs: themeAttrs,
    buildPageExport: buildPageExport,
    FONT_PRESETS: FONT_PRESETS,
    DIFFICULTY_LABEL: DIFFICULTY_LABEL
  };
  if (typeof window !== 'undefined') { window.PageRender = api; }
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})();
