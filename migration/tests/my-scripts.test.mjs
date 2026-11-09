import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';

/* My Scripts on the account (/api/my-scripts): saving, the 50 limit, a
   save from a stale browser keeping both versions, deleting, privacy, and
   the logo/background upload's minted key. */

const as = id => (id ? { Cookie: 'botc_session=user-' + id } : {});
const post = (f, id, path, body) => f.request(path, {
  method: 'POST', headers: { ...as(id), 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});
const list = async (f, id) => (await (await f.request('/api/my-scripts', { headers: as(id) })).json()).scripts;

async function setup() {
  const f = await fixture();
  for (const id of [1, 2]) {
    f.db.prepare("INSERT INTO users(id,username,password_hash) VALUES(?,?,'')").run(id, 'user-' + id);
    f.state.sessions.set('sess:user-' + id, { userId: id, username: 'user-' + id });
  }
  return f;
}

test('scripts save to the account, stay private, and are deleted on request', async t => {
  const f = await setup();
  t.after(() => f.finish());
  assert.equal((await f.request('/api/my-scripts')).status, 401);
  assert.equal((await post(f, 0, '/api/my-scripts', { put: [] })).status, 401);

  let r = await post(f, 1, '/api/my-scripts', {
    put: [{ id: 'abc', chars: ['off-imp', 'x'], meta: { name: 'Night', libId: 'abc' }, updated: 1000, base: 0 }]
  });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.ok(j.saved.abc > 0);
  const mine = await list(f, 1);
  assert.equal(mine.length, 1);
  assert.deepEqual(mine[0].chars, ['off-imp', 'x']);
  assert.equal(mine[0].meta.name, 'Night');
  assert.deepEqual(await list(f, 2), [], 'one account never sees another\'s scripts');

  // an ordinary save on the stamp it was given
  r = await post(f, 1, '/api/my-scripts', { put: [{ id: 'abc', chars: ['off-imp'], meta: { name: 'Night 2' }, updated: 2000, base: j.saved.abc }] });
  assert.equal((await r.json()).conflicts, 0);
  assert.equal((await list(f, 1))[0].meta.name, 'Night 2');

  r = await post(f, 1, '/api/my-scripts', { remove: ['abc'] });
  assert.equal(r.status, 200);
  assert.deepEqual(await list(f, 1), []);
});

test('a save from a browser that missed another device\'s save keeps both', async t => {
  const f = await setup();
  t.after(() => f.finish());
  const first = (await (await post(f, 1, '/api/my-scripts', {
    put: [{ id: 's1', chars: ['a'], meta: { name: 'Mire' }, updated: 1000, base: 0 }]
  })).json()).saved.s1;
  // device B saves on the current stamp
  await post(f, 1, '/api/my-scripts', { put: [{ id: 's1', chars: ['a', 'b'], meta: { name: 'Mire' }, updated: 3000, base: first }] });
  // device A, still on the first stamp, saves an OLDER edit: B's stays, A's is a copy
  let j = await (await post(f, 1, '/api/my-scripts', {
    put: [{ id: 's1', chars: ['a', 'c'], meta: { name: 'Mire' }, updated: 2000, base: first }]
  })).json();
  assert.equal(j.conflicts, 1);
  let rows = await list(f, 1);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.find(x => x.id === 's1').chars, ['a', 'b']);
  assert.equal(rows.find(x => x.id !== 's1').meta.name, 'Mire (older copy)');

  // a NEWER edit from a stale browser wins the id; the server's goes to a copy
  j = await (await post(f, 1, '/api/my-scripts', {
    put: [{ id: 's1', chars: ['z'], meta: { name: 'Mire' }, updated: 9000, base: first }]
  })).json();
  assert.equal(j.conflicts, 1);
  rows = await list(f, 1);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.find(x => x.id === 's1').chars, ['z']);
});

test('fifty scripts is the limit, and bad entries are refused', async t => {
  const f = await setup();
  t.after(() => f.finish());
  const put = [];
  for (let i = 0; i < 52; i++) put.push({ id: 'n' + i, chars: [], meta: { name: 'S' + i }, updated: i, base: 0 });
  put.push({ id: 'bad id!', chars: [], meta: {} });
  const j = await (await post(f, 1, '/api/my-scripts', { put })).json();
  assert.equal(j.full, 2);
  assert.equal((await list(f, 1)).length, 50);
});

test('a logo upload is stored under a key the server mints', async t => {
  const f = await setup();
  t.after(() => f.finish());
  const store = new Map();
  f.env.ART = { async put(k, body, o) { store.set(k, { body, o }); }, async get() { return null; }, async delete() {} };
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8ff1f0003030200ef9c5d4b0000000049454e44ae426082', 'hex');
  assert.equal((await post(f, 0, '/api/my-scripts/image', { data: 'data:image/png;base64,' + png.toString('base64') })).status, 401);
  let r = await post(f, 1, '/api/my-scripts/image', { data: 'data:image/png;base64,' + png.toString('base64') });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.match(j.path, /^library\/1\/[a-z0-9]+\.png$/);
  assert.ok(store.has(j.path));
  r = await post(f, 1, '/api/my-scripts/image', { data: 'data:image/png;base64,' + Buffer.from('<html>').toString('base64') });
  assert.equal(r.status, 400, 'bytes that are not the declared image are refused');
});
