"use client";

import { useCallback, useEffect, useState } from "react";
import { ErrorState, Field, LoadingBlock } from "@/components/ui";
import { getJournalEntry, upsertJournalEntry } from "@/lib/journal";
import {
  addDays,
  formatLong,
  isToday,
  todayKey,
} from "@/lib/dates";

/**
 * Journal editor: date navigation + private free-text entry.
 * Date can be controlled by a parent (date + onDateChange) or managed
 * internally. Fetches and saves its own data.
 */
export function JournalEditor({
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
  const [savedContent, setSavedContent] = useState("");
  const [content, setContent] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const entry = await getJournalEntry(dateKey);
      const text = entry?.content ?? "";
      setSavedContent(text);
      setContent(text);
      setUpdatedAt(entry?.updated_at ?? null);
      setJustSaved(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load this entry.");
    } finally {
      setLoading(false);
    }
  }, [dateKey]);

  useEffect(() => {
    load();
  }, [load]);

  const dirty = content !== savedContent;

  const save = useCallback(async () => {
    if (!content.trim()) return;
    setBusy(true);
    setSaveError(null);
    try {
      const entry = await upsertJournalEntry(dateKey, content.trim());
      setSavedContent(entry.content);
      setContent(entry.content);
      setUpdatedAt(entry.updated_at);
      setJustSaved(true);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }, [content, dateKey]);

  // Debounced autosave: ~1.5s after typing stops, reuse the existing
  // save path (same upsert, same guards). The manual Save button stays.
  useEffect(() => {
    if (loading || error || busy || !dirty) return;
    const t = setTimeout(() => {
      void save();
    }, 1500);
    return () => clearTimeout(t);
  }, [loading, error, busy, dirty, save]);

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
        <div className="flex items-center gap-2">
          <p className="text-sm t-primary font-medium">
            {formatLong(dateKey)}
            {isToday(dateKey) && <span className="t-faint"> · today</span>}
          </p>
          <input
            type="date"
            className="input !min-h-[40px] !py-1.5 text-xs w-[9.5rem]"
            value={dateKey}
            onChange={(e) => e.target.value && go(e.target.value)}
            aria-label="Pick a date"
          />
        </div>
      </div>

      {loading ? (
        <LoadingBlock label="Loading entry…" />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <>
          <Field label="Journal — private, for your eyes only">
            <textarea
              className="textarea !min-h-[220px] leading-relaxed"
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                setJustSaved(false);
              }}
              placeholder="Honest, unfiltered. This is for you."
            />
          </Field>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-xs t-faint tabular-nums">
              {justSaved
                ? "Saved just now."
                : updatedAt
                  ? `Last updated ${new Date(updatedAt).toLocaleString()}`
                  : content.trim()
                    ? "Unsaved."
                    : ""}
            </p>
            <button
              className="btn-primary !min-h-[44px]"
              disabled={busy || !dirty || !content.trim()}
              onClick={save}
            >
              {busy ? "Saving…" : "Save entry"}
            </button>
          </div>
          {saveError && (
            <ErrorState message={saveError} onRetry={save} />
          )}
        </>
      )}
    </div>
  );
}
