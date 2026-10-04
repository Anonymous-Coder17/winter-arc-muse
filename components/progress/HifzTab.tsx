"use client";

import { useMemo } from "react";
import { EmptyState } from "@/components/ui";
import { formatShort, weekStartMonday } from "@/lib/dates";
import { TrendBars } from "./charts";
import { findHifzHabitId, firstFinal, hifzData } from "./normalize";
import type { ProgressData, Range } from "./types";

/**
 * Hifz: totals, per-day trend, weekly totals. Recorded zero is valid data;
 * "no data yet" is a different state from "recorded zeros".
 */
export function HifzTab({ data, range }: { data: ProgressData; range: Range }) {
  const habitId = useMemo(() => findHifzHabitId(data.habits), [data.habits]);

  const hifz = useMemo(
    () => (habitId ? hifzData(data.habitLogs, habitId, range) : null),
    [data.habitLogs, habitId, range]
  );
  const halves = useMemo(
    () => (hifz ? firstFinal(hifz.raw, range) : null),
    [hifz, range]
  );

  const weekly = useMemo(() => {
    if (!hifz) return [];
    const m = new Map<string, number>();
    for (const p of hifz.points) {
      if (p.value === null) continue;
      const w = weekStartMonday(p.date);
      m.set(w, (m.get(w) ?? 0) + p.value);
    }
    return [...m.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([week, total]) => ({ week, total }));
  }, [hifz]);

  if (!habitId) {
    return (
      <EmptyState
        title="No Hifz habit yet"
        body="Add a habit named “Hifz” (count tracking) from the Habits area to see totals and trends here."
      />
    );
  }

  if (!hifz || hifz.totals.recordedDays === 0) {
    return (
      <EmptyState
        title="No Hifz data yet"
        body="Recorded days will appear here. A recorded zero is valid data — different from a day with nothing recorded."
      />
    );
  }

  const t = hifz.totals;
  return (
    <div className="flex flex-col gap-4">
      <section className="surface card-pad" aria-label="Hifz totals">
        <h2 className="section-title mb-3">Totals</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[
            ["Recorded", String(t.total)],
            ["Recorded days", String(t.recordedDays)],
            ["Zero days", String(t.zeroDays)],
            [
              "Avg / recorded day",
              t.avgPerRecordedDay === null
                ? "—"
                : t.avgPerRecordedDay.toFixed(1),
            ],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl border hairline px-3 py-2.5">
              <p className="text-[11px] t-faint">{label}</p>
              <p className="text-base font-medium t-primary tabular-nums mt-0.5">
                {value}
              </p>
            </div>
          ))}
        </div>
        <p className="text-[11px] t-faint mt-2">
          Units depend on how you log your Hifz habit (ayahs, pages, minutes…).
          Zero days are counted as recorded, not missing.
        </p>
      </section>

      <section className="surface card-pad" aria-label="Hifz per-day trend">
        <h2 className="section-title mb-2">Per day</h2>
        <TrendBars
          items={hifz.points.map((p) => ({
            key: p.date,
            label: formatShort(p.date),
            value: p.value ?? 0,
          }))}
        />
        <p className="text-[11px] t-faint mt-1">
          Dim bars are recorded zeros; a gap means nothing was recorded that
          day.
        </p>
      </section>

      <section className="surface card-pad" aria-label="Hifz weekly totals">
        <h2 className="section-title mb-2">Weekly totals</h2>
        {weekly.length === 0 ? (
          <p className="text-sm t-secondary">No recorded weeks in range.</p>
        ) : (
          <div className="flex flex-col divide-y divide-[#E5E7EB] dark:divide-[#242932]">
            {weekly.map((w) => (
              <div
                key={w.week}
                className="flex items-center justify-between py-2"
              >
                <span className="text-sm t-secondary">
                  Week of {formatShort(w.week)}
                </span>
                <span className="text-sm t-primary tabular-nums">{w.total}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {halves && (halves.first !== null || halves.final !== null) && (
        <section className="surface card-pad" aria-label="Hifz start versus end of range">
          <h2 className="section-title mb-1">First 7 days vs last 7 days</h2>
          <p className="text-sm t-primary tabular-nums">
            {halves.first === null ? "—" : halves.first.toFixed(1)} →{" "}
            {halves.final === null ? "—" : halves.final.toFixed(1)}
          </p>
          <p className="text-xs t-faint mt-1">
            Average per recorded day, first 7 days of the range versus last 7
            days. Direction, not a grade.
          </p>
        </section>
      )}
    </div>
  );
}
