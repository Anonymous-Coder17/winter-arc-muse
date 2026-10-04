"use client";

import { addDays, formatShort, isToday, weekStartMonday } from "@/lib/dates";
import type { CalendarData } from "./useCalendarData";

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function WeekView({
  dateKey,
  data,
  onSelectDay,
}: {
  dateKey: string;
  data: CalendarData;
  onSelectDay: (key: string) => void;
}) {
  const start = weekStartMonday(dateKey);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));

  return (
    <div className="surface card-pad">
      <div className="grid grid-cols-7 gap-1 sm:gap-2">
        {days.map((d, i) => {
          const items = data.tasks.filter((t) => t.task_date === d).length +
            data.events.filter((e) => e.event_date === d).length;
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
              <span className="text-[10px] t-faint h-3">
                {items > 0 ? `${items} item${items > 1 ? "s" : ""}` : "·"}
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-xs t-faint mt-3 text-center">
        Tap a day to open it · week of {formatShort(start)}
      </p>
    </div>
  );
}
