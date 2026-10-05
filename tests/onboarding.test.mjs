// V4.7 — Winter Arc onboarding & first-run experience regression tests.
//
// Covers:
//   1.  New user (no challenge) needs onboarding.
//   2.  Existing user (has challenge) bypasses onboarding.
//   3.  Existing active challenge is not overwritten by onboarding.
//   4.  Challenge creation happens exactly once (idempotent).
//   5.  Default configuration is not duplicated.
//   6.  Start date is preserved.
//   7.  30-day phase calculation begins correctly on Day 1.
//   8.  Interrupted onboarding resumes safely (config without challenge).
//   9.  Optional setup can be skipped (no book when skipped).
//   10. Final confirmation enters Day 1.
//   11. Repeated submission does not create duplicate records.
//   12. Onboarding cannot cross user ownership boundaries.
//
// Deterministic: MemoryPort + engine.testInject, no network, no browser.
// Run with:
//   TZ='Asia/Kolkata' node --test --import ./tests/hooks.mjs tests/onboarding.test.mjs
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";

let ports, engine2, write2, onboarding, phases, types;

/** Local noon on the given date key — safely inside the challenge-local day. */
function noon(dateKey) {
  return new Date(dateKey + "T12:00:00");
}

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function load() {
  if (ports) return;
  ports = await import("../lib/sync/ports.ts");
  const remote2 = await import("../lib/sync/remote.ts");
  engine2 = await import("../lib/sync/engine.ts");
  write2 = await import("../lib/sync/write.ts");
  onboarding = await import("../lib/onboarding.ts");
  phases = await import("../lib/phases.ts");
  types = await import("../lib/types.ts");
  // Prime the module graph the way the app does (seed imports engine).
  await import("../lib/seed.ts");
  void remote2;
}

function setup(userId = USER_A) {
  const port = new ports.MemoryPort();
  engine2.engine.testReset();
  // MemoryRemote is unnecessary here: all assertions are local-first.
  engine2.engine.testInject(port, null, userId);
  return { db: write2.getDb() };
}

beforeEach(async () => {
  await load();
});

async function selections(db, overrides = {}) {
  const habits = await db.list("habits", {});
  const rules = await db.list("abstinence_rules", {});
  const limits = await db.list("usage_limits", {});
  return {
    habitEnabled: Object.fromEntries(habits.map((h) => [h.id, true])),
    newHabits: [],
    ruleEnabled: Object.fromEntries(rules.map((r) => [r.id, true])),
    limitMinutes: Object.fromEntries(limits.map((l) => [l.id, l.daily_limit_min])),
    bookName: "",
    bookAuthor: "",
    bookTotalPages: "",
    ...overrides,
  };
}

// 1. New user sees onboarding.
test("new user with no challenge needs onboarding", async () => {
  setup(USER_A);
  assert.equal(await onboarding.hasCompletedOnboarding(), false);
});

// 2. Existing onboarded user bypasses onboarding.
test("user with a challenge bypasses onboarding", async () => {
  const { db } = setup(USER_A);
  await db.insert("challenges", {
    title: "Winter Arc",
    start_date: "2026-10-01",
    duration_days: 30,
    is_active: true,
  });
  assert.equal(await onboarding.hasCompletedOnboarding(), true);
});

// 3. Existing active challenge is not overwritten.
test("ensureOnboardingChallenge never overwrites an existing challenge", async () => {
  const { db } = setup(USER_A);
  const original = await db.insert("challenges", {
    title: "My Custom Arc",
    subtitle: "keep me",
    start_date: "2026-09-15",
    duration_days: 45,
    is_active: true,
  });
  const result = await onboarding.ensureOnboardingChallenge({
    startDate: "2026-10-05",
    durationDays: 30,
  });
  assert.equal(result.id, original.id);
  const after = await db.get("challenges", original.id);
  assert.equal(after.title, "My Custom Arc");
  assert.equal(after.subtitle, "keep me");
  assert.equal(after.start_date, "2026-09-15");
  assert.equal(after.duration_days, 45);
});

// 4. Challenge creation happens exactly once.
test("challenge creation is idempotent", async () => {
  const { db } = setup(USER_A);
  const first = await onboarding.ensureOnboardingChallenge({
    startDate: "2026-10-05",
    durationDays: 30,
  });
  const second = await onboarding.ensureOnboardingChallenge({
    startDate: "2026-10-06",
    durationDays: 30,
  });
  assert.equal(first.id, second.id);
  const all = await db.list("challenges", {});
  assert.equal(all.length, 1);
});

// 5. Default configuration is not duplicated.
test("default seeding does not duplicate on repeat", async () => {
  setup(USER_A);
  const first = await onboarding.getOnboardingConfig();
  const second = await onboarding.getOnboardingConfig();
  assert.equal(first.habits.length, second.habits.length);
  assert.equal(first.rules.length, second.rules.length);
  assert.equal(first.limits.length, second.limits.length);
  assert.ok(first.habits.length > 0);
  assert.deepEqual(
    first.habits.map((h) => h.id).sort(),
    second.habits.map((h) => h.id).sort()
  );
});

// 6. Start date is preserved.
test("existing challenge start date is preserved", async () => {
  const { db } = setup(USER_A);
  await db.insert("challenges", {
    title: "Winter Arc",
    start_date: "2026-09-01",
    duration_days: 30,
    is_active: true,
  });
  await onboarding.ensureOnboardingChallenge({
    startDate: "2026-10-05",
    durationDays: 30,
  });
  const challenges = await db.list("challenges", {});
  assert.equal(challenges.length, 1);
  assert.equal(challenges[0].start_date, "2026-09-01");
});

