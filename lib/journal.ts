// Journal & review data access (V3).
// Local-first: reads hit the per-user IndexedDB cache, writes apply
// instantly and queue for background sync (@/lib/sync). getDb() throws
// "Not signed in." when no user DB is open — callers await
// engine.whenReady() first.
// Re-exports the V3 domain types so journal UI has one import home.
//
// Privacy note: journal content is only ever displayed inside the journal UI.
// Never include it in analytics summaries or any other surface.

import { getDb, getPort } from "@/lib/sync/write";
import type {
  Book,
  Challenge,
  ChallengeReview,
  DailyReview,
  JournalEntry,
  ReadingLog,
  WeeklyReview,
} from "@/lib/types";
import type { Mutation } from "@/lib/sync/types";

export type {
  Book,
  Challenge,
  ChallengeReview,
  DailyReview,
  JournalEntry,
  ReadingLog,
  WeeklyReview,
};

// ---------------------------------------------------------------------------
// Journal entries (one row per local day)
// ---------------------------------------------------------------------------

export async function getJournalEntry(
  dateKey: string
): Promise<JournalEntry | null> {
  const db = getDb();
  return db.getByNaturalKey<JournalEntry>(
    "journal_entries",
    { index: "entry_date", cols: ["entry_date"] },
    { entry_date: dateKey }
  );
}

export async function upsertJournalEntry(
  dateKey: string,
  content: string
): Promise<JournalEntry> {
  const db = getDb();
  const row = await db.upsert(
    "journal_entries",
    { entry_date: dateKey, content },
    { index: "entry_date", cols: ["entry_date"] }
  );
  return row as unknown as JournalEntry;
}

// ---------------------------------------------------------------------------
// Daily reviews — partial save: only provided fields are written.
// ---------------------------------------------------------------------------

export interface DailyReviewFields {
  wins?: string | null;
  problems?: string | null;
  distractions?: string | null;
  adjustment?: string | null;
}

export async function getDailyReview(
  dateKey: string
): Promise<DailyReview | null> {
  const db = getDb();
  return db.getByNaturalKey<DailyReview>(
    "daily_reviews",
    { index: "review_date", cols: ["review_date"] },
    { review_date: dateKey }
  );
}

export async function upsertDailyReview(
  dateKey: string,
  fields: DailyReviewFields
): Promise<DailyReview> {
  const db = getDb();
  const patch: Record<string, string | null> = {};
  for (const k of ["wins", "problems", "distractions", "adjustment"] as const) {
    const v = fields[k];
    if (v !== undefined) patch[k] = v;
  }

  const existing = await db.getByNaturalKey<DailyReview>(
    "daily_reviews",
    { index: "review_date", cols: ["review_date"] },
    { review_date: dateKey }
  );
  const row = existing
    ? await db.update("daily_reviews", existing.id, patch)
    : await db.insert("daily_reviews", {
        review_date: dateKey,
        ...patch,
      });
  return row as unknown as DailyReview;
}

// ---------------------------------------------------------------------------
// Weekly reviews (week_start is Monday, local). Same partial-save semantics.
// ---------------------------------------------------------------------------

export interface WeeklyReviewFields {
  what_worked?: string | null;
  what_didnt?: string | null;
  next_adjustment?: string | null;
}

export async function getWeeklyReview(
  weekStartKey: string
): Promise<WeeklyReview | null> {
  const db = getDb();
  return db.getByNaturalKey<WeeklyReview>(
    "weekly_reviews",
    { index: "week_start", cols: ["week_start"] },
    { week_start: weekStartKey }
  );
}

export async function upsertWeeklyReview(
  weekStartKey: string,
  weekEndKey: string,
  fields: WeeklyReviewFields
): Promise<WeeklyReview> {
  const db = getDb();
  const patch: Record<string, string | null> = { week_end: weekEndKey };
  for (const k of ["what_worked", "what_didnt", "next_adjustment"] as const) {
    const v = fields[k];
    if (v !== undefined) patch[k] = v;
  }

  const existing = await db.getByNaturalKey<WeeklyReview>(
    "weekly_reviews",
    { index: "week_start", cols: ["week_start"] },
    { week_start: weekStartKey }
  );
  const row = existing
    ? await db.update("weekly_reviews", existing.id, patch)
    : await db.insert("weekly_reviews", {
        week_start: weekStartKey,
        ...patch,
      });
  return row as unknown as WeeklyReview;
}

// ---------------------------------------------------------------------------
// Challenge reviews — baseline capture + final review for one challenge.
// All fields optional; never fabricate missing data.
// ---------------------------------------------------------------------------

export interface ChallengeReviewFields {
  baseline_study_min?: number | null;
  baseline_reading_pages?: number | null;
  baseline_hifz_ayahs?: number | null;
  baseline_notes?: string | null;
  review_what_worked?: string | null;
  review_what_didnt?: string | null;
  review_adjustment?: string | null;
}

export async function getChallengeReview(
  challengeId: string
): Promise<ChallengeReview | null> {
  const db = getDb();
  return db.getByNaturalKey<ChallengeReview>(
    "challenge_reviews",
    { index: "challenge_id", cols: ["challenge_id"] },
    { challenge_id: challengeId }
  );
}

