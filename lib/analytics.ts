// Analytics library (V3).
//
// PURE functions only: no I/O, no Supabase, no input mutation. Every
// function takes plain domain rows and returns derived numbers for the UI.
// All dates are local YYYY-MM-DD day keys; timestamped rows (incidents)
// are attributed to calendar days via utcToDayKey from lib/dates.
//
// Product rules honored here:
// - Never call abstinence incident-free days a "streak".
// - No combined scores; each domain reports its own rates.
// - Plans and reality stay separate (plannedVsActual keeps them apart).

import type {
  Habit,
  HabitLog,
  AbstinenceIncident,
  UsageLimit,
  LimitLog,
  WorkoutSession,
  WorkoutExercise,
  WorkoutSet,
  TrainingScheduleRow,
  Subject,
  Topic,
  StudySession,
  Task,
  ExerciseType,
  ReadingLog,
} from "./types";
import {
  addDays,
  formatDuration,
  formatShort,
  utcToDayKey,
  weekdayIndex,
  weekStartMonday,
} from "./dates";

export interface DateRange {
  start: string; // YYYY-MM-DD, inclusive
  end: string; // YYYY-MM-DD, inclusive
}

/** Every local day key in the range, inclusive. Empty when start > end. */
export function daysInRange(r: DateRange): string[] {
  const days: string[] = [];
  if (r.start > r.end) return days;
  for (let d = r.start; d <= r.end; d = addDays(d, 1)) days.push(d);
  return days;
}

/** Round to a whole percent. */
function pct(done: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((done / total) * 100);
}

/**
 * Rows from the DB carry `created_at` (timestamptz), which is not part of
 * the Habit type in lib/types.ts, so it is read defensively. A habit with
 * no created_at is treated as active for the whole range.
 */
type HabitRow = Habit & { created_at?: string };

function habitCreatedDay(h: HabitRow, range: DateRange): string {
  return h.created_at ? utcToDayKey(h.created_at) : range.start;
}

export interface HabitStat {
  habitId: string;
  name: string;
  frequency: "daily" | "weekly";
  activeDays: number;
  doneDays: number;
  pct: number | null;
}

/**
 * Consistency per habit over the range.
 *
 * daily: denominator = days in range on/after the habit's local created
 * day; numerator = days with a 'done' log.
 * weekly: denominator = week-start Mondays in range on/after the created
 * week; numerator = weeks whose 'done' log count reaches weekly_target
 * (default 1). Here activeDays/doneDays count weeks.
 *
 * Inactive habits are still computed over their lived days: there is no
 * deactivation timestamp, so a habit that was active then stopped simply
 * reports a lower pct. Nothing here implies a "streak".
 */
export function habitConsistency(
  habits: Habit[],
  logs: HabitLog[],
  range: DateRange
): HabitStat[] {
  const days = daysInRange(range);
  const logsInRange = logs.filter(
    (l) => l.log_date >= range.start && l.log_date <= range.end
  );

  return habits.map((h) => {
    const createdDay = habitCreatedDay(h, range);
    if (h.frequency === "weekly") {
      const createdWeek = weekStartMonday(createdDay);
      const mondays = days.filter(
        (d) => weekdayIndex(d) === 0 && d >= createdWeek
      );
      const activeDays = mondays.length;
      const doneByWeek = new Map<string, number>();
      for (const l of logsInRange) {
        if (l.habit_id !== h.id || l.status !== "done") continue;
        const monday = weekStartMonday(l.log_date);
        doneByWeek.set(monday, (doneByWeek.get(monday) ?? 0) + 1);
      }
      const target = h.weekly_target ?? 1;
      const doneDays = mondays.filter(
        (m) => (doneByWeek.get(m) ?? 0) >= target
      ).length;
      return {
        habitId: h.id,
        name: h.name,
        frequency: h.frequency,
        activeDays,
        doneDays,
        pct: pct(doneDays, activeDays),
      };
    }

    // daily
    const activeSet = new Set(days.filter((d) => d >= createdDay));
    const doneSet = new Set<string>();
    for (const l of logsInRange) {
      if (l.habit_id !== h.id || l.status !== "done") continue;
      if (l.log_date >= createdDay) doneSet.add(l.log_date);
    }
    const activeDays = activeSet.size;
    const doneDays = [...doneSet].filter((d) => activeSet.has(d)).length;
    return {
      habitId: h.id,
      name: h.name,
      frequency: h.frequency,
      activeDays,
      doneDays,
      pct: pct(doneDays, activeDays),
    };
  });
}

