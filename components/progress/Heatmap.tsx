"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { formatDuration, formatLong, weekdayIndex } from "@/lib/dates";
import type { DayCounts, HeatDay } from "./types";

const LEVEL_BG = [
  "bg-black/[0.05] dark:bg-white/[0.07] hover:bg-black/10 dark:hover:bg-white/15",
  "bg-[#7C8CF8]/25 hover:bg-[#7C8CF8]/40",
  "bg-[#7C8CF8]/60 hover:bg-[#7C8CF8]/75",
  "bg-[#7C8CF8] hover:bg-[#8C9CFF]",
];

const LEGEND: { level: 0 | 1 | 2 | 3; label: string }[] = [
  { level: 0, label: "None" },
  { level: 1, label: "1 area" },
  { level: 2, label: "2–3 areas" },
  { level: 3, label: "4+ areas" },
];

function describe(c: DayCounts): string {
  const parts: string[] = [];
  if (c.habitsDone > 0) parts.push(`${c.habitsDone} habits`);
  if (c.studySeconds > 0) parts.push(`${formatDuration(c.studySeconds)} study`);
  if (c.workouts > 0) parts.push(`${c.workouts} workout${c.workouts === 1 ? "" : "s"}`);
  if (c.hifz !== null) parts.push(`hifz ${c.hifz}`);
  if (c.pages > 0) parts.push(`${c.pages} pages`);
  if (c.journaled) parts.push("journal");
  if (c.incidents > 0) parts.push(`${c.incidents} incident${c.incidents === 1 ? "" : "s"}`);
  if (c.limitsOver > 0) parts.push(`${c.limitsOver} limit${c.limitsOver === 1 ? "" : "s"} over`);
  return parts.length > 0 ? parts.join(" · ") : "no recorded activity";
}

/** Presence-based 30-day activity heatmap. Presence only — never a score. */
export function Heatmap({
  days,
  counts,
}: {
  days: HeatDay[];
  counts: Record<string, DayCounts>;
}) {
  const [selected, setSelected] = useState<string | null>(
    days.length > 0 ? days[days.length - 1].date : null
  );

  // Monday-first week columns.
  const weeks = useMemo(() => {
    if (days.length === 0) return [];
    const pad = weekdayIndex(days[0].date);
    const cols: (HeatDay | null)[][] = [];
    let col: (HeatDay | null)[] = Array(pad).fill(null);
    for (const d of days) {
      col.push(d);
      if (col.length === 7) {
        cols.push(col);
        col = [];
      }
    }
    if (col.length > 0) {
      while (col.length < 7) col.push(null);
      cols.push(col);
    }
    return cols;
  }, [days]);

  const detail = selected ? counts[selected] : null;

  return (
    <section aria-label="Activity heatmap" className="surface card-pad">
      <h2 className="section-title">Last 30 days</h2>
      <p className="text-xs t-faint mt-1">
        Presence per area — habits, study, training, hifz, reading, journal.
        An empty day is just unrecorded, not a failure.
      </p>

      <div className="overflow-x-auto mt-3">
        <div className="flex gap-1.5 w-max" role="group" aria-label="Daily activity">
          {weeks.map((col, ci) => (
            <div key={ci} className="flex flex-col gap-1.5">
              {col.map((d, ri) =>
                d === null ? (
                  <span key={`p-${ri}`} className="w-7 h-7" />
                ) : (
                  <button
                    key={d.date}
                    onClick={() => setSelected(d.date)}
                    aria-label={`${formatLong(d.date)}: ${describe(counts[d.date] ?? { date: d.date, habitsDone: 0, studySeconds: 0, workouts: 0, hifz: null, pages: 0, journaled: false, incidents: 0, limitsOver: 0 })}`}
                    aria-pressed={selected === d.date}
                    className={`w-7 h-7 rounded-md transition-colors touch-manipulation ${LEVEL_BG[d.level]} ${
                      selected === d.date
                        ? "ring-2 ring-[#7C8CF8] ring-offset-1 ring-offset-transparent"
                        : ""
                    }`}
                  />
                )
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3 mt-3 text-[11px] t-faint flex-wrap">
        {LEGEND.map((l) => (
          <span key={l.level} className="inline-flex items-center gap-1.5">
            <span className={`w-3 h-3 rounded ${LEVEL_BG[l.level].split(" ")[0]}`} />
            {l.label}
          </span>
        ))}
      </div>

      {detail && (
        <div className="mt-3 rounded-xl border hairline p-3.5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium t-primary">{formatLong(detail.date)}</p>
            <Link
              href="/calendar"
              className="text-xs t-secondary hover:t-primary underline underline-offset-2"
            >
              Open in calendar →
            </Link>
          </div>
          <p className="text-sm t-secondary mt-1.5">{describe(detail)}</p>
          {detail.hifz !== null && (
            <p className="text-xs t-faint mt-1">
              Hifz recorded value counts as presence; zero is valid data.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
