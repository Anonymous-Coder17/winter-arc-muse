"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { addDays, todayKey } from "@/lib/dates";
import type { StudySession, Subject, Topic } from "@/lib/types";

export interface StudyData {
  subjects: Subject[];
  topics: Topic[];
  sessions: StudySession[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Loads subjects, topics and study sessions. Sessions are bounded to
 * [startKey, endKey] (default: last 90 days → today); subjects and topics
 * always load in full.
 */
export function useStudy(startKey?: string, endKey?: string): StudyData {
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [sessions, setSessions] = useState<StudySession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const sKey = startKey ?? addDays(todayKey(), -90);
  const eKey = endKey ?? todayKey();

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
        const [sub, top, ses] = await Promise.all([
          supabase
            .from("subjects")
            .select("*")
            .eq("owner", user.id)
            .order("sort_order"),
          supabase
            .from("topics")
            .select("*")
            .eq("owner", user.id)
            .order("sort_order"),
          supabase
            .from("study_sessions")
            .select("*")
            .eq("owner", user.id)
            .gte("session_date", sKey)
            .lte("session_date", eKey)
            .order("started_at", { ascending: false }),
        ]);
        if (cancelled) return;
        const firstErr = [sub, top, ses].find((r) => r.error)?.error;
        if (firstErr) throw firstErr;
        setSubjects((sub.data ?? []) as Subject[]);
        setTopics((top.data ?? []) as Topic[]);
        setSessions((ses.data ?? []) as StudySession[]);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Failed to load study data.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sKey, eKey, nonce]);

  return useMemo(
    () => ({ subjects, topics, sessions, loading, error, refresh }),
    [subjects, topics, sessions, loading, error, refresh]
  );
}

/** Active topics for one subject, in order. */
export function topicsFor(topics: Topic[], subjectId: string): Topic[] {
  return topics
    .filter((t) => t.subject_id === subjectId)
    .sort((a, b) => a.sort_order - b.sort_order);
}
