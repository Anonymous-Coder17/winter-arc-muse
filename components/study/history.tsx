"use client";

import { useMemo, useState } from "react";
import { EmptyState } from "@/components/ui";
import {
  addDays,
  formatDuration,
  formatShort,
  todayKey,
  weekStartMonday,
} from "@/lib/dates";
import { sessionsInRange, sumDurations, totalsBySubject } from "@/lib/study";
import { topicsFor } from "./useStudy";
import type { StudySession, Subject, Topic } from "@/lib/types";

// ---------------------------------------------------------------------------
// StudyTotals — today / week / month + per-subject breakdown. No charts.
// ---------------------------------------------------------------------------

export function StudyTotals({
  sessions,
  subjects,
}: {
  sessions: StudySession[];
  subjects: Subject[];
}) {
  const today = todayKey();
  const weekStart = weekStartMonday(today);
  const monthStart = today.slice(0, 8) + "01";

  const todaySecs = sumDurations(sessionsInRange(sessions, today, today));
  const weekSecs = sumDurations(
    sessionsInRange(sessions, weekStart, addDays(weekStart, 6))
  );
  const monthSecs = sumDurations(sessionsInRange(sessions, monthStart, today));
  const bySubject = totalsBySubject(sessions, subjects);

  const cards = [
    { label: "Today", seconds: todaySecs },
    { label: "This week", seconds: weekSecs },
    { label: "This month", seconds: monthSecs },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-2">
        {cards.map((c) => (
          <div key={c.label} className="surface card-pad !p-3 text-center">
            <p className="text-[11px] uppercase tracking-wide t-faint">{c.label}</p>
            <p className="text-lg font-semibold t-primary tabular-nums mt-1">
              {formatDuration(c.seconds)}
            </p>
          </div>
        ))}
      </div>
      {bySubject.length > 0 && (
        <div className="surface card-pad">
          <h3 className="section-title mb-2">Time by subject</h3>
          <div className="flex flex-col gap-1.5">
            {bySubject.map(({ subject, seconds }) => (
              <div
                key={subject.id}
                className="flex items-center justify-between gap-3"
              >
                <span className="text-sm t-primary">{subject.name}</span>
                <span className="text-sm t-secondary tabular-nums">
                  {formatDuration(seconds)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// StudyHistory — filterable session list
// ---------------------------------------------------------------------------

export function StudyHistory({
  sessions,
  subjects,
  topics,
}: {
  sessions: StudySession[];
  subjects: Subject[];
  topics: Topic[];
}) {
  const [subjectId, setSubjectId] = useState("");
  const [topicId, setTopicId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const subjectName = useMemo(() => {
    const m = new Map(subjects.map((s) => [s.id, s.name]));
    return (id: string) => m.get(id) ?? "Subject";
  }, [subjects]);
  const topicName = useMemo(() => {
    const m = new Map(topics.map((t) => [t.id, t.name]));
    return (id: string | null) => (id ? (m.get(id) ?? null) : null);
  }, [topics]);

  const filteredTopics = subjectId
    ? topicsFor(topics, subjectId)
    : topics;

  const filtered = useMemo(() => {
    return sessions.filter((s) => {
      if (subjectId && s.subject_id !== subjectId) return false;
      if (topicId && s.topic_id !== topicId) return false;
      if (from && s.session_date < from) return false;
      if (to && s.session_date > to) return false;
      return true;
    });
  }, [sessions, subjectId, topicId, from, to]);

  const hasFilters = subjectId || topicId || from || to;

  if (sessions.length === 0) {
    return (
      <EmptyState
        title="No study sessions yet"
        body="Start the timer above or log a session manually — it will show up here."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <select
          className="input !min-h-[44px] text-sm"
          value={subjectId}
          onChange={(e) => {
            setSubjectId(e.target.value);
            setTopicId("");
          }}
          aria-label="Filter by subject"
        >
          <option value="">All subjects</option>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          className="input !min-h-[44px] text-sm"
          value={topicId}
          onChange={(e) => setTopicId(e.target.value)}
          aria-label="Filter by topic"
        >
          <option value="">All topics</option>
          {filteredTopics.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <input
          className="input !min-h-[44px] text-sm"
          type="date"
          value={from}
          max={todayKey()}
          onChange={(e) => setFrom(e.target.value)}
          aria-label="From date"
        />
        <input
          className="input !min-h-[44px] text-sm"
          type="date"
          value={to}
          max={todayKey()}
          onChange={(e) => setTo(e.target.value)}
          aria-label="To date"
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="Nothing matches"
          body="Try widening the filters."
          action={
            hasFilters ? (
              <button
                className="btn-secondary"
                onClick={() => {
                  setSubjectId("");
                  setTopicId("");
                  setFrom("");
                  setTo("");
                }}
              >
                Clear filters
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="surface card-pad flex flex-col gap-1">
          {filtered.map((s) => {
            const tn = topicName(s.topic_id);
            return (
              <div
                key={s.id}
                className="flex items-center gap-3 rounded-xl px-2 py-2"
              >
                <span className="text-xs t-faint w-16 shrink-0">
                  {formatShort(s.session_date)}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm t-primary truncate">
                    {subjectName(s.subject_id)}
                    {tn ? (
                      <span className="t-faint"> → {tn}</span>
                    ) : null}
                  </p>
                  {s.notes && (
                    <p className="text-xs t-faint truncate">{s.notes}</p>
                  )}
                </div>
                <span className="text-sm t-secondary tabular-nums shrink-0">
                  {formatDuration(s.duration_seconds)}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <p className="text-xs t-faint">
        {filtered.length} session{filtered.length === 1 ? "" : "s"} ·{" "}
        {formatDuration(sumDurations(filtered))} total
      </p>
    </div>
  );
}
