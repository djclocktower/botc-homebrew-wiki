/* The server-rendered homepage (GET /).

   index.html stays the TEMPLATE: the Worker reads the built file through the
   assets binding and fills the regions marked in it with
   <!--home:NAME-->…<!--/home:NAME--> comments. So the head (stylesheets,
   scripts, preloads), the top bar, the browse cards and the sidebar are
   written once, in index.html, and the static file is still a working page —
   it is what the Worker falls back to (and what assets/home.js fills from
   /api/home?format=panels) if anything here fails.

   Everything drawn here comes from the same builders the JSON routes use
   (homeData → /api/home, the news and article card caches), so the server
   page and the fallback cannot disagree. Every value is escaped.

   The one thing that must stay per-visit is WHICH collection and script
   tiles are shown: the browser used to shuffle them on every load. The HTML
   is one shared cached copy, so the server renders a deterministic pick (for
   readers without JavaScript and for crawlers) and puts the whole pool in an
   inert <template> right after the grid, followed by a tiny inline script
   that re-picks before the first paint — the stylesheet is render-blocking
   and the script sits immediately after the grid, so the reader never sees
   the server's pick swap out. */
import Classify from '../assets/classify.js';
import PageRender from '../assets/render-page.js';
import CardActions from '../assets/card-actions.js';

export const HOME_TILES = 7;
const TEAM_LABEL = {
  townsfolk: 'Townsfolk', outsider: 'Outsider', minion: 'Minion',
  demon: 'Demon', traveller: 'Traveller', fabled: 'Fabled', loric: 'Loric'
};
const GOOD = { townsfolk: 1, outsider: 1 };

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function num(n) { return Number(n) || 0; }
function weightAttr(c) {
  const w = Classify.weightOf(c);
  return w > 1 ? ' data-w="' + w + '"' : '';
}
// One `sizes` for every tile on the wiki (render-page.js owns why it says
// less than the tile's width on a phone).
const SIZES = PageRender.TILE_SIZES;

// Header image, then the author's logo, then the scatter of member icons —
// the logo beats the scatter, and matches what the collection's own page
// shows at the top.
export function collectionTileHTML(c) {
  const name = c.displayName || c.slug, id = c.id || c.slug, count = num(c.count);
  const banner = c.header || c.logo;
  const top = banner
    ? '<div class="collection-tile-header"><img loading="lazy" decoding="async" src="' + esc(PageRender.imgSrc('', banner, c.v)) + '"' +
      PageRender.responsiveAttrs('', banner, c.v, SIZES) + ' alt="' + esc(name) + '"></div>'
    : '<div class="collection-icons">' + (c.icons || []).map(i =>
      '<img loading="lazy" decoding="async" class="collection-icon" src="' + esc(PageRender.thumbSrc(i, '')) +
      '" onerror="this.src=\'assets/favicon.png\'" alt="">').join('') + '</div>';
  return '<a class="collection-tile" data-pick' + weightAttr(c) + ' href="' + esc('collection/' + encodeURIComponent(id)) + '">' +
    top +
    '<h3 class="collection-name">' + esc(name) + '</h3>' +
    (c.tagline ? '<p class="collection-tile-tagline">' + esc(c.tagline) + '</p>' : '') +
    '<div class="collection-footer">' +
      // Same footer shape as the script tiles: count, who made it, then the
      // Curata wreath behind a hairline.
      '<span class="collection-count">' + count + ' character' + (count === 1 ? '' : 's') +
        (c.author ? ' · ' + esc(c.author) : '') +
        (Classify.isCurata(c) ? Classify.classBadgeHTML('curata', { sep: true }) : '') + '</span>' +
      '<span class="collection-arrow">Browse →</span>' +
    '</div>' +
  '</a>';
}
function allCollectionsTileHTML(icons, n) {
  return '<a class="collection-tile" href="all-collections"><div class="collection-icons">' +
    (icons || []).map(i => '<img loading="lazy" decoding="async" class="collection-icon" src="' + esc(PageRender.thumbSrc(i, '')) + '" alt="">').join('') +
    '</div><h3 class="collection-name">All Collections</h3><div class="collection-footer"><span class="collection-count">' +
    num(n) + ' collections</span><span class="collection-arrow">Browse →</span></div></a>';
}
export function scriptTileHTML(sc) {
  const nch = Math.max(String(sc.name || '').replace(/\s+/g, ' ').trim().length, 4);
  const banner = sc.header || sc.logo;
  const header = banner
    ? '<div class="script-card-header"><img loading="lazy" decoding="async" src="' + esc(PageRender.imgSrc('', banner, sc.v)) + '"' +
      PageRender.responsiveAttrs('', banner, sc.v, SIZES) + ' alt="' + esc(sc.name) + '"></div>'
    : '<div class="script-card-header script-card-header-empty"><span style="--nch:' + nch + '">' + esc(sc.name) + '</span></div>';
  return '<a class="collection-tile script-tile" data-pick' + weightAttr(sc) + ' href="' + esc('s/' + encodeURIComponent(sc.slug)) + '">' + header +
    '<h3 class="collection-name">' + esc(sc.name) + '</h3><div class="collection-footer"><span class="collection-count">' +
    num(sc.count) + ' characters' + (sc.author ? ' · ' + esc(sc.author) : '') +
    (Classify.isCurata(sc) ? Classify.classBadgeHTML('curata', { sep: true }) : '') +
    '</span><span class="collection-arrow">Browse →</span></div></a>';
}
function allScriptsTileHTML(n) {
  return '<a class="collection-tile script-tile" href="scripts"><div class="script-card-header script-card-header-empty"><span>All Scripts</span></div>' +
    '<h3 class="collection-name">All Scripts</h3><div class="collection-footer"><span class="collection-count">' + num(n) +
    ' scripts</span><span class="collection-arrow">Browse →</span></div></a>';
}

