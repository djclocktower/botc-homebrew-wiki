import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';

// A stand-in R2 bucket: enough of put/get/head/delete/list for runBackup().
// `list` pages like R2 does (keys in order, `limit` per page, a cursor), so a
// caller that reads only the first page is caught.
function fakeR2({ pageSize = 1000 } = {}) {
  const objects = new Map();
  const bytes = body => Buffer.byteLength(body);
  return {
    objects,
    listCalls: 0,
    async put(key, body) { objects.set(key, String(body)); },
    async get(key) {
      if (!objects.has(key)) return null;
      const body = objects.get(key);
      return { async json() { return JSON.parse(body); }, size: bytes(body) };
    },
    async head(key) { return objects.has(key) ? { size: bytes(objects.get(key)) } : null; },
    batchDeletes: [],
    async delete(key) { if (Array.isArray(key)) this.batchDeletes.push(key.length); for (const k of [].concat(key)) objects.delete(k); },
    async list({ prefix, limit = 1000, cursor }) {
      this.listCalls++;
      const keys = [...objects.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const n = Math.min(limit, pageSize);
      const page = keys.slice(start, start + n);
      const truncated = start + n < keys.length;
      return { objects: page.map(key => ({ key, size: bytes(objects.get(key)) })), truncated, ...(truncated ? { cursor: String(start + n) } : {}) };
    }
  };
}
const quietly = async fn => {
  const origError = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = origError; }
};
const day = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

test('a backup survives a dropped read, writes a narrow table in few parts, and a re-run leaves no stale parts', async () => {
  const f = await fixture();
  const r2 = fakeR2();
  f.env.ART = r2;
  const origError = console.error;
  console.error = () => {};
  try {
    const insert = f.db.prepare('INSERT INTO page_views (entity_type, slug, day, n) VALUES (?,?,?,?)');
    for (let i = 0; i < 25000; i++) insert.run('character', 'c' + (i % 500), '2026-' + String(1 + (i % 9)).padStart(2, '0') + '-' + String(1 + Math.floor(i / 500) % 28).padStart(2, '0'), 1 + (i % 7));
    const total = f.db.prepare('SELECT COUNT(*) AS n FROM page_views').get().n;

    // One transient D1 failure in the middle of page_views used to cost the
    // table its whole snapshot for the night.
    let dropped = false, reads = 0;
    f.state.intercept = ({ sql, value }) => {
      if (/FROM page_views WHERE rowid >/.test(sql)) {
        reads++;
        if (reads === 2 && !dropped) { dropped = true; throw new Error('D1_ERROR: Network connection lost.'); }
      }
      return value;
    };
    const res = await f.hooks.runBackup(f.env);
    f.state.intercept = null;
    assert.ok(dropped);
    assert.equal(res.failed.page_views, undefined);
    assert.equal(res.saved.page_views, total);
    // ~80 bytes a row: a handful of reads, not one per 2000 rows.
    assert.ok(reads <= 5, 'page_views took ' + reads + ' reads');
    const rows = await f.hooks.readBackupTable(f.env, res.date, 'page_views');
    assert.equal(rows.length, total);
    assert.deepEqual(Object.keys(rows[0]).sort(), ['day', 'entity_type', 'n', 'slug']);

    // Plant a part a bigger, earlier run of the same day would have left
    // behind; the re-run must not hand it back as more of the table.
    r2.objects.set(`backups/${res.date}/page_views.part7.json`, '[{"slug":"stale"}]');
    r2.objects.set(`backups/${res.date}/page_views.part1.json`, '[{"slug":"stale"}]');
    const again = await f.hooks.runBackup(f.env);
    assert.equal(again.saved.page_views, total);
    const reread = await f.hooks.readBackupTable(f.env, again.date, 'page_views');
    assert.equal(reread.length, total);
    assert.ok(!reread.some(r => r.slug === 'stale'));

    // The last run is recorded for the dashboard, failures with their reason.
    const last = JSON.parse(f.db.prepare("SELECT value FROM settings WHERE key='last_backup'").get().value);
    assert.equal(last.date, again.date);
    assert.equal(last.failed.page_views, undefined);
  } finally {
    console.error = origError;
    await f.finish();
  }
});

