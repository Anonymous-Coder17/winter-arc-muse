// Unit tests for lib/analytics.ts (V3 analytics library).
// Run with: TZ='Asia/Kolkata' node --test --import ./tests/hooks.mjs tests/analytics.test.mjs
// TZ is forced to Asia/Kolkata because utcToDayKey attribution is asserted
// against IST local days (a 01:30 IST incident must land on the IST day).
import { test } from "node:test";
import assert from "node:assert/strict";

import { formatShort } from "../lib/dates.ts";
import {
  abstinenceStats,
  daysInRange,
  exerciseProgression,
  firstFinalAvg,
  habitConsistency,
  heatmapDays,
  hifzSeries,
  hifzTotals,
  limitCompliance,
  plannedVsActual,
  readingByBook,
  readingSeries,
  readingTotals,
  studyBySubject,
  studyByTopic,
  studyTotals,
  studyTrend,
  trainingStats,
} from "../lib/analytics.ts";

function log(overrides) {
  return {
    id: "l",
    owner: "u",
    habit_id: "h",
    log_date: "2026-10-01",
    status: "done",
    value: null,
    note: null,
    ...overrides,
  };
}

test("daysInRange is inclusive and empty when start > end", () => {
  assert.deepEqual(daysInRange({ start: "2026-10-01", end: "2026-10-03" }), [
    "2026-10-01",
    "2026-10-02",
    "2026-10-03",
  ]);
  assert.deepEqual(
    daysInRange({ start: "2026-10-03", end: "2026-10-01" }),
    []
  );
  assert.deepEqual(daysInRange({ start: "2026-10-01", end: "2026-10-01" }), [
    "2026-10-01",
  ]);
});

test("habitConsistency: daily habit 8/10 done -> 80%", () => {
  const habit = {
    id: "h1",
    owner: "u",
    name: "Meditation",
    description: null,
    tracking: "completion",
    frequency: "daily",
    weekly_target: null,
    preferred_time: null,
    sort_order: 0,
    is_active: true,
    created_at: "2026-09-30T00:00:00Z", // before the range
  };
  const range = { start: "2026-10-01", end: "2026-10-10" };
  const logs = [
    ...["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04",
      "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"].map((d) =>
      log({ id: `d-${d}`, habit_id: "h1", log_date: d, status: "done" })
    ),
    log({ id: "nd9", habit_id: "h1", log_date: "2026-10-09", status: "not_done" }),
    log({ id: "nd10", habit_id: "h1", log_date: "2026-10-10", status: "not_done" }),
  ];
  const [stat] = habitConsistency([habit], logs, range);
  assert.equal(stat.activeDays, 10);
  assert.equal(stat.doneDays, 8);
  assert.equal(stat.pct, 80);
});

test("habitConsistency: habit created mid-range uses active days only", () => {
  const habit = {
    id: "h1",
    owner: "u",
    name: "Reading",
    description: null,
    tracking: "completion",
    frequency: "daily",
    weekly_target: null,
    preferred_time: null,
    sort_order: 0,
    is_active: true,
    // 10:30 IST on 2026-10-04 -> local created day 2026-10-04
    created_at: "2026-10-04T05:00:00Z",
  };
  const range = { start: "2026-10-01", end: "2026-10-10" };
  const logs = [
    // done before creation: must not count
    log({ id: "pre", habit_id: "h1", log_date: "2026-10-02", status: "done" }),
    ...["2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"].map(
      (d) => log({ id: `d-${d}`, habit_id: "h1", log_date: d, status: "done" })
    ),
    log({ id: "nd9", habit_id: "h1", log_date: "2026-10-09", status: "not_done" }),
    log({ id: "nd10", habit_id: "h1", log_date: "2026-10-10", status: "not_done" }),
  ];
  const [stat] = habitConsistency([habit], logs, range);
  assert.equal(stat.activeDays, 7); // 10-04 .. 10-10
  assert.equal(stat.doneDays, 5);
  assert.equal(stat.pct, 71); // round(5/7*100)
});

test("habitConsistency: habit with no created_at is active for the whole range", () => {
  const habit = {
    id: "h1",
    owner: "u",
    name: "Meditation",
    description: null,
    tracking: "completion",
    frequency: "daily",
    weekly_target: null,
    preferred_time: null,
    sort_order: 0,
    is_active: true,
  };
  const range = { start: "2026-10-01", end: "2026-10-03" };
  const [stat] = habitConsistency([habit], [log({ id: "a", habit_id: "h1", log_date: "2026-10-01" })], range);
  assert.equal(stat.activeDays, 3);
  assert.equal(stat.doneDays, 1);
  assert.equal(stat.pct, 33);
});

