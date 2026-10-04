// Database tests: migration integrity, relationship guards, historical
// safety, and RLS regression for the V2.1 hardening pass.
// Runs against PGlite (real Postgres engine, in-process).
// Run with: npm test
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
  for (const f of ["0001_v1_schema.sql", "0002_v2_training_study.sql", "0003_v2_1_integrity.sql"]) {
    await db.exec(readFileSync(join(ROOT, "supabase", "migrations", f), "utf8"));
  }
  await db.exec(`grant all on all tables in schema public to app_user`);
  await db.exec(`set session authorization app_user`);
  await asUser(A);
});

// ---------------------------------------------------------------------------
// §2 — workout_set relationship integrity
// ---------------------------------------------------------------------------

test("DB: valid set (exercise matches session workout) succeeds", async () => {
  await asUser(A);
  const w = (await q(`insert into workouts(owner,name) values ('${A}','WA') returning id`)).rows[0];
  const e = (await q(`insert into workout_exercises(owner,workout_id,name) values ('${A}','${w.id}','ExA') returning id`)).rows[0];
  const s = (await q(`insert into workout_sessions(owner,workout_id,session_date) values ('${A}','${w.id}','2026-10-04') returning id`)).rows[0];
  const set = (await q(
    `insert into workout_sets(owner,session_id,exercise_id,workout_id,set_number,reps)
     values ('${A}','${s.id}','${e.id}','${w.id}',1,5) returning id`
  )).rows[0];
  assert.ok(set.id);
});

test("DB: set mixing exercise from workout B into session of workout A fails", async () => {
  await asUser(A);
  const wa = (await q(`insert into workouts(owner,name) values ('${A}','W-A2') returning id`)).rows[0];
  const wb = (await q(`insert into workouts(owner,name) values ('${A}','W-B2') returning id`)).rows[0];
  const eb = (await q(`insert into workout_exercises(owner,workout_id,name) values ('${A}','${wb.id}','ExB') returning id`)).rows[0];
  const sa = (await q(`insert into workout_sessions(owner,workout_id,session_date) values ('${A}','${wa.id}','2026-10-04') returning id`)).rows[0];
  await expectBlock(
    q(`insert into workout_sets(owner,session_id,exercise_id,workout_id,set_number,reps)
       values ('${A}','${sa.id}','${eb.id}','${wa.id}',1,5)`),
    "cross-workout set insert"
  );
});

test("DB: updating a valid set to another workout's exercise fails", async () => {
  await asUser(A);
  const wa = (await q(`insert into workouts(owner,name) values ('${A}','W-A3') returning id`)).rows[0];
  const wb = (await q(`insert into workouts(owner,name) values ('${A}','W-B3') returning id`)).rows[0];
  const ea = (await q(`insert into workout_exercises(owner,workout_id,name) values ('${A}','${wa.id}','ExA3') returning id`)).rows[0];
  const eb = (await q(`insert into workout_exercises(owner,workout_id,name) values ('${A}','${wb.id}','ExB3') returning id`)).rows[0];
  const sa = (await q(`insert into workout_sessions(owner,workout_id,session_date) values ('${A}','${wa.id}','2026-10-04') returning id`)).rows[0];
  const st = (await q(
    `insert into workout_sets(owner,session_id,exercise_id,workout_id,set_number,reps)
     values ('${A}','${sa.id}','${ea.id}','${wa.id}',1,5) returning id`
  )).rows[0];
  await expectBlock(
    q(`update workout_sets set exercise_id='${eb.id}' where id='${st.id}'`),
    "cross-workout set update"
  );
  // sanity: the row is unchanged
  const row = (await q(`select exercise_id from workout_sets where id='${st.id}'`)).rows[0];
  assert.equal(row.exercise_id, ea.id);
});

// ---------------------------------------------------------------------------
// §3 — study_session topic/subject integrity
// ---------------------------------------------------------------------------

test("DB: valid study session (topic belongs to subject) succeeds", async () => {
  await asUser(A);
  const sub = (await q(`insert into subjects(owner,name) values ('${A}','SubA') returning id`)).rows[0];
  const top = (await q(`insert into topics(owner,subject_id,name) values ('${A}','${sub.id}','TopA') returning id`)).rows[0];
  const ses = (await q(
    `insert into study_sessions(owner,subject_id,topic_id,session_date,started_at,duration_seconds)
     values ('${A}','${sub.id}','${top.id}','2026-10-04',now(),1800) returning id`
  )).rows[0];
  assert.ok(ses.id);
});

