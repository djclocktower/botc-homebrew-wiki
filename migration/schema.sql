-- ============================================================
-- BOTC Homebrew Wiki — D1 Database Schema
-- Designed so new character fields NEVER require a migration:
-- indexed/queryable fields are columns; everything else is JSON.
-- ============================================================

-- ---- USERS (full creator accounts) -------------------------
CREATE TABLE IF NOT EXISTS users (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  username         TEXT NOT NULL UNIQUE,
  password_hash    TEXT NOT NULL,               -- '' for Discord-only accounts
  email            TEXT,
  is_admin         INTEGER NOT NULL DEFAULT 0,  -- 0/1
  display_name     TEXT,
  bio              TEXT,
  discord_id       TEXT,
  discord_username TEXT,
  avatar_url       TEXT,
  email_verified   INTEGER NOT NULL DEFAULT 0,
  last_login       TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
  ON users(lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_discord
  ON users(discord_id) WHERE discord_id IS NOT NULL;

-- ---- CHARACTERS -------------------------------------------
CREATE TABLE IF NOT EXISTS characters (
  slug        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  team        TEXT NOT NULL,
  creator     TEXT,
  owner_id    INTEGER REFERENCES users(id),
  tags        TEXT,
  appears_in  TEXT,
  data        TEXT NOT NULL,                  -- full character object as JSON
  status      TEXT NOT NULL DEFAULT 'published',  -- 'published' | 'draft'
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_characters_team    ON characters(team);
CREATE INDEX IF NOT EXISTS idx_characters_creator ON characters(creator);
CREATE INDEX IF NOT EXISTS idx_characters_owner   ON characters(owner_id);
CREATE INDEX IF NOT EXISTS idx_characters_status  ON characters(status);

-- ---- COLLECTIONS ------------------------------------------
CREATE TABLE IF NOT EXISTS collections (
  slug         TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  owner_id     INTEGER REFERENCES users(id),
  data         TEXT NOT NULL,                 -- full collection object as JSON
  status       TEXT NOT NULL DEFAULT 'published',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_collections_owner ON collections(owner_id);

-- ---- SCRIPTS ----------------------------------------------
CREATE TABLE IF NOT EXISTS scripts (
  slug        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  author      TEXT,
  owner_id    INTEGER REFERENCES users(id),
  data        TEXT NOT NULL,                  -- full script object as JSON
  status      TEXT NOT NULL DEFAULT 'published',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_scripts_owner ON scripts(owner_id);

-- ---- ACTIVITY LOG (admin dashboard feed) ------------------
CREATE TABLE IF NOT EXISTS activity_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL DEFAULT (datetime('now')),
  user_id     INTEGER REFERENCES users(id),
  username    TEXT,                            -- denormalized for easy display
  action      TEXT NOT NULL,                   -- create | update | delete | lock | unlock
  entity_type TEXT,                            -- character | collection | script | wiki
  entity_slug TEXT,
  entity_name TEXT
);
CREATE INDEX IF NOT EXISTS idx_activity_ts   ON activity_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_log(user_id, ts DESC);

-- ---- REVISIONS (page version history for admin rollback) --
-- NOTE: this table is created automatically by the Worker on first use
-- (ensureRevisionsTable in worker/worker.js) — no manual migration needed.
-- Every content save snapshots the version it replaces; the Worker keeps
-- the newest 20 revisions per page. Reference only:
CREATE TABLE IF NOT EXISTS revisions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,                   -- character | collection | script
  slug        TEXT NOT NULL,                   -- the row's PK slug
  name        TEXT,
  status      TEXT,                            -- status the page had at snapshot time
  data        TEXT NOT NULL,                   -- full JSON blob of the old version
  edited_by   TEXT,                            -- who made the edit that replaced it
  ts          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_revisions_entity ON revisions(entity_type, slug, id);

-- ---- MESSAGES (contact-the-admins form -> dashboard inbox) --
-- Auto-created by the Worker on first use. Reference only:
CREATE TABLE IF NOT EXISTS messages (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       TEXT NOT NULL DEFAULT (datetime('now')),
  user_id  INTEGER,
  username TEXT,
  category TEXT,                               -- bug | suggestion | question | other
  body     TEXT NOT NULL,
  status   TEXT NOT NULL DEFAULT 'open'        -- open | resolved
);

-- ---- PAGE VIEWS (analytics; one row per page per day) --------
-- Auto-created by the Worker on first use; rows older than 180 days are
-- pruned by the nightly cron. Reference only:
CREATE TABLE IF NOT EXISTS page_views (
  entity_type TEXT NOT NULL,                   -- character | script | collection
  slug        TEXT NOT NULL,
  day         TEXT NOT NULL,                   -- YYYY-MM-DD
  n           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (entity_type, slug, day)
);

-- ---- USERS: ban flag -----------------------------------------
-- Auto-added by the Worker (ALTER TABLE, first use of the users panel).
-- ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0;

-- ---- SETTINGS (global key/value flags, e.g. wiki lock) ----
-- Also holds: 'announcement' (JSON {text, at, by}) for the site-wide
-- banner, and 'protected:{type}:{slug}' = '1' for admin page protection.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
INSERT OR IGNORE INTO settings (key, value) VALUES ('wiki_locked', '0');

-- ---- SETTINGS: content_version ----------------------------------
-- Counter bumped by logActivity() on every feed-changing action. The JSON
-- feeds (/characters.json etc.) key their edge-cache entry on it, so a
-- content write invalidates the cache by no longer matching, with no purge.
INSERT OR IGNORE INTO settings (key, value) VALUES ('content_version', '1');

-- ---- LAUNCH-SCALE INDEXES ---------------------------------------
-- Added when the site was hardened for a large influx of contributors.
-- Applied live to the botc-wiki D1 instance; repeated here so a fresh
-- database gets them too. All idempotent.
--
-- page_views(day) is the important one: the PK is (entity_type, slug, day),
-- so `day` is not a leading column and the nightly 180-day retention DELETE
-- full-scanned the largest table in the database every single night.
-- EXPLAIN QUERY PLAN now reports SEARCH ... USING INDEX instead of SCAN.
CREATE INDEX IF NOT EXISTS idx_page_views_day     ON page_views(day);

-- status='published' filters that previously had no index at all. Both fire
-- on every content page view via applyCollectionStarlight() and the sitemap.
CREATE INDEX IF NOT EXISTS idx_collections_status ON collections(status);
CREATE INDEX IF NOT EXISTS idx_scripts_status     ON scripts(status);

-- The admin dashboard and profile pages sort by updated_at with no index,
-- which forces a full scan and sort even behind a LIMIT.
CREATE INDEX IF NOT EXISTS idx_characters_upd     ON characters(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_created      ON users(created_at DESC);

-- Moderation queues. comment_reports, messages and dm_reports had no indexes
-- whatsoever, and they are exactly the tables that get read under load.
CREATE INDEX IF NOT EXISTS idx_comment_reports_st ON comment_reports(status, comment_id);
CREATE INDEX IF NOT EXISTS idx_comments_status_id ON comments(status, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_status    ON messages(status);
CREATE INDEX IF NOT EXISTS idx_dm_reports_status  ON dm_reports(status);
