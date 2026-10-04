import "server-only";

// lib/google/server.ts
//
// SERVER ONLY. Shared helpers for the /api/google/* route handlers:
// environment/config access, OAuth2Client construction, the httpOnly
// state+PKCE cookie, connection lookup, and access-token refresh.
//
// Security invariants live here:
//  - No secret, refresh token, or access token is ever returned or logged.
//  - The owner always comes from the session user id, never from the client.

import { OAuth2Client } from "google-auth-library";
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptToken, encryptToken } from "./tokenVault";
import type { GoogleCalendarConnection } from "./types";

export const GCAL_OAUTH_COOKIE = "gcal_oauth";
export const GCAL_OAUTH_COOKIE_MAX_AGE_SECONDS = 600;

/** Payload stored (base64url-encoded) in the httpOnly gcal_oauth cookie. */
export interface OAuthCookiePayload {
  state: string;
  verifier: string;
  userId: string;
  exp: number;
}

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

/** The gcal_oauth cookie is Secure only over https / in production. */
export function isSecureRequest(request: Request): boolean {
  return (
    request.url.startsWith("https://") || process.env.NODE_ENV === "production"
  );
}

export function encodeOAuthCookie(payload: OAuthCookiePayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function isOAuthCookiePayload(v: unknown): v is OAuthCookiePayload {
  const p = v as Partial<OAuthCookiePayload> | null;
  return (
    !!p &&
    typeof p.state === "string" &&
    typeof p.verifier === "string" &&
    typeof p.userId === "string" &&
    typeof p.exp === "number"
  );
}

/** Read + shape-validate the gcal_oauth cookie from the incoming request. */
export function readOAuthCookie(request: Request): OAuthCookiePayload | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  const pair = header
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(GCAL_OAUTH_COOKIE + "="));
  if (!pair) return null;
  const raw = pair.slice(GCAL_OAUTH_COOKIE.length + 1);
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8")
    );
    return isOAuthCookiePayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Expire the gcal_oauth cookie on an outgoing response. */
export function clearOAuthCookie(res: NextResponse): void {
  res.cookies.set(GCAL_OAUTH_COOKIE, "", {
    path: "/",
    maxAge: 0,
    httpOnly: true,
    sameSite: "lax",
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
