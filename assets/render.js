/* Shared character renderer — used by character.html (live), the static
   character pages (JSON box only), and create.html (preview).
   Guarantees the preview/published output always match. */
(function () {
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function tok(s) {
    return esc(s).replace(/\[\[(.+?)\]\]/g, '<span class="tok">$1</span>');
  }
  var TEAM_LABEL = {
    townsfolk: 'Townsfolk', outsider: 'Outsider', minion: 'Minion',
    demon: 'Demon', traveller: 'Traveller', fabled: 'Fabled', loric: 'Loric'
  };
  function jinxURL(name) {
    return 'https://wiki.bloodontheclocktower.com/' +
      esc(String(name).trim().replace(/\s+/g, '_'));
  }
  function slugId(name) {
    return String(name || '').toLowerCase().normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '').slice(0, 50);
  }

  /* ── Build official-schema JSON object from character data ── */
  function buildSchema(d) {
    var o = {
      id: d.jsonId || slugId(d.name),
      name: d.name || '',
      team: d.team || 'townsfolk',
      ability: d.ability || ''
    };
    if (d.image) o.image = d.image;
    if (d.edition) o.edition = d.edition;
    var fl = d.flavor || d.quote;
    if (fl) o.flavor = String(fl).replace(/^["']|["']$/g, '');
    o.firstNight = Number(d.firstNight) || 0;
    o.firstNightReminder = d.firstNightReminder || '';
    o.otherNight = Number(d.otherNight) || 0;
    o.otherNightReminder = d.otherNightReminder || '';
    if (d.reminders && d.reminders.length) o.reminders = d.reminders;
    if (d.remindersGlobal && d.remindersGlobal.length) o.remindersGlobal = d.remindersGlobal;
    if (d.setup) o.setup = true;
    if (d.jinxes && d.jinxes.length) {
      var jx = d.jinxes.map(function (j) {
        return { id: j.id || slugId(j.name), reason: j.text || j.reason || '' };
      }).filter(function (j) { return j.id; });
      if (jx.length) o.jinxes = jx;
    }
    if (d.special && d.special.length) o.special = d.special;
    return o;
  }
  function schemaJSON(d) { return JSON.stringify(buildSchema(d), null, 2); }

  /* ── Collapsible JSON box ── */
  function renderJsonBox(d) {
    var json = schemaJSON(d);
    return '<div class="json-box">' +
      '<div class="json-bar">' +
      '<span class="json-bar-toggle" role="button" tabindex="0" aria-expanded="false">JSON <span class="json-arrow">&#9662;</span></span>' +
      '<button type="button" class="json-copy">Copy JSON</button>' +
      '</div>' +
      '<pre class="json-body" hidden><code>' + esc(json) + '</code></pre>' +
      '</div>';
  }

  /* ── Full character page body ── */
  function renderCharacter(d, artSrc) {
    var team = d.team || 'townsfolk';
    var label = TEAM_LABEL[team] || team;
    var bullets  = (d.summaryBullets || []).filter(function (x) { return x && x.trim(); });
    var paras    = (d.howToRun || []).filter(function (x) { return x && x.trim(); });
    var examples = (d.examples || []).filter(function (x) { return x && x.trim(); });
    var tips     = (d.tips || []).filter(function (x) { return x && x.trim(); });
    var jinxes   = (d.jinxes || []).filter(function (j) { return j && (j.name || j.id); });

    var summaryCol =
      '<div class="gen-sech-wrap"><h2 class="gen-sech">Summary</h2></div>' +
      (d.ability ? '<p class="ability">' + esc(d.ability) + '</p>' : '') +
      (d.lede ? '<p class="lede">' + esc(d.lede) + '</p>' : '') +
      (bullets.length ? '<ul>' + bullets.map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('') + '</ul>' : '');

    var howCol =
      '<div class="gen-sech-wrap"><h2 class="gen-sech">How to Run</h2></div>' +
      paras.map(function (p) { return '<p>' + tok(p) + '</p>'; }).join('') +
      (d.callout && d.callout.trim() ? '<div class="callout">' + tok(d.callout) + '</div>' : '');

    var examplesBlock = examples.length ?
      ('<div class="examples"><div class="gen-sech-wrap"><h2 class="gen-sech">Examples</h2></div>' +
        examples.map(function (e) { return '<div class="ex">' + esc(e) + '</div>'; }).join('') +
        '</div>') : '';

    var tipsBlock = tips.length ?
      ('<div class="tips"><div class="gen-sech-wrap"><h2 class="gen-sech">Tips &amp; Tricks</h2></div>' +
        '<ul>' + tips.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></div>') : '';

    var info = '<dl class="info"><dt>Type:</dt><dd><a class="type-link" href="team.html?t=' + esc(team) + '">' + esc(label) + '</a></dd>' +
      (d.creator && d.creator.trim() ? '<dt>Creator:</dt><dd>' + esc(d.creator) + '</dd>' : '') +
      (d.appearsIn && d.appearsIn.trim() ? '<dt>Appears in:</dt><dd>' + esc(d.appearsIn) + '</dd>' : '') +
      (d.tags && d.tags.trim() ? '<dt>Tags:</dt><dd>' + esc(d.tags) + '</dd>' : '') +
      '</dl>';

    var quoteClean = (d.quote || d.flavor || '').replace(/^["']|["']$/g, '');
    var infoCard = '<div class="card char-infocard">' +
      (artSrc ? '<img class="emblem" src="' + esc(artSrc) + '" alt="' + esc(d.name) + '">' : '') +
      (quoteClean.trim() ? '<p class="quote">"' + esc(quoteClean) + '"</p>' : '') +
      '<h2 class="info-h">Information</h2>' + info + '</div>';

    var jinxInner = '';
    if (jinxes.length) {
      jinxInner = '<div class="card">' +
        '<h2 class="gen-sech" style="text-align:center;margin-bottom:14px">Jinxes</h2>' +
        jinxes.map(function (j) {
          var al = (j.align === 'evil') ? 'evil' : 'good';
          var nm = j.name || j.id;
          return '<div class="jinx noicon"><div class="jbody">' +
            '<a class="jname ' + al + '" href="' + jinxURL(nm) +
            '" target="_blank" rel="noopener noreferrer">' + esc(nm) + '</a>' +
            '<span class="jtext">' + esc(j.text || j.reason || '') + '</span></div></div>';
        }).join('') +
        '</div>';
    }

    // no jinxes: fold JSON box into the infocard; with jinxes: keep sidebar
    var sideBar, infoCardFinal;
    if (jinxes.length) {
      sideBar       = '<aside class="char-side">' + jinxInner + renderJsonBox(d) + '</aside>';
      infoCardFinal = infoCard;
    } else {
      sideBar       = '';
      // strip closing </div> and append the JSON box before it
      infoCardFinal = infoCard.slice(0, -6) +
        '<div style="margin-top:14px">' + renderJsonBox(d) + '</div></div>';
    }

    return '<h1 class="gen-title">' + esc(d.name || 'Unnamed') + '</h1>' +
      '<div class="char-layout">' +
      '<section class="char-parchment card">' +
      '<div class="cols"><div>' + summaryCol + '</div><div>' + howCol + '</div></div>' +
      examplesBlock + tipsBlock +
      '</section>' +
      infoCardFinal + sideBar +
      '</div>';
  }

  /* ── one-time delegated handlers for JSON box toggle + copy ── */
  if (typeof document !== 'undefined' && !window.__jsonBoxBound) {
    window.__jsonBoxBound = true;
    document.addEventListener('click', function (e) {
      var tg = e.target.closest && e.target.closest('.json-bar-toggle');
      if (tg) {
        var box = tg.closest('.json-box');
        var open = box.classList.toggle('open');
        tg.setAttribute('aria-expanded', open ? 'true' : 'false');
        box.querySelector('.json-body').hidden = !open;
        return;
      }
      var cp = e.target.closest && e.target.closest('.json-copy');
      if (cp) {
        var b = cp.closest('.json-box');
        var txt = b.querySelector('code').textContent;
        if (navigator.clipboard) {
          navigator.clipboard.writeText(txt).then(function () {
            cp.textContent = 'Copied!'; setTimeout(function () { cp.textContent = 'Copy JSON'; }, 1500);
          }, function () {
            cp.textContent = 'Copy failed'; setTimeout(function () { cp.textContent = 'Copy JSON'; }, 1500);
          });
        }
      }
    });
  }

  window.renderCharacter = renderCharacter;
  window.renderJsonBox = renderJsonBox;
  window.buildSchema = buildSchema;
  window.schemaJSON = schemaJSON;
  window.slugId = slugId;
  window.TEAM_LABEL = TEAM_LABEL;
})();
