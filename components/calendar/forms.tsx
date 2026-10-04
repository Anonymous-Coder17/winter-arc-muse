"use client";

import { useState, type FormEvent } from "react";
import { getDb } from "@/lib/sync/write";
import { Field } from "@/components/ui";
import type { Task, TaskKind, TaskState } from "@/lib/types";

const KINDS: { value: TaskKind; label: string }[] = [
  { value: "general", label: "General" },
  { value: "workout", label: "Workout" },
  { value: "study", label: "Study" },
  { value: "hifz", label: "Hifz" },
  { value: "reading", label: "Reading" },
  { value: "journal", label: "Journal" },
];

export function TaskForm({
  dateKey,
  initial,
  presetKind,
  showDateField,
  onSaved,
  onDeleted,
}: {
  dateKey: string;
  initial?: Task;
  presetKind?: TaskKind;
  /** when true, the user can pick the task's date (default: locked to dateKey) */
  showDateField?: boolean;
  onSaved: () => void;
  onDeleted?: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [taskDate, setTaskDate] = useState(initial?.task_date ?? dateKey);
  const [start, setStart] = useState(initial?.start_time ?? "");
  const [end, setEnd] = useState(initial?.end_time ?? "");
  const [kind, setKind] = useState<TaskKind>(initial?.kind ?? presetKind ?? "general");
  const [state, setState] = useState<TaskState>(initial?.state ?? "planned");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const db = getDb();
      const row = {
        title: title.trim(),
        task_date: showDateField ? taskDate : dateKey,
        start_time: start || null,
        end_time: end || null,
        kind,
        state,
        notes: notes.trim() || null,
      };
      if (initial) await db.update("tasks", initial.id, row);
      else await db.insert("tasks", row);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save task.");
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!initial) return;
    setBusy(true);
    try {
      const db = getDb();
      await db.remove("tasks", initial.id);
      onDeleted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete task.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Field label="Title">
        <input
          className="input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs doing?"
          required
          autoFocus
        />
      </Field>
      {showDateField && (
        <Field label="Date">
          <input
            className="input"
            type="date"
            value={taskDate}
            onChange={(e) => setTaskDate(e.target.value)}
            required
          />
        </Field>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Start time (optional)">
          <input
            className="input"
            type="time"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </Field>
        <Field label="End time (optional)">
          <input
            className="input"
            type="time"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Type">
          <select
            className="input"
            value={kind}
            onChange={(e) => setKind(e.target.value as TaskKind)}
          >
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="State">
          <select
            className="input"
            value={state}
            onChange={(e) => setState(e.target.value as TaskState)}
          >
            <option value="planned">Planned</option>
            <option value="done">Done — actually happened</option>
            <option value="not_done">Not done — day passed</option>
          </select>
        </Field>
      </div>
      <Field label="Notes (optional)">
        <textarea
          className="textarea"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Anything worth remembering…"
        />
      </Field>
      {error && (
        <p className="text-sm text-red-500 dark:text-red-400" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-2 justify-between">
        <div>
          {initial && onDeleted && (
            <button
              type="button"
              className="btn-danger"
              onClick={onDelete}
              disabled={busy}
            >
              Delete
            </button>
          )}
        </div>
        <button className="btn-primary" disabled={busy || !title.trim()}>
          {busy ? "Saving…" : initial ? "Save changes" : "Add task"}
        </button>
      </div>
    </form>
  );
}

export function EventForm({
  dateKey,
  initial,
  onSaved,
  onDeleted,
}: {
  dateKey: string;
  initial?: import("@/lib/types").CalendarEvent;
  onSaved: () => void;
  onDeleted?: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [start, setStart] = useState(initial?.start_time ?? "");
  const [end, setEnd] = useState(initial?.end_time ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || !start || !end) return;
    setBusy(true);
    setError(null);
    try {
      const db = getDb();
      const row = {
        title: title.trim(),
        event_date: dateKey,
        start_time: start,
        end_time: end,
        notes: notes.trim() || null,
      };
      if (initial) await db.update("calendar_events", initial.id, row);
      else await db.insert("calendar_events", row);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save event.");
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!initial) return;
    setBusy(true);
    try {
      const db = getDb();
      await db.remove("calendar_events", initial.id);
      onDeleted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete event.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Field label="Title">
        <input
          className="input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Event name"
          required
          autoFocus
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Start time">
          <input
            className="input"
            type="time"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            required
          />
        </Field>
        <Field label="End time">
          <input
            className="input"
            type="time"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            required
          />
        </Field>
      </div>
      <Field label="Notes (optional)">
        <textarea
          className="textarea"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Anything worth remembering…"
        />
      </Field>
      {error && (
        <p className="text-sm text-red-500 dark:text-red-400" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-2 justify-between">
        <div>
          {initial && onDeleted && (
            <button
              type="button"
              className="btn-danger"
              onClick={onDelete}
              disabled={busy}
            >
              Delete
            </button>
          )}
        </div>
        <button
          className="btn-primary"
          disabled={busy || !title.trim() || !start || !end}
        >
          {busy ? "Saving…" : initial ? "Save changes" : "Add event"}
        </button>
      </div>
    </form>
  );
}
