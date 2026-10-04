import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  NotConnectedError,
  RevokedError,
  runGoogleSync,
} from "@/lib/google/eventSync";
import {
  googleNotConfiguredResponse,
  isGoogleConfigured,
} from "@/lib/google/server";

export const runtime = "nodejs";

// POST /api/google/sync — run a two-way Google Calendar sync for the session
// user. Body: { timeZone: string } (IANA zone, used to interpret Google
// events as wall-clock time).
//
// Returns 200 with the GoogleSyncResult JSON on success. 409
// { error:"not_connected" } when no connection exists; 401
// { connected:true, revoked:true } when the grant is dead (matching the
// /api/google/calendars convention). Tokens are never included.
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const timeZone = (body as { timeZone?: unknown } | null)?.timeZone;
  if (typeof timeZone !== "string" || timeZone.trim().length === 0) {
    return NextResponse.json(
      { error: "timeZone is required." },
      { status: 400 }
    );
  }

  if (!isGoogleConfigured()) {
    // Deliberately generic: never expose env values or which variable is missing.
    return googleNotConfiguredResponse();
  }

  try {
    const result = await runGoogleSync({
      supabase,
      userId: user.id,
      timeZone: timeZone.trim(),
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof NotConnectedError) {
      return NextResponse.json({ error: "not_connected" }, { status: 409 });
    }
    if (err instanceof RevokedError) {
      return NextResponse.json(
        { connected: true, revoked: true },
        { status: 401 }
      );
    }
    return NextResponse.json({ error: "Google sync failed." }, { status: 502 });
  }
}
