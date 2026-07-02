# BOTC Wiki — Stage 1 Deployment Guide
### Goal: get the Worker live, serving data from D1, with admin login working.
### Do this on a PC (desktop browser). Takes ~20-30 minutes.

---

## BEFORE YOU START — have these ready
- Your Cloudflare login
- Your admin password (saved earlier): **fgwp-6328-pdrb**
- The D1 database you already created: **botc-wiki**

You will NOT need to install anything or type any commands. This is all dashboard clicks.

---

## STEP 1 — Create the KV namespace (for login sessions)
1. Go to **dash.cloudflare.com** and log in
2. Left sidebar → **Storage & Databases** → **KV**
   (older menus call it **Workers & Pages → KV**)
3. Click **Create a namespace**
4. Name it exactly: **botc-sessions**
5. Click **Add** / **Create**

✅ You now have a KV namespace. Leave this tab; we'll link it in Step 4.

---

## STEP 1B — Create the R2 bucket (for instant image uploads)
1. Left sidebar → **R2 Object Storage** (enable R2 for the account if prompted —
   it has a free tier; no public bucket access is needed)
2. Click **Create bucket**
3. Name it exactly: **botc-wiki-art**
4. Click **Create bucket**

The Worker binds this bucket as `ART` via `wrangler.toml` (`[[r2_buckets]]`).
If the Worker was created through the dashboard instead, add the binding
manually: **Worker → Settings → Bindings → R2 bucket → Add**, variable name
`ART`, bucket `botc-wiki-art`.

✅ Art, collection headers, and script headers now upload straight to R2 via
`POST /api/upload` — no git commit, no rebuild. Character pages are
server-side rendered from D1 by the Worker (`GET /c/{slug}.html`), so new and
edited characters are live instantly.

---

## STEP 2 — Create the Worker from your GitHub repo
1. Left sidebar → **Workers & Pages**
2. Click **Create application** (or **Create**)
3. Choose the **Workers** tab (NOT Pages)
4. Click **Connect to Git** / **Import a repository**
5. Authorize GitHub if asked, then pick **djclocktower/botc-homebrew-wiki**
6. Branch: **main**
7. Build settings:
   - **Build command:** leave BLANK
   - **Deploy command:** leave BLANK (or default)
   - Cloudflare reads your `wrangler.toml` automatically
8. Click **Save and Deploy**

⚠️ The FIRST deploy may show an error about missing database/KV IDs.
That is EXPECTED — we add the bindings next, then redeploy. Continue.

---

## STEP 3 — Link the D1 database to the Worker
1. On your new Worker's page, go to **Settings** → **Bindings**
   (may be **Settings → Variables and Bindings**)
2. Find **D1 database bindings** → click **Add binding**
3. Set:
   - **Variable name:** `DB`   (exactly, capital D-B)
   - **D1 database:** select **botc-wiki**
4. Click **Save**

---

## STEP 4 — Link the KV namespace to the Worker
1. Same **Bindings** page → find **KV namespace bindings** → **Add binding**
2. Set:
   - **Variable name:** `SESSIONS`   (exactly, all caps)
   - **KV namespace:** select **botc-sessions**
3. Click **Save**

---

## STEP 5 — Load the database tables (schema)
The database is empty — it has no tables yet. We add them now.
1. Left sidebar → **Storage & Databases** → **D1** → click **botc-wiki**
2. Click the **Console** tab
3. Open the file **migration/schema.sql** from your repo on github.com
   (djclocktower/botc-homebrew-wiki → migration → schema.sql → click "Raw")
4. Copy ALL of it, paste into the Console, click **Execute**
5. You should see success / "Query ran successfully"

Then create the admin account:
6. Open **migration/seed.sql** from the repo the same way (Raw)
7. Copy ALL of it, paste into the Console, click **Execute**

✅ Database now has empty tables + your admin account.
(We do NOT paste the big import file — the Worker loads that in Step 8.)

---

## STEP 6 — Redeploy the Worker
Now that bindings + tables exist, redeploy so the Worker picks them up.
1. Go back to your Worker → **Deployments** tab
2. Click **Create deployment** / **Retry deployment** / **Redeploy**
   (or just push happens automatically — if unsure, click Redeploy)
3. Wait for it to finish (green check)

---

## STEP 7 — Point your domain at the Worker
1. On the Worker page → **Settings** → **Domains & Routes** (or **Triggers**)
2. Click **Add** → **Custom Domain**
3. Enter: **botchomebrew.wiki**
4. Click **Add domain** — Cloudflare wires the DNS automatically
   (it may take a few minutes to go live)
5. ALSO add **www.botchomebrew.wiki** the same way if you use www

⚠️ This is the moment hosting moves from GitHub Pages to Cloudflare.
The site may flicker/brief downtime during the switch — normal.

---

## STEP 8 — Load your characters into the database (the seed)
This is the one-click data load (Option 3).
1. First, log in: go to **https://botchomebrew.wiki/login.html**
2. Username: **admin**   Password: **fgwp-6328-pdrb**
3. Click **Log In** — you should see "Logged in! Redirecting…"
4. Now visit this exact URL in the same browser:
   **https://botchomebrew.wiki/api/seed**
   - Because /api/seed needs a POST, easiest way: see note below ⬇
5. You should get a response like:
   `{"ok":true,"characters":96,"collections":5,"scripts":2}`

📌 NOTE: /api/seed needs a POST request, which a normal browser visit can't do.
   The SIMPLEST way: I will add a tiny "Seed Database" button to the login page
   that does this for you with one click once you're logged in. (Tell me when
   you reach this step and I'll have it ready — or I can add it now so it's
   waiting for you.)

---

## STEP 9 — Verify everything works
1. Visit **https://botchomebrew.wiki** — homepage should load with all characters
2. Visit **https://botchomebrew.wiki/characters.json** — should show JSON from the DB
3. Browse a character page — should work exactly as before
4. The site should feel instant; edits (later) won't need hard-refresh

---

## IF SOMETHING GOES WRONG
- Copy the exact error message (screenshot is fine) and send it to me
- Common issues:
  - "DB is not defined" → binding name isn't exactly `DB` (Step 3)
  - "SESSIONS is not defined" → binding name isn't exactly `SESSIONS` (Step 4)
  - Login fails → schema/seed didn't load (Step 5)
  - Seed says "already has characters" → it already ran; you're fine
- Nothing here is irreversible. GitHub Pages can be turned back on if needed.

---

## WHAT YOU'LL HAVE AFTER STAGE 1
✅ Site served by Cloudflare (instant deploys)
✅ Data living in D1 database
✅ Admin login working
✅ No more hard-refresh (cache headers active)
⬜ Editing through the site still uses old flow — that's STAGE 2 (next session)
