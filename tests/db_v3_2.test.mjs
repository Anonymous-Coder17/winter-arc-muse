// Database tests: V3.2 cross-entity ownership integrity.
// Verifies the database itself rejects cross-owner parent references for
// challenge_reviews (owner+challenge_id) and reading_logs (owner+book_id),
// via the composite foreign keys added in 0006_v3_2_ownership.sql.
// Runs against PGlite (real Postgres engine).
// Run with: node --test tests/db_v3_2.test.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

let db;

async function asUser(id) {
  await db.exec(`set app.user_id = '${id}'`);
}

async function q(sql, params = []) {
  return db.query(sql, params);
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
    grant usage on schema public, auth to app_user;
    grant execute on function auth.uid() to app_user;
  `);
  // Load 0001-0006 in order.
  for (const f of [
    "0001_v1_schema.sql",
    "0002_v2_training_study.sql",
    "0003_v2_1_integrity.sql",
    "0004_v2_2_deletion_safety.sql",
    "0005_v3_journal_review.sql",
    "0006_v3_2_ownership.sql",
  ]) {
    await db.exec(readFileSync(join(ROOT, "supabase", "migrations", f), "utf8"));
  }
  // Table privileges for the simulated app role (RLS still enforced).
  await db.exec(`grant all on all tables in schema public to app_user`);
});

// ---------------------------------------------------------------------------
// Migration shape: old single-column FKs replaced by composite FKs
// ---------------------------------------------------------------------------

test("DB V3.2: composite ownership FKs exist, old single-column FKs are gone", async () => {
  const rows = (
    await q(`
      select conname, pg_get_constraintdef(oid) as def
      from pg_constraint
      where conrelid in ('public.challenge_reviews'::regclass, 'public.reading_logs'::regclass)
        and contype = 'f'`)
  ).rows;
  const names = rows.map((r) => r.conname);
  assert.ok(
    names.includes("challenge_reviews_challenge_owner_fkey"),
    "composite challenge_reviews FK exists"
  );
  assert.ok(
    names.includes("reading_logs_book_owner_fkey"),
    "composite reading_logs FK exists"
  );
  assert.ok(
    !names.includes("challenge_reviews_challenge_id_fkey"),
    "old single-column challenge_reviews FK removed"
  );
  assert.ok(
    !names.includes("reading_logs_book_id_fkey"),
    "old single-column reading_logs FK removed"
  );
  const cr = rows.find((r) => r.conname === "challenge_reviews_challenge_owner_fkey").def;
  assert.match(cr, /FOREIGN KEY \(challenge_id, owner\)/);
  assert.match(cr, /CASCADE/);
  const rl = rows.find((r) => r.conname === "reading_logs_book_owner_fkey").def;
  assert.match(rl, /FOREIGN KEY \(book_id, owner\)/);
  assert.match(rl, /RESTRICT/);
});

// ---------------------------------------------------------------------------
// challenge_reviews ownership (§7)
// ---------------------------------------------------------------------------

test("DB V3.2: challenge_reviews — valid same-owner insert succeeds", async () => {
  const ch = (
    await q(`insert into challenges(owner,title,start_date) values ('${A}','A Challenge','2026-10-02') returning id`)
  ).rows[0];
  const r = (
    await q(`insert into challenge_reviews(owner,challenge_id,baseline_notes) values ('${A}','${ch.id}','baseline ok') returning id`)
  ).rows[0];
  assert.ok(r.id);
});

test("DB V3.2: challenge_reviews — cross-owner insert is rejected", async () => {
  // B owns a challenge; A must not be able to attach a review to it,
  // even though A knows the challenge ID. Run as superuser so this proves
  // the *database* rejects it, not just RLS.
  await db.exec(`set session authorization postgres`);
  const chB = (
    await q(`insert into challenges(owner,title,start_date) values ('${B}','B Challenge','2026-10-02') returning id`)
  ).rows[0];
  await expectBlock(
    q(`insert into challenge_reviews(owner,challenge_id) values ('${A}','${chB.id}')`),
    "A review -> B challenge"
  );
  const n = (await q(`select count(*)::int c from challenge_reviews where owner='${A}' and challenge_id='${chB.id}'`)).rows[0];
  assert.equal(n.c, 0, "no cross-owner review row persisted");
});

test("DB V3.2: challenge_reviews — cross-owner UPDATE is rejected", async () => {
  await db.exec(`set session authorization postgres`);
  const chA = (
    await q(`insert into challenges(owner,title,start_date) values ('${A}','A Challenge 2','2026-10-02') returning id`)
  ).rows[0];
  const chB = (
    await q(`select id from challenges where owner='${B}' limit 1`)
  ).rows[0];
  const r = (
    await q(`insert into challenge_reviews(owner,challenge_id) values ('${A}','${chA.id}') returning id`)
  ).rows[0];
  await expectBlock(
    q(`update challenge_reviews set challenge_id='${chB.id}' where id='${r.id}'`),
    "review retargeted to B challenge"
  );
  const after = (await q(`select challenge_id from challenge_reviews where id='${r.id}'`)).rows[0];
  assert.equal(after.challenge_id, chA.id, "review still points at A's challenge");
});

test("DB V3.2: challenge_reviews — same-owner CRUD still works", async () => {
  await db.exec(`set session authorization postgres`);
  const ch = (
    await q(`insert into challenges(owner,title,start_date) values ('${A}','A Challenge 3','2026-10-02') returning id`)
  ).rows[0];
  const r = (
    await q(`insert into challenge_reviews(owner,challenge_id,review_what_worked) values ('${A}','${ch.id}','planning') returning id`)
  ).rows[0];
  await q(`update challenge_reviews set review_adjustment='earlier bedtime' where id='${r.id}'`);
  const got = (await q(`select review_what_worked, review_adjustment from challenge_reviews where id='${r.id}'`)).rows[0];
  assert.equal(got.review_what_worked, "planning");
  assert.equal(got.review_adjustment, "earlier bedtime");
  await q(`delete from challenge_reviews where id='${r.id}'`);
  const gone = (await q(`select count(*)::int c from challenge_reviews where id='${r.id}'`)).rows[0];
  assert.equal(gone.c, 0);
});

// ---------------------------------------------------------------------------
// reading_logs ownership (§8)
// ---------------------------------------------------------------------------

test("DB V3.2: reading_logs — valid same-owner insert succeeds", async () => {
  const b = (await q(`insert into books(owner,name) values ('${A}','A Book') returning id`)).rows[0];
  const rl = (
    await q(`insert into reading_logs(owner,book_id,log_date,pages) values ('${A}','${b.id}','2026-10-04',18) returning id`)
  ).rows[0];
  assert.ok(rl.id);
});

test("DB V3.2: reading_logs — cross-owner insert is rejected", async () => {
  await db.exec(`set session authorization postgres`);
  const bB = (await q(`insert into books(owner,name) values ('${B}','B Book') returning id`)).rows[0];
  await expectBlock(
    q(`insert into reading_logs(owner,book_id,log_date,pages) values ('${A}','${bB.id}','2026-10-04',9)`),
    "A log -> B book"
  );
  const n = (await q(`select count(*)::int c from reading_logs where owner='${A}' and book_id='${bB.id}'`)).rows[0];
  assert.equal(n.c, 0, "no cross-owner log row persisted");
});

test("DB V3.2: reading_logs — cross-owner UPDATE is rejected", async () => {
  await db.exec(`set session authorization postgres`);
  const bA = (await q(`insert into books(owner,name) values ('${A}','A Book 2') returning id`)).rows[0];
  const bB = (await q(`select id from books where owner='${B}' limit 1`)).rows[0];
  const rl = (
    await q(`insert into reading_logs(owner,book_id,log_date,pages) values ('${A}','${bA.id}','2026-10-04',12) returning id`)
  ).rows[0];
  await expectBlock(
    q(`update reading_logs set book_id='${bB.id}' where id='${rl.id}'`),
    "log retargeted to B book"
  );
  const after = (await q(`select book_id from reading_logs where id='${rl.id}'`)).rows[0];
  assert.equal(after.book_id, bA.id, "log still points at A's book");
});

test("DB V3.2: reading_logs — NULL book_id still allowed, same-owner CRUD works", async () => {
  await db.exec(`set session authorization postgres`);
  // Bookless rows (e.g. from the V3 backfill) must keep working.
  const rl = (
    await q(`insert into reading_logs(owner,log_date,pages,note) values ('${A}','2026-10-05',20,'no book') returning id`)
  ).rows[0];
  assert.ok(rl.id);
  const b = (await q(`insert into books(owner,name) values ('${A}','A Book 3') returning id`)).rows[0];
  await q(`update reading_logs set book_id='${b.id}', pages=22 where id='${rl.id}'`);
  const got = (await q(`select book_id, pages from reading_logs where id='${rl.id}'`)).rows[0];
  assert.equal(got.book_id, b.id);
  assert.equal(got.pages, 22);
  await q(`delete from reading_logs where id='${rl.id}'`);
  const gone = (await q(`select count(*)::int c from reading_logs where id='${rl.id}'`)).rows[0];
  assert.equal(gone.c, 0);
});

// ---------------------------------------------------------------------------
// RLS regression (§9): ownership FKs add guarantees, policies unchanged
// ---------------------------------------------------------------------------

test("DB V3.2 RLS: B cannot touch A's reviews/logs; A keeps own access", async () => {
  await db.exec(`set session authorization postgres`);
  const chA = (
    await q(`insert into challenges(owner,title,start_date) values ('${A}','A RLS Challenge','2026-10-02') returning id`)
  ).rows[0];
  await q(`insert into challenge_reviews(owner,challenge_id) values ('${A}','${chA.id}')`);
  const bA = (await q(`insert into books(owner,name) values ('${A}','A RLS Book') returning id`)).rows[0];
  await q(`insert into reading_logs(owner,book_id,log_date,pages) values ('${A}','${bA.id}','2026-10-04',7)`);

  await db.exec(`set session authorization app_user`);
  await asUser(B);
  // read isolation
  for (const tbl of ["challenge_reviews", "reading_logs"]) {
    const r = await q(`select count(*)::int c from ${tbl} where owner='${A}'`);
    assert.equal(r.rows[0].c, 0, `B sees A rows in ${tbl}`);
  }
  // B cannot create a review/log owned by A, nor one pointing at A's parent
  await expectBlock(q(`insert into challenge_reviews(owner,challenge_id) values ('${A}','${chA.id}')`), "B inserts A-owned review");
  await expectBlock(q(`insert into challenge_reviews(owner,challenge_id) values ('${B}','${chA.id}')`), "B review -> A challenge (composite FK)");
  await expectBlock(q(`insert into reading_logs(owner,book_id,log_date,pages) values ('${B}','${bA.id}','2026-10-04',5)`), "B log -> A book (composite FK)");
  // B cannot modify A's rows
  const u1 = await q(`update challenge_reviews set review_what_worked='x' where owner='${A}'`);
  assert.equal(u1.affectedRows ?? 0, 0);
  const d1 = await q(`delete from reading_logs where owner='${A}'`);
  assert.equal(d1.affectedRows ?? 0, 0);

  // A retains full own access through RLS
  await asUser(A);
  const seen = (await q(`select count(*)::int c from challenge_reviews where owner='${A}'`)).rows[0];
  assert.ok(seen.c >= 1, "A reads own reviews");
  const seenLogs = (await q(`select count(*)::int c from reading_logs where owner='${A}'`)).rows[0];
  assert.ok(seenLogs.c >= 1, "A reads own logs");
});
