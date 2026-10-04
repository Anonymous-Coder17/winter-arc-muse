// Adapter layer between the Progress UI and lib/analytics (built by a
// parallel work package). This is the ONLY file that imports lib/analytics,
// so any contract drift is contained here. Every adapter normalizes the
// analytics return into a locally-defined, fully-typed shape and never
// guesses missing numbers (they fall back to 0 and are displayed as such).

import {
  abstinenceStats,
  daysInRange,
  exerciseProgression,
  firstFinalAvg,
  habitConsistency,
  heatmapDays,
  hifzSeries,
  hifzTotals,
  limitCompliance,
  plannedVsActual,
  readingByBook,
  readingSeries,
  studyBySubject,
  studyByTopic,
  studyTotals,
  studyTrend,
  trainingStats,
} from "@/lib/analytics";
import { addDays, todayKey, utcToDayKey, weekStartMonday } from "@/lib/dates";
import type {
  AbstinenceIncident,
  AbstinenceRule,
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
  WorkoutExercise,
  WorkoutSession,
  WorkoutSet,
} from "@/lib/types";
import type { Challenge } from "@/lib/types";
import type { DayCounts, HeatDay, ProgressData, Range } from "./types";

// ---------------------------------------------------------------------------
// defensive extraction
// ---------------------------------------------------------------------------

export function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asRecords(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (x): x is Record<string, unknown> => typeof x === "object" && x !== null
  );
}

function asObject(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null
    ? (v as Record<string, unknown>)
    : {};
}

// ---------------------------------------------------------------------------
// date ranges
// ---------------------------------------------------------------------------

export type RangePreset = "7d" | "30d" | "week" | "month" | "challenge" | "custom";

export function computeRange(
  preset: RangePreset,
  challenge: Challenge | null,
  customStart: string,
  customEnd: string
): Range {
  const today = todayKey();
  const fallback: Range = { start: addDays(today, -29), end: today };
  switch (preset) {
    case "7d":
      return { start: addDays(today, -6), end: today };
    case "week":
      return { start: weekStartMonday(today), end: today };
    case "month":
      return { start: today.slice(0, 8) + "01", end: today };
    case "challenge": {
      if (!challenge) return fallback;
      const challengeEnd = addDays(
        challenge.start_date,
        challenge.duration_days - 1
      );
      return {
        start: challenge.start_date,
        end: challengeEnd < today ? challengeEnd : today,
      };
    }
    case "custom": {
      const ok =
        /^\d{4}-\d{2}-\d{2}$/.test(customStart) &&
        /^\d{4}-\d{2}-\d{2}$/.test(customEnd) &&
        customStart <= customEnd;
      return ok ? { start: customStart, end: customEnd } : fallback;
    }
    case "30d":
    default:
      return fallback;
  }
}

/** The heatmap always covers the last 30 days, independent of the range. */
export function heatRange(): Range {
  const today = todayKey();
  return { start: addDays(today, -29), end: today };
}

export function rangeDays(range: Range): string[] {
  const out = daysInRange(range);
  return Array.isArray(out) ? out.filter((d) => typeof d === "string") : [];
}

/** The Hifz habit is the user's habit named "Hifz" (case-insensitive). */
export function findHifzHabitId(habits: Habit[]): string | null {
  return (
    habits.find((h) => h.name.trim().toLowerCase() === "hifz")?.id ?? null
  );
}

// ---------------------------------------------------------------------------
// habits
// ---------------------------------------------------------------------------

export interface HabitStat {
  habitId: string;
  name: string;
  frequency: string;
  activeDays: number;
  doneDays: number;
  pct: number | null;
}

export function habitStats(
  habits: Habit[],
  logs: HabitLog[],
  range: Range
): HabitStat[] {
  return asRecords(habitConsistency(habits, logs, range)).map((r) => ({
    habitId: str(r.habitId ?? r.habit_id),
    name: str(r.name),
    frequency: str(r.frequency),
    activeDays: num(r.activeDays),
    doneDays: num(r.doneDays),
    pct: typeof r.pct === "number" ? r.pct : null,
  }));
}

