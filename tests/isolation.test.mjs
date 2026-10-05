// V4.8 — cross-user isolation regression tests.
// Verifies RLS owner isolation: User B cannot read, modify, or delete
// User A's data across all major table categories, including Google
// integration tables. Runs against PGlite with the full migration chain
// (0001 → 0013) and the same auth.uid() stub pattern as tests/db.test.mjs.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

let db;
async function q(sql) {
  return db.query(sql);
}
async function asUser(id) {
  await db.exec(`set app.user_id = '${id}'`);
}

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

before(async () => {
  db = new PGlite();
  await db.exec(`
    create schema auth;
    create table auth.users(id uuid primary key);
    create or replace function auth.uid() returns uuid
      language sql stable as $$ select current_setting('app.user_id', true)::uuid $$;
    insert into auth.users(id) values ('${A}'::uuid), ('${B}'::uuid);
    create role app_user nosuperuser login;
    create role authenticated nosuperuser;
    grant usage on schema public, auth to app_user;
    grant execute on function auth.uid() to app_user;
  `);
  for (const f of MIGRATIONS) {
    await db.exec(readFileSync(join(ROOT, "supabase", "migrations", f), "utf8"));
  }
  await db.exec(`grant all on all tables in schema public to app_user`);
  await db.exec(`grant usage, select on all sequences in schema public to app_user`);
  await db.exec(`set session authorization app_user`);
});

// Seed one row per table as user A. Returns the seeded ids.
// Idempotent: wipes A's rows first so each test starts clean.
async function seedAsA() {
  await asUser(A);
  for (const t of [
    "workout_sets", "workout_sessions", "workout_exercises", "workouts",
    "habit_logs", "habits", "reading_logs", "books",
    "study_sessions", "subjects", "journal_entries", "calendar_events",
    "challenges", "abstinence_rules", "usage_limits",
    "google_event_mappings", "google_calendar_sync_state",
    "google_calendar_selections", "google_calendar_connections",
  ]) {
    await q(`delete from ${t} where owner = '${A}'`);
  }
  const ids = {};
  ids.challenge = (await q(`insert into challenges(owner,title,start_date,duration_days) values ('${A}','Arc','2026-10-05',30) returning id`)).rows[0].id;
  ids.event = (await q(`insert into calendar_events(owner,title,event_date,start_time,end_time) values ('${A}','Deep work','2026-10-05','09:00','10:00') returning id`)).rows[0].id;
  ids.habit = (await q(`insert into habits(owner,name) values ('${A}','Meditation') returning id`)).rows[0].id;
  ids.habitLog = (await q(`insert into habit_logs(owner,habit_id,log_date,status) values ('${A}','${ids.habit}','2026-10-05','done') returning id`)).rows[0].id;
  ids.book = (await q(`insert into books(owner,name,total_pages) values ('${A}','Deep Work',320) returning id`)).rows[0].id;
  ids.readingLog = (await q(`insert into reading_logs(owner,book_id,log_date,pages) values ('${A}','${ids.book}','2026-10-05',20) returning id`)).rows[0].id;
  ids.workout = (await q(`insert into workouts(owner,name) values ('${A}','Push') returning id`)).rows[0].id;
  ids.exercise = (await q(`insert into workout_exercises(owner,workout_id,name) values ('${A}','${ids.workout}','HSPU') returning id`)).rows[0].id;
  ids.session = (await q(`insert into workout_sessions(owner,workout_id,session_date) values ('${A}','${ids.workout}','2026-10-05') returning id`)).rows[0].id;
  ids.set = (await q(`insert into workout_sets(owner,session_id,exercise_id,workout_id,set_number,reps) values ('${A}','${ids.session}','${ids.exercise}','${ids.workout}',1,5) returning id`)).rows[0].id;
  ids.subject = (await q(`insert into subjects(owner,name) values ('${A}','Math') returning id`)).rows[0].id;
  ids.studySession = (await q(`insert into study_sessions(owner,subject_id,session_date,started_at,duration_seconds) values ('${A}','${ids.subject}','2026-10-05','2026-10-05T10:00:00Z',1800) returning id`)).rows[0].id;
  ids.journal = (await q(`insert into journal_entries(owner,entry_date,content) values ('${A}','2026-10-05','Day 1') returning id`)).rows[0].id;
  ids.abstinence = (await q(`insert into abstinence_rules(owner,name) values ('${A}','Instagram') returning id`)).rows[0].id;
  ids.limit = (await q(`insert into usage_limits(owner,name,daily_limit_min) values ('${A}','YouTube',45) returning id`)).rows[0].id;
  return ids;
}

