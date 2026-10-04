// V4.3.1: migration integrity for 0008_google_calendar_integration.sql.
//
// This test proves that a FRESH database applying the actual project
// migrations 0001 -> 0008 ends up with working Google Calendar tables:
// schema, constraints, RLS, and cascade behavior. It does NOT create any
// 0008 object manually: if migration 0008 forgets a required table,
// column, constraint, policy, trigger, or index, this test fails.
//
// Run with:
//   TZ='Asia/Kolkata' node --test --import ./tests/hooks.mjs tests/google_migration.test.mjs
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

function uniqueKeyCols(table) {
  return q(
    `select kcu.column_name
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu
         on tc.constraint_name = kcu.constraint_name
        and tc.table_schema = kcu.table_schema
      where tc.table_schema = 'public'
        and tc.table_name = $1
        and tc.constraint_type = 'UNIQUE'
      order by kcu.ordinal_position`,
    [table]
  ).then((r) => r.rows.map((x) => x.column_name));
}

before(async () => {
  db = new PGlite();
  // Minimal stub of the Supabase auth schema that the migrations expect.
  // Prerequisite of the environment, NOT a substitute for 0008: both
  // Google Calendar tables must come from the migration files.
  // Queries run as the non-superuser app_user so RLS actually enforces.
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
    await db.exec(readFileSync(join(ROOT, "supabase", "migrations", f), "utf8"));
  }
  await db.exec(`grant all on all tables in schema public to app_user`);
  await db.exec(`grant all on all tables in schema auth to app_user`);
  await db.exec(`set session authorization app_user`);
  await asUser(A);
});

test("migration: 0001->0008 applies cleanly on a fresh database", async () => {
  // If we got here, all eight migrations applied without error.
  for (const t of [
    "google_calendar_connections",
    "google_calendar_selections",
  ]) {
    const exists = (
      await q(`select to_regclass('public.${t}') as t`)
    ).rows[0].t;
    assert.equal(exists, t, `${t} must be created by migration 0008`);
  }
});

test("migration: connections table has the expected columns", async () => {
  const cols = await columnsOf("google_calendar_connections");
  for (const c of [
    "id",
    "owner",
    "google_account_id",
    "email",
    "status",
    "refresh_token_enc",
    "access_token_enc",
    "token_expires_at",
    "scopes",
    "created_at",
    "updated_at",
  ]) {
    assert.ok(cols.includes(c), `connections column ${c} must exist`);
  }
});

test("migration: selections table has the expected columns", async () => {
  const cols = await columnsOf("google_calendar_selections");
  for (const c of [
    "id",
    "owner",
    "connection_id",
    "google_calendar_id",
    "calendar_name",
    "time_zone",
    "is_primary",
    "selected",
    "created_at",
    "updated_at",
  ]) {
    assert.ok(cols.includes(c), `selections column ${c} must exist`);
  }
});

test("migration: uniqueness arbiters are the specified composites", async () => {
  // Same Google account reconnect reuses the row: no duplicates per owner.
  assert.deepEqual(
    await uniqueKeyCols("google_calendar_connections"),
    ["owner", "google_account_id"],
    "connections must be unique on (owner, google_account_id)"
  );
  assert.deepEqual(
    await uniqueKeyCols("google_calendar_selections"),
    ["connection_id", "google_calendar_id"],
    "selections must be unique on (connection_id, google_calendar_id)"
  );
});

