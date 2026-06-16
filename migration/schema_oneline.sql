CREATE TABLE IF NOT EXISTS users ( id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, email TEXT, is_admin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')) );
CREATE TABLE IF NOT EXISTS characters ( slug TEXT PRIMARY KEY, name TEXT NOT NULL, team TEXT NOT NULL, creator TEXT, owner_id INTEGER REFERENCES users(id), tags TEXT, appears_in TEXT, data TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')) );
CREATE INDEX IF NOT EXISTS idx_characters_team ON characters(team);
CREATE INDEX IF NOT EXISTS idx_characters_creator ON characters(creator);
CREATE INDEX IF NOT EXISTS idx_characters_owner ON characters(owner_id);
CREATE TABLE IF NOT EXISTS collections ( slug TEXT PRIMARY KEY, display_name TEXT NOT NULL, owner_id INTEGER REFERENCES users(id), data TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')) );
CREATE TABLE IF NOT EXISTS scripts ( slug TEXT PRIMARY KEY, name TEXT NOT NULL, author TEXT, owner_id INTEGER REFERENCES users(id), data TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')) );
