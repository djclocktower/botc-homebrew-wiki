// Run before committing: node migration/build-assets.mjs
// Wrangler runs --check: a deploy must include the archive of every hash it serves.
import { readdir, readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { minifyCSS, minifyJS, significantJS } from './minify.mjs';

const root = resolve(process.env.BOTC_BUILD_ROOT || fileURLToPath(new URL('../', import.meta.url)));
const check = process.argv.includes('--check');
const read = p => readFile(resolve(root, p), 'utf8');
const hash = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 20);
const archivePath = 'migration/asset-archive.json';
let archive = {};
try { archive = JSON.parse(await read(archivePath)); } catch (error) { if (error.code !== 'ENOENT') throw error; }

// Only the hashed copies under assets/immutable/ are minified. The plain
// assets/x.js copies stay byte-for-byte the source: /text-editor's scanner
// (assets/text-scan.js) fetches those to list the site's wording, and they are
// what a stale or missing manifest entry falls back to.
// Files named here ship unminified whatever the minifier thinks.
const NO_MINIFY = new Set([]);
const skipped = [];
let bytesIn = 0, bytesOut = 0;
function minified(file, body) {
  if (NO_MINIFY.has(file)) return body;
  const skip = why => skipped.push(file + ' (' + why + ')');
  if (file.endsWith('.css')) {
    const out = minifyCSS(body, skip);
    if (out == null) return body;
    // Determinism is what lets --check compare against the committed archive.
    if (minifyCSS(body) !== out) throw new Error('CSS minifier is not deterministic: ' + file);
    return out;
  }
  // A file that is not a classic script (a module, say) is left alone.
  try { new vm.Script(body, { filename: file }); } catch { skip('not a classic script'); return body; }
  const out = minifyJS(body, skip);
  if (out == null) return body;
  if (minifyJS(body) !== out) throw new Error('JS minifier is not deterministic: ' + file);
  // A minifier bug fails the build, never the site: the minified copy must be
  // the same token stream and must still compile (what `node --check` does).
  if (significantJS(out).join('\0') !== significantJS(body).join('\0')) throw new Error('Minified tokens differ: ' + file);
  try { new vm.Script(out, { filename: 'immutable/' + file }); }
  catch (error) { throw new Error('Minified copy does not compile: ' + file + ': ' + error.message); }
  return out;
}

