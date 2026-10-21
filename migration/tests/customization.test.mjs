import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fixture } from './worker-fixture.mjs';

const require = createRequire(import.meta.url);
const CustomCSS = require('../../assets/custom-css.js');
const PageRender = require('../../assets/render-page.js');

const member = id => ({ headers: { Cookie: 'botc_session=user-' + id } });
const post = (id, body) => ({
  method: 'POST',
  headers: { Cookie: 'botc_session=user-' + id, 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});
function users(f) {
  for (const id of [1, 2]) {
    f.db.prepare("INSERT INTO users(id,username,password_hash) VALUES(?,?,'')").run(id, 'user-' + id);
    f.state.sessions.set('sess:user-' + id, { userId: id, username: 'user-' + id });
  }
}
// The scope is printed id-weighted (see ROOT in custom-css.js); the cases
// below read it as plain .ucss.
const css = text => CustomCSS.clean(text).css.split(CustomCSS.ROOT).join('.ucss');

test('custom CSS: every rule is scoped under .ucss, body/html/:root mean the page area', () => {
  assert.equal(CustomCSS.clean('h1{color:red}').css, ':is(.ucss,#ucss) h1{color:red}');
  assert.equal(css('body{color:red}'), '.ucss{color:red}');
  assert.equal(css('html body .card{color:red}'), '.ucss .card{color:red}');
  assert.equal(css(':root{--x:1}'), '.ucss{--x:1}');
  assert.equal(css('body.dark::before{content:"x"}'), '.ucss.dark::before{content:"x"}');
  assert.equal(css('h1, .a:hover{color:blue}'), '.ucss h1,.ucss .a:hover{color:blue}');
  assert.equal(css('@media (max-width:600px){h1{color:red}}'), '@media (max-width:600px){.ucss h1{color:red}}');
  assert.equal(css('@supports (display:grid){@media screen{.g{display:grid}}}'),
    '@supports (display:grid){@media screen{.ucss .g{display:grid}}}');
  // An unfinished stylesheet still means what it says.
  assert.equal(css('a{color:red'), '.ucss a{color:red}');
});

test('custom CSS: the ways out of the page are closed', () => {
  // The <style> element can never be closed from inside it.
  for (const evil of ['</style><script>alert(1)</script>', 'a{content:"</style><script>x</script>"}',
                      'a{b:c}</StYlE>', 'a{background:url("data:image/svg+xml,<svg></svg>")}']) {
    assert.doesNotMatch(css(evil), /</, evil);
  }
  // Nesting and & could point a selector back outside the scope.
  assert.equal(css('.topbar:not(&){display:none}'), '');
  assert.equal(css('.a{ .b{x:y} & ~ .topbar{x:y} color:blue }'), '.ucss .a{color:blue}');
  // Fetches: only url(), only https/assets/data:image/#fragment, never /api/.
  assert.equal(css('@import url(https://e.com/a.css); .a{b:c}'), '.ucss .a{b:c}');
  assert.equal(css('a{background:url(https://e.com/a.png)}'), '.ucss a{background:url("https://e.com/a.png")}');
  assert.equal(css('a{background:url(/assets/art/x.png)}'), '.ucss a{background:url("/assets/art/x.png")}');
  for (const bad of ['url(http://e.com/a.png)', 'url(//e.com/a.png)', 'url(/api/logout)', 'url(/assets/../api/x)',
                     'url(https://botchomebrew.wiki/api/auth/discord)', 'url(javascript:alert(1))',
                     'image-set("https://e/x" 1x)', 'src("https://e/x")', 'cross-fade(url(a),url(b))',
                     'u\\72 l(https://e/x)', 'expression(alert(1))']) {
    assert.equal(css('a{background:' + bad + '}'), '', bad);
  }
  // Global names are renamed so the site's own fonts and animations stay its own.
  assert.equal(css('@font-face{font-family:"Dumbledor2";src:url(https://e/f.woff2)} h1{font-family:Dumbledor2,serif}'),
    '@font-face{font-family:"u-Dumbledor2";src:url("https://e/f.woff2")}.ucss h1{font-family:"u-Dumbledor2",serif}');
  assert.equal(css('@keyframes spin{to{transform:rotate(1turn)}} .a{animation:spin 2s infinite}'),
    '@keyframes u-spin{to{transform:rotate(1turn)}}.ucss .a{animation:u-spin 2s infinite}');
  // Site-wide at-rules go entirely.
  for (const g of ['@property --purple-deep{syntax:"<color>";inherits:false;initial-value:red}',
                   '@layer x{.a{color:red}}', '@counter-style x{system:cyclic}', '@page{margin:0}',
                   '@namespace svg url(http://www.w3.org/2000/svg);']) {
    assert.equal(css(g), '', g);
  }
  assert.equal(css('a{behavior:url(x.htc);color:red}'), '.ucss a{color:red}');
  assert.ok(CustomCSS.clean('@import "x";').warnings.length);
});

test('theme kit: only validated values survive, and attributes are built from them', () => {
  const t = PageRender.sanitizeTheme({
    font: 'cinzel', bodyFont: 'nope', gFont: 'Creepster', gBodyFont: "Evil'); x{",
    accent: '#AABBCC', bgColor: 'red', bgColor2: '#000000', bgAngle: 400, bgDim: '40', panelAlpha: 100,
    radius: 0, borderW: 0, shadow: 'glow', width: 'huge', headCase: 'upper', textScale: 120,
    css: 'x'.repeat(40000), background: 'scripts/other-bg.png'
  }, 'scripts/mine');
  assert.deepEqual(Object.keys(t).sort(), ['accent', 'bgColor2', 'bgDim', 'borderW', 'css', 'font', 'gFont',
    'headCase', 'radius', 'shadow', 'textScale'].sort());
  assert.equal(t.accent, '#aabbcc');
  assert.equal(t.css.length, PageRender.THEME_CSS_MAX);
  const a = PageRender.themeAttrs(t);
  assert.match(a.cls, /theme-radius/);
  assert.match(a.cls, /theme-hcase-upper/);
  assert.match(a.style, /--pg-font:'Creepster', serif/);
  assert.deepEqual(a.fonts, ['https://fonts.googleapis.com/css2?family=Creepster&display=swap']);
  // Nothing in the style attribute can close a declaration early.
  assert.doesNotMatch(a.style, /[<>"{}]/);
  // Every preset is a valid theme on its own.
  for (const [k, p] of Object.entries(PageRender.THEME_PRESETS)) {
    const s = PageRender.sanitizeTheme(p.t, 'x') || {};
    assert.equal(Object.keys(s).length, Object.keys(p.t).length, k);
  }
});

test('a script page carries its theme, fonts and scoped custom CSS', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  users(f);
  const r = await f.request('/api/script', post(1, {
    slug: 'themed', name: 'Themed', author: 'user-1', characters: [], status: 'published',
    theme: { accent: '#ff0000', gFont: 'Creepster', css: 'body{background:#000} h1{color:gold} </style><b>x</b>' }
  }));
  assert.equal(r.status, 200, await r.clone().text());
  const html = await (await f.request('/s/themed')).text();
  assert.match(html, /<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/css2\?family=Creepster&amp;display=swap">/);
  const style = html.match(/<style id="page-custom-css">([\s\S]*?)<\/style>/);
  assert.ok(style, 'custom stylesheet printed');
  assert.ok(style[1].startsWith(':is(.ucss,#ucss){background:#000}:is(.ucss,#ucss) h1{color:gold}'), style[1]);
  assert.doesNotMatch(style[1], /</);
  assert.match(html, /<main class="wrap" id="content"><div class="ucss-frame"><div class="ucss">/);
  assert.match(html, /<body class="[^"]*theme-accent/);
  // Without custom CSS there is no frame and no style element.
  await f.request('/api/script', post(1, { slug: 'plain', name: 'Plain', author: 'user-1', characters: [], status: 'published' }));
  const plain = await (await f.request('/s/plain')).text();
  assert.doesNotMatch(plain, /ucss-frame|page-custom-css|fonts\.googleapis/);
});

test('custom URLs: a script answers at its own address, the slug and old addresses forward to it', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  users(f);
  let r = await f.request('/api/script', post(1, { slug: 'long-auto-name', name: 'Long Auto Name', author: 'user-1',
    characters: [], status: 'published', customUrl: 'Cool Script!' }));
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await r.json()).customUrl, 'cool-script');

  r = await f.request('/s/cool-script');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<link rel="canonical" href="[^"]*\/s\/cool-script">/);
  r = await f.request('/s/long-auto-name', { redirect: 'manual' });
  assert.equal(r.status, 301);
  assert.match(r.headers.get('Location'), /\/s\/cool-script$/);

  // Somebody else cannot take it, as a custom URL or as a new script's slug.
  r = await f.request('/api/custom-url-check?type=script&url=cool-script', member(2));
  assert.equal((await r.json()).free, false);
  r = await f.request('/api/script', post(2, { slug: 'other', name: 'Other', author: 'user-2', characters: [], customUrl: 'cool-script' }));
  assert.equal(r.status, 409);
  r = await f.request('/api/script', post(2, { slug: 'cool-script', name: 'Cool Script', author: 'user-2', characters: [] }));
  assert.equal(r.status, 409);
  r = await f.request('/api/script', post(2, { slug: 'other2', name: 'Other', author: 'user-2', characters: [], customUrl: 'long-auto-name' }));
  assert.equal(r.status, 409, 'another page\'s slug is not free either');
  // Too short.
  r = await f.request('/api/script', post(1, { slug: 'long-auto-name', name: 'Long Auto Name', author: 'user-1', characters: [], customUrl: 'ab' }));
  assert.equal(r.status, 400);

  // Moving it leaves the old address forwarding; a save that does not send
  // the field keeps it.
  r = await f.request('/api/script', post(1, { slug: 'long-auto-name', name: 'Long Auto Name', author: 'user-1', characters: [], customUrl: 'cooler' }));
  assert.equal((await r.json()).customUrl, 'cooler');
  r = await f.request('/s/cool-script', { redirect: 'manual' });
  assert.equal(r.status, 301);
  assert.match(r.headers.get('Location'), /\/s\/cooler$/);
  r = await f.request('/api/script', post(1, { slug: 'long-auto-name', name: 'Renamed', author: 'user-1', characters: [] }));
  assert.equal((await r.json()).customUrl, 'cooler');
  // And a public-edit guest cannot move it.
  r = await f.request('/api/script', post(1, { slug: 'long-auto-name', name: 'Renamed', author: 'user-1', characters: [], publicEdit: 'all' }));
  assert.equal(r.status, 200);
  r = await f.request('/api/script', post(2, { slug: 'long-auto-name', name: 'Renamed', author: 'user-1', characters: [], customUrl: 'mine-now' }));
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await r.json()).customUrl, 'cooler');
  // Clearing it puts the page back on its slug, and the old address forwards.
  r = await f.request('/api/script', post(1, { slug: 'long-auto-name', name: 'Renamed', author: 'user-1', characters: [], customUrl: '' }));
  assert.equal((await r.json()).customUrl, '');
  assert.equal((await f.request('/s/long-auto-name')).status, 200);
  r = await f.request('/s/cooler', { redirect: 'manual' });
  assert.equal(r.status, 301);
  assert.match(r.headers.get('Location'), /\/s\/long-auto-name$/);
});

