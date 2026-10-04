-- 0009_google_oauth_hardening.sql
--
-- V4.3.1.1: Google OAuth flow hardening (database layer only).
--
-- What this migration does:
--   * public.google_oauth_transactions — a server-side, single-use store for
--     OAuth state + PKCE verifiers during the Google consent flow. The
--     browser holds only a random transaction id (in a narrow-scoped,
--     httpOnly cookie); the state, verifier, and owner binding live here.
--     The verifier is stored as AES-256-GCM ciphertext via the OAuth
--     worker's tokenVault key, NEVER as plaintext. Transactions expire
--     (created with a 10-minute TTL) and are consumed atomically: the first
--     successful consume deletes the row, so a transaction id can never be
--     replayed or used by a different user.
--   * ONE-ACCOUNT-PER-USER on google_calendar_connections — the integration
--     boundary is a single linked Google account per app user. A fail-safe
--     guard (below) verifies no owner has more than one connection BEFORE
--     anything else is created: if duplicates exist, the migration aborts
--     with a clear error and changes NOTHING. It never auto-picks a
--     survivor and never deletes rows — calendar selections cascade from
--     the connection, so silent deletion would destroy user data. Once the
--     data is valid, unique(owner) is added. The finer-grained
--     unique(owner, google_account_id) from 0008 remains in place.
--
-- This migration is additive and safe: no tables, policies, triggers, or
-- functions from 0001-0008 are modified, and it performs no destructive
-- data changes of its own.

-- ---------------------------------------------------------------------------
-- duplicate-connection guard: fail safe, never destructive (runs FIRST)
-- ---------------------------------------------------------------------------
-- unique(owner) can only be added when the data is already valid. Never
-- auto-pick a survivor: deleting a duplicate connection would cascade to
-- its calendar selections and silently destroy user data, so the migration
-- refuses to proceed instead. The duplicate owner must be resolved
-- explicitly (choose which connection and its selections to keep) before
-- re-running this migration.
do $$
declare
  dup_owner uuid;
  dup_count integer;
begin
  select owner, count(*)
    into dup_owner, dup_count
    from public.google_calendar_connections
   group by owner
  having count(*) > 1
   limit 1;

  if dup_owner is not null then
    raise exception
      'migration 0009 aborted: owner % has % google_calendar_connections rows. '
      'Resolve the duplicate connections manually (choose which connection and '
      'its calendar selections to keep), then re-run the migration. '
      'No rows were deleted.',
      dup_owner, dup_count
      using errcode = 'integrity_constraint_violation';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- google_oauth_transactions
-- ---------------------------------------------------------------------------
create table if not exists public.google_oauth_transactions (
  id           uuid primary key default gen_random_uuid(),
  owner        uuid not null references auth.users(id) on delete cascade,
  -- OAuth CSRF state sent to Google and compared (timing-safe) on return.
  state        text not null,
  -- AES-256-GCM ciphertext of the PKCE code verifier. The OAuth worker
  -- encrypts server-side with a key from env; the plaintext never goes here.
  verifier_enc text not null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  -- Set the instant the transaction is consumed; the row is deleted right
  -- after, so a consumed transaction id can never be reused.
  consumed_at  timestamptz
);
alter table public.google_oauth_transactions enable row level security;

drop policy if exists "google_oauth_transactions_all_own"
  on public.google_oauth_transactions;
create policy "google_oauth_transactions_all_own"
  on public.google_oauth_transactions for all
  using (auth.uid() = owner)
  with check (auth.uid() = owner);

-- Lookups and stale cleanup are always owner-scoped by expiration time.
create index if not exists google_oauth_transactions_owner_expires_idx
  on public.google_oauth_transactions (owner, expires_at);

-- ---------------------------------------------------------------------------
-- one account per user on google_calendar_connections
-- ---------------------------------------------------------------------------
-- The guard above has already verified that no owner has more than one
-- connection, so the constraint can be added safely.
alter table public.google_calendar_connections
  add constraint google_calendar_connections_one_per_owner unique (owner);
