"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ErrorState, Field, LoadingBlock } from "@/components/ui";
import {
  getWeeklyReview,
  upsertWeeklyReview,
  type WeeklyReviewFields,
} from "@/lib/journal";
import {
  addDays,
  formatLong,
  formatShort,
  todayKey,
  weekStartMonday,
} from "@/lib/dates";

const PROMPTS: {
  key: keyof WeeklyReviewFields;
  label: string;
  placeholder: string;
}[] = [
  {
    key: "what_worked",
    label: "What worked this week?",
    placeholder: "Keep doing more of this.",
  },
  {
    key: "what_didnt",
    label: "What didn't work?",
    placeholder: "Be specific. Data, not a verdict.",
  },
  {
    key: "next_adjustment",
    label: "Adjustment for next week",
    placeholder: "One concrete change to carry forward.",
  },
];

/**
 * Weekly review form. `summary` is a slot the caller fills with real data
 * (e.g. habit consistency, study time) — never journal content.
 * Week can be controlled by a parent or managed internally.
 */
export function WeeklyReviewForm({
  summary,
  weekStart,
  onWeekChange,
}: {
  summary?: ReactNode;
  weekStart?: string;
  onWeekChange?: (weekStartKey: string) => void;
}) {
  const [internalWeek, setInternalWeek] = useState(
    () => weekStart ?? weekStartMonday(todayKey())
  );
  useEffect(() => {
    if (weekStart !== undefined) setInternalWeek(weekStart);
  }, [weekStart]);
  const weekStartKey = weekStart ?? internalWeek;
  const weekEndKey = addDays(weekStartKey, 6);

  function go(w: string) {
    setInternalWeek(w);
    onWeekChange?.(w);
  }

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({
    what_worked: "",
    what_didnt: "",
    next_adjustment: "",
  });
  const [savedFields, setSavedFields] = useState<Record<string, string>>({
    what_worked: "",
    what_didnt: "",
    next_adjustment: "",
  });
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const review = await getWeeklyReview(weekStartKey);
      const f = {
        what_worked: review?.what_worked ?? "",
        what_didnt: review?.what_didnt ?? "",
        next_adjustment: review?.next_adjustment ?? "",
      };
      setFields(f);
      setSavedFields(f);
      setUpdatedAt(review?.updated_at ?? null);
      setSavedTick(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the review.");
    } finally {
      setLoading(false);
    }
  }, [weekStartKey]);

  useEffect(() => {
    load();
  }, [load]);

  const dirty = PROMPTS.some((p) => fields[p.key] !== savedFields[p.key]);

  async function save() {
    setBusy(true);
    setSaveError(null);
    try {
      const patch: WeeklyReviewFields = {};
      for (const p of PROMPTS) {
        const v = fields[p.key].trim();
        patch[p.key] = v ? v : undefined;
      }
      const review = await upsertWeeklyReview(weekStartKey, weekEndKey, patch);
      const f = {
        what_worked: review.what_worked ?? "",
        what_didnt: review.what_didnt ?? "",
        next_adjustment: review.next_adjustment ?? "",
      };
      setSavedFields(f);
      setUpdatedAt(review.updated_at);
      setSavedTick(true);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="surface card-pad flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5">
          <button
            className="btn-ghost !min-h-[40px] !px-3"
            onClick={() => go(addDays(weekStartKey, -7))}
            aria-label="Previous week"
          >
            ←
          </button>
          <button
            className="btn-ghost !min-h-[40px] !px-3"
            onClick={() => go(weekStartMonday(todayKey()))}
          >
            This week
          </button>
          <button
            className="btn-ghost !min-h-[40px] !px-3"
            onClick={() => go(addDays(weekStartKey, 7))}
            aria-label="Next week"
          >
            →
          </button>
        </div>
        <p className="text-sm t-primary font-medium tabular-nums">
          {formatShort(weekStartKey)} – {formatLong(weekEndKey)}
        </p>
      </div>

      {summary && <div className="surface-elevated rounded-2xl p-3">{summary}</div>}

      {loading ? (
        <LoadingBlock label="Loading review…" />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <>
          {PROMPTS.map((p) => (
            <Field key={p.key} label={p.label}>
              <textarea
                className="textarea !min-h-[72px]"
                value={fields[p.key]}
                onChange={(e) => {
                  setFields((f) => ({ ...f, [p.key]: e.target.value }));
                  setSavedTick(false);
                }}
                placeholder={p.placeholder}
              />
            </Field>
          ))}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-xs t-faint tabular-nums">
              {savedTick
                ? "Saved just now."
                : updatedAt
                  ? `Last updated ${new Date(updatedAt).toLocaleString()}`
                  : ""}
            </p>
            <button
              className="btn-primary !min-h-[44px]"
              disabled={busy || !dirty}
              onClick={save}
            >
              {busy ? "Saving…" : "Save review"}
            </button>
          </div>
          {saveError && <ErrorState message={saveError} onRetry={save} />}
        </>
      )}
    </div>
  );
}