test("migration: cascades, defaults, and updated_at triggers are wired", async () => {
  // owner -> auth.users cascades, connection_id -> connections cascades.
  // (pg_catalog, not information_schema: the referential views hide rows
  //  from non-owner roles, but pg_constraint is fully visible.)
  const fks = (
    await q(
      `select t.relname as table_name,
              (regexp_split_to_array(c.confrelid::regclass::text, '\\.'))[
                array_length(regexp_split_to_array(c.confrelid::regclass::text, '\\.'), 1)
              ] as ref,
              c.confdeltype as del
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
        where c.contype = 'f'
          and t.relname in
            ('google_calendar_connections', 'google_calendar_selections')`
    )
  ).rows;
  const cascade = (t, ref) =>
    fks.some((f) => f.table_name === t && f.ref === ref && f.del === "c");
  assert.ok(
    cascade("google_calendar_connections", "users"),
    "connections.owner must cascade from auth.users"
  );
  assert.ok(
    cascade("google_calendar_selections", "users"),
    "selections.owner must cascade from auth.users"
  );
  assert.ok(
    cascade("google_calendar_selections", "google_calendar_connections"),
    "selections.connection_id must cascade from connections"
  );

  // Defaults: status 'connected', scopes '{}', selected false.
  await asUser(A);
  const conn = (
    await q(
      `insert into google_calendar_connections(owner, google_account_id, email)
       values ('${A}', 'sub-defaults', 'a@gmail.com') returning *`
    )
  ).rows[0];
  assert.equal(conn.status, "connected", "status must default to connected");
  assert.deepEqual(conn.scopes, [], "scopes must default to empty array");

  const sel = (
    await q(
      `insert into google_calendar_selections(owner, connection_id, google_calendar_id)
       values ('${A}', '${conn.id}', 'primary') returning *`
    )
  ).rows[0];
  assert.equal(sel.selected, false, "selected must default to false");
  assert.equal(sel.is_primary, false, "is_primary must default to false");

  // handle_updated_at triggers stamp updated_at on both tables.
  for (const [t, id] of [
    ["google_calendar_connections", conn.id],
    ["google_calendar_selections", sel.id],
  ]) {
    const trg = (
      await q(
        `select count(*)::int as n from pg_trigger
          where tgrelid = 'public.${t}'::regclass and not tgisinternal`
      )
    ).rows[0].n;
    assert.equal(trg, 1, `${t} must have exactly one updated_at trigger`);
  }
  await q(`delete from google_calendar_connections where id = '${conn.id}'`);

  // Indexes exist.
  for (const idx of [
    "google_calendar_connections_owner_idx",
    "google_calendar_selections_owner_connection_idx",
  ]) {
    const n = (
      await q(
        `select count(*)::int as n from pg_indexes
          where schemaname = 'public' and indexname = $1`,
        [idx]
      )
    ).rows[0].n;
    assert.equal(n, 1, `index ${idx} must exist`);
  }
});

test("migration: RLS is enabled and owner-scoped on both tables", async () => {
  for (const t of [
    "google_calendar_connections",
    "google_calendar_selections",
  ]) {
    const rls = (
      await q(
        `select relrowsecurity as rls from pg_class where relname = $1`,
        [t]
      )
    ).rows[0].rls;
    assert.equal(rls, true, `RLS must be enabled on ${t}`);

    const all = (
      await q(
        `select policyname, cmd, qual, with_check from pg_policies
          where schemaname = 'public' and tablename = $1 and cmd = 'ALL'`,
        [t]
      )
    ).rows;
    assert.equal(
      all.length,
      1,
      `${t} must have exactly one ALL policy`
    );
    assert.ok(
      all[0].qual.includes("auth.uid()") &&
        all[0].with_check.includes("auth.uid()"),
      `${t} policy must scope rows to auth.uid()`
    );
  }
  // The selections policy additionally requires the referenced connection
  // to be owned by the caller, so a user can never attach a selection to
  // someone else's connection.
  const selPolicy = (
    await q(
      `select with_check from pg_policies
        where schemaname = 'public'
          and tablename = 'google_calendar_selections'`
    )
  ).rows[0].with_check;
  assert.ok(
    selPolicy.includes("google_calendar_connections"),
    "selections with-check must verify connection ownership"
  );
});

