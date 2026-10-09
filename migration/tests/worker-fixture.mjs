import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = process.env.BOTC_TEST_ROOT || fileURLToPath(new URL('../../', import.meta.url));
const read = path => readFile(resolve(root, path), 'utf8');
let instance = 0;
// worker/argon2.js imports its WebAssembly the way Cloudflare does (a `.wasm`
// import IS a WebAssembly.Module there); Node has no such rule, so those two
// imports are rewritten into compiled modules and the file is loaded from a
// data: URL like the Worker itself.
async function argon2ModuleUrl() {
  const dir = resolve(root, 'worker');
  const src = "import { readFileSync } from 'node:fs';\n" + (await read('worker/argon2.js'))
    .replace(/import (\w+) from (['"])(\.\/[^'"]+\.wasm)\2;/g,
      (_, name, quote, path) => `const ${name} = new WebAssembly.Module(readFileSync(${JSON.stringify(resolve(dir, path))}));`)
    .replace(/from (['"])(\.\.?\/[^'"]+)\1/g,
      (_, quote, path) => 'from ' + JSON.stringify(pathToFileURL(resolve(dir, path)).href));
  return 'data:text/javascript;base64,' + Buffer.from(src).toString('base64');
}

export async function fixture() {
  const argon2Url = await argon2ModuleUrl();
  // Appending test-only exports avoids changing the production module API.
  const source = (await read('worker/worker.js')).replace(
    /from (['"])(\.\.?\/[^'"]+)\1/g,
    (_, quote, path) => 'from ' + JSON.stringify(path === './argon2.js' ? argon2Url : pathToFileURL(resolve(root, 'worker', path)).href)
  ) + `\n// isolate ${instance++}\nexport const hooks = {
    contentVersion, bumpContentVersion, cachedFeedBody, renderCharacterPage,
    applyCollectionAppearsIn, charsBySlug, ensurePagesTable, uploadSlotDenied,
    serveMedia, serveThumb, serveR2Image, ssrRoute, logActivity, app,
    hashPassword, verifyPassword, wrapLegacyPasswords, runBackup, readBackupTable,
    appearsInHref: typeof appearsInHref === 'function' ? appearsInHref : null
  };\n//# sourceURL=botc-worker-test-${instance}.mjs`;
  const worker = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const db = new DatabaseSync(':memory:');
  db.exec(await read('migration/schema.sql'));
  db.exec("ALTER TABLE characters ADD COLUMN url_slug TEXT; INSERT OR REPLACE INTO settings(key,value) VALUES('content_version','7')");
  const calls = [], background = [], cache = new Map();
  const state = { intercept: null, sessions: new Map() };
  const env = {
    DB: {
      prepare(sql) {
        const statement = {
          values: [],
          bind(...values) { this.values = values; return this; },
          async execute(kind) {
            calls.push({ sql, kind });
            const native = db.prepare(sql);
            // A write reports through `meta` on D1, which is what the Worker
            // reads to count the rows an UPDATE actually touched; node:sqlite
            // returns the counts bare, so both shapes are handed back.
            const written = kind === 'run' ? native.run(...this.values) : null;
            const value = kind === 'all' ? { results: native.all(...this.values) }
              : kind === 'first' ? native.get(...this.values) || null
              : { ...written, meta: { changes: Number(written.changes) || 0, last_row_id: Number(written.lastInsertRowid) || 0 } };
            return state.intercept ? state.intercept({ sql, kind, value }) : value;
          },
          all() { return this.execute('all'); },
          first() { return this.execute('first'); },
          run() { return this.execute('run'); }
        };
        return statement;
      }
    },
    SESSIONS: { async get(key) { return state.sessions.has(key) ? JSON.stringify(state.sessions.get(key)) : null; } },
    ASSETS: { async fetch(request) {
      const path = new URL(request.url).pathname.slice(1);
      try { return new Response(await read(path)); }
      catch {
        // Clean URLs (/team serves team.html), as Cloudflare's assets do.
        try { if (path && !/\.\w+$/.test(path)) return new Response(await read(path + '.html')); } catch { /* 404 below */ }
        return new Response('Not found', { status: 404 });
      }
    } }
  };
  globalThis.caches = { default: {
    async match(request) { return cache.get(request.url)?.clone(); },
    async put(request, response) { cache.set(request.url, response.clone()); }
  } };
  const ctx = { waitUntil(promise) { background.push(promise); } };
  function insert(table, slug, data, status = 'published') {
    const nameCol = table === 'collections' ? 'display_name' : 'name';
    const teamCol = table === 'characters' ? ',team,url_slug' : '';
    const teamValues = table === 'characters' ? ',?,?' : '';
    const values = [slug, data.name || data.displayName || slug, JSON.stringify(data), status, '2026-09-09 00:00:00'];
    if (table === 'characters') values.push(data.team || 'townsfolk', 'test-set/' + slug);
    db.prepare(`INSERT INTO ${table}(slug,${nameCol},data,status,updated_at${teamCol}) VALUES(?,?,?,?,?${teamValues})`).run(...values);
  }
  return { ...worker, env, ctx, db, calls, state, insert, cache, background,
    // The router itself, under the top-level safety net, so a test can see
    // the error a route throws. `safeRequest` goes through the net, as a
    // reader's request does.
    request(path, options) { return worker.hooks.app.fetch(new Request('https://botchomebrew.wiki' + path, options), env, ctx); },
    safeRequest(path, options) { return worker.default.fetch(new Request('https://botchomebrew.wiki' + path, options), env, ctx); },
    async finish() { await Promise.all(background); db.close(); }
  };
}

