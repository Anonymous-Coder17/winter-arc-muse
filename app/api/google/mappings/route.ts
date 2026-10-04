import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserConnection } from "@/lib/google/server";

export const runtime = "nodejs";

// POST /api/google/mappings — link a local calendar event to one of the
// user's selected Google calendars so future syncs push it to Google.
// Body: { localEventId: string, googleCalendarId: string }.
//
// The event must belong to the session user and the calendar must be one of
// their SELECTED calendars. Creates a mapping row with origin "synced"; if a
// mapping already exists for the event it is left untouched (the event is
// already queued for push on the next sync).
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
  const localEventId = (body as { localEventId?: unknown } | null)?.localEventId;
  const googleCalendarId = (body as { googleCalendarId?: unknown } | null)
    ?.googleCalendarId;
  if (
    typeof localEventId !== "string" ||
    localEventId.length === 0 ||
    typeof googleCalendarId !== "string" ||
    googleCalendarId.length === 0
  ) {
    return NextResponse.json(
      { error: "localEventId and googleCalendarId are required." },
      { status: 400 }
    );
  }

  const conn = await getUserConnection(supabase, user.id);
  if (!conn) {
    return NextResponse.json({ error: "not_connected" }, { status: 409 });
  }

  // The event must belong to the session user.
  const { data: event, error: eventError } = await supabase
    .from("calendar_events")
    .select("id")
    .eq("id", localEventId)
    .eq("owner", user.id)
    .maybeSingle();
  if (eventError || !event) {
    return NextResponse.json({ error: "Event not found." }, { status: 404 });
  }

  // The calendar must be one of the user's SELECTED calendars.
  const { data: selection } = await supabase
    .from("google_calendar_selections")
    .select("google_calendar_id")
    .eq("owner", user.id)
    .eq("google_calendar_id", googleCalendarId)
    .eq("selected", true)
    .maybeSingle();
  if (!selection) {
    return NextResponse.json(
      { error: "Calendar is not selected for sync." },
      { status: 400 }
    );
  }

  const { error: upsertError } = await supabase
    .from("google_event_mappings")
    .upsert(
      {
        owner: user.id,
        local_event_id: localEventId,
        google_account_id: conn.google_account_id,
        google_calendar_id: googleCalendarId,
        origin: "synced",
      },
      { onConflict: "owner,local_event_id", ignoreDuplicates: true }
    );
  if (upsertError) {
    return NextResponse.json(
      { error: "Could not link the event." },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true });
}