// ---------------------------------------------------------------------------
// §1 — User B cannot read User A's data
// ---------------------------------------------------------------------------

test("ISOLATION: user B sees zero rows of user A's data (SELECT)", async () => {
  const ids = await seedAsA();
  await asUser(B);
  const checks = [
    ["challenges", ids.challenge],
    ["calendar_events", ids.event],
    ["habits", ids.habit],
    ["habit_logs", ids.habitLog],
    ["books", ids.book],
    ["reading_logs", ids.readingLog],
    ["workouts", ids.workout],
    ["workout_sessions", ids.session],
    ["workout_sets", ids.set],
    ["subjects", ids.subject],
    ["study_sessions", ids.studySession],
    ["journal_entries", ids.journal],
    ["abstinence_rules", ids.abstinence],
    ["usage_limits", ids.limit],
  ];
  for (const [table, id] of checks) {
    const r = await q(`select id from ${table} where id = '${id}'`);
    assert.equal(r.rows.length, 0, `${table}: user B must not see user A's row`);
  }
  // Google tables: B sees no connections, mappings, or sync state of A.
  await asUser(A);
  await q(`insert into google_calendar_connections(owner,google_account_id,refresh_token_enc) values ('${A}','g-acct','enc')`);
  await asUser(B);
  const conns = await q(`select id from google_calendar_connections`);
  assert.equal(conns.rows.length, 0, "user B must not see user A's Google connection");
  const maps = await q(`select id from google_event_mappings`);
  assert.equal(maps.rows.length, 0, "user B must not see user A's event mappings");
  const sync = await q(`select id from google_calendar_sync_state`);
  assert.equal(sync.rows.length, 0, "user B must not see user A's sync state");
});

// ---------------------------------------------------------------------------
// §2 — User B cannot modify User A's data
// ---------------------------------------------------------------------------

test("ISOLATION: user B cannot update user A's rows", async () => {
  const ids = await seedAsA();
  await asUser(B);
  const r1 = await q(`update calendar_events set title='Hacked' where id='${ids.event}'`);
  assert.equal(r1.rows.length, 0, "update must affect 0 rows");
  const r2 = await q(`update habits set name='Hacked' where id='${ids.habit}'`);
  assert.equal(r2.rows.length, 0, "update must affect 0 rows");
  // Verify A's data is unchanged.
  await asUser(A);
  const ev = await q(`select title from calendar_events where id='${ids.event}'`);
  assert.equal(ev.rows[0].title, "Deep work");
});

test("ISOLATION: user B cannot delete user A's rows", async () => {
  const ids = await seedAsA();
  await asUser(B);
  await q(`delete from calendar_events where id='${ids.event}'`);
  await q(`delete from journal_entries where id='${ids.journal}'`);
  await asUser(A);
  const ev = await q(`select id from calendar_events where id='${ids.event}'`);
  assert.equal(ev.rows.length, 1, "user A's event must survive user B's delete");
  const j = await q(`select id from journal_entries where id='${ids.journal}'`);
  assert.equal(j.rows.length, 1, "user A's journal must survive user B's delete");
});

test("ISOLATION: user B cannot insert rows owned by user A", async () => {
  await seedAsA();
  await asUser(B);
  await assert.rejects(
    q(`insert into calendar_events(owner,title,event_date,start_time,end_time) values ('${A}','Sneaky','2026-10-05','09:00','10:00')`),
    "insert with another user's owner must violate RLS WITH CHECK"
  );
});

// ---------------------------------------------------------------------------
// §3 — User B cannot touch User A's Google integration
// ---------------------------------------------------------------------------

test("ISOLATION: user B cannot delete user A's Google connection", async () => {
  await asUser(A);
  await q(`insert into google_calendar_connections(owner,google_account_id,refresh_token_enc) values ('${A}','g-acct','enc')`);
  await asUser(B);
  await q(`delete from google_calendar_connections where owner='${A}'`);
  await asUser(A);
  const r = await q(`select id from google_calendar_connections where owner='${A}'`);
  assert.equal(r.rows.length, 1, "user A's Google connection must survive");
});