export async function upsertChallengeReview(
  challengeId: string,
  fields: ChallengeReviewFields
): Promise<ChallengeReview> {
  const db = getDb();
  const patch: Record<string, number | string | null> = {};
  for (const k of [
    "baseline_study_min",
    "baseline_reading_pages",
    "baseline_hifz_ayahs",
    "baseline_notes",
    "review_what_worked",
    "review_what_didnt",
    "review_adjustment",
  ] as const) {
    const v = fields[k];
    if (v !== undefined) patch[k] = v;
  }

  const existing = await db.getByNaturalKey<ChallengeReview>(
    "challenge_reviews",
    { index: "challenge_id", cols: ["challenge_id"] },
    { challenge_id: challengeId }
  );
  const row = existing
    ? await db.update("challenge_reviews", existing.id, patch)
    : await db.insert("challenge_reviews", {
        challenge_id: challengeId,
        ...patch,
      });
  return row as unknown as ChallengeReview;
}

// ---------------------------------------------------------------------------
// Books — archive only, never delete (history keeps working).
// ---------------------------------------------------------------------------

export async function getBooks(): Promise<Book[]> {
  const db = getDb();
  return db.list<Book>("books", {
    eq: { is_active: true },
    order: [
      { col: "sort_order", ascending: true },
      { col: "name", ascending: true },
    ],
  });
}

export async function createBook(
  name: string,
  author?: string,
  totalPages?: number
): Promise<Book> {
  const cleanName = name.trim();
  if (!cleanName) throw new Error("Give the book a name.");
  const db = getDb();
  const last = (
    await db.list<Book>("books", {
      order: [{ col: "sort_order", ascending: false }],
      limit: 1,
    })
  )[0];
  const row = await db.insert("books", {
    name: cleanName,
    author: author?.trim() || null,
    total_pages: totalPages && totalPages > 0 ? totalPages : null,
    is_active: true,
    sort_order: (last?.sort_order ?? -1) + 1,
  });
  return row as unknown as Book;
}

/** Books that have been archived. Same ordering as getBooks. */
export async function getArchivedBooks(): Promise<Book[]> {
  const db = getDb();
  return db.list<Book>("books", {
    eq: { is_active: false },
    order: [
      { col: "sort_order", ascending: true },
      { col: "name", ascending: true },
    ],
  });
}

export async function updateBook(
  id: string,
  fields: Partial<Pick<Book, "name" | "author" | "total_pages" | "sort_order">>
): Promise<Book> {
  const db = getDb();
  const row = await db.update<Book>("books", id, fields);
  return row;
}

export async function archiveBook(id: string): Promise<void> {
  const db = getDb();
  await db.update("books", id, { is_active: false });
}

/** Restore an archived book. Archive is just a flag, so restore is safe. */
export async function restoreBook(id: string): Promise<void> {
  const db = getDb();
  await db.update("books", id, { is_active: true });
}

// ---------------------------------------------------------------------------
// Reading logs — V3 source of truth for reading.
// Adds pages to the existing row for (log_date, book_id), or creates it.
// ---------------------------------------------------------------------------

export async function logReadingPages(
  dateKey: string,
  pages: number,
  bookId?: string | null
): Promise<void> {
  const db = getDb();
  if (!pages || pages <= 0) throw new Error("Pages must be positive.");

  const existing = (
    await db.list("reading_logs", {
      eq: { log_date: dateKey, book_id: bookId ?? null },
      limit: 1,
    })
  )[0];

  await db.increment(
    "reading_logs",
    existing?.id,
    "pages",
    pages,
    { log_date: dateKey, book_id: bookId ?? null, pages: 0, note: null }
  );
}

export async function getReadingLogs(
  start: string,
  end: string
): Promise<ReadingLog[]> {
  const db = getDb();
  return db.list<ReadingLog>("reading_logs", {
    gte: { log_date: start },
    lte: { log_date: end },
    order: [{ col: "log_date", ascending: true }],
  });
}

// ---------------------------------------------------------------------------
// Reading-log corrections.
//
// There is deliberately NO delete function for reading logs (and no delete
// for books — archive only). Two reasons:
//  1. Additive-sync resurrection race: a delete queued locally could lose to
//     a queued insert/increment for the same row replaying from another
//     device, silently resurrecting the "deleted" row.
//  2. History preservation: logs are the record of what happened; to correct
//     a mistaken entry, set its pages to 0 with updateReadingLogPages.
// ---------------------------------------------------------------------------

/**
 * Correct a reading-log row's page count (absolute value, not a delta).
 * Validates pages as an integer >= 0.
 *
 * Guard: reading pages are normally written with `db.increment`, whose
 * mutation replays as "apply delta on top of the latest remote value". If an
 * unflushed (pending/inflight/failed) mutation is still queued for this row,
 * an absolute write could clobber that delta during replay, so we refuse and
 * ask the user to try again once the sync has flushed. Read path: the
 * durable `_mutations` store via getPort() (same store the engine and
 * dropQueuedMutations use).
 */
export async function updateReadingLogPages(
  id: string,
  pages: number
): Promise<void> {
  if (!Number.isInteger(pages) || pages < 0)
    throw new Error("Pages must be a whole number of 0 or more.");
  const port = getPort();
  const queued = (await port.list("_mutations", {
    eq: { record_id: id },
  })) as Mutation[];
  const unsynced = queued.filter((m) => m.status !== "superseded");
  if (unsynced.length > 0)
    throw new Error("Sync in progress — please wait a moment and try again.");
  const db = getDb();
  await db.update("reading_logs", id, { pages });
}

// ---------------------------------------------------------------------------
// Journal frequency — entry_date only, for range summaries/heatmaps.
// ---------------------------------------------------------------------------

export async function getJournalDates(
  start: string,
  end: string
): Promise<string[]> {
  const db = getDb();
  const rows = await db.list<JournalEntry>("journal_entries", {
    gte: { entry_date: start },
    lte: { entry_date: end },
    order: [{ col: "entry_date", ascending: true }],
  });
  return rows.map((r) => r.entry_date);
}
