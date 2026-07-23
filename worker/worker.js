/**
 * BOTC Homebrew Wiki — Cloudflare Worker
 * ----------------------------------------------------------------
 * Option B architecture: the frontend stays static and renders in the
 * browser. This Worker only changes WHERE the data comes from and adds
 * authentication + ownership for writes.
 *
 * Routes it handles:
 *   GET  /characters.json     -> built from D1 (published pages only)
 *   GET  /collections.json    -> built from D1
 *   GET  /scripts.json        -> built from D1
 *
 *   -- auth --
 *   POST /api/signup          -> create an account (username/email/password)
 *   POST /api/login           -> log in (username OR email + password)
 *   POST /api/logout          -> clears session
 *   GET  /api/me              -> who am I
 *   POST /api/forgot-password -> email a password-reset link
 *   POST /api/reset-password  -> set new password from a reset token
 *   GET  /api/verify-email    -> confirm email from the emailed link
 *   POST /api/resend-verification
 *   GET  /api/auth/discord    -> start Discord OAuth (sign in / sign up / link)
 *   GET  /api/auth/discord/callback
 *
 *   -- account --
 *   GET  /api/account         -> profile + your pages + drafts + recent edits
 *   POST /api/account/profile -> update display name / bio
 *   POST /api/account/avatar  -> upload/remove your profile picture (R2)
 *   POST /api/account/password-> change (or set) password
 *   POST /api/account/email   -> change email (re-verifies)
 *   POST /api/account/unlink-discord
 *   GET  /api/contact         -> your own messages to the admins
 *   POST /api/contact         -> send a message to the admins (bug/suggestion/…)
 *   GET  /api/announcement    -> current site-wide announcement (public)
 *
 *   -- direct messages (user <-> user, incl. admins; /messages page) --
 *   GET  /api/messages        -> conversation list + unread counts + block list
 *   GET  /api/messages/thread -> one conversation (?with=username, ?before=id)
 *   POST /api/messages/send   -> send a DM ({to, body})
 *   POST /api/messages/block  -> block/unblock a user ({user, blocked})
 *   POST /api/messages/delete -> hide a whole conversation for yourself ({with})
 *   POST /api/messages/report -> report a conversation to the admins ({with, reason})
 *   GET  /api/admin/dm-reports -> reported conversations (?status=open|all)
 *   POST /api/admin/dm-report  -> resolve/reopen/delete one report
 *   GET  /api/admin/dm-thread  -> transcript of a REPORTED conversation (?a=&b=)
 *
 *   -- content (any logged-in user; edits restricted to owner/admin) --
 *   GET  /api/page            -> fetch one page for editing (drafts incl.)
 *   POST /api/character       -> create/update a character
 *   POST /api/collection      -> create/update a collection
 *   POST /api/script          -> create/update a script
 *   POST /api/publish         -> flip a page between draft and published
 *   POST /api/delete          -> soft-delete a page you own (recoverable)
 *   POST /api/upload          -> image upload to R2 (ownership-checked)
 *
 *   -- public pages & discovery --
 *   GET  /api/user            -> public profile + published pages (?u=username)
 *   GET  /u/{username}        -> public profile page (serves profile.html)
 *   GET  /random              -> 302 to a random published character page
 *   GET  /sitemap.xml         -> built live from D1
 *   GET  /s/{slug}            -> script page (server-side rendered from D1)
 *   GET  /collection/{id}     -> collection page (server-side rendered from D1)
 *   GET  /script-view(.html)  -> 301 to /s/{slug} (legacy links)
 *   POST /api/admin/assign-owner -> admin: set/clear a page's owner account
 *
 *   -- admin --
 *   GET  /api/admin/dashboard -> dashboard data (incl. deleted + protected)
 *   GET  /api/admin/activity  -> full activity log (paginated + filterable)
 *   GET  /api/admin/report    -> activity report for the last ?days=N days
 *   GET  /api/admin/revisions -> version history for one page (?type=&slug=)
 *   POST /api/admin/rollback  -> roll a page back to an earlier revision
 *   POST /api/admin/restore   -> admin: restore a soft-deleted page
 *   POST /api/admin/purge     -> admin: permanently delete a soft-deleted page
 *   GET  /api/admin/users     -> user list (?q= search) for the users panel
 *   POST /api/admin/user      -> ban/unban/promote/demote/reset-link for a user
 *   GET  /api/admin/messages  -> contact-form inbox (?status=open|all)
 *   POST /api/admin/message   -> resolve/reopen/delete an inbox message
 *   POST /api/admin/protect   -> protect/unprotect one page from edits
 *   POST /api/admin/announce  -> set/clear the site-wide announcement banner
 *   GET  /api/admin/orphans   -> R2 images no page references any more
 *   POST /api/admin/purge-images -> delete selected orphaned images
 *   GET  /api/admin/broken-refs  -> scripts/collections pointing at missing chars
 *   POST /api/admin/clean-refs   -> strip broken refs from one page
 *   GET  /api/admin/backups   -> list nightly R2 backups (dates + tables)
 *   GET  /api/admin/backup-file  -> download one backup table (?date=&table=)
 *   POST /api/admin/restore-page -> restore one page from a backup date
 *   GET  /api/admin/pages     -> page list for bulk actions (?type=&q=&owner=)
 *   POST /api/admin/bulk      -> bulk publish/unpublish/delete/owner/tag ops
 *   GET  /api/admin/analytics -> most-viewed pages for the last ?days=N days
 *   POST /api/lock            -> lock/unlock the wiki
 *   POST /api/backup          -> run a D1 -> R2 backup now
 *   POST /api/seed            -> one-time data load from repo JSON
 *
 *   scheduled (cron)          -> nightly D1 -> R2 JSON backup (backups/{date}/)
 *   everything else           -> served from static assets
 * ----------------------------------------------------------------
 * Secrets / vars this Worker uses (set via `wrangler secret put` or the
 * Cloudflare dashboard — all optional, features degrade gracefully):
 *   RESEND_API_KEY        -> enables outgoing email (password reset, verify)
 *   MAIL_FROM             -> e.g. 'BOTC Homebrew Wiki <no-reply@yourdomain>'
 *   DISCORD_CLIENT_ID     -> enables "Sign in with Discord"
 *   DISCORD_CLIENT_SECRET
 */

// esbuild bundles render.js's CommonJS export into the Worker; no DOM here.
import Render from '../assets/render.js';
// Shared script/collection page renderer (also used by the publish pages in
// the browser). It receives render.js's exports through init().
import PageRender from '../assets/render-page.js';
PageRender.init(Render);
// Creator-symbol registry ("credit icons"), single source in creators.js.
// Injected so SSR /c/ pages show a creator's symbol next to their name.
import Creators from '../assets/creators.js';
Render.setCreators(Creators);

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const APP_NAME = 'BOTC Homebrew Wiki';

const R2_PREFIXES = ['art/', 'collections/', 'scripts/', 'tokens/'];
// avatars/ is servable from R2 but NOT uploadable through the generic
// /api/upload — profile pictures only go through /api/account/avatar,
// which pins the key to the logged-in user's own slot.
const R2_SERVE_PREFIXES = R2_PREFIXES.concat(['avatars/']);
const EXT_CONTENT_TYPE = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml'
};

// Content-type registry: maps API "type" to its table + display columns.
const CONTENT = {
  character:  { table: 'characters',  nameCol: 'name' },
  collection: { table: 'collections', nameCol: 'display_name' },
  script:     { table: 'scripts',     nameCol: 'name' }
};

// ---- password hashing (PBKDF2, matches the seeded admin hash) ----
const PBKDF2_ITERATIONS = 100000;

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password),
    { name: 'PBKDF2' }, false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key, 256
  );
  return bytesToBase64(new Uint8Array(bits));
}

async function verifyPassword(password, stored) {
  // stored format: pbkdf2_sha256$iterations$salt_b64$hash_b64
  if (!stored) return false; // Discord-only accounts have no password
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
  const iterations = parseInt(parts[1], 10);
  const salt = base64ToBytes(parts[2]);
  return (await pbkdf2(password, salt, iterations)) === parts[3];
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${hash}`;
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function randomToken() {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
}

// ---- sessions (stored in KV) ----
async function createSession(env, userId, isAdmin) {
  const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
  const session = JSON.stringify({ userId, isAdmin, created: Date.now() });
  // 30-day expiry
  await env.SESSIONS.put('sess:' + token, session, { expirationTtl: 60 * 60 * 24 * 30 });
  return token;
}
async function getSession(env, request) {
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/botc_session=([^;]+)/);
  if (!m) return null;
  const raw = await env.SESSIONS.get('sess:' + m[1]);
  if (!raw) return null;
  try { return { token: m[1], ...JSON.parse(raw) }; } catch { return null; }
}
function sessionCookie(token) {
  return `botc_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`;
}
function clearCookie() {
  return 'botc_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}

// ---- basic per-IP rate limiting (KV counter; best-effort) ----
async function rateLimited(env, request, bucket, limit, windowSec) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = `rl:${bucket}:${ip}`;
  const cur = parseInt((await env.SESSIONS.get(key)) || '0', 10);
  if (cur >= limit) return true;
  await env.SESSIONS.put(key, String(cur + 1), { expirationTtl: windowSec });
  return false;
}

// ---- outgoing email (Resend; optional) ----
function emailShell(title, bodyHtml) {
  return `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:24px;color:#241a12;background:#f7f0e0;border:1px solid #cdbfa0">
  <h2 style="color:#5b1f21;margin:0 0 12px">${title}</h2>
  ${bodyHtml}
  <p style="font-size:12px;color:#8a7a5e;margin-top:28px">${APP_NAME} — fan-made content for Blood on the Clocktower.<br>
  If you didn't request this email you can safely ignore it.</p>
</div>`;
}

async function sendEmail(env, to, subject, html) {
  if (!env.RESEND_API_KEY) {
    return { ok: false, error: 'Email is not configured on this server yet.' };
  }
  const from = env.MAIL_FROM || `${APP_NAME} <onboarding@resend.dev>`;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from, to: [to], subject, html })
    });
    if (!res.ok) return { ok: false, error: 'Email delivery failed (' + res.status + ').' };
    return { ok: true };
  } catch {
    return { ok: false, error: 'Email delivery failed.' };
  }
}

async function sendVerificationEmail(env, origin, user) {
  if (!user.email) return { ok: false, error: 'No email on this account.' };
  const token = randomToken();
  await env.SESSIONS.put('verify:' + token, String(user.id), { expirationTtl: 60 * 60 * 24 });
  const link = origin + '/api/verify-email?token=' + token;
  return sendEmail(env, user.email, 'Verify your email — ' + APP_NAME, emailShell(
    'Verify your email',
    `<p>Hi ${escapeHtml(user.display_name || user.username)},</p>
     <p>Click the link below to verify the email address on your ${APP_NAME} account:</p>
     <p><a href="${link}" style="color:#5b1f21;font-weight:bold">Verify my email</a></p>
     <p>This link expires in 24 hours.</p>`
  ));
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---- validation ----
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,19}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validSignup(username, email, password) {
  if (!USERNAME_RE.test(username || '')) {
    return 'Username must be 3–20 characters: letters, numbers, hyphens or underscores.';
  }
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return 'Please enter a valid email address.';
  }
  if (!password || password.length < 8 || password.length > 200) {
    return 'Password must be at least 8 characters.';
  }
  return null;
}

async function findUserByLogin(env, identifier) {
  return env.DB.prepare(
    `SELECT * FROM users WHERE lower(username) = lower(?1) OR (email IS NOT NULL AND lower(email) = lower(?1))`
  ).bind(identifier).first();
}

// ---- wiki lock (global freeze flag, stored in D1 settings) ----
async function isWikiLocked(env) {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key='wiki_locked'").first();
    return !!row && row.value === '1';
  } catch { return false; }
}

// ---- activity log helper ----
async function logActivity(env, sess, action, entityType, slug, name) {
  let username = null;
  try {
    const u = await env.DB.prepare('SELECT username FROM users WHERE id=?').bind(sess.userId).first();
    username = u ? u.username : null;
  } catch { /* non-fatal: still log with null username */ }
  try {
    await env.DB.prepare(
      `INSERT INTO activity_log (user_id, username, action, entity_type, entity_slug, entity_name)
       VALUES (?,?,?,?,?,?)`
    ).bind(sess.userId, username, action, entityType, slug || null, name || null).run();
  } catch { /* never let logging break a write */ }
}

// ---- page revisions (version history for rollback) ----
// The table is created lazily by the Worker itself, so no manual D1
// migration is ever needed. Every content save snapshots the version it is
// about to replace; the newest 20 revisions per page are kept.
const REVISIONS_KEEP = 20;
let _revisionsReady = false;
async function ensureRevisionsTable(env) {
  if (_revisionsReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS revisions (
       id          INTEGER PRIMARY KEY AUTOINCREMENT,
       entity_type TEXT NOT NULL,
       slug        TEXT NOT NULL,
       name        TEXT,
       status      TEXT,
       data        TEXT NOT NULL,
       edited_by   TEXT,
       ts          TEXT NOT NULL DEFAULT (datetime('now'))
     )`
  ).run();
  await env.DB.prepare(
    'CREATE INDEX IF NOT EXISTS idx_revisions_entity ON revisions(entity_type, slug, id)'
  ).run();
  _revisionsReady = true;
}

// Snapshot an existing row before it gets overwritten. `edited_by` records
// who made the edit that replaced this version. Never blocks the save.
async function saveRevision(env, sess, type, row) {
  try {
    await ensureRevisionsTable(env);
    let by = null;
    try {
      const u = await env.DB.prepare('SELECT username FROM users WHERE id=?').bind(sess.userId).first();
      by = u ? u.username : null;
    } catch { /* non-fatal */ }
    await env.DB.prepare(
      'INSERT INTO revisions (entity_type, slug, name, status, data, edited_by) VALUES (?,?,?,?,?,?)'
    ).bind(type, row.slug, row.name || null, row.status || 'published', row.data, by).run();
    await env.DB.prepare(
      `DELETE FROM revisions WHERE entity_type=? AND slug=? AND id NOT IN (
         SELECT id FROM revisions WHERE entity_type=? AND slug=? ORDER BY id DESC LIMIT ${REVISIONS_KEEP})`
    ).bind(type, row.slug, type, row.slug).run();
  } catch { /* history must never break a write */ }
}

// ---- more lazily-created tables/columns (no manual migrations ever) ----
let _viewsReady = false;
async function ensureViewsTable(env) {
  if (_viewsReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS page_views (
       entity_type TEXT NOT NULL,
       slug        TEXT NOT NULL,
       day         TEXT NOT NULL,
       n           INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (entity_type, slug, day)
     )`
  ).run();
  _viewsReady = true;
}

let _messagesReady = false;
async function ensureMessagesTable(env) {
  if (_messagesReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS messages (
       id       INTEGER PRIMARY KEY AUTOINCREMENT,
       ts       TEXT NOT NULL DEFAULT (datetime('now')),
       user_id  INTEGER,
       username TEXT,
       category TEXT,
       body     TEXT NOT NULL,
       status   TEXT NOT NULL DEFAULT 'open'
     )`
  ).run();
  _messagesReady = true;
}

