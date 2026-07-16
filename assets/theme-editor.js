/* Shared theme form controls for publish-script.html / publish-collection.html.
   Expects the page to contain: #th-font (select), #th-accent/#th-panel/#th-text/
   #th-link (color inputs) with matching #th-*-state labels and .th-clear buttons.
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
    Array.prototype.forEach.call(document.querySelectorAll('.th-clear'), function (btn) {
      btn.addEventListener('click', function () {
        var k = btn.getAttribute('data-k');
        var t = opts.get() || {};
        delete t[k]; opts.set(t);
        var st = $('th-' + k + '-state'); if (st) st.textContent = 'not set';
      });
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
    return !!(theme.font || theme.accent || theme.panel || theme.text || theme.link || theme.background);
  }

  window.ThemeEditor = { wire: wire, prime: prime };
})();
