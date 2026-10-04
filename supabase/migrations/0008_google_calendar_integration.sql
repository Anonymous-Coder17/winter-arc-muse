-- 0008_google_calendar_integration.sql
--
-- V4.3.1: Google Calendar integration foundation (database layer only).
--
-- What these tables are for:
--   * public.google_calendar_connections — one row per Google account the
--     user has linked via OAuth. Holds the OAuth tokens needed to import
--     Google Calendar events into the app's Planned vs Actual calendar.
--   * public.google_calendar_selections — which of that account's calendars
--     (by Google's calendarId) the user chose to import from, plus cached
--     metadata (calendar name, time zone, primary flag).
--
-- Token storage: refresh_token_enc and access_token_enc hold AES-256-GCM
-- ciphertext, NEVER plaintext. The OAuth worker encrypts server-side with a
-- key from the server environment before writing; the raw tokens never
-- reach the database.
--
-- Disconnect semantics: disconnecting = DELETE the connections row. The
-- delete cascades to that connection's selections. Previously imported app
-- events are NOT touched — imported history stays, only the linkage is
-- removed. Reconnecting the same Google account (same `sub`) reuses the
-- existing row (unique(owner, google_account_id)); it never creates a
-- duplicate.
--
-- RLS: strictly owner-only. Using(auth.uid() = owner) and
-- with check(auth.uid() = owner) on both tables, plus the selections
-- policy additionally requires the referenced connection row to be owned
-- by the caller, so a user can never attach a selection to someone else's
-- connection.
--
-- This migration does not modify any existing table, policy, trigger, or
-- function from 0001-0007.

-- ---------------------------------------------------------------------------
-- google_calendar_connections
-- ---------------------------------------------------------------------------
create table if not exists public.google_calendar_connections (
  id                 uuid primary key default gen_random_uuid(),
  owner              uuid not null references auth.users(id) on delete cascade,
  -- Google's stable user id (the OIDC `sub` claim): identifies the account.
  google_account_id  text not null,
  -- Display only, e.g. for "Connected as x@gmail.com".
  email              text,
  status             text not null default 'connected'
                       check (status in ('connected', 'revoked', 'error')),
  -- AES-256-GCM ciphertext of the refresh / access tokens. The OAuth worker
  -- encrypts server-side with a key from env; the plaintext never goes here.
  refresh_token_enc  text,
  access_token_enc   text,
  token_expires_at   timestamptz,
  scopes             text[] not null default '{}',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- Reconnecting the same Google account reuses the row: no duplicates.
  unique (owner, google_account_id)
);
alter table public.google_calendar_connections enable row level security;

drop policy if exists "google_calendar_connections_all_own"
  on public.google_calendar_connections;
create policy "google_calendar_connections_all_own"
  on public.google_calendar_connections for all
  using (auth.uid() = owner)
  with check (auth.uid() = owner);

create trigger google_calendar_connections_updated_at
  before update on public.google_calendar_connections
  for each row execute function public.handle_updated_at();

create index if not exists google_calendar_connections_owner_idx
  on public.google_calendar_connections (owner);

-- ---------------------------------------------------------------------------
-- google_calendar_selections
-- ---------------------------------------------------------------------------
create table if not exists public.google_calendar_selections (
  id                 uuid primary key default gen_random_uuid(),
  owner              uuid not null references auth.users(id) on delete cascade,
  connection_id      uuid not null
                       references public.google_calendar_connections(id)
                       on delete cascade,
  -- Google's calendarId (e.g. "primary" or "abcd@group.calendar.google.com").
  google_calendar_id text not null,
  calendar_name      text,
  time_zone          text,
  is_primary         boolean not null default false,
  -- Whether the user chose to import from this calendar.
  selected           boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (connection_id, google_calendar_id)
);
alter table public.google_calendar_selections enable row level security;

drop policy if exists "google_calendar_selections_all_own"
  on public.google_calendar_selections;
create policy "google_calendar_selections_all_own"
  on public.google_calendar_selections for all
  using (auth.uid() = owner)
  with check (
    auth.uid() = owner
    and exists (
      select 1
        from public.google_calendar_connections c
       where c.id = connection_id
         and c.owner = auth.uid()
    )
  );

create trigger google_calendar_selections_updated_at
  before update on public.google_calendar_selections
  for each row execute function public.handle_updated_at();

create index if not exists google_calendar_selections_owner_connection_idx
  on public.google_calendar_selections (owner, connection_id);
