"use client";

import { useCallback, useEffect, useState } from "react";
import { ErrorState, Field, LoadingBlock } from "@/components/ui";
import {
  getDailyReview,
  upsertDailyReview,
  type DailyReviewFields,
} from "@/lib/journal";
import {
  addDays,
  formatLong,
  isToday,
  todayKey,
} from "@/lib/dates";

const PROMPTS: {
  key: keyof DailyReviewFields;
  label: string;
  placeholder: string;
}[] = [
  {
    key: "wins",
    label: "What went well?",
    placeholder: "Small or large — anything you did right.",
  },
  {
    key: "problems",
    label: "What went wrong?",
    placeholder: "Be specific. This is data, not a verdict.",
  },
  {
    key: "distractions",
    label: "What distracted me?",
    placeholder: "Name the leak honestly.",
  },
  {
    key: "adjustment",
    label: "What should change tomorrow?",
    placeholder: "One concrete adjustment.",
  },
];

/**
 * Daily review form. All four fields optional — empty fields are left
 * untouched (partial save), so you can fill in just what's on your mind.
 * Date can be controlled by a parent or managed internally.
 */
export function DailyReviewForm({
  date,
  onDateChange,
}: {
  date?: string;
  onDateChange?: (dateKey: string) => void;
}) {
  const [internalDate, setInternalDate] = useState(() => date ?? todayKey());
  useEffect(() => {
    if (date !== undefined) setInternalDate(date);
  }, [date]);
  const dateKey = date ?? internalDate;

  function go(d: string) {
    setInternalDate(d);
    onDateChange?.(d);
  }

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({
    wins: "",
    problems: "",
    distractions: "",
    adjustment: "",
  });
  const [savedFields, setSavedFields] = useState<Record<string, string>>({
    wins: "",
    problems: "",
    distractions: "",
    adjustment: "",
  });
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const review = await getDailyReview(dateKey);
      const f = {
        wins: review?.wins ?? "",
        problems: review?.problems ?? "",
        distractions: review?.distractions ?? "",
        adjustment: review?.adjustment ?? "",
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
  }, [dateKey]);

  useEffect(() => {
    load();
  }, [load]);

  const dirty = PROMPTS.some((p) => fields[p.key] !== savedFields[p.key]);

  async function save() {
    setBusy(true);
    setSaveError(null);
    try {
      // Empty fields are undefined → left untouched (partial save).
      const patch: DailyReviewFields = {};
      for (const p of PROMPTS) {
        const v = fields[p.key].trim();
        patch[p.key] = v ? v : undefined;
      }
      const review = await upsertDailyReview(dateKey, patch);
      const f = {
        wins: review.wins ?? "",
        problems: review.problems ?? "",
        distractions: review.distractions ?? "",
        adjustment: review.adjustment ?? "",
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
            onClick={() => go(addDays(dateKey, -1))}
            aria-label="Previous day"
          >
            ←
          </button>
          {!isToday(dateKey) && (
            <button className="btn-ghost !min-h-[40px] !px-3" onClick={() => go(todayKey())}>
              Today
            </button>
          )}
          <button
            className="btn-ghost !min-h-[40px] !px-3"
            onClick={() => go(addDays(dateKey, 1))}
            aria-label="Next day"
          >
            →
          </button>
        </div>
        <p className="text-sm t-primary font-medium">
          {formatLong(dateKey)}
          {isToday(dateKey) && <span className="t-faint"> · today</span>}
        </p>
      </div>

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
