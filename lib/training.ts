import { weekdayIndex } from "./dates";
import type {
  TrainingScheduleRow,
  Workout,
  WorkoutExercise,
  WorkoutSession,
  WorkoutSet,
} from "./types";

export const WEEKDAY_LABELS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

export const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * The workout planned for a date from the weekly schedule.
 * Returns null for rest days and unscheduled days — the caller renders
 * "Rest day" for both; a rest day is never a failure.
 */
export function scheduledWorkoutForDate(
  schedule: TrainingScheduleRow[],
  workouts: Workout[],
  dateKey: string
): Workout | null {
  const wd = weekdayIndex(dateKey);
  const row = schedule.find((r) => r.weekday === wd);
  if (!row || !row.workout_id) return null;
  return workouts.find((w) => w.id === row.workout_id && w.is_active) ?? null;
}

/** Sets for one exercise inside one session, in set order. */
export function setsForExercise(
  sets: WorkoutSet[],
  sessionId: string,
  exerciseId: string
): WorkoutSet[] {
  return sets
    .filter((s) => s.session_id === sessionId && s.exercise_id === exerciseId)
    .sort((a, b) => a.set_number - b.set_number);
}

/** Compact summary of one exercise's sets: "5/5/4" or "18s/15s". */
export function summarizeExerciseSets(
  exercise: WorkoutExercise,
  sets: WorkoutSet[]
): string {
  if (sets.length === 0) return "—";
  if (exercise.exercise_type === "time") {
    return sets.map((s) => `${s.duration_seconds ?? 0}s`).join(" / ");
  }
  return sets.map((s) => `${s.reps ?? 0}`).join(" / ");
}

/** One-line session summary for history rows. */
export function summarizeSession(
  session: WorkoutSession,
  workout: Workout | undefined,
  exercises: WorkoutExercise[],
  sets: WorkoutSet[]
): string {
  if (!workout) return "Workout";
  if (workout.type === "completion") {
    return session.status === "completed" ? "Completed" : session.status;
  }
  const parts = exercises.map((e) =>
    summarizeExerciseSets(e, setsForExercise(sets, session.id, e.id))
  );
  const done = parts.filter((p) => p !== "—").length;
  return `${done}/${exercises.length} exercises logged`;
}

export interface ExercisePR {
  exerciseId: string;
  /** best single set: max reps, or max seconds for time-based */
  bestSingle: number | null;
  /** best session total: sum of reps, or sum of seconds */
  bestTotal: number | null;
  unit: "reps" | "sec";
}

/**
 * Simple personal records per exercise, computed from completed sessions.
 * Only metrics that are logically appropriate: reps-based exercises get
 * rep PRs, time-based get hold PRs. No invented cross-metric scores.
 */
export function computePRs(
  exercises: WorkoutExercise[],
  sessions: WorkoutSession[],
  sets: WorkoutSet[]
): Map<string, ExercisePR> {
  const completedIds = new Set(
    sessions.filter((s) => s.status === "completed").map((s) => s.id)
  );
  const out = new Map<string, ExercisePR>();
  for (const e of exercises) {
    const unit = e.exercise_type === "time" ? "sec" : "reps";
    const vals = sets
      .filter((s) => s.exercise_id === e.id && completedIds.has(s.session_id))
      .map((s) => (unit === "sec" ? s.duration_seconds : s.reps))
      .filter((v): v is number => v !== null);
    if (vals.length === 0) {
      out.set(e.id, { exerciseId: e.id, bestSingle: null, bestTotal: null, unit });
      continue;
    }
    // totals grouped per session for bestTotal
    const perSession = new Map<string, number>();
    for (const s of sets.filter(
      (x) => x.exercise_id === e.id && completedIds.has(x.session_id)
    )) {
      const v = unit === "sec" ? s.duration_seconds ?? 0 : s.reps ?? 0;
      perSession.set(s.session_id, (perSession.get(s.session_id) ?? 0) + v);
    }
    out.set(e.id, {
      exerciseId: e.id,
      bestSingle: Math.max(...vals),
      bestTotal: Math.max(...perSession.values()),
      unit,
    });
  }
  return out;
}

/** Most recent completed session for a workout before (or on) a date. */
export function previousSession(
  sessions: WorkoutSession[],
  workoutId: string,
  beforeDateKey: string,
  excludeSessionId?: string
): WorkoutSession | undefined {
  return sessions
    .filter(
      (s) =>
        s.workout_id === workoutId &&
        s.status === "completed" &&
        s.session_date <= beforeDateKey &&
        s.id !== excludeSessionId
    )
    .sort((a, b) => b.session_date.localeCompare(a.session_date))[0];
}

/** Suggest the next set number for an exercise in a session. */
export function nextSetNumber(
  sets: WorkoutSet[],
  sessionId: string,
  exerciseId: string
): number {
  const existing = setsForExercise(sets, sessionId, exerciseId);
  return existing.length === 0
    ? 1
    : Math.max(...existing.map((s) => s.set_number)) + 1;
}
