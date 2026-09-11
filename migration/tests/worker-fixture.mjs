import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = process.env.BOTC_TEST_ROOT || fileURLToPath(new URL('../../', import.meta.url));
const read = path => readFile(resolve(root, path), 'utf8');
let instance = 0;
export async function fixture() {
  // Appending test-only exports avoids changing the production module API.
  const source = (await read('worker/worker.js')).replace(
    /from (['"])(\.\.?\/[^'"]+)\1/g,
    (_, quote, path) => 'from ' + JSON.stringify(pathToFileURL(resolve(root, 'worker', path)).href)
  ) + `\n// isolate ${instance++}\nexport const hooks = {
    contentVersion, bumpContentVersion, cachedFeedBody, renderCharacterPage,
    applyCollectionAppearsIn, charsBySlug, ensurePagesTable, uploadSlotDenied,
    serveMedia, serveThumb, serveR2Image, ssrRoute, logActivity,
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
            const value = kind === 'all' ? { results: native.all(...this.values) }
              : kind === 'first' ? native.get(...this.values) || null : native.run(...this.values);
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
      catch { return new Response('Not found', { status: 404 }); }
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
    request(path, options) { return worker.default.fetch(new Request('https://botchomebrew.wiki' + path, options), env, ctx); },
    async finish() { await Promise.all(background); db.close(); }
  };
}

