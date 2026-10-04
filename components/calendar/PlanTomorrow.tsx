"use client";

import { useMemo, useState } from "react";
import { addDays, formatLong } from "@/lib/dates";
import { Field, Modal } from "@/components/ui";
import { TaskForm } from "./forms";
import type { CalendarData } from "./useCalendarData";

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
  const { tasks, events, habits, habitLogs, refresh } = data;
  const [addingTask, setAddingTask] = useState(false);
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState(false);

  const tTasks = useMemo(
    () => tasks.filter((t) => t.task_date === tomorrow),
    [tasks, tomorrow]
  );
  const tEvents = useMemo(
    () => events.filter((e) => e.event_date === tomorrow),
    [events, tomorrow]
  );

  async function toggleHabitActive(habitId: string, isActive: boolean) {
    const { createClient } = await import("@/lib/supabase/client");
    const supabase = createClient();
    await supabase
      .from("habits")
      .update({ is_active: !isActive })
      .eq("id", habitId);
    refresh();
  }

  async function saveNote() {
    if (!note.trim()) return;
    const { createClient } = await import("@/lib/supabase/client");
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    await supabase.from("daily_records").insert({
      owner: user.id,
      record_date: tomorrow,
      kind: "note",
      title: "Plan note",
      body: note.trim(),
    });
    setSaved(true);
    setNote("");
    refresh();
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
          <div className="flex flex-col gap-1">
            {habits.map((h) => (
              <div
                key={h.id}
                className="flex items-center justify-between gap-3 rounded-xl px-3 py-2 hover:bg-black/5 dark:hover:bg-white/5"
              >
                <span className="text-sm t-primary">{h.name}</span>
                <button
                  className={`seg-btn !min-h-[36px] ${h.is_active ? "seg-btn-active" : ""}`}
                  onClick={() => toggleHabitActive(h.id, h.is_active)}
                >
                  {h.is_active ? "Active" : "Paused"}
                </button>
              </div>
            ))}
          </div>
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
            disabled={!note.trim()}
            onClick={saveNote}
          >
            Save note
          </button>
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
