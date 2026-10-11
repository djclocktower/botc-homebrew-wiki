/* assets/edit-journal.js — never lose a word.

   Two jobs, shared by the five editors (create, edit, publish-script,
   publish-collection, publish-page) so they cannot drift apart:

   1. THE JOURNAL. While somebody types, a copy of the form is kept in this
      browser's localStorage. A phone throws a background tab away without
      asking, a session runs out, a save fails — and the text used to go with
      it. Now the next visit to the same editor offers it back ("You have
      unsaved changes from 4 minutes ago. Restore them / Discard"), and leaving
      the page with unsaved changes asks first.

   2. THE CONFLICT PANEL. Every save posts the `updatedAt` its editor loaded,
      and the Worker refuses one whose copy is stale (409, `conflict: true`).
      That refusal used to end in "reload before saving again", which threw
      the typing away. The panel says what each side changed, and offers to
      combine them, take theirs, or keep editing.

   Rules that are easy to break:

   - PER ACCOUNT. A key is botc_journal:{account}:{page}. On a shared family
     computer or a club laptop, somebody else signing in to the same page must
     never be offered the last person's unsaved text. With no account known,
     mount() still tracks the form (the conflict panel needs that) but writes
     nothing, shows nothing and never guards the unload. Logging out clears
     every entry (account.html and login.html do it inline).
   - TEXT ONLY. strip() drops any `data:` string (a freshly picked picture)
     and any string over 100,000 characters; an entry over 300,000 characters
     in all is not written. The banner never claims a copy it does not have.
   - THE BASE TRAVELS WITH THE ENTRY. An entry stores the stamp its edits
     were made against (`base`), the server's copy at that stamp (`baseData`)
     and the form as it was then (`baseForm`). Restoring puts all three back,
     so a save after somebody else's edit meets the conflict panel with a true
     three-way diff, instead of overwriting blind or calling every field
     "changed by you".
   - A WAITING OFFER IS NEVER OVERWRITTEN. While the restore banner is up,
     nothing is written over the entry it is offering; typing first and then
     choosing Restore must still find the old text.
   - Two snapshots, two shapes. "Changed by you" compares the form now with
     the form as loaded (gather() shape, `mineBase`); "changed by them"
     compares the server's copy then with the server's copy now (`base` and
     `theirs`, the API's shape). Comparing across shapes would report every
     field as changed.

   No DOM at the top level; everything that touches document or localStorage
   is inside a function and a try/catch. The pure helpers are exported for
   migration/tests/edit-journal.test.mjs. */
