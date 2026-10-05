/**
 * V4.7 — Winter Arc onboarding & first-run experience.
 *
 * Onboarding completion is DERIVED, never stored: a user has completed
 * onboarding if and only if they have at least one challenge. No new
 * database table, no persistent flag, no migration.
 *
 * - New users (no challenge) are routed to /onboarding.
 * - Returning users (any challenge) go straight into the app.
 * - Existing users with a pre-V4.7 challenge are preserved untouched.
 *
 * All operations are idempotent:
 * - seedDefaultsIfEmpty() is count-guarded (existing behavior).
 * - ensureOnboardingChallenge() returns the existing challenge when one
 *   exists; otherwise it upserts a single deterministic row, so double
 *   submission, retry after interruption, and multi-device races converge
 *   instead of creating duplicates.
 * - applyOnboardingConfig() uses updates (idempotent) and deterministic
 *   ids / name checks for inserts.
 *
 * Ownership: every write goes through getDb(), which stamps the ambient
 * sync-context user id as owner. There is no way to initialize another
 * user's configuration.
 */

import { getDb } from "./sync/write";
import { engine } from "./sync/engine";
import { seedDefaultsIfEmpty, seedId } from "./seed";
import type {
  AbstinenceRule,
  Challenge,
  Habit,
  UsageLimit,
} from "./types";

function currentUserId(): string {
  const id = engine.getSnapshot().userId;
  if (!id) throw new Error("Not signed in.");
  return id;
}

/**
 * True when the user has completed onboarding. Derived from the existing
 * challenge state: any challenge (active or past) means the user has been
 * through setup — either the V4.7 onboarding or the pre-V4.7 Settings flow.
 */
export async function hasCompletedOnboarding(): Promise<boolean> {
  const db = getDb();
  const userId = currentUserId();
  const rows = await db.list("challenges", {
    eq: { owner: userId },
    limit: 1,
  });
  return rows.length > 0;
}

/**
 * The user's challenges, newest first. Used by the onboarding gate and the
 * onboarding page to decide whether setup is needed.
 */
export async function listChallenges(): Promise<Challenge[]> {
  const db = getDb();
  const userId = currentUserId();
  return db.list<Challenge>("challenges", {
    eq: { owner: userId },
    order: [{ col: "created_at", ascending: false }],
  });
}

export interface OnboardingChallengeInput {
  /** YYYY-MM-DD, challenge-local. */
  startDate: string;
  durationDays: number;
  title?: string;
}

/**
 * Idempotent challenge creation for onboarding.
 *
 * - If the user already has any challenge, it is returned untouched: never
 *   overwritten, never duplicated, dates never reset.
 * - Otherwise a single challenge row is upserted under a deterministic id
 *   (seedId(owner, "challenge", "onboarding")), so repeated submission,
 *   retry after an interrupted onboarding, and cross-device races all
 *   converge on one row.
 * - Preserves the app's "one active challenge at a time" invariant by
 *   deactivating any other active rows (only possible via a race, since we
 *   return early when challenges already exist).
 */
export async function ensureOnboardingChallenge(
  input: OnboardingChallengeInput
): Promise<Challenge> {
  const db = getDb();
  const userId = currentUserId();
  const existing = await db.list<Challenge>("challenges", {
    eq: { owner: userId },
    order: [{ col: "created_at", ascending: false }],
  });
  const active = existing.find((c) => c.is_active) ?? existing[0];
  if (active) return active;

  const durationDays = Math.max(1, Math.min(365, Math.floor(input.durationDays) || 30));
  const row = await db.upsert(
    "challenges",
    {
      id: seedId(userId, "challenge", "onboarding"),
      title: input.title?.trim() || "30-Day Winter Arc",
      subtitle: null,
      start_date: input.startDate,
      duration_days: durationDays,
      is_active: true,
    },
    undefined,
    { tolerance: "drop-on-conflict" }
  );
  const challenge = row as unknown as Challenge;

  // Defensive: preserve the one-active-challenge invariant if a race
  // created a second row between our check and the upsert.
  const others = await db.list<Challenge>("challenges", {
    eq: { owner: userId, is_active: true },
  });
  await Promise.all(
    others
      .filter((c) => c.id !== challenge.id)
      .map((c) => db.update("challenges", c.id, { is_active: false }))
  );
  return challenge;
}

