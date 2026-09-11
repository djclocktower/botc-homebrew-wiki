import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

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
  assert.equal(await read('.build/public/assets/' + first['data.js']), 'window.data = 1;');
  assert.equal(await read('.build/public/characters/old.html'), await read('characters/old.html'));
  for (const path of ['worker/worker.js', 'migration/private.sql', 'migration/asset-archive.json', 'README.md']) {
    await assert.rejects(read('.build/public/' + path), { code: 'ENOENT' });
  }
  build('--check'); assert.equal(await read('worker/asset-manifest.js'), firstStamp);
  await write('assets/data.js', 'window.data = 2;');
  assert.throws(() => build('--check'), /Run node migration\/build-assets.mjs/);
  build(); const second = await manifest(); assert.notEqual(first['data.js'], second['data.js']);
  assert.equal(await read('.build/public/assets/' + first['data.js']), 'window.data = 1;');
  assert.equal(await read('.build/public/assets/' + second['data.js']), 'window.data = 2;');
  const beforeWorkerEdit = await read('worker/asset-manifest.js');
  await write('worker/worker.js', 'export default { changed: true };');
  assert.throws(() => build('--check'), /manifest is stale/);
  build(); assert.notEqual(await read('worker/asset-manifest.js'), beforeWorkerEdit);
  build('--check');
});
