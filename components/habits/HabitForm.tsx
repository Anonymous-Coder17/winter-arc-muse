"use client";

import { useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
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
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in.");
      const row = {
        owner: user.id,
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
      const { error } = initial
        ? await supabase.from("habits").update(row).eq("id", initial.id)
        : await supabase.from("habits").insert({ ...row, sort_order: 0 });
      if (error) throw error;
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
      const supabase = createClient();
      const { error } = await supabase
        .from("habits")
        .delete()
        .eq("id", initial.id);
      if (error) throw error;
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
