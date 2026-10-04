"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { ErrorState, LoadingBlock } from "@/components/ui";
import { addDays, todayKey, weekStartMonday } from "@/lib/dates";
import type {
  AbstinenceIncident,
  AbstinenceRule,
  Book,
  Challenge,
  Habit,
  HabitLog,
  LimitLog,
  ReadingLog,
  StudySession,
  Subject,
  Task,
  Topic,
  TrainingScheduleRow,
  UsageLimit,
  Workout,
  WorkoutExercise,
  WorkoutSession,
  WorkoutSet,
} from "@/lib/types";
import { RangeControl } from "@/components/progress/RangeControl";
import { TabBar, TABS } from "@/components/progress/TabBar";
import { Overview } from "@/components/progress/Overview";
import { HabitsTab } from "@/components/progress/HabitsTab";
import { DistractionsTab } from "@/components/progress/DistractionsTab";
import { TrainingTab } from "@/components/progress/TrainingTab";
import { StudyTab } from "@/components/progress/StudyTab";
import { HifzTab } from "@/components/progress/HifzTab";
import { ReadingTab } from "@/components/progress/ReadingTab";
import { ReflectionTab } from "@/components/progress/ReflectionTab";
import {
  computeRange,
  type RangePreset,
} from "@/components/progress/normalize";
import type {
  ProgressData,
  ProgressTab,
  Range,
} from "@/components/progress/types";

// V3 Progress: the analytics/review hub. Progressive disclosure via tabs —
// never a wall of cards. Independent metrics only: no overall life score,
// no XP, no streaks, no gamification anywhere.
export default function ProgressPage() {
  return (
    <Suspense fallback={<LoadingBlock label="Loading progress…" />}>
      <ProgressInner />
    </Suspense>
  );
}

const TAB_IDS = TABS.map((t) => t.id);