test("habitConsistency: weekly habit counts weeks meeting the target", () => {
  const habit = {
    id: "hw",
    owner: "u",
    name: "Tahajjud",
    description: null,
    tracking: "completion",
    frequency: "weekly",
    weekly_target: 2,
    preferred_time: null,
    sort_order: 0,
    is_active: true,
    created_at: "2026-09-20T00:00:00Z", // well before the range
  };
  // 2026-09-28 (Mon) .. 2026-10-11 (Sun): two full weeks
  const range = { start: "2026-09-28", end: "2026-10-11" };
  const logs = [
    log({ id: "w1a", habit_id: "hw", log_date: "2026-09-29" }),
    log({ id: "w1b", habit_id: "hw", log_date: "2026-09-30" }),
    log({ id: "w2a", habit_id: "hw", log_date: "2026-10-06" }), // only 1: misses target 2
  ];
  const [stat] = habitConsistency([habit], logs, range);
  assert.equal(stat.frequency, "weekly");
  assert.equal(stat.activeDays, 2); // two week-start Mondays in range
  assert.equal(stat.doneDays, 1);
  assert.equal(stat.pct, 50);
});

test("habitConsistency: weekly target defaults to 1", () => {
  const habit = {
    id: "hw",
    owner: "u",
    name: "Gym",
    description: null,
    tracking: "completion",
    frequency: "weekly",
    weekly_target: null,
    preferred_time: null,
    sort_order: 0,
    is_active: true,
    created_at: "2026-09-20T00:00:00Z",
  };
  const range = { start: "2026-09-28", end: "2026-10-04" }; // one Monday
  const [stat] = habitConsistency(
    [habit],
    [log({ id: "w", habit_id: "hw", log_date: "2026-10-02" })],
    range
  );
  assert.equal(stat.activeDays, 1);
  assert.equal(stat.doneDays, 1);
  assert.equal(stat.pct, 100);
});

test("habitConsistency: empty range window gives null pct", () => {
  const habit = {
    id: "h1",
    owner: "u",
    name: "Future",
    description: null,
    tracking: "completion",
    frequency: "daily",
    weekly_target: null,
    preferred_time: null,
    sort_order: 0,
    is_active: true,
    created_at: "2026-11-01T00:00:00Z", // created after the range
  };
  const [stat] = habitConsistency([habit], [], { start: "2026-10-01", end: "2026-10-10" });
  assert.equal(stat.activeDays, 0);
  assert.equal(stat.doneDays, 0);
  assert.equal(stat.pct, null);
});

test("abstinenceStats attributes incidents via utcToDayKey (01:30 IST)", () => {
  const rules = [{ id: "r1", name: "Instagram" }];
  const incidents = [
    // 2026-10-03T20:00:00Z = 2026-10-04 01:30 IST -> local day 2026-10-04
    { rule_id: "r1", occurred_at: "2026-10-03T20:00:00Z" },
    // 2026-10-05T10:00:00Z = 15:30 IST -> 2026-10-05
    { rule_id: "r1", occurred_at: "2026-10-05T10:00:00Z" },
    // outside the range: excluded from dates/incidents
    { rule_id: "r1", occurred_at: "2026-10-10T10:00:00Z" },
  ];
  const [stat] = abstinenceStats(rules, incidents, {
    start: "2026-10-01",
    end: "2026-10-07",
  });
  assert.deepEqual(stat.dates, ["2026-10-04", "2026-10-05"]);
  assert.equal(stat.incidents, 2);
  assert.equal(stat.incidentFreeDays, 5);
});

test("abstinenceStats with no incidents", () => {
  const [stat] = abstinenceStats([{ id: "r1", name: "Games" }], [], {
    start: "2026-10-01",
    end: "2026-10-03",
  });
  assert.equal(stat.incidents, 0);
  assert.equal(stat.incidentFreeDays, 3);
  assert.deepEqual(stat.dates, []);
});

