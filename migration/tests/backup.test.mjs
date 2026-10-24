import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';

// A stand-in R2 bucket: enough of put/get/head/delete/list for runBackup().
function fakeR2() {
  const objects = new Map();
  return {
    objects,
    async put(key, body) { objects.set(key, String(body)); },
    async get(key) {
      if (!objects.has(key)) return null;
      const body = objects.get(key);
      return { async json() { return JSON.parse(body); }, size: body.length };
    },
    async head(key) { return objects.has(key) ? { size: objects.get(key).length } : null; },
    async delete(key) { objects.delete(key); },
    async list({ prefix }) {
      return { objects: [...objects.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key, size: objects.get(key).length })), truncated: false };
    }
  };
}

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
