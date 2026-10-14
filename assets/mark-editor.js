/* "Your Creator Mark" on the account page: claim a symbol, give it a picture,
   choose whether it shows beside your name. The rules (what a glyph may be,
   whether it is free) are assets/creators.js's and the Worker's; this is the
   form. Saves through POST /api/account/mark.

   MarkEditor.mount(el, {username, displayName}) */
(function () {
  // Symbols offered as a starting point, minus any already taken. Chosen to
  // draw as text, not as a coloured emoji, on phones.
  var PALETTE = ('✠✢✣✤✥✦✧✩✪✫✬✭✮✯✰✱✲✵✶✷✸✹✺✻✼✽✾✿❀❁❂❃❅❆❈❉❊❋❖❦❧☉☊☋☌☍☙☤☥☦☧☨☩☫☬☽☿' +
    '♀♁♂♃♅♆♇♔♕♖♗♘♙♚♛♜♝♞♢♤♧♩♫♬♭♮♯⚘⚚⚝⚶⚷⚸⚹⚺⚻⚼⛤⛥⛦⟡⟐⧫⧖⧗⬟⬠⬡⬢⬣⬥⬦' +
    'ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛃᛇᛈᛉᛊᛏᛒᛗᛚᛜᛞᛟ🜁🜂🜃🜄🜍🜔🜛');
  var PALETTE_SHOWN = 40;
  var MASK_PX = 128;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function postJSON(body) {
    return fetch('/api/account/mark', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, body: d }; }); });
  }

  /* A picked file -> a 128px PNG whose ALPHA is the mark (the colour is
     thrown away: the mark is painted in the text colour). A PNG with
     transparency keeps its shape; anything opaque is read as ink on paper,
     dark on light or light on dark, whichever its corners say the paper is.
     Trimmed to the ink and centred. */
  function toMask(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var scale = Math.min(1, 384 / Math.max(img.width, img.height));
        var w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
        var c = document.createElement('canvas'); c.width = w; c.height = h;
        var cx = c.getContext('2d');
        cx.drawImage(img, 0, 0, w, h);
        var data = cx.getImageData(0, 0, w, h), px = data.data, n = w * h, i;
        var clear = 0;
        for (i = 0; i < n; i++) if (px[i * 4 + 3] < 200) clear++;
        var transparent = clear > n * 0.02;
        var lum = function (k) { return 0.299 * px[k] + 0.587 * px[k + 1] + 0.114 * px[k + 2]; };
        var corners = [0, w - 1, (h - 1) * w, n - 1].reduce(function (a, p) { return a + lum(p * 4); }, 0) / 4;
        var darkPaper = corners < 110;
        var minX = w, minY = h, maxX = -1, maxY = -1;
        for (i = 0; i < n; i++) {
          var k = i * 4, a;
          if (transparent) a = px[k + 3];
          else {
            var l = lum(k);
            a = darkPaper ? l : 255 - l;
            a = Math.max(0, Math.min(255, (a - 40) * 1.4));   // paper to nothing, ink to solid
          }
          px[k] = px[k + 1] = px[k + 2] = 0; px[k + 3] = a;
          if (a > 24) {
            var x = i % w, y = (i / w) | 0;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
        if (maxX < 0) { reject(new Error('That picture looks blank.')); return; }
        cx.putImageData(data, 0, 0);
        var out = document.createElement('canvas'); out.width = out.height = MASK_PX;
        var bw = maxX - minX + 1, bh = maxY - minY + 1;
        var fit = (MASK_PX - 8) / Math.max(bw, bh);
        var dw = bw * fit, dh = bh * fit;
        out.getContext('2d').drawImage(c, minX, minY, bw, bh, (MASK_PX - dw) / 2, (MASK_PX - dh) / 2, dw, dh);
        resolve(out.toDataURL('image/png'));
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); };
      img.src = url;
    });
  }

  function mount(el, opts) {
    var CS = window.CreatorSymbols;
    if (!el || !CS) return;
    var me = String(opts.username || '');
    var state = { mark: null, legacy: [], glyph: '', image: undefined, imagePreview: '', show: true };

    el.innerHTML =
      '<div class="mark-ed">' +
        '<div class="mark-ed-preview">' +
          '<div class="mark-disc" id="me-disc"></div>' +
          '<p class="mark-ed-sample" id="me-sample"></p>' +
        '</div>' +
        '<div class="mark-ed-form">' +
          '<p class="mark-ed-status" id="me-status">Loading…</p>' +
          '<div class="set-field">' +
            '<label for="me-glyph">Symbol</label>' +
            '<div class="mark-ed-row"><input id="me-glyph" maxlength="8" autocomplete="off" spellcheck="false" placeholder="Paste or pick a symbol">' +
            '<span class="mark-ed-avail" id="me-avail"></span></div>' +
            '<p class="mark-ed-hint">One symbol, yours alone. It goes wherever a picture cannot: exported scripts, the official script tool, Discord.</p>' +
            '<div class="mark-ed-palette" id="me-palette"></div>' +
          '</div>' +
          '<div class="set-field">' +
            '<label>Picture <span class="mark-ed-opt">(optional)</span></label>' +
            '<input type="file" id="me-file" accept="image/png,image/jpeg,image/webp" hidden>' +
            '<button type="button" class="btn" id="me-upload" style="padding:7px 12px;font-size:.88rem">Upload a picture</button> ' +
            '<button type="button" class="mini-btn del" id="me-img-remove" hidden>Use the symbol only</button>' +
            '<p class="mark-ed-hint">A drawing on a plain background, or a PNG with a transparent one. It is drawn in a single colour, like the symbol, so it matches the text around it. On the wiki the picture is shown; the symbol stands in where pictures cannot go.</p>' +
          '</div>' +
          '<label class="mark-ed-check"><input type="checkbox" id="me-show" checked> Show my mark next to my name around the wiki</label>' +
          '<div class="mark-ed-btns"><button type="button" class="btn" id="me-save">Save Mark</button>' +
          '<button type="button" class="btn secondary" id="me-giveup" hidden>Give up this mark</button></div>' +
          '<div class="inline-msg" id="me-msg"></div>' +
        '</div>' +
      '</div>';
    function $(id) { return el.querySelector('#' + id); }
    function msg(cls, text) { var m = $('me-msg'); m.className = 'inline-msg ' + (cls || ''); m.textContent = text || ''; }

    // Who else holds this glyph: an account, or a name from the original
    // list that is not one of yours. (The Worker checks again on save.)
    function takenBy(glyph) {
      var k = CS.markKey(glyph);
      if (state.legacy.some(function (l) { return l.k === k; })) return null;
      var list = CS.allMarks() || [];
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (m.k === k && !(m.u && m.u.toLowerCase() === me.toLowerCase())) return m;
      }
      return null;
    }
    // The mark as it will look: the picture if there is one, else the glyph.
    function previewMark() {
      var img = state.image === null ? '' : (state.imagePreview || (state.mark && /^marks\/u\d+\.png$/.test(state.mark.img || '') ? '/assets/' + state.mark.img + (/^[a-z0-9]+$/i.test(state.mark.v || '') ? '?v=' + state.mark.v : '') : ''));
      return { glyph: state.glyph, img: img };
    }
    function markInner(p) {
      return p.img
        ? '<span class="creator-mark creator-mark-img" style="--mark:url(' + p.img + ')"></span>'
        : '<span class="creator-mark">' + esc(p.glyph || '?') + '</span>';
    }
    function paint() {
      var p = previewMark();
      $('me-disc').innerHTML = p.glyph || p.img ? markInner(p) : '<span class="mark-disc-empty">?</span>';
      $('me-sample').innerHTML = 'by <strong>' + esc(opts.displayName || me) + '</strong>' +
        (state.show && (p.glyph || p.img) ? ' ' + markInner(p) : '') +
        (state.show ? '' : ' <span class="mark-ed-opt">(hidden)</span>');
      $('me-img-remove').hidden = !p.img;
      var bad = state.glyph ? CS.markProblem(state.glyph) : '';
      var other = !bad && state.glyph ? takenBy(state.glyph) : null;
      var av = $('me-avail');
      av.className = 'mark-ed-avail ' + (bad || other ? 'err' : (state.glyph ? 'ok' : ''));
      av.textContent = bad ? bad : other ? 'Taken by ' + CS.markOwner(other) : (state.glyph ? 'Available' : '');
      $('me-save').disabled = !state.glyph || !!bad || !!other;
    }
    function palette() {
      // An even spread across the whole list, so every family of symbols
      // (stars, astrology, chess, runes, alchemy) is offered, not just the first.
      var all = Array.from(PALETTE).filter(function (g) { return !takenBy(g); });
      var step = Math.max(1, all.length / PALETTE_SHOWN), free = [];
      for (var i = 0; i < all.length && free.length < PALETTE_SHOWN; i += step) free.push(all[Math.floor(i)]);
      $('me-palette').innerHTML = free.map(function (g) {
        return '<button type="button" class="mark-pick" data-g="' + esc(g) + '" aria-label="Use ' + esc(g) + '">' + esc(g) + '</button>';
      }).join('');
    }
    function status() {
      var m = state.mark, s = $('me-status');
      if (m) s.textContent = 'This mark is yours. Nobody else can take it while you have it.';
      else if (state.legacy.length) s.textContent = 'Your pages already carry ' + state.legacy.map(function (l) { return l.g; }).join(' ') +
        ' from the original creator icons list. Save it to make it your own (and give it a picture if you like), or pick a new symbol, which frees the old one.';
      else s.textContent = 'You have no mark yet. Pick a symbol nobody else has, and it is yours.';
      $('me-giveup').hidden = !m;
    }

    $('me-glyph').addEventListener('input', function () { state.glyph = this.value.trim(); paint(); });
    $('me-palette').addEventListener('click', function (e) {
      var b = e.target.closest('.mark-pick');
      if (!b) return;
      state.glyph = b.getAttribute('data-g');
      $('me-glyph').value = state.glyph;
      paint();
    });
    $('me-show').addEventListener('change', function () { state.show = this.checked; paint(); });
    $('me-upload').addEventListener('click', function () { $('me-file').click(); });
    $('me-file').addEventListener('change', function () {
      var f = this.files && this.files[0];
      this.value = '';
      if (!f) return;
      msg('', 'Preparing picture…');
      toMask(f).then(function (url) {
        state.image = url; state.imagePreview = url;
        msg('', 'Picture ready. Save to keep it.');
        paint();
      }, function (e) { msg('err', e.message || 'Could not read that image.'); });
    });
    $('me-img-remove').addEventListener('click', function () {
      state.image = null; state.imagePreview = '';
      paint();
    });
    $('me-save').addEventListener('click', function () {
      var btn = this;
      btn.disabled = true;
      msg('', 'Saving…');
      var body = { glyph: state.glyph, show: state.show };
      if (state.image === null) body.image = null;
      else if (state.image) body.image = state.image;
      postJSON(body).then(function (res) {
        btn.disabled = false;
        if (!res.ok) { msg('err', res.body.error || 'Could not save your mark.'); return; }
        state.mark = res.body.mark; state.image = undefined; state.imagePreview = '';
        msg('ok', 'Saved. Your mark now shows on your pages.');
        status(); paint();
      }, function () { btn.disabled = false; msg('err', 'Could not save your mark.'); });
    });
    $('me-giveup').addEventListener('click', function () {
      if (!confirm('Give up your mark? Anyone will be able to claim it.')) return;
      postJSON({ remove: true }).then(function (res) {
        if (!res.ok) { msg('err', res.body.error || 'Could not remove your mark.'); return; }
        state.mark = null; state.glyph = ''; state.image = undefined; state.imagePreview = '';
        $('me-glyph').value = '';
        msg('ok', 'Your mark is gone.');
        status(); palette(); paint();
      });
    });

    Promise.all([
      CS.load(),
      fetch('/api/account/mark', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : {}; })
    ]).then(function (res) {
      var mine = res[1] || {};
      var m = mine.mark || null;
      state.mark = m;
      state.legacy = Array.isArray(mine.legacy) ? mine.legacy : [];
      if (m) {
        state.glyph = m.g;
        state.show = !m.hide;
        $('me-show').checked = state.show;
      } else if (state.legacy.length) state.glyph = state.legacy[0].g;
      $('me-glyph').value = state.glyph;
      status(); palette(); paint();
    }, function () { $('me-status').textContent = 'Could not load your mark. Reload to try again.'; });
  }

  window.MarkEditor = { mount: mount, toMask: toMask };
})();
