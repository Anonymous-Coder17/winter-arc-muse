"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Field, Modal } from "@/components/ui";
import { useTodayExtras } from "./useTodayExtras";
import {
  addLimitMinutes,
  logIncident,
  quickLogCount,
} from "./todayActions";
import { logReadingPages } from "@/lib/journal";
import { logFor, type CalendarData } from "@/components/calendar/useCalendarData";
import { toggleHabitDone } from "@/lib/habits";
import { formatDuration } from "@/lib/dates";
import { useTraining, exercisesFor } from "@/components/training/useTraining";
import { useStudy } from "@/components/study/useStudy";
import { scheduledWorkoutForDate } from "@/lib/training";
import { sumDurations } from "@/lib/study";
import type { UsageLimit } from "@/lib/types";

function QuickButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="surface-elevated rounded-2xl px-3 py-3.5 text-sm font-medium t-primary text-center transition-colors hover:border-[#7C8CF8]/60 active:scale-[0.98] touch-manipulation min-h-[56px] disabled:opacity-50"
    >
      {label}
    </button>
  );
}

export function TodayPanel({
  dateKey,
  data,
}: {
  dateKey: string;
  data: CalendarData;
}) {
  const extras = useTodayExtras(dateKey);
  const { refresh } = data;
  const router = useRouter();
  const [incidentRule, setIncidentRule] = useState<string | null>(null);
  const [trigger, setTrigger] = useState("");
  const [incidentNote, setIncidentNote] = useState("");
  const [limitToLog, setLimitToLog] = useState<UsageLimit | null>(null);
  const [minutes, setMinutes] = useState("15");
  const [selectedBook, setSelectedBook] = useState("");
  const [pagesInput, setPagesInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  function refreshAll() {
    refresh();
    extras.refresh();
  }

  function note(msg: string) {
    setFlash(msg);
    setTimeout(() => setFlash(null), 2500);
  }

  async function run(fn: () => Promise<unknown>, doneMsg: string) {
    setBusy(true);
    try {
      await fn();
      refreshAll();
      note(doneMsg);
    } finally {
      setBusy(false);
    }
  }

  // V2 training + study (scheduled workout / today's study time).
  // Planned tasks still live in the DayView timeline; these sections show
  // the training system and recorded study reality.
  const training = useTraining(dateKey, dateKey);
  const study = useStudy(dateKey, dateKey);
  const scheduled = scheduledWorkoutForDate(
    training.schedule,
    training.workouts,
    dateKey
  );
  const todayWorkoutSession = training.sessions.find(
    (s) =>
      s.workout_id === scheduled?.id &&
      (s.status === "completed" || s.status === "in_progress")
  );
  const studySeconds = sumDurations(study.sessions);
  const recentStudy = study.sessions[0];
  const recentStudySubject = study.subjects.find(
    (x) => x.id === recentStudy?.subject_id
  );
  const recentStudyTopic = study.topics.find(
    (x) => x.id === recentStudy?.topic_id
  );

  const hifzHabit = data.habits.find((h) => h.name.toLowerCase() === "hifz");
  const hifzToday = hifzHabit
    ? Number(logFor(data.habitLogs, hifzHabit.id, dateKey)?.value ?? 0)
    : 0;
  // V3: reading pages now live in reading_logs (backfilled from the old
  // "Reading" count habit by migration 0005). Sum today's rows.
  const readingToday = extras.readingLogs.reduce(
    (sum, r) => sum + (Number(r.pages) || 0),
    0
  );
  // V4.4: per-book totals — multiple rows per (log_date, book_id) are legal
  // (cross-device additive), so SUM(pages) grouped by book_id.
  // Key "" = unbooked rows; unknown ids (archived since) are labelled later.
  const readingByBook = extras.readingLogs.reduce<Map<string, number>>(
    (map, r) => {
      const key = r.book_id ?? "";
      map.set(key, (map.get(key) ?? 0) + (Number(r.pages) || 0));
      return map;
    },
    new Map()
  );
  const bookNameById = new Map(extras.books.map((b) => [b.id, b.name]));
  const readingBreakdown = [...readingByBook.entries()]
    .sort(([a], [b]) => {
      const orderA = extras.books.findIndex((bk) => bk.id === a);
      const orderB = extras.books.findIndex((bk) => bk.id === b);
      // Known books in list order (sort_order, name); unbooked "" and
      // archived ids (index -1) go last, in that order.
      return (
        (orderA === -1 ? extras.books.length + (a === "" ? 0 : 1) : orderA) -
        (orderB === -1 ? extras.books.length + (b === "" ? 0 : 1) : orderB)
      );
    })
    .map(([bookId, pages]) => ({
      bookId,
      pages,
      label: bookId === "" ? "No book" : (bookNameById.get(bookId) ?? "Archived book"),
    }));
  // The selected book may have been archived since the list loaded —
  // fall back to unbooked rather than holding a stale id.
  const effectiveBookId = extras.books.some((b) => b.id === selectedBook)
    ? selectedBook
    : "";
  const effectiveBookName =
    effectiveBookId !== "" ? bookNameById.get(effectiveBookId) : null;
  const bookSuffix = effectiveBookName ? ` for ${effectiveBookName}` : "";
  function logPages(fn: (bookId: string | null) => Promise<unknown>, doneMsg: string) {
    return run(() => fn(effectiveBookId || null), doneMsg);
  }
  const meditation = data.habits.find(
    (h) => h.name.toLowerCase() === "meditation"
  );
  const meditationDone = meditation
    ? logFor(data.habitLogs, meditation.id, dateKey)?.status === "done"
    : false;
  const journalWritten = extras.journalDates.includes(dateKey);

  return (
    <div className="flex flex-col gap-4">
      {flash && (
        <div
          className="surface-elevated card-pad text-sm text-center t-primary border-[#7C8CF8]/50"
          role="status"
        >
          {flash}
        </div>
      )}

      {/* quick actions */}
      <section aria-label="Quick actions">
        <h3 className="section-title mb-2">Quick actions</h3>
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          <QuickButton
            label={meditationDone ? "✓ Meditation" : "Meditation"}
            disabled={busy}
            onClick={() =>
              meditation &&
              run(
                () =>
                  toggleHabitDone(
                    meditation,
                    dateKey,
                    logFor(data.habitLogs, meditation.id, dateKey)
                      ?.status === "done"
                  ),
                meditationDone ? "Meditation unmarked." : "Meditation logged."
              )
            }
          />
          <QuickButton
            label="Start study"
            onClick={() => router.push("/study")}
          />
          <QuickButton
            label="Start workout"
            onClick={() => router.push("/training")}
          />
          <QuickButton
            label="✎ Journal"
            onClick={() =>
              router.push(`/progress?tab=reflection&date=${dateKey}`)
            }
          />
        </div>
        <div className="grid grid-cols-3 gap-2 mt-2">
          <div className="surface card-pad !p-3">
            <p className="text-xs t-secondary mb-1.5">Hifz · {hifzToday} ayahs</p>
            <div className="flex flex-wrap gap-1.5">
              {[1, 3, 5, 10].map((v) => (
                <button
                  key={v}
                  className="seg-btn !min-h-[36px] !px-2.5"
                  disabled={busy}
                  onClick={() =>
                    run(
                      () => quickLogCount("Hifz", dateKey, v),
                      `+${v} ayahs logged.`
                    )
                  }
                >
                  +{v}
                </button>
              ))}
            </div>
          </div>
          <div className="surface card-pad !p-3">
            <select
              className="input !min-h-[36px] !py-1.5 text-xs w-full mb-1.5"
              value={effectiveBookId}
              onChange={(e) => setSelectedBook(e.target.value)}
              disabled={busy}
              aria-label="Select book"
            >
              <option value="">No book</option>
              {extras.books.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <p className="text-xs t-secondary mb-1.5">
              Reading · {readingToday} pages
            </p>
            {readingByBook.size === 0 ? (
              <p className="text-xs t-faint mb-1.5">
                No reading logged today
              </p>
            ) : (
              readingBreakdown.map((line) => (
                <p
                  key={line.bookId === "" ? "unbooked" : line.bookId}
                  className="text-xs t-secondary tabular-nums mb-0.5 truncate"
                >
                  {line.label} · {line.pages} pages
                </p>
              ))
            )}
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {[5, 10, 20].map((v) => (
                <button
                  key={v}
                  className="seg-btn !min-h-[36px] !px-2.5"
                  disabled={busy}
                  onClick={() =>
                    logPages(
                      (bookId) => logReadingPages(dateKey, v, bookId),
                      `+${v} pages logged${bookSuffix}.`
                    )
                  }
                >
                  +{v}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              <input
                className="input !min-h-[36px] !py-1.5 text-xs flex-1 min-w-[56px]"
                type="number"
                min={1}
                inputMode="numeric"
                value={pagesInput}
                onChange={(e) => setPagesInput(e.target.value)}
                disabled={busy}
                aria-label="Pages"
                placeholder="Pages"
              />
              <button
                className="btn-primary !min-h-[36px] !px-3 text-xs shrink-0"
                disabled={busy}
                aria-label="Log reading pages"
                onClick={() => {
                  const n = Number(pagesInput);
                  if (!Number.isInteger(n) || n <= 0) {
                    note("Enter a positive number of pages.");
                    return;
                  }
                  logPages(async (bookId) => {
                    await logReadingPages(dateKey, n, bookId);
                    setPagesInput("");
                  }, `+${n} pages logged${bookSuffix}.`);
                }}
              >
                Add
              </button>
            </div>
          </div>
          <div className="surface card-pad !p-3">
            <p className="text-xs t-secondary mb-1.5">Incident</p>
            <select
              className="input !min-h-[36px] !py-1.5 text-xs"
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) setIncidentRule(e.target.value);
                e.target.value = "";
              }}
              aria-label="Log abstinence incident"
            >
              <option value="">Log incident…</option>
              {extras.rules.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      {/* reflection */}
      <section aria-label="Reflection">
        <h3 className="section-title mb-2">How was today?</h3>
        <div className="surface card-pad flex flex-col gap-2">
          <div className="flex gap-2">
            <button
              className="btn-ghost flex-1 !min-h-[44px]"
              onClick={() =>
                router.push(`/progress?tab=reflection&date=${dateKey}`)
              }
            >
              Journal &amp; daily review
            </button>
          </div>
          {journalWritten && (
            <p className="text-xs t-secondary" aria-live="polite">
              <span className="text-emerald-500 font-semibold">✓</span> Journal
              written today
            </p>
          )}
        </div>
      </section>

      {/* training */}
      <section aria-label="Training">
        <h3 className="section-title mb-2">Training</h3>
        <div className="surface card-pad">
          {training.loading ? (
            <p className="text-sm t-faint">Loading…</p>
          ) : scheduled ? (
            <div className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium t-primary">{scheduled.name}</p>
                <p className="text-xs t-secondary">
                  {scheduled.type === "structured"
                    ? `${exercisesFor(training.exercises, scheduled.id, true).length} exercises`
                    : (scheduled.description ?? "Completion workout")}
                  {todayWorkoutSession?.status === "completed"
                    ? " · ✓ completed"
                    : todayWorkoutSession?.status === "in_progress"
                      ? " · in progress"
                      : ""}
                </p>
              </div>
              <button
                className="btn-primary !min-h-[48px] shrink-0"
                onClick={() => router.push("/training")}
              >
                {todayWorkoutSession?.status === "in_progress"
                  ? "Continue"
                  : todayWorkoutSession
                    ? "Open"
                    : "Start workout"}
              </button>
            </div>
          ) : (
            <p className="text-sm t-secondary">
              <span className="font-semibold t-primary tracking-wide">REST DAY</span>
              {" — "}recovery is part of the plan.
            </p>
          )}
        </div>
      </section>

      {/* study */}
      <section aria-label="Study">
        <h3 className="section-title mb-2">Study</h3>
        <div className="surface card-pad">
          {study.loading ? (
            <p className="text-sm t-faint">Loading…</p>
          ) : (
            <div className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm t-primary">
                  Today:{" "}
                  <span className="font-semibold tabular-nums">
                    {formatDuration(studySeconds)}
                  </span>
                </p>
                {recentStudy && recentStudySubject && (
                  <p className="text-xs t-faint truncate">
                    Recent: {recentStudySubject.name}
                    {recentStudyTopic ? ` → ${recentStudyTopic.name}` : ""} ·{" "}
                    {formatDuration(recentStudy.duration_seconds)}
                  </p>
                )}
              </div>
              <button
                className="btn-primary !min-h-[48px] shrink-0"
                onClick={() => router.push("/study")}
              >
                Start study
              </button>
            </div>
          )}
        </div>
      </section>

      {/* abstinence */}
      <section aria-label="Abstinence">
        <h3 className="section-title mb-2">Abstinence</h3>
        <div className="surface card-pad flex flex-col gap-2">
          {extras.rules.length === 0 ? (
            <p className="text-sm t-secondary">
              No abstinence rules yet — add them on the Habits page.
            </p>
          ) : (
            extras.rules.map((r) => {
              const count = extras.incidents.filter((i) => i.rule_id === r.id).length;
              return (
                <div
                  key={r.id}
                  className="flex items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-2.5">
                    <span
                      className={`w-2.5 h-2.5 rounded-full ${
                        count === 0 ? "bg-emerald-500" : "bg-amber-400"
                      }`}
                      aria-hidden
                    />
                    <span className="text-sm t-primary">{r.name}</span>
                    {count > 0 && (
                      <span className="text-xs t-faint">
                        {count} incident{count === 1 ? "" : "s"} today
                      </span>
                    )}
                  </div>
                  <button
                    className="btn-ghost !min-h-[36px] !px-3 text-xs"
                    onClick={() => setIncidentRule(r.id)}
                  >
                    Log incident
                  </button>
                </div>
              );
            })
          )}
          <p className="text-xs t-faint mt-1">
            An incident is recorded data. It never resets your challenge.
          </p>
        </div>
      </section>

      {/* limits */}
      <section aria-label="Limits">
        <h3 className="section-title mb-2">Limits</h3>
        <div className="surface card-pad flex flex-col gap-3">
          {extras.limits.length === 0 ? (
            <p className="text-sm t-secondary">
              No usage limits yet — add them on the Habits page.
            </p>
          ) : (
            extras.limits.map((l) => {
              const log = extras.limitLogs.find((x) => x.limit_id === l.id);
              const used = log?.minutes_used ?? 0;
              const remaining = l.daily_limit_min - used;
              const over = remaining < 0;
              const pct = Math.min(100, (used / l.daily_limit_min) * 100);
              return (
                <div key={l.id}>
                  <div className="flex items-center justify-between gap-3 mb-1.5">
                    <span className="text-sm t-primary">{l.name}</span>
                    <button
                      className="btn-ghost !min-h-[36px] !px-3 text-xs"
                      onClick={() => setLimitToLog(l)}
                    >
                      Log time
                    </button>
                  </div>
                  <div className="h-2 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        over ? "bg-red-500" : "bg-[#7C8CF8]"
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <p className="text-xs t-secondary mt-1 tabular-nums">
                    {used} / {l.daily_limit_min} min
                    {over ? (
                      <span className="text-red-500 dark:text-red-400 font-medium">
                        {" "}
                        · +{-remaining} min over
                      </span>
                    ) : (
                      <span> · {remaining} min remaining</span>
                    )}
                  </p>
                </div>
              );
            })
          )}
        </div>
      </section>

      {/* incident modal */}
      {incidentRule && (
        <Modal
          title={`Log incident — ${extras.rules.find((r) => r.id === incidentRule)?.name ?? ""}`}
          onClose={() => {
            setIncidentRule(null);
            setTrigger("");
            setIncidentNote("");
          }}
        >
          <div className="flex flex-col gap-4">
            <p className="text-sm t-secondary">
              This records what happened. Nothing resets — it simply becomes
              part of your history.
            </p>
            <Field label="Trigger (optional)">
              <input
                className="input"
                value={trigger}
                onChange={(e) => setTrigger(e.target.value)}
                placeholder="What led to it?"
              />
            </Field>
            <Field label="Note (optional)">
              <textarea
                className="textarea"
                value={incidentNote}
                onChange={(e) => setIncidentNote(e.target.value)}
                placeholder="Anything worth remembering…"
              />
            </Field>
            <button
              className="btn-primary"
              disabled={busy}
              onClick={() =>
                run(
                  async () => {
                    await logIncident(
                      incidentRule,
                      trigger.trim(),
                      incidentNote.trim()
                    );
                    setIncidentRule(null);
                    setTrigger("");
                    setIncidentNote("");
                  },
                  "Incident recorded."
                )
              }
            >
              {busy ? "Saving…" : "Record incident"}
            </button>
          </div>
        </Modal>
      )}

      {/* limit logging modal */}
      {limitToLog && (
        <Modal title={`Log ${limitToLog.name}`} onClose={() => setLimitToLog(null)}>
          <div className="flex flex-col gap-4">
            <Field label="Minutes used">
              <input
                className="input"
                type="number"
                min={1}
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
                autoFocus
              />
            </Field>
            <div className="flex gap-2 flex-wrap">
              {[5, 15, 30, 60].map((v) => (
                <button
                  key={v}
                  className="seg-btn"
                  onClick={() => setMinutes(String(v))}
                >
                  {v} min
                </button>
              ))}
            </div>
            <button
              className="btn-primary"
              disabled={busy || !Number(minutes)}
              onClick={() =>
                run(
                  async () => {
                    await addLimitMinutes(
                      limitToLog.id,
                      dateKey,
                      Number(minutes)
                    );
                    setLimitToLog(null);
                    setMinutes("15");
                  },
                  `${minutes} minutes logged.`
                )
              }
            >
              {busy ? "Saving…" : "Log time"}
            </button>
          </div>
        </Modal>
      )}

    </div>
  );
}
