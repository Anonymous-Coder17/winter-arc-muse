/**
 * V4.2 offline-first sync — shared types and constants.
 *
 * Architecture: Supabase/Postgres is the single authoritative cloud source of
 * truth. The browser holds a per-user IndexedDB cache plus a durable mutation
 * queue. All reads/writes go through the local DB first; a sync engine pushes
 * queued mutations and pulls remote changes when connectivity and a valid
 * session exist. RLS stays authoritative on every remote operation.
 */

/** Every user-owned table mirrored locally (all 25 app tables). */
export const TABLES = [
  "profiles",
  "challenges",
  "habits",
  "habit_logs",
  "abstinence_rules",
  "abstinence_incidents",
  "usage_limits",
  "limit_logs",
  "tasks",
  "calendar_events",
  "daily_records",
  "workouts",
  "workout_exercises",
  "workout_sessions",
  "workout_sets",
  "training_schedule",
  "subjects",
  "topics",
  "study_sessions",
  "journal_entries",
  "daily_reviews",
  "weekly_reviews",
  "challenge_reviews",
  "books",
  "reading_logs",
] as const;

export type TableName = (typeof TABLES)[number];

/** Internal per-user stores live in the same IndexedDB database. */
export type StoreName = TableName | "_mutations" | "_meta" | "_conflicts";

/**
 * Local sync metadata attached to every cached entity row.
 * `updated_at` / `created_at` (no underscore) are the last-known server values
 * and are the basis for last-write-wins conflict detection.
 */
export interface LocalMeta {
  _dirty: 0 | 1;
  /** Tombstone: deleted locally, retained until the delete syncs. */
  _deleted: 0 | 1;
  _local_created_at: string;
  _local_updated_at: string;
  _sync_error?: string | null;
}

export type LocalRow<T = Record<string, any>> = T & LocalMeta;

export type MutationOp = "insert" | "update" | "upsert" | "increment" | "delete";
export type MutationStatus = "pending" | "inflight" | "failed" | "superseded";

export interface Mutation {
  mutation_id: string;
  owner_id: string;
  entity: TableName;
  op: MutationOp;
  record_id: string;
  /** Full row (insert/upsert/increment) or patch (update). Never has _-keys. */
  payload: Record<string, any>;
  /** Plain-column natural-key constraint for upsert/increment, e.g. ["habit_id","log_date"]. */
  natural_key_cols?: string[] | null;
  /** increment op only */
  field?: string | null;
  /** increment op only: the delta to apply */
  delta?: number | null;
  /** increment op only: local value before the delta */
  base?: number | null;
  created_at: string;
  retry_count: number;
  last_error: string | null;
  status: MutationStatus;
  next_retry_at: string | null;
  /** Seeds tolerate unique-violation as "already exists" instead of failing. */
  tolerance?: "drop-on-conflict" | null;
}

export interface ConflictRecord {
  id: string;
  owner_id: string;
  created_at: string;
  entity: TableName;
  record_id: string;
  kind:
    | "update-lost"
    | "upsert-lost"
    | "delete-lost"
    | "natural-key-adopted"
    | "seed-dropped";
  detail: string;
}

/**
 * Push order: parents before children so FK/RLS parent-ownership guards pass.
 * Level 0 = independent, 1 = references level 0, 2 = references level 1.
 */
export const PUSH_LEVEL: Record<TableName, number> = {
  profiles: 0,
  challenges: 0,
  habits: 0,
  abstinence_rules: 0,
  usage_limits: 0,
  workouts: 0,
  subjects: 0,
  books: 0,
  tasks: 0,
  calendar_events: 0,
  daily_records: 0,
  journal_entries: 0,
  daily_reviews: 0,
  weekly_reviews: 0,
  training_schedule: 0,
  habit_logs: 1,
  abstinence_incidents: 1,
  limit_logs: 1,
  workout_exercises: 1,
  workout_sessions: 1,
  topics: 1,
  study_sessions: 1,
  reading_logs: 1,
  challenge_reviews: 1,
  workout_sets: 2,
};

/**
 * Mirrors the V2.2 `prevent_historical_data_loss` trigger: these parents may
 * not be deleted (locally or remotely) while historical children exist.
 * Maps parent table -> list of [child table, child FK column].
 */
export const DELETE_GUARD: Partial<
  Record<TableName, Array<[TableName, string]>>
> = {
  workouts: [
    ["workout_exercises", "workout_id"],
    ["workout_sessions", "workout_id"],
  ],
  workout_exercises: [["workout_sets", "exercise_id"]],
  subjects: [
    ["topics", "subject_id"],
    ["study_sessions", "subject_id"],
  ],
  topics: [["study_sessions", "topic_id"]],
};

export const SHELL_CACHE = "winter-arc-shell-v1";
export const DB_NAME_PREFIX = "winter-arc-v1-";
export const DB_VERSION = 1;
export const MAX_RETRIES = 8;

export function backoffDelayMs(retryCount: number): number {
  return Math.min(Math.pow(2, retryCount) * 5000, 5 * 60 * 1000);
}

export const nowIso = (): string => new Date().toISOString();

export function newUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Remove local-only `_`-prefixed keys before sending a row to Supabase. */
export function stripLocalMeta<T extends Record<string, any>>(row: T): T {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!k.startsWith("_")) out[k] = v;
  }
  return out as T;
}
