"use client";

import { useEffect, useMemo, useState } from "react";
import { addDays, formatLong } from "@/lib/dates";
import { Field, Modal } from "@/components/ui";
import { TaskForm } from "./forms";
import type { CalendarData } from "./useCalendarData";
import type { Habit } from "@/lib/types";

/** Prominent next-day planning: review what's already planned for tomorrow,
 *  quickly add tasks, and make sure tomorrow's habits are active. */
export function PlanTomorrow({
  todayKey,
  data,
  onClose,
}: {
  todayKey: string;
  data: CalendarData;
  onClose: () => void;
}) {
  const tomorrow = addDays(todayKey, 1);
  const { tasks, events, refresh } = data;
  const [addingTask, setAddingTask] = useState(false);
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState(false);
  const [allHabits, setAllHabits] = useState<Habit[]>([]);
  const [habitBusy, setHabitBusy] = useState(false);
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);

  // data.habits only carries active habits; planning needs the full list so
  // paused habits can be reactivated for tomorrow.
  useEffect(() => {
    let cancelled = false;
    async function loadHabits() {
      const { createClient } = await import("@/lib/supabase/client");
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      const { data: rows } = await supabase
        .from("habits")
        .select("*")
        .eq("owner", user.id)
        .order("sort_order")
        .order("name");
      if (!cancelled && rows) setAllHabits(rows);
    }
    loadHabits();
    return () => {
      cancelled = true;
    };
  }, []);

  const tTasks = useMemo(
    () => tasks.filter((t) => t.task_date === tomorrow),
    [tasks, tomorrow]
  );
  const tEvents = useMemo(
    () => events.filter((e) => e.event_date === tomorrow),
    [events, tomorrow]
  );

  async function toggleHabitActive(habitId: string, isActive: boolean) {
    if (habitBusy) return;
    setHabitBusy(true);
    try {
      const { createClient } = await import("@/lib/supabase/client");
      const supabase = createClient();
      const { error } = await supabase
        .from("habits")
        .update({ is_active: !isActive })
        .eq("id", habitId);
      if (error) throw error;
      setAllHabits((prev) =>
        prev.map((h) =>
          h.id === habitId ? { ...h, is_active: !isActive } : h
        )
      );
      refresh();
    } catch {
      // Silent here would strand the toggle; refresh to show true state.
      refresh();
    } finally {
      setHabitBusy(false);
    }
  }

  async function saveNote() {
    if (!note.trim() || noteBusy) return;
    setNoteBusy(true);
    setNoteError(null);
    try {
      const { createClient } = await import("@/lib/supabase/client");
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in.");
      const { error } = await supabase.from("daily_records").insert({
        owner: user.id,
        record_date: tomorrow,
        kind: "note",
        title: "Plan note",
        body: note.trim(),
      });
      if (error) throw error;
      setSaved(true);
      setNote("");
      refresh();
    } catch (err) {
      setNoteError(err instanceof Error ? err.message : "Could not save note.");
    } finally {
      setNoteBusy(false);
    }
  }

  return (
    <Modal title={`Plan tomorrow — ${formatLong(tomorrow)}`} onClose={onClose}>
      <div className="flex flex-col gap-5">
        <section>
          <h3 className="section-title mb-2">Already planned</h3>
          {tTasks.length === 0 && tEvents.length === 0 ? (
            <p className="text-sm t-secondary">
              Nothing planned yet. A quiet day, or a blank page — your call.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {tEvents.map((e) => (
                <li key={e.id} className="text-sm t-primary">
                  ▦ {e.title}{" "}
                  <span className="t-faint text-xs">
                    {e.start_time.slice(0, 5)}–{e.end_time.slice(0, 5)}
                  </span>
                </li>
              ))}
              {tTasks.map((t) => (
                <li key={t.id} className="text-sm t-primary">
                  ☐ {t.title}
                  {t.start_time && (
                    <span className="t-faint text-xs">
                      {" "}
                      · {t.start_time.slice(0, 5)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {!addingTask ? (
            <button
              className="btn-secondary mt-3"
              onClick={() => setAddingTask(true)}
            >
              + Add a task for tomorrow
            </button>
          ) : (
            <div className="mt-3 surface-elevated card-pad">
              <TaskForm
                dateKey={tomorrow}
                onSaved={() => {
                  setAddingTask(false);
                  refresh();
                }}
              />
              <button
                className="btn-ghost mt-2"
                onClick={() => setAddingTask(false)}
              >
                Cancel
              </button>
            </div>
          )}
        </section>

        <section>
          <h3 className="section-title mb-2">Tomorrow&apos;s habits</h3>
          <p className="text-xs t-faint mb-2">
            Only active habits appear on the day view. Toggle what applies
            tomorrow.
          </p>
          {allHabits.length === 0 ? (
            <p className="text-sm t-secondary">
              No habits yet — create them on the Habits page.
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {allHabits.map((h) => (
                <div
                  key={h.id}
                  className="flex items-center justify-between gap-3 rounded-xl px-3 py-2 hover:bg-black/5 dark:hover:bg-white/5"
                >
                  <span className="text-sm t-primary">{h.name}</span>
                  <button
                    className={`seg-btn !min-h-[36px] ${h.is_active ? "seg-btn-active" : ""}`}
                    disabled={habitBusy}
                    onClick={() => toggleHabitActive(h.id, h.is_active)}
                  >
                    {h.is_active ? "Active" : "Paused"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <Field label="A note to tomorrow's you (optional)">
            <textarea
              className="textarea"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="One intention. Keep it small."
            />
          </Field>
          <button
            className="btn-secondary mt-2"
            disabled={!note.trim() || noteBusy}
            onClick={saveNote}
          >
            {noteBusy ? "Saving…" : "Save note"}
          </button>
          {noteError && (
            <p className="text-sm text-red-500 dark:text-red-400 mt-2" role="alert">
              {noteError}
            </p>
          )}
          {saved && (
            <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-2">
              Saved — it will be waiting on tomorrow&apos;s day view.
            </p>
          )}
        </section>

        <button className="btn-primary" onClick={onClose}>
          Done planning
        </button>
      </div>
    </Modal>
  );
}
