// Run with Node 22.13+ / 24: node --test migration/tests/read-path.test.mjs
// The server's read path: how many D1 round trips a page costs, that reads
// never write the schema, and that the schema is still created lazily.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';

// Page-view counting runs in the background (and is not this file's subject).
const foreground = c => !/page_views|sqlite_master/.test(c.sql);
const schemaWrite = c => /^\s*(CREATE|ALTER|DROP)\b/i.test(c.sql);

// Delay every D1 call and record when it ran, so the number of sequential
// round trips ("waves") a request needed can be read back.
function timed(f, delay = 15) {
  const log = [];
  const prepare = f.env.DB.prepare.bind(f.env.DB);
  f.env.DB.prepare = sql => {
    const st = prepare(sql);
    for (const k of ['all', 'first', 'run']) {
      const run = st[k].bind(st);
      st[k] = async (...a) => {
        const t0 = performance.now();
        await new Promise(r => setTimeout(r, delay));
        try { return await run(...a); } finally { log.push({ sql, t0, t1: performance.now() }); }
      };
    }
    return st;
  };
  return log;
}
function waves(calls) {
  let n = 0, end = -Infinity;
  for (const c of calls.slice().sort((a, b) => a.t0 - b.t0)) {
    if (c.t0 >= end - 1) { n++; end = c.t1; } else end = Math.max(end, c.t1);
  }
  return n;
}

