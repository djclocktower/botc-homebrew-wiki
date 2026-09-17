/* Jinx character picker: create.html, edit.html and the /jinxes page.

   The "Jinxed character" field used to be free text, so a typo produced a
   jinx pointing at nothing: no icon, and a link to an official wiki page that
   does not exist. This puts a search box over both rosters, official and
   homebrew, and records WHICH one was picked (`slug` for one of ours, `id` for
   an official one) instead of hoping the typed name matches later.

   Typing a name that matches nothing still saves as plain text, exactly as
   before, so nobody loses work mid-edit and an unusual name is still allowed.

   Shape and keyboard handling follow assets/night-order-picker.js; the two
   are deliberately the same control worn differently. If either fetch fails
   the field stays a plain text input.

   Usage: mountJinxPicker(inputEl[, opts]). Reads the chosen target back off
   the input's dataset (`data-slug` / `data-id`).

   `opts.source` swaps the list: a function returning an array of items (or a
   promise of one) in the shape load() produces —
     {official, slug|id, name, team, creator, icon, group, order, meta}
   — so the same combobox can sit over a SHORTER roster than the whole wiki.
   /jinxes mounts it that way on "Your character", where the only sensible
   answers are the pages the reader owns and a <select> of a hundred of them
   was a very long scroll on a phone. `group` is the sticky heading a row is
   filed under (default: Official / This wiki), `order` sorts the groups
   (default: official first), `meta` overrides the small line under the name.
   `opts.empty` is the no-match message.

   loadJinxRoster() is the default source and is exported: a page that has
   the roster in hand already (for icons, say) reads the same promise rather
   than fetching the two files again. */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var TEAM_LABEL = {
    townsfolk: 'Townsfolk', outsider: 'Outsider', minion: 'Minion', demon: 'Demon',
    traveller: 'Traveller', fabled: 'Fabled', loric: 'Loric'
  };

  function root() {
    return (typeof window !== 'undefined' && window.SITE_ROOT) ||
      new URL('.', document.baseURI).href;
  }

  /* A wiki character's icon, the size a picker row draws it: the 192px WebP
     thumbnail (thumb/{file}.webp beside art/{file}), versioned by the row's
     `v` so the URL caches for a year — the same order as thumbSrc() in
     render-page.js, which every card on the wiki draws through. Art under
     another prefix is served as it is, a remote `image` stays remote, and a
     page with neither gets no icon rather than a placeholder. */
  function charIcon(c, base) {
    var ver = c.v ? '?v=' + encodeURIComponent(String(c.v)) : '';
    if (c.art && /^art\/[^/]+$/.test(c.art)) return base + 'assets/thumb/' + c.art.slice(4) + '.webp' + ver;
    if (c.art) return base + 'assets/' + c.art + ver;
    if (typeof c.image === 'string' && c.image) return c.image;
    if (Array.isArray(c.image) && c.image[0]) return c.image[0];
    return '';
  }

  /* One fetch for the whole page, however many rows ask for it. */
  var DATA = null;
  function load() {
    if (DATA) return DATA;
    var base = root();
    DATA = Promise.all([
      fetch(base + 'assets/roles.json').then(function (r) { return r.json(); })
        .catch(function () { return []; }),
      fetch(base + 'characters.json?fields=card').then(function (r) { return r.json(); })
        .catch(function () { return []; })
    ]).then(function (res) {
      var out = [];
      (res[0] || []).forEach(function (r) {
        if (!r || !r.name) return;
        out.push({
          official: true, id: r.id || '', name: r.name, team: r.team || '',
          icon: (r.image && /^https?:\/\//.test(r.image)) ? r.image : ''
        });
      });
      (res[1] || []).forEach(function (c) {
        if (!c || !c.slug || !c.name) return;
        out.push({
          official: false, slug: c.slug, name: c.name, team: c.team || '',
          creator: c.creator || '',
          icon: charIcon(c, base)
        });
      });
      return out;
    });
    return DATA;
  }

  var seq = 0;

  // Where a row files in the list: official characters lead by default (they
  // are what most jinxes point at); a custom source says otherwise with `order`.
  function order(c) {
    return typeof c.order === 'number' ? c.order : (c.official ? 0 : 1);
  }
  function group(c) {
    return c.group || (c.official ? 'Official' : 'This wiki');
  }
  function metaFor(c) {
    if (c.meta != null) return c.meta;
    return c.official
      ? (TEAM_LABEL[c.team] || c.team || 'Official')
      : ((TEAM_LABEL[c.team] || c.team || '') + (c.creator ? ' · ' + c.creator : ''));
  }

  function mountJinxPicker(field, opts) {
    if (!field || field.getAttribute('data-jxpicked') === '1') return;
    opts = opts || {};
    field.setAttribute('data-jxpicked', '1');
    field.setAttribute('autocomplete', 'off');
    field.setAttribute('role', 'combobox');
    field.setAttribute('aria-autocomplete', 'list');
    field.setAttribute('aria-expanded', 'false');

    var listId = 'jx-drop-' + (++seq);
    var wrap = document.createElement('div');
    wrap.className = 'jx-combo';
    field.parentNode.insertBefore(wrap, field);
    wrap.appendChild(field);
    var drop = document.createElement('div');
    drop.className = 'jx-drop';
    drop.id = listId;
    drop.setAttribute('role', 'listbox');
    drop.hidden = true;
    wrap.appendChild(drop);
    field.setAttribute('aria-controls', listId);

    var rows = [], active = -1, items = null;
    var source = typeof opts.source === 'function' ? opts.source : load;
    Promise.resolve(source()).then(function (d) {
      items = Array.isArray(d) ? d : [];
      // The list arrived after the field was focused: open it now rather than
      // waiting for a keystroke that a reader who already tapped may not make.
      if (document.activeElement === field) open();
    }).catch(function () { items = []; });
    var empty = opts.empty || 'No character by that name. It will be saved as plain text.';

    function close() {
      drop.hidden = true;
      field.setAttribute('aria-expanded', 'false');
      field.removeAttribute('aria-activedescendant');
      active = -1;
    }
    function highlight(i) {
      if (!rows.length) return;
      if (i < 0) i = rows.length - 1;
      if (i >= rows.length) i = 0;
      rows.forEach(function (r) { r.el.classList.remove('on'); });
      active = i;
      var el = rows[i].el;
      el.classList.add('on');
      field.setAttribute('aria-activedescendant', el.id);
      if (el.offsetTop < drop.scrollTop) drop.scrollTop = el.offsetTop;
      else if (el.offsetTop + el.offsetHeight > drop.scrollTop + drop.clientHeight)
        drop.scrollTop = el.offsetTop + el.offsetHeight - drop.clientHeight;
    }

    function open() {
      if (!items) return;
      var q = field.value.trim().toLowerCase();
      var hits = items.filter(function (c) {
        return !q || c.name.toLowerCase().indexOf(q) !== -1;
      });
      // A name typed in full should be the first thing offered, then the
      // groups in their order, then the alphabet.
      hits.sort(function (a, b) {
        var an = a.name.toLowerCase(), bn = b.name.toLowerCase();
        if (q) {
          var ax = an === q ? 0 : an.indexOf(q) === 0 ? 1 : 2;
          var bx = bn === q ? 0 : bn.indexOf(q) === 0 ? 1 : 2;
          if (ax !== bx) return ax - bx;
        }
        var ao = order(a), bo = order(b);
        if (ao !== bo) return ao - bo;
        return an.localeCompare(bn);
      });
      hits = hits.slice(0, 40);

      rows = [];
      drop.innerHTML = '';
      if (!hits.length) {
        drop.innerHTML = '<p class="jx-empty">' + esc(empty) + '</p>';
      }
      var lastGroup = null;
      hits.forEach(function (c, i) {
        var g = group(c);
        if (g !== lastGroup) {
          var h = document.createElement('div');
          h.className = 'jx-group';
          h.textContent = g;
          drop.appendChild(h);
          lastGroup = g;
        }
        var el = document.createElement('button');
        el.type = 'button';
        el.className = 'jx-opt';
        el.id = listId + '-' + i;
        el.tabIndex = -1;
        el.setAttribute('role', 'option');
        el.innerHTML =
          (c.icon ? '<img class="jx-opt-ico" src="' + esc(c.icon) + '" alt="" loading="lazy" ' +
            'decoding="async" onerror="this.style.visibility=\'hidden\'">'
            : '<span class="jx-opt-ico"></span>') +
          '<span class="jx-opt-body"><span class="jx-opt-name">' + esc(c.name) + '</span>' +
          '<span class="jx-opt-meta">' + esc(metaFor(c)) + '</span></span>';
        el.addEventListener('mousedown', function (e) { e.preventDefault(); pick(c); });
        drop.appendChild(el);
        rows.push({ el: el, c: c });
      });
      drop.scrollTop = 0;
      drop.hidden = false;
      field.setAttribute('aria-expanded', 'true');
    }

    function pick(c) {
      // The editors refresh their preview off `input`, so one has to be
      // dispatched. But this field's OWN input handler clears the recorded
      // target (that is what makes typing over a pick drop it), so the guard
      // marks this as a set rather than a keystroke.
      field.setAttribute('data-jxsetting', '1');
      field.value = c.name;
      if (c.official) { field.dataset.id = c.id || ''; delete field.dataset.slug; }
      else { field.dataset.slug = c.slug; delete field.dataset.id; }
      // The team travels with the pick: the Related editor stores it as the
      // ribbon colour's fallback (and an official character's only source —
      // the render-side registries carry no team). Jinx rows ignore it.
      if (c.team) field.dataset.team = c.team; else delete field.dataset.team;
      close();
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      field.removeAttribute('data-jxsetting');
      if (typeof opts.onPick === 'function') opts.onPick(c, field);
    }

    // Typing by hand drops the recorded target: the text no longer describes
    // whatever was picked, and a stale slug would point at the wrong page.
    // The `input` a pick dispatches is not typing: it is for the editors'
    // preview, and reopening the list on it left the one row just picked
    // hanging under the field until the reader tapped elsewhere.
    field.addEventListener('input', function () {
      if (field.getAttribute('data-jxsetting') === '1') return;
      delete field.dataset.slug;
      delete field.dataset.id;
      delete field.dataset.team;
      open();
    });
    field.addEventListener('focus', open);
    field.addEventListener('blur', function () { setTimeout(close, 0); });
    field.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (drop.hidden) return open();
        highlight(active + (e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === 'Enter') {
        if (!drop.hidden && active > -1) { e.preventDefault(); pick(rows[active].c); }
      } else if (e.key === 'Escape') {
        if (!drop.hidden) { e.stopPropagation(); close(); }
      }
    });
  }

  /* Fill a field from stored data without the input handler wiping the
     target it came with. */
  function setJinxField(field, value, slug, id, team) {
    if (!field) return;
    field.setAttribute('data-jxsetting', '1');
    field.value = value || '';
    if (slug) field.dataset.slug = slug; else delete field.dataset.slug;
    if (id) field.dataset.id = id; else delete field.dataset.id;
    if (team) field.dataset.team = team; else delete field.dataset.team;
    field.removeAttribute('data-jxsetting');
  }

  if (typeof window !== 'undefined') {
    window.mountJinxPicker = mountJinxPicker;
    window.setJinxField = setJinxField;
    window.loadJinxRoster = load;
    window.jinxCharIcon = charIcon;
  }
})();
