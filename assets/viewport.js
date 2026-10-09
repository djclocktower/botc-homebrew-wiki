/* Character cards in bounded batches, drawn as the reader approaches them.

   window.mountCardBatches(host, groups, renderCard, options) -> cancel()
     groups      [{selector, items, tail?}] — one per grid (CharFilters.sections())
     renderCard  item -> card HTML
     options.size   cards per batch (48)
     options.first  how many the first grid draws at once (defaults to size;
                    a filter tap asks for fewer so its next paint is quick)
     options.adopt  the grids may already hold server-drawn cards and their
                    spacer and button (CharFilters.batchedHTML()): keep them,
                    when they are the items' first cards, instead of drawing
                    them again

   Three things keep the page still while it fills in:
   - Under every grid sits a spacer as tall as the cards it has not drawn yet
     (measured from the rows already drawn), and the "Show more" button sits
     under the spacer. A batch fills the spacer's place rather than pushing
     the button, the next section and the footer down the screen.
   - A batch is drawn when the spacer comes within MARGIN of the screen, and
     at most one per animation frame, so a fast scroll or a Group change
     never draws several sections in one long task. When the page is idle,
     the next batch near the screen is drawn ahead of the reader.
   - The buttons work without IntersectionObserver, and every card stays
     reachable by clicking them.

   window.mountCardBatches.reserve(host) sizes the spacers of server-drawn
   grids (data-total) before any data has arrived, and
   window.mountCardBatches.whenNeeded(host, start) calls start() once, the
   first time the page is idle after loading or the reader does anything —
   the moment a server-drawn page fetches the full list. */
