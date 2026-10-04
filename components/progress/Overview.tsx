"use client";

import { useMemo } from "react";
import { EmptyState } from "@/components/ui";
import {
  addDays,
  formatDuration,
  formatLong,
  todayKey,
  weekStartMonday,
} from "@/lib/dates";
import { challengeDayNumber, daysRemaining } from "@/lib/types";
import { Heatmap } from "./Heatmap";
import {
  dayCounts,
  findHifzHabitId,
  habitStats,
  heatDays,
  hifzData,
  limitStats,
  planVsActual,
  readingData,
  ruleStats,
  studySummary,
  trainingSummary,
} from "./normalize";
import type { ProgressData, ProgressTab, Range } from "./types";

interface DimRow {
  id: ProgressTab;
  label: string;
  summary: string;
}

export function Overview({
  data,
  range,
  onSelectTab,
}: {
  data: ProgressData;
  range: Range;
  onSelectTab: (t: ProgressTab) => void;
}) {
  const hifzHabitId = useMemo(() => findHifzHabitId(data.habits), [data.habits]);
  const heat = useMemo(() => heatDays(data, hifzHabitId), [data, hifzHabitId]);
  const counts = useMemo(
    () => dayCounts(data, hifzHabitId),
    [data, hifzHabitId]
  );

  const challenge = data.challenge;
  const dayNumber = challenge
    ? challengeDayNumber(challenge, new Date())
    : null;
  const remaining = challenge ? daysRemaining(challenge, new Date()) : null;
  const pct =
    challenge && dayNumber !== null && dayNumber >= 1
      ? Math.min(
          100,
          Math.round(
            (Math.min(dayNumber, challenge.duration_days) /
              challenge.duration_days) *
              100
          )
        )
      : 0;

  // Tahajjud weekly progress (optional habit, this week only).
  const tahajjud = useMemo(() => {
    const habit = data.habits.find(
      (x) => x.name.toLowerCase() === "tahajjud"
    );
    if (!habit) return null;
    const weekStart = weekStartMonday(todayKey());
    const weekEnd = addDays(weekStart, 6);
    const count = data.habitLogs.filter(
      (x) =>
        x.habit_id === habit.id &&
        x.status === "done" &&
        x.log_date >= weekStart &&
        x.log_date <= weekEnd
    ).length;
    return { count, target: habit.weekly_target ?? 2 };
  }, [data.habits, data.habitLogs]);

  const dims: DimRow[] = useMemo(() => {
    const hs = habitStats(data.habits, data.habitLogs, range);
    const doneDays = hs.reduce((a, h) => a + h.doneDays, 0);
    const activeDays = hs.reduce((a, h) => a + h.activeDays, 0);

    const rs = ruleStats(data.rules, data.incidents, range);
    const incidents = rs.reduce((a, r) => a + r.incidents, 0);
    const freeDays = rs.reduce((a, r) => a + r.incidentFreeDays, 0);

    const ls = limitStats(data.limits, data.limitLogs, range);
    const over = ls.reduce((a, l) => a + l.daysOver, 0);
    const within = ls.reduce((a, l) => a + l.daysWithin, 0);

    const ts = trainingSummary(data.sessions, data.schedule, range);
    const st = studySummary(data.studySessions, range);
    const journalDays = new Set(
      data.journalDates.filter((d) => d >= range.start && d <= range.end)
    ).size;

    const rows: DimRow[] = [
      {
        id: "habits",
        label: "Habits",
        summary:
          hs.length === 0
            ? "No habits yet"
            : `${doneDays} of ${activeDays} habit-days done`,
      },
      {
        id: "distractions",
        label: "Distractions",
        summary:
          data.rules.length === 0 && data.limits.length === 0
            ? "Nothing tracked"
            : `${incidents} incident${incidents === 1 ? "" : "s"} · ${freeDays} incident-free days · ${over} days over limit · ${within} within`,
      },
      {
        id: "training",
        label: "Training",
        summary: `${ts.completed} of ${ts.planned} planned sessions done · ${ts.restDays} rest days`,
      },
      {
        id: "study",
        label: "Study",
        summary: `${formatDuration(st.totalSeconds)} total · ${st.sessionCount} sessions · ${st.activeDays} active days`,
      },
    ];

    if (hifzHabitId) {
      const hz = hifzData(data.habitLogs, hifzHabitId, range).totals;
      rows.push({
        id: "hifz",
        label: "Hifz",
        summary:
          hz.recordedDays === 0
            ? "No Hifz data yet"
            : `${hz.total} recorded over ${hz.recordedDays} day${hz.recordedDays === 1 ? "" : "s"}`,
      });
    } else {
      rows.push({ id: "hifz", label: "Hifz", summary: "No Hifz habit set up" });
    }

    const rd = readingData(data.readingLogs, range, data.books);
    const booksWithPages = rd.byBook.filter((b) => b.pages > 0).length;
    rows.push({
      id: "reading",
      label: "Reading",
      summary:
        rd.recordedDays === 0
          ? "No reading data yet"
          : `${rd.totalPages} pages · ${booksWithPages} book${booksWithPages === 1 ? "" : "s"}`,
    });
    rows.push({
      id: "reflection",
      label: "Reflection",
      summary:
        journalDays === 0
          ? "No journal days in range"
          : `${journalDays} journal day${journalDays === 1 ? "" : "s"}`,
    });
    return rows;
  }, [data, range, hifzHabitId]);

  const pva = useMemo(
    () =>
      planVsActual(data.tasks, data.studySessions, data.sessions, range),
    [data, range]
  );

  return (
    <div className="flex flex-col gap-4">
      {/* challenge */}
      {challenge ? (
        <section className="surface card-pad" aria-label="Challenge">
          <p className="text-[11px] uppercase tracking-[0.18em] t-faint">
            {challenge.title}
          </p>
          {dayNumber !== null && dayNumber >= 1 ? (
            <p className="text-lg font-semibold t-primary mt-1 tabular-nums">
              Day {Math.min(dayNumber, challenge.duration_days)} of{" "}
              {challenge.duration_days}
              {remaining !== null && (
                <span className="text-sm font-normal t-secondary">
                  {" "}
                  · {remaining} remaining
                </span>
              )}
            </p>
          ) : (
            <p className="text-lg font-semibold t-primary mt-1">
              Starts {formatLong(challenge.start_date)}
            </p>
          )}
          <div className="h-2 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden mt-3">
            <div
              className="h-full rounded-full bg-[#7C8CF8]"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-xs t-faint mt-2">
            This bar is time elapsed in your challenge — not a score.
          </p>
        </section>
      ) : (
        <EmptyState
          title="No active challenge"
          body="Start a challenge from Settings to anchor this view to a 30-day span."
        />
      )}

      {/* tahajjud weekly */}
      {tahajjud && (
        <section className="surface card-pad" aria-label="Tahajjud this week">
          <h2 className="section-title mb-1">Tahajjud · this week</h2>
          <p className="text-sm t-primary tabular-nums">
            {tahajjud.count} / {tahajjud.target} times
          </p>
          <p className="text-xs t-faint mt-1">
            Optional and personal — recorded when performed, nothing more.
          </p>
        </section>
      )}

      <Heatmap days={heat} counts={counts} />

      {/* dimension summaries */}
      <section aria-label="Dimensions">
        <h2 className="section-title mb-2">By area</h2>
        <div className="surface card-pad flex flex-col divide-y divide-[#E5E7EB] dark:divide-[#242932] !py-1">
          {dims.map((d) => (
            <button
              key={d.id}
              onClick={() => onSelectTab(d.id)}
              className="flex items-center justify-between gap-3 py-3 text-left touch-manipulation"
            >
              <span className="text-sm font-medium t-primary">{d.label}</span>
              <span className="text-xs t-secondary text-right tabular-nums">
                {d.summary}
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* planned vs actual */}
      <section aria-label="Planned versus actual" className="surface card-pad">
        <h2 className="section-title mb-1">Planned vs actual</h2>
        <p className="text-xs t-faint mb-3">
          Approximate: “planned” comes from your tasks and weekly schedule;
          “actual” from completed records. Plans and reality stay separate.
        </p>
        <dl className="flex flex-col gap-2.5 text-sm">
          <div className="flex items-center justify-between">
            <dt className="t-secondary">Tasks</dt>
            <dd className="t-primary tabular-nums">
              {pva.tasksPlanned} planned · {pva.tasksDone} done
            </dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="t-secondary">Study sessions</dt>
            <dd className="t-primary tabular-nums">
              {pva.studyPlanned} planned · {pva.studyActual} actual
            </dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="t-secondary">Workouts</dt>
            <dd className="t-primary tabular-nums">
              {pva.workoutsPlanned} planned · {pva.workoutsActual} actual
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
