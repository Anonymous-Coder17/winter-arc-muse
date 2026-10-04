-- ============================================================================
-- winter-arc-muse · V3 schema: journal + reviews + books/reading logs
-- Incremental and idempotent (safe to re-run): every statement uses
-- IF NOT EXISTS guards or drop-if-exists + recreate, and no existing
-- data is altered. Never touches migrations 0001-0004.
-- The reading_logs backfill below is idempotent via a NOT EXISTS guard.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- journal_entries
-- One free-form journal entry per day (kind 'journal' previously lived on
-- daily_records; V3 makes journaling first-class with a per-day unique).
-- ---------------------------------------------------------------------------
create table if not exists public.journal_entries (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null references auth.users(id) on delete cascade,
  entry_date  date not null,
  content     text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (owner, entry_date)
);
alter table public.journal_entries enable row level security;

drop policy if exists "journal_entries_all_own" on public.journal_entries;
create policy "journal_entries_all_own"
  on public.journal_entries for all
  using (auth.uid() = owner)
  with check (auth.uid() = owner);

drop trigger if exists journal_entries_updated_at on public.journal_entries;
create trigger journal_entries_updated_at
  before update on public.journal_entries
  for each row execute function public.handle_updated_at();

create index if not exists journal_entries_owner_date_idx
  on public.journal_entries (owner, entry_date);

-- ---------------------------------------------------------------------------
-- daily_reviews
-- One review per day; every field is nullable so a partial review can be
-- saved and filled in later (wins/problems/distractions/adjustment).
-- ---------------------------------------------------------------------------
create table if not exists public.daily_reviews (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null references auth.users(id) on delete cascade,
  review_date date not null,
  wins        text,
  problems    text,
  distractions text,
  adjustment  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (owner, review_date)
);
alter table public.daily_reviews enable row level security;

drop policy if exists "daily_reviews_all_own" on public.daily_reviews;
create policy "daily_reviews_all_own"
  on public.daily_reviews for all
  using (auth.uid() = owner)
  with check (auth.uid() = owner);

drop trigger if exists daily_reviews_updated_at on public.daily_reviews;
create trigger daily_reviews_updated_at
  before update on public.daily_reviews
  for each row execute function public.handle_updated_at();

create index if not exists daily_reviews_owner_date_idx
  on public.daily_reviews (owner, review_date);

-- ---------------------------------------------------------------------------
-- weekly_reviews
-- One review per week, anchored on week_start (a Monday). week_end must be
-- >= week_start; the app enforces the Monday convention.
-- ---------------------------------------------------------------------------
create table if not exists public.weekly_reviews (
  id              uuid primary key default gen_random_uuid(),
  owner           uuid not null references auth.users(id) on delete cascade,
  week_start      date not null,
  week_end        date not null check (week_end >= week_start),
  what_worked     text,
  what_didnt      text,
  next_adjustment text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (owner, week_start)
);
alter table public.weekly_reviews enable row level security;

drop policy if exists "weekly_reviews_all_own" on public.weekly_reviews;
create policy "weekly_reviews_all_own"
  on public.weekly_reviews for all
  using (auth.uid() = owner)
  with check (auth.uid() = owner);

drop trigger if exists weekly_reviews_updated_at on public.weekly_reviews;
create trigger weekly_reviews_updated_at
  before update on public.weekly_reviews
  for each row execute function public.handle_updated_at();

create index if not exists weekly_reviews_owner_start_idx
  on public.weekly_reviews (owner, week_start);

-- ---------------------------------------------------------------------------
-- challenge_reviews
-- One review per challenge: Day 1 vs Day 30 baselines plus the final
-- retrospective. Tied to the challenge so history survives multiple
-- challenge rounds.
-- ---------------------------------------------------------------------------
create table if not exists public.challenge_reviews (
  id                  uuid primary key default gen_random_uuid(),
  owner               uuid not null references auth.users(id) on delete cascade,
  challenge_id        uuid not null references public.challenges(id) on delete cascade,
  baseline_study_min    int check (baseline_study_min is null or baseline_study_min >= 0),
  baseline_reading_pages int check (baseline_reading_pages is null or baseline_reading_pages >= 0),
  baseline_hifz_ayahs   int check (baseline_hifz_ayahs is null or baseline_hifz_ayahs >= 0),
  baseline_notes      text,
  review_what_worked  text,
  review_what_didnt   text,
  review_adjustment   text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (owner, challenge_id)
);
alter table public.challenge_reviews enable row level security;

