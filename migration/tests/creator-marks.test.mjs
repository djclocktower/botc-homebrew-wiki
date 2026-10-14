import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';

const member = id => ({ headers: { Cookie: 'botc_session=user-' + id } });
const post = (id, body) => ({
  method: 'POST',
  headers: { Cookie: 'botc_session=user-' + id, 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('creator marks: claim, uniqueness, the legacy list, pages, hiding, export', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  const r2 = new Map();
  f.env.ART = { async put(k, v) { r2.set(k, v); }, async delete(k) { r2.delete(k); } };
  for (const id of [1, 2]) {
    f.db.prepare("INSERT INTO users(id,username,password_hash) VALUES(?,?,'')").run(id, 'user-' + id);
    f.state.sessions.set('sess:user-' + id, { userId: id, username: 'user-' + id });
  }
  // Hystrex has ∇ on the original list; their published page proves the name
  // is user-1's.
  f.insert('characters', 'a', { slug: 'a', name: 'Alpha ∇', team: 'townsfolk', creator: 'Hystrex', art: 'art/a.png', ability: 'Does a thing.' });
  f.db.prepare('UPDATE characters SET owner_id=1, creator=? WHERE slug=?').run('Hystrex', 'a');
  f.insert('scripts', 'demo', { slug: 'demo', name: 'Demo', characters: ['a'], creatorMarks: true });

  // The legacy glyph is user-1's to claim and nobody else's.
  const mine = await (await f.request('/api/account/mark', member(1))).json();
  assert.deepEqual(mine.legacy.map(l => l.g), ['∇']);
  let r = await f.request('/api/account/mark', post(2, { glyph: '∇' }));
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /Hystrex/);
  assert.equal((await f.request('/api/account/mark', post(2, { glyph: 'ab' }))).status, 400);
  assert.equal((await f.request('/api/account/mark', post(2, { glyph: '✶' }))).status, 200);
  // ✶ and its variation-selector twin are one mark.
  assert.equal((await f.request('/api/account/mark', post(1, { glyph: '✶︎' }))).status, 409);
  assert.equal((await f.request('/api/account/mark', post(1, { glyph: '∇' }))).status, 200);

  let reg = (await (await f.request('/api/creator-marks')).json()).marks;
  const one = reg.find(m => m.u === 'user-1');
  assert.equal(one.g, '∇');
  assert.ok(one.n.includes('hystrex'));
  assert.ok(!reg.some(m => m.legacy && m.g === '∇'), 'the claimed glyph leaves the legacy list');
  assert.equal(reg.find(m => m.u === 'user-2').g, '✶');

  // The character page draws it beside the credit, with whose it is, and the
  // title loses the copy typed into the name.
  let html = await (await f.request('/c/test-set/a')).text();
  assert.match(html, /class="creator-mark" data-tip="Creator mark of user-1"[^>]*>∇<\/span>/);
  assert.match(html, /<h1 class="gen-title"[^>]*>Alpha<\/h1>/);

  // A script that asked for marks carries them on its roster and its JSON.
  html = await (await f.request('/s/demo')).text();
  assert.match(html, /script-char-name">Alpha <span class="creator-mark"/);
  const json = JSON.parse(await (await f.request('/api/page-json?type=script&slug=demo')).text());
  assert.equal(json.find(e => e.id && e.id !== '_meta').name, 'Alpha ∇');

  // Hidden: still theirs, drawn nowhere.
  assert.equal((await f.request('/api/account/mark', post(1, { show: false }))).status, 200);
  html = await (await f.request('/c/test-set/a')).text();
  assert.doesNotMatch(html, /creator-mark/);
  assert.equal((await f.request('/api/account/mark', post(2, { glyph: '∇' }))).status, 409);

  // A picture mark: stored in the account's own slot, drawn as a mask.
  r = await f.request('/api/account/mark', post(2, { image: PNG }));
  assert.equal(r.status, 200);
  assert.ok(r2.has('marks/u2.png'));
  reg = (await (await f.request('/api/creator-marks')).json()).marks;
  assert.equal(reg.find(m => m.u === 'user-2').img, 'marks/u2.png');
  assert.equal((await f.request('/api/account/mark', post(2, { image: 'data:image/svg+xml;base64,PHN2Zz4=' }))).status, 400);

  // Giving it up frees the glyph and the picture.
  assert.equal((await f.request('/api/account/mark', post(2, { remove: true }))).status, 200);
  assert.ok(!r2.has('marks/u2.png'));
  assert.equal((await f.request('/api/account/mark', post(1, { glyph: '✶' }))).status, 200);
});