test("limitCompliance: 4/5 days within -> 80%", () => {
  const limits = [
    { id: "l1", owner: "u", name: "YouTube", daily_limit_min: 45, is_active: true },
    { id: "l2", owner: "u", name: "WhatsApp", daily_limit_min: 30, is_active: true },
  ];
  const mk = (id, limit_id, log_date, minutes_used) => ({
    id, owner: "u", limit_id, log_date, minutes_used,
  });
  const logs = [
    mk("a", "l1", "2026-10-01", 30),
    mk("b", "l1", "2026-10-02", 45), // exactly at limit: within
    mk("c", "l1", "2026-10-03", 50), // over
    mk("d", "l1", "2026-10-04", 20),
    mk("e", "l1", "2026-10-05", 40),
  ];
  const range = { start: "2026-10-01", end: "2026-10-05" };
  const [yt, wa] = limitCompliance(limits, logs, range);
  assert.equal(yt.dailyLimit, 45);
  assert.equal(yt.totalUsed, 185);
  assert.equal(yt.daysWithData, 5);
  assert.equal(yt.daysWithin, 4);
  assert.equal(yt.daysOver, 1);
  assert.equal(yt.compliancePct, 80);
  assert.equal(yt.avgPerDay, 37); // round(185/5)
  // limit with no data: nulls, not zeros
  assert.equal(wa.daysWithData, 0);
  assert.equal(wa.compliancePct, null);
  assert.equal(wa.avgPerDay, null);
});

test("limitCompliance sums multiple logs on the same day", () => {
  const limits = [
    { id: "l1", owner: "u", name: "YouTube", daily_limit_min: 45, is_active: true },
  ];
  const logs = [
    { id: "a", owner: "u", limit_id: "l1", log_date: "2026-10-01", minutes_used: 30 },
    { id: "b", owner: "u", limit_id: "l1", log_date: "2026-10-01", minutes_used: 20 },
  ];
  const [stat] = limitCompliance(limits, logs, { start: "2026-10-01", end: "2026-10-02" });
  assert.equal(stat.totalUsed, 50);
  assert.equal(stat.daysWithData, 1);
  assert.equal(stat.daysOver, 1); // 30+20 = 50 > 45
  assert.equal(stat.compliancePct, 0);
});

test("trainingStats: planned vs completed, rest days never missed", () => {
  // 2026-10-05 is a Monday .. 2026-10-11 is a Sunday
  const schedule = [
    { id: "s0", owner: "u", weekday: 0, workout_id: "w1" }, // Mon planned
    { id: "s2", owner: "u", weekday: 2, workout_id: "w2" }, // Wed planned
    { id: "s4", owner: "u", weekday: 4, workout_id: null }, // Fri rest
    // other weekdays: no row -> neither planned nor rest
  ];
  const mk = (id, session_date, status) => ({
    id, owner: "u", workout_id: "w1", session_date,
    started_at: `${session_date}T06:00:00Z`, completed_at: null,
    status, notes: null,
  });
  const sessions = [
    mk("a", "2026-10-05", "completed"),
    mk("b", "2026-10-06", "completed"), // completed off-plan: still counts
    mk("c", "2026-10-07", "in_progress"), // not completed
    mk("d", "2026-10-05", "completed"),
  ];
  const [stat] = trainingStats(sessions, schedule, {
    start: "2026-10-05",
    end: "2026-10-11",
  });
  assert.equal(stat.planned, 2); // Mon + Wed only; Fri rest excluded
  assert.equal(stat.completed, 3);
  assert.equal(stat.completionPct, 150); // 3/2*100, rounded
  assert.equal(stat.restDays, 1);
});

test("trainingStats: no planned days -> null completionPct", () => {
  const [stat] = trainingStats([], [], {
    start: "2026-10-05",
    end: "2026-10-11",
  });
  assert.equal(stat.planned, 0);
  assert.equal(stat.restDays, 0);
  assert.equal(stat.completionPct, null);
});

