/* The jinx relationship map (/jinxes).

   Every character on the wiki that takes part in a jinx, drawn as a node,
   with a line to each character it is jinxed with. Official characters are
   here too as anchor nodes: most jinxes point at one, so without them the
   map would be a handful of disconnected pairs. Official-to-official jinxes
   are not included — this is a map of the homebrew wiki, not the base game.

   Hand-rolled SVG on purpose. The repo vendors everything and has no
   bundler, and a graph library would be the first CDN dependency on the
   site; at ~250 nodes and ~350 edges a small spring layout is a few hundred
   lines and stays inside the house style.

   Two things worth knowing before changing the layout:

   1. Positions are seeded from a hash of the node id, not from Math.random,
      so the map has the same shape every visit. People navigate it by
      remembering where things are; a layout that reshuffles on reload is
      much harder to use than a slightly worse layout that holds still.
   2. The simulation runs a fixed number of ticks and then STOPS. It is not
      a live animation — a permanently running rAF loop on a page people
      leave open is a battery cost for no benefit, and dragging re-heats
      only the neighbourhood being dragged.

   mountJinxGraph(opts) -> api, where opts is
     {mount, data, onSelect}. Returns {focus, filter, destroy}. */
(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';

  var TEAM_COLORS = {
    townsfolk: '#2c5b9a', outsider: '#2c8a8a', minion: '#b8852a',
    demon: '#9a2c2c', traveller: '#6a4a8a', traveler: '#6a4a8a',
    fabled: '#b89a2a', loric: '#3a7a4a'
  };
  var OFFICIAL_COLOR = '#8a7a5c';
  var EDGE_GOOD = '#2f6fb8';
  var EDGE_EVIL = '#9a0d12';

  function el(name, attrs) {
    var n = document.createElementNS(SVG_NS, name);
    for (var k in attrs) if (attrs.hasOwnProperty(k)) n.setAttribute(k, attrs[k]);
    return n;
  }

  /* Deterministic per-id seed: same map every visit. */
  function hash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function mountJinxGraph(opts) {
    opts = opts || {};
    var mount = typeof opts.mount === 'string' ? document.getElementById(opts.mount) : opts.mount;
    if (!mount) return null;
    var data = opts.data || { nodes: [], edges: [] };
    if (!data.nodes.length) return null;

    // ---- model -------------------------------------------------------
    var nodes = data.nodes.map(function (n) {
      var h = hash(n.id);
      // Spread the seed over a disc rather than a square: a square start
      // leaves visible corners in the finished layout.
      var ang = (h % 3600) / 3600 * Math.PI * 2;
      var rad = 60 + ((h >> 12) % 1000) / 1000 * 340;
      return {
        d: n, id: n.id,
        x: Math.cos(ang) * rad, y: Math.sin(ang) * rad,
        vx: 0, vy: 0, deg: 0, on: true
      };
    });
    var byId = {};
    nodes.forEach(function (n) { byId[n.id] = n; });

    var links = [];
    data.edges.forEach(function (e) {
      var a = byId[e.a], b = byId[e.b];
      if (!a || !b || a === b) return;
      a.deg++; b.deg++;
      links.push({ a: a, b: b, e: e, on: true });
    });

    // A node's pull should grow with how connected it is, but slowly — the
    // busiest character has an order of magnitude more jinxes than the median
    // and would otherwise sit in a hole with everything else on the rim.
    nodes.forEach(function (n) { n.r = 11 + Math.sqrt(n.deg) * 3.4; });

    // ---- layout ------------------------------------------------------
    /* Repulsion is an inverse-square term, so two nodes that happen to seed
       almost on top of each other produce an enormous first-tick force and
       fling the whole map apart — 320 ticks of gravity never gets it back.
       REPEL_CAP is what keeps the opening tick sane; do not remove it. */
    var REPEL = 16000;
    var REPEL_CAP = 44;
    var REPEL_RANGE2 = 810000;   // beyond 900px apart, ignore each other
    var LINK_REST = 118;         // slack in a jinx line, on top of both radii
    var NODE_GAP = 26;           // clear parchment between two icons

    function simulate(ticks) {
      var i, j, k, n, m, dx, dy, d2, len, force, ux, uy;
      for (k = 0; k < ticks; k++) {
        // Cooling: big moves early, fine adjustment late.
        var a = Math.max(1 - k / ticks, 0.03);

        // repulsion, every pair (n is small enough to afford it)
        for (i = 0; i < nodes.length; i++) {
          n = nodes[i];
          for (j = i + 1; j < nodes.length; j++) {
            m = nodes[j];
            dx = m.x - n.x; dy = m.y - n.y;
            d2 = dx * dx + dy * dy;
            if (d2 > REPEL_RANGE2) continue;
            if (d2 < 1) {
              // Exactly coincident: push apart along a fixed axis so the
              // pair separates instead of dividing by zero.
              dx = ((i * 7 + j) % 13) - 6; dy = ((i * 5 + j) % 11) - 5;
              d2 = dx * dx + dy * dy || 1;
            }
            len = Math.sqrt(d2);
            force = REPEL / d2;
            if (force > REPEL_CAP) force = REPEL_CAP;
            ux = dx / len; uy = dy / len;
            n.vx -= ux * force; n.vy -= uy * force;
            m.vx += ux * force; m.vy += uy * force;
          }
        }

        // springs
        for (i = 0; i < links.length; i++) {
          var l = links[i];
          dx = l.b.x - l.a.x; dy = l.b.y - l.a.y;
          len = Math.sqrt(dx * dx + dy * dy) || 0.01;
          var rest = LINK_REST + l.a.r + l.b.r;
          force = (len - rest) * 0.09;
          if (force > 12) force = 12;
          var sx = (dx / len) * force, sy = (dy / len) * force;
          l.a.vx += sx; l.a.vy += sy;
          l.b.vx -= sx; l.b.vy -= sy;
        }

        // gravity towards the middle, and integrate
        for (i = 0; i < nodes.length; i++) {
          n = nodes[i];
          if (n.fixed) { n.vx = 0; n.vy = 0; continue; }
          n.vx -= n.x * 0.022;
          n.vy -= n.y * 0.022;
          n.x += n.vx * a;
          n.y += n.vy * a;
          n.vx *= 0.72;
          n.vy *= 0.72;
        }

        // Hard separation, so icons do not sit on top of one another. The
        // spring/repulsion balance alone leaves the densest clusters
        // overlapping, and an unreadable pile is worse than a wider map.
        for (i = 0; i < nodes.length; i++) {
          n = nodes[i];
          for (j = i + 1; j < nodes.length; j++) {
            m = nodes[j];
            var want = n.r + m.r + NODE_GAP;
            dx = m.x - n.x; dy = m.y - n.y;
            d2 = dx * dx + dy * dy;
            if (d2 >= want * want || d2 === 0) continue;
            len = Math.sqrt(d2) || 0.01;
            var push = (want - len) / 2;
            ux = dx / len; uy = dy / len;
            if (!n.fixed) { n.x -= ux * push; n.y -= uy * push; }
            if (!m.fixed) { m.x += ux * push; m.y += uy * push; }
          }
        }
      }
    }
    simulate(520);

    // ---- svg ---------------------------------------------------------
    var svg = el('svg', { class: 'jg-svg', xmlns: SVG_NS });
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label',
      'Relationship map of ' + nodes.length + ' characters connected by ' + links.length + ' jinxes');
    var root = el('g', {});
    var gEdges = el('g', { class: 'jg-edges' });
    var gNodes = el('g', { class: 'jg-nodes' });
    root.appendChild(gEdges);
    root.appendChild(gNodes);
    svg.appendChild(root);

    // Clip every icon to its circle once, rather than per node.
    var defs = el('defs', {});
    svg.insertBefore(defs, root);

    links.forEach(function (l) {
      l.el = el('line', {
        class: 'jg-edge',
        stroke: l.e.align === 'evil' ? EDGE_EVIL : EDGE_GOOD
      });
      gEdges.appendChild(l.el);
    });

    nodes.forEach(function (n) {
      var g = el('g', { class: 'jg-node' + (n.d.official ? ' jg-official' : '') });
      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'button');
      g.setAttribute('aria-label', n.d.name + (n.d.official ? ' (official)' : '') +
        ', ' + n.deg + ' jinx' + (n.deg === 1 ? '' : 'es'));

      var clipId = 'jgclip-' + n.id.replace(/[^a-z0-9]/gi, '');
      var clip = el('clipPath', { id: clipId });
      clip.appendChild(el('circle', { r: n.r }));
      defs.appendChild(clip);

      var ring = el('circle', {
        class: 'jg-ring', r: n.r,
        fill: '#f7f0e0',
        stroke: n.d.official ? OFFICIAL_COLOR : (TEAM_COLORS[n.d.team] || OFFICIAL_COLOR)
      });
      g.appendChild(ring);
      if (n.d.icon) {
        var img = el('image', {
          x: -n.r, y: -n.r, width: n.r * 2, height: n.r * 2,
          'clip-path': 'url(#' + clipId + ')',
          preserveAspectRatio: 'xMidYMid slice'
        });
        img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', n.d.icon);
        img.setAttribute('href', n.d.icon);
        // A missing icon leaves the coloured ring, which still reads as a node.
        img.addEventListener('error', function () { img.remove(); });
        g.appendChild(img);
      }
      n.el = g;
      n.ring = ring;
      gNodes.appendChild(g);
    });

    mount.appendChild(svg);

    function place() {
      links.forEach(function (l) {
        l.el.setAttribute('x1', l.a.x); l.el.setAttribute('y1', l.a.y);
        l.el.setAttribute('x2', l.b.x); l.el.setAttribute('y2', l.b.y);
      });
      nodes.forEach(function (n) {
        n.el.setAttribute('transform', 'translate(' + n.x + ',' + n.y + ')');
      });
    }
    place();

    // ---- viewport: pan + zoom ----------------------------------------
    var view = { x: 0, y: 0, k: 1 };
    function applyView() {
      root.setAttribute('transform',
        'translate(' + view.x + ',' + view.y + ') scale(' + view.k + ')');
    }
    function size() {
      var r = svg.getBoundingClientRect();
      return { w: r.width || mount.clientWidth || 800, h: r.height || 520 };
    }
    /* The smallest a character icon may be drawn at when the map first
       opens. Fitting 170-odd nodes into a phone-width box mathematically
       cannot leave them legible — it lands around 8px, which is the "grouped
       so tight together it's hard to read" complaint. So the opening view is
       allowed to overflow: it zooms only as far out as MIN_ICON_PX and lets
       the reader pan. Pinching out past this is still fine (minimum zoom is
       0.15); the floor governs the default view, not what the reader may do. */
    var MIN_ICON_PX = 26;
    var medianR = nodes.map(function (n) { return n.r; })
      .sort(function (a, b) { return a - b; })[Math.floor(nodes.length / 2)] || 14;

    /* Fit the map, once, and whenever the box changes size.
       fit({all: true}) ignores the legibility floor and really does show
       everything, however small that ends up. */
    function fit(o) {
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      nodes.forEach(function (n) {
        minX = Math.min(minX, n.x - n.r); maxX = Math.max(maxX, n.x + n.r);
        minY = Math.min(minY, n.y - n.r); maxY = Math.max(maxY, n.y + n.r);
      });
      var s = size();
      var pad = 20;
      var k = Math.min((s.w - pad * 2) / (maxX - minX || 1),
                       (s.h - pad * 2) / (maxY - minY || 1));
      if (!(o && o.all)) k = Math.max(k, MIN_ICON_PX / (medianR * 2));
      view.k = Math.max(0.15, Math.min(k, 2));
      view.x = s.w / 2 - ((minX + maxX) / 2) * view.k;
      view.y = s.h / 2 - ((minY + maxY) / 2) * view.k;
      applyView();
    }

    function zoomAt(cx, cy, factor) {
      var k = Math.max(0.15, Math.min(view.k * factor, 6));
      var f = k / view.k;
      view.x = cx - (cx - view.x) * f;
      view.y = cy - (cy - view.y) * f;
      view.k = k;
      applyView();
    }

    function localPoint(ev) {
      var r = svg.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    }

    svg.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      var p = localPoint(ev);
      zoomAt(p.x, p.y, ev.deltaY < 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });

    // Pointer handling covers mouse, pen and touch in one path. Two active
    // pointers means a pinch; one means a drag (of a node or the canvas).
    var pointers = {};
    var dragNode = null, panFrom = null, pinchFrom = null;
    // Press and release almost always have a pointermove between them — a
    // mouse jitters, a finger rolls. Treating any movement at all as a drag
    // swallowed the click, so a drag only begins past this many pixels.
    var DRAG_SLOP = 5;
    // setPointerCapture retargets every later event to the <svg>, so pointerup
    // cannot be asked what was under the cursor — the node has to be
    // remembered from pointerdown.
    var downAt = null, downNode = null, dragged = false;

    function nodeFromEvent(ev) {
      var t = ev.target;
      while (t && t !== svg) {
        if (t.classList && t.classList.contains('jg-node')) {
          for (var i = 0; i < nodes.length; i++) if (nodes[i].el === t) return nodes[i];
          return null;
        }
        t = t.parentNode;
      }
      return null;
    }

    function toWorld(p) {
      return { x: (p.x - view.x) / view.k, y: (p.y - view.y) / view.k };
    }

    /* Whether focus arrived from a pointer or from the keyboard. The hover
       tooltip is a mouse affordance: on a touch screen there is no hover to
       end it, so tapping a character left it stranded on the parchment (and
       saying the same thing as the panel that just opened). It is now shown
       for the mouse and for keyboard focus, and never for a tap. */
    var pointerFocus = false;
    // Tab moves focus without ever reaching the node's own keydown, so the
    // reset has to be watched for at the document.
    function onKeyNav(ev) {
      if (ev.key === 'Tab' || ev.key.indexOf('Arrow') === 0) pointerFocus = false;
    }
    document.addEventListener('keydown', onKeyNav, true);

    svg.addEventListener('pointerdown', function (ev) {
      pointerFocus = true;
      hideTip();
      svg.setPointerCapture(ev.pointerId);
      pointers[ev.pointerId] = localPoint(ev);
      var ids = Object.keys(pointers);
      if (ids.length === 2) {
        dragNode = null; panFrom = null;
        var a = pointers[ids[0]], b = pointers[ids[1]];
        pinchFrom = {
          dist: Math.hypot(a.x - b.x, a.y - b.y),
          cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, k: view.k
        };
        return;
      }
      dragged = false;
      downAt = { x: ev.clientX, y: ev.clientY };
      var n = nodeFromEvent(ev);
      downNode = n;
      if (n) {
        dragNode = n;
        n.fixed = true;
      } else {
        panFrom = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y };
      }
    });

    svg.addEventListener('pointermove', function (ev) {
      if (!pointers[ev.pointerId]) {
        if (!dragNode && !panFrom) hoverAt(ev);
        return;
      }
      pointers[ev.pointerId] = localPoint(ev);
      var ids = Object.keys(pointers);

      if (pinchFrom && ids.length === 2) {
        var a = pointers[ids[0]], b = pointers[ids[1]];
        var dist = Math.hypot(a.x - b.x, a.y - b.y);
        var k = Math.max(0.15, Math.min(pinchFrom.k * (dist / pinchFrom.dist), 6));
        var f = k / view.k;
        view.x = pinchFrom.cx - (pinchFrom.cx - view.x) * f;
        view.y = pinchFrom.cy - (pinchFrom.cy - view.y) * f;
        view.k = k;
        applyView();
        return;
      }
      if (downAt && !dragged &&
          Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y) > DRAG_SLOP) {
        dragged = true;
      }
      if (!dragged) return;
      if (dragNode) {
        var w = toWorld(pointers[ev.pointerId]);
        dragNode.x = w.x; dragNode.y = w.y;
        // Re-settle just the neighbourhood, so dragging one character does
        // not rearrange the entire map under the reader's finger.
        settleAround(dragNode);
        place();
      } else if (panFrom) {
        view.x = panFrom.vx + (ev.clientX - panFrom.x);
        view.y = panFrom.vy + (ev.clientY - panFrom.y);
        applyView();
      }
    });

    function endPointer(ev) {
      delete pointers[ev.pointerId];
      if (Object.keys(pointers).length < 2) pinchFrom = null;
      if (dragNode) { dragNode.fixed = false; dragNode = null; }
      panFrom = null;
      downAt = null;
      downNode = null;
    }
    svg.addEventListener('pointerup', function (ev) {
      var wasDrag = dragged;
      var n = downNode;
      var hadPointer = !!pointers[ev.pointerId];
      endPointer(ev);
      // A second finger lifting off a pinch is not a click on anything.
      if (!hadPointer || wasDrag) return;
      select(n || null);
    });
    svg.addEventListener('pointercancel', endPointer);
    svg.addEventListener('pointerleave', function () { hideTip(); });

    function settleAround(n) {
      var near = links.filter(function (l) { return l.a === n || l.b === n; })
        .map(function (l) { return l.a === n ? l.b : l.a; });
      near.forEach(function (m) {
        if (m.fixed) return;
        var dx = m.x - n.x, dy = m.y - n.y;
        var dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        var rest = 70 + n.r + m.r;
        var f = (dist - rest) * 0.08;
        m.x -= (dx / dist) * f;
        m.y -= (dy / dist) * f;
      });
    }

    // ---- selection ----------------------------------------------------
    var selected = null;
    function select(n) {
      // Selecting replaces the tooltip with the panel; leaving both up is
      // duplicate information, and on touch the tooltip would never leave.
      hideTip();
      selected = n;
      paint();
      if (opts.onSelect) {
        opts.onSelect(n ? {
          node: n.d,
          jinxes: links.filter(function (l) { return l.a === n || l.b === n; })
            .map(function (l) {
              var other = l.a === n ? l.b : l.a;
              return { with: other.d, align: l.e.align, text: l.e.text };
            })
        } : null);
      }
    }

    nodes.forEach(function (n) {
      n.el.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(n); }
      });
      n.el.addEventListener('focus', function () {
        if (!pointerFocus) showTipFor(n);
      });
      n.el.addEventListener('blur', hideTip);
    });

    /* One repaint for selection AND filtering: a node is dimmed when it is
       filtered out, or when something else is selected and it is not a
       neighbour of it. Doing both in one place is what keeps the two from
       fighting over the same class. */
    function paint() {
      var near = null;
      if (selected) {
        near = {};
        near[selected.id] = 1;
        links.forEach(function (l) {
          if (l.a === selected) near[l.b.id] = 1;
          if (l.b === selected) near[l.a.id] = 1;
        });
      }
      nodes.forEach(function (n) {
        var dim = !n.on || (near && !near[n.id]);
        n.el.classList.toggle('jg-dim', !!dim);
        n.el.classList.toggle('jg-sel', n === selected);
      });
      links.forEach(function (l) {
        var visible = l.a.on && l.b.on;
        var lit = !selected || l.a === selected || l.b === selected;
        l.el.classList.toggle('jg-dim', !visible || !lit);
        l.el.classList.toggle('jg-lit', !!selected && lit && visible);
      });
    }

    // ---- tooltip ------------------------------------------------------
    var tip = document.createElement('div');
    tip.className = 'jg-tip';
    tip.hidden = true;
    mount.appendChild(tip);

    function showTip(html, x, y) {
      tip.innerHTML = html;
      tip.hidden = false;
      var box = mount.getBoundingClientRect();
      var tw = tip.offsetWidth, th = tip.offsetHeight;
      // Keep it inside the box: near the right edge it flips to the left of
      // the cursor, near the bottom it flips above.
      var left = x + 14, top = y + 14;
      if (left + tw > box.width - 4) left = x - tw - 14;
      if (top + th > box.height - 4) top = y - th - 14;
      tip.style.left = Math.max(4, left) + 'px';
      tip.style.top = Math.max(4, top) + 'px';
    }
    function hideTip() { tip.hidden = true; }

    function escHTML(s) {
      return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
      });
    }

    function showTipFor(n, p) {
      var meta = n.d.official ? 'Official character'
        : ((n.d.team ? n.d.team.charAt(0).toUpperCase() + n.d.team.slice(1) : '') +
           (n.d.creator ? ' &middot; ' + escHTML(n.d.creator) : ''));
      // Keyboard focus has no cursor to sit beside, so fall back to where the
      // node actually is on screen rather than the corner of the box.
      var at = p || { x: n.x * view.k + view.x, y: n.y * view.k + view.y + n.r * view.k };
      showTip('<strong>' + escHTML(n.d.name) + '</strong>' +
        '<span>' + meta + '</span>' +
        '<span>' + n.deg + ' jinx' + (n.deg === 1 ? '' : 'es') + '</span>',
        at.x, at.y);
    }

    function hoverAt(ev) {
      var p = localPoint(ev);
      var n = nodeFromEvent(ev);
      if (n) { showTipFor(n, p); return; }
      var t = ev.target;
      if (t && t.classList && t.classList.contains('jg-edge')) {
        for (var i = 0; i < links.length; i++) {
          if (links[i].el === t) {
            var l = links[i];
            showTip('<strong>' + escHTML(l.a.d.name) + ' &harr; ' + escHTML(l.b.d.name) + '</strong>' +
              '<span class="jg-tip-text">' + escHTML(l.e.text) + '</span>', p.x, p.y);
            return;
          }
        }
      }
      hideTip();
    }

    // ---- public api ---------------------------------------------------
    function focus(id) {
      var n = byId[id];
      if (!n) return false;
      var s = size();
      view.k = Math.max(view.k, 1.1);
      view.x = s.w / 2 - n.x * view.k;
      view.y = s.h / 2 - n.y * view.k;
      applyView();
      select(n);
      return true;
    }

    function filter(fn) {
      nodes.forEach(function (n) { n.on = fn ? !!fn(n.d, n.deg) : true; });
      // A selection that has just been filtered out should not keep the rest
      // of the map dimmed around it.
      if (selected && !selected.on) select(null);
      else paint();
      return nodes.filter(function (n) { return n.on; }).length;
    }

    var ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      var first = true;
      ro = new ResizeObserver(function () {
        if (first) { first = false; fit(); return; }
      });
      ro.observe(mount);
    }
    fit();

    return {
      focus: focus,
      filter: filter,
      fit: fit,
      fitAll: function () { select(null); fit({ all: true }); },
      select: function (id) { return id ? focus(id) : select(null); },
      nodeCount: nodes.length,
      edgeCount: links.length,
      destroy: function () {
        document.removeEventListener('keydown', onKeyNav, true);
        if (ro) ro.disconnect();
        if (svg.parentNode) svg.parentNode.removeChild(svg);
        if (tip.parentNode) tip.parentNode.removeChild(tip);
      }
    };
  }

  if (typeof window !== 'undefined') window.mountJinxGraph = mountJinxGraph;
})();
