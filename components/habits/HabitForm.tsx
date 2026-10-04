"use client";

import { useState, type FormEvent } from "react";
import { getDb } from "@/lib/sync/write";
import { Field } from "@/components/ui";
import type { Habit, HabitTracking } from "@/lib/types";

export function HabitForm({
  initial,
  onSaved,
  onDeleted,
}: {
  initial?: Habit;
  onSaved: () => void;
  onDeleted?: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [tracking, setTracking] = useState<HabitTracking>(
    initial?.tracking ?? "completion"
  );
  const [frequency, setFrequency] = useState<"daily" | "weekly">(
    initial?.frequency ?? "daily"
  );
  const [weeklyTarget, setWeeklyTarget] = useState(
    initial?.weekly_target != null ? String(initial.weekly_target) : ""
  );
  const [preferredTime, setPreferredTime] = useState(
    initial?.preferred_time ?? ""
  );
  const [isActive, setIsActive] = useState(initial?.is_active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const db = getDb();
      const row = {
        name: name.trim(),
        description: description.trim() || null,
        tracking,
        frequency,
        weekly_target:
          frequency === "weekly" && weeklyTarget
            ? Number(weeklyTarget)
            : null,
        preferred_time: preferredTime || null,
        is_active: isActive,
      };
      if (initial) await db.update("habits", initial.id, row);
      else await db.insert("habits", { ...row, sort_order: 0 });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save habit.");
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!initial) return;
    setBusy(true);
    try {
      const db = getDb();
      await db.remove("habits", initial.id);
      onDeleted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete habit.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Field label="Name">
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Meditation"
          required
          autoFocus
        />
      </Field>
      <Field label="Description (optional)">
        <input
          className="input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What does done look like?"
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Tracking">
          <select
            className="input"
            value={tracking}
            onChange={(e) => setTracking(e.target.value as HabitTracking)}
          >
            <option value="completion">Completion</option>
            <option value="count">Count (number)</option>
            <option value="duration">Duration (minutes)</option>
          </select>
        </Field>
        <Field label="Frequency">
          <select
            className="input"
            value={frequency}
            onChange={(e) =>
              setFrequency(e.target.value as "daily" | "weekly")
            }
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </Field>
      </div>
      {frequency === "weekly" && (
        <Field label="Weekly target">
          <input
            className="input"
            type="number"
            min={1}
            value={weeklyTarget}
            onChange={(e) => setWeeklyTarget(e.target.value)}
            placeholder="e.g. 2"
          />
        </Field>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Preferred time (optional)">
          <input
            className="input"
            type="time"
            value={preferredTime}
            onChange={(e) => setPreferredTime(e.target.value)}
          />
        </Field>
        <Field label="Status">
          <select
            className="input"
            value={isActive ? "active" : "paused"}
            onChange={(e) => setIsActive(e.target.value === "active")}
          >
            <option value="active">Active</option>
            <option value="paused">Paused</option>
          </select>
        </Field>
      </div>
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
        <button className="btn-primary" disabled={busy || !name.trim()}>
          {busy ? "Saving…" : initial ? "Save changes" : "Add habit"}
        </button>
      </div>
    </form>
  );
}
