import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { revokeRefreshTokenEnc } from "@/lib/google/server";
import {
  DELETE_CONFIRMATION_PHRASE,
  deleteUserAccountData,
  isDeleteConfirmationValid,
} from "@/lib/accountDeletion";

export const runtime = "nodejs";

// POST /api/account/delete — permanently delete ALL of the authenticated
// user's application data (every user-owned table; see lib/accountDeletion.ts
// for the table order and Google-lifecycle semantics).
//
// Only POST is exported, so GET/PUT/DELETE/etc. are rejected by Next.js
// (405) — account deletion can never be triggered by a bare link.
//
// NOTE on auth.users: the Supabase Auth user record (auth.users) itself is
// NOT deleted by this route. This app has no service_role key by design
// (verified: none exists in the codebase), so nothing here can delete an
// Auth identity; the operator removes it via the Supabase dashboard.
// Deleting auth.users cascades to profiles (profiles.id references
// auth.users(id) ON DELETE CASCADE). All application data IS deleted by
// this route regardless.
export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Explicit, typed confirmation — anything else is rejected. The user id
  // is ALWAYS the session user's; a client-provided id is never trusted.
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  if (!isDeleteConfirmationValid(body)) {
    return NextResponse.json(
      {
        error: `Confirmation required: request body must be { "confirm": "${DELETE_CONFIRMATION_PHRASE}" }`,
      },
      { status: 400 }
    );
  }

  try {
    // Google lifecycle mirrors the disconnect route
    // (app/api/google/oauth/disconnect/route.ts): best-effort server-side
    // revocation of Google's grant first — failures are swallowed inside
    // revokeRefreshTokenEnc on purpose — then row deletion drops the
    // encrypted tokens from our database. No Google Calendar events are
    // touched: they live on Google's servers and this route makes no
    // Google Calendar API calls.
    const { data: connections } = await supabase
      .from("google_calendar_connections")
      .select("id, refresh_token_enc")
      .eq("owner", user.id);
    await Promise.all(
      (connections ?? []).map((conn) => revokeRefreshTokenEnc(conn.refresh_token_enc))
    );

    await deleteUserAccountData(supabase, user.id);

    // The session is over: sign out so no authenticated requests can follow.
    await supabase.auth.signOut();

    return NextResponse.json({ ok: true });
  } catch (err) {
    // Safe generic 500: raw database errors are never sent to the client.
    console.error("account deletion failed", err);
    return NextResponse.json({ error: "Account deletion failed" }, { status: 500 });
  }
}
