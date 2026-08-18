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
    ['demon', 'Demon'], ['traveller', 'Traveller'], ['fabled', 'Fabled'],
    ['loric', 'Loric']
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

  /* The order a collection's roster is shown in, and the single source of
     truth for it — the collection page renders through this, and
     publish-collection.html arranges through it, so the editor's list is the
     page's list.

     Team first: the page draws one section per team, so nothing can reorder
     across that boundary. Then the author's hand-arranged `order` list. Then
     name, for anyone the author has never placed.

     Membership and order are deliberately separate lists. A slug in `order`
     that is no longer a member simply never matches; a member missing from
     `order` ranks Infinity and falls to the end of its team, alphabetically.
     Neither list has to be kept in step with the other — which is the only
     reason it is safe to store an order beside a membership rule that
     recomputes itself — and a collection nobody has arranged sorts exactly as
     it always did. Sorts a copy; the input array is left alone. */
  function sortCollectionMembers(coll, members) {
    var teamOrder = {};
    TEAMS.forEach(function (t, i) { teamOrder[t[0]] = i; });
    var manual = {};
    (Array.isArray(coll && coll.order) ? coll.order : []).forEach(function (slug, i) {
      if (manual[slug] == null) manual[slug] = i;
    });
    return (members || []).slice().sort(function (a, b) {
      var ta = teamOrder[a.team] != null ? teamOrder[a.team] : 99;
      var tb = teamOrder[b.team] != null ? teamOrder[b.team] : 99;
      if (ta !== tb) return ta - tb;
      var ma = manual[a.slug] != null ? manual[a.slug] : Infinity;
      var mb = manual[b.slug] != null ? manual[b.slug] : Infinity;
      if (ma !== mb) return ma - mb;
      return (a.name || '').localeCompare(b.name || '');
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
  /* An official character has no page here, so its name links to the official
     wiki: another site, so a new tab, and a mark saying so. */
  function offsite(c) {
    return c && c.official ? ' target="_blank" rel="noopener"' : '';
  }
  function offMark(c) {
    return c && c.official ? ' <span class="script-char-off" title="Official character; opens the official wiki">&#8599;</span>' : '';
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
        html += '<a class="script-char-row" href="' + esc(charHref(c, root)) + '"' + offsite(c) + '>' +
          '<img loading="lazy" decoding="async" class="script-char-thumb" src="' + esc(artSrc(c, root)) + '" alt="" onerror="this.onerror=null;this.src=\'' + esc(root) + 'assets/favicon.png\'">' +
          '<div class="script-char-text"><span class="script-char-name">' + esc(c.name) + offMark(c) + '</span>' +
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
        html += '<a class="script-char-row" href="' + esc(charHref(c, root)) + '"' + offsite(c) + '>' +
          '<img loading="lazy" decoding="async" class="script-char-thumb" src="' + esc(artSrc(c, root)) + '" alt="">' +
          '<div class="script-char-text"><span class="script-char-name">' + esc(c.name) + offMark(c) + '</span>' +
          '<span class="script-char-ability">' + esc(c.ability || '') + '</span></div></a>';
      });
      html += '</div></div>';
    }
    return html;
  }

  /* The empty chrome of the collapsed filter box. The bar itself is built in
     the browser by card-filters.js, which is handed these three ids; creator
     pages reuse this so there is one piece of filter markup, not two.
     `pfx` namespaces the ids ('coll' -> coll-filters / coll-filter-toggle
     / coll-filter-bar), because a page could carry more than one grid. */
  function filterBoxHTML(pfx, label) {
    var p = pfx || 'coll';
    return '<div class="coll-filters" id="' + p + '-filters">' +
      '<button type="button" class="filter-toggle coll-filter-toggle" id="' + p + '-filter-toggle"' +
      ' aria-expanded="false" aria-controls="' + p + '-filter-bar">' +
      esc(label || 'Filter characters') + ' <span class="filter-toggle-arrow">&#9662;</span></button>' +
      '<div class="filter-bar coll-filter-bar" id="' + p + '-filter-bar" hidden></div>' +
      '</div>';
  }

  /* Collection roster as a full-width card grid grouped by team, with a team
     header above each group (like all-characters). Cards reuse the .char-card
     styles and carry data-* attributes so card-filters.js can filter and
     sort them client-side. orderMap gives each slug its index in the full
     character list, for the "recently added" sort. */
  function renderRosterCards(entries, root, orderMap) {
    if (!entries.length) {
      // This grid hangs on the dark page background (no parchment behind it),
      // unlike renderRoster's list — so the empty note needs light text.
      return '<p class="roster-empty">No characters on this page yet.</p>';
    }
    orderMap = orderMap || {};
    function cardHTML(c) {
      var label = '';
      for (var i = 0; i < TEAMS.length; i++) { if (TEAMS[i][0] === c.team) { label = TEAMS[i][1]; break; } }
      if (!label) label = c.team || '';
      // data-partial / data-curata let card-filters.js offer the Show
      // Partial and Curata-only chips. `classification` is stamped by the
      // Worker on every row it serves (buildPublicJSON / /api/user), so it is
      // already here — this file never needs classify.js of its own.
      var cls = c.classification || '';
      var hasCurata = !!(c.curata || cls === 'curata');
      // Marks on the name: the Curata wreath (the same bare mark as
      // everywhere else) and, on a creator page's drafts, what is still
      // unpublished.
      var marks =
        (c.status === 'draft'
          ? '<span class="draft-mark" title="Unpublished — only its owner and the admins can see this page.">Draft</span>' : '') +
        (hasCurata
          ? '<span class="curata-mark" role="img" title="' +
            (c.curataFrom
              ? 'Curata — part of the ' + esc(c.curataFrom) + ' collection.'
              : 'Awarded by the wiki admins. Shown more often on the homepage and in Featured picks.') +
            '" aria-label="Curata"></span>' : '');
      return '<a class="char-card' + (c.status === 'draft' ? ' char-card-draft' : '') +
        '" href="' + esc(charHref(c, root)) + '"' +
        ' data-team="' + esc(c.team || '') + '"' +
        ' data-tags="' + esc(c.tags || '') + '"' +
        ' data-creator="' + esc((c.creator || '').trim()) + '"' +
        ' data-name="' + esc(c.name || '') + '"' +
        // Curata wins over Partial (same rule as Classify.isPartial): a
        // character can be stamped 'partial' and then inherit the wreath from a
        // Curata collection, and an admin-blessed page is never hidden
        // behind the Show Partial chip.
        (cls === 'partial' && !hasCurata ? ' data-partial="1"' : '') +
        (hasCurata ? ' data-curata="1"' : '') +
        ' data-order="' + (orderMap[c.slug] != null ? orderMap[c.slug] : 0) + '">' +
        '<img loading="lazy" decoding="async" class="char-card-thumb" src="' + esc(artSrc(c, root)) + '" alt="" onerror="this.onerror=null;this.src=\'' + esc(root) + 'assets/favicon.png\'">' +
        '<div class="char-card-info">' +
        '<div class="char-card-name">' + esc(c.name) + marks + '</div>' +
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

  /* Jinxes between a character on this script and an OFFICIAL character that
     is ALSO on it. findScriptJinxes only pairs two wiki characters, and a
     roster slug this wiki has no row for lands in cfg.missing as a bare name,
     so those pairs were invisible here. */
  function officialJinxesOnScript(entries, missing, root) {
    if (!missing || !missing.length) return [];
    var resolve = dep('resolveJinxTarget');
    var normJinxId = dep('normJinxId');
    if (!resolve || !normJinxId) return [];
    var onScript = {};
    missing.forEach(function (n) { var k = normJinxId(n); if (k) onScript[k] = n; });

    var out = [], seen = {};
    entries.forEach(function (c) {
      (c.jinxes || []).forEach(function (j) {
        var t = resolve(j, root);
        if (!t.external) return;                 // a wiki pair, already listed
        var key = normJinxId(t.name);
        if (!onScript[key]) return;
        var id = c.slug + '|' + key;
        if (seen[id]) return;
        seen[id] = 1;
        out.push({ a: c, target: t, text: j.text || j.reason || '' });
      });
    });
    return out;
  }

  /* Bootlegger rules: the official schema's `_meta.bootlegger`, house rules
     the app prints with the script. On the page too, or a reader would only
     find them by opening the JSON. */
  function renderBootlegger(rules) {
    var list = (rules || []).map(function (r) { return String(r || '').trim(); }).filter(Boolean);
    if (!list.length) return '';
    return '<div class="sv-section sv-bootlegger" id="sec-bootlegger">' +
      sech('sec-bootlegger', 'House Rules') +
      '<ul class="sv-boot-list">' + list.map(function (r) {
        return '<li>' + tok(r) + '</li>';
      }).join('') + '</ul></div>';
  }

  /* ── jinxes on one script, and the single source of truth for them ──
     A jinx normally belongs to the characters: both editors write it into the
     character's own `jinxes`, and findScriptJinxes finds the pairs where both
     ends are on this script. That is right for a rule the character carries
     everywhere, and wrong for a script that wants to drop one or add a rule
     that only holds here, so a script may carry `jinxEdits`:

       {off: ["slugA|slugB"], add: [{a: slug, b: slug, text: "…"}]}

     `off` names an inherited pair to leave out; `add` is this script's own.
     The pair key is the two slugs sorted and joined with "|", so it reads the
     same whichever end the jinx was written on. Nothing is written back to
     the characters, so another script keeps whatever they say.

     The page renders through this, both editors edit through it, and the
     exported JSON is built from it, so all three agree. */
  function jinxKey(a, b) { return [a, b].sort().join('|'); }

  function scriptJinxes(entries, edits) {
    var findScriptJinxes = dep('findScriptJinxes');
    var list = findScriptJinxes ? findScriptJinxes(entries || []) : [];
    edits = edits || {};
    var off = {};
    (Array.isArray(edits.off) ? edits.off : []).forEach(function (k) { off[k] = 1; });
    var out = list.filter(function (j) {
      return !off[jinxKey(j.a.slug || j.a.name, j.b.slug || j.b.name)];
    }).map(function (j) {
      return { a: j.a, b: j.b, text: j.text, custom: false };
    });
    var bySlug = {};
    (entries || []).forEach(function (c) { bySlug[c.slug] = c; });
    (Array.isArray(edits.add) ? edits.add : []).forEach(function (j) {
      var a = bySlug[j && j.a], b = bySlug[j && j.b];
      // A jinx whose other half has left the roster simply stops applying.
      // Not an error, and the entry stays put in case it comes back.
      if (!a || !b || a === b) return;
      out.push({ a: a, b: b, text: (j.text || '').trim(), custom: true });
    });
    return out;
  }

  /* One script's jinxes, from both directions at once:

       - scriptJinxes() covers every pair the roster holds, with this script's
         own edits applied. Official characters resolve into the roster now
         (official-roles.js), so an official/homebrew pair comes through here
         and can be switched off or rewritten like any other.
       - officialJinxesOnScript() covers the ones that cannot: a roster slug
         this wiki has no row for at all, which lands in `missing` as a bare
         name. Those are read-only: there is no page on either side to hang
         an edit off. */
  function renderJinxGroup(entries, root, missing, edits) {
    root = root || '';
    var jinxes = scriptJinxes(entries, edits);
    var official = officialJinxesOnScript(entries, missing, root);
    if (!jinxes.length && !official.length) return '';
    var html = '<div class="script-team-group" id="sec-jinxes"><h3 class="script-team-head">Jinxes <span class="script-team-count">(' +
      (jinxes.length + official.length) + ')</span></h3>' +
      '<div class="script-char-list">';
    function side(c) {
      return '<a class="jx-pair-side" href="' + esc(charHref(c, root)) + '">' +
        '<img loading="lazy" decoding="async" class="jx-pair-ico" src="' + esc(artSrc(c, root)) + '" alt=""' +
        ' onerror="this.style.display=\'none\'">' +
        '<span class="jx-pair-name">' + esc(c.name) + '</span></a>';
    }
    jinxes.forEach(function (j) {
      html += '<div class="script-char-row jx-pair-row"><div class="script-char-text">' +
        '<span class="script-char-name jx-pair">' +
          side(j.a) + '<span class="jx-pair-link">&harr;</span>' + side(j.b) +
        '</span>' +
        '<span class="script-char-ability">' + esc(j.text) + '</span></div></div>';
    });
    official.forEach(function (j) {
      html += '<div class="script-char-row jx-pair-row"><div class="script-char-text">' +
        '<span class="script-char-name jx-pair">' +
          side(j.a) + '<span class="jx-pair-link">&harr;</span>' +
          '<a class="jx-pair-side" href="' + esc(j.target.href) + '" target="_blank" rel="noopener noreferrer">' +
            (j.target.iconSrc ? '<img loading="lazy" decoding="async" class="jx-pair-ico" src="' +
              esc(j.target.iconSrc) + '" alt="" onerror="this.style.display=\'none\'">' : '') +
            '<span class="jx-pair-name">' + esc(j.target.name) + '</span></a>' +
        '</span>' +
        '<span class="script-char-ability">' + esc(j.text) + '</span></div></div>';
    });
    return html + '</div></div>';
  }

  /* ── the night order, and the single source of truth for it ──
     The page renders through this and publish-script.html arranges through
     it, so the list the owner drags around IS the list a reader sees, the
     same rule sortCollectionMembers follows for a collection's roster.

     Who acts is never a choice: a character wakes if its own firstNight /
     otherNight is above zero, and the numbers come from the character (for
     official ones, from assets/night-order.json, merged in by
     official-roles.js). What the owner may change is the ORDER, kept on the
     script as `nightOrder: {first: [slug], other: [slug]}`.

     A character the arrangement has not heard of, added since it was last
     saved, is not dumped at the end: it slots in after the last arranged
     character that acts before it does, by night number. */
  function nightItems(entries, order) {
    var buildSchema = dep('buildSchema');
    if (!buildSchema) return { first: [], other: [] };
    var first = [], other = [];
    (entries || []).forEach(function (c) {
      var s;
      try { s = buildSchema(c); } catch (e) { return; }
      if (s.firstNight > 0) first.push({ c: c, n: s.firstNight, r: s.firstNightReminder || '' });
      if (s.otherNight > 0) other.push({ c: c, n: s.otherNight, r: s.otherNightReminder || '' });
    });
    order = order || {};
    return {
      first: sortNightItems(first, order.first),
      other: sortNightItems(other, order.other)
    };
  }

  function sortNightItems(items, orderList) {
    var idx = {};
    (Array.isArray(orderList) ? orderList : []).forEach(function (slug, i) {
      if (idx[slug] == null) idx[slug] = i;
    });
    var arranged = items.filter(function (it) { return idx[it.c.slug] != null; })
      .sort(function (a, b) { return idx[a.c.slug] - idx[b.c.slug]; });
    var keyed = arranged.map(function (it, i) { return { it: it, key: i }; });
    items.forEach(function (it) {
      if (idx[it.c.slug] != null) return;
      var key = -0.5;                    // acts before everything arranged
      for (var i = 0; i < arranged.length; i++) {
        if (arranged[i].n <= it.n) key = i + 0.5;
      }
      keyed.push({ it: it, key: key });
    });
    return keyed.sort(function (a, b) {
      return a.key - b.key || a.it.n - b.it.n ||
        (a.it.c.name || '').localeCompare(b.it.c.name || '');
    }).map(function (x) { return x.it; });
  }

  function renderNightOrder(entries, root, order) {
    var lists = nightItems(entries, order);
    var first = lists.first, other = lists.other;
    if (!first.length && !other.length) return '';
    function list(items) {
      if (!items.length) return '<p class="sv-night-empty">No characters act.</p>';
      return '<ol class="sv-night-list">' + items.map(function (it) {
        return '<li class="sv-night-item">' +
          '<img loading="lazy" decoding="async" class="sv-night-thumb" src="' + esc(artSrc(it.c, root)) + '" alt="" onerror="this.style.display=\'none\'">' +
          '<div class="sv-night-text"><a class="sv-night-name" href="' + esc(charHref(it.c, root)) + '"' + offsite(it.c) + '>' + esc(it.c.name) + offMark(it.c) + '</a>' +
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
    // Co-credited characters count towards each creator separately, so the
    // credits list matches the links on the character pages themselves.
    var split = dep('splitCreators') ||
      function (s) { return String(s || '').split(',').map(function (n) { return n.trim(); }).filter(Boolean); };
    entries.forEach(function (c) {
      if (c.official) return;
      split(c.creator).forEach(function (cr) { counts[cr] = (counts[cr] || 0) + 1; });
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
    // Creator/credit symbol next to the name, same as character info boxes.
    var symFn = dep('creatorSymbol');
    var sym = (typeof symFn === 'function' && opts.author) ? (symFn(opts.author) || '') : '';
    var symHTML = sym ? ' <span class="creator-mark" title="' + esc(opts.author) + '’s symbol" aria-hidden="true">' + esc(sym) + '</span>' : '';
    var authorLink = opts.author
      ? '<a class="author-link" href="' + esc(root) + 'author?a=' + encodeURIComponent(opts.author) + '">' + esc(opts.author) + '</a>'
      : '';
    var rows = '';
    if (opts.author && !opts.authorProminent) {
      rows += '<dt>Author:</dt><dd>' + authorLink + symHTML + '</dd>';
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
      // Prominent author credit sits directly under the logo.
      (opts.author && opts.authorProminent ? '<p class="sv-info-author">by ' + authorLink + symHTML + '</p>' : '') +
      '<h2 class="info-h">Information</h2>' +
      '<dl class="info">' + rows + '</dl></div>';
  }

  /* Curata row for the Information box. Admin-awarded (assets/classify.js);
     Standard pages show nothing, which is the point of Standard. */
  function curataRow(d) {
    if (!d || !d.curata) return [];
    return ['<dt>Status:</dt><dd><span class="curata-mark" ' +
      'title="Awarded by the wiki admins. Shown more often on the homepage and in Featured picks." ' +
      'aria-label="Curata"></span> Curata</dd>'];
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

  /* The id the exported JSON uses for a character, the same one buildSchema
     writes, so a jinx can point at it. */
  function exportId(c) {
    var slugId = dep('slugId');
    return c.jsonId || (slugId ? slugId(c.name) : String(c.name || '').toLowerCase().replace(/[^a-z0-9]/g, ''));
  }

  /* Per-character jinx lists for the export, but ONLY for the characters this
     script's own jinx edits actually touch. Everyone else exports exactly what
     they always did. Returns null when the script has no jinx edits at all. */
  function jinxExportMap(entries, edits) {
    edits = edits || {};
    var off = Array.isArray(edits.off) ? edits.off : [];
    var add = Array.isArray(edits.add) ? edits.add : [];
    if (!off.length && !add.length) return null;

    var bySlug = {}, byId = {};
    (entries || []).forEach(function (c) {
      bySlug[c.slug] = c;
      byId[exportId(c)] = c;
      byId[String(c.slug || '').replace(/-/g, '')] = c;
    });
    var touched = {};
    off.forEach(function (k) {
      String(k).split('|').forEach(function (s) { if (bySlug[s]) touched[s] = 1; });
    });
    add.forEach(function (j) { if (j && bySlug[j.a]) touched[j.a] = 1; });

    var final = scriptJinxes(entries, edits);
    var map = {};
    Object.keys(touched).forEach(function (slug) {
      var c = bySlug[slug];
      // Jinxes this character carries with someone who is NOT on this script
      // stay exactly as written: they are part of the character, and this
      // script has no business editing them out of it.
      var kept = (c.jinxes || []).filter(function (j) {
        var idKey = String(j.id || j.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        return !byId[idKey];
      }).map(function (j) {
        return { id: j.id || exportId({ name: j.name }), reason: j.text || j.reason || '' };
      });
      final.forEach(function (j) {
        if (j.a !== c) return;
        kept.push({ id: exportId(j.b), reason: j.text });
      });
      // Only characters whose jinxes actually CHANGED go in the map. Switching
      // a jinx off touches both ends of the pair, but the text usually lives
      // on one of them, and forcing the other into the map would export an
      // official character as a full object, quietly replacing the app's own
      // copy of it to say nothing at all.
      var before = JSON.stringify((c.jinxes || []).map(function (j) {
        return [j.id || '', j.text || j.reason || ''];
      }));
      var after = JSON.stringify(kept.map(function (j) {
        return [j.id || '', j.reason || ''];
      }));
      if (before !== after) map[slug] = { list: kept };
    });
    return map;
  }

  /* _meta.firstNight / _meta.otherNight: the night as a list of ids, which is
     how the official app is told a script's own order. Only written for a
     script whose owner arranged one. Left out, the app reads each character's
     own number and reaches the same answer.

     The night is not only characters: dusk opens it, dawn closes it, and the
     first night has the minion and demon info steps in the middle. Those
     positions live in assets/night-order.json (`meta`) and are handed in by
     whoever loaded that file; without them this returns null rather than
     write a sequence that would silently drop those steps from the app's
     night sheet. */
  var NIGHT_META = null;
  function setNightMeta(list) { NIGHT_META = Array.isArray(list) ? list : null; }

  function nightSequences(entries, nightOrder) {
    if (!nightOrder || (!(nightOrder.first || []).length && !(nightOrder.other || []).length)) return null;
    if (!NIGHT_META || !NIGHT_META.length) return null;
    var lists = nightItems(entries, nightOrder);
    // `which` names the list ('first' / 'other'); the markers carry their
    // positions under the character field names ('firstNight' / 'otherNight').
    function seq(which) {
      var field = which === 'first' ? 'firstNight' : 'otherNight';
      var marks = NIGHT_META.map(function (m) {
        return { id: m.id, n: Number(m[field]) };
      }).filter(function (m) { return isFinite(m.n); });
      var out = [];
      var items = lists[which].map(function (it) { return { id: exportId(it.c), n: it.n }; });
      // Each marker goes in front of the first character that acts after it.
      marks.sort(function (a, b) { return a.n - b.n; });
      var mi = 0;
      items.forEach(function (it) {
        while (mi < marks.length && marks[mi].n <= it.n) out.push(marks[mi++].id);
        out.push(it.id);
      });
      while (mi < marks.length) out.push(marks[mi++].id);
      return out;
    }
    return { first: seq('first'), other: seq('other') };
  }

  /* Official-schema export: [_meta, ...characters]. Official roles export as
     their bare id; homebrew characters as full objects (same as the builder).

     `sc` is the script itself (optional; collections pass nothing), and fills
     in the rest of the _meta the official app reads:
     background, hideTitle, almanac, bootlegger, and the firstNight /
     otherNight sequences. See the schema at
     github.com/ThePandemoniumInstitute/botc-release.

     Two things here are not just copying fields across:

     - The night sequences are only written when the script's owner actually
       arranged one. Left out, the app orders the night by each character's
       own number, which is the same answer. Writing it out anyway would
       freeze today's answer into the file.
     - A script's own jinxes (jinxEdits) have to be pushed back onto the
       CHARACTERS, because that is where the app reads jinxes from. A character
       that gains or loses one this way is rebuilt from the script's list; one
       the script never touched is exported exactly as it always was. An
       official character normally exports as a bare id, but if this script
       gives it a jinx the bare id has nowhere to carry it, so that one is
       written out in full. */
  function buildPageExport(name, author, headerPath, entries, sc) {
    var buildSchema = dep('buildSchema');
    sc = sc || {};
    var meta = { id: '_meta', name: name || 'Homebrew Script' };
    if (author) meta.author = author;
    if (headerPath) meta.logo = 'https://botchomebrew.wiki/assets/' + headerPath;
    var bg = sc.theme && sc.theme.background;
    if (bg) meta.background = 'https://botchomebrew.wiki/assets/' + bg;
    if (sc.hideTitle) meta.hideTitle = true;
    if (sc.almanac) meta.almanac = sc.almanac;
    var boot = (sc.bootlegger || []).map(function (r) { return String(r || '').trim(); }).filter(Boolean);
    if (boot.length) meta.bootlegger = boot;

    var jinxMap = jinxExportMap(entries, sc.jinxEdits);
    var arr = [meta];
    entries.forEach(function (c) {
      var own = jinxMap && jinxMap[c.slug];
      if (c.official && !own) { arr.push(String(c.slug).replace(/^off-/, '')); return; }
      if (!buildSchema) return;
      var src = c;
      if (own) { src = {}; for (var k in c) src[k] = c[k]; src.jinxes = own.list; }
      arr.push(buildSchema(src));
    });
    var seq = nightSequences(entries, sc.nightOrder);
    if (seq) { meta.firstNight = seq.first; meta.otherNight = seq.other; }
    return JSON.stringify(arr, null, 2);
  }

  /* ── custom wiki pages attached to this script/collection ──
     The page links are rendered by render-wiki.js (the Worker passes the HTML
     in); this only wraps them in the page's section frame and adds the
     owner's "new page" button. These pages appear nowhere else on the wiki,
     so this section is the only route to them. */
  function pagesSection(pagesHTML, newPageHref) {
    if (!pagesHTML && !newPageHref) return '';
    return '<div class="sv-section wiki-pages-section">' +
      sech('sec-pages', 'Pages') +
      (pagesHTML || '<p class="wiki-pages-empty">No pages yet.</p>') +
      (newPageHref
        ? '<a class="cta-secondary wiki-pages-new" href="' + esc(newPageHref) + '">+ Write a page</a>'
        : '') +
      '</div>';
  }

  /* ── owner's edit bar ──
     The pencil in the top bar is easy to miss, and was the only way in: the
     alternative was the account page and a long scroll. The Worker decides who
     gets this and passes the href in; an empty one renders nothing, so it is
     never shown to a reader the API would refuse. */
  function ownerBar(editHref, label) {
    if (!editHref) return '';
    return '<p class="page-owner-bar"><a class="cta-secondary page-owner-edit" href="' +
      esc(editHref) + '">&#9998; ' + esc(label) + '</a></p>';
  }

  /* A Status-box row for a script or collection its creator opened up, with
     the link to its edit log. Characters say the same in their own info box
     (openEditRow in render.js). Only an opened page says anything, which is
     how anybody finds out they are welcome to help. */
  var OPEN_EDIT_TEXT = {
    all: ['open to all', 'anyone with an account can edit this page. '],
    suggest: ['suggestions welcome', 'anyone with an account can propose an edit for the creator to approve. ']
  };
  function openEditRows(d, root, type) {
    var t = OPEN_EDIT_TEXT[d.publicEdit];
    if (!t) return [];
    var key = type === 'script' ? (d.slug || '') : (d.id || d.slug || '');
    var q = 'type=' + esc(type) + '&amp;slug=' + encodeURIComponent(key);
    var links = '<a class="hist-page-link" href="' + esc(root) + 'history?' + q + '">Edit history</a>';
    if (d.publicEdit === 'suggest') {
      links = '<a class="hist-page-link" href="' + esc(root) + 'suggestions?' + q + '">Suggestions</a> ' + links;
    }
    return ['<dt>Editing:</dt><dd class="open-edit-row"><span class="oe-chip">' + t[0] + '</span> ' +
      t[1] + links + '</dd>'];
  }

  /* ── shared page body ── */
  function renderPageBody(cfg) {
    /* cfg: {root, name, header, logo, tagline, author, version, difficulty,
             synopsis, gameplay, strategyGood, strategyEvil, description,
             entries, missing[], jsonText, actions[], extraInfoRows[],
             creditsEntries, pagesHTML, boxesHTML, newPageHref} */
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
    top += ownerBar(cfg.editHref, 'Edit this script');

    var main = '';
    if (cfg.synopsis) main += '<div class="sv-section">' + sech('sec-synopsis', 'Synopsis') + prose(cfg.synopsis) + '</div>';
    var gameplay = '';
    if (cfg.gameplay) gameplay += prose(cfg.gameplay);
    if (cfg.strategyGood) gameplay += '<h3 class="sv-subhead good">Playing Good</h3>' + prose(cfg.strategyGood);
    if (cfg.strategyEvil) gameplay += '<h3 class="sv-subhead">Playing Evil</h3>' + prose(cfg.strategyEvil);
    if (gameplay) main += '<div class="sv-section">' + sech('sec-gameplay', 'Gameplay') + gameplay + '</div>';
    main += pagesSection(cfg.pagesHTML, cfg.newPageHref);

    main += '<div class="sv-section">' +
      (main ? sech('sec-characters', 'Characters') : '') +
      renderRoster(cfg.entries, root) +
      renderJinxGroup(cfg.entries, root, cfg.missing, cfg.jinxEdits) + '</div>';
    main += renderBootlegger(cfg.bootlegger);
    main += renderNightOrder(cfg.entries, root, cfg.nightOrder);
    if (cfg.missing && cfg.missing.length) {
      main += '<p class="script-missing">⚠ ' + cfg.missing.length + ' character' + (cfg.missing.length === 1 ? '' : 's') + ' on this page ' +
        (cfg.missing.length === 1 ? 'is' : 'are') + ' not in the wiki: ' + cfg.missing.map(esc).join(', ') + '</p>';
    }

    var aside = renderInfobox({
      root: root, logoPath: cfg.logo, author: cfg.author, version: cfg.version,
      difficulty: cfg.difficulty, entries: cfg.entries, extraRows: cfg.extraInfoRows
    });
    aside += renderCredits(cfg.creditsEntries || cfg.entries, root);
    aside += cfg.boxesHTML || '';
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
    top += ownerBar(cfg.editHref, 'Edit this collection');

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
    proseHTML += pagesSection(cfg.pagesHTML, cfg.newPageHref);
    // Custom boxes sit below the prose, full width, like the character-page ones.
    if (cfg.boxesHTML) proseHTML += '<div class="coll-boxes">' + cfg.boxesHTML + '</div>';
    var prosePanel = proseHTML ? '<section class="script-chars-panel coll-prose">' + proseHTML + '</section>' : '';

    // Collapsed filter box; card-filters.js fills the bar in the browser.
    var filters = filterBoxHTML('coll');

    // A single character count (updates as filters are applied).
    var count = '<p class="coll-chars-count" id="coll-chars-count">' + n + ' character' + (n === 1 ? '' : 's') + '</p>';

    var chars = '<section class="coll-chars" id="sec-characters">' + count +
      '<div id="coll-grid">' + renderRosterCards(cfg.entries, root, cfg.orderMap) + '</div></section>';

    var jinx = renderJinxGroup(cfg.entries, root, cfg.missing, cfg.jinxEdits);
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
    var jsonText = buildPageExport(sc.name, sc.author, sc.header, entries, sc);

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
      jsonLabel: 'Script JSON', editHref: opts.editHref, nightOrder: sc.nightOrder,
      jinxEdits: sc.jinxEdits, bootlegger: sc.bootlegger,
      pagesHTML: opts.pagesHTML, boxesHTML: opts.boxesHTML, newPageHref: opts.newPageHref,
      extraInfoRows: curataRow(sc).concat(openEditRows(sc, root, 'script'))
    });
  }

  function renderCollectionPage(coll, allChars, opts) {
    opts = opts || {};
    var root = opts.linkRoot || '';
    var members = sortCollectionMembers(coll, resolveCollectionMembers(coll, allChars || []));
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
      jsonLabel: 'Collection JSON', editHref: opts.editHref,
      pagesHTML: opts.pagesHTML, boxesHTML: opts.boxesHTML, newPageHref: opts.newPageHref,
      extraInfoRows: curataRow(coll).concat(openEditRows(coll, root, 'collection'))
    });
  }

  var api = {
    init: init,
    renderScriptPage: renderScriptPage,
    renderCollectionPage: renderCollectionPage,
    renderRosterCards: renderRosterCards,
    nightItems: nightItems,
    filterBoxHTML: filterBoxHTML,
    scriptJinxes: scriptJinxes,
    jinxKey: jinxKey,
    setNightMeta: setNightMeta,
    resolveCollectionMembers: resolveCollectionMembers,
    sortCollectionMembers: sortCollectionMembers,
    sanitizeTheme: sanitizeTheme,
    themeAttrs: themeAttrs,
    buildPageExport: buildPageExport,
    FONT_PRESETS: FONT_PRESETS,
    DIFFICULTY_LABEL: DIFFICULTY_LABEL
  };
  if (typeof window !== 'undefined') { window.PageRender = api; }
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})();
