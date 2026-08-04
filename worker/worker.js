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
 *     ?drafts=1               -> ADMINS ONLY: also includes draft rows, each
 *                                stamped with `status`. Non-admins asking for
 *                                it get the ordinary published-only feed.
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
 *   -- comments (character / collection / script / news pages) --
 *   GET  /api/comments        -> a page's comments (?type=&slug=; public)
 *   POST /api/comments        -> post a comment or reply ({parentId} to reply;
 *                                {agree:true} carries the first-time agreement)
 *   POST /api/comments/agree  -> record the one-time comment-terms agreement
 *   POST /api/comments/delete -> remove one (author, page owner, or admin)
 *   POST /api/comments/pin    -> pin/unpin a thread (page owner or admin)
 *   POST /api/comments/report -> report one to the admins
 *
 *   -- news (admin-written articles) --
 *   GET  /api/news            -> published articles (?limit=, admin ?drafts=1)
 *   GET  /api/news/item       -> one article (?slug=; drafts admin-only)
 *   GET  /news/{slug}         -> article page (server-side rendered, comments)
 *   POST /api/admin/news      -> create/update/delete an article
 *
 *   -- custom wiki pages (text-first pages under a script/collection) --
 *   GET  /api/wiki-pages      -> pages under one parent (?parentType=&parentSlug=)
 *                                or everything one author wrote (?author=)
 *   GET  /api/wiki-page       -> one page for editing (?slug=; drafts incl.)
 *   POST /api/wiki-page       -> create/update/delete one ({action:'delete'})
 *   GET  /p/{slug}            -> the page itself (SSR, noindex, comments).
 *                                Deliberately unlisted: no sitemap entry, no
 *                                search, no browse list — only the parent
 *                                script/collection page and its author's page
 *                                link to it.
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
 *   GET  /api/user            -> creator page data (?u=username or ?a=creator
 *                                name): owned + credited pages, drafts for the
 *                                owner/admins
 *   GET  /api/creators        -> every creator with counts + linked account
 *   GET  /u/{username}        -> creator page (serves profile.html)
 *   GET  /author?a={name}     -> same page; 302 to /u/{username} when the name
 *                                belongs to an account
 *   POST /api/admin/creator-alias -> admin: link a creator name to an account
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
 *   GET  /api/admin/pages     -> page list for bulk actions
 *                                (?type=&q=&owner=&status=&flag=no-icon|partial|starlight|no-owner)
 *   POST /api/admin/bulk      -> bulk publish/unpublish/delete/owner/tag/starlight ops
 *   GET  /api/admin/analytics -> most-viewed pages for the last ?days=N days
 *   GET  /api/admin/comments  -> moderation queue (?view=reported|recent|removed)
 *   POST /api/admin/comment   -> remove/restore/resolve/purge one comment
 *   POST /api/admin/starlight -> grant/remove Starlight on one page
 *   POST /api/admin/demote-no-icon -> sweep published no-icon characters to draft
 *   POST /api/admin/cleanup-odyssey -> ONE-TIME: em dashes + gendered pronouns
 *                                      in the Odyssey almanacs. Remove after use.
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
// Partial / Standard / Starlight rules — shared with every browser page so
// the badges and filters agree with what the Worker serves.
import Classify from '../assets/classify.js';
// Lets render.js emit the Starlight star without importing classify.js
// itself (it is loaded standalone in the browser).
Render.setStarMark(Classify.classBadgeHTML);
// Wiki text engine: the markdown-ish formatter + the text-first page layout,
// shared by /p/{slug} pages, news articles and the announcement banner.
import WikiRender from '../assets/render-wiki.js';
// News article renderer (also used by the /news index and the admin editor
// preview in the browser). It formats text through render-wiki.js.
import NewsRender from '../assets/render-news.js';
NewsRender.init(WikiRender);
// One-time text cleanup for the Odyssey almanacs, driving
// POST /api/admin/cleanup-odyssey (the "Clean up Odyssey text" dashboard card).
// Lives in migration/ (in .assetsignore) so it is never served as a static file.
// Delete this import, the route and the card once the cleanup has been run.
import OdysseyCleanup from '../migration/odyssey-cleanup.js';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const APP_NAME = 'BOTC Homebrew Wiki';

const R2_PREFIXES = ['art/', 'collections/', 'scripts/', 'tokens/', 'pages/', 'news/'];
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
// Every content type that can carry comments. `news` and `wikipage` are not
// in CONTENT (they have their own tables and handlers) but readers can comment
// on both.
const COMMENTABLE = ['character', 'collection', 'script', 'news', 'wikipage'];

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

// ---- comments (character / collection / script / news pages) ----
// One flat thread per page — no nesting, which keeps the mobile layout
// readable and the moderation model simple. Removing a comment sets
// status='removed' rather than deleting the row, so an admin can undo a
// mistaken removal from the dashboard.
const COMMENT_MAX = 2000;
// Bumping this re-prompts everyone with the "be respectful" agreement.
const COMMENT_TERMS_VERSION = '1';
let _commentsReady = false;
async function ensureCommentTables(env) {
  if (_commentsReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS comments (
       id          INTEGER PRIMARY KEY AUTOINCREMENT,
       ts          TEXT NOT NULL DEFAULT (datetime('now')),
       entity_type TEXT NOT NULL,
       slug        TEXT NOT NULL,
       user_id     INTEGER NOT NULL,
       body        TEXT NOT NULL,
       status      TEXT NOT NULL DEFAULT 'visible',
       removed_by  TEXT,
       removed_at  TEXT
     )`
  ).run();
  await env.DB.prepare(
    'CREATE INDEX IF NOT EXISTS idx_comments_page ON comments(entity_type, slug, id)'
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS comment_reports (
       id          INTEGER PRIMARY KEY AUTOINCREMENT,
       ts          TEXT NOT NULL DEFAULT (datetime('now')),
       comment_id  INTEGER NOT NULL,
       reporter_id INTEGER NOT NULL,
       reason      TEXT,
       status      TEXT NOT NULL DEFAULT 'open'
     )`
  ).run();
  // Which version of the comment terms this account has agreed to.
  try { await env.DB.prepare('ALTER TABLE users ADD COLUMN comment_terms TEXT').run(); }
  catch { /* already there */ }
  // Threading + pinning, added after the table shipped flat — lazily ALTERed
  // like users.banned so there is still nothing to migrate by hand.
  // parent_id is NULL for a top-level comment and never points at another
  // reply: threads are exactly one level deep (see the flattening in
  // POST /api/comments), which keeps them readable on a phone.
  try { await env.DB.prepare('ALTER TABLE comments ADD COLUMN parent_id INTEGER').run(); }
  catch { /* already there */ }
  try { await env.DB.prepare('ALTER TABLE comments ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0').run(); }
  catch { /* already there */ }
  _commentsReady = true;
}

// Removing a top-level comment has to take its replies with it, or the page
// shows answers to a question nobody can see. The replies get status
// 'hidden' rather than 'removed' so restoring the parent brings back exactly
// those, and never a reply an admin removed on its own merits.
async function removeCommentCascade(env, row, by) {
  await env.DB.prepare(
    "UPDATE comments SET status='removed', pinned=0, removed_by=?, removed_at=datetime('now') WHERE id=?"
  ).bind(by, row.id).run();
  if (!row.parent_id) {
    await env.DB.prepare(
      "UPDATE comments SET status='hidden' WHERE parent_id=? AND status='visible'"
    ).bind(row.id).run();
  }
}
async function restoreCommentCascade(env, row) {
  await env.DB.prepare(
    "UPDATE comments SET status='visible', removed_by=NULL, removed_at=NULL WHERE id=?"
  ).bind(row.id).run();
  if (!row.parent_id) {
    await env.DB.prepare(
      "UPDATE comments SET status='visible' WHERE parent_id=? AND status='hidden'"
    ).bind(row.id).run();
  }
}

// ---- news articles (admin-written, /news + /news/{slug}) ----
// Same hybrid shape as the content tables: a few indexed columns plus the
// whole article as JSON in `data`, so new article fields never need a
// migration. Created lazily on first use like revisions/dms.
let _newsReady = false;
async function ensureNewsTable(env) {
  if (_newsReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS news (
       slug         TEXT PRIMARY KEY,
       title        TEXT NOT NULL,
       owner_id     INTEGER,
       data         TEXT NOT NULL,
       status       TEXT NOT NULL DEFAULT 'draft',
       created_at   TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
       published_at TEXT
     )`
  ).run();
  await env.DB.prepare(
    'CREATE INDEX IF NOT EXISTS idx_news_status ON news(status, published_at)'
  ).run();
  _newsReady = true;
}

// ---- custom wiki pages (text-first pages hanging off a script/collection) ----
// A page belongs to exactly one script or collection and is reachable ONLY
// from that parent page and from its author's page — never from search, the
// homepage, the browse lists or the sitemap. Same hybrid shape as everything
// else: indexed columns for the lookups plus the whole page as JSON in `data`.
let _pagesReady = false;
async function ensurePagesTable(env) {
  if (_pagesReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS pages (
       slug        TEXT PRIMARY KEY,
       title       TEXT NOT NULL,
       parent_type TEXT NOT NULL,
       parent_slug TEXT NOT NULL,
       author      TEXT,
       owner_id    INTEGER,
       data        TEXT NOT NULL,
       status      TEXT NOT NULL DEFAULT 'draft',
       created_at  TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
     )`
  ).run();
  await env.DB.prepare(
    'CREATE INDEX IF NOT EXISTS idx_pages_parent ON pages(parent_type, parent_slug, status)'
  ).run();
  await env.DB.prepare(
    'CREATE INDEX IF NOT EXISTS idx_pages_owner ON pages(owner_id)'
  ).run();
  _pagesReady = true;
}

// The parent script/collection row a wiki page hangs off, resolved the same
// way the SSR routes resolve it (collections may be addressed by kebab id).
async function wikiParentRow(env, type, key) {
  if (type === 'collection') {
    const row = await findCollectionRow(env, key);
    if (!row) return null;
    const d = parseData(row);
    return { type, slug: row.slug, key: d.id || row.slug, name: row.name || d.displayName || row.slug, ownerId: row.owner_id, status: row.status };
  }
  if (type !== 'script') return null;
  const row = await getEntityRow(env, 'script', key);
  if (!row) return null;
  return { type, slug: row.slug, key: row.slug, name: row.name || row.slug, ownerId: row.owner_id, status: row.status };
}

// Name -> slug map so [[Snake Charmer]] in page text becomes a real link.
// Only the indexed columns are read, so this stays cheap even at 1000 rows.
async function loadCharLinks(env) {
  const map = {};
  try {
    const { results } = await env.DB.prepare(
      "SELECT slug, name FROM characters WHERE status='published'"
    ).all();
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    for (const r of results || []) {
      if (r.slug) map[norm(r.slug)] = r.slug;
      if (r.name) map[norm(r.name)] = r.slug;
    }
  } catch { /* links just fall back to token pills */ }
  return map;
}

// Custom side boxes — the {title, content} widget shared by character,
// script, collection, wiki and news pages. Text only; the renderer escapes it.
const BOX_MAX = 24;
function sanitizeBoxes(boxes) {
  if (!Array.isArray(boxes)) return [];
  return boxes.slice(0, BOX_MAX).map(b => ({
    title: String((b && b.title) || '').slice(0, 120),
    content: String((b && b.content) || '').slice(0, 4000)
  })).filter(b => b.title.trim() || b.content.trim());
}

// The fact box on a wiki page / news article: a title, an image and rows.
function sanitizeInfobox(info) {
  if (!info || typeof info !== 'object') return null;
  const out = {
    title: String(info.title || '').slice(0, 80),
    image: typeof info.image === 'string' ? info.image.slice(0, 300) : '',
    rows: Array.isArray(info.rows)
      ? info.rows.slice(0, 20).map(r => ({
          label: String((r && r.label) || '').slice(0, 60),
          value: String((r && r.value) || '').slice(0, 300)
        })).filter(r => r.label.trim() || r.value.trim())
      : []
  };
  if (out.image && !WikiRender.safeImg(out.image, '')) out.image = '';
  if (!out.title && !out.image && !out.rows.length) return null;
  return out;
}

// Pages a parent script/collection carries. Drafts are only ever included
// for someone allowed to see them (the owner, or an admin).
async function listWikiPages(env, parentType, parentSlug, opts = {}) {
  await ensurePagesTable(env);
  const where = opts.includeDrafts
    ? "status IN ('published','draft')"
    : "status='published'";
  const { results } = await env.DB.prepare(
    `SELECT slug, title, status, author, data, updated_at FROM pages
     WHERE parent_type=? AND parent_slug=? AND ${where}
     ORDER BY status='draft', created_at`
  ).bind(parentType, parentSlug).all().catch(() => ({ results: [] }));
  return (results || []).map(r => {
    const d = parseData(r);
    return {
      slug: r.slug, title: r.title, status: r.status,
      author: r.author || d.author || null,
      blurb: d.blurb || WikiRender.autoSummary(d.body, 140),
      updatedAt: r.updated_at
    };
  });
}

