"use client";

import { createClient } from "@/lib/supabase/client";

// ---- numeric quick-logging for Hifz / Reading ----
// Finds a count-tracking habit by name (creating it if missing), then adds
// to today's log value. Architecture stays on habit_logs — no parallel store.

export async function quickLogCount(
  name: string,
  dateKey: string,
  amount: number
): Promise<number> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in.");

  let { data: habit, error: hErr } = await supabase
    .from("habits")
    .select("*")
    .eq("owner", user.id)
    .eq("name", name)
    .maybeSingle();
  if (hErr) throw hErr;

  if (!habit) {
    const { data, error } = await supabase
      .from("habits")
      .insert({
        owner: user.id,
        name,
        description: null,
        tracking: "count",
        frequency: "daily",
        sort_order: 99,
        is_active: true,
      })
      .select("*")
      .single();
    if (error) throw error;
    habit = data;
  }

  const { data: existing } = await supabase
    .from("habit_logs")
    .select("*")
    .eq("habit_id", habit.id)
    .eq("log_date", dateKey)
    .maybeSingle();

  const newValue = (Number(existing?.value ?? 0) || 0) + amount;
  const { error } = await supabase.from("habit_logs").upsert(
    {
      owner: user.id,
      habit_id: habit.id,
      log_date: dateKey,
      status: "done",
      value: newValue,
    },
    { onConflict: "habit_id,log_date" }
  );
  if (error) throw error;
  return newValue;
}

// ---- usage limits ----

export async function addLimitMinutes(
  limitId: string,
  dateKey: string,
  minutes: number
): Promise<void> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in.");

  const { data: existing } = await supabase
    .from("limit_logs")
    .select("*")
    .eq("limit_id", limitId)
    .eq("log_date", dateKey)
    .maybeSingle();

  const newUsed = (existing?.minutes_used ?? 0) + minutes;
  const { error } = existing
    ? await supabase
        .from("limit_logs")
        .update({ minutes_used: newUsed })
        .eq("id", existing.id)
    : await supabase.from("limit_logs").insert({
        owner: user.id,
        limit_id: limitId,
        log_date: dateKey,
        minutes_used: newUsed,
      });
  if (error) throw error;
}

// ---- abstinence incidents (recorded data; never resets the challenge) ----

export async function logIncident(
  ruleId: string,
  trigger: string | null,
  note: string | null
): Promise<void> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in.");
  const { error } = await supabase.from("abstinence_incidents").insert({
    owner: user.id,
    rule_id: ruleId,
    occurred_at: new Date().toISOString(),
    trigger: trigger || null,
    note: note || null,
  });
  if (error) throw error;
}
