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
    // image as array (required by official script tool); alternate art
    // (e.g. an evil version) rides along as the second entry
    var imgs = d.image ? (Array.isArray(d.image) ? d.image.slice() : [d.image]) : [];
    if (d.imageAlt && imgs.indexOf(d.imageAlt) === -1) imgs.push(d.imageAlt);
    if (imgs.length) o.image = imgs;
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

  /* ── Find jinxes that are active between characters on the same script ──
     Takes an array of character objects; returns [{a, b, text}] where `a`
     carries the jinx and `b` is the matching character also in the list. */
  function normJinxId(id) {
    return String(id || '').replace(/_festival_of_lanterns$/, '')
      .toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  function findScriptJinxes(chars) {
    var byId = {};
    chars.forEach(function (c) {
      [slugId(c.name), normJinxId(c.jsonId), (c.slug || '').replace(/-/g, '')]
        .forEach(function (id) { if (id) byId[id] = c; });
    });
    var out = [], seen = {};
    chars.forEach(function (c) {
      (c.jinxes || []).forEach(function (j) {
        var target = byId[normJinxId(j.id || slugId(j.name || ''))];
        if (!target || target === c) return;
        var text = j.text || j.reason || '';
        var key = [c.slug || c.name, target.slug || target.name].sort().join('|') + '|' + text;
        if (seen[key]) return;
        seen[key] = 1;
        out.push({ a: c, b: target, text: text });
      });
    });
    return out;
  }

  /* ── Collapsible JSON box ── */
  function renderJsonBox(d) {
    // A user-supplied custom JSON replaces the auto-generated schema.
    var json;
    if (d.customJson && String(d.customJson).trim()) {
      var raw = String(d.customJson).trim();
      try { json = JSON.stringify(JSON.parse(raw), null, 2); }
      catch (e) { json = raw; }
    } else {
      json = schemaJSON(d);
    }
    return '<div class="json-box">' +
      '<div class="json-bar">' +
      '<span class="json-bar-toggle" role="button" tabindex="0" aria-expanded="false">JSON <span class="json-arrow">&#9662;</span></span>' +
      '<button type="button" class="json-copy">Copy JSON</button>' +
      '</div>' +
      '<pre class="json-body" hidden><code>' + esc(json) + '</code></pre>' +
      '</div>';
  }

  /* ── Full character page body ── */
  function renderCharacter(d, artSrc, linkRoot) {
    var root = (linkRoot != null) ? linkRoot
      : ((typeof window !== 'undefined' && window.LINK_ROOT) || '');
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

    var info = '<dl class="info"><dt>Type:</dt><dd><a class="type-link" href="' + root + 'team?t=' + esc(team) + '">' + esc(label) + '</a></dd>' +
      (d.creator && d.creator.trim() ? '<dt>Creator:</dt><dd><a class="author-link" href="' + root + 'author?a=' + encodeURIComponent(d.creator.trim()) + '">' + esc(d.creator.trim()) + '</a></dd>' : '') +
      (d.appearsIn && d.appearsIn.trim() ? '<dt>Appears in:</dt><dd>' + esc(d.appearsIn) + '</dd>' : '') +
      (d.tags && d.tags.trim() ? '<dt>Tags:</dt><dd>' + d.tags.split(',').map(function(t){
        t = t.trim(); if(!t) return '';
        var display = t.toLowerCase().replace(/(^|[\s-])[a-z]/g, function(m){ return m.toUpperCase(); });
        return '<a class="tag-link" data-tag="' + esc(display) + '" href="' + root + 'tag?t='+encodeURIComponent(display)+'">'+esc(display)+'</a>';
      }).filter(Boolean).join('<span class="tag-sep">, </span>') + '</dd>' : '') +
      (d.translatedBy && d.translatedBy.trim() ? '<dt>Translated by:</dt><dd>' + esc(d.translatedBy.trim()) + '</dd>' : '') +
      (d.iconBy && d.iconBy.trim() ? '<dt>Icon by:</dt><dd>' + esc(d.iconBy.trim()) + '</dd>' : '') +
      '</dl>';

    // Copy-link button lives in the top-right corner *inside* the info card so
    // it never crowds the title (see .card-actions in styles.css).
    var copyBtn = '<button type="button" class="copy-link-btn" title="Copy link to this character" aria-label="Copy link"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg> Copy link</button>';

    var quoteClean = (d.quote || d.flavor || '').replace(/^["']|["']$/g, '');
    // Alternate art (e.g. an evil version): click the emblem to swap.
    var altSrc = d.artAlt ? (root + 'assets/' + d.artAlt) : (d.imageAlt || '');
    var emblem = '';
    if (artSrc) {
      emblem = altSrc
        ? '<img class="emblem has-alt" src="' + esc(artSrc) + '" data-main="' + esc(artSrc) +
          '" data-alt="' + esc(altSrc) + '" alt="' + esc(d.name) + '" title="Click to see the alternate art">' +
          '<span class="alt-art-hint">Click art to see alternate version</span>'
        : '<img class="emblem" src="' + esc(artSrc) + '" alt="' + esc(d.name) + '">';
    }
    var infoCard = '<div class="card char-infocard">' +
      '<div class="card-actions">' + copyBtn + '</div>' +
      emblem +
      (quoteClean.trim() ? '<p class="quote">"' + esc(quoteClean) + '"</p>' : '') +
      '<h2 class="info-h">Information</h2>' + info + '</div>';

    // Shared jinx item markup, used by both the sidebar box and the dropdown.
    var jinxItems = jinxes.map(function (j) {
      var al = (j.align === 'evil') ? 'evil' : 'good';
      var nm = jinxDisplayName(j);
      var rawId = j.id || slugId(j.name || '');
      var iconId = rawId.replace(/_festival_of_lanterns$/, '').replace(/-/g, '');
      var iconSrc = root + 'assets/icons/' + iconId + '.png';
      return '<div class="jinx' + (iconId ? '' : ' noicon') + '">' +
        (iconId ? '<img class="jico" src="' + iconSrc + '" alt=""' +
        ' onerror="this.style.display=\'none\';this.closest(\'.jinx\').classList.add(\'noicon\')">'
        : '') +
        '<div class="jbody">' +
        '<a class="jname ' + al + '" href="' + jinxURL(nm) +
        '" target="_blank" rel="noopener noreferrer">' + esc(nm) + '</a>' +
        '<span class="jtext">' + esc(j.text || j.reason || '') + '</span></div></div>';
    }).join('');

    // Two ways to show jinxes: a floating box in the sidebar (default) or a
    // collapsible dropdown at the foot of the main column. Chosen per-character.
    var jinxMode = (d.jinxDisplay === 'dropdown') ? 'dropdown' : 'sidebar';
    var jinxCard = jinxes.length ?
      '<div class="card" id="sec-jinxes">' +
        '<h2 class="gen-sech" style="text-align:center;margin-bottom:14px"><a class="sec-anchor" href="#sec-jinxes">Jinxes</a></h2>' +
        jinxItems +
      '</div>' : '';
    var jinxDrop = jinxes.length ?
      '<div class="jinx-drop" id="sec-jinxes">' +
        '<div class="jinx-drop-bar" role="button" tabindex="0" aria-expanded="false">' +
          '<span class="jinx-drop-title">Jinxes</span>' +
          '<span class="jinx-drop-arrow">&#9662;</span>' +
        '</div>' +
        '<div class="jinx-drop-body" hidden>' + jinxItems + '</div>' +
      '</div>' : '';

    // Custom user-defined sidebar boxes: any number of {title, content}.
    var customBoxesHtml = (d.customBoxes || []).map(function (b) {
      var title = String((b && b.title) || '').trim();
      var content = String((b && b.content) || '');
      if (!title && !content.trim()) return '';
      var body = content.split(/\n{2,}/).map(function (p) {
        p = p.replace(/\s+$/, '');
        return p.trim() ? '<p>' + tok(p).replace(/\n/g, '<br>') + '</p>' : '';
      }).join('');
      return '<div class="card custom-box">' +
        (title ? '<h2 class="info-h custom-box-h">' + esc(title) + '</h2>' : '') +
        '<div class="custom-box-body">' + body + '</div>' +
      '</div>';
    }).join('');

    // JSON box always lives inside the infocard, below the info dl.
    // The sidebar carries the jinx box (unless dropdown mode) + custom boxes.
    var sideItems = (jinxMode === 'sidebar' ? jinxCard : '') + customBoxesHtml;
    var sideBar = sideItems ? '<aside class="char-side">' + sideItems + '</aside>' : '';
    var infoCardFinal = infoCard.slice(0, -6) +
      '<div style="margin-top:14px">' + renderJsonBox(d) + '</div></div>';

    // Title auto-fits to its width: --nch (letter count, spaces collapsed) drives
    // a fluid font-size in .gen-title so short names grow large and long names
    // shrink to fill the same width without overlapping. See styles.css.
    var titleName = d.name || 'Unnamed';
    var nch = Math.max(String(titleName).replace(/\s+/g, ' ').trim().length, 4);

    return '<div class="title-row"><h1 class="gen-title" style="--nch:' + nch + '">' + esc(titleName) + '</h1></div>' +
      '<div class="char-layout">' +
      '<section class="char-parchment card">' +
      (summaryCol || howCol ? '<div class="cols">' + (summaryCol ? '<div>' + summaryCol + '</div>' : '') + (howCol ? '<div>' + howCol + '</div>' : '') + '</div>' : '') +
      examplesBlock + tipsBlock + bluffingBlock + fightingBlock +
      (jinxMode === 'dropdown' ? jinxDrop : '') +
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
      // Alternate-art emblem: click to swap between the two versions
      var em = e.target.closest && e.target.closest('.emblem.has-alt');
      if (em) {
        var showingAlt = em.getAttribute('src') === em.getAttribute('data-alt');
        em.setAttribute('src', showingAlt ? em.getAttribute('data-main') : em.getAttribute('data-alt'));
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
      var jd = e.target.closest && e.target.closest('.jinx-drop-bar');
      if (jd) {
        var jbox = jd.closest('.jinx-drop');
        var jopen = jbox.classList.toggle('open');
        jd.setAttribute('aria-expanded', jopen ? 'true' : 'false');
        jbox.querySelector('.jinx-drop-body').hidden = !jopen;
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
    // Keyboard toggle for the collapsible jinx dropdown (Enter / Space).
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      var jd = e.target.closest && e.target.closest('.jinx-drop-bar');
      if (!jd) return;
      e.preventDefault();
      var jbox = jd.closest('.jinx-drop');
      var jopen = jbox.classList.toggle('open');
      jd.setAttribute('aria-expanded', jopen ? 'true' : 'false');
      jbox.querySelector('.jinx-drop-body').hidden = !jopen;
    });
  }

  if (typeof window !== 'undefined') {
    window.renderCharacter = renderCharacter;
    window.renderJsonBox = renderJsonBox;
    window.buildSchema = buildSchema;
    window.schemaJSON = schemaJSON;
    window.slugId = slugId;
    window.TEAM_LABEL = TEAM_LABEL;
    window.findScriptJinxes = findScriptJinxes;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      renderCharacter: renderCharacter, renderJsonBox: renderJsonBox,
      buildSchema: buildSchema, schemaJSON: schemaJSON,
      slugId: slugId, TEAM_LABEL: TEAM_LABEL,
      findScriptJinxes: findScriptJinxes
    };
  }
})();

// nudge redeploy
// nudge build 2026-07-02