// Find the page a comment is aimed at and work out who may moderate it.
// Returns null when the page doesn't exist or isn't publicly visible.
async function commentTarget(env, type, slug) {
  if (!COMMENTABLE.includes(type) || !slug) return null;
  if (type === 'wikipage') {
    await ensurePagesTable(env);
    const row = await env.DB.prepare('SELECT slug, title AS name, status, owner_id, data FROM pages WHERE slug=?')
      .bind(slug).first().catch(() => null);
    if (!row || row.status !== 'published') return null;
    if (parseData(row).comments === false) return null;
    return { slug: row.slug, name: row.name, ownerId: row.owner_id, type };
  }
  if (type === 'news') {
    await ensureNewsTable(env);
    const row = await env.DB.prepare('SELECT slug, title AS name, status, owner_id FROM news WHERE slug=?')
      .bind(slug).first().catch(() => null);
    if (!row || row.status !== 'published') return null;
    return { slug: row.slug, name: row.name, ownerId: row.owner_id, type };
  }
  let row = await getEntityRow(env, type, slug);
  if (!row && type === 'collection') row = await findCollectionRow(env, slug);
  if (!row || row.status !== 'published') return null;
  return { slug: row.slug, name: row.name, ownerId: row.owner_id, type };
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

// Extra profile bits (links + pinned pages) live in one JSON column rather than
// a column each — the same hybrid design the content tables use, so adding a
// field later never needs a migration. Created lazily like the ban column.
let _profileColReady = false;
async function ensureProfileColumn(env) {
  if (_profileColReady) return;
  try {
    await env.DB.prepare('ALTER TABLE users ADD COLUMN profile_json TEXT').run();
  } catch { /* column already exists */ }
  _profileColReady = true;
}

const PROFILE_LINK_KEYS = ['website', 'discord', 'bluesky', 'other'];
const PROFILE_URL_RE = /^https?:\/\/[^\s<>"']{3,300}$/i;
// Validate what a user typed into their profile settings. Links are http(s)
// only (Discord is a handle, not a URL); pinned pages are checked against what
// the account actually owns by the caller, not here.
function sanitizeProfileExtra(input) {
  const out = { links: {}, pinned: [] };
  const links = (input && typeof input.links === 'object' && input.links) || {};
  for (const k of PROFILE_LINK_KEYS) {
    let v = String(links[k] == null ? '' : links[k]).trim().slice(0, 300);
    if (!v) continue;
    if (k === 'discord') {
      // A handle, not a link: strip a leading @ and keep it plain text.
      v = v.replace(/^@+/, '').slice(0, 40);
      if (v) out.links.discord = v;
      continue;
    }
    if (PROFILE_URL_RE.test(v)) out.links[k] = v;
  }
  const pinned = Array.isArray(input && input.pinned) ? input.pinned : [];
  for (const p of pinned.slice(0, 12)) {
    const type = String((p && p.type) || '');
    const slug = String((p && p.slug) || '').slice(0, 80);
    if (!CONTENT[type] || !slug) continue;
    if (out.pinned.some(x => x.type === type && x.slug === slug)) continue;
    out.pinned.push({ type, slug });
    if (out.pinned.length >= 3) break;   // three is the whole point of pinning
  }
  return out;
}
function parseProfileExtra(row) {
  let x = null;
  try { x = row && row.profile_json ? JSON.parse(row.profile_json) : null; } catch { x = null; }
  return {
    links: (x && x.links && typeof x.links === 'object') ? x.links : {},
    pinned: Array.isArray(x && x.pinned) ? x.pinned : []
  };
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

// ---- creator identity: which free-text "Creator" names belong to an account ----
// A page's Creator field is free text ("Hystrex"); an account is a row in users.
// Half the wiki was bulk-imported with a creator string and no account at all,
// so the two can never be the same thing — but the creator page and the profile
// page are one page now (/u/{username}, /author?a=Name), and it needs to know
// when a name and an account are the same person.
//
// A name is linked to an account when EITHER:
//   1. proof by ownership — the account already owns a page credited to that
//      name. Publishing under a name is the proof, so registering the username
//      "Hystrex" is not enough to inherit Hystrex's forty characters.
//   2. an admin said so — a settings row, key creator_alias:{lower(name)}, value
//      = the username (an empty value pins the name as deliberately unlinked).
//      This is what covers bulk-imported pages, which have owner_id NULL and so
//      can never prove anything. The override always wins.
// Nothing here is stored on the pages themselves, so it all stays correct as
// pages change hands.
function creatorAliasKey(name) {
  return 'creator_alias:' + String(name || '').trim().toLowerCase();
}
function normCreator(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

// A credit can name several people — "Taiyi (太一), Saki" — and each of them
// gets their own creator page, so matching one name against the whole column
// has to compare a single comma-separated segment at a time. Normalising the
// spaces around the commas lets instr() do exact segment matching; instr and
// not LIKE, because a name is free text and may contain % or _.
function creditMatchSQL(col) {
  return `instr(',' || replace(replace(lower(trim(${col})), ' ,', ','), ', ', ',') || ',', ',' || ? || ',') > 0`;
}
// The same test against a list of names: one bind per name.
function creditAnySQL(col, n) {
  const one = creditMatchSQL(col);
  return '(' + new Array(n).fill(one).join(' OR ') + ')';
}
// Credit string -> the individual names in it, lower-cased.
function creditNames(s) {
  return Creators.splitCreators(s).map(normCreator).filter(Boolean);
}
// How a name is actually spelled on the pages that credit it, so an unclaimed
// creator page shows "Ma'ayan" rather than whatever casing the link carried.
function creditSpelling(name, ...rowSets) {
  const want = normCreator(name);
  if (!want) return '';
  for (const rows of rowSets) {
    for (const r of rows || []) {
      const d = parseData(r);
      for (const n of Creators.splitCreators(d.creator || d.author)) {
        if (normCreator(n) === want) return n.trim();
      }
    }
  }
  return '';
}

// A creator name -> the user row that owns it, or null when nobody does.
async function resolveCreatorAccount(env, name) {
  const key = normCreator(name);
  if (!key) return null;
  try {
    const alias = await env.DB.prepare('SELECT value FROM settings WHERE key=?')
      .bind(creatorAliasKey(key)).first();
    if (alias) {
      // An alias row with an empty value means "this name has no account" —
      // an admin's way of overruling a wrong ownership match.
      if (!alias.value) return null;
      return await env.DB.prepare(
        'SELECT id, username, display_name, bio, avatar_url, created_at FROM users WHERE lower(username)=lower(?)'
      ).bind(alias.value).first();
    }
  } catch { /* settings table unreachable -> fall through to ownership */ }
  // Proof by ownership: whoever owns the most PUBLISHED pages credited to this
  // name. Published matters — a draft is invisible to everyone but its owner,
  // so counting drafts would let anyone claim any name by saving an unpublished
  // page credited to it. Ties break on the lowest user id; an admin alias is
  // how you settle a genuine clash between two people using the same handle.
  try {
    const hit = await env.DB.prepare(
      `SELECT owner_id, COUNT(*) AS n FROM characters
        WHERE owner_id IS NOT NULL AND status='published' AND ${creditMatchSQL('creator')}
        GROUP BY owner_id ORDER BY n DESC, owner_id ASC LIMIT 1`
    ).bind(key).first();
    let ownerId = hit && hit.owner_id;
    if (!ownerId) {
      const s = await env.DB.prepare(
        `SELECT owner_id, COUNT(*) AS n FROM scripts
          WHERE owner_id IS NOT NULL AND status='published' AND ${creditMatchSQL('author')}
          GROUP BY owner_id ORDER BY n DESC, owner_id ASC LIMIT 1`
      ).bind(key).first();
      ownerId = s && s.owner_id;
    }
    if (!ownerId) return null;
    return await env.DB.prepare(
      'SELECT id, username, display_name, bio, avatar_url, created_at FROM users WHERE id=?'
    ).bind(ownerId).first();
  } catch { return null; }
}

// An account -> every creator name it has published under (proof by ownership),
// plus any name an admin has pointed at it. Lower-cased for comparison; the
// display spelling comes off the pages themselves.
async function creatorNamesFor(env, userId, username) {
  const names = new Set();
  try {
    // Published only, for the same reason resolveCreatorAccount insists on it:
    // a draft nobody else can see must not be able to claim a name.
    const [chars, scripts] = await Promise.all([
      env.DB.prepare(`SELECT DISTINCT creator AS n FROM characters WHERE owner_id=? AND status='published'`).bind(userId).all(),
      env.DB.prepare(`SELECT DISTINCT author AS n FROM scripts WHERE owner_id=? AND status='published'`).bind(userId).all()
    ]);
    // Split each credit: co-authoring a page claims the name you were credited
    // under, not the whole "Taiyi (太一), Saki" string.
    for (const r of [...(chars.results || []), ...(scripts.results || [])]) {
      for (const n of creditNames(r.n)) names.add(n);
    }
  } catch { /* leave whatever we got */ }
  try {
    const { results } = await env.DB.prepare(
      `SELECT key, value FROM settings WHERE key LIKE 'creator_alias:%'`
    ).all();
    for (const r of results || []) {
      const n = String(r.key).slice('creator_alias:'.length);
      if (!n) continue;
      // The alias is the last word on a name, in both directions: it grants the
      // name to the account it points at, and takes it off everyone else — an
      // empty value ("nobody") and a different username both un-link it here,
      // even from an account that owns published pages under it. Without this,
      // reassigning a shared handle would leave it claimed twice.
      if (normCreator(r.value) === normCreator(username)) names.add(n);
      else names.delete(n);
    }
  } catch { /* no aliases set */ }
  return [...names];
}

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

// ---- Starlight inheritance ----
// A Starlight collection lends the status to every character in it: awarding
// it to "Ravenswood Chronicle" marks all of Ravenswood's characters too, so
// the Starlight filter on All Characters shows them. Inherited status is
// never written back to the character row — it is derived on read, so
// removing Starlight from the collection takes it off the characters with
// it, and a character keeps its own flag if it was given one directly.
// `starlightFrom` records which collection lent it, for the tooltip.
async function applyCollectionStarlight(env, chars) {
  let rows;
  try {
    ({ results: rows } = await env.DB.prepare(
      "SELECT data FROM collections WHERE status='published'"
    ).all());
  } catch { return chars; }
  const starred = (rows || []).map(parseData).filter(d => d && d.starlight);
  if (!starred.length) return chars;
  for (const coll of starred) {
    const name = coll.displayName || coll.id || coll.slug || 'a collection';
    for (const c of PageRender.resolveCollectionMembers(coll, chars)) {
      if (c.starlight) continue;              // its own flag wins
      c.starlight = true;
      c.starlightFrom = name;
      c.classification = 'starlight';
    }
  }
  return chars;
}

// A row's `data` blob, or {} if the row is missing or the JSON is corrupt.
function parseData(row) {
  if (!row || !row.data) return {};
  try { return JSON.parse(row.data); } catch { return {}; }
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
  // Custom side boxes, same widget as the character editor's.
  if (o.customBoxes != null) {
    const boxes = sanitizeBoxes(o.customBoxes);
    if (boxes.length) o.customBoxes = boxes; else delete o.customBoxes;
  }
  const theme = PageRender.sanitizeTheme(o.theme, themeBase);
  if (theme) o.theme = theme; else delete o.theme;
}

// ---- validation for wiki pages (/p/{slug}) and news articles ----
// Same idea as sanitizePageFields: cap every text field, constrain images to
// the page's own R2 area, and run boxes/infobox/theme through the shared
// sanitizers. `imgBase` is the folder a page may put its own images in.
const WIKI_FIELD_CAPS = {
  title: 160, subtitle: 200, blurb: 300, author: 80, body: 60000
};
function sanitizeWikiFields(o, imgBase, themeBase) {
  for (const k of Object.keys(WIKI_FIELD_CAPS)) {
    if (o[k] != null) o[k] = String(o[k]).slice(0, WIKI_FIELD_CAPS[k]);
  }
  if (o.body != null) o.body = String(o.body).replace(/\r\n/g, '\n');
  // The banner sits in this page's own image slot, or nowhere.
  if (o.header != null) {
    const h = String(o.header);
    const ok = h === '' || (h.indexOf(imgBase) === 0 && h.indexOf('..') === -1 &&
      /^[a-z0-9/._ -]+\.(png|jpe?g|webp)$/i.test(h));
    o.header = ok ? h : '';
  }
  // Images the author uploaded for this page, so the editor can list them
  // again. Only this page's own slots, never someone else's.
  o.images = Array.isArray(o.images)
    ? o.images.slice(0, 40).map(x => String(x))
        .filter(s => s.indexOf(imgBase) === 0 && s.indexOf('..') === -1 &&
                     /^[a-z0-9/._ -]+\.(png|jpe?g|webp)$/i.test(s))
    : [];
  o.boxes = sanitizeBoxes(o.boxes);
  const info = sanitizeInfobox(o.infobox);
  if (info) o.infobox = info; else delete o.infobox;
  o.toc = o.toc !== false;
  o.comments = o.comments !== false;
  const theme = PageRender.sanitizeTheme(o.theme, themeBase);
  if (theme) o.theme = theme; else delete o.theme;
}

// ---- build the three JSON files from D1 (published pages only) ----
// `opts.includeDrafts` adds draft rows and stamps each row's `status`, for the
// admin-only ?drafts=1 form of the JSON feeds. Soft-deleted rows are never
// included either way — recovery is the dashboard's job.
async function buildPublicJSON(env, table, opts = {}) {
  const drafts = !!opts.includeDrafts;
  const where = drafts ? "status IN ('published','draft')" : "status='published'";
  let results;
  try {
    ({ results } = await env.DB.prepare(`SELECT data, status FROM ${table} WHERE ${where}`).all());
  } catch {
    // status column not migrated yet -> serve everything (legacy behaviour)
    ({ results } = await env.DB.prepare(`SELECT data FROM ${table}`).all());
  }
  const type = table === 'characters' ? 'character'
    : table === 'collections' ? 'collection' : 'script';
  const out = results.map(r => {
    const d = JSON.parse(r.data);
    // Only the admin feed carries status; the public one must never imply
    // that unpublished pages exist.
    if (drafts) d.status = r.status || 'published';
    // clean URLs: stored page paths end in .html, but the site serves them
    // extensionless now — strip it so every consumer links the clean form
    if (typeof d.page === 'string') d.page = d.page.replace(/\.html$/, '');
    // Partial/Standard/Starlight is derived here rather than stored, so a
    // page re-classifies itself the moment its owner adds a tag or a line of
    // almanac text. `starlight` is the only stored half (admin-set).
    // Standard is the default everywhere, so it is left off the wire —
    // characters.json is ~1000 entries and the repetition is not free.
    if (d.starlight) d.starlight = true; else delete d.starlight;
    const cls = Classify.classifyPage(d, type);
    if (cls !== 'standard') d.classification = cls;
    else delete d.classification;
    return d;
  });
  // Characters pick up Starlight from any Starlight collection they belong to.
  if (table === 'characters') await applyCollectionStarlight(env, out);
  return out;
}

// ---- D1 -> R2 backup (nightly cron + POST /api/backup) ----
// Dumps every content table to backups/{YYYY-MM-DD}/{table}.json in the ART
// bucket. backups/ is not in R2_PREFIXES, so the files are never publicly
// servable through /assets/. Keeps 30 days of snapshots.
async function runBackup(env) {
  if (!env.ART) throw new Error('R2 bucket (ART binding) is not configured.');
  const stamp = new Date().toISOString().slice(0, 10);
  const tables = ['characters', 'collections', 'scripts', 'pages', 'news', 'users', 'activity_log', 'settings', 'revisions', 'messages', 'page_views', 'dms', 'dm_blocks', 'dm_reports', 'comments', 'comment_reports'];
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
  //     bodyStyle, mainClass, mainStyle, bootstrap, scripts[], draftBanner,
  //     noindex}
  // `noindex` keeps a page out of search engines — used by the custom wiki
  // pages, which are reachable only from their parent page and their author's.
  // The nav row is identical on every page (built into the shell below);
  // site.js appends Tools + the Account/Login button, and moves the
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
${o.noindex ? '<meta name="robots" content="noindex, nofollow">\n' : ''}<link rel="canonical" href="${attr(o.canonicalUrl)}">
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
    <nav class="crumb" aria-label="Primary">
      <a href="../all-characters">All Characters</a>
      <a href="../scripts">Scripts</a>
      <a href="../all-collections">Collections</a>
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
  <a href="../all-collections">Collections</a>
  <a href="../script">Script Builder</a>
</nav>

  <main${mainAttrs} id="content">${o.body}</main>

  <p class="foot">Fan-made content for <em>Blood on the Clocktower</em> &middot; Not affiliated with The Pandemonium Institute</p>

  <script>${o.bootstrap || ''}</script>
${(o.scripts || []).map(s => '  <script src="../assets/' + s + '"></script>').join('\n')}
</body>
</html>`;
}

// The "this page is Partial" nudge. Only ever rendered for someone who can
// edit the page (owner or admin) — a reader has no use for it, and the wiki
// does not advertise which pages its authors haven't finished.
function partialNoticeHTML(d) {
  const missing = Classify.missingBits(d)
    .map(b => b === 'almanac' ? 'almanac text or night order' : b);
  const still = missing.length
    ? ' Still missing: ' + escapeHtml(missing.join(', ')) + '.'
    : '';
  return '<div class="page-notice page-notice-partial" role="status">' +
    '<strong>Only you and the admins can see this.</strong> ' +
    'This page counts as <em>Partial</em> — it has an ability, but no tags, no ' +
    'almanac text and no mechanics (night order, reminder tokens, setup, jinxes), ' +
    'so it stays hidden from All Characters, the tag pages and the homepage unless ' +
    'a reader turns on the “Show Partial” filter.' + still +
    ' One tag or one line of almanac text is enough to fix it. ' +
    '<a href="../edit?c=' + attr(d.slug) + '">Edit this page &rarr;</a></div>';
}

// The creator page is one static file (profile.html) served under two paths:
// /u/{username} and /author?a=Name. It reads the key off location itself.
async function serveProfileShell(env, request, url) {
  const res = await env.ASSETS.fetch(new Request(url.origin + '/profile.html'));
  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' }
  });
}

function renderCharacterPage(d, origin, isDraft, showPartialNotice) {
  const name = d.name || 'Character';
  const desc = (d.ability || d.lede || '').trim();
  const pageUrl = origin + '/c/' + d.slug;
  const imgRaw = Array.isArray(d.image) ? d.image[0] : d.image;
  const img = imgRaw || (origin + '/assets/' + (d.art || ''));
  // bulk-imported characters may only have a remote image URL, no local art
  const artSrc = d.art ? '../assets/' + d.art : (imgRaw || '');
  // Stamped here too (not just in characters.json) so the Starlight star in
  // the info box is right on a page reached directly.
  d.classification = Classify.classifyCharacter(d);
  const body = Render.renderCharacter(d, artSrc, '../');
  const draftBanner = (isDraft
    ? '<div style="background:#7a5c18;color:#f7ecd0;text-align:center;padding:10px 16px;font-family:\'TradeGothicLT\',\'Libre Franklin\',sans-serif;letter-spacing:.04em">DRAFT — only you (and admins) can see this page. Publish it from your <a href="../account" style="color:#ffe9ad">account page</a> or the editor.</div>'
    : '') + (showPartialNotice ? partialNoticeHTML(d) : '');
  return pageShell({
    title: name, desc, canonicalUrl: pageUrl, ogImage: img, ogCard: 'summary',
    body, draftBanner,
    bootstrap: `window.SSR = true; window.LINK_ROOT = '../'; window.CHAR_SLUG = ${JSON.stringify(d.slug)};` +
      ` window.PAGE_TYPE = 'character'; window.PAGE_SLUG = ${JSON.stringify(d.slug)};`,
    scripts: ['render.js', 'tags.js', 'charpage.js', 'comments.js', 'site.js']
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

  // One session read serves both the draft check and the "may this reader see
  // draft wiki pages / the new-page button" check further down.
  const pageSess = await getSession(env, request);
  const mayEditParent = canEditRow(pageSess, row);
  const isDraft = row.status === 'draft';
  if (isDraft && !mayEditParent) return env.ASSETS.fetch(request); // 404 for everyone else
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

  // Custom wiki pages hanging off this script/collection. They live nowhere
  // else on the site, so this list is the only way in (besides the author's
  // page). Drafts show only to whoever may edit them.
  const wikiPages = await listWikiPages(env, type, row.slug || slug, { includeDrafts: mayEditParent });
  const pagesHTML = WikiRender.renderPageLinks(wikiPages, { linkRoot: '../' });
  // [[Character Name]] inside a custom box links to that character.
  const linkMap = {};
  const nkey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  for (const c of chars) {
    if (c.slug) linkMap[nkey(c.slug)] = c.slug;
    if (c.name) linkMap[nkey(c.name)] = c.slug;
  }
  WikiRender.setCharLinks(linkMap);
  const boxesHTML = WikiRender.renderBoxes(d.customBoxes, { linkRoot: '../' });
  const pageKey = isScript ? d.slug : (d.id || d.slug);
  const newPageHref = mayEditParent
    ? '../publish-page?parentType=' + encodeURIComponent(type) + '&parentSlug=' + encodeURIComponent(pageKey)
    : '';

  const body = isScript
    ? PageRender.renderScriptPage(d, chars, { linkRoot: '../', isDraft, pagesHTML, boxesHTML, newPageHref })
    : PageRender.renderCollectionPage(d, chars, { linkRoot: '../', isDraft, pagesHTML, boxesHTML, newPageHref });

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
      ? ['render.js', 'pageview.js', 'comments.js', 'site.js']
      : ['render.js', 'pageview.js', 'card-filters.js', 'comments.js', 'site.js']
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
    // ?drafts=1 includes unpublished pages, for admins only. Anyone else
    // asking for it silently gets the ordinary published-only feed rather
    // than an error, so a stale bookmark or a logged-out admin can never be
    // told that drafts exist. Every one of these responses is `no-store`
    // (jsonResponse), so a cache can't hand an admin's copy to a visitor.
    if (method === 'GET' && (path === '/characters.json' || path === '/collections.json' || path === '/scripts.json')) {
      const table = path === '/characters.json' ? 'characters'
        : path === '/collections.json' ? 'collections' : 'scripts';
      const wantsDrafts = url.searchParams.get('drafts') === '1';
      const includeDrafts = wantsDrafts && !!(await adminSession(env, request));
      return jsonResponse(await buildPublicJSON(env, table, { includeDrafts }));
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

    // ---------- NEWS ----------
    // Public list. ?limit=N for the homepage panel; admins can add
    // ?drafts=1 to see unpublished articles in the editor's list.
    if (method === 'GET' && path === '/api/news') {
      await ensureNewsTable(env);
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '30', 10) || 30, 1), 100);
      let includeDrafts = false;
      if (url.searchParams.get('drafts') === '1') {
        includeDrafts = !!(await adminSession(env, request));
      }
      const { results } = await env.DB.prepare(
        includeDrafts
          ? `SELECT slug, title, status, published_at, updated_at, data FROM news
             ORDER BY COALESCE(published_at, updated_at) DESC LIMIT ?`
          : `SELECT slug, title, status, published_at, updated_at, data FROM news
             WHERE status='published' ORDER BY published_at DESC LIMIT ?`
      ).bind(limit).all().catch(() => ({ results: [] }));
      return jsonResponse({
        articles: (results || []).map(r => {
          const d = parseData(r);
          return {
            slug: r.slug, title: r.title, status: r.status,
            publishedAt: r.published_at, updatedAt: r.updated_at,
            author: d.author || null,
            summary: d.summary || NewsRender.autoSummary(d.body, 160),
            image: d.image || null,
            // Body is only sent on the single-article route — the list stays
            // small even with a hundred long articles in it.
            pinned: !!d.pinned
          };
        })
      });
    }

    // One article as JSON. Public for published articles; the admin editor
    // uses it to load drafts too.
    if (method === 'GET' && path === '/api/news/item') {
      await ensureNewsTable(env);
      const slug = url.searchParams.get('slug') || '';
      const row = await env.DB.prepare('SELECT * FROM news WHERE slug=?').bind(slug).first().catch(() => null);
      if (!row) return jsonResponse({ error: 'Not found' }, { status: 404 });
      if (row.status !== 'published' && !(await adminSession(env, request))) {
        return jsonResponse({ error: 'Not found' }, { status: 404 });
      }
      const d = parseData(row);
      return jsonResponse({
        article: {
          ...d, slug: row.slug, title: row.title, status: row.status,
          publishedAt: row.published_at, updatedAt: row.updated_at
        }
      });
    }

    // ---------- NEWS ARTICLE PAGES (server-side rendered) ----------
    if (method === 'GET' && path.startsWith('/news/')) {
      let slug = decodeURIComponent(path.slice(6));
      if (slug.endsWith('.html')) {
        slug = slug.slice(0, -5);
        return new Response(null, {
          status: 301,
          headers: { Location: url.origin + '/news/' + slug + url.search, 'Cache-Control': 'no-store' }
        });
      }
      if (!slug || !/^[a-z0-9-]+$/i.test(slug)) return env.ASSETS.fetch(request);
      await ensureNewsTable(env);
      const row = await env.DB.prepare('SELECT * FROM news WHERE slug=?').bind(slug).first().catch(() => null);
      if (!row) return env.ASSETS.fetch(request);
      const isDraft = row.status !== 'published';
      if (isDraft && !(await adminSession(env, request))) return env.ASSETS.fetch(request);
      if (!isDraft && ctx) ctx.waitUntil(bumpView(env, request, 'news', row.slug));

      const d = parseData(row);
      const a = {
        ...d, slug: row.slug, title: row.title,
        publishedAt: row.published_at, updatedAt: row.updated_at
      };
      const desc = (a.summary || NewsRender.autoSummary(a.body, 180) ||
        'News from the BOTC Homebrew Wiki.');
      const img = a.image
        ? (/^https?:\/\//i.test(a.image) ? a.image : url.origin + '/assets/' + a.image)
        : url.origin + '/assets/logo_skull.png';
      // [[Character Name]] in an article links to that character's page.
      WikiRender.setCharLinks(await loadCharLinks(env));
      const newsTheme = PageRender.sanitizeTheme(a.theme, 'news/' + a.slug);
      const newsThemeAttrs = PageRender.themeAttrs(newsTheme, '../');
      const html = pageShell({
        title: (isDraft ? 'Draft: ' : '') + (a.title || 'News'),
        desc, canonicalUrl: url.origin + '/news/' + encodeURIComponent(a.slug),
        ogImage: img, ogCard: a.image ? 'summary_large_image' : 'summary',
        bodyClass: newsThemeAttrs.cls, bodyStyle: newsThemeAttrs.style,
        body: '<p class="news-back"><a href="../news">← All news</a></p>' +
          NewsRender.renderArticle(a, { linkRoot: '../', isDraft }),
        draftBanner: isDraft
          ? '<div style="background:#7a5c18;color:#f7ecd0;text-align:center;padding:10px 16px;font-family:\'TradeGothicLT\',\'Libre Franklin\',sans-serif;letter-spacing:.04em">DRAFT — only admins can see this article. Publish it from <a href="../publish-news?n=' + attr(encodeURIComponent(a.slug)) + '" style="color:#ffe9ad">the news editor</a>.</div>'
          : '',
        bootstrap: `window.SSR = true; window.LINK_ROOT = '../'; window.PAGE_TYPE = 'news'; window.PAGE_SLUG = ${JSON.stringify(a.slug)};`,
        scripts: ['comments.js', 'site.js']
      });
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }

    // ---------- CUSTOM WIKI PAGES ----------
    // List the pages hanging off one script/collection, or everything one
    // author has written. These pages are deliberately invisible everywhere
    // else on the wiki, so there is no "all pages" feed.
    if (method === 'GET' && path === '/api/wiki-pages') {
      await ensurePagesTable(env);
      const author = (url.searchParams.get('author') || '').trim();
      if (author) {
        // Published only — an author page is public.
        const { results } = await env.DB.prepare(
          `SELECT slug, title, parent_type, parent_slug, author, data, updated_at
           FROM pages WHERE status='published' AND lower(author)=lower(?)
           ORDER BY updated_at DESC LIMIT 200`
        ).bind(author).all().catch(() => ({ results: [] }));
        const pages = [];
        for (const r of results || []) {
          const d = parseData(r);
          const parent = await wikiParentRow(env, r.parent_type, r.parent_slug);
          // A page whose script/collection has been deleted drops out of the
          // public listings with it.
          if (parent && parent.status === 'deleted') continue;
          pages.push({
            slug: r.slug, title: r.title, author: r.author,
            blurb: d.blurb || WikiRender.autoSummary(d.body, 140),
            parentType: r.parent_type,
            parentKey: parent ? parent.key : r.parent_slug,
            parentName: parent ? parent.name : null,
            updatedAt: r.updated_at
          });
        }
        return jsonResponse({ pages });
      }
      const parentType = url.searchParams.get('parentType') || '';
      const parentKey = url.searchParams.get('parentSlug') || '';
      const parent = await wikiParentRow(env, parentType, parentKey);
      if (!parent) return jsonResponse({ error: 'Unknown parent page' }, { status: 404 });
      const sess = await getSession(env, request);
      const mayEdit = canEditRow(sess, { owner_id: parent.ownerId });
      return jsonResponse({
        parent: { type: parent.type, key: parent.key, name: parent.name },
        canEdit: mayEdit,
        pages: await listWikiPages(env, parent.type, parent.slug, { includeDrafts: mayEdit })
      });
    }

    // One wiki page as JSON — what the editor loads. Drafts are visible to
    // their owner and to admins only.
    if (method === 'GET' && path === '/api/wiki-page') {
      await ensurePagesTable(env);
      const slug = url.searchParams.get('slug') || '';
      const row = await env.DB.prepare('SELECT * FROM pages WHERE slug=?')
        .bind(slug).first().catch(() => null);
      if (!row) return jsonResponse({ error: 'Not found' }, { status: 404 });
      const sess = await getSession(env, request);
      const editable = canEditRow(sess, row);
      if (row.status !== 'published' && !editable) {
        return jsonResponse({ error: 'Not found' }, { status: 404 });
      }
      const parent = await wikiParentRow(env, row.parent_type, row.parent_slug);
      return jsonResponse({
        page: {
          ...parseData(row), slug: row.slug, title: row.title,
          parentType: row.parent_type, parentSlug: row.parent_slug,
          parentKey: parent ? parent.key : row.parent_slug,
          parentName: parent ? parent.name : null,
          author: row.author || null,
          updatedAt: row.updated_at
        },
        status: row.status, canEdit: editable
      });
    }

    // ---------- CUSTOM WIKI PAGE (server-side rendered, noindex) ----------
    if (method === 'GET' && path.startsWith('/p/')) {
      let slug = decodeURIComponent(path.slice(3));
      if (slug.endsWith('.html')) {
        slug = slug.slice(0, -5);
        return new Response(null, {
          status: 301,
          headers: { Location: url.origin + '/p/' + encodeURIComponent(slug) + url.search, 'Cache-Control': 'no-store' }
        });
      }
      if (!slug || !/^[a-z0-9-]+$/i.test(slug)) return env.ASSETS.fetch(request);
      await ensurePagesTable(env);
      const row = await env.DB.prepare('SELECT * FROM pages WHERE slug=?')
        .bind(slug).first().catch(() => null);
      if (!row) return env.ASSETS.fetch(request);
      const isDraft = row.status !== 'published';
      if (isDraft) {
        const sess = await getSession(env, request);
        if (!canEditRow(sess, row)) return env.ASSETS.fetch(request);
      }
      if (!isDraft && ctx) ctx.waitUntil(bumpView(env, request, 'wikipage', row.slug));

      const d = parseData(row);
      const parent = await wikiParentRow(env, row.parent_type, row.parent_slug);
      // A page goes down with its parent: if the script/collection it belongs
      // to has been deleted, nothing links here any more and the public
      // shouldn't reach it either. Its owner still can, so restoring the
      // parent brings everything back.
      if (parent && parent.status === 'deleted') {
        const sess = await getSession(env, request);
        if (!canEditRow(sess, row)) return env.ASSETS.fetch(request);
      }
      WikiRender.setCharLinks(await loadCharLinks(env));
      const page = {
        ...d, slug: row.slug, title: row.title,
        author: row.author || d.author || null,
        parentType: row.parent_type,
        parentKey: parent ? parent.key : row.parent_slug,
        parentName: parent ? parent.name : null,
        updatedAt: row.updated_at
      };
      const theme = PageRender.sanitizeTheme(d.theme, 'pages/' + row.slug);
      const ta = PageRender.themeAttrs(theme, '../');
      const desc = (d.blurb || d.subtitle || WikiRender.autoSummary(d.body, 180) ||
        'A page from the BOTC Homebrew Wiki.');
      const bannerImg = d.header ? WikiRender.safeImg(d.header, url.origin + '/') : '';

      const html = pageShell({
        title: (isDraft ? 'Draft: ' : '') + (row.title || 'Page'),
        desc, canonicalUrl: url.origin + '/p/' + encodeURIComponent(row.slug),
        ogImage: bannerImg || (url.origin + '/assets/logo_skull.png'),
        ogCard: bannerImg ? 'summary_large_image' : 'summary',
        // These pages are intentionally unlisted: no search engines, no
        // sitemap entry, no site search — only their parent page links here.
        noindex: true,
        bodyClass: ta.cls, bodyStyle: ta.style,
        body: WikiRender.renderWikiPage(page, { linkRoot: '../', isDraft }),
        draftBanner: isDraft
          ? '<div style="background:#7a5c18;color:#f7ecd0;text-align:center;padding:10px 16px;font-family:\'TradeGothicLT\',\'Libre Franklin\',sans-serif;letter-spacing:.04em">DRAFT — only you (and admins) can see this page. Publish it from <a href="../publish-page?p=' + attr(encodeURIComponent(row.slug)) + '" style="color:#ffe9ad">the page editor</a>.</div>'
          : '',
        bootstrap: `window.SSR = true; window.LINK_ROOT = '../'; window.WIKI_PAGE_SLUG = ${JSON.stringify(row.slug)};` +
          (d.comments === false ? '' : ` window.PAGE_TYPE = 'wikipage'; window.PAGE_SLUG = ${JSON.stringify(row.slug)};`),
        scripts: d.comments === false ? ['wikipage.js', 'site.js'] : ['wikipage.js', 'comments.js', 'site.js']
      });
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }

    // ---------- COMMENTS (public read; posting needs an account) ----------
    if (method === 'GET' && path === '/api/comments') {
      const type = url.searchParams.get('type') || '';
      const slug = url.searchParams.get('slug') || '';
      const target = await commentTarget(env, type, slug);
      if (!target) return jsonResponse({ error: 'Page not found' }, { status: 404 });
      await ensureCommentTables(env);
      // Pinned top-level comments float to the top; everything else is
      // oldest-first so a thread reads in the order it was written. Replies
      // are grouped under their parent by the client.
      const { results } = await env.DB.prepare(
        `SELECT c.id, c.ts, c.body, c.user_id, c.parent_id, c.pinned,
                u.username, u.display_name, u.avatar_url, u.is_admin
         FROM comments c LEFT JOIN users u ON u.id = c.user_id
         WHERE c.entity_type=? AND c.slug=? AND c.status='visible'
         ORDER BY c.pinned DESC, c.id ASC LIMIT 500`
      ).bind(type, target.slug).all().catch(() => ({ results: [] }));

      const sess = await getSession(env, request);
      let me = null;
      if (sess) {
        const u = await env.DB.prepare(
          'SELECT id, username, is_admin, banned, comment_terms FROM users WHERE id=?'
        ).bind(sess.userId).first().catch(() => null);
        if (u) {
          me = {
            username: u.username,
            isAdmin: !!u.is_admin,
            // Suspended accounts can read but not post.
            canComment: !u.banned,
            // Page owners moderate their own page; admins moderate everything.
            canModerate: !!u.is_admin || (target.ownerId != null && target.ownerId === u.id),
            agreed: String(u.comment_terms || '') === COMMENT_TERMS_VERSION
          };
        }
      }
      return jsonResponse({
        type, slug: target.slug,
        termsVersion: COMMENT_TERMS_VERSION,
        me,
        comments: (results || []).map(r => ({
          id: r.id, ts: r.ts, body: r.body,
          parentId: r.parent_id || null,
          pinned: !!r.pinned,
          username: r.username || '[deleted user]',
          displayName: r.display_name || r.username || '[deleted user]',
          avatarUrl: r.avatar_url || null,
          isAdmin: !!r.is_admin,
          mine: !!(sess && r.user_id === sess.userId)
        }))
      });
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
          // Two things want to know whether this viewer owns the page: the
          // draft gate and the Partial nudge. Resolve it at most once, and
          // only when one of them asks — a logged-out reader looking at a
          // finished page never pays for a session lookup.
          let editable = null;
          const canEdit = async () => {
            if (editable === null) editable = canEditRow(await getSession(env, request), row);
            return editable;
          };
          if (isDraft && !(await canEdit())) return env.ASSETS.fetch(request); // 404 for everyone else
          const d = JSON.parse(row.data);
          if (!d.slug) d.slug = slug;
          // Same Starlight inheritance the JSON feeds get, so the star on the
          // page agrees with the star in the grid it was clicked from.
          if (!d.starlight) await applyCollectionStarlight(env, [d]);
          // "This page is Partial" is shown to the people who can act on it
          // and to nobody else (see partialNoticeHTML).
          const partialNotice = Classify.isPartial(d) && await canEdit();
          if (!isDraft) ctx.waitUntil(bumpView(env, request, 'character', slug));
          Render.setOfficialIconUrls(await officialIconMap(env, url.origin));
          return new Response(renderCharacterPage(d, url.origin, isDraft, partialNotice), {
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
      // Weighted by classification: Starlight pages come up more often and
      // Partial (unfinished) pages never do. Falls back to a plain SQL
      // RANDOM() pick if the table can't be read as JSON for any reason.
      let picked = null;
      try {
        const chars = await buildPublicJSON(env, 'characters');
        picked = Classify.weightedPick(chars);
      } catch { /* fall through */ }
      let row = picked && picked.slug ? { slug: picked.slug } : null;
      if (!row) {
        try {
          row = await env.DB.prepare(
            "SELECT slug FROM characters WHERE status='published' ORDER BY RANDOM() LIMIT 1"
          ).first();
        } catch {
          row = await env.DB.prepare(
            'SELECT slug FROM characters ORDER BY RANDOM() LIMIT 1'
          ).first();
        }
      }
      const dest = row ? '/c/' + row.slug : '/all-characters';
      return new Response(null, {
        status: 302,
        headers: { Location: url.origin + dest, 'Cache-Control': 'no-store' }
      });
    }

    // ---------- CREATOR PAGE (/u/{username} and /author?a=Name) ----------
    // One page, two keys. profile.html renders both: an account profile when
    // the name belongs to somebody, and a plain creator page when it does not
    // (half the wiki was bulk-imported under names with no account behind them).
    if (method === 'GET' && path.startsWith('/u/')) return serveProfileShell(env, request, url);

    // /author?a=Name — the link every character info box, credits list and the
    // homepage creator strip already points at. When the name belongs to an
    // account it redirects to that account's canonical URL; otherwise the same
    // page renders in place. 302 and not 301: an admin can link or unlink a
    // name at any time, and a cached permanent redirect would outlive that.
    if (method === 'GET' && (path === '/author' || path === '/author.html')) {
      const who = (url.searchParams.get('a') || '').trim();
      if (path === '/author.html') {
        return new Response(null, {
          status: 301,
          headers: {
            Location: url.origin + '/author' + (who ? '?a=' + encodeURIComponent(who) : ''),
            'Cache-Control': 'no-store'
          }
        });
      }
      if (who) {
        // A D1 hiccup must not 500 a page that used to be a static file:
        // resolveCreatorAccount swallows its own errors and returns null, so
        // the worst case here is the un-redirected creator page.
        const acct = await resolveCreatorAccount(env, who);
        if (acct && acct.username) {
          return new Response(null, {
            status: 302,
            headers: {
              Location: url.origin + '/u/' + encodeURIComponent(acct.username),
              'Cache-Control': 'no-store'
            }
          });
        }
      }
      return serveProfileShell(env, request, url);
    }

    // ---------- CREATOR PAGE DATA (?u=username or ?a=creator name) ----------
    // Returns everything one person made: pages their account owns, UNION pages
    // credited to any name that account has published under. An unclaimed name
    // gets the same shape with a minimal profile and no account fields.
    if (method === 'GET' && path === '/api/user') {
      const uname = (url.searchParams.get('u') || '').trim();
      const aname = (url.searchParams.get('a') || '').trim();
      if (!uname && !aname) return jsonResponse({ error: 'Missing username' }, { status: 400 });

      let u = null;
      if (uname) {
        await ensureProfileColumn(env);
        u = await env.DB.prepare(
          'SELECT id, username, display_name, bio, avatar_url, created_at, profile_json FROM users WHERE lower(username)=lower(?)'
        ).bind(uname).first().catch(() => null);
        if (!u) {
          u = await env.DB.prepare(
            'SELECT id, username, display_name, bio, avatar_url, created_at FROM users WHERE lower(username)=lower(?)'
          ).bind(uname).first();
        }
        if (!u) return jsonResponse({ error: 'No such user' }, { status: 404 });
      } else {
        u = await resolveCreatorAccount(env, aname);
        if (u) {
          await ensureProfileColumn(env);
          const full = await env.DB.prepare('SELECT profile_json FROM users WHERE id=?')
            .bind(u.id).first().catch(() => null);
          if (full) u.profile_json = full.profile_json;
        }
      }

      // Every creator name this page covers, lower-cased for matching.
      const names = u ? await creatorNamesFor(env, u.id, u.username) : [];
      if (aname && !names.includes(normCreator(aname))) names.push(normCreator(aname));

      // Drafts are for the people who can do something about them: the owner
      // of the profile and the admins. Same rule the old author page used.
      const sess = await getSession(env, request);
      const canSeeDrafts = !!(sess && (sess.isAdmin || (u && sess.userId === u.id)));

      const statusIn = canSeeDrafts ? "('published','draft')" : "('published')";
      // owner_id OR credited-name, so a page counts either way round: one the
      // account owns but credited to somebody else, and one credited to this
      // name but owned by nobody (the bulk-imported case).
      function whereFor(nameCol) {
        const clauses = [];
        if (u) clauses.push('owner_id=?');
        if (names.length) clauses.push(creditAnySQL(nameCol, names.length));
        if (!clauses.length) return null;
        return { sql: `(${clauses.join(' OR ')}) AND status IN ${statusIn}`,
                 binds: [...(u ? [u.id] : []), ...names] };
      }
      // The PK slug comes off the row, not out of the JSON: legacy rows do not
      // all carry `slug` in their data blob, and a card with no slug is a
      // broken link.
      async function pagesFrom(table, nameCol) {
        const w = whereFor(nameCol);
        if (!w) return [];
        try {
          const { results } = await env.DB.prepare(
            `SELECT slug, data, status FROM ${table} WHERE ${w.sql} ORDER BY updated_at DESC`
          ).bind(...w.binds).all();
          return results || [];
        } catch {
          // status/updated_at not migrated on this row set — legacy fallback
          const { results } = await env.DB.prepare(
            `SELECT slug, data FROM ${table} WHERE owner_id=?`
          ).bind(u ? u.id : -1).all().catch(() => ({ results: [] }));
          return results || [];
        }
      }

      const [charRows, scriptRows] = await Promise.all([
        pagesFrom('characters', 'creator'),
        pagesFrom('scripts', 'author')
      ]);
      // Collections keep their author in the JSON blob (no column), so they are
      // filtered in JS — the same full-table read applyCollectionStarlight does.
      let collRows = [];
      try {
        const { results } = await env.DB.prepare(
          `SELECT slug, data, status, owner_id FROM collections WHERE status IN ${statusIn}`
        ).all();
        collRows = (results || []).filter(r => {
          if (u && r.owner_id === u.id) return true;
          if (!names.length) return false;
          const d = parseData(r);
          // A collection can be co-credited too.
          return creditNames(d.author).some(n => names.includes(n));
        });
      } catch { collRows = []; }

      // Trim to what a card needs. The old endpoint shipped every page's whole
      // data blob — a creator with forty characters meant a megabyte of almanac
      // prose just to draw thumbnails.
      function card(row, type) {
        const d = parseData(row);
        const status = row.status || 'published';
        const slug = row.slug || d.slug;
        const o = {
          slug, name: d.name || d.displayName || slug,
          status,
          page: typeof d.page === 'string' ? d.page.replace(/\.html$/, '') : undefined
        };
        if (type === 'character') {
          o.team = d.team || '';
          o.ability = d.ability || '';
          o.creator = d.creator || '';
          o.tags = d.tags || '';
          o.art = d.art || '';
          o.image = Array.isArray(d.image) ? d.image[0] : (d.image || '');
          o.appearsIn = d.appearsIn || '';
        } else if (type === 'script') {
          o.author = d.author || '';
          o.tagline = d.tagline || '';
          o.header = d.header || '';
          o.characters = Array.isArray(d.characters) ? d.characters.length : 0;
        } else {
          // Collection URLs use the kebab id, never the PK slug — legacy rows
          // have display-string slugs like "The Academy".
          o.id = d.id || slug;
          o.displayName = d.displayName || slug;
          o.author = d.author || '';
          o.description = d.description || '';
          o.header = d.header || '';
        }
        if (d.starlight) o.starlight = true;
        const cls = Classify.classifyPage(d, type);
        if (cls !== 'standard') o.classification = cls;
        // Partial is derived per read, and the page needs the raw ingredients
        // to explain itself in the editor's terms — but not the prose itself.
        return o;
      }

      const characters = charRows.map(r => card(r, 'character'));
      const scripts = scriptRows.map(r => card(r, 'script'));
      const collections = collRows.map(r => card(r, 'collection'));
      // A Starlight collection lends its status to its characters here too, so
      // the star on a profile card agrees with the star on the character page.
      await applyCollectionStarlight(env, characters);

      const split = list => ({
        live: list.filter(x => x.status !== 'draft'),
        drafts: list.filter(x => x.status === 'draft')
      });
      const c = split(characters), s = split(scripts), k = split(collections);

      const extra = u ? parseProfileExtra(u) : { links: {}, pinned: [] };
      // A pinned page that has since gone draft or been deleted quietly drops
      // out rather than 404-ing from somebody's profile.
      const livePins = extra.pinned.filter(p => {
        const pool = p.type === 'character' ? c.live : p.type === 'script' ? s.live : k.live;
        return pool.some(x => x.slug === p.slug);
      });

      // Custom wiki pages by this person. They are unlisted everywhere else, so
      // their creator page is one of only two ways in. Matched the same way the
      // content tables are — the account that owns them, or any creator name it
      // has claimed — so a page written under a bulk-imported credit still
      // shows up on the page for that name.
      let pages = [];
      try {
        await ensurePagesTable(env);
        const where = [];
        const binds = [];
        if (u) { where.push('owner_id=?'); binds.push(u.id); }
        if (names.length) { where.push(creditAnySQL('author', names.length)); binds.push(...names); }
        if (where.length) {
          const { results } = await env.DB.prepare(
            `SELECT slug, title, parent_type, parent_slug, data, updated_at FROM pages
             WHERE (${where.join(' OR ')}) AND status='published'
             ORDER BY updated_at DESC LIMIT 200`
          ).bind(...binds).all();
          for (const r of results || []) {
            const d = parseData(r);
            const parent = await wikiParentRow(env, r.parent_type, r.parent_slug);
            if (parent && parent.status === 'deleted') continue;
            pages.push({
              slug: r.slug, title: r.title,
              blurb: d.blurb || WikiRender.autoSummary(d.body, 140),
              parentType: r.parent_type,
              parentKey: parent ? parent.key : r.parent_slug,
              parentName: parent ? parent.name : null,
              updatedAt: r.updated_at
            });
          }
        }
      } catch { /* the creator page still works without them */ }

      return jsonResponse({
        profile: u ? {
          claimed: true,
          username: u.username,
          displayName: u.display_name || u.username,
          bio: u.bio || '',
          avatarUrl: u.avatar_url || null,
          joined: u.created_at,
          creatorNames: names,
          links: extra.links,
          pinned: livePins
        } : {
          claimed: false,
          username: null,
          // Show the spelling the pages actually use, not whatever casing came
          // in on the query string.
          displayName: creditSpelling(aname, charRows, scriptRows) || aname,
          creatorNames: names,
          links: {},
          pinned: []
        },
        characters: c.live, scripts: s.live, collections: k.live, pages,
        drafts: canSeeDrafts
          ? { characters: c.drafts, scripts: s.drafts, collections: k.drafts }
          : null
      });
    }

    // ---------- CREATOR INDEX DATA (every creator, claimed or not) ----------
    if (method === 'GET' && path === '/api/creators') {
      const tally = new Map();   // lower(name) -> {name, characters, scripts, collections}
      // One credit string can name several people; each of them gets their own
      // row here, the same way each of them gets their own creator page.
      function bump(raw, kind) {
        for (const name of Creators.splitCreators(raw)) {
          const key = normCreator(name);
          if (!key) continue;
          let row = tally.get(key);
          if (!row) { row = { name: name.trim(), characters: 0, scripts: 0, collections: 0 }; tally.set(key, row); }
          row[kind]++;
        }
      }
      try {
        const [chars, scripts, colls] = await Promise.all([
          env.DB.prepare(`SELECT creator AS n FROM characters WHERE status='published'`).all(),
          env.DB.prepare(`SELECT author AS n FROM scripts WHERE status='published'`).all(),
          env.DB.prepare(`SELECT data FROM collections WHERE status='published'`).all()
        ]);
        for (const r of chars.results || []) bump(r.n, 'characters');
        for (const r of scripts.results || []) bump(r.n, 'scripts');
        for (const r of colls.results || []) bump(parseData(r).author, 'collections');
      } catch { /* partial tally is better than none */ }

      // Attach accounts. One pass over the alias table and one over the users
      // that own published pages, rather than a resolve call per name.
      const aliases = new Map();
      try {
        const { results } = await env.DB.prepare(
          `SELECT key, value FROM settings WHERE key LIKE 'creator_alias:%'`
        ).all();
        for (const r of results || []) {
          aliases.set(String(r.key).slice('creator_alias:'.length), String(r.value || ''));
        }
      } catch { /* none set */ }
      // lower(name) -> owner_id, the account that owns the most published
      // pages credited to that name (proof by ownership, in bulk). Counted in
      // JS rather than SQL because a credit can name several people.
      const owners = new Map();
      try {
        const { results } = await env.DB.prepare(
          `SELECT creator AS n, owner_id, COUNT(*) AS c FROM characters
            WHERE owner_id IS NOT NULL AND creator IS NOT NULL AND status='published'
            GROUP BY creator, owner_id`
        ).all();
        const perName = new Map();   // name -> Map(owner_id -> count)
        for (const r of results || []) {
          for (const key of creditNames(r.n)) {
            if (!perName.has(key)) perName.set(key, new Map());
            const m = perName.get(key);
            m.set(r.owner_id, (m.get(r.owner_id) || 0) + r.c);
          }
        }
        for (const [key, m] of perName) {
          let best = null, bestN = 0;
          for (const [ownerId, n] of m) {
            if (n > bestN || (n === bestN && best != null && ownerId < best)) { best = ownerId; bestN = n; }
          }
          if (best != null) owners.set(key, best);
        }
      } catch { /* no owned pages */ }
      let users = [];
      try {
        const { results } = await env.DB.prepare(
          'SELECT id, username, display_name, avatar_url FROM users'
        ).all();
        users = results || [];
      } catch { /* users unreadable */ }
      const byId = new Map(users.map(x => [x.id, x]));
      const byName = new Map(users.map(x => [String(x.username).toLowerCase(), x]));

      const out = [];
      for (const [key, row] of tally) {
        let acct = null;
        if (aliases.has(key)) {
          const v = aliases.get(key);
          acct = v ? byName.get(v.toLowerCase()) || null : null;
        } else if (owners.has(key)) {
          acct = byId.get(owners.get(key)) || null;
        }
        out.push({
          name: row.name,
          characters: row.characters, scripts: row.scripts, collections: row.collections,
          total: row.characters + row.scripts + row.collections,
          username: acct ? acct.username : null,
          displayName: acct ? (acct.display_name || acct.username) : null,
          avatarUrl: acct ? acct.avatar_url : null
        });
      }
      out.sort((a, b) => b.total - a.total || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      return jsonResponse({ creators: out });
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
      async function pubNews() {
        try {
          await ensureNewsTable(env);
          return (await env.DB.prepare(
            `SELECT slug, updated_at FROM news WHERE status='published'`
          ).all()).results;
        } catch { return []; }
      }
      const [chars, scripts, colls, news] = await Promise.all([
        pub('characters'), pub('scripts'), pubCollections(), pubNews()
      ]);
      const staticPages = ['', 'all-characters', 'scripts', 'tags', 'creators',
        'script', 'tools', 'tokens', 'grimforge', 'mass-upload',
        'steven-approved-order', 'rules', 'news'];
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
      for (const r of news) {
        urls.push('<url><loc>' + xmlEsc(url.origin + '/news/' + encodeURIComponent(r.slug)) + '</loc>' + lastmod(r) + '</url>');
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
      await ensureProfileColumn(env);
      const batch = await env.DB.batch([
        env.DB.prepare(`SELECT username, email, is_admin, display_name, bio, profile_json, discord_id, discord_username, avatar_url, email_verified, password_hash, created_at, last_login FROM users WHERE id=?`).bind(sess.userId),
        env.DB.prepare(`SELECT slug, name, team, status, created_at, updated_at FROM characters WHERE owner_id=? AND status IS NOT 'deleted' ORDER BY updated_at DESC`).bind(sess.userId),
        env.DB.prepare(`SELECT slug, display_name AS name, status, created_at, updated_at FROM collections WHERE owner_id=? AND status IS NOT 'deleted' ORDER BY updated_at DESC`).bind(sess.userId),
        env.DB.prepare(`SELECT slug, name, status, created_at, updated_at FROM scripts WHERE owner_id=? AND status IS NOT 'deleted' ORDER BY updated_at DESC`).bind(sess.userId),
        env.DB.prepare(`SELECT ts, action, entity_type, entity_slug, entity_name FROM activity_log WHERE user_id=? ORDER BY ts DESC, id DESC LIMIT 50`).bind(sess.userId)
      ]);
      const u = batch[0].results[0];
      if (!u) return jsonResponse({ error: 'Not logged in' }, { status: 401, 'Set-Cookie': clearCookie() });
      // Custom wiki pages this account owns, drafts included — the account
      // page is where their author manages them.
      let myPages = [];
      try {
        await ensurePagesTable(env);
        const { results } = await env.DB.prepare(
          `SELECT slug, title, parent_type, parent_slug, status, created_at, updated_at
           FROM pages WHERE owner_id=? ORDER BY updated_at DESC`
        ).bind(sess.userId).all();
        myPages = (results || []).map(r => ({
          slug: r.slug, name: r.title, status: r.status,
          parentType: r.parent_type, parentSlug: r.parent_slug,
          created_at: r.created_at, updated_at: r.updated_at
        }));
      } catch { /* non-fatal */ }
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
          lastLogin: u.last_login,
          links: parseProfileExtra(u).links,
          pinned: parseProfileExtra(u).pinned
        },
        characters: batch[1].results,
        collections: batch[2].results,
        scripts: batch[3].results,
        pages: myPages,
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

    // ---------- ADMIN: COMMENT MODERATION ----------
    // ?view=reported (default) shows open reports; ?view=recent shows the
    // latest comments site-wide; ?view=removed shows what's been taken down.
    if (method === 'GET' && path === '/api/admin/comments') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });
      await ensureCommentTables(env);
      const view = url.searchParams.get('view') || 'reported';
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 200);
      const base =
        `SELECT c.id, c.ts, c.entity_type, c.slug, c.body, c.status, c.removed_by, c.removed_at,
                c.parent_id, c.pinned, u.username, u.id AS user_id
         FROM comments c LEFT JOIN users u ON u.id = c.user_id`;
      let sql, binds = [];
      if (view === 'recent') {
        sql = base + " WHERE c.status='visible' ORDER BY c.id DESC LIMIT ?";
        binds = [limit];
      } else if (view === 'removed') {
        // 'hidden' = a reply that went down with its parent, not removed on
        // its own. Shown here too so nothing is invisible to an admin.
        sql = base + " WHERE c.status IN ('removed','hidden') ORDER BY COALESCE(c.removed_at, c.ts) DESC LIMIT ?";
        binds = [limit];
      } else {
        sql = `SELECT c.id, c.ts, c.entity_type, c.slug, c.body, c.status, c.removed_by, c.removed_at,
                      c.parent_id, c.pinned, u.username, u.id AS user_id,
                      COUNT(r.id) AS reports, MAX(r.reason) AS reason
               FROM comment_reports r
               JOIN comments c ON c.id = r.comment_id
               LEFT JOIN users u ON u.id = c.user_id
               WHERE r.status='open'
               GROUP BY c.id ORDER BY MAX(r.id) DESC LIMIT ?`;
        binds = [limit];
      }
      const { results } = await env.DB.prepare(sql).bind(...binds).all().catch(() => ({ results: [] }));
      const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM comment_reports WHERE status='open'")
        .first().catch(() => ({ n: 0 }));
      return jsonResponse({ view, comments: results || [], openReports: (open && open.n) || 0 });
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
      else if (status === 'all') { /* every status, deleted included */ }
      else wh.push("p.status IS NOT 'deleted'");
      // Content flags can't be expressed in SQL (they live in the data blob),
      // so pull `data` and filter in JS. 'any' means no flag filter.
      const flag = (url.searchParams.get('flag') || '').trim();
      const { results } = await env.DB.prepare(
        `SELECT p.slug, p.${t.nameCol} AS name, p.status, p.updated_at, u.username AS owner, p.data
         FROM ${t.table} p LEFT JOIN users u ON u.id = p.owner_id
         ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''}
         ORDER BY p.updated_at DESC LIMIT 1000`
      ).bind(...binds).all();
      let pages = (results || []).map(r => {
        const d = parseData(r);
        return {
          slug: r.slug, name: r.name, status: r.status,
          updated_at: r.updated_at, owner: r.owner,
          starlight: !!d.starlight,
          classification: Classify.classifyPage(d, type),
          // "hasIcon: true" for a page that does not need one, so the
          // no-icon filter only ever surfaces pages with a real gap.
          hasIcon: type === 'character' ? (!Classify.needsIcon(d) || Classify.hasIcon(d)) : true,
          missing: type === 'character' ? Classify.missingBits(d) : []
        };
      });
      if (flag === 'no-icon') pages = pages.filter(p => !p.hasIcon);
      else if (flag === 'partial') pages = pages.filter(p => p.classification === 'partial');
      else if (flag === 'starlight') pages = pages.filter(p => p.starlight);
      else if (flag === 'no-owner') pages = pages.filter(p => !p.owner);
      return jsonResponse({ pages: pages.slice(0, 400), total: pages.length });
    }

    // ---------- ADMIN: PAGE-VIEW ANALYTICS ----------
    if (method === 'GET' && path === '/api/admin/analytics') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });
      const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '7', 10) || 7, 1), 365);
      const since = '-' + days + ' day';
      await ensureViewsTable(env);
      await ensureNewsTable(env);  // the name lookup below UNIONs both of
      await ensurePagesTable(env); // these in
      const names =
        `(SELECT 'character' AS t, slug, name FROM characters
          UNION ALL SELECT 'script', slug, name FROM scripts
          UNION ALL SELECT 'collection', slug, display_name FROM collections
          UNION ALL SELECT 'news', slug, title FROM news
          UNION ALL SELECT 'wikipage', slug, title FROM pages)`;
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
      // Posting a comment counts as a content write: a wiki locked because of
      // vandalism should not leave the comment boxes open. Removing and
      // reporting comments stay available so moderation still works.
      const isContentWrite = ['/api/character', '/api/collection', '/api/script', '/api/wiki-page', '/api/publish', '/api/delete', '/api/upload', '/api/comments'].includes(path);
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
        // Links + pinned pages ride in the same save. Only touched when the
        // client sends them, so an older form that posts name+bio alone can
        // never wipe somebody's links.
        if (b.links !== undefined || b.pinned !== undefined) {
          await ensureProfileColumn(env);
          const extra = sanitizeProfileExtra(b);
          // You can only pin your own published pages — checked here, and again
          // on read, so a page that later goes draft quietly drops off.
          const verified = [];
          for (const p of extra.pinned) {
            const t = CONTENT[p.type];
            if (!t) continue;
            const row = await env.DB.prepare(
              `SELECT slug FROM ${t.table} WHERE slug=? AND owner_id=? AND status='published'`
            ).bind(p.slug, sess.userId).first().catch(() => null);
            if (row) verified.push(p);
          }
          extra.pinned = verified;
          await env.DB.prepare('UPDATE users SET profile_json=? WHERE id=?')
            .bind(JSON.stringify(extra), sess.userId).run();
          return jsonResponse({ ok: true, links: extra.links, pinned: extra.pinned });
        }
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
          // tokens/ is reserved for admin tooling; news/ for the news editor,
          // which is admin-only anyway.
          if (key.startsWith('tokens/') || key.startsWith('news/')) {
            return jsonResponse({ error: 'Not authorized for that upload path.' }, { status: 403 });
          }
          // Wiki-page images follow pages/{page-slug}-*.{ext}. If that page
          // exists, only its owner may put images in its slot.
          if (key.startsWith('pages/')) {
            await ensurePagesTable(env);
            const base = key.slice(6).replace(/\.[a-z0-9]+$/i, '');
            // Longest matching slug wins: "my-page-header.png" belongs to the
            // page "my-page", not to a page that happens to be called "my".
            const row = await env.DB.prepare(
              "SELECT slug, owner_id FROM pages WHERE slug=? OR ? LIKE slug || '-%' ORDER BY length(slug) DESC"
            ).bind(base, base).first().catch(() => null);
            if (row && !canEditRow(sess, row)) {
              return jsonResponse({ error: 'That image slot belongs to a page owned by another account.' }, { status: 403 });
            }
          }
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

      // ---- comments ----
      // Agreeing to the comment terms. The browser also shows the modal, but
      // the server is what actually gates posting, so a first comment can
      // carry {agree:true} and be accepted in one round-trip.
      if (path === '/api/comments/agree') {
        await ensureCommentTables(env);
        await env.DB.prepare('UPDATE users SET comment_terms=? WHERE id=?')
          .bind(COMMENT_TERMS_VERSION, sess.userId).run();
        return jsonResponse({ ok: true, agreed: true });
      }

      if (path === '/api/comments') {
        if (acctFlags.banned) {
          return jsonResponse({ error: 'This account is suspended and cannot post comments.' }, { status: 403 });
        }
        if (await rateLimited(env, request, 'comment', 30, 3600)) {
          return jsonResponse({ error: 'Slow down — too many comments from this connection. Try again later.' }, { status: 429 });
        }
        const b = await request.json().catch(() => ({}));
        const type = String(b.type || '');
        const target = await commentTarget(env, type, String(b.slug || ''));
        if (!target) return jsonResponse({ error: 'That page does not exist (or is not published yet).' }, { status: 404 });
        const body = String(b.body || '').replace(/\r\n/g, '\n').trim().slice(0, COMMENT_MAX);
        if (!body) return jsonResponse({ error: 'Write something first.' }, { status: 400 });
        await ensureCommentTables(env);
        // First-time commenters must accept the terms; the client sends
        // agree:true from the modal alongside their first comment.
        const u = await env.DB.prepare('SELECT comment_terms FROM users WHERE id=?')
          .bind(sess.userId).first().catch(() => null);
        let agreed = u && String(u.comment_terms || '') === COMMENT_TERMS_VERSION;
        if (!agreed && b.agree) {
          await env.DB.prepare('UPDATE users SET comment_terms=? WHERE id=?')
            .bind(COMMENT_TERMS_VERSION, sess.userId).run();
          agreed = true;
        }
        if (!agreed) {
          return jsonResponse({
            error: 'Please agree to the comment guidelines first.',
            needsAgreement: true, termsVersion: COMMENT_TERMS_VERSION
          }, { status: 428 });
        }
        // Replying: the parent must be a visible comment on this same page.
        // Threads stay one level deep — replying to a reply attaches to that
        // reply's parent instead of nesting further.
        let parentId = null;
        if (b.parentId) {
          const parent = await env.DB.prepare(
            "SELECT id, parent_id, entity_type, slug, status FROM comments WHERE id=?"
          ).bind(parseInt(b.parentId, 10) || 0).first().catch(() => null);
          if (!parent || parent.status !== 'visible' ||
              parent.entity_type !== type || parent.slug !== target.slug) {
            return jsonResponse({ error: 'The comment you replied to is no longer there.' }, { status: 404 });
          }
          parentId = parent.parent_id || parent.id;
        }
        const res = await env.DB.prepare(
          'INSERT INTO comments (entity_type, slug, user_id, body, parent_id) VALUES (?,?,?,?,?)'
        ).bind(type, target.slug, sess.userId, body, parentId).run();
        await logActivity(env, sess, parentId ? 'comment-reply' : 'comment',
          type, target.slug, body.slice(0, 60));
        return jsonResponse({
          ok: true, id: (res.meta && res.meta.last_row_id) || null, parentId
        });
      }

      // Pin / unpin a comment — admins and the page's owner. Only top-level
      // comments can be pinned; pinning a reply pins the thread it belongs to.
      if (path === '/api/comments/pin') {
        await ensureCommentTables(env);
        const b = await request.json().catch(() => ({}));
        const id = parseInt(b.id, 10);
        if (!id) return jsonResponse({ error: 'Missing comment id.' }, { status: 400 });
        const row = await env.DB.prepare('SELECT * FROM comments WHERE id=?').bind(id).first().catch(() => null);
        if (!row || row.status !== 'visible') return jsonResponse({ error: 'Comment not found.' }, { status: 404 });
        const target = await commentTarget(env, row.entity_type, row.slug);
        const isOwner = target && target.ownerId != null && target.ownerId === sess.userId;
        if (!sess.isAdmin && !isOwner) {
          return jsonResponse({ error: 'Only the page owner and the admins can pin comments.' }, { status: 403 });
        }
        const pinId = row.parent_id || row.id;
        const on = !!b.pinned;
        await env.DB.prepare('UPDATE comments SET pinned=? WHERE id=?').bind(on ? 1 : 0, pinId).run();
        await logActivity(env, sess, on ? 'comment-pin' : 'comment-unpin',
          row.entity_type, row.slug, 'comment #' + pinId);
        return jsonResponse({ ok: true, id: pinId, pinned: on });
      }

      // Remove a comment: its author, the page's owner, or any admin.
      if (path === '/api/comments/delete') {
        await ensureCommentTables(env);
        const b = await request.json().catch(() => ({}));
        const id = parseInt(b.id, 10);
        if (!id) return jsonResponse({ error: 'Missing comment id.' }, { status: 400 });
        const row = await env.DB.prepare('SELECT * FROM comments WHERE id=?').bind(id).first().catch(() => null);
        if (!row || row.status !== 'visible') return jsonResponse({ error: 'Comment not found.' }, { status: 404 });
        const target = await commentTarget(env, row.entity_type, row.slug);
        const isOwner = target && target.ownerId != null && target.ownerId === sess.userId;
        if (!sess.isAdmin && !isOwner && row.user_id !== sess.userId) {
          return jsonResponse({ error: 'You can only remove your own comments.' }, { status: 403 });
        }
        let by = null;
        try {
          const u = await env.DB.prepare('SELECT username FROM users WHERE id=?').bind(sess.userId).first();
          by = u ? u.username : null;
        } catch { /* non-fatal */ }
        await removeCommentCascade(env, row, by);
        await logActivity(env, sess, 'comment-remove', row.entity_type, row.slug, 'comment #' + id);
        return jsonResponse({ ok: true, id });
      }

      // Report a comment to the admins (shows up in the dashboard queue).
      if (path === '/api/comments/report') {
        await ensureCommentTables(env);
        if (await rateLimited(env, request, 'comment-report', 20, 3600)) {
          return jsonResponse({ error: 'Too many reports. Try again later.' }, { status: 429 });
        }
        const b = await request.json().catch(() => ({}));
        const id = parseInt(b.id, 10);
        if (!id) return jsonResponse({ error: 'Missing comment id.' }, { status: 400 });
        const row = await env.DB.prepare('SELECT id FROM comments WHERE id=?').bind(id).first().catch(() => null);
        if (!row) return jsonResponse({ error: 'Comment not found.' }, { status: 404 });
        const already = await env.DB.prepare(
          "SELECT id FROM comment_reports WHERE comment_id=? AND reporter_id=? AND status='open'"
        ).bind(id, sess.userId).first().catch(() => null);
        if (already) return jsonResponse({ ok: true, id, already: true });
        await env.DB.prepare(
          'INSERT INTO comment_reports (comment_id, reporter_id, reason) VALUES (?,?,?)'
        ).bind(id, sess.userId, String(b.reason || '').trim().slice(0, 500) || null).run();
        return jsonResponse({ ok: true, id });
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
        let status = c.status === 'draft' ? 'draft' : 'published';
        delete c.status;
        // Starlight is admin-only: never trust the client, always carry the
        // stored value forward. /api/admin/starlight is the only way to set it.
        c.starlight = existing ? !!parseData(existing).starlight : false;
        // A character with no icon cannot go live. Publishing attempts are
        // saved as drafts instead so nothing is lost — the editor shows why.
        let iconBlocked = false;
        if (status === 'published' && Classify.needsIcon(c) && !Classify.hasIcon(c)) {
          status = 'draft';
          iconBlocked = true;
        }
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
        return jsonResponse({
          ok: true, slug: c.slug, status,
          classification: Classify.classifyCharacter(c),
          missing: Classify.missingBits(c),
          iconBlocked,
          notice: iconBlocked
            ? 'Saved as a draft: a character needs an icon before it can be published. Add one and publish again.'
            : undefined
        });
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
        // Admin-only flag: keep whatever is stored, ignore the client.
        c.starlight = existing ? !!parseData(existing).starlight : false;
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
        // Admin-only flag: keep whatever is stored, ignore the client.
        s.starlight = existing ? !!parseData(existing).starlight : false;
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

      // ---- custom wiki pages (text-first pages under a script/collection) ----
      // Who may write one: the owner of the parent script/collection, or an
      // admin. The page is then owned by whoever created it, and only they (or
      // an admin) can edit it afterwards.
      if (path === '/api/wiki-page') {
        await ensurePagesTable(env);
        const b = await request.json().catch(() => ({}));
        const kebab = s => String(s || '').toLowerCase().normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '').slice(0, 70);

        if (b.action === 'delete') {
          const row = await env.DB.prepare('SELECT * FROM pages WHERE slug=?')
            .bind(String(b.slug || '')).first().catch(() => null);
          if (!row) return jsonResponse({ error: 'Page not found.' }, { status: 404 });
          if (!canEditRow(sess, row)) return jsonResponse({ error: 'That page belongs to another account.' }, { status: 403 });
          await saveRevision(env, sess, 'wikipage', row);
          await env.DB.prepare('DELETE FROM pages WHERE slug=?').bind(row.slug).run();
          await ensureCommentTables(env);
          await env.DB.prepare("DELETE FROM comments WHERE entity_type='wikipage' AND slug=?").bind(row.slug).run();
          await logActivity(env, sess, 'delete', 'wikipage', row.slug, row.title);
          return jsonResponse({ ok: true, deleted: row.slug });
        }

        const title = String(b.title || '').trim().slice(0, 160);
        if (!title) return jsonResponse({ error: 'Give the page a title.' }, { status: 400 });
        if (!String(b.body || '').trim()) {
          return jsonResponse({ error: 'Write something in the page body first.' }, { status: 400 });
        }

        const existing = b.slug
          ? await env.DB.prepare('SELECT * FROM pages WHERE slug=?').bind(String(b.slug)).first().catch(() => null)
          : null;
        if (b.slug && !existing) return jsonResponse({ error: 'That page no longer exists.' }, { status: 404 });
        if (existing && !canEditRow(sess, existing)) {
          return jsonResponse({ error: 'That page belongs to another account.' }, { status: 403 });
        }

        // The parent never changes once a page is created — its URL and the
        // link back to it would both break.
        const parent = existing
          ? await wikiParentRow(env, existing.parent_type, existing.parent_slug)
          : await wikiParentRow(env, String(b.parentType || ''), String(b.parentSlug || ''));
        if (!parent) return jsonResponse({ error: 'That script or collection could not be found.' }, { status: 404 });
        if (!existing && !canEditRow(sess, { owner_id: parent.ownerId })) {
          return jsonResponse({ error: 'Only the owner of "' + parent.name + '" can add pages to it.' }, { status: 403 });
        }
        if (!sess.isAdmin && await isProtected(env, parent.type, parent.slug)) {
          return jsonResponse({ error: PROTECTED_MSG }, { status: 423 });
        }

        // Slug is derived from the title once, then frozen so links keep
        // working. A clash with someone else's page gets a numeric suffix.
        let slug = existing ? existing.slug : kebab(title);
        if (!slug) return jsonResponse({ error: 'Could not build a URL from that title.' }, { status: 400 });
        if (!existing) {
          const taken = async s => !!(await env.DB.prepare('SELECT 1 FROM pages WHERE slug=?')
            .bind(s).first().catch(() => null));
          let candidate = slug;
          for (let i = 2; i < 60 && await taken(candidate); i++) candidate = slug + '-' + i;
          // The upsert below would overwrite an existing page, so never save
          // onto a slug that is still taken — ask for a different title first.
          if (await taken(candidate)) {
            return jsonResponse({ error: 'Too many pages already use that title. Give this one a different name.' }, { status: 409 });
          }
          slug = candidate;
        }

        const page = {
          slug, title,
          subtitle: b.subtitle, blurb: b.blurb, author: b.author,
          body: b.body, header: b.header, images: b.images,
          boxes: b.boxes, infobox: b.infobox, theme: b.theme,
          toc: b.toc, comments: b.comments
        };
        sanitizeWikiFields(page, 'pages/' + slug + '-', 'pages/' + slug);
        page.parentType = parent.type;
        page.parentSlug = parent.slug;
        if (!page.blurb) page.blurb = WikiRender.autoSummary(page.body, 140);

        const status = b.status === 'published' ? 'published' : 'draft';
        if (existing) await saveRevision(env, sess, 'wikipage', existing);
        await env.DB.prepare(
          `INSERT INTO pages (slug,title,parent_type,parent_slug,author,owner_id,data,status,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
           ON CONFLICT(slug) DO UPDATE SET
             title=excluded.title, author=excluded.author, data=excluded.data,
             status=excluded.status, updated_at=datetime('now')`
        ).bind(slug, title, parent.type, parent.slug, page.author || null,
               existing ? existing.owner_id : sess.userId, JSON.stringify(page), status).run();
        await logActivity(env, sess, existing ? 'update' : 'create', 'wikipage', slug, title);
        return jsonResponse({
          ok: true, slug, status,
          parentType: parent.type, parentKey: parent.key, parentName: parent.name
        });
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
        // Same rule as /api/character: no icon, no publishing.
        const pubData = type === 'character' ? parseData(row) : null;
        if (status === 'published' && type === 'character' &&
            Classify.needsIcon(pubData) && !Classify.hasIcon(pubData)) {
          return jsonResponse({
            error: 'This character needs an icon before it can be published. Open the editor and add one.',
            needsIcon: true
          }, { status: 400 });
        }
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

      // ---- admin: link a creator name to an account (or unlink it) ----
      // Body: {name, username} to link, {name, username: null} to pin the name
      // as deliberately unlinked, {name, clear: true} to go back to deciding by
      // ownership. This is what covers bulk-imported pages, which have no owner
      // and so can never prove who made them. The control lives on the creator
      // page itself, where you notice the problem.
      if (path === '/api/admin/creator-alias') {
        const b = await request.json().catch(() => ({}));
        const name = String(b.name || '').trim();
        if (!name) return jsonResponse({ error: 'Missing creator name' }, { status: 400 });
        const key = creatorAliasKey(name);
        if (b.clear) {
          await env.DB.prepare('DELETE FROM settings WHERE key=?').bind(key).run();
          const acct = await resolveCreatorAccount(env, name);
          return jsonResponse({ ok: true, username: acct ? acct.username : null, cleared: true });
        }
        const uname = String(b.username || '').trim();
        if (uname) {
          const u = await env.DB.prepare('SELECT username FROM users WHERE lower(username)=lower(?)')
            .bind(uname).first();
          if (!u) return jsonResponse({ error: 'No account with that username.' }, { status: 404 });
          await env.DB.prepare(
            'INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
          ).bind(key, u.username).run();
          await logActivity(env, sess, 'update', 'creator', name, u.username);
          return jsonResponse({ ok: true, username: u.username });
        }
        // Empty value = "this name has no account", overruling any ownership match.
        await env.DB.prepare(
          'INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
        ).bind(key, '').run();
        await logActivity(env, sess, 'update', 'creator', name, null);
        return jsonResponse({ ok: true, username: null });
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

      // ---- admin: create / update / delete a news article ----
      // {slug?, title, author?, summary?, body, image?, pinned?, status}
      // The slug is derived from the title on first save and then frozen, so
      // published article URLs never move under readers' feet.
      if (path === '/api/admin/news') {
        await ensureNewsTable(env);
        const b = await request.json().catch(() => ({}));
        const kebab = s => String(s || '').toLowerCase().normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '').slice(0, 80);

        if (b.action === 'delete') {
          const slug = String(b.slug || '');
          const row = await env.DB.prepare('SELECT title FROM news WHERE slug=?').bind(slug).first().catch(() => null);
          if (!row) return jsonResponse({ error: 'Article not found.' }, { status: 404 });
          await env.DB.prepare('DELETE FROM news WHERE slug=?').bind(slug).run();
          await ensureCommentTables(env);
          await env.DB.prepare("DELETE FROM comments WHERE entity_type='news' AND slug=?").bind(slug).run();
          await logActivity(env, sess, 'delete', 'news', slug, row.title);
          return jsonResponse({ ok: true, deleted: slug });
        }

        const title = String(b.title || '').trim().slice(0, 160);
        if (!title) return jsonResponse({ error: 'Give the article a title.' }, { status: 400 });
        const body = String(b.body || '').replace(/\r\n/g, '\n').slice(0, 40000);
        if (!body.trim()) return jsonResponse({ error: 'Write the article body first.' }, { status: 400 });

        let slug = kebab(b.slug) || kebab(title);
        if (!slug) return jsonResponse({ error: 'Could not build a URL from that title.' }, { status: 400 });
        const existing = await env.DB.prepare('SELECT * FROM news WHERE slug=?').bind(slug).first().catch(() => null);
        // A brand-new article (no slug sent) whose title happens to kebab down
        // to an article that already exists must NOT overwrite it.
        if (existing && !b.slug) {
          return jsonResponse({
            error: 'An article with that title already exists — open it from the list below to edit it, or change the title.'
          }, { status: 409 });
        }

        const image = String(b.image || '').trim().slice(0, 300);
        const article = {
          slug, title,
          author: String(b.author || '').trim().slice(0, 80) || null,
          summary: String(b.summary || '').trim().slice(0, 300) || null,
          body,
          // Hero images live in the R2 news/scripts/collections areas or are
          // remote URLs; anything else is dropped rather than half-trusted.
          image: (/^https?:\/\//i.test(image) || /^(news|scripts|collections|art)\/[a-z0-9._ -]+\.(png|jpe?g|webp)$/i.test(image))
            ? image : null,
          pinned: !!b.pinned,
          // Images uploaded for this article, so the editor can list them again.
          images: Array.isArray(b.images)
            ? b.images.slice(0, 40).map(x => String(x))
                .filter(s => s.indexOf('news/' + slug + '-') === 0 && s.indexOf('..') === -1 &&
                             /^[a-z0-9/._ -]+\.(png|jpe?g|webp)$/i.test(s))
            : [],
          // Same page furniture the custom wiki pages get: contents box,
          // side boxes, fact box and the theme kit.
          toc: !!b.toc,
          boxes: sanitizeBoxes(b.boxes),
          infobox: sanitizeInfobox(b.infobox),
          theme: PageRender.sanitizeTheme(b.theme, 'news/' + slug)
        };
        if (!article.infobox) delete article.infobox;
        if (!article.theme) delete article.theme;
        const status = b.status === 'published' ? 'published' : 'draft';
        // published_at is stamped once, the first time it goes live, so
        // editing an old article doesn't jump it to the top of the list.
        const publishedAt = status === 'published'
          ? ((existing && existing.published_at) || new Date().toISOString().replace('T', ' ').slice(0, 19))
          : (existing ? existing.published_at : null);

        await env.DB.prepare(
          `INSERT INTO news (slug,title,owner_id,data,status,created_at,updated_at,published_at)
           VALUES (?,?,?,?,?,datetime('now'),datetime('now'),?)
           ON CONFLICT(slug) DO UPDATE SET
             title=excluded.title, data=excluded.data, status=excluded.status,
             updated_at=datetime('now'), published_at=excluded.published_at`
        ).bind(slug, title, sess.userId, JSON.stringify(article), status, publishedAt).run();
        await logActivity(env, sess, existing ? 'update' : 'create', 'news', slug, title);
        return jsonResponse({ ok: true, slug, status });
      }

      // ---- admin: act on one comment ----
      // remove/restore the comment itself, or clear its report queue entry.
      if (path === '/api/admin/comment') {
        await ensureCommentTables(env);
        const b = await request.json().catch(() => ({}));
        const id = parseInt(b.id, 10);
        const action = String(b.action || '');
        if (!id) return jsonResponse({ error: 'Missing comment id.' }, { status: 400 });
        const row = await env.DB.prepare('SELECT * FROM comments WHERE id=?').bind(id).first().catch(() => null);
        if (!row) return jsonResponse({ error: 'Comment not found.' }, { status: 404 });
        if (action === 'remove' || action === 'restore') {
          const removing = action === 'remove';
          let by = null;
          try {
            const u = await env.DB.prepare('SELECT username FROM users WHERE id=?').bind(sess.userId).first();
            by = u ? u.username : null;
          } catch { /* non-fatal */ }
          if (removing) await removeCommentCascade(env, row, by);
          else await restoreCommentCascade(env, row);
          await logActivity(env, sess, removing ? 'comment-remove' : 'comment-restore',
            row.entity_type, row.slug, 'comment #' + id);
        } else if (action === 'resolve') {
          await env.DB.prepare("UPDATE comment_reports SET status='resolved' WHERE comment_id=?").bind(id).run();
        } else if (action === 'purge') {
          // Permanent: drops the row, its replies, and all their reports.
          const ids = [id];
          if (!row.parent_id) {
            const { results } = await env.DB.prepare('SELECT id FROM comments WHERE parent_id=?')
              .bind(id).all().catch(() => ({ results: [] }));
            for (const r of results || []) ids.push(r.id);
          }
          for (const cid of ids) {
            await env.DB.prepare('DELETE FROM comment_reports WHERE comment_id=?').bind(cid).run();
            await env.DB.prepare('DELETE FROM comments WHERE id=?').bind(cid).run();
          }
          await logActivity(env, sess, 'comment-purge', row.entity_type, row.slug,
            'comment #' + id + (ids.length > 1 ? ' + ' + (ids.length - 1) + ' repl' + (ids.length === 2 ? 'y' : 'ies') : ''));
        } else {
          return jsonResponse({ error: 'Unknown action.' }, { status: 400 });
        }
        return jsonResponse({ ok: true, id, action });
      }

      // ---- admin: Starlight status ----
      // Starlight is the only stored half of the classification system: a
      // boolean in the page's data JSON that only this endpoint can write.
      // It works on characters, collections and scripts alike.
      if (path === '/api/admin/starlight') {
        const b = await request.json().catch(() => ({}));
        const type = String(b.type || '');
        const t = CONTENT[type];
        if (!t) return jsonResponse({ error: 'Unknown type' }, { status: 400 });
        let row = await getEntityRow(env, type, String(b.slug || ''));
        if (!row && type === 'collection') row = await findCollectionRow(env, String(b.slug || ''));
        if (!row) return jsonResponse({ error: 'Not found' }, { status: 404 });
        const on = !!b.starlight;
        const d = parseData(row);
        if (!!d.starlight === on) return jsonResponse({ ok: true, slug: row.slug, starlight: on });
        d.starlight = on;
        if (!on) delete d.starlight;
        await env.DB.prepare(`UPDATE ${t.table} SET data=?, updated_at=datetime('now') WHERE slug=?`)
          .bind(JSON.stringify(d), row.slug).run();
        await logActivity(env, sess, on ? 'starlight' : 'unstarlight', type, row.slug, row.name);
        return jsonResponse({ ok: true, slug: row.slug, starlight: on });
      }

      // ---- admin: one-click cleanup of published characters with no icon ----
      // The icon rule only bites on save/publish, so this sweeps the pages
      // that went live before the rule existed. Every affected page becomes a
      // draft — nothing is deleted, and re-publishing is one click once the
      // owner adds art. Pass {dryRun:true} to just count them.
      if (path === '/api/admin/demote-no-icon') {
        const b = await request.json().catch(() => ({}));
        const { results } = await env.DB.prepare(
          "SELECT slug, name, data FROM characters WHERE status='published'"
        ).all();
        // Fabled rules pages (States/Conditions/Calls) never had icons and
        // are not supposed to — Classify.needsIcon() keeps them out of this.
        const hits = (results || []).filter(r => {
          const d = parseData(r);
          return Classify.needsIcon(d) && !Classify.hasIcon(d);
        });
        if (b.dryRun) {
          return jsonResponse({
            ok: true, dryRun: true, count: hits.length,
            pages: hits.slice(0, 300).map(r => ({ slug: r.slug, name: r.name }))
          });
        }
        for (const r of hits) {
          await env.DB.prepare("UPDATE characters SET status='draft', updated_at=datetime('now') WHERE slug=?")
            .bind(r.slug).run();
        }
        await logActivity(env, sess, 'unpublish', 'character', null,
          hits.length + ' page(s) with no icon moved to draft');
        return jsonResponse({ ok: true, count: hits.length, pages: hits.map(r => r.slug) });
      }

      // ---- admin: one-time Odyssey text cleanup ----
      // Strips the translation's em dashes and rewrites its gendered pronouns
      // to they/them/their across the Odyssey almanacs, leaving `ability` and
      // the flavour quote's pronouns alone. The rules live in
      // migration/odyssey-cleanup.js so the same code can be dry-run locally.
      // Remove this block, the import at the top and the dashboard card once
      // it has been run.
      if (path === '/api/admin/cleanup-odyssey') {
        const b = await request.json().catch(() => ({}));
        // translatedBy is the Odyssey import's own marker: it matches those 119
        // rows and nothing else on the wiki.
        const { results } = await env.DB.prepare(
          "SELECT slug, name, status, data FROM characters WHERE json_extract(data,'$.translatedBy')='DJ_DJ_DJ'"
        ).all();
        const rows = results || [];
        const plan = [], flags = [];
        for (const row of rows) {
          const res = OdysseyCleanup.cleanCharacter(parseData(row));
          res.flags.forEach(f => flags.push({ slug: row.slug, field: f.field, flag: f.flag }));
          if (res.changed) plan.push({ row, data: res.data, n: res.changed });
        }
        if (b.dryRun) {
          return jsonResponse({
            ok: true, dryRun: true, scanned: rows.length,
            pages: plan.length, fields: plan.reduce((a, p) => a + p.n, 0),
            flags
          });
        }
        // A flagged case means the rules met something they were not built for.
        // Refuse rather than write half-checked prose.
        if (flags.length) {
          return jsonResponse({ error: flags.length + ' flagged case(s); nothing was changed.', flags }, { status: 400 });
        }
        for (const p of plan) {
          await saveRevision(env, sess, 'character', p.row);
          await env.DB.prepare("UPDATE characters SET data=?, updated_at=datetime('now') WHERE slug=?")
            .bind(JSON.stringify(p.data), p.row.slug).run();
        }
        await logActivity(env, sess, 'update', 'character', null,
          'Odyssey text cleanup: ' + plan.length + ' page(s)');
        return jsonResponse({
          ok: true, scanned: rows.length, pages: plan.length,
          fields: plan.reduce((a, p) => a + p.n, 0), flags: []
        });
      }

      // ---- admin: site-wide announcement banner ----
      if (path === '/api/admin/announce') {
        const b = await request.json().catch(() => ({}));
        // Roomier than it looks: [label](https://…) link markup eats
        // characters that the reader never sees.
        const text = String(b.text || '').trim().slice(0, 600);
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
        const ACTIONS = ['publish', 'unpublish', 'delete', 'restore', 'assign-owner', 'clear-owner',
                        'add-tag', 'remove-tag', 'starlight', 'unstarlight'];
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
            } else if (action === 'starlight' || action === 'unstarlight') {
              const on = action === 'starlight';
              const d = parseData(row);
              if (!!d.starlight !== on) {
                d.starlight = on;
                if (!on) delete d.starlight;
                await env.DB.prepare(`UPDATE ${t.table} SET data=?, updated_at=datetime('now') WHERE slug=?`)
                  .bind(JSON.stringify(d), row.slug).run();
              }
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
