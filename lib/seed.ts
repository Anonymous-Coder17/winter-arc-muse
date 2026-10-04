import { getDb } from "./sync/write";
import { engine } from "./sync/engine";
import { todayKey } from "./dates";

/**
 * Deterministic id: same owner + kind + name → same UUID on every
 * device. Two devices seeding the same defaults before first sync therefore
 * create the SAME rows (idempotent across devices), so the sync engine's
 * insert-then-exists check converges instead of hitting unique/FK conflicts.
 * (cyrb53-based 128-bit construction; UUID-shaped, not RFC v5.)
 */
export function seedId(owner: string, kind: string, name: string): string {
  const h = (str: string): string => {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
  };
  const hex = (h(`${owner}|${kind}|${name}|0`) + h(`${owner}|${kind}|${name}|1`)).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function seedOwner(): string {
  const id = engine.getSnapshot().userId;
  if (!id) throw new Error("Not signed in.");
  return id;
}

// Default seed rows for a brand-new user. Called once, lazily, when the user
// has no habits/rules/limits yet. NEVER includes the five daily prayers.
// Tahajjud is seeded as an OPTIONAL weekly habit (2x/week), editable/removable.
//
// Local-first: counts are checked against the local store, and defaults are
// written with drop-on-conflict tolerance so seed races across devices
// converge instead of failing.
const DROP_ON_CONFLICT = { tolerance: "drop-on-conflict" as const };

/** Seed row type: the local store always assigns an id on write. */
type SeedRow = Record<string, unknown> & { id?: string };

export async function seedDefaultsIfEmpty(): Promise<void> {
  const db = getDb();
  const owner = seedOwner();
  const today = todayKey(); // local date — never UTC-sliced

  if ((await db.count("habits")) === 0) {
    await db.upsert(
      "habits",
      {
        id: seedId(owner, "habit", "Meditation"),
        name: "Meditation",
        description: "Daily stillness practice.",
        tracking: "completion",
        frequency: "daily",
        sort_order: 1,
        is_active: true,
      },
      undefined,
      DROP_ON_CONFLICT
    );
    await db.upsert(
      "habits",
      {
        id: seedId(owner, "habit", "Tahajjud"),
        name: "Tahajjud",
        description: "Optional night prayer. Not mandatory — record when performed.",
        tracking: "completion",
        frequency: "weekly",
        weekly_target: 2,
        sort_order: 2,
        is_active: true,
      },
      undefined,
      DROP_ON_CONFLICT
    );
  }

  if ((await db.count("abstinence_rules")) === 0) {
    for (const name of ["Porn", "Instagram", "Telegram", "Games"]) {
      await db.upsert(
        "abstinence_rules",
        { id: seedId(owner, "rule", name), name, start_date: today, is_active: true },
        undefined,
        DROP_ON_CONFLICT
      );
    }
  }

  if ((await db.count("usage_limits")) === 0) {
    for (const [name, daily_limit_min] of [
      ["YouTube", 45],
      ["WhatsApp", 30],
    ] as const) {
      await db.upsert(
        "usage_limits",
        { id: seedId(owner, "limit", name), name, daily_limit_min, is_active: true },
        undefined,
        DROP_ON_CONFLICT
      );
    }
  }
}

// Default training setup for a brand-new user. Called lazily when the user
// first opens the Training page and has no workouts yet.
// Schedule (weekday 0=Monday): Mon HSPU, Tue Abs, Wed Legs, Thu Rest,
// Fri HSPU, Sat/Sun Rest. Everything is editable afterwards.
export async function seedTrainingDefaultsIfEmpty(): Promise<void> {
  const db = getDb();
  const owner = seedOwner();
  if ((await db.count("workouts")) !== 0) return;

  const hspu = await db.upsert<SeedRow>(
    "workouts",
    {
      id: seedId(owner, "workout", "HSPU"),
      name: "HSPU",
      type: "structured",
      description: "Handstand push-up progression.",
      sort_order: 1,
      is_active: true,
    },
    undefined,
    DROP_ON_CONFLICT
  );
  if (!hspu) return;
  const hspuId = hspu.id;
  if (!hspuId) return;

  for (const [name, exercise_type, sort_order] of [
    ["Wall HSPU", "reps", 1],
    ["Negative HSPU", "reps", 2],
    ["Pike HSPU", "reps", 3],
    ["Handstand Hold", "time", 4],
  ] as const) {
    await db.upsert(
      "workout_exercises",
      {
        id: seedId(owner, "exercise", `HSPU:${name}`),
        workout_id: hspuId,
        name,
        exercise_type,
        sort_order,
        is_active: true,
      },
      undefined,
      DROP_ON_CONFLICT
    );
  }

  const abs = await db.upsert<SeedRow>(
    "workouts",
    {
      id: seedId(owner, "workout", "Abs"),
      name: "Abs",
      type: "completion",
      description: "20-minute video.",
      video_ref: "20-minute abs video",
      sort_order: 2,
      is_active: true,
    },
    undefined,
    DROP_ON_CONFLICT
  );

  const legs = await db.upsert<SeedRow>(
    "workouts",
    {
      id: seedId(owner, "workout", "Legs"),
      name: "Legs",
      type: "completion",
      description: "20-minute video.",
      video_ref: "20-minute legs video",
      sort_order: 3,
      is_active: true,
    },
    undefined,
    DROP_ON_CONFLICT
  );

  // Mon HSPU · Tue Abs · Wed Legs · Thu Rest · Fri HSPU · Sat/Sun Rest
  const plan: Array<{ weekday: number; workout_id: string | null }> = [
    { weekday: 0, workout_id: hspuId },
    { weekday: 1, workout_id: abs?.id ?? null },
    { weekday: 2, workout_id: legs?.id ?? null },
    { weekday: 3, workout_id: null },
    { weekday: 4, workout_id: hspuId },
    { weekday: 5, workout_id: null },
    { weekday: 6, workout_id: null },
  ];
  for (const p of plan) {
    await db.upsert(
      "training_schedule",
      { id: seedId(owner, "schedule", String(p.weekday)), weekday: p.weekday, workout_id: p.workout_id },
      undefined,
      DROP_ON_CONFLICT
    );
  }
}