// 7. 30-day phase calculation begins correctly.
test("Day 1 of a new 30-day challenge is Stabilize", async () => {
  setup(USER_A);
  const challenge = await onboarding.ensureOnboardingChallenge({
    startDate: todayKey(),
    durationDays: 30,
  });
  const dayNumber = types.challengeDayNumber(challenge, new Date());
  assert.equal(dayNumber, 1);
  const phase = phases.currentChallengePhase(challenge, new Date());
  assert.ok(phase);
  assert.equal(phase.def.key, "stabilize");
  assert.equal(phase.dayNumber, 1);
});

// 8. Interrupted onboarding resumes safely.
test("config without challenge still needs onboarding; resume creates no duplicates", async () => {
  const { db } = setup(USER_A);
  // Simulate an interrupted onboarding: config applied, challenge never created.
  const cfg = await onboarding.getOnboardingConfig();
  const habit = cfg.habits[0];
  await onboarding.applyOnboardingConfig(
    await selections(db, {
      habitEnabled: { [habit.id]: false },
      newHabits: ["Evening walk"],
    })
  );
  // Still needs onboarding — the challenge is the completion marker.
  assert.equal(await onboarding.hasCompletedOnboarding(), false);
  // Resume: re-applying the same config must not duplicate the custom habit.
  await onboarding.applyOnboardingConfig(
    await selections(db, {
      habitEnabled: { [habit.id]: false },
      newHabits: ["Evening walk"],
    })
  );
  const habits = await db.list("habits", {});
  const walks = habits.filter((h) => h.name === "Evening walk");
  assert.equal(walks.length, 1);
  // Completing now creates exactly one challenge.
  await onboarding.ensureOnboardingChallenge({
    startDate: todayKey(),
    durationDays: 30,
  });
  assert.equal((await db.list("challenges", {})).length, 1);
  assert.equal(await onboarding.hasCompletedOnboarding(), true);
});

// 9. Optional setup can be skipped.
test("skipping the optional book creates no book", async () => {
  const { db } = setup(USER_A);
  await onboarding.getOnboardingConfig();
  await onboarding.applyOnboardingConfig(await selections(db));
  assert.equal((await db.list("books", {})).length, 0);
});

// 10. Final confirmation enters Day 1.
test("starting with today as start date lands on Day 1", async () => {
  setup(USER_A);
  const challenge = await onboarding.ensureOnboardingChallenge({
    startDate: todayKey(),
    durationDays: 30,
  });
  assert.equal(types.challengeDayNumber(challenge, noon(todayKey())), 1);
  assert.equal(types.daysRemaining(challenge, noon(todayKey())), 30);
});

// 11. Repeated submission does not create duplicate records.
test("full double submission creates no duplicates", async () => {
  const { db } = setup(USER_A);
  const cfg = await onboarding.getOnboardingConfig();
  const sel = await selections(db, {
    newHabits: ["Read 10 pages"],
    bookName: "Deep Work",
    bookAuthor: "Cal Newport",
    bookTotalPages: "304",
  });
  await onboarding.applyOnboardingConfig(sel);
  await onboarding.ensureOnboardingChallenge({
    startDate: todayKey(),
    durationDays: 30,
  });
  // Submit everything again, as a double-click / retry would.
  await onboarding.applyOnboardingConfig(sel);
  await onboarding.ensureOnboardingChallenge({
    startDate: todayKey(),
    durationDays: 30,
  });
  assert.equal((await db.list("challenges", {})).length, 1);
  assert.equal((await db.list("books", {})).length, 1);
  const habits = await db.list("habits", {});
  assert.equal(
    habits.filter((h) => h.name === "Read 10 pages").length,
    1
  );
  // Seeded defaults still exactly once each.
  assert.equal(habits.length, cfg.habits.length + 1);
});

// 12. Onboarding cannot cross user ownership boundaries.
test("onboarding writes are owned by the current user only", async () => {
  // Each user gets their own local database (per-user IndexedDB in the
  // real app); hold both ports the way the architecture does.
  const portA = new ports.MemoryPort();
  const portB = new ports.MemoryPort();

  engine2.engine.testReset();
  engine2.engine.testInject(portA, null, USER_A);
  const dbA = write2.getDb();
  await onboarding.getOnboardingConfig();
  await onboarding.applyOnboardingConfig(
    await selections(dbA, { bookName: "User A Book" })
  );
  const challengeA = await onboarding.ensureOnboardingChallenge({
    startDate: todayKey(),
    durationDays: 30,
  });
  assert.equal(challengeA.owner, USER_A);
  const booksA = await dbA.list("books", {});
  assert.equal(booksA.length, 1);
  assert.equal(booksA[0].owner, USER_A);

  // User B: a fresh user who still needs onboarding, fully independent.
  engine2.engine.testReset();
  engine2.engine.testInject(portB, null, USER_B);
  const dbB = write2.getDb();
  assert.equal(await onboarding.hasCompletedOnboarding(), false);
  const challengeB = await onboarding.ensureOnboardingChallenge({
    startDate: todayKey(),
    durationDays: 30,
  });
  assert.equal(challengeB.owner, USER_B);
  assert.notEqual(challengeB.id, challengeA.id);

  // User A's data is untouched by everything user B did.
  engine2.engine.testReset();
  engine2.engine.testInject(portA, null, USER_A);
  const challengesA = await dbA.list("challenges", {});
  assert.equal(challengesA.length, 1);
  assert.equal(challengesA[0].id, challengeA.id);
  assert.equal(await onboarding.hasCompletedOnboarding(), true);
  const booksA2 = await dbA.list("books", {});
  assert.equal(booksA2.length, 1);
  assert.equal(booksA2[0].name, "User A Book");
});
