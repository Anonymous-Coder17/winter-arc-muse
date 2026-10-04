// Shared domain types mirroring the Supabase V1 + V2 schema.
// Keep in sync with supabase/migrations/0001_v1_schema.sql and
// supabase/migrations/0002_v2_training_study.sql.

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
  /**
   * Client-side tag (V4.3.2): set by useCalendarData when the event has a
   * Google sync mapping in the local metadata cache. Not a DB column — never
   * written back to calendar_events.
   */
  isGoogleSynced?: boolean;
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
// V2 — Training: Workout → Exercise → Session → Sets
// ---------------------------------------------------------------------------

export type WorkoutType = "structured" | "completion";

export interface Workout {
  id: string;
  owner: string;
  name: string;
  type: WorkoutType;
  description: string | null;
  video_ref: string | null;
  is_active: boolean;
  sort_order: number;
}

export type ExerciseType = "reps" | "time";

export interface WorkoutExercise {
  id: string;
  owner: string;
  workout_id: string;
  name: string;
  exercise_type: ExerciseType;
  sort_order: number;
  notes: string | null;
  /** false = archived/removed from the workout; history keeps showing it */
  is_active: boolean;
}

export type WorkoutSessionStatus = "in_progress" | "completed" | "cancelled";

export interface WorkoutSession {
  id: string;
  owner: string;
  workout_id: string;
  session_date: string; // YYYY-MM-DD
  started_at: string;
  completed_at: string | null;
  status: WorkoutSessionStatus;
  notes: string | null;
}

export interface WorkoutSet {
  id: string;
  owner: string;
  session_id: string;
  exercise_id: string;
  /** Denormalized guard: must equal the session's workout_id (DB-enforced). */
  workout_id: string;
  set_number: number;
  reps: number | null;
  duration_seconds: number | null;
  notes: string | null;
}

/** weekday: 0 = Monday … 6 = Sunday. workout_id null = REST day. */
export interface TrainingScheduleRow {
  id: string;
  owner: string;
  weekday: number;
  workout_id: string | null;
}

// ---------------------------------------------------------------------------
// V2 — Study: Subject → Topic → Session
// ---------------------------------------------------------------------------

export interface Subject {
  id: string;
  owner: string;
  name: string;
  description: string | null;
  is_active: boolean;
  sort_order: number;
}

export interface Topic {
  id: string;
  owner: string;
  subject_id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  sort_order: number;
}

export interface StudySession {
  id: string;
  owner: string;
  subject_id: string;
  topic_id: string | null;
  session_date: string; // YYYY-MM-DD
  started_at: string;
  completed_at: string | null;
  duration_seconds: number;
  notes: string | null;
}

// ---------------------------------------------------------------------------
// V3 — Journal & Review: date-based reflection, all private per user
// ---------------------------------------------------------------------------

export interface JournalEntry {
  id: string;
  owner: string;
  entry_date: string; // YYYY-MM-DD (local)
  content: string;
  created_at: string;
  updated_at: string;
}

export interface DailyReview {
  id: string;
  owner: string;
  review_date: string; // YYYY-MM-DD (local)
  wins: string | null;
  problems: string | null;
  distractions: string | null;
  adjustment: string | null;
  created_at: string;
  updated_at: string;
}

export interface WeeklyReview {
  id: string;
  owner: string;
  week_start: string; // YYYY-MM-DD (local, Monday)
  week_end: string; // YYYY-MM-DD (local, Sunday)
  what_worked: string | null;
  what_didnt: string | null;
  next_adjustment: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Optional baseline capture + final 30-day review for one challenge.
 * All fields optional — never fabricate missing data.
 */
export interface ChallengeReview {
  id: string;
  owner: string;
  challenge_id: string;
  baseline_study_min: number | null;
  baseline_reading_pages: number | null;
  baseline_hifz_ayahs: number | null;
  baseline_notes: string | null;
  review_what_worked: string | null;
  review_what_didnt: string | null;
  review_adjustment: string | null;
  created_at: string;
  updated_at: string;
}

export interface Book {
  id: string;
  owner: string;
  name: string;
  author: string | null;
  total_pages: number | null;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/**
 * V3 reading source of truth. Migration 0005 backfills existing "Reading"
 * habit_logs into this table (book_id null). New reading is recorded here.
 */
export interface ReadingLog {
  id: string;
  owner: string;
  book_id: string | null;
  log_date: string; // YYYY-MM-DD (local)
  pages: number;
  note: string | null;
  created_at: string;
  updated_at: string;
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
