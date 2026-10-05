// V4.8 (Data & Account Safety): account deletion regression tests.
//
// Covers deleteUserAccountData + the /api/account/delete route contract:
//   (a) deletion removes the user's app data across all user-owned tables,
//   (b) another user's data is untouched,
//   (c) Google Calendar events are never deleted (no Google API calls),
//   (d) Google connection credentials are removed,
//   (e) wrong confirmation phrase is rejected,
//   (f) unauthenticated requests are rejected,
//   (g) deletion is idempotent.
//
// DB tests run against PGlite (real Postgres engine, in-process) with the
// actual project migration chain 0001 -> 0013 and RLS enforced, so FK
// ordering (notably reading_logs -> books ON DELETE RESTRICT) is exercised
// for real. The route handler itself imports next/headers, which cannot run
// under plain node, so route-level guarantees (401/400/signOut/no-GET) are
// asserted by static source analysis — the same pattern existing
// google route safety tests use — plus unit tests of the pure confirmation
// validator the route delegates to.
//
// Run with:
//   TZ='Asia/Kolkata' node --test --import ./tests/hooks.mjs tests/account_deletion.test.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  deleteUserAccountData,
  USER_TABLES_DELETION_ORDER,
  DELETE_CONFIRMATION_PHRASE,
  isDeleteConfirmationValid,
} from "@/lib/accountDeletion";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const C = "33333333-3333-3333-3333-333333333333"; // never owns any rows

const MIGRATIONS = [
  "0001_v1_schema.sql",
  "0002_v2_training_study.sql",
  "0003_v2_1_integrity.sql",
  "0004_v2_2_deletion_safety.sql",
  "0005_v3_journal_review.sql",
  "0006_v3_2_ownership.sql",
  "0007_v4_2_2_increment_ledger.sql",
  "0008_google_calendar_integration.sql",
  "0009_google_oauth_hardening.sql",
  "0010_google_calendar_sync.sql",
  "0011_google_calendar_roundtrip.sql",
  "0012_google_calendar_local_timezone.sql",
  "0013_calendar_allday_end_date.sql",
];

// Every user-owned table from the architecture audit (31). profiles keys
// the user by `id`, sync_applied_mutations by `owner_id`; the rest by `owner`.
const ALL_TABLES = [
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
  "google_calendar_connections",
  "google_calendar_selections",
  "google_calendar_sync_state",
  "google_event_mappings",
  "google_oauth_transactions",
  "sync_applied_mutations",
];

const OWNER_COL = { profiles: "id", sync_applied_mutations: "owner_id" };
const ownerCol = (t) => OWNER_COL[t] ?? "owner";

let db;
const touchedTables = [];

async function q(sql, params = []) {
  return db.query(sql, params);
}
async function asUser(id) {
  await db.exec(`set app.user_id = '${id}'`);
}
async function countFor(table, user) {
  const r = await q(
    `select count(*)::int as n from "${table}" where "${ownerCol(table)}" = $1`,
    [user]
  );
  return r.rows[0].n;
}
function readSource(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}

/**
 * Minimal stand-in for the Supabase client surface deleteUserAccountData
 * uses: supabase.from(t).delete().eq(col, userId). Backed by real SQL
 * against PGlite with RLS enforced, so the deletion plan is exercised
 * against the real schema, constraints, and policies.
 */
function fakeSupabase() {
  return {
    from(table) {
      return {
        delete() {
          return {
            eq: async (column, value) => {
              touchedTables.push(table);
              try {
                await q(`delete from "${table}" where "${column}" = $1`, [value]);
                return { error: null };
              } catch (e) {
                return { error: e };
              }
            },
          };
        },
      };
    },
  };
}

