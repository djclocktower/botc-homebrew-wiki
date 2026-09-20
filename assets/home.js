/* Homepage presentation. Dependencies are deferred in document order. */

  /* ── News panel ──────────────────────────────────────────────
     Shows the three most recent published articles. The whole section
     stays hidden while there are none. */
  (function(){
    var sec = document.getElementById('news-section');
    var grid = document.getElementById('news-grid');
    if (!sec || !grid) return;
    BotcData.json('/api/news?limit=3&format=cards')
      .then(function(d){
        if (!d || !d.html) return;
        grid.innerHTML = d.html;
        sec.hidden = false;
      })
      .catch(function(){ /* no news, no panel */ });
  })();
  

  (function(){
    var TEAM_LABEL = {
      townsfolk: 'Townsfolk', outsider: 'Outsider', minion: 'Minion',
      demon: 'Demon', traveller: 'Traveller', fabled: 'Fabled', loric: 'Loric'
    };
    var GOOD = { townsfolk: 1, outsider: 1 };

    function esc(s){
      return String(s == null ? '' : s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
    function collectionTileHTML(name, id, count, icons, header, tagline, coll){
      var href = 'collection/' + encodeURIComponent(id);
      // Header image, then the author's logo, then the scatter of member
      // icons — the logo beats the scatter, and matches what the collection's
      // own page shows at the top.
      var banner = header || (coll && coll.logo);
      var topHTML = banner
        ? '<div class="collection-tile-header"><img loading="lazy" decoding="async" src="' + esc(PageRender.imgSrc('', banner, coll.v)) + '"' + PageRender.responsiveAttrs('', banner, coll.v, '(max-width: 640px) 94vw, 320px') + ' alt="' + esc(name) + '"></div>'
        : '<div class="collection-icons">' + icons.map(function(c){ return '<img loading="lazy" decoding="async" class="collection-icon" src="' + esc(PageRender.thumbSrc(c, '')) + '" onerror="this.src=\'assets/favicon.png\'" alt="">'; }).join('') + '</div>';
      return '<a class="collection-tile" href="' + esc(href) + '">' +
        topHTML +
        '<h3 class="collection-name">' + esc(name) + '</h3>' +
        (tagline ? '<p class="collection-tile-tagline">' + esc(tagline) + '</p>' : '') +
        '<div class="collection-footer">' +
          // Same footer shape as the script tiles below: count, then who made
          // it, then the Curata wreath behind a hairline.
          '<span class="collection-count">' + count + ' character' + (count===1?'':'s') +
            ((coll && coll.author) ? ' · ' + esc(coll.author) : '') +
            ((coll && coll.curata) ? window.classBadgeHTML('curata', { sep: true }) : '') + '</span>' +
          '<span class="collection-arrow">Browse →</span>' +
        '</div>' +
      '</a>';
    }

    function recentCardHTML(c){
      var tc = GOOD[c.team] ? ' good' : '';
      var label = TEAM_LABEL[c.team] || c.team;
      return '<a class="recent-card" href="' + esc(c.page) + '">' +
        '<img loading="lazy" decoding="async" class="recent-thumb" src="' + esc(PageRender.thumbSrc(c, '')) + '" onerror="this.src=\'assets/favicon.png\'" alt="">' +
        '<div class="recent-name">' + esc(c.name) + '</div>' +
        '<div class="recent-type' + tc + '">' + esc(label) + '</div>' +
      '</a>';
    }

    // The server picks the daily feature; only presentation happens here.
    function featuredCardHTML(c){
      var tc = GOOD[c.team] ? ' good' : '';
      var label = TEAM_LABEL[c.team] || c.team;
      var lede = c.plainLede || '';
      var ability = c.ability || '';
      var creator = c.creator || '';
      var appears = c.appearsIn || '';
      return '<a class="featured-card" href="' + esc(c.page) + '">' +
        '<img loading="lazy" decoding="async" width="260" height="260" class="featured-art" src="' + esc(PageRender.artSrc(c, '')) + '" alt="' + esc(c.name) + '">' +
        '<div class="featured-body">' +
          '<div class="featured-type' + tc + '">' + esc(label) + '</div>' +
          '<h3 class="featured-name">' + esc(c.name) +
            (c.curata ? window.classBadgeHTML('curata', { from: c.curataFrom }) : '') + '</h3>' +
          (lede ? '<p class="featured-lede">' + esc(lede) + '</p>' : '') +
          (ability ? '<p class="featured-ability">' + esc(ability) + '</p>' : '') +
          '<div class="featured-meta">' +
            (creator ? '<span>by ' + esc(creator) + '</span>' : '') +
            (appears ? '<span>· ' + esc(appears) + '</span>' : '') +
          '</div>' +
          '<span class="featured-link">View Full Page →</span>' +
        '</div>' +
      '</a>';
    }

    BotcData.json('/api/home').then(function(data){
      var stats = data.stats;
      document.getElementById('landing-stats').textContent = stats.characters + ' characters · ' + stats.collections + ' collections · ' + stats.creators + ' creators · ' + stats.scripts + ' scripts';
      document.getElementById('bc-team').textContent = stats.characters + ' characters';
      document.getElementById('bc-creator').textContent = stats.creators + ' creators';
      document.getElementById('bc-tag').textContent = stats.tags + ' tags';
      document.getElementById('bc-jinx').textContent = stats.jinxed ? stats.jinxed + ' jinxed characters' : 'See the map';
      document.getElementById('recent-strip').innerHTML = data.recent.map(recentCardHTML).join('');
      document.getElementById('featured-wrap').innerHTML = data.featured ? featuredCardHTML(data.featured) : '<p>No featured character available.</p>';
      var collections = window.weightedShuffle(data.collections).slice(0, 7);
      var html = collections.map(function(c){ return collectionTileHTML(c.displayName || c.slug, c.id || c.slug, c.count, c.icons, c.header, c.tagline, c); }).join('');
      html += '<a class="collection-tile" href="all-collections"><div class="collection-icons">' + data.icons.map(function(c){ return '<img loading="lazy" decoding="async" class="collection-icon" src="' + esc(PageRender.thumbSrc(c, '')) + '" alt="">'; }).join('') + '</div><h3 class="collection-name">All Collections</h3><div class="collection-footer"><span class="collection-count">' + stats.collections + ' collections</span><span class="collection-arrow">Browse →</span></div></a>';
      document.getElementById('collections-grid').innerHTML = html;
      document.getElementById('scripts-grid').innerHTML = window.weightedShuffle(data.scripts).slice(0, 7).map(function(sc){
        var nch = Math.max(String(sc.name || '').replace(/\s+/g, ' ').trim().length, 4);
        var header = sc.header || sc.logo
          ? '<div class="script-card-header"><img loading="lazy" decoding="async" src="' + esc(PageRender.imgSrc('', sc.header || sc.logo, sc.v)) + '"' + PageRender.responsiveAttrs('', sc.header || sc.logo, sc.v, '(max-width: 640px) 94vw, 320px') + ' alt="' + esc(sc.name) + '"></div>'
          : '<div class="script-card-header script-card-header-empty"><span style="--nch:' + nch + '">' + esc(sc.name) + '</span></div>';
        return '<a class="collection-tile script-tile" href="s/' + encodeURIComponent(sc.slug) + '">' + header + '<h3 class="collection-name">' + esc(sc.name) + '</h3><div class="collection-footer"><span class="collection-count">' + sc.count + ' characters' + (sc.author ? ' · ' + esc(sc.author) : '') + (sc.curata ? window.classBadgeHTML('curata', {sep: true}) : '') + '</span><span class="collection-arrow">Browse →</span></div></a>';
      }).join('') + '<a class="collection-tile script-tile" href="scripts"><div class="script-card-header script-card-header-empty"><span>All Scripts</span></div><h3 class="collection-name">All Scripts</h3><div class="collection-footer"><span class="collection-count">' + stats.scripts + ' scripts</span><span class="collection-arrow">Browse →</span></div></a>';
    }).catch(function(){ document.getElementById('landing-stats').textContent = 'Could not load homepage data. Please refresh to retry.'; });
  })();
  

  (function () {
    var box = document.getElementById('home-rules');
    if (box && typeof window.renderRulesHTML === 'function') {
      box.innerHTML = window.renderRulesHTML();
    }
  })();
