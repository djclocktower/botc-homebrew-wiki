/* script-builder-view.js — the Script Builder's View settings.
 *
 * Everything about HOW the builder draws a script, as opposed to what is on
 * it: the roster's layout (sheet, cards, list, icon wall), its look, its
 * size, its columns, what each row shows, how the panel is grouped. None of
 * it touches the script — the same roster exports, publishes and shares
 * identically under every one of these — so it is kept in the reader's own browser (botc_builder_prefs.view,
 * written by script-builder.js) and never in the script's meta.
 *
 * Three parts, and the split is the point:
 *
 *   VIEW_SCHEMA  is the whole list of settings — key, control, options, and
 *                `repaint`, which says what the controller has to redraw when
 *                it changes ('roster', 'panel', or nothing at all). A new
 *                setting is one row here plus the CSS that reads it.
 *   apply()      turns a view object into CSS custom properties, data-
 *                attributes and classes on the builder's root. Most settings
 *                are pure CSS from there and cost no re-render.
 *   mount()      builds the popover's controls from the schema, so the
 *                controls and the settings cannot drift apart.
 *
 * Styles are .sbx-view* in styles.css. Browser only.
 */
(function (global) {
  'use strict';

  var DEFAULTS = {
    layout: 'sheet',      // sheet | cards | list | icons
    look: 'parchment',    // parchment | dark | printed
    size: 'normal',       // small | normal | large — icons, text, spacing
    columns: 'auto',      // auto | 1 | 2 (the whole script down two columns)
    teamColour: 'heads',  // off | heads | rows
    teamHeads: true,
    showAbility: true,
    showCreator: false,   // on the roster AND in the panel
    showTags: false,
    showNight: false,
    showJinx: true,
    showNotes: true,      // the script's own note under a character
    panelGroup: 'team',   // team | creator | set | name
    // Kept with the view but set elsewhere: Arrange is a button beside Sort,
    // the panel's Show is a select in the panel itself.
    arrange: false,
    panelScope: 'all'     // all | off (not on the script) | on
  };

  /* One row per setting. `repaint` names what the controller must redraw:
     'roster' (the row markup carries something this changes), 'panel'
     (the add list does), or '' for a setting CSS alone can honour.
     `ui: false` rows are stored here but drawn by the page, not the popover. */
  var VIEW_SCHEMA = [
    { group: 'Roster', key: 'layout', label: 'Layout', type: 'seg', repaint: '',
      options: [['sheet', 'Sheet'], ['cards', 'Cards'], ['list', 'List'], ['icons', 'Icons']],
      hint: 'Sheet is the character sheet, Cards the browse grid, List one line each, Icons the art alone.' },
    { group: 'Roster', key: 'look', label: 'Look', type: 'seg', repaint: '',
      options: [['parchment', 'Parchment'], ['dark', 'Dark'], ['printed', 'Printed']] },
    { group: 'Roster', key: 'size', label: 'Size', type: 'seg', repaint: '',
      options: [['small', 'Small'], ['normal', 'Normal'], ['large', 'Large']],
      hint: 'Icons, text and spacing together, in the roster and the panel.' },
    { group: 'Roster', key: 'columns', label: 'Columns', type: 'seg', repaint: '',
      options: [['auto', 'Auto'], ['1', '1'], ['2', '2']],
      hint: '2 pours the whole script down two columns, like a printed sheet.' },
    { group: 'Roster', key: 'teamColour', label: 'Team colours', type: 'seg', repaint: '',
      options: [['off', 'Off'], ['heads', 'Headings'], ['rows', 'Headings and rows']] },
    { group: 'Roster', key: 'teamHeads', label: 'Team headings', type: 'check', repaint: 'roster' },

    { group: 'Show on each character', key: 'showAbility', label: 'Ability', type: 'check', repaint: '' },
    { group: 'Show on each character', key: 'showCreator', label: 'Creator', type: 'check', repaint: 'roster' },
    { group: 'Show on each character', key: 'showTags', label: 'Tags', type: 'check', repaint: 'roster' },
    { group: 'Show on each character', key: 'showNight', label: 'Night marks (F / O)', type: 'check', repaint: 'roster' },
    { group: 'Show on each character', key: 'showJinx', label: 'Jinx marks', type: 'check', repaint: 'roster' },
    { group: 'Show on each character', key: 'showNotes', label: 'Your notes', type: 'check', repaint: 'roster' },

    { group: 'Character panel', key: 'panelGroup', label: 'Grouped by', type: 'seg', repaint: 'panel',
      options: [['team', 'Team'], ['creator', 'Creator'], ['set', 'Set'], ['name', 'A to Z']],
      hint: 'Set is the script or collection a character is filed under.' },

    { key: 'arrange', type: 'check', repaint: 'roster', ui: false },
    { key: 'panelScope', type: 'select', repaint: '', ui: false,
      options: [['all', 'Everyone'], ['off', 'Not on the script'], ['on', 'On the script']] }
  ];

  /* What each Size means, per layout: the icon a layout wants is its own
     (a card is mostly picture, a list row hardly any), and the rest follow
     the size alone. The old sliders' defaults are the Normal row. */
  var ICON = { sheet: 40, cards: 56, list: 28, icons: 64 };
  var SIZES = {
    small:  { icon: 0.75, text: 0.9,  density: 'compact',     panelIcon: 22, panelText: 0.9,  panelCompact: true },
    normal: { icon: 1,    text: 1,    density: 'comfortable', panelIcon: 26, panelText: 1,    panelCompact: false },
    large:  { icon: 1.4,  text: 1.25, density: 'roomy',       panelIcon: 34, panelText: 1.15, panelCompact: false }
  };
  var LOOKS = {
    parchment: { tone: 'parchment', font: 'wiki' },
    dark:      { tone: 'dark',      font: 'wiki' },
    printed:   { tone: 'paper',     font: 'print' }
  };

  var byKey = {};
  VIEW_SCHEMA.forEach(function (s) { byKey[s.key] = s; });

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* A view stored by the builder before the settings were merged, read into
     the merged ones so a reader's choices survive: the paper and type became
     Look, the two column settings Columns, the two colour switches Team
     colours. The sizes start over at Normal. */
  function migrate(v) {
    if (v.look == null && (v.tone != null || v.font != null)) {
      v.look = v.tone === 'dark' ? 'dark' : (v.tone === 'paper' || v.font === 'print') ? 'printed' : 'parchment';
    }
    if (v.columns != null && v.pageCols != null) {
      v.columns = v.pageCols ? '2' : (String(v.columns) === '1' ? '1' : 'auto');
    }
    if (v.teamColour == null && (v.accent != null || v.rowStripe != null)) {
      v.teamColour = v.accent === false ? 'off' : v.rowStripe ? 'rows' : 'heads';
    }
    if (v.teamHeads == null && v.teamLabel != null) v.teamHeads = v.teamLabel !== 'none';
    if (v.showCreator == null && v.panelCreator) v.showCreator = true;
    return v;
  }

  /* Whatever was stored, made whole and legal: every key present, every
     value one the schema allows. A setting from a later version that this
     build does not know is dropped rather than kept as a stranger. */
  function normalize(v) {
    v = (v && typeof v === 'object') ? migrate(Object.assign({}, v)) : {};
    var out = {};
    VIEW_SCHEMA.forEach(function (s) {
      var d = DEFAULTS[s.key];
      var x = v[s.key];
      if (s.type === 'check') { out[s.key] = x == null ? d : !!x; return; }
      var ok = s.options.some(function (o) { return o[0] === String(x); });
      out[s.key] = ok ? String(x) : d;
    });
    return out;
  }

  function isDefault(v) {
    v = normalize(v);
    return VIEW_SCHEMA.every(function (s) { return s.ui === false || v[s.key] === DEFAULTS[s.key]; });
  }

  /* View -> the DOM. Everything CSS can read is written here, once, and the
     stylesheet does the rest. `root` is the builder's grid (#sbx). */
  function apply(root, v) {
    if (!root) return;
    v = normalize(v);
    var size = SIZES[v.size], look = LOOKS[v.look];
    root.setAttribute('data-layout', v.layout);
    root.setAttribute('data-cols', v.columns === 'auto' ? 'auto' : '1');
    /* The two-column FLOW, not the per-team grid: the whole roster poured
       down two columns of the page, the way a printed script sheet reads.
       It is dropped while Arrange is on — a row lifted out of a multicol
       flow lands back in the wrong column, and arranging is the one mode
       where where a row sits has to be exactly where it looks. */
    root.classList.toggle('sbx-two-col', v.columns === '2' && !v.arrange);
    root.setAttribute('data-density', size.density);
    root.setAttribute('data-font', look.font);
    root.setAttribute('data-tone', look.tone);
    root.setAttribute('data-panelscope', v.panelScope);
    root.style.setProperty('--sbx-icon', (Math.round(ICON[v.layout] * size.icon / 2) * 2) + 'px');
    root.style.setProperty('--sbx-text', String(size.text));
    root.style.setProperty('--sbx-panel-icon', size.panelIcon + 'px');
    root.style.setProperty('--sbx-panel-text', String(size.panelText));
    var cls = {
      'sbx-no-ability': !v.showAbility,
      'sbx-no-accent': v.teamColour === 'off',
      'sbx-row-stripe': v.teamColour === 'rows',
      'sbx-panel-compact': size.panelCompact,
      'sbx-panel-creator': v.showCreator
    };
    Object.keys(cls).forEach(function (k) { root.classList.toggle(k, !!cls[k]); });
  }

  function teamHeading(team, label, v) {
    v = v || DEFAULTS;
    return v.teamHeads === false ? '' : label;
  }

  /* ── the popover ──────────────────────────────────────────────────── */
  function controlHTML(s, v) {
    var id = 'sbv-' + s.key;
    var val = v[s.key];
    if (s.type === 'check') {
      return '<label class="sbx-view-check"><input type="checkbox" id="' + id + '" data-key="' + s.key + '"' +
        (val ? ' checked' : '') + '> <span>' + esc(s.label) + '</span></label>';
    }
    var out = '<div class="sbx-view-row"><span class="sbx-view-label" id="' + id + '-l">' + esc(s.label) + '</span>';
    if (s.type === 'seg') {
      out += '<div class="sbx-view-seg" role="group" aria-labelledby="' + id + '-l" data-key="' + s.key + '">' +
        s.options.map(function (o) {
          return '<button type="button" data-value="' + esc(o[0]) + '" class="' + (String(val) === o[0] ? 'on' : '') +
            '" aria-pressed="' + (String(val) === o[0] ? 'true' : 'false') + '">' + esc(o[1]) + '</button>';
        }).join('') + '</div>';
    }
    if (s.hint) out += '<p class="sbx-view-hint">' + esc(s.hint) + '</p>';
    return out + '</div>';
  }

  /* host: the popover's body. opts.get() -> the view; opts.set(view, key)
     stores and applies it (key is what changed, '' for a reset). */
  function mount(host, opts) {
    if (!host) return null;
    opts = opts || {};
    var get = function () { return normalize(opts.get ? opts.get() : {}); };

    function render() {
      var v = get();
      var groups = [];
      var seen = {};
      VIEW_SCHEMA.forEach(function (s) {
        if (s.ui === false) return;
        if (!seen[s.group]) { seen[s.group] = { name: s.group, rows: [] }; groups.push(seen[s.group]); }
        seen[s.group].rows.push(s);
      });
      var html = '';
      groups.forEach(function (g) {
        html += '<fieldset class="sbx-view-group"><legend>' + esc(g.name) + '</legend>';
        var checks = g.rows.filter(function (s) { return s.type === 'check'; });
        var others = g.rows.filter(function (s) { return s.type !== 'check'; });
        others.forEach(function (s) { html += controlHTML(s, v); });
        if (checks.length) {
          html += '<div class="sbx-view-checks">' + checks.map(function (s) { return controlHTML(s, v); }).join('') + '</div>';
        }
        html += '</fieldset>';
      });
      html += '<div class="sbx-view-foot">' +
        '<button type="button" class="sbx-b-sm" id="sbv-reset"' + (isDefault(v) ? ' disabled' : '') + '>' +
          (window.UIIcons ? window.UIIcons.svg('reset') : '') + ' Back to the default look</button>' +
        '</div>';
      host.innerHTML = html;
    }

    function change(key, value) {
      var v = get();
      var s = byKey[key];
      if (!s) return;
      if (s.type === 'check') v[key] = !!value;
      else v[key] = String(value);
      v = normalize(v);
      if (opts.set) opts.set(v, key);
      // Keep the segmented buttons and the reset button honest without a
      // whole re-render.
      if (s.type === 'seg') {
        [].slice.call(host.querySelectorAll('.sbx-view-seg[data-key="' + key + '"] button')).forEach(function (b) {
          var on = b.getAttribute('data-value') === v[key];
          b.classList.toggle('on', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
      }
      var reset = host.querySelector('#sbv-reset');
      if (reset) reset.disabled = isDefault(v);
    }

    host.addEventListener('click', function (e) {
      var seg = e.target.closest && e.target.closest('.sbx-view-seg button');
      if (seg) { change(seg.parentNode.getAttribute('data-key'), seg.getAttribute('data-value')); return; }
      if (e.target.closest && e.target.closest('#sbv-reset')) {
        // Back to the default look, keeping what is set outside the popover.
        var keep = get(), d = normalize({});
        VIEW_SCHEMA.forEach(function (s) { if (s.ui === false) d[s.key] = keep[s.key]; });
        if (opts.set) opts.set(d, '');
        render();
      }
    });
    host.addEventListener('change', function (e) {
      var t = e.target;
      if (!t || !t.getAttribute) return;
      var key = t.getAttribute('data-key');
      if (!key) return;
      if (t.type === 'checkbox') change(key, t.checked);
      else if (t.tagName === 'SELECT') change(key, t.value);
    });
    render();
    return { render: render };
  }

  global.SBView = {
    DEFAULTS: DEFAULTS,
    SCHEMA: VIEW_SCHEMA,
    normalize: normalize,
    isDefault: isDefault,
    apply: apply,
    teamHeading: teamHeading,
    repaintFor: function (key) { return byKey[key] ? byKey[key].repaint : ''; },
    mount: mount
  };
})(typeof window !== 'undefined' ? window : this);
