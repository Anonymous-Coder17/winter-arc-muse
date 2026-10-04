"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
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
        const supabase = createClient();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) throw new Error("Not signed in.");
        const owner = user.id;
        // Incidents carry timestamptz; bound by the local-day window so
        // attribution matches the rest of the app (see Progress page).
        const incidentFrom = new Date(r.start + "T00:00:00").toISOString();
        const incidentTo = new Date(
          addDays(r.end, 1) + "T00:00:00"
        ).toISOString();

        const [
          habitsRes,
          habitLogsRes,
          incidentsRes,
          limitsRes,
          limitLogsRes,
          sessionsRes,
          scheduleRes,
          studyRes,
          readingRes,
        ] = await Promise.all([
          supabase.from("habits").select("*").eq("owner", owner),
          supabase
            .from("habit_logs")
            .select("*")
            .eq("owner", owner)
            .gte("log_date", r.start)
            .lte("log_date", r.end),
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
            .gte("log_date", r.start)
            .lte("log_date", r.end),
          supabase
            .from("workout_sessions")
            .select("*")
            .eq("owner", owner)
            .gte("session_date", r.start)
            .lte("session_date", r.end),
          supabase.from("training_schedule").select("*").eq("owner", owner),
          supabase
            .from("study_sessions")
            .select("*")
            .eq("owner", owner)
            .gte("session_date", r.start)
            .lte("session_date", r.end),
          supabase
            .from("reading_logs")
            .select("*")
            .eq("owner", owner)
            .gte("log_date", r.start)
            .lte("log_date", r.end),
        ]);
        if (cancelled) return;
        const firstErr = [
          habitsRes,
          habitLogsRes,
          incidentsRes,
          limitsRes,
          limitLogsRes,
          sessionsRes,
          scheduleRes,
          studyRes,
          readingRes,
        ].find((x) => x.error)?.error;
        if (firstErr) throw firstErr;
        setData({
          habits: (habitsRes.data ?? []) as Habit[],
          habitLogs: (habitLogsRes.data ?? []) as HabitLog[],
          incidents: (incidentsRes.data ?? []) as AbstinenceIncident[],
          limits: (limitsRes.data ?? []) as UsageLimit[],
          limitLogs: (limitLogsRes.data ?? []) as LimitLog[],
          sessions: (sessionsRes.data ?? []) as WorkoutSession[],
          schedule: (scheduleRes.data ?? []) as TrainingScheduleRow[],
          studySessions: (studyRes.data ?? []) as StudySession[],
          readingLogs: (readingRes.data ?? []) as ReadingLog[],
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
  }, [range?.start, range?.end, nonce]);

  return { ...data, loading, error, refresh };
}
