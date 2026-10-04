// Shared types for the Progress (analytics/review) surface.
// Raw data comes from the page; analytics shapes are normalized in
// ./normalize.ts so the cross-package lib/analytics contract is adapted in
// exactly one place.

import type {
  AbstinenceIncident,
  AbstinenceRule,
  Book,
  Challenge,
  Habit,
  HabitLog,
  LimitLog,
  ReadingLog,
  StudySession,
  Subject,
  Task,
  Topic,
  TrainingScheduleRow,
  UsageLimit,
  Workout,
  WorkoutExercise,
  WorkoutSession,
  WorkoutSet,
} from "@/lib/types";

export interface Range {
  start: string; // YYYY-MM-DD (local)
  end: string; // YYYY-MM-DD (local), inclusive
}

export type ProgressTab =
  | "overview"
  | "habits"
  | "distractions"
  | "training"
  | "study"
  | "hifz"
  | "reading"
  | "reflection";

/** Everything the Progress page fetches once, then slices per tab. */
export interface ProgressData {
  challenge: Challenge | null;
  habits: Habit[];
  habitLogs: HabitLog[];
  rules: AbstinenceRule[];
  incidents: AbstinenceIncident[];
  limits: UsageLimit[];
  limitLogs: LimitLog[];
  workouts: Workout[];
  exercises: WorkoutExercise[];
  sessions: WorkoutSession[];
  sets: WorkoutSet[];
  schedule: TrainingScheduleRow[];
  subjects: Subject[];
  topics: Topic[];
  studySessions: StudySession[];
  tasks: Task[];
  books: Book[];
  readingLogs: ReadingLog[];
  /** entry_date values only — journal TEXT is never loaded for analytics. */
  journalDates: string[];
}

/** Per-day counts backing the heatmap detail strip. */
export interface DayCounts {
  date: string;
  habitsDone: number;
  studySeconds: number;
  workouts: number;
  hifz: number | null;
  pages: number;
  journaled: boolean;
  incidents: number;
  limitsOver: number;
}

/** One presence-based heatmap cell. */
export interface HeatDay {
  date: string;
  level: 0 | 1 | 2 | 3;
  signals: string[];
}
