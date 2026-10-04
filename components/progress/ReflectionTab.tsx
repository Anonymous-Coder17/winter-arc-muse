"use client";

// Reflection tab: delegates entirely to the journal package's
// ReflectionSection. Journal TEXT is never read here — only the range is
// passed down, and the journal UI manages its own display.
import { ReflectionSection } from "@/components/journal/ReflectionSection";
import type { Range } from "./types";

export function ReflectionTab({
  range,
  initialDate,
}: {
  range: Range;
  initialDate?: string | null;
}) {
  return <ReflectionSection range={range} initialDate={initialDate} />;
}
