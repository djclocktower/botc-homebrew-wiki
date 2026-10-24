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

  /* The quick-action slot under a card's icon (assets/card-actions.js). The
     Worker hands the module in through setCardActions(); in the browser it is
     window.CardActions. Without either, cards simply draw no slot. */
  var cardActions = null;
  function setCardActions(ca) { cardActions = ca || null; }
  function quickSlot(c) {
    var ca = cardActions || (typeof window !== 'undefined' ? window.CardActions : null);
    return ca && ca.slotHTML ? ca.slotHTML(c) : '';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function tok(s) {
    // Bounded, like render.js's tok(): a run of '[[' that never closes is
    // one pass rather than a rescan of the text from every one of them.
    return esc(s).replace(/\[\[([^\]\n]{1,160})\]\]/g, '<span class="tok">$1</span>');
  }
  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }

  var TEAMS = [
    ['townsfolk', 'Townsfolk'], ['outsider', 'Outsider'], ['minion', 'Minion'],
    ['demon', 'Demon'], ['traveller', 'Traveller'], ['fabled', 'Fabled'],
    ['loric', 'Loric'], ['other', 'Other']
  ];
  // A team this list does not know (a typo in an old import) is drawn with
  // Other rather than vanishing from the roster.
  function teamOf(c) {
    for (var i = 0; i < TEAMS.length; i++) if (TEAMS[i][0] === c.team) return c.team;
    return 'other';
  }
  /* An Other character may name its own type ("Spirit"). Its card says so,
     and so does its team's heading and count, when every Other character on
     the page shares the one name; a mix keeps the plain "Other". */
  function typeNameOf(c) {
    return (c && c.team === 'other' && String(c.typeName || '').trim()) || '';
  }
  function groupLabel(key, label, grp) {
    if (key !== 'other' || !grp.length) return label;
    var n = typeNameOf(grp[0]);
    for (var i = 1; n && i < grp.length; i++) if (typeNameOf(grp[i]) !== n) n = '';
    return n || label;
  }
  var GOOD = { townsfolk: 1, outsider: 1 };
  // Blue for good, the wiki's purple for Other, the stylesheet's red else.
  function teamCls(t) { return GOOD[t] ? ' good' : t === 'other' ? ' other' : ''; }
  var DIFFICULTY_LABEL = {
    beginner: 'Beginner', intermediate: 'Intermediate', veteran: 'Veteran'
  };

  /* ── Theme ──
     Stored as data.theme on scripts, collections, wiki pages, news and (in
     profile_json) on an account's creator page. Every value is validated by
     sanitizeTheme (server AND client) and only ever applied as CSS custom
     properties / whitelisted class names. The one exception is `css`, the
     custom stylesheet, which is cleaned and scoped by assets/custom-css.js
     before it is printed — never by this file.

     The kit has three layers, and the editor (assets/theme-editor.js) shows
     them in that order: a one-click style (THEME_PRESETS — nothing but a
     bundle of the same fields), the individual knobs below, and the custom
     CSS box for everything else. */
  var FONT_PRESETS = {
    'default':   'Wiki default',
    'dumbledor': 'Dumbledor',
    'trade':     'Trade Gothic',
    'oswald':    'Oswald',
    'roboto':    'Roboto',
    'franklin':  'Libre Franklin',
    'garamond':  'EB Garamond',
    'notoserif': 'Noto Serif',
    'cinzel':    'Cinzel',
    'pirata':    'Pirata One',
    'imfell':    'IM Fell English',
    'grenze':    'Grenze Gotisch',
    'unlovable': 'LHF Unlovable',
    'georgia':   'Georgia (classic serif)',
    'system':    'System sans-serif',
    'mono':      'Typewriter (monospace)',
    'comic':     'Comic Sans'
  };
  /* The font stack each preset stands for. Every face here is self-hosted in
     assets/fonts (declared in styles.css) or a system font, so a preset never
     reaches another origin; a Google Font is the separate `gFont` field. */
  var FONT_STACKS = {
    'dumbledor': "'Dumbledor2', serif",
    'trade':     "'TradeGothicLT', 'Libre Franklin', sans-serif",
    'oswald':    "'Oswald', sans-serif",
    'roboto':    "'Roboto', sans-serif",
    'franklin':  "'Libre Franklin', sans-serif",
    'garamond':  "'EB Garamond', serif",
    'notoserif': "'Noto Serif', serif",
    'cinzel':    "'Cinzel', serif",
    'pirata':    "'Pirata One', serif",
    'imfell':    "'IM Fell English', serif",
    'grenze':    "'Grenze Gotisch', serif",
    'unlovable': "'LHFUnlovable', 'Dumbledor2', serif",
    'georgia':   "Georgia, 'Times New Roman', serif",
    'system':    "system-ui, -apple-system, 'Segoe UI', sans-serif",
    'mono':      "'Courier New', Courier, monospace",
    'comic':     "'Comic Sans MS', 'Comic Neue', 'Chalkboard SE', cursive"
  };

  /* How far the top graphic may be scaled, as a percentage of the wiki's own
     size for it. The floor is "still recognisably a logo" and the ceiling is
     "still inside the page" — above 250 the header would push everything else
     below the fold on a phone. */
  var LOGO_SIZE_MIN = 25;
  var LOGO_SIZE_MAX = 250;
  /* The custom stylesheet's ceiling, in characters. Room for a real theme
     with a few small data: images, small enough that it never dominates the
     page it sits in. Cut, not refused, so a save never fails on it. */
  var THEME_CSS_MAX = 30000;

  /* The numeric knobs: [key, min, max, the value that means "not set"].
     A value equal to the neutral one is never stored, so a page nobody
     touched keeps following the stylesheet. `null` neutral: any in-range
     value is a choice (0 corners and no border both mean something). */
  var THEME_NUMBERS = [
    ['bgAngle',    0, 360, null],
    ['bgDim',      0,  90, 0],
    ['bgBlur',     0,  20, 0],
    ['panelAlpha', 0, 100, 100],
    ['radius',     0,  40, null],
    ['borderW',    0,   8, null],
    ['textScale', 75, 150, 100],
    // Character boxes (collection/creator cards, script roster rows)
    ['cardAlpha',   0, 100, 100],
    ['cardBorderW', 0,   8, null],
    ['cardRadius',  0,  40, null],
    ['cardIcon',   50, 200, 100],
    // Team headings and dividers
    ['teamSize',   50, 250, 100],
    ['ruleW',       0,  12, null],
    // Layout: how big things are and where they sit (THEME_LAYOUT_KEYS)
    ['cardW',     140, 700, null],
    ['cardCols',    1,   8, null],
    ['cardGap',     0,  80, null],
    ['cardPad',     0,  48, null],
    ['pageW',     600, 2400, null],
    ['panelPad',    0,  64, null],
    ['secGap',      0, 120, null],
    ['infoW',     200, 640, null],
    ['titleSize',  50, 250, 100]
  ];
  // The pick-one knobs and what each may say.
  var THEME_CHOICES = {
    bgFit:    ['cover', 'contain', 'tile', 'stretch', 'center'],
    bgPos:    ['top', 'center', 'bottom'],
    shadow:   ['none', 'soft', 'strong', 'glow'],
    width:    ['narrow', 'wide', 'full'],
    headCase: ['upper', 'lower', 'caps', 'none'],
    align:    ['center', 'justify'],
    cardShadow: ['none', 'soft', 'strong', 'glow'],
    cardHover:  ['none', 'lift', 'grow', 'glow'],
    teamAlign:  ['left', 'center', 'right'],
    teamCase:   ['upper', 'lower', 'caps', 'none'],
    ruleStyle:  ['fade', 'solid', 'dashed', 'dotted', 'double', 'glow', 'none'],
    cardLayout: ['side', 'top', 'right'],
    cardAlign:  ['left', 'center', 'right'],
    cardAbility: ['full', 'short', 'hide'],
    infoPos:    ['right', 'left', 'top', 'bottom'],
    topAlign:   ['left', 'center', 'right']
  };
  /* The sections a page's owner may put in another order (theme.order).
     Each page kind draws its own few; a key a page does not draw sets a
     custom property nothing reads. Listed per kind for the editor. */
  var THEME_SECTIONS = {
    script: [['synopsis', 'Synopsis'], ['gameplay', 'Gameplay'], ['pages', 'Pages'],
      ['characters', 'Characters and jinxes'], ['bootlegger', 'Bootlegger rules'], ['night', 'Night order']],
    collection: [['info', 'Information and JSON'], ['about', 'Synopsis, gameplay and boxes'],
      ['characters', 'Characters'], ['jinx', 'Jinxes']],
    profile: [['pinned', 'Pinned'], ['characters', 'Characters'], ['scripts', 'Scripts'],
      ['collections', 'Collections'], ['pages', 'Pages']]
  };
  var SECTION_KEYS = Object.create(null);
  Object.keys(THEME_SECTIONS).forEach(function (k) {
    THEME_SECTIONS[k].forEach(function (s) { SECTION_KEYS[s[0]] = true; });
  });
  /* ── Moves: any part of a page dragged to where its owner wants it ──
     theme.moves = {key: [x, y]}, an offset in CSS pixels from where the page
     would have put that part. A key names a part (MOVABLE), a character box
     ('c:' + identity), a team block ('t:' + team) or a creator-page section
     ('s:' + section). They become `translate` rules (movesCSS), so the page
     keeps its flow and its space: a moved part only LOOKS moved, nothing
     else reflows around it, and taking a move off puts it back exactly.
     Wide screens only: offsets made on a desktop would throw a phone's
     one-column page apart, so a phone always gets the page as laid out. */
  var MOVABLE = {
    title:      ['Title', '.script-title-fallback, .coll-title, .wiki-title, .news-article h1'],
    banner:     ['Banner', '.script-header-wrap, .coll-header-wrap, .wiki-banner-wrap, .news-hero'],
    logo:       ['Logo', '.sv-logo-wrap'],
    tagline:    ['Tagline', '.sv-tagline, .wiki-subtitle'],
    desc:       ['Description', '.script-desc'],
    meta:       ['Byline', '.script-meta-line, .wiki-meta'],
    favs:       ['Favorites button', '.page-fav-bar'],
    head:       ['Title box', '.wiki-page-head'],
    info:       ['Information box', '.script-json-panel, .coll-meta-row, .wiki-side'],
    main:       ['Main box', '.sv-main, .coll-prose, .wiki-body, .news-body'],
    synopsis:   ['Synopsis', '.sv-s-synopsis'],
    gameplay:   ['Gameplay', '.sv-s-gameplay'],
    pages:      ['Pages', '#page-wiki-links'],
    characters: ['Characters', '.sv-s-characters, .coll-chars'],
    filters:    ['Filter box', '.coll-filters'],
    count:      ['Character count', '.coll-chars-count'],
    jinx:       ['Jinxes', '.coll-jinx'],
    night:      ['Night order', '#sec-nightorder'],
    bootlegger: ['Bootlegger rules', '.sv-bootlegger'],
    hero:       ['Top of the page', '.home-hero'],
    avatar:     ['Picture', '.profile-avatar'],
    name:       ['Name', '.profile-hero-text h1'],
    bio:        ['Bio', '.profile-bio'],
    links:      ['Links', '.profile-links']
  };
  var MOVE_TEAMS = /^t:(townsfolk|outsider|minion|demon|traveller|fabled|loric|other)$/;
  var MOVE_SECS = /^s:(pinned|characters|scripts|collections|pages)$/;
  var MOVE_CHAR = /^c:[a-z0-9][a-z0-9_-]{0,119}$/;
  var MOVES_MAX = 400, MOVE_LIMIT = 3000;
  function moveSelector(key) {
    if (Object.prototype.hasOwnProperty.call(MOVABLE, key)) return MOVABLE[key][1];
    var v = key.slice(2);
    if (MOVE_CHAR.test(key)) return '.char-card[data-slug="' + v + '"], .script-char-row[data-slug="' + v + '"]';
    if (MOVE_TEAMS.test(key)) return '.type-section[data-team="' + v + '"], .script-team-group[data-team="' + v + '"]';
    if (MOVE_SECS.test(key)) return '.prof-panel > [data-sec="' + v + '"]';
    return '';
  }
  function sanitizeMoves(m) {
    var out = {}, n = 0;
    if (!m || typeof m !== 'object' || Array.isArray(m)) return out;
    Object.keys(m).forEach(function (k) {
      if (n >= MOVES_MAX || !moveSelector(k)) return;
      var v = m[k];
      if (!Array.isArray(v) || v.length !== 2) return;
      var x = Math.round(Number(v[0])), y = Math.round(Number(v[1]));
      if (!isFinite(x) || !isFinite(y)) return;
      x = Math.max(-MOVE_LIMIT, Math.min(MOVE_LIMIT, x));
      y = Math.max(-MOVE_LIMIT, Math.min(MOVE_LIMIT, y));
      if (!x && !y) return;
      out[k] = [x, y]; n++;
    });
    return out;
  }
  // Built only from whitelisted selectors, validated keys and integers.
  function movesCSS(moves) {
    var m = sanitizeMoves(moves), rules = [];
    Object.keys(m).forEach(function (k) {
      // On top of what it was dragged over. `position` is what lets z-index
      // work on an ordinary block; a script's side column is sticky (already
      // positioned), so it keeps its own.
      moveSelector(k).split(',').forEach(function (sel) {
        sel = sel.trim();
        rules.push('.tl-moved ' + sel + '{translate:' + m[k][0] + 'px ' + m[k][1] + 'px;' +
          (sel === '.script-json-panel' ? '' : 'position:relative;') + 'z-index:5}');
      });
    });
    return rules.length ? '@media (min-width: 901px){' + rules.join('') + '}' : '';
  }

  function sanitizeOrder(list) {
    if (!Array.isArray(list)) return [];
    var out = [];
    list.forEach(function (k) {
      if (typeof k === 'string' && SECTION_KEYS[k] && out.indexOf(k) < 0 && out.length < 16) out.push(k);
    });
    return out;
  }
  var THEME_COLORS = ['accent', 'panel', 'text', 'link', 'bgColor', 'bgColor2', 'border', 'glow', 'heading',
    'cardBg', 'cardText', 'cardName', 'cardAccent', 'cardBorder',
    'teamColor', 'teamBg', 'teamGlow', 'ruleColor'];
  // The font slots: a preset key each, or a Google family that replaces it.
  var THEME_FONTS = [['font', 'gFont'], ['bodyFont', 'gBodyFont'], ['cardFont', 'gCardFont'], ['teamFont', 'gTeamFont']];
  /* A Google Fonts family name: letters, digits and spaces, which is every
     family Google serves. Nothing else may reach the stylesheet URL or the
     font stack, so a name can never close a quote or a url(). */
  var GOOGLE_FONT_RE = /^[A-Za-z0-9][A-Za-z0-9 ]{0,48}[A-Za-z0-9]$/;

  function sanitizeTheme(theme, allowedBgBase) {
    if (!theme || typeof theme !== 'object') return null;
    var out = {};
    THEME_FONTS.forEach(function (f) {
      var k = f[0], g = f[1];
      if (typeof theme[k] === 'string' &&
          Object.prototype.hasOwnProperty.call(FONT_STACKS, theme[k])) {
        out[k] = theme[k];
      }
      var v = typeof theme[g] === 'string' ? theme[g].trim().replace(/\s+/g, ' ') : '';
      if (GOOGLE_FONT_RE.test(v)) out[g] = v;
    });
    THEME_COLORS.forEach(function (k) {
      var v = theme[k];
      if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim())) {
        out[k] = v.trim().toLowerCase();
      }
    });
    if (typeof theme.background === 'string' && allowedBgBase) {
      var m = theme.background.match(/^([a-z0-9/-]+)-bg\.(png|jpe?g|webp)$/i);
      if (m && m[1] === allowedBgBase) out.background = theme.background;
    }
    /* The top graphic's size. TWO settings, because they are two images: a
       page with a header banner still has a logo, which the header hides at
       the top of the page but the information box goes on showing — so one
       number could not say "this banner is too tall" and "this logo is too
       small" at the same time. `headerSize` sizes the banner, `logoSize` the
       logo; whichever of the two the page is actually showing at the top is
       the one the reader sees change.

       Both are a PERCENTAGE of the size the wiki would have drawn the image
       at, so 100 is "leave it alone" and is never stored — an image the
       author never touched keeps following whatever the stylesheet says. It
       becomes a multiplier on the existing max-width/max-height rules rather
       than a width of its own, so a small image is still never blown up past
       its own pixels and the mobile cap still applies.

       `logoPanel` puts a parchment card behind whichever one is on top: art
       drawn for a light background disappears against the wiki's purple, and
       the alternative was asking every author to re-export it. */
    ['logoSize', 'headerSize'].forEach(function (k) {
      var n = Math.round(Number(theme[k]));
      if (isFinite(n) && n >= LOGO_SIZE_MIN && n <= LOGO_SIZE_MAX && n !== 100) out[k] = n;
    });
    if (theme.logoPanel === true || theme.logoPanel === 'on' || theme.logoPanel === 1) {
      out.logoPanel = true;
    }
    THEME_NUMBERS.forEach(function (r) {
      var v = theme[r[0]];
      // '' and null are "not set", not zero (Number('') is 0).
      if (v === '' || v == null || typeof v === 'boolean') return;
      var n = Math.round(Number(v));
      if (isFinite(n) && n >= r[1] && n <= r[2] && n !== r[3]) out[r[0]] = n;
    });
    Object.keys(THEME_CHOICES).forEach(function (k) {
      if (THEME_CHOICES[k].indexOf(theme[k]) >= 0) out[k] = theme[k];
    });
    if (typeof theme.css === 'string' && theme.css.trim()) {
      out.css = theme.css.slice(0, THEME_CSS_MAX);
    }
    var st = sanitizeStickers(theme.stickers, allowedBgBase);
    if (st.length) out.stickers = st;
    var ord = sanitizeOrder(theme.order);
    if (ord.length) out.order = ord;
    var mv = sanitizeMoves(theme.moves);
    if (Object.keys(mv).length) out.moves = mv;
    return Object.keys(out).length ? out : null;
  }

  /* ── Stickers: free-standing images on the page ──
     A GIF, PNG, JPEG or WebP placed anywhere on a page, at any size, turned,
     faded, flipped, animated, in front of the page's boxes or behind them,
     scrolling with the page or pinned to the screen. Stored as
     theme.stickers = [{src, x, y, w, rot, opacity, flip, layer, pin, anim,
     hideSmall}]. x and y are the sticker's CENTRE as a percentage of the
     page area (or of the screen, for a pinned one), so a placement survives a
     phone's narrower, taller page; w is its width in px, never wider than
     90% of the screen.

     `src` is the one thing a writer controls that reaches markup, so it is
     whitelisted: an https:// address (never an /api/ path), or an image this
     page uploaded into its own slot, {base}-st{n}.{ext} — the same base its
     background lives under. Every number is clamped and rounded, every word
     is from a list, and stickersHTML() escapes on top of that. A sticker
     never takes a click (pointer-events: none in styles.css), so an image
     can be anything but a link. */
  var STICKERS_MAX = 24;
  var STICKER_ANIMS = ['spin', 'bob', 'wiggle', 'pulse', 'blink'];
  var STICKER_DEFAULTS = { x: 85, y: 12, w: 140, rot: 0, opacity: 100 };
  function clampNum(v, lo, hi, dflt) {
    var n = Math.round(Number(v));
    return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
  }
  function stickerSrcOk(src, base) {
    src = typeof src === 'string' ? src.trim() : '';
    if (!src || src.length > 2000) return '';
    var m = src.match(/^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(\/[^\s"'<>\\()`]*)?$/);
    if (m) return /^\/api(\/|$)/i.test(m[1] || '') ? '' : src;
    if (!base) return '';
    var esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('^' + esc + '-st\\d{1,2}\\.(png|jpe?g|gif|webp)$', 'i').test(src) ? src : '';
  }
  function sanitizeStickers(list, base) {
    var out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length && out.length < STICKERS_MAX; i++) {
      var t = list[i];
      if (!t || typeof t !== 'object') continue;
      var src = stickerSrcOk(t.src, base);
      if (!src) continue;
      var o = {
        src: src,
        x: clampNum(t.x, -20, 120, STICKER_DEFAULTS.x),
        y: clampNum(t.y, -20, 120, STICKER_DEFAULTS.y),
        w: clampNum(t.w, 12, 1200, STICKER_DEFAULTS.w),
        rot: clampNum(t.rot, -180, 180, 0),
        opacity: clampNum(t.opacity, 5, 100, 100),
        layer: t.layer === 'back' ? 'back' : 'front',
        pin: t.pin === 'screen' ? 'screen' : 'page'
      };
      if (t.flip === true) o.flip = true;
      if (STICKER_ANIMS.indexOf(t.anim) >= 0) o.anim = t.anim;
      if (t.hideSmall === true) o.hideSmall = true;
      out.push(o);
    }
    return out;
  }
  /* The markup for a SANITIZED list (sanitizeTheme's output). The page
     draws it inside its main area, outside the custom-CSS frame, so an
     author's stylesheet cannot reach the stickers and the frame's paint
     containment cannot trap a pinned one. */
  function stickersHTML(list) {
    if (!Array.isArray(list) || !list.length) return '';
    return '<div class="pg-stickers" aria-hidden="true">' + list.map(function (s) {
      var src = /^https:/i.test(s.src) ? s.src : '/assets/' + s.src;
      var cls = 'pg-sticker pgs-' + (s.layer === 'back' ? 'back' : 'front') +
        (s.pin === 'screen' ? ' pgs-fixed' : '') +
        (STICKER_ANIMS.indexOf(s.anim) >= 0 ? ' pgs-anim-' + s.anim : '') +
        (s.hideSmall ? ' pgs-hide-small' : '');
      var style = 'left:' + Number(s.x) + '%;top:' + Number(s.y) + '%;width:' + Number(s.w) + 'px;' +
        '--pgs-r:' + Number(s.rot) + 'deg;--pgs-o:' + (Number(s.opacity) / 100) + ';--pgs-fx:' + (s.flip ? -1 : 1);
      return '<img class="' + cls + '" src="' + esc(src) + '" alt="" loading="lazy" decoding="async" ' +
        'referrerpolicy="no-referrer" draggable="false" style="' + style + '">';
    }).join('') + '</div>';
  }

  var SHADOWS = {
    none:   'none',
    soft:   '0 4px 14px rgba(0,0,0,.28)',
    strong: '0 12px 32px rgba(0,0,0,.6)'
  };
  var BG_FIT = {
    cover: 'cover no-repeat', contain: 'contain no-repeat', tile: 'auto repeat',
    stretch: '100% 100% no-repeat', center: 'auto no-repeat'
  };

  function hexA(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /* The Google Fonts stylesheets a sanitized theme asks for (0, 1 or 2). The
     plain family request: asking for weights a family does not have fails the
     whole stylesheet, and the browser synthesises bold well enough. */
  function themeFontLinks(theme) {
    var out = [];
    if (!theme) return out;
    THEME_FONTS.forEach(function (f) {
      var k = f[1];
      if (theme[k] && GOOGLE_FONT_RE.test(theme[k])) {
        var href = 'https://fonts.googleapis.com/css2?family=' +
          theme[k].replace(/ /g, '+') + '&display=swap';
        if (out.indexOf(href) < 0) out.push(href);
      }
    });
    return out;
  }

  /* Build the class list + inline style for <body> from a sanitized theme.
     Callers MUST pass the theme through sanitizeTheme first (the Worker does
     this on save and again at render time). `linkRoot` is accepted for the
     callers that pass it but no longer shapes anything — see the background
     note below for why the one URL here must not be relative.
     Every value written into `style` is a validated hex colour, a number, a
     constant from this file or a GOOGLE_FONT_RE name, so nothing a writer
     typed can close the declaration it sits in. */
  function themeAttrs(theme, linkRoot) {
    if (!theme) return { cls: '', style: '', fonts: [], movesCss: '' };
    var cls = ['page-themed'];
    var style = [];
    if (theme.font) cls.push('theme-font-' + theme.font);
    if (theme.gFont) style.push("--pg-font:'" + theme.gFont + "', serif");
    else if (theme.font && FONT_STACKS[theme.font]) style.push('--pg-font:' + FONT_STACKS[theme.font]);
    var bodyStack = theme.gBodyFont ? ("'" + theme.gBodyFont + "', sans-serif")
      : (theme.bodyFont && FONT_STACKS[theme.bodyFont]);
    if (bodyStack) { cls.push('theme-bfont'); style.push('--pg-bfont:' + bodyStack); }
    if (theme.accent) { cls.push('theme-accent'); style.push('--pg-accent:' + theme.accent); }
    if (theme.heading) { cls.push('theme-heading'); style.push('--pg-heading:' + theme.heading); }
    if (theme.panel)  { cls.push('theme-panel');  style.push('--pg-panel:' + theme.panel); }
    if (theme.text)   { cls.push('theme-text');   style.push('--pg-text:' + theme.text); }
    if (theme.link)   { cls.push('theme-link');   style.push('--pg-link:' + theme.link); }
    if (theme.panelAlpha != null && theme.panelAlpha !== 100) {
      cls.push('theme-alpha');
      style.push('--pg-alpha:' + theme.panelAlpha + '%');
    }
    if (theme.radius != null) { cls.push('theme-radius'); style.push('--pg-radius:' + theme.radius + 'px'); }
    if (theme.borderW != null || theme.border) {
      cls.push('theme-border');
      style.push('--pg-bw:' + (theme.borderW != null ? theme.borderW : 2) + 'px');
      if (theme.border) style.push('--pg-border:' + theme.border);
    }
    if (theme.shadow) {
      cls.push('theme-shadow');
      style.push('--pg-shadow:' + (theme.shadow === 'glow'
        ? '0 0 22px ' + hexA(theme.glow || theme.accent || '#e8c66a', .75)
        : SHADOWS[theme.shadow]));
    }
    if (theme.glow) {
      cls.push('theme-glow');
      style.push('--pg-glow:0 0 6px ' + hexA(theme.glow, .9) + ',0 0 16px ' + hexA(theme.glow, .6));
    }
    if (theme.textScale) { cls.push('theme-scale'); style.push('--pg-scale:' + (theme.textScale / 100)); }

    /* Character boxes, team headings and dividers: one class per setting
       (tc-* / tt-* / tr-*), so an untouched setting keeps the stylesheet's
       own look, and a custom property carrying the value. */
    function stack(k, g, fallback) {
      return theme[g] ? "'" + theme[g] + "', " + fallback : (theme[k] && FONT_STACKS[theme[k]]);
    }
    function on(c, prop, val) { cls.push(c); if (prop) style.push(prop + ':' + val); }
    if (theme.cardBg || theme.cardAlpha != null) {
      on('tc-bg', theme.cardBg ? '--pg-card-bg' : '', theme.cardBg);
      if (theme.cardAlpha != null) style.push('--pg-card-alpha:' + theme.cardAlpha + '%');
    }
    if (theme.cardText) on('tc-text', '--pg-card-text', theme.cardText);
    if (theme.cardName) on('tc-name', '--pg-card-name', theme.cardName);
    if (theme.cardAccent) on('tc-accent', '--pg-card-accent', theme.cardAccent);
    var cardStack = stack('cardFont', 'gCardFont', 'serif');
    if (cardStack) on('tc-font', '--pg-card-font', cardStack);
    if (theme.cardBorder || theme.cardBorderW != null) {
      cls.push('tc-border');
      style.push('--pg-card-bw:' + (theme.cardBorderW != null ? theme.cardBorderW : 2) + 'px');
      if (theme.cardBorder) style.push('--pg-card-border:' + theme.cardBorder);
    }
    if (theme.cardRadius != null) on('tc-radius', '--pg-card-radius', theme.cardRadius + 'px');
    var cardGlow = hexA(theme.cardAccent || theme.glow || theme.accent || '#e8c66a', .8);
    if (theme.cardShadow) {
      on('tc-shadow', '--pg-card-shadow', theme.cardShadow === 'glow' ? '0 0 18px ' + cardGlow : SHADOWS[theme.cardShadow]);
    }
    if (theme.cardHover) { cls.push('tc-hover-' + theme.cardHover); style.push('--pg-card-glow:' + cardGlow); }
    if (theme.cardBg || theme.cardAlpha != null || theme.cardBorder || theme.cardBorderW != null ||
        theme.cardRadius != null || theme.cardShadow) cls.push('tc-box');
    if (theme.cardIcon) on('tc-icon', '--pg-card-icon', theme.cardIcon / 100);
    var teamStack = stack('teamFont', 'gTeamFont', 'serif');
    if (teamStack) on('tt-font', '--pg-team-font', teamStack);
    if (theme.teamColor) on('tt-color', '--pg-team-color', theme.teamColor);
    if (theme.teamBg) on('tt-bg', '--pg-team-bg', theme.teamBg);
    if (theme.teamGlow) on('tt-glow', '--pg-team-glow', '0 0 6px ' + hexA(theme.teamGlow, .9) + ',0 0 14px ' + hexA(theme.teamGlow, .6));
    if (theme.teamSize) on('tt-size', '--pg-team-size', theme.teamSize / 100);
    if (theme.teamAlign) cls.push('tt-align-' + theme.teamAlign);
    if (theme.teamCase) cls.push('tt-case-' + theme.teamCase);
    if (theme.ruleStyle || theme.ruleColor || theme.ruleW != null) {
      cls.push('tr-' + (theme.ruleStyle || 'fade'));
      if (theme.ruleColor) style.push('--pg-rule:' + theme.ruleColor);
      if (theme.ruleW != null) style.push('--pg-rule-w:' + theme.ruleW + 'px');
    }
    if (theme.width) cls.push('theme-width-' + theme.width);
    /* Layout: tl-* classes, read by the "Theme kit: layout" block of
       styles.css. Sizes are custom properties; positions are classes. */
    if (theme.cardW) on('tl-cardw', '--pg-card-w', theme.cardW + 'px');
    if (theme.cardCols) on('tl-cols', '--pg-cols', theme.cardCols);
    if (theme.cardGap != null) on('tl-gap', '--pg-card-gap', theme.cardGap + 'px');
    if (theme.cardPad != null) on('tl-pad', '--pg-card-pad', theme.cardPad + 'px');
    if (theme.cardLayout && theme.cardLayout !== 'side') cls.push('tl-card-' + theme.cardLayout);
    if (theme.cardAlign) cls.push('tl-calign-' + theme.cardAlign);
    if (theme.cardAbility && theme.cardAbility !== 'full') cls.push('tl-ab-' + theme.cardAbility);
    if (theme.pageW) on('tl-pagew', '--pg-page-w', theme.pageW + 'px');
    if (theme.panelPad != null) on('tl-ppad', '--pg-panel-pad', theme.panelPad + 'px');
    if (theme.secGap != null) on('tl-gapy', '--pg-sec-gap', theme.secGap + 'px');
    if (theme.infoW) on('tl-infow', '--pg-info-w', theme.infoW + 'px');
    if (theme.infoPos && theme.infoPos !== 'right') cls.push('tl-info-' + theme.infoPos);
    if (theme.titleSize) on('tl-title', '--pg-title', theme.titleSize / 100);
    if (theme.topAlign) cls.push('tl-top-' + theme.topAlign);
    var ord = sanitizeOrder(theme.order);
    if (ord.length) {
      cls.push('tl-order');
      ord.forEach(function (k, n) { style.push('--pg-o-' + k + ':' + (n + 1)); });
    }
    if (ord.length || theme.secGap != null) cls.push('tl-flow');
    var movesCss = movesCSS(theme.moves);
    if (movesCss) cls.push('tl-moved');
    if (theme.headCase) cls.push('theme-hcase-' + theme.headCase);
    if (theme.align) cls.push('theme-align-' + theme.align);

    /* The page background: one composed `background` value on the fixed
       body::before layer (the same mobile-safe layer the wiki always paints
       on), so image, darkening, fit and colour/gradient cannot fight each
       other across rules. Layers, top first: the darkening veil, the image,
       then the colour or gradient underneath. */
    if (theme.background || theme.bgColor || theme.bgColor2 || theme.bgDim) {
      var layers = [];
      if (theme.bgDim) {
        var dim = 'rgba(0,0,0,' + (theme.bgDim / 100) + ')';
        layers.push('linear-gradient(' + dim + ',' + dim + ')');
      }
      if (theme.background) {
        /* ROOT-ABSOLUTE, never linkRoot-relative. This url() sits inside a
           custom property on <body>, and Chromium resolves a relative url() in
           a custom property against the STYLESHEET where var() consumes it,
           not the document that declared it. The stylesheet used to live at
           /assets/styles.css, where '../assets/x-bg.png' came out right by
           accident; the build now serves it from /assets/immutable/, so the
           same string resolved to /assets/assets/x-bg.png and every custom
           background on the site 404'd. '/assets/...' reads the same from any
           base URL, so no stylesheet move can break it again. */
        layers.push('url("/assets/' + theme.background + '") center ' +
          (theme.bgPos || 'top') + ' / ' + BG_FIT[theme.bgFit || 'cover']);
      }
      if (theme.bgColor2) {
        layers.push('linear-gradient(' + (theme.bgAngle != null ? theme.bgAngle : 180) + 'deg,' +
          (theme.bgColor || '#2a0f24') + ',' + theme.bgColor2 + ')');
      }
      // The colour goes on the last layer, the only one allowed one.
      var base = theme.bgColor || 'var(--purple-deep)';
      if (layers.length) layers[layers.length - 1] += ' ' + base;
      else layers.push(base);
      cls.push('theme-bg');
      style.push('--pg-bgl:' + layers.join(','));
    }
    if (theme.bgBlur) { cls.push('theme-blur'); style.push('--pg-blur:' + theme.bgBlur + 'px'); }
    /* Both of these are carried by the class list on <body> and read by
       styles.css, so the page markup itself is untouched: the same rules
       cover the script header, the collection header and the bare logo. */
    if (theme.logoSize) {
      cls.push('theme-logo-size');
      style.push('--pg-logo-scale:' + (theme.logoSize / 100));
    }
    if (theme.headerSize) {
      cls.push('theme-header-size');
      style.push('--pg-header-scale:' + (theme.headerSize / 100));
    }
    if (theme.logoPanel) cls.push('theme-logo-panel');
    return { cls: cls.join(' '), style: style.join(';'), fonts: themeFontLinks(theme), movesCss: movesCss };
  }

  /* One-click styles: each is a bundle of the fields above and nothing else,
     so a preset is just a starting point the knobs can then move. Applying
     one replaces the STYLE fields and leaves the page's own images, image
     sizes and custom CSS alone (see ThemeEditor.applyPreset). */
  /* Layout is kept apart from the style fields: picking a quick style
     recolours a page, it does not undo how the owner arranged it. */
  var THEME_LAYOUT_KEYS = ['width', 'cardW', 'cardCols', 'cardGap', 'cardPad', 'cardLayout', 'cardAlign',
    'cardAbility', 'pageW', 'panelPad', 'secGap', 'infoW', 'infoPos', 'titleSize', 'topAlign', 'order', 'moves'];
  var THEME_STYLE_KEYS = THEME_FONTS.reduce(function (a, f) { return a.concat(f); }, []).concat(THEME_COLORS)
    .concat(THEME_NUMBERS.map(function (r) { return r[0]; }))
    .concat(Object.keys(THEME_CHOICES))
    .filter(function (k) { return THEME_LAYOUT_KEYS.indexOf(k) < 0; });
  var THEME_PRESETS = {
    'default':  { label: 'Wiki default', t: {} },
    'midnight': { label: 'Midnight', t: { font: 'cinzel', accent: '#d9c27a', heading: '#f3e3a8', panel: '#141a2e', text: '#dfe4f2', link: '#8fb8ff', bgColor: '#05070f', bgColor2: '#1b2448', bgAngle: 160, panelAlpha: 92, radius: 10, border: '#3a4670', borderW: 1, shadow: 'strong' } },
    'bloodmoon': { label: 'Blood Moon', t: { font: 'grenze', accent: '#ff5a4f', heading: '#ffb3a8', panel: '#1e0607', text: '#f1d9d4', link: '#ff8c7a', bgColor: '#120000', bgColor2: '#5c0a0a', bgAngle: 200, panelAlpha: 90, radius: 4, border: '#7a1414', borderW: 2, shadow: 'glow', glow: '#ff2a1a' } },
    'grimoire': { label: 'Grimoire Green', t: { font: 'imfell', accent: '#2f5a2a', panel: '#e8ecd6', text: '#1d2a17', link: '#3d6f2f', bgColor: '#0f2410', bgColor2: '#2f4a1f', bgAngle: 135, radius: 6, border: '#6d7c4a', borderW: 2, shadow: 'soft' } },
    'royal':    { label: 'Royal Purple', t: { font: 'cinzel', accent: '#6a2c91', heading: '#4b1a6b', panel: '#f3ecfa', text: '#2a1838', link: '#8b3fc4', bgColor: '#1a0629', bgColor2: '#4a1470', bgAngle: 170, radius: 14, border: '#c9a227', borderW: 2, shadow: 'soft' } },
    'paper':    { label: 'Paper & Ink', t: { font: 'garamond', bodyFont: 'garamond', accent: '#111111', panel: '#fbfaf6', text: '#1a1a1a', link: '#1d4ed8', bgColor: '#e9e5da', radius: 2, border: '#c8c2b0', borderW: 1, shadow: 'none' } },
    'neon':     { label: 'Neon Arcade', t: { font: 'mono', bodyFont: 'mono', accent: '#39ff14', heading: '#ff2bd6', panel: '#0a0a12', text: '#e6e6ff', link: '#00e5ff', bgColor: '#000000', bgColor2: '#1a0033', bgAngle: 135, panelAlpha: 88, radius: 0, border: '#ff2bd6', borderW: 2, shadow: 'glow', glow: '#00e5ff', headCase: 'upper' } },
    'sunset':   { label: 'Sunset', t: { font: 'pirata', accent: '#b8461c', heading: '#7a2a0c', panel: '#fff3e2', text: '#3b2214', link: '#c2410c', bgColor: '#ff9a3c', bgColor2: '#6a1b4d', bgAngle: 180, radius: 16, shadow: 'soft' } },
    'ocean':    { label: 'Deep Ocean', t: { font: 'oswald', bodyFont: 'roboto', accent: '#7fdbff', heading: '#bdf0ff', panel: '#06223a', text: '#d6eefc', link: '#5ad1ff', bgColor: '#01101f', bgColor2: '#05486b', bgAngle: 190, panelAlpha: 85, radius: 12, border: '#1b6b93', borderW: 1, shadow: 'strong', headCase: 'upper' } },
    'retro':    { label: 'Retro Web', t: { font: 'comic', bodyFont: 'comic', accent: '#0000ee', heading: '#ff00ff', panel: '#ffffcc', text: '#000000', link: '#0000ee', bgColor: '#008080', radius: 0, border: '#000000', borderW: 3, shadow: 'none' } },
    'ghost':    { label: 'Ghostly', t: { font: 'unlovable', accent: '#cfd8e3', heading: '#ffffff', panel: '#1c2027', text: '#cfd6df', link: '#a9c6e8', bgColor: '#0b0d10', bgColor2: '#2b313a', bgAngle: 180, panelAlpha: 70, radius: 18, shadow: 'glow', glow: '#b7c9e2', bgBlur: 3 } }
  };
  /* Every quick style dresses the character boxes, team headings and
     dividers too, from its own colours, so a preset never leaves parchment
     cards sitting on a neon page. A preset that names one of these itself
     keeps its own. */
  Object.keys(THEME_PRESETS).forEach(function (k) {
    var t = THEME_PRESETS[k].t;
    if (!t.panel) return;
    var derived = {
      cardBg: t.panel, cardText: t.text, cardName: t.heading || t.accent, cardAccent: t.link,
      cardBorder: t.border, cardBorderW: t.borderW, cardRadius: t.radius, cardShadow: t.shadow,
      cardAlpha: t.panelAlpha, cardFont: t.font,
      teamColor: t.heading || t.accent, teamFont: t.font, teamGlow: t.glow,
      ruleColor: t.border || t.accent
    };
    Object.keys(derived).forEach(function (d) {
      if (derived[d] != null && t[d] == null) t[d] = derived[d];
    });
  });

  /* ── Hybrid collection membership ──
     Auto-matched by the character's "Appears in" text (normalized against
     match[]), plus explicit include[] slugs, minus explicit exclude[] slugs. */
  function resolveCollectionMembers(coll, allChars) {
    var match = (coll.match || []).map(norm).filter(Boolean);
    var include = Object.create(null), exclude = Object.create(null);
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
    var manual = Object.create(null);
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

  /* The row's version (`v`, stamped by the Worker from updated_at — see
     rowVersion() in worker.js) as a query string. A versioned image URL is
     served immutable for a year and kept at the edge, so an unchanged icon
     costs a returning reader nothing; a save is a new version is a new URL.
     Rows without one (the editors' live preview, a legacy import) get the
     bare URL, which still revalidates every time as it always did. */
  function artVer(c) {
    return c && c.v ? '?v=' + encodeURIComponent(String(c.v)) : '';
  }
  function artSrc(c, root) {
    if (c.art) return root + 'assets/' + c.art + artVer(c);
    if (typeof c.image === 'string' && c.image) return c.image;
    if (Array.isArray(c.image) && c.image[0]) return c.image[0];
    return root + 'assets/favicon.png';
  }
  /* What a CARD draws: the 192px WebP thumbnail (thumb/{file}.webp beside
     art/{file}, ~8 KB against the original's ~150 KB). Only art under art/ has
     one; a remote `image` or another prefix falls back to artSrc(). The Worker
     serves the original at the thumbnail URL when no thumbnail exists yet, so
     this never needs an onerror of its own. Anything that shows the icon
     LARGE (the /c/ emblem, the featured card) draws the display copy
     instead (displaySrc below, artVersions().display in render.js). */
  function thumbSrc(c, root) {
    if (c.art && /^art\/[^/]+$/.test(c.art)) {
      return root + 'assets/thumb/' + c.art.slice(4) + '.webp' + artVer(c);
    }
    var small = officialSmall(c, root);
    if (small) return small;
    return artSrc(c, root);
  }
  /* An official character (official-roles.js: `official`, `id`, and the CDN
     `image`) is DRAWN from the 192px self-hosted copy,
     assets/icons-sm/{id}.webp (migration/make-small-icons.js), instead of the
     CDN's 400px file on another origin. Display only: the object's `image`
     is untouched, and that is what any export reads. */
  function officialSmall(c, root) {
    if (!c || !c.official || !c.id) return '';
    var id = String(c.id).toLowerCase().replace(/[^a-z0-9]/g, '');
    return id ? (root || '') + 'assets/icons-sm/' + id + '.webp' : '';
  }
  /* The onerror for an <img> whose src may be a small official copy: try
     `fb` (the CDN file) once, then do `then` — what the onerror always did. */
  function fbAttrs(fb, then) {
    if (!fb) return then ? ' onerror="' + then + '"' : '';
    return ' data-fb="' + esc(fb) + '" onerror="if(this.dataset.fb){this.src=this.dataset.fb;this.removeAttribute(\'data-fb\')}' +
      (then ? 'else{' + then + '}' : '') + '"';
  }
  // thumbSrc()'s fallback, for the same row: the CDN image of an official.
  function thumbFallback(c) {
    return officialSmall(c, '') && typeof c.image === 'string' && /^https?:\/\//i.test(c.image) ? c.image : '';
  }
  /* What draws ONE character large (the homepage's Featured card): the
     display copy, media/full/{art}.webp — the same picture as WebP, made
     beside the original by assets/art-thumb.js and stood in for by the
     original until it exists. Same rule as render.js's artDisplayPath() and
     the Worker's mediaParts(). Anything else falls back to artSrc(). */
  function displaySrc(c, root) {
    var a = c && typeof c.art === 'string' ? c.art : '';
    if (/^art\/[^/?#]+\.(png|jpe?g|webp)$/i.test(a) && !/-token\.[a-z]+$/i.test(a)) {
      return root + 'assets/media/full/' + a + '.webp' + artVer(c);
    }
    return artSrc(c, root);
  }
  function charHref(c, root) {
    var p = c.page || ('c/' + c.slug);
    if (/^https?:/i.test(p)) return p;
    return root + p.replace(/\.html$/, '');
  }
  /* A script or collection image (the header banner, the logo) is usually a
     relative path into /assets/ — an R2 upload — but a bulk import stores art
     hosted elsewhere as an absolute URL, the same convention character art
     has always had (artSrc above). One resolver, or a remote logo comes out
     as "assets/https://…" and draws as a broken image on every tile while
     the page's own onerror quietly hides it. */
  function imgSrc(root, p, version) {
    p = String(p || '');
    if (!p) return '';
    if (/^https?:\/\//i.test(p)) return p;
    // An image picked in an editor and not uploaded yet (the live preview).
    if (/^data:image\/(png|jpeg|gif|webp);base64,/i.test(p)) return p;
    return root + 'assets/' + p + (version
      ? (p.indexOf('?') === -1 ? '?' : '&') + 'v=' + encodeURIComponent(String(version)) : '');
  }
  /* The srcset for a banner or logo: the browser-made WebP copies at the
     320/640/1280 slots (media/{slot}/{path}.webp, see assets/art-thumb.js).
     Each slot holds the source at min(slot, source width) — copies are never
     enlarged — so the descriptors have to be TRUE widths or a width:auto
     logo lays out at the wrong size: `imageW` is the page's record of its
     images' real widths ({path: px}, or just the number), written by the
     Worker. Known, the srcset lists the slots narrower than the source and
     then one at the source's own width; unknown (a page not stamped yet),
     the three slots as they always were — the copies made before the
     no-enlarging rule really are those widths. */
  function responsiveAttrs(root, path, version, sizes, imageW) {
    if (!/^(scripts|collections)\/[^/]+\.(png|jpe?g|webp)$/i.test(String(path || ''))) return '';
    var encodedPath = path.split('/').map(encodeURIComponent).join('/');
    var query = version ? '?v=' + encodeURIComponent(String(version)) : '';
    var srcW = typeof imageW === 'number' ? imageW
      : (imageW && typeof imageW === 'object' ? Number(imageW[path]) : 0);
    srcW = srcW > 0 && srcW <= 20000 ? Math.round(srcW) : 0;
    var parts = [];
    for (var i = 0; i < MEDIA_SLOTS.length; i++) {
      var slot = MEDIA_SLOTS[i];
      var w = srcW ? Math.min(slot, srcW) : slot;
      parts.push(root + 'assets/media/' + slot + '/' + encodedPath + '.webp' + query + ' ' + w + 'w');
      if (srcW && w >= srcW) break;
    }
    return ' srcset="' + esc(parts.join(', ')) + '" sizes="' + esc(sizes || '(max-width: 640px) 94vw, 800px') + '"';
  }
  var MEDIA_SLOTS = [320, 640, 1280];
  /* `sizes` for a script or collection TILE (the browse grids, the
     homepage, a creator page, search). A tile is ~320 CSS px wide on a
     phone and 245-380 on a desktop, its picture object-fit inside a 21:9
     box. On a phone this deliberately says less than the tile's width, so a
     3x screen takes the 640 copy (twice the density, indistinguishable at
     that size) instead of the 1280 one at four to ten times the bytes; on a
     desktop 320 keeps a 1x screen on the 320 copy and a 2x one on 640. */
  var TILE_SIZES = '(max-width: 640px) 210px, 320px';
  /* An official character has no page here, so its name links to the official
     wiki: another site, so a new tab, and a mark saying so. */
  function offsite(c) {
    return c && c.official ? ' target="_blank" rel="noopener"' : '';
  }
  function offMark(c) {
    return c && c.official ? ' <span class="script-char-off" title="Official character; opens the official wiki"><span class="ico ico-external" aria-hidden="true"></span></span>' : '';
  }

  function sech(id, title) {
    return '<div class="gen-sech-wrap" id="' + id + '"><h2 class="gen-sech">' +
      '<a class="sec-anchor" href="#' + id + '">' + esc(title) + '</a></h2></div>';
  }
  function prose(text) {
    return String(text || '').split(/\n{2,}/).map(function (p) {
      // By hand: `\s+$` rescans a long run of spaces from each one of them.
      var e = p.length;
      while (e > 0 && /\s/.test(p.charAt(e - 1))) e--;
      p = p.slice(0, e);
      return p.trim() ? '<p>' + tok(p).replace(/\n/g, '<br>') + '</p>' : '';
    }).join('');
  }

  /* A roster row's name, with its creators' marks after it when the script
     asked for them (`creatorMarks`, the Script Builder's "creator marks on
     names" option). The marks sit inside the row's link, so they take no
     focus of their own; the tooltip still shows on hover. A name that has the
     mark typed into it loses that copy first, or it would show twice. */
  function rosterName(c, marks) {
    var mf = marks && !c.official && dep('creatorMarkHTML');
    if (!mf) return esc(c.name);
    var credits = (dep('splitCreators') || function () { return []; })(c.creator);
    var strip = dep('stripCreatorMark');
    var html = credits.map(function (n) { return mf(n, { noFocus: true }); }).filter(Boolean).join('');
    var nm = strip ? strip(c.name, credits[0] || '') : c.name;
    return esc(nm || c.name) + (html ? ' ' + html : '');
  }

  /* ── page sections ── */
  function renderRoster(entries, root, marks) {
    if (!entries.length) {
      return '<p style="color:var(--ink);opacity:.7;padding:8px 0">No characters on this page yet.</p>';
    }
    var html = '';
    TEAMS.forEach(function (t) {
      var grp = entries.filter(function (c) { return teamOf(c) === t[0]; });
      if (!grp.length) return;
      html += '<div class="script-team-group" data-team="' + t[0] + '"><h3 class="script-team-head' + teamCls(t[0]) + '">' +
        esc(groupLabel(t[0], t[1], grp)) + ' <span class="script-team-count">(' + grp.length + ')</span></h3>' +
        '<div class="script-char-list">';
      grp.forEach(function (c) {
        html += '<a class="script-char-row" href="' + esc(charHref(c, root)) + '" data-slug="' + esc(c.slug || '') + '"' + offsite(c) + '>' +
          '<span class="card-side">' +
          '<img loading="lazy" decoding="async" class="script-char-thumb" src="' + esc(thumbSrc(c, root)) + '" alt=""' + fbAttrs(thumbFallback(c), 'this.onerror=null;this.src=\'' + esc(root) + 'assets/favicon.png\'') + '>' +
          quickSlot(c) + '</span>' +
          '<div class="script-char-text"><span class="script-char-name">' + rosterName(c, marks) + offMark(c) + '</span>' +
          '<span class="script-char-ability">' + esc(c.ability || '') + '</span></div></a>';
      });
      html += '</div></div>';
    });
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
      var label = typeNameOf(c);
      if (!label) for (var i = 0; i < TEAMS.length; i++) { if (TEAMS[i][0] === c.team) { label = TEAMS[i][1]; break; } }
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
              ? 'Curata: part of the ' + esc(c.curataFrom) + ' collection.'
              : 'Awarded by the wiki admins. Shown more often on the homepage and in Featured picks.') +
            '" aria-label="Curata"></span>' : '');
      return '<a class="char-card' + (c.status === 'draft' ? ' char-card-draft' : '') +
        '" href="' + esc(charHref(c, root)) + '"' +
        // The identity, for the Favorites chip in card-filters.js: a saved
        // character is keyed on it, never on the address the link goes to.
        ' data-slug="' + esc(c.slug || '') + '"' +
        ' data-team="' + esc(c.team || '') + '"' +
        ' data-tags="' + esc(c.tags || '') + '"' +
        ' data-creator="' + esc((c.creator || '').trim()) + '"' +
        ' data-name="' + esc(c.name || '') + '"' +
        // The set this character's own "Appears in" row names — the typed
        // line, else a collection that lists it by hand — for "Group: By
        // script or collection" in card-filters.js.
        ' data-set="' + esc(String(c.appearsIn || '').split(',')[0].trim() ||
          (c.appearsInFrom && c.appearsInFrom[0] && c.appearsInFrom[0].name) || '') + '"' +
        // Curata wins over Partial (same rule as Classify.isPartial): a
        // character can be stamped 'partial' and then inherit the wreath from a
        // Curata collection, and an admin-blessed page is never taken out
        // by the Hide Partial chip.
        (cls === 'partial' && !hasCurata ? ' data-partial="1"' : '') +
        (hasCurata ? ' data-curata="1"' : '') +
        ' data-order="' + (Object.prototype.hasOwnProperty.call(orderMap, c.slug) && orderMap[c.slug] != null ? orderMap[c.slug] : 0) + '">' +
        // The icon and, under it, the two quick actions (Favorites, Add to
        // Script — assets/card-actions.js). A draft gets no slot.
        '<span class="card-side">' +
        '<img loading="lazy" decoding="async" class="char-card-thumb" src="' + esc(thumbSrc(c, root)) + '" alt=""' + fbAttrs(thumbFallback(c), 'this.onerror=null;this.src=\'' + esc(root) + 'assets/favicon.png\'') + '>' +
        quickSlot(c) + '</span>' +
        '<div class="char-card-info">' +
        '<div class="char-card-name">' + esc(c.name) + marks + '</div>' +
        '<div class="char-card-type' + teamCls(teamOf(c)) + '">' + esc(label) + '</div>' +
        '<div class="char-card-ability">' + esc(c.ability || '') + '</div>' +
        '<span class="char-card-link">View Character &rarr;</span>' +
        '</div></a>';
    }
    function section(key, label, grp) {
      return '<section class="type-section coll-team" data-team="' + esc(key) + '">' +
        '<h2 class="type-header' + teamCls(key) + '">' +
        // A renamed Other heading ("Spirit") is not the Other team page.
        (key === 'other' && label !== 'Other' ? esc(label)
          : '<a class="team-header-link" href="' + esc(root) + 'team?t=' + encodeURIComponent(key) + '">' + esc(label) + '</a>') +
        ' <span class="coll-team-count">(' + grp.length + ')</span></h2>' +
        '<div class="type-rule"></div>' +
        '<div class="char-grid">' + grp.map(cardHTML).join('') + '</div></section>';
    }
    var html = '';
    TEAMS.forEach(function (t) {
      var grp = entries.filter(function (c) { return teamOf(c) === t[0]; });
      if (grp.length) html += section(t[0], groupLabel(t[0], t[1], grp), grp);
    });
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
    var onScript = Object.create(null);
    missing.forEach(function (n) { var k = normJinxId(n); if (k) onScript[k] = n; });

    var out = [], seen = Object.create(null);
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

  /* Bootlegger rules: the official schema's `_meta.bootlegger`, the rules
     the app prints with the script. On the page too, or a reader would only
     find them by opening the JSON. Where they sit is the owner's choice
     (`bootleggerAt`): under the characters (nothing stored), above the
     synopsis ('top'), or as a box in the sidebar under the information box
     ('side'). */
  function renderBootlegger(rules, side) {
    var list = (rules || []).map(function (r) { return String(r || '').trim(); }).filter(Boolean);
    if (!list.length) return '';
    var items = '<ul class="sv-boot-list">' + list.map(function (r) {
      return '<li>' + tok(r) + '</li>';
    }).join('') + '</ul>';
    if (side) return '<div class="card sv-bootlegger sv-boot-side" id="sec-bootlegger"><h2 class="info-h">Bootlegger Rules</h2>' + items + '</div>';
    return '<div class="sv-section sv-bootlegger">' + sech('sec-bootlegger', 'Bootlegger Rules') + items + '</div>';
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
    var off = Object.create(null);
    (Array.isArray(edits.off) ? edits.off : []).forEach(function (k) { off[k] = 1; });
    var out = list.filter(function (j) {
      return !off[jinxKey(j.a.slug || j.a.name, j.b.slug || j.b.name)];
    }).map(function (j) {
      return { a: j.a, b: j.b, text: j.text, custom: false };
    });
    var bySlug = Object.create(null);
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
        '<img loading="lazy" decoding="async" class="jx-pair-ico" src="' + esc(thumbSrc(c, root)) + '" alt=""' +
        fbAttrs(thumbFallback(c), 'this.style.display=\'none\'') + '>' +
        '<span class="jx-pair-name">' + esc(c.name) + '</span></a>';
    }
    jinxes.forEach(function (j) {
      html += '<div class="script-char-row jx-pair-row"><div class="script-char-text">' +
        '<span class="script-char-name jx-pair">' +
          side(j.a) + '<span class="jx-pair-link"><span class="ico ico-swap" aria-hidden="true"></span></span>' + side(j.b) +
        '</span>' +
        '<span class="script-char-ability">' + esc(j.text) + '</span></div></div>';
    });
    official.forEach(function (j) {
      html += '<div class="script-char-row jx-pair-row"><div class="script-char-text">' +
        '<span class="script-char-name jx-pair">' +
          side(j.a) + '<span class="jx-pair-link"><span class="ico ico-swap" aria-hidden="true"></span></span>' +
          '<a class="jx-pair-side" href="' + esc(j.target.href) + '" target="_blank" rel="noopener noreferrer">' +
            (j.target.iconSrc ? '<img loading="lazy" decoding="async" class="jx-pair-ico" src="' +
              esc(j.target.iconSrc) + '" alt=""' + fbAttrs(j.target.iconFallback, 'this.style.display=\'none\'') + '>' : '') +
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
     character that acts before it does, by night number.

     Dusk, minion info, demon info and dawn ride the same lists when
     NIGHT_META is set, as items with `mark` set and a pseudo-character whose
     slug is '@' + id (no identity has an '@', so the arrangement can store
     them beside the characters and an owner can put a character either side
     of one). Without NIGHT_META they are simply absent. */
  /* ':reminder:' marks where the official app places a reminder token. A
     list has no token to place, so it is dropped — in any case, because
     homebrew text writes ':Reminder:' and it was printed as words. */
  function listReminder(t) {
    return String(t || '').replace(/:reminder:/gi, '').replace(/\s{2,}/g, ' ').trim();
  }
  function nightItems(entries, order) {
    var buildSchema = dep('buildSchema');
    if (!buildSchema) return { first: [], other: [] };
    var first = [], other = [];
    (entries || []).forEach(function (c) {
      var s;
      try { s = buildSchema(c); } catch (e) { return; }
      if (s.firstNight > 0) first.push({ c: c, n: s.firstNight, r: listReminder(s.firstNightReminder) });
      if (s.otherNight > 0) other.push({ c: c, n: s.otherNight, r: listReminder(s.otherNightReminder) });
    });
    (NIGHT_META || []).forEach(function (m) {
      var t = NIGHT_MARK_TEXT[m.id] || { name: m.id, r: '' };
      [[first, 'firstNight'], [other, 'otherNight']].forEach(function (p) {
        var n = m[p[1]] == null ? NaN : Number(m[p[1]]);
        if (isFinite(n)) p[0].push({ c: { slug: '@' + m.id, name: t.name }, n: n, r: t.r, mark: m.id });
      });
    });
    order = order || {};
    return {
      first: sortNightItems(first, order.first),
      other: sortNightItems(other, order.other)
    };
  }

  function sortNightItems(items, orderList) {
    var idx = Object.create(null);
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
        (b.it.mark ? 1 : 0) - (a.it.mark ? 1 : 0) ||
        (a.it.c.name || '').localeCompare(b.it.c.name || '');
    }).map(function (x) { return x.it; });
  }

  function renderNightOrder(entries, root, order) {
    var lists = nightItems(entries, order);
    var first = lists.first, other = lists.other;
    function chars(items) { return items.some(function (it) { return !it.mark; }); }
    if (!chars(first) && !chars(other)) return '';
    function list(items) {
      if (!chars(items)) return '<p class="sv-night-empty">No characters act.</p>';
      return '<ol class="sv-night-list">' + items.map(function (it) {
        if (it.mark) {
          return '<li class="sv-night-item sv-night-step">' +
            '<span class="sv-night-thumb" aria-hidden="true"></span>' +
            '<div class="sv-night-text"><span class="sv-night-name">' + esc(it.c.name) + '</span>' +
            (it.r ? '<span class="sv-night-reminder">' + esc(it.r) + '</span>' : '') +
            '</div></li>';
        }
        return '<li class="sv-night-item">' +
          '<img loading="lazy" decoding="async" class="sv-night-thumb" src="' + esc(thumbSrc(it.c, root)) + '" alt=""' + fbAttrs(thumbFallback(it.c), 'this.style.display=\'none\'') + '>' +
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
    var counts = Object.create(null);
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
        var mf = dep('creatorMarkHTML'), mk = mf ? mf(n) : '';
        return '<li><a class="author-link" href="' + esc(root) + 'author?a=' + encodeURIComponent(n) + '">' + esc(n) + '</a>' +
          (mk ? ' ' + mk : '') +
          ' <span class="sv-credits-count">(' + counts[n] + ')</span></li>';
      }).join('') + '</ul></div>';
  }

  function teamCounts(entries) {
    var out = [];
    TEAMS.forEach(function (t) {
      var grp = entries.filter(function (c) { return c.team === t[0]; });
      if (grp.length) out.push([esc(groupLabel(t[0], t[1], grp)), grp.length]);
    });
    return out;
  }

  function renderInfobox(opts) {
    // opts: {root, logoPath, author, version, difficulty, entries, extraRows[],
    //        authorProminent} — authorProminent shows the author as a bold
    //        credit line at the top of the box instead of a plain table row.
    var root = opts.root;
    // Creator/credit symbol next to the name, same as character info boxes.
    var markFn = dep('creatorMarkHTML');
    var mk = (typeof markFn === 'function' && opts.author) ? (markFn(opts.author) || '') : '';
    var symHTML = mk ? ' ' + mk : '';
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
      (opts.logoPath ? '<img class="sv-info-logo" src="' + esc(imgSrc(root, opts.logoPath, opts.artVersion)) + '"' + responsiveAttrs(root, opts.logoPath, opts.artVersion, '240px', opts.imageW) + ' alt="" onerror="this.style.display=\'none\'">' : '') +
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
        // `download` marks the one action that saves a file rather than
        // navigating. The href is a real URL, so a browser without the
        // attribute still gets the file — it just opens it instead.
        return '<a class="cta-secondary" style="display:block;text-align:center;margin-top:10px"' +
          (a.id ? ' id="' + a.id + '"' : '') + (a.download ? ' download' : '') +
          ' href="' + esc(a.href) + '">' + a.label + '</a>';
      }).join('');
  }

  /* The id the exported JSON uses for a character, the same one buildSchema
     writes, so a jinx, a night list and the roster all name it identically.
     Render.exportId is the rule (name + creator + set); `opts` is the
     script's or collection's own export settings plus the set the export is
     FOR, so every character in one file is qualified by that file's page.
     Without render.js this falls back to the bare squashed name, which is
     what the wiki wrote before ids were qualified. */
  function exportId(c, opts) {
    var f = dep('exportId');
    if (f) return f(c, opts);
    var slugId = dep('slugId');
    return c.jsonId || (slugId ? slugId(c.name) : String(c.name || '').toLowerCase().replace(/[^a-z0-9]/g, ''));
  }

  /* The export settings a script or collection carries, as buildSchema wants
     them. `set` is the page the export is for — "the collection or script
     it's in" — so the same character exports under this script's name here
     and under that collection's name there, and a tool loading both sees two
     entries rather than one silently overwriting the other. */
  function exportOpts(sc, setName) {
    var e = (sc && sc.exportIds) || {};
    return {
      mode: e.mode || 'full',
      prefix: e.prefix || '',
      suffix: e.suffix || '',
      set: setName === undefined ? undefined : (setName || '')
    };
  }

  /* A jinx's id exactly as the character stored it — what the export falls
     back to when the target is not on this script and so cannot be qualified
     against it. */
  function rawJinxId(j) {
    var slugId = dep('slugId');
    return j.id || (slugId ? slugId(j.name || '') : norm(j.name));
  }

  /* The id every jinx on this export writes for its target.

     A jinx has to meet its target INSIDE the file — the app reads jinxes off
     the characters and pairs them by id — and the id a character exports
     under is now qualified (Render.exportId), while the id a jinx stored is
     whatever its writer or an import typed years ago. So a jinx whose target
     is on this script is rewritten to that target's exported id; one whose
     target is not keeps the raw id, which is the best answer there is.

     `host` is the character whose jinx it is, which is what settles a name
     more than one page answers to (Render.jinxLookupKeys, gotcha 8).
     Render.jinxTargetCheck is the shared resolver, so this cannot disagree
     with the jinx list the page itself draws — and it leaves an OFFICIAL
     character's id alone, because that id is the app's own key for a
     character it already ships. */
  function jinxIdWriter(entries, xo) {
    var jinxCharIndex = dep('jinxCharIndex');
    var jinxTargetCheck = dep('jinxTargetCheck');
    if (!jinxCharIndex || !jinxTargetCheck) return null;
    var index = jinxCharIndex(entries);
    return function (host) {
      return function (j) {
        var chk = jinxTargetCheck(j, host, index);
        if (chk.official || !chk.picked) return rawJinxId(j);
        return exportId(chk.picked, xo);
      };
    };
  }

  /* Per-character jinx lists for the export, but ONLY for the characters this
     script's own jinx edits actually touch. Everyone else exports exactly what
     they always did. Returns null when the script has no jinx edits at all. */
  function jinxExportMap(entries, edits, xo) {
    edits = edits || {};
    xo = xo || {};
    var off = Array.isArray(edits.off) ? edits.off : [];
    var add = Array.isArray(edits.add) ? edits.add : [];
    if (!off.length && !add.length) return null;

    // `byId` answers "is this jinx's target on this script", and it is asked
    // with the id the CHARACTER STORED, so it has to hold every shape a jinx
    // can name a target by: the id this export writes, the identity, and the
    // bare name a jinx typed by hand carries. Keying it on the exported id
    // alone left every hand-typed jinx looking off-script, which kept it as
    // written AND rebuilt it from the script's list — the same jinx twice.
    var bySlug = Object.create(null), byId = Object.create(null);
    (entries || []).forEach(function (c) {
      bySlug[c.slug] = c;
      [exportId(c, xo), c.jsonId, c.name, c.slug].forEach(function (k) {
        var key = norm(k);
        if (key && !byId[key]) byId[key] = c;
      });
    });
    var touched = Object.create(null);
    off.forEach(function (k) {
      String(k).split('|').forEach(function (s) { if (bySlug[s]) touched[s] = 1; });
    });
    add.forEach(function (j) { if (j && bySlug[j.a]) touched[j.a] = 1; });

    var final = scriptJinxes(entries, edits);
    var map = Object.create(null);
    Object.keys(touched).forEach(function (slug) {
      var c = bySlug[slug];
      // Jinxes this character carries with someone who is NOT on this script
      // stay exactly as written: they are part of the character, and this
      // script has no business editing them out of it.
      var kept = (c.jinxes || []).filter(function (j) {
        var idKey = String(j.id || j.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        return !byId[idKey];
      }).map(function (j) {
        // The target is NOT on this script, so there is no entry to qualify
        // this against: the id stays exactly as the character stored it.
        return { id: j.id || rawJinxId(j), reason: j.text || j.reason || '' };
      });
      final.forEach(function (j) {
        if (j.a !== c) return;
        kept.push({ id: exportId(j.b, xo), reason: j.text });
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

  function nightSequences(entries, nightOrder, xo) {
    if (!nightOrder || (!(nightOrder.first || []).length && !(nightOrder.other || []).length)) return null;
    if (!NIGHT_META || !NIGHT_META.length) return null;
    var lists = nightItems(entries, nightOrder);
    function seq(which) {
      return lists[which].map(function (it) { return it.mark || exportId(it.c, xo); });
    }
    return { first: seq('first'), other: seq('other') };
  }

  // The official sheet's wording for those steps.
  var NIGHT_MARK_TEXT = {
    dusk: { name: 'Dusk', r: 'Check that all eyes are closed. Some Travellers act.' },
    minioninfo: { name: 'Minion Info', r: 'If there are 7 or more players, wake all Minions: show the THIS IS THE DEMON token and point to the Demon. Show the THESE ARE YOUR MINIONS token and point to the other Minions.' },
    demoninfo: { name: 'Demon Info', r: 'If there are 7 or more players, wake the Demon: show the THESE ARE YOUR MINIONS token and point to all Minions. Show the THESE CHARACTERS ARE NOT IN PLAY token and 3 not-in-play good character tokens.' },
    dawn: { name: 'Dawn', r: 'Wait a few seconds. Call for eyes open.' }
  };

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
       written out in full.
     - `opts.credits` appends one extra entry at the very end — the
       botchomebrew.wiki credits Fabled (buildCreditsFabled in render.js). Only
       the Script Builder passes it: a published page's JSON box is the
       author's own script and never carries the wiki's signature. */
  /* An image path as the app needs it: absolute. A URL somebody pasted in
     goes out untouched; one of ours, with or without its /assets/ prefix,
     is put on the site's own address. */
  function exportImageURL(p) {
    p = String(p || '').trim();
    if (!p) return '';
    if (/^https?:\/\//i.test(p)) return p;
    return 'https://botchomebrew.wiki/assets/' + p.replace(/^\/?assets\//, '');
  }

  /* A page's kept JSON (`customJson`): the file its owner imported, shown
     and downloaded in place of the JSON built from the roster. Pretty-printed
     when it parses; '' when there is none. */
  function customExport(raw) {
    raw = String(raw || '').trim();
    if (!raw) return '';
    try { return JSON.stringify(JSON.parse(raw), null, 2); } catch (e) { return raw; }
  }

  /* `logoPath` is what the app draws as the script's logo. Callers pass the
     page's `logo` first and fall back to its header banner — `_meta.logo` is
     the app's logo, and a Bloodstar import, which has a logo and no banner,
     used to export none at all because only the header was ever read. */
  function buildPageExport(name, author, logoPath, entries, sc, opts) {
    var buildSchema = dep('buildSchema');
    sc = sc || {};
    opts = opts || {};
    /* The set every character in this file is qualified by: the page the
       export is FOR (see Render.exportId).

       The id, not the display name — a script's name can be edited and every
       id would move with it, while its address never does; a collection is
       keyed on its kebab `id` for the same reason its URL is. An unnamed
       roster (the Script Builder before it has been named) has no set to
       qualify by at all, so each character keeps its own, which is what an
       undefined `set` means to Render.exportId. */
    var setKey = opts.set === undefined
      ? (sc.id || sc.slug || sc.name || sc.displayName || '')
      : opts.set;
    var xo = exportOpts(sc, setKey || undefined);
    var writeJinxId = jinxIdWriter(entries, xo);
    var meta = { id: '_meta', name: name || 'Homebrew Script' };
    if (author) meta.author = author;
    if (logoPath) meta.logo = exportImageURL(logoPath);
    var bg = sc.theme && sc.theme.background;
    if (bg) meta.background = exportImageURL(bg);
    if (sc.hideTitle) meta.hideTitle = true;
    if (sc.almanac) meta.almanac = sc.almanac;
    var boot = (sc.bootlegger || []).map(function (r) { return String(r || '').trim(); }).filter(Boolean);
    if (boot.length) meta.bootlegger = boot;

    var jinxMap = jinxExportMap(entries, sc.jinxEdits, xo);
    var arr = [meta];
    entries.forEach(function (c) {
      var own = jinxMap && jinxMap[c.slug];
      if (c.official && !own) { arr.push(String(c.slug).replace(/^off-/, '')); return; }
      if (!buildSchema) return;
      var src = c;
      if (own) { src = {}; for (var k in c) src[k] = c[k]; src.jinxes = own.list; }
      // A character rebuilt by jinxExportMap already carries this script's
      // ids; everyone else's jinxes are rewritten as they are built.
      var cOpts = { mode: xo.mode, prefix: xo.prefix, suffix: xo.suffix, set: xo.set };
      cOpts.jinxId = own
        ? function (j) { return j.id; }   // jinxExportMap already wrote these
        : (writeJinxId ? writeJinxId(c) : undefined);
      var o = buildSchema(src, cOpts);
      // The script asked for its creators' marks on the names: the official
      // app prints names as text, so this is the mark's glyph.
      var nwm = sc.creatorMarks && dep('nameWithMarks');
      if (nwm && o && o.name) o.name = nwm(o.name, c.creator);
      arr.push(o);
    });
    var seq = nightSequences(entries, sc.nightOrder, xo);
    if (seq) { meta.firstNight = seq.first; meta.otherNight = seq.other; }
    // Last, so it reads as the script's footer and never joins a night list.
    if (opts.credits) arr.push(opts.credits);
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
    if (!editHref) return '<div id="page-owner-controls"></div>';
    return '<p id="page-owner-controls" class="page-owner-bar"><a class="cta-secondary page-owner-edit" href="' +
      esc(editHref) + '"><span class="ico ico-edit" aria-hidden="true"></span> ' + esc(label) + '</a></p>';
  }

  /* The "who may edit this page" line used to sit here too, as a Status-box
     row (openEditRows). It now belongs to the page's EDITING page, where the
     people it concerns already are — publish-script.html and
     publish-collection.html draw it with Render.editStatusHTML(), the same
     call the character editor makes, so the three page types cannot word it
     differently. Nothing about a page's sharing is announced to readers. */

  /* ── shared page body ── */
  function renderPageBody(cfg) {
    /* cfg: {root, name, header, logo, tagline, author, version, difficulty,
             synopsis, gameplay, strategyGood, strategyEvil, description,
             entries, missing[], jsonText, actions[], extraInfoRows[],
             creditsEntries, pagesHTML, boxesHTML, newPageHref} */
    var root = cfg.root;
    var top = cfg.header
      ? '<div class="script-header-wrap"><img class="script-header-img" src="' + esc(imgSrc(root, cfg.header, cfg.artVersion)) + '"' + responsiveAttrs(root, cfg.header, cfg.artVersion, '(max-width: 640px) 94vw, 1000px', cfg.imageW) + ' alt="' + esc(cfg.name) + '"></div>'
      : ((cfg.logo ? '<div class="sv-logo-wrap"><img class="sv-logo" src="' + esc(imgSrc(root, cfg.logo, cfg.artVersion)) + '"' + responsiveAttrs(root, cfg.logo, cfg.artVersion, '(max-width: 640px) 80vw, 400px', cfg.imageW) + ' alt="" onerror="this.style.display=\'none\'"></div>' : '') +
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
    var boot = renderBootlegger(cfg.bootlegger, cfg.bootleggerAt === 'side');
    if (cfg.bootleggerAt === 'top') main += boot;
    if (cfg.synopsis) main += '<div class="sv-section sv-s-synopsis">' + sech('sec-synopsis', 'Synopsis') + prose(cfg.synopsis) + '</div>';
    var gameplay = '';
    if (cfg.gameplay) gameplay += prose(cfg.gameplay);
    if (cfg.strategyGood) gameplay += '<h3 class="sv-subhead good">Playing Good</h3>' + prose(cfg.strategyGood);
    if (cfg.strategyEvil) gameplay += '<h3 class="sv-subhead">Playing Evil</h3>' + prose(cfg.strategyEvil);
    if (gameplay) main += '<div class="sv-section sv-s-gameplay">' + sech('sec-gameplay', 'Gameplay') + gameplay + '</div>';
    main += '<div id="page-wiki-links">' + pagesSection(cfg.pagesHTML, cfg.newPageHref) + '</div>';

    main += '<div class="sv-section sv-s-characters">' +
      (main ? sech('sec-characters', 'Characters') : '') +
      renderRoster(cfg.entries, root, cfg.creatorMarks) +
      renderJinxGroup(cfg.entries, root, cfg.missing, cfg.jinxEdits) + '</div>';
    if (!cfg.bootleggerAt) main += boot;
    main += renderNightOrder(cfg.entries, root, cfg.nightOrder);
    if (cfg.missing && cfg.missing.length) {
      main += '<p class="script-missing"><span class="ico ico-warning" aria-hidden="true"></span> ' + cfg.missing.length + ' character' + (cfg.missing.length === 1 ? '' : 's') + ' on this page ' +
        (cfg.missing.length === 1 ? 'is' : 'are') + ' not in the wiki: ' + cfg.missing.map(esc).join(', ') + '</p>';
    }

    var aside = renderInfobox({
      root: root, logoPath: cfg.logo, artVersion: cfg.artVersion, imageW: cfg.imageW, author: cfg.author, version: cfg.version,
      difficulty: cfg.difficulty, entries: cfg.entries, extraRows: cfg.extraInfoRows
    });
    if (cfg.bootleggerAt === 'side') aside += boot;
    aside += renderCredits(cfg.creditsEntries || cfg.entries, root);
    aside += cfg.boxesHTML || '';
    aside += '<div class="sv-json-wrap">' + renderJsonPanel(cfg.jsonText, cfg.actions, cfg.jsonLabel) + '</div>';

    return top +
      '<div class="script-view-layout">' +
      '<section class="script-chars-panel sv-main">' + main + '</section>' +
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
      ? '<div class="coll-header-wrap"><img class="coll-header-img" src="' + esc(imgSrc(root, cfg.header, cfg.artVersion)) + '"' + responsiveAttrs(root, cfg.header, cfg.artVersion, '(max-width: 640px) 94vw, 1000px', cfg.imageW) + ' alt="' + esc(cfg.name) + '"></div>'
      : ((cfg.logo ? '<div class="sv-logo-wrap"><img class="sv-logo" src="' + esc(imgSrc(root, cfg.logo, cfg.artVersion)) + '"' + responsiveAttrs(root, cfg.logo, cfg.artVersion, '(max-width: 640px) 80vw, 400px', cfg.imageW) + ' alt="" onerror="this.style.display=\'none\'"></div>' : '') +
         '<h1 class="coll-title">' + esc(cfg.name) + '</h1>');
    if (cfg.tagline) top += '<p class="sv-tagline">' + esc(cfg.tagline) + '</p>';
    if (cfg.description) top += '<p class="script-desc">' + esc(cfg.description) + '</p>';
    top += ownerBar(cfg.editHref, 'Edit this collection');

    // Information + JSON/tokens boxes — moved to the top. The author credit
    // lives prominently inside the Information box (linked to their page).
    var infobox = renderInfobox({
      root: root, logoPath: cfg.logo, artVersion: cfg.artVersion, imageW: cfg.imageW, author: cfg.author, version: cfg.version,
      difficulty: cfg.difficulty, entries: cfg.entries, extraRows: cfg.extraInfoRows,
      authorProminent: true
    });
    var json = '<div class="sv-json-wrap">' + renderJsonPanel(cfg.jsonText, cfg.actions, cfg.jsonLabel, true) + '</div>';
    var meta = '<div class="coll-meta-row">' + infobox + json + '</div>';

    // Prose sections (synopsis / gameplay) in a parchment panel.
    var proseHTML = '';
    if (cfg.synopsis) proseHTML += '<div class="sv-section sv-s-synopsis">' + sech('sec-synopsis', 'Synopsis') + prose(cfg.synopsis) + '</div>';
    var gameplay = '';
    if (cfg.gameplay) gameplay += prose(cfg.gameplay);
    if (cfg.strategyGood) gameplay += '<h3 class="sv-subhead good">Playing Good</h3>' + prose(cfg.strategyGood);
    if (cfg.strategyEvil) gameplay += '<h3 class="sv-subhead">Playing Evil</h3>' + prose(cfg.strategyEvil);
    if (gameplay) proseHTML += '<div class="sv-section sv-s-gameplay">' + sech('sec-gameplay', 'Gameplay') + gameplay + '</div>';
    proseHTML += '<div id="page-wiki-links">' + pagesSection(cfg.pagesHTML, cfg.newPageHref) + '</div>';
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

    // .coll-flow / .coll-top are what the layout settings reorder
    // (styles.css, "Theme kit: layout"); untouched, they are plain blocks.
    return '<div class="coll-flow"><div class="coll-top">' + top + '</div>' +
      meta + prosePanel + filters + chars + jinxPanel + '</div>';
  }

  /* ── public renderers ── */
  function renderScriptPage(sc, allChars, opts) {
    opts = opts || {};
    var root = opts.linkRoot || '';
    var bySlug = Object.create(null);
    (allChars || []).forEach(function (c) { bySlug[c.slug] = c; });
    var entries = (sc.characters || []).map(function (s) { return bySlug[s]; }).filter(Boolean);
    var missing = (sc.characters || []).filter(function (s) { return !bySlug[s]; });
    var jsonText = customExport(sc.customJson) || buildPageExport(sc.name, sc.author, sc.logo || sc.header, entries, sc);

    var share = b64url(JSON.stringify({ n: sc.name || '', a: sc.author || '', c: (sc.characters || []) }));
    var actions = [
      // A real link to the file, not an href="#" that script has to fill in
      // later: the server builds this JSON to render the page anyway, so the
      // button can just point at it. Works with no JavaScript, survives
      // "save link as", and cannot fail silently. See pageJsonResponse().
      { id: 'json-download', download: true,
        href: root + 'api/page-json?type=script&slug=' + encodeURIComponent(sc.slug || ''),
        label: '<span class="ico ico-download" aria-hidden="true"></span> Download JSON' },
      { href: root + 'script' + (share ? '?share=' + share : ''), label: 'Open in Script Builder' },
      { href: root + 'tokens?script=' + encodeURIComponent(sc.slug || ''), label: 'Print Tokens' },
      { href: root + 'fancyscripts?s=' + encodeURIComponent(sc.slug || ''), label: 'Fancy Sheet' }
    ];
    return renderPageBody({
      root: root, name: sc.name || 'Untitled Script', header: sc.header, logo: sc.logo, artVersion: sc.v, imageW: sc.imageW,
      tagline: sc.tagline, author: sc.author, version: sc.version, difficulty: sc.difficulty,
      synopsis: sc.synopsis, gameplay: sc.gameplay, strategyGood: sc.strategyGood,
      strategyEvil: sc.strategyEvil, description: sc.description,
      entries: entries, missing: missing, jsonText: jsonText, actions: actions,
      jsonLabel: 'Script JSON', editHref: opts.editHref, nightOrder: sc.nightOrder,
      jinxEdits: sc.jinxEdits, bootlegger: sc.bootlegger, bootleggerAt: sc.bootleggerAt, creatorMarks: !!sc.creatorMarks,
      pagesHTML: opts.pagesHTML, boxesHTML: opts.boxesHTML, newPageHref: opts.newPageHref,
      extraInfoRows: curataRow(sc)
    });
  }

  function renderCollectionPage(coll, allChars, opts) {
    opts = opts || {};
    var root = opts.linkRoot || '';
    var members = sortCollectionMembers(coll, resolveCollectionMembers(coll, allChars || []));
    var name = coll.displayName || coll.slug || 'Collection';
    // A narrow view of the collection, not the whole row: buildPageExport
    // reads a SCRIPT's _meta fields off this object (background, hideTitle,
    // almanac, bootlegger, the night order) and a collection has none of
    // them — it only needs to say which set it is and how it wants its ids.
    var jsonText = customExport(coll.customJson) || buildPageExport(name, coll.author, coll.logo || coll.header, members,
      { id: coll.id, slug: coll.slug, name: name, exportIds: coll.exportIds });
    // orderMap: each slug's index in the full character list, for "recently
    // added" sorting in the on-page filter (higher index = more recent).
    var orderMap = Object.create(null);
    (allChars || []).forEach(function (c, i) { orderMap[c.slug] = i; });
    // Browse/filter now lives on this page, so that action is gone.
    var actions = [
      { id: 'json-download', download: true,
        href: root + 'api/page-json?type=collection&slug=' + encodeURIComponent(coll.id || coll.slug || ''),
        label: '<span class="ico ico-download" aria-hidden="true"></span> Download JSON' },
      { href: root + 'tokens?collection=' + encodeURIComponent(coll.slug || coll.id || ''), label: 'Print Tokens' },
      { href: root + 'fancyscripts?c=' + encodeURIComponent(coll.id || coll.slug || ''), label: 'Fancy Sheet' }
    ];
    return renderCollectionBody({
      root: root, name: name, header: coll.header, logo: coll.logo, artVersion: coll.v, imageW: coll.imageW,
      tagline: coll.tagline, author: coll.author, version: coll.version, difficulty: coll.difficulty,
      synopsis: coll.synopsis, gameplay: coll.gameplay, strategyGood: coll.strategyGood,
      strategyEvil: coll.strategyEvil, description: coll.description,
      entries: members, orderMap: orderMap, jsonText: jsonText, actions: actions,
      jsonLabel: 'Collection JSON', editHref: opts.editHref,
      pagesHTML: opts.pagesHTML, boxesHTML: opts.boxesHTML, newPageHref: opts.newPageHref,
      extraInfoRows: curataRow(coll)
    });
  }

  var api = {
    init: init,
    renderScriptPage: renderScriptPage,
    renderCollectionPage: renderCollectionPage,
    renderRosterCards: renderRosterCards,
    setCardActions: setCardActions,
    nightItems: nightItems,
    filterBoxHTML: filterBoxHTML,
    scriptJinxes: scriptJinxes,
    jinxKey: jinxKey,
    setNightMeta: setNightMeta,
    resolveCollectionMembers: resolveCollectionMembers,
    sortCollectionMembers: sortCollectionMembers,
    sanitizeTheme: sanitizeTheme,
    sanitizeStickers: sanitizeStickers,
    stickersHTML: stickersHTML,
    STICKERS_MAX: STICKERS_MAX,
    STICKER_ANIMS: STICKER_ANIMS,
    STICKER_DEFAULTS: STICKER_DEFAULTS,
    themeFontLinks: themeFontLinks,
    THEME_PRESETS: THEME_PRESETS,
    THEME_STYLE_KEYS: THEME_STYLE_KEYS,
    THEME_LAYOUT_KEYS: THEME_LAYOUT_KEYS,
    MOVABLE: MOVABLE,
    moveSelector: moveSelector,
    sanitizeMoves: sanitizeMoves,
    movesCSS: movesCSS,
    THEME_SECTIONS: THEME_SECTIONS,
    THEME_NUMBERS: THEME_NUMBERS,
    THEME_CHOICES: THEME_CHOICES,
    THEME_CSS_MAX: THEME_CSS_MAX,
    FONT_STACKS: FONT_STACKS,
    themeAttrs: themeAttrs,
    LOGO_SIZE_MIN: LOGO_SIZE_MIN,
    LOGO_SIZE_MAX: LOGO_SIZE_MAX,
    buildPageExport: buildPageExport,
    customExport: customExport,
    FONT_PRESETS: FONT_PRESETS,
    artSrc: artSrc,
    thumbSrc: thumbSrc, displaySrc: displaySrc, officialSmall: officialSmall,
    thumbFallback: thumbFallback, TILE_SIZES: TILE_SIZES,
    artVer: artVer,
    imgSrc: imgSrc, responsiveAttrs: responsiveAttrs, pagesSection: pagesSection,
    DIFFICULTY_LABEL: DIFFICULTY_LABEL
  };
  if (typeof window !== 'undefined') { window.PageRender = api; }
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})();
