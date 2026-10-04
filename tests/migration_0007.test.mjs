// V4.2.3: migration integrity for 0007_v4_2_2_increment_ledger.sql.
//
// This test proves that a FRESH database applying the actual project
// migrations 0001 -> 0007 ends up with a working ledger and RPC. It does NOT
// create sync_applied_mutations (or any 0007 object) manually: if migration
// 0007 forgets a required table, constraint, policy, or function, this test
// fails.
//
// Run with:
//   TZ='Asia/Kolkata' node --test --import ./tests/hooks.mjs tests/migration_0007.test.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const A = "11111111-1111-1111-1111-111111111111";

const MIGRATIONS = [
  "0001_v1_schema.sql",
  "0002_v2_training_study.sql",
  "0003_v2_1_integrity.sql",
  "0004_v2_2_deletion_safety.sql",
  "0005_v3_journal_review.sql",
  "0006_v3_2_ownership.sql",
  "0007_v4_2_2_increment_ledger.sql",
];

let db;

async function q(sql, params = []) {
  return db.query(sql, params);
}

before(async () => {
  db = new PGlite();
  // Minimal stub of the Supabase auth schema that the migrations expect.
  // This is a prerequisite of the environment, NOT a substitute for 0007:
  // sync_applied_mutations itself must come from the migration files.
  await db.exec(`
    create schema auth;
    create table auth.users(id uuid primary key);
    create or replace function auth.uid() returns uuid
      language sql stable as $$ select current_setting('app.user_id', true)::uuid $$;
    insert into auth.users(id) values ('${A}'::uuid);
    create role authenticated nosuperuser;
  `);
  for (const f of MIGRATIONS) {
    await db.exec(readFileSync(join(ROOT, "supabase", "migrations", f), "utf8"));
  }
  await db.exec(`set app.user_id = '${A}'`);
});

test("migration: 0001->0007 applies cleanly on a fresh database", async () => {
  // If we got here, all seven migrations applied without error.
  const applied = (
    await q(
      `select count(*)::int as n from pg_tables where schemaname = 'public'`
    )
  ).rows[0].n;
  assert.ok(applied > 20, `expected app tables, got ${applied}`);
});

test("migration: sync_applied_mutations exists with account-scoped identity", async () => {
  const t = (
    await q(`select to_regclass('public.sync_applied_mutations') as t`)
  ).rows[0].t;
  assert.equal(t, "sync_applied_mutations", "ledger table must be created by 0007");

  // The primary key MUST be the composite (owner_id, mutation_id): mutation
  // identity includes account ownership, so one account's mutation id can
  // never be mistaken for another account's already-applied mutation.
  const pkCols = (
    await q(
      `select kcu.column_name
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on tc.constraint_name = kcu.constraint_name
          and tc.table_schema = kcu.table_schema
        where tc.table_schema = 'public'
          and tc.table_name = 'sync_applied_mutations'
          and tc.constraint_type = 'PRIMARY KEY'
        order by kcu.ordinal_position`
    )
  ).rows.map((r) => r.column_name);
  assert.deepEqual(
    pkCols,
    ["owner_id", "mutation_id"],
    "ledger PK must be (owner_id, mutation_id)"
  );

  // Required columns are present.
  const cols = (
    await q(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'sync_applied_mutations'`
    )
  ).rows.map((r) => r.column_name);
  for (const c of [
    "mutation_id",
    "owner_id",
    "entity",
    "record_id",
    "field",
    "delta",
    "applied_at",
  ]) {
    assert.ok(cols.includes(c), `ledger column ${c} must exist`);
  }
});

test("migration: ledger RLS is enabled and owner-scoped", async () => {
  const rls = (
    await q(
      `select relrowsecurity as rls, relforcerowsecurity as force
         from pg_class where relname = 'sync_applied_mutations'`
    )
  ).rows[0];
  assert.equal(rls.rls, true, "RLS must be enabled on the ledger");

  const policies = (
    await q(
      `select policyname, permissive, roles, cmd, qual, with_check
         from pg_policies
        where schemaname = 'public' and tablename = 'sync_applied_mutations'`
    )
  ).rows;
  assert.ok(policies.length >= 1, "ledger must have at least one RLS policy");
  const all = policies.find((p) => p.cmd === "ALL");
  assert.ok(all, "ledger needs an ALL policy for the SECURITY INVOKER RPC");
  assert.ok(
    all.qual.includes("auth.uid()") && all.with_check.includes("auth.uid()"),
    "ledger policy must scope rows to auth.uid()"
  );
});

test("migration: apply_increment exists and is callable by authenticated", async () => {
  const fn = (
    await q(
      `select count(*)::int as n from information_schema.routines
        where routine_schema = 'public' and routine_name = 'apply_increment'`
    )
  ).rows[0].n;
  assert.equal(fn, 1, "apply_increment must be created by 0007");

  const grant = (
    await q(
      `select has_function_privilege('authenticated',
         'public.apply_increment(uuid,text,uuid,text,numeric,jsonb,timestamptz)',
         'EXECUTE') as ok`
    )
  ).rows[0].ok;
  assert.equal(grant, true, "authenticated role must be able to execute the RPC");
});

test("migration: RPC works end-to-end on the migrated database", async () => {
  const habitId = (
    await q(`insert into habits(owner,name) values ('${A}','mig habit') returning id`)
  ).rows[0].id;
  const mid = "00000000-0000-4000-8000-000000000501";
  const rec = "00000000-0000-4000-8000-000000000502";
  const seed = JSON.stringify({
    habit_id: habitId,
    log_date: "2026-10-04",
    status: "done",
  });
  const call = (m, r, d) =>
    q(
      `select apply_increment($1::uuid,'habit_logs',$2::uuid,'value',$3::numeric,$4::jsonb,null) as res`,
      [m, r, d, seed]
    ).then((x) => x.rows[0].res);

  // First increment: 0 + 20 = 20 (row created by the RPC itself).
  const first = await call(mid, rec, 20);
  assert.equal(first.applied, true);
  assert.equal(Number(first.row.value), 20);

  // Same mutation retried: idempotent, value untouched.
  const retry = await call(mid, rec, 20);
  assert.equal(retry.applied, false);
  assert.equal(Number(retry.row.value), 20);

  // Different mutation: independent increment applied.
  const second = await call(
    "00000000-0000-4000-8000-000000000503",
    "00000000-0000-4000-8000-000000000504",
    5
  );
  assert.equal(second.applied, true);
  assert.equal(Number(second.row.value), 25);

  // Ledger holds both identities for this owner.
  const n = (
    await q(
      `select count(*)::int as n from sync_applied_mutations where owner_id = $1::uuid`,
      [A]
    )
  ).rows[0].n;
  assert.equal(n, 2);
});
