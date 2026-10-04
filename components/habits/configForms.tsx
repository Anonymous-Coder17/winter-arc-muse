"use client";

import { useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { Field } from "@/components/ui";
import type { AbstinenceRule, UsageLimit } from "@/lib/types";

// ---------------------------------------------------------------------------
// Category A — abstain completely
// ---------------------------------------------------------------------------

export function AbstinenceRuleForm({
  initial,
  onSaved,
  onDeleted,
}: {
  initial?: AbstinenceRule;
  onSaved: () => void;
  onDeleted?: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [startDate, setStartDate] = useState(
    initial?.start_date ?? new Date().toISOString().slice(0, 10)
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
        notes: notes.trim() || null,
        start_date: startDate,
        is_active: isActive,
      };
      const { error } = initial
        ? await supabase
            .from("abstinence_rules")
            .update(row)
            .eq("id", initial.id)
        : await supabase.from("abstinence_rules").insert(row);
      if (error) throw error;
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save rule.");
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
        .from("abstinence_rules")
        .delete()
        .eq("id", initial.id);
      if (error) throw error;
      onDeleted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete rule.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Field label="Behavior to abstain from">
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Instagram"
          required
          autoFocus
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Start date">
          <input
            className="input"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
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
      <Field label="Notes (optional)">
        <textarea
          className="textarea"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Why this matters to you…"
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
        <button className="btn-primary" disabled={busy || !name.trim()}>
          {busy ? "Saving…" : initial ? "Save changes" : "Add rule"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Category B — allowed but limited
// ---------------------------------------------------------------------------

export function UsageLimitForm({
  initial,
  onSaved,
  onDeleted,
}: {
  initial?: UsageLimit;
  onSaved: () => void;
  onDeleted?: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [dailyLimit, setDailyLimit] = useState(
    initial ? String(initial.daily_limit_min) : ""
  );
  const [isActive, setIsActive] = useState(initial?.is_active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !Number(dailyLimit)) return;
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
        daily_limit_min: Number(dailyLimit),
        is_active: isActive,
      };
      const { error } = initial
        ? await supabase.from("usage_limits").update(row).eq("id", initial.id)
        : await supabase.from("usage_limits").insert(row);
      if (error) throw error;
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save limit.");
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
        .from("usage_limits")
        .delete()
        .eq("id", initial.id);
      if (error) throw error;
      onDeleted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete limit.");
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
          placeholder="e.g. YouTube"
          required
          autoFocus
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Daily limit (minutes)">
          <input
            className="input"
            type="number"
            min={1}
            value={dailyLimit}
            onChange={(e) => setDailyLimit(e.target.value)}
            placeholder="e.g. 45"
            required
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
        <button
          className="btn-primary"
          disabled={busy || !name.trim() || !Number(dailyLimit)}
        >
          {busy ? "Saving…" : initial ? "Save changes" : "Add limit"}
        </button>
      </div>
    </form>
  );
}
