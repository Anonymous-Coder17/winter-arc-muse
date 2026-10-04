// Journal & review data access (V3).
// Local-first: reads hit the per-user IndexedDB cache, writes apply
// instantly and queue for background sync (@/lib/sync). getDb() throws
// "Not signed in." when no user DB is open — callers await
// engine.whenReady() first.
// Re-exports the V3 domain types so journal UI has one import home.
//
// Privacy note: journal content is only ever displayed inside the journal UI.
// Never include it in analytics summaries or any other surface.

import { getDb } from "@/lib/sync/write";
import type {
  Book,
  Challenge,
  ChallengeReview,
  DailyReview,
  JournalEntry,
  ReadingLog,
  WeeklyReview,
} from "@/lib/types";

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
  const db = getDb();
  const last = (
    await db.list<Book>("books", {
      order: [{ col: "sort_order", ascending: false }],
      limit: 1,
    })
  )[0];
  const row = await db.insert("books", {
    name,
    author: author?.trim() || null,
    total_pages: totalPages && totalPages > 0 ? totalPages : null,
    is_active: true,
    sort_order: (last?.sort_order ?? -1) + 1,
  });
  return row as unknown as Book;
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
