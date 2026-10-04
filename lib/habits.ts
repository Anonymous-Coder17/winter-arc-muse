"use client";

import { createClient } from "@/lib/supabase/client";
import type { Habit } from "@/lib/types";

/** Record (or toggle) a habit's completion for a day. Returns the new state. */
export async function toggleHabitDone(
  habit: Habit,
  dateKey: string,
  currentlyDone: boolean
): Promise<"done" | "removed"> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in.");

  if (currentlyDone) {
    // Un-mark: remove today's log row. Absence = "not recorded".
    const { error } = await supabase
      .from("habit_logs")
      .delete()
      .eq("habit_id", habit.id)
      .eq("log_date", dateKey);
    if (error) throw error;
    return "removed";
  }

  const { error } = await supabase.from("habit_logs").upsert(
    {
      owner: user.id,
      habit_id: habit.id,
      log_date: dateKey,
      status: "done",
    },
    { onConflict: "habit_id,log_date" }
  );
  if (error) throw error;
  return "done";
}

/** Mark a habit explicitly as not done (recorded reality, not punishment). */
export async function markHabitNotDone(
  habit: Habit,
  dateKey: string
): Promise<void> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in.");
  const { error } = await supabase.from("habit_logs").upsert(
    {
      owner: user.id,
      habit_id: habit.id,
      log_date: dateKey,
      status: "not_done",
    },
    { onConflict: "habit_id,log_date" }
  );
  if (error) throw error;
}
