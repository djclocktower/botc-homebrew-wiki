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
  function wire(opts) {
    // Every write from the controls above repaints the sample below as well.
    var rawSet = opts.set;
    opts = { get: opts.get, onChange: opts.onChange, set: function (t) {
      rawSet(t);
      if (more) { paintSample(t); }
      if (opts.onChange) opts.onChange(t);
    } };
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
    textScale:  ['Size of everything', '%']
  };
  var CHOICE_LABELS = {
    bgFit:    ['Image fit', { cover: 'Fill the screen', contain: 'Whole image', tile: 'Tile / repeat', stretch: 'Stretch', center: 'Actual size, centred' }],
    bgPos:    ['Image position', { top: 'Top', center: 'Middle', bottom: 'Bottom' }],
    shadow:   ['Box shadow', { none: 'None', soft: 'Soft', strong: 'Strong', glow: 'Glow' }],
    width:    ['Page width', { narrow: 'Narrow', wide: 'Wide', full: 'Full screen' }],
    headCase: ['Heading letters', { upper: 'UPPERCASE', lower: 'lowercase', caps: 'Small Caps', none: 'As typed' }],
    align:    ['Paragraphs', { center: 'Centred', justify: 'Justified' }]
  };
  var COLOR_LABELS = {
    heading: 'Headings (if different from the accent)', bgColor: 'Page background colour',
    bgColor2: 'Gradient second colour', border: 'Box border', glow: 'Heading glow'
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
    if (kind === 'profile') {
      return '<div class="home-hero"><h1>Your Name</h1><p class="profile-bio">A short bio goes here, with a <a href="#">link</a>.</p></div>' +
        '<section class="prof-section"><h2 class="type-header">Characters</h2><p>Your cards appear in sections like this one.</p></section>';
    }
    if (kind === 'page' || kind === 'news') {
      return '<div class="wiki-page-head"><h1 class="wiki-title">Page Title</h1></div>' +
        '<div class="wiki-body"><h2 class="wiki-h">A heading</h2><p>Body text looks like this, with a <a href="#">link</a> in it.</p></div>';
    }
    return '<section class="script-chars-panel"><h2 class="gen-sech">Synopsis</h2>' +
      '<p class="script-desc">Body text looks like this, with a <a href="#">link</a> in it.</p></section>' +
      '<div class="card"><h2 class="info-h">Information</h2><dl class="info"><dt>Author</dt><dd><a href="#">You</a></dd></dl></div>';
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

    h += sec('Fonts', 'Body text font and any Google Font', 
      '<div class="thx-row"><label for="thx-bodyFont">Body text font</label><select id="thx-bodyFont" data-font="bodyFont">' + fontOpts + '</select></div>' +
      '<div class="thx-row"><label for="thx-gFont">Google Font for headings</label><input type="text" id="thx-gFont" data-gfont="gFont" list="thx-gfonts" placeholder="e.g. Creepster" maxlength="50"></div>' +
      '<div class="thx-row"><label for="thx-gBodyFont">Google Font for body text</label><input type="text" id="thx-gBodyFont" data-gfont="gBodyFont" list="thx-gfonts" placeholder="e.g. Lora" maxlength="50"></div>' +
      '<datalist id="thx-gfonts">' + POPULAR_FONTS.map(function (f) { return '<option value="' + escH(f) + '">'; }).join('') + '</datalist>' +
      '<p class="thx-sub">Type the exact name of any font on <a href="https://fonts.google.com" target="_blank" rel="noopener">fonts.google.com</a>. It replaces the font picked above it.</p>');
    h += sec('More colours', 'Background colour, gradient, borders, glow',
      ['heading', 'bgColor', 'bgColor2', 'border', 'glow'].map(colorRow).join('') + numRow('bgAngle') +
      '<p class="thx-sub">Pick a second colour to turn the background into a gradient.</p>');
    h += sec('Background image', 'How the uploaded background sits',
      choiceRow('bgFit') + choiceRow('bgPos') + numRow('bgDim') + numRow('bgBlur'));
    h += sec('Boxes', 'See-through, rounded, bordered, shadowed',
      numRow('panelAlpha') + numRow('radius') + numRow('borderW') + choiceRow('shadow'));
    h += sec('Layout & text', 'Width, size, heading style',
      choiceRow('width') + numRow('textScale') + choiceRow('headCase') + choiceRow('align'));
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
    var t = PR().sanitizeTheme ? (PR().sanitizeTheme(theme || {}, 'x') || {}) : {};
    // The sample cannot show an image that is not uploaded yet, but it can
    // show one the page already has (its path survives sanitizeTheme only
    // with the right base, so keep whatever the caller stored).
    if (theme && theme.background && /^[a-z0-9/-]+-bg\.(png|jpe?g|webp)$/i.test(theme.background)) t.background = theme.background;
    var ta = PR().themeAttrs ? PR().themeAttrs(t) : { cls: '', style: '', fonts: [] };
    var el = document.getElementById('thx-sample');
    if (el) {
      el.className = 'thx-sample ucss ' + ta.cls;
      el.setAttribute('style', ta.style);
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
      i.value = has ? theme[r[0]] : (r[0] === 'bgAngle' ? 180 : (r[3] != null ? r[3] : r[1]));
      showNum(r[0], has ? theme[r[0]] : null);
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-choice]'), function (i) {
      i.value = theme[i.getAttribute('data-choice')] || '';
    });
    var bf = $('thx-bodyFont'); if (bf) bf.value = theme.bodyFont || 'default';
    ['gFont', 'gBodyFont'].forEach(function (k) { var i = $('thx-' + k); if (i) i.value = theme[k] || ''; });
    var css = $('thx-css'); if (css) css.value = theme.css || '';
    paintSample(theme);
  }
  function showNum(k, v) {
    var st = $('thx-' + k + '-state');
    if (st) st.textContent = v == null ? 'default' : v + NUM_LABELS[k][1];
  }

  function mountMore(el, opts) {
    var kind = el.getAttribute('data-kind') || 'script';
    el.innerHTML = moreHTML(kind);
    more = { el: el, opts: opts, kind: kind };
    el.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b || !el.contains(b)) return;
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
      if ((k = i.getAttribute('data-choice'))) {
        update(function (t) { if (i.value) t[k] = i.value; else delete t[k]; });
      } else if ((k = i.getAttribute('data-font'))) {
        update(function (t) { if (i.value && i.value !== 'default') t[k] = i.value; else delete t[k]; });
      }
    });
    primeMore(opts.get() || {});
  }

  /* Paint a theme onto any element of an editor's own preview (publish-page,
     publish-news): the same classes, custom properties and scoped CSS the
     published page gets, on that element instead of <body>. */
  function applyTo(el, theme) {
    if (!el) return;
    var t = PR().sanitizeTheme ? (PR().sanitizeTheme(theme || {}, 'x') || {}) : {};
    if (theme && theme.background && /^[a-z0-9/-]+-bg\.(png|jpe?g|webp)$/i.test(theme.background)) t.background = theme.background;
    var ta = PR().themeAttrs ? PR().themeAttrs(t) : { cls: '', style: '', fonts: [] };
    var keep = (el.getAttribute('data-thx-base') || el.className.replace(/\b(page-themed|theme-\S+|ucss|thx-preview)\b/g, '').trim());
    el.setAttribute('data-thx-base', keep);
    el.className = (keep + ' thx-preview ucss ' + ta.cls).trim();
    el.setAttribute('style', ta.style);
    (ta.fonts || []).forEach(loadFont);
    if (!more) paintCss(t.css || '');
  }

  window.ThemeEditor = { wire: wire, prime: prime, paintPreviews: paintPreviews,
                         syncSizerRows: syncSizerRows, mountMore: mountMore, applyTo: applyTo };
})();