function ProgressInner() {
  const searchParams = useSearchParams();
  const initialTab = searchParams.get("tab");
  const [tab, setTab] = useState<ProgressTab>(
    TAB_IDS.includes(initialTab as ProgressTab)
      ? (initialTab as ProgressTab)
      : "overview"
  );
  const [preset, setPreset] = useState<RangePreset>("30d");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [range, setRange] = useState<Range>(() =>
    computeRange("30d", null, "", "")
  );
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [data, setData] = useState<ProgressData | null>(null);
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
        const owner = user.id;

        // Challenge first: the "Challenge" range preset needs its span.
        const { data: chData, error: chErr } = await supabase
          .from("challenges")
          .select("*")
          .eq("owner", owner)
          .eq("is_active", true)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (chErr) throw chErr;
        if (cancelled) return;
        const challengeRow = (chData ?? null) as Challenge | null;
        setChallenge(challengeRow);

        const r = computeRange(preset, challengeRow, customStart, customEnd);
        setRange(r);
        const today = todayKey();
        // Fetch window: selected range ∪ last 30 days (heatmap) ∪ current
        // week (Tahajjud). Analytics slice per range afterwards.
        const queryStart = [r.start, addDays(today, -29), weekStartMonday(today)].sort()[0];
        const incidentFrom = new Date(queryStart + "T00:00:00").toISOString();
        const incidentTo = new Date(addDays(today, 1) + "T00:00:00").toISOString();

        const [
          habitsRes,
          habitLogsRes,
          rulesRes,
          incidentsRes,
          limitsRes,
          limitLogsRes,
          workoutsRes,
          exercisesRes,
          scheduleRes,
          sessionsRes,
          subjectsRes,
          topicsRes,
          studySessionsRes,
          tasksRes,
          booksRes,
          readingLogsRes,
          journalRes,
        ] = await Promise.all([
          supabase.from("habits").select("*").eq("owner", owner),
          supabase
            .from("habit_logs")
            .select("*")
            .eq("owner", owner)
            .gte("log_date", queryStart)
            .lte("log_date", today),
          supabase.from("abstinence_rules").select("*").eq("owner", owner),
          supabase
            .from("abstinence_incidents")
            .select("*")
            .eq("owner", owner)
            .gte("occurred_at", incidentFrom)
            .lt("occurred_at", incidentTo)
            .order("occurred_at", { ascending: true })
            .limit(500),
          supabase.from("usage_limits").select("*").eq("owner", owner),
          supabase
            .from("limit_logs")
            .select("*")
            .eq("owner", owner)
            .gte("log_date", queryStart)
            .lte("log_date", today),
          supabase.from("workouts").select("*").eq("owner", owner),
          supabase.from("workout_exercises").select("*").eq("owner", owner),
          supabase.from("training_schedule").select("*").eq("owner", owner),
          supabase
            .from("workout_sessions")
            .select("*")
            .eq("owner", owner)
            .gte("session_date", queryStart)
            .lte("session_date", today),
          supabase.from("subjects").select("*").eq("owner", owner),
          supabase.from("topics").select("*").eq("owner", owner),
          supabase
            .from("study_sessions")
            .select("*")
            .eq("owner", owner)
            .gte("session_date", queryStart)
            .lte("session_date", today),
          supabase
            .from("tasks")
            .select("*")
            .eq("owner", owner)
            .gte("task_date", queryStart)
            .lte("task_date", today),
          supabase.from("books").select("*").eq("owner", owner),
          supabase
            .from("reading_logs")
            .select("*")
            .eq("owner", owner)
            .gte("log_date", queryStart)
            .lte("log_date", today),
          // entry_date only — journal TEXT is never loaded for analytics.
          supabase
            .from("journal_entries")
            .select("entry_date")
            .eq("owner", owner)
            .gte("entry_date", queryStart)
            .lte("entry_date", today),
        ]);
        if (cancelled) return;

        const sessions = (sessionsRes.data ?? []) as WorkoutSession[];
        const sessionIds = sessions.map((s) => s.id);
        const setsRes =
          sessionIds.length > 0
            ? await supabase
                .from("workout_sets")
                .select("*")
                .eq("owner", owner)
                .in("session_id", sessionIds)
            : { data: [] as WorkoutSet[], error: null };
        if (cancelled) return;

        const firstErr = [
          habitsRes,
          habitLogsRes,
          rulesRes,
          incidentsRes,
          limitsRes,
          limitLogsRes,
          workoutsRes,
          exercisesRes,
          scheduleRes,
          sessionsRes,
          setsRes,
          subjectsRes,
          topicsRes,
          studySessionsRes,
          tasksRes,
          booksRes,
          readingLogsRes,
          journalRes,
        ].find((x) => x.error)?.error;
        if (firstErr) throw firstErr;

        setData({
          challenge: challengeRow,
          habits: (habitsRes.data ?? []) as Habit[],
          habitLogs: (habitLogsRes.data ?? []) as HabitLog[],
          rules: (rulesRes.data ?? []) as AbstinenceRule[],
          incidents: (incidentsRes.data ?? []) as AbstinenceIncident[],
          limits: (limitsRes.data ?? []) as UsageLimit[],
          limitLogs: (limitLogsRes.data ?? []) as LimitLog[],
          workouts: (workoutsRes.data ?? []) as Workout[],
          exercises: (exercisesRes.data ?? []) as WorkoutExercise[],
          sessions,
          sets: (setsRes.data ?? []) as WorkoutSet[],
          schedule: (scheduleRes.data ?? []) as TrainingScheduleRow[],
          subjects: (subjectsRes.data ?? []) as Subject[],
          topics: (topicsRes.data ?? []) as Topic[],
          studySessions: (studySessionsRes.data ?? []) as StudySession[],
          tasks: (tasksRes.data ?? []) as Task[],
          books: (booksRes.data ?? []) as Book[],
          readingLogs: (readingLogsRes.data ?? []) as ReadingLog[],
          journalDates: ((journalRes.data ?? []) as { entry_date: string }[]).map(
            (j) => j.entry_date
          ),
        });
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
  }, [preset, customStart, customEnd, nonce]);

  if (loading) return <LoadingBlock label="Loading progress…" />;
  if (error)
    return <ErrorState message={error} onRetry={() => setNonce((n) => n + 1)} />;
  if (!data) return null;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="page-title">Transformation</h1>
        <p className="page-sub">What happened — recorded, not rated.</p>
      </div>

      <RangeControl
        preset={preset}
        onPreset={setPreset}
        customStart={customStart}
        customEnd={customEnd}
        onCustomStart={setCustomStart}
        onCustomEnd={setCustomEnd}
        challenge={challenge}
        range={range}
      />

      <TabBar value={tab} onChange={setTab} />

      {tab === "overview" && (
        <Overview data={data} range={range} onSelectTab={setTab} />
      )}
      {tab === "habits" && <HabitsTab data={data} range={range} />}
      {tab === "distractions" && <DistractionsTab data={data} range={range} />}
      {tab === "training" && <TrainingTab data={data} range={range} />}
      {tab === "study" && <StudyTab data={data} range={range} />}
      {tab === "hifz" && <HifzTab data={data} range={range} />}
      {tab === "reading" && <ReadingTab data={data} range={range} />}
      {tab === "reflection" && <ReflectionTab range={range} />}
    </div>
  );
}
