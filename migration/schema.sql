-- ============================================================
-- BOTC Homebrew Wiki — D1 Database Schema
-- Designed so new character fields NEVER require a migration:
-- indexed/queryable fields are columns; everything else is JSON.
-- ============================================================

-- ---- USERS (admin now, full creator accounts later) -------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  email         TEXT,
  is_admin      INTEGER NOT NULL DEFAULT 0,   -- 0/1
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

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
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_characters_team    ON characters(team);
CREATE INDEX IF NOT EXISTS idx_characters_creator ON characters(creator);
CREATE INDEX IF NOT EXISTS idx_characters_owner   ON characters(owner_id);

-- ---- COLLECTIONS ------------------------------------------
CREATE TABLE IF NOT EXISTS collections (
  slug         TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  owner_id     INTEGER REFERENCES users(id),
  data         TEXT NOT NULL,                 -- full collection object as JSON
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---- SCRIPTS ----------------------------------------------
CREATE TABLE IF NOT EXISTS scripts (
  slug        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  author      TEXT,
  owner_id    INTEGER REFERENCES users(id),
  data        TEXT NOT NULL,                  -- full script object as JSON
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

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
CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity_log(ts DESC);

-- ---- SETTINGS (global key/value flags, e.g. wiki lock) ----
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
INSERT OR IGNORE INTO settings (key, value) VALUES ('wiki_locked', '0');