test("exerciseProgression: first/latest/best labels", () => {
  const exercises = [
    { id: "e1", owner: "u", workout_id: "w1", name: "Push-ups", exercise_type: "reps", sort_order: 0, notes: null, is_active: true },
    { id: "e2", owner: "u", workout_id: "w1", name: "Plank", exercise_type: "time", sort_order: 1, notes: null, is_active: true },
    { id: "e3", owner: "u", workout_id: "w1", name: "HSPU", exercise_type: "reps", sort_order: 2, notes: null, is_active: true },
  ];
  const sessions = [
    { id: "s1", owner: "u", workout_id: "w1", session_date: "2026-10-05", started_at: "2026-10-05T06:00:00Z", completed_at: "2026-10-05T07:00:00Z", status: "completed", notes: null },
    { id: "s2", owner: "u", workout_id: "w1", session_date: "2026-10-08", started_at: "2026-10-08T06:00:00Z", completed_at: "2026-10-08T07:00:00Z", status: "completed", notes: null },
    { id: "s3", owner: "u", workout_id: "w1", session_date: "2026-10-09", started_at: "2026-10-09T06:00:00Z", completed_at: null, status: "in_progress", notes: null },
  ];
  const mk = (id, session_id, exercise_id, set_number, reps, duration_seconds) => ({
    id, owner: "u", session_id, exercise_id, workout_id: "w1",
    set_number, reps, duration_seconds, notes: null,
  });
  const sets = [
    mk("a", "s1", "e1", 1, 12, null),
    mk("b", "s1", "e2", 1, null, 45),
    mk("c", "s2", "e1", 1, 8, null),
    mk("d", "s2", "e1", 2, 7, null), // 8+7 = 15 on 10-08
    mk("e", "s2", "e2", 1, null, 60),
    mk("f", "s3", "e1", 1, 20, null), // in_progress session: ignored
  ];
  const range = { start: "2026-10-01", end: "2026-10-10" };
  const [pushups, plank, hspu] = exerciseProgression(exercises, sessions, sets, range);

  assert.deepEqual(pushups.points, [
    { date: "2026-10-05", value: 12, label: "12 reps" },
    { date: "2026-10-08", value: 15, label: "15 reps" },
  ]);
  assert.equal(pushups.first, "12 reps");
  assert.equal(pushups.latest, "15 reps");
  assert.equal(pushups.best, "15 reps");

  assert.deepEqual(plank.points, [
    { date: "2026-10-05", value: 45, label: "45s" },
    { date: "2026-10-08", value: 60, label: "1m" },
  ]);
  assert.equal(plank.first, "45s");
  assert.equal(plank.latest, "1m");
  assert.equal(plank.best, "1m");

  // no sets: nulls, empty points
  assert.deepEqual(hspu.points, []);
  assert.equal(hspu.first, null);
  assert.equal(hspu.latest, null);
  assert.equal(hspu.best, null);
});

test("studyTotals: 30+45+60 min -> 8100s, avg over active days", () => {
  const mk = (id, session_date, duration_seconds) => ({
    id, owner: "u", subject_id: "sub1", topic_id: null,
    session_date, started_at: `${session_date}T06:00:00Z`,
    completed_at: `${session_date}T07:00:00Z`, duration_seconds, notes: null,
  });
  const sessions = [
    mk("a", "2026-10-03", 1800), // 30m
    mk("b", "2026-10-03", 2700), // 45m
    mk("c", "2026-10-05", 3600), // 60m
  ];
  const [totals] = studyTotals(sessions, { start: "2026-10-01", end: "2026-10-07" });
  assert.equal(totals.totalSeconds, 8100); // 2h15m
  assert.equal(totals.activeDays, 2);
  assert.equal(totals.sessionCount, 3);
  assert.equal(totals.avgPerActiveDay, 4050); // 8100/2

  const [empty] = studyTotals([], { start: "2026-10-01", end: "2026-10-07" });
  assert.equal(empty.totalSeconds, 0);
  assert.equal(empty.avgPerActiveDay, null);
});

test("studyBySubject and studyByTopic", () => {
  const subjects = [
    { id: "sub1", owner: "u", name: "Mathematics", description: null, is_active: true, sort_order: 0 },
    { id: "sub2", owner: "u", name: "Physics", description: null, is_active: true, sort_order: 1 },
  ];
  const topics = [
    { id: "t1", owner: "u", subject_id: "sub1", name: "Algebra", description: null, is_active: true, sort_order: 0 },
    { id: "t2", owner: "u", subject_id: "sub2", name: "Mechanics", description: null, is_active: true, sort_order: 0 },
  ];
  const mk = (id, subject_id, topic_id, session_date, duration_seconds) => ({
    id, owner: "u", subject_id, topic_id, session_date,
    started_at: `${session_date}T06:00:00Z`, completed_at: null,
    duration_seconds, notes: null,
  });
  const sessions = [
    mk("a", "sub1", "t1", "2026-10-03", 1800),
    mk("b", "sub1", "t1", "2026-10-04", 900),
    mk("c", "sub2", "t2", "2026-10-05", 3600),
    mk("d", "sub2", null, "2026-10-06", 600), // untopiced: counts for subject only
  ];
  const range = { start: "2026-10-01", end: "2026-10-07" };

  assert.deepEqual(studyBySubject(sessions, subjects, range), [
    { subjectId: "sub1", name: "Mathematics", seconds: 2700 },
    { subjectId: "sub2", name: "Physics", seconds: 4200 },
  ]);
  assert.deepEqual(studyByTopic(sessions, topics, "sub1", range), [
    { topicId: "t1", name: "Algebra", seconds: 2700 },
  ]);
  assert.deepEqual(studyByTopic(sessions, topics, "sub2", range), [
    { topicId: "t2", name: "Mechanics", seconds: 3600 },
  ]);
});

