-- 0011_google_calendar_roundtrip.sql
--
-- V4.3.2.1: preserve Google timezone + all-day semantics for round-tripping.
--
-- Two correctness fixes, both additive:
--
-- 1. calendar_events.is_all_day — marks events that are all-day. Google
--    all-day events import as 00:00–23:59 rows (so the existing
--    CHECK (start_time < end_time) still holds and local display is
--    unchanged); the flag is the semantic marker the sync engine uses to
--    emit start.date/end.date instead of start.dateTime/end.dateTime when
--    pushing back to Google.
--
-- 2. google_event_mappings round-trip metadata:
--      google_end_timezone : Google end timezone, only when it differs from
--        the start zone (NULL = same as google_timezone).
--      google_start_date / google_end_date : the Google all-day date range
--        (end is EXCLUSIVE per Google semantics: 2026-10-10 → 2026-10-12
--        means Oct 10 and Oct 11). NULL for timed events.
--
--    google_timezone itself now stores the GOOGLE event's start timezone
--    (start.timeZone, else the event's timeZone, else the calendar's
--    timeZone). Previously the sync engine stored the app/device timezone
--    used for display — that conflated "display timezone" with "Google
--    event timezone" and caused pushes to silently re-zone events. Rows
--    written before this fix keep their old value until the next Google→app
--    update refreshes them; the push path falls back to the current sync
--    timezone when the stored value is NULL, so nothing breaks.
--
-- This migration does not modify any existing table, policy, trigger,
-- constraint, function, or index from 0001–0010. Additive only.

-- ---------------------------------------------------------------------------
-- calendar_events.is_all_day
-- ---------------------------------------------------------------------------
alter table public.calendar_events
  add column if not exists is_all_day boolean not null default false;

-- ---------------------------------------------------------------------------
-- google_event_mappings round-trip columns
-- ---------------------------------------------------------------------------
alter table public.google_event_mappings
  add column if not exists google_end_timezone text,
  add column if not exists google_start_date date,
  add column if not exists google_end_date date;

-- The all-day date range is stored as a pair or not at all: a half-written
-- range would make the push path unable to reconstruct the exclusive end.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'google_event_mappings_all_day_dates_pair'
  ) then
    alter table public.google_event_mappings
      add constraint google_event_mappings_all_day_dates_pair
      check ((google_start_date is null) = (google_end_date is null));
  end if;
end $$;
