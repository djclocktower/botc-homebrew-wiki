/* assets/starlit.js: the Starlit Gallery (/starlit). See "The Starlit
 * Gallery" in CLAUDE.md.
 *
 * An icon is a BLACK layer, filled with the picked texture, over a WHITE one,
 * filled with parchment, with a drop shadow under both. The layers are only
 * masks. compose() does all the drawing; the Worker only stores files.
 * ?icon={id} opens one icon; ?pick=1 is the gallery inside a character
 * editor (assets/starlit-picker.js). Browser only.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var PICK = document.documentElement.classList.contains('sg-pick');
  var FILL = window.ART_FILL || 0.6;
  var TARGET = window.ART_TARGET || 591;
  var LAYER_MAX = 1200;       // longest side a layer is stored at
  var THUMB = 256;            // the grid's picture
  var ARTISTS = 'Harry & Co & Bendan';
  var TEX = '/assets/iconforge/textures/';
  // Icon Forge's sheets, under Icon Forge's ids (assets/iconforge/textures.js),
  // so "Open in Icon Forge" can carry the choice across.
  var BUILT_IN = [
    { id: 'blue', name: 'Good', src: TEX + 'blue.png' },
    { id: 'red', name: 'Evil', src: TEX + 'red.png' },
    { id: 'brown', name: 'Traveller', src: TEX + 'brown.png' },
    { id: 'traveller_split', name: 'Traveller II', src: TEX + 'blue.png', src2: TEX + 'red.png' },
    { id: 'yellow_fibbin', name: 'Fabled', src: TEX + 'yellow_fibbin.png' },
    { id: 'green_pope', name: 'Loric', src: TEX + 'green_pope.png' },
    { id: 'white', name: 'Monochrome', src: TEX + 'white.png' }
  ];
  // What an icon opens in when it names no texture we have: the team's base
  // grey (one of the gallery's own, so found by name), else Good.
  var DEFAULT_TEX_NAME = 'Grey';
  var PARCHMENT = TEX + 'white.png';
  var TOGGLES = ['texture', 'whites', 'blacks', 'shadow'];

  var gallery = { icons: [], textures: [], canUpload: false, isAdmin: false, uploaders: [] };
  var textures = BUILT_IN.slice();   // + the gallery's own, + the reader's
  var own = null;                    // a texture picked from the reader's device
  var filter = { q: '', tag: '' };
  var view = { tex: 'blue', texture: true, whites: true, blacks: true, shadow: true };
  var current = null;                // the icon open in the window
  var previewUrl = null, paintSeq = 0;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fold(s) { return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
  function canvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h == null ? w : h;
    return c;
  }
  function say(id, text, bad) { var el = $(id); el.textContent = text || ''; el.className = 'sg-msg' + (bad ? ' err' : ''); }

  function imageFrom(src) {
    return new Promise(function (resolve, reject) {
      var im = new Image();
      im.onload = function () { resolve(im); };
      im.onerror = function () { reject(new Error('An image did not load. Check your connection and try again.')); };
      im.src = src;
    });
  }
  var images = Object.create(null);
  function loadImg(src) {
    if (!images[src]) images[src] = imageFrom(src).catch(function (e) { delete images[src]; throw e; });
    return images[src];
  }
  function texById(id) {
    for (var i = 0; i < textures.length; i++) if (textures[i].id === id) return textures[i];
    return null;
  }
  function defaultTex() {
    for (var i = 0; i < textures.length; i++) {
      if (textures[i].id.indexOf('starlit-') === 0 && textures[i].name === DEFAULT_TEX_NAME) return textures[i].id;
    }
    return 'blue';
  }
  // Traveller II, as in Icon Forge: one sheet down the left, the other down
  // the right. compose() centres the fill, so the split runs through the icon.
  function splitFill(a, b) {
    var w = a.naturalWidth, h = a.naturalHeight, c = canvas(w, h), x = c.getContext('2d');
    x.drawImage(a, 0, 0, w, h);
    x.drawImage(b, w / 2, 0, w / 2, h, w / 2, 0, w / 2, h);
    return c;
  }
  function texturesFor(id) {
    var t = texById(id) || texById(defaultTex()) || BUILT_IN[0];
    return Promise.all([loadImg(t.src), loadImg(PARCHMENT), t.src2 ? loadImg(t.src2) : null])
      .then(function (r) { return { fill: r[2] ? splitFill(r[0], r[2]) : r[0], parch: r[1] }; });
  }

  /* ── drawing ──────────────────────────────────────────────────── */

  // Where the figure sits on the layers: both drawn on the black layer's
  // frame, trimmed the way every character icon is (artTrimBox).
  function figureBox(black, white) {
    var W = black.naturalWidth || black.width, H = black.naturalHeight || black.height;
    var c = canvas(W, H), x = c.getContext('2d');
    x.drawImage(white, 0, 0, W, H);
    x.drawImage(black, 0, 0, W, H);
    var b = window.artTrimBox ? window.artTrimBox(c) : { x: 0, y: 0, w: W, h: H };
    return { x: b.x, y: b.y, w: b.w, h: b.h, W: W, H: H };
  }
  function layersOf(icon) {
    if (!icon._layers) {
      icon._layers = Promise.all([loadImg(icon.black + '?v=' + icon.v), loadImg(icon.white + '?v=' + icon.v)])
        .then(function (l) { return { black: l[0], white: l[1], box: figureBox(l[0], l[1]) }; })
        .catch(function (e) { icon._layers = null; throw e; });
    }
    return icon._layers;
  }
  function cover(x, img, size) {
    var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    var s = size / Math.min(w, h);
    x.drawImage(img, (size - w * s) / 2, (size - h * s) / 2, w * s, h * s);
  }
  /* The icon at `size` px. `o` says what to show (TOGGLES) and carries the
     loaded textures: `fill` for the black layer, `parch` for the white. With
     the texture off they are plain black and plain white. */
  function compose(L, o, size) {
    var b = L.box, k = size * FILL / Math.max(b.w, b.h, 1);
    var dx = size / 2 - (b.x + b.w / 2) * k, dy = size / 2 - (b.y + b.h / 2) * k;
    function layer(img, fill) {
      var c = canvas(size), x = c.getContext('2d');
      x.imageSmoothingQuality = 'high';
      x.drawImage(img, dx, dy, b.W * k, b.H * k);
      x.globalCompositeOperation = 'source-in';
      if (typeof fill === 'string') { x.fillStyle = fill; x.fillRect(0, 0, size, size); }
      else cover(x, fill, size);
      return c;
    }
    var art = canvas(size), ax = art.getContext('2d');
    if (o.whites) ax.drawImage(layer(L.white, o.texture && o.parch ? o.parch : '#ffffff'), 0, 0);
    if (o.blacks) ax.drawImage(layer(L.black, o.texture && o.fill ? o.fill : '#000000'), 0, 0);
    var out = canvas(size), ctx = out.getContext('2d');
    if (o.shadow) {
      // Icon Forge's default shadow, at any size.
      ctx.shadowColor = 'rgba(0,0,0,0.4)';
      ctx.shadowBlur = size * 0.027;
      ctx.shadowOffsetX = ctx.shadowOffsetY = size * 0.0072;
    }
    ctx.drawImage(art, 0, 0);
    return out;
  }
  function render(icon, size, opts) {
    opts = opts || view;
    return Promise.all([layersOf(icon), texturesFor(opts.tex)]).then(function (r) {
      return compose(r[0], {
        texture: opts.texture, whites: opts.whites, blacks: opts.blacks, shadow: opts.shadow,
        fill: r[1].fill, parch: r[1].parch
      }, size);
    });
  }
  function toBlob(c) {
    return new Promise(function (resolve, reject) {
      c.toBlob(function (b) { if (b) resolve(b); else reject(new Error('The PNG could not be made.')); }, 'image/png');
    });
  }
  function fileName(icon) {
    return (String(icon.name).replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '') || 'icon') + '_Starlit.png';
  }

  /* ── the grid ─────────────────────────────────────────────────── */

  function matches(icon) {
    if (filter.tag && icon.tags.indexOf(filter.tag) < 0) return false;
    var words = fold(filter.q).split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    var hay = fold(icon.name + ' ' + icon.tags.join(' ') + ' ' + icon.artist);
    return words.every(function (w) { return hay.indexOf(w) >= 0; });
  }
  function shown() { return gallery.icons.filter(matches); }
  function byId(id) {
    for (var i = 0; i < gallery.icons.length; i++) if (String(gallery.icons[i].id) === String(id)) return gallery.icons[i];
    return null;
  }
  function drawGrid() {
    var list = shown(), n = gallery.icons.length;
    $('sg-grid').innerHTML = list.map(function (ic) {
      return '<button type="button" class="sg-tile" data-id="' + ic.id + '">' +
        '<img src="' + esc(ic.thumb + '?v=' + ic.v) + '" alt="" loading="lazy" decoding="async">' +
        '<span>' + esc(ic.name) + '</span></button>';
    }).join('');
    $('sg-count').textContent = !n ? 'No icons yet.'
      : list.length === n ? n + (n === 1 ? ' icon' : ' icons')
      : list.length + ' of ' + n + ' icons';
    $('sg-random').disabled = !list.length;
  }
  // The most used keywords as chips; the search box finds the rest.
  function drawTags() {
    var count = Object.create(null);
    gallery.icons.forEach(function (ic) { ic.tags.forEach(function (t) { count[t] = (count[t] || 0) + 1; }); });
    var tags = Object.keys(count).sort(function (a, b) { return count[b] - count[a] || a.localeCompare(b); }).slice(0, 30);
    if (filter.tag && tags.indexOf(filter.tag) < 0) tags.unshift(filter.tag);
    $('sg-tags').innerHTML = tags.map(function (t) {
      return '<button type="button" class="sg-chip" data-tag="' + esc(t) + '" aria-pressed="' + (t === filter.tag) + '">' +
        esc(t) + '<small>' + (count[t] || 0) + '</small></button>';
    }).join('');
  }
  function setTag(t) {
    filter.tag = filter.tag === t ? '' : t;
    drawTags(); drawGrid();
  }

  $('sg-search').addEventListener('input', function () { filter.q = this.value; drawGrid(); });
  $('sg-tags').addEventListener('click', function (e) {
    var b = e.target.closest('[data-tag]');
    if (b) setTag(b.getAttribute('data-tag'));
  });
  $('sg-grid').addEventListener('click', function (e) {
    var b = e.target.closest('[data-id]');
    if (b) openIcon(byId(b.getAttribute('data-id')));
  });
  $('sg-random').addEventListener('click', function () {
    var list = shown();
    if (list.length) openIcon(list[Math.floor(Math.random() * list.length)]);
  });

  /* ── windows ──────────────────────────────────────────────────── */

  function show(id, on) {
    $(id).hidden = !on;
    var open = !$('sg-detail').hidden || !$('sg-form-modal').hidden;
    document.documentElement.style.overflow = open ? 'hidden' : '';
  }
  function setUrlIcon(id) {
    try {
      var u = new URL(location.href);
      if (id) u.searchParams.set('icon', id); else u.searchParams.delete('icon');
      history.replaceState(history.state, '', u.pathname + u.search + u.hash);
    } catch (e) { /* the address just stays as it was */ }
  }
  ['sg-detail', 'sg-form-modal'].forEach(function (id) {
    $(id).addEventListener('click', function (e) { if (e.target === this) closeWindow(id); });
  });
  function closeWindow(id) {
    show(id, false);
    if (id === 'sg-detail') { current = null; setUrlIcon(null); }
  }
  $('sg-d-close').addEventListener('click', function () { closeWindow('sg-detail'); });
  $('sg-f-close').addEventListener('click', function () { closeWindow('sg-form-modal'); });
  $('sg-f-cancel').addEventListener('click', function () { closeWindow('sg-form-modal'); });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!$('sg-form-modal').hidden) closeWindow('sg-form-modal');
    else if (!$('sg-detail').hidden) closeWindow('sg-detail');
  });

  /* ── one icon ─────────────────────────────────────────────────── */

  function creditHTML(icon) {
    var who = icon.artist || ARTISTS;
    var names = window.splitCreators ? window.splitCreators(who) : [who];
    var target = PICK ? ' target="_blank" rel="noopener"' : '';
    return 'Art by ' + names.map(function (n) {
      var mark = window.CreatorSymbols ? window.CreatorSymbols.markHTMLFor(n) : '';
      return '<a href="author?a=' + encodeURIComponent(n) + '"' + target + '>' + esc(n) + '</a>' + (mark ? ' ' + mark : '');
    }).join(', ') + ', from the Starlit Gallery';
  }
  function openIcon(icon) {
    if (!icon) return;
    current = icon;
    view.tex = texById(icon.tex) ? icon.tex : defaultTex();
    $('sg-d-name').textContent = icon.name;
    $('sg-d-credit').innerHTML = creditHTML(icon);
    $('sg-d-tags').innerHTML = icon.tags.map(function (t) {
      return '<button type="button" class="sg-chip" data-tag="' + esc(t) + '">' + esc(t) + '</button>';
    }).join('');
    $('sg-d-img').removeAttribute('src');
    $('sg-manage').hidden = !gallery.canUpload || PICK;
    say('sg-d-msg', '');
    drawTexs();
    TOGGLES.forEach(function (k) { $('sg-o-' + k).checked = view[k]; });
    show('sg-detail', true);
    setUrlIcon(icon.id);
    say('sg-save-msg', '');
    loadMyChars();
    paint();
  }
  function paint() {
    if (!current) return;
    var icon = current, seq = ++paintSeq;
    render(icon, TARGET).then(toBlob).then(function (blob) {
      if (seq !== paintSeq) return;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(blob);
      $('sg-d-img').src = previewUrl;
      $('sg-d-img').alt = icon.name;
    }).catch(function (e) { if (seq === paintSeq) say('sg-d-msg', e.message, true); });
  }

  function rebuildTextures() {
    textures = BUILT_IN.concat(gallery.textures.map(function (t) {
      return { id: 'starlit-' + t.id, name: t.name, src: t.image + '?v=' + t.v };
    }), own ? [own] : []);
  }
  function drawTexs() {
    $('sg-texs').innerHTML = textures.map(function (t) {
      return '<button type="button" class="sg-tex" data-tex="' + esc(t.id) + '" aria-pressed="' + (t.id === view.tex) + '" title="' + esc(t.name) + '">' +
        (t.src2 ? '<span class="sg-tex-split"><img src="' + esc(t.src) + '" alt=""><img src="' + esc(t.src2) + '" alt=""></span>'
          : '<img src="' + esc(t.src) + '" alt="" decoding="async">') + '<b>' + esc(t.name) + '</b></button>';
    }).join('') +
      '<button type="button" class="sg-tex sg-tex-own" data-own="1" title="Use a texture from your device"><i aria-hidden="true">+</i><b>Your own</b></button>';
  }
  $('sg-texs').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-own')) { $('sg-own-tex').click(); return; }
    view.tex = b.getAttribute('data-tex');
    drawTexs(); paint();
  });
  // A texture from the reader's own device: used here and nowhere else.
  $('sg-own-tex').addEventListener('change', function () {
    var f = this.files && this.files[0];
    this.value = '';
    if (!f) return;
    if (own) { URL.revokeObjectURL(own.src); delete images[own.src]; }
    own = { id: 'own', name: 'Yours', src: URL.createObjectURL(f) };
    rebuildTextures();
    view.tex = 'own';
    drawTexs(); paint();
  });
  TOGGLES.forEach(function (k) {
    $('sg-o-' + k).addEventListener('change', function () { view[k] = this.checked; paint(); });
  });
  $('sg-d-tags').addEventListener('click', function (e) {
    var b = e.target.closest('[data-tag]');
    if (!b) return;
    closeWindow('sg-detail');
    filter.tag = '';
    setTag(b.getAttribute('data-tag'));
    $('sg-search').scrollIntoView({ block: 'center' });
  });

  $('sg-download').addEventListener('click', function () {
    if (!current) return;
    var icon = current, btn = this;
    btn.disabled = true;
    render(icon, parseInt($('sg-size').value, 10) || TARGET).then(toBlob).then(function (blob) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fileName(icon);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
    }).catch(function (e) { say('sg-d-msg', e.message, true); })
      .then(function () { btn.disabled = false; });
  });

  /* Icon Forge takes one picture: the layers are flattened, plain black over
     plain white, and left in localStorage for iconforge?from=starlit
     (assets/iconforge/app.js), with the texture to open on. */
  $('sg-forge').addEventListener('click', function () {
    if (!current) return;
    var icon = current;
    render(icon, TARGET * 2, { tex: view.tex, texture: false, whites: view.whites, blacks: view.blacks, shadow: false })
      .then(function (c) {
        localStorage.setItem('botc_starlit_forge', JSON.stringify({
          name: icon.name, png: c.toDataURL('image/png'), tex: view.tex === 'own' ? '' : view.tex
        }));
        location.href = 'iconforge?from=starlit';
      })
      .catch(function (e) { say('sg-d-msg', 'Could not open it in Icon Forge: ' + e.message, true); });
  });

  // Inside a character editor: hand the icon back (assets/starlit-picker.js).
  $('sg-use').addEventListener('click', function () {
    if (!current) return;
    var icon = current, btn = this;
    btn.disabled = true;
    render(icon, TARGET).then(toBlob).then(function (blob) {
      window.parent.postMessage({
        starlit: 'pick', id: icon.id, name: icon.name, artist: icon.artist || ARTISTS, blob: blob
      }, location.origin);
    }).catch(function (e) { say('sg-d-msg', e.message, true); })
      .then(function () { btn.disabled = false; });
  });

  /* ── save straight onto one of your characters (drafts too) ───── */
  // assets/char-icon-save.js does the work, shared with Icon Forge.

  var myChars = null;   // asked once, on the first icon opened
  function loadMyChars() {
    if (myChars || PICK || !window.CharIconSave) return;
    myChars = window.CharIconSave.list().then(function (list) {
      $('sg-save').hidden = false;
      if (!list) {
        $('sg-save-msg').innerHTML = '<a href="login?next=' + encodeURIComponent('starlit' + location.search) + '">Sign in</a> to save it straight onto one of your characters.';
        return;
      }
      if (!list.length) {
        $('sg-save-msg').innerHTML = 'You have no characters yet. Start one in the <a href="create">character editor</a>.';
        return;
      }
      list.sort(function (a, b) { return a.name.localeCompare(b.name); });
      $('sg-save-pick').innerHTML = '<option value="">Choose a character…</option>' + list.map(function (c) {
        return '<option value="' + esc(c.slug) + '">' + esc(c.name) + (c.status === 'draft' ? ' (draft)' : '') + '</option>';
      }).join('');
      $('sg-save-row').hidden = false;
    }).catch(function () { myChars = null; });
  }
  $('sg-save-pick').addEventListener('change', function () { $('sg-save-go').disabled = !this.value; });
  $('sg-save-go').addEventListener('click', function () {
    var pick = $('sg-save-pick'), slug = pick.value, icon = current, btn = this;
    if (!slug || !icon) return;
    var name = pick.options[pick.selectedIndex].text.replace(/ \(draft\)$/, '');
    btn.disabled = true;
    say('sg-save-msg', 'Saving…');
    render(icon, TARGET).then(function (c) {
      return window.CharIconSave.save(slug, c.toDataURL('image/png'), {
        iconBy: String(icon.artist || ARTISTS).replace(/[[\]()]/g, '').trim() +
          ' ([Starlit Gallery](/starlit?icon=' + encodeURIComponent(icon.id) + '))',
        confirmReplace: function (n) { return window.confirm('Replace the icon on ' + n + '?'); }
      });
    }).then(function (saved) {
      if (!saved) { say('sg-save-msg', ''); return; }
      $('sg-save-msg').className = 'sg-msg';
      $('sg-save-msg').innerHTML = 'Saved to <a href="c/' + encodeURIComponent(saved) + '">' + esc(name) + '</a>.';
    }).catch(function (e) { say('sg-save-msg', e.message, true); })
      .then(function () { btn.disabled = !pick.value; });
  });

  /* ── the gallery team ─────────────────────────────────────────── */

  function api(body, path) {
    return fetch(path || '/api/starlit', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || j.error) throw new Error(j.error || 'The wiki could not save that (' + r.status + ').');
        return j;
      });
    });
  }
  function byName(a, b) { return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id - b.id; }
  function readDataURL(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result)); };
      r.onerror = function () { reject(new Error('That file could not be read.')); };
      r.readAsDataURL(file);
    });
  }

  function drawTeam() {
    $('sg-team').hidden = !gallery.canUpload || PICK;
    $('sg-admin').hidden = !gallery.isAdmin;
    $('sg-tex-list').innerHTML = gallery.textures.length ? gallery.textures.map(function (t) {
      return '<li><img src="' + esc(t.image + '?v=' + t.v) + '" alt=""><span>' + esc(t.name) + '</span>' +
        '<button type="button" class="sg-link-btn" data-del="' + t.id + '">Delete</button></li>';
    }).join('') : '<li>None yet.</li>';
    if (gallery.isAdmin) {
      $('sg-up-names').value = gallery.uploaders.map(function (u) { return u.username; }).join(', ');
    }
  }

  $('sg-t-add').addEventListener('click', function () {
    var name = $('sg-t-name').value.trim(), file = $('sg-t-file').files[0], btn = this;
    if (!name || !file) { say('sg-t-msg', 'Give the texture a name and pick its image.', true); return; }
    if (file.size > 4 * 1024 * 1024) { say('sg-t-msg', 'That image is over 4 MB.', true); return; }
    btn.disabled = true;
    say('sg-t-msg', 'Uploading…');
    readDataURL(file).then(function (data) { return api({ action: 'texture', name: name, image: data }); })
      .then(function (r) {
        gallery.textures.push(r.texture);
        gallery.textures.sort(byName);
        rebuildTextures(); drawTeam();
        $('sg-t-name').value = ''; $('sg-t-file').value = '';
        say('sg-t-msg', 'Added to the texture picker.');
      })
      .catch(function (e) { say('sg-t-msg', e.message, true); })
      .then(function () { btn.disabled = false; });
  });
  $('sg-tex-list').addEventListener('click', function (e) {
    var b = e.target.closest('[data-del]');
    if (!b) return;
    var id = Number(b.getAttribute('data-del'));
    var t = gallery.textures.filter(function (x) { return x.id === id; })[0];
    if (!t || !confirm('Delete the texture "' + t.name + '"? Icons shown in it will open in Good instead.')) return;
    api({ action: 'delete-texture', id: id }).then(function () {
      gallery.textures = gallery.textures.filter(function (x) { return x.id !== id; });
      rebuildTextures(); drawTeam();
      say('sg-t-msg', 'Deleted.');
    }).catch(function (e2) { say('sg-t-msg', e2.message, true); });
  });

  $('sg-up-save').addEventListener('click', function () {
    var names = $('sg-up-names').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var btn = this;
    btn.disabled = true;
    api({ names: names }, '/api/admin/starlit-uploaders').then(function (r) {
      gallery.uploaders = r.uploaders || [];
      drawTeam();
      var who = gallery.uploaders.map(function (u) { return '@' + u.username; }).join(', ');
      say('sg-up-msg', (who ? 'Saved. ' + who + (gallery.uploaders.length === 1 ? ' can' : ' can all') + ' upload.' : 'Saved. Only admins can upload.') +
        (r.unknown && r.unknown.length ? ' No account is called ' + r.unknown.join(', ') + '.' : ''),
        !!(r.unknown && r.unknown.length));
    }).catch(function (e) { say('sg-up-msg', e.message, true); })
      .then(function () { btn.disabled = false; });
  });

  /* The form: a new icon, or changes to one. A picked layer is redrawn onto a
     canvas no larger than LAYER_MAX and stored as a PNG, whatever it came in
     as; an edit sends only the layers it replaces, and a fresh grid picture
     whenever the look changed. */
  var form = { icon: null, black: null, white: null, blackData: null, whiteData: null, L: null };

  function readLayer(file) {
    var url = URL.createObjectURL(file);
    return imageFrom(url).then(function (im) {
      var w = im.naturalWidth, h = im.naturalHeight, k = Math.min(1, LAYER_MAX / Math.max(w, h));
      var c = canvas(Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)));
      var x = c.getContext('2d');
      x.imageSmoothingQuality = 'high';
      x.drawImage(im, 0, 0, c.width, c.height);
      var data = c.toDataURL('image/png');
      return imageFrom(data).then(function (img) { return { img: img, data: data }; });
    }, function () {
      throw new Error('That file could not be read as an image. Use a PNG with a transparent background.');
    }).then(function (r) { URL.revokeObjectURL(url); return r; }, function (e) { URL.revokeObjectURL(url); throw e; });
  }
  function formLayers() {
    if (!form.L) form.L = { black: form.black, white: form.white, box: figureBox(form.black, form.white) };
    return form.L;
  }
  // A layer exported trimmed to its own drawing has lost where it sat on the
  // canvas, and stretched over the other one the outline slips out of line.
  var SIZES_DIFFER = 'The two layers are different sizes, so they will not line up. Export both at the full canvas size, not trimmed.';
  function layersDiffer() {
    return form.black.naturalWidth !== form.white.naturalWidth || form.black.naturalHeight !== form.white.naturalHeight;
  }
  function formPreview() {
    var c = $('sg-f-preview'), x = c.getContext('2d');
    x.clearRect(0, 0, c.width, c.height);
    if (!form.black || !form.white) return Promise.resolve();
    if (layersDiffer()) say('sg-f-msg', SIZES_DIFFER, true);
    var L = formLayers();
    return texturesFor($('sg-f-tex').value).then(function (t) {
      x.clearRect(0, 0, c.width, c.height);
      x.drawImage(compose(L, { texture: true, whites: true, blacks: true, shadow: true, fill: t.fill, parch: t.parch }, c.width), 0, 0);
    }).catch(function (e) { say('sg-f-msg', e.message, true); });
  }
  function openForm(icon) {
    form = { icon: icon || null, black: null, white: null, blackData: null, whiteData: null, L: null };
    $('sg-f-title').textContent = icon ? 'Edit ' + icon.name : 'Add an icon';
    $('sg-f-name').value = icon ? icon.name : '';
    $('sg-f-tags').value = icon ? icon.tags.join(', ') : '';
    var last = '';
    try { last = localStorage.getItem('botc_starlit_artist') || ''; } catch (e) { /* none */ }
    $('sg-f-artist').value = icon ? icon.artist : last;
    $('sg-f-black').value = ''; $('sg-f-white').value = '';
    $('sg-f-tex').innerHTML = textures.filter(function (t) { return t.id !== 'own'; }).map(function (t) {
      return '<option value="' + esc(t.id) + '">' + esc(t.name) + '</option>';
    }).join('');
    $('sg-f-tex').value = icon && texById(icon.tex) ? icon.tex : defaultTex();
    say('sg-f-msg', icon ? 'Pick a new layer only to replace it.' : '');
    show('sg-form-modal', true);
    formPreview();
    if (icon) {
      layersOf(icon).then(function (L) {
        if (form.icon !== icon) return;
        form.black = form.black || L.black;
        form.white = form.white || L.white;
        form.L = null;
        formPreview();
      }).catch(function (e) { say('sg-f-msg', e.message, true); });
    }
    $('sg-f-name').focus();
  }
  ['black', 'white'].forEach(function (k) {
    $('sg-f-' + k).addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (!f) return;
      say('sg-f-msg', '');
      readLayer(f).then(function (r) {
        form[k] = r.img; form[k + 'Data'] = r.data; form.L = null;
        formPreview();
      }).catch(function (e) { say('sg-f-msg', e.message, true); });
    });
  });
  $('sg-f-tex').addEventListener('change', formPreview);
  $('sg-add').addEventListener('click', function () { openForm(null); });
  $('sg-edit').addEventListener('click', function () {
    var icon = current;
    closeWindow('sg-detail');
    openForm(icon);
  });
  $('sg-delete').addEventListener('click', function () {
    var icon = current;
    if (!icon || !confirm('Delete "' + icon.name + '" from the gallery? This cannot be undone.')) return;
    api({ action: 'delete', id: icon.id }).then(function () {
      gallery.icons = gallery.icons.filter(function (x) { return x.id !== icon.id; });
      closeWindow('sg-detail');
      drawTags(); drawGrid();
    }).catch(function (e) { say('sg-d-msg', e.message, true); });
  });

  $('sg-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var icon = form.icon, btn = $('sg-f-save');
    var body = {
      action: 'save', name: $('sg-f-name').value.trim(), tags: $('sg-f-tags').value,
      artist: $('sg-f-artist').value.trim(), tex: $('sg-f-tex').value
    };
    if (icon) body.id = icon.id;
    if (!body.name) { say('sg-f-msg', 'Give the icon a name.', true); return; }
    if (!form.black || !form.white) {
      say('sg-f-msg', icon ? 'The layers are still loading. Try again in a moment.' : 'Pick both layers.', true);
      return;
    }
    if (layersDiffer()) { say('sg-f-msg', SIZES_DIFFER, true); return; }
    if (form.blackData) body.black = form.blackData;
    if (form.whiteData) body.white = form.whiteData;
    var newLook = !icon || body.black || body.white || icon.tex !== body.tex;
    btn.disabled = true;
    say('sg-f-msg', 'Saving…');
    (newLook ? texturesFor(body.tex).then(function (t) {
      body.thumb = compose(formLayers(), {
        texture: true, whites: true, blacks: true, shadow: true, fill: t.fill, parch: t.parch
      }, THUMB).toDataURL('image/webp', 0.86);
    }) : Promise.resolve()).then(function () { return api(body); }).then(function (r) {
      gallery.icons = gallery.icons.filter(function (x) { return x.id !== r.icon.id; }).concat([r.icon]).sort(byName);
      try { localStorage.setItem('botc_starlit_artist', body.artist); } catch (e2) { /* fine */ }
      closeWindow('sg-form-modal');
      drawTags(); drawGrid();
      openIcon(r.icon);
    }).catch(function (e2) { say('sg-f-msg', e2.message, true); })
      .then(function () { btn.disabled = false; });
  });

  /* ── start ────────────────────────────────────────────────────── */

  if (PICK) {
    $('sg-pick-head').hidden = false;
    $('sg-use').hidden = false;
    $('sg-download').hidden = true;
    $('sg-size').hidden = true;
  }
  if (window.CreatorSymbols) {
    var drawHeroMark = function () {
      var old = document.querySelector('.sg-by .creator-mark');
      if (old) old.remove();
      var m = window.CreatorSymbols.markHTMLFor(ARTISTS);
      if (m) $('sg-by-link').insertAdjacentHTML('afterend', ' ' + m);
    };
    drawHeroMark();
    window.CreatorSymbols.load().then(drawHeroMark);
  }

  fetch('/api/starlit', { credentials: 'same-origin' })
    .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
    .then(function (d) {
      gallery = {
        icons: d.icons || [], textures: d.textures || [], canUpload: !!d.canUpload,
        isAdmin: !!d.isAdmin, uploaders: d.uploaders || []
      };
      rebuildTextures(); drawTags(); drawGrid(); drawTeam();
      var want = new URLSearchParams(location.search).get('icon');
      if (want) openIcon(byId(want));
    })
    .catch(function () { $('sg-count').textContent = 'The gallery could not be loaded. Refresh the page to try again.'; });
})();
