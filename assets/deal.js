/* deal.js: "Deal a Game" — draw a legal bag from a script and lay it out as
 * a grimoire.
 *
 * Pick a player count, and this draws the Demon, the Minions, the Outsiders
 * and the Townsfolk the way a Storyteller would: the official setup sheet for
 * the counts, every [+1 Outsider] on a character in play applied to them, a
 * [+the King] honoured, and three Demon bluffs from the good characters left
 * in the box. What it cannot simulate ([Most players are Legion]) is said word
 * for word under the circle rather than silently ignored. The rules are all
 * in assets/setup-rules.js; this file is the picture.
 *
 * Mounted in two places, with the roster handed in rather than fetched:
 *   - a published script page (/s/), where pageview.js reads the roster rows
 *     the page already drew (render-page.js stamps data-team / data-slug on
 *     them) and loads this file only when the reader opens the panel;
 *   - the Script Builder, over its own roster.
 *
 * Deal.mount(el, {getRoster, name}) -> {render, deal}
 *   getRoster() returns [{slug, name, team, ability, icon, href, official}].
 * Nothing is stored anywhere: every deal is a fresh draw, and the player
 * count is remembered for this browser only (localStorage botc_deal_players).
 * Styles are .dl-* in assets/play.css.
 */
(function () {
  'use strict';

  var TEAM_LABEL = { townsfolk: 'Townsfolk', outsider: 'Outsider', minion: 'Minion', demon: 'Demon' };
  var GOOD = { townsfolk: true, outsider: true };
  var PLAYERS_KEY = 'botc_deal_players';

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function storedPlayers() {
    try {
      var n = parseInt(localStorage.getItem(PLAYERS_KEY), 10);
      return n >= 5 && n <= 15 ? n : 10;
    } catch (e) { return 10; }
  }
  function storePlayers(n) { try { localStorage.setItem(PLAYERS_KEY, String(n)); } catch (e) { /* private window */ } }

  function tokenHTML(c, i, extraClass) {
    return '<button type="button" class="dl-tok dl-' + esc(c.team) + (extraClass ? ' ' + extraClass : '') + '" data-i="' + i + '"' +
      ' aria-label="' + esc(c.name + ', ' + (TEAM_LABEL[c.team] || c.team)) + '">' +
      '<span class="dl-tok-disc">' + (c.icon ? '<img src="' + esc(c.icon) + '" alt="" decoding="async" draggable="false" onerror="this.style.visibility=\'hidden\'">' : '<span class="dl-tok-letter">' + esc(String(c.name || '?').charAt(0)) + '</span>') + '</span>' +
      '<span class="dl-tok-name">' + esc(c.name) + '</span>' +
      '</button>';
  }

  function mount(el, o) {
    o = o || {};
    var players = storedPlayers();
    var last = null;          // the current deal
    var picked = -1;          // which seat's details are showing in the middle

    el.innerHTML =
      '<div class="dl">' +
        '<div class="dl-controls">' +
          '<span class="dl-count-label" id="dl-count-label">Players</span>' +
          '<span class="dl-stepper" role="group" aria-labelledby="dl-count-label">' +
            '<button type="button" class="dl-step" data-step="-1" aria-label="Fewer players">−</button>' +
            '<output class="dl-count" aria-live="polite">' + players + '</output>' +
            '<button type="button" class="dl-step" data-step="1" aria-label="More players">+</button>' +
          '</span>' +
          '<button type="button" class="dl-btn dl-deal">⚄ Deal</button>' +
          '<button type="button" class="dl-btn dl-copy" hidden>⧉ Copy as text</button>' +
        '</div>' +
        '<div class="dl-out"></div>' +
      '</div>';
    var out = el.querySelector('.dl-out');
    var countEl = el.querySelector('.dl-count');

    function roster() {
      var r = typeof o.getRoster === 'function' ? o.getRoster() : [];
      return Array.isArray(r) ? r : [];
    }

    function centre() {
      var d = last;
      if (!d) return '';
      var c = picked >= 0 ? (picked >= 1000 ? d.bluffs[picked - 1000] : d.seats[picked]) : null;
      if (!c) {
        var cn = d.counts;
        return '<div class="dl-centre-summary">' +
          '<span class="dl-centre-big">' + d.players + ' players</span>' +
          '<span class="dl-centre-line"><b class="dl-c-good">' + cn.townsfolk + '</b> Townsfolk · <b class="dl-c-good">' + cn.outsider + '</b> Outsider' + (cn.outsider === 1 ? '' : 's') + '</span>' +
          '<span class="dl-centre-line"><b class="dl-c-evil">' + cn.minion + '</b> Minion' + (cn.minion === 1 ? '' : 's') + ' · <b class="dl-c-evil">' + cn.demon + '</b> Demon' + (cn.demon === 1 ? '' : 's') + '</span>' +
          '<span class="dl-centre-hint">Tap a token to read it</span>' +
          '</div>';
      }
      var link = c.href ? '<a class="dl-centre-link" href="' + esc(c.href) + '"' + (c.official ? ' target="_blank" rel="noopener"' : '') + '>Open page' + (c.official ? ' ↗' : ' →') + '</a>' : '';
      return '<div class="dl-centre-detail">' +
        '<span class="dl-centre-name ' + (GOOD[c.team] ? 'dl-c-good' : 'dl-c-evil') + '">' + esc(c.name) + '</span>' +
        '<span class="dl-centre-team">' + esc(TEAM_LABEL[c.team] || c.team) + (picked >= 1000 ? ' · bluff' : '') + '</span>' +
        '<span class="dl-centre-ability">' + esc(c.ability || '') + '</span>' + link +
        '</div>';
    }

    function paint() {
      var d = last;
      if (!d) { out.innerHTML = ''; return; }
      var n = d.seats.length;
      if (!n) {
        out.innerHTML = '<p class="dl-empty">This script has no Demon, Minion, Outsider or Townsfolk to deal.</p>';
        return;
      }
      // Token size: the ring's circumference shared between the seats, with
      // room to spare, as a percentage of the circle's own width. The ring
      // sits at 40% of the width from the centre.
      var tok = Math.max(9, Math.min(17, (2 * Math.PI * 40) / n * 0.78));
      var h = '<div class="dl-grim' + (n <= 10 ? ' dl-labelled' : '') + '" style="--tok:' + tok.toFixed(2) + '%">';
      d.seats.forEach(function (c, i) {
        var ang = (-90 + 360 * i / n) * Math.PI / 180;
        var x = 50 + 40 * Math.cos(ang), y = 50 + 40 * Math.sin(ang);
        h += tokenHTML(c, i, (picked === i ? 'on' : '')).replace('<button ', '<button style="left:' + x.toFixed(2) + '%;top:' + y.toFixed(2) + '%" ');
      });
      h += '<div class="dl-centre">' + centre() + '</div></div>';

      if (d.bluffs.length) {
        h += '<div class="dl-bluffs"><span class="dl-bluffs-label">Demon bluffs</span><div class="dl-bluff-row">' +
          d.bluffs.map(function (c, i) { return tokenHTML(c, 1000 + i, 'dl-bluff' + (picked === 1000 + i ? ' on' : '')); }).join('') +
          '</div></div>';
      }
      var lines = [];
      d.short.forEach(function (s) {
        lines.push('<li class="dl-warn">Not enough ' + esc(window.SetupRules.PLURAL[s.team]) + ': the bag needs ' + s.want + ' and the script has ' + s.have + '.</li>');
      });
      d.applied.forEach(function (a) { lines.push('<li>' + esc(a) + '</li>'); });
      d.notes.forEach(function (a) { lines.push('<li class="dl-note">' + esc(a) + '</li>'); });
      if (lines.length) h += '<ul class="dl-notes">' + lines.join('') + '</ul>';
      out.innerHTML = h;
    }

    function asText() {
      var d = last;
      if (!d) return '';
      var byTeam = function (t) { return d.seats.filter(function (c) { return c.team === t; }).map(function (c) { return c.name; }).join(', ') || '(none)'; };
      var lines = [(o.name ? o.name + ' — ' : '') + d.players + ' players',
        'Townsfolk: ' + byTeam('townsfolk'), 'Outsiders: ' + byTeam('outsider'),
        'Minions: ' + byTeam('minion'), 'Demon: ' + byTeam('demon')];
      if (d.bluffs.length) lines.push('Bluffs: ' + d.bluffs.map(function (c) { return c.name; }).join(', '));
      d.applied.forEach(function (a) { lines.push(a); });
      return lines.join('\n');
    }

    function deal() {
      if (!window.SetupRules) return;
      last = window.SetupRules.deal(roster(), players);
      picked = -1;
      paint();
      el.querySelector('.dl-copy').hidden = !last || !last.seats.length;
    }

    el.addEventListener('click', function (e) {
      var step = e.target.closest('.dl-step');
      if (step) {
        players = Math.max(5, Math.min(15, players + Number(step.getAttribute('data-step'))));
        countEl.textContent = players;
        storePlayers(players);
        deal();
        return;
      }
      if (e.target.closest('.dl-deal')) { deal(); return; }
      var copy = e.target.closest('.dl-copy');
      if (copy) {
        var text = asText();
        var done = function () { copy.textContent = '✓ Copied'; setTimeout(function () { copy.textContent = '⧉ Copy as text'; }, 1500); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { window.prompt('Copy this setup:', text); });
        else window.prompt('Copy this setup:', text);
        return;
      }
      var tok = e.target.closest('.dl-tok');
      if (tok) {
        var i = Number(tok.getAttribute('data-i'));
        picked = picked === i ? -1 : i;
        paint();
        var again = out.querySelector('.dl-tok[data-i="' + i + '"]');
        if (again && picked === i) again.focus();
        return;
      }
      // A tap on the middle of the circle goes back to the summary.
      if (e.target.closest('.dl-centre') && !e.target.closest('a') && picked !== -1) { picked = -1; paint(); }
    });

    deal();
    return { render: deal, deal: deal };
  }

  /* The roster a published script page already drew. Only the four bag teams
     matter; the page lists Travellers and Fabled too and those are skipped
     by the dealer. The thumbnail the row shows is the token's icon. */
  function rosterFromPage(doc) {
    doc = doc || document;
    var out = [];
    doc.querySelectorAll('.script-char-row[data-team]').forEach(function (row) {
      var nameEl = row.querySelector('.script-char-name');
      var name = nameEl ? nameEl.cloneNode(true) : null;
      if (name) name.querySelectorAll('.script-char-off').forEach(function (x) { x.remove(); });
      var img = row.querySelector('img');
      var abil = row.querySelector('.script-char-ability');
      out.push({
        slug: row.getAttribute('data-slug') || '',
        team: row.getAttribute('data-team') || '',
        name: name ? name.textContent.trim() : '',
        ability: abil ? abil.textContent.trim() : '',
        icon: img ? (img.currentSrc || img.getAttribute('src') || '') : '',
        href: row.getAttribute('href') || '',
        official: row.getAttribute('target') === '_blank'
      });
    });
    return out;
  }

  window.Deal = { mount: mount, rosterFromPage: rosterFromPage };
})();