export interface AbstinenceStat {
  ruleId: string;
  name: string;
  incidents: number;
  incidentFreeDays: number;
  dates: string[];
}

/**
 * Per-rule abstinence summary. Incidents are attributed to their LOCAL day
 * via utcToDayKey. incidentFreeDays = days in range with no incident
 * (clamped at 0). This is an incident-free-day count, never a streak.
 */
export function abstinenceStats(
  rules: { id: string; name: string }[],
  incidents: { rule_id: string; occurred_at: string }[],
  range: DateRange
): AbstinenceStat[] {
  const totalDays = daysInRange(range).length;
  return rules.map((rule) => {
    const dayKeys = incidents
      .filter((i) => i.rule_id === rule.id)
      .map((i) => utcToDayKey(i.occurred_at))
      .filter((d) => d >= range.start && d <= range.end)
      .sort();
    const uniqueDays = new Set(dayKeys);
    return {
      ruleId: rule.id,
      name: rule.name,
      incidents: dayKeys.length,
      incidentFreeDays: Math.max(0, totalDays - uniqueDays.size),
      dates: dayKeys,
    };
  });
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

/**
 * Per-limit usage compliance. Multiple logs on the same day are summed
 * before comparing against the daily limit.
 */
export function limitCompliance(
  limits: UsageLimit[],
  logs: LimitLog[],
  range: DateRange
): LimitStat[] {
  return limits.map((limit) => {
    const perDay = new Map<string, number>();
    for (const l of logs) {
      if (l.limit_id !== limit.id) continue;
      if (l.log_date < range.start || l.log_date > range.end) continue;
      perDay.set(l.log_date, (perDay.get(l.log_date) ?? 0) + l.minutes_used);
    }
    let totalUsed = 0;
    let daysWithin = 0;
    let daysOver = 0;
    for (const minutes of perDay.values()) {
      totalUsed += minutes;
      if (minutes <= limit.daily_limit_min) daysWithin++;
      else daysOver++;
    }
    const daysWithData = perDay.size;
    return {
      limitId: limit.id,
      name: limit.name,
      dailyLimit: limit.daily_limit_min,
      totalUsed,
      avgPerDay:
        daysWithData === 0 ? null : Math.round(totalUsed / daysWithData),
      daysWithin,
      daysOver,
      daysWithData,
      compliancePct: pct(daysWithin, daysWithData),
    };
  });
}

export interface TrainingStat {
  planned: number;
  completed: number;
  completionPct: number | null;
  restDays: number;
}

/**
 * planned = days in range whose schedule row has a non-null workout_id.
 * restDays = days with an explicit null workout_id (scheduled rest);
 * rest days are never counted as missed. Weekdays with no schedule row at
 * all count as neither.
 */
export function trainingStats(
  sessions: WorkoutSession[],
  schedule: TrainingScheduleRow[],
  range: DateRange
): TrainingStat[] {
  const byWeekday = new Map<number, TrainingScheduleRow>();
  for (const row of schedule) byWeekday.set(row.weekday, row);

  let planned = 0;
  let restDays = 0;
  for (const d of daysInRange(range)) {
    const row = byWeekday.get(weekdayIndex(d));
    if (!row) continue;
    if (row.workout_id === null) restDays++;
    else planned++;
  }

  const completed = sessions.filter(
    (s) =>
      s.status === "completed" &&
      s.session_date >= range.start &&
      s.session_date <= range.end
  ).length;

  return [
    {
      planned,
      completed,
      completionPct: pct(completed, planned),
      restDays,
    },
  ];
}

export interface ExercisePoint {
  date: string;
  value: number;
  label: string;
}

export interface ExerciseProgression {
  exerciseId: string;
  name: string;
  type: ExerciseType;
  first: string | null;
  latest: string | null;
  best: string | null;
  points: ExercisePoint[];
}

/**
 * Per-exercise progression from completed sessions in range. Per exercise
 * per date, reps exercises sum reps ("12 reps"), time exercises sum
 * duration_seconds (formatDuration, e.g. "45s"). first/latest/best are the
 * human labels of the first, last, and max-value points.
 */
export function exerciseProgression(
  exercises: WorkoutExercise[],
  sessions: WorkoutSession[],
  sets: WorkoutSet[],
  range: DateRange
): ExerciseProgression[] {
  const sessionsInScope = sessions.filter(
    (s) =>
      s.status === "completed" &&
      s.session_date >= range.start &&
      s.session_date <= range.end
  );
  const sessionDateById = new Map(sessionsInScope.map((s) => [s.id, s.session_date]));
  const sessionInScope = new Set(sessionDateById.keys());
  const exerciseById = new Map(exercises.map((e) => [e.id, e]));

  const perExerciseDay = new Map<string, Map<string, number>>();
  for (const set of sets) {
    const date = sessionDateById.get(set.session_id);
    if (date === undefined) continue;
    const exercise = exerciseById.get(set.exercise_id);
    if (!exercise) continue;
    const value =
      exercise.exercise_type === "reps"
        ? set.reps ?? 0
        : set.duration_seconds ?? 0;
    let byDay = perExerciseDay.get(exercise.id);
    if (!byDay) {
      byDay = new Map();
      perExerciseDay.set(exercise.id, byDay);
    }
    byDay.set(date, (byDay.get(date) ?? 0) + value);
  }

  return exercises.map((e) => {
    const byDay = perExerciseDay.get(e.id);
    const points: ExercisePoint[] = [...(byDay?.entries() ?? [])]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([date, value]) => ({
        date,
        value,
        label:
          e.exercise_type === "reps" ? `${value} reps` : formatDuration(value),
      }));
    const bestPoint = points.reduce<ExercisePoint | null>(
      (best, p) => (best === null || p.value > best.value ? p : best),
      null
    );
    return {
      exerciseId: e.id,
      name: e.name,
      type: e.exercise_type,
      first: points.length > 0 ? points[0].label : null,
      latest: points.length > 0 ? points[points.length - 1].label : null,
      best: bestPoint ? bestPoint.label : null,
      points,
    };
  });
}

