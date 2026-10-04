// V4.2.2: server-side atomic increment RPC (migration 0007).
// Tests the idempotency ledger + apply_increment() against PGlite
// (real Postgres engine, in-process).
// Run with:
//   TZ='Asia/Kolkata' node --test --import ./tests/hooks.mjs tests/sync_increment_pg.test.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

/** Deterministic v4-format UUID for stable test identities. */
function uuid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

let db;
let HABIT_A; // habits row owned by A (parent for habit_logs)
let LIMIT_A; // usage_limits row owned by A (parent for limit_logs)

async function asUser(id) {
  await db.exec(`set app.user_id = '${id}'`);
}

async function q(sql, params = []) {
  return db.query(sql, params);
}

/** Call public.apply_increment and return the parsed jsonb result. */
async function apply(mid, entity, rec, field, delta, seed, createdAt = null) {
  const r = await q(
    `select apply_increment($1::uuid,$2,$3::uuid,$4,$5::numeric,$6::jsonb,$7::timestamptz) as res`,
    [mid, entity, rec, field, delta, JSON.stringify(seed), createdAt]
  );
  return r.rows[0].res;
}

/** Expect the promise to reject (constraint / RPC raise / RLS block). */
async function expectBlock(promise, label) {
  let blocked = false;
  try {
    await promise;
  } catch {
    blocked = true;
  }
  assert.ok(blocked, `expected block: ${label}`);
}

before(async () => {
  db = new PGlite();
  // --- stub the Supabase auth schema the migrations expect ---
  await db.exec(`
    create schema auth;
    create table auth.users(id uuid primary key);
    create or replace function auth.uid() returns uuid
      language sql stable as $$ select current_setting('app.user_id', true)::uuid $$;
    insert into auth.users(id) values ('${A}'::uuid), ('${B}'::uuid);
    create role app_user nosuperuser login;
    -- Supabase always has an authenticated role; migration 0007 grants to it.
    create role authenticated nosuperuser;
    grant usage on schema public, auth to app_user;
    grant execute on function auth.uid() to app_user;
  `);
  for (const f of [
    "0001_v1_schema.sql",
    "0002_v2_training_study.sql",
    "0003_v2_1_integrity.sql",
    "0004_v2_2_deletion_safety.sql",
    "0005_v3_journal_review.sql",
    "0006_v3_2_ownership.sql",
    "0007_v4_2_2_increment_ledger.sql",
  ]) {
    await db.exec(readFileSync(join(ROOT, "supabase", "migrations", f), "utf8"));
  }
  await db.exec(`grant all on all tables in schema public to app_user`);
  await db.exec(
    `grant execute on function public.apply_increment(uuid,text,uuid,text,numeric,jsonb,timestamptz) to app_user`
  );
  await db.exec(`set session authorization app_user`);
  await asUser(A);
  // --- parent rows needed by the whitelisted increment paths ---
  HABIT_A = (
    await q(`insert into habits(owner,name) values ('${A}','PG habit') returning id`)
  ).rows[0].id;
  LIMIT_A = (
    await q(
      `insert into usage_limits(owner,name,daily_limit_min) values ('${A}','PG limit',45) returning id`
    )
  ).rows[0].id;
});

// ---------------------------------------------------------------------------
// 1 — migration objects exist
// ---------------------------------------------------------------------------

test("pg: migration 0007 applies; ledger table and RPC exist", async () => {
  await asUser(A);
  const t = (
    await q(`select to_regclass('public.sync_applied_mutations') as t`)
  ).rows[0].t;
  assert.equal(t, "sync_applied_mutations");
  const fn = (
    await q(
      `select count(*)::int as n from information_schema.routines
        where routine_schema = 'public' and routine_name = 'apply_increment'`
    )
  ).rows[0].n;
  assert.equal(fn, 1);
});

// ---------------------------------------------------------------------------
// 2 — idempotent retry applies exactly once
// ---------------------------------------------------------------------------

test("pg: idempotent retry applies exactly once", async () => {
  await asUser(A);
  const mid = uuid(1);
  const rec = uuid(2);
  const seed = { habit_id: HABIT_A, log_date: "2026-10-04", status: "done" };

  const first = await apply(mid, "habit_logs", rec, "value", 5, seed);
  assert.equal(first.applied, true);
  assert.equal(first.row.id, rec);
  assert.equal(Number(first.row.value), 5);

  const second = await apply(mid, "habit_logs", rec, "value", 5, seed);
  assert.equal(second.applied, false);
  assert.equal(second.row.id, rec);
  assert.equal(Number(second.row.value), 5);

  // exactly one ledger entry, one data row, value applied once
  const ledger = (
    await q(`select count(*)::int as n from sync_applied_mutations where mutation_id = $1::uuid`, [
      mid,
    ])
  ).rows[0].n;
  assert.equal(ledger, 1);
  const rows = (
    await q(`select id, value from habit_logs where habit_id = $1 and log_date = '2026-10-04'`, [
      HABIT_A,
    ])
  ).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, rec);
  assert.equal(Number(rows[0].value), 5);
});

