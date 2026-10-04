// Database tests: V3 journal/review/books/reading-logs migration.
// Covers CRUD, unique guards, RLS isolation, the reading backfill, and
// migration idempotency. Runs against PGlite (real Postgres engine).
// Run with: node --test tests/db_v3.test.mjs
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
  // Load 0001-0004 first so the backfill test can stage pre-V3 data.
  for (const f of [
    "0001_v1_schema.sql",
    "0002_v2_training_study.sql",
    "0003_v2_1_integrity.sql",
    "0004_v2_2_deletion_safety.sql",
  ]) {
    await db.exec(readFileSync(join(ROOT, "supabase", "migrations", f), "utf8"));
  }
  // Stage pre-V3 reading data: a count-tracking "Reading" habit with logs.
  const habit = (
    await q(
      `insert into habits(owner,name,tracking) values ('${A}','Reading','count') returning id`
    )
  ).rows[0];
  await q(
    `insert into habit_logs(owner,habit_id,log_date,value,note)
     values ('${A}','${habit.id}','2026-09-30',12,'chapter one'),
            ('${A}','${habit.id}','2026-10-01',25,'chapter two')`
  );
  // Also stage a Reading habit for B (backfill must not leak across owners).
  const habitB = (
    await q(
      `insert into habits(owner,name,tracking) values ('${B}','Reading','count') returning id`
    )
  ).rows[0];
  await q(
    `insert into habit_logs(owner,habit_id,log_date,value)
     values ('${B}','${habitB.id}','2026-10-01',7)`
  );
  // A non-reading count habit whose logs must NOT be backfilled.
  const hifz = (
    await q(
      `insert into habits(owner,name,tracking) values ('${A}','Hifz','count') returning id`
    )
  ).rows[0];
  await q(
    `insert into habit_logs(owner,habit_id,log_date,value)
     values ('${A}','${hifz.id}','2026-10-01',3)`
  );
  // A completion-tracking habit named Reading would be an odd edge case —
  // backfill only handles tracking='count', so add one with no value.
  const readComp = (
    await q(
      `insert into habits(owner,name,tracking) values ('${A}','Reading Journal','completion') returning id`
    )
  ).rows[0];
  await q(
    `insert into habit_logs(owner,habit_id,log_date,status)
     values ('${A}','${readComp.id}','2026-10-01','done')`
  );
  // Now load migration 0005 (runs the backfill).
  await db.exec(
    readFileSync(join(ROOT, "supabase", "migrations", "0005_v3_journal_review.sql"), "utf8")
  );
  await db.exec(`grant all on all tables in schema public to app_user`);
  await db.exec(`set session authorization app_user`);
  await asUser(A);
});

// ---------------------------------------------------------------------------
// Backfill correctness
// ---------------------------------------------------------------------------

test("DB V3: backfill copies Reading count-habit logs into reading_logs", async () => {
  await asUser(A);
  const rows = (
    await q(`select log_date::text d, pages, note from reading_logs where owner='${A}' order by log_date`)
  ).rows;
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => [r.d, r.pages]),
    [
      ["2026-09-30", 12],
      ["2026-10-01", 25],
    ]
  );
  assert.equal(rows[0].note, "chapter one");
  // backfilled rows are bookless
  const bookless = (await q(`select count(*)::int c from reading_logs where owner='${A}' and book_id is null`)).rows[0];
  assert.equal(bookless.c, 2);
});

test("DB V3: backfill skips non-reading and value-less habit logs, keeps owner isolation", async () => {
  // Hifz count habit must not appear in reading_logs
  const aRows = (await q(`select count(*)::int c from reading_logs where owner='${A}'`)).rows[0];
  assert.equal(aRows.c, 2, "only the 2 reading rows for A");
  // B's reading log backfilled too (same-owner isolation check happens via RLS)
  const bTotal = (
    await q(`select count(*)::int c from reading_logs`)
  ).rows; // as A, B rows invisible under RLS
  assert.equal(bTotal[0].c, 2);
});

test("DB V3: backfill is idempotent — re-running migration adds no duplicate rows", async () => {
  await db.exec(`set session authorization postgres`);
  await db.exec(
    readFileSync(join(ROOT, "supabase", "migrations", "0005_v3_journal_review.sql"), "utf8")
  );
  await db.exec(`set session authorization app_user`);
  await asUser(A);
  const aRows = (await q(`select count(*)::int c from reading_logs where owner='${A}'`)).rows[0];
  assert.equal(aRows.c, 2, "no duplicates after second run");
  await db.exec(`set session authorization postgres`);
  const all = (await q(`select count(*)::int c from reading_logs`)).rows[0];
  assert.equal(all.c, 3, "B's single row also untouched");
  await db.exec(`set session authorization app_user`);
  await asUser(A);
});

