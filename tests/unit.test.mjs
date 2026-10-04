// Unit tests for the pure lib helpers (dates, training, study).
// Run with: npm test   (node --test --import ./tests/hooks.mjs tests/)
// The TZ for date-sensitive assertions is forced via the test script env;
// utcToDayKey is asserted under Asia/Kolkata (see package.json test script).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addDays,
  formatDuration,
  formatHMS,
  timeLabel,
  utcToDayKey,
  weekdayIndex,
  weekStartMonday,
  monthGridStart,
  toDayKey,
} from "../lib/dates.ts";
import {
  computePRs,
  exercisesFor,
  nextSetNumber,
  previousSession,
  scheduledWorkoutForDate,
  setsForExercise,
  summarizeExerciseSets,
  summarizeSession,
} from "../lib/training.ts";
import {
  sessionsInRange,
  sumDurations,
  totalsBySubject,
} from "../lib/study.ts";

// ---------------------------------------------------------------- dates ---

test("addDays: simple increment", () => {
  assert.equal(addDays("2026-10-04", 1), "2026-10-05");
  assert.equal(addDays("2026-10-04", -4), "2026-09-30");
});

test("addDays: month rollover", () => {
  assert.equal(addDays("2026-01-31", 1), "2026-02-01");
});

test("addDays: year rollover", () => {
  assert.equal(addDays("2025-12-31", 1), "2026-01-01");
});

test("weekdayIndex: Monday=0 … Sunday=6", () => {
  assert.equal(weekdayIndex("2026-10-05"), 0); // Monday
  assert.equal(weekdayIndex("2026-10-04"), 6); // Sunday
});

test("weekStartMonday: Sunday rolls back to Monday", () => {
  assert.equal(weekStartMonday("2026-10-04"), "2026-09-28");
  assert.equal(weekStartMonday("2026-10-05"), "2026-10-05");
});

test("monthGridStart: October 2026 starts Monday Sep 28", () => {
  const start = monthGridStart(2026, 9);
  assert.equal(toDayKey(start), "2026-09-28");
});

test("formatDuration: compact human durations", () => {
  assert.equal(formatDuration(45), "45s");
  assert.equal(formatDuration(90), "1m");
  assert.equal(formatDuration(3661), "1h 1m");
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(-5), "0s");
});

test("formatHMS: timer readout", () => {
  assert.equal(formatHMS(2537), "42:17");
  assert.equal(formatHMS(3753), "1:02:33");
});

test("timeLabel: 24h -> 12h", () => {
  assert.equal(timeLabel("13:30"), "1:30 pm");
  assert.equal(timeLabel("09:05"), "9:05 am");
  assert.equal(timeLabel(null), "");
});

test("utcToDayKey: attributes UTC timestamps to the local day (Asia/Kolkata)", () => {
  // 2026-10-03T20:30:00Z == 2026-10-04 02:00 IST
  assert.equal(utcToDayKey("2026-10-03T20:30:00.000Z"), "2026-10-04");
  assert.equal(utcToDayKey("2026-10-04T10:00:00.000Z"), "2026-10-04");
});

// ------------------------------------------------------------- training ---

const W = (over) => ({
  id: "w1", owner: "u1", name: "HSPU", type: "structured",
  description: null, video_ref: null, is_active: true, sort_order: 0,
  ...over,
});
const EX = (over) => ({
  id: "e1", owner: "u1", workout_id: "w1", name: "Wall HSPU",
  exercise_type: "reps", sort_order: 0, notes: null, is_active: true,
  ...over,
});
const SE = (over) => ({
  id: "s1", owner: "u1", workout_id: "w1", session_date: "2026-10-01",
  started_at: "2026-10-01T10:00:00Z", completed_at: "2026-10-01T10:30:00Z",
  status: "completed", notes: null,
  ...over,
});
const SET = (over) => ({
  id: "set1", owner: "u1", session_id: "s1", exercise_id: "e1",
  workout_id: "w1", set_number: 1, reps: 5, duration_seconds: null, notes: null,
  ...over,
});

test("scheduledWorkoutForDate: rest / unscheduled / inactive -> null", () => {
  assert.equal(scheduledWorkoutForDate([], [W()], "2026-10-05"), null);
  assert.equal(
    scheduledWorkoutForDate([{ weekday: 0, workout_id: null }], [W()], "2026-10-05"),
    null
  );
  assert.equal(
    scheduledWorkoutForDate([{ weekday: 0, workout_id: "w1" }], [W({ is_active: false })], "2026-10-05"),
    null
  );
});

test("scheduledWorkoutForDate: active workout resolves", () => {
  const w = W();
  assert.equal(
    scheduledWorkoutForDate([{ weekday: 0, workout_id: "w1" }], [w], "2026-10-05"),
    w
  );
});

test("setsForExercise: filters by session+exercise and sorts", () => {
  const sets = [
    SET({ id: "b", set_number: 2 }),
    SET({ id: "a", set_number: 1 }),
    SET({ id: "c", set_number: 1, exercise_id: "e2" }),
    SET({ id: "d", set_number: 1, session_id: "s2" }),
  ];
  const got = setsForExercise(sets, "s1", "e1").map((s) => s.id);
  assert.deepEqual(got, ["a", "b"]);
});

