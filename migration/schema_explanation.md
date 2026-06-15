DATABASE SCHEMA — PLAIN ENGLISH

TABLE 1: users  (accounts — admin now, full creators later)
  - id            unique number
  - username      login name (unique)
  - password_hash scrambled password (never stored in plain text)
  - email         optional, for future password reset
  - is_admin      true/false — admin can edit anything
  - created_at    when the account was made

TABLE 2: characters  (your 96 characters, source of truth)
  - slug          unique URL id (e.g. "cadenza")        [indexed column]
  - name          display name                          [indexed column]
  - team          townsfolk/outsider/etc                [indexed column]
  - creator       creator name string                   [indexed column]
  - owner_id      which user account owns it (can edit) [indexed column, links to users.id]
  - tags          comma list                            [indexed column]
  - appears_in    collection match string               [indexed column]
  - data          the FULL character object as JSON     [everything else lives here]
  - updated_at    last edit time

TABLE 3: collections  (your 5 collections)
  - slug, display_name, owner_id, data (full JSON), updated_at

TABLE 4: scripts  (your 2 scripts)
  - slug, name, author, owner_id, data (full JSON), updated_at

TABLE 5: sessions  (login sessions — lives in Cloudflare KV, not D1)
  - a signed token in a cookie → maps to a user id, expires after a while

WHY THE "data" JSON COLUMN?
  Your characters have 28 possible fields and you add new ones often
  (translatedBy, bluffing, fighting were all recent). Storing the indexed
  fields as columns (for fast filtering) PLUS the whole object as JSON means
  we never need a database migration when you add a new field — it just goes
  in the JSON. Best of both worlds.

OWNERSHIP (for the future account system)
  Every character/collection/script has an owner_id. Right now everything
  will be owned by YOU (the admin). When real creator accounts arrive,
  new content gets owned by whoever created it, and the edit button only
  shows if you own it (or you're admin). The machinery is built in now;
  we just flip it on later.
