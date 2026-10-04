"use client";

import { useMemo } from "react";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/ui";
import { addDays, formatDuration, todayKey } from "@/lib/dates";
import {
  findHifzHabitId,
  firstFinal,
  habitStats,
  hifzData,
  limitStats,
  readingData,
  studySummary,
  studyTrendItems,
  trainingSummary,
} from "@/components/progress/normalize";
import type { RangeDataset } from "./useRangeData";
import type { Challenge } from "@/lib/types";

/** "3.5" instead of "3.50"; whole numbers stay whole. */
function fmtAvg(v: number | null, unit: string): string {
  if (v === null) return "–";
  const n = Math.round(v * 10) / 10;
  return `${n} ${unit}/day`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="text-sm t-secondary">{label}</span>
      <span className="text-sm font-medium t-primary tabular-nums text-right">
        {value}
      </span>
    </div>
  );
}

/**
 * Behavioral summary for one week, rendered inside the weekly review.
 * Every number comes from the existing analytics engine (normalize.ts);
 * this component only aggregates and displays. Journal content is never
 * touched — only counts and durations.
 */
export function WeeklySummary({
  data,
  weekStart,
}: {
  data: RangeDataset;
  weekStart: string;
}) {
  const weekEnd = addDays(weekStart, 6);
  const range = useMemo(() => ({ start: weekStart, end: weekEnd }), [weekStart, weekEnd]);

  const rows = useMemo(() => {
    // Only habits the user currently keeps active — a long-deactivated habit
    // shouldn't drag this week's numbers.
    const activeHabits = data.habits.filter((h) => h.is_active);
    const hs = habitStats(activeHabits, data.habitLogs, range);
    const doneDays = hs.reduce((a, s) => a + s.doneDays, 0);
    const activeDays = hs.reduce((a, s) => a + s.activeDays, 0);
    const habitPct =
      activeDays > 0 ? Math.round((doneDays / activeDays) * 100) : null;

    const t = trainingSummary(data.sessions, data.schedule, range);
    const st = studySummary(data.studySessions, range);
    const hifzHabitId = findHifzHabitId(data.habits);
    const hz = hifzHabitId ? hifzData(data.habitLogs, hifzHabitId, range) : null;
    const rd = readingData(data.readingLogs, range, []);
    const ls = limitStats(data.limits, data.limitLogs, range);
    const limWithin = ls.reduce((a, s) => a + s.daysWithin, 0);
    const limDays = ls.reduce((a, s) => a + s.daysWithData, 0);
    const limPct = limDays > 0 ? Math.round((limWithin / limDays) * 100) : null;

    return { hs, doneDays, activeDays, habitPct, t, st, hz, rd, ls, limPct };
  }, [data, range]);

  const out: { label: string; value: string }[] = [];
  if (rows.hs.length > 0) {
    out.push({
      label: "Habits",
      value:
        rows.habitPct === null
          ? "No active days"
          : `${rows.habitPct}% · ${rows.doneDays}/${rows.activeDays} days`,
    });
  }
  if (rows.t.planned > 0 || rows.t.completed > 0) {
    out.push({
      label: "Training",
      value: `${rows.t.completed}/${rows.t.planned} sessions`,
    });
  }
  if (rows.st.sessionCount > 0) {
    out.push({ label: "Study", value: formatDuration(rows.st.totalSeconds) });
  }
  if (rows.hz && rows.hz.totals.recordedDays > 0) {
    out.push({ label: "Hifz", value: `${rows.hz.totals.total} ayahs` });
  }
  if (rows.rd.totalPages > 0) {
    out.push({ label: "Reading", value: `${rows.rd.totalPages} pages` });
  }
  out.push({
    label: "Abstinence",
    value:
      data.incidents.length === 0
        ? "No incidents"
        : `${data.incidents.length} incident${data.incidents.length === 1 ? "" : "s"}`,
  });
  if (rows.ls.length > 0) {
    out.push({
      label: "Limits",
      value:
        rows.limPct === null
          ? "No usage logged"
          : `${rows.limPct}% within limit`,
    });
  }

  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide t-faint mb-1">
        Data — what actually happened
      </p>
      {out.length === 0 ? (
        <p className="text-sm t-secondary">No recorded activity this week.</p>
      ) : (
        <div className="divide-y divide-[#E5E7EB] dark:divide-[#242932]">
          {out.map((r) => (
            <Row key={r.label} label={r.label} value={r.value} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * First-7 vs final-7 comparison for the active challenge, rendered inside
 * the 30-day review. Anchored to the CHALLENGE dates (not calendar weeks):
 * first window = days 1–7, final window = last 7 elapsed days. Only metrics
 * with real data on at least one side are shown — never manufactured zeros.
 * Manual baseline stays in its own card, untouched by these numbers.
 */
export function ChallengeComparison({
  data,
  challenge,
}: {
  data: RangeDataset;
  challenge: Challenge;
}) {
  const today = todayKey();
  const challengeEnd = useMemo(() => {
    const full = addDays(challenge.start_date, challenge.duration_days - 1);
    return full < today ? full : today;
  }, [challenge.start_date, challenge.duration_days, today]);
  const range = useMemo(
    () => ({ start: challenge.start_date, end: challengeEnd }),
    [challenge.start_date, challengeEnd]
  );

  const rows = useMemo(() => {
    const activeHabits = data.habits.filter((h) => h.is_active);
    const firstRange = { start: range.start, end: addDays(range.start, 6) };
    const finalRange = { start: addDays(range.end, -6), end: range.end };

    const trend = studyTrendItems(data.studySessions, range, "day").map(
      (t) => ({ date: t.key, value: t.value })
    );
    const study = firstFinal(trend, range);

    const rd = readingData(data.readingLogs, range, []);
    const reading = firstFinal(
      rd.points.map((p) => ({ date: p.date, value: p.value })),
      range
    );

    const hifzHabitId = findHifzHabitId(data.habits);
    const hz = hifzHabitId ? hifzData(data.habitLogs, hifzHabitId, range) : null;
    const hifz = hz
      ? firstFinal(
          hz.points.map((p) => ({ date: p.date, value: p.value })),
          range
        )
      : { first: null, final: null };

    const agg = (r: { start: string; end: string }) => {
      const hs = habitStats(activeHabits, data.habitLogs, r);
      const done = hs.reduce((a, s) => a + s.doneDays, 0);
      const active = hs.reduce((a, s) => a + s.activeDays, 0);
      return active > 0 ? Math.round((done / active) * 100) : null;
    };
    const habitFirst = agg(firstRange);
    const habitFinal = agg(finalRange);

    const trainFirst = trainingSummary(data.sessions, data.schedule, firstRange);
    const trainFinal = trainingSummary(data.sessions, data.schedule, finalRange);

    return { study, reading, hifz, habitFirst, habitFinal, trainFirst, trainFinal };
  }, [data, range]);

  const out: { label: string; first: string; final: string }[] = [];
  if (rows.study.first !== null || rows.study.final !== null) {
    out.push({
      label: "Study",
      first: rows.study.first === null ? "–" : formatDuration(rows.study.first),
      final: rows.study.final === null ? "–" : formatDuration(rows.study.final),
    });
  }
  if (rows.reading.first !== null || rows.reading.final !== null) {
    out.push({
      label: "Reading",
      first: fmtAvg(rows.reading.first, "pages"),
      final: fmtAvg(rows.reading.final, "pages"),
    });
  }
  if (rows.hifz.first !== null || rows.hifz.final !== null) {
    out.push({
      label: "Hifz",
      first: fmtAvg(rows.hifz.first, "ayahs"),
      final: fmtAvg(rows.hifz.final, "ayahs"),
    });
  }
  if (rows.habitFirst !== null || rows.habitFinal !== null) {
    out.push({
      label: "Habit consistency",
      first: rows.habitFirst === null ? "–" : `${rows.habitFirst}%`,
      final: rows.habitFinal === null ? "–" : `${rows.habitFinal}%`,
    });
  }
  if (
    rows.trainFirst.planned > 0 ||
    rows.trainFirst.completed > 0 ||
    rows.trainFinal.planned > 0 ||
    rows.trainFinal.completed > 0
  ) {
    out.push({
      label: "Training",
      first: `${rows.trainFirst.completed} sessions`,
      final: `${rows.trainFinal.completed} sessions`,
    });
  }

  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide t-faint mb-2">
        Evidence — measured, not judged
      </p>
      {out.length === 0 ? (
        <p className="text-sm t-secondary">
          Not enough recorded data yet for a beginning/end comparison.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 text-[11px] uppercase tracking-wide t-faint">
            <span />
            <span>First 7 days</span>
            <span>Final 7 days</span>
          </div>
          {out.map((r) => (
            <div
              key={r.label}
              className="grid grid-cols-[1fr_auto_auto] gap-x-4 items-baseline py-1.5 border-t hairline-t"
            >
              <span className="text-sm t-secondary">{r.label}</span>
              <span className="text-sm t-primary tabular-nums text-right">
                {r.first}
              </span>
              <span className="text-sm font-medium t-primary tabular-nums text-right">
                {r.final}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Shared loading/error shell for the summary slots. */
export function SummaryState({
  loading,
  error,
  onRetry,
  children,
}: {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  children: React.ReactNode;
}) {
  if (loading) return <LoadingBlock label="Loading week data…" />;
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  return <>{children}</>;
}

export function ComparisonState({
  loading,
  error,
  onRetry,
  children,
}: {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  children: React.ReactNode;
}) {
  if (loading) return <LoadingBlock label="Loading challenge data…" />;
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  return <>{children}</>;
}
