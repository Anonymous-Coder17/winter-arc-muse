import "server-only";

// lib/google/server.ts
//
// SERVER ONLY. Shared helpers for the /api/google/* route handlers:
// environment/config access, OAuth2Client construction, the httpOnly OAuth
// transaction-id cookie, connection lookup, and access-token refresh.
//
// Security invariants live here:
//  - No secret, refresh token, or access token is ever returned or logged.
//  - The owner always comes from the session user id, never from the client.
//  - The browser cookie carries ONLY a random OAuth transaction id. The
//    OAuth state, PKCE verifier, and owner binding live server-side in
//    google_oauth_transactions (see lib/google/oauthTransactions.ts).

import { OAuth2Client } from "google-auth-library";
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptToken, encryptToken } from "./tokenVault";
import type { GoogleCalendarConnection } from "./types";

/**
 * Cookie holding the OAuth transaction id. The cookie is scoped narrowly to
 * the callback route (the only route that reads it) and expires with the
 * transaction itself (10 minutes).
 */
export const GCAL_OAUTH_TXN_COOKIE = "gcal_oauth_txn";
export const GCAL_OAUTH_TXN_COOKIE_PATH = "/api/google/oauth/callback";
export const GCAL_OAUTH_TXN_COOKIE_MAX_AGE_SECONDS = 600;

function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

export function getGoogleClientId(): string | undefined {
  return env("GOOGLE_CLIENT_ID");
}

export function getGoogleClientSecret(): string | undefined {
  return env("GOOGLE_CLIENT_SECRET");
}

/**
 * True only when every Google Calendar credential is present and non-empty:
 * GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_TOKEN_ENCRYPTION_KEY.
 *
 * Server-side only. Never reveals which value is missing and never carries
 * secret values — route clients to GOOGLE_NOT_CONFIGURED_MESSAGE instead.
 */
export function isGoogleConfigured(): boolean {
  return Boolean(
    getGoogleClientId() &&
      getGoogleClientSecret() &&
      env("GOOGLE_TOKEN_ENCRYPTION_KEY")
  );
}

/**
 * The single, secret-free message every /api/google route returns when the
 * integration is not configured. It never names the missing variable and
 * never carries secret values.
 */
export const GOOGLE_NOT_CONFIGURED_MESSAGE =
  "Google Calendar integration is not configured on this server.";

/** 500 JSON response carrying only the generic not-configured message. */
export function googleNotConfiguredResponse(): NextResponse {
  return NextResponse.json(
    { error: GOOGLE_NOT_CONFIGURED_MESSAGE },
    { status: 500 }
  );
}

/**
 * Redirect URI for the OAuth flow: GOOGLE_REDIRECT_URI when explicitly
 * configured, otherwise <request origin>/api/google/oauth/callback. The
 * callback route resolves this the same way so Google's exact-match check
 * passes.
 */
export function getRedirectUri(request: Request): string {
  const configured = env("GOOGLE_REDIRECT_URI");
  if (configured) return configured;
  return new URL(request.url).origin + "/api/google/oauth/callback";
}

/**
 * OAuth2 client for the authorization-code exchange (needs redirect_uri).
 * Throws a clear, env-value-free error when Google OAuth is not configured.
 */
export function newOAuth2Client(redirectUri: string): OAuth2Client {
  const clientId = getGoogleClientId();
  const clientSecret = getGoogleClientSecret();
  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth is not configured on the server.");
  }
  return new OAuth2Client({ clientId, clientSecret, redirectUri });
}

/** OAuth2 client for refresh-token calls (no redirect_uri needed). */
function newRefreshClient(): OAuth2Client {
  const clientId = getGoogleClientId();
  const clientSecret = getGoogleClientSecret();
  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth is not configured on the server.");
  }
  return new OAuth2Client({ clientId, clientSecret });
}

/** The txn cookie is Secure only over https / in production. */
export function isSecureRequest(request: Request): boolean {
  return (
    request.url.startsWith("https://") || process.env.NODE_ENV === "production"
  );
}

/**
 * Set the transaction-id cookie on an outgoing response. It carries ONLY the
 * random transaction id — no state, no verifier, no user id.
 */
export function setOAuthTxnCookie(
  res: NextResponse,
  txnId: string,
  request: Request
): void {
  res.cookies.set(GCAL_OAUTH_TXN_COOKIE, txnId, {
    httpOnly: true,
    secure: isSecureRequest(request),
    sameSite: "lax",
    path: GCAL_OAUTH_TXN_COOKIE_PATH,
    maxAge: GCAL_OAUTH_TXN_COOKIE_MAX_AGE_SECONDS,
  });
}

