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
  function R() { return (typeof window !== 'undefined' && window.LINK_ROOT) || ''; }
  function jinxURL(name) {
    return 'https://wiki.bloodontheclocktower.com/' +
      esc(String(name).trim().replace(/\s+/g, '_'));
  }
  // Map known slugified IDs back to proper display names for jinx links
  var JINX_ID_NAMES = {
    'alhadikhia':'Al-Hadikhia','eviltwin':'Evil Twin','lilmonsta':"Lil' Monsta",
    'organgrinder':'Organ Grinder','pithag':'Pit-Hag','plaguedoctor':'Plague Doctor',
    'poppygrower':'Poppy Grower','scarletwoman':'Scarlet Woman',
    'snakecharmer':'Snake Charmer','villageidiot':'Village Idiot',
    'banxian_festival_of_lanterns':'Ban Xian','pedant_festival_of_lanterns':'Pedant'
  };
  function jinxDisplayName(j) {
    if (j.name && j.name.trim()) return j.name.trim();
    var id = j.id || '';
    if (JINX_ID_NAMES[id]) return JINX_ID_NAMES[id];
    // Fallback: capitalise first letter
    return id ? id[0].toUpperCase() + id.slice(1) : id;
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
    // image as array (required by official script tool)
    if (d.image) o.image = Array.isArray(d.image) ? d.image : [d.image];
    if (d.edition) o.edition = d.edition;
    var fl = d.flavor || d.quote;
    if (fl) o.flavor = String(fl).replace(/^["']|["']$/g, '');
    o.firstNight = Number(d.firstNight) || 0;
    if (d.firstNightReminder) o.firstNightReminder = d.firstNightReminder;
    o.otherNight = Number(d.otherNight) || 0;
    if (d.otherNightReminder) o.otherNightReminder = d.otherNightReminder;
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
  function schemaJSON(d) {
    var meta = { id: '_meta', name: '' };
    return JSON.stringify([meta, buildSchema(d)], null, 2);
  }

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
    var bluffing = (d.bluffing || []).filter(function (x) { return x && x.trim(); });
    var fighting = (d.fighting || []).filter(function (x) { return x && x.trim(); });
    var jinxes   = (d.jinxes || []).filter(function (j) { return j && (j.name || j.id); });

    var summaryCol =
      '<div class="gen-sech-wrap" id="sec-summary"><h2 class="gen-sech"><a class="sec-anchor" href="#sec-summary">Summary</a></h2></div>' +
      (d.ability ? '<p class="ability">' + esc(d.ability) + '</p>' : '') +
      (d.lede ? '<p class="lede">' + esc(d.lede) + '</p>' : '') +
      (bullets.length ? '<ul>' + bullets.map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('') + '</ul>' : '');

    var howColBody = paras.map(function (p) { return '<p>' + tok(p) + '</p>'; }).join('') +
      (d.callout && d.callout.trim() ? '<div class="callout">' + tok(d.callout) + '</div>' : '');
    var howCol = howColBody ?
      '<div class="gen-sech-wrap" id="sec-howtorun"><h2 class="gen-sech"><a class="sec-anchor" href="#sec-howtorun">How to Run</a></h2></div>' + howColBody : '';

    var examplesBlock = examples.length ?
      ('<div class="examples"><div class="gen-sech-wrap" id="sec-examples"><h2 class="gen-sech"><a class="sec-anchor" href="#sec-examples">Examples</a></h2></div>' +
        examples.map(function (e) { return '<div class="ex">' + esc(e) + '</div>'; }).join('') +
        '</div>') : '';

    var tipsBlock = tips.length ?
      ('<div class="tips"><div class="gen-sech-wrap" id="sec-tips"><h2 class="gen-sech"><a class="sec-anchor" href="#sec-tips">Tips &amp; Tricks</a></h2></div>' +
        '<ul>' + tips.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></div>') : '';

    var charName = esc(d.name || 'Character');
    var bluffingBlock = bluffing.length ?
      ('<div class="tips"><div class="gen-sech-wrap"><h2 class="gen-sech">Bluffing as the ' + charName + '</h2></div>' +
        '<ul>' + bluffing.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></div>') : '';
    var fightingBlock = fighting.length ?
      ('<div class="tips"><div class="gen-sech-wrap"><h2 class="gen-sech">Fighting the ' + charName + '</h2></div>' +
        '<ul>' + fighting.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></div>') : '';

    var info = '<dl class="info"><dt>Type:</dt><dd><a class="type-link" href="' + R() + 'team.html?t=' + esc(team) + '">' + esc(label) + '</a></dd>' +
      (d.creator && d.creator.trim() ? '<dt>Creator:</dt><dd><a class="author-link" href="' + R() + 'author.html?a=' + encodeURIComponent(d.creator.trim()) + '">' + esc(d.creator.trim()) + '</a></dd>' : '') +
      (d.appearsIn && d.appearsIn.trim() ? '<dt>Appears in:</dt><dd>' + esc(d.appearsIn) + '</dd>' : '') +
      (d.tags && d.tags.trim() ? '<dt>Tags:</dt><dd>' + d.tags.split(',').map(function(t){
        t = t.trim(); if(!t) return '';
        var display = t.replace(/\w\S*/g, function(w){ return w.charAt(0).toUpperCase()+w.slice(1).toLowerCase(); });
        return '<a class="tag-link" href="' + R() + 'tag.html?t='+encodeURIComponent(display)+'">'+esc(display)+'</a>';
      }).filter(Boolean).join('<span class="tag-sep">, </span>') + '</dd>' : '') +
      (d.translatedBy && d.translatedBy.trim() ? '<dt>Translated by:</dt><dd>' + esc(d.translatedBy.trim()) + '</dd>' : '') +
      (d.iconBy && d.iconBy.trim() ? '<dt>Icon by:</dt><dd>' + esc(d.iconBy.trim()) + '</dd>' : '') +
      '</dl>';

    var quoteClean = (d.quote || d.flavor || '').replace(/^["']|["']$/g, '');
    var infoCard = '<div class="card char-infocard">' +
      (artSrc ? '<img class="emblem" src="' + esc(artSrc) + '" alt="' + esc(d.name) + '">' : '') +
      (quoteClean.trim() ? '<p class="quote">"' + esc(quoteClean) + '"</p>' : '') +
      '<h2 class="info-h">Information</h2>' + info + '</div>';

    var jinxInner = '';
    if (jinxes.length) {
      jinxInner = '<div class="card" id="sec-jinxes">' +
        '<h2 class="gen-sech" style="text-align:center;margin-bottom:14px"><a class="sec-anchor" href="#sec-jinxes">Jinxes</a></h2>' +
        jinxes.map(function (j) {
          var al = (j.align === 'evil') ? 'evil' : 'good';
          var nm = jinxDisplayName(j);
          var rawId = j.id || slugId(j.name || '');
          var iconId = rawId.replace(/_festival_of_lanterns$/, '').replace(/-/g, '');
          var iconSrc = (window.LINK_ROOT || '') + 'assets/icons/' + iconId + '.png';
          return '<div class="jinx' + (iconId ? '' : ' noicon') + '">' +
            (iconId ? '<img class="jico" src="' + iconSrc + '" alt=""' +
            ' onerror="this.style.display=\'none\';this.closest(\'.jinx\').classList.add(\'noicon\')">'
            : '') +
            '<div class="jbody">' +
            '<a class="jname ' + al + '" href="' + jinxURL(nm) +
            '" target="_blank" rel="noopener noreferrer">' + esc(nm) + '</a>' +
            '<span class="jtext">' + esc(j.text || j.reason || '') + '</span></div></div>';
        }).join('') +
        '</div>';
    }

    // JSON box always lives inside the infocard, below the info dl
    // jinxes (if any) go in the sidebar on their own
    var sideBar = jinxes.length ? '<aside class="char-side">' + jinxInner + '</aside>' : '';
    var infoCardFinal = infoCard.slice(0, -6) +
      '<div style="margin-top:14px">' + renderJsonBox(d) + '</div></div>';

    return '<div class="title-row"><h1 class="gen-title">' + esc(d.name || 'Unnamed') + '</h1>' +
      '<button type="button" class="copy-link-btn" title="Copy link to this character" aria-label="Copy link"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg> Copy link</button></div>' +
      '<div class="char-layout">' +
      '<section class="char-parchment card">' +
      (summaryCol || howCol ? '<div class="cols">' + (summaryCol ? '<div>' + summaryCol + '</div>' : '') + (howCol ? '<div>' + howCol + '</div>' : '') + '</div>' : '') +
      examplesBlock + tipsBlock + bluffingBlock + fightingBlock +
      '</section>' +
      '<div class="char-col2">' + infoCardFinal + sideBar + '</div>' +
      '</div>';
  }

  /* ── one-time delegated handlers for JSON box toggle + copy ── */
  if (typeof document !== 'undefined' && !window.__jsonBoxBound) {
    window.__jsonBoxBound = true;
    document.addEventListener('click', function (e) {
      // Copy-link button
      var cl = e.target.closest && e.target.closest('.copy-link-btn');
      if (cl) {
        var url = location.href.split('#')[0];
        if (navigator.clipboard) {
          navigator.clipboard.writeText(url).then(function () {
            cl.innerHTML = '\u2713 Copied!';
            setTimeout(function () { cl.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg> Copy link'; }, 1500);
          });
        }
        return;
      }
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

// nudge redeploy