(function () {
  'use strict';
  var MARGIN = 1500;
  var STEP = 24;          // cards per frame / idle slice; a 48-card insert was an 85–220 ms task on a phone

  function frame(fn) { return (window.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(fn); }
  function idle(fn, timeout) {
    if (window.requestIdleCallback) window.requestIdleCallback(fn, { timeout: timeout || 2000 });
    else setTimeout(function () { fn({ timeRemaining: function () { return 16; }, didTimeout: true }); }, 200);
  }
  function viewH() { return window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 800; }
  function label(total, at, started) {
    return started ? 'Show more (' + (total - at) + ' remaining)' : 'Show ' + total + ' characters';
  }
  function cardCount(grid) {
    var n = 0, kids = grid.children || [];
    for (var i = 0; i < kids.length; i++) if (!/\bempty-card\b/.test(kids[i].className || '')) n++;
    return n;
  }
  // Row geometry of a grid that has cards in it: columns, gap, and the
  // height one row adds (its pitch). Null when it cannot be measured.
  function metricsOf(grid) {
    try {
      if (!grid || !grid.getBoundingClientRect || !window.getComputedStyle) return null;
      var n = (grid.children || []).length;
      if (!n) return null;
      var cs = window.getComputedStyle(grid);
      var cols = String(cs.gridTemplateColumns || '').split(' ').filter(Boolean).length || 1;
      var gap = parseFloat(cs.rowGap) || 0;
      var h = grid.getBoundingClientRect().height;
      var rows = Math.ceil(n / cols);
      return h && rows ? { cols: cols, gap: gap, pitch: (h + gap) / rows } : null;
    } catch (e) { return null; }
  }
  // The height the cards still to come will add to a grid holding `at`.
  function reserveFor(m, total, at) {
    var left = total - at;
    if (!m || left <= 0) return 0;
    var room = at % m.cols ? m.cols - at % m.cols : 0;   // free cells in the last drawn row
    var rows = Math.ceil(Math.max(0, left - room) / m.cols);
    return Math.max(0, rows * m.pitch - (at ? 0 : m.gap));
  }
  function sectionOf(grid) {
    return grid.closest ? grid.closest('.type-section') : null;
  }
  // Before a section is first rendered, content-visibility sizes it by its
  // intrinsic size: make that the section's real expected height, so the
  // scrollbar and everything below it do not jump when it renders.
  function sizeSection(grid, m, total) {
    var sec = sectionOf(grid);
    if (!sec || !sec.style || !m) return;
    var full = total ? Math.ceil(total / m.cols) * m.pitch - m.gap : 0;
    sec.style.containIntrinsicSize = 'auto ' + Math.round(full + 140) + 'px';
  }
  function next(el, cls) {
    var sib = el && el.nextElementSibling;
    return sib && (' ' + (sib.className || '') + ' ').indexOf(' ' + cls + ' ') !== -1 ? sib : null;
  }

  window.mountCardBatches = function (host, groups, renderCard, options) {
    var opts = options || {}, size = opts.size || 48, alive = true, observer, metrics = null;
    var jobs = [], queue = [], pending = false, idling = false;

    function setSpacer(job) {
      if (!job.spacer || !job.spacer.style) return;
      var left = job.items.length - job.at + (job.tail && !job.tailDone ? 1 : 0);
      job.spacer.style.height = left && metrics ? Math.round(reserveFor(metrics, job.at + left, job.at)) + 'px' : '0px';
    }
    function update(job) {
      var total = job.items.length;
      job.button.hidden = job.at >= total;
      job.button.textContent = label(total, job.at, true);
      job.started = true;
      setSpacer(job);
    }
    function append(job, n) {
      if (!alive || !job || job.at >= job.items.length) return;
      var end = Math.min(job.at + (n || size), job.items.length);
      var html = job.items.slice(job.at, end).map(renderCard).join('');
      if (end === job.items.length && job.tail && !job.tailDone) { html += job.tail; job.tailDone = true; }
      job.grid.insertAdjacentHTML('beforeend', html);
      job.at = end;
      if (!metrics) {
        metrics = metricsOf(job.grid);
        if (metrics) jobs.forEach(function (j) { setSpacer(j); sizeSection(j.grid, metrics, j.items.length); });
      }
      update(job);
    }
    function near(job) {
      try {
        var r = (job.spacer || job.button).getBoundingClientRect();
        return r.top < viewH() + MARGIN && r.bottom > -MARGIN;
      } catch (e) { return false; }
    }
    // One step per animation frame, nearest-first; keeps going while the
    // junction is still within reach.
    function want(job) {
      if (!job || job.at >= job.items.length) return;
      if (queue.indexOf(job) === -1) queue.push(job);
      if (!pending) { pending = true; frame(drain); }
    }
    function drain() {
      pending = false;
      if (!alive) return;
      var job = queue.shift();
      if (job) {
        append(job, STEP);
        if (job.at < job.items.length && near(job)) queue.push(job);
      }
      if (queue.length) { pending = true; frame(drain); }
      else ahead();
    }
    // When nothing is waiting, draw the next step of the nearest unfinished
    // grid within two margins of the screen, in idle time.
    function ahead() {
      if (idling || !alive || !observer) return;
      idling = true;
      idle(function (deadline) {
        idling = false;
        if (!alive || queue.length || pending) return;
        if (deadline && deadline.timeRemaining && deadline.timeRemaining() < 8 && !deadline.didTimeout) { ahead(); return; }
        for (var i = 0; i < jobs.length; i++) {
          var job = jobs[i];
          if (job.at >= job.items.length) continue;
          var r;
          try { r = job.spacer.getBoundingClientRect(); } catch (e) { return; }
          if (r.top > -200 && r.top < viewH() + 2 * MARGIN) { append(job, STEP); ahead(); return; }
        }
      }, 3000);
    }

    if (typeof IntersectionObserver === 'function') observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        for (var i = 0; i < jobs.length; i++) {
          var j = jobs[i];
          if (j.spacer === entry.target || j.button === entry.target || j.section === entry.target) { want(j); break; }
        }
      });
    }, { rootMargin: MARGIN + 'px 0px' });

    groups.forEach(function (group, index) {
      var grid = host.querySelector(group.selector);
      if (!grid || !group.items.length) return;
      var job = { grid: grid, items: group.items, at: 0, tail: group.tail || '', tailDone: false, started: false };
      if (opts.adopt) {
        // Keep the cards already there when they are this list's first ones,
        // in order; anything else is cleared and drawn afresh.
        var have = grid.children ? cardCount(grid) : 0, ok = have <= group.items.length;
        for (var i = 0; ok && i < have; i++) {
          if (grid.children[i].getAttribute('href') !== String(group.items[i].page)) ok = false;
        }
        if (ok) {
          job.at = have;
          job.tailDone = !!(grid.querySelector && grid.querySelector('.empty-card'));
          job.started = have > 0 || index === 0;
        } else grid.innerHTML = '';
      }
      job.spacer = next(grid, 'card-spacer');
      if (!job.spacer && document.createElement) {
        job.spacer = document.createElement('div');
        job.spacer.className = 'card-spacer';
        if (job.spacer.setAttribute) job.spacer.setAttribute('aria-hidden', 'true');
        grid.insertAdjacentElement('afterend', job.spacer);
      }
      job.button = next(job.spacer, 'card-load-more') || next(grid, 'card-load-more');
      if (!job.button) {
        job.button = document.createElement('button');
        job.button.type = 'button'; job.button.className = 'card-load-more';
        (job.spacer || grid).insertAdjacentElement('afterend', job.button);
      }
      job.section = sectionOf(grid);
      jobs.push(job);
      job.button.addEventListener('click', function () { append(job, size); });
      // Only the first group is drawn eagerly. Other sections get their
      // first batch on approach, including direct jumps to a team anchor.
      if ((index === 0 || !observer) && job.at === 0) append(job, index === 0 ? (opts.first || size) : size);
      else if (job.started) update(job);
      else job.button.textContent = label(job.items.length, 0, false);
    });
    if (!metrics) {
      for (var k = 0; k < jobs.length && !metrics; k++) if (jobs[k].at) metrics = metricsOf(jobs[k].grid);
    }
    jobs.forEach(function (job) {
      setSpacer(job);
      if (metrics) sizeSection(job.grid, metrics, job.items.length);
      if (observer && job.at < job.items.length) {
        observer.observe(job.spacer || job.button);
        if (job.section && !job.at) observer.observe(job.section);
      }
    });
    // A first grid drawn short (opts.first) is finished in the next frames.
    if (observer && jobs[0] && jobs[0].at < jobs[0].items.length && jobs[0].at < size && near(jobs[0])) want(jobs[0]);
    // A turned phone or a resized window changes the columns, and with them
    // the height the undrawn cards will take.
    var resizeTimer = 0;
    function onResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (!alive) return;
        for (var r = 0; r < jobs.length; r++) if (jobs[r].at) { metrics = metricsOf(jobs[r].grid) || metrics; break; }
        jobs.forEach(function (j) { setSpacer(j); if (metrics) sizeSection(j.grid, metrics, j.items.length); });
      }, 200);
    }
    if (window.addEventListener) window.addEventListener('resize', onResize);
    return function () {
      alive = false; queue.length = 0;
      if (observer) observer.disconnect();
      if (window.removeEventListener) window.removeEventListener('resize', onResize);
    };
  };

  // Spacers for server-drawn grids, before the list has arrived: each grid
  // says how many cards it will hold (data-total), the first one's rows say
  // how tall a row is.
  window.mountCardBatches.reserve = function (host) {
    if (!host || !host.querySelectorAll) return;
    var grids = host.querySelectorAll('.char-grid[data-total]'), m = null, i;
    for (i = 0; i < grids.length && !m; i++) if (cardCount(grids[i])) m = metricsOf(grids[i]);
    if (!m) return;
    for (i = 0; i < grids.length; i++) {
      var g = grids[i], total = +g.getAttribute('data-total') + (g.getAttribute('data-tail') ? 1 : 0);
      var have = (g.children || []).length, sp = next(g, 'card-spacer');
      if (sp && sp.style) sp.style.height = Math.round(reserveFor(m, total, have)) + 'px';
      sizeSection(g, m, total);
    }
  };

  // start(button) once: on idle after the page has loaded, on the reader's
  // first scroll, tap or key, or when the end of the drawn cards nears the
  // screen, or a "Show more" button is clicked (that button is handed on,
  // so its batch can be drawn).
  window.mountCardBatches.whenNeeded = function (host, start) {
    var done = false, io = null, events = ['scroll', 'pointerdown', 'touchstart', 'keydown', 'focusin'];
    function go(button) {
      if (done) return;
      done = true;
      events.forEach(function (ev) { window.removeEventListener(ev, onEvent, true); });
      if (host) host.removeEventListener('click', onClick);
      if (io) io.disconnect();
      start(button || null);
    }
    function onEvent() { go(); }
    function onClick(e) {
      var b = e.target && e.target.closest ? e.target.closest('.card-load-more') : null;
      if (b) go(b);
    }
    events.forEach(function (ev) { window.addEventListener(ev, onEvent, { capture: true, passive: true }); });
    if (host) host.addEventListener('click', onClick);
    if (host && typeof IntersectionObserver === 'function') {
      io = new IntersectionObserver(function (entries) {
        if (entries.some(function (e) { return e.isIntersecting; })) go();
      }, { rootMargin: MARGIN + 'px 0px' });
      // The spacer's top is where the drawn cards end.
      Array.prototype.forEach.call(host.querySelectorAll('.card-spacer'), function (sp) {
        var b = next(sp, 'card-load-more');
        if (b && !b.hidden) io.observe(sp);
      });
    }
    function soon() { idle(function () { go(); }, 3000); }
    if (document.readyState === 'complete') soon();
    else window.addEventListener('load', soon);
  };
})();