test("studyTrend: day granularity labels and week bucketing", () => {
  const mk = (id, session_date, duration_seconds) => ({
    id, owner: "u", subject_id: "sub1", topic_id: null, session_date,
    started_at: `${session_date}T06:00:00Z`, completed_at: null,
    duration_seconds, notes: null,
  });
  const sessions = [
    mk("a", "2026-10-04", 1800),
    mk("b", "2026-10-05", 3600),
    mk("c", "2026-10-06", 900),
  ];
  const range = { start: "2026-09-27", end: "2026-10-10" };

  const daily = studyTrend(sessions, range, "day");
  assert.deepEqual(daily, [
    { key: "2026-10-04", label: formatShort("2026-10-04"), seconds: 1800 },
    { key: "2026-10-05", label: formatShort("2026-10-05"), seconds: 3600 },
    { key: "2026-10-06", label: formatShort("2026-10-06"), seconds: 900 },
  ]);
  assert.equal(daily[0].label, "Oct 4");

  // 2026-10-04 is a Sunday -> week key 2026-09-28 (Monday);
  // 10-05/10-06 belong to week starting 2026-10-05
  const weekly = studyTrend(sessions, range, "week");
  assert.deepEqual(weekly, [
    { key: "2026-09-28", label: formatShort("2026-09-28"), seconds: 1800 },
    { key: "2026-10-05", label: formatShort("2026-10-05"), seconds: 4500 },
  ]);
  assert.equal(weekly[0].label, "Sep 28");
});

test("hifzSeries/hifzTotals: null value = no record, 0 = recorded zero", () => {
  const range = { start: "2026-10-01", end: "2026-10-07" };
  const logs = [
    log({ id: "a", habit_id: "hifz", log_date: "2026-10-02", value: 3 }),
    log({ id: "b", habit_id: "hifz", log_date: "2026-10-03", value: 0 }),
    log({ id: "c", habit_id: "hifz", log_date: "2026-10-04", value: null }), // no record
    log({ id: "d", habit_id: "hifz", log_date: "2026-10-05", value: 10 }),
    log({ id: "e", habit_id: "hifz", log_date: "2026-10-06", value: 2 }),
    log({ id: "f", habit_id: "other", log_date: "2026-10-06", value: 99 }), // other habit ignored
  ];
  const points = hifzSeries(logs, "hifz", range);
  assert.deepEqual(points.map((p) => p.value), [null, 3, 0, null, 10, 2, null]);

  const totals = hifzTotals(points);
  assert.equal(totals.total, 15);
  assert.equal(totals.recordedDays, 4);
  assert.equal(totals.zeroDays, 1);
  assert.equal(totals.avgPerRecordedDay, 4); // round(15/4)

  // null habit id -> every day is "no record"
  assert.ok(hifzSeries(logs, null, range).every((p) => p.value === null));

  const empty = hifzTotals(hifzSeries([], "hifz", range));
  assert.equal(empty.avgPerRecordedDay, null);
});

test("readingSeries/readingTotals/readingByBook", () => {
  const range = { start: "2026-10-01", end: "2026-10-07" };
  const logs = [
    { log_date: "2026-10-02", pages: 5, book_id: "b1" },
    { log_date: "2026-10-03", pages: 10, book_id: null },
    { log_date: "2026-10-05", pages: 20, book_id: "b1" },
  ];
  const points = readingSeries(logs, range);
  assert.deepEqual(points.map((p) => p.value), [null, 5, 10, null, 20, null, null]);

  const totals = readingTotals(points);
  assert.equal(totals.total, 35);
  assert.equal(totals.recordedDays, 3);
  assert.equal(totals.avgPerRecordedDay, 12); // round(35/3)

  const byBook = readingByBook(logs, [
    { id: "b1", name: "Deep Work" },
    { id: "b2", name: "Atomic Habits" },
  ]);
  assert.deepEqual(byBook, [
    { bookId: "b1", name: "Deep Work", pages: 25 },
    { bookId: "b2", name: "Atomic Habits", pages: 0 },
    { bookId: null, name: "No book", pages: 10 },
  ]);
});