// ---------------------------------------------------------------------------
// 3 — concurrent equal increments from an existing row
// ---------------------------------------------------------------------------

test("pg: concurrent equal increments from existing row", async () => {
  await asUser(A);
  // seed a base row directly (simulates a pre-existing log entry)
  await q(
    `insert into habit_logs(owner,habit_id,log_date,status,value)
     values ('${A}',$1::uuid,'2026-10-05','done',20)`,
    [HABIT_A]
  );
  const seed = { habit_id: HABIT_A, log_date: "2026-10-05", status: "done" };

  const r1 = await apply(uuid(3), "habit_logs", uuid(4), "value", 5, seed);
  const r2 = await apply(uuid(5), "habit_logs", uuid(6), "value", 5, seed);
  assert.equal(r1.applied, true);
  assert.equal(r2.applied, true);

  const rows = (
    await q(`select id, value from habit_logs where habit_id = $1 and log_date = '2026-10-05'`, [
      HABIT_A,
    ])
  ).rows;
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].value), 30);
});

// ---------------------------------------------------------------------------
// 4 — concurrent different increments, both orders
// (+5/+7 on a base of 20 -> 32 regardless of call order)
// ---------------------------------------------------------------------------

test("pg: concurrent different increments, both orders", async () => {
  await asUser(A);
  const mkSeed = (d) => ({ habit_id: HABIT_A, log_date: d, status: "done" });

  // order 1: +5 then +7
  await q(
    `insert into habit_logs(owner,habit_id,log_date,status,value)
     values ('${A}',$1::uuid,'2026-10-06','done',20)`,
    [HABIT_A]
  );
  await apply(uuid(7), "habit_logs", uuid(8), "value", 5, mkSeed("2026-10-06"));
  await apply(uuid(9), "habit_logs", uuid(10), "value", 7, mkSeed("2026-10-06"));
  const v1 = (
    await q(`select value from habit_logs where habit_id = $1 and log_date = '2026-10-06'`, [
      HABIT_A,
    ])
  ).rows[0].value;
  assert.equal(Number(v1), 32);

  // order 2: +7 then +5, on a fresh natural key
  await q(
    `insert into habit_logs(owner,habit_id,log_date,status,value)
     values ('${A}',$1::uuid,'2026-10-07','done',20)`,
    [HABIT_A]
  );
  await apply(uuid(11), "habit_logs", uuid(12), "value", 7, mkSeed("2026-10-07"));
  await apply(uuid(13), "habit_logs", uuid(14), "value", 5, mkSeed("2026-10-07"));
  const v2 = (
    await q(`select value from habit_logs where habit_id = $1 and log_date = '2026-10-07'`, [
      HABIT_A,
    ])
  ).rows[0].value;
  assert.equal(Number(v2), 32);
});

// ---------------------------------------------------------------------------
// 5 — natural-key create race: first caller wins the row id, deltas sum
// ---------------------------------------------------------------------------

test("pg: natural-key create race", async () => {
  await asUser(A);
  const mkSeed = (d) => ({ habit_id: HABIT_A, log_date: d, status: "done" });

  // race 1: caller A (+5) first, then caller B (+7) with a different record id
  const midA1 = uuid(15);
  const idA1 = uuid(16);
  const midB1 = uuid(17);
  const idB1 = uuid(18);
  const a1 = await apply(midA1, "habit_logs", idA1, "value", 5, mkSeed("2026-10-08"));
  const b1 = await apply(midB1, "habit_logs", idB1, "value", 7, mkSeed("2026-10-08"));
  assert.equal(a1.applied, true);
  assert.equal(b1.applied, true);
  // second caller adopted the natural-key row instead of creating its own
  assert.equal(b1.row.id, idA1);
  assert.equal(Number(b1.row.value), 12);
  const rows1 = (
    await q(`select id, value from habit_logs where habit_id = $1 and log_date = '2026-10-08'`, [
      HABIT_A,
    ])
  ).rows;
  assert.equal(rows1.length, 1);
  assert.equal(rows1[0].id, idA1);
  assert.equal(Number(rows1[0].value), 12);

  // race 2: reversed — caller B (+7) first wins the row id
  const midB2 = uuid(19);
  const idB2 = uuid(20);
  const midA2 = uuid(21);
  const idA2 = uuid(22);
  const b2 = await apply(midB2, "habit_logs", idB2, "value", 7, mkSeed("2026-10-09"));
  const a2 = await apply(midA2, "habit_logs", idA2, "value", 5, mkSeed("2026-10-09"));
  assert.equal(b2.applied, true);
  assert.equal(a2.applied, true);
  assert.equal(a2.row.id, idB2);
  const rows2 = (
    await q(`select id, value from habit_logs where habit_id = $1 and log_date = '2026-10-09'`, [
      HABIT_A,
    ])
  ).rows;
  assert.equal(rows2.length, 1);
  assert.equal(rows2[0].id, idB2);
  assert.equal(Number(rows2[0].value), 12);

  // every independent mutation is in the ledger exactly once
  const ledger = (
    await q(
      `select count(*)::int as n from sync_applied_mutations
        where mutation_id in ($1::uuid,$2::uuid,$3::uuid,$4::uuid)`,
      [midA1, midB1, midB2, midA2]
    )
  ).rows[0].n;
  assert.equal(ledger, 4);
});