before(async () => {
  db = new PGlite();
  // --- stub the Supabase auth schema the migrations expect ---
  await db.exec(`
    create schema auth;
    create table auth.users(id uuid primary key);
    create or replace function auth.uid() returns uuid
      language sql stable as $$ select current_setting('app.user_id', true)::uuid $$;
    insert into auth.users(id) values ('${A}'::uuid), ('${B}'::uuid), ('${C}'::uuid);
    create role app_user nosuperuser login;
    create role authenticated nosuperuser;
    grant usage on schema public, auth to app_user;
    grant select on auth.users to app_user;
    grant execute on function auth.uid() to app_user;
  `);
  for (const f of MIGRATIONS) {
    await db.exec(readFileSync(join(ROOT, "supabase", "migrations", f), "utf8"));
  }
  await db.exec(`grant all on all tables in schema public to app_user`);
  await db.exec(`set session authorization app_user`);

  // --- seed user A: broad coverage across the table graph ---
  await asUser(A);
  await q(`insert into profiles(id) values ($1)`, [A]);
  const ch = (await q(`insert into challenges(owner, start_date) values ($1,'2026-10-05') returning id`, [A])).rows[0];
  await q(`insert into challenge_reviews(owner, challenge_id) values ($1,$2)`, [A, ch.id]);
  const hb = (await q(`insert into habits(owner, name) values ($1,'Meditation') returning id`, [A])).rows[0];
  await q(`insert into habit_logs(owner, habit_id, log_date) values ($1,$2,'2026-10-05')`, [A, hb.id]);
  const ar = (await q(`insert into abstinence_rules(owner, name) values ($1,'Porn') returning id`, [A])).rows[0];
  await q(`insert into abstinence_incidents(owner, rule_id) values ($1,$2)`, [A, ar.id]);
  const ul = (await q(`insert into usage_limits(owner, name, daily_limit_min) values ($1,'YouTube',45) returning id`, [A])).rows[0];
  await q(`insert into limit_logs(owner, limit_id, log_date) values ($1,$2,'2026-10-05')`, [A, ul.id]);
  await q(`insert into tasks(owner, title, task_date) values ($1,'Task A','2026-10-05')`, [A]);
  const ev = (await q(`insert into calendar_events(owner, title, event_date, start_time, end_time) values ($1,'Event A','2026-10-05','09:00','10:00') returning id`, [A])).rows[0];
  await q(`insert into daily_records(owner, record_date) values ($1,'2026-10-05')`, [A]);
  await q(`insert into daily_reviews(owner, review_date) values ($1,'2026-10-05')`, [A]);
  await q(`insert into weekly_reviews(owner, week_start, week_end) values ($1,'2026-09-29','2026-10-05')`, [A]);
  await q(`insert into journal_entries(owner, entry_date) values ($1,'2026-10-05')`, [A]);
  const wo = (await q(`insert into workouts(owner, name) values ($1,'HSPU') returning id`, [A])).rows[0];
  const ex = (await q(`insert into workout_exercises(owner, workout_id, name) values ($1,$2,'HSPU') returning id`, [A, wo.id])).rows[0];
  const se = (await q(`insert into workout_sessions(owner, workout_id, session_date) values ($1,$2,'2026-10-05') returning id`, [A, wo.id])).rows[0];
  await q(`insert into workout_sets(owner, session_id, exercise_id, workout_id, set_number, reps) values ($1,$2,$3,$4,1,5)`, [A, se.id, ex.id, wo.id]);
  await q(`insert into training_schedule(owner, weekday) values ($1,1)`, [A]);
  const sj = (await q(`insert into subjects(owner, name) values ($1,'Mathematics') returning id`, [A])).rows[0];
  const tp = (await q(`insert into topics(owner, subject_id, name) values ($1,$2,'Algebra') returning id`, [A, sj.id])).rows[0];
  await q(`insert into study_sessions(owner, subject_id, topic_id, session_date, started_at) values ($1,$2,$3,'2026-10-05', now())`, [A, sj.id, tp.id]);
  const bk = (await q(`insert into books(owner, name) values ($1,'Deep Work') returning id`, [A])).rows[0];
  await q(`insert into reading_logs(owner, book_id, log_date, pages) values ($1,$2,'2026-10-05',20)`, [A, bk.id]);
  const gc = (await q(`insert into google_calendar_connections(owner, google_account_id) values ($1,'google-sub-A') returning id`, [A])).rows[0];
  await q(`insert into google_calendar_selections(owner, connection_id, google_calendar_id) values ($1,$2,'primary')`, [A, gc.id]);
  await q(`insert into google_oauth_transactions(owner, state, verifier_enc, expires_at) values ($1,'st','venc', now() + interval '10 minutes')`, [A]);
  await q(`insert into google_calendar_sync_state(owner, google_account_id, google_calendar_id) values ($1,'google-sub-A','primary')`, [A]);
  await q(`insert into google_event_mappings(owner, google_account_id, google_calendar_id, origin, local_event_id) values ($1,'google-sub-A','primary','synced',$2)`, [A, ev.id]);
  await q(`insert into sync_applied_mutations(mutation_id, owner_id, entity, record_id, field, delta) values (gen_random_uuid(),$1,'workout_sets',gen_random_uuid(),'reps',1)`, [A]);

  // --- seed user B: a smaller set, to prove isolation ---
  await asUser(B);
  await q(`insert into profiles(id) values ($1)`, [B]);
  await q(`insert into challenges(owner, start_date) values ($1,'2026-10-05')`, [B]);
  await q(`insert into habits(owner, name) values ($1,'Reading')`, [B]);
  await q(`insert into tasks(owner, title, task_date) values ($1,'Task B','2026-10-05')`, [B]);
  await q(`insert into calendar_events(owner, title, event_date, start_time, end_time) values ($1,'Event B','2026-10-05','11:00','12:00')`, [B]);
  await q(`insert into books(owner, name) values ($1,'Atomic Habits')`, [B]);
  await q(`insert into weekly_reviews(owner, week_start, week_end) values ($1,'2026-09-29','2026-10-05')`, [B]);
  await q(`insert into google_calendar_connections(owner, google_account_id) values ($1,'google-sub-B')`, [B]);
});

