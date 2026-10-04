// V4.3.2: migration integrity for 0010_google_calendar_sync.sql.
//
// This test proves that a FRESH database applying the actual project
// migrations 0001 -> 0010 ends up with:
//   * public.google_calendar_sync_state — schema, (owner, google_calendar_id)
//     uniqueness, owner-scoped RLS, updated_at trigger,
//   * public.google_event_mappings — schema, both UNIQUE constraints,
//     the origin check, ON DELETE SET NULL tombstone semantics on
//     local_event_id, owner-scoped RLS, updated_at trigger,
//   * intentionally NO foreign key from either table to
//     google_calendar_connections — disconnect keeps mappings and sync
//     cursors so a reconnect resumes instead of duplicating; a
//     different-account replace deletes them explicitly by
//     google_account_id.
// It does NOT create any 0010 object manually: if migration 0010 forgets a
// required table, column, constraint, policy, trigger, or index, this test fails.
//
// Run with:
//   TZ='Asia/Kolkata' node --test --import ./tests/hooks.mjs tests/google_migration_0010.test.mjs
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
  "0010_google_calendar_sync.sql",
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

/** Insert a sync_state row; returns id. */
async function insertSyncState(owner, account, cal, token = null) {
  const r = await q(
    `insert into google_calendar_sync_state(owner, google_account_id, google_calendar_id, sync_token)
     values ($1, $2, $3, $4) returning id`,
    [owner, account, cal, token]
  );
  return r.rows[0].id;
}

/** Insert a mapping row; returns id. */
async function insertMapping(owner, account, cal, extra = {}) {
  const r = await q(
    `insert into google_event_mappings
       (owner, local_event_id, google_account_id, google_calendar_id,
        google_event_id, google_etag, origin, google_timezone, recurrence)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [
      owner,
      extra.local_event_id ?? null,
      account,
      cal,
      extra.google_event_id ?? null,
      extra.google_etag ?? null,
      extra.origin ?? "google",
      extra.google_timezone ?? null,
      extra.recurrence ?? null,
    ]
  );
  return r.rows[0].id;
}

function columnsOf(table) {
  return q(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = $1`,
    [table]
  ).then((r) => r.rows.map((x) => x.column_name));
}

async function tableExists(name) {
  const r = await q(`select to_regclass($1) as t`, [`public.${name}`]);
  return r.rows[0].t === name;
}

async function countRows(table, where, params) {
  const r = await q(`select count(*)::int as n from ${table} where ${where}`, params);
  return r.rows[0].n;
}

