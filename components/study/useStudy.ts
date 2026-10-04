"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getDb } from "@/lib/sync/write";
import { engine } from "@/lib/sync/engine";
import { useSyncTick } from "@/components/sync/status";
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
  const tick = useSyncTick();

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const sKey = startKey ?? addDays(todayKey(), -90);
  const eKey = endKey ?? todayKey();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setError(null);
      try {
        await engine.whenReady();
        const db = getDb();
        const [subjectRows, topicRows, sessionRows] = await Promise.all([
          db.list<Subject>("subjects", {
            order: [{ col: "sort_order", ascending: true }],
          }),
          db.list<Topic>("topics", {
            order: [{ col: "sort_order", ascending: true }],
          }),
          db.list<StudySession>("study_sessions", {
            gte: { session_date: sKey },
            lte: { session_date: eKey },
            order: [{ col: "started_at", ascending: false }],
          }),
        ]);
        if (cancelled) return;
        setSubjects(subjectRows);
        setTopics(topicRows);
        setSessions(sessionRows);
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
  }, [sKey, eKey, tick, nonce]);

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
