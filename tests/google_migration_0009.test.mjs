// V4.3.1.1: migration integrity for 0009_google_oauth_hardening.sql.
//
// This test proves that a FRESH database applying the actual project
// migrations 0001 -> 0009 ends up with:
//   * public.google_oauth_transactions — schema, RLS, owner-scoped policy,
//     (owner, expires_at) index,
//   * google_calendar_connections_one_per_owner — the unique(owner)
//     constraint, enforced,
//   * unchanged 0008 behavior (selections cascade, owner isolation).
// It does NOT create any 0009 object manually: if migration 0009 forgets a
// required table, column, constraint, policy, or index, this test fails.
//
// Run with:
//   TZ='Asia/Kolkata' node --test --import ./tests/hooks.mjs tests/google_migration_0009.test.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const C = "33333333-3333-3333-3333-333333333333";

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
];

let db;

async function q(sql, params = []) {
  return db.query(sql, params);
}

async function asUser(id) {
  await db.exec(`set app.user_id = '${id}'`);
}

/** Expect the promise to reject (constraint / RLS block). */
async function expectBlock(promise, label) {
  let blocked = false;
  try {
    await promise;
  } catch {
    blocked = true;
  }
  assert.ok(blocked, `expected block: ${label}`);
}

function columnsOf(table) {
  return q(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = $1`,
    [table]
  ).then((r) => r.rows.map((x) => x.column_name));
}

before(async () => {
  db = new PGlite();
  // Minimal stub of the Supabase auth schema that the migrations expect.
  // Prerequisite of the environment, NOT a substitute for 0009: the OAuth
  // transaction table, the dedupe, and the unique(owner) constraint must
  // all come from the migration files. Queries run as the non-superuser
  // app_user so RLS actually enforces.
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
    -- CREATE on public is only for this file's dedupe scratch table; the
    -- migration under test never needs it.
    grant create on schema public to app_user;
    grant execute on function auth.uid() to app_user;
  `);
  for (const f of MIGRATIONS) {
    await db.exec(readFileSync(join(ROOT, "supabase", "migrations", f), "utf8"));
  }
  await db.exec(`grant all on all tables in schema public to app_user`);
  await db.exec(`grant all on all tables in schema auth to app_user`);
  await db.exec(`set session authorization app_user`);
  await asUser(A);
});

test("migration: 0001->0009 applies cleanly on a fresh database", async () => {
  // If we got here, all nine migrations applied without error.
  const exists = (
    await q(`select to_regclass('public.google_oauth_transactions') as t`)
  ).rows[0].t;
  assert.equal(
    exists,
    "google_oauth_transactions",
    "google_oauth_transactions must be created by migration 0009"
  );
});

test("migration: google_oauth_transactions has the expected columns", async () => {
  const cols = await columnsOf("google_oauth_transactions");
  for (const c of [
    "id",
    "owner",
    "state",
    "verifier_enc",
    "created_at",
    "expires_at",
    "consumed_at",
  ]) {
    assert.ok(cols.includes(c), `google_oauth_transactions column ${c} must exist`);
  }
});

test("migration: RLS is enabled and owner-scoped on google_oauth_transactions", async () => {
  const rls = (
    await q(
      `select relrowsecurity as rls from pg_class
        where relname = 'google_oauth_transactions'`
    )
  ).rows[0].rls;
  assert.equal(rls, true, "RLS must be enabled on google_oauth_transactions");

  const policies = (
    await q(
      `select policyname, cmd, qual, with_check from pg_policies
        where schemaname = 'public'
          and tablename = 'google_oauth_transactions' and cmd = 'ALL'`
    )
  ).rows;
  assert.equal(
    policies.length,
    1,
    "google_oauth_transactions must have exactly one ALL policy"
  );
  assert.ok(
    policies[0].qual.includes("auth.uid()") &&
      policies[0].with_check.includes("auth.uid()"),
    "policy must scope rows to auth.uid() in both qual and with_check"
  );
});

test("migration: the (owner, expires_at) index exists", async () => {
  const n = (
    await q(
      `select count(*)::int as n from pg_indexes
        where schemaname = 'public'
          and indexname = 'google_oauth_transactions_owner_expires_idx'`
    )
  ).rows[0].n;
  assert.equal(n, 1, "owner/expires index must exist");
});

test("migration: google_calendar_connections_one_per_owner constraint exists", async () => {
  const rows = (
    await q(
      `select conname, contype from pg_constraint
        where conrelid = 'public.google_calendar_connections'::regclass
          and conname = 'google_calendar_connections_one_per_owner'`
    )
  ).rows;
  assert.equal(rows.length, 1, "the one-per-owner constraint must exist");
  assert.equal(rows[0].contype, "u", "it must be a UNIQUE constraint");
});

test("migration: a second connection for the same owner is rejected (23505)", async () => {
  await asUser(A);
  const first = (
    await q(
      `insert into google_calendar_connections(owner, google_account_id)
       values ('${A}', 'sub-one-per-owner-1') returning id`
    )
  ).rows[0];
  assert.ok(first.id, "first connection for the owner is accepted");

  // Same owner, DIFFERENT Google account: the new unique(owner) arbiter
  // rejects it (the old unique(owner, google_account_id) alone would allow it).
  let code = null;
  try {
    await q(
      `insert into google_calendar_connections(owner, google_account_id)
       values ('${A}', 'sub-one-per-owner-2')`
    );
  } catch (err) {
    code = err.code;
  }
  assert.equal(code, "23505", "second connection for the owner must raise unique_violation");

  await q(`delete from google_calendar_connections where id = '${first.id}'`);
});

