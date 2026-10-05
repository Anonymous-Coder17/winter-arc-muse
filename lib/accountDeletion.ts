/**
 * V4.8 (Data & Account Safety): safe server-side account deletion.
 *
 * `deleteUserAccountData(supabase, userId)` permanently deletes every row
 * owned by `userId` across all user-owned tables, in dependency order
 * (children before parents), using the session-based RLS-enforced client.
 * There is no service_role key in this app by design, so deletion can only
 * ever touch rows RLS already grants to the session user.
 *
 * This is DELETION, not archiving: it runs only when the user explicitly
 * asks for it (the /api/account/delete route enforces an explicit typed
 * confirmation phrase). Archive semantics elsewhere in the app are untouched.
 *
 * Google lifecycle: mirrors app/api/google/oauth/disconnect/route.ts —
 * selections (FK child of connections) are deleted before connections, then
 * OAuth transactions; deleting the connection row drops the encrypted
 * OAuth tokens. One deliberate difference from disconnect, documented here:
 * disconnect RETAINS google_event_mappings + google_calendar_sync_state so
 * a same-account reconnect resumes without duplicating events. Account
 * deletion drops those tables' rows too: the account is gone, so no
 * reconnect can ever happen and retaining sync cursors for a deleted user
 * serves no purpose. Google Calendar events themselves live on Google's
 * servers and are NEVER touched here — this module makes no Google API
 * calls of any kind.
 *
 * Two RLS caveats, both intentional:
 *  - `profiles` has no DELETE policy (select/insert/update only), so the
 *    session client cannot delete the profile row; the delete is a silent
 *    no-op under RLS. The row is removed later automatically:
 *    profiles.id references auth.users(id) ON DELETE CASCADE, so deleting
 *    the Auth user (operator step, see the route) removes it.
 *  - `sync_applied_mutations` names its owner column `owner_id`, not
 *    `owner`; the plan below carries the column per table.
 *
 * Idempotent: deleting zero rows succeeds, so running twice is safe.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Exact phrase the UI must collect and the API route must require. */
export const DELETE_CONFIRMATION_PHRASE = "DELETE MY ACCOUNT";

/**
 * Pure check for the delete-confirmation body. Kept here (not in the route)
 * so it is unit-testable without a Next.js request context.
 */
export function isDeleteConfirmationValid(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { confirm?: unknown }).confirm === DELETE_CONFIRMATION_PHRASE
  );
}

interface DeletionStep {
  /** Table to delete from. */
  table: string;
  /** Column holding the owning user id (`profiles` uses `id`). */
  ownerColumn: "owner" | "owner_id" | "id";
}

/**
 * Deletion plan in execution order. Rationale per group:
 *  - workout_sets -> workout_sessions/workout_exercises -> workouts:
 *    composite FKs (0003) cascade, but children are deleted first anyway so
 *    the plan does not depend on FK behavior.
 *  - habit_logs -> habits; abstinence_incidents -> abstinence_rules;
 *    limit_logs -> usage_limits: FK children first.
 *  - reading_logs BEFORE books: reading_logs.book_id is ON DELETE RESTRICT
 *    (0005/0006) — deleting a book with logged pages would fail.
 *  - study_sessions -> topics -> subjects: FK children first.
 *  - challenge_reviews -> challenges: FK child first.
 *  - google_calendar_selections -> google_calendar_connections ->
 *    google_oauth_transactions: mirrors the disconnect route's order
 *    (selections FK to connections).
 *  - google_event_mappings + google_calendar_sync_state: dropped for
 *    account deletion (see header); deleted before calendar_events for
 *    cleanliness (local_event_id is only ON DELETE SET NULL).
 *  - Remaining tables are FK-independent; profiles is last-but-one because
 *    its delete is an RLS no-op (see header).
 */
const DELETION_PLAN: DeletionStep[] = [
  { table: "workout_sets", ownerColumn: "owner" },
  { table: "workout_sessions", ownerColumn: "owner" },
  { table: "workout_exercises", ownerColumn: "owner" },
  { table: "training_schedule", ownerColumn: "owner" },
  { table: "workouts", ownerColumn: "owner" },
  { table: "habit_logs", ownerColumn: "owner" },
  { table: "habits", ownerColumn: "owner" },
  { table: "abstinence_incidents", ownerColumn: "owner" },
  { table: "abstinence_rules", ownerColumn: "owner" },
  { table: "limit_logs", ownerColumn: "owner" },
  { table: "usage_limits", ownerColumn: "owner" },
  { table: "reading_logs", ownerColumn: "owner" },
  { table: "books", ownerColumn: "owner" },
  { table: "study_sessions", ownerColumn: "owner" },
  { table: "topics", ownerColumn: "owner" },
  { table: "subjects", ownerColumn: "owner" },
  { table: "challenge_reviews", ownerColumn: "owner" },
  { table: "challenges", ownerColumn: "owner" },
  { table: "google_calendar_selections", ownerColumn: "owner" },
  { table: "google_calendar_connections", ownerColumn: "owner" },
  { table: "google_oauth_transactions", ownerColumn: "owner" },
  { table: "google_event_mappings", ownerColumn: "owner" },
  { table: "google_calendar_sync_state", ownerColumn: "owner" },
  { table: "calendar_events", ownerColumn: "owner" },
  { table: "tasks", ownerColumn: "owner" },
  { table: "daily_records", ownerColumn: "owner" },
  { table: "daily_reviews", ownerColumn: "owner" },
  { table: "weekly_reviews", ownerColumn: "owner" },
  { table: "journal_entries", ownerColumn: "owner" },
  { table: "profiles", ownerColumn: "id" },
  { table: "sync_applied_mutations", ownerColumn: "owner_id" },
];

/** Table names in deletion order, exported for tests and auditing. */
export const USER_TABLES_DELETION_ORDER: string[] = DELETION_PLAN.map(
  (step) => step.table
);

/**
 * Delete every row owned by `userId` across all user-owned tables.
 *
 * @param supabase Session-based (RLS-enforced) Supabase client.
 * @param userId   The authenticated user's id — callers must pass the
 *                 SESSION user id, never a client-provided value.
 * @throws Error naming the table if any delete fails. The message is for
 *         server-side logs only; the API route returns a safe generic 500
 *         and never forwards raw database errors to the client.
 */
export async function deleteUserAccountData(
  supabase: SupabaseClient,
  userId: string
): Promise<void> {
  if (!userId || typeof userId !== "string") {
    throw new Error("deleteUserAccountData: userId is required");
  }
  for (const { table, ownerColumn } of DELETION_PLAN) {
    const { error } = await supabase
      .from(table)
      .delete()
      .eq(ownerColumn, userId);
    if (error) {
      // Logged server-side; never surfaced verbatim to the client.
      throw new Error(
        `deleteUserAccountData: failed deleting from "${table}": ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}
