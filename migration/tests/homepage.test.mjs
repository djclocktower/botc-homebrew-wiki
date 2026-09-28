import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fixture } from './worker-fixture.mjs';
import NewsRender from '../../assets/render-news.js';
import WikiRender from '../../assets/render-wiki.js';
import { homeData } from '../../worker/home-data.js';

NewsRender.init(WikiRender);
const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8');
const scans = f => f.calls.filter(c => /SELECT slug, title, status/.test(c.sql)).length;
async function seedNews(f) {
  await f.request('/api/news'); // initialize the table
  for (const [slug, status, date, pinned] of [
    ['latest', 'published', '2026-09-20', false],
    ['pinned', 'published', '2026-09-19', true],
    ['older', 'published', '2026-09-18', false],
    ['draft-secret', 'draft', '2026-09-21', true],
    ['deleted-secret', 'deleted', '2026-09-22', true]
  ]) f.db.prepare('INSERT INTO news(slug,title,status,published_at,data) VALUES(?,?,?,?,?)')
    .run(slug, '<' + slug + '>', status, date, JSON.stringify({ pinned, body: 'A {{red|story}} <script>bad()</script>' }));
  await f.hooks.bumpContentVersion(f.env, 'news');
}

test('public news reuses its edge copy and ETag, keeps ordering/escaping, and isolates formats and limits', async t => {
  const f = await fixture(); t.after(() => f.finish()); await seedNews(f);
  const path = '/api/news?limit=3&format=cards';
  const response = await f.request(path), { html } = await response.json();
  assert.ok(html.indexOf('&lt;pinned&gt;') < html.indexOf('&lt;latest&gt;'));
  assert.doesNotMatch(html, /draft-secret|deleted-secret|<script>/);
  const rows = (await (await f.request('/api/news?limit=3')).json()).articles;
  assert.equal(html, [rows[1], rows[0], rows[2]].map(a => NewsRender.renderCard(a)).join(''));
  await Promise.all(f.background);
  const before = scans(f);
  assert.deepEqual(await (await f.request(path)).json(), { html });
  assert.equal(scans(f), before, 'warm edge copy needs no news query');
  const unchanged = await f.request(path, { headers: { 'If-None-Match': response.headers.get('ETag') } });
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), '');
  assert.equal(scans(f), before);
  assert.match(unchanged.headers.get('Cache-Control'), /private.*must-revalidate/);
  const other = await f.request('/api/news?limit=1', { headers: { 'If-None-Match': response.headers.get('ETag') } });
  assert.equal(other.status, 200);
  assert.equal((await other.json()).articles.length, 1);
});

test('news edits and unpublishing invalidate cards, without invalidating the homepage character snapshot', async t => {
  const f = await fixture(); t.after(() => f.finish()); await seedNews(f);
  const home = await f.request('/api/home');
  const news = await f.request('/api/news?limit=3&format=cards');
  f.db.prepare("UPDATE news SET title='Edited headline' WHERE slug='latest'").run();
  await f.hooks.logActivity(f.env, null, 'update', 'news', 'latest', 'Edited headline');
  const edited = await f.request('/api/news?limit=3&format=cards', { headers: { 'If-None-Match': news.headers.get('ETag') } });
  assert.equal(edited.status, 200);
  assert.match((await edited.json()).html, /Edited headline/);
  f.db.prepare("UPDATE news SET status='draft' WHERE slug='latest'").run();
  await f.hooks.logActivity(f.env, null, 'unpublish', 'news', 'latest', 'Edited headline');
  assert.doesNotMatch((await (await f.request('/api/news?limit=3&format=cards')).json()).html, /Edited headline/);
  assert.equal((await f.request('/api/home', { headers: { 'If-None-Match': home.headers.get('ETag') } })).status, 304);
});