test("migration: User B is isolated from User A's connections (select/insert/update/delete)", async () => {
  await asUser(A);
  const aConn = (
    await q(
      `insert into google_calendar_connections(owner, google_account_id, email)
       values ('${A}', 'sub-iso', 'a@gmail.com') returning id`
    )
  ).rows[0];

  await asUser(B);
  // Cannot see A's connection.
  let n = (
    await q(`select count(*)::int as n from google_calendar_connections`)
  ).rows[0].n;
  assert.equal(n, 0, "B must not see A's connection");

  // Cannot insert a row owned by A.
  await expectBlock(
    q(
      `insert into google_calendar_connections(owner, google_account_id)
       values ('${A}', 'sub-evil')`
    ),
    "B inserting a connection owned by A"
  );

  // Cannot update A's connection (silently affects zero rows under RLS).
  const upd = (
    await q(
      `update google_calendar_connections set email = 'x@evil.com'
        where id = '${aConn.id}'`
    )
  ).rowCount;
  assert.equal(upd, 0, "B must not update A's connection");

  // Cannot delete A's connection.
  const del = (
    await q(`delete from google_calendar_connections where id = '${aConn.id}'`)
  ).rowCount;
  assert.equal(del, 0, "B must not delete A's connection");

  // B CAN manage their own connection.
  const bConn = (
    await q(
      `insert into google_calendar_connections(owner, google_account_id)
       values ('${B}', 'sub-iso') returning id`
    )
  ).rows[0];
  assert.ok(bConn.id, "B can insert their own connection");
  // Same google_account_id under a different owner is a DIFFERENT row:
  // the uniqueness arbiter is (owner, google_account_id), not the sub alone.
  n = (
    await q(
      `select count(*)::int as n from google_calendar_connections where owner = '${B}'`
    )
  ).rows[0].n;
  assert.equal(n, 1, "B sees exactly their own connection");

  await asUser(A);
  await q(`delete from google_calendar_connections where id = '${aConn.id}'`);
  await asUser(B);
  await q(`delete from google_calendar_connections where id = '${bConn.id}'`);
});

test("migration: User B is isolated from User A's selections", async () => {
  await asUser(A);
  const aConn = (
    await q(
      `insert into google_calendar_connections(owner, google_account_id)
       values ('${A}', 'sub-seliso') returning id`
    )
  ).rows[0];
  const aSel = (
    await q(
      `insert into google_calendar_selections(owner, connection_id, google_calendar_id, calendar_name, selected)
       values ('${A}', '${aConn.id}', 'primary', 'A Calendar', true) returning id`
    )
  ).rows[0];

  await asUser(B);
  let n = (
    await q(`select count(*)::int as n from google_calendar_selections`)
  ).rows[0].n;
  assert.equal(n, 0, "B must not see A's selections");

  // Cannot attach a selection to A's connection, even with owner=B.
  await expectBlock(
    q(
      `insert into google_calendar_selections(owner, connection_id, google_calendar_id)
       values ('${B}', '${aConn.id}', 'primary')`
    ),
    "B attaching a selection to A's connection"
  );

  // Cannot insert a selection row owned by A.
  await expectBlock(
    q(
      `insert into google_calendar_selections(owner, connection_id, google_calendar_id)
       values ('${A}', '${aConn.id}', 'primary')`
    ),
    "B inserting a selection owned by A"
  );

  // Cannot flip A's selection.
  const upd = (
    await q(
      `update google_calendar_selections set selected = false where id = '${aSel.id}'`
    )
  ).rowCount;
  assert.equal(upd, 0, "B must not update A's selection");

  await asUser(A);
  await q(`delete from google_calendar_connections where id = '${aConn.id}'`);
});

test("migration: duplicate connections and selections are rejected", async () => {
  await asUser(A);
  const conn = (
    await q(
      `insert into google_calendar_connections(owner, google_account_id)
       values ('${A}', 'sub-dup') returning id`
    )
  ).rows[0];

  // Same (owner, google_account_id) twice: blocked.
  await expectBlock(
    q(
      `insert into google_calendar_connections(owner, google_account_id)
       values ('${A}', 'sub-dup')`
    ),
    "duplicate (owner, google_account_id)"
  );

  // Same (connection_id, google_calendar_id) twice: blocked.
  await q(
    `insert into google_calendar_selections(owner, connection_id, google_calendar_id)
     values ('${A}', '${conn.id}', 'primary')`
  );
  await expectBlock(
    q(
      `insert into google_calendar_selections(owner, connection_id, google_calendar_id)
       values ('${A}', '${conn.id}', 'primary')`
    ),
    "duplicate (connection_id, google_calendar_id)"
  );

  // A different calendar under the same connection: fine.
  const ok = (
    await q(
      `insert into google_calendar_selections(owner, connection_id, google_calendar_id)
       values ('${A}', '${conn.id}', 'other@group.calendar.google.com') returning id`
    )
  ).rows[0];
  assert.ok(ok.id);

  await q(`delete from google_calendar_connections where id = '${conn.id}'`);
});

