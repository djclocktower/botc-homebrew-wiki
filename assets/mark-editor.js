/* "Your Creator Mark" on the account page: claim a symbol and
   choose whether it shows beside your name. The rules (what a glyph may be,
   whether it is free) are assets/creators.js's and the Worker's; this is the
   form. Saves through POST /api/account/mark.

   MarkEditor.mount(el, {username, displayName}) */
(function () {
  // Symbols offered as a starting point, minus any already taken. Chosen to
  // draw as text, not as a coloured emoji, on phones.
  var PALETTE = ('✠✢✣✤✥✦✧✩✪✫✬✭✮✯✰✱✲✵✶✷✸✹✺✻✼✽✾✿❀❁❂❃❅❆❈❉❊❋❖❦❧☉☊☋☌☍☙☤☥☦☧☨☩☫☬☽☿' +
    '♀♁♂♃♅♆♇♔♕♖♗♘♙♚♛♜♝♞♢♤♧♩♫♬♭♮♯⚘⚚⚝⚶⚷⚸⚹⚺⚻⚼⛤⛥⛦⟡⟐⧫⧖⧗⬟⬠⬡⬢⬣⬥⬦' +
    'ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛃᛇᛈᛉᛊᛏᛒᛗᛚᛜᛞᛟ🜁🜂🜃🜍🜔🜛');
  var PALETTE_SHOWN = 40;

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

  function mount(el, opts) {
    var CS = window.CreatorSymbols;
    if (!el || !CS) return;
    var me = String(opts.username || '');
    var state = { mark: null, legacy: [], banned: [], glyph: '', show: true };

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
            '<p class="mark-ed-hint">One symbol, yours alone. It is plain text, so it goes everywhere your name does: the wiki, exported scripts, the official script tool, Discord.</p>' +
            '<div class="mark-ed-palette" id="me-palette"></div>' +
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
    function isBanned(glyph) { return state.banned.indexOf(CS.markKey(glyph)) !== -1; }
    function markInner(g) { return '<span class="creator-mark">' + esc(g || '?') + '</span>'; }
    function paint() {
      var g = state.glyph;
      $('me-disc').innerHTML = g ? markInner(g) : '<span class="mark-disc-empty">?</span>';
      $('me-sample').innerHTML = 'by <strong>' + esc(opts.displayName || me) + '</strong>' +
        (state.show && g ? ' ' + markInner(g) : '') +
        (state.show ? '' : ' <span class="mark-ed-opt">(hidden)</span>');
      var bad = state.glyph ? CS.markProblem(state.glyph) || (isBanned(state.glyph) ? 'Not allowed as a mark' : '') : '';
      var other = !bad && state.glyph ? takenBy(state.glyph) : null;
      var av = $('me-avail');
      av.className = 'mark-ed-avail ' + (bad || other ? 'err' : (state.glyph ? 'ok' : ''));
      av.textContent = bad ? bad : other ? 'Taken by ' + CS.markOwner(other) : (state.glyph ? 'Available' : '');
      $('me-save').disabled = !state.glyph || !!bad || !!other;
    }
    function palette() {
      // An even spread across the whole list, so every family of symbols
      // (stars, astrology, chess, runes, alchemy) is offered, not just the first.
      var all = Array.from(PALETTE).filter(function (g) { return !takenBy(g) && !isBanned(g); });
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
        ' from the original creator icons list. Save it to make it your own, or pick a new symbol, which frees the old one.';
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
    $('me-save').addEventListener('click', function () {
      var btn = this;
      btn.disabled = true;
      msg('', 'Saving…');
      var body = { glyph: state.glyph, show: state.show };
      postJSON(body).then(function (res) {
        btn.disabled = false;
        if (!res.ok) { msg('err', res.body.error || 'Could not save your mark.'); return; }
        state.mark = res.body.mark;
        msg('ok', 'Saved. Your mark now shows on your pages.');
        status(); paint();
      }, function () { btn.disabled = false; msg('err', 'Could not save your mark.'); });
    });
    $('me-giveup').addEventListener('click', function () {
      if (!confirm('Give up your mark? Anyone will be able to claim it.')) return;
      postJSON({ remove: true }).then(function (res) {
        if (!res.ok) { msg('err', res.body.error || 'Could not remove your mark.'); return; }
        state.mark = null; state.glyph = '';
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
      state.banned = Array.isArray(mine.banned) ? mine.banned : [];
      if (m) {
        state.glyph = m.g;
        state.show = !m.hide;
        $('me-show').checked = state.show;
      } else if (state.legacy.length) state.glyph = state.legacy[0].g;
      $('me-glyph').value = state.glyph;
      status(); palette(); paint();
    }, function () { $('me-status').textContent = 'Could not load your mark. Reload to try again.'; });
  }

  window.MarkEditor = { mount: mount };
})();
