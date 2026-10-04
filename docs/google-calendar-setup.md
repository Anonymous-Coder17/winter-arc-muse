# Google Calendar Integration — Setup Guide (V4.3.3)

Two-way sync between the app's own calendar and the user's Google Calendar(s).

> **Status: real end-to-end verification has NOT been performed.** No Google
> Cloud credentials exist for this project yet. The OAuth flow, token vault,
> sync engine, and timezone round-trips are covered by 386 automated tests
> (mocked Google API responses) and a clean typecheck/lint/build — but the
> live handshake against Google's servers has never run. Do not treat this
> integration as production-proven until the walkthrough in
> [App walkthrough](#4-app-walkthrough-first-live-run) below has been
> completed with real credentials.

---

## 1. Required environment variables

All Google credentials are **SERVER-ONLY**. They live in the server runtime
only (`lib/google/*` is guarded by `import "server-only"`), are never sent to
the browser, and are never logged.

| Variable | Required | Purpose |
|---|---|---|
| `GOOGLE_CLIENT_ID` | Yes | OAuth web-client ID from Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | Yes | OAuth web-client secret from Google Cloud Console |
| `GOOGLE_TOKEN_ENCRYPTION_KEY` | Yes | 32-byte AES-256-GCM key encrypting OAuth tokens at rest. Generate with `openssl rand -hex 32` |
| `GOOGLE_REDIRECT_URI` | No | Exact OAuth redirect URI registered in Google Cloud Console. When unset, defaults to `<app-origin>/api/google/oauth/callback` |

Rules:

- **Never prefix any of these with `NEXT_PUBLIC_`.** A `NEXT_PUBLIC_`
  variable is baked into the client bundle and visible to anyone.
- Never commit real values to git. Keep them in `.env.local` (dev) or your
  hosting provider's secret store (production). `.env.example` shows the
  shape only.
- Rotate `GOOGLE_TOKEN_ENCRYPTION_KEY` only with a migration plan: existing
  encrypted tokens in the database become undecryptable under a new key, so
  users would need to reconnect. Treat the key like a database password —
  back it up.
- There is **no** `GOOGLE_OAUTH_STATE_SECRET` in this project. OAuth state,
  the PKCE verifier, and the owner binding are stored server-side in the
  `google_oauth_transactions` table; the browser cookie carries only a random
  transaction id, so no state-signing secret is needed.

### Missing-config behavior

Server-side only. When any required variable is missing, every Google API
route fails safely with the generic message

> `Google Calendar integration is not configured on this server.`

It never says *which* variable is missing and never includes secret values.
The check is `isGoogleConfigured()` in `lib/google/server.ts`; `app/api/google`
routes return HTTP 500 with that single message (JSON routes) or redirect to
`/settings?gcal=error&reason=config` (the OAuth callback). No admin
dashboard is needed — a deployer can verify config by calling
`GET /api/google/calendars` with a session and checking for 200 vs this 500.

---

## 2. Google Cloud Console setup

Do this once per deployment (dev and production are separate OAuth clients
with separate redirect URIs).

1. **Create / select a project.** Go to
   [Google Cloud Console](https://console.cloud.google.com/), create a new
   project (or pick an existing one).
2. **Enable the Google Calendar API.** APIs & Services → Library → search
   "Google Calendar API" → Enable.
3. **Configure the OAuth consent screen.** APIs & Services → OAuth consent
   screen.
   - User type: **External** (unless the deployment is Workspace-only).
   - Fill in app name, user support email, developer contact email.
   - Scopes: add the Calendar scopes the app requests
     (`https://www.googleapis.com/auth/calendar.readonly` and
     `https://www.googleapis.com/auth/calendar.events`, see
     `GOOGLE_CALENDAR_SCOPES` in `lib/google/oauthCore.ts`).
   - While the app is in **Testing** publishing status, add each test user's
     Google address under "Test users". For production, submit the app for
     verification.
4. **Create OAuth client credentials.** APIs & Services → Credentials →
   Create Credentials → OAuth client ID → application type **Web application**.
   - Under **Authorized redirect URIs**, add the exact redirect URI the app
     will use. It must match character-for-character:
     - If `GOOGLE_REDIRECT_URI` is set: that exact value.
     - If unset: `<your-app-origin>/api/google/oauth/callback`
       (e.g. `https://app.example.com/api/google/oauth/callback`).
   - Copy the generated **Client ID** and **Client secret**.
5. **Record the values.** Put them into `.env.local` (dev) or the host's
   secret store (production) as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
   Generate the encryption key with `openssl rand -hex 32` and store it as
   `GOOGLE_TOKEN_ENCRYPTION_KEY`.

---

## 3. App-side configuration

1. Copy `.env.example` to `.env.local` and fill in the four Google variables
   (plus the Supabase ones).
2. Restart the dev server (`npm run dev`) or redeploy — env vars are read at
   runtime from `process.env`, so a restart picks them up.
3. Quick smoke check (before any user connects): sign in, then
   `GET /api/google/calendars` should return `{ "connected": false }` (200),
   not the 500 not-configured message.

---

## 4. App walkthrough (first live run)

Perform each step once with real credentials. This is the un-run E2E the
project still owes itself.

1. **Connect.** In the app: Settings → Google Calendar → Connect. Complete
   Google's consent screen. Expected: redirect back to `/settings?gcal=connected`
   and the connection shows the Google account email.
2. **Select calendar(s).** In the Google Calendar settings panel, pick which
   of the user's Google calendars participate in sync.
3. **Sync now.** Press "Sync now". Expected: success, "last synced" timestamp
   updates, no conflicts on a first run.
4. **Create a test event in the app**, link it to a selected Google calendar
   (EventForm's Google-calendar selector), run Sync now. **Verify App→Google:**
   the event appears in Google Calendar with the right title and time.
5. **Create a test event directly in Google Calendar**, run Sync now.
   **Verify Google→App:** the event appears in the app's calendar.
6. **Edit the synced app event in the app** (title only), run Sync now.
   **Verify App→Google:** Google's copy shows the new title at the same time
   (no time drift — this exercises the timezone round-trip logic).
7. **Disconnect.** Settings → Disconnect. Expected: app calendar events are
   untouched; Google-side events are untouched; reconnecting does not create
   duplicate integration records.
8. **Reconnect** and confirm sync resumes without duplicates.

---

## 5. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Google Calendar integration is not configured on this server.` (API 500 / settings error) | One of `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_TOKEN_ENCRYPTION_KEY` is missing or empty. Check the server env, restart/redeploy. |
| `redirect_uri_mismatch` at Google | The redirect URI in Google Cloud Console does not exactly match what the app sends. Compare `GOOGLE_REDIRECT_URI` (or `<origin>/api/google/oauth/callback`) character-for-character with the authorized redirect URIs list. |
| `?gcal=error&reason=config` after consent | Same as the first row — server config missing when the callback ran. |
| `?gcal=error&reason=exchange` | Code exchange failed: usually clock skew, reused code, or wrong client secret. |
| Settings shows "revoked" | The user revoked the grant in their Google account. They can reconnect; the app marks the connection revoked on `invalid_grant`. |
| Sync 502 "Google sync failed." | Google API error or network issue; not a config problem. Check server logs. |

---

## 6. Security notes for deployers

- OAuth tokens are stored AES-256-GCM encrypted (`v1:iv:ciphertext:tag`);
  the encryption key never leaves the server.
- The browser cookie (`gcal_oauth_txn`) carries only a random transaction
  id, scoped to `/api/google/oauth/callback`, httpOnly, 10-minute TTL.
- Owner identity always comes from the Supabase session user id, never from
  the client; RLS restricts all Google tables to the owner.
- Disconnect revokes the grant at Google (best-effort) and deletes the
  connection, calendar selections, and any pending OAuth transactions.
  **App calendar events are never deleted by disconnect or reconnect.**
  The event mappings (`google_event_mappings`) and incremental sync cursors
  (`google_calendar_sync_state`) are intentionally **retained** after
  disconnect, so reconnecting the *same* Google account resumes
  synchronization using the existing mappings instead of creating duplicate
  events. They contain no credentials — only sync metadata.
- Reconnecting the **same** Google account updates the existing connection
  in place and reuses the retained mappings, so no duplicate events are
  created and no duplicate integration records appear.
- One Google account per app user: connecting a **different** Google account
  revokes and replaces the old connection (its selections cascade; the old
  account's mappings and sync state are dropped so nothing leaks into the
  new account). A different account never inherits another account's
  mappings.