// ---- direct messages (user <-> user DMs, tables created lazily) ----
// `dms` is one row per message; a "conversation" is just every row between a
// pair of users. Each side can hide a conversation for themselves only
// (sender_deleted / recipient_deleted); rows hidden by BOTH sides are purged.
// `dm_blocks` stores per-user block lists (admins bypass blocks so the
// admin <-> user channel always works).
let _dmReady = false;
async function ensureDmTables(env) {
  if (_dmReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS dms (
       id                INTEGER PRIMARY KEY AUTOINCREMENT,
       ts                TEXT NOT NULL DEFAULT (datetime('now')),
       sender_id         INTEGER NOT NULL,
       recipient_id      INTEGER NOT NULL,
       body              TEXT NOT NULL,
       read_at           TEXT,
       sender_deleted    INTEGER NOT NULL DEFAULT 0,
       recipient_deleted INTEGER NOT NULL DEFAULT 0
     )`
  ).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_dms_recipient ON dms(recipient_id, id)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_dms_sender ON dms(sender_id, id)').run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS dm_blocks (
       user_id    INTEGER NOT NULL,
       blocked_id INTEGER NOT NULL,
       ts         TEXT NOT NULL DEFAULT (datetime('now')),
       PRIMARY KEY (user_id, blocked_id)
     )`
  ).run();
  // A report unlocks that one conversation for admin review — admins can
  // never read DMs that nobody reported.
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS dm_reports (
       id          INTEGER PRIMARY KEY AUTOINCREMENT,
       ts          TEXT NOT NULL DEFAULT (datetime('now')),
       reporter_id INTEGER NOT NULL,
       reported_id INTEGER NOT NULL,
       reason      TEXT,
       status      TEXT NOT NULL DEFAULT 'open'
     )`
  ).run();
  _dmReady = true;
}

async function findUserByUsername(env, username) {
  if (!username) return null;
  return env.DB.prepare(
    'SELECT id, username, display_name, avatar_url, is_admin FROM users WHERE lower(username)=lower(?)'
  ).bind(username).first().catch(() => null);
}

let _banReady = false;
async function ensureBanColumn(env) {
  if (_banReady) return;
  try {
    await env.DB.prepare('ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0').run();
  } catch { /* column already exists */ }
  _banReady = true;
}

// Fresh admin/ban flags from D1 — session cookies cache isAdmin for 30 days,
// but bans and demotions must apply immediately, not when the cookie expires.
async function getAccountFlags(env, userId) {
  try {
    return await env.DB.prepare('SELECT is_admin, banned FROM users WHERE id=?').bind(userId).first();
  } catch {
    // banned column not created yet
    const r = await env.DB.prepare('SELECT is_admin FROM users WHERE id=?').bind(userId).first().catch(() => null);
    return r ? { is_admin: r.is_admin, banned: 0 } : null;
  }
}

// Admin gate for GET endpoints: session must exist AND still be admin in D1.
async function adminSession(env, request) {
  const sess = await getSession(env, request);
  if (!sess || !sess.isAdmin) return null;
  const flags = await getAccountFlags(env, sess.userId);
  if (!flags || !flags.is_admin) return null;
  return sess;
}

// ---- per-page protection (admin page lock, stored in settings) ----
function protectKey(type, slug) { return 'protected:' + type + ':' + slug; }
async function isProtected(env, type, slug) {
  try {
    const r = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(protectKey(type, slug)).first();
    return !!r && r.value === '1';
  } catch { return false; }
}
const PROTECTED_MSG = 'This page has been protected by an admin and cannot be edited right now.';

// ---- page-view counter (analytics; bots filtered, 180-day retention) ----
const BOT_UA_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|discord|whatsapp|telegram|curl|wget|python|java|httpclient|headless|lighthouse|pingdom|uptime/i;
async function bumpView(env, request, type, slug) {
  try {
    const ua = request.headers.get('User-Agent') || '';
    if (!ua || BOT_UA_RE.test(ua)) return;
    await ensureViewsTable(env);
    await env.DB.prepare(
      `INSERT INTO page_views (entity_type, slug, day, n) VALUES (?,?,date('now'),1)
       ON CONFLICT(entity_type, slug, day) DO UPDATE SET n = n + 1`
    ).bind(type, slug).run();
  } catch { /* analytics must never break a page */ }
}

// ---- ownership: may this session edit this row? ----
function canEditRow(sess, row) {
  if (!sess) return false;
  if (sess.isAdmin) return true;
  return !!row.owner_id && row.owner_id === sess.userId;
}

async function getEntityRow(env, type, slug) {
  const t = CONTENT[type];
  if (!t || !slug) return null;
  return env.DB.prepare(
    `SELECT slug, ${t.nameCol} AS name, owner_id, status, data FROM ${t.table} WHERE slug=?`
  ).bind(slug).first().catch(() => null);
}

// ---- shared validation for script/collection page fields ----
// Caps text lengths, whitelists difficulty, constrains image paths to the
// scripts/ and collections/ R2 areas, and runs the theme through the shared
// sanitizer (hex colors, preset fonts, own -bg image slot only).
const PAGE_FIELD_CAPS = {
  name: 120, displayName: 120, author: 80, description: 2000, tagline: 140,
  version: 32, synopsis: 4000, gameplay: 4000, strategyGood: 2000, strategyEvil: 2000
};
const PAGE_IMG_RE = /^(scripts|collections)\/[a-z0-9._ -]+\.(png|jpe?g|webp)$/i;
function sanitizePageFields(o, themeBase) {
  for (const k of Object.keys(PAGE_FIELD_CAPS)) {
    if (o[k] != null) o[k] = String(o[k]).slice(0, PAGE_FIELD_CAPS[k]);
  }
  if (o.difficulty != null && !['', 'beginner', 'intermediate', 'veteran'].includes(o.difficulty)) {
    o.difficulty = '';
  }
  for (const k of ['header', 'logo']) {
    if (o[k] != null && !(typeof o[k] === 'string' && (o[k] === '' || PAGE_IMG_RE.test(o[k])))) {
      o[k] = '';
    }
  }
  const theme = PageRender.sanitizeTheme(o.theme, themeBase);
  if (theme) o.theme = theme; else delete o.theme;
}

// ---- build the three JSON files from D1 (published pages only) ----
async function buildPublicJSON(env, table) {
  let results;
  try {
    ({ results } = await env.DB.prepare(`SELECT data FROM ${table} WHERE status='published'`).all());
  } catch {
    // status column not migrated yet -> serve everything (legacy behaviour)
    ({ results } = await env.DB.prepare(`SELECT data FROM ${table}`).all());
  }
  return results.map(r => {
    const d = JSON.parse(r.data);
    // clean URLs: stored page paths end in .html, but the site serves them
    // extensionless now — strip it so every consumer links the clean form
    if (typeof d.page === 'string') d.page = d.page.replace(/\.html$/, '');
    return d;
  });
}

// ---- D1 -> R2 backup (nightly cron + POST /api/backup) ----
// Dumps every content table to backups/{YYYY-MM-DD}/{table}.json in the ART
// bucket. backups/ is not in R2_PREFIXES, so the files are never publicly
// servable through /assets/. Keeps 30 days of snapshots.
async function runBackup(env) {
  if (!env.ART) throw new Error('R2 bucket (ART binding) is not configured.');
  const stamp = new Date().toISOString().slice(0, 10);
  const tables = ['characters', 'collections', 'scripts', 'users', 'activity_log', 'settings', 'revisions', 'messages', 'page_views', 'dms', 'dm_blocks', 'dm_reports'];
  const saved = {};
  for (const t of tables) {
    try {
      const { results } = await env.DB.prepare(`SELECT * FROM ${t}`).all();
      await env.ART.put(`backups/${stamp}/${t}.json`, JSON.stringify(results), {
        httpMetadata: { contentType: 'application/json' }
      });
      saved[t] = results.length;
    } catch (e) {
      saved[t] = 'skipped (' + ((e && e.message) || 'error') + ')';
    }
  }
  const cutoff = Date.now() - 30 * 86400000;
  try {
    const listed = await env.ART.list({ prefix: 'backups/', limit: 1000 });
    for (const obj of listed.objects) {
      const m = obj.key.match(/^backups\/(\d{4}-\d{2}-\d{2})\//);
      if (m && Date.parse(m[1]) < cutoff) await env.ART.delete(obj.key);
    }
  } catch { /* pruning is best-effort */ }
  return { date: stamp, saved };
}

function jsonResponse(obj, extraHeaders = {}) {
  // `status` in the second argument sets the HTTP status; everything else
  // is a response header.
  const { status = 200, ...headers } = extraHeaders;
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...JSON_HEADERS, 'Cache-Control': 'no-store', ...headers }
  });
}

function redirectResponse(location, cookie) {
  const headers = new Headers({ Location: location });
  if (cookie) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 302, headers });
}

function attr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Shared HTML shell for every server-rendered page (/c/, /s/, /collection/).
// The topbar/nav markup mirrors the static pages (scripts.html is canonical).
function pageShell(o) {
  // o: {title, desc, canonicalUrl, ogImage, ogCard, body, bodyClass,
  //     bodyStyle, mainClass, mainStyle, bootstrap, scripts[], draftBanner}
  // The nav row is identical on every page (built into the shell below);
  // site.js appends Token Tool + the Account/Login button, and moves the
  // Edit button to the end of the row on editable pages.
  const bodyAttrs = (o.bodyClass ? ' class="' + attr(o.bodyClass) + '"' : '') +
    (o.bodyStyle ? ' style="' + attr(o.bodyStyle) + '"' : '');
  const mainAttrs = ' class="wrap' + (o.mainClass ? ' ' + attr(o.mainClass) : '') + '"' +
    (o.mainStyle ? ' style="' + attr(o.mainStyle) + '"' : '');
  return `<!DOCTYPE html>
<html lang="en" class="redesign-on">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${attr(o.title)} — BOTC HomeBrew Wiki</title>
<meta name="description" content="${attr(o.desc)}">
<link rel="canonical" href="${attr(o.canonicalUrl)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="BOTC HomeBrew Wiki">
<meta property="og:title" content="${attr(o.title)}">
<meta property="og:description" content="${attr(o.desc)}">
<meta property="og:image" content="${attr(o.ogImage)}">
<meta property="og:url" content="${attr(o.canonicalUrl)}">
<meta name="twitter:card" content="${attr(o.ogCard || 'summary')}">
<meta name="twitter:title" content="${attr(o.title)}">
<meta name="twitter:description" content="${attr(o.desc)}">
<meta name="twitter:image" content="${attr(o.ogImage)}">
<link rel="icon" type="image/png" sizes="64x64" href="../assets/favicon.png">
<link rel="apple-touch-icon" href="../assets/favicon.png">
<link rel="stylesheet" href="../assets/styles.css">
<link rel="stylesheet" href="../assets/header-redesign.css">
</head>
<body${bodyAttrs}>
${o.draftBanner || ''}
  <header class="topbar">
    <div class="brand-group">
      <a class="brand" href="../">
        <img class="brand-skull" src="../assets/logo_skull.png" alt="">
        <img class="brand-header-text" src="../assets/headertext.png" alt="BOTC HomeBrew Wiki">
      </a>
      <img class="topbar-badge" src="../assets/ccc-parchment.png" alt="Community Created Content">
      <a class="edit-link" id="edit-btn" style="display:none" href="#">&#9998; Edit</a>
    </div>
    <nav class="crumb" aria-label="Primary" id="crumb">
      <a href="../all-characters">All Characters</a>
      <a href="../scripts">Scripts</a>
      <a href="../tags">Tags</a>
      <a href="../creators">Creators</a>
      <a href="../script">Script Builder</a>
    </nav>
  <div class="search-wrap" id="search-wrap">
    <input class="search-input" id="search-input" type="search" placeholder="Search characters…" autocomplete="off" aria-label="Search characters" aria-expanded="false" aria-haspopup="listbox">
    <div class="search-drop" id="search-drop" role="listbox" aria-label="Search results" hidden></div>
  </div>
  <button class="hamburger" id="hamburger" aria-label="Navigation menu" aria-expanded="false">
    <span></span><span></span><span></span>
  </button>
</header>
<nav class="nav-dropdown" id="nav-dropdown" aria-label="Mobile navigation">
  <div class="nav-dropdown-search">
    <input type="search" id="nav-search-input" placeholder="Search characters…" autocomplete="off">
  </div>
  <a href="../">Home</a>
  <a href="../all-characters">All Characters</a>
  <a href="../scripts">Scripts</a>
  <a href="../tags">Tags</a>
  <a href="../creators">Creators</a>
  <a href="../script">Script Builder</a>
</nav>

  <main${mainAttrs} id="content">${o.body}</main>

  <p class="foot">Fan-made content for <em>Blood on the Clocktower</em> &middot; Not affiliated with The Pandemonium Institute</p>

  <script>${o.bootstrap || ''}</script>
${(o.scripts || []).map(s => '  <script src="../assets/' + s + '"></script>').join('\n')}
</body>
</html>`;
}

function renderCharacterPage(d, origin, isDraft) {
  const name = d.name || 'Character';
  const desc = (d.ability || d.lede || '').trim();
  const pageUrl = origin + '/c/' + d.slug;
  const imgRaw = Array.isArray(d.image) ? d.image[0] : d.image;
  const img = imgRaw || (origin + '/assets/' + (d.art || ''));
  // bulk-imported characters may only have a remote image URL, no local art
  const artSrc = d.art ? '../assets/' + d.art : (imgRaw || '');
  const body = Render.renderCharacter(d, artSrc, '../');
  const draftBanner = isDraft
    ? '<div style="background:#7a5c18;color:#f7ecd0;text-align:center;padding:10px 16px;font-family:\'TradeGothicLT\',\'Libre Franklin\',sans-serif;letter-spacing:.04em">DRAFT — only you (and admins) can see this page. Publish it from your <a href="../account" style="color:#ffe9ad">account page</a> or the editor.</div>'
    : '';
  return pageShell({
    title: name, desc, canonicalUrl: pageUrl, ogImage: img, ogCard: 'summary',
    body, draftBanner,
    bootstrap: `window.SSR = true; window.LINK_ROOT = '../'; window.CHAR_SLUG = ${JSON.stringify(d.slug)};`,
    scripts: ['render.js', 'tags.js', 'charpage.js', 'site.js']
  });
}

// ---- official BotC roles (assets/roles.json), for script rosters that
// include imported official characters ('off-' slugs). Cached per isolate.
let _officialRolesCache = null;
async function loadOfficialRoles(env, origin) {
  if (_officialRolesCache) return _officialRolesCache;
  try {
    const res = await env.ASSETS.fetch(new Request(origin + '/assets/roles.json'));
    const roles = await res.json();
    _officialRolesCache = (roles || []).filter(r => r && r.id).map(r => ({
      slug: 'off-' + String(r.id).toLowerCase().replace(/[^a-z0-9]/g, ''),
      official: true, id: r.id,
      name: r.name || r.id, team: r.team || '',
      ability: r.ability || '', image: r.image || '',
      page: 'https://wiki.bloodontheclocktower.com/' + encodeURIComponent(String(r.name || r.id).replace(/ /g, '_'))
    }));
  } catch {
    _officialRolesCache = [];
  }
  return _officialRolesCache;
}

// Map of slugId(id/name) -> official icon URL, so /c/ jinx icons for official
// characters use the same release-CDN art as the Token Tool. Cached per isolate.
let _officialIconMapCache = null;
async function officialIconMap(env, origin) {
  if (_officialIconMapCache) return _officialIconMapCache;
  const m = {};
  for (const r of await loadOfficialRoles(env, origin)) {
    if (r.image && /^https?:\/\//.test(r.image)) {
      m[Render.slugId(r.id)] = r.image;
      if (r.name) m[Render.slugId(r.name)] = r.image;
    }
  }
  _officialIconMapCache = m;
  return m;
}

// ---- shared SSR for /s/{slug} and /collection/{id} pages ----
async function renderContentPage(env, ctx, request, url, type, slug) {
  const isScript = type === 'script';
  const table = isScript ? 'scripts' : 'collections';
  let row = null;
  try {
    row = await env.DB.prepare(`SELECT slug, data, status, owner_id FROM ${table} WHERE slug=?`)
      .bind(slug).first();
  } catch {
    row = await env.DB.prepare(`SELECT slug, data FROM ${table} WHERE slug=?`).bind(slug).first();
  }
  if (!isScript && !row) row = await findCollectionRow(env, slug);
  if (!row || !row.data) return env.ASSETS.fetch(request);

  // Soft-deleted pages are hidden from everyone; recovery is on the dashboard.
  if (row.status === 'deleted') return env.ASSETS.fetch(request);

  const isDraft = row.status === 'draft';
  if (isDraft) {
    const sess = await getSession(env, request);
    if (!canEditRow(sess, row)) return env.ASSETS.fetch(request); // 404 for everyone else
  }
  if (!isDraft && ctx) ctx.waitUntil(bumpView(env, request, type, row.slug || slug));
  const d = JSON.parse(row.data);
  if (!d.slug) d.slug = row.slug || slug;

  let chars = await buildPublicJSON(env, 'characters');
  // Scripts can carry imported official roles ('off-' slugs) — resolve them
  if (isScript && (d.characters || []).some(s => String(s).indexOf('off-') === 0)) {
    chars = chars.concat(await loadOfficialRoles(env, url.origin));
  }

  const themeBase = isScript ? ('scripts/' + d.slug) : ('collections/' + (d.id || d.slug));
  const theme = PageRender.sanitizeTheme(d.theme, themeBase);
  const ta = PageRender.themeAttrs(theme, '../');

  const name = (isScript ? d.name : (d.displayName || d.slug)) || 'Untitled';
  const body = isScript
    ? PageRender.renderScriptPage(d, chars, { linkRoot: '../', isDraft })
    : PageRender.renderCollectionPage(d, chars, { linkRoot: '../', isDraft });

  const nChars = isScript
    ? (d.characters || []).length
    : PageRender.resolveCollectionMembers(d, chars).length;
  const desc = (d.tagline || '').trim() || (d.description || '').trim() ||
    (nChars + '-character homebrew ' + (isScript ? 'script' : 'collection') +
     ' for Blood on the Clocktower' + (d.author ? ', by ' + d.author : '') + '.');
  const canonical = url.origin + (isScript ? '/s/' : '/collection/') + encodeURIComponent(isScript ? d.slug : (d.id || d.slug));
  const img = url.origin + '/assets/' + (d.header || d.logo || 'logo_skull.png');
  const editHref = isScript
    ? '../publish-script?s=' + encodeURIComponent(d.slug)
    : '../publish-collection?c=' + encodeURIComponent(d.id || d.slug);
  const draftBanner = isDraft
    ? '<div style="background:#7a5c18;color:#f7ecd0;text-align:center;padding:10px 16px;font-family:\'TradeGothicLT\',\'Libre Franklin\',sans-serif;letter-spacing:.04em">DRAFT — only you (and admins) can see this page. Publish it from <a href="' + attr(editHref) + '" style="color:#ffe9ad">the editor</a> or <a href="../account" style="color:#ffe9ad">your account</a>.</div>'
    : '';

  const html = pageShell({
    title: (isDraft ? 'Draft: ' : '') + name, desc, canonicalUrl: canonical,
    ogImage: img, ogCard: d.header ? 'summary_large_image' : 'summary',
    body, draftBanner,
    bodyClass: ta.cls, bodyStyle: ta.style,
    bootstrap: `window.SSR = true; window.LINK_ROOT = '../'; window.PAGE_TYPE = ${JSON.stringify(type)}; window.PAGE_SLUG = ${JSON.stringify(isScript ? d.slug : (d.id || d.slug))};`,
    scripts: isScript
      ? ['render.js', 'pageview.js', 'site.js']
      : ['render.js', 'pageview.js', 'collection-filters.js', 'site.js']
  });
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

// Collections: legacy rows have a display-string PK slug (e.g. "The Academy")
// while URLs use the kebab id from the JSON ("the-academy"). Resolve by PK
// first, then by data.id, then by normalized slug/displayName.
async function findCollectionRow(env, key) {
  if (!key) return null;
  let hit = await env.DB.prepare(
    'SELECT slug, display_name AS name, owner_id, status, data FROM collections WHERE slug=?'
  ).bind(key).first().catch(() => null);
  if (hit) return hit;
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const nkey = norm(key);
  const { results } = await env.DB.prepare(
    'SELECT slug, display_name AS name, owner_id, status, data FROM collections'
  ).all().catch(() => ({ results: [] }));
  for (const row of results || []) {
    try {
      const d = JSON.parse(row.data);
      if (d.id === key || norm(d.id) === nkey || norm(row.slug) === nkey || norm(d.displayName) === nkey) return row;
    } catch { /* skip bad rows */ }
  }
  return null;
}

// ---- Discord OAuth helpers ----
function discordConfigured(env) {
  return !!(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET);
}
function discordRedirectUri(origin) {
  return origin + '/api/auth/discord/callback';
}

// Pick a free username derived from the Discord name.
async function uniqueUsername(env, base) {
  let stem = String(base || 'user').toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 16);
  if (stem.length < 3) stem = ('user-' + (stem || '')).slice(0, 16).replace(/[-_]+$/, '');
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? stem : stem + '-' + (i + 1);
    const hit = await env.DB.prepare('SELECT 1 FROM users WHERE lower(username)=lower(?)')
      .bind(candidate).first();
    if (!hit) return candidate;
  }
  return stem + '-' + Date.now();
}

function loginErrorRedirect(origin, msg) {
  return redirectResponse(origin + '/login?error=' + encodeURIComponent(msg));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // ---------- DATA ENDPOINTS (replace static JSON files) ----------
    if (method === 'GET' && path === '/characters.json') {
      return jsonResponse(await buildPublicJSON(env, 'characters'));
    }
    if (method === 'GET' && path === '/collections.json') {
      return jsonResponse(await buildPublicJSON(env, 'collections'));
    }
    if (method === 'GET' && path === '/scripts.json') {
      return jsonResponse(await buildPublicJSON(env, 'scripts'));
    }

    // ---------- SITE-WIDE ANNOUNCEMENT (public; site.js shows the banner) ----------
    if (method === 'GET' && path === '/api/announcement') {
      let ann = null;
      try {
        const r = await env.DB.prepare("SELECT value FROM settings WHERE key='announcement'").first();
        if (r && r.value) ann = JSON.parse(r.value);
      } catch { /* no announcement */ }
      return jsonResponse({ announcement: ann && ann.text ? ann : null });
    }

    // ---------- CHARACTER PAGES (server-side rendered from D1) ----------
    if (method === 'GET' && path.startsWith('/c/')) {
      let slug = decodeURIComponent(path.slice(3));
      // clean URLs: the .html form permanently redirects to the extensionless one
      if (slug.endsWith('.html')) {
        slug = slug.slice(0, -5);
        return new Response(null, {
          status: 301,
          headers: { Location: url.origin + '/c/' + slug + url.search, 'Cache-Control': 'no-store' }
        });
      }
      if (slug && /^[a-z0-9-]+$/i.test(slug)) {
        let row = null;
        try {
          row = await env.DB.prepare('SELECT data, status, owner_id FROM characters WHERE slug = ?')
            .bind(slug).first();
        } catch {
          row = await env.DB.prepare('SELECT data FROM characters WHERE slug = ?')
            .bind(slug).first();
        }
        if (row && row.data) {
          // Soft-deleted pages are hidden from everyone (incl. owner/admin);
          // recovery happens on the admin dashboard, not the live page.
          if (row.status === 'deleted') return env.ASSETS.fetch(request);
          const isDraft = row.status === 'draft';
          if (isDraft) {
            const sess = await getSession(env, request);
            if (!canEditRow(sess, row)) return env.ASSETS.fetch(request); // 404 for everyone else
          }
          const d = JSON.parse(row.data);
          if (!d.slug) d.slug = slug;
          if (!isDraft) ctx.waitUntil(bumpView(env, request, 'character', slug));
          Render.setOfficialIconUrls(await officialIconMap(env, url.origin));
          return new Response(renderCharacterPage(d, url.origin, isDraft), {
            headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
          });
        }
      }
      // Unknown slug -> fall back to a committed static page (if any), else 404.
      return env.ASSETS.fetch(request);
    }

    // ---------- SCRIPT PAGES (server-side rendered from D1) ----------
    if (method === 'GET' && path.startsWith('/s/')) {
      let slug = decodeURIComponent(path.slice(3));
      if (slug.endsWith('.html')) {
        slug = slug.slice(0, -5);
        return new Response(null, {
          status: 301,
          headers: { Location: url.origin + '/s/' + slug + url.search, 'Cache-Control': 'no-store' }
        });
      }
      if (slug && /^[a-z0-9-]+$/i.test(slug)) {
        return renderContentPage(env, ctx, request, url, 'script', slug);
      }
      return env.ASSETS.fetch(request);
    }

    // ---------- COLLECTION PAGES (server-side rendered from D1) ----------
    if (method === 'GET' && path.startsWith('/collection/')) {
      let key = decodeURIComponent(path.slice('/collection/'.length));
      if (key.endsWith('.html')) {
        key = key.slice(0, -5);
        return new Response(null, {
          status: 301,
          headers: { Location: url.origin + '/collection/' + encodeURIComponent(key) + url.search, 'Cache-Control': 'no-store' }
        });
      }
      if (key) {
        return renderContentPage(env, ctx, request, url, 'collection', key);
      }
      return env.ASSETS.fetch(request);
    }

    // ---------- IMAGE ASSETS (served from R2, fall back to static) ----------
    if (method === 'GET' && path.startsWith('/assets/')) {
      const key = path.slice('/assets/'.length);
      if (env.ART && R2_SERVE_PREFIXES.some(p => key.startsWith(p))) {
        const obj = await env.ART.get(key);
        if (obj) {
          const headers = new Headers();
          obj.writeHttpMetadata(headers);
          const ext = key.split('.').pop().toLowerCase();
          if (!headers.has('Content-Type') && EXT_CONTENT_TYPE[ext]) {
            headers.set('Content-Type', EXT_CONTENT_TYPE[ext]);
          }
          headers.set('Cache-Control', 'no-cache, must-revalidate');
          if (obj.httpEtag) headers.set('ETag', obj.httpEtag);
          return new Response(obj.body, { headers });
        }
      }
      return env.ASSETS.fetch(request); // not in R2 -> committed static file
    }

    // ---------- RANDOM CHARACTER (302 to a random published page) ----------
    if (method === 'GET' && path === '/random') {
      let row;
      try {
        row = await env.DB.prepare(
          "SELECT slug FROM characters WHERE status='published' ORDER BY RANDOM() LIMIT 1"
        ).first();
      } catch {
        row = await env.DB.prepare(
          'SELECT slug FROM characters ORDER BY RANDOM() LIMIT 1'
        ).first();
      }
      const dest = row ? '/c/' + row.slug : '/all-characters';
      return new Response(null, {
        status: 302,
        headers: { Location: url.origin + dest, 'Cache-Control': 'no-store' }
      });
    }

    // ---------- PUBLIC PROFILE PAGE (/u/{username} serves profile.html) ----------
    if (method === 'GET' && path.startsWith('/u/')) {
      const res = await env.ASSETS.fetch(new Request(url.origin + '/profile.html'));
      return new Response(res.body, {
        status: res.status,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' }
      });
    }

    // ---------- PUBLIC PROFILE DATA ----------
    if (method === 'GET' && path === '/api/user') {
      const uname = (url.searchParams.get('u') || '').trim();
      if (!uname) return jsonResponse({ error: 'Missing username' }, { status: 400 });
      const u = await env.DB.prepare(
        'SELECT id, username, display_name, bio, avatar_url, created_at FROM users WHERE lower(username)=lower(?)'
      ).bind(uname).first();
      if (!u) return jsonResponse({ error: 'No such user' }, { status: 404 });
      async function ownedPublished(table) {
        let results;
        try {
          ({ results } = await env.DB.prepare(
            `SELECT data FROM ${table} WHERE owner_id=? AND status='published' ORDER BY updated_at DESC`
          ).bind(u.id).all());
        } catch {
          ({ results } = await env.DB.prepare(
            `SELECT data FROM ${table} WHERE owner_id=?`
          ).bind(u.id).all());
        }
        return results.map(r => JSON.parse(r.data));
      }
      const [characters, collections, scripts] = await Promise.all([
        ownedPublished('characters'), ownedPublished('collections'), ownedPublished('scripts')
      ]);
      return jsonResponse({
        profile: {
          username: u.username,
          displayName: u.display_name || u.username,
          bio: u.bio || '',
          avatarUrl: u.avatar_url || null,
          joined: u.created_at
        },
        characters, collections, scripts
      });
    }

    // ---------- SITEMAP (built live from D1) ----------
    if (method === 'GET' && path === '/sitemap.xml') {
      const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      async function pub(table) {
        try {
          return (await env.DB.prepare(`SELECT slug, updated_at FROM ${table} WHERE status='published'`).all()).results;
        } catch {
          return (await env.DB.prepare(`SELECT slug, updated_at FROM ${table}`).all()).results;
        }
      }
      async function pubCollections() {
        try {
          return (await env.DB.prepare(`SELECT slug, data, updated_at FROM collections WHERE status='published'`).all()).results;
        } catch {
          return (await env.DB.prepare(`SELECT slug, data, updated_at FROM collections`).all()).results;
        }
      }
      const [chars, scripts, colls] = await Promise.all([pub('characters'), pub('scripts'), pubCollections()]);
      const staticPages = ['', 'all-characters', 'scripts', 'tags', 'creators',
        'authors', 'script', 'tokens', 'mass-upload', 'steven-approved-order'];
      const urls = staticPages.map(p => '<url><loc>' + xmlEsc(url.origin + '/' + p) + '</loc></url>');
      const lastmod = r => r.updated_at ? '<lastmod>' + xmlEsc(String(r.updated_at).slice(0, 10)) + '</lastmod>' : '';
      for (const r of chars) {
        urls.push('<url><loc>' + xmlEsc(url.origin + '/c/' + r.slug) + '</loc>' + lastmod(r) + '</url>');
      }
      for (const r of scripts) {
        urls.push('<url><loc>' + xmlEsc(url.origin + '/s/' + encodeURIComponent(r.slug)) + '</loc>' + lastmod(r) + '</url>');
      }
      for (const r of colls) {
        let id = '';
        try { id = JSON.parse(r.data).id || ''; } catch { /* fall back to slug */ }
        urls.push('<url><loc>' + xmlEsc(url.origin + '/collection/' + encodeURIComponent(id || r.slug)) + '</loc>' + lastmod(r) + '</url>');
      }
      const body = '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        urls.join('\n') + '\n</urlset>';
      return new Response(body, {
        headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }
      });
    }

    // ---------- SCRIPT VIEW (legacy URLs redirect to the SSR /s/ pages) ----------
    if (method === 'GET' && (path === '/script-view.html' || path === '/script-view')) {
      const slug = url.searchParams.get('s');
      if (slug && /^[a-z0-9-]+$/i.test(slug)) {
        return new Response(null, {
          status: 301,
          headers: { Location: url.origin + '/s/' + encodeURIComponent(slug), 'Cache-Control': 'no-store' }
        });
      }
      return new Response(null, {
        status: 302,
        headers: { Location: url.origin + '/scripts', 'Cache-Control': 'no-store' }
      });
    }

    // ---------- AUTH: SIGN UP ----------
    if (method === 'POST' && path === '/api/signup') {
      if (await rateLimited(env, request, 'signup', 5, 3600)) {
        return jsonResponse({ error: 'Too many signups from this connection. Try again later.' }, { status: 429 });
      }
      const body = await request.json().catch(() => ({}));
      const username = String(body.username || '').trim();
      const email = String(body.email || '').trim();
      const password = String(body.password || '');
      const bad = validSignup(username, email, password);
      if (bad) return jsonResponse({ error: bad }, { status: 400 });

      const nameTaken = await env.DB.prepare('SELECT 1 FROM users WHERE lower(username)=lower(?)')
        .bind(username).first();
      if (nameTaken) return jsonResponse({ error: 'That username is already taken.' }, { status: 409 });
      const emailTaken = await env.DB.prepare('SELECT 1 FROM users WHERE email IS NOT NULL AND lower(email)=lower(?)')
        .bind(email).first();
      if (emailTaken) return jsonResponse({ error: 'An account with that email already exists. Try logging in or resetting your password.' }, { status: 409 });

      const hash = await hashPassword(password);
      const res = await env.DB.prepare(
        `INSERT INTO users (username, password_hash, email, is_admin, last_login)
         VALUES (?,?,?,0,datetime('now'))`
      ).bind(username, hash, email).run();
      const userId = res.meta.last_row_id;

      const token = await createSession(env, userId, false);
      await logActivity(env, { userId }, 'signup', 'user', null, username);
      // Best-effort verification email; signup succeeds either way.
      ctx.waitUntil(sendVerificationEmail(env, url.origin, { id: userId, username, email }));
      return jsonResponse({ ok: true, username }, { 'Set-Cookie': sessionCookie(token) });
    }

    // ---------- AUTH: LOG IN ----------
    if (method === 'POST' && path === '/api/login') {
      if (await rateLimited(env, request, 'login', 10, 600)) {
        return jsonResponse({ error: 'Too many login attempts. Wait a few minutes and try again.' }, { status: 429 });
      }
      const body = await request.json().catch(() => ({}));
      const identifier = String(body.username || body.email || '').trim();
      const password = String(body.password || '');
      if (!identifier || !password) return jsonResponse({ error: 'Missing credentials' }, { status: 400 });
      const user = await findUserByLogin(env, identifier);
      if (!user) return jsonResponse({ error: 'Invalid login' }, { status: 401 });
      const ok = await verifyPassword(password, user.password_hash);
      if (!ok) {
        if (!user.password_hash && user.discord_id) {
          return jsonResponse({ error: 'This account signs in with Discord. Use the Discord button (you can set a password afterwards on your account page).' }, { status: 401 });
        }
        return jsonResponse({ error: 'Invalid login' }, { status: 401 });
      }
      if (user.banned) {
        return jsonResponse({ error: 'This account has been suspended. Contact the admins if you think this is a mistake.' }, { status: 403 });
      }
      const token = await createSession(env, user.id, !!user.is_admin);
      ctx.waitUntil(env.DB.prepare("UPDATE users SET last_login=datetime('now') WHERE id=?").bind(user.id).run());
      return jsonResponse({ ok: true, isAdmin: !!user.is_admin, username: user.username }, { 'Set-Cookie': sessionCookie(token) });
    }

    if (method === 'POST' && path === '/api/logout') {
      const sess = await getSession(env, request);
      if (sess) await env.SESSIONS.delete('sess:' + sess.token);
      return jsonResponse({ ok: true }, { 'Set-Cookie': clearCookie() });
    }

    if (method === 'GET' && path === '/api/me') {
      const sess = await getSession(env, request);
      if (!sess) return jsonResponse({ loggedIn: false, isAdmin: false });
      const u = await env.DB.prepare(
        `SELECT username, email, is_admin, display_name, avatar_url, email_verified, discord_id, password_hash
         FROM users WHERE id=?`
      ).bind(sess.userId).first().catch(() => null);
      if (!u) return jsonResponse({ loggedIn: false, isAdmin: false }, { 'Set-Cookie': clearCookie() });
      // Unread DM count (dms table may not exist until the first message)
      let unreadMessages = 0;
      try {
        const r = await env.DB.prepare(
          'SELECT COUNT(*) AS n FROM dms WHERE recipient_id=? AND read_at IS NULL AND recipient_deleted=0'
        ).bind(sess.userId).first();
        unreadMessages = r ? r.n : 0;
      } catch { /* no DMs yet */ }
      return jsonResponse({
        loggedIn: true,
        isAdmin: !!u.is_admin,
        username: u.username,
        displayName: u.display_name || u.username,
        avatarUrl: u.avatar_url || null,
        email: u.email || null,
        emailVerified: !!u.email_verified,
        discordLinked: !!u.discord_id,
        hasPassword: !!u.password_hash,
        unreadMessages
      });
    }

    // ---------- AUTH: FORGOT / RESET PASSWORD ----------
    if (method === 'POST' && path === '/api/forgot-password') {
      if (await rateLimited(env, request, 'forgot', 5, 3600)) {
        return jsonResponse({ error: 'Too many reset requests. Try again later.' }, { status: 429 });
      }
      const body = await request.json().catch(() => ({}));
      const identifier = String(body.email || body.username || '').trim();
      if (!identifier) return jsonResponse({ error: 'Enter your email or username.' }, { status: 400 });
      if (!env.RESEND_API_KEY) {
        return jsonResponse({ error: 'Password reset email is not configured on this server yet. Contact an admin.' }, { status: 501 });
      }
      const user = await findUserByLogin(env, identifier);
      // Always report success so account existence can't be probed.
      if (user && user.email) {
        const token = randomToken();
        await env.SESSIONS.put('pwreset:' + token, String(user.id), { expirationTtl: 3600 });
        const link = url.origin + '/reset-password?token=' + token;
        ctx.waitUntil(sendEmail(env, user.email, 'Reset your password — ' + APP_NAME, emailShell(
          'Reset your password',
          `<p>Hi ${escapeHtml(user.display_name || user.username)},</p>
           <p>Someone (hopefully you) asked to reset the password for your ${APP_NAME} account.</p>
           <p><a href="${link}" style="color:#5b1f21;font-weight:bold">Choose a new password</a></p>
           <p>This link expires in 1 hour and can be used once.</p>`
        )));
      }
      return jsonResponse({ ok: true, message: 'If that account exists, a reset link is on its way to its email address.' });
    }

    if (method === 'POST' && path === '/api/reset-password') {
      const body = await request.json().catch(() => ({}));
      const token = String(body.token || '');
      const password = String(body.password || '');
      if (!token) return jsonResponse({ error: 'Missing reset token.' }, { status: 400 });
      if (!password || password.length < 8) return jsonResponse({ error: 'Password must be at least 8 characters.' }, { status: 400 });
      const userId = await env.SESSIONS.get('pwreset:' + token);
      if (!userId) return jsonResponse({ error: 'That reset link is invalid or has expired. Request a new one.' }, { status: 400 });
      const hash = await hashPassword(password);
      await env.DB.prepare('UPDATE users SET password_hash=? WHERE id=?').bind(hash, userId).run();
      await env.SESSIONS.delete('pwreset:' + token);
      // Log them straight in for convenience.
      const u = await env.DB.prepare('SELECT id, is_admin FROM users WHERE id=?').bind(userId).first();
      const sessTok = await createSession(env, u.id, !!u.is_admin);
      return jsonResponse({ ok: true }, { 'Set-Cookie': sessionCookie(sessTok) });
    }

    // ---------- AUTH: EMAIL VERIFICATION ----------
    if (method === 'GET' && path === '/api/verify-email') {
      const token = url.searchParams.get('token') || '';
      const userId = token && await env.SESSIONS.get('verify:' + token);
      if (!userId) return redirectResponse(url.origin + '/account?verified=0');
      await env.DB.prepare('UPDATE users SET email_verified=1 WHERE id=?').bind(userId).run();
      await env.SESSIONS.delete('verify:' + token);
      return redirectResponse(url.origin + '/account?verified=1');
    }

    if (method === 'POST' && path === '/api/resend-verification') {
      const sess = await getSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not logged in' }, { status: 401 });
      if (await rateLimited(env, request, 'verify', 3, 3600)) {
        return jsonResponse({ error: 'Too many verification emails requested. Try again later.' }, { status: 429 });
      }
      const u = await env.DB.prepare('SELECT id, username, display_name, email, email_verified FROM users WHERE id=?')
        .bind(sess.userId).first();
      if (!u || !u.email) return jsonResponse({ error: 'No email on this account.' }, { status: 400 });
      if (u.email_verified) return jsonResponse({ ok: true, message: 'Email is already verified.' });
      const sent = await sendVerificationEmail(env, url.origin, u);
      if (!sent.ok) return jsonResponse({ error: sent.error }, { status: 502 });
      return jsonResponse({ ok: true, message: 'Verification email sent.' });
    }

    // ---------- AUTH: DISCORD OAUTH ----------
    if (method === 'GET' && path === '/api/auth/discord') {
      if (!discordConfigured(env)) return loginErrorRedirect(url.origin, 'Discord sign-in is not configured on this server yet.');
      const state = randomToken();
      let linkUserId = 0;
      if (url.searchParams.get('link') === '1') {
        const sess = await getSession(env, request);
        if (!sess) return loginErrorRedirect(url.origin, 'Log in first, then link Discord from your account page.');
        linkUserId = sess.userId;
      }
      await env.SESSIONS.put('oauth:' + state, JSON.stringify({ link: linkUserId }), { expirationTtl: 600 });
      const auth = new URL('https://discord.com/oauth2/authorize');
      auth.searchParams.set('client_id', env.DISCORD_CLIENT_ID);
      auth.searchParams.set('response_type', 'code');
      auth.searchParams.set('redirect_uri', discordRedirectUri(url.origin));
      auth.searchParams.set('scope', 'identify email');
      auth.searchParams.set('state', state);
      auth.searchParams.set('prompt', 'none');
      return redirectResponse(auth.toString());
    }

    if (method === 'GET' && path === '/api/auth/discord/callback') {
      if (!discordConfigured(env)) return loginErrorRedirect(url.origin, 'Discord sign-in is not configured.');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state') || '';
      const stateRaw = state && await env.SESSIONS.get('oauth:' + state);
      if (!code || !stateRaw) return loginErrorRedirect(url.origin, 'Discord sign-in failed (state mismatch). Please try again.');
      await env.SESSIONS.delete('oauth:' + state);
      let linkUserId = 0;
      try { linkUserId = (JSON.parse(stateRaw).link | 0); } catch {}

      // Exchange the code for a token.
      const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.DISCORD_CLIENT_ID,
          client_secret: env.DISCORD_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
          redirect_uri: discordRedirectUri(url.origin)
        })
      });
      if (!tokenRes.ok) return loginErrorRedirect(url.origin, 'Discord sign-in failed (token exchange). Please try again.');
      const tok = await tokenRes.json();

      const userRes = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: 'Bearer ' + tok.access_token }
      });
      if (!userRes.ok) return loginErrorRedirect(url.origin, 'Discord sign-in failed (profile fetch). Please try again.');
      const du = await userRes.json();
      const discordId = String(du.id);
      const discordName = du.global_name || du.username || 'user';
      const avatarUrl = du.avatar
        ? `https://cdn.discordapp.com/avatars/${discordId}/${du.avatar}.png?size=128`
        : null;
      const discordEmail = (du.email && du.verified) ? String(du.email) : null;

      const byDiscord = await env.DB.prepare('SELECT * FROM users WHERE discord_id=?').bind(discordId).first();

      // Link mode: attach this Discord identity to the logged-in account.
      if (linkUserId) {
        if (byDiscord && byDiscord.id !== linkUserId) {
          return redirectResponse(url.origin + '/account?error=' + encodeURIComponent('That Discord account is already linked to a different wiki account.'));
        }
        await env.DB.prepare(
          `UPDATE users SET discord_id=?, discord_username=?, avatar_url=COALESCE(avatar_url, ?) WHERE id=?`
        ).bind(discordId, du.username || discordName, avatarUrl, linkUserId).run();
        return redirectResponse(url.origin + '/account?linked=1');
      }

      // Existing Discord-linked account -> log in. A picture the user set on
      // the wiki wins over the Discord one, so logging in never clobbers it.
      if (byDiscord) {
        if (byDiscord.banned) return loginErrorRedirect(url.origin, 'This account has been suspended.');
        await env.DB.prepare(
          `UPDATE users SET discord_username=?, avatar_url=COALESCE(avatar_url, ?), last_login=datetime('now') WHERE id=?`
        ).bind(du.username || discordName, avatarUrl, byDiscord.id).run();
        const t = await createSession(env, byDiscord.id, !!byDiscord.is_admin);
        return redirectResponse(url.origin + '/account', sessionCookie(t));
      }

      // Same verified email already on a verified account -> link + log in.
      if (discordEmail) {
        const byEmail = await env.DB.prepare(
          'SELECT * FROM users WHERE email IS NOT NULL AND lower(email)=lower(?)'
        ).bind(discordEmail).first();
        if (byEmail) {
          if (byEmail.banned) return loginErrorRedirect(url.origin, 'This account has been suspended.');
          if (!byEmail.email_verified) {
            return loginErrorRedirect(url.origin, 'An account with your Discord email already exists but its email is unverified. Log in with your password, verify your email, then link Discord from your account page.');
          }
          await env.DB.prepare(
            `UPDATE users SET discord_id=?, discord_username=?, avatar_url=COALESCE(avatar_url, ?), last_login=datetime('now') WHERE id=?`
          ).bind(discordId, du.username || discordName, avatarUrl, byEmail.id).run();
          const t = await createSession(env, byEmail.id, !!byEmail.is_admin);
          return redirectResponse(url.origin + '/account?linked=1', sessionCookie(t));
        }
      }

      // Brand-new account from Discord. No password yet ('' = Discord-only).
      const username = await uniqueUsername(env, discordName);
      const ins = await env.DB.prepare(
        `INSERT INTO users (username, password_hash, email, is_admin, display_name, discord_id, discord_username, avatar_url, email_verified, last_login)
         VALUES (?, '', ?, 0, ?, ?, ?, ?, ?, datetime('now'))`
      ).bind(username, discordEmail, discordName, discordId, du.username || discordName, avatarUrl, discordEmail ? 1 : 0).run();
      const newId = ins.meta.last_row_id;
      await logActivity(env, { userId: newId }, 'signup', 'user', null, username);
      const t = await createSession(env, newId, false);
      return redirectResponse(url.origin + '/account?welcome=1', sessionCookie(t));
    }

    // ---------- YOUR OWN MESSAGES TO THE ADMINS ----------
    if (method === 'GET' && path === '/api/contact') {
      const sess = await getSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not logged in' }, { status: 401 });
      await ensureMessagesTable(env);
      const { results } = await env.DB.prepare(
        'SELECT id, ts, category, body, status FROM messages WHERE user_id=? ORDER BY id DESC LIMIT 20'
      ).bind(sess.userId).all();
      return jsonResponse({ messages: results || [] });
    }

    // ---------- DIRECT MESSAGES: CONVERSATION LIST ----------
    if (method === 'GET' && path === '/api/messages') {
      const sess = await getSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not logged in' }, { status: 401 });
      await ensureDmTables(env);
      const me = sess.userId;
      // One row per conversation partner: newest message id + my unread count.
      const { results: convs } = await env.DB.prepare(
        `SELECT partner, MAX(id) AS last_id, SUM(unread) AS unread FROM (
           SELECT CASE WHEN sender_id=?1 THEN recipient_id ELSE sender_id END AS partner,
                  id,
                  CASE WHEN recipient_id=?1 AND read_at IS NULL THEN 1 ELSE 0 END AS unread
           FROM dms
           WHERE (sender_id=?1 AND sender_deleted=0) OR (recipient_id=?1 AND recipient_deleted=0)
         ) GROUP BY partner ORDER BY last_id DESC LIMIT 100`
      ).bind(me).all();
      const list = convs || [];
      const lastById = {}, userById = {};
      if (list.length) {
        const marks = ids => ids.map(() => '?').join(',');
        const lastIds = list.map(c => c.last_id);
        const partnerIds = list.map(c => c.partner);
        const [lasts, users] = await Promise.all([
          env.DB.prepare(`SELECT id, ts, sender_id, body FROM dms WHERE id IN (${marks(lastIds)})`).bind(...lastIds).all(),
          env.DB.prepare(`SELECT id, username, display_name, avatar_url, is_admin FROM users WHERE id IN (${marks(partnerIds)})`).bind(...partnerIds).all()
        ]);
        for (const r of lasts.results || []) lastById[r.id] = r;
        for (const r of users.results || []) userById[r.id] = r;
      }
      let unreadTotal = 0;
      const conversations = list.map(c => {
        const u = userById[c.partner];
        if (!u) return null; // partner account was deleted
        const last = lastById[c.last_id] || {};
        unreadTotal += c.unread || 0;
        return {
          username: u.username,
          displayName: u.display_name || u.username,
          avatarUrl: u.avatar_url || null,
          isAdmin: !!u.is_admin,
          unread: c.unread || 0,
          lastTs: last.ts || null,
          lastFromMe: last.sender_id === me,
          lastBody: String(last.body || '').slice(0, 120)
        };
      }).filter(Boolean);
      const { results: blocks } = await env.DB.prepare(
        `SELECT u.username FROM dm_blocks b JOIN users u ON u.id=b.blocked_id
         WHERE b.user_id=? ORDER BY lower(u.username)`
      ).bind(me).all();
      return jsonResponse({
        conversations,
        unreadTotal,
        blocked: (blocks || []).map(b => b.username)
      });
    }

    // ---------- DIRECT MESSAGES: ONE THREAD ----------
    // ?with=username (+ optional ?before=id to page further back). Loading the
    // newest page marks the incoming messages as read.
    if (method === 'GET' && path === '/api/messages/thread') {
      const sess = await getSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not logged in' }, { status: 401 });
      await ensureDmTables(env);
      const other = await findUserByUsername(env, (url.searchParams.get('with') || '').trim());
      if (!other) return jsonResponse({ error: 'No such user.' }, { status: 404 });
      if (other.id === sess.userId) return jsonResponse({ error: "You can't message yourself." }, { status: 400 });
      const before = parseInt(url.searchParams.get('before'), 10) || 0;
      const PAGE = 50;
      const { results } = await env.DB.prepare(
        `SELECT id, ts, sender_id, body, read_at FROM dms
         WHERE ((sender_id=?1 AND recipient_id=?2 AND sender_deleted=0)
             OR (sender_id=?2 AND recipient_id=?1 AND recipient_deleted=0))
           AND (?3=0 OR id<?3)
         ORDER BY id DESC LIMIT ${PAGE}`
      ).bind(sess.userId, other.id, before).all();
      const rows = results || [];
      if (!before && rows.some(r => r.sender_id === other.id && !r.read_at)) {
        await env.DB.prepare(
          `UPDATE dms SET read_at=datetime('now')
           WHERE recipient_id=? AND sender_id=? AND read_at IS NULL`
        ).bind(sess.userId, other.id).run();
      }
      const youBlockedThem = !!(await env.DB.prepare(
        'SELECT 1 FROM dm_blocks WHERE user_id=? AND blocked_id=?'
      ).bind(sess.userId, other.id).first());
      return jsonResponse({
        partner: {
          username: other.username,
          displayName: other.display_name || other.username,
          avatarUrl: other.avatar_url || null,
          isAdmin: !!other.is_admin
        },
        messages: rows.reverse().map(r => ({
          id: r.id, ts: r.ts,
          fromMe: r.sender_id === sess.userId,
          read: !!r.read_at,
          body: r.body
        })),
        hasMore: rows.length === PAGE,
        youBlockedThem
      });
    }

    // ---------- ACCOUNT PAGE DATA ----------
    if (method === 'GET' && path === '/api/account') {
      const sess = await getSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not logged in' }, { status: 401 });
      const batch = await env.DB.batch([
        env.DB.prepare(`SELECT username, email, is_admin, display_name, bio, discord_id, discord_username, avatar_url, email_verified, password_hash, created_at, last_login FROM users WHERE id=?`).bind(sess.userId),
        env.DB.prepare(`SELECT slug, name, team, status, created_at, updated_at FROM characters WHERE owner_id=? AND status IS NOT 'deleted' ORDER BY updated_at DESC`).bind(sess.userId),
        env.DB.prepare(`SELECT slug, display_name AS name, status, created_at, updated_at FROM collections WHERE owner_id=? AND status IS NOT 'deleted' ORDER BY updated_at DESC`).bind(sess.userId),
        env.DB.prepare(`SELECT slug, name, status, created_at, updated_at FROM scripts WHERE owner_id=? AND status IS NOT 'deleted' ORDER BY updated_at DESC`).bind(sess.userId),
        env.DB.prepare(`SELECT ts, action, entity_type, entity_slug, entity_name FROM activity_log WHERE user_id=? ORDER BY ts DESC, id DESC LIMIT 50`).bind(sess.userId)
      ]);
      const u = batch[0].results[0];
      if (!u) return jsonResponse({ error: 'Not logged in' }, { status: 401, 'Set-Cookie': clearCookie() });
      return jsonResponse({
        profile: {
          username: u.username,
          displayName: u.display_name || u.username,
          bio: u.bio || '',
          email: u.email || null,
          emailVerified: !!u.email_verified,
          isAdmin: !!u.is_admin,
          discordLinked: !!u.discord_id,
          discordUsername: u.discord_username || null,
          avatarUrl: u.avatar_url || null,
          hasPassword: !!u.password_hash,
          createdAt: u.created_at,
          lastLogin: u.last_login
        },
        characters: batch[1].results,
        collections: batch[2].results,
        scripts: batch[3].results,
        recentEdits: batch[4].results
      });
    }

    // ---------- FETCH A PAGE FOR EDITING (drafts included for owner) ----------
    if (method === 'GET' && path === '/api/page') {
      const type = url.searchParams.get('type') || 'character';
      const slug = url.searchParams.get('slug') || '';
      if (!CONTENT[type]) return jsonResponse({ error: 'Unknown type' }, { status: 400 });
      let row = await getEntityRow(env, type, slug);
      // Legacy collection rows have display-string PK slugs; resolve by id too.
      if (!row && type === 'collection') row = await findCollectionRow(env, slug);
      if (!row) return jsonResponse({ error: 'Not found' }, { status: 404 });
      const sess = await getSession(env, request);
      const editable = canEditRow(sess, row);
      // Soft-deleted pages read as gone; restore from the dashboard first.
      if (row.status === 'deleted') return jsonResponse({ error: 'Not found' }, { status: 404 });
      if (row.status === 'draft' && !editable) return jsonResponse({ error: 'Not found' }, { status: 404 });
      return jsonResponse({ data: JSON.parse(row.data), status: row.status || 'published', canEdit: editable });
    }

    // ---------- ADMIN DASHBOARD (read, admin only) ----------
    if (method === 'GET' && path === '/api/admin/dashboard') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });

      const batch = await env.DB.batch([
        env.DB.prepare(
          `SELECT
             (SELECT COUNT(*) FROM characters  WHERE status IS NOT 'deleted') AS characters,
             (SELECT COUNT(*) FROM collections WHERE status IS NOT 'deleted') AS collections,
             (SELECT COUNT(*) FROM scripts     WHERE status IS NOT 'deleted') AS scripts,
             (SELECT COUNT(*) FROM users)       AS users`),
        env.DB.prepare(
          `SELECT team, COUNT(*) AS n FROM characters WHERE status IS NOT 'deleted' GROUP BY team ORDER BY n DESC`),
        env.DB.prepare(
          `SELECT 'character' AS type, slug, name, updated_at FROM characters WHERE status IS NOT 'deleted'
           UNION ALL SELECT 'collection', slug, display_name, updated_at FROM collections WHERE status IS NOT 'deleted'
           UNION ALL SELECT 'script', slug, name, updated_at FROM scripts WHERE status IS NOT 'deleted'
           ORDER BY updated_at DESC LIMIT 15`),
        env.DB.prepare(
          `SELECT 'character' AS type, slug, name, created_at FROM characters WHERE status IS NOT 'deleted'
           UNION ALL SELECT 'collection', slug, display_name, created_at FROM collections WHERE status IS NOT 'deleted'
           UNION ALL SELECT 'script', slug, name, created_at FROM scripts WHERE status IS NOT 'deleted'
           ORDER BY created_at DESC LIMIT 15`),
        env.DB.prepare(
          `SELECT ts, username, action, entity_type, entity_slug, entity_name
           FROM activity_log ORDER BY ts DESC, id DESC LIMIT 25`),
        env.DB.prepare(
          `SELECT username, email, is_admin, created_at FROM users
           ORDER BY created_at DESC LIMIT 15`),
        env.DB.prepare(`SELECT value FROM settings WHERE key='wiki_locked'`),
        env.DB.prepare(
          `SELECT 'collection' AS type, slug, display_name AS name FROM collections WHERE owner_id IS NULL AND status IS NOT 'deleted'
           UNION ALL SELECT 'script', slug, name FROM scripts WHERE owner_id IS NULL AND status IS NOT 'deleted'
           UNION ALL SELECT 'character', slug, name FROM characters WHERE owner_id IS NULL AND status IS NOT 'deleted'
           ORDER BY type, name LIMIT 200`),
        env.DB.prepare(
          `SELECT 'character' AS type, slug, name, updated_at, data FROM characters WHERE status='deleted'
           UNION ALL SELECT 'collection', slug, display_name, updated_at, data FROM collections WHERE status='deleted'
           UNION ALL SELECT 'script', slug, name, updated_at, data FROM scripts WHERE status='deleted'
           ORDER BY updated_at DESC LIMIT 200`),
        env.DB.prepare(`SELECT key FROM settings WHERE key LIKE 'protected:%' ORDER BY key`)
      ]);

      const lockVal = batch[6].results[0];
      // Trim the deleted rows down to just what the panel needs (name, when,
      // and who/when it was deleted) — never ship the whole data blob.
      const deleted = (batch[8].results || []).map(r => {
        let meta = {};
        try { meta = (JSON.parse(r.data || '{}')._deleted) || {}; } catch { /* ignore */ }
        return {
          type: r.type, slug: r.slug, name: r.name,
          updated_at: r.updated_at,
          deletedAt: meta.at || null, deletedBy: meta.by || null, deletedFrom: meta.from || null
        };
      });
      // settings keys look like protected:{type}:{slug}
      const protectedPages = (batch[9].results || []).map(r => {
        const parts = String(r.key).split(':');
        return { type: parts[1] || '', slug: parts.slice(2).join(':') };
      }).filter(p => p.type && p.slug);
      return jsonResponse({
        counts: batch[0].results[0],
        charactersByTeam: batch[1].results,
        recentEdits: batch[2].results,
        recentCreations: batch[3].results,
        recentActivity: batch[4].results,
        recentSignups: batch[5].results,
        locked: !!lockVal && lockVal.value === '1',
        unowned: batch[7].results,
        deleted: deleted,
        protectedPages: protectedPages
      });
    }

    // ---------- ADMIN: FULL ACTIVITY LOG (paginated + filterable) ----------
    // ?limit=50 (max 200), ?before={id} to page further back, and optional
    // filters: ?user= (username), ?action=, ?type= (entity_type), ?days=N.
    if (method === 'GET' && path === '/api/admin/activity') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });
      const q = url.searchParams;
      const limit = Math.min(Math.max(parseInt(q.get('limit') || '50', 10) || 50, 1), 200);
      const filters = [];
      const fBinds = [];
      const uname = (q.get('user') || '').trim();
      if (uname) { filters.push('lower(username)=lower(?)'); fBinds.push(uname); }
      const action = (q.get('action') || '').trim();
      if (action) { filters.push('action=?'); fBinds.push(action); }
      const etype = (q.get('type') || '').trim();
      if (etype) { filters.push('entity_type=?'); fBinds.push(etype); }
      const days = parseInt(q.get('days') || '0', 10) || 0;
      if (days > 0) { filters.push("ts >= datetime('now', ?)"); fBinds.push('-' + Math.min(days, 3650) + ' days'); }
      const rowWh = filters.slice();
      const rowBinds = fBinds.slice();
      const before = parseInt(q.get('before') || '0', 10) || 0;
      if (before) { rowWh.push('id < ?'); rowBinds.push(before); }
      const [rowsRes, totalRes] = await Promise.all([
        env.DB.prepare(
          'SELECT id, ts, username, action, entity_type, entity_slug, entity_name FROM activity_log' +
          (rowWh.length ? ' WHERE ' + rowWh.join(' AND ') : '') +
          ' ORDER BY id DESC LIMIT ?'
        ).bind(...rowBinds, limit).all(),
        env.DB.prepare(
          'SELECT COUNT(*) AS n FROM activity_log' +
          (filters.length ? ' WHERE ' + filters.join(' AND ') : '')
        ).bind(...fBinds).first()
      ]);
      const rows = rowsRes.results || [];
      return jsonResponse({
        rows,
        total: totalRes ? totalRes.n : rows.length,
        hasMore: rows.length === limit,
        nextBefore: rows.length ? rows[rows.length - 1].id : null
      });
    }

    // ---------- ADMIN: ACTIVITY REPORT FOR A TIME WINDOW ----------
    // ?days=N (1–365, default 7). Summarizes everything in the window plus
    // the full event log (capped at 1000 rows for the download).
    if (method === 'GET' && path === '/api/admin/report') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });
      const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '7', 10) || 7, 1), 365);
      const since = '-' + days + ' days';
      const batch = await env.DB.batch([
        env.DB.prepare(
          `SELECT action, COUNT(*) AS n FROM activity_log WHERE ts >= datetime('now', ?)
           GROUP BY action ORDER BY n DESC`).bind(since),
        env.DB.prepare(
          `SELECT entity_type, action, COUNT(*) AS n FROM activity_log
           WHERE ts >= datetime('now', ?) AND entity_type IN ('character','collection','script')
           GROUP BY entity_type, action ORDER BY entity_type, n DESC`).bind(since),
        env.DB.prepare(
          `SELECT username, COUNT(*) AS n FROM activity_log
           WHERE ts >= datetime('now', ?) AND username IS NOT NULL
           GROUP BY username ORDER BY n DESC LIMIT 10`).bind(since),
        env.DB.prepare(
          `SELECT entity_type, entity_slug, MAX(entity_name) AS entity_name, COUNT(*) AS n
           FROM activity_log WHERE ts >= datetime('now', ?) AND entity_slug IS NOT NULL
           GROUP BY entity_type, entity_slug ORDER BY n DESC LIMIT 10`).bind(since),
        env.DB.prepare(
          `SELECT username, created_at FROM users WHERE created_at >= datetime('now', ?)
           ORDER BY created_at DESC LIMIT 100`).bind(since),
        env.DB.prepare(
          `SELECT COUNT(*) AS n FROM activity_log WHERE ts >= datetime('now', ?)`).bind(since),
        env.DB.prepare(
          `SELECT
             (SELECT COUNT(*) FROM characters  WHERE status IS NOT 'deleted') AS characters,
             (SELECT COUNT(*) FROM collections WHERE status IS NOT 'deleted') AS collections,
             (SELECT COUNT(*) FROM scripts     WHERE status IS NOT 'deleted') AS scripts,
             (SELECT COUNT(*) FROM users)       AS users`),
        env.DB.prepare(
          `SELECT ts, username, action, entity_type, entity_slug, entity_name FROM activity_log
           WHERE ts >= datetime('now', ?) ORDER BY id DESC LIMIT 1000`).bind(since)
      ]);
      const log = batch[7].results || [];
      return jsonResponse({
        generatedAt: new Date().toISOString(),
        days,
        activityCount: batch[5].results[0] ? batch[5].results[0].n : 0,
        byAction: batch[0].results,
        contentByType: batch[1].results,
        topUsers: batch[2].results,
        topPages: batch[3].results,
        newUsers: batch[4].results,
        siteTotals: batch[6].results[0] || {},
        log,
        logTruncated: log.length === 1000
      });
    }

    // ---------- ADMIN: VERSION HISTORY FOR ONE PAGE ----------
    if (method === 'GET' && path === '/api/admin/revisions') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });
      const type = url.searchParams.get('type') || '';
      if (!CONTENT[type]) return jsonResponse({ error: 'Unknown type' }, { status: 400 });
      const slugParam = (url.searchParams.get('slug') || '').trim();
      if (!slugParam) return jsonResponse({ error: 'Missing slug' }, { status: 400 });
      let row = await getEntityRow(env, type, slugParam);
      if (!row && type === 'collection') row = await findCollectionRow(env, slugParam);
      const pk = row ? row.slug : slugParam;
      await ensureRevisionsTable(env);
      const { results } = await env.DB.prepare(
        `SELECT id, ts, name, status, edited_by, length(data) AS bytes
         FROM revisions WHERE entity_type=? AND slug=? ORDER BY id DESC`
      ).bind(type, pk).all();
      return jsonResponse({
        slug: pk,
        current: row ? { name: row.name, status: row.status || 'published' } : null,
        revisions: results || []
      });
    }

    // ---------- ADMIN: USER LIST (users panel; ?q= searches) ----------
    if (method === 'GET' && path === '/api/admin/users') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });
      await ensureBanColumn(env);
      const q = (url.searchParams.get('q') || '').trim();
      let sql =
        `SELECT u.id, u.username, u.display_name, u.email, u.is_admin,
                COALESCE(u.banned, 0) AS banned, u.created_at, u.last_login,
                (SELECT COUNT(*) FROM characters  WHERE owner_id=u.id AND status IS NOT 'deleted') AS characters,
                (SELECT COUNT(*) FROM scripts     WHERE owner_id=u.id AND status IS NOT 'deleted') AS scripts,
                (SELECT COUNT(*) FROM collections WHERE owner_id=u.id AND status IS NOT 'deleted') AS collections
         FROM users u`;
      const binds = [];
      if (q) {
        sql += ' WHERE u.username LIKE ? OR u.display_name LIKE ? OR u.email LIKE ?';
        const like = '%' + q + '%';
        binds.push(like, like, like);
      }
      sql += ' ORDER BY u.created_at DESC LIMIT 200';
      const { results } = await env.DB.prepare(sql).bind(...binds).all();
      return jsonResponse({ users: results || [], me: sess.userId });
    }

    // ---------- ADMIN: CONTACT-FORM INBOX ----------
    if (method === 'GET' && path === '/api/admin/messages') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });
      await ensureMessagesTable(env);
      const status = url.searchParams.get('status') || 'open';
      let sql = 'SELECT id, ts, user_id, username, category, body, status FROM messages';
      const binds = [];
      if (status !== 'all') { sql += ' WHERE status=?'; binds.push(status === 'resolved' ? 'resolved' : 'open'); }
      sql += ' ORDER BY id DESC LIMIT 200';
      const [list, open] = await Promise.all([
        env.DB.prepare(sql).bind(...binds).all(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE status='open'").first()
      ]);
      return jsonResponse({ messages: list.results || [], openCount: open ? open.n : 0 });
    }

    // ---------- ADMIN: REPORTED DM CONVERSATIONS ----------
    if (method === 'GET' && path === '/api/admin/dm-reports') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });
      await ensureDmTables(env);
      const status = url.searchParams.get('status') || 'open';
      let sql =
        `SELECT r.id, r.ts, r.reason, r.status,
                ru.username AS reporter, tu.username AS reported
         FROM dm_reports r
         LEFT JOIN users ru ON ru.id=r.reporter_id
         LEFT JOIN users tu ON tu.id=r.reported_id`;
      const binds = [];
      if (status !== 'all') { sql += ' WHERE r.status=?'; binds.push(status === 'resolved' ? 'resolved' : 'open'); }
      sql += ' ORDER BY r.id DESC LIMIT 200';
      const [list, open] = await Promise.all([
        env.DB.prepare(sql).bind(...binds).all(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM dm_reports WHERE status='open'").first()
      ]);
      return jsonResponse({ reports: list.results || [], openCount: open ? open.n : 0 });
    }

    // ---------- ADMIN: TRANSCRIPT OF A REPORTED CONVERSATION ----------
    // Privacy guard: only conversations someone reported can be opened, and
    // only by an admin. ?a= and ?b= are the two usernames.
    if (method === 'GET' && path === '/api/admin/dm-thread') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });
      await ensureDmTables(env);
      const ua = await findUserByUsername(env, (url.searchParams.get('a') || '').trim());
      const ub = await findUserByUsername(env, (url.searchParams.get('b') || '').trim());
      if (!ua || !ub) return jsonResponse({ error: 'No such user.' }, { status: 404 });
      const reported = await env.DB.prepare(
        `SELECT 1 FROM dm_reports
         WHERE (reporter_id=?1 AND reported_id=?2) OR (reporter_id=?2 AND reported_id=?1)`
      ).bind(ua.id, ub.id).first();
      if (!reported) {
        return jsonResponse({ error: 'That conversation has not been reported, so it stays private.' }, { status: 403 });
      }
      const { results } = await env.DB.prepare(
        `SELECT id, ts, sender_id, body FROM dms
         WHERE (sender_id=?1 AND recipient_id=?2) OR (sender_id=?2 AND recipient_id=?1)
         ORDER BY id DESC LIMIT 100`
      ).bind(ua.id, ub.id).all();
      return jsonResponse({
        a: ua.username, b: ub.username,
        messages: (results || []).reverse().map(r => ({
          id: r.id, ts: r.ts,
          from: r.sender_id === ua.id ? ua.username : ub.username,
          body: r.body
        }))
      });
    }

    // ---------- ADMIN: ORPHANED IMAGES (R2 objects no page references) ----------
    if (method === 'GET' && path === '/api/admin/orphans') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });
      if (!env.ART) return jsonResponse({ error: 'Image storage (R2) is not configured' }, { status: 500 });
      // Every image path mentioned anywhere in any page's JSON (all statuses:
      // drafts and trashed pages still need their art if restored).
      const refs = new Set();
      for (const tbl of ['characters', 'collections', 'scripts']) {
        const { results } = await env.DB.prepare(`SELECT data FROM ${tbl}`).all();
        for (const r of results || []) {
          const found = String(r.data).match(/(?:art|scripts|collections)\/[A-Za-z0-9._ -]+\.(?:png|jpe?g|webp|gif|svg)/gi) || [];
          for (const f of found) refs.add(f.toLowerCase());
        }
      }
      const userIds = new Set(
        ((await env.DB.prepare('SELECT id FROM users').all()).results || []).map(r => String(r.id))
      );
      const orphans = [];
      let totalBytes = 0;
      let truncated = false;
      for (const prefix of ['art/', 'scripts/', 'collections/', 'avatars/']) {
        let cursor;
        do {
          const listed = await env.ART.list({ prefix, cursor, limit: 1000 });
          for (const o of listed.objects) {
            let orphan;
            if (prefix === 'avatars/') {
              // avatars/u{id}.{ext} is orphaned when that account no longer exists
              const m = o.key.match(/^avatars\/u(\d+)\./);
              orphan = !!m && !userIds.has(m[1]);
            } else {
              orphan = !refs.has(o.key.toLowerCase());
            }
            if (!orphan) continue;
            totalBytes += o.size || 0;
            if (orphans.length < 500) {
              orphans.push({ key: o.key, size: o.size || 0, uploaded: o.uploaded || null });
            } else {
              truncated = true;
            }
          }
          cursor = listed.truncated ? listed.cursor : null;
        } while (cursor);
      }
      return jsonResponse({ orphans, totalBytes, truncated });
    }

    // ---------- ADMIN: BROKEN CHARACTER REFERENCES ----------
    if (method === 'GET' && path === '/api/admin/broken-refs') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });
      const charStatus = {};
      for (const r of (await env.DB.prepare('SELECT slug, status FROM characters').all()).results || []) {
        charStatus[r.slug] = r.status || 'published';
      }
      const official = new Set((await loadOfficialRoles(env, url.origin)).map(r => r.slug));
      function checkRefs(list) {
        const missing = [], deleted = [], draft = [];
        for (const raw of list || []) {
          const s = String(raw);
          if (official.has(s)) continue;
          const st = charStatus[s];
          if (st === undefined) missing.push(s);
          else if (st === 'deleted') deleted.push(s);
          else if (st === 'draft') draft.push(s);
        }
        return { missing, deleted, draft };
      }
      const issues = [];
      let checkedScripts = 0, checkedCollections = 0;
      for (const r of (await env.DB.prepare(
        "SELECT slug, name, status, data FROM scripts WHERE status IS NOT 'deleted'").all()).results || []) {
        checkedScripts++;
        let d; try { d = JSON.parse(r.data); } catch { continue; }
        const res = checkRefs(d.characters);
        if (res.missing.length || res.deleted.length || res.draft.length) {
          issues.push({ type: 'script', slug: r.slug, name: r.name, status: r.status, ...res });
        }
      }
      for (const r of (await env.DB.prepare(
        "SELECT slug, display_name AS name, status, data FROM collections WHERE status IS NOT 'deleted'").all()).results || []) {
        checkedCollections++;
        let d; try { d = JSON.parse(r.data); } catch { continue; }
        const res = checkRefs((d.include || []).concat(d.exclude || []));
        if (res.missing.length || res.deleted.length || res.draft.length) {
          issues.push({ type: 'collection', slug: r.slug, name: r.name, status: r.status, ...res });
        }
      }
      return jsonResponse({ issues, checkedScripts, checkedCollections });
    }

    // ---------- ADMIN: BACKUP BROWSER ----------
    if (method === 'GET' && path === '/api/admin/backups') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });
      if (!env.ART) return jsonResponse({ error: 'Image storage (R2) is not configured' }, { status: 500 });
      const byDate = {};
      let cursor;
      do {
        const listed = await env.ART.list({ prefix: 'backups/', cursor, limit: 1000 });
        for (const o of listed.objects) {
          const m = o.key.match(/^backups\/(\d{4}-\d{2}-\d{2})\/([a-z_]+)\.json$/);
          if (!m) continue;
          (byDate[m[1]] = byDate[m[1]] || []).push({ table: m[2], size: o.size || 0 });
        }
        cursor = listed.truncated ? listed.cursor : null;
      } while (cursor);
      const backups = Object.keys(byDate).sort().reverse().map(date => ({
        date, tables: byDate[date].sort((a, b) => a.table < b.table ? -1 : 1)
      }));
      return jsonResponse({ backups });
    }

    // ---------- ADMIN: DOWNLOAD ONE BACKUP TABLE ----------
    if (method === 'GET' && path === '/api/admin/backup-file') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });
      if (!env.ART) return jsonResponse({ error: 'Image storage (R2) is not configured' }, { status: 500 });
      const date = url.searchParams.get('date') || '';
      const table = url.searchParams.get('table') || '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[a-z_]{1,40}$/.test(table)) {
        return jsonResponse({ error: 'Bad date or table.' }, { status: 400 });
      }
      const obj = await env.ART.get(`backups/${date}/${table}.json`);
      if (!obj) return jsonResponse({ error: 'No such backup file.' }, { status: 404 });
      return new Response(obj.body, {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="botc-backup-${date}-${table}.json"`,
          'Cache-Control': 'no-store'
        }
      });
    }

    // ---------- ADMIN: PAGE LIST FOR BULK ACTIONS ----------
    if (method === 'GET' && path === '/api/admin/pages') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });
      const type = url.searchParams.get('type') || '';
      const t = CONTENT[type];
      if (!t) return jsonResponse({ error: 'Unknown type' }, { status: 400 });
      const q = (url.searchParams.get('q') || '').trim();
      const owner = (url.searchParams.get('owner') || '').trim();
      const status = (url.searchParams.get('status') || '').trim();
      const wh = [];
      const binds = [];
      if (q) {
        wh.push(`(p.slug LIKE ? OR p.${t.nameCol} LIKE ?)`);
        const like = '%' + q + '%';
        binds.push(like, like);
      }
      if (owner === 'none') wh.push('p.owner_id IS NULL');
      else if (owner) { wh.push('lower(u.username)=lower(?)'); binds.push(owner); }
      if (['published', 'draft', 'deleted'].includes(status)) { wh.push('p.status=?'); binds.push(status); }
      else wh.push("p.status IS NOT 'deleted'");
      const { results } = await env.DB.prepare(
        `SELECT p.slug, p.${t.nameCol} AS name, p.status, p.updated_at, u.username AS owner
         FROM ${t.table} p LEFT JOIN users u ON u.id = p.owner_id
         WHERE ${wh.join(' AND ')}
         ORDER BY p.updated_at DESC LIMIT 300`
      ).bind(...binds).all();
      return jsonResponse({ pages: results || [] });
    }

    // ---------- ADMIN: PAGE-VIEW ANALYTICS ----------
    if (method === 'GET' && path === '/api/admin/analytics') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });
      const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '7', 10) || 7, 1), 365);
      const since = '-' + days + ' day';
      await ensureViewsTable(env);
      const names =
        `(SELECT 'character' AS t, slug, name FROM characters
          UNION ALL SELECT 'script', slug, name FROM scripts
          UNION ALL SELECT 'collection', slug, display_name FROM collections)`;
      const [top, totals] = await Promise.all([
        env.DB.prepare(
          `SELECT pv.entity_type, pv.slug, SUM(pv.n) AS views, MAX(p.name) AS name
           FROM page_views pv LEFT JOIN ${names} p ON p.t = pv.entity_type AND p.slug = pv.slug
           WHERE pv.day >= date('now', ?)
           GROUP BY pv.entity_type, pv.slug ORDER BY views DESC LIMIT 15`
        ).bind(since).all(),
        env.DB.prepare(
          `SELECT COALESCE(SUM(n), 0) AS views, COUNT(DISTINCT entity_type || ':' || slug) AS pages
           FROM page_views WHERE day >= date('now', ?)`
        ).bind(since).first()
      ]);
      return jsonResponse({ days, totals: totals || { views: 0, pages: 0 }, top: top.results || [] });
    }

    // ---------- WRITES (logged-in users; ownership enforced) ----------
    if (method === 'POST' && path.startsWith('/api/')) {
      const sess = await getSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not logged in. Create an account or log in first.' }, { status: 401 });

      // Fresh account flags from D1: bans and admin promotions/demotions
      // apply immediately instead of when the 30-day session cookie expires.
      const acctFlags = await getAccountFlags(env, sess.userId);
      if (!acctFlags) return jsonResponse({ error: 'Not logged in.' }, { status: 401, 'Set-Cookie': clearCookie() });
      sess.isAdmin = !!acctFlags.is_admin;

      // Every /api/admin/* endpoint (plus lock/seed/backup) is admin-only.
      const adminOnly = path.startsWith('/api/admin/') ||
                        path === '/api/lock' || path === '/api/seed' || path === '/api/backup';
      if (adminOnly && !sess.isAdmin) return jsonResponse({ error: 'Not authorized' }, { status: 403 });

      // Content writes are blocked while the wiki is locked (true freeze,
      // applies to admins too). Lock toggle + seed are intentionally exempt.
      const isContentWrite = ['/api/character', '/api/collection', '/api/script', '/api/publish', '/api/delete', '/api/upload'].includes(path);
      // Suspended accounts can still use account settings and the contact
      // form (to appeal), but cannot touch content.
      if (isContentWrite && acctFlags.banned) {
        return jsonResponse({ error: 'This account is suspended. You can contact the admins from your account page.' }, { status: 403 });
      }
      if (isContentWrite && await isWikiLocked(env)) {
        return jsonResponse({ error: 'The wiki is locked. Editing and page creation are temporarily disabled.' }, { status: 423 });
      }

      // ---- account settings ----
      if (path === '/api/account/profile') {
        const b = await request.json().catch(() => ({}));
        const displayName = String(b.displayName || '').trim().slice(0, 40) || null;
        const bio = String(b.bio || '').trim().slice(0, 500) || null;
        await env.DB.prepare('UPDATE users SET display_name=?, bio=? WHERE id=?')
          .bind(displayName, bio, sess.userId).run();
        return jsonResponse({ ok: true });
      }

      // ---- profile picture (uploaded to R2 under avatars/u{id}.{ext}) ----
      // Body: {data: dataURL} to set, or {remove: true} to go back to the
      // initial-letter avatar. The key is derived from the session, so users
      // can only ever touch their own avatar slot.
      if (path === '/api/account/avatar') {
        if (!env.ART) return jsonResponse({ error: 'Image storage (R2) is not configured' }, { status: 500 });
        if (await rateLimited(env, request, 'avatar', 20, 3600)) {
          return jsonResponse({ error: 'Too many avatar changes. Try again later.' }, { status: 429 });
        }
        const b = await request.json().catch(() => ({}));
        const AVATAR_EXTS = ['png', 'jpg', 'jpeg', 'webp'];
        async function deleteOwnAvatars() {
          for (const e of AVATAR_EXTS) {
            try { await env.ART.delete('avatars/u' + sess.userId + '.' + e); } catch { /* best-effort */ }
          }
        }
        if (b.remove) {
          await deleteOwnAvatars();
          await env.DB.prepare('UPDATE users SET avatar_url=NULL WHERE id=?').bind(sess.userId).run();
          return jsonResponse({ ok: true, avatarUrl: null });
        }
        let data = String(b.data || '');
        if (!data.startsWith('data:')) return jsonResponse({ error: 'Send the image as a data URL.' }, { status: 400 });
        const contentType = data.slice(5, data.indexOf(';'));
        const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[contentType];
        if (!ext) return jsonResponse({ error: 'Profile pictures must be PNG, JPEG, or WebP.' }, { status: 400 });
        data = data.slice(data.indexOf(',') + 1);
        let bytes;
        try { bytes = base64ToBytes(data); } catch { return jsonResponse({ error: 'Could not read that image.' }, { status: 400 }); }
        if (!bytes.length) return jsonResponse({ error: 'Could not read that image.' }, { status: 400 });
        if (bytes.length > 2 * 1024 * 1024) return jsonResponse({ error: 'Picture is too large (2 MB max).' }, { status: 413 });
        await deleteOwnAvatars(); // clear any old picture with a different extension
        const key = 'avatars/u' + sess.userId + '.' + ext;
        await env.ART.put(key, bytes, {
          httpMetadata: { contentType },
          customMetadata: { owner: String(sess.userId) }
        });
        // ?v= busts any cached copy the browser holds of the previous picture
        const avatarUrl = '/assets/' + key + '?v=' + Date.now();
        await env.DB.prepare('UPDATE users SET avatar_url=? WHERE id=?').bind(avatarUrl, sess.userId).run();
        return jsonResponse({ ok: true, avatarUrl });
      }

      if (path === '/api/account/password') {
        const b = await request.json().catch(() => ({}));
        const newPassword = String(b.newPassword || '');
        if (newPassword.length < 8) return jsonResponse({ error: 'New password must be at least 8 characters.' }, { status: 400 });
        const u = await env.DB.prepare('SELECT password_hash FROM users WHERE id=?').bind(sess.userId).first();
        if (u.password_hash) {
          const ok = await verifyPassword(String(b.currentPassword || ''), u.password_hash);
          if (!ok) return jsonResponse({ error: 'Current password is incorrect.' }, { status: 403 });
        }
        // (no current password on Discord-only accounts: they may set one freely)
        await env.DB.prepare('UPDATE users SET password_hash=? WHERE id=?')
          .bind(await hashPassword(newPassword), sess.userId).run();
        return jsonResponse({ ok: true });
      }

      if (path === '/api/account/email') {
        const b = await request.json().catch(() => ({}));
        const email = String(b.email || '').trim();
        if (!EMAIL_RE.test(email) || email.length > 254) return jsonResponse({ error: 'Please enter a valid email address.' }, { status: 400 });
        const taken = await env.DB.prepare('SELECT 1 FROM users WHERE id<>? AND email IS NOT NULL AND lower(email)=lower(?)')
          .bind(sess.userId, email).first();
        if (taken) return jsonResponse({ error: 'That email is already in use by another account.' }, { status: 409 });
        await env.DB.prepare('UPDATE users SET email=?, email_verified=0 WHERE id=?')
          .bind(email, sess.userId).run();
        const u = await env.DB.prepare('SELECT id, username, display_name, email FROM users WHERE id=?').bind(sess.userId).first();
        ctx.waitUntil(sendVerificationEmail(env, url.origin, u));
        return jsonResponse({ ok: true, message: 'Email updated. Check your inbox for a verification link.' });
      }

      if (path === '/api/account/unlink-discord') {
        const u = await env.DB.prepare('SELECT password_hash, discord_id FROM users WHERE id=?').bind(sess.userId).first();
        if (!u.discord_id) return jsonResponse({ error: 'No Discord account is linked.' }, { status: 400 });
        if (!u.password_hash) return jsonResponse({ error: 'Set a password first so you can still log in after unlinking Discord.' }, { status: 400 });
        await env.DB.prepare('UPDATE users SET discord_id=NULL, discord_username=NULL WHERE id=?').bind(sess.userId).run();
        return jsonResponse({ ok: true });
      }

      // ---- image upload (ownership-checked) ----
      if (path === '/api/upload') {
        if (!env.ART) return jsonResponse({ error: 'Image storage (R2) is not configured' }, { status: 500 });
        const ct = request.headers.get('Content-Type') || '';
        let key, bytes, contentType;
        if (ct.includes('application/json')) {
          const b = await request.json().catch(() => ({}));
          key = b.key;
          if (!key || !b.data) return jsonResponse({ error: 'Missing key or data' }, { status: 400 });
          let data = String(b.data);
          if (data.startsWith('data:')) {
            contentType = data.slice(5, data.indexOf(';'));
            data = data.slice(data.indexOf(',') + 1);
          }
          bytes = base64ToBytes(data);
        } else {
          key = url.searchParams.get('key');
          bytes = new Uint8Array(await request.arrayBuffer());
          contentType = ct || undefined;
        }
        key = String(key || '').replace(/^\/+/, '').replace(/^assets\//, '');
        if (key.includes('..') || !R2_PREFIXES.some(p => key.startsWith(p))) {
          return jsonResponse({ error: 'Key must be under: ' + R2_PREFIXES.join(', ') }, { status: 400 });
        }
        if (bytes.length > 8 * 1024 * 1024) {
          return jsonResponse({ error: 'Image is too large (8 MB max).' }, { status: 413 });
        }

        if (!sess.isAdmin) {
          // tokens/ is reserved for admin tooling.
          if (key.startsWith('tokens/')) return jsonResponse({ error: 'Not authorized for that upload path.' }, { status: 403 });
          // Character art follows art/{slug}.png — if that character exists,
          // only its owner may replace the art.
          if (key.startsWith('art/')) {
            const slug = key.slice(4).replace(/\.[a-z0-9]+$/i, '');
            const row = await getEntityRow(env, 'character', slug);
            if (row && !canEditRow(sess, row)) {
              return jsonResponse({ error: 'That art slot belongs to a character owned by another account.' }, { status: 403 });
            }
            if (row && await isProtected(env, 'character', row.slug)) {
              return jsonResponse({ error: PROTECTED_MSG }, { status: 423 });
            }
          }
          // Script images follow scripts/{slug}[-logo|-bg].{ext}; collection
          // images collections/{id}[-logo|-bg].{ext}. If that page exists,
          // only its owner may replace its images.
          if (key.startsWith('scripts/')) {
            const base = key.slice(8).replace(/\.[a-z0-9]+$/i, '').replace(/-(logo|bg)$/, '');
            const row = await getEntityRow(env, 'script', base);
            if (row && !canEditRow(sess, row)) {
              return jsonResponse({ error: 'That image slot belongs to a script owned by another account.' }, { status: 403 });
            }
            if (row && await isProtected(env, 'script', row.slug)) {
              return jsonResponse({ error: PROTECTED_MSG }, { status: 423 });
            }
          }
          if (key.startsWith('collections/')) {
            const base = key.slice(12).replace(/\.[a-z0-9]+$/i, '').replace(/-(logo|bg)$/, '');
            const row = await findCollectionRow(env, base);
            if (row && !canEditRow(sess, row)) {
              return jsonResponse({ error: 'That image slot belongs to a collection owned by another account.' }, { status: 403 });
            }
            if (row && await isProtected(env, 'collection', row.slug)) {
              return jsonResponse({ error: PROTECTED_MSG }, { status: 423 });
            }
          }
          // Never allow silently replacing someone else's uploaded file.
          const existing = await env.ART.head(key).catch(() => null);
          if (existing) {
            const owner = existing.customMetadata && existing.customMetadata.owner;
            if (owner !== String(sess.userId)) {
              return jsonResponse({ error: 'A file already exists at that path and belongs to another account.' }, { status: 403 });
            }
          }
        }

        const ext = key.split('.').pop().toLowerCase();
        if (!contentType) contentType = EXT_CONTENT_TYPE[ext] || 'application/octet-stream';
        await env.ART.put(key, bytes, {
          httpMetadata: { contentType },
          customMetadata: { owner: String(sess.userId) }
        });
        return jsonResponse({ ok: true, path: '/assets/' + key });
      }

      // ---- content create / update ----
      if (path === '/api/character') {
        const c = await request.json();
        if (!c || !c.slug || !c.name || !c.team || !c.ability)
          return jsonResponse({ error: 'Missing required fields' }, { status: 400 });
        const existing = await getEntityRow(env, 'character', c.slug);
        if (existing && !canEditRow(sess, existing)) {
          return jsonResponse({ error: 'A character with that name already exists and belongs to another account. Pick a different name.' }, { status: 403 });
        }
        if (existing && !sess.isAdmin && await isProtected(env, 'character', existing.slug)) {
          return jsonResponse({ error: PROTECTED_MSG }, { status: 423 });
        }
        const status = c.status === 'draft' ? 'draft' : 'published';
        delete c.status;
        if (existing) await saveRevision(env, sess, 'character', existing);
        await env.DB.prepare(
          `INSERT INTO characters (slug,name,team,creator,owner_id,tags,appears_in,data,status,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
           ON CONFLICT(slug) DO UPDATE SET
             name=excluded.name, team=excluded.team, creator=excluded.creator,
             tags=excluded.tags, appears_in=excluded.appears_in,
             data=excluded.data, status=excluded.status, updated_at=datetime('now')`
        ).bind(c.slug, c.name, c.team, c.creator || null, sess.userId,
               c.tags || null, c.appearsIn || null, JSON.stringify(c), status).run();
        await logActivity(env, sess, existing ? 'update' : 'create', 'character', c.slug, c.name);
        return jsonResponse({ ok: true, slug: c.slug, status });
      }

      if (path === '/api/collection') {
        const c = await request.json();
        if (!c || (!c.slug && !c.id && !c.displayName)) {
          return jsonResponse({ error: 'Missing collection name' }, { status: 400 });
        }
        // Resolve the row this write targets: PK slug first, then kebab id
        // (legacy rows have display-string PK slugs, e.g. "The Academy").
        let existing = c.slug ? await getEntityRow(env, 'collection', c.slug) : null;
        if (!existing) existing = await findCollectionRow(env, c.id || c.slug);
        if (existing && !canEditRow(sess, existing)) {
          return jsonResponse({ error: 'That collection belongs to another account.' }, { status: 403 });
        }
        if (existing && !sess.isAdmin && await isProtected(env, 'collection', existing.slug)) {
          return jsonResponse({ error: PROTECTED_MSG }, { status: 423 });
        }
        // Keep the existing PK for updates; new collections use the kebab id
        // as PK so the URL, id and PK all agree.
        const kebab = s => String(s || '').toLowerCase().normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
        c.id = kebab(c.id) || kebab(c.displayName) || kebab(c.slug);
        if (!c.id) return jsonResponse({ error: 'Could not derive a collection id from that name.' }, { status: 400 });
        const pkSlug = existing ? existing.slug : c.id;
        if (!existing) {
          // creating: the id must not collide with another collection's id
          const clash = await findCollectionRow(env, c.id);
          if (clash && clash.slug !== pkSlug) {
            return jsonResponse({ error: 'A collection with that name already exists.' }, { status: 409 });
          }
          c.slug = c.id;
        } else {
          c.slug = existing.slug;
        }
        if (!c.displayName) c.displayName = existing ? existing.name : c.slug;
        sanitizePageFields(c, 'collections/' + c.id);
        c.match = Array.isArray(c.match)
          ? c.match.slice(0, 30).map(s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean)
          : [];
        for (const k of ['include', 'exclude']) {
          c[k] = Array.isArray(c[k]) ? c[k].slice(0, 500).map(x => String(x).slice(0, 80)) : [];
        }
        const status = c.status === 'draft' ? 'draft' : 'published';
        delete c.status;
        if (existing) await saveRevision(env, sess, 'collection', existing);
        await env.DB.prepare(
          `INSERT INTO collections (slug,display_name,owner_id,data,status,created_at,updated_at)
           VALUES (?,?,?,?,?,datetime('now'),datetime('now'))
           ON CONFLICT(slug) DO UPDATE SET
             display_name=excluded.display_name, data=excluded.data, status=excluded.status, updated_at=datetime('now')`
        ).bind(pkSlug, c.displayName, sess.userId, JSON.stringify(c), status).run();
        await logActivity(env, sess, existing ? 'update' : 'create', 'collection', pkSlug, c.displayName);
        return jsonResponse({ ok: true, slug: pkSlug, id: c.id, status });
      }

      if (path === '/api/script') {
        const s = await request.json();
        if (!s || !s.slug) return jsonResponse({ error: 'Missing slug' }, { status: 400 });
        if (!/^[a-z0-9-]{1,80}$/.test(String(s.slug))) {
          return jsonResponse({ error: 'Invalid script slug.' }, { status: 400 });
        }
        const existing = await getEntityRow(env, 'script', s.slug);
        if (existing && !canEditRow(sess, existing)) {
          return jsonResponse({ error: 'That script belongs to another account.' }, { status: 403 });
        }
        if (existing && !sess.isAdmin && await isProtected(env, 'script', existing.slug)) {
          return jsonResponse({ error: PROTECTED_MSG }, { status: 423 });
        }
        sanitizePageFields(s, 'scripts/' + s.slug);
        s.characters = Array.isArray(s.characters)
          ? s.characters.slice(0, 100).map(x => String(x).slice(0, 80))
          : [];
        const status = s.status === 'draft' ? 'draft' : 'published';
        delete s.status;
        if (existing) await saveRevision(env, sess, 'script', existing);
        await env.DB.prepare(
          `INSERT INTO scripts (slug,name,author,owner_id,data,status,created_at,updated_at)
           VALUES (?,?,?,?,?,?,datetime('now'),datetime('now'))
           ON CONFLICT(slug) DO UPDATE SET
             name=excluded.name, author=excluded.author, data=excluded.data, status=excluded.status, updated_at=datetime('now')`
        ).bind(s.slug, s.name || s.slug, s.author || null, sess.userId, JSON.stringify(s), status).run();
        await logActivity(env, sess, existing ? 'update' : 'create', 'script', s.slug, s.name || s.slug);
        return jsonResponse({ ok: true, slug: s.slug, status });
      }

      // ---- publish / unpublish a page ----
      if (path === '/api/publish') {
        const b = await request.json().catch(() => ({}));
        const type = String(b.type || 'character');
        const t = CONTENT[type];
        if (!t) return jsonResponse({ error: 'Unknown type' }, { status: 400 });
        const row = await getEntityRow(env, type, String(b.slug || ''));
        if (!row) return jsonResponse({ error: 'Not found' }, { status: 404 });
        if (!canEditRow(sess, row)) return jsonResponse({ error: 'That page belongs to another account.' }, { status: 403 });
        if (row.status === 'deleted') return jsonResponse({ error: 'That page is deleted. An admin can restore it from the dashboard.' }, { status: 400 });
        if (!sess.isAdmin && await isProtected(env, type, row.slug)) {
          return jsonResponse({ error: PROTECTED_MSG }, { status: 423 });
        }
        const status = b.status === 'draft' ? 'draft' : 'published';
        await env.DB.prepare(`UPDATE ${t.table} SET status=?, updated_at=datetime('now') WHERE slug=?`)
          .bind(status, row.slug).run();
        await logActivity(env, sess, status === 'published' ? 'publish' : 'unpublish', type, row.slug, row.name);
        return jsonResponse({ ok: true, slug: row.slug, status });
      }

      // ---- delete a page (SOFT delete) ----
      // The row is not removed — its status is flipped to 'deleted' so it drops
      // out of the whole site (public JSON, SSR pages, search, the owner's
      // account list) but can still be restored, or purged for good, from the
      // admin Deleted Content panel. This keeps scripts/JSON that reference a
      // character from silently breaking on an accidental delete. The prior
      // status + who/when is stashed in the data blob (no schema migration).
      if (path === '/api/delete') {
        const b = await request.json().catch(() => ({}));
        const type = String(b.type || 'character');
        const t = CONTENT[type];
        if (!t) return jsonResponse({ error: 'Unknown type' }, { status: 400 });
        let row = await getEntityRow(env, type, String(b.slug || ''));
        // Legacy collections have display-string PK slugs; the URL uses the id.
        if (!row && type === 'collection') row = await findCollectionRow(env, String(b.slug || ''));
        if (!row) return jsonResponse({ error: 'Not found' }, { status: 404 });
        if (!canEditRow(sess, row)) return jsonResponse({ error: 'That page belongs to another account.' }, { status: 403 });
        if (!sess.isAdmin && await isProtected(env, type, row.slug)) {
          return jsonResponse({ error: PROTECTED_MSG }, { status: 423 });
        }
        if (row.status === 'deleted') return jsonResponse({ ok: true, slug: row.slug });
        let data;
        try { data = JSON.parse(row.data); } catch { data = {}; }
        let byName = null;
        try {
          const u = await env.DB.prepare('SELECT username FROM users WHERE id=?').bind(sess.userId).first();
          byName = u ? u.username : null;
        } catch { /* non-fatal */ }
        data._deleted = { at: new Date().toISOString(), by: byName, from: row.status || 'published' };
        await env.DB.prepare(`UPDATE ${t.table} SET status='deleted', data=?, updated_at=datetime('now') WHERE slug=?`)
          .bind(JSON.stringify(data), row.slug).run();
        await logActivity(env, sess, 'delete', type, row.slug, row.name);
        return jsonResponse({ ok: true, slug: row.slug });
      }

      // ---- admin: restore a soft-deleted page ----
      // Puts the row back to the status it had before deletion (published or
      // draft) and clears the _deleted marker.
      if (path === '/api/admin/restore') {
        const b = await request.json().catch(() => ({}));
        const type = String(b.type || '');
        const t = CONTENT[type];
        if (!t) return jsonResponse({ error: 'Unknown type' }, { status: 400 });
        let row = await getEntityRow(env, type, String(b.slug || ''));
        if (!row && type === 'collection') row = await findCollectionRow(env, String(b.slug || ''));
        if (!row) return jsonResponse({ error: 'Not found' }, { status: 404 });
        if (row.status !== 'deleted') return jsonResponse({ error: 'That page is not deleted.' }, { status: 400 });
        let data;
        try { data = JSON.parse(row.data); } catch { data = {}; }
        const from = (data._deleted && data._deleted.from) || 'published';
        const status = from === 'draft' ? 'draft' : 'published';
        delete data._deleted;
        await env.DB.prepare(`UPDATE ${t.table} SET status=?, data=?, updated_at=datetime('now') WHERE slug=?`)
          .bind(status, JSON.stringify(data), row.slug).run();
        await logActivity(env, sess, 'restore', type, row.slug, row.name);
        return jsonResponse({ ok: true, slug: row.slug, status });
      }

      // ---- admin: permanently purge a soft-deleted page ----
      // Only removes rows already in the 'deleted' state, so a page can never be
      // hard-deleted without first passing through the recoverable trash.
      if (path === '/api/admin/purge') {
        const b = await request.json().catch(() => ({}));
        const type = String(b.type || '');
        const t = CONTENT[type];
        if (!t) return jsonResponse({ error: 'Unknown type' }, { status: 400 });
        let row = await getEntityRow(env, type, String(b.slug || ''));
        if (!row && type === 'collection') row = await findCollectionRow(env, String(b.slug || ''));
        if (!row) return jsonResponse({ error: 'Not found' }, { status: 404 });
        if (row.status !== 'deleted') return jsonResponse({ error: 'Purge only removes already-deleted pages. Delete it first.' }, { status: 400 });
        await env.DB.prepare(`DELETE FROM ${t.table} WHERE slug=?`).bind(row.slug).run();
        // A purged page is gone for good — drop its version history too.
        try {
          await env.DB.prepare('DELETE FROM revisions WHERE entity_type=? AND slug=?').bind(type, row.slug).run();
        } catch { /* revisions table may not exist yet */ }
        await logActivity(env, sess, 'purge', type, row.slug, row.name);
        return jsonResponse({ ok: true, slug: row.slug });
      }

      // ---- admin: roll a page back to an earlier revision ----
      // Body: {type, slug, id} where id is a revision id from
      // /api/admin/revisions. The current version is snapshotted first, so a
      // rollback can itself be rolled back. Publish status and ownership are
      // left as they are — only the page content moves.
      if (path === '/api/admin/rollback') {
        const b = await request.json().catch(() => ({}));
        const type = String(b.type || '');
        const t = CONTENT[type];
        if (!t) return jsonResponse({ error: 'Unknown type' }, { status: 400 });
        let row = await getEntityRow(env, type, String(b.slug || ''));
        if (!row && type === 'collection') row = await findCollectionRow(env, String(b.slug || ''));
        if (!row) return jsonResponse({ error: 'Not found' }, { status: 404 });
        if (row.status === 'deleted') {
          return jsonResponse({ error: 'That page is in the trash. Restore it from Deleted Content first, then roll it back.' }, { status: 400 });
        }
        await ensureRevisionsTable(env);
        const rev = await env.DB.prepare(
          'SELECT id, ts, data FROM revisions WHERE id=? AND entity_type=? AND slug=?'
        ).bind(parseInt(b.id, 10) || 0, type, row.slug).first();
        if (!rev) return jsonResponse({ error: 'No such revision for that page.' }, { status: 404 });
        let d;
        try { d = JSON.parse(rev.data); } catch { d = null; }
        if (!d) return jsonResponse({ error: 'That revision is corrupt and cannot be restored.' }, { status: 500 });
        delete d._deleted;
        await saveRevision(env, sess, type, row); // make the rollback undoable
        if (type === 'character') {
          if (!d.name || !d.team) return jsonResponse({ error: 'That revision is missing required fields.' }, { status: 500 });
          await env.DB.prepare(
            `UPDATE characters SET name=?, team=?, creator=?, tags=?, appears_in=?, data=?, updated_at=datetime('now') WHERE slug=?`
          ).bind(d.name, d.team, d.creator || null, d.tags || null, d.appearsIn || null, JSON.stringify(d), row.slug).run();
        } else if (type === 'collection') {
          await env.DB.prepare(
            `UPDATE collections SET display_name=?, data=?, updated_at=datetime('now') WHERE slug=?`
          ).bind(d.displayName || row.name || row.slug, JSON.stringify(d), row.slug).run();
        } else {
          await env.DB.prepare(
            `UPDATE scripts SET name=?, author=?, data=?, updated_at=datetime('now') WHERE slug=?`
          ).bind(d.name || row.slug, d.author || null, JSON.stringify(d), row.slug).run();
        }
        await logActivity(env, sess, 'rollback', type, row.slug, d.name || d.displayName || row.name);
        return jsonResponse({ ok: true, slug: row.slug, restoredFrom: rev.ts });
      }

      // ---- admin: assign (or clear) a page's owner ----
      // Body: {type: 'character'|'collection'|'script', slug, username|null}.
      // Lets seeded pages (owner_id NULL) be claimed for their creators.
      if (path === '/api/admin/assign-owner') {
        const b = await request.json().catch(() => ({}));
        const type = String(b.type || '');
        const t = CONTENT[type];
        if (!t) return jsonResponse({ error: 'Unknown type' }, { status: 400 });
        let row = await getEntityRow(env, type, String(b.slug || ''));
        if (!row && type === 'collection') row = await findCollectionRow(env, String(b.slug || ''));
        if (!row) return jsonResponse({ error: 'Not found' }, { status: 404 });
        let ownerId = null;
        const uname = String(b.username || '').trim();
        if (uname) {
          const u = await env.DB.prepare('SELECT id, username FROM users WHERE lower(username)=lower(?)')
            .bind(uname).first();
          if (!u) return jsonResponse({ error: 'No user named "' + uname + '".' }, { status: 404 });
          ownerId = u.id;
        }
        await env.DB.prepare(`UPDATE ${t.table} SET owner_id=?, updated_at=datetime('now') WHERE slug=?`)
          .bind(ownerId, row.slug).run();
        await logActivity(env, sess, 'assign-owner', type, row.slug, row.name);
        return jsonResponse({ ok: true, slug: row.slug, owner: uname || null });
      }

      // ---- admin: wiki lock ----
      if (path === '/api/lock') {
        const body = await request.json().catch(() => ({}));
        const locked = body.locked ? '1' : '0';
        await env.DB.prepare(
          `INSERT INTO settings (key,value) VALUES ('wiki_locked',?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value`
        ).bind(locked).run();
        await logActivity(env, sess, locked === '1' ? 'lock' : 'unlock', 'wiki', null, null);
        return jsonResponse({ ok: true, locked: locked === '1' });
      }

      // ---- admin: run a D1 -> R2 backup right now ----
      if (path === '/api/backup') {
        try {
          const result = await runBackup(env);
          await logActivity(env, sess, 'backup', 'wiki', null, result.date);
          return jsonResponse({ ok: true, ...result });
        } catch (e) {
          return jsonResponse({ error: (e && e.message) || 'Backup failed.' }, { status: 500 });
        }
      }

      // ---- admin: one-time seed ----
      if (path === '/api/seed') {
        // Safety: refuse if data already exists (prevents accidental overwrite)
        const existing = await env.DB.prepare('SELECT COUNT(*) AS n FROM characters').first();
        if (existing && existing.n > 0) {
          return jsonResponse({ error: 'Database already has ' + existing.n + ' characters. Seed aborted to protect data.' }, { status: 409 });
        }
        // Read the JSON files from static assets (already in the repo)
        const origin = new URL(request.url).origin;
        async function loadJSON(file) {
          const res = await env.ASSETS.fetch(new Request(origin + '/' + file));
          if (!res.ok) throw new Error('Could not read ' + file);
          return res.json();
        }
        const [chars, cols, scripts] = await Promise.all([
          loadJSON('characters.json'),
          loadJSON('collections.json'),
          loadJSON('scripts.json')
        ]);
        // Insert everything, owned by the admin (sess.userId)
        const stmts = [];
        for (const c of chars) {
          stmts.push(env.DB.prepare(
            "INSERT OR REPLACE INTO characters (slug,name,team,creator,owner_id,tags,appears_in,data,created_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'))"
          ).bind(c.slug, c.name, c.team, c.creator || null, sess.userId, c.tags || null, c.appearsIn || null, JSON.stringify(c)));
        }
        for (const c of cols) {
          stmts.push(env.DB.prepare(
            "INSERT OR REPLACE INTO collections (slug,display_name,owner_id,data,created_at) VALUES (?,?,?,?,datetime('now'))"
          ).bind(c.slug, c.displayName || c.slug, sess.userId, JSON.stringify(c)));
        }
        for (const s of scripts) {
          stmts.push(env.DB.prepare(
            "INSERT OR REPLACE INTO scripts (slug,name,author,owner_id,data,created_at) VALUES (?,?,?,?,datetime('now'))"
          ).bind(s.slug, s.name || s.slug, s.author || null, sess.userId, JSON.stringify(s)));
        }
        await env.DB.batch(stmts);
        return jsonResponse({ ok: true, characters: chars.length, collections: cols.length, scripts: scripts.length });
      }

      // ---- contact the admins (bug reports, suggestions, anything) ----
      if (path === '/api/contact') {
        if (await rateLimited(env, request, 'contact', 5, 3600)) {
          return jsonResponse({ error: 'Too many messages in a row. Try again in a bit.' }, { status: 429 });
        }
        const b = await request.json().catch(() => ({}));
        const category = ['bug', 'suggestion', 'question', 'other'].includes(b.category) ? b.category : 'other';
        const body = String(b.body || '').trim().slice(0, 2000);
        if (body.length < 5) return jsonResponse({ error: 'Please write a message first.' }, { status: 400 });
        await ensureMessagesTable(env);
        let uname = null;
        try {
          const u = await env.DB.prepare('SELECT username FROM users WHERE id=?').bind(sess.userId).first();
          uname = u ? u.username : null;
        } catch { /* non-fatal */ }
        await env.DB.prepare(
          'INSERT INTO messages (user_id, username, category, body) VALUES (?,?,?,?)'
        ).bind(sess.userId, uname, category, body).run();
        await logActivity(env, sess, 'contact', 'message', null, category);
        return jsonResponse({ ok: true, message: 'Message sent — the admins will see it on their dashboard.' });
      }

      // ---- direct messages: send ----
      if (path === '/api/messages/send') {
        if (acctFlags.banned) {
          return jsonResponse({ error: 'This account is suspended and cannot send messages. You can contact the admins from your account page.' }, { status: 403 });
        }
        if (await rateLimited(env, request, 'dm', 20, 300)) {
          return jsonResponse({ error: 'You are sending messages very quickly — wait a minute and try again.' }, { status: 429 });
        }
        const b = await request.json().catch(() => ({}));
        const to = String(b.to || '').trim();
        const body = String(b.body || '').trim().slice(0, 3000);
        if (!to) return jsonResponse({ error: 'Missing recipient.' }, { status: 400 });
        if (!body) return jsonResponse({ error: 'Write a message first.' }, { status: 400 });
        await ensureDmTables(env);
        const target = await findUserByUsername(env, to);
        if (!target) return jsonResponse({ error: 'No user is named “' + to + '”.' }, { status: 404 });
        if (target.id === sess.userId) return jsonResponse({ error: "You can't message yourself." }, { status: 400 });
        // Blocks stop regular users; admins bypass them so the admin <-> user
        // channel (warnings, appeals) always works.
        if (!sess.isAdmin) {
          const blocked = await env.DB.prepare(
            'SELECT 1 FROM dm_blocks WHERE user_id=? AND blocked_id=?'
          ).bind(target.id, sess.userId).first();
          if (blocked) return jsonResponse({ error: 'This user is not accepting messages from you.' }, { status: 403 });
        }
        const ins = await env.DB.prepare(
          'INSERT INTO dms (sender_id, recipient_id, body) VALUES (?,?,?)'
        ).bind(sess.userId, target.id, body).run();
        return jsonResponse({ ok: true, id: ins.meta.last_row_id });
      }

      // ---- direct messages: block / unblock a user ----
      if (path === '/api/messages/block') {
        const b = await request.json().catch(() => ({}));
        await ensureDmTables(env);
        const target = await findUserByUsername(env, String(b.user || '').trim());
        if (!target) return jsonResponse({ error: 'No such user.' }, { status: 404 });
        if (target.id === sess.userId) return jsonResponse({ error: "You can't block yourself." }, { status: 400 });
        if (b.blocked) {
          await env.DB.prepare('INSERT OR IGNORE INTO dm_blocks (user_id, blocked_id) VALUES (?,?)')
            .bind(sess.userId, target.id).run();
        } else {
          await env.DB.prepare('DELETE FROM dm_blocks WHERE user_id=? AND blocked_id=?')
            .bind(sess.userId, target.id).run();
        }
        return jsonResponse({ ok: true, blocked: !!b.blocked });
      }

      // ---- direct messages: hide a whole conversation for yourself ----
      // The other person keeps their copy; rows hidden by both sides are
      // permanently purged.
      if (path === '/api/messages/delete') {
        const b = await request.json().catch(() => ({}));
        await ensureDmTables(env);
        const target = await findUserByUsername(env, String(b.with || '').trim());
        if (!target) return jsonResponse({ error: 'No such user.' }, { status: 404 });
        await env.DB.batch([
          env.DB.prepare('UPDATE dms SET sender_deleted=1 WHERE sender_id=? AND recipient_id=?')
            .bind(sess.userId, target.id),
          env.DB.prepare('UPDATE dms SET recipient_deleted=1 WHERE recipient_id=? AND sender_id=?')
            .bind(sess.userId, target.id),
          env.DB.prepare('DELETE FROM dms WHERE sender_deleted=1 AND recipient_deleted=1')
        ]);
        return jsonResponse({ ok: true });
      }

      // ---- direct messages: report a conversation to the admins ----
      // Creating a report is what unlocks the conversation for admin review
      // (GET /api/admin/dm-thread refuses un-reported pairs).
      if (path === '/api/messages/report') {
        if (await rateLimited(env, request, 'dmreport', 5, 3600)) {
          return jsonResponse({ error: 'Too many reports in a row. Try again later.' }, { status: 429 });
        }
        const b = await request.json().catch(() => ({}));
        await ensureDmTables(env);
        const target = await findUserByUsername(env, String(b.with || '').trim());
        if (!target) return jsonResponse({ error: 'No such user.' }, { status: 404 });
        if (target.id === sess.userId) return jsonResponse({ error: "You can't report yourself." }, { status: 400 });
        const convo = await env.DB.prepare(
          `SELECT 1 FROM dms
           WHERE (sender_id=?1 AND recipient_id=?2 AND sender_deleted=0)
              OR (sender_id=?2 AND recipient_id=?1 AND recipient_deleted=0)
           LIMIT 1`
        ).bind(sess.userId, target.id).first();
        if (!convo) return jsonResponse({ error: 'There are no messages with this user to report.' }, { status: 400 });
        const already = await env.DB.prepare(
          "SELECT 1 FROM dm_reports WHERE reporter_id=? AND reported_id=? AND status='open'"
        ).bind(sess.userId, target.id).first();
        if (!already) {
          const reason = String(b.reason || '').trim().slice(0, 500) || null;
          await env.DB.prepare(
            'INSERT INTO dm_reports (reporter_id, reported_id, reason) VALUES (?,?,?)'
          ).bind(sess.userId, target.id, reason).run();
          await logActivity(env, sess, 'report', 'dm', null, target.username);
        }
        return jsonResponse({ ok: true, message: 'Reported. The admins can now review this conversation.' });
      }

      // ---- admin: manage a user (ban/unban/promote/demote/reset link) ----
      if (path === '/api/admin/user') {
        await ensureBanColumn(env);
        const b = await request.json().catch(() => ({}));
        const action = String(b.action || '');
        const target = await env.DB.prepare(
          'SELECT id, username, is_admin, COALESCE(banned,0) AS banned FROM users WHERE id=?'
        ).bind(parseInt(b.id, 10) || 0).first();
        if (!target) return jsonResponse({ error: 'No such user.' }, { status: 404 });
        if (target.id === sess.userId && (action === 'ban' || action === 'demote')) {
          return jsonResponse({ error: "You can't " + (action === 'ban' ? 'ban' : 'demote') + ' your own account.' }, { status: 400 });
        }
        if (action === 'ban') {
          if (target.is_admin) return jsonResponse({ error: 'Admins cannot be banned. Remove admin first.' }, { status: 400 });
          await env.DB.prepare('UPDATE users SET banned=1 WHERE id=?').bind(target.id).run();
          await logActivity(env, sess, 'ban', 'user', null, target.username);
        } else if (action === 'unban') {
          await env.DB.prepare('UPDATE users SET banned=0 WHERE id=?').bind(target.id).run();
          await logActivity(env, sess, 'unban', 'user', null, target.username);
        } else if (action === 'promote') {
          await env.DB.prepare('UPDATE users SET is_admin=1, banned=0 WHERE id=?').bind(target.id).run();
          await logActivity(env, sess, 'promote', 'user', null, target.username);
        } else if (action === 'demote') {
          await env.DB.prepare('UPDATE users SET is_admin=0 WHERE id=?').bind(target.id).run();
          await logActivity(env, sess, 'demote', 'user', null, target.username);
        } else if (action === 'reset-link') {
          // One-time password reset link (24 h) the admin can hand to the
          // user directly — works even when email isn't configured.
          const token = randomToken();
          await env.SESSIONS.put('pwreset:' + token, String(target.id), { expirationTtl: 86400 });
          await logActivity(env, sess, 'reset-link', 'user', null, target.username);
          return jsonResponse({ ok: true, resetLink: url.origin + '/reset-password?token=' + token });
        } else {
          return jsonResponse({ error: 'Unknown action.' }, { status: 400 });
        }
        return jsonResponse({ ok: true });
      }

      // ---- admin: inbox message actions ----
      if (path === '/api/admin/message') {
        await ensureMessagesTable(env);
        const b = await request.json().catch(() => ({}));
        const id = parseInt(b.id, 10) || 0;
        const action = String(b.action || '');
        if (action === 'delete') {
          await env.DB.prepare('DELETE FROM messages WHERE id=?').bind(id).run();
        } else if (action === 'resolve' || action === 'reopen') {
          await env.DB.prepare('UPDATE messages SET status=? WHERE id=?')
            .bind(action === 'resolve' ? 'resolved' : 'open', id).run();
        } else {
          return jsonResponse({ error: 'Unknown action.' }, { status: 400 });
        }
        return jsonResponse({ ok: true });
      }

      // ---- admin: resolve/reopen/delete a reported DM conversation ----
      if (path === '/api/admin/dm-report') {
        await ensureDmTables(env);
        const b = await request.json().catch(() => ({}));
        const id = parseInt(b.id, 10) || 0;
        const action = String(b.action || '');
        if (action === 'delete') {
          await env.DB.prepare('DELETE FROM dm_reports WHERE id=?').bind(id).run();
        } else if (action === 'resolve' || action === 'reopen') {
          await env.DB.prepare('UPDATE dm_reports SET status=? WHERE id=?')
            .bind(action === 'resolve' ? 'resolved' : 'open', id).run();
        } else {
          return jsonResponse({ error: 'Unknown action.' }, { status: 400 });
        }
        return jsonResponse({ ok: true });
      }

      // ---- admin: protect / unprotect one page ----
      if (path === '/api/admin/protect') {
        const b = await request.json().catch(() => ({}));
        const type = String(b.type || '');
        if (!CONTENT[type]) return jsonResponse({ error: 'Unknown type' }, { status: 400 });
        let row = await getEntityRow(env, type, String(b.slug || ''));
        if (!row && type === 'collection') row = await findCollectionRow(env, String(b.slug || ''));
        if (!row) return jsonResponse({ error: 'Not found' }, { status: 404 });
        if (b.protected) {
          await env.DB.prepare(
            `INSERT INTO settings (key,value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value='1'`
          ).bind(protectKey(type, row.slug)).run();
          await logActivity(env, sess, 'protect', type, row.slug, row.name);
        } else {
          await env.DB.prepare('DELETE FROM settings WHERE key=?').bind(protectKey(type, row.slug)).run();
          await logActivity(env, sess, 'unprotect', type, row.slug, row.name);
        }
        return jsonResponse({ ok: true, slug: row.slug, protected: !!b.protected });
      }

      // ---- admin: site-wide announcement banner ----
      if (path === '/api/admin/announce') {
        const b = await request.json().catch(() => ({}));
        const text = String(b.text || '').trim().slice(0, 300);
        if (!text) {
          await env.DB.prepare("DELETE FROM settings WHERE key='announcement'").run();
          await logActivity(env, sess, 'announce', 'wiki', null, 'cleared');
          return jsonResponse({ ok: true, announcement: null });
        }
        let by = null;
        try {
          const u = await env.DB.prepare('SELECT username FROM users WHERE id=?').bind(sess.userId).first();
          by = u ? u.username : null;
        } catch { /* non-fatal */ }
        const ann = { text, at: new Date().toISOString(), by };
        await env.DB.prepare(
          `INSERT INTO settings (key,value) VALUES ('announcement',?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value`
        ).bind(JSON.stringify(ann)).run();
        await logActivity(env, sess, 'announce', 'wiki', null, text.slice(0, 60));
        return jsonResponse({ ok: true, announcement: ann });
      }

      // ---- admin: delete orphaned images picked from /api/admin/orphans ----
      if (path === '/api/admin/purge-images') {
        if (!env.ART) return jsonResponse({ error: 'Image storage (R2) is not configured' }, { status: 500 });
        const b = await request.json().catch(() => ({}));
        const keys = (Array.isArray(b.keys) ? b.keys : []).slice(0, 100).filter(k =>
          typeof k === 'string' && !k.includes('..') &&
          ['art/', 'scripts/', 'collections/', 'avatars/'].some(p => k.startsWith(p))
        );
        if (!keys.length) return jsonResponse({ error: 'No image keys given.' }, { status: 400 });
        for (const k of keys) {
          try { await env.ART.delete(k); } catch { /* best-effort */ }
        }
        await logActivity(env, sess, 'purge-images', 'wiki', null, keys.length + ' images');
        return jsonResponse({ ok: true, deleted: keys.length });
      }

      // ---- admin: strip broken character refs from one script/collection ----
      if (path === '/api/admin/clean-refs') {
        const b = await request.json().catch(() => ({}));
        const type = String(b.type || '');
        if (type !== 'script' && type !== 'collection') return jsonResponse({ error: 'Unknown type' }, { status: 400 });
        let row = await getEntityRow(env, type, String(b.slug || ''));
        if (!row && type === 'collection') row = await findCollectionRow(env, String(b.slug || ''));
        if (!row) return jsonResponse({ error: 'Not found' }, { status: 404 });
        const rm = new Set((Array.isArray(b.remove) ? b.remove : []).map(String));
        if (!rm.size) return jsonResponse({ error: 'Nothing to remove.' }, { status: 400 });
        let d;
        try { d = JSON.parse(row.data); } catch { return jsonResponse({ error: 'Page data is corrupt.' }, { status: 500 }); }
        await saveRevision(env, sess, type, row);
        let removed = 0;
        function strip(list) {
          const before = (list || []).length;
          const out = (list || []).filter(s => !rm.has(String(s)));
          removed += before - out.length;
          return out;
        }
        if (type === 'script') {
          d.characters = strip(d.characters);
          await env.DB.prepare(`UPDATE scripts SET data=?, updated_at=datetime('now') WHERE slug=?`)
            .bind(JSON.stringify(d), row.slug).run();
        } else {
          d.include = strip(d.include);
          d.exclude = strip(d.exclude);
          await env.DB.prepare(`UPDATE collections SET data=?, updated_at=datetime('now') WHERE slug=?`)
            .bind(JSON.stringify(d), row.slug).run();
        }
        await logActivity(env, sess, 'clean-refs', type, row.slug, row.name);
        return jsonResponse({ ok: true, slug: row.slug, removed });
      }

      // ---- admin: restore one page from a nightly backup ----
      // The current version (if any) is snapshotted to history first. Also
      // recovers pages that were purged — the row is re-created.
      if (path === '/api/admin/restore-page') {
        if (!env.ART) return jsonResponse({ error: 'Image storage (R2) is not configured' }, { status: 500 });
        const b = await request.json().catch(() => ({}));
        const type = String(b.type || '');
        const t = CONTENT[type];
        if (!t) return jsonResponse({ error: 'Unknown type' }, { status: 400 });
        const date = String(b.date || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return jsonResponse({ error: 'Bad backup date.' }, { status: 400 });
        const obj = await env.ART.get(`backups/${date}/${t.table}.json`);
        if (!obj) return jsonResponse({ error: 'No backup of ' + t.table + ' for ' + date + '.' }, { status: 404 });
        let rows;
        try { rows = await obj.json(); } catch { return jsonResponse({ error: 'That backup file is corrupt.' }, { status: 500 }); }
        const want = String(b.slug || '');
        const hit = (rows || []).find(r => r && r.slug === want) ||
                    (rows || []).find(r => r && String(r.slug).toLowerCase() === want.toLowerCase());
        if (!hit) return jsonResponse({ error: 'No page with that slug in the ' + date + ' backup.' }, { status: 404 });
        const current = await getEntityRow(env, type, hit.slug);
        if (current) await saveRevision(env, sess, type, current);
        const status = ['published', 'draft', 'deleted'].includes(hit.status) ? hit.status : 'published';
        if (type === 'character') {
          await env.DB.prepare(
            `INSERT INTO characters (slug,name,team,creator,owner_id,tags,appears_in,data,status,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,COALESCE(?,datetime('now')),datetime('now'))
             ON CONFLICT(slug) DO UPDATE SET
               name=excluded.name, team=excluded.team, creator=excluded.creator,
               owner_id=excluded.owner_id, tags=excluded.tags, appears_in=excluded.appears_in,
               data=excluded.data, status=excluded.status, updated_at=datetime('now')`
          ).bind(hit.slug, hit.name, hit.team, hit.creator || null, hit.owner_id || null,
                 hit.tags || null, hit.appears_in || null, hit.data, status, hit.created_at || null).run();
        } else if (type === 'collection') {
          await env.DB.prepare(
            `INSERT INTO collections (slug,display_name,owner_id,data,status,created_at,updated_at)
             VALUES (?,?,?,?,?,COALESCE(?,datetime('now')),datetime('now'))
             ON CONFLICT(slug) DO UPDATE SET
               display_name=excluded.display_name, owner_id=excluded.owner_id,
               data=excluded.data, status=excluded.status, updated_at=datetime('now')`
          ).bind(hit.slug, hit.display_name || hit.slug, hit.owner_id || null, hit.data, status, hit.created_at || null).run();
        } else {
          await env.DB.prepare(
            `INSERT INTO scripts (slug,name,author,owner_id,data,status,created_at,updated_at)
             VALUES (?,?,?,?,?,?,COALESCE(?,datetime('now')),datetime('now'))
             ON CONFLICT(slug) DO UPDATE SET
               name=excluded.name, author=excluded.author, owner_id=excluded.owner_id,
               data=excluded.data, status=excluded.status, updated_at=datetime('now')`
          ).bind(hit.slug, hit.name || hit.slug, hit.author || null, hit.owner_id || null, hit.data, status, hit.created_at || null).run();
        }
        await logActivity(env, sess, 'restore-backup', type, hit.slug, hit.name || hit.display_name || hit.slug);
        return jsonResponse({ ok: true, slug: hit.slug, status, date });
      }

      // ---- admin: bulk actions across many pages ----
      // Body: {action, type, slugs[], username?, tag?}. Actions: publish,
      // unpublish, delete, restore, assign-owner, clear-owner, add-tag,
      // remove-tag (tags are characters only).
      if (path === '/api/admin/bulk') {
        const b = await request.json().catch(() => ({}));
        const type = String(b.type || '');
        const t = CONTENT[type];
        if (!t) return jsonResponse({ error: 'Unknown type' }, { status: 400 });
        const action = String(b.action || '');
        const ACTIONS = ['publish', 'unpublish', 'delete', 'restore', 'assign-owner', 'clear-owner', 'add-tag', 'remove-tag'];
        if (!ACTIONS.includes(action)) return jsonResponse({ error: 'Unknown action.' }, { status: 400 });
        const slugs = (Array.isArray(b.slugs) ? b.slugs : []).slice(0, 200).map(String);
        if (!slugs.length) return jsonResponse({ error: 'No pages selected.' }, { status: 400 });
        let ownerId = null;
        if (action === 'assign-owner') {
          const u = await env.DB.prepare('SELECT id FROM users WHERE lower(username)=lower(?)')
            .bind(String(b.username || '').trim()).first();
          if (!u) return jsonResponse({ error: 'No user named "' + String(b.username || '') + '".' }, { status: 404 });
          ownerId = u.id;
        }
        const tag = String(b.tag || '').trim().slice(0, 40);
        if ((action === 'add-tag' || action === 'remove-tag')) {
          if (type !== 'character') return jsonResponse({ error: 'Tags only apply to characters.' }, { status: 400 });
          if (!tag) return jsonResponse({ error: 'Enter a tag first.' }, { status: 400 });
        }
        let adminName = null;
        try {
          const u = await env.DB.prepare('SELECT username FROM users WHERE id=?').bind(sess.userId).first();
          adminName = u ? u.username : null;
        } catch { /* non-fatal */ }
        let done = 0;
        const failed = [];
        for (const slug of slugs) {
          try {
            let row = await getEntityRow(env, type, slug);
            if (!row && type === 'collection') row = await findCollectionRow(env, slug);
            if (!row) { failed.push(slug); continue; }
            if (action === 'publish' || action === 'unpublish') {
              if (row.status === 'deleted') { failed.push(slug); continue; }
              await env.DB.prepare(`UPDATE ${t.table} SET status=?, updated_at=datetime('now') WHERE slug=?`)
                .bind(action === 'publish' ? 'published' : 'draft', row.slug).run();
            } else if (action === 'delete') {
              if (row.status === 'deleted') { done++; continue; }
              let data; try { data = JSON.parse(row.data); } catch { data = {}; }
              data._deleted = { at: new Date().toISOString(), by: adminName, from: row.status || 'published' };
              await env.DB.prepare(`UPDATE ${t.table} SET status='deleted', data=?, updated_at=datetime('now') WHERE slug=?`)
                .bind(JSON.stringify(data), row.slug).run();
            } else if (action === 'restore') {
              if (row.status !== 'deleted') { done++; continue; }
              let data; try { data = JSON.parse(row.data); } catch { data = {}; }
              const from = (data._deleted && data._deleted.from) || 'published';
              delete data._deleted;
              await env.DB.prepare(`UPDATE ${t.table} SET status=?, data=?, updated_at=datetime('now') WHERE slug=?`)
                .bind(from === 'draft' ? 'draft' : 'published', JSON.stringify(data), row.slug).run();
            } else if (action === 'assign-owner' || action === 'clear-owner') {
              await env.DB.prepare(`UPDATE ${t.table} SET owner_id=?, updated_at=datetime('now') WHERE slug=?`)
                .bind(action === 'assign-owner' ? ownerId : null, row.slug).run();
            } else {
              // add-tag / remove-tag: tags are a comma-separated string kept
              // in both the indexed column and the data JSON.
              let d; try { d = JSON.parse(row.data); } catch { failed.push(slug); continue; }
              const tags = String(d.tags || '').split(',').map(s => s.trim()).filter(Boolean);
              const has = tags.some(x => x.toLowerCase() === tag.toLowerCase());
              let next = tags;
              if (action === 'add-tag' && !has) next = tags.concat([tag]);
              if (action === 'remove-tag') next = tags.filter(x => x.toLowerCase() !== tag.toLowerCase());
              const joined = next.join(', ');
              if (joined !== String(d.tags || '')) {
                await saveRevision(env, sess, 'character', row);
                d.tags = joined;
                await env.DB.prepare(`UPDATE characters SET tags=?, data=?, updated_at=datetime('now') WHERE slug=?`)
                  .bind(joined || null, JSON.stringify(d), row.slug).run();
              }
            }
            done++;
          } catch { failed.push(slug); }
        }
        await logActivity(env, sess, 'bulk-' + action, type, null, done + ' page' + (done === 1 ? '' : 's'));
        return jsonResponse({ ok: true, done, failed });
      }

      return jsonResponse({ error: 'Unknown endpoint' }, { status: 404 });
    }

    // ---------- STATIC ASSETS (pass through to Pages) ----------
    // env.ASSETS is the static site binding (Cloudflare Pages / Workers Assets)
    return env.ASSETS.fetch(request);
  },

  // Nightly cron (see [triggers] in wrangler.toml): back up D1 to R2, and
  // prune page-view analytics older than 180 days.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBackup(env));
    ctx.waitUntil(
      env.DB.prepare("DELETE FROM page_views WHERE day < date('now', '-180 day')").run().catch(() => {})
    );
  }
};
