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

-- ---- SETTINGS (global key/value flags, e.g. wiki lock) ----
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
INSERT OR IGNORE INTO settings (key, value) VALUES ('wiki_locked', '0');