test("heatmapDays: levels 0-3 and signal names", () => {
  const days = heatmapDays({
    range: { start: "2026-10-01", end: "2026-10-03" },
    habitDoneDates: ["2026-10-01", "2026-10-01"], // dupes collapse
    studyDates: ["2026-10-01", "2026-10-02"],
    workoutDates: ["2026-10-01"],
    hifzDates: ["2026-10-01"],
    readingDates: ["2026-10-02"],
    journalDates: ["2026-10-03"],
  });
  assert.deepEqual(days, [
    { date: "2026-10-01", level: 3, signals: ["habits", "study", "workouts", "hifz"] },
    { date: "2026-10-02", level: 2, signals: ["study", "reading"] },
    { date: "2026-10-03", level: 1, signals: ["journal"] },
  ]);

  // a day with no signals at all
  const [lone] = heatmapDays({
    range: { start: "2026-10-04", end: "2026-10-04" },
    habitDoneDates: [],
    studyDates: [],
    workoutDates: [],
    hifzDates: [],
    readingDates: [],
    journalDates: [],
  });
  assert.equal(lone.level, 0);
  assert.deepEqual(lone.signals, []);
});

test("plannedVsActual separates plans from reality", () => {
  const mkTask = (id, task_date, kind, state) => ({
    id, owner: "u", title: "t", task_date,
    start_time: null, end_time: null, kind, state, notes: null,
  });
  const tasks = [
    mkTask("t1", "2026-10-02", "study", "done"),
    mkTask("t2", "2026-10-03", "study", "planned"),
    mkTask("t3", "2026-10-04", "workout", "done"),
    mkTask("t4", "2026-10-05", "general", "not_done"),
    mkTask("t5", "2026-10-06", "workout", "planned"),
    mkTask("t6", "2026-10-08", "study", "done"), // out of range
  ];
  const mkStudy = (id, session_date) => ({
    id, owner: "u", subject_id: "s", topic_id: null, session_date,
    started_at: `${session_date}T06:00:00Z`, completed_at: null,
    duration_seconds: 900, notes: null,
  });
  const studySessions = [
    mkStudy("ss1", "2026-10-02"),
    mkStudy("ss2", "2026-10-05"),
    mkStudy("ss3", "2026-10-09"), // out of range
  ];
  const mkWorkout = (id, session_date, status) => ({
    id, owner: "u", workout_id: "w1", session_date,
    started_at: `${session_date}T06:00:00Z`, completed_at: null,
    status, notes: null,
  });
  const workoutSessions = [
    mkWorkout("ws1", "2026-10-04", "completed"),
    mkWorkout("ws2", "2026-10-06", "in_progress"),
    mkWorkout("ws3", "2026-10-09", "completed"), // out of range
  ];
  const range = { start: "2026-10-01", end: "2026-10-07" };
  const [pa] = plannedVsActual(tasks, studySessions, workoutSessions, range);
  assert.deepEqual(pa, {
    tasksPlanned: 5,
    tasksDone: 2,
    studyPlanned: 2,
    studyActual: 2,
    workoutsPlanned: 2,
    workoutsActual: 1,
  });
});

test("firstFinalAvg: no zero-filling; null when a window is empty", () => {
  const range = { start: "2026-10-01", end: "2026-10-30" };
  const points = [
    { date: "2026-10-02", value: 4 },
    { date: "2026-10-05", value: 8 },
    { date: "2026-10-28", value: 10 },
    { date: "2026-10-30", value: 20 },
  ];
  // first window 10-01..10-07: (4+8)/2 = 6, not (4+8)/7
  // final window 10-24..10-30: (10+20)/2 = 15
  assert.deepEqual(firstFinalAvg(points, range), { first: 6, final: 15 });

  // empty final window -> null, not 0
  assert.deepEqual(
    firstFinalAvg(
      [
        { date: "2026-10-02", value: 4 },
        { date: "2026-10-05", value: 8 },
      ],
      range
    ),
    { first: 6, final: null }
  );

  // both windows empty
  assert.deepEqual(firstFinalAvg([], range), { first: null, final: null });
});

test("firstFinalAvg windows clamp to short ranges", () => {
  const range = { start: "2026-10-01", end: "2026-10-05" };
  // both 7-day windows cover the whole 5-day range: (3+9)/2 = 6 either way
  assert.deepEqual(
    firstFinalAvg(
      [
        { date: "2026-10-01", value: 3 },
        { date: "2026-10-05", value: 9 },
      ],
      range
    ),
    { first: 6, final: 6 }
  );
});

// ---------------------------------------------------------------------------
// V3.1: weekly-review and 30-day-comparison integration math
// (the WeeklySummary / ChallengeComparison components feed these exact
// engine functions — the numbers below are what the review UI displays)
// ---------------------------------------------------------------------------

function habitFixture(id, name, created_at) {
  return {
    id, owner: "u", name, description: null, tracking: "completion",
    frequency: "daily", weekly_target: null, preferred_time: null,
    sort_order: 0, is_active: true, created_at,
  };
}

