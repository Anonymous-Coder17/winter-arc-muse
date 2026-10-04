"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Field, Modal } from "@/components/ui";
import {
  nextSetNumber,
  previousSession,
  setsForExercise,
  summarizeExerciseSets,
} from "@/lib/training";
import { exercisesFor } from "./useTraining";
import type {
  Workout,
  WorkoutExercise,
  WorkoutSession,
  WorkoutSet,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// SessionLogger — log (or review) a workout session for a date.
// Structured workouts: per-exercise set inputs with previous performance.
// Completion workouts: notes + mark complete.
// ---------------------------------------------------------------------------

export function SessionLogger({
  workout,
  exercises,
  sessions,
  sets,
  dateKey,
  onClose,
  onSaved,
}: {
  workout: Workout;
  exercises: WorkoutExercise[];
  sessions: WorkoutSession[];
  sets: WorkoutSet[];
  dateKey: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [session, setSession] = useState<WorkoutSession | null>(() =>
    sessions.find(
      (s) =>
        s.workout_id === workout.id &&
        s.session_date === dateKey &&
        s.status === "in_progress"
    ) ?? null
  );
  const [localSets, setLocalSets] = useState<WorkoutSet[]>([]);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const exList = useMemo(
    () => exercisesFor(exercises, workout.id, true),
    [exercises, workout.id]
  );

  // Load this session's sets + notes when the session is (re)created.
  useEffect(() => {
    if (!session) {
      setLocalSets([]);
      setNotes("");
      return;
    }
    const sessionId: string = session.id;
    const sessionNotes: string | null = session.notes;
    let cancelled = false;
    async function loadSets() {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("workout_sets")
        .select("*")
        .eq("session_id", sessionId)
        .order("set_number");
      if (!cancelled && !error) {
        setLocalSets((data ?? []) as WorkoutSet[]);
        setNotes(sessionNotes ?? "");
      }
    }
    loadSets();
    return () => {
      cancelled = true;
    };
  }, [session]);

  const completedToday = sessions.find(
    (s) =>
      s.workout_id === workout.id &&
      s.session_date === dateKey &&
      s.status === "completed"
  );

  async function authed() {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new Error("Not signed in.");
    return { supabase, user };
  }

  async function startSession() {
    setBusy(true);
    setError(null);
    try {
      const { supabase, user } = await authed();
      const { data, error } = await supabase
        .from("workout_sessions")
        .insert({
          owner: user.id,
          workout_id: workout.id,
          session_date: dateKey,
          status: "in_progress",
        })
        .select("*")
        .single();
      if (error) throw error;
      setSession(data as WorkoutSession);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start session.");
    } finally {
      setBusy(false);
    }
  }

  /** Persist one set row (insert or update via the unique backstop). */
  async function persistSet(row: WorkoutSet) {
    const { supabase, user } = await authed();
    const { data, error } = await supabase
      .from("workout_sets")
      .upsert(
        {
          owner: user.id,
          session_id: row.session_id,
          exercise_id: row.exercise_id,
          // Guard column: must equal the session's workout (DB-enforced).
          workout_id: workout.id,
          set_number: row.set_number,
          reps: row.reps,
          duration_seconds: row.duration_seconds,
        },
        { onConflict: "session_id,exercise_id,set_number" }
      )
      .select("*")
      .single();
    if (error) throw error;
    return data as WorkoutSet;
  }

  function updateLocalValue(setId: string, value: number) {
    setLocalSets((prev) =>
      prev.map((s) => {
        if (s.id !== setId) return s;
        return s.exercise_id
          ? {
              ...s,
              reps:
                exercises.find((e) => e.id === s.exercise_id)?.exercise_type ===
                "time"
                  ? s.reps
                  : value,
              duration_seconds:
                exercises.find((e) => e.id === s.exercise_id)?.exercise_type ===
                "time"
                  ? value
                  : s.duration_seconds,
            }
          : s;
      })
    );
  }

  async function commitSet(setId: string) {
    const row = localSets.find((s) => s.id === setId);
    if (!row || !session) return;
    setSaving(setId);
    try {
      const saved = await persistSet(row);
      setLocalSets((prev) => prev.map((s) => (s.id === setId ? saved : s)));
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save set.");
    } finally {
      setSaving(null);
    }
  }

  async function addSet(exercise: WorkoutExercise) {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const { supabase, user } = await authed();
      const num = nextSetNumber(localSets, session.id, exercise.id);
      const { data, error } = await supabase
        .from("workout_sets")
        .insert({
          owner: user.id,
          session_id: session.id,
          exercise_id: exercise.id,
          // Guard column: must equal the session's workout (DB-enforced).
          workout_id: workout.id,
          set_number: num,
          reps: exercise.exercise_type === "reps" ? 0 : null,
          duration_seconds: exercise.exercise_type === "time" ? 0 : null,
        })
        .select("*")
        .single();
      if (error) throw error;
      setLocalSets((prev) => [...prev, data as WorkoutSet]);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add set.");
    } finally {
      setBusy(false);
    }
  }

  async function removeSet(row: WorkoutSet) {
    setBusy(true);
    try {
      const { supabase } = await authed();
      const { error } = await supabase
        .from("workout_sets")
        .delete()
        .eq("id", row.id);
      if (error) throw error;
      setLocalSets((prev) => prev.filter((s) => s.id !== row.id));
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove set.");
    } finally {
      setBusy(false);
    }
  }

  async function saveNotes() {
    if (!session) return;
    const { supabase } = await authed();
    const { error } = await supabase
      .from("workout_sessions")
      .update({ notes: notes.trim() || null })
      .eq("id", session.id);
    if (error) setError(error.message);
  }

  async function finish(status: "completed" | "cancelled") {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const { supabase } = await authed();
      // flush any pending local edits first
      for (const row of localSets) {
        await persistSet(row);
      }
      const { error } = await supabase
        .from("workout_sessions")
        .update({
          status,
          completed_at: new Date().toISOString(),
          notes: notes.trim() || null,
        })
        .eq("id", session.id);
      if (error) throw error;
      setSession(null);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not finish session.");
    } finally {
      setBusy(false);
    }
  }

  // -- not started -----------------------------------------------------------
  if (!session) {
    return (
      <Modal title={workout.name} onClose={onClose}>
        <div className="flex flex-col gap-4">
          {completedToday ? (
            <p className="text-sm t-secondary">
              ✓ Already completed today
              {completedToday.notes ? ` — ${completedToday.notes}` : ""}. You
              can log another session if you trained twice.
            </p>
          ) : (
            <p className="text-sm t-secondary">
              {workout.type === "structured"
                ? `${exList.length} exercise${exList.length === 1 ? "" : "s"}. Previous performance will be shown while you log.`
                : "Mark it done when finished — no set tracking needed."}
            </p>
          )}
          {error && (
            <p className="text-sm text-red-500 dark:text-red-400">{error}</p>
          )}
          <button className="btn-primary" disabled={busy} onClick={startSession}>
            {busy ? "Starting…" : completedToday ? "Log another session" : "Start workout"}
          </button>
        </div>
      </Modal>
    );
  }

  // -- completion workout ----------------------------------------------------
  if (workout.type === "completion") {
    return (
      <Modal title={workout.name} onClose={onClose}>
        <div className="flex flex-col gap-4">
          {workout.description && (
            <p className="text-sm t-secondary">{workout.description}</p>
          )}
          {workout.video_ref && (
            <p className="text-sm t-secondary">Video: {workout.video_ref}</p>
          )}
          <Field label="Notes (optional)">
            <textarea
              className="textarea"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={saveNotes}
              placeholder="How did it go?"
            />
          </Field>
          {error && (
            <p className="text-sm text-red-500 dark:text-red-400">{error}</p>
          )}
          <div className="flex gap-2">
            <button
              className="btn-primary flex-1"
              disabled={busy}
              onClick={() => finish("completed")}
            >
              {busy ? "Saving…" : "✓ Mark complete"}
            </button>
            <button
              className="btn-ghost"
              disabled={busy}
              onClick={() => finish("cancelled")}
            >
              Cancel
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  // -- structured workout ----------------------------------------------------
  const prev = previousSession(sessions, workout.id, dateKey, session.id);

  return (
    <Modal title={`${workout.name} — logging`} onClose={onClose}>
      <div className="flex flex-col gap-5">
        {exList.length === 0 && (
          <p className="text-sm t-secondary">
            No exercises in this workout yet. Add some on the Training page
            first.
          </p>
        )}
        {exList.map((ex) => {
          const exSets = setsForExercise(localSets, session.id, ex.id);
          const prevSets = prev
            ? setsForExercise(sets, prev.id, ex.id)
            : [];
          const prevSummary =
            prev && prevSets.length > 0
              ? summarizeExerciseSets(ex, prevSets)
              : null;
          const isTime = ex.exercise_type === "time";
          return (
            <section key={ex.id} aria-label={ex.name}>
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <h3 className="text-sm font-semibold t-primary">{ex.name}</h3>
                <span className="text-xs t-faint">
                  {isTime ? "Timed hold" : "Reps"}
                </span>
              </div>
              {prevSummary && (
                <p className="text-xs t-secondary mb-2">
                  Previous: <span className="font-medium t-primary">{prevSummary}</span>
                  {isTime ? "" : " — beat it if you can, no pressure"}
                </p>
              )}
              <div className="flex flex-col gap-2">
                {exSets.map((s) => (
                  <div key={s.id} className="flex items-center gap-2">
                    <span className="text-xs t-faint w-12 shrink-0">
                      Set {s.set_number}
                    </span>
                    <input
                      className="input !min-h-[52px] text-center text-lg font-semibold tabular-nums flex-1"
                      type="number"
                      inputMode="numeric"
                      min={0}
                      value={
                        isTime
                          ? (s.duration_seconds ?? 0)
                          : (s.reps ?? 0)
                      }
                      onChange={(e) =>
                        updateLocalValue(s.id, Number(e.target.value))
                      }
                      onBlur={() => commitSet(s.id)}
                      aria-label={`${ex.name} set ${s.set_number} ${isTime ? "seconds" : "reps"}`}
                    />
                    <span className="text-xs t-faint w-8 shrink-0">
                      {isTime ? "sec" : "reps"}
                    </span>
                    {saving === s.id ? (
                      <span className="text-xs t-faint w-14 shrink-0">Saving…</span>
                    ) : (
                      <button
                        className="btn-ghost !min-h-[44px] !px-3 text-xs shrink-0"
                        onClick={() => removeSet(s)}
                        aria-label={`Remove set ${s.set_number}`}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
                <button
                  className="btn-secondary !min-h-[44px] self-start !px-4 text-sm"
                  disabled={busy}
                  onClick={() => addSet(ex)}
                >
                  + Add set
                </button>
              </div>
            </section>
          );
        })}

        <Field label="Session notes (optional)">
          <textarea
            className="textarea"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={saveNotes}
            placeholder="How did it feel? Anything to remember?"
          />
        </Field>

        {error && (
          <p className="text-sm text-red-500 dark:text-red-400">{error}</p>
        )}
        <div className="flex gap-2">
          <button
            className="btn-primary flex-1"
            disabled={busy}
            onClick={() => finish("completed")}
          >
            {busy ? "Saving…" : "✓ Complete workout"}
          </button>
          <button
            className="btn-ghost"
            disabled={busy}
            onClick={() => finish("cancelled")}
          >
            Discard
          </button>
        </div>
        <p className="text-xs t-faint">
          Sets save as you enter them.{" "}
          {prev
            ? `Last trained ${prev.session_date}.`
            : "No previous session yet — this becomes your baseline."}
        </p>
      </div>
    </Modal>
  );
}