// ---------------------------------------------------------------------------
// distractions: abstinence + limits (kept separate)
// ---------------------------------------------------------------------------

export interface RuleStat {
  ruleId: string;
  name: string;
  incidents: number;
  incidentFreeDays: number;
  dates: string[];
}

export function ruleStats(
  rules: AbstinenceRule[],
  incidents: AbstinenceIncident[],
  range: Range
): RuleStat[] {
  return asRecords(abstinenceStats(rules, incidents, range)).map((r) => ({
    ruleId: str(r.ruleId ?? r.rule_id),
    name: str(r.name),
    incidents: num(r.incidents),
    incidentFreeDays: num(r.incidentFreeDays),
    dates: Array.isArray(r.dates)
      ? r.dates.filter((d): d is string => typeof d === "string")
      : [],
  }));
}

export interface LimitStat {
  limitId: string;
  name: string;
  dailyLimit: number;
  totalUsed: number;
  avgPerDay: number | null;
  daysWithin: number;
  daysOver: number;
  daysWithData: number;
  compliancePct: number | null;
}

export function limitStats(
  limits: UsageLimit[],
  logs: LimitLog[],
  range: Range
): LimitStat[] {
  return asRecords(limitCompliance(limits, logs, range)).map((r) => ({
    limitId: str(r.limitId ?? r.limit_id),
    name: str(r.name),
    dailyLimit: num(r.dailyLimit),
    totalUsed: num(r.totalUsed),
    avgPerDay: typeof r.avgPerDay === "number" ? r.avgPerDay : null,
    daysWithin: num(r.daysWithin),
    daysOver: num(r.daysOver),
    daysWithData: num(r.daysWithData),
    compliancePct: typeof r.compliancePct === "number" ? r.compliancePct : null,
  }));
}

// ---------------------------------------------------------------------------
// training
// ---------------------------------------------------------------------------

export interface TrainingSummary {
  planned: number;
  completed: number;
  completionPct: number | null;
  restDays: number;
}

export function trainingSummary(
  sessions: WorkoutSession[],
  schedule: TrainingScheduleRow[],
  range: Range
): TrainingSummary {
  const rows = trainingStats(sessions, schedule, range);
  const r = asObject(Array.isArray(rows) ? rows[0] : rows);
  return {
    planned: num(r.planned),
    completed: num(r.completed),
    completionPct:
      typeof r.completionPct === "number" ? r.completionPct : null,
    restDays: num(r.restDays),
  };
}

export interface ExercisePoint {
  date: string;
  value: number;
  label: string;
}

/**
 * first/latest/best arrive as human labels ("12 reps", "45s") — displayed
 * as-is, never re-derived.
 */
export interface ExerciseStat {
  exerciseId: string;
  name: string;
  type: string;
  first: string | null;
  latest: string | null;
  best: string | null;
  points: ExercisePoint[];
}

export function exerciseProgress(
  exercises: WorkoutExercise[],
  sessions: WorkoutSession[],
  sets: WorkoutSet[],
  range: Range
): ExerciseStat[] {
  return asRecords(exerciseProgression(exercises, sessions, sets, range)).map(
    (r) => ({
      exerciseId: str(r.exerciseId ?? r.exercise_id),
      name: str(r.name),
      type: str(r.type),
      first: typeof r.first === "string" ? r.first : null,
      latest: typeof r.latest === "string" ? r.latest : null,
      best: typeof r.best === "string" ? r.best : null,
      points: asRecords(r.points)
        .map((p) => ({
          date: str(p.date),
          value: num(p.value),
          label: str(p.label),
        }))
        .filter((p) => p.date)
        .sort((a, b) => (a.date < b.date ? -1 : 1)),
    })
  );
}

// ---------------------------------------------------------------------------
// study
// ---------------------------------------------------------------------------