export function recentCardHTML(c) {
  return '<a class="recent-card" href="' + esc(c.page) + '">' +
    '<img loading="lazy" decoding="async" class="recent-thumb" src="' + esc(PageRender.thumbSrc(c, '')) + '" onerror="this.src=\'assets/favicon.png\'" alt="">' +
    '<div class="recent-name">' + esc(c.name) + '</div>' +
    '<div class="recent-type' + (GOOD[c.team] ? ' good' : '') + '">' + esc(TEAM_LABEL[c.team] || c.team) + '</div>' +
    // The Favorites / Add to Script quick actions, side by side under the
    // team name: an EMPTY slot that card-actions.js fills in the browser,
    // because saved/unsaved is one reader's state and this HTML is shared.
    CardActions.slotHTML(c) +
  '</a>';
}

// The daily pick is made by featuredPick() in home-data.js; the lede was
// flattened through WikiRender.plainText() there.
export function featuredCardHTML(c) {
  const lede = c.plainLede || '', ability = c.ability || '', creator = c.creator || '', appears = c.appearsIn || '';
  return '<a class="featured-card" href="' + esc(c.page) + '">' +
    '<img loading="lazy" decoding="async" width="260" height="260" class="featured-art" src="' + esc(PageRender.displaySrc(c, '')) + '" alt="' + esc(c.name) + '">' +
    '<div class="featured-body">' +
      '<div class="featured-type' + (GOOD[c.team] ? ' good' : '') + '">' + esc(TEAM_LABEL[c.team] || c.team) + '</div>' +
      '<h3 class="featured-name">' + esc(c.name) +
        (Classify.isCurata(c) ? Classify.classBadgeHTML('curata', { from: c.curataFrom }) : '') + '</h3>' +
      (lede ? '<p class="featured-lede">' + esc(lede) + '</p>' : '') +
      (ability ? '<p class="featured-ability">' + esc(ability) + '</p>' : '') +
      // The quick actions ride the credit line, right after the name.
      '<div class="featured-meta">' +
        (creator ? '<span>by ' + esc(creator) + '</span>' : '') +
        CardActions.slotHTML(c) +
        (appears ? '<span>· ' + esc(appears) + '</span>' : '') +
      '</div>' +
      '<span class="featured-link">View Full Page →</span>' +
    '</div>' +
  '</a>';
}

export function statsText(s) {
  return num(s.characters) + ' characters · ' + num(s.collections) + ' collections · ' +
    num(s.creators) + ' creators · ' + num(s.scripts) + ' scripts';
}

