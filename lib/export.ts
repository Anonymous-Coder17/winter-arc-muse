import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * V4.8 (Data & Account Safety) — "Export my data".
 *
 * Reads every user-owned table scoped to the owner and returns a single JSON
 * archive. There is no data transformation beyond removing secrets: rows are
 * returned as-is (dates/timestamps stay as ISO strings from the DB).
 *
 * Secrets that NEVER appear in an export:
 * - google_calendar_connections.refresh_token_enc / access_token_enc
 *   (AES-256-GCM ciphertext of Google OAuth tokens) — the columns are not
 *   even selected, so the ciphertext never leaves the database.
 * - google_calendar_sync_state.sync_token — Google's incremental-sync
 *   cursor; internal sync machinery, not user data.
 * - google_oauth_transactions — skipped entirely: transient OAuth security
 *   artifacts (CSRF `state`, encrypted PKCE verifier), not user data.
 * - sync_applied_mutations — skipped entirely: internal offline-sync
 *   idempotency ledger, not user data.
 *
 * Scoping is defense-in-depth: callers pass a session-based, RLS-enforced
 * Supabase client (RLS already limits rows to auth.uid() = owner), and every
 * table is ALSO explicitly filtered on its owner column.
 */

export const EXPORT_VERSION = 1;

export interface UserExportPayload {
  export_version: number;
  exported_at: string;
  data: Record<string, Record<string, unknown>[]>;
}

export interface ExportTableSpec {
  table: string;
  ownerColumn: "owner" | "owner_id" | "id";
  /** undefined = select all columns. Explicit lists keep secrets off the wire. */
  columns?: string;
  /**
   * When true the table is intentionally excluded from the export; the key
   * is still present in `data` as an empty array for a stable schema.
   */
  excluded?: boolean;
  /** Documented reason for the exclusion. */
  exclusionReason?: string;
}

/**
 * One entry per user-owned table, keyed by table name in the export payload.
 * Keep in sync with supabase/migrations: adding a user-owned table must add
 * an entry here (with explicit column lists for any table holding secrets).
 */
export const EXPORT_TABLES: ExportTableSpec[] = [
  { table: "profiles", ownerColumn: "id" },
  { table: "challenges", ownerColumn: "owner" },
  { table: "habits", ownerColumn: "owner" },
  { table: "habit_logs", ownerColumn: "owner" },
  { table: "abstinence_rules", ownerColumn: "owner" },
  { table: "abstinence_incidents", ownerColumn: "owner" },
  { table: "usage_limits", ownerColumn: "owner" },
  { table: "limit_logs", ownerColumn: "owner" },
  { table: "tasks", ownerColumn: "owner" },
  { table: "calendar_events", ownerColumn: "owner" },
  { table: "daily_records", ownerColumn: "owner" },
  { table: "workouts", ownerColumn: "owner" },
  { table: "workout_exercises", ownerColumn: "owner" },
  { table: "workout_sessions", ownerColumn: "owner" },
  { table: "workout_sets", ownerColumn: "owner" },
  { table: "training_schedule", ownerColumn: "owner" },
  { table: "subjects", ownerColumn: "owner" },
  { table: "topics", ownerColumn: "owner" },
  { table: "study_sessions", ownerColumn: "owner" },
  { table: "journal_entries", ownerColumn: "owner" },
  { table: "daily_reviews", ownerColumn: "owner" },
  { table: "weekly_reviews", ownerColumn: "owner" },
  { table: "challenge_reviews", ownerColumn: "owner" },
  { table: "books", ownerColumn: "owner" },
  { table: "reading_logs", ownerColumn: "owner" },
  {
    table: "google_calendar_connections",
    ownerColumn: "owner",
    // refresh_token_enc / access_token_enc hold the encrypted Google OAuth
    // tokens and are deliberately NOT selected: only connection metadata is
    // exported. Column list mirrors 0008 (plus 0009's one-per-owner guard,
    // which adds a constraint, not a column).
    columns:
      "id, owner, google_account_id, email, status, token_expires_at, scopes, created_at, updated_at",
  },
  { table: "google_calendar_selections", ownerColumn: "owner" },
  {
    table: "google_calendar_sync_state",
    ownerColumn: "owner",
    // sync_token (0010) is Google's incremental-sync cursor: internal sync
    // machinery, not user data. Everything else is user-visible metadata.
    columns:
      "id, owner, google_account_id, google_calendar_id, last_synced_at, created_at, updated_at",
  },
  { table: "google_event_mappings", ownerColumn: "owner" },
  {
    table: "google_oauth_transactions",
    ownerColumn: "owner",
    excluded: true,
    exclusionReason:
      "Transient OAuth security artifacts (CSRF state + AES-256-GCM encrypted PKCE verifier); not user data and must never be exported.",
  },
  {
    table: "sync_applied_mutations",
    ownerColumn: "owner_id",
    excluded: true,
    exclusionReason:
      "Internal offline-sync idempotency ledger (mutation ids, deltas); not user data.",
  },
];

/**
 * Build the full user data export for `userId`.
 *
 * @param supabase A session-based, RLS-enforced Supabase client for the
 *                 authenticated user. The owner comes ONLY from the session —
 *                 never trust a client-provided id at the call site.
 * @param userId   The authenticated user's id (from supabase.auth.getUser()).
 * @throws A generic Error on any read failure; DB error details are logged
 *         server-side only and never exposed to the client.
 */
export async function buildUserExport(
  supabase: SupabaseClient,
  userId: string
): Promise<UserExportPayload> {
  if (!userId || typeof userId !== "string") {
    throw new Error("User data export requires an authenticated user id.");
  }

  const data: Record<string, Record<string, unknown>[]> = {};
  for (const spec of EXPORT_TABLES) {
    if (spec.excluded) {
      data[spec.table] = [];
      continue;
    }
    const { data: rows, error } = await supabase
      .from(spec.table)
      .select(spec.columns ?? "*")
      .eq(spec.ownerColumn, userId);
    if (error || !rows) {
      // Server log only — the client receives a generic failure (see route).
      console.error(`[export] failed to read table ${spec.table}`, error);
      throw new Error("Failed to build the user data export.");
    }
    data[spec.table] = rows as unknown as Record<string, unknown>[];
  }

  return {
    export_version: EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    data,
  };
}
