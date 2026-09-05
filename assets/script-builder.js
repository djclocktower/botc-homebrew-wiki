/* script-builder.js — everything behind /script (script.html).
 *
 * The page is the markup; this is the whole of its behaviour. It used to be
 * one long inline <script>, which meant it could not be `node --check`ed and
 * could not be read without scrolling past 200 lines of CSS.
 *
 * ── Why it is shaped like this ──────────────────────────────────────────
 * Adding a character used to take two to three seconds. Every click ran a
 * full repaint of four separate things: the whole roster's innerHTML, the
 * night-order arranger, the jinx editor, and a querySelectorAll over all
 * ~1,900 sidebar rows to repaint their ticks. So the rules here are:
 *
 *   1. A click touches ONE sidebar row. Every row is kept in `rowBySlug`
 *      when the list is built, so there is no query to run.
 *   2. The roster is small (a script is 25-ish characters), so it is rebuilt
 *      whole — that is genuinely cheap, and nothing else is.
 *   3. The night order and the jinx list are only built when their tab is
 *      actually on screen. Off screen they are marked dirty and left alone.
 *   4. Anything that is nice-to-have rather than immediate — the jinx count
 *      on the tab, the credits line, saving to the library — happens in one
 *      debounced pass after the clicking stops.
 *
 * The other half is the shell: the document itself does not scroll (see the
 * .sbx block in styles.css), the two panes do. That is what removes the band
 * of empty page under the character list.
 *
 * ── What is stored where ───────────────────────────────────────────────
 *   botc_script          the current roster, an array of slugs. Shared with
 *                        publish-script.html and the "add to script" button
 *                        on character pages — do not rename it.
 *   botc_script_meta     the current script's details: name, author, night
 *                        order, jinx edits, the official-app options, and
 *                        editSlug when it is an edit of a published page.
 *                        publish-script.html reads all of it.
 *   botc_script_library  up to 15 saved scripts, each {id, chars, meta}.
 *                        Purely this page's; nothing else reads it.
 *   botc_builder_prefs   panel width, inline abilities, which tab was open.
 */
