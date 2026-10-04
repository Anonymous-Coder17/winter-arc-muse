import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  buildAuthUrl,
  codeChallenge,
  GOOGLE_CALENDAR_SCOPES,
  newCodeVerifier,
  newOAuthState,
} from "@/lib/google/oauthCore";
import { createOAuthTransaction } from "@/lib/google/oauthTransactions";
import {
  GCAL_OAUTH_TXN_COOKIE_MAX_AGE_SECONDS,
  getGoogleClientId,
  getRedirectUri,
  setOAuthTxnCookie,
} from "@/lib/google/server";

export const runtime = "nodejs";

// GET /api/google/oauth/start — begins the Google OAuth consent flow.
// Requires a session. Creates a server-side OAuth transaction (state +
// encrypted PKCE verifier, bound to the session user) and sets an httpOnly
// cookie holding ONLY the random transaction id, then redirects the browser
// to Google's consent screen.
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clientId = getGoogleClientId();
  if (!clientId) {
    // Deliberately generic: never expose env values or config details.
    return NextResponse.json(
      { error: "Google OAuth is not configured on the server." },
      { status: 500 }
    );
  }

  const redirectUri = getRedirectUri(request);
  const state = newOAuthState();
  const verifier = newCodeVerifier();

  const authUrl = buildAuthUrl({
    clientId,
    redirectUri,
    state,
    challenge: codeChallenge(verifier),
    scopes: GOOGLE_CALENDAR_SCOPES,
  });

  const txnId = await createOAuthTransaction(supabase, user.id, {
    state,
    verifier,
    ttlSeconds: GCAL_OAUTH_TXN_COOKIE_MAX_AGE_SECONDS,
  });

  const res = NextResponse.redirect(authUrl, 302);
  setOAuthTxnCookie(res, txnId, request);
  return res;
}
