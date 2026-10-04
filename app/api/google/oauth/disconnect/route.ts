import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { revokeRefreshTokenEnc } from "@/lib/google/server";

export const runtime = "nodejs";

// POST /api/google/oauth/disconnect — revoke Google's grant (best-effort)
// and delete the user's stored connections + calendar selections + any
// in-flight OAuth transactions. App calendar events are NEVER touched here.
export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: connections } = await supabase
    .from("google_calendar_connections")
    .select("id, refresh_token_enc")
    .eq("owner", user.id);

  // Best-effort server-side revocation. Failures are ignored on purpose:
  // local state is authoritative and Google's revoke endpoint is advisory.
  await Promise.all(
    (connections ?? []).map((conn) => revokeRefreshTokenEnc(conn.refresh_token_enc))
  );

  // Selections first (FK to connections), then connections, then any
  // in-flight OAuth transactions. RLS restricts all deletes to the session
  // user's own rows.
  await supabase
    .from("google_calendar_selections")
    .delete()
    .eq("owner", user.id);
  await supabase
    .from("google_calendar_connections")
    .delete()
    .eq("owner", user.id);
  await supabase
    .from("google_oauth_transactions")
    .delete()
    .eq("owner", user.id);

  return NextResponse.json({ ok: true });
}