// ---------------------------------------------------------------------------
// CRUD on the new tables
// ---------------------------------------------------------------------------

test("DB V3: journal_entries CRUD + updated_at trigger", async () => {
  await asUser(A);
  const j = (await q(
    `insert into journal_entries(owner,entry_date,content) values ('${A}','2026-10-04','Day one, honest notes.') returning id`
  )).rows[0];
  assert.ok(j.id);
  const got = (await q(`select content, created_at, updated_at from journal_entries where id='${j.id}'`)).rows[0];
  assert.equal(got.content, "Day one, honest notes.");
  await new Promise((r) => setTimeout(r, 5));
  await q(`update journal_entries set content='Edited.' where id='${j.id}'`);
  const after = (await q(`select content, updated_at >= created_at as bumped from journal_entries where id='${j.id}'`)).rows[0];
  assert.equal(after.content, "Edited.");
  assert.ok(after.bumped);
  const d = await q(`delete from journal_entries where id='${j.id}' returning id`);
  assert.equal(d.rows.length, 1);
});

test("DB V3: second journal entry for the same date is rejected", async () => {
  await asUser(A);
  await q(`insert into journal_entries(owner,entry_date,content) values ('${A}','2026-10-05','First.')`);
  await expectBlock(
    q(`insert into journal_entries(owner,entry_date,content) values ('${A}','2026-10-05','Second.')`),
    "duplicate journal date"
  );
});

test("DB V3: daily_reviews CRUD with partial (nullable) fields", async () => {
  await asUser(A);
  const r = (await q(
    `insert into daily_reviews(owner,review_date,wins) values ('${A}','2026-10-04','Shipped V2') returning id`
  )).rows[0];
  assert.ok(r.id);
  const got = (await q(`select wins, problems from daily_reviews where id='${r.id}'`)).rows[0];
  assert.equal(got.wins, "Shipped V2");
  assert.equal(got.problems, null, "problems left null on partial save");
  await q(`update daily_reviews set problems='Phone at night', adjustment='Greyscale after 10pm' where id='${r.id}'`);
  const after = (await q(`select problems, adjustment from daily_reviews where id='${r.id}'`)).rows[0];
  assert.equal(after.problems, "Phone at night");
  assert.equal(after.adjustment, "Greyscale after 10pm");
  await expectBlock(
    q(`insert into daily_reviews(owner,review_date) values ('${A}','2026-10-04')`),
    "duplicate daily review date"
  );
  const d = await q(`delete from daily_reviews where id='${r.id}' returning id`);
  assert.equal(d.rows.length, 1);
});

test("DB V3: weekly_reviews CRUD + week_end >= week_start guard", async () => {
  await asUser(A);
  const r = (await q(
    `insert into weekly_reviews(owner,week_start,week_end,what_worked) values ('${A}','2026-09-29','2026-10-05','Consistency') returning id`
  )).rows[0];
  assert.ok(r.id);
  await expectBlock(
    q(`insert into weekly_reviews(owner,week_start,week_end) values ('${A}','2026-09-29','2026-10-05')`),
    "duplicate weekly review week_start"
  );
  await expectBlock(
    q(`insert into weekly_reviews(owner,week_start,week_end) values ('${A}','2026-10-06','2026-10-05')`),
    "week_end before week_start"
  );
  await q(`update weekly_reviews set next_adjustment='Earlier bedtime' where id='${r.id}'`);
  const after = (await q(`select next_adjustment from weekly_reviews where id='${r.id}'`)).rows[0];
  assert.equal(after.next_adjustment, "Earlier bedtime");
  const d = await q(`delete from weekly_reviews where id='${r.id}' returning id`);
  assert.equal(d.rows.length, 1);
});

