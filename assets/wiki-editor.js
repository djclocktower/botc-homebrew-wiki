/* Shared editor widgets for every page that writes wiki text:
   publish-page.html (custom pages), publish-news.html (news articles) and
   the custom-box sections of publish-script.html / publish-collection.html.

   Nothing here renders published output — that is render-wiki.js, which the
   previews call so the editor and the live page can never drift apart.

   Provides:
     WikiEditor.toolbar(textarea, mount, opts)  formatting buttons
     WikiEditor.boxes(container, addButton)     the {title, content} repeater
     WikiEditor.infobox(container, addButton)   the fact-box row repeater
     WikiEditor.autoGrow(textarea)              grow-with-content textareas
     WikiEditor.loadCharLinks()                 feeds [[Name]] links to the
                                                preview from characters.json
     WikiEditor.imageInput(opts)                pick + downscale an image
*/
(function () {
  'use strict';

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* ── textareas that grow with their content ── */
  function autoGrow(ta) {
    if (!ta) return;
    ta.style.overflowY = 'hidden';
    function fit() {
      ta.style.height = 'auto';
      ta.style.height = Math.max(ta.scrollHeight + 2, 54) + 'px';
    }
    ta.addEventListener('input', fit);
    fit();
  }

  /* ── formatting toolbar ──
     Each button wraps the selection, or drops a template in at the cursor. */
  var BUTTONS = [
    { label: 'B', title: 'Bold', wrap: ['**', '**'], cls: 'we-b' },
    { label: 'I', title: 'Italic', wrap: ['*', '*'], cls: 'we-i' },
    { label: 'S', title: 'Strikethrough', wrap: ['~~', '~~'], cls: 'we-s' },
    { label: '</>', title: 'Code', wrap: ['`', '`'] },
    { label: 'H1', title: 'Big heading', line: '# ' },
    { label: 'H2', title: 'Heading', line: '## ' },
    { label: 'H3', title: 'Small heading', line: '### ' },
    { label: '• List', title: 'Bullet list', line: '- ' },
    { label: '1. List', title: 'Numbered list', line: '1. ' },
    { label: '❝', title: 'Quote', line: '> ' },
    { label: 'Link', title: 'Link', template: '[label](https://example.com)', select: [1, 6] },
    { label: 'Character', title: 'Link to a character on this wiki', template: '[[Character Name]]', select: [2, 16] },
    { label: 'Image', title: 'Image (add |left, |right or |wide to place it)', template: '![caption](pages/my-image.png|right)', select: [2, 9] },
    { label: 'Table', title: 'Table', block: '| Column | Column |\n| --- | --- |\n| value | value |' },
    { label: 'Note', title: 'Callout box (note / tip / warning / example / lore)', block: '::: note Title\nText inside the box.\n:::' },
    { label: 'Rule', title: 'Horizontal rule', block: '---' },
    { label: 'Contents', title: 'Put the contents box here', block: '[toc]' }
  ];

  function toolbar(ta, mount, opts) {
    opts = opts || {};
    if (!ta || !mount) return;
    var bar = el('div', 'we-toolbar');

    function apply(fn) {
      var start = ta.selectionStart, end = ta.selectionEnd;
      var before = ta.value.slice(0, start), sel = ta.value.slice(start, end), after = ta.value.slice(end);
      var res = fn(before, sel, after);
      ta.value = res.value;
      ta.focus();
      ta.setSelectionRange(res.start, res.end);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }

    BUTTONS.forEach(function (b) {
      if (opts.simple && !b.wrap && !b.line && b.label !== 'Link') return;
      var btn = el('button', 'we-btn' + (b.cls ? ' ' + b.cls : ''), b.label);
      btn.type = 'button';
      btn.title = b.title;
      btn.addEventListener('click', function () {
        apply(function (before, sel, after) {
          if (b.wrap) {
            var body = sel || b.title.toLowerCase();
            return {
              value: before + b.wrap[0] + body + b.wrap[1] + after,
              start: before.length + b.wrap[0].length,
              end: before.length + b.wrap[0].length + body.length
            };
          }
          if (b.line) {
            // Prefix every selected line (or the current one).
            var lineStart = before.lastIndexOf('\n') + 1;
            var head = before.slice(0, lineStart);
            var rest = before.slice(lineStart) + sel;
            var out = rest.split('\n').map(function (l) { return b.line + l; }).join('\n');
            return { value: head + out + after, start: head.length + out.length, end: head.length + out.length };
          }
          var pad = (before && !/\n\n$/.test(before)) ? (/\n$/.test(before) ? '\n' : '\n\n') : '';
          var text = b.template || b.block;
          var at = before.length + pad.length;
          return {
            value: before + pad + text + (b.block ? '\n' : '') + after,
            start: b.select ? at + b.select[0] : at + text.length,
            end: b.select ? at + b.select[1] : at + text.length
          };
        });
      });
      bar.appendChild(btn);
    });

    mount.appendChild(bar);
  }

  /* ── custom boxes: any number of {title, content} ── */
  function boxes(container, addBtn, opts) {
    opts = opts || {};
    if (!container) return null;
    function onChange() { if (opts.onChange) opts.onChange(); }

    function add(title, content) {
      var row = el('div', 'we-box-row');
      var head = el('div', 'we-box-head');
      var t = el('input', 'we-box-title');
      t.type = 'text';
      t.placeholder = opts.titlePlaceholder || 'Box title (e.g. Lore)';
      t.value = title || '';
      var del = el('button', 'we-box-del', '✕');
      del.type = 'button';
      del.title = 'Remove this box';
      head.appendChild(t); head.appendChild(del);
      var c = el('textarea', 'we-box-content');
      c.placeholder = 'Box contents… (the same formatting as the page body)';
      c.value = content || '';
      row.appendChild(head); row.appendChild(c);
      container.appendChild(row);
      autoGrow(c);
      del.addEventListener('click', function () { row.remove(); onChange(); });
      t.addEventListener('input', onChange);
      c.addEventListener('input', onChange);
      return row;
    }

    if (addBtn) addBtn.addEventListener('click', function () { add(); onChange(); });

    return {
      add: add,
      load: function (list) {
        container.innerHTML = '';
        (list || []).forEach(function (b) { add((b && b.title) || '', (b && b.content) || ''); });
      },
      gather: function () {
        var out = [];
        Array.prototype.forEach.call(container.querySelectorAll('.we-box-row'), function (r) {
          var t = r.querySelector('.we-box-title').value.trim();
          var c = r.querySelector('.we-box-content').value.replace(/\s+$/, '');
          if (t || c.trim()) out.push({ title: t, content: c });
        });
        return out;
      }
    };
  }

  /* ── fact box: a title, an image path and Label / value rows ── */
  function infobox(container, addBtn, opts) {
    opts = opts || {};
    if (!container) return null;
    function onChange() { if (opts.onChange) opts.onChange(); }

    function addRow(label, value) {
      var row = el('div', 'we-info-row');
      var l = el('input', 'we-info-label');
      l.type = 'text'; l.placeholder = 'Label'; l.value = label || '';
      var v = el('input', 'we-info-value');
      v.type = 'text'; v.placeholder = 'Value'; v.value = value || '';
      var del = el('button', 'we-box-del', '✕');
      del.type = 'button'; del.title = 'Remove this row';
      row.appendChild(l); row.appendChild(v); row.appendChild(del);
      container.appendChild(row);
      del.addEventListener('click', function () { row.remove(); onChange(); });
      l.addEventListener('input', onChange);
      v.addEventListener('input', onChange);
      return row;
    }

    if (addBtn) addBtn.addEventListener('click', function () { addRow(); onChange(); });

    return {
      addRow: addRow,
      load: function (info) {
        container.innerHTML = '';
        ((info && info.rows) || []).forEach(function (r) { addRow(r.label, r.value); });
      },
      gather: function (title, image) {
        var rows = [];
        Array.prototype.forEach.call(container.querySelectorAll('.we-info-row'), function (r) {
          var l = r.querySelector('.we-info-label').value.trim();
          var v = r.querySelector('.we-info-value').value.trim();
          if (l || v) rows.push({ label: l, value: v });
        });
        title = (title || '').trim();
        image = (image || '').trim();
        if (!rows.length && !title && !image) return null;
        return { title: title, image: image, rows: rows };
      }
    };
  }

  /* ── [[Character Name]] links in the preview ──
     Same map the Worker builds from D1, so the preview and the published
     page agree on which names are real characters. */
  function loadCharLinks() {
    if (!window.WikiRender) return Promise.resolve({});
    return fetch('characters.json?fields=card')
      .then(function (r) { return r.json(); })
      .then(function (list) {
        var map = {};
        var norm = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); };
        // render-wiki builds `c/{value}`, so the value is the character's
        // ADDRESS (page, minus its own c/ prefix) rather than its identity.
        var addr = function (c) {
          return c.page ? String(c.page).replace(/^\//, '').replace(/^c\//, '').replace(/\.html$/, '') : c.slug;
        };
        (list || []).forEach(function (c) {
          if (c.slug) map[norm(c.slug)] = addr(c);
          if (c.name) map[norm(c.name)] = addr(c);
        });
        window.WikiRender.setCharLinks(map);
        return map;
      })
      .catch(function () { return {}; });
  }

  /* ── image picker: reads a file, downscales it, hands back a data URL ── */
  function imageInput(opts) {
    var input = document.getElementById(opts.input);
    if (!input) return;
    input.addEventListener('change', function (e) {
      var f = e.target.files[0];
      if (!f) return;
      var rd = new FileReader();
      rd.onload = function (ev) {
        var img = new Image();
        img.onload = function () {
          var w = img.width, h = img.height, maxW = opts.maxWidth || 1200;
          if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
          var cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          cv.getContext('2d').drawImage(img, 0, 0, w, h);
          var dataURL = cv.toDataURL('image/png');
          var pv = opts.preview && document.getElementById(opts.preview);
          if (pv) { pv.src = dataURL; pv.style.display = 'block'; }
          var note = opts.note && document.getElementById(opts.note);
          if (note) note.textContent = 'New image ready — it uploads when you save.';
          opts.onReady(dataURL);
        };
        img.src = ev.target.result;
      };
      rd.readAsDataURL(f);
    });
  }

  window.WikiEditor = {
    toolbar: toolbar, boxes: boxes, infobox: infobox,
    autoGrow: autoGrow, loadCharLinks: loadCharLinks, imageInput: imageInput
  };
})();
