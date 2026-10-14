/* The "Custom URL" field on publish-script, publish-collection and
   publish-page: a page's own address (/s/{x}, /collection/{x}, /p/{x}).

   CustomUrl.mount({input, state, type, slug}) -> {get, set, known}
     input  the text box; state  the line under it that says free / taken;
     type   'script' | 'collection' | 'wikipage';
     slug() the page's own key, or '' for a page not saved yet.

   It only ASKS (/api/custom-url-check, as you type); the Worker decides on
   save (settleCustomUrl in worker.js). `known()` is false until the box was
   either filled from the saved page or typed in, and an editor sends nothing
   while it is false — a stale form must never clear an address it never
   loaded. */
(function () {
  function norm(v) {
    return String(v == null ? '' : v).trim().toLowerCase().normalize('NFD')
      .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function mount(o) {
    var input = o.input, state = o.state, timer = null, seq = 0, known = false;
    function show(cls, text) {
      if (!state) return;
      state.className = 'cu-state' + (cls ? ' cu-' + cls : '');
      state.textContent = text || '';
    }
    function check() {
      var v = norm(input.value);
      var my = ++seq;
      if (!v) { show('', 'Using the automatic address.'); return; }
      if (v.length < 3 || v.length > 60) { show('bad', 'Use 3 to 60 letters, numbers or hyphens.'); return; }
      show('', 'Checking ' + v + '…');
      fetch('/api/custom-url-check?type=' + encodeURIComponent(o.type) +
            '&url=' + encodeURIComponent(v) + '&slug=' + encodeURIComponent(o.slug() || ''),
            { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (my !== seq) return;
          if (d.error) show('bad', d.error);
          else if (d.free === true) show('ok', '✓ ' + d.url + ' is yours to use.');
          else if (d.free === false) show('bad', '✗ ' + d.url + ' is already taken. Try another.');
          else show('', '');
        })
        .catch(function () { if (my === seq) show('', ''); });
    }
    input.addEventListener('input', function () {
      known = true;
      clearTimeout(timer);
      timer = setTimeout(check, 350);
      if (o.onChange) o.onChange(norm(input.value));
    });
    input.addEventListener('blur', function () {
      var v = norm(input.value);
      if (v !== input.value) input.value = v;
    });
    return {
      get: function () { return norm(input.value); },
      set: function (v) { input.value = norm(v); known = true; check(); },
      known: function () { return known; }
    };
  }

  window.CustomUrl = { mount: mount, norm: norm };
})();
