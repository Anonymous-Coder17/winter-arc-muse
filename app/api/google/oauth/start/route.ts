import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  buildAuthUrl,
  codeChallenge,
  GOOGLE_CALENDAR_SCOPES,
  newCodeVerifier,
  newOAuthState,
} from "@/lib/google/oauthCore";
import {
  encodeOAuthCookie,
  GCAL_OAUTH_COOKIE,
  GCAL_OAUTH_COOKIE_MAX_AGE_SECONDS,
  getGoogleClientId,
  getRedirectUri,
  isSecureRequest,
} from "@/lib/google/server";

export const runtime = "nodejs";

// GET /api/google/oauth/start — begins the Google OAuth consent flow.
// Requires a session. Sets an httpOnly state+PKCE cookie, then redirects the
// browser to Google's consent screen.
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

  const res = NextResponse.redirect(authUrl, 302);
  res.cookies.set(
    GCAL_OAUTH_COOKIE,
    encodeOAuthCookie({
      state,
      verifier,
      userId: user.id,
      exp: Date.now() + GCAL_OAUTH_COOKIE_MAX_AGE_SECONDS * 1000,
    }),
    {
      httpOnly: true,
      secure: isSecureRequest(request),
      sameSite: "lax",
      path: "/",
      maxAge: GCAL_OAUTH_COOKIE_MAX_AGE_SECONDS,
    }
  );
  return res;
}
