"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { toggleHabitDone } from "@/lib/habits";
import { formatLong, isToday, timeLabel } from "@/lib/dates";
import { EmptyState, Modal, StateDot } from "@/components/ui";
import { EventForm, TaskForm } from "./forms";
import { TodayPanel } from "@/components/today/TodayPanel";
import { logFor, type CalendarData } from "./useCalendarData";
import type { CalendarEvent, Task } from "@/lib/types";

export function DayView({
  dateKey,
  data,
}: {
  dateKey: string;
  data: CalendarData;
}) {
  const { tasks, events, habits, habitLogs, refresh } = data;
  const [adding, setAdding] = useState<"task" | "event" | null>(null);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  const dayTasks = useMemo(
    () => tasks.filter((t) => t.task_date === dateKey),
    [tasks, dateKey]
  );
  const dayEvents = useMemo(
    () =>
      [...events.filter((e) => e.event_date === dateKey)].sort((a, b) =>
        a.start_time.localeCompare(b.start_time)
      ),
    [events, dateKey]
  );

  async function onToggleTask(task: Task) {
    const supabase = createClient();
    const next = task.state === "done" ? "planned" : "done";
    const { error } = await supabase
      .from("tasks")
      .update({ state: next })
      .eq("id", task.id);
    if (!error) refresh();
  }

  async function onToggleHabit(habitId: string) {
    const habit = habits.find((h) => h.id === habitId);
    if (!habit || toggling) return;
    setToggling(habitId);
    try {
      const done = logFor(habitLogs, habitId, dateKey)?.status === "done";
      await toggleHabitDone(habit, dateKey, done);
      refresh();
    } finally {
      setToggling(null);
    }
  }

  const doneCount = habits.filter(
    (h) => logFor(habitLogs, h.id, dateKey)?.status === "done"
  ).length;

  return (
    <div className="flex flex-col gap-4">
      {/* header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="page-title">{formatLong(dateKey)}</h2>
          <p className="page-sub">
            {isToday(dateKey) ? "Today · " : ""}
            {habits.length > 0
              ? `${doneCount} of ${habits.length} habits logged`
              : "No habits yet"}
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button className="btn-secondary !px-3" onClick={() => setAdding("event")}>
            + Event
          </button>
          <button className="btn-primary !px-3" onClick={() => setAdding("task")}>
            + Task
          </button>
        </div>
      </div>

      {/* timeline */}
      <section aria-label="Timeline">
        <h3 className="section-title mb-2">Timeline</h3>
        {dayEvents.length === 0 && dayTasks.length === 0 ? (
          <EmptyState
            title="Nothing scheduled"
            body="Add a task or event to start shaping this day."
            action={
              <button className="btn-primary" onClick={() => setAdding("task")}>
                Plan something
              </button>
            }
          />
        ) : (
          <div className="surface card-pad flex flex-col gap-1">
            {dayEvents.map((e) => (
              <button
                key={`e-${e.id}`}
                onClick={() => setEditingEvent(e)}
                className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              >
                <span className="text-xs t-faint w-24 shrink-0 tabular-nums">
                  {timeLabel(e.start_time)}–{timeLabel(e.end_time)}
                </span>
                <span className="w-1 self-stretch rounded-full bg-[#7C8CF8]" aria-hidden />
                <span className="text-sm t-primary flex-1">{e.title}</span>
                <span className="text-[11px] t-faint uppercase tracking-wide">
                  Planned
                </span>
              </button>
            ))}
            {dayTasks.map((t) => (
              <div
                key={`t-${t.id}`}
                className="flex items-center gap-3 rounded-xl px-3 py-2.5"
              >
                <button
                  onClick={() => onToggleTask(t)}
                  aria-label={t.state === "done" ? "Mark as planned" : "Mark as done"}
                  className={`w-6 h-6 shrink-0 rounded-lg border-2 flex items-center justify-center transition-colors touch-manipulation ${
                    t.state === "done"
                      ? "bg-[#5A6AE0] border-[#5A6AE0] text-white"
                      : "hairline t-faint hover:border-[#7C8CF8]"
                  }`}
                >
                  {t.state === "done" && <span className="text-sm">✓</span>}
                </button>
                <button
                  onClick={() => setEditingTask(t)}
                  className="flex-1 flex items-center gap-3 text-left min-w-0"
                >
                  {(t.start_time || t.end_time) && (
                    <span className="text-xs t-faint w-24 shrink-0 tabular-nums">
                      {timeLabel(t.start_time)}
                      {t.end_time ? `–${timeLabel(t.end_time)}` : ""}
                    </span>
                  )}
                  <span
                    className={`text-sm flex-1 truncate ${
                      t.state === "done"
                        ? "line-through t-faint"
                        : "t-primary"
                    }`}
                  >
                    {t.title}
                  </span>
                  <span className="flex items-center gap-1.5 shrink-0">
                    <StateDot
                      tone={
                        t.state === "done"
                          ? "ok"
                          : t.state === "not_done"
                            ? "warn"
                            : "idle"
                      }
                    />
                    <span className="text-[11px] t-faint uppercase tracking-wide hidden sm:inline">
                      {t.state === "done"
                        ? "Done"
                        : t.state === "not_done"
                          ? "Not done"
                          : "Planned"}
                    </span>
                  </span>
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* habits */}
      <section aria-label="Habits">
        <h3 className="section-title mb-2">Habits</h3>
        {habits.length === 0 ? (
          <EmptyState
            title="No habits yet"
            body="Create your first habit to start logging daily."
            action={
              <Link href="/habits" className="btn-primary">
                Go to Habits
              </Link>
            }
          />
        ) : (
          <div className="surface card-pad flex flex-col gap-1">
            {habits.map((h) => {
              const log = logFor(habitLogs, h.id, dateKey);
              const done = log?.status === "done";
              return (
                <div key={h.id} className="flex items-center gap-3 rounded-xl px-3 py-2.5">
                  <button
                    onClick={() => onToggleHabit(h.id)}
                    disabled={toggling === h.id}
                    aria-label={done ? `Unmark ${h.name}` : `Mark ${h.name} done`}
                    className={`w-6 h-6 shrink-0 rounded-full border-2 flex items-center justify-center transition-colors touch-manipulation ${
                      done
                        ? "bg-emerald-500 border-emerald-500 text-white"
                        : "hairline t-faint hover:border-emerald-500"
                    }`}
                  >
                    {done && <span className="text-sm">✓</span>}
                  </button>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm ${done ? "t-primary" : "t-primary"}`}>
                      {h.name}
                    </p>
                    {h.frequency === "weekly" && h.weekly_target && (
                      <p className="text-xs t-faint">
                        {h.weekly_target}× per week · optional
                      </p>
                    )}
                  </div>
                  {log?.status === "not_done" && (
                    <span className="text-[11px] t-faint uppercase tracking-wide">
                      Not done
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* today dashboard: only on the current day */}
      {isToday(dateKey) && <TodayPanel dateKey={dateKey} data={data} />}

      {adding === "task" && (
        <Modal title="New task" onClose={() => setAdding(null)}>
          <TaskForm
            dateKey={dateKey}
            onSaved={() => {
              setAdding(null);
              refresh();
            }}
          />
        </Modal>
      )}
      {adding === "event" && (
        <Modal title="New event" onClose={() => setAdding(null)}>
          <EventForm
            dateKey={dateKey}
            onSaved={() => {
              setAdding(null);
              refresh();
            }}
          />
        </Modal>
      )}
      {editingTask && (
        <Modal title="Edit task" onClose={() => setEditingTask(null)}>
          <TaskForm
            dateKey={editingTask.task_date}
            initial={editingTask}
            onSaved={() => {
              setEditingTask(null);
              refresh();
            }}
            onDeleted={() => {
              setEditingTask(null);
              refresh();
            }}
          />
        </Modal>
      )}
      {editingEvent && (
        <Modal title="Edit event" onClose={() => setEditingEvent(null)}>
          <EventForm
            dateKey={editingEvent.event_date}
            initial={editingEvent}
            onSaved={() => {
              setEditingEvent(null);
              refresh();
            }}
            onDeleted={() => {
              setEditingEvent(null);
              refresh();
            }}
          />
        </Modal>
      )}
    </div>
  );
}
