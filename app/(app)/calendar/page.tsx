"use client";

import { useEffect, useMemo, useState } from "react";
import { useCalendarData } from "@/components/calendar/useCalendarData";
import { useTraining } from "@/components/training/useTraining";
import { DayView } from "@/components/calendar/DayView";
import { WeekView } from "@/components/calendar/WeekView";
import { MonthView } from "@/components/calendar/MonthView";
import { PlanTomorrow } from "@/components/calendar/PlanTomorrow";
import { EmptyState, ErrorState, LoadingBlock, SegControl } from "@/components/ui";
import { addDays, formatLong, isToday, todayKey } from "@/lib/dates";
import { challengeDayNumber, daysRemaining } from "@/lib/types";
import {
  currentChallengePhase,
  resolveChallengePhases,
} from "@/lib/phases";
import { PhaseOverview } from "@/components/challenge/PhaseOverview";
import { engine } from "@/lib/sync/engine";
import { GoogleCalendarProvider } from "@/lib/calendar-providers/google";
import { triggerGoogleSync } from "@/lib/calendar-providers/googleSyncClient";
import { readMetaCache } from "@/lib/calendar-providers/googleMeta";
import Link from "next/link";

type View = "day" | "week" | "month";

/** Re-sync at most this often when the calendar page opens. */
const AUTO_SYNC_STALE_MS = 15 * 60 * 1000;

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
  const training = useTraining(startKey, endKey);

  // V4.3.2: auto-sync Google events when the page opens — only when Google
  // is connected (lightweight meta-cache check), the device is online, and
  // the last sync is missing or older than 15 minutes. Best-effort: the
  // calendar opens fine even if this never runs.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await engine.whenReady();
        if (cancelled) return;
        const userId = engine.getSnapshot().userId;
        if (!userId) return;
        if (typeof navigator !== "undefined" && navigator.onLine === false) {
          return;
        }
        const meta = await readMetaCache(userId);
        if (cancelled || meta?.status !== "connected") return;
        const provider = new GoogleCalendarProvider(
          undefined,
          () => engine.getSnapshot().userId
        );
        const sync = await provider.getSyncStatus();
        const last = sync.lastSyncedAt ? Date.parse(sync.lastSyncedAt) : NaN;
        if (
          !sync.lastSyncedAt ||
          Number.isNaN(last) ||
          Date.now() - last > AUTO_SYNC_STALE_MS
        ) {
          await triggerGoogleSync(provider);
          // The engine pull bumps the sync tick, so useCalendarData reloads
          // (and re-tags synced events) on its own.
        }
      } catch {
        // Auto-sync is best-effort; never break the calendar over it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const challenge = data.challenge;
  const dayNumber =
    challenge && dateKey === todayKey()
      ? challengeDayNumber(challenge, new Date())
      : null;
  const remaining =
    challenge && dateKey === todayKey()
      ? daysRemaining(challenge, new Date())
      : null;
  // V4.6: current phase + overview, derived from the challenge dates.
  // Shown only for the standard 30-day challenge; null otherwise.
  const phaseNow =
    challenge && dateKey === todayKey()
      ? currentChallengePhase(challenge, new Date())
      : null;
  const phases =
    challenge && dateKey === todayKey()
      ? resolveChallengePhases(challenge, new Date())
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
          <>
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
              {/* V4.6: current phase — contextual, compact, date-derived. */}
              {phaseNow && (
                <p className="text-xs t-secondary mt-1.5" aria-label={`Current phase: ${phaseNow.def.name}`}>
                  <span className="font-semibold uppercase tracking-[0.14em] t-primary">
                    {phaseNow.def.name}
                  </span>
                  <span className="t-faint">
                    {" "}· Days {phaseNow.def.startDay}–{phaseNow.def.endDay}
                  </span>
                  <span className="block mt-0.5 t-faint">
                    {phaseNow.def.description}
                  </span>
                </p>
              )}
            </div>
            <button
              className="btn-primary shrink-0"
              onClick={() => setPlanning(true)}
            >
              Plan tomorrow
            </button>
          </div>
          {/* V4.6: phase overview — all four phases, date-based state. */}
          {phases && <PhaseOverview phases={phases} />}
          </>
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
        <DayView dateKey={dateKey} data={data} training={training} />
      ) : view === "week" ? (
        <WeekView
          dateKey={dateKey}
          data={data}
          training={training}
          onSelectDay={(k) => {
            setDateKey(k);
            setView("day");
          }}
        />
      ) : (
        <MonthView
          dateKey={dateKey}
          data={data}
          training={training}
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
