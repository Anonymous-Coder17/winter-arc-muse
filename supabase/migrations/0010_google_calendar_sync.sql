-- 0010_google_calendar_sync.sql
--
-- V4.3.2: Google Calendar event sync (database layer only).
--
-- What these tables are for:
--   * public.google_calendar_sync_state — one row per selected Google
--     calendar the user syncs. Holds the Google incremental-sync cursor
--     (`sync_token` from the events.list/watch channel) plus the last
--     time the worker synced that calendar.
--   * public.google_event_mappings — links app `calendar_events` rows to
--     their Google Calendar counterparts, in both directions:
--       - origin = 'google' : a Google event was IMPORTED into the app.
--         `local_event_id` points at the app's `calendar_events` copy;
--         `google_event_id` identifies the event on Google's side.
--       - origin = 'synced' : a local app event is PUSHED to Google.
--         `google_event_id` stays NULL until the local event is first
--         pushed; the mapping is created up-front so the push worker can
--         tell "not yet pushed" from "unknown event".
--
-- Tombstone semantics (why local_event_id is nullable ON DELETE SET NULL):
-- When the app's `calendar_events` row is deleted, the mapping row SURVIVES
-- with `local_event_id` set to NULL instead of being cascade-deleted. The
-- surviving row is a marker the sync worker reads, never re-imports:
--   - origin = 'google', local_event_id IS NULL : "the user deleted the
--     local copy of an imported Google event; do NOT re-import it on the
--     next sync." Google stays the source of truth for that event; the
--     local deletion is deliberate and must stick.
--   - origin = 'synced', local_event_id IS NULL : "the local event was
--     deleted; the sync worker must push that deletion to Google, then
--     drop the mapping." Until the push completes, the row is the queue.
-- A mapping with NULL `local_event_id` must therefore never be treated as
-- "missing mapping" by import logic; NULL google_event_id / NULL
-- local_event_id pairs on a UNIQUE index never conflict in Postgres, so
-- pending rows do not block each other.
--
-- Why these tables have NO foreign key to google_calendar_connections
-- (disconnect keeps them): disconnecting deletes the connections row
-- (0008 semantics), but the mappings and sync cursors must SURVIVE the
-- disconnect. Reconnecting the SAME Google account then resumes the
-- incremental sync from the stored sync_token instead of re-importing
-- everything and duplicating events. A FK with ON DELETE CASCADE would
-- destroy exactly that resume state, so the linkage is by the
-- (owner, google_account_id, google_calendar_id) text columns instead.
-- When the user REPLACES the account with a DIFFERENT Google account,
-- the application explicitly deletes that account's mappings and sync
-- state rows by google_account_id in a bulk owner-scoped delete, because
-- those cursors belong to the old account. No mapping may ever be deleted
-- implicitly by a connection delete.
--
-- RLS: strictly owner-only. A single FOR ALL policy per table,
-- using (auth.uid() = owner) and with check (auth.uid() = owner).
--
-- This migration does not modify any existing table, policy, trigger,
-- constraint, function, or index from 0001-0009. It only adds two tables
-- and their policies, triggers, and indexes.

-- ---------------------------------------------------------------------------
-- google_calendar_sync_state
-- ---------------------------------------------------------------------------
create table if not exists public.google_calendar_sync_state (
  id                 uuid primary key default gen_random_uuid(),
  owner              uuid not null references auth.users(id) on delete cascade,
  -- Google's stable user id (the OIDC `sub` claim): identifies the account.
  -- Intentionally NOT a FK to google_calendar_connections: the sync cursor
  -- must survive disconnect (see header). Text copies the account id.
  google_account_id  text not null,
  -- Google's calendarId (e.g. "primary" or "abcd@group.calendar.google.com").
  google_calendar_id text not null,
  -- Incremental-sync cursor from the last Google events.list response.
  -- NULL until the first successful sync of this calendar.
  sync_token         text,
  last_synced_at     timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- One cursor per selected calendar per user.
  unique (owner, google_calendar_id)
);
alter table public.google_calendar_sync_state enable row level security;

drop policy if exists "google_calendar_sync_state_all_own"
  on public.google_calendar_sync_state;
create policy "google_calendar_sync_state_all_own"
  on public.google_calendar_sync_state for all
  using (auth.uid() = owner)
  with check (auth.uid() = owner);

create trigger google_calendar_sync_state_updated_at
  before update on public.google_calendar_sync_state
  for each row execute function public.handle_updated_at();

create index if not exists google_calendar_sync_state_owner_calendar_idx
  on public.google_calendar_sync_state (owner, google_calendar_id);

-- ---------------------------------------------------------------------------
-- google_event_mappings
-- ---------------------------------------------------------------------------
create table if not exists public.google_event_mappings (
  id                 uuid primary key default gen_random_uuid(),
  owner              uuid not null references auth.users(id) on delete cascade,
  -- The app's calendar_events row. Nullable ON DELETE SET NULL: when the
  -- local event is deleted, the mapping survives as a tombstone marker
  -- (see header comment), NOT as a dangling row.
  local_event_id     uuid null references public.calendar_events(id)
                       on delete set null,
  -- Google's stable user id (the OIDC `sub` claim) and calendarId.
  -- Intentionally NOT a FK to google_calendar_connections: mappings must
  -- survive disconnect (see header). Deleted connections are cleaned up
  -- explicitly by the application keyed on google_account_id.
  google_account_id  text not null,
  google_calendar_id text not null,
  -- Google's event id. NULL until a local 'synced' event is first pushed.
  google_event_id    text,
  -- Google's etag for the event, for conditional updates/conflict checks.
  google_etag        text,
  -- 'google' = imported from Google; 'synced' = local event pushed to Google.
  origin             text not null
                       check (origin in ('google', 'synced')),
  -- IANA time zone reported by Google for the event, when known.
  google_timezone    text,
  -- Raw RRULE string for recurring masters, when known.
  recurrence         text,
  last_synced_at     timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- No duplicate imports under concurrency: NULL google_event_id rows
  -- never conflict in Postgres, so pending push rows don't block imports.
  unique (owner, google_calendar_id, google_event_id),
  -- One mapping per local event: NULL local_event_id tombstones never
  -- conflict, so multiple tombstones coexist without blocking new links.
  unique (owner, local_event_id)
);
alter table public.google_event_mappings enable row level security;

drop policy if exists "google_event_mappings_all_own"
  on public.google_event_mappings;
create policy "google_event_mappings_all_own"
  on public.google_event_mappings for all
  using (auth.uid() = owner)
  with check (auth.uid() = owner);

create trigger google_event_mappings_updated_at
  before update on public.google_event_mappings
  for each row execute function public.handle_updated_at();

create index if not exists google_event_mappings_owner_calendar_idx
  on public.google_event_mappings (owner, google_calendar_id);