test("V3.1 weekly review: deterministic week computes every summary metric", () => {
  // Week Mon 2026-09-28 .. Sun 2026-10-04.
  const week = { start: "2026-09-28", end: "2026-10-04" };

  // Habits: Meditation 7 active days / 5 done; Exercise (created Fri) 3/3.
  const habits = [
    habitFixture("h1", "Meditation", "2026-09-01T00:00:00Z"),
    habitFixture("h2", "Exercise", "2026-10-02T00:00:00Z"),
  ];
  const habitLogs = [
    ...["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"].map(
      (d) => log({ habit_id: "h1", log_date: d })
    ),
    ...["2026-10-02", "2026-10-03", "2026-10-04"].map((d) =>
      log({ habit_id: "h2", log_date: d })
    ),
  ];
  const stats = habitConsistency(habits, habitLogs, week);
  const doneDays = stats.reduce((a, s) => a + s.doneDays, 0);
  const activeDays = stats.reduce((a, s) => a + s.activeDays, 0);
  assert.equal(activeDays, 10);
  assert.equal(doneDays, 8);
  assert.equal(Math.round((doneDays / activeDays) * 100), 80);

  // Training: 2 planned (Mon/Wed), 2 completed.
  const schedule = [
    { id: "s0", owner: "u", weekday: 0, workout_id: "w1" },
    { id: "s2", owner: "u", weekday: 2, workout_id: "w1" },
    { id: "s4", owner: "u", weekday: 4, workout_id: null },
  ];
  const sessions = [
    { id: "a", owner: "u", workout_id: "w1", session_date: "2026-09-28", status: "completed" },
    { id: "b", owner: "u", workout_id: "w1", session_date: "2026-09-30", status: "completed" },
  ];
  const [t] = trainingStats(sessions, schedule, week);
  assert.equal(t.planned, 2);
  assert.equal(t.completed, 2);

  // Study: 1h + 1.5h + 0.5h = 3h total.
  const studySessions = [
    { id: "s1", owner: "u", session_date: "2026-10-01", duration_seconds: 3600 },
    { id: "s2", owner: "u", session_date: "2026-10-03", duration_seconds: 5400 },
    { id: "s3", owner: "u", session_date: "2026-10-04", duration_seconds: 1800 },
  ];
  const [st] = studyTotals(studySessions, week);
  assert.equal(st.totalSeconds, 10800);

  // Hifz: 3 + 0 + 10 + 2 = 15 ayahs; 0 is a recorded zero, not missing data.
  const hifzLogs = [
    log({ habit_id: "hifz1", log_date: "2026-09-29", value: 3 }),
    log({ habit_id: "hifz1", log_date: "2026-09-30", value: 0 }),
    log({ habit_id: "hifz1", log_date: "2026-10-02", value: 10 }),
    log({ habit_id: "hifz1", log_date: "2026-10-04", value: 2 }),
  ];
  const ht = hifzTotals(hifzSeries(hifzLogs, "hifz1", week));
  assert.equal(ht.total, 15);
  assert.equal(ht.recordedDays, 4);
  assert.equal(ht.zeroDays, 1);

  // Reading: 5 + 10 + 20 = 35 pages.
  const readingLogs = [
    { log_date: "2026-09-29", pages: 5, book_id: null },
    { log_date: "2026-10-01", pages: 10, book_id: null },
    { log_date: "2026-10-03", pages: 20, book_id: null },
  ];
  const rt = readingTotals(readingSeries(readingLogs, week));
  assert.equal(rt.total, 35);
  assert.equal(rt.recordedDays, 3);

  // Abstinence: exactly 1 incident in the week.
  const [ig] = abstinenceStats(
    [{ id: "r1", name: "Instagram" }],
    [{ rule_id: "r1", occurred_at: "2026-10-02T10:00:00+05:30" }],
    week
  );
  assert.equal(ig.incidents, 1);

  // Limits: 4 of 5 logged days within limit -> 80% compliance.
  const [yt] = limitCompliance(
    [{ id: "l1", owner: "u", name: "YouTube", daily_limit_min: 45, is_active: true }],
    [
      { id: "a", owner: "u", limit_id: "l1", log_date: "2026-09-28", minutes_used: 30 },
      { id: "b", owner: "u", limit_id: "l1", log_date: "2026-09-29", minutes_used: 40 },
      { id: "c", owner: "u", limit_id: "l1", log_date: "2026-09-30", minutes_used: 20 },
      { id: "d", owner: "u", limit_id: "l1", log_date: "2026-10-01", minutes_used: 45 },
      { id: "e", owner: "u", limit_id: "l1", log_date: "2026-10-02", minutes_used: 60 },
    ],
    week
  );
  assert.equal(yt.daysWithin, 4);
  assert.equal(yt.daysOver, 1);
  assert.equal(yt.compliancePct, 80);
});