test('custom URLs: a draft never redirects a stranger, and a wiki page takes one too', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  users(f);
  await f.request('/api/script', post(1, { slug: 'secret', name: 'Secret', author: 'user-1', characters: [], status: 'draft', customUrl: 'hidden-one' }));
  assert.equal((await f.request('/s/secret', { redirect: 'manual' })).status, 404);
  assert.equal((await f.request('/s/hidden-one', { redirect: 'manual' })).status, 404);
  assert.equal((await f.request('/s/secret', { ...member(1), redirect: 'manual' })).status, 301);

  let r = await f.request('/api/wiki-page', post(1, { parentType: 'article', title: 'A Very Long Guide Title', body: 'x', status: 'published', customUrl: 'guide' }));
  assert.equal(r.status, 200, await r.clone().text());
  const made = await r.json();
  assert.equal(made.customUrl, 'guide');
  r = await f.request('/p/guide');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<link rel="canonical" href="[^"]*\/p\/guide">/);
  r = await f.request('/p/' + made.slug, { redirect: 'manual' });
  assert.equal(r.status, 301);
  // A new page titled like the custom address does not land on it.
  r = await f.request('/api/wiki-page', post(2, { parentType: 'article', title: 'Guide', body: 'y', status: 'published' }));
  assert.equal((await r.json()).slug, 'guide-2');
  const sm = await (await f.request('/sitemap.xml')).text();
  assert.match(sm, /\/p\/guide</);
});

