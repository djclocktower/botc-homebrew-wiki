# BOTC HomeBrew Wiki

A fan-made wiki for **Blood on the Clocktower** homebrew characters —
live at **[botchomebrew.wiki](https://botchomebrew.wiki)**.

Fan-made content. Not affiliated with The Pandemonium Institute.

## How it works

The site runs entirely on **Cloudflare Workers**:

- `worker/worker.js` serves every request. It builds `characters.json`,
  `collections.json` and `scripts.json` live from a **D1 database**,
  server-side renders character pages at `/c/{slug}`, handles accounts and
  logins (KV sessions, optional Discord OAuth), stores uploaded art in **R2**,
  and runs a nightly D1 → R2 backup cron.
- Everything else in the repo (HTML pages, `assets/`) is uploaded as static
  assets and served as-is. There is no build step and no framework.

Content is created and edited on the site itself (`create.html`, `edit.html`,
`mass-upload.html`, the Script Builder) and written straight to D1 — the repo
holds the code, not the content.

## Deploying

Pushing to `main` deploys automatically via Cloudflare's Git integration
(takes ~30–60 seconds). `wrangler.toml` holds the Worker config and bindings;
`_headers` holds the static-asset cache rules; `.assetsignore` keeps
non-asset files (git internals, worker source, docs) out of the upload.

## Working on the code

Read **CLAUDE.md** first — it documents the architecture, file map, data
model, and the gotchas that will break the deploy if ignored.
`migration/schema.sql` describes the D1 schema.