// A small seeded generator, so the server's default pick is stable for one
// cache build (the day) and the cached HTML does not change between hits.
function seeded(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/* Re-picks the tiles in the reader's browser, before first paint.
   `g` is the grid, `t` the <template> holding every tile, `n` how many to
   show. Same weighting as Classify.weightedShuffle (key = U^(1/w), Curata
   tiles carry data-w="3"), so Curata still floats forward without being
   pinned. The tiles the server picked carry data-pick and are replaced; the
   trailing "All …" tile has no data-pick and stays last. Any failure leaves
   the server's pick in place. */
export const PICK_FN = 'window.botcHomePick=function(g,t,n){try{g=document.getElementById(g);t=document.getElementById(t);' +
  'if(!g||!t||!t.content)return;var a=[],c=t.content.children,i;for(i=0;i<c.length;i++)' +
  'a.push([c[i],Math.pow(Math.random()||1e-9,1/(+c[i].getAttribute("data-w")||1))]);if(!a.length)return;' +
  'a.sort(function(x,y){return y[1]-x[1]});var f=document.createDocumentFragment();' +
  'for(i=0;i<a.length&&i<n;i++)f.appendChild(document.importNode(a[i][0],true));' +
  'var o=g.querySelectorAll("[data-pick]");for(i=0;i<o.length;i++)if(o[i].parentNode===g)g.removeChild(o[i]);' +
  'g.insertBefore(f,g.firstChild)}catch(e){}};';

function poolHTML(gridId, poolId, tiles, define) {
  if (!tiles.length) return '';
  return '<template id="' + poolId + '">' + tiles.join('') + '</template>' +
    '<script>' + (define ? PICK_FN : '') +
    'window.botcHomePick&&botcHomePick("' + gridId + '","' + poolId + '",' + HOME_TILES + ')</script>';
}

/* Every region of the page, as HTML. `opts.rand` decides the tiles drawn in
   the grids themselves (a seeded generator for the cached page, Math.random
   for the fallback panels); `opts.pools` adds the <template> + re-pick script
   after each grid. */
export function homeRegions(home, opts = {}) {
  const stats = home.stats || {};
  const rand = opts.rand || Math.random;
  const collections = home.collections || [], scripts = home.scripts || [];
  const pickC = Classify.weightedShuffle(collections, rand).slice(0, HOME_TILES);
  const pickS = Classify.weightedShuffle(scripts, rand).slice(0, HOME_TILES);
  const regions = {
    stats: esc(statsText(stats)),
    'bc-team': esc(num(stats.characters) + ' characters'),
    'bc-creator': esc(num(stats.creators) + ' creators'),
    'bc-tag': esc(num(stats.tags) + ' tags'),
    'bc-jinx': esc(stats.jinxed ? num(stats.jinxed) + ' jinxed characters' : 'See the map'),
    collections: pickC.map(collectionTileHTML).join('') + allCollectionsTileHTML(home.icons, stats.collections),
    scripts: pickS.map(scriptTileHTML).join('') + allScriptsTileHTML(stats.scripts),
    recent: (home.recent || []).map(recentCardHTML).join(''),
    featured: home.featured ? featuredCardHTML(home.featured) : '<p>No featured character available.</p>',
    // Server-built card markup (NewsRender), already escaped there.
    news: opts.newsHTML || '',
    articles: opts.articlesHTML || ''
  };
  if (opts.pools) {
    regions['collections-pool'] = poolHTML('collections-grid', 'collections-pool', collections.map(collectionTileHTML), true);
    regions['scripts-pool'] = poolHTML('scripts-grid', 'scripts-pool', scripts.map(scriptTileHTML), true);
  }
  return regions;
}

// Region name → the marker it fills in index.html.
const MARKERS = {
  stats: 'stats', 'bc-team': 'bc-team', 'bc-creator': 'bc-creator', 'bc-tag': 'bc-tag', 'bc-jinx': 'bc-jinx',
  collections: 'collections', 'collections-pool': 'collections-pool', scripts: 'scripts', 'scripts-pool': 'scripts-pool',
  recent: 'recent', featured: 'featured', news: 'news', articles: 'articles'
};
function fill(html, name, content) {
  const open = '<!--home:' + name + '-->', close = '<!--/home:' + name + '-->';
  const a = html.indexOf(open), b = html.indexOf(close, a);
  if (a < 0 || b < 0) throw new Error('Homepage template is missing the ' + name + ' region');
  return html.slice(0, a) + content + html.slice(b + close.length);
}
function unhide(html, id) {
  const from = 'id="' + id + '" hidden';
  if (html.indexOf(from) < 0) throw new Error('Homepage template is missing #' + id);
  return html.replace(from, () => 'id="' + id + '"');
}

/* The whole page: the template with every region filled. Throws when the
   template does not carry a region, so the caller can fall back to the
   static page rather than serve one with a hole in it. A News or Articles
   section with nothing in it stays hidden, as it always has. */
export function renderHomePage(template, home, opts = {}) {
  const day = Number(opts.day) || 0;
  const regions = homeRegions(home, { ...opts, pools: true, rand: seeded(Math.imul(day + 1, 2246822519)) });
  let html = template;
  for (const [name, marker] of Object.entries(MARKERS)) html = fill(html, marker, regions[name]);
  if (regions.news) html = unhide(html, 'news-section');
  if (regions.articles) html = unhide(html, 'articles-section');
  return html;
}
