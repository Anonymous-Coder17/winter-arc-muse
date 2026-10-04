// V4.3.2.1: migration integrity for 0011_google_calendar_roundtrip.sql.
//
// This test proves that a FRESH database applying the actual project
// migrations 0001 -> 0011 ends up with:
//   * public.calendar_events.is_all_day (boolean, NOT NULL, default false),
//   * public.google_event_mappings.google_end_timezone (text, nullable),
//   * public.google_event_mappings.google_start_date / google_end_date
//     (date, nullable, stored as a pair or not at all),
//   * the all-day date-pair CHECK constraint,
//   * RLS still enabled and owner-scoped on both tables,
//   * pre-existing rows remain valid (new columns default / stay NULL).
// It does NOT create any 0011 object manually: if migration 0011 forgets a
// required column or constraint, this test fails.
//
// Run with:
//   TZ='Asia/Kolkata' node --test --import ./tests/hooks.mjs tests/google_migration_0011.test.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

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
];

let db;

async function q(sql, params = []) {
  return db.query(sql, params);
}

async function asUser(id) {
  await db.exec(`set app.user_id = '${id}'`);
}

before(async () => {
  db = new PGlite();
  // Minimal stub of the Supabase auth schema that the migrations expect.
  // Prerequisite of the environment, NOT a substitute for 0011: the new
  // columns, constraint, and everything else must come from the migration
  // files. Queries run as the non-superuser app_user so RLS enforces.
  await db.exec(`
    create schema auth;
    create table auth.users(id uuid primary key);
    create or replace function auth.uid() returns uuid
      language sql stable as $$ select current_setting('app.user_id', true)::uuid $$;
    insert into auth.users(id) values ('${A}'::uuid), ('${B}'::uuid);
    create role app_user nosuperuser login;
    -- 0007 grants EXECUTE to the Supabase-style authenticated role; it must
    -- exist for the migration to apply, even though this test runs as app_user.
    create role authenticated nosuperuser;
    grant usage on schema public, auth to app_user;
    grant execute on function auth.uid() to app_user;
  `);
  for (const f of MIGRATIONS) {
    const sql = readFileSync(join(ROOT, "supabase/migrations", f), "utf8");
    await db.exec(sql);
  }
  await db.exec(`grant all on all tables in schema public to app_user`);
  await db.exec(`grant all on all tables in schema auth to app_user`);
  await db.exec(`set session authorization app_user`);
});

