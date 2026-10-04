// Journal & review data access (V3).
// Plain async helpers for the browser. Each creates its own Supabase client
// and scopes everything to the signed-in owner (RLS backs this up too).
// Re-exports the V3 domain types so journal UI has one import home.
//
// Privacy note: journal content is only ever displayed inside the journal UI.
// Never include it in analytics summaries or any other surface.

import { createClient } from "@/lib/supabase/client";
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

async function authed() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in.");
  return { supabase, owner: user.id };
}

// ---------------------------------------------------------------------------
// Journal entries (one row per local day)
// ---------------------------------------------------------------------------

export async function getJournalEntry(
  dateKey: string
): Promise<JournalEntry | null> {
  const { supabase, owner } = await authed();
  const { data, error } = await supabase
    .from("journal_entries")
    .select("*")
    .eq("owner", owner)
    .eq("entry_date", dateKey)
    .maybeSingle();
  if (error) throw error;
  return data as JournalEntry | null;
}

export async function upsertJournalEntry(
  dateKey: string,
  content: string
): Promise<JournalEntry> {
  const { supabase, owner } = await authed();
  const { data, error } = await supabase
    .from("journal_entries")
    .upsert(
      {
        owner,
        entry_date: dateKey,
        content,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "owner,entry_date" }
    )
    .select("*")
    .single();
  if (error) throw error;
  return data as JournalEntry;
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
  const { supabase, owner } = await authed();
  const { data, error } = await supabase
    .from("daily_reviews")
    .select("*")
    .eq("owner", owner)
    .eq("review_date", dateKey)
    .maybeSingle();
  if (error) throw error;
  return data as DailyReview | null;
}

export async function upsertDailyReview(
  dateKey: string,
  fields: DailyReviewFields
): Promise<DailyReview> {
  const { supabase, owner } = await authed();
  const patch: Record<string, string | null> = {};
  for (const k of ["wins", "problems", "distractions", "adjustment"] as const) {
    const v = fields[k];
    if (v !== undefined) patch[k] = v;
  }
  patch.updated_at = new Date().toISOString();

  const existing = await getDailyReview(dateKey);
  const { data, error } = existing
    ? await supabase
        .from("daily_reviews")
        .update(patch)
        .eq("id", existing.id)
        .select("*")
        .single()
    : await supabase
        .from("daily_reviews")
        .insert({ owner, review_date: dateKey, ...patch })
        .select("*")
        .single();
  if (error) throw error;
  return data as DailyReview;
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
  const { supabase, owner } = await authed();
  const { data, error } = await supabase
    .from("weekly_reviews")
    .select("*")
    .eq("owner", owner)
    .eq("week_start", weekStartKey)
    .maybeSingle();
  if (error) throw error;
  return data as WeeklyReview | null;
}

export async function upsertWeeklyReview(
  weekStartKey: string,
  weekEndKey: string,
  fields: WeeklyReviewFields
): Promise<WeeklyReview> {
  const { supabase, owner } = await authed();
  const patch: Record<string, string | null> = {
    week_end: weekEndKey,
    updated_at: new Date().toISOString(),
  };
  for (const k of ["what_worked", "what_didnt", "next_adjustment"] as const) {
    const v = fields[k];
    if (v !== undefined) patch[k] = v;
  }

  const existing = await getWeeklyReview(weekStartKey);
  const { data, error } = existing
    ? await supabase
        .from("weekly_reviews")
        .update(patch)
        .eq("id", existing.id)
        .select("*")
        .single()
    : await supabase
        .from("weekly_reviews")
        .insert({ owner, week_start: weekStartKey, ...patch })
        .select("*")
        .single();
  if (error) throw error;
  return data as WeeklyReview;
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
  const { supabase, owner } = await authed();
  const { data, error } = await supabase
    .from("challenge_reviews")
    .select("*")
    .eq("owner", owner)
    .eq("challenge_id", challengeId)
    .maybeSingle();
  if (error) throw error;
  return data as ChallengeReview | null;
}

