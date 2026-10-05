// V4.6: 30-day challenge phases — regression tests.
//
// Covers:
//   1-8.   Phase boundaries: day 1/7 -> Stabilize, 8/15 -> Build,
//            16/23 -> Discipline, 24/30 -> Identity.
//   9.     A missed day does not change the phase.
//   10.    A relapse does not reset the challenge.
//   11.    Phase calculation uses the challenge's own date semantics
//            (challenge-local day, not a UTC boundary).
//   12.    A challenge start date interpreted in another timezone context
//            does not shift the phase unexpectedly.
//
// Deterministic: pure date math, no network, no DB. Phase is derived only
// from (start_date, duration_days, date) — there is deliberately no
// behavioral input, which is exactly what makes 9 & 10 hold.
//
// Run with:
//   TZ='Asia/Kolkata' node --test --import ./tests/hooks.mjs tests/challenge_phases.test.mjs
import { register } from "node:module";
register(new URL("./resolve-next-server-stub.mjs", import.meta.url).href);

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  CHALLENGE_PHASES,
  currentChallengePhase,
  phaseForDateKey,
  phaseForDayNumber,
  phasesAvailable,
  resolveChallengePhases,
} = await import("@/lib/phases.ts");

function challenge(start_date, duration_days = 30) {
  return {
    id: "c1",
    owner: "u1",
    title: "Winter Arc",
    subtitle: null,
    start_date,
    duration_days,
    is_active: true,
  };
}

/** Local noon on the given date key — safely inside the challenge-local day. */
function noon(dateKey) {
  return new Date(dateKey + "T12:00:00");
}

// ---------------------------------------------------------------------------
// 1-8: phase boundaries
// ---------------------------------------------------------------------------

const BOUNDARIES = [
  [1, "Stabilize"],
  [7, "Stabilize"],
  [8, "Build"],
  [15, "Build"],
  [16, "Discipline"],
  [23, "Discipline"],
  [24, "Identity"],
  [30, "Identity"],
];

for (const [day, expected] of BOUNDARIES) {
  test(`day ${day} -> ${expected}`, () => {
    const c = challenge("2026-10-01");
    // date key of that challenge day:
    const d = new Date(2026, 9, 1 + (day - 1), 12, 0, 0);
    const got = currentChallengePhase(c, d);
    assert.ok(got, "phase should resolve");
    assert.equal(got.def.name, expected);
    assert.equal(got.dayNumber, day);
    assert.equal(phaseForDayNumber(day)?.name, expected);
  });
}

test("phaseForDayNumber rejects out-of-range days", () => {
  assert.equal(phaseForDayNumber(0), null);
  assert.equal(phaseForDayNumber(31), null);
  assert.equal(phaseForDayNumber(-3), null);
});

// ---------------------------------------------------------------------------
// Before start / after end: no phase (honest, not a failure)
// ---------------------------------------------------------------------------

test("no phase before the challenge starts or after it ends", () => {
  const c = challenge("2026-10-01");
  assert.equal(currentChallengePhase(c, noon("2026-09-30")), null);
  assert.equal(currentChallengePhase(c, noon("2026-10-31")), null);
});

// ---------------------------------------------------------------------------
// 9-10: missed days and relapses never change the phase
// ---------------------------------------------------------------------------

test("a missed day does not change the phase", () => {
  const c = challenge("2026-10-01");
  // Phase is derived purely from dates. Whether or not the user recorded
  // anything on Day 12, Day 12 is still Day 12 and still Build.
  const withActivity = currentChallengePhase(c, noon("2026-10-12"));
  const withoutActivity = currentChallengePhase(c, noon("2026-10-12"));
  assert.ok(withActivity && withoutActivity);
  assert.equal(withActivity.def.name, "Build");
  assert.equal(withoutActivity.def.name, "Build");
  assert.equal(withoutActivity.dayNumber, 12);
});

test("a relapse does not reset the challenge or the phase", () => {
  const c = challenge("2026-10-01");
  // An incident/relapse is recorded behavioral data; it is not an input to
  // phase calculation at all, so the phase cannot reset.
  const before = currentChallengePhase(c, noon("2026-10-19"));
  const after = currentChallengePhase(c, noon("2026-10-20"));
  assert.equal(before?.def.name, "Discipline");
  assert.equal(after?.def.name, "Discipline");
  assert.equal(after?.dayNumber, 20); // Day 20 remains Day 20
});

