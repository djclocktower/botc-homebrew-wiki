import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';

/* Changing your username (once every 30 days, the old /u/ address forwarding)
   and deleting your account (backed up to R2 first, restorable by an admin).
   Same setup as fix-auth.test.mjs: a full KV and outbound fetch stubbed. */

function fakeR2() {
  const objects = new Map(), meta = new Map();
  return {
    objects, fail: false,
    async put(key, body, opts) {
      if (this.fail) throw new Error('R2 down');
      objects.set(key, String(body)); meta.set(key, (opts && opts.customMetadata) || {});
    },
    async get(key) {
      if (!objects.has(key)) return null;
      const body = objects.get(key);
      return { async json() { return JSON.parse(body); } };
    },
    async list({ prefix }) {
      return { objects: [...objects.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key, customMetadata: meta.get(key) })), truncated: false };
    }
  };
}

async function setup() {
  const f = await fixture();
  const kv = new Map();
  f.env.SESSIONS = {
    async get(k) { return kv.has(k) ? kv.get(k) : null; },
    async put(k, v) { kv.set(k, String(v)); },
    async delete(k) { kv.delete(k); }
  };
  f.env.ART = fakeR2();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const u = String(input && input.url || input);
    if (u.startsWith('https://api.pwnedpasswords.com/range/')) return new Response('0000000000000000000000000000000000A:0');
    throw new Error('unexpected fetch ' + u);
  };
  let ip = 0;
  const post = (path, body, cookie) => f.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.9.0.' + (++ip), ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body)
  });
  const signup = async (username, password) => {
    const res = await post('/api/signup', { username, email: username + '@example.com', password });
    assert.equal(res.status, 200, username);
    return (res.headers.get('Set-Cookie') || '').split(';')[0];
  };
  const idOf = name => (f.db.prepare('SELECT id FROM users WHERE username=?').get(name) || {}).id;
  const finish = async () => { globalThis.fetch = realFetch; await f.finish(); };
  return { f, post, signup, idOf, finish };
}

test('a member can rename once every 30 days, and the old address forwards and stays theirs', async () => {
  const t = await setup();
  try {
    const cookie = await t.signup('oldname', 'a-long-password-1');
    const id = t.idOf('oldname');
    let res = await t.post('/api/account/username', { username: 'newname' }, cookie);
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(t.idOf('newname'), id);

    res = await t.f.request('/u/oldname');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Location'), 'https://botchomebrew.wiki/u/newname');

    res = await t.post('/api/account/username', { username: 'thirdname' }, cookie);
    assert.equal(res.status, 429, 'a second change inside 30 days is refused');

    res = await t.post('/api/signup', { username: 'OldName', email: 'x@example.com', password: 'a-long-password-2' });
    assert.equal(res.status, 409, 'nobody else can take the old name');

    t.f.db.prepare("UPDATE users SET username_changed_at=datetime('now','-31 day') WHERE id=?").run(id);
    res = await t.post('/api/account/username', { username: 'oldname' }, cookie);
    assert.equal(res.status, 200, 'the account may take its own old name back');
    assert.equal(t.idOf('oldname'), id);
    res = await t.f.request('/u/newname');
    assert.equal(res.status, 302, 'and the name it left forwards too');

    t.f.db.prepare("UPDATE users SET username_changed_at=NULL WHERE id=?").run(id);
    res = await t.post('/api/account/username', { username: 'bad name!' }, cookie);
    assert.equal(res.status, 400);
  } finally { await t.finish(); }
});

async function withContent(t, cookie, name) {
  const id = t.idOf(name);
  t.f.insert('characters', name + '-char', { name: 'Char of ' + name, ability: 'x' });
  t.f.insert('scripts', name + '-draft', { name: 'Draft of ' + name }, 'draft');
  t.f.db.prepare('UPDATE characters SET owner_id=? WHERE slug=?').run(id, name + '-char');
  t.f.db.prepare('UPDATE scripts SET owner_id=? WHERE slug=?').run(id, name + '-draft');
  await t.f.hooks.ensurePagesTable(t.f.env);
  t.f.db.prepare(`INSERT INTO pages (slug,title,parent_type,parent_slug,owner_id,data,status)
                  VALUES (?,?,'article','',?,'{}','published')`).run(name + '-page', 'Page', id);
  t.f.db.exec(`CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, entity_type TEXT,
               slug TEXT, user_id INTEGER, body TEXT, status TEXT DEFAULT 'visible', parent_id INTEGER, pinned INTEGER, images TEXT)`);
  t.f.db.prepare("INSERT INTO comments (entity_type,slug,user_id,body) VALUES ('character','x',?, 'hi')").run(id);
  t.f.db.prepare("INSERT INTO comments (entity_type,slug,user_id,body) VALUES ('wikipage',?,999, 'nice page')").run(name + '-page');
  return id;
}