test("V3.1 30-day comparison: first-7 vs final-7 anchored to the challenge", () => {
  // Challenge: 2026-09-05 (Sat) .. 2026-10-04 (Sun), 30 days.
  const challenge = { start: "2026-09-05", end: "2026-10-04" };
  const d = (n) => {
    const base = new Date(Date.UTC(2026, 8, 5 + n));
    return base.toISOString().slice(0, 10);
  }; // d(0)=day 1 .. d(29)=day 30

  // Study: 1h/day first week, 2h/day final week; day 8 and day 23 are decoys.
  const studyPts = [];
  for (let i = 0; i < 7; i++) studyPts.push({ date: d(i), value: 3600 });
  for (let i = 23; i < 30; i++) studyPts.push({ date: d(i), value: 7200 });
  studyPts.push({ date: d(7), value: 99999 }); // day 8: in neither window
  studyPts.push({ date: d(22), value: 88888 }); // day 23: in neither window
  const study = firstFinalAvg(studyPts, challenge);
  assert.equal(study.first, 3600);
  assert.equal(study.final, 7200);

  // Reading: 10 pages/day first week, 20/day final; day-8 decoy excluded.
  const readPts = [];
  for (let i = 0; i < 7; i++) readPts.push({ date: d(i), value: 10 });
  for (let i = 23; i < 30; i++) readPts.push({ date: d(i), value: 20 });
  readPts.push({ date: d(7), value: 500 });
  const reading = firstFinalAvg(readPts, challenge);
  assert.equal(reading.first, 10);
  assert.equal(reading.final, 20);

  // Hifz: first week 3+0+10+2+5+0+4=24 (avg 24/7); final week 42 (avg 6).
  // Zeros are recorded data; missing days are simply absent (no zero-fill).
  const hifzLogs = [
    ...[3, 0, 10, 2, 5, 0, 4].map((value, i) =>
      log({ habit_id: "hifz1", log_date: d(i), value })
    ),
    ...[10, 10, 5, 8, 4, 3, 2].map((value, i) =>
      log({ habit_id: "hifz1", log_date: d(23 + i), value })
    ),
  ];
  const hifzPts = hifzSeries(hifzLogs, "hifz1", challenge)
    .filter((p) => p.value !== null)
    .map((p) => ({ date: p.date, value: p.value }));
  const hifz = firstFinalAvg(hifzPts, challenge);
  assert.ok(Math.abs(hifz.first - 24 / 7) < 1e-9);
  assert.ok(Math.abs(hifz.final - 6) < 1e-9);

  // Habit consistency: first window 5/7 -> 71%; final window 6/7 -> 86%.
  const habit = habitFixture("h1", "Meditation", "2026-09-01T00:00:00Z");
  const firstLogs = ["2026-09-05", "2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09"].map(
    (log_date) => log({ habit_id: "h1", log_date })
  );
  const finalLogs = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03"].map(
    (log_date) => log({ habit_id: "h1", log_date })
  );
  const [hsFirst] = habitConsistency([habit], firstLogs, {
    start: d(0),
    end: d(6),
  });
  const [hsFinal] = habitConsistency([habit], finalLogs, {
    start: d(23),
    end: d(29),
  });
  assert.equal(hsFirst.pct, 71);
  assert.equal(hsFinal.pct, 86);

  // Training: 2 completed first week, 3 completed final week.
  const schedule = [
    { id: "s0", owner: "u", weekday: 0, workout_id: "w1" },
    { id: "s2", owner: "u", weekday: 2, workout_id: "w1" },
  ];
  const mk = (id, session_date) => ({
    id, owner: "u", workout_id: "w1", session_date, status: "completed",
  });
  const [tFirst] = trainingStats(
    [mk("a", d(2)), mk("b", d(4))],
    schedule,
    { start: d(0), end: d(6) }
  );
  const [tFinal] = trainingStats(
    [mk("c", d(23)), mk("d", d(25)), mk("e", d(27))],
    schedule,
    { start: d(23), end: d(29) }
  );
  assert.equal(tFirst.completed, 2);
  assert.equal(tFinal.completed, 3);

  // A day-8 session must not leak into either training window either.
  const [tFirstLeak] = trainingStats(
    [mk("a", d(2)), mk("b", d(4)), mk("z", d(7))],
    schedule,
    { start: d(0), end: d(6) }
  );
  assert.equal(tFirstLeak.completed, 2);
});