test('a table that keeps failing is reported with its reason, and the rest still back up', async () => {
  const f = await fixture();
  f.env.ART = fakeR2();
  const origError = console.error;
  console.error = () => {};
  try {
    f.db.prepare("INSERT INTO page_views (entity_type, slug, day, n) VALUES ('character','a','2026-10-01',1)").run();
    f.state.intercept = ({ sql, value }) => {
      if (/FROM page_views WHERE rowid >/.test(sql)) throw new Error('D1_ERROR: storage operation exceeded timeout');
      return value;
    };
    const res = await f.hooks.runBackup(f.env);
    f.state.intercept = null;
    assert.equal(res.ok, false);
    assert.match(res.failed.page_views, /reading rows after 0: D1_ERROR: storage operation exceeded timeout/);
    assert.equal(res.failed.characters, undefined);
    const last = JSON.parse(f.db.prepare("SELECT value FROM settings WHERE key='last_backup'").get().value);
    assert.match(last.failed.page_views, /exceeded timeout/);
  } finally {
    console.error = origError;
    await f.finish();
  }
});

test('every table the code creates is in the backup registry, and every skipped one says why', async () => {
  const f = await fixture();
  try {
    const { readFile } = await import('node:fs/promises');
    const root = new URL('../../', import.meta.url);
    const text = (await readFile(new URL('worker/worker.js', root), 'utf8')) +
      (await readFile(new URL('migration/schema.sql', root), 'utf8'));
    const created = new Set([...text.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(/g)].map(m => m[1]));
    const registry = f.hooks.dataTables;
    assert.ok(Array.isArray(registry), 'DATA_TABLES is exposed to the tests');
    const names = new Set(registry.map(t => t.name));
    for (const t of created) assert.ok(names.has(t), `CREATE TABLE ${t} is not in DATA_TABLES: add it (or mark it backup:false with a why)`);
    for (const t of registry) if (t.backup === false) assert.ok(t.why, `${t.name} is skipped without a why`);
    assert.ok(created.has('problem_log') && created.has('redirects'));
  } finally { await f.finish(); }
});

test('lazy tables are backed up, never-created ones are absent rather than failed, and unregistered ones are kept and flagged', async () => {
  const f = await fixture();
  f.env.ART = fakeR2();
  try {
    f.db.exec(`CREATE TABLE IF NOT EXISTS redirects (entity_type TEXT NOT NULL, from_slug TEXT NOT NULL, to_slug TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (entity_type, from_slug));
      CREATE TABLE IF NOT EXISTS favorites (user_id INTEGER NOT NULL, entity_type TEXT NOT NULL, slug TEXT NOT NULL,
      ts TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (user_id, entity_type, slug));
      CREATE TABLE zz_new (x TEXT);`);
    f.db.prepare("INSERT INTO redirects (entity_type, from_slug, to_slug) VALUES ('character','old/name','witch')").run();
    f.db.prepare("INSERT INTO favorites (user_id, entity_type, slug) VALUES (1,'character','witch')").run();
    f.db.prepare("INSERT INTO zz_new (x) VALUES ('kept')").run();
    const res = await quietly(() => f.hooks.runBackup(f.env));
    assert.equal(res.ok, true, JSON.stringify(res.failed));
    assert.equal(res.saved.redirects, 1);
    assert.equal(res.saved.favorites, 1);
    const redirects = await f.hooks.readBackupTable(f.env, res.date, 'redirects');
    assert.equal(redirects.length, 1);
    assert.equal(redirects[0].from_slug, 'old/name');
    assert.equal(redirects[0].to_slug, 'witch');
    // Never created: absent, not a failure.
    assert.equal(res.manifest.tables.suggestions.status, 'absent');
    assert.equal(res.failed.suggestions, undefined);
    // Not in the registry: still saved, and named.
    assert.deepEqual(res.manifest.unregistered, ['zz_new']);
    assert.deepEqual(await f.hooks.readBackupTable(f.env, res.date, 'zz_new'), [{ x: 'kept' }]);
    // Skipped on purpose, with the reason.
    assert.ok(res.manifest.skipped.rate_limits);
    assert.ok(!f.env.ART.objects.has(`backups/${res.date}/rate_limits.json`));
  } finally { await f.finish(); }
});

test('a core table that is missing IS a failure', async () => {
  const f = await fixture();
  f.env.ART = fakeR2();
  try {
    f.db.exec('DROP TABLE page_views');
    const res = await quietly(() => f.hooks.runBackup(f.env));
    assert.equal(res.ok, false);
    assert.match(res.failed.page_views, /no such table/);
    assert.equal(res.manifest.tables.page_views.status, 'failed');
  } finally { await f.finish(); }
});

