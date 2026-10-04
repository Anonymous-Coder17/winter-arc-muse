"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getDb } from "@/lib/sync/write";
import { engine } from "@/lib/sync/engine";
import { useSyncTick } from "@/components/sync/status";
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
  const rawDate = searchParams.get("date");
  // Today links here with ?tab=reflection&date=YYYY-MM-DD so "Write journal"
  // opens the V3 journal on the intended day. Anything else falls back to today.
  const initialDate =
    rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null;
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
  const tick = useSyncTick();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        await engine.whenReady();
        const owner = engine.getSnapshot().userId;
        if (!owner) {
          if (!cancelled) setError("Not signed in.");
          return;
        }
        const db = getDb();

        // Challenge first: the "Challenge" range preset needs its span.
        const chRows = await db.list<Challenge>("challenges", {
          eq: { owner, is_active: true },
          order: [{ col: "created_at", ascending: false }],
          limit: 1,
        });
        if (cancelled) return;
        const challengeRow = chRows[0] ?? null;
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
          habits,
          habitLogs,
          rules,
          incidents,
          limits,
          limitLogs,
          workouts,
          exercises,
          schedule,
          sessions,
          subjects,
          topics,
          studySessions,
          tasks,
          books,
          readingLogs,
          journalRows,
        ] = await Promise.all([
          db.list<Habit>("habits", { eq: { owner } }),
          db.list<HabitLog>("habit_logs", {
            eq: { owner },
            gte: { log_date: queryStart },
            lte: { log_date: today },
          }),
          db.list<AbstinenceRule>("abstinence_rules", { eq: { owner } }),
          db.list<AbstinenceIncident>("abstinence_incidents", {
            eq: { owner },
            gte: { occurred_at: incidentFrom },
            lt: { occurred_at: incidentTo },
            order: [{ col: "occurred_at", ascending: true }],
            limit: 500,
          }),
          db.list<UsageLimit>("usage_limits", { eq: { owner } }),
          db.list<LimitLog>("limit_logs", {
            eq: { owner },
            gte: { log_date: queryStart },
            lte: { log_date: today },
          }),
          db.list<Workout>("workouts", { eq: { owner } }),
          db.list<WorkoutExercise>("workout_exercises", { eq: { owner } }),
          db.list<TrainingScheduleRow>("training_schedule", { eq: { owner } }),
          db.list<WorkoutSession>("workout_sessions", {
            eq: { owner },
            gte: { session_date: queryStart },
            lte: { session_date: today },
          }),
          db.list<Subject>("subjects", { eq: { owner } }),
          db.list<Topic>("topics", { eq: { owner } }),
          db.list<StudySession>("study_sessions", {
            eq: { owner },
            gte: { session_date: queryStart },
            lte: { session_date: today },
          }),
          db.list<Task>("tasks", {
            eq: { owner },
            gte: { task_date: queryStart },
            lte: { task_date: today },
          }),
          db.list<Book>("books", { eq: { owner } }),
          db.list<ReadingLog>("reading_logs", {
            eq: { owner },
            gte: { log_date: queryStart },
            lte: { log_date: today },
          }),
          // entry_date only — journal TEXT is never loaded for analytics.
          db.list<{ entry_date: string }>("journal_entries", {
            eq: { owner },
            gte: { entry_date: queryStart },
            lte: { entry_date: today },
          }),
        ]);
        if (cancelled) return;

        const sessionIds = sessions.map((s) => s.id);
        const sets = await db.list<WorkoutSet>("workout_sets", {
          eq: { owner },
          in: { session_id: sessionIds },
        });
        if (cancelled) return;

        setData({
          challenge: challengeRow,
          habits,
          habitLogs,
          rules,
          incidents,
          limits,
          limitLogs,
          workouts,
          exercises,
          sessions,
          sets,
          schedule,
          subjects,
          topics,
          studySessions,
          tasks,
          books,
          readingLogs,
          journalDates: journalRows.map((j) => j.entry_date),
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
  }, [preset, customStart, customEnd, nonce, tick]);

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
      {tab === "reflection" && (
        <ReflectionTab range={range} initialDate={initialDate} />
      )}
    </div>
  );
}