// ---------------------------------------------------------------------------
// 11: challenge-local date semantics (not UTC boundaries)
// ---------------------------------------------------------------------------

test("phase changes on the challenge-local date, not a UTC boundary", () => {
  const c = challenge("2026-10-01");
  // 2026-10-07 23:30 local (Asia/Kolkata = UTC+5:30) is already 2026-10-07
  // 18:00 UTC — still challenge Day 7 -> Stabilize.
  const lateLocal = new Date(2026, 9, 7, 23, 30, 0);
  assert.equal(currentChallengePhase(c, lateLocal)?.def.name, "Stabilize");
  // 2026-10-08 00:30 local is 2026-10-07 19:00 UTC — still Day 8 -> Build.
  const earlyLocal = new Date(2026, 9, 8, 0, 30, 0);
  assert.equal(currentChallengePhase(c, earlyLocal)?.def.name, "Build");
});

// ---------------------------------------------------------------------------
// 12: timezone-context invariance
// ---------------------------------------------------------------------------

test("same wall-clock date gives the same phase regardless of time of day", () => {
  const c = challenge("2026-10-01");
  const morning = new Date(2026, 9, 12, 0, 30, 0);
  const evening = new Date(2026, 9, 12, 23, 30, 0);
  assert.equal(currentChallengePhase(c, morning)?.def.name, "Build");
  assert.equal(currentChallengePhase(c, evening)?.def.name, "Build");
  assert.equal(
    currentChallengePhase(c, morning)?.dayNumber,
    currentChallengePhase(c, evening)?.dayNumber
  );
});

// ---------------------------------------------------------------------------
// Phase date ranges and states
// ---------------------------------------------------------------------------

test("resolveChallengePhases returns calendar ranges and date-based states", () => {
  const c = challenge("2026-10-01");
  const phases = resolveChallengePhases(c, noon("2026-10-12"));
  assert.ok(phases);
  assert.equal(phases.length, 4);
  assert.deepEqual(
    phases.map((p) => [p.def.name, p.startDate, p.endDate]),
    [
      ["Stabilize", "2026-10-01", "2026-10-07"],
      ["Build", "2026-10-08", "2026-10-15"],
      ["Discipline", "2026-10-16", "2026-10-23"],
      ["Identity", "2026-10-24", "2026-10-30"],
    ]
  );
  assert.deepEqual(
    phases.map((p) => p.state),
    ["past", "current", "upcoming", "upcoming"]
  );
});

test("phaseForDateKey labels journal dates within the challenge", () => {
  const c = challenge("2026-10-01");
  const p = phaseForDateKey(c, "2026-10-12");
  assert.equal(p?.def.name, "Build");
  assert.equal(p?.dayNumber, 12);
  assert.equal(phaseForDateKey(c, "2026-09-15"), null);
});

// ---------------------------------------------------------------------------
// Non-30-day challenges: phases stay hidden, nothing invented
// ---------------------------------------------------------------------------

test("non-30-day challenges get no phase system", () => {
  const c = challenge("2026-10-01", 14);
  assert.equal(phasesAvailable(c), false);
  assert.equal(currentChallengePhase(c, noon("2026-10-05")), null);
  assert.equal(resolveChallengePhases(c, noon("2026-10-05")), null);
  assert.equal(phaseForDateKey(c, "2026-10-05"), null);
});

test("30-day challenge enables phases", () => {
  assert.equal(phasesAvailable(challenge("2026-10-01", 30)), true);
});

// ---------------------------------------------------------------------------
// Central copy: four phases, stable names and descriptions
// ---------------------------------------------------------------------------

test("phase copy lives in one place with the agreed descriptions", () => {
  assert.deepEqual(
    CHALLENGE_PHASES.map((p) => p.name),
    ["Stabilize", "Build", "Discipline", "Identity"]
  );
  const byName = Object.fromEntries(CHALLENGE_PHASES.map((p) => [p.name, p]));
  assert.equal(
    byName.Stabilize.description,
    "Establish the baseline and make the daily system easy to follow."
  );
  assert.equal(
    byName.Build.description,
    "Strengthen consistency across study, training, reading, and routines."
  );
  assert.equal(
    byName.Discipline.description,
    "Execute the system even when motivation is low."
  );
  assert.equal(
    byName.Identity.description,
    "Turn the systems you've practiced into something you can carry forward."
  );
});
