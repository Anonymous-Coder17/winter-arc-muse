import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { decryptToken } from "@/lib/google/tokenVault";
import {
  getUserConnection,
  InvalidGrantError,
  isInvalidGrant,
  refreshConnectionAccessToken,
} from "@/lib/google/server";
import type { GoogleCalendarListItem } from "@/lib/google/types";

export const runtime = "nodejs";

// Tokens are considered expired 60s early so a token that dies mid-request
// never reaches Google.
const EXPIRY_SKEW_MS = 60_000;

// GET /api/google/calendars — list the user's Google calendars.
// Returns { connected:false } when no connection exists. Refreshes the access
// token transparently when expired; on invalid_grant marks the connection
// revoked and returns 401 { connected:true, revoked:true }. Tokens are never
// included in the response.
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const conn = await getUserConnection(supabase, user.id);
  if (!conn) {
    return NextResponse.json({ connected: false });
  }
  if (conn.status === "revoked") {
    return NextResponse.json(
      { connected: true, revoked: true },
      { status: 401 }
    );
  }

  const markRevoked = async () => {
    await supabase
      .from("google_calendar_connections")
      .update({ status: "revoked", updated_at: new Date().toISOString() })
      .eq("id", conn.id)
      .eq("owner", user.id);
  };

  let accessToken: string | null = null;
  const expiresAt = conn.token_expires_at
    ? Date.parse(conn.token_expires_at)
    : Number.NaN;
  const stillValid =
    conn.access_token_enc &&
    Number.isFinite(expiresAt) &&
    expiresAt - EXPIRY_SKEW_MS > Date.now();

  if (stillValid && conn.access_token_enc) {
    try {
      accessToken = decryptToken(conn.access_token_enc);
    } catch {
      accessToken = null; // fall through to refresh below
    }
  }
  if (!accessToken) {
    try {
      accessToken = await refreshConnectionAccessToken(supabase, conn);
    } catch (err) {
      if (err instanceof InvalidGrantError || isInvalidGrant(err)) {
        await markRevoked();
        return NextResponse.json(
          { connected: true, revoked: true },
          { status: 401 }
        );
      }
      return NextResponse.json(
        { error: "Could not refresh the Google connection." },
        { status: 502 }
      );
    }
  }

  let list: { items?: Array<Record<string, unknown>> };
  try {
    const res = await fetch(
      "https://www.googleapis.com/calendar/v3/users/me/calendarList",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (res.status === 401) {
      // Google rejected the token outright: treat the grant as dead.
      await markRevoked();
      return NextResponse.json(
        { connected: true, revoked: true },
        { status: 401 }
      );
    }
    if (!res.ok) {
      return NextResponse.json(
        { error: "Could not load Google calendars." },
        { status: 502 }
      );
    }
    list = (await res.json()) as { items?: Array<Record<string, unknown>> };
  } catch {
    return NextResponse.json(
      { error: "Could not load Google calendars." },
      { status: 502 }
    );
  }

  const calendars: GoogleCalendarListItem[] = (list.items ?? []).map((item) => ({
    id: String(item.id ?? ""),
    summary:
      typeof item.summary === "string" && item.summary.length > 0
        ? item.summary
        : null,
    primary: item.primary === true,
    timeZone:
      typeof item.timeZone === "string" && item.timeZone.length > 0
        ? item.timeZone
        : null,
  }));

  return NextResponse.json({
    connected: true,
    email: conn.email,
    calendars,
  });
}