// ---------------------------------------------------------------------------
// 6 — already-applied retry after natural-key adoption returns adopted row
// ---------------------------------------------------------------------------

test("pg: already-applied retry after natural-key adoption returns the adopted row", async () => {
  await asUser(A);
  const midB1 = uuid(17); // the "loser" of race 1 above (record id uuid(18))
  const seed = { habit_id: HABIT_A, log_date: "2026-10-08", status: "done" };
  const retry = await apply(midB1, "habit_logs", uuid(18), "value", 7, seed);
  assert.equal(retry.applied, false);
  // falls back to the natural key: the winner's row (uuid(16)), untouched
  assert.equal(retry.row.id, uuid(16));
  assert.equal(Number(retry.row.value), 12);
  const v = (
    await q(`select value from habit_logs where habit_id = $1 and log_date = '2026-10-08'`, [
      HABIT_A,
    ])
  ).rows[0].value;
  assert.equal(Number(v), 12);
});

// ---------------------------------------------------------------------------
// 7 — whitelist rejects other entity/field pairs
// ---------------------------------------------------------------------------

test("pg: whitelist rejects other entities", async () => {
  await asUser(A);
  await expectBlock(
    apply(uuid(23), "tasks", uuid(24), "title", 5, { log_date: "2026-10-04" }),
    "tasks/title increment"
  );
  await expectBlock(
    apply(uuid(25), "habit_logs", uuid(26), "note", 5, {
      habit_id: HABIT_A,
      log_date: "2026-10-04",
    }),
    "habit_logs/note increment"
  );
});

// ---------------------------------------------------------------------------
// 8 — RLS isolation
// ---------------------------------------------------------------------------

test("pg: RLS isolation", async () => {
  // B sets up their own parent + increment — works normally
  await asUser(B);
  const habitB = (
    await q(`insert into habits(owner,name) values ('${B}','PG habit B') returning id`)
  ).rows[0].id;
  const midB = uuid(27);
  const recB = uuid(28);
  const seedB = { habit_id: habitB, log_date: "2026-10-12", status: "done" };
  const rb = await apply(midB, "habit_logs", recB, "value", 5, seedB);
  assert.equal(rb.applied, true);
  assert.equal(Number(rb.row.value), 5);

  // B reuses A's mutation id from test 2 with B's own seed: mutation identity
  // is (owner_id, mutation_id), so this is an INDEPENDENT identity -- applied
  // for B, never mistaken for A's already-applied mutation and never dropped.
  const reuseSeed = { habit_id: habitB, log_date: "2026-10-13", status: "done" };
  const reuseRec = uuid(29);
  const reuse = await apply(uuid(1), "habit_logs", reuseRec, "value", 5, reuseSeed);
  assert.equal(reuse.applied, true, "cross-owner same id applies independently");
  assert.equal(reuse.row.id, reuseRec);
  assert.equal(Number(reuse.row.value), 5, "B's delta applied to B's row");
  // B's retry of the same identity is exactly-once.
  const reuseRetry = await apply(uuid(1), "habit_logs", reuseRec, "value", 5, reuseSeed);
  assert.equal(reuseRetry.applied, false, "B's retry is idempotent");
  assert.equal(Number(reuseRetry.row.value), 5);
  // The ledger holds two independent identities for the one mutation id.
  // RLS hides A's row from B, so B sees only their own identity here; the
  // A-side check below confirms A's identity is intact and untouched.
  const ledgerB = (
    await q(`select owner_id from sync_applied_mutations where mutation_id = $1::uuid`, [
      uuid(1),
    ])
  ).rows.map((r) => r.owner_id);
  assert.deepEqual(ledgerB, [B]);
  await asUser(A);
  const ledgerACount = (
    await q(`select count(*)::int as n from sync_applied_mutations where mutation_id = $1::uuid`, [
      uuid(1),
    ])
  ).rows[0].n;
  assert.equal(ledgerACount, 1, "A's own identity for the mutation id is intact");
  await asUser(B);

  // B cannot see A's ledger rows at all
  const seen = await q(`select owner_id from sync_applied_mutations`);
  assert.ok(seen.rows.length > 0);
  for (const row of seen.rows) {
    assert.equal(row.owner_id, B);
  }

  // A's data is untouched by all of B's activity
  await asUser(A);
  const av = (
    await q(`select value from habit_logs where habit_id = $1 and log_date = '2026-10-04'`, [
      HABIT_A,
    ])
  ).rows[0].value;
  assert.equal(Number(av), 5);
  const ledgerA = (
    await q(`select owner_id, delta from sync_applied_mutations where mutation_id = $1::uuid`, [
      uuid(1),
    ])
  ).rows[0];
  assert.equal(ledgerA.owner_id, A);
  assert.equal(Number(ledgerA.delta), 5);
});