const assets = {}, current = {};
for (const file of (await readdir(resolve(root, 'assets'))).sort()) {
  if (!/\.(js|css)$/.test(file)) continue;
  let body = await read('assets/' + file);
  // CSS moves one directory down; keep relative fonts/textures pointed at assets/.
  if (file.endsWith('.css')) body = body.replace(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/g, (all, quote, url) =>
    /^(?:[a-z]+:|\/|#)/i.test(url) ? all : 'url(' + quote + '../' + url + quote + ')');
  const source = body;
  body = minified(file, body);
  bytesIn += Buffer.byteLength(source); bytesOut += Buffer.byteLength(body);
  const name = file.replace(/\.(js|css)$/, '.' + hash(body) + '.$1');
  assets[file] = 'immutable/' + name;
  current[name] = body;
  if (archive[name]) {
    if (gunzipSync(Buffer.from(archive[name], 'base64')).toString() !== body) throw new Error('Immutable asset collision: ' + name);
  } else {
    if (check) throw new Error('Run node migration/build-assets.mjs and commit its generated files before deploying: ' + file);
    archive[name] = gzipSync(body, { level: 9 }).toString('base64');
  }
}
const sources = [];
for (const directory of ['', 'worker']) {
  for (const file of (await readdir(resolve(root, directory))).sort()) {
    if (!/\.(html|js)$/.test(file) || file === 'asset-manifest.js') continue;
    const path = directory ? directory + '/' + file : file;
    sources.push(path + '\n' + await read(path));
  }
}
// What a page can look up at RUNTIME, which is all window.BOTC_ASSETS is for:
// a literal name handed to BotcData.asset/script/style (data.js) in a browser
// script or a page. Everything a page loads with a plain <script src> or
// <link href> is rewritten into the HTML and needs no entry, and the full map
// was ~4 KB at the top of every page. A name the scan misses (one built at
// runtime) still loads, from its plain, revalidating /assets/ address.
const lookups = new Set();
const lookupCall = /\.(?:asset|script|style)\(\s*['"`](?:\.{0,2}\/)*(?:assets\/)?([a-z0-9._-]+\.(?:js|css))['"`]/gi;
for (const file of (await readdir(resolve(root, 'assets'))).sort()) {
  if (/\.js$/.test(file)) for (const m of (await read('assets/' + file)).matchAll(lookupCall)) lookups.add(m[1]);
}
for (const entry of sources) {
  for (const m of entry.matchAll(lookupCall)) lookups.add(m[1]);   // worker/ too: its pages carry inline scripts
}
const runtime = {};
for (const file of Object.keys(assets)) if (lookups.has(file)) runtime[file] = assets[file];

// A deployment stamp also rolls SSR when only the Worker or HTML changes.
const buildId = hash(JSON.stringify(assets) + sources.join('\n'));
const manifest = '// Generated by migration/build-assets.mjs; do not edit.\n' +
  'export const BUILD_ID = ' + JSON.stringify(buildId) + ';\n' +
  '// The entries a page looks up at runtime: what window.BOTC_ASSETS carries.\n' +
  'export const RUNTIME_ASSETS = ' + JSON.stringify(runtime, null, 2) + ';\n' +
  'export default ' + JSON.stringify(assets, null, 2) + ';\n';
if (check) {
  if (await read('worker/asset-manifest.js') !== manifest) throw new Error('Asset manifest is stale. Run node migration/build-assets.mjs before committing.');
} else {
  await writeFile(resolve(root, 'worker/asset-manifest.js'), manifest);
  await writeFile(resolve(root, archivePath), JSON.stringify(archive, null, 2) + '\n');
}
const out = resolve(root, '.build/public');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
// Explicit public inputs; Worker source, tests and archives never get uploaded.
await cp(resolve(root, 'assets'), resolve(out, 'assets'), { recursive: true });
// These three historical character addresses are still public redirect stubs.
await cp(resolve(root, 'characters'), resolve(out, 'characters'), { recursive: true });
await mkdir(resolve(out, 'assets/immutable'), { recursive: true });
for (const [name, compressed] of Object.entries(archive)) {
  if (!/^[a-z0-9._-]+\.[a-f0-9]{20}\.(js|css)$/i.test(name)) throw new Error('Invalid archive path');
  await writeFile(resolve(out, 'assets/immutable', name), gunzipSync(Buffer.from(compressed, 'base64')));
}
function replacePaths(text) {
  return text.replace(/assets\/([a-z0-9._-]+\.(?:js|css))\b/gi, (all, file) => assets[file] ? 'assets/' + assets[file] : all);
}
const bootstrap = '<script>window.BOTC_ASSETS=' + JSON.stringify(runtime) + ';</script>';
for (const file of await readdir(root)) {
  if (!/\.(html|json|txt|xml|ico|png|webmanifest)$/.test(file) && !['_headers', '_redirects'].includes(file)) continue;
  const body = await readFile(resolve(root, file));
  let output = body;
  // Keep the encoding declaration within the first 1024 bytes. The manifest
  // is larger than that and must follow it, before any inline consumers.
  if (/\.html$/.test(file)) output = replacePaths(body.toString()).replace(/<meta\s+charset=[^>]+>/i, '$&\n' + bootstrap);
  if (file === '_headers') output = replacePaths(body.toString());
  await writeFile(resolve(out, file), output);
}
for (const line of skipped) console.log('Shipped unminified: ' + line);
console.log('Minified ' + Math.round(bytesIn / 1024) + ' KB of CSS/JS to ' + Math.round(bytesOut / 1024) + ' KB.');
console.log('Built ' + Object.keys(assets).length + ' versioned assets; retained ' + Object.keys(archive).length + ' immutable files. Build ' + buildId);
