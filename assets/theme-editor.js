/* Shared theme form controls for publish-script.html / publish-collection.html.
   Expects the page to contain: #th-font (select), #th-accent/#th-panel/#th-text/
   #th-link (color inputs) with matching #th-*-state labels and .th-clear buttons,
   plus the two top-graphic sizers #th-headersize / #th-logosize (range inputs,
   with #th-*-state labels) and #th-logopanel (checkbox).
   Values are validated again by sanitizeTheme on save (client + server).

   The two editors do not agree on element ids (sb-* vs pc-*), so the image
   previews this file has to keep in step are found by ATTRIBUTE instead:
   put data-th-preview="header" or data-th-preview="logo" on the <img>, and
   data-th-row="header|logo" on the size row that belongs beside it.

   Each size slider lives NEXT TO ITS OWN IMAGE, not in a list of theme
   controls: the first version put both sliders in the collapsed Page
   Appearance panel, a long way below the Header graphic upload, and the
   answer to "where do I change the header size" was "somewhere you were not
   looking". Only the parchment-box tick is still in that panel, because it is
   the one setting that applies to whichever image is on top. */
(function () {
  var KEYS = ['accent', 'panel', 'text', 'link'];
  /* The two sizers, and the theme key + state label each one drives. Kept as a
     table so adding a third image is a row here plus a row of markup, not
     another copy of the same four handlers. */
  var SIZERS = [
    { id: 'th-headersize', key: 'headerSize', preview: 'header' },
    { id: 'th-logosize',   key: 'logoSize',   preview: 'logo' }
  ];
  function $(id) { return document.getElementById(id); }

  // opts.get() -> current theme object (may be null); opts.set(theme) persists it.
  // opts.onChange(theme), optional: called after any change made in here, so
  // an editor with a live preview can redraw it.
  var wired = null, listeners = [];
  function wire(opts) {
    // Every write from the controls above repaints the sample below as well.
    var rawSet = opts.set;
    opts = { get: opts.get, onChange: opts.onChange,
      stickerBase: opts.stickerBase, stickerUpload: opts.stickerUpload, stickerMaxMB: opts.stickerMaxMB,
      set: function (t) {
      rawSet(t);
      if (more) { paintSample(t); }
      if (opts.onChange) opts.onChange(t);
      listeners.forEach(function (f) { f(t); });
    } };
    wired = opts;
    var sel = $('th-font');
    if (sel && !sel.options.length) {
      var presets = (window.PageRender && window.PageRender.FONT_PRESETS) || { 'default': 'Wiki default' };
      Object.keys(presets).forEach(function (k) {
        var opt = document.createElement('option');
        opt.value = k; opt.textContent = presets[k];
        sel.appendChild(opt);
      });
    }
    if (sel) {
      sel.addEventListener('change', function () {
        var t = opts.get() || {};
        if (sel.value === 'default') delete t.font; else t.font = sel.value;
        opts.set(t);
      });
    }
    KEYS.forEach(function (k) {
      var input = $('th-' + k);
      if (!input) return;
      input.addEventListener('input', function () {
        var t = opts.get() || {};
        t[k] = input.value; opts.set(t);
        var st = $('th-' + k + '-state'); if (st) st.textContent = input.value;
      });
    });
    /* The top graphic's size, as a percentage of the size the wiki would have
       drawn it at. 100 is the default and is never stored, so dragging the
       slider back to the middle takes the page off the setting entirely
       rather than freezing today's default into it. */
    var min = (window.PageRender && window.PageRender.LOGO_SIZE_MIN) || 25;
    var max = (window.PageRender && window.PageRender.LOGO_SIZE_MAX) || 250;
    SIZERS.forEach(function (sz) {
      var input = $(sz.id);
      if (!input) return;
      input.min = min; input.max = max; input.step = 5;
      input.addEventListener('input', function () {
        var t = opts.get() || {};
        var n = Math.round(Number(input.value));
        if (!isFinite(n) || n === 100) delete t[sz.key]; else t[sz.key] = n;
        opts.set(t);
        showSize(sz, n);
        paintPreviews(t);
      });
    });
    var panel = $('th-logopanel');
    if (panel) {
      panel.addEventListener('change', function () {
        var t = opts.get() || {};
        if (panel.checked) t.logoPanel = true; else delete t.logoPanel;
        opts.set(t);
        paintPreviews(t);
      });
    }

    Array.prototype.forEach.call(document.querySelectorAll('.th-clear'), function (btn) {
      btn.addEventListener('click', function () {
        var k = btn.getAttribute('data-k');
        var t = opts.get() || {};
        delete t[k]; opts.set(t);
        var sz = sizerFor(k);
        if (sz) {
          var input = $(sz.id); if (input) input.value = 100;
          showSize(sz, 100);
          paintPreviews(t);
          return;
        }
        var st = $('th-' + k + '-state'); if (st) st.textContent = 'not set';
      });
    });
    watchPreviews();
    var host = $('th-more');
    if (host) mountMore(host, opts);
  }

  function sizerFor(key) {
    for (var i = 0; i < SIZERS.length; i++) if (SIZERS[i].key === key) return SIZERS[i];
    return null;
  }

  function showSize(sz, n) {
    var st = $(sz.id + '-state');
    if (st) st.textContent = (n === 100 ? 'default size' : n + '%');
  }

  /* A size slider with no image to size is a control for nothing, so each row
     follows its own preview: shown while the preview is shown, hidden while it
     is not. The previews are shown and hidden by each editor's own upload and
     remove handlers, which this file does not own — hence an observer rather
     than a call the two editors would each have to remember to make. */
  function syncSizerRows() {
    SIZERS.forEach(function (sz) {
      var row = document.querySelector('[data-th-row="' + sz.preview + '"]');
      if (!row) return;
      var img = document.querySelector('[data-th-preview="' + sz.preview + '"]');
      var shown = !!(img && img.style.display && img.style.display !== 'none');
      row.style.display = shown ? '' : 'none';
    });
  }

  function watchPreviews() {
    if (typeof MutationObserver !== 'function') { syncSizerRows(); return; }
    var obs = new MutationObserver(syncSizerRows);
    SIZERS.forEach(function (sz) {
      var img = document.querySelector('[data-th-preview="' + sz.preview + '"]');
      if (img) obs.observe(img, { attributes: true, attributeFilter: ['style'] });
    });
    syncSizerRows();
  }

  /* Make the editor's own image previews show what was just chosen. The
     percentage means nothing typed as a number — the whole question is whether
     the banner now looks right — so the preview scales with the same
     multiplier the page will use, and takes the parchment card when the card
     is switched on. The previews sit on the page's purple, which is the
     background the card exists to solve for. */
  function paintPreviews(theme) {
    theme = theme || {};
    SIZERS.forEach(function (sz) {
      var n = Number(theme[sz.key]) || 100;
      Array.prototype.forEach.call(
        document.querySelectorAll('[data-th-preview="' + sz.preview + '"]'),
        function (img) {
          img.style.setProperty('--th-prev-scale', n / 100);
          img.classList.toggle('th-prev-panel', !!theme.logoPanel);
        }
      );
    });
  }

  // Reflect a loaded theme in the controls. Returns true if anything is set
  // (so callers can auto-open their appearance section).
  function prime(theme) {
    theme = theme || {};
    var sel = $('th-font');
    if (sel) {
      sel.value = theme.font && sel.querySelector('option[value="' + theme.font + '"]') ? theme.font : 'default';
    }
    KEYS.forEach(function (k) {
      var input = $('th-' + k), st = $('th-' + k + '-state');
      if (theme[k]) { if (input) input.value = theme[k]; if (st) st.textContent = theme[k]; }
      else if (st) { st.textContent = 'not set'; }
    });
    SIZERS.forEach(function (sz) {
      var input = $(sz.id);
      var n = Number(theme[sz.key]) || 100;
      if (input) input.value = n;
      showSize(sz, n);
    });
    var panel = $('th-logopanel');
    if (panel) panel.checked = !!theme.logoPanel;
    paintPreviews(theme);
    syncSizerRows();
    primeMore(theme);
    return Object.keys(theme).length > 0;
  }

  /* ── The deeper layers: one-click styles, every other knob, custom CSS ──
     Built into <div id="th-more" data-kind="script|collection|page|news|
     profile"> by wire(), so an editor only has to carry that one element and
     the script tags (render-page.js before this file, custom-css.js beside
     it). Everything here reads and writes the same theme object the controls
     above do, through the same get()/set(); the field rules live in
     PageRender (sanitizeTheme), not here. */
  var more = null;   // { el, opts, kind } once mounted

  function PR() { return window.PageRender || {}; }
  function escH(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  var NUM_LABELS = {
    bgAngle:    ['Gradient direction', '°'],
    bgDim:      ['Darken the background', '%'],
    bgBlur:     ['Blur the background', 'px'],
    panelAlpha: ['Box opacity', '%'],
    radius:     ['Rounded corners', 'px'],
    borderW:    ['Border thickness', 'px'],
    textScale:  ['Size of everything', '%'],
    cardAlpha:   ['Box opacity', '%'],
    cardBorderW: ['Border thickness', 'px'],
    cardRadius:  ['Rounded corners', 'px'],
    cardIcon:    ['Icon size', '%'],
    teamSize:    ['Heading size', '%'],
    ruleW:       ['Divider thickness', 'px'],
    cardW:       ['Box width (at least)', 'px'],
    cardCols:    ['Boxes per row', ''],
    cardGap:     ['Space between boxes', 'px'],
    cardPad:     ['Space inside each box', 'px'],
    pageW:       ['Exact page width', 'px'],
    panelPad:    ['Space inside the big boxes', 'px'],
    secGap:      ['Space between sections', 'px'],
    infoW:       ['Information box width', 'px'],
    titleSize:   ['Title size', '%']
  };
  var CHOICE_LABELS = {
    bgFit:    ['Image fit', { cover: 'Fill the screen', contain: 'Whole image', tile: 'Tile / repeat', stretch: 'Stretch', center: 'Actual size, centred' }],
    bgPos:    ['Image position', { top: 'Top', center: 'Middle', bottom: 'Bottom' }],
    shadow:   ['Box shadow', { none: 'None', soft: 'Soft', strong: 'Strong', glow: 'Glow' }],
    width:    ['Page width', { narrow: 'Narrow', wide: 'Wide', full: 'Full screen' }],
    headCase: ['Heading letters', { upper: 'UPPERCASE', lower: 'lowercase', caps: 'Small Caps', none: 'As typed' }],
    align:    ['Paragraphs', { center: 'Centred', justify: 'Justified' }],
    cardShadow: ['Box shadow', { none: 'None', soft: 'Soft', strong: 'Strong', glow: 'Glow' }],
    cardHover:  ['When the mouse is over a box', { lift: 'Lift up', grow: 'Grow', glow: 'Glow', none: 'Stay still' }],
    teamAlign:  ['Heading position', { left: 'Left', center: 'Centred', right: 'Right' }],
    teamCase:   ['Heading letters', { upper: 'UPPERCASE', lower: 'lowercase', caps: 'Small Caps', none: 'As typed' }],
    ruleStyle:  ['Divider style', { fade: 'Fading line', solid: 'Solid line', dashed: 'Dashed', dotted: 'Dotted', double: 'Double line', glow: 'Glowing line', none: 'No divider' }],
    cardLayout: ['Icon position', { side: 'Left of the text', top: 'Above the text', right: 'Right of the text' }],
    cardAlign:  ['Text in the box', { left: 'Left', center: 'Centred', right: 'Right' }],
    cardAbility: ['Ability text', { full: 'Show all of it', short: 'First 3 lines', hide: 'Hide it' }],
    infoPos:    ['Information box position', { right: 'Right side', left: 'Left side', top: 'Above everything', bottom: 'Below everything' }],
    topAlign:   ['Title and banner position', { left: 'Left', center: 'Centred', right: 'Right' }]
  };
  var COLOR_LABELS = {
    heading: 'Headings (if different from the accent)', bgColor: 'Page background colour',
    bgColor2: 'Gradient second colour', border: 'Box border', glow: 'Heading glow',
    cardBg: 'Box colour', cardText: 'Ability text', cardName: 'Character name',
    cardAccent: 'Team label and "View Character" link', cardBorder: 'Box border',
    teamColor: 'Heading colour', teamBg: 'Band behind the heading', teamGlow: 'Heading glow',
    ruleColor: 'Divider colour'
  };
  var POPULAR_FONTS = ['Lobster', 'Pacifico', 'Creepster', 'Nosifer', 'Metal Mania', 'UnifrakturMaguntia',
    'Uncial Antiqua', 'MedievalSharp', 'Almendra', 'Cormorant Garamond', 'Playfair Display', 'Abril Fatface',
    'Bebas Neue', 'Press Start 2P', 'VT323', 'Silkscreen', 'Special Elite', 'Caveat', 'Indie Flower',
    'Permanent Marker', 'Bangers', 'Righteous', 'Orbitron', 'Monoton', 'Lato', 'Montserrat', 'Merriweather',
    'Lora', 'Crimson Text', 'Spectral', 'Josefin Sans', 'Quicksand', 'Nunito', 'Fira Sans'];
  var SNIPPETS = [
    ['Rainbow headings', 'h1, h2 {\n  background: linear-gradient(90deg, #ff4d4d, #ffb84d, #f9f871, #4dff88, #4db8ff, #b84dff);\n  -webkit-background-clip: text;\n  background-clip: text;\n  color: transparent;\n}'],
    ['Floating boxes', '.card, .script-chars-panel, .wiki-body, .prof-section {\n  border-radius: 18px;\n  box-shadow: 0 14px 34px rgba(0, 0, 0, .45);\n  transform: rotate(-.4deg);\n}'],
    ['Glowing links', 'a {\n  text-shadow: 0 0 6px currentColor;\n}\na:hover {\n  letter-spacing: .03em;\n}'],
    ['Wobble on hover', '@keyframes wobble {\n  0%, 100% { transform: rotate(0); }\n  25% { transform: rotate(-2deg); }\n  75% { transform: rotate(2deg); }\n}\n.card:hover, img:hover {\n  animation: wobble .4s ease-in-out;\n}'],
    ['Spooky flicker', '@keyframes flicker {\n  0%, 100% { opacity: 1; }\n  45% { opacity: .85; }\n  50% { opacity: .4; }\n  55% { opacity: .9; }\n}\nh1 {\n  animation: flicker 4s infinite;\n}'],
    ['Dotted page', 'body {\n  background-image: radial-gradient(rgba(255,255,255,.12) 1px, transparent 1px);\n  background-size: 18px 18px;\n  padding: 12px;\n}'],
    ['Crosshair cursor', 'body {\n  cursor: crosshair;\n}'],
    ['Big first letter', 'p:first-of-type::first-letter {\n  float: left;\n  font-size: 3.2em;\n  line-height: .9;\n  padding-right: 6px;\n}']
  ];
  var CHEATS = {
    script: '.script-chars-panel (the main column), .script-json-panel (the side column), .card (each side box), .gen-sech (section headings), .script-char-row (a character), .script-char-name, .script-char-ability, .sv-night-item, .script-header-img (the banner), .sv-logo',
    collection: '.script-chars-panel (the prose box), .coll-title, .card (each character card and side box), .type-section (a team), .script-header-img (the banner), .info-h, .info',
    page: '.wiki-page-head (the title box), .wiki-title, .wiki-body (the text), .wiki-h (headings), .wiki-toc (contents), .wiki-infobox (fact box), .wiki-callout, .wiki-banner, .wiki-figure img',
    news: '.news-article, .news-article h1, .news-body, .news-hero, .wiki-h, .wiki-callout',
    profile: '.home-hero (the top), .profile-avatar, .profile-bio, .profile-links, .prof-section (each section), .type-header (section headings), .card (character cards), .coll-card'
  };

  function sampleHTML(kind) {
    if (kind === 'page' || kind === 'news') {
      var body = '<div class="wiki-body"><h2 class="wiki-h">A heading</h2><p>Body text looks like this, with a <a href="#">link</a> in it.</p>' +
        '<hr class="wiki-rule"><p>More text after a divider.</p></div>';
      return '<div class="wiki-page-head"><h1 class="wiki-title">Page Title</h1></div>' + (kind === 'page'
        ? '<div class="wiki-layout">' + body + '<aside class="wiki-side"><div class="card wiki-infobox"><h2 class="info-h">Fact box</h2><dl class="info"><dt>Type</dt><dd>Rules</dd></dl></div></aside></div>'
        : body);
    }
    var icon = function (id) { return '/assets/icons-sm/' + id + '.webp'; };
    if (kind === 'script') {
      var row = function (id, name, ab) {
        return '<a class="script-char-row" href="#"><img class="script-char-thumb" src="' + icon(id) + '" alt="">' +
          '<div class="script-char-text"><span class="script-char-name">' + name + '</span>' +
          '<span class="script-char-ability">' + ab + '</span></div></a>';
      };
      return '<h1 class="script-title-fallback">Your Script</h1>' +
        '<div class="script-view-layout"><section class="script-chars-panel sv-main">' +
        '<div class="sv-section sv-s-synopsis"><div class="gen-sech-wrap"><h2 class="gen-sech">Synopsis</h2></div>' +
        '<p class="script-desc">Body text looks like this, with a <a href="#">link</a> in it.</p></div>' +
        '<div class="sv-section sv-s-characters"><div class="script-team-group"><h3 class="script-team-head good">Townsfolk <span class="script-team-count">(3)</span></h3>' +
        '<div class="script-char-list">' +
        row('washerwoman', 'Washerwoman', 'You start knowing that 1 of 2 players is a particular Townsfolk.') +
        row('librarian', 'Librarian', 'You start knowing that 1 of 2 players is a particular Outsider.') +
        row('investigator', 'Investigator', 'You start knowing that 1 of 2 players is a particular Minion.') +
        '</div></div></div></section>' +
        '<aside class="script-json-panel"><div class="card"><h2 class="info-h">Information</h2><dl class="info"><dt>Author</dt><dd><a href="#">You</a></dd></dl></div></aside></div>';
    }
    var card = function (id, name, team, good, ab) {
      return '<a class="char-card" href="#"><span class="card-side"><img class="char-card-thumb" src="' + icon(id) + '" alt=""></span>' +
        '<div class="char-card-info"><div class="char-card-name">' + name + '</div>' +
        '<div class="char-card-type' + (good ? ' good' : '') + '">' + team + '</div>' +
        '<div class="char-card-ability">' + ab + '</div><span class="char-card-link">View Character &rarr;</span></div></a>';
    };
    var roster = '<div class="type-section"><h2 class="type-header good">Townsfolk <span class="coll-team-count">(2)</span></h2>' +
      '<div class="type-rule"></div><div class="char-grid">' +
      card('washerwoman', 'Washerwoman', 'Townsfolk', true, 'You start knowing that 1 of 2 players is a particular Townsfolk.') +
      card('poisoner', 'Poisoner', 'Minion', false, 'Each night, choose a player: they are poisoned tonight and tomorrow day.') +
      card('imp', 'Imp', 'Demon', false, 'Each night*, choose a player: they die.') + '</div></div>';
    if (kind === 'profile') {
      return '<div class="home-hero"><h1>Your Name</h1><p class="profile-bio">A short bio goes here, with a <a href="#">link</a>.</p></div>' +
        '<div class="prof-panel"><section class="prof-section" data-sec="characters"><h2 class="type-header">Characters</h2>' + roster + '</section>' +
        '<section class="prof-section" data-sec="scripts"><h2 class="type-header">Scripts</h2><p>Your scripts appear here.</p></section></div>';
    }
    return '<div class="coll-flow"><div class="coll-top"><h1 class="coll-title">Your Collection</h1></div>' +
      '<div class="coll-meta-row"><div class="card"><h2 class="info-h">Information</h2><dl class="info"><dt>Author</dt><dd><a href="#">You</a></dd></dl></div></div>' +
      '<section class="script-chars-panel coll-prose"><div class="sv-section sv-s-synopsis"><div class="gen-sech-wrap"><h2 class="gen-sech">Synopsis</h2></div>' +
      '<p class="script-desc">Body text looks like this, with a <a href="#">link</a> in it.</p></div></section>' +
      '<section class="coll-chars"><p class="coll-chars-count">3 characters</p>' + roster + '</section></div>';
  }

  function moreHTML(kind) {
    var presets = PR().THEME_PRESETS || {};
    var fonts = PR().FONT_PRESETS || {};
    var h = '<div class="thx">';
    h += '<div class="thx-block"><div class="thx-lab">Quick styles</div>' +
      '<div class="thx-swatches">' + Object.keys(presets).map(function (k) {
        var t = presets[k].t;
        var bg = t.bgColor2 ? 'linear-gradient(135deg,' + (t.bgColor || '#2a0f24') + ',' + t.bgColor2 + ')' : (t.bgColor || '#2a0f24');
        return '<button type="button" class="thx-swatch" data-preset="' + escH(k) + '" style="background:' + escH(bg) + '">' +
          '<span style="background:' + escH(t.panel || '#f0e8d5') + ';color:' + escH(t.accent || '#5b1f21') + '">Aa</span>' +
          escH(presets[k].label) + '</button>';
      }).join('') + '</div>' +
      '<p class="thx-sub">One click sets the fonts, colours and boxes. Change anything afterwards. Your images and custom CSS are kept.</p></div>';

    h += '<div class="thx-block"><div class="thx-lab">Live sample</div>' +
      '<div class="thx-sample-frame"><div class="thx-sample ucss" id="thx-sample"><div class="thx-sample-in">' + sampleHTML(kind) + '</div></div></div></div>';

    h += '<details class="thx-sec thx-sec-st" open><summary>Stickers &amp; images<span>GIFs and pictures placed anywhere on your page</span></summary><div class="thx-sec-body">' +
      '<p class="thx-sub" style="margin-top:0">Add a GIF, PNG, JPEG or WebP and put it anywhere: drag it around in the live sample above or in the live preview, or use the sliders. ' +
      'Stickers can sit in front of your page or behind its boxes, stay on screen while the page scrolls, spin, bob and more.</p>' +
      '<div class="thx-st-add">' +
        '<input type="file" id="thx-st-file" accept="image/png,image/jpeg,image/gif,image/webp" hidden>' +
        '<button type="button" class="thx-snip" id="thx-st-upload">+ Upload an image</button>' +
        '<input type="text" id="thx-st-url" placeholder="…or paste an https:// image link" maxlength="2000">' +
        '<button type="button" class="thx-snip" id="thx-st-addurl">Add link</button>' +
      '</div>' +
      '<div class="thx-st-msg" id="thx-st-msg"></div>' +
      '<div id="thx-st-list"></div></div></details>';
    function sec(title, sub, body) {
      return '<details class="thx-sec"><summary>' + escH(title) + (sub ? '<span>' + escH(sub) + '</span>' : '') + '</summary><div class="thx-sec-body">' + body + '</div></details>';
    }
    function colorRow(k) {
      return '<div class="thx-row"><label for="thx-' + k + '">' + escH(COLOR_LABELS[k]) + '</label>' +
        '<span class="thx-state" id="thx-' + k + '-state">not set</span>' +
        '<input type="color" id="thx-' + k + '" data-color="' + k + '" value="#000000">' +
        '<button type="button" class="thx-reset" data-reset="' + k + '">reset</button></div>';
    }
    function numRow(k) {
      var r = (PR().THEME_NUMBERS || []).filter(function (x) { return x[0] === k; })[0];
      if (!r) return '';
      return '<div class="thx-row"><label for="thx-' + k + '">' + escH(NUM_LABELS[k][0]) + '</label>' +
        '<span class="thx-state" id="thx-' + k + '-state">default</span>' +
        '<input type="range" id="thx-' + k + '" data-num="' + k + '" min="' + r[1] + '" max="' + r[2] + '" step="1">' +
        '<button type="button" class="thx-reset" data-reset="' + k + '">reset</button></div>';
    }
    function choiceRow(k) {
      var c = CHOICE_LABELS[k];
      return '<div class="thx-row"><label for="thx-' + k + '">' + escH(c[0]) + '</label>' +
        '<select id="thx-' + k + '" data-choice="' + k + '"><option value="">Default</option>' +
        Object.keys(c[1]).map(function (v) { return '<option value="' + v + '">' + escH(c[1][v]) + '</option>'; }).join('') +
        '</select></div>';
    }
    var fontOpts = Object.keys(fonts).map(function (k) {
      return '<option value="' + escH(k) + '">' + escH(fonts[k]) + '</option>';
    }).join('');
    function fontRow(k, label) {
      return '<div class="thx-row"><label for="thx-' + k + '">' + escH(label) + '</label><select id="thx-' + k + '" data-font="' + k + '">' + fontOpts + '</select></div>';
    }
    function gfontRow(k, label, eg) {
      return '<div class="thx-row"><label for="thx-' + k + '">' + escH(label) + '</label><input type="text" id="thx-' + k + '" data-gfont="' + k + '" list="thx-gfonts" placeholder="e.g. ' + escH(eg) + '" maxlength="50"></div>';
    }

    h += sec('Fonts', 'Body text font and any Google Font', 
      fontRow('bodyFont', 'Body text font') +
      gfontRow('gFont', 'Google Font for headings', 'Creepster') +
      gfontRow('gBodyFont', 'Google Font for body text', 'Lora') +
      '<datalist id="thx-gfonts">' + POPULAR_FONTS.map(function (f) { return '<option value="' + escH(f) + '">'; }).join('') + '</datalist>' +
      '<p class="thx-sub">Type the exact name of any font on <a href="https://fonts.google.com" target="_blank" rel="noopener">fonts.google.com</a>. It replaces the font picked above it.</p>');
    if (kind !== 'page' && kind !== 'news') {
      h += sec('Character boxes', 'The box each character sits in: colour, font, border, shadow',
        ['cardBg'].map(colorRow).join('') + numRow('cardAlpha') +
        ['cardName', 'cardText', 'cardAccent'].map(colorRow).join('') +
        fontRow('cardFont', 'Character name font') + gfontRow('gCardFont', 'Google Font for names', 'Cinzel Decorative') +
        colorRow('cardBorder') + numRow('cardBorderW') + numRow('cardRadius') +
        choiceRow('cardShadow') + choiceRow('cardHover') + numRow('cardIcon'));
      h += sec('Team headings', 'The Townsfolk / Outsider / Minion / Demon titles',
        fontRow('teamFont', 'Heading font') + gfontRow('gTeamFont', 'Google Font for headings', 'Metal Mania') +
        ['teamColor', 'teamBg', 'teamGlow'].map(colorRow).join('') +
        numRow('teamSize') + choiceRow('teamAlign') + choiceRow('teamCase'));
    }
    h += sec('Dividers', 'The lines under headings and between sections',
      choiceRow('ruleStyle') + colorRow('ruleColor') + numRow('ruleW'));
    h += sec('More colours', 'Background colour, gradient, borders, glow',
      ['heading', 'bgColor', 'bgColor2', 'border', 'glow'].map(colorRow).join('') + numRow('bgAngle') +
      '<p class="thx-sub">Pick a second colour to turn the background into a gradient.</p>');
    h += sec('Background image', 'How the uploaded background sits',
      choiceRow('bgFit') + choiceRow('bgPos') + numRow('bgDim') + numRow('bgBlur'));
    h += sec('Boxes', 'See-through, rounded, bordered, shadowed',
      numRow('panelAlpha') + numRow('radius') + numRow('borderW') + choiceRow('shadow'));
    h += sec('Text', 'Size, heading letters, paragraphs',
      numRow('textScale') + choiceRow('headCase') + choiceRow('align'));
    var lay = '<p class="thx-sub" style="margin-top:0">How big things are and where they sit. Phones keep a one-column page whatever you pick here.</p>';
    if (kind !== 'page' && kind !== 'news') {
      lay += '<div class="thx-lab">Character boxes</div>' +
        numRow('cardW') + numRow('cardCols') + numRow('cardGap') + numRow('cardPad') +
        choiceRow('cardLayout') + choiceRow('cardAlign') + choiceRow('cardAbility');
    }
    lay += '<div class="thx-lab">The page</div>' + choiceRow('width') + numRow('pageW') + numRow('panelPad');
    if (kind !== 'profile') lay += numRow('titleSize') + choiceRow('topAlign');
    if (kind === 'script' || kind === 'page') lay += choiceRow('infoPos') + numRow('infoW');
    if ((PR().THEME_SECTIONS || {})[kind]) {
      lay += numRow('secGap') + '<div class="thx-lab">Order of the sections</div>' +
        '<p class="thx-sub">Move a section up or down the page. Sections your page does not have are skipped.</p>' +
        '<ol class="thx-order" id="thx-order"></ol>' +
        '<button type="button" class="thx-reset" data-reset="order">Back to the usual order</button>';
    }
    lay += '<div class="thx-foot"><button type="button" class="thx-reset" id="thx-reset-layout">Reset the whole layout</button></div>';
    h += sec('Layout', 'Make boxes wider, change columns, move sections around', lay);
    h += sec('Custom CSS', 'Advanced: write your own styles',
      '<p class="thx-sub">Anything CSS can do, on your page only. <code>body</code> means your page area; the site\'s top bar, footer and comments stay as they are. Images can come from any <code>https://</code> link. Changes show in the sample above.</p>' +
      '<textarea id="thx-css" class="thx-css" spellcheck="false" maxlength="' + (PR().THEME_CSS_MAX || 30000) + '" placeholder="h1 {\n  color: gold;\n  text-shadow: 0 0 10px orange;\n}"></textarea>' +
      '<div class="thx-css-meta"><span id="thx-css-count"></span></div>' +
      '<ul class="thx-warn" id="thx-css-warn" hidden></ul>' +
      '<div class="thx-lab">Add a starter snippet</div><div class="thx-snips">' +
      SNIPPETS.map(function (sn, i) { return '<button type="button" class="thx-snip" data-snip="' + i + '">+ ' + escH(sn[0]) + '</button>'; }).join('') + '</div>' +
      '<details class="thx-cheat"><summary>Class names you can style</summary><p>' + escH(CHEATS[kind] || CHEATS.script) + '</p>' +
      '<p>Also: <code>h1</code>, <code>h2</code>, <code>p</code>, <code>a</code>, <code>img</code>, <code>::selection</code>, <code>@media (max-width: 640px) { … }</code> for phones, <code>@keyframes</code> for animation and <code>@font-face</code> for a font file of your own.</p></details>');
    h += '<div class="thx-foot"><button type="button" class="thx-reset thx-reset-all" id="thx-reset-all">Reset every style setting</button></div>';
    return h + '</div>';
  }

  // more.opts.set is wire()'s wrapper: it repaints the sample and tells the
  // editor (onChange), so nothing here has to.
  function update(fn) {
    var t = more.opts.get() || {};
    fn(t);
    more.opts.set(t);
    paintPreviews(t);
  }

  var cssTimer = null;
  function paintSample(theme) {
    if (!more) return;
    var t = PR().sanitizeTheme ? (PR().sanitizeTheme(theme || {}, stBase() || 'x') || {}) : {};
    // The sample cannot show an image that is not uploaded yet, but it can
    // show one the page already has (its path survives sanitizeTheme only
    // with the right base, so keep whatever the caller stored).
    if (theme && theme.background && /^[a-z0-9/-]+-bg\.(png|jpe?g|webp)$/i.test(theme.background)) t.background = theme.background;
    var ta = PR().themeAttrs ? PR().themeAttrs(t) : { cls: '', style: '', fonts: [] };
    var el = document.getElementById('thx-sample');
    if (el) {
      el.className = 'thx-sample ucss ' + ta.cls;
      el.setAttribute('style', ta.style);
      var inner = el.querySelector('.thx-sample-in');
      var old = inner && inner.querySelector(':scope > .pg-stickers');
      if (old) old.remove();
      if (inner && t.stickers && PR().stickersHTML) {
        inner.insertAdjacentHTML('afterbegin', PR().stickersHTML(t.stickers));
        Array.prototype.forEach.call(inner.querySelectorAll(':scope > .pg-stickers > .pg-sticker'), function (img, n) {
          img.setAttribute('data-i', n);
          img.removeAttribute('loading');
        });
      }
    }
    (ta.fonts || []).forEach(loadFont);
    clearTimeout(cssTimer);
    cssTimer = setTimeout(function () { paintCss(t.css || ''); }, 250);
  }
  function loadFont(href) {
    var id = 'thx-font-' + href.replace(/[^A-Za-z0-9]/g, '');
    if (document.getElementById(id)) return;
    var l = document.createElement('link');
    l.id = id; l.rel = 'stylesheet'; l.href = href;
    document.head.appendChild(l);
  }
  function paintCss(text) {
    var res = window.CustomCSS ? window.CustomCSS.clean(text) : { css: '', warnings: [] };
    var st = document.getElementById('thx-css-style');
    if (!st) { st = document.createElement('style'); st.id = 'thx-css-style'; document.head.appendChild(st); }
    st.textContent = res.css;
    var w = document.getElementById('thx-css-warn');
    if (w) {
      w.hidden = !res.warnings.length;
      w.innerHTML = res.warnings.map(function (m) { return '<li>' + escH(m) + '</li>'; }).join('');
    }
    var c = document.getElementById('thx-css-count');
    if (c) c.textContent = text ? text.length + ' / ' + (PR().THEME_CSS_MAX || 30000) + ' characters' : '';
  }

  function primeMore(theme) {
    if (!more) return;
    theme = theme || {};
    var root = more.el;
    Array.prototype.forEach.call(root.querySelectorAll('[data-color]'), function (i) {
      var k = i.getAttribute('data-color'), st = $('thx-' + k + '-state');
      if (theme[k]) { i.value = theme[k]; if (st) st.textContent = theme[k]; }
      else if (st) st.textContent = 'not set';
    });
    (PR().THEME_NUMBERS || []).forEach(function (r) {
      var i = $('thx-' + r[0]); if (!i) return;
      var has = theme[r[0]] != null;
      // Where an unset slider rests: the look the stylesheet already draws.
      var rest = { bgAngle: 180, ruleW: 2, borderW: 2, cardBorderW: 4, cardW: 240, cardCols: 3, cardGap: 18,
        cardPad: 16, pageW: 1200, panelPad: 20, secGap: 20, infoW: 320 }[r[0]];
      i.value = has ? theme[r[0]] : (rest != null ? rest : (r[3] != null ? r[3] : r[1]));
      showNum(r[0], has ? theme[r[0]] : null);
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-choice]'), function (i) {
      i.value = theme[i.getAttribute('data-choice')] || '';
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-font]'), function (i) {
      i.value = theme[i.getAttribute('data-font')] || 'default';
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-gfont]'), function (i) {
      i.value = theme[i.getAttribute('data-gfont')] || '';
    });
    var css = $('thx-css'); if (css) css.value = theme.css || '';
    renderOrder(theme);
    renderStickers(theme);
    paintSample(theme);
  }
  function showNum(k, v) {
    var st = $('thx-' + k + '-state');
    if (st) st.textContent = v == null ? (k === 'cardCols' ? 'automatic' : 'default') : v + NUM_LABELS[k][1];
  }

  /* ── Section order (theme.order; the keys are PageRender.THEME_SECTIONS) ──
     The whole list for this kind is stored once anything moves, and nothing
     once it is back in the usual order. */
  function kindSections() { return ((PR().THEME_SECTIONS || {})[more && more.kind]) || []; }
  function currentOrder(t) {
    var keys = kindSections().map(function (x) { return x[0]; });
    var saved = (Array.isArray(t && t.order) ? t.order : []).filter(function (k) { return keys.indexOf(k) >= 0; });
    return saved.concat(keys.filter(function (k) { return saved.indexOf(k) < 0; }));
  }
  function renderOrder(t) {
    var ol = $('thx-order'); if (!ol) return;
    var names = {}; kindSections().forEach(function (x) { names[x[0]] = x[1]; });
    var ord = currentOrder(t);
    ol.innerHTML = ord.map(function (k, n) {
      return '<li><span>' + (n + 1) + '. ' + escH(names[k]) + '</span>' +
        '<button type="button" class="thx-reset" data-ord="' + n + '" data-dir="-1"' + (n ? '' : ' disabled') + ' aria-label="Move ' + escH(names[k]) + ' up">▲</button>' +
        '<button type="button" class="thx-reset" data-ord="' + n + '" data-dir="1"' + (n < ord.length - 1 ? '' : ' disabled') + ' aria-label="Move ' + escH(names[k]) + ' down">▼</button></li>';
    }).join('');
  }
  function moveSection(n, dir) {
    update(function (t) {
      var ord = currentOrder(t), m = n + dir;
      if (m < 0 || m >= ord.length) return;
      var x = ord[n]; ord[n] = ord[m]; ord[m] = x;
      var usual = kindSections().map(function (s) { return s[0]; });
      if (ord.join() === usual.join()) delete t.order; else t.order = ord;
    });
    renderOrder(more.opts.get() || {});
  }

  /* ── Stickers (theme.stickers; rules in PageRender.sanitizeStickers) ── */
  function stBase() { return (more && more.opts.stickerBase && more.opts.stickerBase()) || ''; }
  function stList(t) { return Array.isArray(t && t.stickers) ? t.stickers : []; }
  function stSrc(src) { return /^https:/i.test(src) ? src : '/assets/' + src; }
  function stMsg(cls, text) {
    var m = $('thx-st-msg'); if (!m) return;
    m.className = 'thx-st-msg' + (cls ? ' thx-st-' + cls : ''); m.textContent = text || '';
  }
  var ST_ROWS = [
    ['x', 'Across', -20, 120, '%'], ['y', 'Down', -20, 120, '%'], ['w', 'Size', 12, 1200, 'px'],
    ['rot', 'Turn', -180, 180, '°'], ['opacity', 'See-through', 5, 100, '%']
  ];
  function stickerCard(st, i) {
    var D = PR().STICKER_DEFAULTS || {};
    function v(k) { return st[k] != null ? st[k] : (D[k] != null ? D[k] : 0); }
    function sel(k, opts) {
      return '<select data-stk="' + k + '">' + opts.map(function (o) {
        return '<option value="' + o[0] + '"' + ((st[k] || opts[0][0]) === o[0] ? ' selected' : '') + '>' + escH(o[1]) + '</option>';
      }).join('') + '</select>';
    }
    return '<div class="thx-st" data-st="' + i + '">' +
      '<div class="thx-st-thumb"><img src="' + escH(stSrc(st.src)) + '" alt="" referrerpolicy="no-referrer"></div>' +
      '<div class="thx-st-body">' +
      ST_ROWS.map(function (r) {
        return '<label class="thx-st-row"><span>' + r[1] + '</span>' +
          '<input type="range" data-stk="' + r[0] + '" min="' + r[2] + '" max="' + r[3] + '" value="' + v(r[0]) + '">' +
          '<em data-stv="' + r[0] + '">' + v(r[0]) + r[4] + '</em></label>';
      }).join('') +
      '<div class="thx-st-opts">' +
        sel('layer', [['front', 'In front of the page'], ['back', 'Behind the boxes']]) +
        sel('pin', [['page', 'Scrolls with the page'], ['screen', 'Stays on screen']]) +
        sel('anim', [['', 'No animation'], ['spin', 'Spin'], ['bob', 'Bob up and down'], ['wiggle', 'Wiggle'], ['pulse', 'Pulse'], ['blink', 'Blink']]) +
      '</div><div class="thx-st-opts">' +
        '<label class="thx-st-check"><input type="checkbox" data-stk="flip"' + (st.flip ? ' checked' : '') + '> Mirror</label>' +
        '<label class="thx-st-check"><input type="checkbox" data-stk="hideSmall"' + (st.hideSmall ? ' checked' : '') + '> Hide on phones</label>' +
        '<button type="button" class="thx-reset" data-stact="dup">Duplicate</button>' +
        '<button type="button" class="thx-reset" data-stact="del">Remove</button>' +
      '</div></div></div>';
  }
  function renderStickers(theme) {
    var box = $('thx-st-list'); if (!box) return;
    var list = stList(theme);
    box.innerHTML = list.length ? list.map(stickerCard).join('')
      : '<p class="thx-sub" style="margin:4px 0 0">No stickers yet.</p>';
    var up = $('thx-st-upload');
    if (up) up.title = stBase() ? '' : 'Save this page once (a draft is fine) to upload images. Image links work now.';
  }
  function setStickers(list, redraw) {
    update(function (t) { if (list.length) t.stickers = list; else delete t.stickers; });
    if (redraw) renderStickers(more.opts.get() || {});
  }
  function addSticker(src) {
    var list = stList(more.opts.get()).slice();
    var max = PR().STICKERS_MAX || 24;
    if (list.length >= max) { stMsg('bad', 'A page can have up to ' + max + ' stickers.'); return false; }
    var D = PR().STICKER_DEFAULTS || {};
    // Each new one a little lower down, so two in a row do not stack.
    list.push({ src: src, x: D.x, y: Math.min(110, (D.y || 12) + list.length * 8), w: D.w, rot: 0, opacity: 100,
                layer: 'front', pin: 'page' });
    setStickers(list, true);
    return true;
  }
  function nextStickerN(list) {
    var used = {};
    list.forEach(function (s) { var m = String(s.src).match(/-st(\d{1,2})\.[a-z]+$/i); if (m) used[+m[1]] = 1; });
    for (var n = 1; n <= (PR().STICKERS_MAX || 24); n++) if (!used[n]) return n;
    return 0;
  }
  function uploadSticker(file) {
    var base = stBase();
    if (!base) { stMsg('bad', 'Save this page once (a draft is fine), then you can upload images. Image links work now.'); return; }
    var ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[file.type];
    if (!ext) { stMsg('bad', 'Stickers can be PNG, JPEG, GIF or WebP.'); return; }
    var maxMB = more.opts.stickerMaxMB || 8;
    if (file.size > maxMB * 1024 * 1024) { stMsg('bad', 'That file is over ' + maxMB + ' MB. Try a smaller one.'); return; }
    var n = nextStickerN(stList(more.opts.get()));
    if (!n) { stMsg('bad', 'A page can have up to ' + (PR().STICKERS_MAX || 24) + ' stickers.'); return; }
    stMsg('', 'Uploading…');
    // Read as it is: a GIF through a canvas would lose its animation.
    var fr = new FileReader();
    fr.onload = function () {
      var key = base + '-st' + n + '.' + ext;
      var send = more.opts.stickerUpload
        ? more.opts.stickerUpload(n, fr.result, key)
        : fetch('/api/upload', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: key, data: fr.result }) })
            .then(function (r) { return r.json(); })
            .then(function (j) { if (!j || j.error) throw new Error((j && j.error) || 'Upload failed.'); return key; });
      send.then(function (path) {
        // The same slot re-used for a new file: ask for it fresh.
        if (addSticker(path)) stMsg('ok', 'Added. Drag it into place in the sample or the live preview, then save the page.');
      }, function (e) { stMsg('bad', (e && e.message) || 'Upload failed.'); });
    };
    fr.onerror = function () { stMsg('bad', 'That file could not be read.'); };
    fr.readAsDataURL(file);
  }
  /* Drag a sticker in the live sample: the sample stands for the page, so a
     drop at 40% across it is 40% across the page. */
  function wireStickerDrag(sample) {
    var drag = null;
    sample.addEventListener('pointerdown', function (e) {
      var img = e.target.closest('.pg-sticker');
      if (!img || !sample.contains(img)) return;
      e.preventDefault();
      var frame = img.classList.contains('pgs-fixed') ? sample : img.parentNode;
      drag = { img: img, i: +img.getAttribute('data-i'), rect: frame.getBoundingClientRect(), id: e.pointerId };
      img.setPointerCapture(e.pointerId);
      img.classList.add('thx-st-dragging');
    });
    sample.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var r = drag.rect;
      drag.x = Math.max(-20, Math.min(120, Math.round((e.clientX - r.left) / r.width * 100)));
      drag.y = Math.max(-20, Math.min(120, Math.round((e.clientY - r.top) / r.height * 100)));
      drag.img.style.left = drag.x + '%'; drag.img.style.top = drag.y + '%';
    });
    function end(e) {
      if (!drag || e.pointerId !== drag.id) return;
      var d = drag; drag = null;
      d.img.classList.remove('thx-st-dragging');
      if (d.x == null) return;
      var list = stList(more.opts.get()).slice();
      if (!list[d.i]) return;
      list[d.i] = Object.assign({}, list[d.i], { x: d.x, y: d.y });
      setStickers(list, false);
      syncStickerCard(d.i, list[d.i]);
    }
    sample.addEventListener('pointerup', end);
    sample.addEventListener('pointercancel', end);
  }
  function syncStickerCard(i, st) {
    var card = document.querySelector('.thx-st[data-st="' + i + '"]');
    if (!card) return;
    ST_ROWS.forEach(function (r) {
      var inp = card.querySelector('[data-stk="' + r[0] + '"]'), lab = card.querySelector('[data-stv="' + r[0] + '"]');
      if (inp) inp.value = st[r[0]]; if (lab) lab.textContent = st[r[0]] + r[4];
    });
  }

  function mountMore(el, opts) {
    var kind = el.getAttribute('data-kind') || 'script';
    el.innerHTML = moreHTML(kind);
    more = { el: el, opts: opts, kind: kind };
    el.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b || !el.contains(b)) return;
      if (b.id === 'thx-st-upload') {
        // A page that has not been saved has no image slot yet.
        if (!stBase()) stMsg('bad', 'Save this page once (a draft is fine), then you can upload images. Image links work now.');
        else $('thx-st-file').click();
        return;
      }
      if (b.id === 'thx-st-addurl') {
        var u = $('thx-st-url'), src = u.value.trim();
        var ok = PR().sanitizeStickers ? PR().sanitizeStickers([{ src: src }], stBase()).length : 0;
        if (!ok) { stMsg('bad', 'That needs to be an https:// link to an image.'); return; }
        if (addSticker(src)) { u.value = ''; stMsg('ok', 'Added. Drag it into place in the sample or the live preview, then save the page.'); }
        return;
      }
      if (b.hasAttribute('data-ord')) {
        moveSection(+b.getAttribute('data-ord'), +b.getAttribute('data-dir'));
        return;
      }
      if (b.id === 'thx-reset-layout') {
        update(function (t) { (PR().THEME_LAYOUT_KEYS || []).forEach(function (k) { delete t[k]; }); });
        primeMore(opts.get() || {});
        return;
      }
      if (b.hasAttribute('data-stact')) {
        var ci = +b.closest('.thx-st').getAttribute('data-st');
        var cur = stList(opts.get()).slice();
        if (!cur[ci]) return;
        if (b.getAttribute('data-stact') === 'del') cur.splice(ci, 1);
        else if (cur.length < (PR().STICKERS_MAX || 24)) cur.splice(ci + 1, 0, Object.assign({}, cur[ci], { x: Math.min(120, cur[ci].x + 6), y: Math.min(120, cur[ci].y + 6) }));
        setStickers(cur, true);
        return;
      }
      if (b.hasAttribute('data-preset')) {
        var p = (PR().THEME_PRESETS || {})[b.getAttribute('data-preset')];
        if (!p) return;
        var t = opts.get() || {};
        (PR().THEME_STYLE_KEYS || []).forEach(function (k) { delete t[k]; });
        Object.keys(p.t).forEach(function (k) { t[k] = p.t[k]; });
        opts.set(t);
        prime(t);
      } else if (b.hasAttribute('data-reset')) {
        var k = b.getAttribute('data-reset');
        update(function (t) { delete t[k]; });
        primeMore(opts.get() || {});
      } else if (b.id === 'thx-reset-all') {
        if (!window.confirm('Reset every font, colour and box setting back to the wiki look? Your images and custom CSS are kept.')) return;
        var t2 = opts.get() || {};
        (PR().THEME_STYLE_KEYS || []).forEach(function (k) { delete t2[k]; });
        opts.set(t2); prime(t2);
      } else if (b.hasAttribute('data-snip')) {
        var sn = SNIPPETS[+b.getAttribute('data-snip')];
        var ta = $('thx-css');
        if (!sn || !ta) return;
        ta.value = (ta.value.replace(/\s+$/, '') + (ta.value.trim() ? '\n\n' : '') + sn[1]).slice(0, PR().THEME_CSS_MAX || 30000);
        ta.dispatchEvent(new Event('input'));
      }
    });
    el.addEventListener('input', function (e) {
      var i = e.target, k;
      if ((k = i.getAttribute('data-stk')) && i.type === 'range') {
        stickerField(i, k, Math.round(Number(i.value)));
        return;
      }
      if ((k = i.getAttribute('data-color'))) {
        update(function (t) { t[k] = i.value; });
        var st = $('thx-' + k + '-state'); if (st) st.textContent = i.value;
      } else if ((k = i.getAttribute('data-num'))) {
        var n = Math.round(Number(i.value));
        update(function (t) { t[k] = n; });
        showNum(k, n);
      } else if ((k = i.getAttribute('data-gfont'))) {
        var v = i.value.trim().replace(/\s+/g, ' ');
        var ok = !v || /^[A-Za-z0-9][A-Za-z0-9 ]{0,48}[A-Za-z0-9]$/.test(v);
        i.classList.toggle('thx-bad', !ok);
        update(function (t) { if (v && ok) t[k] = v; else delete t[k]; });
      } else if (i.id === 'thx-css') {
        update(function (t) { if (i.value.trim()) t.css = i.value; else delete t.css; });
      }
    });
    el.addEventListener('change', function (e) {
      var i = e.target, k;
      if (i.id === 'thx-st-file') {
        var f = i.files && i.files[0]; i.value = '';
        if (f) uploadSticker(f);
        return;
      }
      if ((k = i.getAttribute('data-stk')) && i.type !== 'range') {
        stickerField(i, k, i.type === 'checkbox' ? i.checked : i.value);
        return;
      }
      if ((k = i.getAttribute('data-choice'))) {
        update(function (t) { if (i.value) t[k] = i.value; else delete t[k]; });
      } else if ((k = i.getAttribute('data-font'))) {
        update(function (t) { if (i.value && i.value !== 'default') t[k] = i.value; else delete t[k]; });
      }
    });
    function stickerField(input, key, val) {
      var ci = +input.closest('.thx-st').getAttribute('data-st');
      var list = stList(opts.get()).slice();
      if (!list[ci]) return;
      var s2 = Object.assign({}, list[ci]);
      if (val === false || val === '') delete s2[key]; else s2[key] = val;
      list[ci] = s2;
      setStickers(list, false);
      var row = ST_ROWS.filter(function (r) { return r[0] === key; })[0];
      var lab = input.closest('.thx-st').querySelector('[data-stv="' + key + '"]');
      if (row && lab) lab.textContent = val + row[4];
    }
    var sample = $('thx-sample');
    if (sample) wireStickerDrag(sample);
    primeMore(opts.get() || {});
  }

  /* Paint a theme onto any element of an editor's own preview (publish-page,
     publish-news): the same classes, custom properties and scoped CSS the
     published page gets, on that element instead of <body>. */
  function applyTo(el, theme) {
    if (!el) return;
    var t = PR().sanitizeTheme ? (PR().sanitizeTheme(theme || {}, stBase() || 'x') || {}) : {};
    if (theme && theme.background && /^[a-z0-9/-]+-bg\.(png|jpe?g|webp)$/i.test(theme.background)) t.background = theme.background;
    var ta = PR().themeAttrs ? PR().themeAttrs(t) : { cls: '', style: '', fonts: [] };
    var oldSt = el.querySelector(':scope > .pg-stickers');
    if (oldSt) oldSt.remove();
    if (t.stickers && PR().stickersHTML) el.insertAdjacentHTML('afterbegin', PR().stickersHTML(t.stickers));
    var keep = (el.getAttribute('data-thx-base') || el.className.replace(/\b(page-themed|theme-\S+|ucss|thx-preview)\b/g, '').trim());
    el.setAttribute('data-thx-base', keep);
    el.className = (keep + ' thx-preview ucss ' + ta.cls).trim();
    el.setAttribute('style', ta.style);
    (ta.fonts || []).forEach(loadFont);
    if (!more) paintCss(t.css || '');
  }

  /* For the live page preview (page-preview.js): read the theme, write one
     (a drag stores theme.moves through here, so the editor saves it), and
     hear about every change the controls make. */
  function current() { return wired ? (wired.get() || {}) : {}; }
  function store(t) { if (wired) wired.set(t); if (more) renderStickers(t); }
  function listen(f) { listeners.push(f); }

  window.ThemeEditor = { wire: wire, prime: prime, paintPreviews: paintPreviews,
                         syncSizerRows: syncSizerRows, mountMore: mountMore, applyTo: applyTo,
                         current: current, store: store, listen: listen };
})();