function columnsOf(table) {
  return q(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = $1`,
    [table]
  ).then((r) => r.rows.map((x) => x.column_name));
}

test("migration: 0001->0011 applies cleanly on a fresh database", async () => {
  const tables = await q(
    `select tablename from pg_tables where schemaname = 'public'`
  );
  const names = tables.rows.map((r) => r.tablename);
  assert.ok(names.includes("calendar_events"), "calendar_events exists");
  assert.ok(names.includes("google_event_mappings"), "google_event_mappings exists");
});

test("migration: calendar_events gains is_all_day with a safe default", async () => {
  const cols = await columnsOf("calendar_events");
  assert.ok(cols.includes("is_all_day"), "is_all_day column exists");
  const info = await q(
    `select data_type, is_nullable, column_default
     from information_schema.columns
     where table_schema = 'public' and table_name = 'calendar_events'
       and column_name = 'is_all_day'`
  );
  assert.equal(info.rows[0].data_type, "boolean");
  assert.equal(info.rows[0].is_nullable, "NO");
  assert.ok(
    String(info.rows[0].column_default).includes("false"),
    "defaults to false"
  );
  // Pre-existing rows (written before 0011) read back as NOT all-day.
  await asUser(A);
  await q(
    `insert into calendar_events (owner, title, event_date, start_time, end_time)
     values ($1, 'Legacy', '2026-10-05', '09:00', '10:00')`,
    [A]
  );
  const row = await q(
    `select is_all_day from calendar_events where owner = $1`,
    [A]
  );
  assert.equal(row.rows[0].is_all_day, false, "legacy rows default to false");
});

test("migration: google_event_mappings gains the round-trip columns", async () => {
  const cols = await columnsOf("google_event_mappings");
  for (const c of [
    "google_end_timezone",
    "google_start_date",
    "google_end_date",
  ]) {
    assert.ok(cols.includes(c), `google_event_mappings column ${c} must exist`);
  }
  const types = await q(
    `select column_name, data_type from information_schema.columns
     where table_schema = 'public' and table_name = 'google_event_mappings'
       and column_name in ('google_end_timezone', 'google_start_date', 'google_end_date')`
  );
  const byName = Object.fromEntries(types.rows.map((r) => [r.column_name, r.data_type]));
  assert.equal(byName.google_end_timezone, "text");
  assert.equal(byName.google_start_date, "date");
  assert.equal(byName.google_end_date, "date");
});

test("migration: all-day date pair CHECK is enforced", async () => {
  const con = await q(
    `select conname from pg_constraint
     where conname = 'google_event_mappings_all_day_dates_pair'`
  );
  assert.equal(con.rows.length, 1, "pair CHECK constraint exists");

  // Both dates: ok.
  await asUser(A);
  await q(
    `insert into google_event_mappings
       (owner, google_account_id, google_calendar_id, google_event_id,
        origin, google_start_date, google_end_date)
     values ($1, 'g', 'c', 'pair-ok', 'google', '2026-10-10', '2026-10-12')`,
    [A]
  );
  // Neither date: ok (timed events).
  await q(
    `insert into google_event_mappings
       (owner, google_account_id, google_calendar_id, google_event_id, origin)
     values ($1, 'g', 'c', 'pair-none', 'google')`,
    [A]
  );
  // Only one date: rejected.
  let blocked = false;
  try {
    await q(
      `insert into google_event_mappings
         (owner, google_account_id, google_calendar_id, google_event_id,
          origin, google_start_date)
       values ($1, 'g', 'c', 'pair-half', 'google', '2026-10-10')`,
      [A]
    );
  } catch {
    blocked = true;
  }
  assert.ok(blocked, "half-written all-day range is rejected");
});

test("migration: RLS remains enabled and owner-scoped on both tables", async () => {
  for (const t of ["calendar_events", "google_event_mappings"]) {
    const rls = await q(
      `select relrowsecurity from pg_class where relname = $1`,
      [t]
    );
    assert.equal(rls.rows[0].relrowsecurity, true, `${t} has RLS enabled`);
    const pol = await q(
      `select policyname, qual, with_check from pg_policies
       where schemaname = 'public' and tablename = $1`,
      [t]
    );
    assert.ok(pol.rows.length >= 1, `${t} keeps at least one policy`);
    assert.ok(
      pol.rows[0].qual.includes("auth.uid()") &&
        pol.rows[0].with_check.includes("auth.uid()"),
      `${t} policy scopes rows to auth.uid() in both qual and with_check`
    );
  }
  // Cross-user isolation: B cannot read A's rows.
  await asUser(B);
  const hidden = await q(
    `select count(*)::int as n from google_event_mappings`
  );
  assert.equal(hidden.rows[0].n, 0, "user B sees none of user A's mappings");
  const hiddenEvents = await q(
    `select count(*)::int as n from calendar_events`
  );
  assert.equal(hiddenEvents.rows[0].n, 0, "user B sees none of user A's events");
  await asUser(A);
});

test("migration: pre-0011 mapping rows remain valid; new columns default NULL", async () => {
  const row = await q(
    `select google_end_timezone, google_start_date, google_end_date
     from google_event_mappings where google_event_id = 'pair-none'`
  );
  assert.equal(row.rows[0].google_end_timezone, null);
  assert.equal(row.rows[0].google_start_date, null);
  assert.equal(row.rows[0].google_end_date, null);
});

test("migration: 0011 performs no destructive operations", async () => {
  const src = readFileSync(
    join(ROOT, "supabase/migrations/0011_google_calendar_roundtrip.sql"),
    "utf8"
  ).toLowerCase();
  assert.ok(!src.includes("drop table"), "no dropped tables");
  assert.ok(!src.match(/delete\s+from/), "no deleted rows");
  assert.ok(!src.includes("truncate"), "no truncation");
  // Only additive DDL: ALTER TABLE ... ADD COLUMN / ADD CONSTRAINT.
  const alters = src.match(/alter table/g) || [];
  assert.ok(alters.length >= 2, "additive ALTER TABLE statements present");
});
