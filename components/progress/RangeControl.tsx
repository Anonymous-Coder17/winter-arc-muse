"use client";

import { Field } from "@/components/ui";
import { formatShort } from "@/lib/dates";
import type { Challenge } from "@/lib/types";
import type { RangePreset } from "./normalize";
import type { Range } from "./types";

const PRESETS: { id: RangePreset; label: string }[] = [
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "week", label: "This week" },
  { id: "month", label: "This month" },
  { id: "challenge", label: "Challenge" },
  { id: "custom", label: "Custom" },
];

export function RangeControl({
  preset,
  onPreset,
  customStart,
  customEnd,
  onCustomStart,
  onCustomEnd,
  challenge,
  range,
}: {
  preset: RangePreset;
  onPreset: (p: RangePreset) => void;
  customStart: string;
  customEnd: string;
  onCustomStart: (v: string) => void;
  onCustomEnd: (v: string) => void;
  challenge: Challenge | null;
  range: Range;
}) {
  return (
    <section aria-label="Date range" className="surface card-pad">
      <div
        className="flex gap-1 overflow-x-auto pb-1"
        role="tablist"
        aria-label="Range presets"
      >
        {PRESETS.map((p) => {
          const disabled = p.id === "challenge" && !challenge;
          const active = preset === p.id;
          return (
            <button
              key={p.id}
              role="tab"
              aria-selected={active}
              disabled={disabled}
              onClick={() => onPreset(p.id)}
              className={`whitespace-nowrap rounded-full px-3.5 py-2 text-sm font-medium transition-colors min-h-[40px] touch-manipulation disabled:opacity-40 ${
                active
                  ? "bg-[#5A6AE0]/15 text-[#3D4AC4] dark:text-[#C3CCFF] border border-[#5A6AE0]/30"
                  : "t-secondary border border-transparent hover:t-primary"
              }`}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      {preset === "custom" && (
        <div className="grid grid-cols-2 gap-3 mt-3">
          <Field label="From">
            <input
              type="date"
              className="input"
              value={customStart}
              max={customEnd || undefined}
              onChange={(e) => onCustomStart(e.target.value)}
            />
          </Field>
          <Field label="To">
            <input
              type="date"
              className="input"
              value={customEnd}
              min={customStart || undefined}
              onChange={(e) => onCustomEnd(e.target.value)}
            />
          </Field>
        </div>
      )}
      <p className="text-xs t-faint mt-2 tabular-nums">
        {formatShort(range.start)} – {formatShort(range.end)}
      </p>
    </section>
  );
}