test('profile appearance: saved on its own, kept by a profile save, returned to the creator page', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  users(f);
  let r = await f.request('/api/account/theme', post(1, { theme: {
    accent: '#123456', css: 'h1{color:red}', background: 'avatars/u1-bg.jpg', bgDim: 30
  } }));
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await r.json()).theme.accent, '#123456');
  // Somebody else's background slot is never accepted.
  r = await f.request('/api/account/theme', post(2, { theme: { background: 'avatars/u1-bg.jpg', accent: '#000000' } }));
  assert.equal((await r.json()).theme.background, undefined);

  // The links-and-pins save leaves the theme alone.
  r = await f.request('/api/account/profile', post(1, { displayName: 'One', bio: '', links: { website: 'https://e.com' }, pinned: [] }));
  assert.equal(r.status, 200);
  const u = await (await f.request('/api/user?u=user-1')).json();
  assert.equal(u.profile.theme.accent, '#123456');
  assert.equal(u.profile.theme.css, 'h1{color:red}');
  assert.equal(u.profile.theme.background, 'avatars/u1-bg.jpg');
  assert.equal(u.profile.links.website, 'https://e.com');
  // Clearing it.
  r = await f.request('/api/account/theme', post(1, { theme: null }));
  assert.equal((await r.json()).theme, null);
});