// ---------------------------------------------------------------------------
// Deletion order constant
// ---------------------------------------------------------------------------

test("deletion order covers every user-owned table exactly once", () => {
  assert.deepEqual(
    [...USER_TABLES_DELETION_ORDER].sort(),
    [...ALL_TABLES].sort(),
    "USER_TABLES_DELETION_ORDER must list every user-owned table exactly once"
  );
});

test("deletion order respects FK dependencies", () => {
  const idx = (t) => USER_TABLES_DELETION_ORDER.indexOf(t);
  // ON DELETE RESTRICT: reading_logs.book_id -> books(id). Deleting a book
  // with logged pages would fail, so logs must go first.
  assert.ok(idx("reading_logs") < idx("books"), "reading_logs before books (RESTRICT)");
  // Children before parents everywhere else (cascade would also handle it,
  // but the plan must not depend on FK behavior).
  assert.ok(idx("workout_sets") < idx("workout_sessions"), "sets before sessions");
  assert.ok(idx("workout_sets") < idx("workout_exercises"), "sets before exercises");
  assert.ok(idx("workout_sessions") < idx("workouts"), "sessions before workouts");
  assert.ok(idx("workout_exercises") < idx("workouts"), "exercises before workouts");
  assert.ok(idx("habit_logs") < idx("habits"), "habit_logs before habits");
  assert.ok(idx("abstinence_incidents") < idx("abstinence_rules"));
  assert.ok(idx("limit_logs") < idx("usage_limits"));
  assert.ok(idx("study_sessions") < idx("subjects"));
  assert.ok(idx("topics") < idx("subjects"));
  assert.ok(idx("challenge_reviews") < idx("challenges"));
  // Disconnect-route order: selections (FK child) before connections.
  assert.ok(
    idx("google_calendar_selections") < idx("google_calendar_connections"),
    "selections before connections (mirrors disconnect route)"
  );
});

// ---------------------------------------------------------------------------
// Confirmation phrase
// ---------------------------------------------------------------------------

test("confirmation phrase is the exact required string", () => {
  assert.equal(DELETE_CONFIRMATION_PHRASE, "DELETE MY ACCOUNT");
});

