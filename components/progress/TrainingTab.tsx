"use client";

import { useMemo, useState } from "react";
import { EmptyState, StateDot } from "@/components/ui";
import { formatLong } from "@/lib/dates";
import { Sparkline } from "./charts";
import { exerciseProgress, trainingSummary } from "./normalize";
import type { ProgressData, Range } from "./types";

const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Training: completion stats, exercise progression, session history. */
export function TrainingTab({
  data,
  range,
}: {
  data: ProgressData;
  range: Range;
}) {
  const summary = useMemo(
    () => trainingSummary(data.sessions, data.schedule, range),
    [data.sessions, data.schedule, range]
  );
  const progression = useMemo(
    () =>
      exerciseProgress(data.exercises, data.sessions, data.sets, range).filter(
        (e) => e.points.length > 0
      ),
    [data.exercises, data.sessions, data.sets, range]
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    progression.find((e) => e.exerciseId === selectedId) ??
    progression[0] ??
    null;

  const workoutName = useMemo(() => {
    const m = new Map(data.workouts.map((w) => [w.id, w.name]));
    return (id: string) => m.get(id) ?? "Workout";
  }, [data.workouts]);

  const sessions = useMemo(
    () =>
      [...data.sessions]
        .filter((s) => s.session_date >= range.start && s.session_date <= range.end)
        .sort((a, b) => (a.session_date < b.session_date ? 1 : -1)),
    [data.sessions, range]
  );
  const setsBySession = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of data.sets) m.set(s.session_id, (m.get(s.session_id) ?? 0) + 1);
    return m;
  }, [data.sets]);

  const restWeekdays = useMemo(
    () =>
      data.schedule
        .filter((r) => r.workout_id === null)
        .map((r) => WEEKDAY_NAMES[r.weekday] ?? "")
        .filter(Boolean),
    [data.schedule]
  );

  const hasTraining = data.workouts.length > 0 || data.sessions.length > 0;

  return (
    <div className="flex flex-col gap-4">
      {/* completion */}
      <section className="surface card-pad" aria-label="Training completion">
        <h2 className="section-title mb-1">Completion</h2>
        {summary.planned === 0 && summary.completed === 0 ? (
          <p className="text-sm t-secondary mt-1">
            No planned or completed sessions in this range.
          </p>
        ) : (
          <p className="text-sm t-primary tabular-nums mt-1">
            {summary.completed} of {summary.planned} planned sessions completed
            {summary.completionPct !== null && (
              <span className="t-secondary">
                {" "}
                · {Math.round(summary.completionPct)}%
              </span>
            )}
          </p>
        )}
        <p className="text-xs t-faint mt-2">
          {summary.restDays} rest day{summary.restDays === 1 ? "" : "s"} in
          range
          {restWeekdays.length > 0 ? ` (${restWeekdays.join(", ")})` : ""} —
          rest is scheduled recovery, never a miss.
        </p>
      </section>

      {/* exercise progression */}
      <section aria-label="Exercise progression">
        <h2 className="section-title mb-2">Exercise progression</h2>
        {!hasTraining ? (
          <EmptyState
            title="No training data yet"
            body="Log a workout from the Training area to see progression here."
          />
        ) : progression.length === 0 ? (
          <EmptyState
            title="No progression data in this range"
            body="Exercises with recorded sets will appear here."
          />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label="Exercises">
              {progression.map((e) => (
                <button
                  key={e.exerciseId}
                  role="tab"
                  aria-selected={selected?.exerciseId === e.exerciseId}
                  onClick={() => setSelectedId(e.exerciseId)}
                  className={`whitespace-nowrap rounded-full px-3.5 py-2 text-sm font-medium min-h-[40px] touch-manipulation border transition-colors ${
                    selected?.exerciseId === e.exerciseId
                      ? "bg-[#5A6AE0]/15 text-[#3D4AC4] dark:text-[#C3CCFF] border-[#5A6AE0]/30"
                      : "t-secondary border-transparent hover:t-primary"
                  }`}
                >
                  {e.name}
                </button>
              ))}
            </div>
            {selected && (
              <div className="surface card-pad">
                <h3 className="text-sm font-medium t-primary">
                  {selected.name}
                  <span className="ml-2 text-[11px] font-normal t-faint">
                    {selected.type === "time" ? "timed" : "reps"}
                  </span>
                </h3>
                <dl className="grid grid-cols-3 gap-2 mt-3 text-center">
                  {(
                    [
                      ["First", selected.first],
                      ["Latest", selected.latest],
                      ["Best", selected.best],
                    ] as const
                  ).map(([label, value]) => (
                    <div
                      key={label}
                      className="rounded-xl border hairline px-2 py-2.5"
                    >
                      <dt className="text-[11px] t-faint">{label}</dt>
                      <dd className="text-sm t-primary tabular-nums mt-0.5">
                        {value ?? "—"}
                      </dd>
                    </div>
                  ))}
                </dl>
                <div className="mt-3">
                  <Sparkline
                    points={selected.points.map((p) => ({
                      date: p.date,
                      value: p.value,
                      label: p.label || formatLong(p.date),
                    }))}
                  />
                </div>
                <p className="text-[11px] t-faint mt-1">
                  {selected.points.length} recorded point
                  {selected.points.length === 1 ? "" : "s"} in range.
                </p>
              </div>
            )}
          </div>
        )}
      </section>

      {/* session history */}
      <section aria-label="Session history">
        <h2 className="section-title mb-2">Session history</h2>
        {sessions.length === 0 ? (
          <p className="text-sm t-secondary">No sessions in this range.</p>
        ) : (
          <div className="surface card-pad flex flex-col divide-y divide-[#E5E7EB] dark:divide-[#242932] !py-1">
            {sessions.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm t-primary truncate">
                    {workoutName(s.workout_id)}
                  </p>
                  <p className="text-xs t-faint">
                    {formatLong(s.session_date)}
                    {s.notes ? ` · ${s.notes}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs t-secondary tabular-nums">
                    {setsBySession.get(s.id) ?? 0} sets
                  </span>
                  <StateDot
                    tone={
                      s.status === "completed"
                        ? "ok"
                        : s.status === "in_progress"
                          ? "warn"
                          : "idle"
                    }
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
