import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';

// A reader's browser visiting a page: the only kind of request whose 404 the
// problem log counts.
const BROWSER = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const visit = (extra = {}) => ({ headers: { 'User-Agent': BROWSER, Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate', ...extra } });
const as = who => ({ headers: { Cookie: 'botc_session=' + who } });
const post = (who, body) => ({
  method: 'POST',
  headers: { Cookie: 'botc_session=' + who, 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});
const beacon = (body, headers = {}) => ({
  method: 'POST',
  headers: { 'User-Agent': BROWSER, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', 'CF-Connecting-IP': '203.0.113.1', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body)
});
const rows = f => {
  try { return f.db.prepare('SELECT * FROM problem_log ORDER BY first_seen, fp').all(); }
  catch { return []; }
};
const settle = f => Promise.all(f.background.splice(0));

async function quietly(fn) {
  const origError = console.error, origLog = console.log;
  console.error = () => {}; console.log = () => {};
  try { return await fn(); } finally { console.error = origError; console.log = origLog; }
}
// Date.now() under the test's control: the throttle is all about minutes.
function clock(start = Date.parse('2026-10-11T08:00:00Z')) {
  const real = Date.now;
  let t = start;
  Date.now = () => t;
  return { advance(ms) { t += ms; }, restore() { Date.now = real; } };
}
function admins(f) {
  f.db.prepare("INSERT INTO users(id,username,password_hash,is_admin) VALUES(1,'admin','',1)").run();
  f.db.prepare("INSERT INTO users(id,username,password_hash) VALUES(2,'member','')").run();
  f.state.sessions.set('sess:admin', { userId: 1, username: 'admin', isAdmin: true });
  f.state.sessions.set('sess:member', { userId: 2, username: 'member' });
}
// Every query but the problem log's own throws as it is prepared, which no
// route catches, so the request crashes (as in crash-page.test.mjs).
const breakEverything = f => {
  const real = f.state.realPrepare = f.state.realPrepare || f.env.DB.prepare;
  f.env.DB.prepare = sql => {
    if (/problem_log/.test(sql)) return real.call(f.env.DB, sql);
    throw new Error('boom 12345');
  };
};
const mend = f => { if (f.state.realPrepare) f.env.DB.prepare = f.state.realPrepare; f.state.intercept = null; };

test('a crash is recorded once, with a pattern for the place and no query string anywhere', async t => {
  const f = await fixture(); t.after(() => f.finish());
  breakEverything(f);
  const res = await quietly(() => f.safeRequest('/c/set/x?token=secret', visit()));
  mend(f);
  assert.equal(res.status, 500);
  await settle(f);
  const all = rows(f);
  assert.equal(all.length, 1);
  assert.equal(all[0].kind, 'crash');
  assert.equal(all[0].route, '/c/:page');
  assert.equal(all[0].sample, '/c/set/x');
  assert.ok(!JSON.stringify(all[0]).includes('secret'));
});

test('a crash that keeps happening is throttled to one write a minute, and the count catches up', async t => {
  const f = await fixture(); t.after(() => f.finish());
  const c = clock(); t.after(() => c.restore());
  breakEverything(f);
  await quietly(async () => {
    for (let i = 0; i < 100; i++) await f.safeRequest('/c/set/x', visit());
  });
  await settle(f);
  const inserts = () => f.calls.filter(x => /INSERT INTO problem_log/.test(x.sql)).length;
  assert.ok(inserts() <= 2, inserts() + ' writes for 100 crashes');
  c.advance(61000);
  await quietly(() => f.safeRequest('/c/set/x', visit()));
  mend(f);
  await settle(f);
  assert.equal(rows(f)[0].count, 101);
});

test('an ordinary answer is untouched by the problem log', async t => {
  const f = await fixture(); t.after(() => f.finish());
  f.insert('characters', 'witch', { name: 'Witch', team: 'minion', ability: 'Each night, choose a player.' });
  const direct = await (await f.request('/c/test-set/witch', visit())).text();
  const netted = await f.safeRequest('/c/test-set/witch', visit());
  assert.equal(netted.status, 200);
  assert.equal(await netted.text(), direct);
  await settle(f);
  assert.equal(rows(f).length, 0);
});

test('a missing page is counted only for a real browser visit, never for bots, scanners or non-pages', async t => {
  const f = await fixture(); t.after(() => f.finish());
  const r = await f.safeRequest('/c/nope', visit());
  assert.equal(r.status, 404);
  await settle(f);
  let all = rows(f);
  assert.equal(all.length, 1);
  assert.equal(all[0].kind, 'notfound');
  assert.equal(all[0].route, '/c/nope');

  await f.safeRequest('/c/googled', visit({ 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' }));
  await f.safeRequest('/c/x.php', visit());
  await f.safeRequest('/c/json-please', visit({ Accept: 'application/json' }));
  const noMode = visit(); delete noMode.headers['Sec-Fetch-Mode'];
  await f.safeRequest('/c/scripted', noMode);
  await settle(f);
  all = rows(f);
  assert.deepEqual(all.map(x => x.route), ['/c/nope']);
});

test('a scanner cannot fill the table: new missing addresses are capped per day, known ones still count', async t => {
  const f = await fixture(); t.after(() => f.finish());
  const c = clock(); t.after(() => c.restore());
  for (let i = 0; i < 201; i++) {
    if (i && i % 10 === 0) c.advance(61000);
    await f.safeRequest('/missing-' + i, visit());
  }
  await settle(f);
  const all = rows(f);
  assert.equal(all.length, 200);
  assert.ok(!all.some(x => x.route === '/missing-200'));
  c.advance(61000);
  await f.safeRequest('/missing-0', visit());
  await settle(f);
  assert.equal(f.db.prepare("SELECT count FROM problem_log WHERE route='/missing-0'").get().count, 2);
});

test('a 503 is recorded as a server problem; a 502 (somebody else\'s site failing) is not', async t => {
  const f = await fixture(); t.after(() => f.finish());
  const real = f.hooks.app.fetch;
  t.after(() => { f.hooks.app.fetch = real; });
  f.hooks.app.fetch = async () => new Response('{}', { status: 502 });
  assert.equal((await f.safeRequest('/api/bloodstar?url=x')).status, 502);
  f.hooks.app.fetch = async () => new Response('{}', { status: 503 });
  assert.equal((await f.safeRequest('/api/login', { method: 'POST' })).status, 503);
  f.hooks.app.fetch = real;
  await settle(f);
  const all = rows(f);
  assert.equal(all.length, 1);
  assert.equal(all[0].kind, 'server');
  assert.equal(all[0].route, '/api/login');
  assert.equal(all[0].message, 'answered 503');
});

test('the browser beacon keeps a real report from our own scripts and quietly drops everything else', async t => {
  const f = await fixture(); t.after(() => f.finish());
  admins(f);
  const good = { message: 'x is not defined', source: 'https://botchomebrew.wiki/assets/site.js', line: 12, col: 3, stack: 'ReferenceError: x is not defined\n at https://botchomebrew.wiki/assets/site.js?v=1:12:3', page: '/all-characters' };
  const r = await f.safeRequest('/api/client-error', beacon(good));
  assert.equal(r.status, 204);
  assert.equal(await r.text(), '');
  await settle(f);
  let all = rows(f);
  assert.equal(all.length, 1);
  assert.equal(all[0].kind, 'browser');
  assert.equal(all[0].route, '/all-characters');
  assert.match(all[0].message, /x is not defined \(site\.js:12\)/);
  assert.ok(!all[0].detail.includes('?v=1'), 'query strings come off the stack');

  // Each of these answers 204 and records nothing.
  const dropped = [
    beacon({ ...good, message: 'from an extension', source: 'chrome-extension://abc/content.js' }, { 'CF-Connecting-IP': '203.0.113.2' }),
    beacon({ ...good, message: 'Script error.' }, { 'CF-Connecting-IP': '203.0.113.3' }),
    beacon(JSON.stringify({ ...good, message: 'big', stack: 'x'.repeat(9000) }), { 'CF-Connecting-IP': '203.0.113.4', 'Content-Length': '9100' }),
    beacon({ ...good, message: 'not ours', source: 'https://example.com/assets/site.js' }, { 'CF-Connecting-IP': '203.0.113.5' }),
    beacon({ ...good, message: 'not an asset', source: 'https://botchomebrew.wiki/somewhere.js' }, { 'CF-Connecting-IP': '203.0.113.6' }),
    beacon({ ...good, message: 'forged file', source: 'https://botchomebrew.wiki/assets/not-a-real-file.js' }, { 'CF-Connecting-IP': '203.0.113.7' }),
    beacon({ ...good, message: 'bot' }, { 'CF-Connecting-IP': '203.0.113.8', 'User-Agent': 'curl/8.0' })
  ];
  const noSite = beacon({ ...good, message: 'curl shaped' }, { 'CF-Connecting-IP': '203.0.113.9' });
  delete noSite.headers['Sec-Fetch-Site'];
  dropped.push(noSite);
  for (const req of dropped) {
    const res = await f.safeRequest('/api/client-error', req);
    assert.equal(res.status, 204);
  }
  // An explicit cross-site post is refused outright, before the route.
  const cross = await f.safeRequest('/api/client-error', beacon({ ...good, message: 'cross' }, { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' }));
  assert.equal(cross.status, 403);
  await settle(f);
  assert.equal(rows(f).length, 1);

  // An inline script on the page itself, and a real hashed file, both count.
  const hashed = Object.values((await import('../../worker/asset-manifest.js')).default).find(v => /\.js$/.test(v));
  await f.safeRequest('/api/client-error', beacon({ ...good, message: 'inline broke', source: 'https://botchomebrew.wiki/tools', page: '/tools' }, { 'CF-Connecting-IP': '203.0.113.10' }));
  await f.safeRequest('/api/client-error', beacon({ ...good, message: 'hashed broke', source: 'https://botchomebrew.wiki/assets/' + hashed }, { 'CF-Connecting-IP': '203.0.113.11' }));
  // Quoted text (a JSON.parse error quoting somebody's draft) is scrubbed.
  await f.safeRequest('/api/client-error', beacon({ ...good, message: 'Unexpected token in "this is my private draft text, quoted"' }, { 'CF-Connecting-IP': '203.0.113.12' }));
  await settle(f);
  all = rows(f);
  assert.equal(all.length, 4);
  assert.ok(all.some(x => /inline broke \(inline script:12\)/.test(x.message)));
  assert.ok(all.some(x => /hashed broke/.test(x.message)));
  const quoted = all.find(x => /Unexpected token/.test(x.message));
  assert.ok(!quoted.message.includes('private draft'));
  assert.match(quoted.message, /"…"/);

  // Five a minute from one address, then quiet.
  for (let i = 0; i < 6; i++) {
    await f.safeRequest('/api/client-error', beacon({ ...good, message: 'burst ' + 'abcdef'[i] }, { 'CF-Connecting-IP': '198.51.100.7' }));
  }
  await settle(f);
  assert.equal(rows(f).filter(x => /burst/.test(x.message)).length, 5);

  // Browser reports never light the Health badge.
  const counts = await (await f.request('/api/admin/queue-counts', as('admin'))).json();
  assert.equal(counts.problems, 0);
});

test('admins read the log and can mark a problem fixed (it comes back reopened) or forget it', async t => {
  const f = await fixture(); t.after(() => f.finish());
  const c = clock(); t.after(() => c.restore());
  admins(f);
  breakEverything(f);
  await quietly(() => f.safeRequest('/c/set/x', visit()));
  mend(f);
  await f.safeRequest('/c/nope', visit());
  await settle(f);

  assert.equal((await f.request('/api/admin/problems', as('member'))).status, 403);
  const d = await (await f.request('/api/admin/problems', as('admin'))).json();
  assert.equal(d.rows.length, 2);
  assert.equal(d.week.crash, 1);
  assert.equal(d.week.notfound, 1);
  assert.equal(d.week.email, 0);
  const crash = d.rows.find(r => r.kind === 'crash');
  const only = await (await f.request('/api/admin/problems?kind=notfound', as('admin'))).json();
  assert.deepEqual(only.rows.map(r => r.kind), ['notfound']);

  // The badge counts the crash, not the 404.
  assert.equal((await (await f.request('/api/admin/queue-counts', as('admin'))).json()).problems, 1);

  assert.equal((await f.request('/api/admin/problem', post('member', { fp: crash.fp, action: 'fix' }))).status, 403);
  assert.equal((await (await f.request('/api/admin/problem', post('admin', { fp: crash.fp, action: 'fix' }))).json()).ok, true);
  let open = await (await f.request('/api/admin/problems', as('admin'))).json();
  assert.ok(!open.rows.some(r => r.fp === crash.fp));
  assert.equal((await (await f.request('/api/admin/queue-counts', as('admin'))).json()).problems, 0);

  c.advance(61000);
  breakEverything(f);
  await quietly(() => f.safeRequest('/c/set/x', visit()));
  mend(f);
  await settle(f);
  const back = f.db.prepare('SELECT * FROM problem_log WHERE fp=?').get(crash.fp);
  assert.equal(back.reopened, 1);
  assert.equal(back.count, 1);
  assert.equal(back.fixed_at, null);

  await f.request('/api/admin/problem', post('admin', { fp: crash.fp, action: 'forget' }));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM problem_log WHERE fp=?').get(crash.fp).n, 0);
});

test('a missing character address can be sent to a page, and the redirect taken back', async t => {
  const f = await fixture(); t.after(() => f.finish());
  admins(f);
  f.insert('characters', 'witch', { name: 'Witch', team: 'minion', ability: 'Each night, choose a player.' });
  assert.equal((await f.safeRequest('/c/old-set/old-name', visit())).status, 404);
  await settle(f);
  const missing = rows(f).find(r => r.kind === 'notfound');
  assert.equal(missing.route, '/c/old-set/old-name');

  const made = await (await f.request('/api/admin/problem-redirect', post('admin', { path: missing.route, to: 'witch' }))).json();
  assert.equal(made.ok, true);
  assert.equal(made.to, 'witch');
  assert.equal(made.name, 'Witch');
  const moved = await f.request('/c/old-set/old-name', visit());
  assert.equal(moved.status, 301);
  assert.match(moved.headers.get('Location'), /\/c\/test-set\/witch$/);
  const row = f.db.prepare('SELECT * FROM problem_log WHERE fp=?').get(missing.fp);
  assert.ok(row.fixed_at);
  assert.equal(row.detail, 'redirect:witch');
  assert.equal(f.db.prepare("SELECT to_slug FROM redirects WHERE from_slug='old-set/old-name'").get().to_slug, 'witch');

  // An address a live page answers to is not missing; a draft is no target.
  assert.equal((await f.request('/api/admin/problem-redirect', post('admin', { path: '/c/test-set/witch', to: 'witch' }))).status, 400);
  f.insert('characters', 'hidden', { name: 'Hidden' }, 'draft');
  assert.equal((await f.request('/api/admin/problem-redirect', post('admin', { path: '/c/other/one', to: 'hidden' }))).status, 400);
  assert.equal((await f.request('/api/admin/problem-redirect', post('member', { path: missing.route, to: 'witch' }))).status, 403);

  const undone = await (await f.request('/api/admin/problem-redirect', post('admin', { path: missing.route, undo: true }))).json();
  assert.equal(undone.ok, true);
  assert.equal((await f.request('/c/old-set/old-name', visit())).status, 404);
  assert.equal(f.db.prepare('SELECT detail FROM problem_log WHERE fp=?').get(missing.fp).detail, null);
  // Nothing left to undo.
  assert.equal((await f.request('/api/admin/problem-redirect', post('admin', { path: missing.route, undo: true }))).status, 409);
  const actions = f.db.prepare("SELECT action FROM activity_log WHERE action LIKE 'redirect-%' ORDER BY id").all().map(r => r.action);
  assert.deepEqual(actions, ['redirect-add', 'redirect-remove']);
});

test('a nightly backup table that keeps failing is a nightly-job problem', async t => {
  const f = await fixture(); t.after(() => f.finish());
  f.env.ART = {
    objects: new Map(),
    async put(k, v) { this.objects.set(k, String(v)); },
    async get() { return null; },
    async head(k) { return this.objects.has(k) ? { size: Buffer.byteLength(this.objects.get(k)) } : null; },
    async delete(k) { this.objects.delete(k); },
    async list() { return { objects: [], truncated: false }; }
  };
  f.db.prepare("INSERT INTO page_views (entity_type, slug, day, n) VALUES ('character','a','2026-10-01',1)").run();
  f.state.intercept = ({ sql, value }) => {
    if (/FROM page_views WHERE rowid >/.test(sql)) throw new Error('D1_ERROR: storage operation exceeded timeout');
    return value;
  };
  const res = await quietly(() => f.hooks.runBackup(f.env));
  f.state.intercept = null;
  assert.equal(res.ok, false);
  const row = rows(f).find(r => r.kind === 'cron');
  assert.ok(row);
  assert.equal(row.route, 'backup');
  assert.match(row.message, /^page_views: reading rows after 0/);
});

test('the site.js beacon reports our own errors, three at most, and nothing from extensions or failed loads', async () => {
  const { readFile } = await import('node:fs/promises');
  const vm = await import('node:vm');
  const src = await readFile(new URL('../../assets/site.js', import.meta.url), 'utf8');
  const at = src.indexOf('/* ── Problem log beacon (F3) ──');
  assert.ok(at > 0, 'the beacon block is in site.js');
  const block = src.slice(at);
  const listeners = {}, beacons = [];
  const win = { addEventListener(type, fn) { listeners[type] = fn; } };
  const ctx = {
    window: win, location: { origin: 'https://botchomebrew.wiki', href: 'https://botchomebrew.wiki/tools', pathname: '/tools' },
    navigator: { sendBeacon(url, blob) { beacons.push({ url, blob }); return true; } },
    Blob: class { constructor(parts, opts) { this.text = parts.join(''); this.type = opts.type; } },
    fetch() { throw new Error('should use sendBeacon'); }
  };
  vm.runInNewContext(block, ctx);
  const fire = ev => listeners.error({ target: win, ...ev });
  fire({ message: 'x is not defined', filename: 'https://botchomebrew.wiki/assets/immutable/site.abc.js', lineno: 4, colno: 2, error: { stack: 'ReferenceError' } });
  fire({ message: 'x is not defined', filename: 'https://botchomebrew.wiki/assets/immutable/site.abc.js', lineno: 4, colno: 2 });  // a repeat
  fire({ message: 'from an extension', filename: 'chrome-extension://abc/x.js', lineno: 1 });
  listeners.error({ target: { tagName: 'IMG' }, message: '' });                                                                  // a failed load
  listeners.unhandledrejection({ reason: { message: 'not ours', stack: 'Error\n at https://cdn.example/x.js:1:1' } });
  listeners.unhandledrejection({ reason: { message: 'ours', stack: 'Error: ours\n at load (https://botchomebrew.wiki/assets/data.js:88:9)' } });
  fire({ message: 'inline', filename: 'https://botchomebrew.wiki/tools', lineno: 9 });
  fire({ message: 'a fourth', filename: 'https://botchomebrew.wiki/assets/site.js', lineno: 1 });
  assert.equal(beacons.length, 3);
  const bodies = beacons.map(b => JSON.parse(b.blob.text));
  assert.ok(beacons.every(b => b.url === '/api/client-error' && b.blob.type === 'application/json'));
  assert.deepEqual(bodies.map(b => b.message), ['x is not defined', 'ours', 'inline']);
  assert.equal(bodies[0].page, '/tools');
  assert.equal(bodies[1].source, 'https://botchomebrew.wiki/assets/data.js');
  assert.equal(bodies[1].line, 88);
  assert.equal(bodies[2].source, 'https://botchomebrew.wiki/tools');
});

test('an oversized beacon with no Content-Length is dropped unread, and a deleted page\'s own address is not redirected', async t => {
  const f = await fixture(); t.after(() => f.finish());
  admins(f);
  // No Content-Length header at all (a chunked body): still capped at 8 KB.
  const big = beacon({ message: 'big', source: 'https://botchomebrew.wiki/assets/site.js', line: 1, page: '/tools', stack: 'x'.repeat(20000) });
  assert.equal(big.headers['Content-Length'], undefined);
  assert.equal((await f.safeRequest('/api/client-error', big)).status, 204);
  await settle(f);
  assert.equal(rows(f).length, 0);

  // A deleted page still holding the address would answer 404 before any
  // redirect row was read, so the tool says so instead of saving a dead one.
  f.insert('characters', 'witch', { name: 'Witch', team: 'minion', ability: 'Each night, choose a player.' });
  f.insert('characters', 'gone', { name: 'Gone', team: 'minion', ability: 'x' }, 'deleted');
  const res = await f.request('/api/admin/problem-redirect', post('admin', { path: '/c/test-set/gone', to: 'witch' }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /deleted page still holds/);
});