export interface StudyTotals {
  totalSeconds: number;
  activeDays: number;
  sessionCount: number;
  avgPerActiveDay: number | null;
}

export function studySummary(
  sessions: StudySession[],
  range: Range
): StudyTotals {
  const rows = studyTotals(sessions, range);
  const r = asObject(Array.isArray(rows) ? rows[0] : rows);
  return {
    totalSeconds: num(r.totalSeconds),
    activeDays: num(r.activeDays),
    sessionCount: num(r.sessionCount),
    avgPerActiveDay:
      typeof r.avgPerActiveDay === "number" ? r.avgPerActiveDay : null,
  };
}

export interface SubjectTotal {
  subjectId: string;
  name: string;
  seconds: number;
  sessions: number;
}

function sessionCountsBy(
  sessions: StudySession[],
  range: Range,
  key: (s: StudySession) => string | null
): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of sessions) {
    if (s.session_date < range.start || s.session_date > range.end) continue;
    const k = key(s);
    if (!k) continue;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

export function subjectTotals(
  sessions: StudySession[],
  subjects: Subject[],
  range: Range
): SubjectTotal[] {
  // studyBySubject returns { subjectId, name, seconds } — session counts are
  // tallied locally from the same sessions.
  const counts = sessionCountsBy(sessions, range, (s) => s.subject_id);
  return asRecords(studyBySubject(sessions, subjects, range))
    .map((r) => {
      const id = str(r.subjectId ?? r.subject_id);
      return {
        subjectId: id,
        name: str(r.name),
        seconds: num(r.seconds ?? r.totalSeconds),
        sessions: counts.get(id) ?? 0,
      };
    })
    .filter((s) => s.subjectId && s.seconds > 0);
}

export interface TopicTotal {
  topicId: string;
  name: string;
  seconds: number;
  sessions: number;
}

export function topicTotals(
  sessions: StudySession[],
  topics: Topic[],
  subjectId: string,
  range: Range
): TopicTotal[] {
  const counts = sessionCountsBy(sessions, range, (s) => s.topic_id);
  return asRecords(studyByTopic(sessions, topics, subjectId, range))
    .map((r) => {
      const id = str(r.topicId ?? r.topic_id);
      return {
        topicId: id,
        name: str(r.name),
        seconds: num(r.seconds ?? r.totalSeconds),
        sessions: counts.get(id) ?? 0,
      };
    })
    .filter((t) => t.topicId && t.seconds > 0);
}

export interface TrendItem {
  key: string;
  label: string;
  value: number;
}

export function studyTrendItems(
  sessions: StudySession[],
  range: Range,
  bucket: "day" | "week"
): TrendItem[] {
  return asRecords(studyTrend(sessions, range, bucket)).map((r) => ({
    key: str(r.key),
    label: str(r.label),
    value: num(r.seconds ?? r.value),
  }));
}

// ---------------------------------------------------------------------------
// hifz
// ---------------------------------------------------------------------------

export interface SeriesPoint {
  date: string;
  value: number | null;
}

function adaptSeries(raw: unknown): SeriesPoint[] {
  return asRecords(raw)
    .map((r) => ({
      date: str(r.date ?? r.key),
      value: r.value === null || r.value === undefined ? null : num(r.value),
    }))
    .filter((p) => p.date)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

export interface HifzTotals {
  total: number;
  recordedDays: number;
  zeroDays: number;
  avgPerRecordedDay: number | null;
}

export interface HifzData {
  points: SeriesPoint[];
  totals: HifzTotals;
  /** raw hifzSeries output, for firstFinal */
  raw: unknown;
}

export function hifzData(
  logs: HabitLog[],
  hifzHabitId: string,
  range: Range
): HifzData {
  const raw = hifzSeries(logs, hifzHabitId, range);
  const t = asObject(hifzTotals(raw));
  return {
    points: adaptSeries(raw),
    totals: {
      total: num(t.total),
      recordedDays: num(t.recordedDays),
      zeroDays: num(t.zeroDays),
      avgPerRecordedDay:
        typeof t.avgPerRecordedDay === "number" ? t.avgPerRecordedDay : null,
    },
    raw,
  };
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

export interface BookBreakdown {
  bookId: string | null;
  name: string;
  pages: number;
  days: number;
}

export interface ReadingData {
  points: SeriesPoint[];
  totalPages: number;
  recordedDays: number;
  byBook: BookBreakdown[];
  /** raw readingSeries output, for firstFinalAvg */
  raw: unknown;
}

export function readingData(
  logs: ReadingLog[],
  range: Range,
  books: { id: string; name: string }[]
): ReadingData {
  const raw = readingSeries(logs, range);
  const points = adaptSeries(raw);
  // readingByBook takes no range — hand it range-filtered logs, and tally
  // distinct days per book locally (the API returns pages only).
  const inRange = logs.filter(
    (l) => l.log_date >= range.start && l.log_date <= range.end
  );
  const daysByBook = new Map<string | null, Set<string>>();
  for (const l of inRange) {
    let set = daysByBook.get(l.book_id);
    if (!set) {
      set = new Set();
      daysByBook.set(l.book_id, set);
    }
    set.add(l.log_date);
  }
  const names = new Map(books.map((b) => [b.id, b.name]));
  const byBook: BookBreakdown[] = asRecords(readingByBook(inRange, books)).map(
    (r) => {
      const id =
        typeof r.bookId === "string" || r.bookId === null
          ? (r.bookId as string | null)
          : null;
      return {
        bookId: id,
        name: str(r.name) || (id ? names.get(id) : null) || "No book",
        pages: num(r.pages ?? r.totalPages),
        days: daysByBook.get(id)?.size ?? 0,
      };
    }
  );
  return {
    points,
    totalPages: points.reduce((a, p) => a + (p.value ?? 0), 0),
    recordedDays: points.filter((p) => p.value !== null).length,
    byBook,
    raw,
  };
}

// ---------------------------------------------------------------------------
// first vs final 7 days of a range, for { date, value } series.
// firstFinalAvg takes non-null values only and returns nulls when a window
// has no points.
// ---------------------------------------------------------------------------

export interface FirstFinal {
  first: number | null;
  final: number | null;
}

export function firstFinal(rawSeries: unknown, range: Range): FirstFinal {
  const pts = asRecords(rawSeries)
    .filter((p) => typeof p.value === "number")
    .map((p) => ({ date: str(p.date), value: p.value as number }))
    .filter((p) => p.date);
  const r = asObject(firstFinalAvg(pts, range));
  return {
    first: typeof r.first === "number" ? r.first : null,
    final: typeof r.final === "number" ? r.final : null,
  };
}

// ---------------------------------------------------------------------------
// planned vs actual
// ---------------------------------------------------------------------------

export interface PlanActual {
  tasksPlanned: number;
  tasksDone: number;
  studyPlanned: number;
  studyActual: number;
  workoutsPlanned: number;
  workoutsActual: number;
}

export function planVsActual(
  tasks: Task[],
  studySessions: StudySession[],
  workoutSessions: WorkoutSession[],
  range: Range
): PlanActual {
  const rows = plannedVsActual(tasks, studySessions, workoutSessions, range);
  const r = asObject(Array.isArray(rows) ? rows[0] : rows);
  return {
    tasksPlanned: num(r.tasksPlanned),
    tasksDone: num(r.tasksDone),
    studyPlanned: num(r.studyPlanned),
    studyActual: num(r.studyActual),
    workoutsPlanned: num(r.workoutsPlanned),
    workoutsActual: num(r.workoutsActual),
  };
}

// ---------------------------------------------------------------------------
// heatmap inputs + per-day detail counts (fixed 30-day window)
// ---------------------------------------------------------------------------

interface HeatInputs {
  habitDoneDates: string[];
  studyDates: string[];
  workoutDates: string[];
  hifzDates: string[];
  readingDates: string[];
  journalDates: string[];
}

function buildHeatInputs(
  data: ProgressData,
  hifzHabitId: string | null,
  r: Range
): HeatInputs {
  const inR = (d: string) => d >= r.start && d <= r.end;
  return {
    habitDoneDates: data.habitLogs
      .filter((l) => l.status === "done" && inR(l.log_date))
      .map((l) => l.log_date),
    studyDates: data.studySessions
      .filter((s) => inR(s.session_date))
      .map((s) => s.session_date),
    workoutDates: data.sessions
      .filter((s) => s.status === "completed" && inR(s.session_date))
      .map((s) => s.session_date),
    hifzDates: hifzHabitId
      ? data.habitLogs
          .filter(
            (l) =>
              l.habit_id === hifzHabitId &&
              l.status === "done" &&
              inR(l.log_date)
          )
          .map((l) => l.log_date)
      : [],
    readingDates: data.readingLogs
      .filter((l) => inR(l.log_date))
      .map((l) => l.log_date),
    journalDates: data.journalDates.filter(inR),
  };
}

export function heatDays(
  data: ProgressData,
  hifzHabitId: string | null
): HeatDay[] {
  const r = heatRange();
  const raw = heatmapDays({ range: r, ...buildHeatInputs(data, hifzHabitId, r) });
  return asRecords(raw).map((d) => {
    const lvl = num(d.level);
    return {
      date: str(d.date),
      level: (lvl === 1 || lvl === 2 || lvl === 3 ? lvl : 0) as 0 | 1 | 2 | 3,
      signals: Array.isArray(d.signals)
        ? d.signals.filter((s): s is string => typeof s === "string")
        : [],
    };
  });
}

/** Per-day counts for the heatmap detail strip. */
export function dayCounts(
  data: ProgressData,
  hifzHabitId: string | null
): Record<string, DayCounts> {
  const r = heatRange();
  const out: Record<string, DayCounts> = {};
  for (const d of rangeDays(r)) {
    out[d] = {
      date: d,
      habitsDone: 0,
      studySeconds: 0,
      workouts: 0,
      hifz: null,
      pages: 0,
      journaled: false,
      incidents: 0,
      limitsOver: 0,
    };
  }
  const inR = (d: string) => d >= r.start && d <= r.end;

  for (const l of data.habitLogs) {
    if (!inR(l.log_date)) continue;
    const c = out[l.log_date];
    if (!c) continue;
    if (l.status === "done") c.habitsDone += 1;
    if (hifzHabitId && l.habit_id === hifzHabitId && l.value != null) {
      c.hifz = (c.hifz ?? 0) + l.value;
    }
  }
  for (const s of data.studySessions) {
    if (!inR(s.session_date)) continue;
    const c = out[s.session_date];
    if (c) c.studySeconds += s.duration_seconds;
  }
  for (const s of data.sessions) {
    if (s.status !== "completed" || !inR(s.session_date)) continue;
    const c = out[s.session_date];
    if (c) c.workouts += 1;
  }
  for (const l of data.readingLogs) {
    if (!inR(l.log_date)) continue;
    const c = out[l.log_date];
    if (c) c.pages += l.pages;
  }
  for (const d of data.journalDates) {
    if (!inR(d)) continue;
    const c = out[d];
    if (c) c.journaled = true;
  }
  for (const i of data.incidents) {
    const d = utcToDayKey(i.occurred_at);
    if (!inR(d)) continue;
    const c = out[d];
    if (c) c.incidents += 1;
  }
  const limitById = new Map(data.limits.map((l) => [l.id, l]));
  const overDays = new Set<string>();
  for (const l of data.limitLogs) {
    if (!inR(l.log_date)) continue;
    const def = limitById.get(l.limit_id);
    if (def && l.minutes_used > def.daily_limit_min) {
      overDays.add(l.log_date);
    }
  }
  for (const d of overDays) {
    const c = out[d];
    if (c) c.limitsOver += 1;
  }
  return out;
}