test('admin news drafts are never cached or returned to an anonymous drafts request', async t => {
  const f = await fixture(); t.after(() => f.finish()); await seedNews(f);
  f.db.prepare("INSERT INTO users(id,username,password_hash,is_admin) VALUES(1,'admin','',1)").run();
  f.state.sessions.set('sess:admin', { userId: 1, username: 'admin', isAdmin: true });
  const response = await f.request('/api/news?drafts=1', { headers: { Cookie: 'botc_session=admin' } });
  assert.match(await response.text(), /draft-secret/);
  assert.equal(response.headers.get('ETag'), null);
  assert.match(response.headers.get('Cache-Control'), /no-store/);
  const publicResponse = await f.request('/api/news?drafts=1');
  assert.doesNotMatch(await publicResponse.text(), /draft-secret|deleted-secret/);
  await Promise.all(f.background);
  for (const [key, value] of f.cache) if (key.includes('/news.json')) {
    assert.doesNotMatch(await value.clone().text(), /draft-secret|deleted-secret/);
  }
});

test('concurrent news requests share a build; failed builds retry without caching an empty list', async t => {
  const f = await fixture(); t.after(() => f.finish()); await seedNews(f);
  const before = scans(f);
  const responses = await Promise.all(Array.from({ length: 12 }, () => f.request('/api/news?limit=3')));
  assert.ok(responses.every(r => r.status === 200));
  assert.equal(scans(f), before + 1);
  await f.hooks.bumpContentVersion(f.env, 'news');
  f.state.intercept = ({ sql, value }) => {
    if (/SELECT slug, title, status/.test(sql)) throw new Error('temporary database outage');
    return value;
  };
  await assert.rejects(f.request('/api/news?limit=3'), /temporary database outage/);
  f.state.intercept = null;
  assert.equal((await (await f.request('/api/news?limit=3')).json()).articles.length, 3);
});

test('a conditional homepage request in a fresh isolate skips feed scans and body generation', async () => {
  const first = await fixture();
  const etag = (await first.request('/api/home')).headers.get('ETag');
  await first.finish();
  const cold = await fixture();
  try {
    const response = await cold.request('/api/home', { headers: { 'If-None-Match': etag } });
    assert.equal(response.status, 304);
    assert.equal(await response.text(), '');
    assert.equal(cold.calls.filter(c => /FROM (characters|collections|scripts)\b/.test(c.sql)).length, 0);
    assert.equal(cold.cache.size, 0);
  } finally { await cold.finish(); }
});

test('homepage renders without article/creator scripts, preserves escaped ledes and lazy featured art, and tolerates news failure', async () => {
  const c = { slug: 'demo', page: 'c/set/demo', name: 'Demo', team: 'townsfolk', art: 'art/demo.png',
    creator: 'Creator', ability: 'Learn a player.', classification: 'standard', lede: '{{red|A story}} <img src=x onerror=bad()>' };
  const data = homeData([c], [], [], 20000);
  assert.equal(data.featured.plainLede, WikiRender.plainText(c.lede));
  const ids = ['news-section','news-grid','articles-section','articles-grid','landing-stats','bc-team','bc-creator','bc-tag','bc-jinx',
    'recent-strip','featured-wrap','collections-grid','scripts-grid','home-rules'];
  const nodes = Object.fromEntries(ids.map(id => [id, { innerHTML: '', textContent: '', hidden: true }]));
  const context = { document: { getElementById: id => nodes[id] }, console,
    BotcData: { json: path => path === '/api/home' ? Promise.resolve(data) : Promise.reject(new Error('news offline')) } };
  context.window = context;
  vm.createContext(context);
  for (const path of ['assets/render-page.js', 'assets/classify.js', 'assets/rules.js', 'assets/home.js']) {
    vm.runInContext(await read(path), context);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.match(nodes['landing-stats'].textContent, /1 characters/);
  assert.match(nodes['featured-wrap'].innerHTML, /loading="lazy"[^>]*class="featured-art"/);
  assert.match(nodes['featured-wrap'].innerHTML, /A story/);
  assert.doesNotMatch(nodes['featured-wrap'].innerHTML, /<img src=x|\{\{red/);
  assert.match(nodes['collections-grid'].innerHTML, /All Collections/);
  assert.ok(nodes['home-rules'].innerHTML);
  assert.equal(nodes['news-section'].hidden, true);
  assert.equal(nodes['articles-section'].hidden, true);
});
