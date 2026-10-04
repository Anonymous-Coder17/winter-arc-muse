"use client";

import { useMemo, useState } from "react";
import { useCalendarData } from "@/components/calendar/useCalendarData";
import { DayView } from "@/components/calendar/DayView";
import { WeekView } from "@/components/calendar/WeekView";
import { MonthView } from "@/components/calendar/MonthView";
import { PlanTomorrow } from "@/components/calendar/PlanTomorrow";
import { EmptyState, ErrorState, LoadingBlock, SegControl } from "@/components/ui";
import { addDays, formatLong, isToday, todayKey } from "@/lib/dates";
import { challengeDayNumber, daysRemaining } from "@/lib/types";
import Link from "next/link";

type View = "day" | "week" | "month";

function rangeFor(view: View, dateKey: string): [string, string] {
  if (view === "day") return [addDays(dateKey, -1), addDays(dateKey, 2)];
  if (view === "week") return [addDays(dateKey, -7), addDays(dateKey, 7)];
  return [dateKey.slice(0, 8) + "01", addDays(dateKey.slice(0, 8) + "01", 45)];
}

export default function CalendarPage() {
  const [view, setView] = useState<View>("day");
  const [dateKey, setDateKey] = useState(todayKey());
  const [planning, setPlanning] = useState(false);

  const [startKey, endKey] = useMemo(
    () => rangeFor(view, dateKey),
    [view, dateKey]
  );
  const data = useCalendarData(startKey, endKey);

  const challenge = data.challenge;
  const dayNumber =
    challenge && dateKey === todayKey()
      ? challengeDayNumber(challenge, new Date())
      : null;
  const remaining =
    challenge && dateKey === todayKey()
      ? daysRemaining(challenge, new Date())
      : null;

  return (
    <div className="flex flex-col gap-4">
      {/* challenge banner */}
      <section aria-label="Challenge" className="surface card-pad">
        {data.loading ? (
          <div className="flex items-center gap-3">
            <LoadingBlock label="" />
          </div>
        ) : challenge ? (
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-[11px] uppercase tracking-[0.18em] t-faint">
                {challenge.title}
              </p>
              {dayNumber !== null && dayNumber >= 1 ? (
                <p className="page-title mt-1">
                  Day {Math.min(dayNumber, challenge.duration_days)} of{" "}
                  {challenge.duration_days}
                </p>
              ) : (
                <p className="page-title mt-1">
                  Starts {formatLong(challenge.start_date)}
                </p>
              )}
              <p className="page-sub">
                {challenge.subtitle ?? "Build the person you want to become."}
                {remaining !== null && remaining > 0 && dayNumber !== null && dayNumber >= 1
                  ? ` · ${remaining} day${remaining === 1 ? "" : "s"} remaining`
                  : ""}
              </p>
            </div>
            <button
              className="btn-primary shrink-0"
              onClick={() => setPlanning(true)}
            >
              Plan tomorrow
            </button>
          </div>
        ) : (
          <EmptyState
            title="No active challenge"
            body="Create your 30-day challenge to anchor everything around it."
            action={
              <Link href="/settings" className="btn-primary">
                Create challenge
              </Link>
            }
          />
        )}
      </section>

      {/* view controls */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <SegControl<View>
          ariaLabel="Calendar view"
          value={view}
          onChange={setView}
          options={[
            { value: "day", label: "Day" },
            { value: "week", label: "Week" },
            { value: "month", label: "Month" },
          ]}
        />
        <div className="flex items-center gap-2">
          <button
            className="btn-ghost !px-3"
            onClick={() => setDateKey(addDays(dateKey, view === "month" ? -30 : view === "week" ? -7 : -1))}
            aria-label="Previous"
          >
            ←
          </button>
          {!isToday(dateKey) && (
            <button className="btn-ghost !px-3" onClick={() => setDateKey(todayKey())}>
              Today
            </button>
          )}
          <button
            className="btn-ghost !px-3"
            onClick={() => setDateKey(addDays(dateKey, view === "month" ? 30 : view === "week" ? 7 : 1))}
            aria-label="Next"
          >
            →
          </button>
        </div>
      </div>

      {data.error ? (
        <ErrorState message={data.error} onRetry={data.refresh} />
      ) : data.loading ? (
        <LoadingBlock />
      ) : view === "day" ? (
        <DayView dateKey={dateKey} data={data} />
      ) : view === "week" ? (
        <WeekView
          dateKey={dateKey}
          data={data}
          onSelectDay={(k) => {
            setDateKey(k);
            setView("day");
          }}
        />
      ) : (
        <MonthView
          dateKey={dateKey}
          data={data}
          onSelectDay={(k) => {
            setDateKey(k);
            setView("day");
          }}
        />
      )}

      {planning && (
        <PlanTomorrow
          todayKey={todayKey()}
          data={data}
          onClose={() => {
            setPlanning(false);
            data.refresh();
          }}
        />
      )}
    </div>
  );
}