test("migration: User B is isolated from User A's OAuth transactions", async () => {
  await asUser(A);
  const txn = (
    await q(
      `insert into google_oauth_transactions(owner, state, verifier_enc, expires_at)
       values ('${A}', 'state-a', 'v1:enc', now() + interval '10 minutes')
       returning id`
    )
  ).rows[0];
  assert.ok(txn.id, "A can insert their own transaction");

  await asUser(B);
  // Cannot see A's transaction.
  let n = (
    await q(`select count(*)::int as n from google_oauth_transactions`)
  ).rows[0].n;
  assert.equal(n, 0, "B must not see A's transaction");

  // Cannot delete A's transaction (silently affects zero rows under RLS).
  const del = (
    await q(
      `delete from google_oauth_transactions where id = '${txn.id}'`
    )
  ).rowCount;
  assert.equal(del, 0, "B must not delete A's transaction");

  // Cannot insert a transaction owned by A.
  await expectBlock(
    q(
      `insert into google_oauth_transactions(owner, state, verifier_enc, expires_at)
       values ('${A}', 'state-evil', 'v1:enc', now() + interval '10 minutes')`
    ),
    "B inserting a transaction owned by A"
  );

  // B CAN manage their own transaction.
  const bTxn = (
    await q(
      `insert into google_oauth_transactions(owner, state, verifier_enc, expires_at)
       values ('${B}', 'state-b', 'v1:enc', now() + interval '10 minutes')
       returning id`
    )
  ).rows[0];
  assert.ok(bTxn.id, "B can insert their own transaction");

  await q(
    `delete from google_oauth_transactions where id = '${bTxn.id}'`
  );
  await asUser(A);
  const ownDel = (
    await q(
      `delete from google_oauth_transactions where id = '${txn.id}'`
    )
  ).rowCount;
  assert.equal(ownDel, 1, "A can delete their own transaction");
});

test("migration: 0008 behavior still valid — selections cascade on connection delete", async () => {
  await asUser(A);
  const conn = (
    await q(
      `insert into google_calendar_connections(owner, google_account_id)
       values ('${A}', 'sub-0009-cascade') returning id`
    )
  ).rows[0];
  await q(
    `insert into google_calendar_selections(owner, connection_id, google_calendar_id)
     values ('${A}', '${conn.id}', 'c1'), ('${A}', '${conn.id}', 'c2')`
  );
  let n = (
    await q(
      `select count(*)::int as n from google_calendar_selections where connection_id = '${conn.id}'`
    )
  ).rows[0].n;
  assert.equal(n, 2, "setup: two selections exist");

  await q(`delete from google_calendar_connections where id = '${conn.id}'`);
  n = (
    await q(
      `select count(*)::int as n from google_calendar_selections where connection_id = '${conn.id}'`
    )
  ).rows[0].n;
  assert.equal(n, 0, "deleting the connection must cascade to its selections");
});

test("migration: deleting the auth.users row purges OAuth transactions (account cleanup)", async () => {
  await q(`insert into auth.users(id) values ('${C}'::uuid)`);
  await asUser(C);
  await q(
    `insert into google_oauth_transactions(owner, state, verifier_enc, expires_at)
     values ('${C}', 'state-c', 'v1:enc', now() + interval '10 minutes')`
  );
  await q(`delete from auth.users where id = '${C}'`);
  const n = (
    await q(
      `select count(*)::int as n from google_oauth_transactions where owner = '${C}'`
    )
  ).rows[0].n;
  assert.equal(n, 0, "owner cascade must remove OAuth transactions");
});

test("migration: dedupe SQL keeps the greatest (updated_at, id) per owner", async () => {
  // The migration's dedupe runs on an empty table at apply time, so its
  // row-selection logic is proven here on a scratch table with the exact
  // same statement shape: keep the survivor with the greatest
  // (updated_at, id) per owner, delete everything else.
  await q(
    `create table dedupe_probe (
       id uuid primary key,
       owner uuid not null,
       updated_at timestamptz not null
     )`
  );
  await q(
    `insert into dedupe_probe(id, owner, updated_at) values
       ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '${A}', '2026-10-01T00:00:00Z'),
       ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '${A}', '2026-10-02T00:00:00Z'),
       ('cccccccc-cccc-cccc-cccc-cccccccccccc', '${A}', '2026-10-02T00:00:00Z'),
       ('dddddddd-dddd-dddd-dddd-dddddddddddd', '${B}', '2026-10-01T00:00:00Z')`
  );

  // Same statement shape as migration 0009's dedupe, table name adapted.
  await q(
    `delete from dedupe_probe c
     where exists (
       select 1
         from dedupe_probe survivor
        where survivor.owner = c.owner
          and survivor.id <> c.id
          and (survivor.updated_at, survivor.id) > (c.updated_at, c.id)
     )`
  );

  const survivors = (
    await q(`select id, owner from dedupe_probe order by owner, id`)
  ).rows;
  assert.deepEqual(
    survivors.map((r) => r.id),
    ["cccccccc-cccc-cccc-cccc-cccccccccccc", "dddddddd-dddd-dddd-dddd-dddddddddddd"],
    "owner A keeps the row with the greatest (updated_at, id) — the updated_at " +
      "tie breaks on the greater id; owner B's lone row is untouched"
  );
  assert.deepEqual(
    survivors.map((r) => r.owner),
    [A, B]
  );

  await q(`drop table dedupe_probe`);
});
