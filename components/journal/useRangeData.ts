"use client";

import { useCallback, useEffect, useState } from "react";
import { getDb } from "@/lib/sync/write";
import { engine } from "@/lib/sync/engine";
import { useSyncTick } from "@/components/sync/status";
import { addDays } from "@/lib/dates";
import type {
  AbstinenceIncident,
  Habit,
  HabitLog,
  LimitLog,
  ReadingLog,
  StudySession,
  TrainingScheduleRow,
  UsageLimit,
  WorkoutSession,
} from "@/lib/types";

export interface Range {
  start: string; // YYYY-MM-DD, inclusive
  end: string; // YYYY-MM-DD, inclusive
}

export interface RangeDataset {
  habits: Habit[];
  habitLogs: HabitLog[];
  incidents: AbstinenceIncident[];
  limits: UsageLimit[];
  limitLogs: LimitLog[];
  sessions: WorkoutSession[];
  schedule: TrainingScheduleRow[];
  studySessions: StudySession[];
  readingLogs: ReadingLog[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const EMPTY: Omit<RangeDataset, "loading" | "error" | "refresh"> = {
  habits: [],
  habitLogs: [],
  incidents: [],
  limits: [],
  limitLogs: [],
  sessions: [],
  schedule: [],
  studySessions: [],
  readingLogs: [],
};

/**
 * Fetches the behavioral rows for exactly one date range, for review
 * summaries (weekly review, 30-day comparison). Uses the same queries as
 * the Progress page but bounded to the caller's range — the existing
 * analytics functions in lib/analytics (via components/progress/normalize)
 * stay the single source of truth for every calculation.
 *
 * Pass null to skip fetching (e.g. no challenge yet).
 */
export function useRangeData(range: Range | null): RangeDataset {
  const [data, setData] =
    useState<Omit<RangeDataset, "loading" | "error" | "refresh">>(EMPTY);
  const [loading, setLoading] = useState(range !== null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const tick = useSyncTick();

  useEffect(() => {
    if (!range) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const r = range; // narrowed non-null for the closure below
    async function load() {
      setLoading(true);
      setError(null);
      try {
        await engine.whenReady();
        const db = getDb();
        // Incidents carry timestamptz; bound by the local-day window so
        // attribution matches the rest of the app (see Progress page).
        const incidentFrom = new Date(r.start + "T00:00:00").toISOString();
        const incidentTo = new Date(
          addDays(r.end, 1) + "T00:00:00"
        ).toISOString();

        const [
          habits,
          habitLogs,
          incidents,
          limits,
          limitLogs,
          sessions,
          schedule,
          studySessions,
          readingLogs,
        ] = await Promise.all([
          db.list<Habit>("habits"),
          db.list<HabitLog>("habit_logs", {
            gte: { log_date: r.start },
            lte: { log_date: r.end },
          }),
          db.list<AbstinenceIncident>("abstinence_incidents", {
            gte: { occurred_at: incidentFrom },
            lt: { occurred_at: incidentTo },
            order: [{ col: "occurred_at", ascending: true }],
            limit: 500,
          }),
          db.list<UsageLimit>("usage_limits"),
          db.list<LimitLog>("limit_logs", {
            gte: { log_date: r.start },
            lte: { log_date: r.end },
          }),
          db.list<WorkoutSession>("workout_sessions", {
            gte: { session_date: r.start },
            lte: { session_date: r.end },
          }),
          db.list<TrainingScheduleRow>("training_schedule"),
          db.list<StudySession>("study_sessions", {
            gte: { session_date: r.start },
            lte: { session_date: r.end },
          }),
          db.list<ReadingLog>("reading_logs", {
            gte: { log_date: r.start },
            lte: { log_date: r.end },
          }),
        ]);
        if (cancelled) return;
        setData({
          habits,
          habitLogs,
          incidents,
          limits,
          limitLogs,
          sessions,
          schedule,
          studySessions,
          readingLogs,
        });
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Could not load data.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range?.start, range?.end, nonce, tick]);

  return { ...data, loading, error, refresh };
}
