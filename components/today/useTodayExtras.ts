"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type {
  AbstinenceIncident,
  AbstinenceRule,
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const supabase = createClient();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) {
          if (!cancelled) setError("Not signed in.");
          return;
        }
        const dayStart = new Date(dateKey + "T00:00:00").toISOString();
        const dayEnd = new Date(dateKey + "T23:59:59").toISOString();
        const [l, ll, r, inc, rec, rl] = await Promise.all([
          supabase
            .from("usage_limits")
            .select("*")
            .eq("owner", user.id)
            .eq("is_active", true)
            .order("name"),
          supabase
            .from("limit_logs")
            .select("*")
            .eq("log_date", dateKey),
          supabase
            .from("abstinence_rules")
            .select("*")
            .eq("owner", user.id)
            .eq("is_active", true)
            .order("name"),
          supabase
            .from("abstinence_incidents")
            .select("*")
            .gte("occurred_at", dayStart)
            .lte("occurred_at", dayEnd)
            .order("occurred_at", { ascending: false }),
          // V3.1: the journal lives in journal_entries now (see lib/journal).
          // Today only needs to know whether an entry exists for the date —
          // the text itself stays inside the journal UI.
          supabase
            .from("journal_entries")
            .select("entry_date")
            .eq("owner", user.id)
            .eq("entry_date", dateKey)
            .limit(1),
          supabase
            .from("reading_logs")
            .select("*")
            .eq("log_date", dateKey),
        ]);
        if (cancelled) return;
        const firstErr = [l, ll, r, inc, rec, rl].find((x) => x.error)?.error;
        if (firstErr) throw firstErr;
        setLimits(l.data ?? []);
        setLimitLogs(ll.data ?? []);
        setRules(r.data ?? []);
        setIncidents(inc.data ?? []);
        setJournalDates(
          (rec.data ?? []).map((r) => (r as { entry_date: string }).entry_date)
        );
        setReadingLogs(rl.data ?? []);
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
  }, [dateKey, nonce]);

  return useMemo(
    () => ({ limits, limitLogs, rules, incidents, journalDates, readingLogs, loading, error, refresh }),
    [limits, limitLogs, rules, incidents, journalDates, readingLogs, loading, error, refresh]
  );
}