test('deleting an account backs everything up first, and an admin can put it back', async () => {
  const t = await setup();
  try {
    const cookie = await t.signup('leaver', 'a-long-password-1');
    const id = await withContent(t, cookie, 'leaver');

    let res = await t.post('/api/account/delete', { password: 'wrong-password' }, cookie);
    assert.equal(res.status, 403);
    assert.ok(t.idOf('leaver'), 'a wrong password deletes nothing');

    t.f.env.ART.fail = true;
    res = await t.post('/api/account/delete', { password: 'a-long-password-1' }, cookie);
    assert.equal(res.status, 503);
    assert.ok(t.idOf('leaver'), 'no backup, no deletion');
    t.f.env.ART.fail = false;

    res = await t.post('/api/account/delete', { password: 'a-long-password-1' }, cookie);
    assert.equal(res.status, 200, await res.clone().text());
    const { backup } = await res.json();
    assert.equal(t.idOf('leaver'), undefined, 'the account row is gone');
    const ch = t.f.db.prepare("SELECT status, owner_id FROM characters WHERE slug='leaver-char'").get();
    assert.deepEqual({ ...ch }, { status: 'deleted', owner_id: null });
    assert.equal(t.f.db.prepare("SELECT COUNT(*) AS n FROM pages WHERE slug='leaver-page'").get().n, 0);
    assert.equal(t.f.db.prepare('SELECT status FROM comments WHERE user_id=?').get(id).status, 'removed');
    const saved = JSON.parse(t.f.env.ART.objects.get(backup));
    assert.equal(saved.user.username, 'leaver');
    assert.equal(saved.user.password_hash, undefined, 'the password hash is not kept');
    assert.equal(saved.characters.length, 1);
    assert.equal(saved.pageComments.length, 1);

    res = await t.post('/api/signup', { username: 'leaver', email: 'new@example.com', password: 'a-long-password-2' });
    assert.equal(res.status, 409, 'the deleted handle stays parked');

    const admin = await t.signup('boss', 'a-long-password-3');
    t.f.db.prepare("UPDATE users SET is_admin=1 WHERE username='boss'").run();
    res = await t.f.request('/api/admin/account-backups', { headers: { Cookie: admin } });
    const list = await res.json();
    assert.equal(list.backups[0].key, backup);
    assert.equal(list.backups[0].username, 'leaver');

    res = await t.post('/api/admin/restore-account', { key: backup, username: 'boss' }, admin);
    assert.equal(res.status, 200, await res.clone().text());
    const out = await res.json();
    assert.equal(out.restored.length, 3);
    assert.equal(out.comments, 1);
    const back = t.f.db.prepare("SELECT status, owner_id, data FROM characters WHERE slug='leaver-char'").get();
    assert.equal(back.status, 'published');
    assert.equal(back.owner_id, t.idOf('boss'));
    assert.equal(JSON.parse(back.data)._deleted, undefined);
    assert.equal(t.f.db.prepare("SELECT status FROM scripts WHERE slug='leaver-draft'").get().status, 'draft');
    assert.equal(t.f.db.prepare("SELECT status FROM pages WHERE slug='leaver-page'").get().status, 'published');
    assert.equal(t.f.db.prepare("SELECT COUNT(*) AS n FROM comments WHERE slug='leaver-page'").get().n, 1,
      'the wiki page comes back with its comments');

    res = await t.post('/api/admin/restore-account', { key: backup }, cookie);
    assert.notEqual(res.status, 200, 'a deleted session is not an admin');
  } finally { await t.finish(); }
});

test('keeping your pages leaves them up with no owner', async () => {
  const t = await setup();
  try {
    const cookie = await t.signup('keeper', 'a-long-password-1');
    const id = await withContent(t, cookie, 'keeper');
    const res = await t.post('/api/account/delete', { password: 'a-long-password-1', keepPages: true }, cookie);
    assert.equal(res.status, 200);
    const ch = t.f.db.prepare("SELECT status, owner_id FROM characters WHERE slug='keeper-char'").get();
    assert.deepEqual({ ...ch }, { status: 'published', owner_id: null });
    assert.equal(t.f.db.prepare("SELECT owner_id FROM pages WHERE slug='keeper-page'").get().owner_id, null);
    assert.equal(t.f.db.prepare('SELECT status FROM comments WHERE user_id=?').get(id).status, 'visible');
  } finally { await t.finish(); }
});

test('an admin cannot delete their own account', async () => {
  const t = await setup();
  try {
    const cookie = await t.signup('adminy', 'a-long-password-1');
    t.f.db.prepare("UPDATE users SET is_admin=1 WHERE username='adminy'").run();
    const res = await t.post('/api/account/delete', { password: 'a-long-password-1' }, cookie);
    assert.equal(res.status, 400);
    assert.ok(t.idOf('adminy'));
  } finally { await t.finish(); }
});
