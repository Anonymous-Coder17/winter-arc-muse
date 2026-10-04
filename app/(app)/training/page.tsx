"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  EmptyState,
  ErrorState,
  LoadingBlock,
  Modal,
} from "@/components/ui";
import { TaskForm } from "@/components/calendar/forms";
import { addDays, formatShort, todayKey } from "@/lib/dates";
import type { DailyRecord, Task } from "@/lib/types";

// V1 Training: the week's planned workouts and started sessions.
// No set history, no analytics — those are V2/V3.
export default function TrainingPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [sessions, setSessions] = useState<DailyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
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
        const start = addDays(todayKey(), -7);
        const end = addDays(todayKey(), 14);
        const [t, s] = await Promise.all([
          supabase
            .from("tasks")
            .select("*")
            .eq("kind", "workout")
            .gte("task_date", start)
            .lte("task_date", end)
            .order("task_date")
            .order("start_time", { ascending: true, nullsFirst: false }),
          supabase
            .from("daily_records")
            .select("*")
            .eq("kind", "workout_session")
            .gte("record_date", start)
            .lte("record_date", end)
            .order("created_at", { ascending: false }),
        ]);
        if (cancelled) return;
        if (t.error) throw t.error;
        if (s.error) throw s.error;
        setTasks(t.data ?? []);
        setSessions(s.data ?? []);
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
  }, [nonce]);

  const grouped = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of tasks) {
      const arr = map.get(t.task_date) ?? [];
      arr.push(t);
      map.set(t.task_date, arr);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [tasks]);

  if (loading) return <LoadingBlock />;
  if (error)
    return <ErrorState message={error} onRetry={() => setNonce((n) => n + 1)} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="page-title">Training</h1>
          <p className="page-sub">Planned workouts and completed sessions.</p>
        </div>
        <button className="btn-primary" onClick={() => setAdding(true)}>
          + Plan workout
        </button>
      </div>

      <section>
        <h2 className="section-title mb-2">Upcoming & recent workouts</h2>
        {grouped.length === 0 ? (
          <EmptyState
            title="No workouts planned"
            body="Schedule a workout from the calendar, or plan one here."
            action={
              <button className="btn-primary" onClick={() => setAdding(true)}>
                Plan your first workout
              </button>
            }
          />
        ) : (
          <div className="flex flex-col gap-3">
            {grouped.map(([date, dayTasks]) => (
              <div key={date} className="surface card-pad">
                <p className="text-xs font-medium t-secondary uppercase tracking-wide mb-2">
                  {formatShort(date)}
                </p>
                <ul className="flex flex-col gap-1.5">
                  {dayTasks.map((t) => (
                    <li key={t.id} className="flex items-center gap-2 text-sm">
                      <span
                        className={
                          t.state === "done"
                            ? "line-through t-faint"
                            : "t-primary"
                        }
                      >
                        {t.title}
                      </span>
                      <span className="text-xs t-faint">
                        {t.state === "done" ? "· done" : "· planned"}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="section-title mb-2">Recent sessions</h2>
        {sessions.length === 0 ? (
          <EmptyState
            title="No sessions yet"
            body="Use “Start workout” on the Today view to record one."
          />
        ) : (
          <div className="surface card-pad flex flex-col gap-2">
            {sessions.map((s) => (
              <p key={s.id} className="text-sm t-primary">
                {formatShort(s.record_date)} — {s.title}{" "}
                <span className="t-faint text-xs">{s.body}</span>
              </p>
            ))}
          </div>
        )}
      </section>

      {adding && (
        <Modal title="Plan workout" onClose={() => setAdding(false)}>
          <TaskForm
            dateKey={todayKey()}
            presetKind="workout"
            showDateField
            onSaved={() => {
              setAdding(false);
              setNonce((n) => n + 1);
            }}
          />
        </Modal>
      )}
    </div>
  );
}
