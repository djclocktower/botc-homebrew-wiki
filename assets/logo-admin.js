/* The "Wiki logo" card on the admin dashboard: every version of the logo,
   which one is in use, and a form that adds one.

   The logo is drawn in six sizes (see "The wiki logo" in CLAUDE.md), and an
   admin uploads ONE picture. The six are made here, in the browser, because
   the Worker has no image encoder: the picture is trimmed to its drawing and
   fitted into each size's frame (SIZES), so a new logo sits exactly where the
   old one did on every page. The lettering beside the skull is a second,
   optional picture; a version without one keeps the Classic lettering.

   LogoAdmin.mount(element) draws the card. LogoAdmin.make(file, wordFile)
   resolves with {slot: data URL} and is what the form posts to
   /api/admin/logo. Browser only (canvas + DOM). Styles are .lg-* in
   dashboard.html. */
(function () {
  'use strict';

  var FILE = { mark: 'mark.webp', hero: 'hero.webp', wordmark: 'wordmark.png', favicon: 'favicon.png', icon: 'icon.png', og: 'og.png' };

  /* Each size: the most room the drawing may take (w, h), and either a fixed
     canvas it is centred on (frame) or a canvas cut to the drawing. `webp`
     sizes fall back to PNG in a browser that cannot encode WebP; the three
     that leave the site (browser tab, exported JSON, link preview) are PNG.
       mark     the top bar, drawn up to 54px tall: 3x that.
       hero     the homepage title, on the 265:330 frame its <img> declares.
       favicon  the browser tab, and the stand-in for a missing picture.
       icon     the credits Fabled in an exported script: the figure at 60%
                of a square, like every character icon (ART_FILL).
       og       link previews. */
  var SIZES = {
    mark:    { w: 203, h: 162, webp: true },
    hero:    { w: 506, h: 636, frame: [530, 660], webp: true },
    favicon: { w: 64, h: 64, frame: [64, 64] },
    icon:    { w: 192, h: 192, frame: [320, 320] },
    og:      { w: 400, h: 400 }
  };
  var WORDMARK = { w: 528, h: 132, webp: true };
  var SOURCE_MAX = 4096;   // px; a phone's canvas gives up not far past this

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function readPicture(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var scale = Math.min(1, SOURCE_MAX / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * scale));
        c.height = Math.max(1, Math.round(img.naturalHeight * scale));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('That picture could not be read.')); };
      img.src = url;
    });
  }

  // The drawing without its transparent margin. A picture with no
  // transparency at all comes back whole.
  function trimmed(c) {
    var w = c.width, h = c.height;
    var data = c.getContext('2d').getImageData(0, 0, w, h).data;
    var x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] > 8) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) throw new Error('That picture is empty.');
    var out = document.createElement('canvas');
    out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
    out.getContext('2d').drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    return out;
  }

  // Halved until it is within twice the target, then drawn once: one big
  // step down drops detail a logo at 64px cannot spare.
  function scaled(src, w, h) {
    var cur = src;
    while (cur.width > w * 2 && cur.height > h * 2) {
      var half = document.createElement('canvas');
      half.width = Math.ceil(cur.width / 2); half.height = Math.ceil(cur.height / 2);
      var hx = half.getContext('2d');
      hx.imageSmoothingQuality = 'high';
      hx.drawImage(cur, 0, 0, half.width, half.height);
      cur = half;
    }
    var out = document.createElement('canvas');
    out.width = w; out.height = h;
    var ox = out.getContext('2d');
    ox.imageSmoothingQuality = 'high';
    ox.drawImage(cur, 0, 0, w, h);
    return out;
  }

  function encode(c, webp) {
    if (webp) {
      var url = c.toDataURL('image/webp', 0.9);
      if (url.indexOf('data:image/webp') === 0) return url;
    }
    return c.toDataURL('image/png');
  }

  function fitted(src, size) {
    var k = Math.min(size.w / src.width, size.h / src.height);
    var w = Math.max(1, Math.round(src.width * k)), h = Math.max(1, Math.round(src.height * k));
    var drawn = scaled(src, w, h);
    if (!size.frame) return encode(drawn, size.webp);
    var c = document.createElement('canvas');
    c.width = size.frame[0]; c.height = size.frame[1];
    c.getContext('2d').drawImage(drawn, Math.round((c.width - w) / 2), Math.round((c.height - h) / 2));
    return encode(c, size.webp);
  }

  function make(file, wordFile) {
    return readPicture(file).then(function (c) {
      var art = trimmed(c);
      var out = {};
      Object.keys(SIZES).forEach(function (slot) { out[slot] = fitted(art, SIZES[slot]); });
      if (!wordFile) return out;
      return readPicture(wordFile).then(function (w) {
        out.wordmark = fitted(trimmed(w), WORDMARK);
        return out;
      });
    });
  }

  function api(body) {
    return fetch('/api/admin/logo', body ? {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    } : { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, body: d || {} }; }); })
      .catch(function () { return { ok: false, body: { error: 'The wiki could not be reached.' } }; });
  }

  function mount(root) {
    if (!root) return;
    var state = { active: '', versions: [] };
    var made = null;   // the six pictures of the file in the form

    var list = el('div', 'lg-list');
    var form = el('div', 'lg-add');
    var toast = el('div', 'toast');
    root.textContent = '';
    root.appendChild(list); root.appendChild(form); root.appendChild(toast);

    function say(ok, text) { toast.className = 'toast ' + (ok ? 'ok' : 'err'); toast.textContent = text; }

    // The top bar in miniature: the skull and the lettering on the bar's colour.
    function barPreview(markSrc, wordSrc) {
      var bar = el('div', 'lg-bar');
      var mark = el('img', 'lg-mark'); mark.alt = ''; mark.src = markSrc;
      var word = el('img', 'lg-word'); word.alt = ''; word.src = wordSrc;
      bar.appendChild(mark); bar.appendChild(word);
      return bar;
    }

    function tile(v) {
      var id = v ? v.id : 'classic';
      var inUse = state.active === (v ? v.id : '');
      var t = el('div', 'lg-tile' + (inUse ? ' on' : ''));
      t.appendChild(barPreview('/assets/logo/' + id + '/' + FILE.mark, '/assets/logo/' + id + '/' + FILE.wordmark));
      t.appendChild(el('div', 'lg-name', v ? v.name : 'Classic'));
      var acts = el('div', 'lg-acts');
      if (inUse) acts.appendChild(el('span', 'lg-on', 'In use'));
      else {
        var use = el('button', 'small-btn', 'Use'); use.type = 'button';
        use.addEventListener('click', function () {
          use.disabled = true;
          api({ action: 'use', id: v ? v.id : '' }).then(function (res) {
            if (!res.ok) { use.disabled = false; say(false, res.body.error || 'Failed.'); return; }
            state = res.body; draw();
            // This browser first; everybody else's follows from /api/boot.
            if (window.SiteLogo) { window.SiteLogo.seen(state.active); window.SiteLogo.refresh(); }
            say(true, 'In use.');
          });
        });
        acts.appendChild(use);
      }
      if (v) {
        var del = el('button', 'small-btn alt', 'Delete'); del.type = 'button';
        del.addEventListener('click', function () {
          if (!confirm('Delete "' + v.name + '"?')) return;
          del.disabled = true;
          api({ action: 'delete', id: v.id }).then(function (res) {
            if (!res.ok) { del.disabled = false; say(false, res.body.error || 'Failed.'); return; }
            var wasActive = state.active === v.id;
            state = res.body; draw();
            if (wasActive && window.SiteLogo) { window.SiteLogo.seen(state.active); window.SiteLogo.refresh(); }
            say(true, 'Deleted.');
          });
        });
        acts.appendChild(del);
      }
      t.appendChild(acts);
      return t;
    }

    function draw() {
      list.textContent = '';
      list.appendChild(tile(null));
      state.versions.forEach(function (v) { list.appendChild(tile(v)); });
    }

    /* ---- the form ---- */
    function field(label, input) {
      var l = el('label', 'lg-field');
      l.appendChild(el('span', '', label));
      l.appendChild(input);
      return l;
    }
    var name = el('input'); name.type = 'text'; name.maxLength = 40;
    var pic = el('input'); pic.type = 'file'; pic.accept = 'image/png,image/webp';
    var word = el('input'); word.type = 'file'; word.accept = 'image/png,image/webp';
    var preview = el('div', 'lg-preview'); preview.hidden = true;
    var add = el('button', 'small-btn', 'Add'); add.type = 'button'; add.disabled = true;
    form.appendChild(el('div', 'lg-head', 'Add a logo'));
    form.appendChild(field('Name', name));
    form.appendChild(field('Picture (transparent PNG)', pic));
    form.appendChild(field('Lettering (optional)', word));
    form.appendChild(preview);
    form.appendChild(add);

    function remake() {
      made = null; add.disabled = true; preview.hidden = true; preview.textContent = '';
      if (!pic.files || !pic.files[0]) return;
      make(pic.files[0], word.files && word.files[0]).then(function (out) {
        made = out; add.disabled = false; say(true, '');
        preview.appendChild(barPreview(out.mark, out.wordmark || '/assets/logo/classic/' + FILE.wordmark));
        var tab = el('img', 'lg-tab'); tab.alt = ''; tab.src = out.favicon; preview.appendChild(tab);
        var hero = el('img', 'lg-hero'); hero.alt = ''; hero.src = out.hero; preview.appendChild(hero);
        preview.hidden = false;
      }).catch(function (e) { say(false, (e && e.message) || 'That picture could not be read.'); });
    }
    pic.addEventListener('change', remake);
    word.addEventListener('change', remake);

    add.addEventListener('click', function () {
      if (!made) return;
      if (!name.value.trim()) { say(false, 'Give it a name.'); name.focus(); return; }
      add.disabled = true;
      api({ action: 'add', name: name.value.trim(), files: made }).then(function (res) {
        if (!res.ok) { add.disabled = false; say(false, res.body.error || 'Failed.'); return; }
        state = res.body; draw();
        name.value = ''; pic.value = ''; word.value = ''; remake();
        say(true, 'Added.');
      });
    });

    api().then(function (res) {
      if (!res.ok) { say(false, res.body.error || 'Failed.'); return; }
      state = res.body; draw();
    });
  }

  window.LogoAdmin = { mount: mount, make: make, SIZES: SIZES };

  function auto() { mount(document.getElementById('logo-admin')); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', auto);
  else auto();
})();
