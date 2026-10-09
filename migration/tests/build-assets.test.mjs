import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';

test('build versions assets, retains old URLs, preserves redirect stubs and excludes internal files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'botc-build-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['assets', 'worker', 'migration', 'characters']) await mkdir(join(root, dir));
  const write = (path, data) => writeFile(join(root, path), data);
  const read = path => readFile(join(root, path), 'utf8');
  await write('assets/data.js', 'window.data = 1;');
  await write('assets/styles.css', '.page { background:url(bg.webp); }');
  await write('worker/worker.js', 'export default {};');
  await write('migration/private.sql', 'PRIVATE DATABASE CONTENT');
  await write('README.md', 'INTERNAL DOCUMENTATION');
  await write('characters/old.html', '<meta http-equiv="refresh" content="0;url=../c/new">');
  await write('index.html', '<!doctype html><head><meta charset="UTF-8"><script src="assets/data.js"></script><link href="assets/styles.css" rel="stylesheet"></head>');
  await write('_headers', '/\n  Link: </assets/styles.css>; rel=preload; as=style\n');
  const script = fileURLToPath(new URL('../build-assets.mjs', import.meta.url));
  const build = (...args) => execFileSync(process.execPath, [script, ...args], { env: { ...process.env, BOTC_BUILD_ROOT: root }, stdio: 'pipe' });
  const manifest = async () => JSON.parse((await read('worker/asset-manifest.js')).match(/export default ([\s\S]+);/)[1]);
  build(); const first = await manifest(), firstStamp = await read('worker/asset-manifest.js');
  const html = await read('.build/public/index.html');
  assert.ok(html.indexOf('charset=') < 1024);
  assert.ok(html.indexOf('BOTC_ASSETS') > html.indexOf('charset='));
  assert.match(html, new RegExp(first['data.js'].replaceAll('.', '\\.')));
  assert.match(await read('.build/public/assets/' + first['styles.css']), /url\(\.\.\/bg.webp\)/);
  // The hashed copy is minified; the plain one stays the source (the text editor reads it).
  assert.equal(await read('.build/public/assets/' + first['data.js']), 'window.data=1;\n');
  assert.equal(await read('.build/public/assets/data.js'), 'window.data = 1;');
  assert.equal(await read('.build/public/characters/old.html'), await read('characters/old.html'));
  for (const path of ['worker/worker.js', 'migration/private.sql', 'migration/asset-archive.json', 'README.md']) {
    await assert.rejects(read('.build/public/' + path), { code: 'ENOENT' });
  }
  build('--check'); assert.equal(await read('worker/asset-manifest.js'), firstStamp);
  await write('assets/data.js', 'window.data = 2;');
  assert.throws(() => build('--check'), /Run node migration\/build-assets.mjs/);
  build(); const second = await manifest(); assert.notEqual(first['data.js'], second['data.js']);
  assert.equal(await read('.build/public/assets/' + first['data.js']), 'window.data=1;\n');
  assert.equal(await read('.build/public/assets/' + second['data.js']), 'window.data=2;\n');
  const beforeWorkerEdit = await read('worker/asset-manifest.js');
  await write('worker/worker.js', 'export default { changed: true };');
  assert.throws(() => build('--check'), /manifest is stale/);
  build(); assert.notEqual(await read('worker/asset-manifest.js'), beforeWorkerEdit);
  build('--check');
});

test('build minifies the immutable copies, ships unreadable files as written and keeps the archive immutable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'botc-build-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['assets', 'worker', 'migration', 'characters']) await mkdir(join(root, dir));
  const write = (path, data) => writeFile(join(root, path), data);
  const read = path => readFile(join(root, path), 'utf8');
  const site = '/* loader */\nfunction load() {\n  return BotcData.script(\'lazy.js\');   // looked up at runtime\n}\nvar s = "  keep   this  ";\n';
  await write('assets/site.js', site);
  await write('assets/lazy.js', 'window.lazy = true;\n');
  await write('assets/page.js', 'window.page = true;\n');
  // `}` then `/`: the tokenizer will not guess, so this ships as written.
  await write('assets/odd.js', 'if (a) {}\n/x/.test(b);\n');
  await write('assets/styles.css', '/* c */\n.a  >  .b {\n  width: calc(100% - 2px);\n  background: url(img/x.png);\n}\n');
  await write('assets/broken.css', "/* a */ b */ it's\n.a { x: y }\n");
  await write('worker/worker.js', 'export default {};');
  await write('characters/old.html', 'x');
  await write('index.html', '<!doctype html><head><meta charset="UTF-8"><link href="assets/styles.css" rel="stylesheet"><script src="assets/site.js"></script><script src="assets/page.js"></script></head>');
  const script = fileURLToPath(new URL('../build-assets.mjs', import.meta.url));
  const build = (...args) => execFileSync(process.execPath, [script, ...args], { env: { ...process.env, BOTC_BUILD_ROOT: root }, stdio: 'pipe' }).toString();
  const log = build();
  const manifest = JSON.parse((await read('worker/asset-manifest.js')).match(/export default ([\s\S]+);/)[1]);
  const built = file => read('.build/public/assets/' + manifest[file]);
  assert.equal(await built('site.js'), 'function load(){return BotcData.script(\'lazy.js\');}\nvar s="  keep   this  ";\n');
  assert.equal(await read('.build/public/assets/site.js'), site);
  assert.equal(await built('styles.css'), '.a>.b{width:calc(100% - 2px);background:url(../img/x.png)}\n');
  assert.equal(await built('odd.js'), 'if (a) {}\n/x/.test(b);\n');
  assert.equal(await built('broken.css'), "/* a */ b */ it's\n.a { x: y }\n");
  assert.match(log, /Shipped unminified: broken\.css/);
  assert.match(log, /Shipped unminified: odd\.js/);
  // BOTC_ASSETS carries only what a page looks up at runtime.
  const html = await read('.build/public/index.html');
  const runtime = JSON.parse(html.match(/window\.BOTC_ASSETS=(\{.*?\});/)[1]);
  assert.deepEqual(runtime, { 'lazy.js': manifest['lazy.js'] });
  assert.ok(html.includes('assets/' + manifest['page.js']));
  assert.match(await read('worker/asset-manifest.js'), /export const RUNTIME_ASSETS = \{\s*"lazy\.js": "immutable\/lazy\.[a-f0-9]{20}\.js"\s*\};/);
  // Deterministic: a second build and --check reproduce the same bytes.
  const stamp = await read('worker/asset-manifest.js'), archive = await read('migration/asset-archive.json');
  build(); assert.equal(await read('worker/asset-manifest.js'), stamp); assert.equal(await read('migration/asset-archive.json'), archive);
  build('--check');
  // A published hash is never pruned, and never re-pointed at other bytes.
  await write('assets/lazy.js', 'window.lazy = 2;\n');
  build();
  const kept = JSON.parse(await read('migration/asset-archive.json'));
  assert.ok(kept[manifest['lazy.js'].slice('immutable/'.length)]);
  assert.equal(await built('lazy.js'), 'window.lazy=true;\n');
  const next = JSON.parse((await read('worker/asset-manifest.js')).match(/export default ([\s\S]+);/)[1]);
  kept[next['lazy.js'].slice('immutable/'.length)] = gzipSync('tampered').toString('base64');
  await write('migration/asset-archive.json', JSON.stringify(kept));
  assert.throws(() => build('--check'), /Immutable asset collision/);
});
