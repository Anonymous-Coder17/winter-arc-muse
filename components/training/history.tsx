"use client";

import { useMemo, useState } from "react";
import { Modal, EmptyState } from "@/components/ui";
import {
  computePRs,
  setsForExercise,
  summarizeExerciseSets,
  summarizeSession,
} from "@/lib/training";
import { formatDuration, formatLong } from "@/lib/dates";
import { exercisesFor } from "./useTraining";
import type {
  Workout,
  WorkoutExercise,
  WorkoutSession,
  WorkoutSet,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// SessionDetail — read-only view of a past session
// ---------------------------------------------------------------------------

export function SessionDetailModal({
  session,
  workout,
  exercises,
  sets,
  onClose,
}: {
  session: WorkoutSession;
  workout: Workout | undefined;
  exercises: WorkoutExercise[];
  sets: WorkoutSet[];
  onClose: () => void;
}) {
  const exList = useMemo(
    () => (workout ? exercisesFor(exercises, workout.id) : []),
    [exercises, workout]
  );
  return (
    <Modal title={`${workout?.name ?? "Workout"} — ${formatLong(session.session_date)}`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-xs t-faint uppercase tracking-wide">
          {session.status === "completed"
            ? "Completed"
            : session.status === "cancelled"
              ? "Cancelled"
              : "In progress"}
        </p>
        {workout?.type === "structured" ? (
          exList.map((ex) => {
            const exSets = setsForExercise(sets, session.id, ex.id);
            if (exSets.length === 0) return null;
            return (
              <div key={ex.id}>
                <p className="text-sm font-medium t-primary mb-1">{ex.name}</p>
                <p className="text-sm t-secondary tabular-nums">
                  {summarizeExerciseSets(ex, exSets)}
                  {ex.exercise_type === "time" ? "" : " reps"}
                </p>
              </div>
            );
          })
        ) : (
          <p className="text-sm t-secondary">
            {session.status === "completed" ? "Completed." : "Not completed."}
          </p>
        )}
        {session.notes && (
          <div>
            <p className="label">Notes</p>
            <p className="text-sm t-primary whitespace-pre-wrap">{session.notes}</p>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// TrainingHistory — past sessions, newest first
// ---------------------------------------------------------------------------

export function TrainingHistory({
  sessions,
  sets,
  exercises,
  workouts,
}: {
  sessions: WorkoutSession[];
  sets: WorkoutSet[];
  exercises: WorkoutExercise[];
  workouts: Workout[];
}) {
  const [open, setOpen] = useState<WorkoutSession | null>(null);

  const sorted = useMemo(
    () =>
      [...sessions].sort((a, b) =>
        b.session_date.localeCompare(a.session_date) ||
        b.started_at.localeCompare(a.started_at)
      ),
    [sessions]
  );

  if (sorted.length === 0) {
    return (
      <EmptyState
        title="No sessions yet"
        body="Your completed workouts will appear here with full set history."
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {sorted.map((s) => {
        const w = workouts.find((x) => x.id === s.workout_id);
        const exList = w ? exercisesFor(exercises, w.id) : [];
        return (
          <button
            key={s.id}
            onClick={() => setOpen(s)}
            className="surface card-pad !p-3 flex items-center gap-3 text-left hover:border-[#7C8CF8]/50 transition-colors"
          >
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium t-primary">
                {w?.name ?? "Workout"}
              </p>
              <p className="text-xs t-faint">
                {formatLong(s.session_date)} ·{" "}
                {summarizeSession(s, w, exList, sets)}
              </p>
            </div>
            <span
              className={`text-[11px] uppercase tracking-wide shrink-0 ${
                s.status === "completed"
                  ? "text-emerald-500"
                  : s.status === "cancelled"
                    ? "t-faint"
                    : "text-amber-500"
              }`}
            >
              {s.status === "completed"
                ? "Done"
                : s.status === "cancelled"
                  ? "Cancelled"
                  : "In progress"}
            </span>
          </button>
        );
      })}
      {open && (
        <SessionDetailModal
          session={open}
          workout={workouts.find((w) => w.id === open.workout_id)}
          exercises={exercises}
          sets={sets}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ExercisePRs — simple personal records, only where logically appropriate
// ---------------------------------------------------------------------------

export function ExercisePRs({
  workout,
  exercises,
  sessions,
  sets,
}: {
  workout: Workout;
  exercises: WorkoutExercise[];
  sessions: WorkoutSession[];
  sets: WorkoutSet[];
}) {
  const exList = useMemo(
    () => exercisesFor(exercises, workout.id),
    [exercises, workout.id]
  );
  const prs = useMemo(
    () => computePRs(exList, sessions, sets),
    [exList, sessions, sets]
  );
  const withPR = exList.filter((e) => prs.get(e.id)?.bestSingle !== null);
  if (withPR.length === 0) return null;

  return (
    <div className="surface card-pad">
      <h3 className="section-title mb-2">Personal records</h3>
      <div className="flex flex-col gap-2">
        {withPR.map((e) => {
          const pr = prs.get(e.id)!;
          const unit = pr.unit === "sec" ? "sec" : "reps";
          return (
            <div key={e.id} className="flex items-center justify-between gap-3">
              <span className="text-sm t-primary">{e.name}</span>
              <span className="text-xs t-secondary tabular-nums text-right">
                Best set: {pr.bestSingle} {unit}
                {" · "}Best session:{" "}
                {pr.unit === "sec"
                  ? formatDuration(pr.bestTotal ?? 0)
                  : `${pr.bestTotal} ${unit}`}
              </span>
            </div>
          );
        })}
      </div>
      <p className="text-xs t-faint mt-2">
        From completed sessions only. No scores — just your bests.
      </p>
    </div>
  );
}
