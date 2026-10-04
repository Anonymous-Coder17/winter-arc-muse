// lib/google/oauthCore.ts
//
// Pure OAuth2/PKCE helpers for the Google Calendar integration (V4.3.1).
// Deliberately free of Next.js imports so this module is unit-testable in
// plain node. All functions are deterministic except the random generators.

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

/** Google's authorization endpoint (OAuth 2.0 for Web Server Applications). */
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/**
 * Scopes requested during the OAuth consent flow. Read-only foundation for
 * V4.3.1 (listing the user's calendars).
 *
 * Deliberate future expansion path: when the event-sync phase lands, add
 * "https://www.googleapis.com/auth/calendar.events" to this list and re-run
 * the consent flow — Google requires re-consent whenever new scopes are
 * requested, so the callback already stores the granted scope set per
 * connection and the refresh logic re-uses whatever was granted.
 */
export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
];

/** RFC 4648 base64url without padding. */
function base64urlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** PKCE code verifier: 32 random bytes, base64url-encoded (RFC 7636). */
export function newCodeVerifier(): string {
  return base64urlEncode(randomBytes(32));
}

/** PKCE S256 code challenge for a verifier: base64url(SHA-256(verifier)). */
export function codeChallenge(verifier: string): string {
  return base64urlEncode(createHash("sha256").update(verifier, "utf8").digest());
}

/** CSRF state parameter: 32 random bytes as lowercase hex. */
export function newOAuthState(): string {
  return randomBytes(32).toString("hex");
}

export interface BuildAuthUrlParams {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  scopes: string[];
}

/**
 * Build the Google consent URL. Requests an offline refresh token
 * (access_type=offline + prompt=consent) so the server can call the Calendar
 * API later without the user present.
 */
export function buildAuthUrl({
  clientId,
  redirectUri,
  state,
  challenge,
  scopes,
}: BuildAuthUrlParams): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/**
 * Timing-safe comparison of the OAuth state returned by Google against the
 * state stored in the httpOnly cookie. Rejects empty values outright.
 */
export function validateState(expected: string, actual: string): boolean {
  if (!expected || !actual) return false;
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(actual, "utf8");
  return (
    expectedBuf.length === actualBuf.length &&
    timingSafeEqual(expectedBuf, actualBuf)
  );
}
