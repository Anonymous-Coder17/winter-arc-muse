import type { StudySession, Subject } from "./types";

/** Total seconds across sessions. */
export function sumDurations(sessions: StudySession[]): number {
  return sessions.reduce((acc, s) => acc + (s.duration_seconds || 0), 0);
}

export interface SubjectTotal {
  subject: Subject;
  seconds: number;
}

/** Time accumulated per subject, sorted highest first. */
export function totalsBySubject(
  sessions: StudySession[],
  subjects: Subject[]
): SubjectTotal[] {
  const byId = new Map<string, number>();
  for (const s of sessions) {
    byId.set(s.subject_id, (byId.get(s.subject_id) ?? 0) + s.duration_seconds);
  }
  return subjects
    .map((subject) => ({ subject, seconds: byId.get(subject.id) ?? 0 }))
    .filter((t) => t.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds);
}

/** Sessions within an inclusive local-date range. */
export function sessionsInRange(
  sessions: StudySession[],
  startKey: string,
  endKey: string
): StudySession[] {
  return sessions.filter(
    (s) => s.session_date >= startKey && s.session_date <= endKey
  );
}
