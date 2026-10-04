import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { GOOGLE_CALENDAR_SCOPES, validateState } from "@/lib/google/oauthCore";
import { encryptToken } from "@/lib/google/tokenVault";
import {
  clearOAuthCookie,
  getRedirectUri,
  newOAuth2Client,
  readOAuthCookie,
} from "@/lib/google/server";

export const runtime = "nodejs";

// GET /api/google/oauth/callback — Google redirects here after consent.
// Validates state, exchanges the code for tokens, stores the encrypted
// connection, then redirects to /settings with a gcal status flag.
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
    clearOAuthCookie(res);
    return res;
  };

  if (!user) return toSettings("?gcal=error&reason=auth");

  // User denied consent (or another OAuth-level error) at Google.
  if (url.searchParams.get("error")) {
    return toSettings("?gcal=cancelled");
  }

  const cookie = readOAuthCookie(request);
  const returnedState = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code");

  if (
    !cookie ||
    cookie.exp < Date.now() ||
    cookie.userId !== user.id ||
    !validateState(cookie.state, returnedState)
  ) {
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
    const res = await client.getToken({ code, codeVerifier: cookie.verifier });
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

  // Select-then-insert-or-update via the user's own client (RLS is owner-only;
  // uniqueness is on (owner, google_account_id)).
  const { data: existing } = await supabase
    .from("google_calendar_connections")
    .select("id, refresh_token_enc")
    .eq("owner", user.id)
    .eq("google_account_id", googleAccountId)
    .maybeSingle();

  // Google only returns a refresh token on first consent (or when
  // prompt=consent forces it); on re-consent without one, keep the stored one.
  const refreshTokenEnc = tokens.refresh_token
    ? encryptToken(tokens.refresh_token)
    : (existing?.refresh_token_enc ?? null);
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
  if (existing) {
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
  if (persistError) {
    return toSettings("?gcal=error&reason=persist");
  }

  return toSettings("?gcal=connected");
}