drop policy if exists "challenge_reviews_all_own" on public.challenge_reviews;
create policy "challenge_reviews_all_own"
  on public.challenge_reviews for all
  using (auth.uid() = owner)
  with check (auth.uid() = owner);

drop trigger if exists challenge_reviews_updated_at on public.challenge_reviews;
create trigger challenge_reviews_updated_at
  before update on public.challenge_reviews
  for each row execute function public.handle_updated_at();

create index if not exists challenge_reviews_owner_challenge_idx
  on public.challenge_reviews (owner, challenge_id);

-- ---------------------------------------------------------------------------
-- books
-- The user's reading list. `is_active` archives finished/dropped books
-- (history in reading_logs survives). Case-insensitive name uniqueness
-- per owner (double-submit race guard).
-- ---------------------------------------------------------------------------
create table if not exists public.books (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  author      text,
  total_pages int check (total_pages is null or total_pages > 0),
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.books enable row level security;

drop policy if exists "books_all_own" on public.books;
create policy "books_all_own"
  on public.books for all
  using (auth.uid() = owner)
  with check (auth.uid() = owner);

drop trigger if exists books_updated_at on public.books;
create trigger books_updated_at
  before update on public.books
  for each row execute function public.handle_updated_at();

create index if not exists books_owner_idx
  on public.books (owner, is_active, sort_order);

-- Case-insensitive name uniqueness per owner (double-submit race guard).
-- An expression can't appear in an inline CREATE TABLE unique constraint,
-- so this is a separate unique index, mirroring 0001's habits guard.
create unique index if not exists books_owner_name_uidx
  on public.books (owner, lower(name));

-- ---------------------------------------------------------------------------
-- reading_logs
-- Reading progress: pages read on a date, optionally against a book.
-- book_id ON DELETE RESTRICT: a book with logged pages cannot be
-- hard-deleted (archive it instead); bookless rows from the backfill
-- carry book_id null. From V3 on this is the source of truth for
-- reading pages (see backfill below).
-- ---------------------------------------------------------------------------
create table if not exists public.reading_logs (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null references auth.users(id) on delete cascade,
  book_id     uuid references public.books(id) on delete restrict,
  log_date    date not null,
  pages       int not null check (pages >= 0),
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.reading_logs enable row level security;

drop policy if exists "reading_logs_all_own" on public.reading_logs;
create policy "reading_logs_all_own"
  on public.reading_logs for all
  using (auth.uid() = owner)
  with check (auth.uid() = owner);

drop trigger if exists reading_logs_updated_at on public.reading_logs;
create trigger reading_logs_updated_at
  before update on public.reading_logs
  for each row execute function public.handle_updated_at();

create index if not exists reading_logs_owner_date_idx
  on public.reading_logs (owner, log_date);
create index if not exists reading_logs_book_idx
  on public.reading_logs (book_id);

-- ---------------------------------------------------------------------------
-- backfill: reading_logs from pre-V3 "Reading" count habits
-- Before V3, reading pages were logged via a count-tracking habit named
-- 'Reading'. This one-time-per-row backfill copies those values into
-- reading_logs (bookless, book_id null) so V3 has a single source of
-- truth. Idempotent: rows already backfilled (same owner + log_date +
-- book_id is null) are skipped.
-- ---------------------------------------------------------------------------
insert into public.reading_logs (owner, book_id, log_date, pages, note)
select
  hl.owner,
  null,
  hl.log_date,
  hl.value::int,
  hl.note
from public.habit_logs hl
join public.habits h on h.id = hl.habit_id
where h.tracking = 'count'
  and lower(h.name) = 'reading'
  and hl.value is not null
  and not exists (
    select 1
    from public.reading_logs rl
    where rl.owner = hl.owner
      and rl.log_date = hl.log_date
      and rl.book_id is null
  );