export interface StudyTotals {
  totalSeconds: number;
  activeDays: number;
  sessionCount: number;
  avgPerActiveDay: number | null;
}

/** Sessions are attributed by session_date, which is already a local day. */
function sessionsInStudyRange(
  sessions: StudySession[],
  range: DateRange
): StudySession[] {
  return sessions.filter(
    (s) => s.session_date >= range.start && s.session_date <= range.end
  );
}

export function studyTotals(
  sessions: StudySession[],
  range: DateRange
): StudyTotals[] {
  const inRange = sessionsInStudyRange(sessions, range);
  const totalSeconds = inRange.reduce((sum, s) => sum + s.duration_seconds, 0);
  const activeDays = new Set(inRange.map((s) => s.session_date)).size;
  return [
    {
      totalSeconds,
      activeDays,
      sessionCount: inRange.length,
      avgPerActiveDay:
        activeDays === 0 ? null : Math.round(totalSeconds / activeDays),
    },
  ];
}

export function studyBySubject(
  sessions: StudySession[],
  subjects: Subject[],
  range: DateRange
): { subjectId: string; name: string; seconds: number }[] {
  const inRange = sessionsInStudyRange(sessions, range);
  return subjects.map((subject) => ({
    subjectId: subject.id,
    name: subject.name,
    seconds: inRange
      .filter((s) => s.subject_id === subject.id)
      .reduce((sum, s) => sum + s.duration_seconds, 0),
  }));
}

