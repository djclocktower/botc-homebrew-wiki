/* Images on a message — the one picker, shared by every place a person can
   attach one.

   Two conversations on this wiki take images: the comment section
   (assets/comments.js) and modmail (the contact form on /account and the
   inbox on /dashboard). They are three different pages with three different
   layouts, so this file owns the ONE thing they must agree on: what an
   attachment is, how it gets to R2, and what the caller hands back to the
   API.

   Why it uploads on pick rather than on send
   ------------------------------------------
   The API stores a LIST OF PATHS, not bytes — so the image has to be in R2
   before the comment is posted. Uploading at send time would mean a comment
   that fails halfway with the text already gone from the box, on a connection
   that is usually a phone. Uploading on pick means the slow part happens
   while the person is still typing, the thumbnail is proof it worked, and
   posting is one small JSON request whichever way it goes.

   The key is minted by the Worker (/api/attachment), never here — see
   ATTACH_PREFIX in worker.js for why.

   Usage:
     var att = mountAttach(hostElement, { max: 4 });
     att.paths()   -> ['/assets/attachments/…', …]  what to post
     att.busy()    -> true while an upload is still running
     att.clear()   -> after a successful post
     att.count()   -> how many are attached

   The host element is emptied and owned by the widget. */
(function () {
  'use strict';

  var MAX = 4;
  var MAX_BYTES = 5 * 1024 * 1024;
  var ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* A file picked on a phone is routinely 4000px wide and several megabytes,
     and it is going to be shown at a few hundred pixels. Shrinking it here
     costs one canvas draw and saves the upload — which is the slow, flaky
     part on mobile data — so it is done before anything is sent. GIFs are
     passed through untouched: a canvas would keep the first frame and throw
     away the animation, which is usually the whole point of the image. */
  var MAX_EDGE = 1600;
  function shrink(file) {
    return new Promise(function (resolve) {
      if (file.type === 'image/gif' || typeof createImageBitmap !== 'function') {
        return resolve(null);
      }
      createImageBitmap(file).then(function (bmp) {
        var scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
        if (scale >= 1 && file.size <= 1024 * 1024) { bmp.close && bmp.close(); return resolve(null); }
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(bmp.width * scale));
        c.height = Math.max(1, Math.round(bmp.height * scale));
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
        if (bmp.close) bmp.close();
        // PNG keeps transparency, which a screenshot of the wiki's own UI
        // often has; everything else is far smaller as JPEG.
        var type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        resolve(c.toDataURL(type, 0.85));
      }).catch(function () { resolve(null); });
    });
  }

  function readAsDataURL(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || '')); };
      fr.onerror = function () { reject(new Error('That file could not be read.')); };
      fr.readAsDataURL(file);
    });
  }

  function upload(dataUrl) {
    return fetch('/api/attachment', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: dataUrl })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok || d.error) throw new Error(d.error || 'Upload failed.');
        return d.path;
      });
    });
  }

  function mountAttach(host, opts) {
    if (!host) return null;
    opts = opts || {};
    var max = Math.max(1, Math.min(MAX, opts.max || MAX));
    var items = [];       // {path} — only successful uploads live here
    var pending = 0;

    host.classList.add('att-box');
    host.innerHTML =
      '<div class="att-strip" hidden></div>' +
      '<div class="att-bar">' +
        '<button type="button" class="att-add">' + esc(opts.label || 'Add image') + '</button>' +
        '<span class="att-note"></span>' +
      '</div>' +
      '<input type="file" class="att-file" accept="' + ACCEPT + '" multiple hidden>';

    var strip = host.querySelector('.att-strip');
    var addBtn = host.querySelector('.att-add');
    var note = host.querySelector('.att-note');
    var input = host.querySelector('.att-file');

    function say(msg, bad) {
      note.textContent = msg || '';
      note.className = 'att-note' + (bad ? ' att-note-bad' : '');
    }

    function paint() {
      strip.hidden = !items.length && !pending;
      strip.innerHTML = items.map(function (it, i) {
        return '<span class="att-thumb">' +
          '<img src="' + esc(it.path) + '" alt="" loading="lazy" decoding="async">' +
          '<button type="button" class="att-drop" data-drop="' + i + '" ' +
            'aria-label="Remove this image">&times;</button>' +
        '</span>';
      }).join('') + (pending
        ? '<span class="att-thumb att-thumb-wait" aria-label="Uploading">…</span>'.repeat(pending)
        : '');
      addBtn.disabled = (items.length + pending) >= max;
      strip.querySelectorAll('[data-drop]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          items.splice(parseInt(btn.getAttribute('data-drop'), 10), 1);
          say('');
          paint();
        });
      });
    }

    function take(files) {
      var room = max - items.length - pending;
      if (room <= 0) { say('That is the most images one message can carry.', true); return; }
      var list = Array.prototype.slice.call(files, 0, room);
      if (files.length > room) say('Only ' + max + ' images per message — the rest were skipped.', true);
      list.forEach(function (file) {
        if (!/^image\//.test(file.type)) { say('Only images can be attached.', true); return; }
        if (file.size > MAX_BYTES * 4) { say('That image is far too large (5 MB max).', true); return; }
        pending++;
        paint();
        shrink(file)
          .then(function (small) { return small || readAsDataURL(file); })
          .then(upload)
          .then(function (p) {
            pending--;
            items.push({ path: p });
            paint();
          })
          .catch(function (err) {
            pending--;
            say((err && err.message) || 'Upload failed.', true);
            paint();
          });
      });
    }

    addBtn.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () {
      take(input.files);
      input.value = '';   // picking the same file twice must still fire
    });

    // Pasting a screenshot is how most people will actually use this.
    if (opts.pasteTarget) {
      opts.pasteTarget.addEventListener('paste', function (e) {
        var files = (e.clipboardData && e.clipboardData.files) || [];
        if (!files.length) return;
        e.preventDefault();
        take(files);
      });
    }

    paint();

    return {
      paths: function () { return items.map(function (i) { return i.path; }); },
      count: function () { return items.length; },
      busy: function () { return pending > 0; },
      clear: function () { items = []; pending = 0; say(''); paint(); },
      element: host
    };
  }

  /* The reading half: the gallery under a comment or a message. Every path
     has already been whitelisted server-side (sanitizeAttachments), so this
     is a plain attribute copy — but it is escaped anyway, because a renderer
     that trusts its input is one schema change away from not being able to.
     The image links to itself: a full-size look is a new tab, not a lightbox
     nobody can close on a phone. */
  function attachmentsHTML(list) {
    if (!list || !list.length) return '';
    return '<div class="att-shots">' + list.map(function (p) {
      var src = esc(p);
      return '<a class="att-shot" href="' + src + '" target="_blank" rel="noopener">' +
        '<img src="' + src + '" alt="Attached image" loading="lazy" decoding="async">' +
      '</a>';
    }).join('') + '</div>';
  }

  window.mountAttach = mountAttach;
  window.attachmentsHTML = attachmentsHTML;
})();
