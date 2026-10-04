"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getDb } from "@/lib/sync/write";
import { engine } from "@/lib/sync/engine";
import { useSyncTick } from "@/components/sync/status";
import { addDays } from "@/lib/dates";
import type {
  AbstinenceIncident,
  AbstinenceRule,
  Book,
  JournalEntry,
  LimitLog,
  ReadingLog,
  UsageLimit,
} from "@/lib/types";

export interface TodayExtras {
  limits: UsageLimit[];
  limitLogs: LimitLog[];
  rules: AbstinenceRule[];
  incidents: AbstinenceIncident[];
  /** entry_date values only — journal TEXT is never loaded here (privacy). */
  journalDates: string[];
  readingLogs: ReadingLog[];
  books: Book[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useTodayExtras(dateKey: string): TodayExtras {
  const [limits, setLimits] = useState<UsageLimit[]>([]);
  const [limitLogs, setLimitLogs] = useState<LimitLog[]>([]);
  const [rules, setRules] = useState<AbstinenceRule[]>([]);
  const [incidents, setIncidents] = useState<AbstinenceIncident[]>([]);
  const [journalDates, setJournalDates] = useState<string[]>([]);
  const [readingLogs, setReadingLogs] = useState<ReadingLog[]>([]);
  const [books, setBooks] = useState<Book[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const tick = useSyncTick();

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setError(null);
      try {
        await engine.whenReady();
        const db = getDb();
        const dayStart = new Date(dateKey + "T00:00:00").toISOString();
        // Incident window is [dayStart, nextDayStart): the old
        // lte(...T23:59:59) silently dropped the last second of the day.
        const nextDayStart = new Date(
          addDays(dateKey, 1) + "T00:00:00"
        ).toISOString();
        const [limitRows, limitLogRows, ruleRows, incidentRows, journalRows, readingLogRows, bookRows] =
          await Promise.all([
            db.list<UsageLimit>("usage_limits", {
              eq: { is_active: true },
              order: [{ col: "name", ascending: true }],
            }),
            db.list<LimitLog>("limit_logs", { eq: { log_date: dateKey } }),
            db.list<AbstinenceRule>("abstinence_rules", {
              eq: { is_active: true },
              order: [{ col: "name", ascending: true }],
            }),
            db.list<AbstinenceIncident>("abstinence_incidents", {
              gte: { occurred_at: dayStart },
              lt: { occurred_at: nextDayStart },
              order: [{ col: "occurred_at", ascending: false }],
            }),
            // V3.1: the journal lives in journal_entries now (see lib/journal).
            // Today only needs to know whether an entry exists for the date —
            // only entry_date values are surfaced into state; the text itself
            // stays inside the journal UI.
            db.list<JournalEntry>("journal_entries", {
              eq: { entry_date: dateKey },
              limit: 1,
            }),
            db.list<ReadingLog>("reading_logs", { eq: { log_date: dateKey } }),
            // Active books for the reading quick-log (same ordering as getBooks).
            db.list<Book>("books", {
              eq: { is_active: true },
              order: [
                { col: "sort_order", ascending: true },
                { col: "name", ascending: true },
              ],
            }),
          ]);
        if (cancelled) return;
        setLimits(limitRows);
        setLimitLogs(limitLogRows);
        setRules(ruleRows);
        setIncidents(incidentRows);
        setJournalDates(journalRows.map((r) => r.entry_date));
        setReadingLogs(readingLogRows);
        setBooks(bookRows);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Failed to load.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateKey, tick, nonce]);

  return useMemo(
    () => ({ limits, limitLogs, rules, incidents, journalDates, readingLogs, books, loading, error, refresh }),
    [limits, limitLogs, rules, incidents, journalDates, readingLogs, books, loading, error, refresh]
  );
}
