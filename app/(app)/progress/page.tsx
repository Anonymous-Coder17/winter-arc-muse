"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  EmptyState,
  ErrorState,
  LoadingBlock,
} from "@/components/ui";
import {
  addDays,
  formatShort,
  todayKey,
  weekStartMonday,
} from "@/lib/dates";
import { challengeDayNumber, daysRemaining } from "@/lib/types";
import type {
  AbstinenceIncident,
  AbstinenceRule,
  Challenge,
  Habit,
  HabitLog,
  LimitLog,
  UsageLimit,
} from "@/lib/types";

// V1 Progress: truthful per-day records. No streaks, no scores, no heatmaps.
// What happened is shown; nothing is combined into a rating.
export default function ProgressPage() {
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [habits, setHabits] = useState<Habit[]>([]);
  const [logs, setLogs] = useState<HabitLog[]>([]);
  const [rules, setRules] = useState<AbstinenceRule[]>([]);
  const [incidents, setIncidents] = useState<AbstinenceIncident[]>([]);
  const [limits, setLimits] = useState<UsageLimit[]>([]);
  const [limitLogs, setLimitLogs] = useState<LimitLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const supabase = createClient();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) {
          if (!cancelled) setError("Not signed in.");
          return;
        }
        const start = addDays(todayKey(), -30);
        const end = todayKey();
        const [c, h, l, r, inc, lim, ll] = await Promise.all([
          supabase
            .from("challenges")
            .select("*")
            .eq("owner", user.id)
            .eq("is_active", true)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
          supabase.from("habits").select("*").eq("owner", user.id),
          supabase
            .from("habit_logs")
            .select("*")
            .gte("log_date", start)
            .lte("log_date", end),
          supabase.from("abstinence_rules").select("*").eq("owner", user.id),
          supabase
            .from("abstinence_incidents")
            .select("*")
            .gte("occurred_at", new Date(start + "T00:00:00").toISOString())
            .order("occurred_at", { ascending: false })
            .limit(50),
          supabase.from("usage_limits").select("*").eq("owner", user.id),
          supabase
            .from("limit_logs")
            .select("*")
            .gte("log_date", start)
            .lte("log_date", end),
        ]);
        if (cancelled) return;
        const firstErr = [c, h, l, r, inc, lim, ll].find(
          (x) => x.error
        )?.error;
        if (firstErr) throw firstErr;
        setChallenge(c.data ?? null);
        setHabits(h.data ?? []);
        setLogs(l.data ?? []);
        setRules(r.data ?? []);
        setIncidents(inc.data ?? []);
        setLimits(lim.data ?? []);
        setLimitLogs(ll.data ?? []);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Failed to load.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  // Per-day aggregates for the last 14 days (newest first).
  const days = useMemo(() => {
    const out: {
      key: string;
      habitsDone: number;
      incidents: number;
      limitsOver: number;
    }[] = [];
    for (let i = 0; i < 14; i++) {
      const key = addDays(todayKey(), -i);
      const dayLogs = logs.filter((x) => x.log_date === key);
      out.push({
        key,
        habitsDone: dayLogs.filter((x) => x.status === "done").length,
        incidents: incidents.filter(
          (x) => x.occurred_at.slice(0, 10) === key
        ).length,
        limitsOver: limits.filter((lim) => {
          const log = limitLogs.find(
            (x) => x.limit_id === lim.id && x.log_date === key
          );
          return log && log.minutes_used > lim.daily_limit_min;
        }).length,
      });
    }
    return out;
  }, [logs, incidents, limits, limitLogs]);

  // Tahajjud weekly progress (optional, 2x/week default).
  const tahajjud = useMemo(() => {
    const habit = habits.find((x) => x.name.toLowerCase() === "tahajjud");
    if (!habit) return null;
    const weekStart = weekStartMonday(todayKey());
    const weekEnd = addDays(weekStart, 6);
    const count = logs.filter(
      (x) =>
        x.habit_id === habit.id &&
        x.status === "done" &&
        x.log_date >= weekStart &&
        x.log_date <= weekEnd
    ).length;
    return { habit, count, target: habit.weekly_target ?? 2 };
  }, [habits, logs]);

  const dayNumber = challenge
    ? challengeDayNumber(challenge, new Date())
    : null;
  const remaining = challenge ? daysRemaining(challenge, new Date()) : null;
  const pct =
    challenge && dayNumber !== null && dayNumber >= 1
      ? Math.min(100, Math.round((Math.min(dayNumber, challenge.duration_days) / challenge.duration_days) * 100))
      : 0;

  if (loading) return <LoadingBlock />;
  if (error)
    return <ErrorState message={error} onRetry={() => setNonce((n) => n + 1)} />;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="page-title">Progress</h1>
        <p className="page-sub">What happened — recorded, not rated.</p>
      </div>

      {/* challenge */}
      {challenge && (
        <section className="surface card-pad" aria-label="Challenge">
          <p className="text-[11px] uppercase tracking-[0.18em] t-faint">
            {challenge.title}
          </p>
          {dayNumber !== null && dayNumber >= 1 ? (
            <p className="text-lg font-semibold t-primary mt-1">
              Day {Math.min(dayNumber, challenge.duration_days)} of{" "}
              {challenge.duration_days}
              {remaining !== null && (
                <span className="text-sm font-normal t-secondary">
                  {" "}
                  · {remaining} remaining
                </span>
              )}
            </p>
          ) : (
            <p className="text-lg font-semibold t-primary mt-1">
              Starts {challenge.start_date}
            </p>
          )}
          <div className="h-2 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden mt-3">
            <div
              className="h-full rounded-full bg-[#7C8CF8]"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-xs t-faint mt-2">
            This bar is time elapsed in your challenge — not a score.
          </p>
        </section>
      )}

      {/* tahajjud weekly progress */}
      {tahajjud && (
        <section className="surface card-pad" aria-label="Tahajjud this week">
          <h2 className="section-title mb-1">Tahajjud · this week</h2>
          <p className="text-sm t-primary tabular-nums">
            {tahajjud.count} / {tahajjud.target} times
          </p>
          <p className="text-xs t-faint mt-1">
            Optional and personal — recorded when performed, nothing more.
          </p>
        </section>
      )}

      {/* per-day aggregates */}
      <section aria-label="Recent days">
        <h2 className="section-title mb-2">Recent days</h2>
        <div className="surface card-pad flex flex-col divide-y divide-[#E5E7EB] dark:divide-[#242932]">
          {days.map((d) => (
            <div
              key={d.key}
              className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0"
            >
              <span className="text-sm t-primary">
                {d.key === todayKey() ? "Today" : formatShort(d.key)}
              </span>
              <span className="text-xs t-secondary tabular-nums text-right">
                {d.habitsDone} habit{d.habitsDone === 1 ? "" : "s"} done
                {d.incidents > 0 &&
                  ` · ${d.incidents} incident${d.incidents === 1 ? "" : "s"}`}
                {d.limitsOver > 0 &&
                  ` · ${d.limitsOver} limit${d.limitsOver === 1 ? "" : "s"} over`}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* incidents history */}
      <section aria-label="Incident history">
        <h2 className="section-title mb-2">Incidents</h2>
        {incidents.length === 0 ? (
          <EmptyState
            title="No incidents recorded"
            body="If one happens, log it from the Today view. It becomes history, not a reset."
          />
        ) : (
          <div className="surface card-pad flex flex-col gap-2">
            {incidents.map((i) => {
              const rule = rules.find((r) => r.id === i.rule_id);
              return (
                <div key={i.id} className="text-sm">
                  <span className="t-primary font-medium">
                    {rule?.name ?? "Unknown"}
                  </span>{" "}
                  <span className="t-faint text-xs">
                    · {new Date(i.occurred_at).toLocaleString()}
                  </span>
                  {(i.trigger || i.note) && (
                    <p className="text-xs t-secondary mt-0.5">
                      {[i.trigger, i.note].filter(Boolean).join(" — ")}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
