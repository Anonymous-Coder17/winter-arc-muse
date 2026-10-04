"use client";

import type { ProgressTab } from "./types";

export const TABS: { id: ProgressTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "habits", label: "Habits" },
  { id: "distractions", label: "Distractions" },
  { id: "training", label: "Training" },
  { id: "study", label: "Study" },
  { id: "hifz", label: "Hifz" },
  { id: "reading", label: "Reading" },
  { id: "reflection", label: "Reflection" },
];

/** Horizontally scrollable tab bar — 8 tabs never fit a segmented control. */
export function TabBar({
  value,
  onChange,
}: {
  value: ProgressTab;
  onChange: (t: ProgressTab) => void;
}) {
  return (
    <div
      className="flex gap-1 overflow-x-auto pb-1 -mx-1 px-1"
      role="tablist"
      aria-label="Progress sections"
    >
      {TABS.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={`whitespace-nowrap rounded-full px-3.5 py-2 text-sm font-medium transition-colors min-h-[40px] touch-manipulation ${
            value === t.id
              ? "bg-[#5A6AE0]/15 text-[#3D4AC4] dark:text-[#C3CCFF] border border-[#5A6AE0]/30"
              : "t-secondary border border-transparent hover:t-primary"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
