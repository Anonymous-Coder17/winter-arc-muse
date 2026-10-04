import type { SupabaseClient } from "@supabase/supabase-js";
import { todayKey } from "./dates";
// Default seed rows for a brand-new user. Called once, lazily, when the user
// has no habits/rules/limits yet. NEVER includes the five daily prayers.
// Tahajjud is seeded as an OPTIONAL weekly habit (2x/week), editable/removable.
export async function seedDefaultsIfEmpty(
  supabase: SupabaseClient,
  owner: string
): Promise<void> {
  const today = todayKey(); // local date — never UTC-sliced
  const { count: habitCount } = await supabase
    .from("habits")
    .select("id", { count: "exact", head: true })
    .eq("owner", owner);

  if (habitCount === 0) {
    await supabase.from("habits").insert([
      {
        owner,
        name: "Meditation",
        description: "Daily stillness practice.",
        tracking: "completion",
        frequency: "daily",
        sort_order: 1,
      },
      {
        owner,
        name: "Tahajjud",
        description: "Optional night prayer. Not mandatory — record when performed.",
        tracking: "completion",
        frequency: "weekly",
        weekly_target: 2,
        sort_order: 2,
      },
    ]);
  }

  const { count: ruleCount } = await supabase
    .from("abstinence_rules")
    .select("id", { count: "exact", head: true })
    .eq("owner", owner);

  if (ruleCount === 0) {
    await supabase.from("abstinence_rules").insert([
      { owner, name: "Porn", start_date: today },
      { owner, name: "Instagram", start_date: today },
      { owner, name: "Telegram", start_date: today },
      { owner, name: "Games", start_date: today },
    ]);
  }

  const { count: limitCount } = await supabase
    .from("usage_limits")
    .select("id", { count: "exact", head: true })
    .eq("owner", owner);

  if (limitCount === 0) {
    await supabase.from("usage_limits").insert([
      { owner, name: "YouTube", daily_limit_min: 45 },
      { owner, name: "WhatsApp", daily_limit_min: 30 },
    ]);
  }
}

// Default training setup for a brand-new user. Called lazily when the user
// first opens the Training page and has no workouts yet.
// Schedule (weekday 0=Monday): Mon HSPU, Tue Abs, Wed Legs, Thu Rest,
// Fri HSPU, Sat/Sun Rest. Everything is editable afterwards.
export async function seedTrainingDefaultsIfEmpty(
  supabase: SupabaseClient,
  owner: string
): Promise<void> {
  const { count: workoutCount } = await supabase
    .from("workouts")
    .select("id", { count: "exact", head: true })
    .eq("owner", owner);
  if (workoutCount !== 0) return;

  const { data: hspu, error: hspuErr } = await supabase
    .from("workouts")
    .insert({
      owner,
      name: "HSPU",
      type: "structured",
      description: "Handstand push-up progression.",
      sort_order: 1,
    })
    .select("id")
    .single();
  if (hspuErr || !hspu) return;

  await supabase.from("workout_exercises").insert([
    { owner, workout_id: hspu.id, name: "Wall HSPU", exercise_type: "reps", sort_order: 1 },
    { owner, workout_id: hspu.id, name: "Negative HSPU", exercise_type: "reps", sort_order: 2 },
    { owner, workout_id: hspu.id, name: "Pike HSPU", exercise_type: "reps", sort_order: 3 },
    { owner, workout_id: hspu.id, name: "Handstand Hold", exercise_type: "time", sort_order: 4 },
  ]);

  const { data: abs } = await supabase
    .from("workouts")
    .insert({
      owner,
      name: "Abs",
      type: "completion",
      description: "20-minute video.",
      video_ref: "20-minute abs video",
      sort_order: 2,
    })
    .select("id")
    .single();

  const { data: legs } = await supabase
    .from("workouts")
    .insert({
      owner,
      name: "Legs",
      type: "completion",
      description: "20-minute video.",
      video_ref: "20-minute legs video",
      sort_order: 3,
    })
    .select("id")
    .single();

  // Mon HSPU · Tue Abs · Wed Legs · Thu Rest · Fri HSPU · Sat/Sun Rest
  const plan: Array<{ weekday: number; workout_id: string | null }> = [
    { weekday: 0, workout_id: hspu.id },
    { weekday: 1, workout_id: abs?.id ?? null },
    { weekday: 2, workout_id: legs?.id ?? null },
    { weekday: 3, workout_id: null },
    { weekday: 4, workout_id: hspu.id },
    { weekday: 5, workout_id: null },
    { weekday: 6, workout_id: null },
  ];
  await supabase.from("training_schedule").insert(
    plan.map((p) => ({ owner, weekday: p.weekday, workout_id: p.workout_id }))
  );
}