before(async () => {
  db = new PGlite();
  // Minimal stub of the Supabase auth schema that the migrations expect.
  // Prerequisite of the environment, NOT a substitute for 0010: both new
  // tables, their constraints, policies, triggers, and indexes must all
  // come from the migration files. Queries run as the non-superuser
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

test("migration: 0001->0010 applies cleanly on a fresh database", async () => {
  // If we got here, all ten migrations applied without error.
  assert.ok(
    await tableExists("google_calendar_sync_state"),
    "google_calendar_sync_state must be created by migration 0010"
  );
  assert.ok(
    await tableExists("google_event_mappings"),
    "google_event_mappings must be created by migration 0010"
  );
});

test("migration: google_calendar_sync_state has the expected columns", async () => {
  const cols = await columnsOf("google_calendar_sync_state");
  for (const c of [
    "id",
    "owner",
    "google_account_id",
    "google_calendar_id",
    "sync_token",
    "last_synced_at",
    "created_at",
    "updated_at",
  ]) {
    assert.ok(cols.includes(c), `google_calendar_sync_state column ${c} must exist`);
  }
});

test("migration: google_event_mappings has the expected columns", async () => {
  const cols = await columnsOf("google_event_mappings");
  for (const c of [
    "id",
    "owner",
    "local_event_id",
    "google_account_id",
    "google_calendar_id",
    "google_event_id",
    "google_etag",
    "origin",
    "google_timezone",
    "recurrence",
    "last_synced_at",
    "created_at",
    "updated_at",
  ]) {
    assert.ok(cols.includes(c), `google_event_mappings column ${c} must exist`);
  }
});

test("migration: RLS enabled with exactly one owner-scoped ALL policy per table", async () => {
  for (const t of ["google_calendar_sync_state", "google_event_mappings"]) {
    const rls = (
      await q(
        `select relrowsecurity as rls from pg_class where relname = $1`,
        [t]
      )
    ).rows[0].rls;
    assert.equal(rls, true, `RLS must be enabled on ${t}`);

    const policies = (
      await q(
        `select policyname, cmd, qual, with_check from pg_policies
          where schemaname = 'public' and tablename = $1 and cmd = 'ALL'`,
        [t]
      )
    ).rows;
    assert.equal(policies.length, 1, `${t} must have exactly one ALL policy`);
    assert.ok(
      policies[0].qual.includes("auth.uid()") &&
        policies[0].with_check.includes("auth.uid()"),
      `${t} policy must scope rows to auth.uid() in both qual and with_check`
    );
  }
});

test("migration: (owner, google_calendar_id) unique enforced on sync_state (23505)", async () => {
  await asUser(A);
  const id = await insertSyncState(A, "acct-sync-uniq", "cal-sync-uniq", "tok-1");
  assert.ok(id, "first sync_state row accepted");

  let code = null;
  try {
    await insertSyncState(A, "acct-sync-uniq-2", "cal-sync-uniq", "tok-2");
  } catch (err) {
    code = err.code;
  }
  assert.equal(
    code,
    "23505",
    "duplicate (owner, google_calendar_id) must raise unique_violation"
  );

  // Same calendar for a DIFFERENT owner is fine.
  await asUser(B);
  const bId = await insertSyncState(B, "acct-sync-uniq", "cal-sync-uniq", "tok-b");
  assert.ok(bId, "same calendar for another owner is accepted");

  await asUser(A);
  await q(`delete from google_calendar_sync_state where id = '${id}'`);
  await asUser(B);
  await q(`delete from google_calendar_sync_state where id = '${bId}'`);
  await asUser(A);
});

test("migration: mappings (owner, calendar, google_event_id) unique enforced; NULLs don't conflict", async () => {
  await asUser(A);
  const m1 = await insertMapping(A, "acct-map-uniq", "cal-map-uniq", {
    google_event_id: "gev-uniq-1",
  });
  assert.ok(m1, "first mapping with google_event_id accepted");

  let code = null;
  try {
    await insertMapping(A, "acct-map-uniq", "cal-map-uniq", {
      google_event_id: "gev-uniq-1",
    });
  } catch (err) {
    code = err.code;
  }
  assert.equal(
    code,
    "23505",
    "duplicate (owner, calendar, google_event_id) must raise unique_violation"
  );

  // Two rows with NULL google_event_id (pending pushes) must NOT conflict.
  const p1 = await insertMapping(A, "acct-map-uniq", "cal-map-uniq", {
    origin: "synced",
  });
  const p2 = await insertMapping(A, "acct-map-uniq", "cal-map-uniq", {
    origin: "synced",
  });
  assert.ok(p1 && p2, "multiple NULL google_event_id rows must be accepted");

  await q(
    `delete from google_event_mappings where id in ('${m1}', '${p1}', '${p2}')`
  );
});

test("migration: mappings (owner, local_event_id) unique enforced; NULL tombstones don't conflict", async () => {
  await asUser(A);
  const ev1 = (
    await q(
      `insert into calendar_events(owner, title, event_date, start_time, end_time)
       values ('${A}', 'local-uniq-1', current_date, '09:00', '10:00') returning id`
    )
  ).rows[0].id;
  const ev2 = (
    await q(
      `insert into calendar_events(owner, title, event_date, start_time, end_time)
       values ('${A}', 'local-uniq-2', current_date, '11:00', '12:00') returning id`
    )
  ).rows[0].id;

  const m1 = await insertMapping(A, "acct-map-uniq2", "cal-map-uniq2", {
    origin: "synced",
    local_event_id: ev1,
  });
  assert.ok(m1, "first mapping for the local event accepted");

  let code = null;
  try {
    await insertMapping(A, "acct-map-uniq2", "cal-map-uniq2", {
      origin: "synced",
      local_event_id: ev1,
    });
  } catch (err) {
    code = err.code;
  }
  assert.equal(
    code,
    "23505",
    "duplicate (owner, local_event_id) must raise unique_violation"
  );

  // Two NULL local_event_id tombstones must NOT conflict.
  const t1 = await insertMapping(A, "acct-map-uniq2", "cal-map-uniq2", {
    google_event_id: "gev-tomb-1",
  });
  const t2 = await insertMapping(A, "acct-map-uniq2", "cal-map-uniq2", {
    google_event_id: "gev-tomb-2",
  });
  assert.ok(t1 && t2, "multiple NULL local_event_id rows must be accepted");

  // A mapping may point at a DIFFERENT local event for the same calendar.
  const m2 = await insertMapping(A, "acct-map-uniq2", "cal-map-uniq2", {
    origin: "synced",
    local_event_id: ev2,
  });
  assert.ok(m2, "second local event gets its own mapping");

  await q(`delete from google_event_mappings where id in ('${m1}', '${m2}', '${t1}', '${t2}')`);
  await q(`delete from calendar_events where id in ('${ev1}', '${ev2}')`);
});

test("migration: origin check constraint rejects invalid origins (23514)", async () => {
  await asUser(A);
  let code = null;
  try {
    await insertMapping(A, "acct-origin", "cal-origin", { origin: "bogus" });
  } catch (err) {
    code = err.code;
  }
  assert.equal(code, "23514", "invalid origin must raise check_violation");

  const m = await insertMapping(A, "acct-origin", "cal-origin", {
    origin: "synced",
  });
  assert.ok(m, "origin='synced' accepted");
  await q(`delete from google_event_mappings where id = '${m}'`);
});

test("migration: User B is isolated from User A's sync_state and mappings", async () => {
  await asUser(A);
  const sId = await insertSyncState(A, "acct-iso", "cal-iso", "tok-a");
  const mId = await insertMapping(A, "acct-iso", "cal-iso", {
    google_event_id: "gev-iso",
  });

  await asUser(B);
  // Cannot read A's rows.
  assert.equal(
    await countRows("google_calendar_sync_state", "owner = $1", [A]),
    0,
    "B must not see A's sync_state rows"
  );
  assert.equal(
    await countRows("google_event_mappings", "owner = $1", [A]),
    0,
    "B must not see A's mapping rows"
  );

  // Cannot insert rows owned by A.
  await expectBlock(
    insertSyncState(A, "acct-iso-evil", "cal-iso-evil"),
    "B inserting sync_state owned by A"
  );
  await expectBlock(
    insertMapping(A, "acct-iso-evil", "cal-iso-evil", { origin: "google" }),
    "B inserting a mapping owned by A"
  );

  // Cannot update A's rows (silently affects zero rows under RLS).
  assert.equal(
    (await q(`update google_calendar_sync_state set sync_token = 'evil' where owner = '${A}'`)).rowCount,
    0,
    "B must not update A's sync_state rows"
  );
  assert.equal(
    (await q(`update google_event_mappings set google_etag = 'evil' where owner = '${A}'`)).rowCount,
    0,
    "B must not update A's mapping rows"
  );

  // Cannot delete A's rows (silently affects zero rows under RLS).
  assert.equal(
    (await q(`delete from google_calendar_sync_state where id = '${sId}'`)).rowCount,
    0,
    "B must not delete A's sync_state rows"
  );
  assert.equal(
    (await q(`delete from google_event_mappings where id = '${mId}'`)).rowCount,
    0,
    "B must not delete A's mapping rows"
  );

  // B CAN manage their own rows.
  const bs = await insertSyncState(B, "acct-iso-b", "cal-iso-b");
  const bm = await insertMapping(B, "acct-iso-b", "cal-iso-b", { origin: "google" });
  assert.ok(bs && bm, "B can insert their own rows");
  await q(`delete from google_calendar_sync_state where id = '${bs}'`);
  await q(`delete from google_event_mappings where id = '${bm}'`);

  await asUser(A);
  await q(`delete from google_calendar_sync_state where id = '${sId}'`);
  await q(`delete from google_event_mappings where id = '${mId}'`);
});

test("migration: deleting the auth.users row cascades to both new tables", async () => {
  await q(`insert into auth.users(id) values ('${C}'::uuid)`);
  await asUser(C);
  const sId = await insertSyncState(C, "acct-cascade", "cal-cascade", "tok-c");
  const mId = await insertMapping(C, "acct-cascade", "cal-cascade", {
    google_event_id: "gev-c",
  });
  assert.ok(sId && mId, "setup: C owns rows in both tables");

  await q(`delete from auth.users where id = '${C}'`);
  assert.equal(
    await countRows("google_calendar_sync_state", "owner = $1", [C]),
    0,
    "owner cascade must remove sync_state rows"
  );
  assert.equal(
    await countRows("google_event_mappings", "owner = $1", [C]),
    0,
    "owner cascade must remove mapping rows"
  );
  await asUser(A);
});

test("migration: deleting calendar_events SET NULLs the mapping — tombstone survives", async () => {
  await asUser(A);
  const ev = (
    await q(
      `insert into calendar_events(owner, title, event_date, start_time, end_time)
       values ('${A}', 'imported-google-event', current_date, '09:00', '10:00')
       returning id`
    )
  ).rows[0].id;
  const mId = await insertMapping(A, "acct-tomb", "cal-tomb", {
    origin: "google",
    local_event_id: ev,
    google_event_id: "gev-tombstone",
  });

  // The user deletes the local copy of an imported Google event.
  await q(`delete from calendar_events where id = '${ev}'`);

  // The mapping row must SURVIVE with local_event_id NULL: it is the
  // do-not-reimport tombstone marker, not a dangling row.
  const row = (
    await q(`select id, local_event_id, origin, google_event_id
             from google_event_mappings where id = '${mId}'`)
  ).rows[0];
  assert.ok(row, "the mapping row must survive the local event delete");
  assert.equal(row.local_event_id, null, "local_event_id must be SET NULL");
  assert.equal(row.origin, "google", "origin must be preserved");
  assert.equal(row.google_event_id, "gev-tombstone", "Google identity must be preserved");

  await q(`delete from google_event_mappings where id = '${mId}'`);
});

// ---------------------------------------------------------------------------
// The connection FK is intentionally absent.
//
// Rationale (mirrors the 0010 header comment): disconnecting deletes the
// google_calendar_connections row (0008 semantics), but the mappings and
// sync cursors must SURVIVE the disconnect so a reconnect of the SAME
// Google account resumes incremental sync from the stored sync_token
// instead of re-importing and duplicating events. A FK with
// ON DELETE CASCADE would destroy exactly that resume state. The link is
// by (owner, google_account_id, google_calendar_id) text columns instead,
// and a different-account replace deletes that account's rows explicitly
// by google_account_id in a bulk owner-scoped delete.
// ---------------------------------------------------------------------------

test("migration: no FK from sync_state/mappings to google_calendar_connections", async () => {
  const n = (
    await q(
      `select count(*)::int as n from pg_constraint
        where contype = 'f'
          and conrelid in (
            'public.google_calendar_sync_state'::regclass,
            'public.google_event_mappings'::regclass
          )
          and confrelid = 'public.google_calendar_connections'::regclass`
    )
  ).rows[0].n;
  assert.equal(
    n,
    0,
    "no foreign key may link the sync tables to google_calendar_connections"
  );
});

test("migration: deleting the connection does NOT delete mappings or sync cursors", async () => {
  await asUser(A);
  const conn = (
    await q(
      `insert into google_calendar_connections(owner, google_account_id)
       values ('${A}', 'acct-disc') returning id`
    )
  ).rows[0];
  const sId = await insertSyncState(A, "acct-disc", "cal-disc", "tok-resume");
  const mId = await insertMapping(A, "acct-disc", "cal-disc", {
    google_event_id: "gev-disc",
  });

  // Disconnect: the connections row is deleted.
  await q(`delete from google_calendar_connections where id = '${conn.id}'`);

  // The sync state and mapping survive the disconnect so a reconnect of
  // the same account resumes instead of re-importing duplicates.
  assert.equal(
    await countRows("google_calendar_sync_state", "id = $1", [sId]),
    1,
    "sync_state must survive the connection delete"
  );
  const kept = (
    await q(`select sync_token from google_calendar_sync_state where id = '${sId}'`)
  ).rows[0];
  assert.equal(
    kept.sync_token,
    "tok-resume",
    "the stored sync_token must be preserved for resume"
  );
  assert.equal(
    await countRows("google_event_mappings", "id = $1", [mId]),
    1,
    "mappings must survive the connection delete"
  );

  // A different-account replace deletes the OLD account's rows explicitly
  // by google_account_id (bulk owner-scoped delete — application code).
  await q(
    `delete from google_event_mappings
      where owner = '${A}' and google_account_id = 'acct-disc'`
  );
  await q(
    `delete from google_calendar_sync_state
      where owner = '${A}' and google_account_id = 'acct-disc'`
  );
  assert.equal(
    await countRows("google_calendar_sync_state", "id = $1", [sId]),
    0,
    "explicit account-scoped delete removes the old sync_state"
  );
  assert.equal(
    await countRows("google_event_mappings", "id = $1", [mId]),
    0,
    "explicit account-scoped delete removes the old mappings"
  );
});

test("migration: the (owner, google_calendar_id) index exists on both tables", async () => {
  for (const idx of [
    "google_calendar_sync_state_owner_calendar_idx",
    "google_event_mappings_owner_calendar_idx",
  ]) {
    const n = (
      await q(
        `select count(*)::int as n from pg_indexes
          where schemaname = 'public' and indexname = $1`,
        [idx]
      )
    ).rows[0].n;
    assert.equal(n, 1, `${idx} must exist`);
  }
});

test("migration: updated_at trigger exists on both tables", async () => {
  for (const tg of [
    "google_calendar_sync_state_updated_at",
    "google_event_mappings_updated_at",
  ]) {
    const n = (
      await q(`select count(*)::int as n from pg_trigger where tgname = $1`, [tg])
    ).rows[0].n;
    assert.equal(n, 1, `trigger ${tg} must exist`);
  }
});
