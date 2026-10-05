"use client";

import { useMemo } from "react";
import { scheduledWorkoutForDate } from "@/lib/training";
import type { TrainingData } from "@/components/training/useTraining";
import type { CalendarData } from "./useCalendarData";
import { addDays, eventCoversDate, formatShort, isToday, weekStartMonday } from "@/lib/dates";

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function WeekView({
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
  const start = weekStartMonday(dateKey);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  // V4.5: all-day events overlapping this week, shown as a date-level list
  // with their spans — never as misleading hourly blocks.
  const weekAllDay = useMemo(
    () =>
      data.events
        .filter(
          (e) => e.is_all_day && days.some((d) => eventCoversDate(e, d))
        )
        .sort((a, b) => a.event_date.localeCompare(b.event_date)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.events, start]
  );

  return (
    <div className="surface card-pad">
      <div className="grid grid-cols-7 gap-1 sm:gap-2">
        {days.map((d, i) => {
          const items = data.tasks.filter((t) => t.task_date === d).length +
            data.events.filter((e) => e.event_date === d).length;
          const scheduled = training
            ? scheduledWorkoutForDate(training.schedule, training.workouts, d)
            : null;
          const today = isToday(d);
          return (
            <button
              key={d}
              onClick={() => onSelectDay(d)}
              className={`flex flex-col items-center gap-1 rounded-xl py-2 sm:py-3 transition-colors touch-manipulation ${
                today
                  ? "bg-[#5A6AE0]/15"
                  : "hover:bg-black/5 dark:hover:bg-white/5"
              }`}
            >
              <span className="text-[11px] t-faint">{DOW[i]}</span>
              <span
                className={`w-9 h-9 flex items-center justify-center rounded-full text-sm font-medium ${
                  today ? "bg-[#5A6AE0] text-white" : "t-primary"
                }`}
              >
                {Number(d.slice(8))}
              </span>
              <span className="text-[10px] t-faint h-3 truncate max-w-full">
                {items > 0 ? `${items} item${items > 1 ? "s" : ""}` : "·"}
                {scheduled ? ` · ${scheduled.name}` : ""}
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-xs t-faint mt-3 text-center">
        Tap a day to open it · week of {formatShort(start)}
      </p>
      {weekAllDay.length > 0 && (
        <div className="mt-3 border-t hairline pt-3" aria-label="All-day this week">
          <p className="text-[11px] uppercase tracking-wide t-faint mb-2">
            All-day
          </p>
          <ul className="flex flex-col gap-1.5">
            {weekAllDay.map((e) => {
              const multiDay =
                e.end_date != null && e.end_date > e.event_date;
              return (
                <li
                  key={e.id}
                  className="flex items-center gap-2 text-sm min-w-0"
                >
                  <span
                    className="w-1 self-stretch rounded-full bg-[#7C8CF8] shrink-0"
                    aria-hidden
                  />
                  <span className="t-primary truncate flex-1 min-w-0">
                    {e.title}
                  </span>
                  <span className="text-[11px] t-faint shrink-0 tabular-nums">
                    {multiDay
                      ? `${formatShort(e.event_date)} → ${formatShort(e.end_date!)}`
                      : formatShort(e.event_date)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
