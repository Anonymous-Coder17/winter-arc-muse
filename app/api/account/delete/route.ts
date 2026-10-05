import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, deleteAuthUser } from "@/lib/supabase/admin";
import { revokeRefreshTokenEnc } from "@/lib/google/server";
import {
  DELETE_CONFIRMATION_PHRASE,
  deleteUserAccountData,
  isDeleteConfirmationValid,
} from "@/lib/accountDeletion";

export const runtime = "nodejs";

// POST /api/account/delete — permanently delete the authenticated user's
// Winter Arc account: every user-owned application row (see
// lib/accountDeletion.ts for the table order and Google-lifecycle
// semantics) AND the Supabase Auth identity itself (auth.users).
//
// Only POST is exported, so GET/PUT/DELETE/etc. are rejected by Next.js
// (405) — account deletion can never be triggered by a bare link.
//
// Auth deletion mechanism: a server-only admin client built from
// SUPABASE_SERVICE_ROLE_KEY (lib/supabase/admin.ts). The key is never a
// NEXT_PUBLIC_ variable, never reaches client code, and the admin client
// is used ONLY for this deletion — ordinary operations keep using the
// session-based RLS-enforced client.
//
// Ordering (failure-safe):
//   1. Authenticate + validate the typed confirmation.
//   2. Fail fast if the admin client cannot be created (misconfigured
//      server) — BEFORE any destructive work, so we never delete app data
//      and then find we cannot complete the Auth deletion.
//   3. Best-effort server-side revocation of Google's OAuth grant.
//   4. Delete application data (idempotent; RLS-enforced session client).
//   5. Delete auth.users via the admin client. profiles cascades via
//      profiles.id -> auth.users(id) ON DELETE CASCADE (migration 0001).
//   6. Best-effort signOut (the identity is already gone).
// If step 4 or 5 fails the route returns a safe generic 500, never claims
// the account was deleted, and the operation stays retryable (both steps
// are idempotent). Google Calendar events are NEVER touched: they live on
// Google's servers and this route makes no Google Calendar API calls.
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

  // Fail fast before any destructive work: without the service-role key we
  // cannot complete the Auth deletion, so refuse rather than leaving a
  // half-deleted account.
  let admin;
  try {
    admin = createAdminClient();
  } catch (err) {
    console.error("account deletion misconfigured", err);
    return NextResponse.json({ error: "Account deletion failed" }, { status: 500 });
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

    // 1. Application-owned data, via the RLS-enforced session client.
    await deleteUserAccountData(supabase, user.id);

    // 2. The Supabase Auth identity itself. user.id comes from the server
    // side session above — a client-supplied id can never reach here.
    await deleteAuthUser(admin, user.id);

    // 3. Session termination. Best-effort: the Auth identity no longer
    // exists, and the client clears its own cookies/local state too.
    try {
      await supabase.auth.signOut();
    } catch {
      /* identity already deleted; nothing to revoke server-side */
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    // Safe generic 500: raw database errors, Auth admin errors, and any
    // service-role details are never sent to the client.
    console.error("account deletion failed", err);
    return NextResponse.json({ error: "Account deletion failed" }, { status: 500 });
  }
}