// ---------------------------------------------------------------------------
// 9 — reading_logs: id-identity, per-device rows, retry exactly-once
// ---------------------------------------------------------------------------

test("pg: reading_logs is id-identity, retry exactly-once", async () => {
  await asUser(A);
  const date = "2026-10-10";
  const seed = { book_id: null, log_date: date }; // no book attached

  // two devices, same day, different record ids -> two independent rows
  const d1 = await apply(uuid(30), "reading_logs", uuid(31), "pages", 5, seed);
  const d2 = await apply(uuid(32), "reading_logs", uuid(33), "pages", 7, seed);
  assert.equal(d1.applied, true);
  assert.equal(d2.applied, true);
  assert.equal(Number(d1.row.pages), 5);
  assert.equal(Number(d2.row.pages), 7);

  // retry of device 1's mutation: not re-applied, both rows untouched
  const retry = await apply(uuid(30), "reading_logs", uuid(31), "pages", 5, seed);
  assert.equal(retry.applied, false);
  assert.equal(Number(retry.row.pages), 5);
  assert.equal(retry.row.id, uuid(31));

  const rows = (
    await q(`select id, pages, book_id from reading_logs where owner = $1 and log_date = $2 order by pages`, [
      A,
      date,
    ])
  ).rows;
  assert.equal(rows.length, 2);
  assert.equal(Number(rows[0].pages), 5);
  assert.equal(Number(rows[1].pages), 7);
  assert.equal(rows[0].book_id, null);
});

// ---------------------------------------------------------------------------
// 10 — limit_logs integer handling + created_at honored
// ---------------------------------------------------------------------------

test("pg: limit_logs integer handling + created_at honored", async () => {
  await asUser(A);
  const seed = { limit_id: LIMIT_A, log_date: "2026-10-11" };
  const createdAt = "2026-10-03T10:00:00+05:30"; // 04:30Z

  const r1 = await apply(uuid(34), "limit_logs", uuid(35), "minutes_used", 45, seed, createdAt);
  assert.equal(r1.applied, true);
  assert.equal(r1.row.minutes_used, 45);
  assert.equal(
    new Date(r1.row.created_at).getTime(),
    Date.parse("2026-10-03T04:30:00.000Z")
  );

  // a second independent increment adds as an integer
  const r2 = await apply(uuid(36), "limit_logs", uuid(37), "minutes_used", 45, seed, createdAt);
  assert.equal(r2.applied, true);
  assert.equal(r2.row.minutes_used, 90);

  // DB agrees: integer column, created_at preserved on the winning row
  const row = (
    await q(`select minutes_used, created_at from limit_logs where limit_id = $1 and log_date = '2026-10-11'`, [
      LIMIT_A,
    ])
  ).rows[0];
  assert.equal(row.minutes_used, 90);
  assert.equal(new Date(row.created_at).getTime(), Date.parse("2026-10-03T04:30:00.000Z"));
});

// ---------------------------------------------------------------------------
// 11 — zero (and null) delta rejected
// ---------------------------------------------------------------------------

test("pg: zero delta rejected", async () => {
  await asUser(A);
  const seed = { habit_id: HABIT_A, log_date: "2026-10-12", status: "done" };
  await expectBlock(
    apply(uuid(38), "habit_logs", uuid(39), "value", 0, seed),
    "zero delta"
  );
  await expectBlock(
    apply(uuid(40), "habit_logs", uuid(41), "value", null, seed),
    "null delta"
  );
});
