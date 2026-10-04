"use client";

import { getDb } from "@/lib/sync/write";
import type { Habit } from "@/lib/types";

const HABIT_LOG_KEY = {
  index: "habit_id_log_date",
  cols: ["habit_id", "log_date"],
} as const;

/** Record (or toggle) a habit's completion for a day. Returns the new state. */
export async function toggleHabitDone(
  habit: Habit,
  dateKey: string,
  currentlyDone: boolean
): Promise<"done" | "removed"> {
  const db = getDb();

  if (currentlyDone) {
    // Un-mark: remove today's log row. Absence = "not recorded".
    const existing = await db.getByNaturalKey(
      "habit_logs",
      { index: HABIT_LOG_KEY.index, cols: [...HABIT_LOG_KEY.cols] },
      { habit_id: habit.id, log_date: dateKey }
    );
    if (existing) await db.remove("habit_logs", existing.id);
    return "removed";
  }

  await db.upsert(
    "habit_logs",
    {
      habit_id: habit.id,
      log_date: dateKey,
      status: "done",
    },
    { index: HABIT_LOG_KEY.index, cols: [...HABIT_LOG_KEY.cols] }
  );
  return "done";
}

/** Mark a habit explicitly as not done (recorded reality, not punishment). */
export async function markHabitNotDone(
  habit: Habit,
  dateKey: string
): Promise<void> {
  const db = getDb();
  await db.upsert(
    "habit_logs",
    {
      habit_id: habit.id,
      log_date: dateKey,
      status: "not_done",
    },
    { index: HABIT_LOG_KEY.index, cols: [...HABIT_LOG_KEY.cols] }
  );
}