test("summarizeExerciseSets: reps, time, empty", () => {
  const ex = EX();
  assert.equal(
    summarizeExerciseSets(ex, [SET({ reps: 5 }), SET({ reps: 5 }), SET({ reps: 4 })]),
    "5 / 5 / 4"
  );
  const hold = EX({ exercise_type: "time" });
  assert.equal(
    summarizeExerciseSets(hold, [SET({ reps: null, duration_seconds: 18 }), SET({ reps: null, duration_seconds: 15 })]),
    "18s / 15s"
  );
  assert.equal(summarizeExerciseSets(ex, []), "—");
});

test("nextSetNumber: 1 when empty, max+1 otherwise", () => {
  assert.equal(nextSetNumber([], "s1", "e1"), 1);
  assert.equal(nextSetNumber([SET({ set_number: 1 }), SET({ set_number: 3 })], "s1", "e1"), 4);
});

test("previousSession: latest completed before date, excludes given id", () => {
  const sessions = [
    SE({ id: "old", session_date: "2026-09-28" }),
    SE({ id: "new", session_date: "2026-10-02" }),
    SE({ id: "prog", session_date: "2026-10-03", status: "in_progress" }),
  ];
  assert.equal(previousSession(sessions, "w1", "2026-10-04")?.id, "new");
  assert.equal(previousSession(sessions, "w1", "2026-10-04", "new")?.id, "old");
  assert.equal(previousSession(sessions, "w1", "2026-09-27"), undefined);
});

test("computePRs: best single and best session total, reps", () => {
  const prs = computePRs(
    [EX()],
    [SE({ id: "s1" }), SE({ id: "s2", session_date: "2026-10-02" })],
    [
      SET({ session_id: "s1", set_number: 1, reps: 5 }),
      SET({ session_id: "s1", set_number: 2, reps: 4 }),
      SET({ session_id: "s2", set_number: 1, reps: 6 }),
    ]
  );
  const pr = prs.get("e1");
  assert.equal(pr.bestSingle, 6);
  assert.equal(pr.bestTotal, 9);
  assert.equal(pr.unit, "reps");
});

test("computePRs: cancelled sessions excluded; time-based uses seconds", () => {
  const prs = computePRs(
    [EX({ id: "h", exercise_type: "time", name: "Hold" })],
    [SE({ id: "s1" }), SE({ id: "sx", status: "cancelled" })],
    [
      SET({ id: "a", exercise_id: "h", reps: null, duration_seconds: 20 }),
      SET({ id: "b", exercise_id: "h", session_id: "sx", reps: null, duration_seconds: 99 }),
    ]
  );
  const pr = prs.get("h");
  assert.equal(pr.bestSingle, 20);
  assert.equal(pr.bestTotal, 20);
  assert.equal(pr.unit, "sec");
});

test("computePRs: no sets -> nulls", () => {
  const prs = computePRs([EX()], [SE()], []);
  assert.equal(prs.get("e1").bestSingle, null);
  assert.equal(prs.get("e1").bestTotal, null);
});

test("summarizeSession: completion workout", () => {
  const w = W({ type: "completion" });
  assert.equal(summarizeSession(SE(), w, [], []), "Completed");
  assert.equal(summarizeSession(SE({ status: "in_progress" }), w, [], []), "in_progress");
});

test("exercisesFor: activeOnly filters archived exercises", () => {
  const list = [EX({ id: "a" }), EX({ id: "b", is_active: false })];
  assert.deepEqual(exercisesFor(list, "w1").map((e) => e.id), ["a", "b"]);
  assert.deepEqual(exercisesFor(list, "w1", true).map((e) => e.id), ["a"]);
});

// ---------------------------------------------------------------- study ---

const SUB = (over) => ({
  id: "sub1", owner: "u1", name: "Mathematics", description: null,
  is_active: true, sort_order: 0, ...over,
});
const SSE = (over) => ({
  id: "ss1", owner: "u1", subject_id: "sub1", topic_id: null,
  session_date: "2026-10-04", started_at: "2026-10-04T10:00:00Z",
  completed_at: "2026-10-04T10:45:00Z", duration_seconds: 2700, notes: null,
  ...over,
});

test("sumDurations: sums seconds", () => {
  assert.equal(sumDurations([SSE(), SSE({ duration_seconds: 900 })]), 3600);
  assert.equal(sumDurations([]), 0);
});

test("totalsBySubject: sorted desc, zero-second subjects dropped", () => {
  const subs = [SUB({ id: "a", name: "Math" }), SUB({ id: "b", name: "Code" }), SUB({ id: "c", name: "Idle" })];
  const sessions = [
    SSE({ subject_id: "a", duration_seconds: 100 }),
    SSE({ subject_id: "b", duration_seconds: 500 }),
    SSE({ subject_id: "a", duration_seconds: 200 }),
  ];
  const totals = totalsBySubject(sessions, subs);
  assert.deepEqual(totals.map((t) => t.subject.id), ["b", "a"]);
  assert.equal(totals[0].seconds, 500);
  assert.equal(totals[1].seconds, 300);
});

test("sessionsInRange: inclusive bounds", () => {
  const sessions = [
    SSE({ id: "x", session_date: "2026-10-01" }),
    SSE({ id: "y", session_date: "2026-10-04" }),
    SSE({ id: "z", session_date: "2026-10-10" }),
  ];
  const got = sessionsInRange(sessions, "2026-10-01", "2026-10-04").map((s) => s.id);
  assert.deepEqual(got, ["x", "y"]);
});
