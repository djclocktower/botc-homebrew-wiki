/* Shared theme form controls for publish-script.html / publish-collection.html.
   Expects the page to contain: #th-font (select), #th-accent/#th-panel/#th-text/
   #th-link (color inputs) with matching #th-*-state labels and .th-clear buttons,
   plus #th-logosize (range) with #th-logosize-state and #th-logopanel (checkbox).
   Values are validated again by sanitizeTheme on save (client + server). */
(function () {
  var KEYS = ['accent', 'panel', 'text', 'link'];
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
    var size = $('th-logosize');
    if (size) {
      var min = (window.PageRender && window.PageRender.LOGO_SIZE_MIN) || 25;
      var max = (window.PageRender && window.PageRender.LOGO_SIZE_MAX) || 250;
      size.min = min; size.max = max; size.step = 5;
      size.addEventListener('input', function () {
        var t = opts.get() || {};
        var n = Math.round(Number(size.value));
        if (!isFinite(n) || n === 100) delete t.logoSize; else t.logoSize = n;
        opts.set(t);
        showSize(n);
      });
    }
    var panel = $('th-logopanel');
    if (panel) {
      panel.addEventListener('change', function () {
        var t = opts.get() || {};
        if (panel.checked) t.logoPanel = true; else delete t.logoPanel;
        opts.set(t);
      });
    }

    Array.prototype.forEach.call(document.querySelectorAll('.th-clear'), function (btn) {
      btn.addEventListener('click', function () {
        var k = btn.getAttribute('data-k');
        var t = opts.get() || {};
        delete t[k]; opts.set(t);
        if (k === 'logoSize') {
          var sz = $('th-logosize'); if (sz) sz.value = 100;
          showSize(100);
          return;
        }
        var st = $('th-' + k + '-state'); if (st) st.textContent = 'not set';
      });
    });
  }

  function showSize(n) {
    var st = $('th-logosize-state');
    if (st) st.textContent = (n === 100 ? 'default size' : n + '%');
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
    var size = $('th-logosize');
    var n = Number(theme.logoSize) || 100;
    if (size) size.value = n;
    showSize(n);
    var panel = $('th-logopanel');
    if (panel) panel.checked = !!theme.logoPanel;
    return !!(theme.font || theme.accent || theme.panel || theme.text || theme.link ||
      theme.background || theme.logoSize || theme.logoPanel);
  }

  window.ThemeEditor = { wire: wire, prime: prime };
})();
