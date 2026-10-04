"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
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
        const [t, e, h, hl, c] = await Promise.all([
          supabase
            .from("tasks")
            .select("*")
            .gte("task_date", startKey)
            .lte("task_date", endKey)
            .order("start_time", { ascending: true, nullsFirst: false }),
          supabase
            .from("calendar_events")
            .select("*")
            .gte("event_date", startKey)
            .lte("event_date", endKey)
            .order("start_time"),
          supabase
            .from("habits")
            .select("*")
            .eq("owner", user.id)
            .eq("is_active", true)
            .order("sort_order"),
          supabase
            .from("habit_logs")
            .select("*")
            .gte("log_date", startKey)
            .lte("log_date", endKey),
          supabase
            .from("challenges")
            .select("*")
            .eq("owner", user.id)
            .eq("is_active", true)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
        ]);
        if (cancelled) return;
        const firstErr = [t, e, h, hl, c].find((r) => r.error)?.error;
        if (firstErr) throw firstErr;
        setTasks(t.data ?? []);
        setEvents(e.data ?? []);
        setHabits(h.data ?? []);
        setHabitLogs(hl.data ?? []);
        setChallenge(c.data ?? null);
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
  }, [startKey, endKey, nonce]);

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
