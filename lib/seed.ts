import type { SupabaseClient } from "@supabase/supabase-js";

// Default seed rows for a brand-new user. Called once, lazily, when the user
// has no habits/rules/limits yet. NEVER includes the five daily prayers.
// Tahajjud is seeded as an OPTIONAL weekly habit (2x/week), editable/removable.
export async function seedDefaultsIfEmpty(
  supabase: SupabaseClient,
  owner: string
): Promise<void> {
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
      { owner, name: "Porn", start_date: new Date().toISOString().slice(0, 10) },
      { owner, name: "Instagram", start_date: new Date().toISOString().slice(0, 10) },
      { owner, name: "Telegram", start_date: new Date().toISOString().slice(0, 10) },
      { owner, name: "Games", start_date: new Date().toISOString().slice(0, 10) },
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
