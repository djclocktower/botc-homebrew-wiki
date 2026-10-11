import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fixture } from './worker-fixture.mjs';
import { PICK_FN } from '../../worker/home-page.js';

const finished = { tags: 'Information', summaryBullets: ['x'], howToRun: ['y'], examples: ['z'], lede: '{{red|A}} lede' };
async function seed(f) {
  f.insert('characters', 'demo', { slug: 'demo', name: 'Demo <b>Bold</b>', team: 'townsfolk', art: 'art/demo.png',
    creator: 'Maker', ability: 'Learn a player.', ...finished });
  f.insert('characters', 'secret-char', { slug: 'secret-char', name: 'DRAFT CHARACTER', team: 'demon', art: 'art/s.png',
    creator: 'Maker', ability: 'x', ...finished }, 'draft');
  f.insert('collections', 'col', { id: 'col', slug: 'col', displayName: 'Col & Co', include: ['demo', 'secret-char'], curata: true });
  f.insert('collections', 'secret-col', { id: 'secret-col', slug: 'secret-col', displayName: 'DRAFT COLLECTION', include: ['demo'] }, 'draft');
  f.insert('scripts', 'scr', { slug: 'scr', name: 'Scr "quoted"', characters: ['demo'] });
  f.insert('scripts', 'secret-scr', { slug: 'secret-scr', name: 'DRAFT SCRIPT', characters: ['demo'] }, 'draft');
  await f.request('/api/news'); await f.request('/api/articles'); // create the lazy tables
  const news = f.db.prepare('INSERT INTO news(slug,title,status,published_at,data) VALUES(?,?,?,?,?)');
  news.run('hello', 'Hello <news>', 'published', '2026-09-01', JSON.stringify({ body: 'Hi' }));
  news.run('draft-news', 'DRAFT NEWS', 'draft', null, JSON.stringify({ body: 'Hi' }));
  const page = f.db.prepare("INSERT INTO pages(slug,title,parent_type,parent_slug,author,data,status) VALUES(?,?,'article','',?,?,?)");
  page.run('guide', 'A Guide', 'Writer', JSON.stringify({ body: 'Text', blurb: 'Blurb' }), 'published');
  page.run('draft-article', 'DRAFT ARTICLE', 'Writer', JSON.stringify({ body: 'Text' }), 'draft');
  await f.hooks.bumpContentVersion(f.env);
}
const member = { headers: { Cookie: 'botc_session=user-1' } };

