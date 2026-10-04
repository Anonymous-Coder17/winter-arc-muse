"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/ui";
import { createClient } from "@/lib/supabase/client";
import {
  getJournalDates,
  getWeeklyReview,
} from "@/lib/journal";
import type { Challenge, WeeklyReview } from "@/lib/types";
import {
  addDays,
  formatLong,
  formatShort,
  todayKey,
  weekStartMonday,
} from "@/lib/dates";
import { JournalEditor } from "./JournalEditor";
import { DailyReviewForm } from "./DailyReviewForm";
import { WeeklyReviewForm } from "./WeeklyReviewForm";
import { ThirtyDayReview } from "./ThirtyDayReview";

/**
 * The Progress "reflection" tab content. Rendered by the progress package.
 *
 * Privacy: journal entry CONTENT is only ever displayed inside the journal
 * components below. The frequency summary counts entries — it never shows
 * what was written.
 */
export function ReflectionSection({
  range,
}: {
  range: { start: string; end: string };
}) {
  const today = todayKey();
  const [selectedDate, setSelectedDate] = useState(today);
  const [selectedWeek, setSelectedWeek] = useState(() =>
    weekStartMonday(today)
  );

  // ---- journal frequency ----
  const [dates, setDates] = useState<string[]>([]);
  const [datesLoading, setDatesLoading] = useState(true);
  const [datesError, setDatesError] = useState<string | null>(null);

  const loadDates = useCallback(async () => {
    setDatesLoading(true);
    setDatesError(null);
    try {
      setDates(await getJournalDates(range.start, range.end));
    } catch (e) {
      setDatesError(e instanceof Error ? e.message : "Could not load dates.");
    } finally {
      setDatesLoading(false);
    }
  }, [range.start, range.end]);

  useEffect(() => {
    loadDates();
  }, [loadDates]);

  // ---- weekly reviews in range ----
  const weekKeys = useMemo(() => {
    const keys: string[] = [];
    let w = weekStartMonday(range.start);
    while (w <= range.end) {
      keys.push(w);
      w = addDays(w, 7);
    }
    return keys;
  }, [range.start, range.end]);

  const [weeklyReviews, setWeeklyReviews] = useState<WeeklyReview[]>([]);
  const [weeksLoading, setWeeksLoading] = useState(true);
  const [weeksError, setWeeksError] = useState<string | null>(null);

  const loadWeeks = useCallback(async () => {
    setWeeksLoading(true);
    setWeeksError(null);
    try {
      const results = await Promise.all(weekKeys.map((w) => getWeeklyReview(w)));
      setWeeklyReviews(
        results.filter((r): r is WeeklyReview => r !== null)
      );
    } catch (e) {
      setWeeksError(
        e instanceof Error ? e.message : "Could not load weekly reviews."
      );
    } finally {
      setWeeksLoading(false);
    }
  }, [weekKeys]);

  useEffect(() => {
    loadWeeks();
  }, [loadWeeks]);

  // ---- active challenge (for the 30-day review) ----
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [challengeLoading, setChallengeLoading] = useState(true);
  const [challengeError, setChallengeError] = useState<string | null>(null);

  const loadChallenge = useCallback(async () => {
    setChallengeLoading(true);
    setChallengeError(null);
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in.");
      const { data, error } = await supabase
        .from("challenges")
        .select("*")
        .eq("owner", user.id)
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      setChallenge((data as Challenge | null) ?? null);
    } catch (e) {
      setChallengeError(
        e instanceof Error ? e.message : "Could not load the challenge."
      );
    } finally {
      setChallengeLoading(false);
    }
  }, []);

  useEffect(() => {
    loadChallenge();
  }, [loadChallenge]);

  return (
    <div className="flex flex-col gap-4">
      {/* journal frequency + entry dates */}
      <section aria-label="Journal activity">
        <h3 className="section-title mb-2">Journal</h3>
        {datesLoading ? (
          <LoadingBlock label="Loading journal activity…" />
        ) : datesError ? (
          <ErrorState message={datesError} onRetry={loadDates} />
        ) : dates.length === 0 ? (
          <EmptyState
            title="No entries in this range"
            body="Write below to start your record."
          />
        ) : (
          <div className="surface card-pad flex flex-col gap-2">
            <p className="text-sm t-primary">
              <span className="font-semibold tabular-nums">{dates.length}</span>{" "}
              {dates.length === 1 ? "entry" : "entries"} in range
            </p>
            <div className="flex flex-wrap gap-1.5">
              {dates.map((d) => (
                <button
                  key={d}
                  className={`seg-btn !min-h-[36px] ${
                    d === selectedDate ? "seg-btn-active" : ""
                  }`}
                  onClick={() => setSelectedDate(d)}
                  title={formatLong(d)}
                >
                  {formatShort(d)}
                </button>
              ))}
            </div>
            <p className="text-xs t-faint">
              Select a date to open it below. Entry content stays here — it is
              never included in summaries or analytics.
            </p>
          </div>
        )}
      </section>

      {/* entry + daily review for the selected date */}
      <section aria-label="Entry for selected date">
        <h3 className="section-title mb-2">
          {formatLong(selectedDate)}
          {selectedDate === today && <span className="t-faint"> · today</span>}
        </h3>
        <div className="flex flex-col gap-3">
          <JournalEditor date={selectedDate} onDateChange={setSelectedDate} />
          <DailyReviewForm date={selectedDate} onDateChange={setSelectedDate} />
        </div>
      </section>

      {/* weekly reviews */}
      <section aria-label="Weekly reviews">
        <h3 className="section-title mb-2">Weekly reviews</h3>
        {weeksLoading ? (
          <LoadingBlock label="Loading weekly reviews…" />
        ) : weeksError ? (
          <ErrorState message={weeksError} onRetry={loadWeeks} />
        ) : (
          <div className="flex flex-col gap-3">
            {weeklyReviews.length > 0 && (
              <div className="surface card-pad flex flex-col gap-2">
                {weeklyReviews.map((r) => (
                  <button
                    key={r.id}
                    className="text-left w-full rounded-xl px-3 py-2.5 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                    onClick={() => setSelectedWeek(r.week_start)}
                  >
                    <p className="text-sm font-medium t-primary tabular-nums">
                      {formatShort(r.week_start)} – {formatShort(r.week_end)}
                    </p>
                    <p className="text-xs t-faint truncate">
                      {[r.what_worked, r.what_didnt, r.next_adjustment].filter(
                        Boolean
                      ).length > 0
                        ? "Review written"
                        : "Empty review"}
                    </p>
                  </button>
                ))}
              </div>
            )}
            <WeeklyReviewForm
              weekStart={selectedWeek}
              onWeekChange={setSelectedWeek}
            />
          </div>
        )}
      </section>

      {/* 30-day review */}
      <section aria-label="30-day review">
        <h3 className="section-title mb-2">30-day review</h3>
        {challengeLoading ? (
          <LoadingBlock label="Loading challenge…" />
        ) : challengeError ? (
          <ErrorState message={challengeError} onRetry={loadChallenge} />
        ) : (
          <ThirtyDayReview challenge={challenge} />
        )}
      </section>
    </div>
  );
}
