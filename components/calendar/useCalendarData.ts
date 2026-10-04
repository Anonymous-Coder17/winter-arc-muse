"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getDb } from "@/lib/sync/write";
import { engine } from "@/lib/sync/engine";
import {
  metaCacheAvailable,
  readSyncMeta,
} from "@/lib/calendar-providers/googleMeta";
import { useSyncTick } from "@/components/sync/status";
import type {
  CalendarEvent,
  Challenge,
  Habit,
  HabitLog,
  Task,
} from "@/lib/types";

export interface CalendarData {
  tasks: Task[];
  events: CalendarEvent[];
  habits: Habit[];
  habitLogs: HabitLog[];
  challenge: Challenge | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/** Loads everything the calendar views need for [startKey, endKey]. */
export function useCalendarData(startKey: string, endKey: string): CalendarData {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [habits, setHabits] = useState<Habit[]>([]);
  const [habitLogs, setHabitLogs] = useState<HabitLog[]>([]);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
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
        const [taskRows, eventRows, habitRows, habitLogRows, challengeRows] =
          await Promise.all([
            db.list<Task>("tasks", {
              gte: { task_date: startKey },
              lte: { task_date: endKey },
              order: [{ col: "start_time", ascending: true }],
            }),
            db.list<CalendarEvent>("calendar_events", {
              gte: { event_date: startKey },
              lte: { event_date: endKey },
              order: [{ col: "start_time", ascending: true }],
            }),
            db.list<Habit>("habits", {
              eq: { is_active: true },
              order: [{ col: "sort_order", ascending: true }],
            }),
            db.list<HabitLog>("habit_logs", {
              gte: { log_date: startKey },
              lte: { log_date: endKey },
            }),
            db.list<Challenge>("challenges", {
              eq: { is_active: true },
              order: [{ col: "created_at", ascending: false }],
              limit: 1,
            }),
          ]);
        if (cancelled) return;
        // V4.3.2: tag events that have a Google sync mapping (local meta
        // cache — offline-safe). Tagging is non-destructive: untagged rows
        // keep their exact identity; tagged rows are shallow copies.
        let syncedIds: Set<string> | null = null;
        try {
          const userId = engine.getSnapshot().userId;
          if (userId && metaCacheAvailable()) {
            const syncMeta = await readSyncMeta(userId);
            if (!cancelled && syncMeta && syncMeta.googleSyncedEventIds.length > 0) {
              syncedIds = new Set(syncMeta.googleSyncedEventIds);
            }
          }
        } catch {
          // Cache unavailable or corrupt: skip tagging gracefully.
          syncedIds = null;
        }
        if (cancelled) return;
        setTasks(taskRows);
        setEvents(
          syncedIds
            ? eventRows.map((e) =>
                syncedIds!.has(e.id) ? { ...e, isGoogleSynced: true } : e
              )
            : eventRows
        );
        setHabits(habitRows);
        setHabitLogs(habitLogRows);
        setChallenge(challengeRows[0] ?? null);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Failed to load data.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [startKey, endKey, tick, nonce]);

  return useMemo(
    () => ({
      tasks,
      events,
      habits,
      habitLogs,
      challenge,
      loading,
      error,
      refresh,
    }),
    [tasks, events, habits, habitLogs, challenge, loading, error, refresh]
  );
}

export function logFor(
  habitLogs: HabitLog[],
  habitId: string,
  dateKey: string
): HabitLog | undefined {
  return habitLogs.find((l) => l.habit_id === habitId && l.log_date === dateKey);
}