export async function upsertChallengeReview(
  challengeId: string,
  fields: ChallengeReviewFields
): Promise<ChallengeReview> {
  const { supabase, owner } = await authed();
  const patch: Record<string, number | string | null> = {
    updated_at: new Date().toISOString(),
  };
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

  const existing = await getChallengeReview(challengeId);
  const { data, error } = existing
    ? await supabase
        .from("challenge_reviews")
        .update(patch)
        .eq("id", existing.id)
        .select("*")
        .single()
    : await supabase
        .from("challenge_reviews")
        .insert({ owner, challenge_id: challengeId, ...patch })
        .select("*")
        .single();
  if (error) throw error;
  return data as ChallengeReview;
}

// ---------------------------------------------------------------------------
// Books — archive only, never delete (history keeps working).
// ---------------------------------------------------------------------------

export async function getBooks(): Promise<Book[]> {
  const { supabase, owner } = await authed();
  const { data, error } = await supabase
    .from("books")
    .select("*")
    .eq("owner", owner)
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  if (error) throw error;
  return (data ?? []) as Book[];
}

export async function createBook(
  name: string,
  author?: string,
  totalPages?: number
): Promise<Book> {
  const { supabase, owner } = await authed();
  const { data: last } = await supabase
    .from("books")
    .select("sort_order")
    .eq("owner", owner)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { data, error } = await supabase
    .from("books")
    .insert({
      owner,
      name,
      author: author?.trim() || null,
      total_pages: totalPages && totalPages > 0 ? totalPages : null,
      is_active: true,
      sort_order: (last?.sort_order ?? -1) + 1,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as Book;
}

export async function updateBook(
  id: string,
  fields: Partial<Pick<Book, "name" | "author" | "total_pages" | "sort_order">>
): Promise<Book> {
  const { supabase } = await authed();
  const { data, error } = await supabase
    .from("books")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return data as Book;
}

export async function archiveBook(id: string): Promise<void> {
  const { supabase } = await authed();
  const { error } = await supabase
    .from("books")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Reading logs — V3 source of truth for reading.
// Upsert per (owner, log_date, book_id): adds pages to the existing row.
// ---------------------------------------------------------------------------

export async function logReadingPages(
  dateKey: string,
  pages: number,
  bookId?: string | null
): Promise<void> {
  const { supabase, owner } = await authed();
  if (!pages || pages <= 0) throw new Error("Pages must be positive.");

  let q = supabase
    .from("reading_logs")
    .select("*")
    .eq("owner", owner)
    .eq("log_date", dateKey);
  q = bookId ? q.eq("book_id", bookId) : q.is("book_id", null);
  const { data: existing, error: findErr } = await q.maybeSingle();
  if (findErr) throw findErr;

  if (existing) {
    const { error } = await supabase
      .from("reading_logs")
      .update({
        pages: Number(existing.pages ?? 0) + pages,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
    if (error) throw error;
    return;
  }

  const { error } = await supabase.from("reading_logs").insert({
    owner,
    book_id: bookId ?? null,
    log_date: dateKey,
    pages,
    note: null,
  });
  if (error) throw error;
}

export async function getReadingLogs(
  start: string,
  end: string
): Promise<ReadingLog[]> {
  const { supabase, owner } = await authed();
  const { data, error } = await supabase
    .from("reading_logs")
    .select("*")
    .eq("owner", owner)
    .gte("log_date", start)
    .lte("log_date", end)
    .order("log_date", { ascending: true });
  if (error) throw error;
  return (data ?? []) as ReadingLog[];
}

// ---------------------------------------------------------------------------
// Journal frequency — entry_date only, for range summaries/heatmaps.
// ---------------------------------------------------------------------------

export async function getJournalDates(
  start: string,
  end: string
): Promise<string[]> {
  const { supabase, owner } = await authed();
  const { data, error } = await supabase
    .from("journal_entries")
    .select("entry_date")
    .eq("owner", owner)
    .gte("entry_date", start)
    .lte("entry_date", end)
    .order("entry_date", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r) => (r as { entry_date: string }).entry_date);
}