function seed(f) {
  f.insert('collections', 'Legacy Name', { id: 'the-set', slug: 'Legacy Name', displayName: 'The Set', include: ['member'], curata: true });
  f.insert('characters', 'member', { name: 'Member', team: 'townsfolk', ability: 'Each night, learn a thing.',
    howToRun: ['Place the [[Other]] token.'], jinxes: [{ name: 'Other', text: 'A [[Member]] rule.' }] });
  f.insert('characters', 'other', { name: 'Other', team: 'minion', ability: 'Something.' });
  f.insert('scripts', 'demo', { slug: 'demo', name: 'Demo', characters: ['member', 'other', 'off-imp'],
    customBoxes: [{ title: 'Notes', content: 'See [[Member]].' }] });
  f.insert('scripts', 'plain', { slug: 'plain', name: 'Plain', characters: ['member'] });
  f.db.exec(`CREATE TABLE pages (slug TEXT PRIMARY KEY, title TEXT NOT NULL, parent_type TEXT NOT NULL,
    parent_slug TEXT NOT NULL, author TEXT, owner_id INTEGER, data TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  f.db.prepare("INSERT INTO pages(slug,title,parent_type,parent_slug,data,status) VALUES('rules','Rules','script','demo',?,'published')")
    .run(JSON.stringify({ title: 'Rules', body: 'About [[Member]].' }));
}

test('SSR misses in a cold isolate take two D1 round trips and never write the schema', async () => {
  const limits = { '/c/test-set/member': 2, '/s/demo': 2, '/collection/the-set': 3, '/p/rules': 2 };
  for (const [path, max] of Object.entries(limits)) {
    const f = await fixture();
    seed(f);
    const log = timed(f);
    const res = await f.request(path);
    const html = await res.text();
    assert.equal(res.status, 200, path);
    const fg = log.filter(foreground);
    assert.ok(waves(fg) <= max, `${path}: ${waves(fg)} round trips (max ${max}): ${fg.map(c => c.sql.slice(0, 60)).join(' | ')}`);
    assert.deepEqual(f.calls.filter(schemaWrite).map(c => c.sql.slice(0, 40)), [], path);
    assert.match(res.headers.get('Server-Timing') || '', /cache;desc="miss", d1;desc="\d+ queries", app;dur=\d+/);
    if (path === '/s/demo' || path === '/p/rules') assert.match(html, /class="wiki-charlink" href="\.\.\/c\/test-set\/member"/);
    await f.finish();
  }
});

test('/c/ fetches the version and the row in one round trip, and the collection set once', async () => {
  const f = await fixture();
  seed(f);
  const log = timed(f);
  const html = await (await f.request('/c/test-set/member')).text();
  const fg = log.filter(foreground).sort((a, b) => a.t0 - b.t0);
  // The first wave is the version read and the row, side by side.
  const first = fg.filter(c => c.t0 < fg[0].t1 - 1).map(c => c.sql);
  assert.ok(first.some(s => /cache_versions/.test(s)) && first.some(s => /FROM characters WHERE url_slug=\?/.test(s)), first.join(' | '));
  // Curata and "Appears in" share one collections read.
  assert.equal(f.calls.filter(c => /FROM collections WHERE status='published'/.test(c.sql)).length, 1);
  // Its own text and its jinx both had [[links]].
  assert.match(html, /The Set/);
  await f.finish();
});

test('a page without [[links]] never builds the link map; a cache hit carries no stored timing', async () => {
  const f = await fixture();
  seed(f);
  const res = await f.request('/s/plain');
  assert.equal(res.status, 200);
  await Promise.all(f.background);
  assert.equal(f.calls.filter(c => /SELECT slug, url_slug, name FROM characters/.test(c.sql)).length, 0);
  assert.ok(![...f.cache.keys()].some(k => k.includes('char-links')));
  // The stored SSR copy has no Server-Timing; the hit gets its own.
  const stored = [...f.cache.entries()].find(([k]) => k.startsWith('https://ssr.internal/s/plain'));
  assert.ok(stored);
  assert.equal(stored[1].headers.get('Server-Timing'), null);
  const hit = await f.request('/s/plain');
  assert.match(hit.headers.get('Server-Timing') || '', /cache;desc="hit"/);
  await f.finish();
});

test('a link map is its own edge entry, built from three columns rather than the card feed', async () => {
  const f = await fixture();
  seed(f);
  await (await f.request('/p/rules')).text();
  await Promise.all(f.background);
  assert.ok([...f.cache.keys()].some(k => k.startsWith('https://feed.internal/char-links.json')));
  assert.ok(!f.calls.some(c => /SELECT data, status, slug, url_slug, updated_at FROM characters WHERE status='published'$/.test(c.sql.trim())));
  await f.finish();
});

test('/api/boot is one round trip, creates nothing, and answers 304 to its own ETag', async () => {
  const f = await fixture();
  const log = timed(f);
  const res = await f.request('/api/boot');
  assert.deepEqual(await res.json(), { items: [], announcement: null });
  assert.equal(waves(log), 1);
  assert.deepEqual(f.calls.filter(schemaWrite), []);
  const etag = res.headers.get('ETag');
  assert.match(etag, /^W\/"boot-/);
  assert.match(res.headers.get('Cache-Control'), /max-age=0, must-revalidate/);
  const again = await f.request('/api/boot', { headers: { 'If-None-Match': etag } });
  assert.equal(again.status, 304);
  await f.finish();

  // A rewrite (seen by a fresh isolate) changes the tag, so the edit shows.
  const g = await fixture();
  g.db.exec("CREATE TABLE site_text (id INTEGER PRIMARY KEY, scope TEXT NOT NULL DEFAULT '*', source TEXT, original TEXT NOT NULL, replacement TEXT NOT NULL, updated_at TEXT, updated_by TEXT)");
  g.db.exec("INSERT INTO site_text(scope, original, replacement) VALUES('*','Tools','Toolbox')");
  const edited = await g.request('/api/boot', { headers: { 'If-None-Match': etag } });
  assert.equal(edited.status, 200);
  assert.deepEqual((await edited.json()).items, [{ o: 'Tools', r: 'Toolbox', s: '*' }]);
  await g.finish();
});

test('the schema is still created lazily, and only when it is missing', async () => {
  // Empty database: reads find nothing and create nothing.
  const f = await fixture();
  assert.equal((await f.request('/p/nothing')).status, 404);
  assert.equal((await f.request('/news/nothing')).status, 404);
  assert.deepEqual(f.calls.filter(schemaWrite), []);
  // The first write path's ensure builds the table and its indexes...
  await f.hooks.ensurePagesTable(f.env);
  assert.ok(f.calls.some(c => /CREATE TABLE IF NOT EXISTS pages/.test(c.sql)));
  assert.ok(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_pages_owner'").get());
  await f.finish();
  // ...and a new isolate that finds them in place writes nothing at all.
  const g = await fixture();
  g.db.exec(`CREATE TABLE pages (slug TEXT PRIMARY KEY, title TEXT NOT NULL, parent_type TEXT NOT NULL, parent_slug TEXT NOT NULL, author TEXT, owner_id INTEGER, data TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', created_at TEXT, updated_at TEXT);
    CREATE INDEX idx_pages_parent ON pages(parent_type, parent_slug, status);
    CREATE INDEX idx_pages_owner ON pages(owner_id);`);
  await g.hooks.ensurePagesTable(g.env);
  assert.deepEqual(g.calls.filter(schemaWrite), []);
  assert.equal(g.calls.filter(c => /sqlite_master/.test(c.sql)).length, 1);
  await g.finish();
});

test('a database without the url_slug column gets it on the first character read', async () => {
  const f = await fixture();
  f.db.exec('ALTER TABLE characters DROP COLUMN url_slug');
  f.db.prepare("INSERT INTO characters(slug,name,team,data,status,updated_at) VALUES('old','Old','townsfolk',?,'published','2026-09-09 00:00:00')")
    .run(JSON.stringify({ name: 'Old', team: 'townsfolk', ability: 'x' }));
  const res = await f.request('/c/old');
  assert.equal(res.status, 200);
  assert.ok(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_characters_url_slug'").get());
  await f.finish();
});