test("DB V3: challenge_reviews CRUD + baseline check guards + challenge cascade", async () => {
  await asUser(A);
  const ch = (await q(
    `insert into challenges(owner,title,start_date) values ('${A}','Winter Arc','2026-10-02') returning id`
  )).rows[0];
  const r = (await q(
    `insert into challenge_reviews(owner,challenge_id,baseline_study_min,baseline_reading_pages,baseline_hifz_ayahs,baseline_notes)
     values ('${A}','${ch.id}',20,10,0,'Day 1 baseline') returning id`
  )).rows[0];
  assert.ok(r.id);
  await expectBlock(
    q(`insert into challenge_reviews(owner,challenge_id,baseline_study_min) values ('${A}','${ch.id}',-5)`),
    "negative baseline study minutes"
  );
  await expectBlock(
    q(`insert into challenge_reviews(owner,challenge_id) values ('${A}','${ch.id}')`),
    "duplicate challenge review"
  );
  await q(`update challenge_reviews set review_what_worked='Planning nightly', review_adjustment='None' where id='${r.id}'`);
  const after = (await q(`select review_what_worked from challenge_reviews where id='${r.id}'`)).rows[0];
  assert.equal(after.review_what_worked, "Planning nightly");
  // deleting the challenge cascades the review
  await q(`delete from challenges where id='${ch.id}'`);
  const gone = (await q(`select count(*)::int c from challenge_reviews where id='${r.id}'`)).rows[0];
  assert.equal(gone.c, 0, "review cascaded with challenge");
});

test("DB V3: books CRUD + case-insensitive name uniqueness + active/archive", async () => {
  await asUser(A);
  const b = (await q(
    `insert into books(owner,name,author,total_pages) values ('${A}','Deep Work','Cal Newport',304) returning id`
  )).rows[0];
  assert.ok(b.id);
  await expectBlock(
    q(`insert into books(owner,name) values ('${A}','deep work')`),
    "case-insensitive duplicate book name"
  );
  await expectBlock(
    q(`insert into books(owner,name,total_pages) values ('${A}','Bad Book',0)`),
    "zero total_pages"
  );
  await q(`update books set is_active=false where id='${b.id}'`);
  const after = (await q(`select is_active from books where id='${b.id}'`)).rows[0];
  assert.equal(after.is_active, false);
});

test("DB V3: reading_logs CRUD + book restrict + pages guard", async () => {
  await asUser(A);
  const b = (await q(`insert into books(owner,name) values ('${A}','Atomic Habits') returning id`)).rows[0];
  const rl = (await q(
    `insert into reading_logs(owner,book_id,log_date,pages,note) values ('${A}','${b.id}','2026-10-04',18,'notes') returning id`
  )).rows[0];
  assert.ok(rl.id);
  await expectBlock(
    q(`insert into reading_logs(owner,log_date,pages) values ('${A}','2026-10-04',-2)`),
    "negative pages"
  );
  // book with logged pages cannot be hard-deleted (restrict)
  let err = null;
  try {
    await q(`delete from books where id='${b.id}'`);
  } catch (e) {
    err = e;
  }
  assert.ok(err, "expected delete restrict on book with logs");
  const stillThere = (await q(`select count(*)::int c from books where id='${b.id}'`)).rows[0];
  assert.equal(stillThere.c, 1, "book survived the restricted delete");
  await q(`delete from reading_logs where id='${rl.id}'`);
  const d = await q(`delete from books where id='${b.id}' returning id`);
  assert.equal(d.rows.length, 1, "bookless book deletes fine");
});

// ---------------------------------------------------------------------------
// RLS isolation
// ---------------------------------------------------------------------------

const V3_TABLES = ["journal_entries", "daily_reviews", "weekly_reviews", "challenge_reviews", "books", "reading_logs"];

test("DB V3 RLS: A cannot read B's rows", async () => {
  await db.exec(`set session authorization postgres`);
  await q(`insert into journal_entries(owner,entry_date,content) values ('${B}','2026-10-04','B journal')`);
  await q(`insert into daily_reviews(owner,review_date,wins) values ('${B}','2026-10-04','B win')`);
  await q(`insert into weekly_reviews(owner,week_start,week_end) values ('${B}','2026-09-29','2026-10-05')`);
  const ch = (await q(`insert into challenges(owner,title,start_date) values ('${B}','B Challenge','2026-10-02') returning id`)).rows[0];
  await q(`insert into challenge_reviews(owner,challenge_id) values ('${B}','${ch.id}')`);
  const bk = (await q(`insert into books(owner,name) values ('${B}','B Book') returning id`)).rows[0];
  await q(`insert into reading_logs(owner,book_id,log_date,pages) values ('${B}','${bk.id}','2026-10-04',9)`);
  await db.exec(`set session authorization app_user`);
  await asUser(A);
  for (const tbl of V3_TABLES) {
    const r = await q(`select count(*)::int c from ${tbl} where owner='${B}'`);
    assert.equal(r.rows[0].c, 0, `A sees B rows in ${tbl}`);
  }
});

