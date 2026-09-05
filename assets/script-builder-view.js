/* script-builder-view.js — the Script Builder's View settings.
 *
 * Everything about HOW the builder draws a script, as opposed to what is on
 * it: the roster's layout (sheet, cards, list, icon wall), its columns, the
 * size of the icons and the text, what each row shows, the order inside a
 * team, the panel's side and density. None of it touches the script — the
 * same roster exports, publishes and shares identically under every one of
 * these — so it is kept in the reader's own browser (botc_builder_prefs.view,
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
    columns: 'auto',      // auto | 1 | 2 | 3
    order: 'added',       // added | name | sao | night
    teamLabel: 'full',    // full | short | none
    density: 'comfortable', // compact | comfortable | roomy
    font: 'wiki',         // wiki | plain | print
    accent: true,         // team colours on the headings and rules
    icon: 40,             // px
    text: 100,            // %
    showAbility: true,
    showCreator: false,
    showTags: false,
    showNight: false,
    showJinx: true,
    showOfficial: true,
    showCounts: true,
    removeHover: false,   // the ✕ only on hover
    side: 'left',         // left | right
    panelIcon: 26,        // px
    panelCompact: false,
    panelHideOn: false,   // hide characters already on the script
    motion: true
  };

  var TEAM_SHORT = {
    townsfolk: 'TF', outsider: 'OUT', minion: 'MIN', demon: 'DEM',
    traveller: 'TRAV', fabled: 'FAB', loric: 'LOR'
  };

  /* One row per setting. `repaint` names what the controller must redraw:
     'roster' (the row markup carries something this changes), 'panel'
     (the add list does), or '' for a setting CSS alone can honour. */
  var VIEW_SCHEMA = [
    { group: 'Roster', key: 'layout', label: 'Layout', type: 'seg', repaint: '',
      options: [['sheet', 'Sheet'], ['cards', 'Cards'], ['list', 'List'], ['icons', 'Icons']],
      hint: 'Sheet reads like the character sheet; Cards is the browse grid; List is one line each; Icons is a wall of art.' },
    { group: 'Roster', key: 'columns', label: 'Columns', type: 'seg', repaint: '',
      options: [['auto', 'Auto'], ['1', '1'], ['2', '2'], ['3', '3']] },
    { group: 'Roster', key: 'order', label: 'Order inside a team', type: 'select', repaint: 'roster',
      options: [['added', 'As arranged'], ['name', 'A to Z'], ['sao', 'Steven Approved Order'], ['night', 'Night order']],
      hint: 'How the roster is shown here. The export and the published page keep the arranged order — use Sort to change that.' },
    { group: 'Roster', key: 'teamLabel', label: 'Team headings', type: 'seg', repaint: 'roster',
      options: [['full', 'Full'], ['short', 'Short'], ['none', 'None']] },
    { group: 'Roster', key: 'density', label: 'Spacing', type: 'seg', repaint: '',
      options: [['compact', 'Tight'], ['comfortable', 'Normal'], ['roomy', 'Airy']] },
    { group: 'Roster', key: 'accent', label: 'Team colours on the headings', type: 'check', repaint: '' },

    { group: 'Size', key: 'icon', label: 'Icon size', type: 'range', min: 20, max: 96, step: 2, unit: 'px', repaint: '' },
    { group: 'Size', key: 'text', label: 'Text size', type: 'range', min: 75, max: 140, step: 5, unit: '%', repaint: '' },
    { group: 'Size', key: 'font', label: 'Type', type: 'seg', repaint: '',
      options: [['wiki', 'Wiki'], ['plain', 'Plain'], ['print', 'Print']] },

    { group: 'Show on each character', key: 'showAbility', label: 'Ability', type: 'check', repaint: '' },
    { group: 'Show on each character', key: 'showCreator', label: 'Creator', type: 'check', repaint: 'roster' },
    { group: 'Show on each character', key: 'showTags', label: 'Tags', type: 'check', repaint: 'roster' },
    { group: 'Show on each character', key: 'showNight', label: 'Night marks (F / O)', type: 'check', repaint: 'roster' },
    { group: 'Show on each character', key: 'showJinx', label: 'Jinx marks', type: 'check', repaint: 'roster' },
    { group: 'Show on each character', key: 'showOfficial', label: 'Official badge', type: 'check', repaint: '' },
    { group: 'Show on each character', key: 'removeHover', label: 'Remove button only on hover', type: 'check', repaint: '' },
    { group: 'Show on each character', key: 'showCounts', label: 'Team counts in the bar', type: 'check', repaint: '' },

    { group: 'Character panel', key: 'side', label: 'Panel side', type: 'seg', repaint: '',
      options: [['left', 'Left'], ['right', 'Right']] },
    { group: 'Character panel', key: 'panelIcon', label: 'Panel icon size', type: 'range', min: 16, max: 56, step: 2, unit: 'px', repaint: '' },
    { group: 'Character panel', key: 'panelCompact', label: 'Tighter rows', type: 'check', repaint: '' },
    { group: 'Character panel', key: 'panelHideOn', label: 'Hide characters already on the script', type: 'check', repaint: '' },

    { group: 'Motion', key: 'motion', label: 'Animations', type: 'check', repaint: '' }
  ];

  /* Quick looks: a few whole views, applied on top of the current one. Only
     the keys named move, so a preset never resets a size somebody chose. */
  var PRESETS = [
    { key: 'sheet', label: 'Character sheet',
      view: { layout: 'sheet', columns: 'auto', density: 'comfortable', icon: 40, text: 100, showAbility: true, font: 'wiki', teamLabel: 'full' } },
    { key: 'cards', label: 'Card grid',
      view: { layout: 'cards', columns: 'auto', density: 'comfortable', icon: 56, showAbility: true, teamLabel: 'full' } },
    { key: 'list', label: 'Tight list',
      view: { layout: 'list', columns: '1', density: 'compact', icon: 24, text: 90, showAbility: true, teamLabel: 'short' } },
    { key: 'icons', label: 'Icon wall',
      view: { layout: 'icons', columns: 'auto', density: 'comfortable', icon: 64, showAbility: false, teamLabel: 'full' } },
    { key: 'big', label: 'Big print',
      view: { layout: 'sheet', columns: '1', density: 'roomy', icon: 56, text: 125, showAbility: true, font: 'print', teamLabel: 'full' } }
  ];

  var byKey = {};
  VIEW_SCHEMA.forEach(function (s) { byKey[s.key] = s; });

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* Whatever was stored, made whole and legal: every key present, every
     value one the schema allows. A setting from a later version that this
     build does not know is dropped rather than kept as a stranger. */
  function normalize(v) {
    v = (v && typeof v === 'object') ? v : {};
    var out = {};
    VIEW_SCHEMA.forEach(function (s) {
      var d = DEFAULTS[s.key];
      var x = v[s.key];
      if (s.type === 'check') { out[s.key] = x == null ? d : !!x; return; }
      if (s.type === 'range') {
        x = Number(x);
        if (!isFinite(x)) x = d;
        out[s.key] = Math.min(s.max, Math.max(s.min, Math.round(x / s.step) * s.step));
        return;
      }
      var ok = s.options.some(function (o) { return o[0] === String(x); });
      out[s.key] = ok ? String(x) : d;
    });
    return out;
  }

  function isDefault(v) {
    v = normalize(v);
    return VIEW_SCHEMA.every(function (s) { return v[s.key] === DEFAULTS[s.key]; });
  }

  /* View -> the DOM. Everything CSS can read is written here, once, and the
     stylesheet does the rest. `root` is the builder's grid (#sbx). */
  function apply(root, v) {
    if (!root) return;
    v = normalize(v);
    root.setAttribute('data-layout', v.layout);
    root.setAttribute('data-cols', v.columns);
    root.setAttribute('data-density', v.density);
    root.setAttribute('data-font', v.font);
    root.setAttribute('data-side', v.side);
    root.setAttribute('data-teamlabel', v.teamLabel);
    root.style.setProperty('--sbx-icon', v.icon + 'px');
    root.style.setProperty('--sbx-text', String(v.text / 100));
    root.style.setProperty('--sbx-panel-icon', v.panelIcon + 'px');
    var cls = {
      'sbx-no-ability': !v.showAbility,
      'sbx-no-official': !v.showOfficial,
      'sbx-no-counts': !v.showCounts,
      'sbx-remove-hover': v.removeHover,
      'sbx-no-accent': !v.accent,
      'sbx-no-motion': !v.motion,
      'sbx-panel-compact': v.panelCompact,
      'sbx-panel-hide-on': v.panelHideOn
    };
    Object.keys(cls).forEach(function (k) { root.classList.toggle(k, !!cls[k]); });
    // The document root carries the motion flag too, for the drawer and the
    // popovers that live outside the grid.
    document.documentElement.classList.toggle('sbx-no-motion', !v.motion);
  }

  function teamHeading(team, label, v) {
    v = v || DEFAULTS;
    if (v.teamLabel === 'none') return '';
    if (v.teamLabel === 'short') return TEAM_SHORT[team] || label;
    return label;
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
    } else if (s.type === 'select') {
      out += '<select id="' + id + '" data-key="' + s.key + '" aria-labelledby="' + id + '-l">' +
        s.options.map(function (o) {
          return '<option value="' + esc(o[0]) + '"' + (String(val) === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
        }).join('') + '</select>';
    } else if (s.type === 'range') {
      out += '<span class="sbx-view-range"><input type="range" id="' + id + '" data-key="' + s.key + '" min="' + s.min +
        '" max="' + s.max + '" step="' + s.step + '" value="' + val + '" aria-labelledby="' + id + '-l">' +
        '<output for="' + id + '">' + val + esc(s.unit || '') + '</output></span>';
    }
    if (s.hint) out += '<p class="sbx-view-hint">' + esc(s.hint) + '</p>';
    return out + '</div>';
  }

  /* host: the popover's body. opts.get() -> the view; opts.set(view, key)
     stores and applies it (key is what changed, '' for a preset / reset). */
  function mount(host, opts) {
    if (!host) return null;
    opts = opts || {};
    var get = function () { return normalize(opts.get ? opts.get() : {}); };

    function render() {
      var v = get();
      var groups = [];
      var seen = {};
      VIEW_SCHEMA.forEach(function (s) {
        if (!seen[s.group]) { seen[s.group] = { name: s.group, rows: [] }; groups.push(seen[s.group]); }
        seen[s.group].rows.push(s);
      });
      var html = '<div class="sbx-view-presets" role="group" aria-label="Quick looks">' +
        PRESETS.map(function (p) {
          return '<button type="button" class="sbx-view-preset" data-preset="' + esc(p.key) + '">' + esc(p.label) + '</button>';
        }).join('') + '</div>';
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
        '<button type="button" class="sbx-b-sm" id="sbv-reset"' + (isDefault(v) ? ' disabled' : '') + '>&#8634; Back to the default look</button>' +
        '</div>';
      host.innerHTML = html;
    }

    function change(key, value) {
      var v = get();
      var s = byKey[key];
      if (!s) return;
      if (s.type === 'check') v[key] = !!value;
      else if (s.type === 'range') v[key] = Number(value);
      else v[key] = String(value);
      v = normalize(v);
      if (opts.set) opts.set(v, key);
      // Keep the segmented buttons and the reset button honest without a
      // whole re-render (a slider in flight must not lose its thumb).
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
      var pre = e.target.closest && e.target.closest('.sbx-view-preset');
      if (pre) {
        var p = null;
        PRESETS.forEach(function (x) { if (x.key === pre.getAttribute('data-preset')) p = x; });
        if (!p) return;
        var v = get();
        Object.keys(p.view).forEach(function (k) { v[k] = p.view[k]; });
        if (opts.set) opts.set(normalize(v), '');
        render();
        return;
      }
      if (e.target.closest && e.target.closest('#sbv-reset')) {
        if (opts.set) opts.set(normalize({}), '');
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
      else if (t.type === 'range') change(key, t.value);
    });
    // Sliders follow the thumb live; the output beside them too.
    host.addEventListener('input', function (e) {
      var t = e.target;
      if (!t || t.type !== 'range') return;
      var key = t.getAttribute('data-key');
      var out = t.nextElementSibling;
      if (out) out.textContent = t.value + ((byKey[key] && byKey[key].unit) || '');
      change(key, t.value);
    });

    render();
    return { render: render };
  }

  global.SBView = {
    DEFAULTS: DEFAULTS,
    SCHEMA: VIEW_SCHEMA,
    PRESETS: PRESETS,
    normalize: normalize,
    isDefault: isDefault,
    apply: apply,
    teamHeading: teamHeading,
    repaintFor: function (key) { return byKey[key] ? byKey[key].repaint : ''; },
    mount: mount
  };
})(typeof window !== 'undefined' ? window : this);