test("migration: deleting a connection cascades to its selections", async () => {
  await asUser(A);
  const conn = (
    await q(
      `insert into google_calendar_connections(owner, google_account_id)
       values ('${A}', 'sub-cascade') returning id`
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

  // Disconnect = delete the connection row. Selections go with it;
  // previously imported app events are untouched (no such import here).
  await q(`delete from google_calendar_connections where id = '${conn.id}'`);
  n = (
    await q(
      `select count(*)::int as n from google_calendar_selections where connection_id = '${conn.id}'`
    )
  ).rows[0].n;
  assert.equal(n, 0, "deleting the connection must cascade to its selections");
});

test("migration: deleting the auth.users row purges connections and selections (account cleanup)", async () => {
  await q(`insert into auth.users(id) values ('${C}'::uuid)`);
  await asUser(C);
  const conn = (
    await q(
      `insert into google_calendar_connections(owner, google_account_id)
       values ('${C}', 'sub-cleanup') returning id`
    )
  ).rows[0];
  await q(
    `insert into google_calendar_selections(owner, connection_id, google_calendar_id)
     values ('${C}', '${conn.id}', 'primary')`
  );

  await q(`delete from auth.users where id = '${C}'`);
  const nConn = (
    await q(
      `select count(*)::int as n from google_calendar_connections where owner = '${C}'`
    )
  ).rows[0].n;
  const nSel = (
    await q(
      `select count(*)::int as n from google_calendar_selections where owner = '${C}'`
    )
  ).rows[0].n;
  assert.equal(nConn, 0, "owner cascade must remove connections");
  assert.equal(nSel, 0, "owner cascade must remove selections");
});

test("migration: status check constraint rejects invalid values", async () => {
  await asUser(A);
  await expectBlock(
    q(
      `insert into google_calendar_connections(owner, google_account_id, status)
       values ('${A}', 'sub-status', 'bogus')`
    ),
    "status outside ('connected','revoked','error')"
  );
  for (const s of ["connected", "revoked", "error"]) {
    const row = (
      await q(
        `insert into google_calendar_connections(owner, google_account_id, status)
         values ('${A}', 'sub-status-${s}', '${s}') returning id`
      )
    ).rows[0];
    assert.ok(row.id, `status '${s}' must be accepted`);
    await q(
      `delete from google_calendar_connections where google_account_id = 'sub-status-${s}'`
    );
  }
});

test("regression (V3.2): challenge_reviews composite FK still enforced", async () => {
  // 0008 must not weaken the V3.2 ownership hardening: a review can only
  // reference a challenge owned by the same user.
  await asUser(A);
  const chA = (
    await q(
      `insert into challenges(owner, start_date) values ('${A}', '2026-10-02') returning id`
    )
  ).rows[0];
  await asUser(B);
  const chB = (
    await q(
      `insert into challenges(owner, start_date) values ('${B}', '2026-10-02') returning id`
    )
  ).rows[0];

  await asUser(A);
  const ok = (
    await q(
      `insert into challenge_reviews(owner, challenge_id) values ('${A}', '${chA.id}') returning id`
    )
  ).rows[0];
  assert.ok(ok.id, "own-challenge review still accepted");

  await expectBlock(
    q(
      `insert into challenge_reviews(owner, challenge_id) values ('${A}', '${chB.id}')`
    ),
    "review referencing another user's challenge"
  );

  await asUser(A);
  await q(`delete from challenges where id = '${chA.id}'`);
  await asUser(B);
  await q(`delete from challenges where id = '${chB.id}'`);
});
