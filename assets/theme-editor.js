/* Shared theme form controls for publish-script.html / publish-collection.html.
   Expects the page to contain: #th-font (select), #th-accent/#th-panel/#th-text/
   #th-link (color inputs) with matching #th-*-state labels and .th-clear buttons,
   plus the two top-graphic sizers #th-headersize / #th-logosize (range inputs,
   with #th-*-state labels) and #th-logopanel (checkbox).
   Values are validated again by sanitizeTheme on save (client + server).

   The two editors do not agree on element ids (sb-* vs pc-*), so the image
   previews this file has to keep in step are found by ATTRIBUTE instead:
   put data-th-preview="header" or data-th-preview="logo" on the <img>. */
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

  // opts.get() -> current theme object (may be null); opts.set(theme) persists it
  function wire(opts) {
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
  }

  function sizerFor(key) {
    for (var i = 0; i < SIZERS.length; i++) if (SIZERS[i].key === key) return SIZERS[i];
    return null;
  }

  function showSize(sz, n) {
    var st = $(sz.id + '-state');
    if (st) st.textContent = (n === 100 ? 'default size' : n + '%');
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
    return !!(theme.font || theme.accent || theme.panel || theme.text || theme.link ||
      theme.background || theme.logoSize || theme.headerSize || theme.logoPanel);
  }

  window.ThemeEditor = { wire: wire, prime: prime, paintPreviews: paintPreviews };
})();
