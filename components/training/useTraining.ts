"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getDb } from "@/lib/sync/write";
import { engine } from "@/lib/sync/engine";
import { useSyncTick } from "@/components/sync/status";
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
  const tick = useSyncTick();

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const sKey = startKey ?? addDays(todayKey(), -60);
  const eKey = endKey ?? addDays(todayKey(), 7);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setError(null);
      try {
        await engine.whenReady();
        const db = getDb();
        // First-run defaults (local-first; cross-device races converge).
        await seedTrainingDefaultsIfEmpty();

        const [workoutRows, exerciseRows, scheduleRows, sessionRows] =
          await Promise.all([
            db.list<Workout>("workouts", {
              order: [{ col: "sort_order", ascending: true }],
            }),
            db.list<WorkoutExercise>("workout_exercises", {
              order: [{ col: "sort_order", ascending: true }],
            }),
            db.list<TrainingScheduleRow>("training_schedule", {
              order: [{ col: "weekday", ascending: true }],
            }),
            db.list<WorkoutSession>("workout_sessions", {
              gte: { session_date: sKey },
              lte: { session_date: eKey },
              order: [
                { col: "session_date", ascending: false },
                { col: "started_at", ascending: false },
              ],
            }),
          ]);
        if (cancelled) return;

        // db.list with an empty `in` array already returns [] — no
        // zero-UUID placeholder needed.
        const setRows = await db.list<WorkoutSet>("workout_sets", {
          in: { session_id: sessionRows.map((s) => s.id) },
          order: [{ col: "set_number", ascending: true }],
        });
        if (cancelled) return;

        setWorkouts(workoutRows);
        setExercises(exerciseRows);
        setSchedule(scheduleRows);
        setSessions(sessionRows);
        setSets(setRows);
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
  }, [sKey, eKey, tick, nonce]);

  return useMemo(
    () => ({ workouts, exercises, schedule, sessions, sets, loading, error, refresh }),
    [workouts, exercises, schedule, sessions, sets, loading, error, refresh]
  );
}
