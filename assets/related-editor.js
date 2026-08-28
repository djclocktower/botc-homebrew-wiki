/* The "Related pages" repeater on the two character editors (create.html and
   edit.html — the same form, which is why this is one file and not two hand
   copies). It collects `data.related`: the owner's hand-picked links to the
   pages this character is about, drawn on the /c/ page as the ribbon cards
   after the Summary bullets (relatedHTML in render.js). The Worker's
   sanitizeRelated() is the enforcer of the shape; this widget only collects.

   One row is one entry. The type decides what the target field is:

   - Character: the jinx picker (official roster + this wiki's), which
     records WHICH character was picked on the field's dataset — slug for one
     of ours, id for an official one, plus the team, which is what colours
     the ribbon when the render-side registries cannot (an official
     character's team has no registry at all). A name typed past the picker
     still saves, matched as an identity guess, exactly as a typed jinx does.
   - Wiki page / Script / Collection: a pasted address or a bare slug, plus
     the link text. Pasting the URL is the expected path — wiki pages are
     deliberately unlisted, so there is no roster to search.
   - Web link: any https URL, with an optional preview image (the "embed").

   Usage: RelatedEditor.mount(listEl, addBtn, {onChange}) →
   {gather, set, addEntry}. */
(function () {
  'use strict';

  var TYPES = [
    ['char', 'Character'],
    ['page', 'Wiki page'],
    ['script', 'Script'],
    ['collection', 'Collection'],
    ['url', 'Web link']
  ];

  var TARGET_HINTS = {
    char: 'Search characters…',
    page: 'Page address or slug (e.g. /p/odyssey-attack)',
    script: 'Script address or slug (e.g. /s/my-script)',
    collection: 'Collection address or id (e.g. /collection/odyssey)',
    url: 'https://…'
  };

  /* A pasted address down to the slug the entry stores. Takes the full URL,
     the site-relative path or the bare slug, and for characters' cousins
     (page/script/collection) strips the known prefix if one is there. */
  function slugFrom(raw, type) {
    var s = String(raw || '').trim();
    if (!s) return '';
    s = s.replace(/^https?:\/\/[^/]+/i, '');
    s = s.replace(/^\//, '');
    var pre = { page: 'p/', script: 's/', collection: 'collection/' }[type];
    if (pre && s.toLowerCase().indexOf(pre) === 0) s = s.slice(pre.length);
    s = s.replace(/[?#].*$/, '').replace(/\/+$/, '');
    try { s = decodeURIComponent(s); } catch (e) { /* keep as typed */ }
    return /^[a-z0-9-]{1,80}$/i.test(s) ? s.toLowerCase() : '';
  }

  // The identity a typed-past-the-picker name most likely means, the same
  // folding /api/slug-check applies to a new character's name.
  function guessSlug(name) {
    return String(name || '').toLowerCase().normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  }

  function mount(listEl, addBtn, opts) {
    if (!listEl || !addBtn) return null;
    opts = opts || {};
    var onChange = typeof opts.onChange === 'function' ? opts.onChange : function () {};

    function syncType(row) {
      var type = row.querySelector('.rl-type').value;
      row.querySelector('.rl-char').style.display = (type === 'char') ? '' : 'none';
      row.querySelector('.rl-target').style.display = (type === 'char') ? 'none' : '';
      row.querySelector('.rl-target').placeholder = TARGET_HINTS[type] || '';
      row.querySelector('.rl-name').style.display = (type === 'char') ? 'none' : '';
      row.querySelector('.rl-image').style.display = (type === 'url') ? '' : 'none';
    }

    function addRow(entry) {
      var row = document.createElement('div');
      row.className = 'rel-row';
      row.innerHTML =
        '<select class="rl-type">' + TYPES.map(function (t) {
          return '<option value="' + t[0] + '">' + t[1] + '</option>';
        }).join('') + '</select>' +
        '<span class="rl-targets">' +
        '<input type="text" class="rl-char" placeholder="' + TARGET_HINTS.char + '">' +
        '<input type="text" class="rl-target">' +
        '</span>' +
        '<button type="button" class="btn btn-del btn-sm rl-del" title="Remove">&#10005;</button>' +
        '<input type="text" class="rl-name" placeholder="Link text (e.g. The Withering)">' +
        '<input type="text" class="rl-image" placeholder="Preview image URL (optional, https)">' +
        '<textarea class="rl-note" placeholder="How they relate (optional) — e.g. Plants the Seed token on them" rows="2"></textarea>';
      listEl.appendChild(row);

      var charField = row.querySelector('.rl-char');
      if (window.mountJinxPicker) window.mountJinxPicker(charField);

      if (entry) {
        row.querySelector('.rl-type').value =
          (entry.type === 'official') ? 'char' : (entry.type || 'char');
        if (entry.type === 'char' || entry.type === 'official') {
          if (window.setJinxField) {
            window.setJinxField(charField, entry.name || entry.slug || entry.id,
              entry.slug || '', entry.id || '', entry.team || '');
          } else { charField.value = entry.name || ''; }
        } else if (entry.type === 'url') {
          row.querySelector('.rl-target').value = entry.url || '';
          row.querySelector('.rl-name').value = entry.name || '';
          row.querySelector('.rl-image').value = entry.image || '';
        } else {
          row.querySelector('.rl-target').value = entry.slug || '';
          row.querySelector('.rl-name').value = entry.name || '';
        }
        row.querySelector('.rl-note').value = entry.note || '';
      }
      syncType(row);

      row.querySelector('.rl-type').addEventListener('change', function () {
        syncType(row); onChange();
      });
      row.querySelector('.rl-del').addEventListener('click', function () {
        row.remove(); onChange();
      });
      row.querySelectorAll('input,textarea').forEach(function (el) {
        el.addEventListener('input', onChange);
      });
      return row;
    }

    function gather() {
      var out = [];
      listEl.querySelectorAll('.rel-row').forEach(function (row) {
        var type = row.querySelector('.rl-type').value;
        var note = row.querySelector('.rl-note').value.trim();
        if (type === 'char') {
          var f = row.querySelector('.rl-char');
          var nm = f.value.trim();
          if (!nm) return;
          var e = { type: 'char', name: nm, note: note };
          if (f.dataset.id) { e.type = 'official'; e.id = f.dataset.id; }
          else e.slug = f.dataset.slug || guessSlug(nm);
          if (f.dataset.team) e.team = f.dataset.team;
          if (!e.slug && !e.id) return;
          out.push(e);
          return;
        }
        if (type === 'url') {
          var u = row.querySelector('.rl-target').value.trim();
          if (!/^https?:\/\//i.test(u)) return;
          var eu = { type: 'url', url: u,
                     name: row.querySelector('.rl-name').value.trim(), note: note };
          var img = row.querySelector('.rl-image').value.trim();
          if (/^https:\/\//i.test(img)) eu.image = img;
          out.push(eu);
          return;
        }
        var slug = slugFrom(row.querySelector('.rl-target').value, type);
        if (!slug) return;
        out.push({ type: type, slug: slug,
                   name: row.querySelector('.rl-name').value.trim() || slug,
                   note: note });
      });
      return out;
    }

    function set(list) {
      listEl.querySelectorAll('.rel-row').forEach(function (r) { r.remove(); });
      (Array.isArray(list) ? list : []).forEach(function (e) { if (e) addRow(e); });
    }

    addBtn.addEventListener('click', function () { addRow(); });

    return { gather: gather, set: set, addEntry: function (e) { addRow(e); onChange(); } };
  }

  if (typeof window !== 'undefined') window.RelatedEditor = { mount: mount };
})();
