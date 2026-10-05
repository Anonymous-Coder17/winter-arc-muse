"use client";

import { useMemo } from "react";
import { scheduledWorkoutForDate } from "@/lib/training";
import type { TrainingData } from "@/components/training/useTraining";
import type { CalendarData } from "./useCalendarData";
import { eventCoversDate, formatShort, isToday, monthGridStart, toDayKey } from "@/lib/dates";

const DOW = ["M", "T", "W", "T", "F", "S", "S"];

export function MonthView({
  dateKey,
  data,
  training,
  onSelectDay,
}: {
  dateKey: string;
  data: CalendarData;
  training?: TrainingData;
  onSelectDay: (key: string) => void;
}) {
  const year = Number(dateKey.slice(0, 4));
  const month = Number(dateKey.slice(5, 7)) - 1;

  const cells = useMemo(() => {
    const start = monthGridStart(year, month);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return toDayKey(d);
    });
  }, [year, month]);

  const label = new Date(year, month, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  return (
    <div className="surface card-pad">
      <h3 className="section-title mb-3 text-center">{label}</h3>
      <div className="grid grid-cols-7 gap-1">
        {DOW.map((d, i) => (
          <div key={i} className="text-center text-[11px] t-faint py-1">
            {d}
          </div>
        ))}
        {cells.map((d) => {
          const inMonth = d.slice(0, 7) === dateKey.slice(0, 7);
          const scheduled = training
            ? scheduledWorkoutForDate(training.schedule, training.workouts, d)
            : null;
          const items =
            data.tasks.filter((t) => t.task_date === d).length +
            // V4.5: multi-day all-day events count on every date they cover.
            data.events.filter((e) => eventCoversDate(e, d)).length +
            (scheduled ? 1 : 0);
          const done = data.tasks.filter(
            (t) => t.task_date === d && t.state === "done"
          ).length;
          const today = isToday(d);
          return (
            <button
              key={d}
              onClick={() => onSelectDay(d)}
              disabled={!inMonth}
              aria-label={`${formatShort(d)}: ${items} ${items === 1 ? "item" : "items"}, ${done} done`}
              className={`flex flex-col items-center rounded-lg py-1.5 min-h-[48px] transition-colors touch-manipulation ${
                today
                  ? "bg-[#5A6AE0]/15"
                  : inMonth
                    ? "hover:bg-black/5 dark:hover:bg-white/5"
                    : "opacity-30"
              }`}
            >
              <span
                className={`w-7 h-7 flex items-center justify-center rounded-full text-[13px] ${
                  today ? "bg-[#5A6AE0] text-white font-semibold" : "t-primary"
                }`}
              >
                {Number(d.slice(8))}
              </span>
              <span className="flex gap-0.5 mt-0.5 h-1.5">
                {items > 0 && (
                  <span className="w-1.5 h-1.5 rounded-full bg-[#7C8CF8]" />
                )}
                {done > 0 && (
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                )}
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-xs t-faint mt-3 text-center">
        Tap a day to open it. No scores here — dots only mark what exists.
      </p>
      <p className="text-[11px] t-faint mt-2 text-center">
        <span className="inline-flex items-center gap-1 mr-4">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#7C8CF8]" aria-hidden="true" />
          Items
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
          Done
        </span>
      </p>
    </div>
  );
}