test('the manifest is written last with row counts, and the backup list does not show it as a table', async () => {
  const f = await fixture();
  f.env.ART = fakeR2();
  try {
    f.db.prepare("INSERT INTO users(id,username,password_hash,is_admin) VALUES(1,'admin','',1)").run();
    f.state.sessions.set('sess:admin', { userId: 1, username: 'admin', isAdmin: true });
    f.insert('characters', 'witch', { name: 'Witch', team: 'minion' });
    f.insert('characters', 'imp2', { name: 'Imp Two', team: 'demon' });
    const res = await quietly(() => f.hooks.runBackup(f.env));
    const mf = JSON.parse(f.env.ART.objects.get(`backups/${res.date}/_manifest.json`));
    assert.equal(mf.v, 1);
    assert.equal(mf.ok, true);
    assert.equal(mf.tables.characters.status, 'ok');
    assert.equal(mf.tables.characters.rows, 2);
    assert.equal(mf.tables.users.rows, 1);
    assert.ok(mf.tables.characters.bytes > 0 && mf.tables.characters.parts === 1);
    // Last: every table's file was written before it.
    const keys = [...f.env.ART.objects.keys()];
    assert.equal(keys[keys.length - 1], `backups/${res.date}/_manifest.json`);

    const list = await (await f.request('/api/admin/backups', { headers: { Cookie: 'botc_session=admin' } })).json();
    const today = list.backups.find(b => b.date === res.date);
    assert.ok(today);
    assert.ok(!today.tables.some(t => t.table.startsWith('_')), 'the manifest is not a table');
    assert.ok(today.tables.some(t => t.table === 'characters'));
    assert.equal(today.manifest.tables.characters, 2);
    assert.equal(today.manifest.ok, true);
  } finally { await f.finish(); }
});

test('a core table that halves overnight is warned about, and the warning is kept for the dashboard', async () => {
  const f = await fixture();
  f.env.ART = fakeR2();
  try {
    for (let i = 0; i < 10; i++) f.insert('characters', 'c' + i, { name: 'C' + i });
    f.env.ART.objects.set(`backups/${day(-1)}/_manifest.json`, JSON.stringify({
      v: 1, date: day(-1), ok: true,
      tables: { characters: { status: 'ok', rows: 2400 }, users: { status: 'ok', rows: 40 } }
    }));
    const res = await quietly(() => f.hooks.runBackup(f.env));
    assert.equal(res.ok, true);
    assert.deepEqual(res.warnings, ['characters: 10 rows, yesterday 2400']);
    const last = JSON.parse(f.db.prepare("SELECT value FROM settings WHERE key='last_backup'").get().value);
    assert.deepEqual(last.warnings, res.warnings);
    // A small table is not judged (users: 40 -> 0 says nothing).
    assert.ok(!res.warnings.some(w => w.startsWith('users')));
    // And it lands in the problem log as a nightly-job problem.
    const row = f.db.prepare("SELECT kind, route, message FROM problem_log WHERE route='backup check'").get();
    assert.equal(row.kind, 'cron');
    assert.match(row.message, /characters: 10 rows, yesterday 2400/);
  } finally { await f.finish(); }
});

test('pruning walks every page of the listing, and keeps the last month', async () => {
  const f = await fixture();
  const r2 = f.env.ART = fakeR2({ pageSize: 1000 });
  try {
    const old = day(-40), recent = day(-3);
    for (let i = 0; i < 1500; i++) r2.objects.set(`backups/${old}/t${String(i).padStart(4, '0')}.json`, '[]');
    r2.objects.set(`backups/${recent}/characters.json`, '[]');
    f.insert('characters', 'witch', { name: 'Witch' });
    const res = await quietly(() => f.hooks.runBackup(f.env));
    const left = [...r2.objects.keys()];
    assert.equal(left.filter(k => k.includes(old)).length, 0, 'every old key was deleted');
    assert.ok(left.includes(`backups/${recent}/characters.json`));
    assert.ok(left.includes(`backups/${res.date}/characters.json`));
    assert.ok(r2.listCalls >= 2, 'the listing was paged');
    // Deleted a thousand keys a call, not one call per key.
    assert.deepEqual(r2.batchDeletes, [1000, 500]);
  } finally { await f.finish(); }
});

test('a part that does not read back at the size it was written fails its table', async () => {
  const f = await fixture();
  const r2 = f.env.ART = fakeR2();
  try {
    f.insert('characters', 'witch', { name: 'Wïtch — ✓', team: 'minion' });
    const realHead = r2.head.bind(r2);
    r2.head = async key => {
      const h = await realHead(key);
      return h && key.endsWith('/characters.json') ? { size: h.size + 1 } : h;
    };
    const res = await quietly(() => f.hooks.runBackup(f.env));
    assert.equal(res.ok, false);
    assert.match(res.failed.characters, /check failed: part 0 size/);
    assert.equal(res.manifest.tables.characters.status, 'failed');
    // Non-ASCII text is measured in bytes, so an honest part passes.
    r2.head = realHead;
    const again = await quietly(() => f.hooks.runBackup(f.env));
    assert.equal(again.ok, true, JSON.stringify(again.failed));
  } finally { await f.finish(); }
});
