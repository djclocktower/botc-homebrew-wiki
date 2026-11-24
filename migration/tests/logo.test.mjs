import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fixture } from './worker-fixture.mjs';

// A PNG header carrying its size, which is all the Worker reads of one.
function png(w, h, fill = 7) {
  const b = Buffer.alloc(64, fill);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}
const dataUrl = (bytes, type = 'image/png') => 'data:' + type + ';base64,' + bytes.toString('base64');
const post = (who, body) => ({
  method: 'POST',
  headers: { Cookie: 'botc_session=' + who, 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

async function setup(t) {
  const f = await fixture(); t.after(() => f.finish());
  f.db.prepare("INSERT INTO users(id,username,password_hash,is_admin) VALUES(1,'admin','',1)").run();
  f.db.prepare("INSERT INTO users(id,username,password_hash) VALUES(2,'member','')").run();
  f.state.sessions.set('sess:admin', { userId: 1, username: 'admin', isAdmin: true });
  f.state.sessions.set('sess:member', { userId: 2, username: 'member', isAdmin: false });
  const objects = new Map();
  f.env.ART = {
    objects,
    async put(key, body, opts) { objects.set(key, { body: Buffer.from(body), opts }); return { etag: 'e' }; },
    async get(key) {
      const o = objects.get(key); if (!o) return null;
      return { key, size: o.body.length, etag: 'e', httpEtag: '"e"', body: new Blob([o.body]).stream(),
        writeHttpMetadata(h) { h.set('Content-Type', o.opts.httpMetadata.contentType); } };
    },
    async head(key) { return objects.has(key) ? { key } : null; },
    async delete(keys) { for (const k of [].concat(keys)) objects.delete(k); }
  };
  const call = async (who, body) => {
    const res = await f.request('/api/admin/logo', post(who, body));
    return { status: res.status, body: await res.json() };
  };
  const bytes = async path => Buffer.from(await (await f.request(path)).arrayBuffer());
  return { f, objects, call, bytes };
}

test('with nothing set, every logo address is the committed Classic file', async t => {
  const { f } = await setup(t);
  for (const file of ['mark.webp', 'hero.webp', 'wordmark.png', 'favicon.png', 'icon.png', 'og.png']) {
    const res = await f.request('/assets/logo/' + file);
    assert.equal(res.status, 200, file);
    assert.match(res.headers.get('Cache-Control'), /^public, max-age=3600/, file);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*', file);
  }
  // What the files used to be called still answers.
  for (const old of ['logo_skull.webp', 'wiki-skull.webp', 'headertext.png', 'favicon.png', 'logo_skull_icon.png', 'logo_skull.png']) {
    assert.equal((await f.request('/assets/' + old)).status, 200, old);
  }
  assert.equal((await f.request('/assets/logo/nothing.png')).status, 404);
  assert.equal((await f.request('/assets/logo/abcdef012345/mark.webp')).status, 404);
  assert.equal((await (await f.request('/api/boot')).json()).logo, '');
});

test('only an admin can list, add, switch or delete', async t => {
  const { f, call } = await setup(t);
  assert.equal((await f.request('/api/admin/logo')).status, 403);
  assert.equal((await f.request('/api/admin/logo', { headers: { Cookie: 'botc_session=member' } })).status, 403);
  assert.equal((await call('member', { action: 'use', id: '' })).status, 403);
  const list = await (await f.request('/api/admin/logo', { headers: { Cookie: 'botc_session=admin' } })).json();
  assert.deepEqual(list, { active: '', versions: [] });
});

test('an added logo is served at the same addresses once it is in use, and Classic comes back', async t => {
  const { f, objects, call, bytes } = await setup(t);
  const mark = png(120, 162, 1), favicon = png(64, 64, 2);
  const added = await call('admin', { action: 'add', name: '  Winter  ', files: { mark: dataUrl(mark), favicon: dataUrl(favicon) } });
  assert.equal(added.status, 200);
  const id = added.body.id;
  assert.match(id, /^[a-f0-9]{12}$/);
  assert.deepEqual(added.body.versions.map(v => [v.name, v.slots, v.by]), [['Winter', ['mark', 'favicon'], 'admin']]);
  assert.equal(added.body.active, '', 'adding does not switch');
  assert.deepEqual([...objects.keys()].sort(), ['logo/' + id + '/favicon.png', 'logo/' + id + '/mark.png']);

  // Not in use yet: the address still answers Classic, the preview address the new one.
  assert.notDeepEqual(await bytes('/assets/logo/mark.webp'), mark);
  assert.deepEqual(await bytes('/assets/logo/' + id + '/mark.webp'), mark);
  assert.notDeepEqual(await bytes('/assets/logo/classic/mark.webp'), mark);

  const used = await call('admin', { action: 'use', id });
  assert.equal(used.body.active, id);
  const res = await f.request('/assets/logo/mark.webp');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), mark);
  assert.equal(res.headers.get('Content-Type'), 'image/png');
  assert.match(res.headers.get('Cache-Control'), /^public, max-age=3600/);
  const etag = res.headers.get('ETag');
  assert.equal((await f.request('/assets/logo/mark.webp', { headers: { 'If-None-Match': etag } })).status, 304);
  assert.deepEqual(await bytes('/assets/logo/favicon.png'), favicon);
  assert.deepEqual(await bytes('/assets/favicon.png'), favicon, 'the old name follows');
  // A size the version does not have keeps drawing Classic.
  assert.deepEqual(await bytes('/assets/logo/hero.webp'), await bytes('/assets/logo/classic/hero.webp'));
  assert.equal((await (await f.request('/api/boot')).json()).logo, id);
  // Classic's own ETag is not this version's.
  assert.equal((await f.request('/assets/logo/classic/mark.webp', { headers: { 'If-None-Match': etag } })).status, 200);

  const back = await call('admin', { action: 'use', id: '' });
  assert.equal(back.body.active, '');
  assert.notDeepEqual(await bytes('/assets/logo/mark.webp'), mark);
  assert.equal((await (await f.request('/api/boot')).json()).logo, '');

  // Deleting the one in use falls back to Classic and removes its files.
  await call('admin', { action: 'use', id });
  const gone = await call('admin', { action: 'delete', id });
  assert.deepEqual(gone.body, { ok: true, active: '', versions: [] });
  assert.equal(objects.size, 0);
  assert.notDeepEqual(await bytes('/assets/logo/mark.webp'), mark);
  assert.equal((await call('admin', { action: 'use', id })).status, 404);
  const log = f.db.prepare("SELECT entity_name FROM activity_log WHERE action='logo' ORDER BY id").all().map(r => r.entity_name);
  assert.deepEqual(log, ['add: Winter', 'use: Winter', 'use: Classic', 'use: Winter', 'delete: Winter']);
});

test('what is added is checked: a name, a picture, its type, its size', async t => {
  const { objects, call } = await setup(t);
  const ok = dataUrl(png(100, 100));
  assert.equal((await call('admin', { action: 'add', name: '', files: { mark: ok } })).status, 400);
  assert.equal((await call('admin', { action: 'add', name: 'X', files: { favicon: ok } })).status, 400);
  assert.equal((await call('admin', { action: 'add', name: 'X', files: { mark: dataUrl(png(100, 100), 'image/svg+xml') } })).status, 400);
  assert.equal((await call('admin', { action: 'add', name: 'X', files: { mark: dataUrl(Buffer.from('<svg/>'), 'image/png') } })).status, 400);
  assert.equal((await call('admin', { action: 'add', name: 'X', files: { mark: dataUrl(png(2000, 100)) } })).status, 400);
  // The three that leave the site are PNG only.
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8X'), Buffer.alloc(18)]);
  assert.equal((await call('admin', { action: 'add', name: 'X', files: { mark: ok, favicon: dataUrl(webp, 'image/webp') } })).status, 400);
  assert.equal((await call('admin', { action: 'bogus' })).status, 400);
  assert.equal(objects.size, 0, 'nothing is stored when any picture is refused');
});

test('a stored row nobody should trust is read as Classic', async t => {
  const { f, bytes } = await setup(t);
  f.db.prepare("INSERT INTO settings(key,value) VALUES('site_logo',?)").run(JSON.stringify({
    active: '../../art', versions: [{ id: '../../art', name: 'x', slots: { mark: 'png' } }, { id: 'abcdef012345', slots: { mark: 'svg' } }]
  }));
  assert.equal((await (await f.request('/api/boot')).json()).logo, '');
  assert.deepEqual(await bytes('/assets/logo/mark.webp'), await bytes('/assets/logo/classic/mark.webp'));
});

test('no page or script still names the old logo files', async () => {
  const root = new URL('../../', import.meta.url);
  const old = /assets\/(logo_skull|wiki-skull|headertext|favicon\.png)/;
  const files = (await readdir(root)).filter(n => n.endsWith('.html'))
    .concat((await readdir(new URL('assets/', root))).filter(n => /\.(js|css)$/.test(n)).map(n => 'assets/' + n))
    .concat(['worker/home-page.js', 'worker/list-pages.js']);
  for (const file of files) {
    assert.ok(!old.test(await readFile(new URL(file, root), 'utf8')), file);
  }
  // The Worker names them once, on purpose: the old addresses it still answers.
  const worker = await readFile(new URL('worker/worker.js', root), 'utf8');
  assert.equal(worker.split('LOGO_OLD_NAMES = {')[1].split('};')[0].match(/'[^']+':/g).length, 6);
});
