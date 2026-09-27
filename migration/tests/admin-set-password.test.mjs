import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';

const post = (who, body) => ({
  method: 'POST',
  headers: { Cookie: 'botc_session=' + who, 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});
const setPassword = (f, who, id, password) =>
  f.request('/api/admin/user', post(who, { id, action: 'set-password', password }));
const hashOf = (f, id) => f.db.prepare('SELECT password_hash FROM users WHERE id=?').get(id).password_hash;

async function seed(f) {
  f.db.prepare("INSERT INTO users(id,username,password_hash,is_admin) VALUES(1,'admin','',1)").run();
  f.db.prepare("INSERT INTO users(id,username,password_hash) VALUES(2,'member','old-hash')").run();
  f.db.prepare("INSERT INTO users(id,username,password_hash) VALUES(3,'other','')").run();
  f.state.sessions.set('sess:admin', { userId: 1, username: 'admin', isAdmin: true });
  f.state.sessions.set('sess:other', { userId: 3, username: 'other' });
}

test('an admin sets a working temporary password on somebody else\'s account', async t => {
  const f = await fixture(); t.after(() => f.finish()); await seed(f);
  const res = await setPassword(f, 'admin', 2, 'temp_pass_12345');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, username: 'member' });
  const stored = hashOf(f, 2);
  assert.match(stored, /^pbkdf2_sha256\$100000\$/);
  assert.equal(await f.hooks.verifyPassword('temp_pass_12345', stored), true);
  assert.equal(await f.hooks.verifyPassword('something-else', stored), false);
  // Logged under the target's name, and the password itself is never written down.
  const log = f.db.prepare("SELECT * FROM activity_log WHERE action='set-password'").all();
  assert.equal(log.length, 1);
  assert.equal(log[0].entity_name, 'member');
  assert.equal(JSON.stringify(log).includes('temp_pass_12345'), false);
});

test('set-password refuses non-admins, short passwords and the admin\'s own account', async t => {
  const f = await fixture(); t.after(() => f.finish()); await seed(f);
  assert.equal((await setPassword(f, 'other', 2, 'temp_pass_12345')).status, 403);
  assert.equal((await setPassword(f, 'admin', 2, 'short')).status, 400);
  assert.equal((await setPassword(f, 'admin', 2, '')).status, 400);
  assert.equal(hashOf(f, 2), 'old-hash');
  const self = await setPassword(f, 'admin', 1, 'temp_pass_12345');
  assert.equal(self.status, 400);
  assert.match((await self.json()).error, /account page/);
  assert.equal(hashOf(f, 1), '');
  assert.equal((await setPassword(f, 'admin', 999, 'temp_pass_12345')).status, 404);
});
