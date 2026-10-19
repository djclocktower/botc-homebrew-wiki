import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';

const member = id => ({ headers: { Cookie: 'botc_session=user-' + id } });
const post = (id, body) => ({
  method: 'POST',
  headers: { Cookie: 'botc_session=user-' + id, 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

test('creator marks: claim, uniqueness, the legacy list, pages, hiding, export', async t => {
  const f = await fixture();
  t.after(() => f.finish());
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

  // Marks are text only: nothing a client sends can attach a picture.
  assert.equal((await f.request('/api/account/mark', post(2, { image: 'data:image/png;base64,AAAA' }))).status, 200);
  reg = (await (await f.request('/api/creator-marks')).json()).marks;
  assert.deepEqual(Object.keys(reg.find(m => m.u === 'user-2')).sort(), ['d', 'g', 'k', 'n', 'u']);

  // Publishing under a credit the mark has not seen yet takes effect on that
  // save, not at the nightly refresh.
  f.insert('characters', 'n', { slug: 'n', name: 'Newcomer', team: 'townsfolk', creator: 'Moth Queen', art: 'art/n.png', ability: 'X.' });
  f.db.prepare('UPDATE characters SET owner_id=1, creator=? WHERE slug=?').run('Moth Queen', 'n');
  await f.hooks.logActivity(f.env, { userId: 1 }, 'update', 'character', 'n', 'Newcomer');
  reg = (await (await f.request('/api/creator-marks')).json()).marks;
  assert.ok(reg.find(m => m.u === 'user-1').n.includes('moth queen'));

  // An original mark the list gives a Discord handle is that account's: drawn
  // on its comments, offered on its account page, and released by its own mark.
  f.db.prepare("INSERT INTO users(id,username,password_hash,discord_username) VALUES(3,'lamp','','Eliderad')").run();
  f.state.sessions.set('sess:user-3', { userId: 3, username: 'lamp' });
  await f.hooks.bumpContentVersion(f.env, 'all');
  reg = (await (await f.request('/api/creator-marks')).json()).marks;
  assert.equal(reg.find(m => m.g === '灯').u, 'lamp');
  assert.deepEqual((await (await f.request('/api/account/mark', member(3))).json()).legacy.map(l => l.g), ['灯']);
  assert.equal((await f.request('/api/account/mark', post(2, { glyph: '灯' }))).status, 409);
  assert.equal((await f.request('/api/account/mark', post(3, { glyph: '✦︎' }))).status, 409, 'Luis keeps ✦');
  assert.equal((await f.request('/api/account/mark', post(3, { glyph: '⚘' }))).status, 200);
  reg = (await (await f.request('/api/creator-marks')).json()).marks;
  assert.ok(!reg.some(m => m.g === '灯'), 'choosing a mark releases the original one');
  // Δ and 𝝳 are two creators' marks.
  assert.ok(reg.some(m => m.g === 'Δ') && reg.some(m => m.g === '𝝳'));

  // Giving it up frees the glyph.
  assert.equal((await f.request('/api/account/mark', post(2, { remove: true }))).status, 200);
  assert.equal((await f.request('/api/account/mark', post(1, { glyph: '✶' }))).status, 200);
});
