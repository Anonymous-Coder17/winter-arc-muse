import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { decryptToken } from "@/lib/google/tokenVault";

export const runtime = "nodejs";

// POST /api/google/oauth/disconnect — revoke Google's grant (best-effort)
// and delete the user's stored connections + calendar selections.
// App calendar events are NEVER touched here.
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
    (connections ?? []).map(async (conn) => {
      if (!conn.refresh_token_enc) return;
      try {
        const refreshToken = decryptToken(conn.refresh_token_enc);
        await fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ token: refreshToken }).toString(),
        });
      } catch {
        // Ignore: a revoked-at-Google-but-present-locally row is still
        // deleted below, which is what the user asked for.
      }
    })
  );

  // Selections first (FK to connections), then connections. RLS restricts
  // both deletes to the session user's own rows.
  await supabase
    .from("google_calendar_selections")
    .delete()
    .eq("owner", user.id);
  await supabase
    .from("google_calendar_connections")
    .delete()
    .eq("owner", user.id);

  return NextResponse.json({ ok: true });
}