export interface OnboardingConfig {
  habits: Habit[];
  rules: AbstinenceRule[];
  limits: UsageLimit[];
}

/**
 * Loads the current daily-system configuration for the onboarding review
 * steps. Seeds the app defaults first when the user has none yet
 * (idempotent — the same seeding the app already does lazily).
 */
export async function getOnboardingConfig(): Promise<OnboardingConfig> {
  await seedDefaultsIfEmpty();
  const db = getDb();
  const userId = currentUserId();
  const [habits, rules, limits] = await Promise.all([
    db.list<Habit>("habits", {
      eq: { owner: userId },
      order: [{ col: "sort_order", ascending: true }],
    }),
    db.list<AbstinenceRule>("abstinence_rules", {
      eq: { owner: userId },
      order: [{ col: "name", ascending: true }],
    }),
    db.list<UsageLimit>("usage_limits", {
      eq: { owner: userId },
      order: [{ col: "name", ascending: true }],
    }),
  ]);
  return { habits, rules, limits };
}

export interface OnboardingSelections {
  /** habit id -> enabled */
  habitEnabled: Record<string, boolean>;
  /** names of custom habits to add */
  newHabits: string[];
  /** rule id -> enabled */
  ruleEnabled: Record<string, boolean>;
  /** limit id -> minutes per day */
  limitMinutes: Record<string, number>;
  /** optional first book */
  bookName: string;
  bookAuthor: string;
  bookTotalPages: string;
}

/**
 * Persists the user's onboarding selections. Fully idempotent:
 * - Toggles and limit changes are plain updates.
 * - Custom habits use deterministic ids (upsert) keyed by normalized name.
 * - The optional book is only created when no book with the same name
 *   exists yet (case-insensitive).
 * Safe to call repeatedly; safe after an interrupted onboarding.
 */
export async function applyOnboardingConfig(
  selections: OnboardingSelections
): Promise<void> {
  const db = getDb();
  const userId = currentUserId();

  for (const [id, enabled] of Object.entries(selections.habitEnabled)) {
    await db.update("habits", id, { is_active: enabled });
  }

  for (const rawName of selections.newHabits) {
    const name = rawName.trim();
    if (!name) continue;
    await db.upsert(
      "habits",
      {
        id: seedId(userId, "habit", `onboarding:${name.toLowerCase()}`),
        name,
        description: null,
        tracking: "completion",
        frequency: "daily",
        weekly_target: null,
        preferred_time: null,
        sort_order: 99,
        is_active: true,
      },
      undefined,
      { tolerance: "drop-on-conflict" }
    );
  }

  for (const [id, enabled] of Object.entries(selections.ruleEnabled)) {
    await db.update("abstinence_rules", id, { is_active: enabled });
  }

  for (const [id, minutes] of Object.entries(selections.limitMinutes)) {
    const clean = Math.max(0, Math.min(24 * 60, Math.floor(Number(minutes) || 0)));
    await db.update("usage_limits", id, { daily_limit_min: clean });
  }

  const bookName = selections.bookName.trim();
  if (bookName) {
    const existing = await db.list("books", { eq: { owner: userId } });
    const duplicate = existing.some(
      (b) =>
        String(b.name ?? "")
          .trim()
          .toLowerCase() === bookName.toLowerCase()
    );
    if (!duplicate) {
      const totalPages = Math.floor(Number(selections.bookTotalPages) || 0);
      const last = (
        await db.list<{ sort_order: number }>("books", {
          eq: { owner: userId },
          order: [{ col: "sort_order", ascending: false }],
          limit: 1,
        })
      )[0];
      await db.insert("books", {
        name: bookName,
        author: selections.bookAuthor.trim() || null,
        total_pages: totalPages > 0 ? totalPages : null,
        is_active: true,
        sort_order: (last?.sort_order ?? -1) + 1,
      });
    }
  }
}