test('custom URLs: a collection answers at its own address, by id and PK it forwards', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  users(f);
  let r = await f.request('/api/collection', post(1, { displayName: 'My Big Set', author: 'user-1', status: 'published', customUrl: 'bigset' }));
  assert.equal(r.status, 200, await r.clone().text());
  const made = await r.json();
  assert.equal(made.customUrl, 'bigset');
  assert.equal((await f.request('/collection/bigset')).status, 200);
  r = await f.request('/collection/' + made.id, { redirect: 'manual' });
  assert.equal(r.status, 301);
  assert.match(r.headers.get('Location'), /\/collection\/bigset$/);
  // Its own id is not a custom address: asking for it clears the custom one.
  r = await f.request('/api/collection', post(1, { slug: made.slug, id: made.id, displayName: 'My Big Set', author: 'user-1', customUrl: made.id }));
  assert.equal((await r.json()).customUrl, '');
  assert.equal((await f.request('/collection/' + made.id)).status, 200);
  // A new collection cannot be created onto a custom address.
  await f.request('/api/collection', post(1, { slug: made.slug, id: made.id, displayName: 'My Big Set', author: 'user-1', customUrl: 'bigset' }));
  r = await f.request('/api/collection', post(2, { displayName: 'Bigset', author: 'user-2' }));
  assert.equal(r.status, 409);
});