test("DB: study session with topic from another subject fails", async () => {
  await asUser(A);
  const sa = (await q(`insert into subjects(owner,name) values ('${A}','SubA2') returning id`)).rows[0];
  const sb = (await q(`insert into subjects(owner,name) values ('${A}','SubB2') returning id`)).rows[0];
  const tb = (await q(`insert into topics(owner,subject_id,name) values ('${A}','${sb.id}','TopB2') returning id`)).rows[0];
  await expectBlock(
    q(`insert into study_sessions(owner,subject_id,topic_id,session_date,started_at,duration_seconds)
       values ('${A}','${sa.id}','${tb.id}','2026-10-04',now(),1800)`),
    "cross-subject topic insert"
  );
});

test("DB: updating a session to another subject's topic fails", async () => {
  await asUser(A);
  const sa = (await q(`insert into subjects(owner,name) values ('${A}','SubA3') returning id`)).rows[0];
  const sb = (await q(`insert into subjects(owner,name) values ('${A}','SubB3') returning id`)).rows[0];
  const ta = (await q(`insert into topics(owner,subject_id,name) values ('${A}','${sa.id}','TopA3') returning id`)).rows[0];
  const tb = (await q(`insert into topics(owner,subject_id,name) values ('${A}','${sb.id}','TopB3') returning id`)).rows[0];
  const ses = (await q(
    `insert into study_sessions(owner,subject_id,topic_id,session_date,started_at,duration_seconds)
     values ('${A}','${sa.id}','${ta.id}','2026-10-04',now(),1800) returning id`
  )).rows[0];
  await expectBlock(
    q(`update study_sessions set topic_id='${tb.id}' where id='${ses.id}'`),
    "cross-subject topic update"
  );
});

test("DB: study session without topic still works (optional topic)", async () => {
  await asUser(A);
  const s = (await q(`insert into subjects(owner,name) values ('${A}','SubNoTopic') returning id`)).rows[0];
  const ses = (await q(
    `insert into study_sessions(owner,subject_id,session_date,started_at,duration_seconds)
     values ('${A}','${s.id}','2026-10-04',now(),900) returning id`
  )).rows[0];
  assert.ok(ses.id);
});

// ---------------------------------------------------------------------------
// §14 — historical safety: archiving preserves history
// ---------------------------------------------------------------------------

test("DB: archiving a workout keeps sessions and sets readable", async () => {
  await asUser(A);
  const w = (await q(`insert into workouts(owner,name) values ('${A}','W-Hist') returning id`)).rows[0];
  const e = (await q(`insert into workout_exercises(owner,workout_id,name) values ('${A}','${w.id}','ExHist') returning id`)).rows[0];
  const s = (await q(`insert into workout_sessions(owner,workout_id,session_date,status) values ('${A}','${w.id}','2026-10-03','completed') returning id`)).rows[0];
  await q(`insert into workout_sets(owner,session_id,exercise_id,workout_id,set_number,reps) values ('${A}','${s.id}','${e.id}','${w.id}',1,8)`);
  // archive the workout (the app's "deactivate" path)
  await q(`update workouts set is_active=false where id='${w.id}'`);
  const sessions = (await q(`select id from workout_sessions where id='${s.id}'`)).rows;
  assert.equal(sessions.length, 1);
  const sets = (await q(`select reps from workout_sets where session_id='${s.id}'`)).rows;
  assert.deepEqual(sets.map((r) => r.reps), [8]);
  const wrow = (await q(`select name from workouts where id='${w.id}'`)).rows[0];
  assert.equal(wrow.name, "W-Hist");
});

test("DB: archiving an exercise keeps historical session detail readable", async () => {
  await asUser(A);
  const w = (await q(`insert into workouts(owner,name) values ('${A}','W-ExHist') returning id`)).rows[0];
  const e = (await q(`insert into workout_exercises(owner,workout_id,name) values ('${A}','${w.id}','Wall HSPU') returning id`)).rows[0];
  const s = (await q(`insert into workout_sessions(owner,workout_id,session_date,status) values ('${A}','${w.id}','2026-10-02','completed') returning id`)).rows[0];
  await q(`insert into workout_sets(owner,session_id,exercise_id,workout_id,set_number,reps) values ('${A}','${s.id}','${e.id}','${w.id}',1,5)`);
  await q(`update workout_exercises set is_active=false where id='${e.id}'`);
  // historical join still resolves the exercise name — no "Unknown exercise"
  const rows = (await q(
    `select e.name, st.reps from workout_sets st
     join workout_exercises e on e.id = st.exercise_id
     where st.session_id='${s.id}'`
  )).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Wall HSPU");
  assert.equal(rows[0].reps, 5);
});

