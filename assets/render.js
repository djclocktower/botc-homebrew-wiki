/* Shared character renderer — used by character.html (live) and create.html (preview)
   so the preview always matches what gets published. */
(function () {
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  // escape, then turn [[TEXT]] into reminder-token pills
  function tok(s) {
    return esc(s).replace(/\[\[(.+?)\]\]/g, '<span class="tok">$1</span>');
  }
  var TEAM_LABEL = {
    townsfolk: 'Townsfolk', outsider: 'Outsider', minion: 'Minion',
    demon: 'Demon', traveller: 'Traveller', fabled: 'Fabled'
  };
  function jinxURL(name) {
    return 'https://wiki.bloodontheclocktower.com/' +
      esc(name.trim().replace(/\s+/g, '_'));
  }

  function renderCharacter(d, artSrc) {
    var team = d.team || 'townsfolk';
    var label = TEAM_LABEL[team] || team;
    var bullets  = (d.summaryBullets || []).filter(function (x) { return x && x.trim(); });
    var paras    = (d.howToRun || []).filter(function (x) { return x && x.trim(); });
    var examples = (d.examples || []).filter(function (x) { return x && x.trim(); });
    var tips     = (d.tips || []).filter(function (x) { return x && x.trim(); });
    var jinxes   = (d.jinxes || []).filter(function (j) { return j && j.name && j.name.trim(); });

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

    var info = '<dl class="info"><dt>Type:</dt><dd>' + esc(label) + '</dd>' +
      (d.creator && d.creator.trim() ? '<dt>Creator:</dt><dd>' + esc(d.creator) + '</dd>' : '') +
      (d.appearsIn && d.appearsIn.trim() ? '<dt>Appears in:</dt><dd>' + esc(d.appearsIn) + '</dd>' : '') +
      (d.tags && d.tags.trim() ? '<dt>Tags:</dt><dd>' + esc(d.tags) + '</dd>' : '') +
      '</dl>';

    var quoteClean = (d.quote || '').replace(/^["']|["']$/g, '');
    var infoCard = '<div class="card char-infocard">' +
      (artSrc ? '<img class="emblem" src="' + esc(artSrc) + '" alt="' + esc(d.name) + '">' : '') +
      (quoteClean.trim() ? '<p class="quote">"' + esc(quoteClean) + '"</p>' : '') +
      '<h2 class="info-h">Information</h2>' + info + '</div>';

    var jinxCard = '';
    if (jinxes.length) {
      jinxCard = '<aside class="char-side"><div class="card">' +
        '<h2 class="gen-sech" style="text-align:center;margin-bottom:14px">Jinxes</h2>' +
        jinxes.map(function (j) {
          var al = (j.align === 'evil') ? 'evil' : 'good';
          return '<div class="jinx noicon"><div class="jbody">' +
            '<a class="jname ' + al + '" href="' + jinxURL(j.name) +
            '" target="_blank" rel="noopener noreferrer">' + esc(j.name) + '</a>' +
            '<span class="jtext">' + esc(j.text || '') + '</span></div></div>';
        }).join('') +
        '</div></aside>';
    }

    return '<h1 class="gen-title">' + esc(d.name || 'Unnamed') + '</h1>' +
      '<div class="char-layout">' +
      '<section class="char-parchment card">' +
      '<div class="cols"><div>' + summaryCol + '</div><div>' + howCol + '</div></div>' +
      examplesBlock + tipsBlock +
      '</section>' +
      infoCard + jinxCard +
      '</div>';
  }

  window.renderCharacter = renderCharacter;
  window.TEAM_LABEL = TEAM_LABEL;
})();
