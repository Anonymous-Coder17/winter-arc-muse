"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { EmptyState, ErrorState, Field, LoadingBlock } from "@/components/ui";
import {
  getChallengeReview,
  upsertChallengeReview,
  type ChallengeReviewFields,
} from "@/lib/journal";
import type { Challenge } from "@/lib/types";

const BASELINE_NUM: {
  key: "baseline_study_min" | "baseline_reading_pages" | "baseline_hifz_ayahs";
  label: string;
  placeholder: string;
}[] = [
  {
    key: "baseline_study_min",
    label: "Study (minutes/day)",
    placeholder: "e.g. 20",
  },
  {
    key: "baseline_reading_pages",
    label: "Reading (pages/day)",
    placeholder: "e.g. 10",
  },
  {
    key: "baseline_hifz_ayahs",
    label: "Hifz (ayahs/day)",
    placeholder: "e.g. 3",
  },
];

const REFLECT: {
  key: "review_what_worked" | "review_what_didnt" | "review_adjustment";
  label: string;
  placeholder: string;
}[] = [
  {
    key: "review_what_worked",
    label: "What worked over the 30 days?",
    placeholder: "Keep these into the next stretch.",
  },
  {
    key: "review_what_didnt",
    label: "What didn't work?",
    placeholder: "Be specific. Data, not a verdict.",
  },
  {
    key: "review_adjustment",
    label: "What will you do differently next?",
    placeholder: "One concrete change.",
  },
];

/**
 * Day-1 baseline capture + end-of-challenge review for one challenge.
 * All fields optional — never fabricate missing data. No scores, no grades.
 * `comparison` is a slot for the caller to inject first-7 vs final-7 data.
 */
export function ThirtyDayReview({
  challenge,
  comparison,
}: {
  challenge: Challenge | null;
  comparison?: ReactNode;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<Record<string, string>>({
    baseline_study_min: "",
    baseline_reading_pages: "",
    baseline_hifz_ayahs: "",
    baseline_notes: "",
  });
  const [reflect, setReflect] = useState<Record<string, string>>({
    review_what_worked: "",
    review_what_didnt: "",
    review_adjustment: "",
  });
  const [savedAll, setSavedAll] = useState<Record<string, string>>({});
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(false);

  const load = useCallback(async () => {
    if (!challenge) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await getChallengeReview(challenge.id);
      const b = {
        baseline_study_min: r?.baseline_study_min?.toString() ?? "",
        baseline_reading_pages: r?.baseline_reading_pages?.toString() ?? "",
        baseline_hifz_ayahs: r?.baseline_hifz_ayahs?.toString() ?? "",
        baseline_notes: r?.baseline_notes ?? "",
      };
      const f = {
        review_what_worked: r?.review_what_worked ?? "",
        review_what_didnt: r?.review_what_didnt ?? "",
        review_adjustment: r?.review_adjustment ?? "",
      };
      setBaseline(b);
      setReflect(f);
      setSavedAll({ ...b, ...f });
      setUpdatedAt(r?.updated_at ?? null);
      setSavedTick(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the review.");
    } finally {
      setLoading(false);
    }
  }, [challenge]);

  useEffect(() => {
    load();
  }, [load]);

  if (!challenge) {
    return (
      <EmptyState
        title="No active challenge"
        body="Start a challenge first — the 30-day review becomes available once you have one."
      />
    );
  }

  const all = { ...baseline, ...reflect };
  const dirty = Object.keys(all).some((k) => all[k] !== (savedAll[k] ?? ""));

  async function save() {
    const c = challenge;
    if (!c) return;
    setBusy(true);
    setSaveError(null);
    try {
      // Only provided fields are written (partial save); empty numerics stay untouched.
      const patch: ChallengeReviewFields = {};
      for (const b of BASELINE_NUM) {
        const v = baseline[b.key].trim();
        patch[b.key] = v ? Number(v) : undefined;
      }
      const notes = baseline.baseline_notes.trim();
      patch.baseline_notes = notes ? notes : undefined;
      for (const r of REFLECT) {
        const v = reflect[r.key].trim();
        patch[r.key] = v ? v : undefined;
      }
      const updated = await upsertChallengeReview(c.id, patch);
      const b = {
        baseline_study_min: updated.baseline_study_min?.toString() ?? "",
        baseline_reading_pages: updated.baseline_reading_pages?.toString() ?? "",
        baseline_hifz_ayahs: updated.baseline_hifz_ayahs?.toString() ?? "",
        baseline_notes: updated.baseline_notes ?? "",
      };
      const f = {
        review_what_worked: updated.review_what_worked ?? "",
        review_what_didnt: updated.review_what_didnt ?? "",
        review_adjustment: updated.review_adjustment ?? "",
      };
      setBaseline(b);
      setReflect(f);
      setSavedAll({ ...b, ...f });
      setUpdatedAt(updated.updated_at);
      setSavedTick(true);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {loading ? (
        <LoadingBlock label="Loading review…" />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <>
          <div className="surface card-pad flex flex-col gap-3">
            <div>
              <h4 className="text-sm font-semibold t-primary">
                Where you started
              </h4>
              <p className="text-xs t-secondary mt-0.5">
                Fill this in on Day 1 (or as close as you can). Leave blank
                anything you didn&apos;t measure — this is a reference point,
                not a score.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {BASELINE_NUM.map((b) => (
                <Field key={b.key} label={b.label}>
                  <input
                    type="number"
                    min={0}
                    className="input tabular-nums"
                    value={baseline[b.key]}
                    onChange={(e) => {
                      setBaseline((s) => ({ ...s, [b.key]: e.target.value }));
                      setSavedTick(false);
                    }}
                    placeholder={b.placeholder}
                  />
                </Field>
              ))}
            </div>
            <Field label="Baseline notes (optional)">
              <textarea
                className="textarea !min-h-[64px]"
                value={baseline.baseline_notes}
                onChange={(e) => {
                  setBaseline((s) => ({ ...s, baseline_notes: e.target.value }));
                  setSavedTick(false);
                }}
                placeholder="Where were you when you began? Anything worth remembering…"
              />
            </Field>
          </div>

          {comparison && (
            <div className="surface card-pad flex flex-col gap-2">
              <h4 className="text-sm font-semibold t-primary">
                First 7 days vs final 7 days
              </h4>
              {comparison}
            </div>
          )}

          <div className="surface card-pad flex flex-col gap-3">
            <div>
              <h4 className="text-sm font-semibold t-primary">
                End of the 30 days
              </h4>
              <p className="text-xs t-secondary mt-0.5">
                Write this when the challenge ends. No grades — just what
                happened and what changes next.
              </p>
            </div>
            {REFLECT.map((r) => (
              <Field key={r.key} label={r.label}>
                <textarea
                  className="textarea !min-h-[72px]"
                  value={reflect[r.key]}
                  onChange={(e) => {
                    setReflect((s) => ({ ...s, [r.key]: e.target.value }));
                    setSavedTick(false);
                  }}
                  placeholder={r.placeholder}
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
          </div>
        </>
      )}
    </div>
  );
}
