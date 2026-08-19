# Account System — Setup Guide

The wiki now has full user accounts: email signup, Discord sign-in, password
reset by email, page ownership, and private drafts. This guide covers the
one-time setup needed to turn everything on.

## 1. Run the database migration (REQUIRED — do this BEFORE deploying)

The new Worker expects new columns (`users.discord_id`, `characters.status`,
etc.). Run the migration against the live D1 database first:

```bash
wrangler d1 execute botc-wiki --remote --file=migration/accounts_migration.sql
```

Or paste the statements from `migration/accounts_migration.sql` into the D1
console in the Cloudflare dashboard (run them one at a time if the console
complains about multiple statements).

Existing pages are automatically marked `published` and keep their current
owner (the admin account). Nothing visible changes for readers.

## 2. Email (password reset + verification) — via Resend

Password-reset and verification emails are sent through
[Resend](https://resend.com) (free tier: 100 emails/day, 3,000/month).

1. Create a Resend account and an API key.
2. (Recommended) Verify your domain in Resend so mail comes from
   `no-reply@yourdomain` instead of the shared test sender.
3. Set the secrets:

```bash
wrangler secret put RESEND_API_KEY     # paste the re_... key
wrangler secret put MAIL_FROM          # e.g. BOTC Homebrew Wiki <no-reply@yourdomain.com>
```

(Secrets can also be added in the dashboard: Workers & Pages → botc-homebrew-wiki
→ Settings → Variables and Secrets.)

**Without these secrets** the site still works: signup/login are fine, but
"Forgot password" returns a friendly "email is not configured" error and
verification emails are silently skipped.

## 3. Discord sign-in

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
   and create a **New Application** (e.g. "BOTC Homebrew Wiki").
2. Under **OAuth2 → Redirects**, add this Redirect URI — exactly, including the
   scheme, with no trailing slash:

   ```
   https://botchomebrew.wiki/api/auth/discord/callback
   ```

   **One entry, not one per hostname.** The Worker pins the whole sign-in flow
   to that single origin (`CANONICAL_ORIGIN` in `worker/worker.js`) and moves a
   reader who arrived on any other hostname — `www.`, workers.dev, a preview
   name — over to it before the flow starts. Discord matches this string
   character for character, and an unregistered one gives readers a bare
   **"Invalid OAuth2 redirect_uri"** screen with no way to sign in.

   If the site ever moves domain, set `SITE_ORIGIN` to the new origin and add
   the matching callback URL here in the same sitting.
3. Copy the **Client ID** and **Client Secret**, then:

```bash
wrangler secret put DISCORD_CLIENT_ID
wrangler secret put DISCORD_CLIENT_SECRET
```

Set from the Cloudflare dashboard instead? Use type **Secret**, never "Text" —
a Git deploy deletes Text variables, which silently turns Discord sign-in off.

**Without these secrets** the "Continue with Discord" button redirects back
with a "not configured" message; everything else works.

### Checking it without trying to log in

Both of the settings above live outside the repo, so nothing in a deploy or a
test can tell you they are still right. The dashboard's **Health** tab has a
**Discord sign-in** card (`GET /api/admin/discord-check`, admin only) that asks
Discord whether the client id/secret pair is still valid and prints the exact
callback URL the portal has to hold. Run it after changing either side, or when
someone reports that the button does not work.

## 4. Deploy

```bash
wrangler deploy
```

(Or push to the repo if you deploy via the Cloudflare Git integration.)

## What users get

- **Sign up** with username + email + password, or one click with Discord.
- **Log in** with username *or* email; Discord users can also set a password
  later and use either method. Sessions last 30 days.
- **Forgot password** — emailed one-hour single-use reset link
  (`reset-password.html`).
- **Email verification** — sent on signup and on email change; badge on the
  account page, resendable.
- **Account page** (`account.html`) — profile (display name, bio, avatar from
  Discord), your published pages, your private drafts (edit / publish /
  delete), your recent edit history, and settings (password, email, Discord
  link/unlink, log out).
- **Ownership** — pages belong to the account that created them. Only the
  owner (or an admin) can edit, re-upload art for, publish/unpublish, or
  delete a page. Slugs are first-come: you can't overwrite someone else's
  character by reusing the name.
- **Drafts** — "Save as Draft" in the character creator/editor keeps a page
  out of the public wiki (excluded from characters.json, search, and its
  `/c/…` URL 404s for everyone but you). A draft banner shows when you
  preview your own draft.

## Security notes

- Passwords are hashed with PBKDF2-SHA256 (100k iterations) — same scheme as
  the original admin account, so the existing admin login keeps working.
- Login/signup/reset endpoints are rate-limited per IP (KV-backed).
- Forgot-password never reveals whether an account exists.
- Discord OAuth uses a KV-backed `state` token (CSRF protection). A Discord
  identity or email can only be attached to one account; auto-linking by
  email only happens when both sides are verified.
- Image uploads are limited to 8 MB, tagged with the uploader, and can't
  overwrite another user's files. `tokens/` uploads stay admin-only.
- Admin-only endpoints (`/api/lock`, `/api/seed`, `/api/admin/dashboard`)
  are unchanged.
