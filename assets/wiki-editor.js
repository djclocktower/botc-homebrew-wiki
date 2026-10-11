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
     WikiEditor.splitPreview(editor, preview)   form and preview side by side
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
    { label: 'Quote', icon: 'quote', title: 'Quote', line: '> ' },
    { label: 'Link', title: 'Link', template: '[label](https://example.com)', select: [1, 6] },
    { label: 'Character', title: 'Link to a character on this wiki', template: '[[Character Name]]', select: [2, 16] },
    { label: 'Image', title: 'Image (add |left, |right, |center or |wide to place it, and |300, |50% or |small/|medium/|large to size it)', template: '![caption](pages/my-image.png|right)', select: [2, 9] },
    { label: 'Table', title: 'Table', block: '| Column | Column |\n| --- | --- |\n| value | value |' },
    { label: 'Note', title: 'Callout box (note / tip / warning / example / lore)', block: '::: note Title\nText inside the box.\n:::' },
    /* The drop cap takes the FIRST LETTER of the paragraph, so it wraps the
       selection the way bold does — select the T, press the button. The
       character editors have no toolbar (they never load this file), so
       there it is documented in the .fmt-help callout instead. */
    { label: 'Drop cap', title: 'Big almanac initial (select the first letter of a paragraph)', wrap: ['{{drop|', '}}'] },
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
      var btn = el('button', 'we-btn' + (b.cls ? ' ' + b.cls : ''), b.icon ? null : b.label);
      if (b.icon) {
        btn.innerHTML = '<span class="ico ico-' + b.icon + '" aria-hidden="true"></span>';
        btn.setAttribute('aria-label', b.title);
      }
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
      var del = el('button', 'we-box-del');
      del.innerHTML = '<span class="ico ico-x" aria-hidden="true"></span>';
      del.type = 'button';
      del.title = 'Remove this box';
      del.setAttribute('aria-label', 'Remove this box');
      head.appendChild(t); head.appendChild(del);
      var c = el('textarea', 'we-box-content');
      c.placeholder = 'Box contents… (same formatting as the page body)';
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
      var del = el('button', 'we-box-del');
      del.innerHTML = '<span class="ico ico-x" aria-hidden="true"></span>';
      del.type = 'button'; del.title = 'Remove this row';
      del.setAttribute('aria-label', 'Remove this row');
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

  /* ── the form and its preview, side by side ──
     Asked for because writing a long article meant scrolling down to the
     preview after every change and back up to the box. On a wide screen the
     form takes the left column and the preview the right, sticky and
     scrolling on its own, the way the character editors have it. A phone
     has no room for two columns, so there the preview stays where it was at
     the bottom of the form AND a floating Preview button opens it over the
     form; closing it puts you back exactly where you were typing.
     Nodes are moved, never re-created, so every id and listener survives. */
  function splitPreview(editor, preview) {
    if (!editor || !preview || editor.querySelector('.we-split')) return;
    var split = el('div', 'we-split');
    var form = el('div', 'we-split-form');
    var side = el('div', 'we-split-side');
    while (editor.firstChild) {
      var n = editor.firstChild;
      (n === preview ? side : form).appendChild(n);
    }
    var close = el('button', 'sb-btn sb-btn-import we-split-close', 'Back to editing');
    close.type = 'button';
    side.insertBefore(close, side.firstChild);
    split.appendChild(form);
    split.appendChild(side);
    editor.appendChild(split);

    var fab = el('button', 'sb-btn sb-btn-clear we-split-fab', 'Preview');
    fab.type = 'button';
    fab.setAttribute('aria-expanded', 'false');
    editor.appendChild(fab);

    var main = editor.closest && editor.closest('main');
    if (main) main.classList.add('we-wide');

    var prevOverflow = '';
    function setOpen(on) {
      if (side.classList.contains('open') === on) return;
      side.classList.toggle('open', on);
      fab.setAttribute('aria-expanded', on ? 'true' : 'false');
      if (on) {
        prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        side.scrollTop = 0;
        close.focus();
      } else {
        document.body.style.overflow = prevOverflow;
        fab.focus();
      }
    }
    fab.addEventListener('click', function () { setOpen(true); });
    close.addEventListener('click', function () { setOpen(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && side.classList.contains('open')) setOpen(false);
    });
    // Widening the window past the breakpoint with the sheet open must not
    // leave the page unable to scroll.
    if (window.matchMedia) {
      var wide = window.matchMedia('(min-width: 1100px)');
      var onWide = function () { if (wide.matches) setOpen(false); };
      if (wide.addEventListener) wide.addEventListener('change', onWide);
      else if (wide.addListener) wide.addListener(onWide);
    }
  }

  /* ── [[Character Name]] links in the preview ──
     Same two registries the Worker sets for the published page (see
     setWikiTextRegistries), so the preview and the page agree: the official
     roster first, then this wiki's characters. Without the roster the preview
     sent [[Nightwatchman]] to a homebrew Nightwatchman while the published
     page sent it to the official wiki. */
  function loadCharLinks() {
    if (!window.WikiRender) return Promise.resolve({});
    var roles = fetch('assets/roles.json')
      .then(function (r) { return r.json(); })
      .then(function (list) {
        var names = {};
        (list || []).forEach(function (r) {
          if (!r || !r.name) return;
          if (r.id) names[r.id] = r.name;
          names[r.name] = r.name;
        });
        window.WikiRender.setOfficialNames(names);
      })
      .catch(function () {});
    var chars = fetch('characters.json?fields=card')
      .then(function (r) { return r.json(); })
      .then(function (list) {
        var map = {};
        // The engine's own key (render-wiki.js), so both sides agree.
        var norm = window.WikiRender.linkKey;
        // render-wiki builds `c/{value}`, so the value is the character's
        // ADDRESS (page, minus its own c/ prefix) rather than its identity.
        var addr = function (c) {
          return c.page ? String(c.page).replace(/^\//, '').replace(/^c\//, '').replace(/\.html$/, '') : c.slug;
        };
        (list || []).forEach(function (c) {
          if (norm(c.slug)) map[norm(c.slug)] = addr(c);
          if (norm(c.name)) map[norm(c.name)] = addr(c);
        });
        window.WikiRender.setCharLinks(map);
        return map;
      })
      .catch(function () { return {}; });
    return Promise.all([chars, roles]).then(function (r) { return r[0]; });
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
          if (note) note.textContent = 'New image ready. It uploads when you save.';
          opts.onReady(dataURL);
        };
        img.src = ev.target.result;
      };
      rd.readAsDataURL(f);
    });
  }

  window.WikiEditor = {
    toolbar: toolbar, boxes: boxes, infobox: infobox,
    autoGrow: autoGrow, loadCharLinks: loadCharLinks, imageInput: imageInput,
    splitPreview: splitPreview
  };
})();
