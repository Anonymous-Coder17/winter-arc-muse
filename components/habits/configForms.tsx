"use client";

import { useState, type FormEvent } from "react";
import { getDb } from "@/lib/sync/write";
import { Field } from "@/components/ui";
import { todayKey } from "@/lib/dates";
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
    initial?.start_date ?? todayKey()
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
        notes: notes.trim() || null,
        start_date: startDate,
        is_active: isActive,
      };
      if (initial) await db.update("abstinence_rules", initial.id, row);
      else await db.insert("abstinence_rules", row);
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
      const db = getDb();
      await db.remove("abstinence_rules", initial.id);
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
      const db = getDb();
      const row = {
        name: name.trim(),
        daily_limit_min: Number(dailyLimit),
        is_active: isActive,
      };
      if (initial) await db.update("usage_limits", initial.id, row);
      else await db.insert("usage_limits", row);
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
      const db = getDb();
      await db.remove("usage_limits", initial.id);
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
