import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { buildUserExport } from "@/lib/export";
import { todayKeyUtc } from "@/lib/dates";

export const runtime = "nodejs";

// GET /api/export — download a JSON archive of the authenticated user's data.
//
// Auth: the owner comes ONLY from the session (supabase.auth.getUser()).
// There is no client-provided user id anywhere on this route.
// Errors are deliberately generic: DB error details never reach the client.
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = await buildUserExport(supabase, user.id);
    const stamp = todayKeyUtc(); // UTC YYYY-MM-DD
    return NextResponse.json(payload, {
      headers: {
        "Content-Disposition": `attachment; filename="winter-arc-export-${stamp}.json"`,
      },
    });
  } catch {
    return NextResponse.json({ error: "Export failed." }, { status: 500 });
  }
}
