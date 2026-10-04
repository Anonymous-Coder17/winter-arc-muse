// Shared domain types mirroring the Supabase V1 schema.
// Keep in sync with supabase/migrations/0001_v1_schema.sql.

export type Appearance = "dark" | "light" | "system";

export interface Profile {
  id: string;
  display_name: string | null;
}

export interface Challenge {
  id: string;
  owner: string;
  title: string;
  subtitle: string | null;
  start_date: string; // YYYY-MM-DD
  duration_days: number;
  is_active: boolean;
}

// Habit tracking models. V1 implements 'completion'; 'count' and 'duration'
// are the extension points for V2+ (Hifz ayahs, pages, study minutes).
export type HabitTracking = "completion" | "count" | "duration";

export interface Habit {
  id: string;
  owner: string;
  name: string;
  description: string | null;
  tracking: HabitTracking;
  frequency: "daily" | "weekly";
  weekly_target: number | null;
  preferred_time: string | null;
  sort_order: number;
  is_active: boolean;
}

export type HabitLogStatus = "done" | "not_done";

export interface HabitLog {
  id: string;
  owner: string;
  habit_id: string;
  log_date: string; // YYYY-MM-DD
  status: HabitLogStatus;
  value: number | null;
  note: string | null;
}

export interface AbstinenceRule {
  id: string;
  owner: string;
  name: string;
  notes: string | null;
  start_date: string;
  is_active: boolean;
}

export interface AbstinenceIncident {
  id: string;
  owner: string;
  rule_id: string;
  occurred_at: string;
  trigger: string | null;
  note: string | null;
}

export interface UsageLimit {
  id: string;
  owner: string;
  name: string;
  daily_limit_min: number;
  is_active: boolean;
}

export interface LimitLog {
  id: string;
  owner: string;
  limit_id: string;
  log_date: string;
  minutes_used: number;
}

// 'planned' = scheduled/intended. 'done'/'not_done' = recorded reality.
// Never pretend a planned item happened.
export type TaskState = "planned" | "done" | "not_done";

export type TaskKind =
  | "general"
  | "workout"
  | "study"
  | "hifz"
  | "reading"
  | "journal";

export interface Task {
  id: string;
  owner: string;
  title: string;
  task_date: string; // YYYY-MM-DD
  start_time: string | null;
  end_time: string | null;
  kind: TaskKind;
  state: TaskState;
  notes: string | null;
}

export interface CalendarEvent {
  id: string;
  owner: string;
  title: string;
  event_date: string; // YYYY-MM-DD
  start_time: string;
  end_time: string;
  notes: string | null;
}

export type DailyRecordKind =
  | "note"
  | "journal"
  | "study_session"
  | "workout_session"
  | "review";

export interface DailyRecord {
  id: string;
  owner: string;
  record_date: string; // YYYY-MM-DD
  kind: DailyRecordKind;
  title: string | null;
  body: string | null;
  minutes: number | null;
}

// ---------------------------------------------------------------------------
// Challenge helpers
// ---------------------------------------------------------------------------

export function challengeDayNumber(challenge: Challenge, onDate: Date): number {
  const start = startOfLocalDay(new Date(challenge.start_date + "T00:00:00"));
  const day = startOfLocalDay(onDate);
  const diff = Math.floor((day.getTime() - start.getTime()) / 86_400_000);
  return diff + 1; // Day 1 = start date
}

export function daysRemaining(challenge: Challenge, onDate: Date): number {
  return Math.max(0, challenge.duration_days - challengeDayNumber(challenge, onDate) + 1);
}

function startOfLocalDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}