(function () {
  'use strict';

  var SCRIPT_KEY = 'botc_script';
  var META_KEY = 'botc_script_meta';
  var LIB_KEY = 'botc_script_library';
  var PREF_KEY = 'botc_builder_prefs';
  var CREDITS_KEY = 'botc_script_credits_detail';
  var LIB_MAX = 15;

  var TEAMS = [['townsfolk', 'Townsfolk'], ['outsider', 'Outsider'], ['minion', 'Minion'],
               ['demon', 'Demon'], ['traveller', 'Traveller'], ['fabled', 'Fabled'],
               ['loric', 'Loric']];
  var TEAM_INDEX = {};
  TEAMS.forEach(function (t, i) { TEAM_INDEX[t[0]] = i; });

  var SITE_ROOT = new URL('.', location.href).href;

  // ── state ──────────────────────────────────────────────────────────────
  var allChars = [];        // this wiki's characters
  var officialChars = [];   // the official roster, merged with its night order
  var bySlug = {};          // both of the above, by slug
  var order = [];           // the current script, in order
  var sel = {};             // the same, as a set, for O(1) "is it on?"
  var rowBySlug = {};       // slug -> the sidebar row's button element
  var rosterCache = null;   // rosterChars(), invalidated on every change

  var nightUI = null, jinxUI = null;
  var nightDirty = true, jinxDirty = true, analyseDirty = true;
  var activeTab = 'script';

  // How the roster is drawn (assets/script-builder-view.js). Never part of
  // the script: the same roster exports and publishes identically under
  // every view, so it lives with the browser's other preferences.
  var view = null;

  // ── tiny helpers ───────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  /* The 192px WebP thumbnail beside the art (PageRender.thumbSrc): ~8 KB
     against the original's ~150 KB, and this list draws 1,900 of them. The
     Worker serves the original at the thumbnail URL when none exists yet. */
  function artOf(c) {
    var PR = window.PageRender;
    if (PR && PR.thumbSrc) return PR.thumbSrc(c, '');
    if (c.art) return 'assets/' + c.art;
    if (typeof c.image === 'string' && c.image) return c.image;
    return 'assets/favicon.png';
  }
  /* The full-size icon, for anywhere it is shown large. */
  function artFull(c) {
    var PR = window.PageRender;
    if (PR && PR.artSrc) return PR.artSrc(c, '');
    if (c.art) return 'assets/' + c.art;
    if (typeof c.image === 'string' && c.image) return c.image;
    return 'assets/favicon.png';
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      if (t) clearTimeout(t);
      t = setTimeout(function () { t = null; fn(); }, ms);
    };
  }
  function readJSON(key, fallback) {
    try {
      var v = JSON.parse(localStorage.getItem(key));
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode / full */ }
  }
  function slugify(x) { return String(x || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function uid() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function ago(ts) {
    var s = Math.max(0, Math.round((Date.now() - (ts || 0)) / 1000));
    if (s < 90) return 'just now';
    var m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60);
    if (h < 24) return h + ' hr ago';
    var d = Math.round(h / 24);
    return d + ' day' + (d === 1 ? '' : 's') + ' ago';
  }

  // ── preferences ────────────────────────────────────────────────────────
  var prefs = readJSON(PREF_KEY, {}) || {};
  function savePrefs() { writeJSON(PREF_KEY, prefs); }

  // ── the current script ─────────────────────────────────────────────────
  function loadCurrent() {
    var arr = readJSON(SCRIPT_KEY, []);
    order = Array.isArray(arr) ? arr.filter(function (s) { return typeof s === 'string'; }) : [];
    sel = {};
    order.forEach(function (s) { sel[s] = 1; });
    rosterCache = null;
  }
  function commitOrder() {
    writeJSON(SCRIPT_KEY, order);
    rosterCache = null;
    if (window.updateScriptBadge) window.updateScriptBadge();
  }
  function getMeta() { return readJSON(META_KEY, {}) || {}; }
  function setMeta(m) { writeJSON(META_KEY, m || {}); }
  /* `how` says what kind of change this is for the undo stack: the default
     is one step; 'typed' coalesces a run of keystrokes into one; 'silent'
     records nothing (a restore, or bookkeeping such as libId). */
  function patchMeta(fn, how) {
    if (how === 'typed') markTyped(); else if (how !== 'silent') mark();
    var m = getMeta(); fn(m); setMeta(m); settle();
  }

  /* The roster in the order the script page draws it: team by team, keeping
     the stored order inside each team (Array.sort is stable). Slugs this wiki
     has no character for are dropped from the objects but never from `order`
     itself — an imported script naming a character we do not have must not
     quietly lose it. */
  function rosterChars() {
    if (rosterCache) return rosterCache;
    rosterCache = order.map(function (s) { return bySlug[s]; }).filter(Boolean)
      .sort(function (a, b) {
        var ta = TEAM_INDEX[a.team] != null ? TEAM_INDEX[a.team] : 99;
        var tb = TEAM_INDEX[b.team] != null ? TEAM_INDEX[b.team] : 99;
        return ta - tb;
      });
    return rosterCache;
  }
  function missingSlugs() {
    return order.filter(function (s) { return !bySlug[s]; });
  }

  // ── night order + jinx edits live on the script's meta ──────────────────
  function getNightOrder() {
    var m = getMeta();
    return (m.nightOrder && typeof m.nightOrder === 'object') ? m.nightOrder : {};
  }
  function setNightOrder(o) {
    patchMeta(function (m) {
      if (o && ((o.first && o.first.length) || (o.other && o.other.length))) m.nightOrder = o;
      else delete m.nightOrder;
    });
  }
  function getJinxEdits() {
    var m = getMeta();
    return (m.jinxEdits && typeof m.jinxEdits === 'object') ? m.jinxEdits : {};
  }
  function setJinxEdits(e) {
    patchMeta(function (m) {
      if (e && ((e.off && e.off.length) || (e.add && e.add.length))) m.jinxEdits = e;
      else delete m.jinxEdits;
    });
    analyseDirty = true;
    paintRoster();
  }

  // ── the script's shape and its locks (script-builder-tools.js) ──────────
  /* `shape` is how many of each team the script is aiming for; the default
     (13 / 4 / 4 / 4) is stored as nothing. `locks` are the characters
     Random keeps and Clear leaves alone. Both live on the meta, so they
     travel with the script into My Scripts and a share link. */
  function shape() {
    return window.SBTools ? window.SBTools.shapeOf(getMeta()) : null;
  }
  function setShape(sh) {
    if (!window.SBTools) return;
    patchMeta(function (m) {
      var st = window.SBTools.shapeStore(sh);
      if (st) m.shape = st; else delete m.shape;
    });
    analyseDirty = true;
    paintCounts();
    paintShape();
    if (activeTab === 'analyse') ensurePane();
  }
  function locks() {
    var m = getMeta();
    return Array.isArray(m.locks) ? m.locks.filter(function (x) { return sel[x]; }) : [];
  }
  function isLocked(slug) { return locks().indexOf(slug) !== -1; }
  function toggleLock(slug) {
    if (!sel[slug]) return;
    patchMeta(function (m) {
      var L = Array.isArray(m.locks) ? m.locks.slice() : [];
      var i = L.indexOf(slug);
      if (i === -1) L.push(slug); else L.splice(i, 1);
      if (L.length) m.locks = L; else delete m.locks;
    });
    paintRoster();
    toast(isLocked(slug) ? bySlug[slug].name + ' is locked: Random keeps it.' : bySlug[slug].name + ' unlocked.');
  }

  // ══════════════════════════════════════════════════════════════════════
  //  Selection
  // ══════════════════════════════════════════════════════════════════════
  function paintRow(slug) {
    var btn = rowBySlug[slug];
    if (!btn) return;
    var on = !!sel[slug];
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    // The row carries it as well, for the "hide what is already on the
    // script" view setting, which is one CSS rule off this class.
    var row = btn.parentNode && btn.parentNode.parentNode;
    if (row && row.classList.contains('sbx-add-row')) row.classList.toggle('on', on);
  }
  function toggle(slug) {
    mark();
    if (sel[slug]) {
      delete sel[slug];
      var i = order.indexOf(slug);
      if (i !== -1) order.splice(i, 1);
    } else {
      sel[slug] = 1;
      order.push(slug);
    }
    commitOrder();
    paintRow(slug);
    afterChange();
  }
  function removeSlug(slug) {
    if (!sel[slug]) return;
    mark();
    delete sel[slug];
    var i = order.indexOf(slug);
    if (i !== -1) order.splice(i, 1);
    commitOrder();
    paintRow(slug);
    afterChange();
  }
  function replaceOrder(list, quiet) {
    if (!quiet) mark();
    var before = order.slice();
    order = list.slice();
    sel = {};
    order.forEach(function (s) { sel[s] = 1; });
    commitOrder();
    // Only the rows whose state actually flipped are repainted; with ~1,900
    // rows in the list, walking all of them is the thing to avoid.
    var seen = {};
    before.concat(order).forEach(function (s) {
      if (seen[s]) return;
      seen[s] = 1;
      paintRow(s);
    });
    afterChange();
  }

  /* Everything a change has to do, in the order of how much it matters.
     The two immediate ones are cheap; the rest waits for the clicking to
     stop. */
  function afterChange() {
    paintCounts();
    paintRoster();
    nightDirty = jinxDirty = analyseDirty = true;
    if (activeTab === 'night' || activeTab === 'jinx' || activeTab === 'analyse') ensurePane();
    if (!$('sbx-shape').hidden) paintShape();
    settle();
  }

  var settle = debounce(function () {
    paintJinxCount();
    paintCredits();
    syncLibrary();
  }, 200);

  // ══════════════════════════════════════════════════════════════════════
  //  The roster (the "Script" tab)
  // ══════════════════════════════════════════════════════════════════════
  function paintCounts() {
    var counts = {}, total = 0;
    rosterChars().forEach(function (c) {
      counts[c.team] = (counts[c.team] || 0) + 1;
      total++;
    });
    var miss = missingSlugs().length;
    var all = total + miss;
    var sh = shape();
    var want = sh && window.SBTools ? window.SBTools.shapeTotal(sh) : 0;
    function state(h, w) { return w ? (h === w ? ' ok' : (h > w ? ' over' : ' under')) : ''; }
    var html = '<span class="sbx-cnt sbx-cnt-total' + state(all, want) + '">' + all + (want ? '/' + want : '') +
      ' character' + (all === 1 && !want ? '' : 's') + '</span>';
    TEAMS.forEach(function (t) {
      var h = counts[t[0]] || 0, w = sh ? sh[t[0]] : 0;
      if (!h && !w) return;
      html += '<span class="sbx-cnt' + state(h, w) + '">' + h + (w ? '/' + w : '') + ' ' + esc(t[1]) + '</span>';
    });
    $('sbx-counts').innerHTML = html;
  }

  /* The Shape popover: presets, a number per team, and Fill. */
  function paintShape() {
    var host = $('sbx-shape-body');
    var T = window.SBTools;
    if (!host || !T) return;
    var sh = shape(), key = T.shapeKey(sh), have = T.countTeams(rosterChars());
    var html = '<div class="sbx-view-presets" role="group" aria-label="Shapes">' + T.SHAPES.map(function (p) {
      return '<button type="button" class="sbx-view-preset' + (p.key === key ? ' on' : '') + '" data-shape="' +
        esc(p.key) + '" title="' + esc(p.hint) + '">' + esc(p.label) + '</button>';
    }).join('') + '</div>';
    html += '<div class="sbx-shape-grid">' + TEAMS.map(function (t) {
      var w = sh[t[0]], h = have[t[0]] || 0;
      var pct = w ? Math.min(100, Math.round(100 * h / w)) : 0;
      return '<label class="sbx-shape-row">' +
        '<span class="sbx-shape-label">' + esc(t[1]) + '</span>' +
        '<input type="number" min="0" max="99" inputmode="numeric" value="' + w + '" data-team="' + esc(t[0]) + '" aria-label="' + esc(t[1]) + ' target">' +
        '<span class="sbx-shape-bar"><span class="' + (w && h > w ? 'over' : (w && h === w ? 'ok' : '')) + '" style="width:' + pct + '%"></span></span>' +
        '<span class="sbx-shape-have">' + h + ' on it</span>' +
      '</label>';
    }).join('') + '</div>';
    html += '<div class="sbx-view-foot">' +
      '<span class="sbx-view-hint" style="flex:1 1 200px">Random draws a whole script to this shape and keeps the locked characters. Fill only adds what is missing, from whatever the panel is showing.</span>' +
      '<button type="button" class="sbx-b-sm" id="sbx-fill">&#9860; Fill the gaps</button>' +
      '</div>';
    host.innerHTML = html;
  }
  function readShapeInputs() {
    var out = {};
    [].slice.call($('sbx-shape-body').querySelectorAll('input[data-team]')).forEach(function (i) {
      out[i.getAttribute('data-team')] = Number(i.value);
    });
    return out;
  }
  function fillGaps() {
    var T = window.SBTools;
    if (!T) return;
    var plan = T.fillPlan(visibleSidebarChars(), rosterChars(), shape());
    var shortBits = Object.keys(plan.short).map(function (t) { return plan.short[t] + ' ' + T.TEAM_LABEL[t]; });
    if (!plan.add.length) {
      toast(shortBits.length ? 'Nothing in the panel fits the gaps (' + shortBits.join(', ') + ').' : 'Every team is already at its target.');
      return;
    }
    replaceOrder(order.concat(plan.add));
    toast('Added ' + plan.add.length + ' character' + (plan.add.length === 1 ? '' : 's') +
      (shortBits.length ? '. Short of ' + shortBits.join(', ') + ' in the panel.' : '.'));
  }

  /* The roster as the VIEW shows it. `order` (and so rosterChars(), the
     export and the published page) keeps the arranged sequence; a view sort
     is only how this page lays it out. Team grouping always wins. */
  function displayChars() {
    var chars = rosterChars();
    var o = view ? view.order : 'added';
    if (o === 'added') return chars;
    function ti(c) { return TEAM_INDEX[c.team] != null ? TEAM_INDEX[c.team] : 99; }
    function nightKey(c) {
      var f = Number(c.firstNight) || 0, n = Number(c.otherNight) || 0;
      return (f > 0 ? f : 1e6) * 1e4 + (n > 0 ? n : 1e3);
    }
    var arr = chars.slice();
    if (o === 'name') arr.sort(function (a, b) { return ti(a) - ti(b) || (a.name || '').localeCompare(b.name || ''); });
    else if (o === 'sao' && window.saoCompare) arr.sort(function (a, b) { return ti(a) - ti(b) || window.saoCompare(a, b); });
    else if (o === 'night') arr.sort(function (a, b) { return ti(a) - ti(b) || nightKey(a) - nightKey(b); });
    return arr;
  }

  var lockSet = {};   // the locks, as a set, for the length of one paintRoster()

  /* slug -> the names it is jinxed with on this script, for the row marks. */
  function jinxMarks() {
    var map = {};
    if (view && !view.showJinx) return map;
    scriptJinxes().forEach(function (j) {
      (map[j.a.slug] = map[j.a.slug] || []).push(j.b.name);
      (map[j.b.slug] = map[j.b.slug] || []).push(j.a.name);
    });
    return map;
  }

  function rowHTML(c, jinxedWith) {
    var v = view || {};
    var meta = '';
    if (v.showCreator && !c.official && c.creator) meta += '<span class="sbx-ch-by">by ' + esc(c.creator) + '</span>';
    if (v.showTags && c.tags) {
      meta += '<span class="sbx-ch-tags">' + String(c.tags).split(',').map(function (t) {
        t = t.trim();
        return t ? '<span class="sbx-tag">' + esc(t) + '</span>' : '';
      }).join('') + '</span>';
    }
    var marks = '';
    if (v.showNight) {
      if (Number(c.firstNight) > 0) marks += '<span class="sbx-ch-n" title="Acts on the first night">F</span>';
      if (Number(c.otherNight) > 0) marks += '<span class="sbx-ch-n" title="Acts on other nights">O</span>';
    }
    if (jinxedWith && jinxedWith.length) {
      marks += '<span class="sbx-ch-jx" title="Jinxed with ' + esc(jinxedWith.join(', ')) + '">&#9903;' + jinxedWith.length + '</span>';
    }
    var locked = lockSet[c.slug] === 1;
    // Name and ability are ONE paragraph, the way the character sheet
    // prints them — not a name stacked over its ability in a box.
    return '<div class="sbx-ch' + (locked ? ' locked' : '') + '" data-slug="' + esc(c.slug) + '">' +
      '<img class="sbx-ch-img" loading="lazy" decoding="async" src="' +
        esc(artOf(c)) + '" alt="" onerror="this.onerror=null;this.src=\'assets/favicon.png\'">' +
      '<p class="sbx-ch-txt">' +
        '<a class="sbx-ch-name" href="' + esc(c.page || '#') + '"' +
          (c.official ? ' target="_blank" rel="noopener" title="Official character — opens the official wiki"' : '') + '>' +
          esc(c.name) + '</a>' +
        (c.official ? '<span class="sbx-off">official &#8599;</span> ' : '') +
        marks +
        '<span class="sbx-ch-ab">' + esc(c.ability || '') + '</span>' +
        (meta ? '<span class="sbx-ch-meta">' + meta + '</span>' : '') +
      '</p>' +
      '<button type="button" class="sbx-ch-lock' + (locked ? ' on' : '') + '" data-slug="' + esc(c.slug) +
        '" aria-pressed="' + (locked ? 'true' : 'false') + '" title="' +
        (locked ? 'Locked: Random and Clear keep this character' : 'Lock: keep this character when the script is randomised') +
        '" aria-label="' + (locked ? 'Unlock ' : 'Lock ') + esc(c.name) + '">' + (locked ? '&#128274;' : '&#128275;') + '</button>' +
      '<button type="button" class="sbx-ch-x" data-slug="' + esc(c.slug) +
        '" aria-label="Remove ' + esc(c.name) + '">&#10005;</button>' +
    '</div>';
  }

  function paintRoster() {
    var chars = displayChars();
    var box = $('sb-script');
    var miss = missingSlugs();
    if (!chars.length && !miss.length) {
      box.innerHTML = '<p class="sbx-empty">Nothing on this script yet. Pick characters from the panel' +
        (view && view.side === 'right' ? ' on the right' : ' on the left') + '.</p>';
      return;
    }
    var jx = jinxMarks();
    lockSet = {};
    locks().forEach(function (x) { lockSet[x] = 1; });
    var html = '';
    TEAMS.forEach(function (t) {
      var group = chars.filter(function (c) { return c.team === t[0]; });
      if (!group.length) return;
      var head = window.SBView ? window.SBView.teamHeading(t[0], t[1], view) : t[1];
      html += '<div class="sbx-team" data-team="' + esc(t[0]) + '">' +
        (head ? '<h3 class="sbx-team-head">' + esc(head) + ' <span>(' + group.length + ')</span></h3>' : '') +
        '<div class="sbx-sheet">';
      group.forEach(function (c) { html += rowHTML(c, jx[c.slug]); });
      html += '</div></div>';
    });
    if (miss.length) {
      html += '<p class="sbx-missing">' + miss.length + ' character' + (miss.length === 1 ? '' : 's') +
        ' on this script have no page on this wiki and are carried along untouched: ' +
        esc(miss.slice(0, 12).join(', ')) + (miss.length > 12 ? '…' : '') + '</p>';
    }
    box.innerHTML = html;
  }

  // ══════════════════════════════════════════════════════════════════════
  //  The add panel
  // ══════════════════════════════════════════════════════════════════════
  /* Built once, then filtered in place by the shared filter box
     (assets/card-filters.js), which is why every row carries the same data-*
     attributes the browse cards do. Rebuilding it on every add would throw
     away whatever the reader had filtered to — and cost far more than the
     one class toggle a click actually needs. */
  /* The list is built in slices of a few hundred rows, one slice per
     frame: the first slice is on screen within a frame of the data
     arriving and the rest fill in below the fold while the reader is
     already looking at their script. One innerHTML of 1,900 rows was a
     single 300–500 ms block on a phone, and nothing could paint until it
     ended. `done` runs after the last slice (the filter box mounts then —
     it walks the whole list once). */
  var CHUNK = 220;
  var buildRun = 0;
  function rowMarkup(c, i) {
    var partial = (window.isPartial && window.isPartial(c)) ? '1' : '0';
    var star = (window.isCurata && window.isCurata(c)) ? '1' : '0';
    return '<div class="sbx-add-row' + (sel[c.slug] ? ' on' : '') + '" data-team="' + esc(c.team || '') + '"' +
      ' data-tags="' + esc(c.tags || '') + '"' +
      ' data-creator="' + esc(c.official ? 'The Pandemonium Institute' : (c.creator || '')) + '"' +
      ' data-name="' + esc(c.name || '') + '"' +
      ' data-order="' + i + '"' +
      ' data-source="' + (c.official ? 'official' : 'homebrew') + '"' +
      ' data-partial="' + partial + '" data-curata="' + star + '">' +
      '<div class="sbx-add-head-row">' +
        '<button type="button" class="sbx-add-item' + (sel[c.slug] ? ' on' : '') +
          '" data-slug="' + esc(c.slug) + '" aria-pressed="' + (sel[c.slug] ? 'true' : 'false') + '">' +
          '<img class="sbx-add-thumb" loading="lazy" decoding="async" src="' +
            esc(artOf(c)) + '" alt="" onerror="this.onerror=null;this.src=\'assets/favicon.png\'">' +
          // The badge sits OUTSIDE the name, which is ellipsised: inside
          // it, a long name would cut the one word saying whose character
          // this is.
          '<span class="sbx-add-name">' + esc(c.name) + '</span>' +
          (c.official ? '<span class="sbx-off">official</span>' : '') +
          '<span class="sbx-add-tick" aria-hidden="true">&#10003;</span>' +
        '</button>' +
        (c.ability
          ? '<button type="button" class="sbx-add-chev" aria-label="Show the ability of ' +
              esc(c.name) + '">&#9662;</button>'
          : '') +
      '</div>' +
      // The filter box reads SAO's sort key off this element, so a
      // character with no ability must have no element rather than one
      // holding a stand-in sentence.
      (c.ability ? '<div class="sbx-add-ab">' + esc(c.ability) + '</div>' : '') +
    '</div>';
  }
  function buildAddList(done) {
    var run = ++buildRun;
    var browsable = allChars.concat(officialChars);
    var groups = [];
    TEAMS.forEach(function (t) {
      var group = browsable.filter(function (c) { return c.team === t[0]; })
        .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
      if (group.length) groups.push({ team: t, chars: group, rowsEl: null, at: 0 });
    });
    var list = $('sb-add-list');
    rowBySlug = {};
    if (!groups.length) {
      list.innerHTML = '<p class="sbx-note">No characters found.</p>';
      if (done) done();
      return;
    }
    list.innerHTML = '';
    var gi = 0;
    function slice() {
      if (run !== buildRun) return;   // a newer build replaced this one
      var budget = CHUNK;
      while (budget > 0 && gi < groups.length) {
        var g = groups[gi];
        if (!g.rowsEl) {
          var wrap = document.createElement('div');
          wrap.className = 'sbx-add-group';
          wrap.setAttribute('data-team', g.team[0]);
          wrap.innerHTML = '<h3 class="sbx-add-grouphead">' + esc(g.team[1]) +
            ' <span class="sbx-add-groupcount">(' + g.chars.length + ')</span></h3>' +
            '<div class="sbx-add-rows"></div>';
          list.appendChild(wrap);
          g.rowsEl = wrap.lastChild;
        }
        var to = Math.min(g.chars.length, g.at + budget);
        var html = '';
        for (var i = g.at; i < to; i++) html += rowMarkup(g.chars[i], i);
        var before = g.rowsEl.childElementCount;
        g.rowsEl.insertAdjacentHTML('beforeend', html);
        var kids = g.rowsEl.children;
        for (var k = before; k < kids.length; k++) {
          var btn = kids[k].querySelector('.sbx-add-item');
          if (btn) rowBySlug[btn.getAttribute('data-slug')] = btn;
        }
        budget -= (to - g.at);
        g.at = to;
        if (g.at >= g.chars.length) gi++;
      }
      if (gi < groups.length) requestAnimationFrame(slice);
      else if (done) done();
    }
    slice();
  }

  function mountAddFilters() {
    if (!window.mountCardFilters) return;
    window.mountCardFilters({
      grid: 'sb-add-list', bar: 'sb-filter-bar', toggle: 'sb-filter-toggle',
      count: 'sb-add-count', search: 'sb-filter',
      sectionSel: '.sbx-add-group', innerSel: '.sbx-add-rows', cardSel: '.sbx-add-row',
      sectionCountSel: '.sbx-add-groupcount', abilitySel: '.sbx-add-ab',
      label: 'Filters', partialChip: true, partialOn: true, curataChip: true,
      sourceChips: [['homebrew', 'Homebrew'], ['official', 'Official']]
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  //  Tabs, and the two panes that are built lazily
  // ══════════════════════════════════════════════════════════════════════
  function showTab(name) {
    activeTab = name;
    [].slice.call(document.querySelectorAll('.sbx-tab')).forEach(function (b) {
      var on = b.getAttribute('data-tab') === name;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    [].slice.call(document.querySelectorAll('.sbx-pane')).forEach(function (p) {
      p.classList.toggle('on', p.getAttribute('data-tab') === name);
    });
    scrollPaneTop();
    prefs.tab = name;
    savePrefs();
    ensurePane();
  }

  /* Open a tab at its beginning. On a wide screen that is the pane's own
     scrollbar; on a phone the DOCUMENT scrolls (see the .sbx-* media query),
     so leaving it alone would open a short pane already scrolled past its
     end — tap Night Order from half way down a long roster and you land at
     the bottom of a list of four. Only ever scrolls UP: it is putting the
     tab strip back where it sticks, never dragging the reader down the
     page. */
  function scrollPaneTop() {
    var sc = $('sbx-scroll');
    sc.scrollTop = 0;
    if (getComputedStyle(sc).overflowY !== 'visible') return;
    // .sbx-scroll is statically positioned, so its offsetTop is a stable
    // document coordinate — the tab strip's is not, because it is sticky.
    var target = sc.offsetTop - topbarHeight() - $('sbx-tabs').offsetHeight;
    var y = window.pageYOffset || document.documentElement.scrollTop || 0;
    if (y > target) window.scrollTo(0, Math.max(0, target));
  }

  /* The tab strip sticks under the top bar, whose height depends on the
     brand images and the reader's own text size — so it is measured rather
     than written down, and re-measured whenever the bar could have changed
     shape. */
  function topbarHeight() {
    var tb = document.querySelector('.topbar');
    return tb ? tb.offsetHeight : 56;
  }
  function syncTopbarHeight() {
    document.documentElement.style.setProperty('--sbx-top', topbarHeight() + 'px');
  }

  /* The night arranger and the jinx editor are only ever built for a tab the
     reader is actually looking at. Both of them rebuild their whole list, and
     doing that behind a hidden tab on every single click is most of what made
     adding a character feel broken. */
  function ensurePane() {
    if (activeTab === 'night') {
      if (!nightUI && window.NightOrderEditor) {
        nightUI = window.NightOrderEditor.mount($('sbx-night-body'), {
          getEntries: rosterChars,
          getOrder: getNightOrder,
          setOrder: setNightOrder,
          onEmpty: function (empty) { $('sb-night-reset').style.display = empty ? 'none' : ''; }
        });
        nightDirty = false;
      } else if (nightUI && nightDirty) {
        nightUI.render();
        nightDirty = false;
      }
    } else if (activeTab === 'jinx') {
      if (!jinxUI && window.JinxEditor) {
        jinxUI = window.JinxEditor.mount($('sbx-jinx-body'), {
          getEntries: rosterChars,
          getEdits: getJinxEdits,
          setEdits: setJinxEdits
        });
        jinxDirty = false;
      } else if (jinxUI && jinxDirty) {
        jinxUI.render();
        jinxDirty = false;
      }
    } else if (activeTab === 'analyse') {
      if (analyseDirty) { paintAnalysis(); analyseDirty = false; }
    } else if (activeTab === 'meta') {
      paintCredits();
      paintEditNote();
      paintTextPreview();
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  The Analyse tab (the reading is SBTools.analyse; this only draws it)
  // ══════════════════════════════════════════════════════════════════════
  function paintAnalysis() {
    var host = $('sbx-analyse-body');
    var T = window.SBTools;
    if (!host || !T) return;
    var chars = rosterChars();
    if (!chars.length) {
      host.innerHTML = '<p class="sbx-empty-in">Add characters and this tab will tell you about the script.</p>';
      $('sbx-tab-an-n').textContent = '';
      return;
    }
    var a = T.analyse(chars, { shape: shape(), jinxes: scriptJinxes(), allBySlug: bySlug });
    var bad = a.warnings.filter(function (w) { return w.level !== 'note'; }).length;
    $('sbx-tab-an-n').textContent = bad ? '(' + bad + ')' : '';

    function chip(n, label) { return '<span class="sbx-an-chip"><b>' + n + '</b>' + esc(label) + '</span>'; }
    var html = '<div class="sbx-an">';

    // shape
    html += '<div class="sbx-an-sec"><h3 class="sbx-an-head">Shape</h3>';
    a.teams.forEach(function (t) {
      if (!t.have && !t.want) return;
      var pct = t.want ? Math.min(100, Math.round(100 * t.have / t.want)) : (t.have ? 100 : 0);
      html += '<div class="sbx-an-row"><span class="sbx-shape-label">' + esc(t.label) + '</span>' +
        '<span class="sbx-shape-bar"><span class="' + (t.want && t.have > t.want ? 'over' : (t.want && t.have === t.want ? 'ok' : '')) +
        '" style="width:' + pct + '%"></span></span>' +
        '<span class="sbx-shape-have">' + t.have + (t.want ? ' / ' + t.want : '') + '</span></div>';
    });
    html += '<p class="sbx-an-fact" style="margin-top:6px"><b>' + a.total + '</b> character' + (a.total === 1 ? '' : 's') +
      (a.shapeTotal ? ' of ' + a.shapeTotal : '') + ' &middot; ' + a.homebrew + ' homebrew, ' + a.official + ' official</p>';
    html += '</div>';

    // warnings
    html += '<div class="sbx-an-sec"><h3 class="sbx-an-head">Worth a look</h3>';
    if (!a.warnings.length) html += '<p class="sbx-an-empty">Nothing to flag.</p>';
    else {
      html += '<ul class="sbx-an-list">' + a.warnings.map(function (w) {
        return '<li class="' + esc(w.level) + '">' + esc(w.text) + (w.list ? '<small>' + esc(w.list.join(', ')) + '</small>' : '') + '</li>';
      }).join('') + '</ul>';
    }
    html += '</div>';

    // at a glance
    html += '<div class="sbx-an-sec"><h3 class="sbx-an-head">At a glance</h3><div class="sbx-an-chips">' +
      chip(a.night.first, 'act on the first night') + chip(a.night.other, 'act on other nights') + chip(a.night.never, 'never wake') +
      chip(a.info, 'learn things') + chip(a.misinfo, 'cause false info') + chip(a.killers, 'kill') + chip(a.protect, 'protect') +
      chip(a.jinxes, 'jinx' + (a.jinxes === 1 ? '' : 'es')) +
      '</div>';
    if (a.setup.length) html += '<p class="sbx-an-fact" style="margin-top:8px"><b>Change the setup:</b> ' + esc(a.setup.join(', ')) + '</p>';
    if (a.outsiderMods.length) html += '<p class="sbx-an-fact"><b>Change the Outsider count:</b> ' + esc(a.outsiderMods.join(', ')) + '</p>';
    html += '</div>';

    // tags
    html += '<div class="sbx-an-sec"><h3 class="sbx-an-head">Tags</h3>';
    if (!a.tags.length) html += '<p class="sbx-an-empty">No tags on these characters yet.</p>';
    else html += '<div class="sbx-an-chips">' + a.tags.slice(0, 18).map(function (t) { return chip(t.n, t.tag); }).join('') +
      (a.tags.length > 18 ? '<span class="sbx-an-chip">&hellip; ' + (a.tags.length - 18) + ' more</span>' : '') + '</div>';
    html += '</div>';

    // creators
    html += '<div class="sbx-an-sec"><h3 class="sbx-an-head">Creators</h3>';
    if (!a.creators.length) html += '<p class="sbx-an-empty">No credits yet.</p>';
    else html += '<div class="sbx-an-chips">' + a.creators.slice(0, 24).map(function (c) { return chip(c.n, c.name); }).join('') + '</div>';
    html += '</div>';

    // jinx suggestions
    if (a.suggest.length) {
      html += '<div class="sbx-an-sec wide"><h3 class="sbx-an-head">Jinxed with someone not on this script</h3>';
      a.suggest.slice(0, 12).forEach(function (sg) {
        html += '<div class="sbx-an-sug">' +
          '<img loading="lazy" decoding="async" src="' + esc(artOf(sg.to)) + '" alt="" onerror="this.onerror=null;this.src=\'assets/favicon.png\'">' +
          '<span class="t"><strong>' + esc(sg.to.name) + '</strong> with ' + esc(sg.from.name) +
          (sg.text ? '<small>' + esc(sg.text) + '</small>' : '') + '</span>' +
          '<button type="button" class="sbx-b-sm" data-add="' + esc(sg.to.slug) + '">&#43; Add</button></div>';
      });
      html += '</div>';
    }
    html += '</div>';
    host.innerHTML = html;
  }

  function scriptJinxes() {
    var PR = window.PageRender;
    if (PR && PR.scriptJinxes) return PR.scriptJinxes(rosterChars(), getJinxEdits());
    return window.findScriptJinxes ? window.findScriptJinxes(rosterChars()) : [];
  }
  function paintJinxCount() {
    var n = scriptJinxes().length;
    $('sbx-tab-jinx-n').textContent = n ? '(' + n + ')' : '';
  }

  // ══════════════════════════════════════════════════════════════════════
  //  The view: how the roster is drawn (script-builder-view.js)
  // ══════════════════════════════════════════════════════════════════════
  function applyView() {
    if (!window.SBView) return;
    view = window.SBView.normalize(prefs.view);
    window.SBView.apply($('sbx'), view);
  }
  function setView(v, key) {
    prefs.view = v;
    savePrefs();
    applyView();
    var rp = key ? window.SBView.repaintFor(key) : 'roster';
    if (rp === 'roster') paintRoster();
    if (key === 'side' || !key) {
      // The panel moved to the other edge, so the grip's arithmetic changes
      // (wireResize reads view.side) and the drawer should shut in case it
      // was open on the old side.
      if (window.innerWidth <= 900) closeSide();
    }
  }
  function mountView() {
    if (!window.SBView) return;
    window.SBView.mount($('sbx-view-body'), {
      get: function () { return view; },
      set: setView
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  //  Undo / redo — the roster and the details, as one stack
  // ══════════════════════════════════════════════════════════════════════
  /* Every change records the state it replaced: a click, a sort, an import,
     a library switch. A run of typing in one field is one step (markTyped),
     so Ctrl+Z takes back the sentence and not the last letter. Snapshots
     are a few hundred bytes of JSON; 80 are kept. */
  var hist = { undo: [], redo: [], last: null };
  var HIST_MAX = 80;
  var typingUntil = 0;

  function snap() { return JSON.stringify({ o: order, m: getMeta() }); }
  function mark() {
    var s = snap();
    if (s === hist.last) return;
    hist.undo.push(s);
    if (hist.undo.length > HIST_MAX) hist.undo.shift();
    hist.redo.length = 0;
    hist.last = s;
    typingUntil = 0;
    paintHistory();
  }
  function markTyped() {
    var now = Date.now();
    if (now > typingUntil) mark();
    typingUntil = now + 900;
  }
  function restore(s) {
    var st;
    try { st = JSON.parse(s); } catch (e) { return; }
    setMeta(st && st.m ? st.m : {});
    primeForm();
    replaceOrder(Array.isArray(st && st.o) ? st.o : [], true);
    paintLibrary();
    hist.last = s;
    typingUntil = 0;
    paintHistory();
  }
  function undo() {
    if (!hist.undo.length) return;
    var cur = snap();
    var s = hist.undo.pop();
    if (s === cur && hist.undo.length) s = hist.undo.pop();
    hist.redo.push(cur);
    restore(s);
    toast('Undone');
  }
  function redo() {
    if (!hist.redo.length) return;
    var cur = snap();
    var s = hist.redo.pop();
    hist.undo.push(cur);
    restore(s);
    toast('Redone');
  }
  function paintHistory() {
    var u = $('sbx-undo'), r = $('sbx-redo');
    if (u) u.disabled = !hist.undo.length;
    if (r) r.disabled = !hist.redo.length;
  }

  // ══════════════════════════════════════════════════════════════════════
  //  Toasts, popovers, keyboard
  // ══════════════════════════════════════════════════════════════════════
  var toastTimer = null;
  function toast(msg, ms) {
    var el = $('sbx-toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('on');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('on'); }, ms || 2200);
  }

  /* One popover open at a time. On a wide screen it hangs off its button;
     below 900px it is a bottom sheet over a scrim (the CSS ignores the
     inline position there). */
  var openPopId = '', openAnchor = null;
  function openPop(id, anchor) {
    if (openPopId && openPopId !== id) closePops();
    var pop = $(id);
    if (!pop) return;
    pop.hidden = false;
    openPopId = id;
    openAnchor = anchor || null;
    placePop();
    var mobile = window.innerWidth <= 900;
    $('sbx-popscrim').classList.toggle('on', mobile);
    if (mobile) document.documentElement.classList.add('sbx-locked');
    if (anchor) anchor.setAttribute('aria-expanded', 'true');
  }
  function placePop() {
    var pop = openPopId && $(openPopId);
    if (!pop) return;
    if (window.innerWidth <= 900 || !openAnchor) {
      pop.style.top = pop.style.left = pop.style.maxHeight = '';
      return;
    }
    var r = openAnchor.getBoundingClientRect();
    var top = Math.round(r.bottom + 6);
    pop.style.top = top + 'px';
    pop.style.maxHeight = Math.max(180, window.innerHeight - top - 12) + 'px';
    var w = pop.offsetWidth;
    pop.style.left = Math.round(Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8)) + 'px';
  }
  function closePops() {
    if (!openPopId) return;
    var pop = $(openPopId);
    if (pop) pop.hidden = true;
    var btn = document.querySelector('[data-pop="' + openPopId + '"]');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    openPopId = '';
    openAnchor = null;
    $('sbx-popscrim').classList.remove('on');
    if (!$('sbx-side').classList.contains('on')) document.documentElement.classList.remove('sbx-locked');
  }
  function togglePop(id, anchor) {
    hidePeek();
    if (openPopId === id) { closePops(); return; }
    if (id === 'sbx-shape') paintShape();
    openPop(id, anchor);
  }

  function focusSearch() {
    if (window.innerWidth <= 900) showSide('chars');
    else if (prefs.side !== 'chars') showSide('chars');
    var f = $('sb-filter');
    f.focus();
    f.select();
  }

  /* The panel rows the filter box is currently showing, in list order.
     Read straight off the DOM the filter box maintains (card-filters.js
     toggles each row's inline display), so this can never disagree with
     what the panel shows. */
  function visibleRows(homebrewOnly) {
    var q = '#sb-add-list .sbx-add-row' + (homebrewOnly ? '[data-source="homebrew"]' : '');
    var out = [];
    [].slice.call(document.querySelectorAll(q)).forEach(function (row) {
      if (row.style.display === 'none') return;
      var group = row.closest('.sbx-add-group');
      if (group && group.style.display === 'none') return;
      out.push(row);
    });
    return out;
  }

  // ══════════════════════════════════════════════════════════════════════
  //  Copy as text
  // ══════════════════════════════════════════════════════════════════════
  var TEXT_OPTS = ['abilities', 'jinxes', 'night', 'rules', 'notes'];
  function textOpts() {
    var o = prefs.text || {};
    return {
      format: o.format || 'plain',
      abilities: o.abilities !== false, jinxes: !!o.jinxes, night: !!o.night, rules: !!o.rules, notes: !!o.notes
    };
  }
  function buildText() {
    var T = window.SBTools, PR = window.PageRender;
    if (!T) return '';
    var o = textOpts();
    var chars = rosterChars();
    return T.textExport(chars, getMeta(), {
      format: o.format, abilities: o.abilities, jinxes: o.jinxes, night: o.night, rules: o.rules, notes: o.notes,
      jinxList: o.jinxes ? scriptJinxes() : [],
      nightItems: (o.night && PR && PR.nightItems) ? PR.nightItems(chars, getNightOrder()) : null
    });
  }
  function paintTextPreview() {
    var box = $('sb-text-preview');
    if (!box) return;
    var o = textOpts();
    $('sb-text-fmt').value = o.format;
    TEXT_OPTS.forEach(function (k) { $('sb-text-' + k).checked = !!o[k]; });
    box.value = order.length ? buildText() : '';
    box.placeholder = order.length ? '' : 'Add characters and the script appears here as text.';
  }
  function copyText(btn) {
    if (!notEmpty()) return;
    if (!cardReady) { withCards(function () { copyText(btn); }); return; }
    var text = buildText();
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(function () { flash(btn, '✓ Copied'); },
        function () { window.prompt('Copy the script:', text); });
    } else { window.prompt('Copy the script:', text); }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  Loading a page published on this wiki
  // ══════════════════════════════════════════════════════════════════════
  /* The picker fills itself the first time it is opened — two small feeds
     nobody should pay for on a page they came to for the panel. A pick
     fetches /api/page-json, the same export the page's own Download JSON
     button saves, and hands it to the ordinary importer. */
  var wikiPickLoaded = false;
  function loadWikiPick() {
    if (wikiPickLoaded) return Promise.resolve();
    wikiPickLoaded = true;
    var sel2 = $('sb-wiki-pick');
    return Promise.all([
      fetch('scripts.json').then(function (r) { return r.json(); }).catch(function () { return []; }),
      fetch('collections.json').then(function (r) { return r.json(); }).catch(function () { return []; })
    ]).then(function (both) {
      function group(label, rows, type, keyOf, nameOf) {
        rows = (rows || []).filter(function (r) { return r && keyOf(r); })
          .sort(function (a, b) { return String(nameOf(a)).localeCompare(String(nameOf(b))); });
        if (!rows.length) return '';
        return '<optgroup label="' + esc(label) + '">' + rows.map(function (r) {
          return '<option value="' + esc(type + ':' + keyOf(r)) + '">' + esc(nameOf(r)) + '</option>';
        }).join('') + '</optgroup>';
      }
      sel2.innerHTML = '<option value="">Pick a published script or collection…</option>' +
        group('Scripts', both[0], 'script', function (r) { return r.slug; }, function (r) { return r.name || r.slug; }) +
        group('Collections', both[1], 'collection', function (r) { return r.id || r.slug; }, function (r) { return r.displayName || r.name || r.id || r.slug; });
    });
  }
  function loadFromWiki(type, key, btn) {
    if (!type || !key) return;
    if (btn) flash(btn, 'Loading…');
    fetch('api/page-json?type=' + encodeURIComponent(type) + '&slug=' + encodeURIComponent(key))
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function (text) { importScript(text); })
      .catch(function () { alert('That page could not be loaded. It may be a draft, or the wiki may be unreachable.'); });
  }
  /* A pasted link to a script or collection page on this wiki. */
  function wikiLinkIn(text) {
    var m = /\/s\/([a-z0-9-]+)/i.exec(text);
    if (m) return { type: 'script', key: m[1] };
    m = /\/collection\/([a-z0-9-]+)/i.exec(text);
    if (m) return { type: 'collection', key: m[1] };
    m = /[?&]s=([a-z0-9-]+)/i.exec(text);
    if (m) return { type: 'script', key: m[1] };
    return null;
  }

  // ══════════════════════════════════════════════════════════════════════
  //  The peek card: a character at a glance
  // ══════════════════════════════════════════════════════════════════════
  /* Hover a row for half a second (a mouse), or hold a finger on it (a
     phone), and the character is shown whole: the icon at a readable size,
     the ability, tags, when it acts, who it is jinxed with. A click still
     adds or removes — the card never gets in the way of that. */
  var peekTimer = null, peekSlug = '', peekPress = null;
  var FINE = window.matchMedia ? window.matchMedia('(hover: hover) and (pointer: fine)') : { matches: true };

  function peekHTML(c) {
    var PR = window.PageRender;
    var schema = null;
    try { if (window.buildSchema) schema = window.buildSchema(c); } catch (e) { schema = null; }
    var tags = window.SBTools ? window.SBTools.tagsOf(c) : [];
    var facts = [];
    var fn = schema ? schema.firstNight : Number(c.firstNight) || 0;
    var on = schema ? schema.otherNight : Number(c.otherNight) || 0;
    if (fn > 0 || on > 0) {
      facts.push('<b>Acts</b> ' + (fn > 0 ? 'first night' : '') + (fn > 0 && on > 0 ? ' and ' : '') + (on > 0 ? 'other nights' : ''));
    } else facts.push('<b>Never wakes</b>');
    if (schema && schema.firstNightReminder) facts.push('<b>First night:</b> ' + esc(schema.firstNightReminder));
    if (schema && schema.otherNightReminder) facts.push('<b>Other nights:</b> ' + esc(schema.otherNightReminder));
    var rem = [].concat(c.reminders || [], c.remindersGlobal || []).filter(Boolean);
    if (rem.length) facts.push('<b>Reminders:</b> ' + esc(rem.join(', ')));
    var jx = [];
    (sel[c.slug] ? scriptJinxes() : []).forEach(function (j) {
      if (j.a.slug === c.slug) jx.push(j.b.name); else if (j.b.slug === c.slug) jx.push(j.a.name);
    });
    if (!jx.length && Array.isArray(c.jinxes) && c.jinxes.length && window.resolveJinxTarget) {
      c.jinxes.forEach(function (j) {
        try { var t = window.resolveJinxTarget(j, '', c); if (t && t.name) jx.push(t.name); } catch (e) { /* skip */ }
      });
    }
    if (jx.length) facts.push('<b>Jinxed with:</b> ' + esc(jx.join(', ')));
    var cls = (!c.official && window.isPartial && window.isPartial(c)) ? 'Partial page' : ((window.isCurata && window.isCurata(c)) ? 'Curata' : '');
    var isOn = !!sel[c.slug];
    return '<button type="button" class="sbx-pop-x sbx-peek-close" data-peek-close aria-label="Close">&#10005;</button>' +
      '<div class="sbx-peek-top">' +
        '<img class="sbx-peek-img" src="' + esc(artFull(c)) + '" alt="" onerror="this.onerror=null;this.src=\'assets/favicon.png\'">' +
        '<div style="min-width:0;flex:1">' +
          '<p class="sbx-peek-name">' + esc(c.name) + '</p>' +
          '<span class="sbx-peek-team ' + esc(c.team || '') + '">' + esc(c.team || '') + '</span>' +
          (c.official ? '<span class="sbx-peek-team">official</span>' : '') +
          (cls ? '<span class="sbx-peek-team">' + esc(cls) + '</span>' : '') +
          (!c.official && c.creator ? '<p class="sbx-peek-by">by ' + esc(c.creator) + '</p>' : '') +
        '</div>' +
      '</div>' +
      '<p class="sbx-peek-ab">' + esc(c.ability || '(no ability text)') + '</p>' +
      (tags.length ? '<p class="sbx-peek-facts" style="margin-top:6px">' + tags.map(function (t) { return '<span class="sbx-tag">' + esc(t) + '</span>'; }).join('') + '</p>' : '') +
      '<p class="sbx-peek-facts">' + facts.join('<br>') + '</p>' +
      '<div class="sbx-peek-acts">' +
        '<button type="button" class="sbx-b-sm" data-peek-toggle="' + esc(c.slug) + '">' + (isOn ? '&#10005; Remove from script' : '&#43; Add to script') + '</button>' +
        (c.page ? '<a href="' + esc(c.page) + '" target="_blank" rel="noopener">Open page &#8599;</a>' : '') +
      '</div>';
  }
  function showPeek(slug, x, y) {
    var c = bySlug[slug];
    var pop = $('sbx-peek');
    if (!c || !pop || openPopId) return;
    peekSlug = slug;
    pop.innerHTML = peekHTML(c);
    pop.hidden = false;
    var mobile = window.innerWidth <= 900;
    if (mobile) {
      pop.style.top = pop.style.left = '';
      $('sbx-popscrim').classList.add('on');
      document.documentElement.classList.add('sbx-locked');
      return;
    }
    var w = pop.offsetWidth, h = pop.offsetHeight;
    var left = x + 18, top = y + 14;
    if (left + w > window.innerWidth - 8) left = Math.max(8, x - w - 18);
    if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);
    pop.style.left = Math.round(left) + 'px';
    pop.style.top = Math.round(top) + 'px';
  }
  function hidePeek() {
    if (peekTimer) { clearTimeout(peekTimer); peekTimer = null; }
    var pop = $('sbx-peek');
    if (!pop || pop.hidden) { peekSlug = ''; return; }
    pop.hidden = true;
    peekSlug = '';
    if (!openPopId) {
      $('sbx-popscrim').classList.remove('on');
      if (!$('sbx-side').classList.contains('on')) document.documentElement.classList.remove('sbx-locked');
    }
  }
  function slugUnder(target) {
    var el = target && target.closest ? (target.closest('.sbx-add-item') || target.closest('.sbx-ch')) : null;
    return el ? el.getAttribute('data-slug') : '';
  }
  function wirePeek(list) {
    // hover, with a mouse
    list.addEventListener('mouseover', function (e) {
      if (!FINE.matches) return;
      var slug = slugUnder(e.target);
      if (!slug || slug === peekSlug) return;
      if (peekTimer) clearTimeout(peekTimer);
      var x = e.clientX, y = e.clientY;
      peekTimer = setTimeout(function () { peekTimer = null; showPeek(slug, x, y); }, 520);
    });
    list.addEventListener('mouseout', function (e) {
      if (!FINE.matches) return;
      var to = e.relatedTarget;
      if (to && to.closest && (to.closest('#sbx-peek') || slugUnder(to) === peekSlug)) return;
      hidePeek();
    });
    // a long press, with a finger
    list.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'touch') return;
      var slug = slugUnder(e.target);
      if (!slug) return;
      peekPress = { slug: slug, x: e.clientX, y: e.clientY, t: setTimeout(function () {
        peekPress = null;
        showPeek(slug, e.clientX, e.clientY);
      }, 550) };
    });
    function cancelPress(e) {
      if (!peekPress) return;
      if (e.type === 'pointermove' && Math.hypot(e.clientX - peekPress.x, e.clientY - peekPress.y) < 10) return;
      clearTimeout(peekPress.t);
      peekPress = null;
    }
    list.addEventListener('pointermove', cancelPress);
    list.addEventListener('pointerup', cancelPress);
    list.addEventListener('pointercancel', cancelPress);
    list.addEventListener('scroll', hidePeek, { passive: true });
  }

  // ══════════════════════════════════════════════════════════════════════
  //  The credits Fabled
  // ══════════════════════════════════════════════════════════════════════
  function creditsDetailed() {
    try { return localStorage.getItem(CREDITS_KEY) === '1'; } catch (e) { return false; }
  }
  function creditsFabled() {
    if (!window.buildCreditsFabled) return null;
    return window.buildCreditsFabled(rosterChars(), { detailed: creditsDetailed() });
  }
  function paintCredits() {
    var box = $('sb-credits-text');
    if (!box) return;
    var f = creditsFabled();
    box.textContent = f ? f.ability : '';
  }

  // ══════════════════════════════════════════════════════════════════════
  //  Export / import / share / print
  // ══════════════════════════════════════════════════════════════════════
  /* Built by PageRender.buildPageExport, the same call the published script
     page's JSON box makes, so what you download here and what a reader
     downloads there cannot drift apart. The one thing only the builder adds
     is the credits Fabled — a published page's JSON is its author's own
     script and never carries the wiki's signature. */
  function buildExport() {
    var m = getMeta();
    return window.PageRender.buildPageExport(
      (m.name || '').trim() || 'My Homebrew Script',
      (m.author || '').trim(), m.header || '', rosterChars(), m,
      { credits: creditsFabled() });
  }
  function fileName() {
    var n = (getMeta().name || 'homebrew-script').trim()
      .replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
    return (n || 'homebrew-script') + '.json';
  }
  function download(name, text, mime) {
    var url = URL.createObjectURL(new Blob([text], { type: mime || 'application/json' }));
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function flash(btn, text) {
    if (!btn) return;
    var was = btn.textContent;
    btn.textContent = text;
    setTimeout(function () { btn.textContent = was; }, 1500);
  }
  function notEmpty() {
    if (order.length) return true;
    alert('This script is empty — add a character or two first.');
    return false;
  }

  function doExport() { if (notEmpty()) withCards(function () { download(fileName(), buildExport()); }); }
  function doCopy(btn) {
    if (!notEmpty()) return;
    if (!cardReady) { withCards(function () { doCopy(btn); }); return; }
    var text = buildExport();
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(function () { flash(btn, '✓ Copied'); },
        function () { window.prompt('Copy the script JSON:', text); });
    } else { window.prompt('Copy the script JSON:', text); }
  }

  /* Share links stay compatible with the ones a published /s/ page makes
     ({n, a, c}); `m` is this page's own addition and every reader of a link
     without it still works. */
  function encodeShare() {
    var m = getMeta();
    var extra = {};
    ['hideTitle', 'almanac', 'bootlegger', 'nightOrder', 'jinxEdits', 'shape', 'notes'].forEach(function (k) {
      if (m[k] != null && m[k] !== '' && m[k] !== false) extra[k] = m[k];
    });
    var payload = { n: m.name || '', a: m.author || '', c: order.slice() };
    if (Object.keys(extra).length) payload.m = extra;
    return btoa(unescape(encodeURIComponent(JSON.stringify(payload))))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function decodeShare(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return JSON.parse(decodeURIComponent(escape(atob(s))));
  }
  function doShare(btn) {
    if (!notEmpty()) return;
    var link = SITE_ROOT + 'script?share=' + encodeShare();
    if (navigator.clipboard) {
      navigator.clipboard.writeText(link).then(function () { flash(btn, '✓ Link copied'); },
        function () { window.prompt('Copy this link:', link); });
    } else { window.prompt('Copy this link:', link); }
  }

  /* A printable sheet, in its own window rather than a @media print rule on
     this one: the builder is a fixed-height app with two scrolling panes, and
     unpicking that for the printer would take more CSS than simply writing
     the pages out. Gives the same two sheets the official tool's PDF does —
     the character sheet, then the night order. */
  function doPrint() {
    if (!notEmpty()) return;
    if (!cardReady) { withCards(doPrint); return; }
    var m = getMeta();
    var chars = rosterChars();
    var PR = window.PageRender;
    var night = (PR && PR.nightItems) ? PR.nightItems(chars, getNightOrder()) : { first: [], other: [] };
    var jinxes = scriptJinxes();

    var out = '';
    TEAMS.forEach(function (t) {
      var group = chars.filter(function (c) { return c.team === t[0]; });
      if (!group.length) return;
      out += '<h2>' + esc(t[1]) + '</h2><table>';
      group.forEach(function (c) {
        out += '<tr><th>' + esc(c.name) + '</th><td>' + esc(c.ability || '') + '</td></tr>';
      });
      out += '</table>';
    });
    if (jinxes.length) {
      out += '<h2>Jinxes</h2><table>';
      jinxes.forEach(function (j) {
        out += '<tr><th>' + esc(j.a.name) + ' &amp; ' + esc(j.b.name) + '</th><td>' +
          esc(j.text) + '</td></tr>';
      });
      out += '</table>';
    }
    function col(label, items) {
      var rows = items.map(function (it, i) {
        return '<tr><th>' + (i + 1) + '</th><td>' + esc(it.c.name) +
          (it.r ? '<br><span class="rem">' + esc(it.r) + '</span>' : '') + '</td></tr>';
      }).join('') || '<tr><td colspan="2">Nobody acts.</td></tr>';
      return '<div class="nc"><h2>' + esc(label) + '</h2><table>' + rows + '</table></div>';
    }
    var sheet =
      '<!doctype html><html><head><meta charset="utf-8"><title>' +
      esc((m.name || 'Script').trim()) + '</title><style>' +
      'body{font:12px/1.45 Georgia,serif;color:#111;margin:22px;}' +
      'h1{font-size:22px;margin:0 0 2px;}' +
      '.by{font-style:italic;color:#555;margin:0 0 14px;}' +
      'h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;' +
      'margin:14px 0 4px;border-bottom:1px solid #999;padding-bottom:2px;}' +
      'table{width:100%;border-collapse:collapse;}' +
      'th{text-align:left;vertical-align:top;width:26%;padding:2px 8px 2px 0;font-weight:bold;}' +
      'td{vertical-align:top;padding:2px 0;}' +
      'tr{page-break-inside:avoid;}' +
      '.rem{color:#666;font-size:11px;}' +
      '.nights{display:flex;gap:26px;}.nc{flex:1;}' +
      '.pb{page-break-before:always;}' +
      '.foot{margin-top:18px;font-size:10px;color:#777;}' +
      '</style></head><body>' +
      '<h1>' + esc((m.name || 'Untitled Script').trim()) + '</h1>' +
      (m.author ? '<p class="by">by ' + esc(m.author) + '</p>' : '') +
      out +
      '<div class="pb"><h1>Night Order</h1><div class="nights">' +
      col('First Night', night.first || []) + col('Other Nights', night.other || []) +
      '</div></div>' +
      '<p class="foot">Built on botchomebrew.wiki &middot; fan-made content for Blood on the Clocktower.</p>' +
      '</body></html>';

    var w = window.open('', '_blank');
    if (!w) { alert('Your browser blocked the print window. Allow pop-ups for this site and try again.'); return; }
    w.document.open();
    w.document.write(sheet);
    w.document.close();
    w.focus();
    setTimeout(function () { try { w.print(); } catch (e) { /* the reader can print it themselves */ } }, 350);
  }

  /* Fancy Scripts (/fancyscripts) presses an official-style print sheet.
     The roster goes across in localStorage — the same JSON the Export
     button saves — and the tool reads the key once and clears it. */
  function doFancy() {
    if (!notEmpty()) return;
    if (!cardReady) { withCards(doFancy); return; }
    try { localStorage.setItem('botc_fancy_incoming', buildExport()); }
    catch (e) { alert('Could not hand the script over — your browser blocked storage.'); return; }
    window.open('fancyscripts?from=builder', '_blank');
  }

  // ── import ─────────────────────────────────────────────────────────────
  function idToSlug() {
    var map = {};
    allChars.forEach(function (c) {
      var id = window.slugId ? window.slugId(c.name) : slugify(c.name);
      map[id] = c.slug;
      if (c.jsonId) map[slugify(c.jsonId)] = c.slug;
      map[(c.slug || '').replace(/-/g, '')] = c.slug;
    });
    // Official roles by bare id and by name. Homebrew was added first and is
    // never overwritten, so a homebrew page sharing an official name wins.
    officialChars.forEach(function (c) {
      var id = c.slug.replace(/^off-/, '');
      if (!(id in map)) map[id] = c.slug;
      var byName = slugify(c.name);
      if (!(byName in map)) map[byName] = c.slug;
    });
    return map;
  }
  function importScript(text) {
    var data;
    try { data = JSON.parse(text); } catch (e) { alert('That is not valid JSON.'); return; }
    if (!Array.isArray(data)) { alert('Expected a script array — the official script JSON format.'); return; }
    var map = idToSlug();
    var slugs = [], missing = [], meta = null;
    data.forEach(function (entry) {
      var id = (typeof entry === 'string') ? entry : (entry && entry.id);
      if (!id) return;
      if (id === '_meta') { meta = entry; return; }
      var key = slugify(id);
      // Our own credits Fabled is rebuilt on every export, so a script this
      // builder wrote must not come back reported as unrecognised.
      if (key === (window.CREDITS_FABLED_ID || 'botchomebrewwiki')) return;
      var slug = map[key];
      if (slug) { if (slugs.indexOf(slug) === -1) slugs.push(slug); }
      else { missing.push((entry && entry.name) || id); }
    });
    if (!slugs.length) { alert('None of the characters in that script are on this wiki.'); return; }

    var replace = true;
    if (order.length) {
      replace = confirm('Replace the script you have open?\n\nOK = replace it, Cancel = add these characters to it.');
    }
    var next = replace ? [] : order.slice();
    slugs.forEach(function (s) { if (next.indexOf(s) === -1) next.push(s); });

    mark();
    if (replace) {
      // Whatever is being replaced goes to its saved copy first: the import
      // clears libId below, so nothing after this point can write over it.
      syncLibrary();
      // A different script is a different script: its name, its author and
      // its official-app options come with it, and it is NOT an edit of
      // whatever published page happened to be open before.
      var m = {};
      if (meta) {
        if (meta.name) m.name = String(meta.name).slice(0, 90);
        if (meta.author) m.author = String(meta.author).slice(0, 70);
        if (meta.hideTitle) m.hideTitle = true;
        if (meta.almanac) m.almanac = String(meta.almanac).slice(0, 300);
        if (Array.isArray(meta.bootlegger)) m.bootlegger = meta.bootlegger.slice(0, 20).map(String);
      }
      setMeta(m);
      primeForm();
    }
    replaceOrder(next, true);

    var offCount = slugs.filter(function (s) { return s.indexOf('off-') === 0; }).length;
    var msg = 'Imported ' + slugs.length + ' character' + (slugs.length === 1 ? '' : 's') +
      (offCount ? ' (' + offCount + ' official)' : '') + '.';
    if (missing.length) {
      msg += '\n\nNot on this wiki (' + missing.length + '): ' +
        missing.slice(0, 10).join(', ') + (missing.length > 10 ? '…' : '');
      alert(msg);
    } else {
      toast(msg);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  My Scripts — up to 15, kept in this browser
  // ══════════════════════════════════════════════════════════════════════
  function getLib() {
    var a = readJSON(LIB_KEY, []);
    return Array.isArray(a) ? a : [];
  }
  function setLib(a) { writeJSON(LIB_KEY, a.slice(0, LIB_MAX)); }
  function libEntry(id) {
    var lib = getLib();
    for (var i = 0; i < lib.length; i++) if (lib[i].id === id) return lib[i];
    return null;
  }
  function snapshot(id) {
    return { id: id, chars: order.slice(), meta: getMeta(), updated: Date.now() };
  }

  /* Whatever is open is written back to its saved copy as it changes, so
     switching scripts never loses anything. A script with no characters and
     no name has nothing worth a slot, so it does not take one until it does. */
  function syncLibrary() {
    var m = getMeta();
    var lib = getLib();
    if (m.libId) {
      for (var i = 0; i < lib.length; i++) {
        if (lib[i].id === m.libId) {
          lib[i] = snapshot(m.libId);
          setLib(lib);
          paintLibrary();
          return;
        }
      }
      // its entry was deleted underneath us — fall through and make a new one
    }
    if (!order.length && !(m.name || '').trim()) return;
    if (lib.length >= LIB_MAX) { paintLibrary(); return; }
    var id = uid();
    m.libId = id;
    setMeta(m);
    // Bookkeeping, not a step: the snapshot on the stack has no libId and
    // would otherwise look like a change to undo.
    if (hist.last) { try { var st = JSON.parse(hist.last); st.m.libId = id; hist.last = JSON.stringify(st); } catch (e) { /* fine */ } }
    lib.unshift(snapshot(id));
    setLib(lib);
    paintLibrary();
  }

  function saveCurrentToLibrary() {
    var m = getMeta();
    if (!order.length && !(m.name || '').trim()) {
      alert('There is nothing to save yet — add a character or give the script a name.');
      return;
    }
    if (!m.libId && getLib().length >= LIB_MAX) {
      alert('This browser keeps ' + LIB_MAX + ' scripts. Delete one from My Scripts to save another.');
      return;
    }
    syncLibrary();
    showSide('lib');
  }

  function loadEntry(id) {
    var e = libEntry(id);
    if (!e) return;
    if (e.id === getMeta().libId) {
      if (window.innerWidth <= 900) closeSide();
      return;
    }
    syncLibrary();                       // keep whatever is open
    mark();
    var m = e.meta && typeof e.meta === 'object' ? e.meta : {};
    m.libId = e.id;
    setMeta(m);
    primeForm();
    replaceOrder(Array.isArray(e.chars) ? e.chars : [], true);
    paintLibrary();
    if (window.innerWidth <= 900) closeSide();
  }

  function newScript() {
    if (order.length || (getMeta().name || '').trim()) {
      if (!confirm('Start a new, empty script?\n\nWhat you have open is kept in My Scripts.')) return;
      syncLibrary();
    }
    mark();
    setMeta({});
    primeForm();
    replaceOrder([], true);
    paintLibrary();
    if (window.innerWidth > 900) $('sb-name').focus();
  }

  function deleteEntry(id) {
    var e = libEntry(id);
    if (!e) return;
    var name = (e.meta && e.meta.name) || 'this script';
    if (!confirm('Delete "' + name + '" from My Scripts?\n\nThis cannot be undone.')) return;
    setLib(getLib().filter(function (x) { return x.id !== id; }));
    if (getMeta().libId === id) patchMeta(function (m) { delete m.libId; }, 'silent');
    paintLibrary();
  }
  function renameEntry(id) {
    var e = libEntry(id);
    if (!e) return;
    var name = window.prompt('Name for this script:', (e.meta && e.meta.name) || '');
    if (name == null) return;
    var lib = getLib();
    lib.forEach(function (x) {
      if (x.id !== id) return;
      x.meta = x.meta || {};
      x.meta.name = name.slice(0, 90);
      x.updated = Date.now();
    });
    setLib(lib);
    if (getMeta().libId === id) {
      patchMeta(function (m) { m.name = name.slice(0, 90); });
      primeForm();
    }
    paintLibrary();
  }
  function duplicateEntry(id) {
    var e = libEntry(id);
    if (!e) return;
    var lib = getLib();
    if (lib.length >= LIB_MAX) {
      alert('This browser keeps ' + LIB_MAX + ' scripts. Delete one to make room for a copy.');
      return;
    }
    var copy = {
      id: uid(),
      chars: (e.chars || []).slice(),
      meta: JSON.parse(JSON.stringify(e.meta || {})),
      updated: Date.now()
    };
    copy.meta.name = ((copy.meta.name || 'Untitled Script') + ' (copy)').slice(0, 90);
    // A copy is a new script, never a second editor for the same published
    // page: keep editSlug and the library id off it.
    delete copy.meta.editSlug;
    delete copy.meta.libId;
    lib.unshift(copy);
    setLib(lib);
    paintLibrary();
  }

  function paintLibrary() {
    var lib = getLib();
    var q = ($('sbx-lib-q').value || '').trim().toLowerCase();
    var cur = getMeta().libId;
    $('sbx-lib-n').textContent = lib.length ? '(' + lib.length + ')' : '';
    $('sbx-lib-count').textContent = lib.length + ' of ' + LIB_MAX + ' saved in this browser';
    $('sbx-lib-full').hidden = lib.length < LIB_MAX;

    var shown = lib.filter(function (e) {
      if (!q) return true;
      var m = e.meta || {};
      return ((m.name || '') + ' ' + (m.author || '')).toLowerCase().indexOf(q) !== -1;
    });
    if (!shown.length) {
      $('sbx-lib-list').innerHTML = '<p class="sbx-note">' +
        (lib.length ? 'No saved script matches that.'
                    : 'Nothing saved yet. Build a script and it is kept here automatically.') +
        '</p>';
      return;
    }
    $('sbx-lib-list').innerHTML = shown.map(function (e) {
      var m = e.meta || {};
      var n = (e.chars || []).length;
      var bits = [n + ' character' + (n === 1 ? '' : 's')];
      if (m.author) bits.push('by ' + m.author);
      bits.push(ago(e.updated));
      if (m.editSlug) bits.push('published');
      return '<div class="sbx-lib-item' + (e.id === cur ? ' on' : '') + '" data-id="' + esc(e.id) + '">' +
        '<button type="button" class="sbx-lib-open" data-act="open">' +
          '<span class="sbx-lib-name">' + esc((m.name || '').trim() || 'Untitled Script') + '</span>' +
          '<span class="sbx-lib-meta">' + esc(bits.join(' · ')) + '</span>' +
        '</button>' +
        '<span class="sbx-lib-acts">' +
          '<button type="button" data-act="rename" title="Rename" aria-label="Rename">&#9998;</button>' +
          '<button type="button" data-act="dup" title="Duplicate" aria-label="Duplicate">&#10697;</button>' +
          '<button type="button" data-act="del" title="Delete" aria-label="Delete">&#128465;</button>' +
        '</span></div>';
    }).join('');
  }

  // ══════════════════════════════════════════════════════════════════════
  //  The details form
  // ══════════════════════════════════════════════════════════════════════
  function primeForm() {
    var m = getMeta();
    $('sb-name').value = m.name || '';
    $('sb-name2').value = m.name || '';
    $('sb-author').value = m.author || '';
    $('sb-author2').value = m.author || '';
    $('sb-hidetitle').checked = !!m.hideTitle;
    $('sb-almanac').value = m.almanac || '';
    $('sb-notes').value = m.notes || '';
    $('sb-boot-list').innerHTML = '';
    (m.bootlegger || []).forEach(addBootRow);
    document.title = ((m.name || '').trim() || 'Script Builder') + ' — BOTC HomeBrew Wiki';
    paintEditNote();
  }

  /* The one that was actually biting: a script edited from its published page
     leaves editSlug, name and author behind in the shared meta, so the next
     script built here exported under the previous one's name. The name is on
     screen now, and when the meta is still tied to a published page it says
     so and offers a way out. */
  function paintEditNote() {
    var m = getMeta();
    var note = $('sbx-edit-note');
    if (!m.editSlug) { note.hidden = true; return; }
    note.hidden = false;
    note.innerHTML = 'This script is linked to the published page <a href="s/' +
      esc(m.editSlug) + '" target="_blank" rel="noopener">/s/' + esc(m.editSlug) +
      '</a>, so publishing updates that page. ' +
      '<button type="button" class="sbx-b-sm" id="sbx-detach">Detach — publish as a new script</button>';
    $('sbx-detach').addEventListener('click', function () {
      patchMeta(function (mm) { delete mm.editSlug; });
      paintEditNote();
      paintLibrary();
    });
  }

  function addBootRow(text) {
    var row = document.createElement('div');
    row.className = 'sbx-boot-row';
    var input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 300;
    input.value = text || '';
    input.placeholder = 'e.g. The Storyteller may not use the Fortune Teller red herring.';
    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'sbx-b-sm';
    del.textContent = '✕';
    del.setAttribute('aria-label', 'Remove this rule');
    del.addEventListener('click', function () { row.parentNode.removeChild(row); saveBoot(); });
    input.addEventListener('input', saveBootSoon);
    row.appendChild(input);
    row.appendChild(del);
    $('sb-boot-list').appendChild(row);
  }
  function saveBoot() {
    var vals = [].slice.call($('sb-boot-list').querySelectorAll('input'))
      .map(function (i) { return i.value.trim(); }).filter(Boolean);
    patchMeta(function (m) {
      if (vals.length) m.bootlegger = vals; else delete m.bootlegger;
    }, 'typed');
  }
  var saveBootSoon = debounce(saveBoot, 350);

  // ══════════════════════════════════════════════════════════════════════
  //  The panel: which side, how wide, drawer on a phone
  // ══════════════════════════════════════════════════════════════════════
  function showSide(which) {
    ['chars', 'lib'].forEach(function (k) {
      $('sbx-pane-' + k).classList.toggle('on', k === which);
      var seg = $('sbx-seg-' + k);
      seg.classList.toggle('on', k === which);
      seg.setAttribute('aria-selected', k === which ? 'true' : 'false');
    });
    prefs.side = which;
    savePrefs();
    if (which === 'lib') paintLibrary();
    if (window.innerWidth <= 900) openSide();
  }
  function openSide() {
    $('sbx-side').classList.add('on');
    $('sbx-scrim').classList.add('on');
    document.documentElement.classList.add('sbx-locked');
  }
  function closeSide() {
    $('sbx-side').classList.remove('on');
    $('sbx-scrim').classList.remove('on');
    document.documentElement.classList.remove('sbx-locked');
  }

  var SIDE_MIN = 240;
  function sideMax() { return Math.max(SIDE_MIN + 60, Math.min(window.innerWidth - 300, 1100)); }
  function setSideWidth(px, save) {
    px = Math.round(Math.max(SIDE_MIN, Math.min(sideMax(), px)));
    $('sbx').style.setProperty('--sbx-side', px + 'px');
    if (save) { prefs.side_w = px; savePrefs(); }
    return px;
  }
  function wideWidth() { return Math.min(sideMax(), Math.round(window.innerWidth * 0.62)); }
  function applyWide(on) {
    prefs.wide = !!on;
    savePrefs();
    $('sbx-wide').classList.toggle('on', !!on);
    $('sbx-wide').setAttribute('aria-pressed', on ? 'true' : 'false');
    setSideWidth(on ? wideWidth() : (prefs.side_w || 330), false);
  }

  function wireResize() {
    var grip = $('sbx-grip'), dragging = false;
    grip.addEventListener('pointerdown', function (e) {
      dragging = true;
      document.documentElement.classList.add('sbx-resizing');
      try { grip.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }
      e.preventDefault();
    });
    grip.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var box = $('sbx').getBoundingClientRect();
      setSideWidth(view && view.side === 'right' ? box.right - e.clientX : e.clientX - box.left, false);
      e.preventDefault();
    });
    function stop() {
      if (!dragging) return;
      dragging = false;
      document.documentElement.classList.remove('sbx-resizing');
      var w = parseInt(getComputedStyle($('sbx')).getPropertyValue('--sbx-side'), 10);
      if (w) { prefs.side_w = w; prefs.wide = w > wideWidth() - 60; savePrefs(); }
      $('sbx-wide').classList.toggle('on', !!prefs.wide);
    }
    grip.addEventListener('pointerup', stop);
    grip.addEventListener('pointercancel', stop);
  }

  // ══════════════════════════════════════════════════════════════════════
  //  Wiring
  // ══════════════════════════════════════════════════════════════════════
  function wire() {
    // ── the add list: one delegated listener for ~1,900 rows ──
    $('sb-add-list').addEventListener('click', function (e) {
      var chev = e.target.closest('.sbx-add-chev');
      if (chev) {
        var row = chev.closest('.sbx-add-row');
        if (row) row.classList.toggle('open');
        return;
      }
      var item = e.target.closest('.sbx-add-item');
      if (!item) return;
      toggle(item.getAttribute('data-slug'));
    });
    // Enter in the search box adds the first character it is showing, so a
    // script can be typed in: name, Enter, name, Enter.
    $('sb-filter').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      var rows = visibleRows(false);
      if (!rows.length) { toast('Nothing matches that.'); return; }
      var btn = rows[0].querySelector('.sbx-add-item');
      var slug = btn && btn.getAttribute('data-slug');
      if (!slug || !bySlug[slug]) return;
      toggle(slug);
      toast((sel[slug] ? 'Added ' : 'Removed ') + bySlug[slug].name);
    });

    $('sb-script').addEventListener('click', function (e) {
      var x = e.target.closest('.sbx-ch-x');
      if (x) { removeSlug(x.getAttribute('data-slug')); return; }
      var lk = e.target.closest('.sbx-ch-lock');
      if (lk) toggleLock(lk.getAttribute('data-slug'));
    });
    $('sbx-analyse-body').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-add]');
      if (!b) return;
      var slug = b.getAttribute('data-add');
      if (bySlug[slug] && !sel[slug]) { toggle(slug); toast('Added ' + bySlug[slug].name); }
    });
    // the shape popover
    $('sbx-shape-body').addEventListener('click', function (e) {
      var p = e.target.closest('button[data-shape]');
      if (p && window.SBTools) {
        var key = p.getAttribute('data-shape');
        window.SBTools.SHAPES.forEach(function (x) { if (x.key === key) setShape(x.shape); });
        return;
      }
      if (e.target.closest('#sbx-fill')) fillGaps();
    });
    $('sbx-shape-body').addEventListener('change', function (e) {
      if (e.target.matches && e.target.matches('input[data-team]')) setShape(readShapeInputs());
    });
    // notes
    $('sb-notes').addEventListener('input', debounce(function () {
      var v = $('sb-notes').value.slice(0, 4000);
      patchMeta(function (m) { if (v.trim()) m.notes = v; else delete m.notes; }, 'typed');
    }, 350));
    // copy as text
    $('sb-text-fmt').addEventListener('change', function () {
      prefs.text = prefs.text || {};
      prefs.text.format = this.value;
      savePrefs();
      paintTextPreview();
    });
    TEXT_OPTS.forEach(function (k) {
      $('sb-text-' + k).addEventListener('change', function () {
        prefs.text = prefs.text || {};
        prefs.text[k] = this.checked;
        savePrefs();
        paintTextPreview();
      });
    });
    $('sb-text-copy').addEventListener('click', function () { copyText(this); });
    $('sb-text-dl').addEventListener('click', function () {
      if (!notEmpty()) return;
      download(fileName().replace(/\.json$/, '.txt'), buildText(), 'text/plain');
    });
    // from this wiki
    var pick = $('sb-wiki-pick');
    ['focus', 'pointerdown', 'touchstart'].forEach(function (ev) {
      pick.addEventListener(ev, function () { loadWikiPick(); }, { passive: true, once: true });
    });
    $('sb-wiki-load').addEventListener('click', function () {
      var v = pick.value;
      if (!v) { loadWikiPick(); toast('Pick a script or collection first.'); return; }
      var i = v.indexOf(':');
      loadFromWiki(v.slice(0, i), v.slice(i + 1), this);
    });
    // the peek card
    wirePeek($('sb-add-list'));
    wirePeek($('sb-script'));
    $('sbx-peek').addEventListener('click', function (e) {
      if (e.target.closest('[data-peek-close]')) { hidePeek(); return; }
      var tg = e.target.closest('button[data-peek-toggle]');
      if (tg) {
        var slug = tg.getAttribute('data-peek-toggle');
        toggle(slug);
        toast((sel[slug] ? 'Added ' : 'Removed ') + bySlug[slug].name);
        hidePeek();
      }
    });
    $('sbx-peek').addEventListener('mouseleave', function () { if (FINE.matches) hidePeek(); });

    // ── abilities inline instead of behind a chevron ──
    var abil = $('sbx-abilities');
    abil.checked = !!prefs.abilities;
    $('sb-add-list').classList.toggle('abil', !!prefs.abilities);
    abil.addEventListener('change', function () {
      prefs.abilities = this.checked;
      savePrefs();
      $('sb-add-list').classList.toggle('abil', this.checked);
    });

    // ── tabs ──
    $('sbx-tabs').addEventListener('click', function (e) {
      var b = e.target.closest('.sbx-tab');
      if (b) showTab(b.getAttribute('data-tab'));
    });

    // ── panel: characters vs saved scripts, width, drawer ──
    [].slice.call(document.querySelectorAll('.sbx-seg')).forEach(function (b) {
      b.addEventListener('click', function () { showSide(b.getAttribute('data-side')); });
    });
    $('sbx-wide').addEventListener('click', function () { applyWide(!prefs.wide); });
    $('sbx-open').addEventListener('click', openSide);
    $('sbx-close').addEventListener('click', closeSide);
    $('sbx-scrim').addEventListener('click', closeSide);
    wireResize();

    // ── name + author, in the bar and in the details tab, one value ──
    function bindName(barId, tabId, key, max) {
      function push(v) {
        patchMeta(function (m) {
          var t = v.slice(0, max);
          if (t) m[key] = t; else delete m[key];
        }, 'typed');
        if (key === 'name') {
          document.title = (v.trim() || 'Script Builder') + ' — BOTC HomeBrew Wiki';
          paintLibrary();
        }
      }
      $(barId).addEventListener('input', function () { $(tabId).value = this.value; push(this.value); });
      $(tabId).addEventListener('input', function () { $(barId).value = this.value; push(this.value); });
    }
    bindName('sb-name', 'sb-name2', 'name', 90);
    bindName('sb-author', 'sb-author2', 'author', 70);

    // ── official-app options ──
    $('sb-hidetitle').addEventListener('change', function () {
      var on = this.checked;
      patchMeta(function (m) { if (on) m.hideTitle = true; else delete m.hideTitle; });
    });
    $('sb-almanac').addEventListener('input', debounce(function () {
      var v = $('sb-almanac').value.trim().slice(0, 300);
      patchMeta(function (m) { if (v) m.almanac = v; else delete m.almanac; }, 'typed');
    }, 350));
    $('sb-boot-add').addEventListener('click', function () { addBootRow(''); });

    // ── the toolbar and its overflow menu ──
    var menu = $('sbx-menu'), more = $('sbx-more');
    function closeMenu() { menu.classList.remove('on'); more.setAttribute('aria-expanded', 'false'); }
    more.addEventListener('click', function (e) {
      e.stopPropagation();
      var on = menu.classList.toggle('on');
      more.setAttribute('aria-expanded', on ? 'true' : 'false');
    });
    document.addEventListener('click', function (e) {
      closeMenu();
      if (!openPopId) return;
      // A target no longer in the document was re-rendered by its own
      // handler (a preset button inside the popover); that is never a click
      // outside, whatever closest() says about a detached node.
      if (e.target && e.target.isConnected === false) return;
      if (!(e.target.closest && (e.target.closest('.sbx-pop') || e.target.closest('[data-pop]')))) closePops();
    });
    // Popover buttons: each names the popover it opens.
    [].slice.call(document.querySelectorAll('[data-pop]')).forEach(function (b) {
      b.addEventListener('click', function () { togglePop(b.getAttribute('data-pop'), b); });
    });
    [].slice.call(document.querySelectorAll('[data-pop-close]')).forEach(function (b) {
      b.addEventListener('click', closePops);
    });
    $('sbx-popscrim').addEventListener('click', function () { closePops(); hidePeek(); });
    window.addEventListener('resize', placePop);
    $('sbx-undo').addEventListener('click', undo);
    $('sbx-redo').addEventListener('click', redo);

    document.addEventListener('keydown', function (e) {
      var t = e.target;
      var typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      var mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') {
        if (peekSlug) { hidePeek(); return; }
        if (openPopId) { closePops(); return; }
        closeMenu();
        if (typing && t.id === 'sb-filter' && t.value) { t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); return; }
        closeSide();
        return;
      }
      // Inside a text box the browser's own undo is the one expected.
      if (mod && !typing && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (mod && !typing && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
      if (mod && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); focusSearch(); return; }
      if (!typing && !mod && !e.altKey && e.key === '/') { e.preventDefault(); focusSearch(); }
    });
    menu.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-do]');
      if (!b) return;
      closeMenu();
      ACTIONS[b.getAttribute('data-do')](b);
    });

    $('sb-export').addEventListener('click', function () { ACTIONS.export(this); });
    $('sb-copy').addEventListener('click', function () { ACTIONS.copy(this); });
    $('sb-share').addEventListener('click', function () { ACTIONS.share(this); });
    $('sb-print').addEventListener('click', function () { ACTIONS.print(this); });
    $('sb-fancy').addEventListener('click', function () { ACTIONS.fancy(this); });
    $('sb-import').addEventListener('click', function () { ACTIONS.import(this); });
    $('sb-randomize').addEventListener('click', randomize);
    $('sb-sort').addEventListener('click', function () {
      if (order.length) replaceOrder(window.sortRosterSAO(order, bySlug));
    });
    $('sb-paste-go').addEventListener('click', function () {
      var t = $('sb-paste').value.trim();
      if (!t) { alert('Paste a script JSON, or a link to a page on this wiki, into the box first.'); return; }
      var link = t.charAt(0) !== '[' && t.charAt(0) !== '{' ? wikiLinkIn(t) : null;
      if (link) loadFromWiki(link.type, link.key, this); else importScript(t);
      $('sb-paste').value = '';
    });
    $('sb-import-file').addEventListener('change', function (e) {
      var f = e.target.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function (ev) { importScript(ev.target.result); };
      fr.readAsText(f);
      e.target.value = '';
    });
    $('sb-night-reset').addEventListener('click', function () {
      setNightOrder(null);
      nightDirty = true;
      ensurePane();
    });

    // ── credits ──
    var cd = $('sb-credits-detail');
    cd.checked = creditsDetailed();
    cd.addEventListener('change', function () {
      try { localStorage.setItem(CREDITS_KEY, this.checked ? '1' : '0'); } catch (e) { /* fine */ }
      paintCredits();
    });

    // ── the library panel ──
    $('sbx-lib-q').addEventListener('input', paintLibrary);
    $('sbx-lib-save').addEventListener('click', saveCurrentToLibrary);
    $('sbx-lib-new').addEventListener('click', newScript);
    $('sbx-lib-list').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-act]');
      if (!b) return;
      var id = b.closest('.sbx-lib-item').getAttribute('data-id');
      var act = b.getAttribute('data-act');
      if (act === 'open') loadEntry(id);
      else if (act === 'rename') renameEntry(id);
      else if (act === 'dup') duplicateEntry(id);
      else if (act === 'del') deleteEntry(id);
    });

    // Another tab of the wiki adding a character to the script (the button on
    // a /c/ page writes the same key) should show up here rather than be
    // overwritten by whatever this tab last wrote.
    window.addEventListener('storage', function (e) {
      if (e.key !== SCRIPT_KEY) return;
      loadCurrent();
      Object.keys(rowBySlug).forEach(paintRow);
      afterChange();
    });
  }

  var ACTIONS = {
    'export': function () { doExport(); },
    copy: function (btn) { doCopy(btn); },
    share: function (btn) { doShare(btn); },
    print: function () { doPrint(); },
    fancy: function () { doFancy(); },
    'import': function () { $('sb-import-file').click(); },
    save: function () { saveCurrentToLibrary(); },
    'new': function () { newScript(); },
    clear: function () {
      if (!order.length) return;
      var L = locks();
      if (!confirm('Remove every character from this script?' +
        (L.length ? '\n\nThe ' + L.length + ' locked character' + (L.length === 1 ? ' stays' : 's stay') + '.' : '') +
        '\n\nThe name and the details are kept.')) return;
      replaceOrder(L);
    }
  };

  /* Randomize draws from whatever the panel's own filter box currently
     shows — a reader who ticked a tag, a creator or a team chip expects it to
     pick from that narrowed pool, not silently reach past it into the whole
     roster. Read straight off the DOM the filter box maintains
     (card-filters.js toggles each row's inline display), so this can never
     disagree with what the panel is showing. Before the panel is built,
     every homebrew character is the pool. */
  function visibleSidebarChars() {
    if (!document.querySelector('#sb-add-list .sbx-add-row')) return allChars.slice();
    var out = [];
    visibleRows(true).forEach(function (row) {
      var btn = row.querySelector('.sbx-add-item');
      var c = btn && bySlug[btn.getAttribute('data-slug')];
      if (c) out.push(c);
    });
    return out;
  }

  /* Homebrew only, deliberately: 180-odd official characters in the pool
     would swamp a random homebrew script. Add officials by hand. (Official
     rows never carry data-source="homebrew", so visibleSidebarChars()
     leaves them out whatever the Source chip says.) The draw goes to the
     script's SHAPE and keeps its locked characters — see SBTools.randomPlan. */
  function randomize() {
    if (!allChars.length || !window.SBTools) return;
    var pool = visibleSidebarChars();
    if (!pool.length) { alert('No homebrew characters match your current filters.'); return; }
    var L = locks();
    if (order.length > L.length && !confirm('Replace this script with a random one?' +
      (L.length ? '\n\nThe ' + L.length + ' locked character' + (L.length === 1 ? ' stays' : 's stay') + '.' : ''))) return;
    var plan = window.SBTools.randomPlan(pool, rosterChars(), shape(), L);
    replaceOrder(plan.slugs);
    var shortBits = Object.keys(plan.short).map(function (t) { return plan.short[t] + ' ' + window.SBTools.TEAM_LABEL[t]; });
    if (shortBits.length) toast('The panel is short of ' + shortBits.join(', ') + ' for this shape.', 3200);
  }

  // ══════════════════════════════════════════════════════════════════════
  //  Boot
  // ══════════════════════════════════════════════════════════════════════
  function loadOfficial() {
    return Promise.all([
      fetch('assets/roles.json').then(function (r) { return r.json(); }),
      fetch('assets/night-order.json').then(function (r) { return r.json(); }).catch(function () { return null; })
    ]).then(function (both) {
      window.OfficialRoles.buildOfficialRoles(both[0], both[1]).forEach(function (c) {
        officialChars.push(c);
        bySlug[c.slug] = c;
      });
      // The official half of the jinx registries: a jinx naming an official
      // character resolves to it (icon, name, the official wiki) before any
      // homebrew page sharing the name — the same order every page uses.
      if (window.slugId && window.setOfficialIconUrls && window.setOfficialNames) {
        var icons = {}, names = {};
        (both[0] || []).forEach(function (r) {
          if (!r || !r.id) return;
          if (r.image && /^https?:\/\//.test(r.image)) {
            icons[window.slugId(r.id)] = r.image;
            if (r.name) icons[window.slugId(r.name)] = r.image;
          }
          if (r.name) { names[window.slugId(r.id)] = r.name; names[window.slugId(r.name)] = r.name; }
        });
        window.setOfficialIconUrls(icons);
        window.setOfficialNames(names);
      }
      // Dusk, the minion and demon info steps, and dawn — without them the
      // export writes no night sequence at all rather than an incomplete one.
      if (window.PageRender && both[1]) window.PageRender.setNightMeta(both[1].meta);
    }).catch(function () { /* officials just will not resolve */ });
  }

  /* Two feeds, in parallel, and whichever lands first draws the page:
       ?fields=grid  what a row needs to be drawn — a third of the bytes
       ?fields=card  the same characters with the schema fields the export,
                     the night order and the jinxes need
     Both are edge-cached, so on a good connection the card feed is often
     first and the grid is never used; on a phone the grid can be on
     screen a second or two before the card arrives. The card rows are
     merged INTO the objects already on the page (Object.assign), so the
     panel's rows and the roster keep pointing at the same characters. */
  var cardReady = false, cardWaiters = [];
  function withCards(fn) {
    if (cardReady) { fn(); return; }
    toast('Still loading the character details…');
    cardWaiters.push(fn);
  }
  function perfMark(name) { try { performance.mark('sb:' + name); } catch (e) { /* fine */ } }

  function start() {
    var official = loadOfficial();
    var gridP = fetch('characters.json?fields=grid').then(function (r) { return r.json(); }).catch(function () { return null; });
    var cardP = fetch('characters.json?fields=card').then(function (r) { return r.json(); });
    var painted = false;

    function firstPaint(list) {
      painted = true;
      allChars = list || [];
      allChars.forEach(function (c) { bySlug[c.slug] = c; });
      registries();

      var params = new URLSearchParams(location.search);
      // Legacy edit links (script?s={slug}) live on the publish page now.
      var editSlug = params.get('s');
      if (editSlug) {
        location.replace('publish-script?s=' + encodeURIComponent(editSlug));
        return false;
      }
      var shareRaw = params.get('share');
      if (shareRaw) applyShare(shareRaw);

      rosterCache = null;
      paintCounts();
      paintRoster();
      paintLibrary();
      perfMark('roster');
      // Either pane may already have been mounted against an empty
      // roster while the fetch was in flight.
      nightDirty = jinxDirty = analyseDirty = true;
      ensurePane();
      settle();
      /* The panel is ~1,900 rows and takes a beat to build, so it is left
         until after the browser has painted: what the reader came back for
         is their script, and it is on screen before the list starts. rAF
         then setTimeout, because an rAF callback alone still runs before
         that paint. */
      requestAnimationFrame(function () {
        setTimeout(function () {
          perfMark('panel-start');
          buildAddList(function () {
            perfMark('panel-done');
            mountAddFilters();
            perfMark('filters');
          });
        }, 0);
      });
      return true;
    }
    function registries() {
      // The jinx resolver's wiki registry — one keying rule for every jinx
      // lookup, shared with the Worker's own index (window.jinxCharIndex
      // owns the order) — so a jinx typed as a name finds its page, and the
      // peek card and the Analyse tab can say who it is with.
      if (window.setWikiChars && window.jinxCharIndex) {
        try { window.setWikiChars(window.jinxCharIndex(allChars).byKey); } catch (e) { /* fine */ }
      }
    }
    function upgrade(list) {
      // The card rows, merged into the objects the page already holds.
      var known = {};
      allChars.forEach(function (c) { known[c.slug] = c; });
      (list || []).forEach(function (row) {
        if (!row || !row.slug) return;
        var have = known[row.slug];
        if (have) { Object.assign(have, row); return; }
        // Published since the grid was cached: a new character.
        allChars.push(row);
        bySlug[row.slug] = row;
        known[row.slug] = row;
      });
      registries();
      rosterCache = null;
      paintRoster();
      nightDirty = jinxDirty = analyseDirty = true;
      ensurePane();
      settle();
    }

    Promise.all([official, gridP]).then(function (both) {
      perfMark('feed-grid');
      if (!painted && both[1] && both[1].length) firstPaint(both[1]);
    }).catch(function () { /* the card feed is still coming */ });
    Promise.all([official, cardP]).then(function (both) {
      perfMark('feed-card');
      var list = both[1] || [];
      if (!painted) { if (firstPaint(list) === false) return; }
      else upgrade(list);
      cardReady = true;
      var w = cardWaiters; cardWaiters = [];
      w.forEach(function (fn) { try { fn(); } catch (e) { /* one waiter must not stop the rest */ } });
    }).catch(function () {
      if (!painted) $('sb-add-list').innerHTML = '<p class="sbx-note">Could not load the characters. Check your connection and reload.</p>';
    });
  }

  function applyShare(raw) {
    try {
      var sh = decodeShare(raw);
      var incoming = (sh.c || []).filter(function (slug) { return bySlug[slug]; });
      if (incoming.length &&
          (!order.length ||
           confirm('Load the shared script (' + incoming.length + ' characters)?\n\nThis replaces what you have open — it is kept in My Scripts.'))) {
        if (order.length) syncLibrary();
        mark();
        var m = {};
        if (sh.n) m.name = String(sh.n).slice(0, 90);
        if (sh.a) m.author = String(sh.a).slice(0, 70);
        if (sh.m && typeof sh.m === 'object') {
          ['hideTitle', 'almanac', 'bootlegger', 'nightOrder', 'jinxEdits', 'shape', 'notes'].forEach(function (k) {
            if (sh.m[k] != null) m[k] = sh.m[k];
          });
          if (typeof m.notes === 'string') m.notes = m.notes.slice(0, 4000); else delete m.notes;
        }
        setMeta(m);
        primeForm();
        order = incoming;
        sel = {};
        order.forEach(function (s) { sel[s] = 1; });
        commitOrder();
      }
    } catch (e) { /* a malformed share payload just leaves the builder alone */ }
    history.replaceState(null, '', location.pathname);
  }

  // The panel and tab the reader left it on.
  function restoreLayout() {
    if (prefs.side_w) setSideWidth(prefs.side_w, false);
    if (prefs.wide) applyWide(true);
    if (prefs.side === 'lib') showSide('lib');
    if (prefs.tab && prefs.tab !== 'script') showTab(prefs.tab);
    // showSide opens the drawer on a phone; on load it should stay shut.
    if (window.innerWidth <= 900) closeSide();
  }

  loadCurrent();
  applyView();
  primeForm();
  wire();
  mountView();
  paintHistory();
  // A small console / test-harness handle (the same idea as
  // window.FancyScripts): read the state, drive the undo stack, no DOM.
  window.ScriptBuilder = {
    order: function () { return order.slice(); },
    meta: getMeta,
    view: function () { return view; },
    undo: undo, redo: redo,
    history: function () { return { undo: hist.undo.length, redo: hist.redo.length }; },
    ready: function () { return cardReady; }
  };
  syncTopbarHeight();
  window.addEventListener('resize', syncTopbarHeight);
  // The bar's height depends on two images; measure again once they are in.
  window.addEventListener('load', syncTopbarHeight);
  restoreLayout();
  start();
})();
