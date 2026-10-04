import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserConnection } from "@/lib/google/server";

export const runtime = "nodejs";

const SELECTION_COLUMNS =
  "id, connection_id, google_calendar_id, calendar_name, time_zone, is_primary, selected";

interface SelectionInput {
  google_calendar_id: string;
  selected: boolean;
  calendar_name?: string;
  time_zone?: string;
  is_primary?: boolean;
}

function parseSelectionInput(value: unknown): SelectionInput | null {
  const v = value as Record<string, unknown> | null;
  if (
    !v ||
    typeof v.google_calendar_id !== "string" ||
    v.google_calendar_id.length === 0 ||
    typeof v.selected !== "boolean"
  ) {
    return null;
  }
  const input: SelectionInput = {
    google_calendar_id: v.google_calendar_id,
    selected: v.selected,
  };
  if (typeof v.calendar_name === "string") input.calendar_name = v.calendar_name;
  if (typeof v.time_zone === "string") input.time_zone = v.time_zone;
  if (typeof v.is_primary === "boolean") input.is_primary = v.is_primary;
  return input;
}

// GET /api/google/selections — the user's stored calendar selections,
// joined with their connection's account info. Owner-only via RLS.
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("google_calendar_selections")
    .select(
      `${SELECTION_COLUMNS}, google_calendar_connections ( email, google_account_id )`
    )
    .eq("owner", user.id)
    .order("calendar_name", { ascending: true });

  if (error) {
    return NextResponse.json(
      { error: "Could not load calendar selections." },
      { status: 500 }
    );
  }
  return NextResponse.json({ selections: data ?? [] });
}

// PUT /api/google/selections — upsert the user's calendar selections.
// Body: { selections: [{ google_calendar_id, selected, ...optional meta }] }.
// The connection is resolved from the session user (never trusted from the
// client); the unique (connection_id, google_calendar_id) constraint plus
// upsert means duplicates are impossible.
export async function PUT(request: Request) {
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
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const rawItems = (body as { selections?: unknown })?.selections;
  if (!Array.isArray(rawItems)) {
    return NextResponse.json(
      { error: "Body must contain a selections array." },
      { status: 400 }
    );
  }
  const parsed = rawItems.map(parseSelectionInput);
  if (parsed.some((p) => p === null)) {
    return NextResponse.json(
      {
        error:
          "Each selection needs google_calendar_id (non-empty string) and selected (boolean).",
      },
      { status: 400 }
    );
  }
  // Last-wins dedupe within the payload so a repeated calendar id upserts once.
  const byId = new Map<string, SelectionInput>();
  for (const p of parsed as SelectionInput[]) byId.set(p.google_calendar_id, p);
  const items = [...byId.values()];

  const conn = await getUserConnection(supabase, user.id);
  if (!conn) {
    return NextResponse.json(
      { error: "No Google Calendar connection found." },
      { status: 404 }
    );
  }

  const now = new Date().toISOString();
  if (items.length > 0) {
    // Optional metadata is only included when the client sent it, so an
    // update that carries just { google_calendar_id, selected } never
    // clobbers stored calendar_name / time_zone / is_primary.
    const rows = items.map((item) => ({
      owner: user.id,
      connection_id: conn.id,
      google_calendar_id: item.google_calendar_id,
      selected: item.selected,
      updated_at: now,
      ...(item.calendar_name !== undefined
        ? { calendar_name: item.calendar_name }
        : {}),
      ...(item.time_zone !== undefined ? { time_zone: item.time_zone } : {}),
      ...(item.is_primary !== undefined ? { is_primary: item.is_primary } : {}),
    }));
    const { error } = await supabase
      .from("google_calendar_selections")
      .upsert(rows, { onConflict: "connection_id,google_calendar_id" });
    if (error) {
      return NextResponse.json(
        { error: "Could not save calendar selections." },
        { status: 500 }
      );
    }
  }

  const { data, error } = await supabase
    .from("google_calendar_selections")
    .select(SELECTION_COLUMNS)
    .eq("owner", user.id)
    .eq("connection_id", conn.id)
    .order("calendar_name", { ascending: true });
  if (error) {
    return NextResponse.json(
      { error: "Could not load calendar selections." },
      { status: 500 }
    );
  }
  return NextResponse.json({ selections: data ?? [] });
}
