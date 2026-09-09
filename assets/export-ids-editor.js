/* ── "Character IDs in the JSON export" ─────────────────────────────────
   The official schema's `id` is what every tool pairs characters by, and
   this wiki has 166 names that more than one page answers to — four Wardens,
   two Changelings. Squashing the name gave all four `warden`, so loading two
   of the wiki's scripts into one tool made three of them disappear into the
   first. Every export now qualifies the id (Render.exportId), and this is the
   page owner's say over the shape of it, plus their own text wrapped around
   it.

   Mounted by publish-script.html AND publish-collection.html so the two page
   types cannot word — or store — the same setting differently. What it stores
   is what sanitizeExportIds() in worker.js stores: {mode, prefix, suffix},
   and the DEFAULT stores nothing at all, so a page nobody has touched keeps
   following the site's rule rather than freezing today's answer into the row.

   The sample line is the whole point of the control: a mode name means
   nothing next to the id it actually produces, so the widget asks the page
   for a character off its own roster and shows what that character will
   export as. With no roster yet it falls back to a made-up Warden, which
   still shows the shape.

   No fetch, no page markup of its own beyond what it builds here; the styles
   are the editors' existing .sb-fld / .sub furniture. */
(function () {
  var FALLBACK = {
    name: 'Warden', slug: 'warden', creator: 'Anna Example',
    ownerName: '', page: 'c/example-set/warden'
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function modes() {
    return (typeof window !== 'undefined' && window.EXPORT_ID_MODES) || [
      { key: 'full', label: 'Name + creator + set', hint: '' }
    ];
  }

  /* host: the element to build into.
     opts.onChange(value)  called on every edit, with {mode, prefix, suffix}
                           — or null when the setting is the default, which is
                           what the row stores.
     opts.getSample()      one character off the page's roster, or null.
     opts.getSet()         the set name the export will qualify by (the
                           script's slug / the collection's id). */
  function mount(host, opts) {
    if (!host) return null;
    opts = opts || {};
    var list = modes();
    host.innerHTML =
      '<div class="sb-fld">' +
        '<label for="xid-mode">Character IDs in the JSON export</label>' +
        '<select id="xid-mode">' +
          list.map(function (m) {
            return '<option value="' + esc(m.key) + '">' + esc(m.label) + '</option>';
          }).join('') +
        '</select>' +
        '<p class="sub" id="xid-hint" style="margin-top:6px"></p>' +
      '</div>' +
      '<div class="sb-fld">' +
        '<label for="xid-prefix">Add your own text</label>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
          '<input type="text" id="xid-prefix" maxlength="24" placeholder="Before (optional)" style="flex:1 1 140px;min-width:0">' +
          '<input type="text" id="xid-suffix" maxlength="24" placeholder="After (optional)" style="flex:1 1 140px;min-width:0">' +
        '</div>' +
        '<p class="sub" style="margin-top:6px">Letters, numbers, spaces, <code>-</code> and <code>_</code>. Anything else is dropped.</p>' +
      '</div>' +
      '<p class="sub" id="xid-sample" style="margin-top:2px"></p>' +
      '<p class="sub" style="margin-top:8px">Official characters on this script keep their own ids (<code>imp</code>, <code>poisoner</code>) — those are the app’s own keys and are never changed.</p>';

    var sel = host.querySelector('#xid-mode');
    var pre = host.querySelector('#xid-prefix');
    var suf = host.querySelector('#xid-suffix');
    var hint = host.querySelector('#xid-hint');
    var sample = host.querySelector('#xid-sample');

    function value() {
      var v = {
        mode: sel.value || 'full',
        prefix: pre.value.trim(),
        suffix: suf.value.trim()
      };
      // The default is stored as nothing — same reasoning as the theme kit's
      // sizes: a page nobody touched follows the site, not today's default.
      if (v.mode === 'full' && !v.prefix && !v.suffix) return null;
      return v;
    }

    function paint() {
      var m = null;
      for (var i = 0; i < list.length; i++) if (list[i].key === sel.value) m = list[i];
      hint.textContent = (m && m.hint) || '';
      var c = (opts.getSample && opts.getSample()) || FALLBACK;
      var setName = opts.getSet ? opts.getSet() : '';
      if (typeof window.exportId === 'function') {
        var id = window.exportId(c, {
          mode: sel.value || 'full',
          prefix: pre.value.trim(),
          suffix: suf.value.trim(),
          set: setName || undefined
        });
        sample.innerHTML = '<strong>' + esc(c.name || 'Warden') + '</strong> exports as <code>' + esc(id) + '</code>';
      } else {
        sample.textContent = '';
      }
    }

    function changed() {
      paint();
      if (opts.onChange) opts.onChange(value());
    }
    sel.addEventListener('change', changed);
    pre.addEventListener('input', changed);
    suf.addEventListener('input', changed);

    paint();
    return {
      get: value,
      // Re-draw the sample without reporting a change: the roster moved, or
      // the script was finally given a name to qualify ids by.
      refresh: paint,
      set: function (v) {
        v = v || {};
        sel.value = v.mode || 'full';
        if (!sel.value) sel.value = 'full';
        pre.value = v.prefix || '';
        suf.value = v.suffix || '';
        paint();
      }
    };
  }

  if (typeof window !== 'undefined') window.ExportIdsEditor = { mount: mount };
})();
