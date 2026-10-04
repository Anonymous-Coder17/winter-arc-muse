"use client";

import { useMemo, useState } from "react";
import {
  EmptyState,
  ErrorState,
  LoadingBlock,
  Modal,
} from "@/components/ui";
import { useTraining, exercisesFor } from "@/components/training/useTraining";
import {
  ExerciseManager,
  ScheduleEditor,
  WorkoutModal,
} from "@/components/training/manage";
import { SessionLogger } from "@/components/training/logger";
import { ExercisePRs, TrainingHistory } from "@/components/training/history";
import { scheduledWorkoutForDate } from "@/lib/training";
import { todayKey } from "@/lib/dates";
import type { Workout } from "@/lib/types";

export default function TrainingPage() {
  const data = useTraining();
  const { workouts, exercises, schedule, sessions, sets } = data;
  const [logging, setLogging] = useState<Workout | null>(null);
  const [managing, setManaging] = useState<Workout | null>(null);
  const [addingWorkout, setAddingWorkout] = useState(false);
  const [editingWorkout, setEditingWorkout] = useState<Workout | null>(null);

  const today = todayKey();
  const todaysWorkout = useMemo(
    () => scheduledWorkoutForDate(schedule, workouts, today),
    [schedule, workouts, today]
  );
  const todaysSession = useMemo(
    () =>
      sessions.find(
        (s) =>
          s.session_date === today &&
          s.workout_id === todaysWorkout?.id &&
          (s.status === "completed" || s.status === "in_progress")
      ),
    [sessions, today, todaysWorkout]
  );

  if (data.loading) return <LoadingBlock />;
  if (data.error)
    return <ErrorState message={data.error} onRetry={data.refresh} />;

  const structured = workouts.filter((w) => w.type === "structured");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="page-title">Training</h1>
          <p className="page-sub">What to train, what you did, how you progress.</p>
        </div>
        <button className="btn-primary shrink-0" onClick={() => setAddingWorkout(true)}>
          + Workout
        </button>
      </div>

      {/* today */}
      <section aria-label="Today's training">
        <h2 className="section-title mb-2">Today</h2>
        {todaysWorkout ? (
          <div className="surface card-pad flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold t-primary">{todaysWorkout.name}</p>
              <p className="text-xs t-secondary">
                {todaysWorkout.type === "structured"
                  ? `${exercisesFor(exercises, todaysWorkout.id).length} exercises`
                  : (todaysWorkout.description ?? "Completion workout")}
                {todaysSession?.status === "completed" ? " · ✓ completed" : ""}
                {todaysSession?.status === "in_progress" ? " · in progress" : ""}
              </p>
            </div>
            <button
              className="btn-primary !min-h-[48px] shrink-0"
              onClick={() => setLogging(todaysWorkout)}
            >
              {todaysSession?.status === "in_progress"
                ? "Continue"
                : todaysSession?.status === "completed"
                  ? "Log again"
                  : "Start workout"}
            </button>
          </div>
        ) : (
          <div className="surface card-pad">
            <p className="text-sm font-semibold t-primary tracking-wide">REST DAY</p>
            <p className="text-xs t-secondary mt-1">
              Recovery is part of the plan — not a missed workout.
            </p>
          </div>
        )}
      </section>

      {/* workouts */}
      <section aria-label="Workouts">
        <h2 className="section-title mb-2">Workouts</h2>
        {workouts.length === 0 ? (
          <EmptyState
            title="No workouts yet"
            body="Create your first workout — structured with sets, or a simple completion workout."
            action={
              <button className="btn-primary" onClick={() => setAddingWorkout(true)}>
                Create workout
              </button>
            }
          />
        ) : (
          <div className="flex flex-col gap-2">
            {workouts.map((w) => (
              <div key={w.id} className="surface card-pad !p-3">
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium t-primary">
                      {w.name}
                      {!w.is_active && (
                        <span className="text-xs t-faint font-normal"> · paused</span>
                      )}
                    </p>
                    <p className="text-xs t-faint">
                      {w.type === "structured"
                        ? `${exercisesFor(exercises, w.id).length} exercises`
                        : (w.description ?? "Completion")}
                    </p>
                  </div>
                  {w.type === "structured" && (
                    <button
                      className="btn-ghost !min-h-[40px] !px-3 text-xs shrink-0"
                      onClick={() => setManaging(w)}
                    >
                      Exercises
                    </button>
                  )}
                  <button
                    className="btn-ghost !min-h-[40px] !px-3 text-xs shrink-0"
                    onClick={() => setEditingWorkout(w)}
                  >
                    Edit
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* schedule */}
      <section aria-label="Weekly schedule">
        <h2 className="section-title mb-2">Weekly schedule</h2>
        <ScheduleEditor
          schedule={schedule}
          workouts={workouts}
          onChanged={data.refresh}
        />
      </section>

      {/* personal records */}
      {structured.map((w) => (
        <ExercisePRs
          key={w.id}
          workout={w}
          exercises={exercises}
          sessions={sessions}
          sets={sets}
        />
      ))}

      {/* history */}
      <section aria-label="History">
        <h2 className="section-title mb-2">History</h2>
        <TrainingHistory
          sessions={sessions}
          sets={sets}
          exercises={exercises}
          workouts={workouts}
        />
      </section>

      {addingWorkout && (
        <WorkoutModal
          title="New workout"
          onClose={() => setAddingWorkout(false)}
          onSaved={data.refresh}
        />
      )}
      {editingWorkout && (
        <WorkoutModal
          title="Edit workout"
          initial={editingWorkout}
          onClose={() => setEditingWorkout(null)}
          onSaved={data.refresh}
        />
      )}
      {managing && (
        <Modal title={`${managing.name} — exercises`} onClose={() => setManaging(null)}>
          <ExerciseManager
            workout={managing}
            exercises={exercises}
            onChanged={data.refresh}
          />
        </Modal>
      )}
      {logging && (
        <SessionLogger
          workout={logging}
          exercises={exercises}
          sessions={sessions}
          sets={sets}
          dateKey={today}
          onClose={() => setLogging(null)}
          onSaved={data.refresh}
        />
      )}
    </div>
  );
}
