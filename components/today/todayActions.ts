"use client";

import { getDb } from "@/lib/sync/write";
import { engine } from "@/lib/sync/engine";
import { seedId } from "@/lib/seed";

// ---- numeric quick-logging for Hifz / Reading ----
// Finds a count-tracking habit by name (creating it if missing), then adds
// to today's log value. Architecture stays on habit_logs — no parallel store.

export async function quickLogCount(
  name: string,
  dateKey: string,
  amount: number
): Promise<number> {
  const db = getDb();

  const habitRows = await db.list("habits", { eq: { name }, limit: 1 });
  let habit = habitRows[0] ?? null;

  if (!habit) {
    // Deterministic id: two devices creating the same quick-log habit offline
    // converge on one row instead of conflicting.
    const owner = engine.getSnapshot().userId;
    if (!owner) throw new Error("Not signed in.");
    habit = await db.upsert(
      "habits",
      {
        id: seedId(owner, "habit", name),
        name,
        description: null,
        tracking: "count",
        frequency: "daily",
        sort_order: 99,
        is_active: true,
      },
      undefined,
      { tolerance: "drop-on-conflict" }
    );
  }

  const existing = await db.getByNaturalKey(
    "habit_logs",
    { index: "habit_id_log_date", cols: ["habit_id", "log_date"] },
    { habit_id: habit.id, log_date: dateKey }
  );

  // Additive counter: replays as a delta so concurrent offline quick-logs on
  // two devices never lose counts.
  const newValue = (Number(existing?.value ?? 0) || 0) + amount;
  await db.increment(
    "habit_logs",
    existing?.id,
    "value",
    amount,
    { habit_id: habit.id, log_date: dateKey, status: "done", value: 0 },
    ["habit_id", "log_date"]
  );
  return newValue;
}

// ---- usage limits ----

export async function addLimitMinutes(
  limitId: string,
  dateKey: string,
  minutes: number
): Promise<void> {
  const db = getDb();
  const existing = (
    await db.list("limit_logs", {
      eq: { limit_id: limitId, log_date: dateKey },
      limit: 1,
    })
  )[0];
  await db.increment(
    "limit_logs",
    existing?.id,
    "minutes_used",
    minutes,
    { limit_id: limitId, log_date: dateKey, minutes_used: 0 },
    ["limit_id", "log_date"]
  );
}

// ---- abstinence incidents (recorded data; never resets the challenge) ----

export async function logIncident(
  ruleId: string,
  trigger: string | null,
  note: string | null
): Promise<void> {
  const db = getDb();
  await db.insert("abstinence_incidents", {
    rule_id: ruleId,
    occurred_at: new Date().toISOString(),
    trigger: trigger || null,
    note: note || null,
  });
}
