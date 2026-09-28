import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fixture } from './worker-fixture.mjs';

const as = who => ({ headers: { Cookie: 'botc_session=' + who } });
const post = (who, body) => ({
  method: 'POST',
  headers: { Cookie: 'botc_session=' + who, 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});
const feature = (f, who, slug, on = true) =>
  f.request('/api/admin/featured-article', post(who, { slug, on }));

async function seed(f) {
  f.db.prepare("INSERT INTO users(id,username,password_hash,is_admin) VALUES(1,'admin','',1)").run();
  f.db.prepare("INSERT INTO users(id,username,password_hash) VALUES(2,'member','')").run();
  f.state.sessions.set('sess:admin', { userId: 1, username: 'admin', isAdmin: true });
  f.state.sessions.set('sess:member', { userId: 2, username: 'member' });
  f.insert('collections', 'Travel', { id: 'travel', slug: 'Travel', displayName: 'Travel by the Starlight' });
  f.insert('scripts', 'gone', { slug: 'gone', name: 'Gone', characters: [] }, 'deleted');
  await f.hooks.ensurePagesTable(f.env);
  const page = (slug, title, parentType, parentSlug, status, data) =>
    f.db.prepare('INSERT INTO pages(slug,title,parent_type,parent_slug,author,owner_id,data,status) VALUES(?,?,?,?,?,2,?,?)')
      .run(slug, title, parentType, parentSlug, 'Harry & Co', JSON.stringify(data), status);
  page('painting', 'Painting <the> Stars', 'collection', 'Travel', 'published',
    { blurb: 'An all-in-one guide <script>bad()</script>', body: 'Text.' });
  page('unfinished', 'Unfinished', 'collection', 'Travel', 'draft', { body: 'Soon.' });
  page('orphan', 'Orphan', 'script', 'gone', 'published', { body: 'Its script was deleted.' });
}

test('only admins feature a page, by link or slug, and only a published one', async t => {
  const f = await fixture(); t.after(() => f.finish()); await seed(f);
  assert.deepEqual(await (await f.request('/api/featured-articles')).json(), { articles: [] });
  assert.deepEqual(await (await f.request('/api/featured-articles?limit=3&format=cards')).json(), { html: '' });

  assert.equal((await feature(f, 'member', 'painting')).status, 403);
  assert.equal((await feature(f, 'admin', 'unfinished')).status, 400);
  assert.equal((await feature(f, 'admin', 'no-such-page')).status, 404);
  assert.equal((await feature(f, 'admin', 'not a link at all!')).status, 400);

  const res = await (await feature(f, 'admin', 'https://botchomebrew.wiki/p/painting')).json();
  assert.equal(res.featured, true);
  assert.deepEqual(res.articles.map(a => a.slug), ['painting']);
  // Featuring it again keeps its place rather than duplicating it.
  await feature(f, 'admin', 'painting');
  assert.equal((await (await f.request('/api/featured-articles')).json()).articles.length, 1);

  const { html } = await (await f.request('/api/featured-articles?limit=3&format=cards')).json();
  assert.match(html, /class="news-card" href="p\/painting"/);
  assert.match(html, /by Harry &amp; Co · Travel by the Starlight/);
  assert.match(html, /Painting &lt;the&gt; Stars/);
  assert.doesNotMatch(html, /<script>|<the>/);
});

test('hidden picks drop out of the public list but stay visible to admins; deleting a page forgets it', async t => {
  const f = await fixture(); t.after(() => f.finish()); await seed(f);
  await feature(f, 'admin', 'painting');
  await feature(f, 'admin', '/p/orphan');
  const pub = await (await f.request('/api/featured-articles')).json();
  assert.deepEqual(pub.articles.map(a => a.slug), ['painting'], 'a page whose parent is deleted is not shown');
  // ?all=1 is admin-only; anybody else gets the public list.
  assert.deepEqual(await (await f.request('/api/featured-articles?all=1', as('member'))).json(), pub);
  const all = (await (await f.request('/api/featured-articles?all=1', as('admin'))).json()).articles;
  assert.deepEqual(all.map(a => [a.slug, a.hidden]), [['orphan', 'parent-deleted'], ['painting', '']]);

  // Back to draft: hidden, but still picked, so republishing brings it back.
  const response = await f.request('/api/featured-articles');
  f.db.prepare("UPDATE pages SET status='draft' WHERE slug='painting'").run();
  await f.hooks.logActivity(f.env, { userId: 2 }, 'update', 'wikipage', 'painting', 'Painting');
  const changed = await f.request('/api/featured-articles', { headers: { 'If-None-Match': response.headers.get('ETag') } });
  assert.equal(changed.status, 200);
  assert.deepEqual((await changed.json()).articles, []);
  const hidden = (await (await f.request('/api/featured-articles?all=1', as('admin'))).json()).articles;
  assert.equal(hidden.find(a => a.slug === 'painting').hidden, 'draft');
  f.db.prepare("UPDATE pages SET status='published' WHERE slug='painting'").run();
  await f.hooks.logActivity(f.env, { userId: 2 }, 'publish', 'wikipage', 'painting', 'Painting');
  assert.equal((await (await f.request('/api/featured-articles')).json()).articles.length, 1);

  // Deleting the page removes the pick for good, so a new page reusing the
  // slug is not featured by accident.
  const del = await f.request('/api/wiki-page', post('admin', { action: 'delete', slug: 'painting' }));
  assert.equal(del.status, 200);
  const picks = JSON.parse(f.db.prepare("SELECT value FROM settings WHERE key='featured_articles'").get().value);
  assert.deepEqual(picks.map(p => p.slug), ['orphan']);

  // Unfeaturing takes it off and is logged.
  const off = await (await feature(f, 'admin', 'orphan', false)).json();
  assert.equal(off.featured, false);
  assert.deepEqual(off.articles, []);
  assert.ok(f.db.prepare("SELECT 1 FROM activity_log WHERE action='unfeature' AND entity_slug='orphan'").get());
});

test('the public list is cached and revalidates by ETag until a feature changes it', async t => {
  const f = await fixture(); t.after(() => f.finish()); await seed(f);
  await feature(f, 'admin', 'painting');
  const path = '/api/featured-articles?limit=3&format=cards';
  const first = await f.request(path);
  const body = await first.text();
  await Promise.all(f.background);
  const scans = () => f.calls.filter(c => /FROM pages WHERE slug IN/.test(c.sql)).length;
  const before = scans();
  assert.equal(await (await f.request(path)).text(), body);
  assert.equal(scans(), before, 'the warm edge copy needs no page query');
  const same = await f.request(path, { headers: { 'If-None-Match': first.headers.get('ETag') } });
  assert.equal(same.status, 304);
  assert.match(same.headers.get('Cache-Control'), /private.*must-revalidate/);
  await feature(f, 'admin', 'painting', false);
  const after = await f.request(path, { headers: { 'If-None-Match': first.headers.get('ETag') } });
  assert.equal(after.status, 200);
  assert.deepEqual(await after.json(), { html: '' });
});

test('a draft page tells wikipage.js it cannot be featured; a published one does not', async t => {
  const f = await fixture(); t.after(() => f.finish()); await seed(f);
  f.db.prepare("UPDATE pages SET owner_id=1 WHERE slug='unfinished'").run();
  assert.match(await (await f.request('/p/unfinished', as('admin'))).text(), /window\.WIKI_PAGE_DRAFT = true/);
  assert.doesNotMatch(await (await f.request('/p/painting')).text(), /WIKI_PAGE_DRAFT/);
});

test('the homepage draws featured cards under News, and hides the section when nothing is featured', async () => {
  const source = await readFile(new URL('../../assets/home.js', import.meta.url), 'utf8');
  for (const html of ['<a class="news-card" href="p/painting">Painting</a>', '']) {
    const nodes = {};
    const context = { console,
      document: { getElementById: id => (nodes[id] = nodes[id] || { innerHTML: '', textContent: '', hidden: true }) },
      BotcData: { json: path => path === '/api/featured-articles?limit=3&format=cards'
        ? Promise.resolve({ html }) : Promise.reject(new Error('offline')) } };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source, context);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(nodes['articles-grid'].innerHTML, html);
    assert.equal(nodes['articles-section'].hidden, !html);
  }
});