test("validator accepts only the exact phrase", () => {
  assert.ok(isDeleteConfirmationValid({ confirm: "DELETE MY ACCOUNT" }));
  for (const bad of [
    { confirm: "delete my account" },
    { confirm: "DELETE MY ACCOUNT " },
    { confirm: " DELETE MY ACCOUNT" },
    { confirm: "" },
    { confirm: 123 },
    {},
    null,
    undefined,
    "DELETE MY ACCOUNT",
  ]) {
    assert.equal(isDeleteConfirmationValid(bad), false, `must reject ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// (a) deletion removes the user's app data
// ---------------------------------------------------------------------------

test("deletion removes all of user A's app data", async () => {
  await asUser(A);
  await deleteUserAccountData(fakeSupabase(), A);
  for (const t of ALL_TABLES) {
    if (t === "profiles") continue; // no DELETE policy under RLS; see below
    assert.equal(await countFor(t, A), 0, `expected no rows for A in ${t}`);
  }
});

test("profiles row survives under RLS (no delete policy) and auth.users is untouched", async () => {
  await asUser(A);
  // profiles has select/insert/update policies only: the RLS-enforced
  // delete is a silent no-op. The row cascades away when the operator
  // later deletes the auth.users record via the dashboard.
  assert.equal(await countFor("profiles", A), 1, "profile row remains (RLS has no delete policy)");
  const r = await q(`select count(*)::int as n from auth.users where id = $1`, [A]);
  assert.equal(r.rows[0].n, 1, "auth.users record is never deleted by app code");
});

test("deletion touches tables in the documented order", () => {
  assert.deepEqual(touchedTables, USER_TABLES_DELETION_ORDER);
});

// ---------------------------------------------------------------------------
// (b) another user's data is untouched
// ---------------------------------------------------------------------------

test("deletion does not touch user B's data", async () => {
  await asUser(B);
  assert.equal(await countFor("profiles", B), 1);
  assert.equal(await countFor("challenges", B), 1);
  assert.equal(await countFor("habits", B), 1);
  assert.equal(await countFor("tasks", B), 1);
  assert.equal(await countFor("calendar_events", B), 1);
  assert.equal(await countFor("books", B), 1);
  assert.equal(await countFor("weekly_reviews", B), 1);
  assert.equal(await countFor("google_calendar_connections", B), 1);
});

// ---------------------------------------------------------------------------
// (c) Google Calendar events are never deleted; (d) credentials removed
// ---------------------------------------------------------------------------

test("deletion makes no Google API calls and ships no Google-side deletion logic", async () => {
  const src = readSource("lib/accountDeletion.ts");
  for (const forbidden of ["googleapis", "oauth2.googleapis", "calendar.events", "fetch("]) {
    assert.ok(!src.includes(forbidden), `lib must not contain ${forbidden}`);
  }
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    calls.push(args);
    throw new Error("network disabled in tests");
  };
  try {
    // User C owns nothing: the full deletion plan still runs, so any
    // network call it attempted would be caught here.
    await asUser(C);
    await deleteUserAccountData(fakeSupabase(), C);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls.length, 0, "no network calls during deletion");
});

test("google connection credentials are removed (connection row gone)", async () => {
  await asUser(A);
  // Seeded in before(); all Google rows for A were deleted by the (a) test.
  assert.equal(await countFor("google_calendar_connections", A), 0, "connection row gone (encrypted tokens dropped with it)");
  assert.equal(await countFor("google_calendar_selections", A), 0);
  assert.equal(await countFor("google_oauth_transactions", A), 0);
  // Account deletion drops these too, unlike disconnect which retains them
  // for same-account reconnect (documented choice: no reconnect is possible).
  assert.equal(await countFor("google_event_mappings", A), 0);
  assert.equal(await countFor("google_calendar_sync_state", A), 0);
});

test("app calendar events are deleted but Google-side events are out of scope", async () => {
  await asUser(A);
  // App calendar_events are user data and are deleted; events living on
  // Google's servers are never reachable from this module (see fetch test).
  assert.equal(await countFor("calendar_events", A), 0);
  const src = readSource("lib/accountDeletion.ts");
  assert.ok(
    src.includes("NEVER touched") || src.includes("never touched"),
    "lib documents that Google Calendar events are never touched"
  );
});

// ---------------------------------------------------------------------------
// (e)/(f) route contract — static analysis (route imports next/headers,
// which cannot execute under plain node)
// ---------------------------------------------------------------------------

test("route: unauthenticated requests are rejected with 401", () => {
  const src = readSource("app/api/account/delete/route.ts");
  assert.ok(src.includes("supabase.auth.getUser()"), "route authenticates via getUser");
  assert.ok(src.includes("status: 401"), "route returns 401 when no user");
});

test("route: wrong confirmation phrase is rejected with 400", () => {
  const src = readSource("app/api/account/delete/route.ts");
  assert.ok(src.includes("isDeleteConfirmationValid"), "route uses the exact-phrase validator");
  assert.ok(src.includes("DELETE_CONFIRMATION_PHRASE"), "route references the phrase constant");
  assert.ok(src.includes("status: 400"), "route returns 400 on bad confirmation");
  assert.ok(!src.includes("body.userId") && !src.includes("body.user_id"), "route never reads a client-provided user id");
  assert.ok(src.includes("deleteUserAccountData(supabase, user.id)"), "route deletes by SESSION user id only");
});

test("route: POST only, signs out, safe generic 500, documents auth.users", () => {
  const src = readSource("app/api/account/delete/route.ts");
  assert.ok(src.includes("export async function POST"), "POST handler exists");
  assert.ok(!src.match(/export async function GET/), "no GET handler (Next.js rejects with 405)");
  assert.ok(src.includes("supabase.auth.signOut()"), "route signs the user out after deletion");
  assert.ok(src.includes("Account deletion failed"), "generic 500 message present");
  assert.ok(!src.includes("NextResponse.json({ error: err"), "raw errors never sent to client");
  assert.ok(!src.includes("error.message }"), "raw DB error text never sent to client");
  assert.ok(src.includes("auth.users"), "route documents that auth.users is NOT deleted here");
  assert.ok(src.includes("service_role"), "route documents the no-service-role design");
});

// ---------------------------------------------------------------------------
// (g) idempotency
// ---------------------------------------------------------------------------

test("deletion is idempotent: running twice does not error", async () => {
  await asUser(A);
  await deleteUserAccountData(fakeSupabase(), A); // second run for A
  for (const t of ALL_TABLES) {
    if (t === "profiles") continue;
    assert.equal(await countFor(t, A), 0, `still no rows for A in ${t}`);
  }
});

test("deletion of an account with no data does not error", async () => {
  await asUser(C);
  await deleteUserAccountData(fakeSupabase(), C);
  assert.equal(await countFor("profiles", C), 0);
});