export function studyByTopic(
  sessions: StudySession[],
  topics: Topic[],
  subjectId: string,
  range: DateRange
): { topicId: string; name: string; seconds: number }[] {
  const inRange = sessionsInStudyRange(sessions, range);
  return topics
    .filter((t) => t.subject_id === subjectId)
    .map((topic) => ({
      topicId: topic.id,
      name: topic.name,
      seconds: inRange
        .filter((s) => s.topic_id === topic.id)
        .reduce((sum, s) => sum + s.duration_seconds, 0),
    }));
}

export function studyTrend(
  sessions: StudySession[],
  range: DateRange,
  granularity: "day" | "week"
): { key: string; label: string; seconds: number }[] {
  const inRange = sessionsInStudyRange(sessions, range);
  const buckets = new Map<string, number>();
  for (const s of inRange) {
    const key =
      granularity === "day" ? s.session_date : weekStartMonday(s.session_date);
    buckets.set(key, (buckets.get(key) ?? 0) + s.duration_seconds);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, seconds]) => ({ key, label: formatShort(key), seconds }));
}

export interface CountSeriesPoint {
  date: string;
  value: number | null; // null = no record (distinct from recorded 0)
}

/**
 * Hifz ayahs per day from habit logs. A log row with value null is no
 * record; value 0 is a recorded zero. Non-null values on the same day sum.
 */
export function hifzSeries(
  logs: HabitLog[],
  hifzHabitId: string | null,
  range: DateRange
): CountSeriesPoint[] {
  return daysInRange(range).map((date) => {
    let sum: number | null = null;
    if (hifzHabitId !== null) {
      for (const l of logs) {
        if (l.habit_id !== hifzHabitId || l.log_date !== date) continue;
        if (l.value === null) continue;
        sum = (sum ?? 0) + l.value;
      }
    }
    return { date, value: sum };
  });
}

export function hifzTotals(points: CountSeriesPoint[]): {
  total: number;
  recordedDays: number;
  zeroDays: number;
  avgPerRecordedDay: number | null;
} {
  const recorded = points.filter((p) => p.value !== null);
  const total = recorded.reduce((sum, p) => sum + (p.value as number), 0);
  return {
    total,
    recordedDays: recorded.length,
    zeroDays: recorded.filter((p) => p.value === 0).length,
    avgPerRecordedDay:
      recorded.length === 0 ? null : Math.round(total / recorded.length),
  };
}

export interface ReadingLogRow {
  log_date: string;
  pages: number;
  book_id: string | null;
}

/** Pages per day. Days with no reading log get value null. */
export function readingSeries(
  logs: ReadingLogRow[],
  range: DateRange
): CountSeriesPoint[] {
  return daysInRange(range).map((date) => {
    let sum: number | null = null;
    for (const l of logs) {
      if (l.log_date !== date) continue;
      sum = (sum ?? 0) + l.pages;
    }
    return { date, value: sum };
  });
}

export function readingTotals(points: CountSeriesPoint[]): {
  total: number;
  recordedDays: number;
  avgPerRecordedDay: number | null;
} {
  const recorded = points.filter((p) => p.value !== null);
  const total = recorded.reduce((sum, p) => sum + (p.value as number), 0);
  return {
    total,
    recordedDays: recorded.length,
    avgPerRecordedDay:
      recorded.length === 0 ? null : Math.round(total / recorded.length),
  };
}