/** Read the transaction id from the callback-scoped cookie. */
export function readOAuthTxnCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  const pair = header
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(GCAL_OAUTH_TXN_COOKIE + "="));
  if (!pair) return null;
  const value = pair.slice(GCAL_OAUTH_TXN_COOKIE.length + 1).trim();
  return value.length > 0 ? value : null;
}

/** Expire the transaction-id cookie on an outgoing response. */
export function clearOAuthTxnCookie(res: NextResponse): void {
  res.cookies.set(GCAL_OAUTH_TXN_COOKIE, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: GCAL_OAUTH_TXN_COOKIE_PATH,
    maxAge: 0,
  });
}

/** True when a Google error payload/message signals a revoked grant. */
export function isInvalidGrant(err: unknown): boolean {
  const anyErr = err as {
    response?: { data?: { error?: unknown } };
    message?: unknown;
  } | null;
  if (anyErr?.response?.data?.error === "invalid_grant") return true;
  return String(anyErr?.message ?? "").includes("invalid_grant");
}

/** Thrown when the stored grant can no longer produce an access token. */
export class InvalidGrantError extends Error {}

/**
 * The user's most recently updated Google connection (owner always from the
 * session user id; RLS additionally restricts rows to the owner).
 */
export async function getUserConnection(
  supabase: SupabaseClient,
  userId: string
): Promise<GoogleCalendarConnection | null> {
  const { data, error } = await supabase
    .from("google_calendar_connections")
    .select("*")
    .eq("owner", userId)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error || !data || data.length === 0) return null;
  return data[0] as GoogleCalendarConnection;
}

export type ConnectionAction = "update" | "replace" | "insert";

/**
 * Pure decision helper for the one-account-per-user model:
 *  - "update":  a connection exists for this exact Google account — update it
 *    in place.
 *  - "replace": a connection exists for a DIFFERENT Google account — revoke
 *    it, delete the row (selections cascade), and insert the new one.
 *  - "insert":  no existing connection — insert.
 */
export function resolveConnectionAction(
  existing: { google_account_id: string } | null,
  googleAccountId: string
): ConnectionAction {
  if (!existing) return "insert";
  return existing.google_account_id === googleAccountId ? "update" : "replace";
}

/**
 * Best-effort server-side revocation of a Google refresh token (passed as
 * AES-256-GCM ciphertext, decrypted only for the single revoke call). Any
 * failure is swallowed on purpose: local state is authoritative and
 * Google's revoke endpoint is advisory. Never throws, never returns or logs
 * token material.
 */
export async function revokeRefreshTokenEnc(
  refreshTokenEnc: string | null
): Promise<void> {
  if (!refreshTokenEnc) return;
  try {
    const refreshToken = decryptToken(refreshTokenEnc);
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token: refreshToken }).toString(),
    });
  } catch {
    // Ignore: local deletion is what matters; a grant Google already forgot
    // about (or that outlives this best-effort call) is harmless.
  }
}

/**
 * Ensure a usable access token for a connection: decrypt the stored refresh
 * token, refresh via Google, re-encrypt and persist the new access token.
 * Throws InvalidGrantError when the grant is dead (no refresh token, or
 * Google reports invalid_grant). Never returns or logs token material.
 */
export async function refreshConnectionAccessToken(
  supabase: SupabaseClient,
  conn: GoogleCalendarConnection
): Promise<string> {
  if (!conn.refresh_token_enc) {
    throw new InvalidGrantError("Connection has no refresh token.");
  }
  const refreshToken = decryptToken(conn.refresh_token_enc);
  const client = newRefreshClient();
  client.setCredentials({ refresh_token: refreshToken });

  let accessToken: string | undefined;
  let expiryDate: number | null | undefined;
  try {
    const res = await client.refreshAccessToken();
    accessToken = res.credentials.access_token ?? undefined;
    expiryDate = res.credentials.expiry_date;
  } catch (err) {
    if (isInvalidGrant(err)) {
      throw new InvalidGrantError("Google revoked the OAuth grant.");
    }
    throw err;
  }
  if (!accessToken) {
    throw new Error("Google did not return an access token.");
  }

  await supabase
    .from("google_calendar_connections")
    .update({
      access_token_enc: encryptToken(accessToken),
      token_expires_at: expiryDate
        ? new Date(expiryDate).toISOString()
        : null,
      status: "connected",
      updated_at: new Date().toISOString(),
    })
    .eq("id", conn.id)
    .eq("owner", conn.owner);

  return accessToken;
}
