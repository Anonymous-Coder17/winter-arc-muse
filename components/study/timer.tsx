"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Field } from "@/components/ui";
import { formatDuration, formatHMS, todayKey, utcToDayKey } from "@/lib/dates";
import { topicsFor } from "./useStudy";
import type { Subject, Topic } from "@/lib/types";

const TIMER_KEY = "winter-arc-study-timer";

interface PersistedTimer {
  subjectId: string;
  topicId: string | null;
  sessionStart: number; // epoch ms of the very first Start
  runStart: number | null; // epoch ms the current running segment began (null = paused)
  accumulatedMs: number; // completed segments
}

function loadPersisted(): PersistedTimer | null {
  try {
    const raw = localStorage.getItem(TIMER_KEY);
    return raw ? (JSON.parse(raw) as PersistedTimer) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// StudyTimer — real timer: start / pause / resume / finish.
// Timing lives in refs + localStorage; React state is only the display tick,
// so re-renders and navigation never lose the session.
// ---------------------------------------------------------------------------

export function StudyTimer({
  subjects,
  topics,
  onSaved,
}: {
  subjects: Subject[];
  topics: Topic[];
  onSaved: () => void;
}) {
  const [subjectId, setSubjectId] = useState("");
  const [topicId, setTopicId] = useState("");
  const [timer, setTimer] = useState<PersistedTimer | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // rehydrate on mount
  useEffect(() => {
    const t = loadPersisted();
    if (t) {
      setTimer(t);
      setSubjectId(t.subjectId);
      setTopicId(t.topicId ?? "");
    }
  }, []);

  const running = timer !== null && timer.runStart !== null;

  // tick while running
  useEffect(() => {
    if (!running) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    intervalRef.current = setInterval(() => setNow(Date.now()), 500);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [running]);

  const elapsedMs = useMemo(() => {
    if (!timer) return 0;
    return (
      timer.accumulatedMs +
      (timer.runStart !== null ? Math.max(0, now - timer.runStart) : 0)
    );
  }, [timer, now]);

  function persist(t: PersistedTimer | null) {
    setTimer(t);
    try {
      if (t) localStorage.setItem(TIMER_KEY, JSON.stringify(t));
      else localStorage.removeItem(TIMER_KEY);
    } catch {
      /* storage unavailable — timer still works in-memory */
    }
  }

  function start() {
    if (!subjectId) {
      setError("Choose a subject first.");
      return;
    }
    setError(null);
    const t: PersistedTimer = {
      subjectId,
      topicId: topicId || null,
      sessionStart: Date.now(),
      runStart: Date.now(),
      accumulatedMs: 0,
    };
    persist(t);
  }

  function pause() {
    if (!timer || timer.runStart === null) return;
    persist({
      ...timer,
      accumulatedMs: timer.accumulatedMs + Math.max(0, Date.now() - timer.runStart),
      runStart: null,
    });
    setNow(Date.now());
  }

  function resume() {
    if (!timer || timer.runStart !== null) return;
    persist({ ...timer, runStart: Date.now() });
  }

  function cancel() {
    persist(null);
    setError(null);
  }

  async function finish() {
    if (!timer) return;
    const seconds = Math.round(elapsedMs / 1000);
    if (seconds < 1) {
      setError("The timer barely ran — nothing to save yet.");
      return;
    }
    const subject = subjects.find((s) => s.id === timer.subjectId);
    if (!subject) {
      setError("That subject no longer exists. Discard this timer and start over.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in.");
      const startedAt = new Date(timer.sessionStart).toISOString();
      const completedAt = new Date().toISOString();
      const { error } = await supabase.from("study_sessions").insert({
        owner: user.id,
        subject_id: timer.subjectId,
        topic_id: timer.topicId,
        session_date: utcToDayKey(startedAt),
        started_at: startedAt,
        completed_at: completedAt,
        duration_seconds: seconds,
      });
      if (error) throw error;
      persist(null);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save session.");
    } finally {
      setBusy(false);
    }
  }

  const activeSubjects = subjects.filter((s) => s.is_active);
  const subjectTopics = topicsFor(topics, subjectId).filter((t) => t.is_active);
  const timerSubject = subjects.find((s) => s.id === timer?.subjectId);
  const timerTopic = topics.find((t) => t.id === timer?.topicId);

  if (subjects.length === 0) {
    return (
      <p className="text-sm t-secondary">
        Create a subject below before starting the timer.
      </p>
    );
  }

  // -- running / paused ------------------------------------------------------
  if (timer) {
    return (
      <div className="flex flex-col items-center gap-4 py-2">
        <div className="text-center">
          <p className="text-xs uppercase tracking-[0.18em] t-faint">
            {timerSubject?.name ?? "Study"}
          </p>
          {timerTopic && (
            <p className="text-sm t-secondary mt-0.5">{timerTopic.name}</p>
          )}
        </div>
        <p
          className="text-5xl font-semibold t-primary tabular-nums tracking-tight"
          aria-live="polite"
        >
          {formatHMS(elapsedMs / 1000)}
        </p>
        <p className="text-xs t-faint -mt-2">
          {running ? "Timer running" : `Paused · ${formatDuration(elapsedMs / 1000)} so far`}
        </p>
        {error && (
          <p className="text-sm text-red-500 dark:text-red-400 text-center">{error}</p>
        )}
        <div className="flex gap-2 w-full max-w-xs">
          {running ? (
            <button className="btn-secondary flex-1 !min-h-[52px]" onClick={pause}>
              Pause
            </button>
          ) : (
            <button className="btn-secondary flex-1 !min-h-[52px]" onClick={resume}>
              Resume
            </button>
          )}
          <button
            className="btn-primary flex-1 !min-h-[52px]"
            disabled={busy}
            onClick={finish}
          >
            {busy ? "Saving…" : "Finish"}
          </button>
        </div>
        <button
          className="btn-ghost !min-h-[40px] text-xs t-faint"
          onClick={cancel}
        >
          Discard timer
        </button>
      </div>
    );
  }

  // -- idle ------------------------------------------------------------------
  return (
    <div className="flex flex-col gap-4">
      <Field label="Subject">
        <select
          className="input"
          value={subjectId}
          onChange={(e) => {
            setSubjectId(e.target.value);
            setTopicId("");
          }}
          aria-label="Subject"
        >
          <option value="">Choose a subject…</option>
          {activeSubjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Topic (optional)">
        <select
          className="input"
          value={topicId}
          onChange={(e) => setTopicId(e.target.value)}
          disabled={!subjectId}
          aria-label="Topic"
        >
          <option value="">No specific topic</option>
          {subjectTopics.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </Field>
      {error && <p className="text-sm text-red-500 dark:text-red-400">{error}</p>}
      <button
        className="btn-primary !min-h-[56px] text-base"
        disabled={!subjectId}
        onClick={start}
      >
        ▶ Start studying
      </button>
      <p className="text-xs t-faint text-center">
        The timer keeps running if you navigate away — come back and finish it here.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ManualStudyForm — record a session that didn't go through the timer
// ---------------------------------------------------------------------------

export function ManualStudyForm({
  subjects,
  topics,
  onSaved,
}: {
  subjects: Subject[];
  topics: Topic[];
  onSaved: () => void;
}) {
  const [subjectId, setSubjectId] = useState("");
  const [topicId, setTopicId] = useState("");
  const [minutes, setMinutes] = useState("45");
  const [date, setDate] = useState(todayKey());
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeSubjects = subjects.filter((s) => s.is_active);
  const subjectTopics = topicsFor(topics, subjectId).filter((t) => t.is_active);

  async function save() {
    const mins = Math.round(Number(minutes));
    if (!subjectId) {
      setError("Choose a subject.");
      return;
    }
    if (!mins || mins <= 0) {
      setError("Enter a duration in minutes.");
      return;
    }
    if (!date) {
      setError("Choose a date.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in.");
      const startedAt = new Date(`${date}T12:00:00`);
      const completedAt = new Date(startedAt.getTime() + mins * 60_000);
      const { error } = await supabase.from("study_sessions").insert({
        owner: user.id,
        subject_id: subjectId,
        topic_id: topicId || null,
        session_date: date,
        started_at: startedAt.toISOString(),
        completed_at: completedAt.toISOString(),
        duration_seconds: mins * 60,
        notes: notes.trim() || null,
      });
      if (error) throw error;
      setMinutes("45");
      setNotes("");
      setTopicId("");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save session.");
    } finally {
      setBusy(false);
    }
  }

  if (subjects.length === 0) {
    return (
      <p className="text-sm t-secondary">Create a subject below first.</p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Subject">
          <select
            className="input"
            value={subjectId}
            onChange={(e) => {
              setSubjectId(e.target.value);
              setTopicId("");
            }}
            aria-label="Subject"
          >
            <option value="">Choose…</option>
            {activeSubjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Topic (optional)">
          <select
            className="input"
            value={topicId}
            onChange={(e) => setTopicId(e.target.value)}
            disabled={!subjectId}
            aria-label="Topic"
          >
            <option value="">None</option>
            {subjectTopics.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Duration (minutes)">
          <input
            className="input"
            type="number"
            inputMode="numeric"
            min={1}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
        </Field>
        <Field label="Date">
          <input
            className="input"
            type="date"
            value={date}
            max={todayKey()}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
      </div>
      <div className="flex gap-2 flex-wrap">
        {[15, 30, 45, 60, 90, 120].map((v) => (
          <button
            key={v}
            className="seg-btn"
            onClick={() => setMinutes(String(v))}
          >
            {v}m
          </button>
        ))}
      </div>
      <Field label="Notes (optional)">
        <textarea
          className="textarea"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="What did you work on?"
        />
      </Field>
      {error && <p className="text-sm text-red-500 dark:text-red-400">{error}</p>}
      <button className="btn-primary" disabled={busy} onClick={save}>
        {busy ? "Saving…" : "Log session"}
      </button>
    </div>
  );
}
