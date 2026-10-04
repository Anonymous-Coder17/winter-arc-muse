"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { ConfirmInline, Field, Modal, SegControl } from "@/components/ui";
import { WEEKDAY_LABELS } from "@/lib/training";
import { exercisesFor } from "./useTraining";
import type {
  ExerciseType,
  TrainingScheduleRow,
  Workout,
  WorkoutExercise,
  WorkoutType,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// WorkoutForm — create / edit a workout definition
// ---------------------------------------------------------------------------

export function WorkoutForm({
  initial,
  onSaved,
}: {
  initial?: Workout | null;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [type, setType] = useState<WorkoutType>(initial?.type ?? "structured");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [videoRef, setVideoRef] = useState(initial?.video_ref ?? "");
  const [isActive, setIsActive] = useState(initial?.is_active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) {
      setError("Give the workout a name.");
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
      const payload = {
        owner: user.id,
        name: name.trim(),
        type,
        description: description.trim() || null,
        video_ref: type === "completion" ? videoRef.trim() || null : null,
        is_active: isActive,
      };
      const { error } = initial
        ? await supabase.from("workouts").update(payload).eq("id", initial.id)
        : await supabase.from("workouts").insert(payload);
      if (error) throw error;
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save workout.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Field label="Name">
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. HSPU, Abs, Legs"
          autoFocus
        />
      </Field>
      <div>
        <span className="label">Type</span>
        <SegControl<WorkoutType>
          ariaLabel="Workout type"
          value={type}
          onChange={setType}
          options={[
            { value: "structured", label: "Structured · sets & reps" },
            { value: "completion", label: "Completion · done or not" },
          ]}
        />
        <p className="text-xs t-faint mt-1.5">
          {type === "structured"
            ? "Exercises with sets — reps or timed holds."
            : "Just mark it done. No set tracking."}
        </p>
      </div>
      <Field label="Description (optional)">
        <input
          className="input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What is this workout?"
        />
      </Field>
      {type === "completion" && (
        <Field label="Video reference (optional)">
          <input
            className="input"
            value={videoRef}
            onChange={(e) => setVideoRef(e.target.value)}
            placeholder="e.g. 20-minute abs video"
          />
        </Field>
      )}
      <label className="flex items-center gap-3 text-sm t-primary cursor-pointer">
        <input
          type="checkbox"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
          className="w-5 h-5 accent-[#5A6AE0]"
        />
        Active
      </label>
      {error && <p className="text-sm text-red-500 dark:text-red-400">{error}</p>}
      <button className="btn-primary" disabled={busy} onClick={save}>
        {busy ? "Saving…" : initial ? "Save changes" : "Create workout"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ExerciseManager — exercises inside a structured workout
// ---------------------------------------------------------------------------

export function ExerciseManager({
  workout,
  exercises,
  onChanged,
}: {
  workout: Workout;
  exercises: WorkoutExercise[];
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [exType, setExType] = useState<ExerciseType>("reps");
  const [notes, setNotes] = useState("");
  const [editing, setEditing] = useState<WorkoutExercise | null>(null);
  const [deleting, setDeleting] = useState<WorkoutExercise | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const list = exercisesFor(exercises, workout.id);

  async function authed() {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new Error("Not signed in.");
    return { supabase, user };
  }

  async function saveExercise() {
    const target = editing;
    const n = (target ? editing!.name : name).trim();
    if (!n) {
      setError("Give the exercise a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { supabase, user } = await authed();
      if (target) {
        const { error } = await supabase
          .from("workout_exercises")
          .update({
            name: n,
            exercise_type: exType,
            notes: notes.trim() || null,
          })
          .eq("id", target.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("workout_exercises").insert({
          owner: user.id,
          workout_id: workout.id,
          name: n,
          exercise_type: exType,
          notes: notes.trim() || null,
          sort_order: list.length + 1,
        });
        if (error) throw error;
      }
      setName("");
      setNotes("");
      setExType("reps");
      setEditing(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save exercise.");
    } finally {
      setBusy(false);
    }
  }

  async function removeExercise(ex: WorkoutExercise) {
    setBusy(true);
    setError(null);
    try {
      const { supabase } = await authed();
      const { error } = await supabase
        .from("workout_exercises")
        .delete()
        .eq("id", ex.id);
      if (error) throw error;
      setDeleting(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete exercise.");
    } finally {
      setBusy(false);
    }
  }

  async function move(ex: WorkoutExercise, dir: -1 | 1) {
    const idx = list.findIndex((e) => e.id === ex.id);
    const other = list[idx + dir];
    if (!other) return;
    setBusy(true);
    try {
      const { supabase } = await authed();
      // swap sort orders
      const { error } = await supabase
        .from("workout_exercises")
        .update({ sort_order: other.sort_order })
        .eq("id", ex.id);
      if (error) throw error;
      const { error: err2 } = await supabase
        .from("workout_exercises")
        .update({ sort_order: ex.sort_order })
        .eq("id", other.id);
      if (err2) throw err2;
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reorder.");
    } finally {
      setBusy(false);
    }
  }

  function startEdit(ex: WorkoutExercise) {
    setEditing(ex);
    setName(ex.name);
    setExType(ex.exercise_type);
    setNotes(ex.notes ?? "");
  }

  return (
    <div className="flex flex-col gap-3">
      {list.length === 0 ? (
        <p className="text-sm t-secondary">
          No exercises yet — add the first one below.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {list.map((ex, i) => (
            <li
              key={ex.id}
              className="surface card-pad !p-3 flex items-center gap-2"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm t-primary font-medium">{ex.name}</p>
                <p className="text-xs t-faint">
                  {ex.exercise_type === "reps" ? "Reps" : "Timed hold"}
                  {ex.notes ? ` · ${ex.notes}` : ""}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  className="btn-ghost !min-h-[36px] !px-2 text-xs"
                  disabled={busy || i === 0}
                  onClick={() => move(ex, -1)}
                  aria-label={`Move ${ex.name} up`}
                >
                  ↑
                </button>
                <button
                  className="btn-ghost !min-h-[36px] !px-2 text-xs"
                  disabled={busy || i === list.length - 1}
                  onClick={() => move(ex, 1)}
                  aria-label={`Move ${ex.name} down`}
                >
                  ↓
                </button>
                <button
                  className="btn-ghost !min-h-[36px] !px-2.5 text-xs"
                  disabled={busy}
                  onClick={() => startEdit(ex)}
                >
                  Edit
                </button>
                <button
                  className="btn-ghost !min-h-[36px] !px-2.5 text-xs text-red-500 dark:text-red-400"
                  disabled={busy}
                  onClick={() => setDeleting(ex)}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {deleting && (
        <ConfirmInline
          message={`Remove “${deleting.name}”? Its recorded sets stay in history.`}
          confirmLabel="Remove"
          onConfirm={() => removeExercise(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}

      <div className="surface-elevated card-pad !p-3 flex flex-col gap-3">
        <p className="text-sm font-medium t-primary">
          {editing ? `Edit “${editing.name}”` : "Add exercise"}
        </p>
        <Field label="Exercise name">
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Wall HSPU"
          />
        </Field>
        <div>
          <span className="label">Records</span>
          <SegControl<ExerciseType>
            ariaLabel="Exercise type"
            value={exType}
            onChange={setExType}
            options={[
              { value: "reps", label: "Reps" },
              { value: "time", label: "Timed hold" },
            ]}
          />
        </div>
        <Field label="Notes (optional)">
          <input
            className="input"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Cues, form reminders…"
          />
        </Field>
        {error && <p className="text-sm text-red-500 dark:text-red-400">{error}</p>}
        <div className="flex gap-2">
          <button className="btn-primary flex-1" disabled={busy} onClick={saveExercise}>
            {busy ? "Saving…" : editing ? "Save exercise" : "Add exercise"}
          </button>
          {editing && (
            <button
              className="btn-secondary"
              disabled={busy}
              onClick={() => {
                setEditing(null);
                setName("");
                setNotes("");
                setExType("reps");
              }}
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ScheduleEditor — weekly plan: weekday → workout (or Rest)
// ---------------------------------------------------------------------------

export function ScheduleEditor({
  schedule,
  workouts,
  onChanged,
}: {
  schedule: TrainingScheduleRow[];
  workouts: Workout[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = workouts.filter((w) => w.is_active);

  async function setDay(weekday: number, workoutId: string | null) {
    setBusy(weekday);
    setError(null);
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in.");
      const { error } = await supabase.from("training_schedule").upsert(
        { owner: user.id, weekday, workout_id: workoutId },
        { onConflict: "owner,weekday" }
      );
      if (error) throw error;
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save schedule.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {WEEKDAY_LABELS.map((label, wd) => {
        const row = schedule.find((r) => r.weekday === wd);
        const current = row?.workout_id ?? "";
        return (
          <div
            key={wd}
            className="surface card-pad !p-3 flex items-center gap-3"
          >
            <span className="text-sm font-medium t-primary w-24 shrink-0">
              {label}
            </span>
            <select
              className="input !min-h-[44px] flex-1"
              value={current}
              disabled={busy !== null}
              onChange={(e) => setDay(wd, e.target.value || null)}
              aria-label={`${label} workout`}
            >
              <option value="">Rest day</option>
              {active.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            {busy === wd && <span className="text-xs t-faint">Saving…</span>}
          </div>
        );
      })}
      {error && <p className="text-sm text-red-500 dark:text-red-400">{error}</p>}
      <p className="text-xs t-faint">
        Rest days are first-class — they are never shown as missed workouts.
      </p>
    </div>
  );
}

/** Small wrapper to open WorkoutForm in a modal. */
export function WorkoutModal({
  title,
  initial,
  onClose,
  onSaved,
}: {
  title: string;
  initial?: Workout | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <WorkoutForm
        initial={initial}
        onSaved={() => {
          onSaved();
          onClose();
        }}
      />
    </Modal>
  );
}