(function (root) {
  'use strict';

  var PREFIX = 'botc_journal:';
  var STASH_KEY = 'botc_script_stash';
  var MAX_AGE = 14 * 24 * 3600 * 1000;
  var KEEP = 20;
  var MAX_LEN = 300000;
  var MAX_STR = 100000;
  // All entries together: localStorage is ~5 MB per origin and shared with
  // the Script Builder, the favourites and the text catalogue. Twenty
  // entries at MAX_LEN would fill it and break their writes too.
  var TOTAL_MAX = 1500000;
  var DEBOUNCE = 1500;
  var IGNORE = ['updatedAt', 'baseUpdatedAt', 'status', 'slug', 'id', 'v', 'classification',
    'curata', 'curataFrom', '_draftNote', 'appearsInFrom', 'tagsBy', 'missing', 'page',
    'address', 'url_slug', 'owner', 'ownerId', 'owner_id', 'parentType', 'parentSlug',
    'parentKey', 'parentName', 'created', 'updated', 'editorsUnknown'];

  // ── pure helpers ──
  function stableStringify(x) {
    if (x === undefined) return 'null';
    if (x === null || typeof x !== 'object') return JSON.stringify(x);
    if (Array.isArray(x)) return '[' + x.map(stableStringify).join(',') + ']';
    var keys = Object.keys(x).filter(function (k) { return x[k] !== undefined; }).sort();
    return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + stableStringify(x[k]); }).join(',') + '}';
  }
  function isEmpty(v) {
    if (v === undefined || v === null || v === '' || v === false) return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'object') return Object.keys(v).every(function (k) { return v[k] === undefined; });
    return false;
  }
  function same(a, b) {
    if (isEmpty(a) && isEmpty(b)) return true;
    return stableStringify(a) === stableStringify(b);
  }
  /* The comparison form: key-sorted, with empty values left out of every
     object, so '' / [] / null / absent (which widgets swap between as they
     settle) never read as an edit nobody made. */
  function canon(x) {
    function clean(v) {
      if (Array.isArray(v)) return v.map(clean);
      if (v && typeof v === 'object') {
        var o = {};
        Object.keys(v).forEach(function (k) { if (!isEmpty(v[k])) o[k] = clean(v[k]); });
        return o;
      }
      return v;
    }
    return stableStringify(clean(x));
  }
  function strip(x) {
    if (typeof x === 'string') {
      if (x.slice(0, 5) === 'data:' || x.length > MAX_STR) return undefined;
      return x;
    }
    if (x === null || typeof x !== 'object') return x;
    if (Array.isArray(x)) {
      return x.map(strip).filter(function (v) { return v !== undefined; });
    }
    var out = {};
    Object.keys(x).forEach(function (k) {
      var v = strip(x[k]);
      if (v !== undefined) out[k] = v;
    });
    return out;
  }
  function own(o, k) { return o && Object.prototype.hasOwnProperty.call(o, k); }
  function get(o, k) { return o ? o[k] : undefined; }

  var LABELS = {
    name: 'Name', team: 'Team', ability: 'Ability', creator: 'Creator', author: 'Author',
    lede: 'Flavour line', summaryBullets: 'Summary', howToRun: 'How to run',
    callout: 'How-to-run notes', examples: 'Examples', tips: 'Tips',
    bluffing: 'Bluffing', fighting: 'Fighting', quote: 'Quote', flavor: 'Quote',
    appearsIn: 'Appears in', tags: 'Tags', customBoxes: 'Custom boxes',
    special: 'Special properties', publicEdit: 'Who can edit', editors: 'Approved editors',
    jinxes: 'Jinxes', jinxDisplay: 'Jinx display', related: 'Related pages',
    customJson: 'Custom JSON', reminders: 'Reminder tokens', remindersGlobal: 'Global reminders',
    firstNight: 'First night order', otherNight: 'Other nights order',
    firstNightReminder: 'First night reminder', otherNightReminder: 'Other nights reminder',
    art: 'Icon', image: 'Icon', artAlt: 'Second icon', imageAlt: 'Second icon',
    artAlt2: 'Third icon', imageAlt2: 'Third icon', token: 'Printable token',
    tokenImage: 'Printable token', tokenArt: 'Printable token', artScale: 'Icon size',
    creditUnlinked: 'Credit link', curataOptOut: 'Curata', setup: 'Setup',
    characters: 'Roster', nightOrder: 'Night order', jinxEdits: 'Script jinxes',
    theme: 'Appearance', header: 'Banner', logo: 'Logo', match: 'Members',
    include: 'Members', exclude: 'Members', order: 'Roster order',
    displayName: 'Name', tagline: 'Tagline', version: 'Version', difficulty: 'Difficulty',
    description: 'Description', synopsis: 'Synopsis', gameplay: 'Gameplay',
    strategyGood: 'Strategy (good)', strategyEvil: 'Strategy (evil)',
    almanac: 'Almanac link', bootlegger: 'Bootlegger rules', hideTitle: 'Hide title',
    title: 'Title', subtitle: 'Subtitle', blurb: 'Summary', body: 'Page text',
    infobox: 'Fact box', boxes: 'Side boxes', images: 'Pictures', toc: 'Contents box',
    comments: 'Comments', pronunciation: 'Pronunciation', translatedBy: 'Translated by',
    iconBy: 'Icon by', edition: 'Edition'
  };
  function label(key) {
    if (LABELS[key]) return LABELS[key];
    var s = String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /* diffFields(base, mine, theirs, opts) -> [{key, label, mine, theirs}]
     base:   the server's copy the edits started from (API shape), or null.
     mine:   the form now (gather() shape).
     theirs: the server's copy now (API shape).
     opts.mineBase: the form as loaded (gather() shape); defaults to base.
     opts.keys: the keys to compare; defaults to mine's keys plus every key
     their side changed. With no base, every key where mine and theirs differ
     is reported as changed by both — there is nothing to say who moved. */
  function diffFields(base, mine, theirs, opts) {
    opts = opts || {};
    mine = mine || {}; theirs = theirs || {};
    var mineBase = opts.mineBase !== undefined && opts.mineBase !== null ? opts.mineBase : base;
    var keys = opts.keys ? opts.keys.slice() : Object.keys(mine);
    if (!opts.keys && base) {
      Object.keys(theirs).concat(Object.keys(base)).forEach(function (k) {
        if (keys.indexOf(k) < 0 && !same(base[k], theirs[k])) keys.push(k);
      });
    }
    var rows = [];
    var seen = {};
    keys.forEach(function (k) {
      if (IGNORE.indexOf(k) >= 0 || seen[k]) return;
      seen[k] = 1;
      var m, t;
      if (!base) {
        if (!own(mine, k)) return;
        m = t = !same(mine[k], theirs[k]);
      } else {
        m = own(mine, k) && !same(get(mineBase, k), mine[k]);
        t = !same(base[k], theirs[k]);
      }
      if (m || t) rows.push({ key: k, label: label(k), mine: !!m, theirs: !!t });
    });
    return rows;
  }

  /* merge(base, mine, theirs, keys, opts) — start from their copy, and take
     mine for every key I changed. Where both changed, mine wins (the panel
     has already shown theirs). With no base, every key is mine: callers must
     not offer that as a "combine" (see the panel). Never mutates inputs. */
  function merge(base, mine, theirs, keys, opts) {
    opts = opts || {};
    mine = mine || {};
    var mineBase = opts.mineBase !== undefined && opts.mineBase !== null ? opts.mineBase : base;
    var out = JSON.parse(JSON.stringify(theirs || {}));
    (keys || Object.keys(mine)).forEach(function (k) {
      if (IGNORE.indexOf(k) >= 0 || !own(mine, k)) return;
      if (!base || !same(get(mineBase, k), mine[k])) {
        out[k] = mine[k] === undefined ? undefined : JSON.parse(JSON.stringify(mine[k]));
      }
    });
    return out;
  }

  function ago(ms, now) {
    var d = Math.max(0, (now === undefined ? Date.now() : now) - ms);
    var min = Math.floor(d / 60000);
    if (min < 1) return 'just now';
    if (min === 1) return '1 minute ago';
    if (min < 60) return min + ' minutes ago';
    var h = Math.floor(min / 60);
    if (h === 1) return '1 hour ago';
    if (h < 24) return h + ' hours ago';
    var days = Math.floor(h / 24);
    if (days === 1) return 'yesterday';
    return days + ' days ago';
  }

  /* A roster looks REPLACED, not edited, when fewer than half of the saved
     roster's characters are still on it. Adding or removing a handful is an
     ordinary edit; a share link, an Import→Replace or a freshly built script
     clears the bar easily. No saved roster (meta written before this) never
     counts. */
  function rosterReplaced(saved, now) {
    var a = (Array.isArray(saved) ? saved : String(saved || '').split(',')).filter(Boolean);
    var b = (Array.isArray(now) ? now : String(now || '').split(',')).filter(Boolean);
    if (!a.length) return false;
    var have = {};
    b.forEach(function (s) { have[s] = 1; });
    var kept = a.filter(function (s) { return have[s]; }).length;
    // Measured against the larger of the two, so ten kept beside forty new
    // reads as a different script too.
    return kept * 2 < Math.max(a.length, b.length);
  }

  function valueText(v) {
    var s;
    if (v === undefined || v === null || v === '') s = '(empty)';
    else if (typeof v === 'string') s = v;
    else if (Array.isArray(v)) {
      s = v.length ? v.map(function (x) { return typeof x === 'string' ? x : JSON.stringify(x, null, 2); }).join('\n') : '(empty)';
    } else s = JSON.stringify(v, null, 2);
    return s.length > 4000 ? s.slice(0, 4000) + '\n…' : s;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ── storage ──
  function store() {
    try {
      if (root.localStorage) return root.localStorage;
      if (typeof localStorage !== 'undefined') return localStorage;
    } catch (e) {}
    return null;
  }
  function userKey(user) {
    var u = user && typeof user === 'object' ? (user.username || '') : (user || '');
    return String(u).trim().toLowerCase();
  }
  function allKeys(st) {
    var out = [];
    try { for (var i = 0; i < st.length; i++) { var k = st.key(i); if (k) out.push(k); } } catch (e) {}
    return out;
  }
  function prune(now) {
    var st = store(); if (!st) return;
    now = now === undefined ? Date.now() : now;
    var entries = [];
    allKeys(st).forEach(function (k) {
      if (k.indexOf(PREFIX) !== 0) return;
      var at = 0, len = 0;
      try { var raw = st.getItem(k) || ''; len = raw.length; at = (JSON.parse(raw) || {}).at || 0; } catch (e) {}
      if (!at || now - at > MAX_AGE) { try { st.removeItem(k); } catch (e) {} }
      else entries.push({ k: k, at: at, len: len });
    });
    entries.sort(function (a, b) { return b.at - a.at; });
    var total = 0;
    entries.forEach(function (e, i) {
      total += e.len;
      if (i >= KEEP || total > TOTAL_MAX) { try { st.removeItem(e.k); } catch (x) {} }
    });
  }
  /* Logging out is the "I'm done on this device" act. */
  function clearAll() {
    var st = store(); if (!st) return;
    allKeys(st).forEach(function (k) {
      if (k.indexOf(PREFIX) === 0 || k === STASH_KEY) { try { st.removeItem(k); } catch (e) {} }
    });
  }
  function isNewKey(key) { return /(^|:)new(:|$)/.test(String(key)); }

  // ── the journal ──
  /* mount(opts) -> handle. opts:
       key         page key: character:{identity} | character:new | script:{slug}
                   | script:new | collection:{id} | collection:new
                   | wikipage:{slug} | wikipage:new:{parentType}:{parentKey}
       user        the account (username, or /api/me's object). None: inert.
       gather()    the form as an object
       apply(data, entry)  put a journal entry back into the form
       root        element whose input/change/click mean "something changed"
       bannerHost  element the restore banner goes into (first child)
       base()      the stamp the form's edits are against
       baseData()  the server's copy at that stamp
       onRestore(entry)  editor adopts entry.base and entry.baseData
       guard       false: never ask before leaving (publish-script, whose
                   state already lives in localStorage and survives a tab)
     Mount AFTER the form is filled: the clean snapshot is taken here. */
  function mount(opts) {
    opts = opts || {};
    var who = userKey(opts.user);
    var enabled = !!(who && opts.key && store());
    var key = opts.key;
    var timer = null, offering = null, paused = false, touched = false, banner = null;
    var clean = snap();
    var baseForm = full();

    function fullKey() { return PREFIX + who + ':' + key; }
    function snapObj() {
      try { return strip(opts.gather ? opts.gather() : {}) || {}; } catch (e) { return null; }
    }
    function snap() { var o = snapObj(); return o === null ? null : canon(o); }
    function full() { var o = snapObj(); return o === null ? null : stableStringify(o); }
    function read() {
      if (!enabled) return null;
      try { var v = JSON.parse(store().getItem(fullKey())); return v && v.v === 1 ? v : null; }
      catch (e) { return null; }
    }
    function remove() {
      if (!enabled) return;
      try { store().removeItem(fullKey()); } catch (e) {}
    }
    function flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!enabled || offering) return;
      var data = snapObj();
      if (data === null) return;
      if (canon(data) === clean) { remove(); return; }
      var entry = {
        v: 1, at: Date.now(),
        base: (opts.base && opts.base()) || null,
        baseData: opts.baseData ? strip(opts.baseData()) || null : null,
        baseForm: baseForm ? JSON.parse(baseForm) : null,
        data: data
      };
      var text = JSON.stringify(entry);
      if (text.length > MAX_LEN) {
        entry.baseData = null;              // the three-way diff is a luxury
        text = JSON.stringify(entry);
        if (text.length > MAX_LEN) { api.lastError = 'too-big'; return; }
      }
      try { store().setItem(fullKey(), text); api.lastError = null; }
      catch (e) {
        prune(); // quota: make room once, then give up quietly
        try { store().setItem(fullKey(), text); api.lastError = null; } catch (x) { api.lastError = 'quota'; }
      }
    }
    function schedule() {
      touched = true;
      if (!enabled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, DEBOUNCE);
    }
    function isDirty() {
      if (paused) return false;
      var s = snap();
      return s !== null && s !== clean;
    }

    function removeBanner() {
      if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
      banner = null;
    }
    function drawBanner(entry, serverUpdatedAt) {
      if (typeof document === 'undefined' || !opts.bannerHost) return;
      removeBanner();
      banner = document.createElement('div');
      banner.className = 'ej-banner';
      banner.setAttribute('role', 'status');
      var stale = entry.base && serverUpdatedAt && entry.base !== serverUpdatedAt;
      banner.innerHTML =
        '<p class="ej-head">You have unsaved changes from ' + esc(ago(entry.at)) + '.</p>' +
        (stale ? '<p>This page has been saved since then. If you restore them and save, ' +
          'you’ll see what changed before anything is overwritten.</p>' : '') +
        '<div class="ej-actions">' +
          '<button type="button" class="ej-btn ej-primary" data-ej="restore">Restore them</button>' +
          '<button type="button" class="ej-btn" data-ej="discard">Discard</button>' +
        '</div>' +
        '<p class="ej-small">Pictures aren’t kept here: if you had picked a new icon or banner, pick it again.</p>';
      banner.addEventListener('click', function (e) {
        var b = e.target && e.target.closest ? e.target.closest('[data-ej]') : null;
        if (!b) return;
        e.preventDefault();
        e.stopPropagation();
        if (b.getAttribute('data-ej') === 'restore') handle.restore();
        else handle.dismissOffer();
      });
      opts.bannerHost.insertBefore(banner, opts.bannerHost.firstChild);
    }

    var handle = {
      /* After load: is there an entry worth offering? Returns it (and draws
         the banner) or null. */
      check: function (serverUpdatedAt) {
        var entry = read();
        if (!entry) return null;
        if (!isNewKey(key) && !entry.base) { remove(); return null; }
        if (canon(entry.data) === clean) { remove(); return null; }
        offering = entry;
        drawBanner(entry, serverUpdatedAt);
        return entry;
      },
      restore: function () {
        var entry = offering;
        if (!entry) return;
        offering = null;
        removeBanner();
        try { if (opts.apply) opts.apply(entry.data, entry); } catch (e) {}
        if (entry.baseForm) baseForm = stableStringify(entry.baseForm);
        touched = true;
        if (opts.onRestore) { try { opts.onRestore(entry); } catch (e) {} }
        flush();
      },
      dismissOffer: function () {
        offering = null;
        removeBanner();
        remove();
        flush();
      },
      markClean: function () {
        if (timer) { clearTimeout(timer); timer = null; }
        offering = null;
        removeBanner();
        var s = snap();
        if (s !== null) { clean = s; baseForm = full(); }
        remove();
      },
      rekey: function (newKey) {
        if (!newKey || newKey === key) return;
        remove();
        key = newKey;
      },
      discard: function () { offering = null; removeBanner(); remove(); paused = true; },
      /* Write an entry the editor assembled itself (publish-script puts its
         unsaved local copy aside here before ?s= loads the server's). */
      put: function (data, base, baseData, baseForm) {
        if (!enabled) return;
        var text = JSON.stringify({ v: 1, at: Date.now(), base: base || null,
          baseData: baseData ? strip(baseData) : null, baseForm: baseForm ? strip(baseForm) : null,
          data: strip(data) });
        if (text.length > MAX_LEN) { api.lastError = 'too-big'; return; }
        try { store().setItem(fullKey(), text); } catch (e) { api.lastError = 'quota'; }
      },
      pause: function () { paused = true; },
      resume: function () { paused = false; },
      isDirty: isDirty,
      flush: flush,
      key: function () { return key; },
      /* The form as loaded (or, after a restore, as it was when the restored
         edits began): the "mine" side's base for diffFields/merge. */
      cleanData: function () { try { return JSON.parse(baseForm); } catch (e) { return null; } },
      enabled: enabled
    };

    if (enabled) {
      prune();
      var r = opts.root;
      if (r && r.addEventListener) {
        r.addEventListener('input', schedule, true);
        r.addEventListener('change', schedule, true);
        r.addEventListener('click', function (e) {
          var t = e.target;
          if (t && t.closest && t.closest('button') && !t.closest('.ej-banner, .ej-conflict')) {
            setTimeout(schedule, 0);
          }
        }, true);
      }
      if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('visibilitychange', function () { if (document.hidden && !paused) flush(); });
      }
      if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('pagehide', function () { if (!paused) flush(); });
        if (opts.guard !== false) window.addEventListener('beforeunload', function (e) {
          if (!isDirty()) return;
          flush();
          e.preventDefault();
          e.returnValue = '';
          return '';
        });
      }
    }
    // Widgets that settle a moment after the form is filled (the tag picker,
    // approved editors, autosize) would otherwise read as an edit nobody made.
    if (typeof setTimeout === 'function') {
      setTimeout(function () {
        if (touched) return;
        var s = snap();
        if (s === null) return;
        clean = s; baseForm = full();
        if (offering && canon(offering.data) === clean) handle.dismissOffer();
      }, 600);
    }
    return handle;
  }

  // ── the conflict panel ──
  /* conflict(opts) draws the panel inline, directly above opts.host (the
     editor's save buttons). opts:
       rows      diffFields() output, or null when their copy could not be read
       theirs    their copy (for the "see theirs" boxes)
       noBase    true when there is no snapshot to diff against: Combine is
                 then not offered (merge would take mine for every field),
                 only an explicitly confirmed "Replace theirs with mine"
       onCombine(), onTakeTheirs(), onReplace(), onCancel()
     Returns { close() }. */
  function conflict(opts) {
    if (typeof document === 'undefined') return { close: function () {} };
    opts = opts || {};
    var old = document.querySelectorAll('.ej-conflict');
    for (var i = 0; i < old.length; i++) old[i].parentNode.removeChild(old[i]);
    var rows = opts.rows;
    var theirs = opts.theirs || {};
    var el = document.createElement('div');
    el.className = 'ej-conflict';
    el.setAttribute('role', 'alert');
    function names(list) { return list.map(function (r) { return esc(r.label); }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(', '); }
    function theirBox(r) {
      return '<details class="ej-their"><summary>See their ' + esc(r.label) + '</summary>' +
        '<div class="ej-val">' + esc(valueText(theirs[r.key])) + '</div></details>';
    }
    var html = '<h3 class="ej-head" tabindex="-1">Someone else saved this page while you were editing</h3>' +
      '<p>Nothing has been saved yet, and your changes are still here.</p>';
    var canCombine = !opts.noBase && !!rows && !!opts.onCombine;
    if (!rows) {
      html += '<p>We couldn’t load their version to compare. Copy anything you want to keep before using theirs.</p>';
    } else if (opts.noBase) {
      if (rows.length) {
        html += '<p><strong>These parts differ:</strong> ' + names(rows) + '</p>';
        html += rows.map(theirBox).join('');
      }
    } else {
      var mineOnly = rows.filter(function (r) { return r.mine && !r.theirs; });
      var theirsOnly = rows.filter(function (r) { return r.theirs && !r.mine; });
      var both = rows.filter(function (r) { return r.mine && r.theirs; });
      if (mineOnly.length) html += '<p><strong>Changed by you:</strong> ' + names(mineOnly) + '</p>';
      if (theirsOnly.length) html += '<p><strong>Changed by them:</strong> ' + names(theirsOnly) + '</p>';
      if (both.length) {
        html += '<p class="ej-both"><strong>Changed by both of you:</strong> ' + names(both) +
          '. If you combine, yours will be kept.</p>';
        html += both.map(theirBox).join('');
      }
    }
    html += '<div class="ej-actions">';
    if (canCombine) html += '<button type="button" class="ej-btn ej-primary" data-ej="combine">Combine and save</button>';
    html += '<button type="button" class="ej-btn' + (canCombine ? '' : ' ej-primary') + '" data-ej="theirs">Use their version</button>';
    if (opts.noBase && rows && opts.onReplace) html += '<button type="button" class="ej-btn" data-ej="replace">Replace theirs with mine</button>';
    html += '<button type="button" class="ej-btn" data-ej="cancel">Keep editing</button></div>';
    if (canCombine) html += '<p class="ej-small">Combine keeps your changes, and their changes to everything you didn’t touch.</p>';
    el.innerHTML = html;
    function close() { if (el.parentNode) el.parentNode.removeChild(el); }
    el.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-ej]') : null;
      if (!b) return;
      e.preventDefault();
      var what = b.getAttribute('data-ej');
      if (what === 'combine') { close(); opts.onCombine(); }
      else if (what === 'theirs') {
        if (!confirm('Throw away your changes and load their version?')) return;
        close(); if (opts.onTakeTheirs) opts.onTakeTheirs();
      } else if (what === 'replace') {
        if (!confirm('Replace their changes with yours? What they saved will be overwritten (it stays in the page history once the page is live).')) return;
        close(); if (opts.onReplace) opts.onReplace();
      } else { close(); if (opts.onCancel) opts.onCancel(); }
    });
    var host = opts.host;
    if (host && host.parentNode) host.parentNode.insertBefore(el, host);
    else if (document.body) document.body.appendChild(el);
    try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
    try { el.querySelector('.ej-head').focus({ preventScroll: true }); } catch (e) {}
    return { close: close };
  }

  /* The flow every editor runs on a 409 with `conflict: true`:
       fetchTheirs() -> Promise<{data, updatedAt, status}> (API shape)
       base, mineBase, mine — as diffFields
       allowSilent — when their side changed nothing a reader would call
         content (a Publish toggle, a Curata grant, an icon upload), re-send
         once with their stamp instead of alarming anybody
       retry(fresh), combine(merged, fresh), takeTheirs(), replace(fresh),
       cancel(), host */
  function handleConflict(o) {
    var fetchP;
    try { fetchP = Promise.resolve(o.fetchTheirs()); } catch (e) { fetchP = Promise.reject(e); }
    return fetchP.then(function (fresh) {
      if (!fresh || !fresh.data) throw new Error('no copy');
      var noBase = !o.base;
      var rows = diffFields(o.base || null, o.mine, fresh.data, { mineBase: o.mineBase });
      var theirSide = noBase ? rows.length : rows.filter(function (r) { return r.theirs; }).length;
      if (o.allowSilent && !theirSide) { o.retry(fresh); return; }
      conflict({
        host: o.host, rows: rows, theirs: fresh.data, noBase: noBase,
        onCombine: noBase ? null : function () {
          o.combine(merge(o.base, o.mine, fresh.data, null, { mineBase: o.mineBase }), fresh);
        },
        onReplace: noBase && o.replace ? function () { o.replace(fresh); } : null,
        onTakeTheirs: o.takeTheirs, onCancel: o.cancel
      });
    }).catch(function () {
      conflict({ host: o.host, rows: null, onTakeTheirs: o.takeTheirs, onCancel: o.cancel });
    });
  }

  /* An error that keeps the response body, so a caller can tell a conflict
     409 from the other 409s (a collection name, a page title). */
  function saveError(message, body, status) {
    var e = new Error(message);
    e.body = body || null;
    e.status = status || 0;
    return e;
  }
  function isConflict(err) { return !!(err && err.body && err.body.conflict); }

  var NOT_LOGGED_IN = 'Your changes are kept on this device. Log in and come back to this page to restore them.';

  var api = {
    mount: mount, conflict: conflict, handleConflict: handleConflict,
    stableStringify: stableStringify, canon: canon, isEmpty: isEmpty, same: same, strip: strip,
    diffFields: diffFields, merge: merge, label: label, ago: ago,
    rosterReplaced: rosterReplaced, valueText: valueText, prune: prune, clearAll: clearAll,
    saveError: saveError, isConflict: isConflict, esc: esc,
    PREFIX: PREFIX, STASH_KEY: STASH_KEY, TOTAL_MAX: TOTAL_MAX, IGNORE: IGNORE, NOT_LOGGED_IN: NOT_LOGGED_IN,
    lastError: null
  };
  root.EditJournal = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