export function readingByBook(
  logs: ReadingLogRow[],
  books: { id: string; name: string }[]
): { bookId: string | null; name: string; pages: number }[] {
  const pagesByBook = new Map<string | null, number>();
  for (const l of logs) {
    pagesByBook.set(l.book_id, (pagesByBook.get(l.book_id) ?? 0) + l.pages);
  }
  const rows = books.map((b) => ({
    bookId: b.id as string | null,
    name: b.name,
    pages: pagesByBook.get(b.id) ?? 0,
  }));
  const noBookPages = pagesByBook.get(null);
  if (noBookPages !== undefined) {
    rows.push({ bookId: null, name: "No book", pages: noBookPages });
  }
  return rows;
}

export type HeatLevel = 0 | 1 | 2 | 3;

export interface HeatDay {
  date: string;
  level: HeatLevel;
  signals: string[];
}

/**
 * One HeatDay per day in range. Each input list is deduped, then signals
 * are counted per day: 0 = none, 1 = one signal, 2 = two or three,
 * 3 = four or more. signals lists the present signal names in fixed order.
 */
export function heatmapDays(input: {
  range: DateRange;
  habitDoneDates: string[];
  studyDates: string[];
  workoutDates: string[];
  hifzDates: string[];
  readingDates: string[];
  journalDates: string[];
}): HeatDay[] {
  const buckets: [string, Set<string>][] = [
    ["habits", new Set(input.habitDoneDates)],
    ["study", new Set(input.studyDates)],
    ["workouts", new Set(input.workoutDates)],
    ["hifz", new Set(input.hifzDates)],
    ["reading", new Set(input.readingDates)],
    ["journal", new Set(input.journalDates)],
  ];
  return daysInRange(input.range).map((date) => {
    const signals = buckets
      .filter(([, dates]) => dates.has(date))
      .map(([name]) => name);
    const count = signals.length;
    const level: HeatLevel =
      count === 0 ? 0 : count === 1 ? 1 : count <= 3 ? 2 : 3;
    return { date, level, signals };
  });
}

export interface PlannedActual {
  tasksPlanned: number;
  tasksDone: number;
  studyPlanned: number;
  studyActual: number;
  workoutsPlanned: number;
  workoutsActual: number;
}

/**
 * Planned vs reality for the range. Tasks are plans (kind study/workout
 * tasks count toward study/workout plans); sessions are reality.
 */
export function plannedVsActual(
  tasks: Task[],
  studySessions: StudySession[],
  workoutSessions: WorkoutSession[],
  range: DateRange
): PlannedActual[] {
  const tasksInRange = tasks.filter(
    (t) => t.task_date >= range.start && t.task_date <= range.end
  );
  return [
    {
      tasksPlanned: tasksInRange.length,
      tasksDone: tasksInRange.filter((t) => t.state === "done").length,
      studyPlanned: tasksInRange.filter((t) => t.kind === "study").length,
      studyActual: sessionsInStudyRange(studySessions, range).length,
      workoutsPlanned: tasksInRange.filter((t) => t.kind === "workout").length,
      workoutsActual: workoutSessions.filter(
        (s) =>
          s.status === "completed" &&
          s.session_date >= range.start &&
          s.session_date <= range.end
      ).length,
    },
  ];
}

export function firstFinalAvg(
  points: { date: string; value: number }[],
  range: DateRange
): { first: number | null; final: number | null } {
  const firstWindowEnd = addDays(range.start, 6);
  const finalWindowStart = addDays(range.end, -6);
  const firstValues = points
    .filter((p) => p.date >= range.start && p.date <= firstWindowEnd)
    .map((p) => p.value);
  const finalValues = points
    .filter((p) => p.date >= finalWindowStart && p.date <= range.end)
    .map((p) => p.value);
  // No zero-filling: averages cover only days that have points.
  const avg = (values: number[]): number | null =>
    values.length === 0
      ? null
      : values.reduce((sum, v) => sum + v, 0) / values.length;
  return { first: avg(firstValues), final: avg(finalValues) };
}
