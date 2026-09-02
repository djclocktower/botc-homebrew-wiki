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
  var nightDirty = true, jinxDirty = true;
  var activeTab = 'script';

  // ── tiny helpers ───────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function artOf(c) {
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
  function patchMeta(fn) { var m = getMeta(); fn(m); setMeta(m); settle(); }

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
    paintRoster();
  }

  // ══════════════════════════════════════════════════════════════════════
  //  Selection
  // ══════════════════════════════════════════════════════════════════════
  function paintRow(slug) {
    var btn = rowBySlug[slug];
    if (btn) btn.classList.toggle('on', !!sel[slug]);
  }
  function toggle(slug) {
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
    delete sel[slug];
    var i = order.indexOf(slug);
    if (i !== -1) order.splice(i, 1);
    commitOrder();
    paintRow(slug);
    afterChange();
  }
  function replaceOrder(list) {
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
    nightDirty = jinxDirty = true;
    if (activeTab === 'night' || activeTab === 'jinx') ensurePane();
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
    var html = '<span class="sbx-cnt sbx-cnt-total">' + (total + miss) + ' character' +
      ((total + miss) === 1 ? '' : 's') + '</span>';
    TEAMS.forEach(function (t) {
      if (counts[t[0]]) html += '<span class="sbx-cnt">' + counts[t[0]] + ' ' + esc(t[1]) + '</span>';
    });
    $('sbx-counts').innerHTML = html;
  }

  function paintRoster() {
    var chars = rosterChars();
    var box = $('sb-script');
    var miss = missingSlugs();
    if (!chars.length && !miss.length) {
      box.innerHTML = '<p class="sbx-empty">Nothing on this script yet. Pick characters from the panel on the left.</p>';
      return;
    }
    var html = '';
    TEAMS.forEach(function (t) {
      var group = chars.filter(function (c) { return c.team === t[0]; });
      if (!group.length) return;
      html += '<div class="sbx-team"><h3 class="sbx-team-head">' + esc(t[1]) +
        ' <span>(' + group.length + ')</span></h3><div class="sbx-sheet">';
      group.forEach(function (c) {
        // Name and ability are ONE paragraph, the way the character sheet
        // prints them — not a name stacked over its ability in a box.
        html += '<div class="sbx-ch">' +
          '<img class="sbx-ch-img" loading="lazy" decoding="async" width="40" height="40" src="' +
            esc(artOf(c)) + '" alt="" onerror="this.src=\'assets/favicon.png\'">' +
          '<p class="sbx-ch-txt">' +
            '<a class="sbx-ch-name" href="' + esc(c.page || '#') + '"' +
              (c.official ? ' target="_blank" rel="noopener" title="Official character — opens the official wiki"' : '') + '>' +
              esc(c.name) + '</a>' +
            (c.official ? '<span class="sbx-off">official &#8599;</span> ' : '') +
            '<span class="sbx-ch-ab">' + esc(c.ability || '') + '</span>' +
          '</p>' +
          '<button type="button" class="sbx-ch-x" data-slug="' + esc(c.slug) +
            '" aria-label="Remove ' + esc(c.name) + '">&#10005;</button>' +
        '</div>';
      });
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
  function buildAddList() {
    var browsable = allChars.concat(officialChars);
    var html = '';
    TEAMS.forEach(function (t) {
      var group = browsable.filter(function (c) { return c.team === t[0]; })
        .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
      if (!group.length) return;
      html += '<div class="sbx-add-group" data-team="' + esc(t[0]) + '">' +
        '<h3 class="sbx-add-grouphead">' + esc(t[1]) +
        ' <span class="sbx-add-groupcount">(' + group.length + ')</span></h3>' +
        '<div class="sbx-add-rows">';
      group.forEach(function (c, i) {
        var partial = (window.isPartial && window.isPartial(c)) ? '1' : '0';
        var star = (window.isCurata && window.isCurata(c)) ? '1' : '0';
        html += '<div class="sbx-add-row" data-team="' + esc(c.team || '') + '"' +
          ' data-tags="' + esc(c.tags || '') + '"' +
          ' data-creator="' + esc(c.official ? 'The Pandemonium Institute' : (c.creator || '')) + '"' +
          ' data-name="' + esc(c.name || '') + '"' +
          ' data-order="' + i + '"' +
          ' data-source="' + (c.official ? 'official' : 'homebrew') + '"' +
          ' data-partial="' + partial + '" data-curata="' + star + '">' +
          '<div class="sbx-add-head-row">' +
            '<button type="button" class="sbx-add-item' + (sel[c.slug] ? ' on' : '') +
              '" data-slug="' + esc(c.slug) + '" aria-pressed="' + (sel[c.slug] ? 'true' : 'false') + '">' +
              '<img class="sbx-add-thumb" loading="lazy" decoding="async" width="26" height="26" src="' +
                esc(artOf(c)) + '" alt="" onerror="this.src=\'assets/favicon.png\'">' +
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
      });
      html += '</div></div>';
    });
    var list = $('sb-add-list');
    list.innerHTML = html || '<p class="sbx-note">No characters found.</p>';
    rowBySlug = {};
    [].slice.call(list.querySelectorAll('.sbx-add-item')).forEach(function (btn) {
      rowBySlug[btn.getAttribute('data-slug')] = btn;
    });
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
    } else if (activeTab === 'meta') {
      paintCredits();
      paintEditNote();
    }
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
  function download(name, text) {
    var url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
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

  function doExport() { if (notEmpty()) download(fileName(), buildExport()); }
  function doCopy(btn) {
    if (!notEmpty()) return;
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
    ['hideTitle', 'almanac', 'bootlegger', 'nightOrder', 'jinxEdits'].forEach(function (k) {
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
    replaceOrder(next);

    var offCount = slugs.filter(function (s) { return s.indexOf('off-') === 0; }).length;
    var msg = 'Imported ' + slugs.length + ' character' + (slugs.length === 1 ? '' : 's') +
      (offCount ? ' (' + offCount + ' official)' : '') + '.';
    if (missing.length) {
      msg += '\n\nNot on this wiki (' + missing.length + '): ' +
        missing.slice(0, 10).join(', ') + (missing.length > 10 ? '…' : '');
    }
    alert(msg);
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
    var m = e.meta && typeof e.meta === 'object' ? e.meta : {};
    m.libId = e.id;
    setMeta(m);
    primeForm();
    replaceOrder(Array.isArray(e.chars) ? e.chars : []);
    paintLibrary();
    if (window.innerWidth <= 900) closeSide();
  }

  function newScript() {
    if (order.length || (getMeta().name || '').trim()) {
      if (!confirm('Start a new, empty script?\n\nWhat you have open is kept in My Scripts.')) return;
      syncLibrary();
    }
    setMeta({});
    primeForm();
    replaceOrder([]);
    paintLibrary();
    if (window.innerWidth > 900) $('sb-name').focus();
  }

  function deleteEntry(id) {
    var e = libEntry(id);
    if (!e) return;
    var name = (e.meta && e.meta.name) || 'this script';
    if (!confirm('Delete "' + name + '" from My Scripts?\n\nThis cannot be undone.')) return;
    setLib(getLib().filter(function (x) { return x.id !== id; }));
    if (getMeta().libId === id) patchMeta(function (m) { delete m.libId; });
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
    });
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
      var left = $('sbx').getBoundingClientRect().left;
      setSideWidth(e.clientX - left, false);
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
      var slug = item.getAttribute('data-slug');
      toggle(slug);
      item.setAttribute('aria-pressed', sel[slug] ? 'true' : 'false');
    });

    $('sb-script').addEventListener('click', function (e) {
      var x = e.target.closest('.sbx-ch-x');
      if (x) removeSlug(x.getAttribute('data-slug'));
    });

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
        });
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
      patchMeta(function (m) { if (v) m.almanac = v; else delete m.almanac; });
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
    document.addEventListener('click', closeMenu);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeMenu(); closeSide(); } });
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
    $('sb-import').addEventListener('click', function () { ACTIONS.import(this); });
    $('sb-randomize').addEventListener('click', randomize);
    $('sb-sort').addEventListener('click', function () {
      if (order.length) replaceOrder(window.sortRosterSAO(order, bySlug));
    });
    $('sb-paste-go').addEventListener('click', function () {
      var t = $('sb-paste').value.trim();
      if (!t) { alert('Paste a script JSON into the box first.'); return; }
      importScript(t);
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
    'import': function () { $('sb-import-file').click(); },
    save: function () { saveCurrentToLibrary(); },
    'new': function () { newScript(); },
    clear: function () {
      if (!order.length) return;
      if (!confirm('Remove every character from this script?\n\nThe name and the details are kept.')) return;
      replaceOrder([]);
    }
  };

  /* Homebrew only, deliberately: 180-odd official characters in the pool
     would swamp a random homebrew script. Add officials by hand. */
  function randomize() {
    if (!allChars.length) return;
    if (order.length && !confirm('Replace this script with a random one?')) return;
    var COUNTS = { townsfolk: 13, outsider: 4, minion: 4, demon: 4 };
    function shuffle(arr) {
      for (var i = arr.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      }
      return arr;
    }
    var byTeam = {};
    allChars.forEach(function (c) {
      if (!byTeam[c.team]) byTeam[c.team] = [];
      byTeam[c.team].push(c);
    });
    var picked = [];
    Object.keys(COUNTS).forEach(function (team) {
      var pool = shuffle((byTeam[team] || []).slice());
      picked = picked.concat(pool.slice(0, Math.min(COUNTS[team], pool.length))
        .map(function (c) { return c.slug; }));
    });
    replaceOrder(picked);
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
      // Dusk, the minion and demon info steps, and dawn — without them the
      // export writes no night sequence at all rather than an incomplete one.
      if (window.PageRender && both[1]) window.PageRender.setNightMeta(both[1].meta);
    }).catch(function () { /* officials just will not resolve */ });
  }

  function start() {
    // The two fetches are independent, so they go together. They used to be
    // chained, which cost a whole round trip before the list could be drawn.
    Promise.all([
      loadOfficial(),
      fetch('characters.json?fields=card').then(function (r) { return r.json(); })
    ]).then(function (both) {
      allChars = both[1] || [];
      allChars.forEach(function (c) { bySlug[c.slug] = c; });

      var params = new URLSearchParams(location.search);
      // Legacy edit links (script?s={slug}) live on the publish page now.
      var editSlug = params.get('s');
      if (editSlug) {
        location.replace('publish-script?s=' + encodeURIComponent(editSlug));
        return;
      }
      var shareRaw = params.get('share');
      if (shareRaw) applyShare(shareRaw);

      rosterCache = null;
      paintCounts();
      paintRoster();
      paintLibrary();
      paintJinxCount();
      // Either pane may already have been mounted against an empty
      // roster while the fetch was in flight.
      nightDirty = jinxDirty = true;
      ensurePane();
      settle();
      /* The panel is ~1,800 rows and takes a beat to build, so it is left
         until after the browser has painted: what the reader came back for
         is their script, and it is on screen before the list starts. rAF
         then setTimeout, because an rAF callback alone still runs before
         that paint. */
      requestAnimationFrame(function () {
        setTimeout(function () {
          buildAddList();
          mountAddFilters();
        }, 0);
      });
    }).catch(function () {
      $('sb-add-list').innerHTML = '<p class="sbx-note">Could not load the characters. Check your connection and reload.</p>';
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
        var m = {};
        if (sh.n) m.name = String(sh.n).slice(0, 90);
        if (sh.a) m.author = String(sh.a).slice(0, 70);
        if (sh.m && typeof sh.m === 'object') {
          ['hideTitle', 'almanac', 'bootlegger', 'nightOrder', 'jinxEdits'].forEach(function (k) {
            if (sh.m[k] != null) m[k] = sh.m[k];
          });
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
  primeForm();
  wire();
  syncTopbarHeight();
  window.addEventListener('resize', syncTopbarHeight);
  // The bar's height depends on two images; measure again once they are in.
  window.addEventListener('load', syncTopbarHeight);
  restoreLayout();
  start();
})();
