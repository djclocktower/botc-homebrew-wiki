import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const png = (fill = 7) => 'data:image/png;base64,' + Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(64, fill)]).toString('base64');
const as = who => ({ headers: { Cookie: 'botc_session=' + who } });
const post = (who, body) => ({
  method: 'POST',
  headers: { Cookie: 'botc_session=' + who, 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

async function setup(t) {
  const f = await fixture(); t.after(() => f.finish());
  f.db.prepare("INSERT INTO users(id,username,password_hash,is_admin) VALUES(1,'admin','',1)").run();
  f.db.prepare("INSERT INTO users(id,username,password_hash) VALUES(2,'harry','')").run();
  f.db.prepare("INSERT INTO users(id,username,password_hash) VALUES(3,'stranger','')").run();
  for (const [id, name] of [[1, 'admin'], [2, 'harry'], [3, 'stranger']]) {
    f.state.sessions.set('sess:' + name, { userId: id, username: name, isAdmin: id === 1 });
  }
  const objects = new Map();
  f.env.ART = {
    objects,
    async put(key, body, opts) { objects.set(key, { body: Buffer.from(body), opts }); return { etag: 'e' }; },
    async get(key) {
      const o = objects.get(key); if (!o) return null;
      return { key, size: o.body.length, etag: 'e', httpEtag: '"e"', customMetadata: o.opts.customMetadata,
        body: new Blob([o.body]).stream(), writeHttpMetadata(h) { h.set('Content-Type', o.opts.httpMetadata.contentType); } };
    },
    async head(key) { return objects.has(key) ? { key, etag: 'e', httpEtag: '"e"' } : null; },
    async delete(keys) { for (const k of [].concat(keys)) objects.delete(k); }
  };
  const call = async (who, body, path = '/api/starlit') => {
    const res = await f.request(path, post(who, body));
    return { status: res.status, body: await res.json() };
  };
  const feed = async who => (await f.request('/api/starlit', who ? as(who) : undefined)).json();
  return { f, objects, call, feed };
}

test('an empty gallery reads as empty, and only the team can change it', async t => {
  const { f, call, feed } = await setup(t);
  const empty = await feed();
  assert.deepEqual(empty.icons, []);
  assert.deepEqual(empty.files, []);
  assert.equal(empty.page, null);
  assert.equal(empty.canUpload, false);
  // The packs the page shipped with are seeded as rows, 9 sheets each.
  assert.equal(empty.textures.length, 54);
  assert.deepEqual([...new Set(empty.textures.map(x => x.pack))], ['Default', 'Vibrant', 'Treasure Hunt', 'Starlit', 'Glitchy', 'Official']);
  assert.equal(empty.textures[0].image, '/assets/starlit/tex/default-base.webp');
  assert.equal(empty.textures[0].thumb, '/assets/starlit/tex/default-base-s.webp');
  assert.equal(empty.textures.find(x => x.pack === 'Official' && x.kind === 'base').name, 'Monochrome');
  assert.equal((await feed('stranger')).canUpload, false);
  const admin = await feed('admin');
  assert.equal(admin.canUpload, true);
  assert.deepEqual(admin.uploaders, []);

  const icon = { action: 'save', name: 'Knight', black: png(), white: png(), thumb: png() };
  assert.equal((await call('harry', icon)).status, 403);
  // Naming the team is an admin's job.
  assert.equal((await call('harry', { names: ['harry'] }, '/api/admin/starlit-uploaders')).status, 403);
  const named = await call('admin', { names: ['@Harry', 'nobody-by-that-name'] }, '/api/admin/starlit-uploaders');
  assert.deepEqual(named.body.uploaders, [{ username: 'harry' }]);
  assert.deepEqual(named.body.unknown, ['nobody-by-that-name']);
  assert.equal((await feed('harry')).canUpload, true);
  assert.equal((await feed('harry')).uploaders, undefined, 'only an admin sees who is on the team');
  assert.equal((await call('stranger', icon)).status, 403);
  // A locked wiki freezes the gallery too.
  f.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('wiki_locked','1')").run();
  const locked = await f.request('/api/starlit', post('harry', icon));
  f.db.prepare("DELETE FROM settings WHERE key='wiki_locked'").run();
  assert.equal(locked.status, 423);
});

test('the team adds, edits and deletes an icon; files get minted keys and go when replaced', async t => {
  const { f, objects, call, feed } = await setup(t);
  await call('admin', { names: ['harry'] }, '/api/admin/starlit-uploaders');
  const version = () => f.db.prepare("SELECT value FROM settings WHERE key='content_version'").get().value;
  const before = version();

  // A new icon needs all three images, and layers must be PNG or WebP.
  assert.equal((await call('harry', { action: 'save', name: 'Knight', black: png() })).status, 400);
  const jpeg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64');
  assert.equal((await call('harry', { action: 'save', name: 'Knight', black: jpeg, white: png(), thumb: png() })).status, 400);
  // The bytes have to be what they claim to be.
  const fake = 'data:image/png;base64,' + Buffer.from('<html>not a picture</html>').toString('base64');
  assert.equal((await call('harry', { action: 'save', name: 'Knight', black: fake, white: png(), thumb: png() })).status, 400);
  assert.equal(objects.size, 0, 'nothing is stored for a refused upload');

  const made = await call('harry', {
    action: 'save', name: '  Knight  of  Cups ', tags: 'Sword, armour ,sword,,', artist: 'Harry & Co & Bendan',
    tex: 'red', black: png(1), white: png(2), thumb: png(3), slug: 'ignored'
  });
  assert.equal(made.status, 200);
  const icon = made.body.icon;
  assert.equal(icon.name, 'Knight of Cups');
  assert.deepEqual(icon.tags, ['sword', 'armour']);
  assert.equal(icon.tex, 'red');
  for (const k of ['black', 'white', 'thumb']) {
    assert.match(icon[k], /^\/assets\/starlit\/[0-9a-f]{20}-(black|white|thumb)\.png$/);
    const stored = objects.get(icon[k].slice('/assets/'.length));
    assert.equal(stored.opts.customMetadata.owner, '2');
    assert.equal(stored.opts.httpMetadata.contentType, 'image/png');
  }
  assert.deepEqual((await feed()).icons.map(i => i.name), ['Knight of Cups']);
  assert.ok(icon.v);

  // The layers are served from R2.
  const served = await f.request(icon.black + '?v=' + icon.v);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('Content-Type'), 'image/png');

  // Replacing one layer is a new file; the old one is deleted, the others stay.
  const edited = await call('harry', { action: 'save', id: icon.id, name: 'Knight', tags: [], black: png(9), thumb: png(8) });
  assert.equal(edited.status, 200);
  assert.notEqual(edited.body.icon.black, icon.black);
  assert.equal(edited.body.icon.white, icon.white);
  assert.ok(!objects.has(icon.black.slice(8)) && !objects.has(icon.thumb.slice(8)));
  assert.ok(objects.has(icon.white.slice(8)));
  assert.equal(objects.size, 3);

  assert.equal((await call('harry', { action: 'save', id: 999, name: 'Gone' })).status, 404);
  assert.equal((await call('harry', { action: 'delete', id: icon.id })).status, 200);
  assert.equal(objects.size, 0);
  assert.deepEqual((await feed()).icons, []);

  // Nothing else on the wiki reads the gallery, so its caches stay warm.
  assert.equal(version(), before);
  const log = f.db.prepare("SELECT action FROM activity_log WHERE entity_type='starlit' ORDER BY id").all().map(r => r.action);
  assert.deepEqual(log, ['starlit-uploaders', 'starlit-add', 'starlit-edit', 'starlit-delete']);
});

test('texture packs: a sheet is added or replaced by pack and kind; packs rename and delete', async t => {
  const { objects, call, feed, f } = await setup(t);
  const tex = { action: 'texture', pack: 'Moonlit', kind: 'evil', image: png(), thumb: png(4) };
  assert.equal((await call('harry', tex)).status, 403);
  const made = await call('admin', tex);
  assert.equal(made.status, 200);
  assert.match(made.body.texture.image, /^\/assets\/starlit\/[0-9a-f]{20}-texture\.png$/);
  assert.match(made.body.texture.thumb, /-texture-s\.png$/);
  assert.equal((await call('admin', { ...tex, pack: '' })).status, 400);
  assert.equal((await call('admin', { ...tex, kind: 'purple' })).status, 400);
  // The same pack and kind again replaces the sheet and drops its old files.
  const again = await call('admin', { ...tex, image: png(5) });
  assert.equal(again.body.texture.id, made.body.texture.id);
  assert.equal(objects.size, 2);
  const only = await (await f.request('/api/starlit?textures=1')).json();
  assert.deepEqual(Object.keys(only), ['textures']);
  assert.equal(only.textures.at(-1).pack, 'Moonlit');

  // Replacing a shipped sheet; deleting its pack leaves the repo's files alone.
  await call('admin', { action: 'texture', pack: 'Default', kind: 'good', image: png(6) });
  assert.equal((await feed()).textures.filter(x => x.pack === 'Default').length, 9);
  assert.equal((await call('admin', { action: 'pack', from: 'Vibrant', to: 'Moonlit' })).status, 409);
  assert.equal((await call('admin', { action: 'pack', from: 'Vibrant', to: 'Bright' })).status, 200);
  assert.equal((await feed()).textures.filter(x => x.pack === 'Bright').length, 9);
  await call('admin', { action: 'pack', from: 'Default', remove: true });
  assert.equal((await feed()).textures.filter(x => x.pack === 'Default').length, 0);
  assert.equal(objects.size, 2, 'the uploaded Default sheet went with its pack');
  await call('admin', { action: 'delete-texture', id: made.body.texture.id });
  assert.equal(objects.size, 0);
});

test('a keyword or an artist renamed across every icon', async t => {
  const { call, feed } = await setup(t);
  const add = (name, tags, artist) => call('admin', { action: 'save', name, tags, artist, black: png(), white: png(), thumb: png() });
  await add('A', 'skull, bone', 'Harry & Co & Bendan');
  await add('B', 'Skull', 'Bendan, Harry & Co & Bendan');
  await add('C', 'tree', 'Someone');
  const r = await call('admin', { action: 'rename', what: 'tag', from: 'SKULL', to: 'bone' });
  assert.equal(r.body.changed, 2);
  assert.deepEqual((await feed()).icons.map(i => i.tags), [['bone'], ['bone'], ['tree']]);
  await call('admin', { action: 'rename', what: 'tag', from: 'tree', to: '' });
  assert.deepEqual((await feed()).icons[2].tags, []);
  const a = await call('admin', { action: 'rename', what: 'artist', from: 'harry & co & bendan', to: 'Harry & Co' });
  assert.equal(a.body.changed, 2);
  assert.deepEqual((await feed()).icons.map(i => i.artist), ['Harry & Co', 'Bendan, Harry & Co', 'Someone']);
  assert.equal((await call('admin', { action: 'rename', what: 'artist', from: 'Someone', to: '' })).status, 400);
});

test('the page text and theme are the team\'s, cleaned on save', async t => {
  const { call, feed } = await setup(t);
  const saved = await call('admin', { action: 'page', page: {
    intro: 'Hello [there](/u/harryandco)', about: '## Hi\n<script>x</script>',
    theme: { accent: '#112233', background: 'starlit/page-bg.jpg', css: 'h1{color:red}', bogus: 1 }
  } });
  assert.equal(saved.status, 200);
  const page = (await feed()).page;
  assert.equal(page.intro, 'Hello [there](/u/harryandco)');
  assert.equal(page.theme.accent, '#112233');
  assert.equal(page.theme.background, 'starlit/page-bg.jpg');
  assert.equal(page.theme.bogus, undefined);
  // Somebody else's background slot is not this page's.
  await call('admin', { action: 'page', page: { theme: { background: 'avatars/u1-bg.jpg' } } });
  assert.equal((await feed()).page, null);
  const bg = await call('admin', { action: 'page-image', kind: 'bg', data: png() });
  assert.equal(bg.body.path, 'starlit/page-bg.png');
  assert.equal((await call('admin', { action: 'page-image', kind: 'st', n: 99, data: png() })).status, 400);
});

test('downloads: any size up to the cap, typed by their bytes', async t => {
  const { f, objects, call, feed } = await setup(t);
  const up = (who, bytes, q) => f.request('/api/starlit-file?' + new URLSearchParams(q), {
    method: 'POST', headers: { Cookie: 'botc_session=' + who, 'Content-Length': String(bytes.length) }, body: bytes
  });
  const psd = Buffer.concat([Buffer.from('8BPS'), Buffer.from([0, 1]), Buffer.alloc(5000, 3)]);
  assert.equal((await up('harry', psd, { title: 'Templates' })).status, 403);
  assert.equal((await up('admin', psd, { title: '' })).status, 400);
  assert.equal((await up('admin', Buffer.from('<svg onload=alert(1)>'), { title: 'x', name: 'a.png' })).status, 400);
  const res = await up('admin', psd, { title: 'Templates', note: 'For Photoshop', name: 'Icon template.psd' });
  assert.equal(res.status, 200);
  const file = (await res.json()).file;
  assert.equal(file.name, 'Icon_template.psd');
  assert.equal(file.type, 'image/vnd.adobe.photoshop');
  assert.equal(file.size, psd.length);
  const stored = objects.get(file.url.slice('/assets/'.length));
  assert.ok(stored.body.equals(psd), 'the whole file is stored');
  assert.match(stored.opts.httpMetadata.contentDisposition, /^attachment/);
  assert.equal((await feed()).files[0].title, 'Templates');
  await call('admin', { action: 'file', id: file.id, title: 'PSD templates', note: '' });
  assert.equal((await feed()).files[0].title, 'PSD templates');
  await call('admin', { action: 'delete-file', id: file.id });
  assert.deepEqual((await feed()).files, []);
  assert.equal(objects.size, 0);
});

test('/api/upload cannot write into the gallery\'s folder', async t => {
  const { f } = await setup(t);
  const res = await f.request('/api/upload', post('admin', { key: 'starlit/abc-black.png', data: png() }));
  assert.equal(res.status, 400);
});

test('a pictographic creator mark is drawn in its text form, everything else as typed', async () => {
  const { default: Creators } = await import('../../assets/creators.js');
  assert.match(Creators.markHTMLFor('Harry & Co & Bendan'), />\u264A\uFE0E<\/span>$/);
  assert.match(Creators.markHTMLFor('Hystrex'), />\u2207<\/span>$/);
  // One already carrying a selector keeps it, and only it.
  assert.match(Creators.markHTMLFor('Pynstripe'), />\u2663\uFE0E<\/span>$/);
});