test('theme kit: character boxes, team headings and dividers each get their own setting', () => {
  const t = PageRender.sanitizeTheme({
    cardBg: '#112233', cardAlpha: 80, cardName: '#ff0000', cardFont: 'cinzel', gTeamFont: 'Metal Mania',
    cardBorderW: 0, cardHover: 'glow', cardIcon: 150, teamColor: '#00ff00', teamBg: '#000000',
    teamSize: 140, teamAlign: 'center', teamCase: 'lower', ruleStyle: 'dashed', ruleColor: '#abcdef', ruleW: 3,
    cardShadow: 'huge', ruleW2: 5
  }, 'x');
  assert.equal(t.cardShadow, undefined);
  assert.equal(t.cardBorderW, 0, 'no border is a choice, not "not set"');
  const a = PageRender.themeAttrs(t);
  for (const c of ['tc-bg', 'tc-name', 'tc-font', 'tc-border', 'tc-hover-glow', 'tc-icon', 'tc-box',
                   'tt-font', 'tt-color', 'tt-bg', 'tt-size', 'tt-align-center', 'tt-case-lower', 'tr-dashed']) {
    assert.match(a.cls, new RegExp('(^| )' + c + '( |$)'), c);
  }
  assert.match(a.style, /--pg-team-font:'Metal Mania', serif/);
  assert.match(a.style, /--pg-rule:#abcdef/);
  assert.ok(a.fonts.some(h => h.includes('family=Metal+Mania')));
  assert.doesNotMatch(a.style, /[<>"{}]/);
  // Untouched, nothing at all is added.
  assert.equal(PageRender.themeAttrs(PageRender.sanitizeTheme({ accent: '#000000' }, 'x')).cls, 'page-themed theme-accent');
});

function bucket(f) {
  const objects = new Map();
  f.env.ART = {
    objects,
    async put(key, body, opts) { objects.set(key, { body: Buffer.from(body), custom: opts && opts.customMetadata }); return { etag: 'e' }; },
    async head(key) { const o = objects.get(key); return o ? { key, customMetadata: o.custom || {} } : null; },
    async get() { return null; },
    async delete(keys) { for (const k of [].concat(keys)) objects.delete(k); },
    async list() { return { truncated: false, objects: [] }; }
  };
  return objects;
}
const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

test('stickers: sanitized, drawn outside the custom-CSS frame, and uploaded only into the page\'s own slots', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  users(f);
  const objects = bucket(f);
  let r = await f.request('/api/script', post(1, { slug: 'decorated', name: 'Decorated', author: 'user-1', characters: [], status: 'published' }));
  assert.equal(r.status, 200);

  // The owner uploads a GIF into the script's sticker slot; somebody else cannot.
  const up = (id, key) => f.request('/api/upload', post(id, { key, data: GIF }));
  assert.equal((await up(1, 'scripts/decorated-st1.gif')).status, 200);
  assert.equal((await up(2, 'scripts/decorated-st2.gif')).status, 403);
  assert.ok(objects.has('scripts/decorated-st1.gif'));

  r = await f.request('/api/script', post(1, { slug: 'decorated', name: 'Decorated', author: 'user-1', characters: [], status: 'published',
    theme: { css: 'h1{color:red}', stickers: [
      { src: 'scripts/decorated-st1.gif', x: 90, y: 5, w: 200, anim: 'spin', layer: 'back', pin: 'screen', hideSmall: true },
      { src: 'scripts/someone-else-st1.gif' },
      { src: 'https://e.com/dance.gif"><script>', x: 10 },
      { src: 'https://e.com/dance.gif', x: 500, w: -3, rot: 'x', layer: 'sideways' }
    ] } }));
  assert.equal(r.status, 200, await r.clone().text());
  const html = await (await f.request('/s/decorated')).text();
  const layer = html.match(/<main[^>]*><div class="pg-stickers" aria-hidden="true">([\s\S]*?)<\/div><div class="ucss-frame">/);
  assert.ok(layer, 'the stickers come first in <main>, outside the custom-CSS frame');
  const imgs = layer[1].match(/<img [^>]*>/g);
  assert.equal(imgs.length, 2);
  assert.match(imgs[0], /class="pg-sticker pgs-back pgs-fixed pgs-anim-spin pgs-hide-small" src="\/assets\/scripts\/decorated-st1\.gif"/);
  assert.match(imgs[0], /style="left:90%;top:5%;width:200px;/);
  assert.match(imgs[1], /src="https:\/\/e\.com\/dance\.gif"/);
  assert.match(imgs[1], /left:120%;top:12%;width:12px;--pgs-r:0deg/, 'numbers clamped, junk replaced by defaults');
  assert.match(imgs[1], /pgs-front/);
  assert.doesNotMatch(layer[1], /<script|someone-else/);

  // A creator page's stickers go through the avatar route, GIF allowed.
  r = await f.request('/api/account/avatar', post(1, { kind: 'st', n: 3, data: GIF }));
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await r.json()).path, 'avatars/u1-st3.gif');
  assert.equal((await f.request('/api/account/avatar', post(1, { kind: 'st', n: 99, data: GIF }))).status, 400);
  assert.equal((await f.request('/api/account/avatar', post(1, { data: GIF }))).status, 400, 'a profile picture still cannot be a GIF');
  r = await f.request('/api/account/theme', post(1, { theme: { stickers: [{ src: 'avatars/u1-st3.gif' }, { src: 'avatars/u2-st1.gif' }] } }));
  assert.deepEqual((await r.json()).theme.stickers.map(s => s.src), ['avatars/u1-st3.gif']);
});

test('layout: sizes and positions are validated, become tl-* settings, and quick styles keep them', async t => {
  const T = PageRender.sanitizeTheme({
    cardW: 380, cardCols: 9, cardGap: 0, cardPad: '12', cardLayout: 'top', cardAlign: 'centre',
    cardAbility: 'hide', pageW: 1600, panelPad: 0, secGap: 30, infoW: 420, infoPos: 'left',
    titleSize: 100, topAlign: 'left',
    order: ['characters', 'synopsis', 'characters', 'nope', '<b>', 'night']
  }, 'scripts/x');
  assert.deepEqual(T, {
    cardW: 380, cardGap: 0, cardPad: 12, pageW: 1600, panelPad: 0, secGap: 30, infoW: 420,
    cardLayout: 'top', cardAbility: 'hide', infoPos: 'left', topAlign: 'left',
    order: ['characters', 'synopsis', 'night']
  });
  const a = PageRender.themeAttrs(T);
  for (const c of ['tl-cardw', 'tl-gap', 'tl-pad', 'tl-card-top', 'tl-ab-hide', 'tl-pagew', 'tl-ppad',
                   'tl-gapy', 'tl-infow', 'tl-info-left', 'tl-top-left', 'tl-order', 'tl-flow']) {
    assert.ok(a.cls.split(' ').includes(c), c);
  }
  assert.doesNotMatch(a.cls, /tl-cols|tl-title|tl-calign/);
  assert.match(a.style, /--pg-card-w:380px/);
  assert.match(a.style, /--pg-o-characters:1;--pg-o-synopsis:2;--pg-o-night:3/);
  // Defaults draw nothing: the usual icon side, full ability and info on the right.
  assert.equal(PageRender.themeAttrs({ cardLayout: 'side', cardAbility: 'full', infoPos: 'right' }).cls, 'page-themed');
  // A quick style recolours; it does not undo the arrangement.
  for (const k of ['cardW', 'order', 'infoPos', 'width']) assert.ok(!PageRender.THEME_STYLE_KEYS.includes(k), k);
  assert.ok(PageRender.THEME_LAYOUT_KEYS.includes('order'));

  // The sections the CSS reorders are marked on the published pages.
  const f = await fixture();
  t.after(() => f.finish());
  users(f);
  let r = await f.request('/api/script', post(1, {
    slug: 'laid', name: 'Laid', author: 'user-1', characters: [], status: 'published', synopsis: 'Hello',
    theme: { order: ['characters', 'synopsis'], cardW: 300 }
  }));
  assert.equal(r.status, 200, await r.clone().text());
  const html = await (await f.request('/s/laid')).text();
  assert.match(html, /<body class="[^"]*tl-order[^"]*tl-flow/);
  assert.match(html, /class="script-chars-panel sv-main"/);
  assert.match(html, /class="sv-section sv-s-synopsis"/);
  assert.match(html, /class="sv-section sv-s-characters"/);
  r = await f.request('/api/collection', post(1, { displayName: 'Flow Set', author: 'user-1', status: 'published' }));
  const made = await r.json();
  const coll = await (await f.request('/collection/' + made.id)).text();
  assert.match(coll, /<div class="coll-flow"><div class="coll-top">/);
});

test('moves: dragged parts are validated, printed as desktop-only translate rules, and kept apart from styles', async t => {
  const T = PageRender.sanitizeTheme({ moves: {
    title: [12.4, -30], 'c:imp': [5, 5], 'c:Bad"x': [1, 1], 't:demon': [0, 40], 't:nope': [1, 1],
    's:pinned': [99999, 1], info: [0, 0], nope: [3, 3], '__proto__': [1, 1], banner: 'x', logo: [1]
  } }, 'scripts/x');
  assert.deepEqual(T, { moves: { title: [12, -30], 'c:imp': [5, 5], 't:demon': [0, 40], 's:pinned': [3000, 1] } });
  const a = PageRender.themeAttrs(T);
  assert.ok(a.cls.split(' ').includes('tl-moved'));
  assert.match(a.movesCss, /^@media \(min-width: 901px\)\{/);
  assert.match(a.movesCss, /\.tl-moved \.char-card\[data-slug="imp"\]\{translate:5px 5px;position:relative;z-index:5\}/);
  assert.match(a.movesCss, /\.tl-moved \.script-team-group\[data-team="demon"\]\{translate:0px 40px/);
  assert.doesNotMatch(a.movesCss, /Bad|nope|</);
  assert.ok(PageRender.THEME_LAYOUT_KEYS.includes('moves'));
  assert.ok(!PageRender.THEME_STYLE_KEYS.includes('moves'));

  const f = await fixture();
  t.after(() => f.finish());
  users(f);
  const r = await f.request('/api/script', post(1, {
    slug: 'moved', name: 'Moved', author: 'user-1', characters: [], status: 'published',
    theme: { moves: { title: [40, 10], '</style>': [1, 1] } }
  }));
  assert.equal(r.status, 200, await r.clone().text());
  const html = await (await f.request('/s/moved')).text();
  const st = html.match(/<style id="page-moves">([\s\S]*?)<\/style>/);
  assert.ok(st, 'moves printed');
  assert.match(st[1], /\.tl-moved \.script-title-fallback\{translate:40px 10px/);
  assert.match(html, /<body class="[^"]*tl-moved/);
  assert.match(html, /class="script-char-row" href="[^"]*" data-slug=|No characters on this page yet/);
});

test('bootlegger rules: under the characters, at the top, or in the sidebar', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  users(f);
  const page = async at => {
    const r = await f.request('/api/script', post(1, { slug: 'boot', name: 'Boot', author: 'user-1', characters: [],
      status: 'published', synopsis: 'Words.', bootlegger: ['No talking.'], bootleggerAt: at }));
    assert.equal(r.status, 200, await r.clone().text());
    const html = await (await f.request('/s/boot')).text();
    const main = html.slice(html.indexOf('sv-main'), html.indexOf('<aside'));
    return { main, aside: html.slice(html.indexOf('<aside')), count: html.split('<li>No talking.</li>').length - 1 };
  };
  let p = await page('bogus');
  assert.equal(p.count, 1);
  assert.ok(p.main.indexOf('No talking.') > p.main.indexOf('Words.'), 'default: after the synopsis');
  assert.equal(JSON.parse(f.db.prepare("SELECT data FROM scripts WHERE slug='boot'").get().data).bootleggerAt, undefined);
  p = await page('top');
  assert.ok(p.main.indexOf('No talking.') < p.main.indexOf('Words.'), 'top: before the synopsis');
  p = await page('side');
  assert.equal(p.count, 1);
  assert.match(p.aside, /sv-boot-side[\s\S]*No talking\./);
});
