// V4.3.2.2: migration integrity for 0012_google_calendar_local_timezone.sql.
//
// This test proves that a FRESH database applying the actual project
// migrations 0001 -> 0012 ends up with:
//   * public.google_event_mappings.local_timezone (text, nullable, no
//     default),
//   * RLS still enabled and owner-scoped on google_event_mappings,
//   * pre-existing mapping rows remain valid (local_timezone NULL),
//   * no destructive operations in the migration.
// It does NOT create any 0012 object manually: if migration 0012 forgets
// the column, this test fails.
//
// Run with:
//   TZ='Asia/Kolkata' node --test --import ./tests/hooks.mjs tests/google_migration_0012.test.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

const MIGRATIONS_PRE = [
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
const MIGRATION_0012 = "0012_google_calendar_local_timezone.sql";

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
  // Prerequisite of the environment, NOT a substitute for 0012: the new
  // column must come from the migration file. Queries run as the
  // non-superuser app_user so RLS enforces.
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
  // Apply 0001 -> 0011 first (as the superuser, like production).
  for (const f of MIGRATIONS_PRE) {
    const sql = readFileSync(join(ROOT, "supabase/migrations", f), "utf8");
    await db.exec(sql);
  }
  // A legacy mapping row written before V4.3.2.2 (no local_timezone).
  // Inserted as superuser (RLS bypassed) purely as fixture setup.
  const ev = await q(
    `insert into public.calendar_events
       (owner, title, event_date, start_time, end_time)
     values ('${A}'::uuid, 'legacy', '2026-10-05', '18:30', '19:30')
     returning id`
  );
  await q(
    `insert into public.google_event_mappings
       (owner, local_event_id, google_account_id, google_calendar_id,
        google_event_id, google_etag, origin, google_timezone)
     values ('${A}'::uuid, '${ev.rows[0].id}'::uuid, 'gacct', 'cal',
        'gev', 'e1', 'google', 'America/New_York')`
  );
  // Now apply 0012 — still as superuser, exactly like production.
  const sql12 = readFileSync(join(ROOT, "supabase/migrations", MIGRATION_0012), "utf8");
  await db.exec(sql12);
  await db.exec(`grant all on all tables in schema public to app_user`);
  await db.exec(`grant all on all tables in schema auth to app_user`);
  await db.exec(`set session authorization app_user`);
});

test("migration: 0001->0012 applies cleanly on a fresh database", async () => {
  const tables = await q(
    `select tablename from pg_tables where schemaname = 'public'`
  );
  const names = tables.rows.map((r) => r.tablename);
  assert.ok(names.includes("google_event_mappings"), "google_event_mappings exists");
});

test("migration: pre-existing rows survive 0012 with NULL local_timezone", async () => {
  await asUser(A);
  const rows = await q(
    `select google_timezone, local_timezone from public.google_event_mappings
     where google_event_id = 'gev'`
  );
  assert.equal(rows.rows.length, 1, "legacy row intact");
  assert.equal(rows.rows[0].google_timezone, "America/New_York");
  assert.equal(
    rows.rows[0].local_timezone,
    null,
    "legacy rows get NULL local_timezone (documented fallback)"
  );
});

test("migration: local_timezone is a nullable text column with no default", async () => {
  const info = await q(
    `select data_type, is_nullable, column_default
     from information_schema.columns
     where table_schema = 'public' and table_name = 'google_event_mappings'
       and column_name = 'local_timezone'`
  );
  assert.equal(info.rows.length, 1, "local_timezone column exists");
  assert.equal(info.rows[0].data_type, "text");
  assert.equal(info.rows[0].is_nullable, "YES");
  assert.equal(info.rows[0].column_default, null);
});

test("migration: RLS remains enabled and owner-scoped on google_event_mappings", async () => {
  const rls = await q(
    `select relrowsecurity from pg_class
     where relnamespace = 'public'::regnamespace and relname = 'google_event_mappings'`
  );
  assert.equal(rls.rows[0].relrowsecurity, true, "RLS enabled");
  const pol = await q(
    `select qual, with_check from pg_policies
     where schemaname = 'public' and tablename = 'google_event_mappings'`
  );
  assert.ok(pol.rows.length >= 1, "owner policy present");
  assert.ok(
    pol.rows.every(
      (r) =>
        String(r.qual).includes("auth.uid()") &&
        String(r.with_check).includes("auth.uid()")
    ),
    "policy is owner-scoped"
  );
  // Cross-user isolation still holds with the new column present.
  await asUser(B);
  const rows = await q(`select id from public.google_event_mappings`);
  assert.equal(rows.rows.length, 0, "user B cannot see user A's mapping");
  await asUser(A);
});

test("migration: new rows can store and read local_timezone", async () => {
  await asUser(A);
  const ev = await q(
    `insert into public.calendar_events
       (owner, title, event_date, start_time, end_time)
     values ('${A}'::uuid, 'new', '2026-10-06', '09:00', '10:00')
     returning id`
  );
  await q(
    `insert into public.google_event_mappings
       (owner, local_event_id, google_account_id, google_calendar_id,
        google_event_id, origin, google_timezone, local_timezone)
     values ('${A}'::uuid, '${ev.rows[0].id}'::uuid, 'gacct', 'cal',
        'gev2', 'synced', 'America/New_York', 'Asia/Kolkata')`
  );
  const rows = await q(
    `select local_timezone from public.google_event_mappings
     where google_event_id = 'gev2'`
  );
  assert.equal(rows.rows[0].local_timezone, "Asia/Kolkata");
});

test("migration: 0012 performs no destructive operations", async () => {
  const sql = readFileSync(
    join(ROOT, "supabase/migrations", MIGRATION_0012),
    "utf8"
  ).toLowerCase();
  for (const forbidden of ["drop table", "delete from", "truncate"]) {
    assert.ok(
      !sql.includes(forbidden),
      `0012 must not contain "${forbidden}"`
    );
  }
  assert.ok(
    sql.includes("add column if not exists local_timezone"),
    "0012 adds the column idempotently"
  );
});