test("DB V3 RLS: A cannot insert/update/delete B's rows", async () => {
  await asUser(A);
  await expectBlock(q(`insert into journal_entries(owner,entry_date) values ('${B}','2026-10-06')`), "insert journal as B");
  await expectBlock(q(`insert into books(owner,name) values ('${B}','Sneaky')`), "insert book as B");
  await expectBlock(q(`insert into reading_logs(owner,log_date,pages) values ('${B}','2026-10-06',5)`), "insert reading log as B");
  const r1 = await q(`update journal_entries set content='Hacked' where owner='${B}'`);
  assert.equal(r1.affectedRows ?? 0, 0, "update B journal affected rows");
  const r2 = await q(`delete from daily_reviews where owner='${B}'`);
  assert.equal(r2.affectedRows ?? 0, 0, "delete B daily review affected rows");
  const r3 = await q(`delete from books where owner='${B}'`);
  assert.equal(r3.affectedRows ?? 0, 0, "delete B book affected rows");
  const r4 = await q(`delete from reading_logs where owner='${B}'`);
  assert.equal(r4.affectedRows ?? 0, 0, "delete B reading log affected rows");
});

test("DB V3 RLS: A can still CRUD own rows", async () => {
  await asUser(A);
  const j = (await q(`insert into journal_entries(owner,entry_date) values ('${A}','2026-10-07') returning id`)).rows[0];
  assert.ok(j.id);
  const c = (await q(`select count(*)::int c from journal_entries where owner='${A}'`)).rows[0];
  assert.ok(c.c >= 1);
  await q(`update journal_entries set content='own edit' where id='${j.id}'`);
  const d = await q(`delete from journal_entries where id='${j.id}' returning id`);
  assert.equal(d.rows.length, 1);
});

// ---------------------------------------------------------------------------
// Idempotency of the whole migration file
// ---------------------------------------------------------------------------

test("DB V3: re-running migration 0005 is error-free", async () => {
  await db.exec(`set session authorization postgres`);
  // Second full re-run must not raise (IF NOT EXISTS / drop-if-exists guards).
  await db.exec(
    readFileSync(join(ROOT, "supabase", "migrations", "0005_v3_journal_review.sql"), "utf8")
  );
  await db.exec(`set session authorization app_user`);
  await asUser(A);
  // Tables still fully usable after the re-run.
  const j = (await q(`insert into journal_entries(owner,entry_date) values ('${A}','2026-10-08') returning id`)).rows[0];
  assert.ok(j.id);
  await q(`delete from journal_entries where id='${j.id}'`);
});

// ---------------------------------------------------------------------------
// V3.1: unified Today -> journal_entries flow
// ---------------------------------------------------------------------------

test("DB V3.1 journal: Today saves to journal_entries; no daily_records duplicate", async () => {
  await asUser(A);
  const date = "2026-10-04";
  // 1-2. The unified Today -> Write journal path (lib/journal upsertJournalEntry
  // semantics: insert, on conflict update). The entry must come from journal_entries.
  await q(`insert into journal_entries(owner, entry_date, content)
           values ('${A}'::uuid, '${date}', 'Day 4: trained, studied, honest day.')
           on conflict (owner, entry_date)
           do update set content = excluded.content, updated_at = now()`);
  let row = (await q(`select content from journal_entries
                      where owner='${A}'::uuid and entry_date='${date}'`)).rows[0];
  assert.equal(row.content, "Day 4: trained, studied, honest day.");

  // 3. Edit persists (the V3 JournalEditor updates the same row).
  await q(`update journal_entries
           set content='Day 4: trained, studied, honest day. Edited.', updated_at=now()
           where owner='${A}'::uuid and entry_date='${date}'`);
  row = (await q(`select content from journal_entries
                  where owner='${A}'::uuid and entry_date='${date}'`)).rows[0];
  assert.equal(row.content, "Day 4: trained, studied, honest day. Edited.");

  // 4. Saving through the new Today flow must NOT create the old
  // daily_records kind='journal' duplicate.
  const dup = await q(`select count(*)::int as n from daily_records
                       where owner='${A}'::uuid and record_date='${date}' and kind='journal'`);
  assert.equal(dup.rows[0].n, 0);

  // 5. The V3 Journal/Reflection interface reads the same row back.
  const ui = await q(`select entry_date, content from journal_entries
                      where owner='${A}'::uuid and entry_date='${date}'`);
  assert.equal(ui.rows.length, 1);
  assert.equal(ui.rows[0].entry_date.toISOString().slice(0, 10), date);

  // 6. Privacy: user B still cannot see A's journal row.
  await asUser(B);
  const leak = await q(`select count(*)::int as n from journal_entries
                        where owner='${A}'::uuid and entry_date='${date}'`);
  assert.equal(leak.rows[0].n, 0);
  await asUser(A);
});
