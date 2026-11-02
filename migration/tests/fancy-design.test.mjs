import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';

/* A Fancy Scripts design saved with its script or collection
   (/api/fancy-design): who may save it, who may read it, and that a
   draft's design stays as hidden as the draft. */

const post = (f, id, body) => f.request('/api/fancy-design', {
  method: 'POST',
  headers: { ...(id ? { Cookie: 'botc_session=user-' + id } : {}), 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});
const get = (f, id, q) => f.request('/api/fancy-design?' + q, id ? { headers: { Cookie: 'botc_session=user-' + id } } : {});
const design = { v: 2, app: 'fancyscripts', options: { jinxText: true }, assets: {}, fonts: {}, script: ['imp'] };

test('a script\'s owner saves its Fancy Scripts design, readers get it, others cannot save', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  const store = new Map();
  f.env.ART = {
    async get(k) { const v = store.get(k); return v ? { customMetadata: v.meta, async json() { return JSON.parse(v.body); } } : null; },
    async put(k, body, o) { store.set(k, { body, meta: (o && o.customMetadata) || {} }); },
    async delete(k) { store.delete(k); },
  };
  for (const id of [1, 2]) {
    f.db.prepare("INSERT INTO users(id,username,password_hash) VALUES(?,?,'')").run(id, 'user-' + id);
    f.state.sessions.set('sess:user-' + id, { userId: id, username: 'user-' + id });
  }
  f.insert('scripts', 'night-set', { slug: 'night-set', name: 'Night Set', author: 'x', characters: ['off-imp'] });
  f.db.prepare('UPDATE scripts SET owner_id=1 WHERE slug=?').run('night-set');

  let r = await get(f, 0, 'type=script&slug=night-set');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { design: null, savedAt: '', canSave: false });

  assert.equal((await post(f, 0, { type: 'script', slug: 'night-set', design })).status, 401);
  assert.equal((await post(f, 2, { type: 'script', slug: 'night-set', design })).status, 403);
  assert.equal((await post(f, 1, { type: 'script', slug: 'night-set', design: { options: {} } })).status, 400);
  r = await post(f, 1, { type: 'script', slug: 'night-set', design });
  assert.equal(r.status, 200);

  r = await get(f, 2, 'type=script&slug=night-set');
  const back = await r.json();
  assert.equal(back.canSave, false);
  assert.deepEqual(back.design.options, { jinxText: true });
  assert.equal(back.design.script, undefined, 'the roster comes from the page, not the design');
  assert.equal((await (await get(f, 1, 'type=script&slug=night-set')).json()).canSave, true);

  // a draft's design is the draft's: a 404 to everyone who cannot edit it
  f.db.prepare("UPDATE scripts SET status='draft' WHERE slug=?").run('night-set');
  assert.equal((await get(f, 2, 'type=script&slug=night-set')).status, 404);
  assert.equal((await get(f, 1, 'type=script&slug=night-set')).status, 200);

  r = await post(f, 1, { type: 'script', slug: 'night-set', remove: true });
  assert.equal(r.status, 200);
  assert.equal((await (await get(f, 1, 'type=script&slug=night-set')).json()).design, null);
  assert.equal((await get(f, 1, 'type=script&slug=nowhere')).status, 404);
});
