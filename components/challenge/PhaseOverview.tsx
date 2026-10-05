"use client";

import { formatShort } from "@/lib/dates";
import type { ResolvedPhase } from "@/lib/phases";

/**
 * V4.6 — compact challenge phase overview.
 *
 * Shows all four phases with name, date range, and date-based state
 * (past / current / upcoming). State is conveyed with text ("Current",
 * "Done"), never color alone. No percentages, no scores — a phase is
 * past/current/upcoming purely from the challenge dates.
 */
export function PhaseOverview({ phases }: { phases: ResolvedPhase[] }) {
  return (
    <div
      className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2"
      role="list"
      aria-label="Challenge phases"
    >
      {phases.map((p) => (
        <div
          key={p.def.key}
          role="listitem"
          aria-label={`${p.def.name} phase, days ${p.def.startDay} to ${p.def.endDay}, ${p.state}`}
          className={`rounded-xl border px-3 py-2.5 ${
            p.state === "current"
              ? "border-[#7C8CF8]/50 bg-[#7C8CF8]/5"
              : "hairline"
          }`}
        >
          <p className="text-xs font-semibold t-primary flex items-center gap-1.5">
            {p.state === "current" && (
              <span
                className="inline-block w-1.5 h-1.5 rounded-full bg-[#7C8CF8] shrink-0"
                aria-hidden
              />
            )}
            {p.def.name}
          </p>
          <p className="text-[11px] t-faint tabular-nums mt-0.5">
            Days {p.def.startDay}–{p.def.endDay}
          </p>
          <p className="text-[11px] t-faint mt-0.5">
            {formatShort(p.startDate)} – {formatShort(p.endDate)}
          </p>
          <p className="text-[11px] font-medium t-secondary mt-1">
            {p.state === "current"
              ? "Current"
              : p.state === "past"
                ? "✓ Done"
                : "Upcoming"}
          </p>
        </div>
      ))}
    </div>
  );
}
