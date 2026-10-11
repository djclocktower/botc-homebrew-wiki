/* The first screen of the character lists, drawn on the server.

   /all-characters, /team?t= and /tag?t= are static pages that used to show a
   skeleton until the browser had fetched and parsed the whole character feed
   (190 KB compressed, 2,700 rows) — four seconds to the first card on a phone
   on slow 4G. This draws the same page with its first 48 cards already in
   it, from the same feed, through the same functions the browser uses
   (assets/char-filters.js: card(), barHTML(), sections(), batchedHTML()), so
   the cards in the HTML are exactly the cards the browser would have drawn.
   The browser adopts them as they stand and fetches the full list once the
   page is idle or the reader does something (see the page scripts).

   Only what the server can reproduce exactly is drawn here: the default view
   of All Characters (no ?collection=, no ?favorites=1 — those are the
   reader's own or need the full feed first) and a team or tag page with at
   least one character. Anything else returns null and the caller serves the
   static page, which still works the old way. The HTML holds nothing about
   the reader (no cookie is read, drafts are never in the feed it is built
   from), so it is cached once for everyone, keyed on the content versions it
   was built from, the deploy and the normalised query. */
import CharFilters from '../assets/char-filters.js';
import Classify from '../assets/classify.js';
import CardActions from '../assets/card-actions.js';
import Creators from '../assets/creators.js';
import Tags from '../assets/tags.js';

CharFilters.init({ Classify, CardActions, splitCreators: Creators.splitCreators });

export const LIST_PAGES = { '/all-characters': 'all', '/team': 'team', '/tag': 'tag' };
// The feeds each page is drawn from. All Characters' Source chips need the
// script and collection feeds too.
const LIST_DEPS = { all: ['character', 'collection', 'script'], team: ['character', 'collection'], tag: ['character', 'collection'] };
const FIRST_SCREEN = 48;
const LIST_RENDER_V = '1';

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// The tag page's own title-casing ("multi-kill" -> "Multi-Kill").
function toTitleCase(s) {
  return String(s || '').trim().toLowerCase().replace(/(^|[\s\-\/])[a-z]/g, m => m.toUpperCase());
}
function hasTag(c, tag) {
  return (c.tags || '').split(',').some(t => t.trim().toLowerCase() === tag);
}

/* The normalised query a request is, or null when the server cannot draw it.
   Unknown parameters (utm_source and friends) are ignored; the page reads its
   own from location, which is untouched. */
export function listQuery(kind, params) {
  if (kind === 'all') return params.has('collection') || params.has('favorites') ? null : '';
  const t = String(params.get('t') || '');
  if (kind === 'team') return CharFilters.TEAM_LABEL[t] ? t : null;
  if (kind === 'tag') {
    const tag = t.trim().toLowerCase();
    return tag && tag.length <= 80 ? tag : null;
  }
  return null;
}

function swap(html, from, to) {
  if (typeof from === 'string' ? html.indexOf(from) === -1 : !from.test(html)) throw new Error('list page template changed: ' + from);
  return html.replace(from, () => to);
}

function panelHTML(laid) {
  return '<main class="home-panel list-panel" id="panel" data-ssr="1" data-ssr-sig="' + esc(CharFilters.layoutSig(laid.groups)) + '">' +
    CharFilters.batchedHTML(laid, c => CharFilters.card(c), { size: FIRST_SCREEN }) + '</main>' +
    // Size the spacers under the grids now, so the footer and the next
    // sections are where they will stay before any data has arrived.
    '<script>window.mountCardBatches&&mountCardBatches.reserve(document.getElementById("panel"))</script>';
}
const PANEL_RE = /<main class="home-panel list-panel" id="panel">[\s\S]*?<\/main>/;
// The feeds start downloading in the static page's head. Here the cards are
// already drawn, so they wait until the page is idle (or the reader acts),
// rather than compete with the first screen's pictures.
const PRELOAD_RE = /<link rel="preload" href="(?:characters|collections|scripts)\.json[^"]*" as="fetch" crossorigin="anonymous">\s*/g;

/* The page itself. `data` = {chars, collections, scripts} (grid and browse
   feed rows). Null when there is nothing the server should draw. */