test("DB: archiving subject/topic keeps study history readable", async () => {
  await asUser(A);
  const sub = (await q(`insert into subjects(owner,name) values ('${A}','MathHist') returning id`)).rows[0];
  const top = (await q(`insert into topics(owner,subject_id,name) values ('${A}','${sub.id}','CalcHist') returning id`)).rows[0];
  const ses = (await q(
    `insert into study_sessions(owner,subject_id,topic_id,session_date,started_at,duration_seconds)
     values ('${A}','${sub.id}','${top.id}','2026-10-01',now(),3600) returning id`
  )).rows[0];
  await q(`update topics set is_active=false where id='${top.id}'`);
  await q(`update subjects set is_active=false where id='${sub.id}'`);
  const rows = (await q(
    `select s.name as subject, t.name as topic, ss.duration_seconds
     from study_sessions ss
     join subjects s on s.id = ss.subject_id
     left join topics t on t.id = ss.topic_id
     where ss.id='${ses.id}'`
  )).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subject, "MathHist");
  assert.equal(rows[0].topic, "CalcHist");
  assert.equal(rows[0].duration_seconds, 3600);
});

// ---------------------------------------------------------------------------
// §15 — RLS regression: user isolation on the new tables
// ---------------------------------------------------------------------------

test("DB RLS: A cannot read B's training/study rows", async () => {
  // seed B's rows as superuser-equivalent setup (RLS bypass via owner role switch)
  await db.exec(`set session authorization postgres`);
  const w = (await q(`insert into workouts(owner,name) values ('${B}','B-Workout') returning id`)).rows[0];
  const e = (await q(`insert into workout_exercises(owner,workout_id,name) values ('${B}','${w.id}','B-Ex') returning id`)).rows[0];
  const s = (await q(`insert into workout_sessions(owner,workout_id,session_date) values ('${B}','${w.id}','2026-10-04') returning id`)).rows[0];
  await q(`insert into workout_sets(owner,session_id,exercise_id,workout_id,set_number,reps) values ('${B}','${s.id}','${e.id}','${w.id}',1,3)`);
  const sub = (await q(`insert into subjects(owner,name) values ('${B}','B-Subject') returning id`)).rows[0];
  const top = (await q(`insert into topics(owner,subject_id,name) values ('${B}','${sub.id}','B-Topic') returning id`)).rows[0];
  await q(`insert into study_sessions(owner,subject_id,topic_id,session_date,started_at,duration_seconds) values ('${B}','${sub.id}','${top.id}','2026-10-04',now(),600)`);
  await q(`insert into training_schedule(owner,weekday,workout_id) values ('${B}',0,'${w.id}')`);
  await db.exec(`set session authorization app_user`);
  await asUser(A);
  for (const tbl of ["workouts", "workout_exercises", "workout_sessions", "workout_sets", "subjects", "topics", "study_sessions"]) {
    const r = await q(`select count(*)::int c from ${tbl} where owner='${B}'`);
    assert.equal(r.rows[0].c, 0, `A sees B rows in ${tbl}`);
  }
  const sched = await q(`select count(*)::int c from training_schedule where owner='${B}'`);
  assert.equal(sched.rows[0].c, 0, "A sees B schedule rows");
});

test("DB RLS: A cannot insert/update/delete B's training rows", async () => {
  await asUser(A);
  await expectBlock(q(`insert into workouts(owner,name) values ('${B}','Evil')`), "insert as B");
  const r1 = await q(`update workouts set name='Hacked' where owner='${B}'`);
  assert.equal(r1.affectedRows ?? 0, 0, "update B workout affected rows");
  const r2 = await q(`delete from subjects where owner='${B}'`);
  assert.equal(r2.affectedRows ?? 0, 0, "delete B subject affected rows");
  const r3 = await q(`delete from workout_sessions where owner='${B}'`);
  assert.equal(r3.affectedRows ?? 0, 0, "delete B session affected rows");
});

test("DB RLS: A can still CRUD own training/study rows", async () => {
  await asUser(A);
  const w = (await q(`insert into workouts(owner,name) values ('${A}','Own-W') returning id`)).rows[0];
  assert.ok(w.id);
  const c = await q(`select count(*)::int c from workouts where owner='${A}'`);
  assert.ok(c.rows[0].c >= 1);
  await q(`update workouts set description='hi' where id='${w.id}'`);
  const d = await q(`delete from workouts where id='${w.id}' returning id`);
  assert.equal(d.rows.length, 1);
});
