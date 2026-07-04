-- ============================================================
-- BOTC Homebrew Wiki — Account System Migration
-- Run this ONCE against the existing botc-wiki D1 database
-- BEFORE deploying the account-system Worker:
--   wrangler d1 execute botc-wiki --remote --file=migration/accounts_migration.sql
-- (or paste into the D1 console — each statement on its own line)
-- ============================================================

-- ---- USERS: profile + auth-provider fields ----------------
ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN bio TEXT;
ALTER TABLE users ADD COLUMN discord_id TEXT;
ALTER TABLE users ADD COLUMN discord_username TEXT;
ALTER TABLE users ADD COLUMN avatar_url TEXT;
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN last_login TEXT;

-- One account per email / per Discord identity (NULLs allowed:
-- Discord-only accounts may lack email, email accounts lack discord_id).
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
  ON users(lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_discord
  ON users(discord_id) WHERE discord_id IS NOT NULL;

-- ---- DRAFTS: publish state on every content type ----------
-- Existing rows automatically get 'published'.
ALTER TABLE characters  ADD COLUMN status TEXT NOT NULL DEFAULT 'published';
ALTER TABLE collections ADD COLUMN status TEXT NOT NULL DEFAULT 'published';
ALTER TABLE scripts     ADD COLUMN status TEXT NOT NULL DEFAULT 'published';

CREATE INDEX IF NOT EXISTS idx_characters_status  ON characters(status);
CREATE INDEX IF NOT EXISTS idx_collections_owner  ON collections(owner_id);
CREATE INDEX IF NOT EXISTS idx_scripts_owner      ON scripts(owner_id);
CREATE INDEX IF NOT EXISTS idx_activity_user      ON activity_log(user_id, ts DESC);
