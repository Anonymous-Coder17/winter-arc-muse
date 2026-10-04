"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { seedTrainingDefaultsIfEmpty } from "@/lib/seed";
import { addDays, todayKey } from "@/lib/dates";
// Pure helper lives in lib; re-exported here so existing imports keep working.
export { exercisesFor } from "../../lib/training";
import type {
  TrainingScheduleRow,
  Workout,
  WorkoutExercise,
  WorkoutSession,
  WorkoutSet,
} from "@/lib/types";

export interface TrainingData {
  workouts: Workout[];
  exercises: WorkoutExercise[];
  schedule: TrainingScheduleRow[];
  sessions: WorkoutSession[];
  sets: WorkoutSet[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Loads everything the training system needs. Sessions/sets are bounded to
 * [startKey, endKey] (default: last 60 days → next 7 days); workouts,
 * exercises and the weekly schedule always load in full.
 */
export function useTraining(startKey?: string, endKey?: string): TrainingData {
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [exercises, setExercises] = useState<WorkoutExercise[]>([]);
  const [schedule, setSchedule] = useState<TrainingScheduleRow[]>([]);
  const [sessions, setSessions] = useState<WorkoutSession[]>([]);
  const [sets, setSets] = useState<WorkoutSet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const sKey = startKey ?? addDays(todayKey(), -60);
  const eKey = endKey ?? addDays(todayKey(), 7);

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
        await seedTrainingDefaultsIfEmpty(supabase, user.id);

        const [w, ex, sch, se] = await Promise.all([
          supabase
            .from("workouts")
            .select("*")
            .eq("owner", user.id)
            .order("sort_order"),
          supabase
            .from("workout_exercises")
            .select("*")
            .eq("owner", user.id)
            .order("sort_order"),
          supabase
            .from("training_schedule")
            .select("*")
            .eq("owner", user.id)
            .order("weekday"),
          supabase
            .from("workout_sessions")
            .select("*")
            .eq("owner", user.id)
            .gte("session_date", sKey)
            .lte("session_date", eKey)
            .order("session_date", { ascending: false })
            .order("started_at", { ascending: false }),
        ]);
        if (cancelled) return;
        const firstErr = [w, ex, sch, se].find((r) => r.error)?.error;
        if (firstErr) throw firstErr;

        const sessionRows = (se.data ?? []) as WorkoutSession[];
        const { data: setRows, error: setErr } = await supabase
          .from("workout_sets")
          .select("*")
          .eq("owner", user.id)
          .in(
            "session_id",
            sessionRows.map((s) => s.id).concat(["00000000-0000-0000-0000-000000000000"])
          )
          .order("set_number");
        if (cancelled) return;
        if (setErr) throw setErr;

        setWorkouts((w.data ?? []) as Workout[]);
        setExercises((ex.data ?? []) as WorkoutExercise[]);
        setSchedule((sch.data ?? []) as TrainingScheduleRow[]);
        setSessions(sessionRows);
        setSets((setRows ?? []) as WorkoutSet[]);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Failed to load training.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sKey, eKey, nonce]);

  return useMemo(
    () => ({ workouts, exercises, schedule, sessions, sets, loading, error, refresh }),
    [workouts, exercises, schedule, sessions, sets, loading, error, refresh]
  );
}