test('GET / is the server-rendered homepage: every panel drawn, escaped, and no drafts', async t => {
  const f = await fixture(); t.after(() => f.finish()); await seed(f);
  const response = await f.request('/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /text\/html/);
  assert.match(response.headers.get('Link'), /parchment\.webp>; rel=preload; as=image/);
  const html = await response.text();
  assert.match(html, /id="landing-stats">1 characters · 1 collections · 1 creators · 1 scripts</);
  assert.match(html, /id="bc-team">1 characters</);
  assert.match(html, /class="collection-tile" data-pick data-w="3" href="collection\/col"/);
  assert.match(html, /Col &amp; Co/);
  assert.match(html, /Scr &quot;quoted&quot;/);
  assert.match(html, /<template id="collections-pool">/);
  assert.match(html, /window\.botcHomePick=function/);
  assert.match(html, /class="recent-card" href="c\/test-set\/demo"/);
  assert.match(html, /Demo &lt;b&gt;Bold&lt;\/b&gt;/);
  assert.match(html, /class="featured-card"/);
  assert.match(html, /<span class="cq" data-cq-slug="demo"><\/span>/, 'empty quick-action slots for card-actions.js');
  assert.match(html, /id="news-section">/);
  assert.match(html, /Hello &lt;news&gt;/);
  assert.match(html, /id="articles-section">/);
  assert.match(html, /href="p\/guide"/);
  assert.doesNotMatch(html, /DRAFT|secret-|<!--home:|Loading collections|— loading —|<b>Bold/);
  // HEAD and a repeat visit cost no body.
  const head = await f.request('/', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  const again = await f.request('/', { headers: { 'If-None-Match': response.headers.get('ETag') } });
  assert.equal(again.status, 304); assert.equal(await again.text(), '');
});

test('the homepage is one shared copy: a member gets the same bytes, and it is served from the cache', async t => {
  const f = await fixture(); t.after(() => f.finish()); await seed(f);
  f.db.prepare("INSERT INTO users(id,username,password_hash) VALUES(1,'user-1','')").run();
  f.state.sessions.set('sess:user-1', { userId: 1, username: 'user-1' });
  const anon = await (await f.request('/')).text();
  await Promise.all(f.background);
  const reads = f.calls.length;
  const asMember = await f.request('/', member);
  assert.equal(asMember.headers.get('Set-Cookie'), null);
  assert.equal(await asMember.text(), anon);
  assert.equal(f.calls.filter((c, i) => i >= reads && /FROM (characters|collections|scripts|news|pages)\b/.test(c.sql)).length, 0);
  let stored = 0;
  for (const [key, value] of f.cache) if (key.startsWith('https://ssr.internal/?home=')) {
    stored++;
    assert.doesNotMatch(await value.clone().text(), /user-1|DRAFT/);
  }
  assert.equal(stored, 1);
  // A content change rolls the page.
  f.insert('characters', 'newbie', { slug: 'newbie', name: 'Newbie', team: 'minion', art: 'art/n.png', creator: 'Other', ability: 'x' });
  await f.hooks.logActivity(f.env, null, 'create', 'character', 'newbie', 'Newbie');
  assert.match(await (await f.request('/')).text(), /Newbie/);
});

test('an empty wiki still renders, with News and Articles left hidden', async t => {
  const f = await fixture(); t.after(() => f.finish());
  const response = await f.request('/');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /0 characters · 0 collections · 0 creators · 0 scripts/);
  assert.match(html, /id="news-section" hidden/);
  assert.match(html, /id="articles-section" hidden/);
  assert.match(html, /All Collections/);
  assert.match(html, /No featured character available/);
  assert.doesNotMatch(html, /<template id="collections-pool">/);
});

test('a failed panel is served uncached; a broken template falls back to the static page', async t => {
  const f = await fixture(); t.after(() => f.finish()); await seed(f);
  f.state.intercept = ({ sql, value }) => { if (/FROM news/.test(sql) && /published/.test(sql)) throw new Error('news down'); return value; };
  const degraded = await (await f.request('/')).text();
  assert.match(degraded, /id="news-section" hidden/);
  assert.match(degraded, /Col &amp; Co/);
  await Promise.all(f.background);
  assert.equal([...f.cache.keys()].filter(k => k.startsWith('https://ssr.internal/?home=')).length, 0);
  f.state.intercept = null;

  const g = await fixture(); t.after(() => g.finish()); await seed(g);
  const real = g.env.ASSETS.fetch;
  g.env.ASSETS = { fetch: async request => new URL(request.url).pathname === '/' || new URL(request.url).pathname === '/index.html'
    ? new Response('<!doctype html><p>static homepage</p>') : real(request) };
  const fallback = await g.request('/');
  assert.equal(fallback.status, 200);
  assert.equal(await fallback.text(), '<!doctype html><p>static homepage</p>');
  // home.js fills that static page from the same markup.
  const panels = await (await g.request('/api/home?format=panels')).json();
  assert.match(panels.regions.collections, /Col &amp; Co/);
  assert.match(panels.regions.news, /Hello &lt;news&gt;/);
  assert.doesNotMatch(JSON.stringify(panels), /DRAFT/);
});

test('the inline picker swaps the server pick for a weighted random one and keeps the trailing tile', () => {
  const el = (attrs = {}) => ({ attrs, parentNode: null, getAttribute: k => attrs[k] ?? null });
  const grid = { children: [],
    querySelectorAll() { return this.children.filter(c => 'data-pick' in c.attrs); },
    removeChild(c) { this.children.splice(this.children.indexOf(c), 1); },
    insertBefore(frag) { frag.list.forEach(c => { c.parentNode = grid; }); this.children.unshift(...frag.list); } };
  const pool = Array.from({ length: 12 }, (_, i) => el({ 'data-pick': '', id: 'p' + i, ...(i === 0 ? { 'data-w': '3' } : {}) }));
  const serverPick = pool.slice(0, 7).map(p => el({ ...p.attrs }));
  const all = el({ id: 'all' });
  grid.children.push(...serverPick, all); grid.children.forEach(c => { c.parentNode = grid; });
  const context = { Math, window: {}, document: {
    getElementById: id => id === 'g' ? grid : id === 't' ? { content: { children: pool } } : null,
    createDocumentFragment: () => ({ list: [], appendChild(n) { this.list.push(n); } }),
    importNode: n => el({ ...n.attrs }) } };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(PICK_FN + 'botcHomePick("g","t",7)', context);
  assert.equal(grid.children.length, 8);
  assert.equal(grid.children[7], all);
  assert.equal(new Set(grid.children.slice(0, 7).map(c => c.attrs.id)).size, 7);
  assert.ok(grid.children.slice(0, 7).every(c => !serverPick.includes(c)));
});
