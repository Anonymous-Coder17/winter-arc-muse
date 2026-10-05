/**
 * V4.6 — 30-day challenge phases.
 *
 * Phases are a NARRATIVE and ORGANIZATIONAL layer, not gamification.
 * There are no points, XP, levels, badges, streak penalties, life scores,
 * phase scores, automatic failure, challenge resets, or punishment mechanics.
 * A missed day or relapse never resets the challenge or the phase — the
 * existing behavioral tracking remains the source of truth.
 *
 * Phase is DERIVED, never stored: it is computed from the challenge's
 * existing start_date + duration_days and the current date, using the same
 * challenge-local date semantics as challengeDayNumber (lib/types.ts).
 * Deriving avoids stale phase state and needs no database migration.
 *
 * Scope decision (V4.6): the phase system is shown ONLY for the standard
 * 30-day challenge (duration_days === 30). For any other duration the
 * functions below return null and no phase UI renders — inventing
 * arbitrary phase boundaries for non-standard durations would be dishonest.
 */

import { addDays } from "@/lib/dates";
import { challengeDayNumber, type Challenge } from "@/lib/types";

export type PhaseKey = "stabilize" | "build" | "discipline" | "identity";

export interface PhaseDef {
  key: PhaseKey;
  /** Display name, e.g. "Stabilize". */
  name: string;
  /** One-line description of the phase's purpose. */
  description: string;
  /** First challenge day in this phase (1-based, inclusive). */
  startDay: number;
  /** Last challenge day in this phase (inclusive). */
  endDay: number;
}

/** The four phases of the standard 30-day Winter Arc. Single source of truth. */
export const CHALLENGE_PHASES: PhaseDef[] = [
  {
    key: "stabilize",
    name: "Stabilize",
    description:
      "Establish the baseline and make the daily system easy to follow.",
    startDay: 1,
    endDay: 7,
  },
  {
    key: "build",
    name: "Build",
    description:
      "Strengthen consistency across study, training, reading, and routines.",
    startDay: 8,
    endDay: 15,
  },
  {
    key: "discipline",
    name: "Discipline",
    description: "Execute the system even when motivation is low.",
    startDay: 16,
    endDay: 23,
  },
  {
    key: "identity",
    name: "Identity",
    description:
      "Turn the systems you've practiced into something you can carry forward.",
    startDay: 24,
    endDay: 30,
  },
];

export type PhaseState = "past" | "current" | "upcoming";

export interface ResolvedPhase {
  def: PhaseDef;
  state: PhaseState;
  /** First calendar date of this phase (YYYY-MM-DD, challenge-local). */
  startDate: string;
  /** Last calendar date of this phase (YYYY-MM-DD, challenge-local). */
  endDate: string;
}

/**
 * True when the phase system applies to this challenge.
 * Only the standard 30-day challenge gets phases (see module doc).
 */
export function phasesAvailable(challenge: Challenge): boolean {
  return challenge.duration_days === 30;
}

/** Phase containing the given 1-based challenge day, or null outside 1–30. */
export function phaseForDayNumber(day: number): PhaseDef | null {
  if (!Number.isInteger(day) || day < 1 || day > 30) return null;
  return CHALLENGE_PHASES.find((p) => day >= p.startDay && day <= p.endDay) ?? null;
}

/**
 * Current phase for the challenge on the given date.
 * Uses challengeDayNumber, so the phase changes on the challenge-local date,
 * not an arbitrary UTC boundary. Returns null when phases don't apply
 * (non-30-day challenge), the challenge hasn't started, or it has ended.
 * A missed day or relapse changes nothing — the day number (and therefore
 * the phase) comes only from dates, never from recorded behavior.
 */
export function currentChallengePhase(
  challenge: Challenge,
  onDate: Date
): { def: PhaseDef; dayNumber: number } | null {
  if (!phasesAvailable(challenge)) return null;
  const dayNumber = challengeDayNumber(challenge, onDate);
  const def = phaseForDayNumber(dayNumber);
  return def ? { def, dayNumber } : null;
}

/**
 * Phase for an arbitrary YYYY-MM-DD date key within the challenge's span,
 * or null when the date is outside the challenge or phases don't apply.
 * Used for journal/review context (e.g. "Day 12 · Build").
 */
export function phaseForDateKey(
  challenge: Challenge,
  dateKey: string
): { def: PhaseDef; dayNumber: number } | null {
  if (!phasesAvailable(challenge)) return null;
  const dayNumber = challengeDayNumber(challenge, new Date(dateKey + "T00:00:00"));
  const def = phaseForDayNumber(dayNumber);
  return def ? { def, dayNumber } : null;
}

/**
 * All four phases with their calendar date ranges and past/current/upcoming
 * state relative to the given date. State is date-based only — never a
 * percentage score. Returns null when phases don't apply.
 */
export function resolveChallengePhases(
  challenge: Challenge,
  onDate: Date
): ResolvedPhase[] | null {
  if (!phasesAvailable(challenge)) return null;
  const dayNumber = challengeDayNumber(challenge, onDate);
  return CHALLENGE_PHASES.map((def) => ({
    def,
    state:
      dayNumber > def.endDay ? "past" : dayNumber < def.startDay ? "upcoming" : "current",
    startDate: addDays(challenge.start_date, def.startDay - 1),
    endDate: addDays(challenge.start_date, def.endDay - 1),
  }));
}
