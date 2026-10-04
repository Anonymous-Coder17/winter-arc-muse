import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { GOOGLE_CALENDAR_SCOPES, validateState } from "@/lib/google/oauthCore";
import { encryptToken } from "@/lib/google/tokenVault";
import {
  clearOAuthTxnCookie,
  getRedirectUri,
  getUserConnection,
  newOAuth2Client,
  readOAuthTxnCookie,
  resolveConnectionAction,
  revokeRefreshTokenEnc,
} from "@/lib/google/server";
import {
  consumeOAuthTransaction,
  deleteOAuthTransaction,
} from "@/lib/google/oauthTransactions";

export const runtime = "nodejs";

// GET /api/google/oauth/callback — Google redirects here after consent.
// Consumes the server-side OAuth transaction (single-use; the transaction
// row is deleted on consume), validates state, exchanges the code for
// tokens with the server-held PKCE verifier, then stores the encrypted
// connection and redirects to /settings with a gcal status flag.
//
// The session user is the ONLY identity source: no client-supplied user id
// is trusted anywhere in this flow. One Google account per app user: when
// the consented account differs from the linked one, the old connection is
// revoked and replaced.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const toSettings = (query: string): NextResponse => {
    const res = NextResponse.redirect(
      `${url.origin}/settings${query}`,
      302
    );
    clearOAuthTxnCookie(res);
    return res;
  };

  if (!user) return toSettings("?gcal=error&reason=auth");

  const txnId = readOAuthTxnCookie(request);

  // User denied consent (or another OAuth-level error) at Google: drop the
  // transaction so no stale state survives the aborted flow.
  if (url.searchParams.get("error")) {
    if (txnId) await deleteOAuthTransaction(supabase, user.id, txnId);
    return toSettings("?gcal=cancelled");
  }

  const returnedState = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code");

  // Atomic single-use consume. Null means the transaction is missing,
  // expired, already consumed, or owned by a different user. On success the
  // row is already deleted, so the id can never be replayed.
  const txn = txnId
    ? await consumeOAuthTransaction(supabase, user.id, txnId)
    : null;
  if (!txn || !validateState(txn.state, returnedState)) {
    return toSettings("?gcal=error&reason=state");
  }
  if (!code) {
    return toSettings("?gcal=error&reason=code");
  }

  const redirectUri = getRedirectUri(request);
  let client;
  try {
    client = newOAuth2Client(redirectUri);
  } catch {
    return toSettings("?gcal=error&reason=config");
  }

  let tokens;
  try {
    const res = await client.getToken({ code, codeVerifier: txn.verifier });
    tokens = res.tokens;
  } catch {
    return toSettings("?gcal=error&reason=exchange");
  }

  // Identify the Google account the tokens belong to.
  let googleAccountId: string | undefined;
  let email: string | null = null;
  try {
    const me = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!me.ok) return toSettings("?gcal=error&reason=userinfo");
    const info = (await me.json()) as { sub?: string; email?: string };
    googleAccountId = info.sub;
    email = info.email ?? null;
  } catch {
    return toSettings("?gcal=error&reason=userinfo");
  }
  if (!googleAccountId) return toSettings("?gcal=error&reason=userinfo");

  // One account per user: the decision is pure, the rows are owner-only
  // (RLS), and uniqueness is enforced by unique(owner) in the database.
  const existing = await getUserConnection(supabase, user.id);
  const action = resolveConnectionAction(existing, googleAccountId);

  // Google only returns a refresh token on first consent (or when
  // prompt=consent forces it); on re-consent without one, keep the stored
  // one — but only when updating the SAME account. Across accounts (replace)
  // or on fresh insert, never carry the old grant over.
  const refreshTokenEnc = tokens.refresh_token
    ? encryptToken(tokens.refresh_token)
    : action === "update"
      ? (existing?.refresh_token_enc ?? null)
      : null;
  const accessTokenEnc = tokens.access_token
    ? encryptToken(tokens.access_token)
    : null;
  const tokenExpiresAt = tokens.expiry_date
    ? new Date(tokens.expiry_date).toISOString()
    : null;
  const scopes =
    tokens.scope && tokens.scope.trim().length > 0
      ? tokens.scope.split(" ").filter(Boolean)
      : [...GOOGLE_CALENDAR_SCOPES];
  const now = new Date().toISOString();

  let persistError: unknown = null;
  if (action === "update" && existing) {
    const { error } = await supabase
      .from("google_calendar_connections")
      .update({
        email,
        status: "connected",
        scopes,
        refresh_token_enc: refreshTokenEnc,
        access_token_enc: accessTokenEnc,
        token_expires_at: tokenExpiresAt,
        updated_at: now,
      })
      .eq("id", existing.id)
      .eq("owner", user.id);
    persistError = error;
  } else {
    if (action === "replace" && existing) {
      // The consented account differs from the linked one. Best-effort
      // revoke the old grant, then delete the row — its selections cascade,
      // so no stale selection can leak into the new connection. App
      // calendar events are NEVER touched here.
      await revokeRefreshTokenEnc(existing.refresh_token_enc);
      const { error: deleteError } = await supabase
        .from("google_calendar_connections")
        .delete()
        .eq("id", existing.id)
        .eq("owner", user.id);
      if (deleteError) persistError = deleteError;
      // Sync state belongs to the replaced account: drop its event mappings
      // and incremental sync tokens so nothing leaks into the new
      // connection. Best-effort; app calendar events are NEVER touched.
      await supabase
        .from("google_event_mappings")
        .delete()
        .eq("owner", user.id)
        .eq("google_account_id", existing.google_account_id);
      await supabase
        .from("google_calendar_sync_state")
        .delete()
        .eq("owner", user.id)
        .eq("google_account_id", existing.google_account_id);
    }
    if (!persistError) {
      const { error } = await supabase
        .from("google_calendar_connections")
        .insert({
          id: randomUUID(),
          owner: user.id,
          google_account_id: googleAccountId,
          email,
          status: "connected",
          scopes,
          refresh_token_enc: refreshTokenEnc,
          access_token_enc: accessTokenEnc,
          token_expires_at: tokenExpiresAt,
        });
      persistError = error;
    }
  }
  if (persistError) {
    return toSettings("?gcal=error&reason=persist");
  }

  return toSettings("?gcal=connected");
}