export function renderListPage(kind, template, data, query) {
  const chars = data.chars || [];
  let html = template.replace(PRELOAD_RE, '');
  if (kind === 'all') {
    const colls = (data.collections || []).map(c => ({ id: c.id, slug: c.slug, displayName: c.displayName || c.slug,
      match: c.match || [], include: c.include || [], exclude: c.exclude || [] }));
    const sourceOf = CharFilters.makeSourceOf(colls, data.scripts || []);
    const cfg = CharFilters.config();
    const list = CharFilters.applyState(chars, CharFilters.blankState(cfg), { sourceOf });
    if (!list.length) return null;
    const model = CharFilters.barModel(chars, sourceOf);
    const bar = CharFilters.barHTML(model, cfg, { creatorChips: CharFilters.creatorListHTML(model.creators, '') });
    html = swap(html, /<button type="button" id="filter-toggle" class="filter-toggle" hidden /, '<button type="button" id="filter-toggle" class="filter-toggle" ');
    html = swap(html, '<div id="filter-bar" class="filter-bar" hidden></div>',
      '<div id="filter-bar" class="filter-bar cf-loading" aria-busy="true">' + bar + '</div>');
    html = swap(html, '<p id="filter-count" class="filter-count" hidden></p>',
      '<p id="filter-count" class="filter-count">' + list.length + ' character' + (list.length === 1 ? '' : 's') +
      '<span class="cf-loading-note"> · loading filters…</span></p>');
    return swap(html, PANEL_RE, panelHTML(CharFilters.sections(list, cfg.group, null)));
  }
  if (kind === 'team') {
    const label = CharFilters.TEAM_LABEL[query];
    const list = chars.filter(c => c.team === query);
    if (!label || !list.length) return null;
    const tail = '<a class="char-card empty-card" href="create" style="display:flex;align-items:center;justify-content:center;text-decoration:none">+ Add a ' + esc(label) + '</a>';
    html = swap(html, '<title>Team — BOTC HomeBrew Wiki</title>', '<title>' + esc(label) + ' — BOTC HomeBrew Wiki</title>');
    html = swap(html, '<h1 id="hero-title">Loading&hellip;</h1>', '<h1 id="hero-title">' + esc(label) + '</h1>');
    return swap(html, PANEL_RE, panelHTML(CharFilters.singleGrid(list, tail)));
  }
  if (kind === 'tag') {
    const list = chars.filter(c => hasTag(c, query));
    if (!list.length) return null;
    const display = toTitleCase(query);
    const desc = Tags && Tags.describeTag ? Tags.describeTag(display) : '';
    html = swap(html, '<title>Tag — BOTC HomeBrew Wiki</title>', '<title>' + esc(display) + ' — BOTC HomeBrew Wiki</title>');
    html = swap(html, '<h1 id="hero-title">Loading…</h1>', '<h1 id="hero-title">' + esc(display) + '</h1>');
    if (desc) html = swap(html, /<p id="hero-desc">[^<]*<\/p>/, '<p id="hero-desc">' + esc(desc) + '</p>');
    return swap(html, PANEL_RE, panelHTML(CharFilters.singleGrid(list)));
  }
  return null;
}

const _templates = new Map();
async function template(env, origin, kind) {
  if (_templates.has(kind)) return _templates.get(kind);
  const file = kind === 'all' ? 'all-characters' : kind;
  let res = await env.ASSETS.fetch(new Request(origin + '/' + file + '.html'));
  if (!res.ok) res = await env.ASSETS.fetch(new Request(origin + '/' + file));
  if (!res.ok) throw new Error('list page template unavailable');
  const text = await res.text();
  _templates.set(kind, text);
  return text;
}
let _parsed = { body: null, rows: null };
function parseOnce(body) {
  // cachedFeedBody hands back the same string while its version holds, so
  // the 1 MB grid feed is parsed once per version per isolate.
  if (_parsed.body !== body) _parsed = { body, rows: JSON.parse(body) };
  return _parsed.rows;
}

/* The route. `h` carries the Worker's own helpers (contentVersion,
   cachedFeedBody, edgeCacheGet/Put, htmlPage, renderV) so this file has no
   copy of them. Returns null to fall back to the static page. */
export async function serveListPage(h, env, ctx, request, url) {
  const kind = LIST_PAGES[url.pathname];
  if (!kind || request.method !== 'GET') return null;
  const query = listQuery(kind, url.searchParams);
  if (query === null) return null;
  try {
    const version = await h.contentVersion(env, LIST_DEPS[kind]);
    const key = 'https://ssr.internal/list/' + kind + '?q=' + encodeURIComponent(query) + '&v=' + encodeURIComponent(version) +
      '&o=' + encodeURIComponent(url.origin) + '&r=' + LIST_RENDER_V + '-' + h.renderV;
    const hit = await h.edgeCacheGet(key);
    if (hit !== null) return h.htmlPage(hit);
    const [tpl, gridBody, collBody, scriptBody] = await Promise.all([
      template(env, url.origin, kind),
      h.cachedFeedBody(env, ctx, 'characters', 'grid'),
      kind === 'all' ? h.cachedFeedBody(env, ctx, 'collections', 'browse') : null,
      kind === 'all' ? h.cachedFeedBody(env, ctx, 'scripts', 'browse') : null
    ]);
    const html = renderListPage(kind, tpl, {
      chars: parseOnce(gridBody),
      collections: collBody ? JSON.parse(collBody) : [],
      scripts: scriptBody ? JSON.parse(scriptBody) : []
    }, query);
    if (!html) return null;
    h.edgeCachePut(ctx, key, html, h.cacheControl, 'text/html; charset=utf-8');
    return h.htmlPage(html);
  } catch (e) {
    // The static page is always a correct answer; never fail the request here.
    return null;
  }
}
