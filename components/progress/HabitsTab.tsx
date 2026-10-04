"use client";

import { useMemo, useState } from "react";
import { EmptyState, StateDot } from "@/components/ui";
import { formatShort } from "@/lib/dates";
import { RatioBar } from "./charts";
import { habitStats, rangeDays } from "./normalize";
import type { ProgressData, Range } from "./types";

/** Per-habit consistency with active-days denominator, plus daily history. */
export function HabitsTab({
  data,
  range,
}: {
  data: ProgressData;
  range: Range;
}) {
  const stats = useMemo(
    () => habitStats(data.habits, data.habitLogs, range),
    [data.habits, data.habitLogs, range]
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const days = useMemo(() => rangeDays(range), [range]);

  const logsByHabitDay = useMemo(() => {
    const m = new Map<string, { status: string; value: number | null }>();
    for (const l of data.habitLogs) {
      m.set(`${l.habit_id}|${l.log_date}`, {
        status: l.status,
        value: l.value,
      });
    }
    return m;
  }, [data.habitLogs]);

  if (data.habits.length === 0) {
    return (
      <EmptyState
        title="No habits yet"
        body="Add habits from the Habits area to see consistency here."
      />
    );
  }

  const selected = stats.find((s) => s.habitId === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <section className="surface card-pad" aria-label="Habit consistency">
        <h2 className="section-title mb-1">Consistency</h2>
        <p className="text-xs t-faint mb-3">
          Done days over active days in the range. Independent per habit —
          nothing is combined into a score.
        </p>
        <div className="flex flex-col gap-3">
          {stats.map((s) => (
            <button
              key={s.habitId}
              onClick={() =>
                setSelectedId(selectedId === s.habitId ? null : s.habitId)
              }
              aria-expanded={selectedId === s.habitId}
              className="text-left touch-manipulation"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium t-primary">
                  {s.name}
                  <span className="ml-2 text-[11px] font-normal t-faint">
                    {s.frequency === "weekly" ? "weekly" : "daily"}
                  </span>
                </span>
                <span className="text-xs t-secondary tabular-nums whitespace-nowrap">
                  {s.doneDays}/{s.activeDays}
                  {s.pct === null ? "" : ` · ${Math.round(s.pct)}%`}
                </span>
              </div>
              <div className="mt-1.5">
                <RatioBar pct={s.pct ?? 0} />
              </div>
            </button>
          ))}
        </div>
        {stats.length === 0 && (
          <p className="text-sm t-secondary">No habit data in this range.</p>
        )}
      </section>

      {selected && (
        <section className="surface card-pad" aria-label="Daily history">
          <h2 className="section-title mb-1">{selected.name} · daily</h2>
          <p className="text-xs t-faint mb-3">
            ✓ done · — marked not done · · unrecorded (not the same as not
            done).
          </p>
          <div className="grid grid-cols-7 gap-1.5">
            {days.map((d) => {
              const log = logsByHabitDay.get(`${selected.habitId}|${d}`);
              return (
                <div
                  key={d}
                  title={`${formatShort(d)}${log?.value != null ? ` · ${log.value}` : ""}`}
                  className="flex flex-col items-center gap-1 rounded-lg border hairline py-2"
                >
                  <span className="text-[10px] t-faint tabular-nums">
                    {d.slice(8)}
                  </span>
                  {log?.status === "done" ? (
                    <span className="text-emerald-500 text-sm leading-none">
                      ✓
                    </span>
                  ) : log?.status === "not_done" ? (
                    <span className="text-sm leading-none t-faint">—</span>
                  ) : (
                    <StateDot tone="idle" />
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
