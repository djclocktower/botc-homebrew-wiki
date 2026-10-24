import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';

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

test('standalone articles: any member writes one, only they edit it, it is listed and indexed', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  users(f);

  // Logged out: no writing.
  assert.equal((await f.request('/api/wiki-page', { method: 'POST', body: '{}' })).status, 401);

  // Any member may start one: no script or collection needed.
  let r = await f.request('/api/wiki-page', post(1, {
    parentType: 'article', title: 'How to Write a Demon', body: 'Start with the **win condition**.', status: 'draft'
  }));
  assert.equal(r.status, 200, await r.clone().text());
  const made = await r.json();
  assert.equal(made.slug, 'how-to-write-a-demon');
  assert.equal(made.status, 'draft');
  assert.equal(made.parentType, 'article');

  // A draft is the writer's alone: not listed for others, 404 to them.
  let list = await (await f.request('/api/articles')).json();
  assert.equal(list.articles.length, 0);
  list = await (await f.request('/api/articles?mine=1', member(1))).json();
  assert.equal(list.articles.length, 1);
  assert.equal(list.articles[0].status, 'draft');
  assert.equal((await f.request('/api/articles?mine=1', member(2)).then(x => x.json())).articles.length, 0);
  assert.equal((await f.request('/p/how-to-write-a-demon', member(2))).status, 404);

  // Somebody else cannot edit or delete it: no set's sharing choice reaches it.
  r = await f.request('/api/wiki-page', post(2, { slug: made.slug, title: 'Mine now', body: 'x', status: 'published' }));
  assert.equal(r.status, 403);
  r = await f.request('/api/wiki-page', post(2, { action: 'delete', slug: made.slug }));
  assert.equal(r.status, 403);

  // The writer publishes it.
  r = await f.request('/api/wiki-page', post(1, { slug: made.slug, title: 'How to Write a Demon', body: 'Start with the **win condition**.', status: 'published' }));
  assert.equal((await r.json()).status, 'published');

  list = await (await f.request('/api/articles')).json();
  assert.equal(list.articles.length, 1);
  assert.equal(list.articles[0].ownerUsername, 'user-1');

  // Listed, so indexable — unlike a set's page — and its way back is /articles.
  const html = await (await f.request('/p/how-to-write-a-demon')).text();
  assert.doesNotMatch(html, /name="robots" content="noindex/);
  assert.match(html, /href="\.\.\/articles"[^>]*>&larr; All articles/);

  // In the sitemap.
  const sm = await (await f.request('/sitemap.xml')).text();
  assert.match(sm, /\/p\/how-to-write-a-demon</);
  assert.match(sm, /\/articles</);

  // And in the site search.
  const si = await (await f.request('/api/search-index')).json();
  assert.ok(si.pages.some(p => p.slug === 'how-to-write-a-demon'));
});

test('a page under a script stays unlisted and noindex', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  users(f);
  f.db.prepare("INSERT INTO scripts(slug,name,data,status,owner_id) VALUES('demo','Demo',?,'published',1)")
    .run(JSON.stringify({ slug: 'demo', name: 'Demo', characters: [] }));
  let r = await f.request('/api/wiki-page', post(1, { parentType: 'script', parentSlug: 'demo', title: 'Rules', body: 'x', status: 'published' }));
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await (await f.request('/api/articles')).json()).articles.length, 0);
  assert.match(await (await f.request('/p/rules')).text(), /noindex/);
  // A member who does not own the script still cannot add a page to it.
  r = await f.request('/api/wiki-page', post(2, { parentType: 'script', parentSlug: 'demo', title: 'Mine', body: 'x' }));
  assert.equal(r.status, 403);
});
