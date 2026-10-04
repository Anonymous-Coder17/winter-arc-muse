-- 0007_v4_2_2_increment_ledger.sql
--
-- V4.2.2: make additive-counter synchronization correct under concurrent
-- offline writes and retry/lost-response scenarios.
--
-- Problem: the sync engine used to replay an increment as client-side
-- read/modify/write and treated `remote_value = base_value + delta` as proof
-- the mutation was already applied. Two devices incrementing +5/+5 from a
-- base of 20 could therefore converge to 25 instead of 30 (the second
-- device's check mistook the first device's increment for its own), and
-- concurrent increments raced on non-atomic read/modify/write.
--
-- Fix: a server-side idempotency ledger plus an atomic RPC.
--   * public.sync_applied_mutations records every applied increment mutation
--    (mutation_id PK, owner-scoped). A retried mutation is recognized by its
--    stable identity -- never by comparing numeric values.
--   * public.apply_increment() runs in a single transaction: ledger insert
--    (ON CONFLICT DO NOTHING) + INSERT ... ON CONFLICT (natural key) DO
--    UPDATE SET field = field + delta. Concurrent callers serialize on the
--    unique arbiter / row lock, so every independent increment survives and
--    no increment is ever applied twice.
--
-- The function is SECURITY INVOKER (the default): RLS policies apply to the
-- calling user exactly as if they had issued the statements themselves.
-- owner is forced to auth.uid() server-side; a mutation id can never be
-- marked applied for another account.
--
-- Whitelisted to the three additive counter paths that exist in the app:
--   habit_logs.value, limit_logs.minutes_used, reading_logs.pages
-- No other entity may use this RPC (the function raises otherwise).
--
-- This migration does not modify any existing table, policy, trigger, or
-- function from 0001-0006.

-- ---------------------------------------------------------------------------
-- idempotency ledger
-- ---------------------------------------------------------------------------
create table if not exists public.sync_applied_mutations (
  mutation_id uuid primary key,
  owner_id    uuid not null references auth.users(id) on delete cascade,
  entity      text not null,
  record_id   uuid not null,
  field       text not null,
  delta       numeric not null,
  applied_at  timestamptz not null default now()
);

alter table public.sync_applied_mutations enable row level security;

drop policy if exists "sync_applied_mutations_all_own"
  on public.sync_applied_mutations;
create policy "sync_applied_mutations_all_own"
  on public.sync_applied_mutations for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create index if not exists sync_applied_mutations_owner_idx
  on public.sync_applied_mutations (owner_id, applied_at desc);

-- ---------------------------------------------------------------------------
-- atomic increment RPC
-- ---------------------------------------------------------------------------
create or replace function public.apply_increment(
  p_mutation_id uuid,
  p_entity      text,
  p_record_id   uuid,
  p_field       text,
  p_delta       numeric,
  p_seed        jsonb,
  p_created_at  timestamptz
)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_applied uuid;
  v_row     jsonb;
begin
  if p_delta is null or p_delta = 0 then
    raise exception 'apply_increment: delta must be a non-zero number';
  end if;

  -- Whitelist: only the three additive counter paths may use this RPC.
  if not (
    (p_entity = 'habit_logs' and p_field = 'value') or
    (p_entity = 'limit_logs' and p_field = 'minutes_used') or
    (p_entity = 'reading_logs' and p_field = 'pages')
  ) then
    raise exception 'apply_increment: unsupported entity/field %/%',
      p_entity, p_field;
  end if;

  -- Idempotency ledger: exactly one application per stable mutation identity.
  -- owner_id is forced to auth.uid() -- a mutation id can never be recorded
  -- as applied for another account.
  insert into public.sync_applied_mutations
    (mutation_id, owner_id, entity, record_id, field, delta)
  values
    (p_mutation_id, auth.uid(), p_entity, p_record_id, p_field, p_delta)
  on conflict (mutation_id) do nothing
  returning mutation_id into v_applied;

  if v_applied is null then
    -- Already applied (e.g. retry after a lost response): return the current
    -- row WITHOUT touching anything. Fall back to the natural key because a
    -- natural-key race may have adopted a different row id.
    if p_entity = 'habit_logs' then
      select to_jsonb(t) into v_row
        from public.habit_logs t where t.id = p_record_id;
      if v_row is null then
        select to_jsonb(t) into v_row
          from public.habit_logs t
         where t.habit_id = (p_seed->>'habit_id')::uuid
           and t.log_date = (p_seed->>'log_date')::date;
      end if;
    elsif p_entity = 'limit_logs' then
      select to_jsonb(t) into v_row
        from public.limit_logs t where t.id = p_record_id;
      if v_row is null then
        select to_jsonb(t) into v_row
          from public.limit_logs t
         where t.limit_id = (p_seed->>'limit_id')::uuid
           and t.log_date = (p_seed->>'log_date')::date;
      end if;
    else
      select to_jsonb(t) into v_row
        from public.reading_logs t where t.id = p_record_id;
    end if;
    return jsonb_build_object('applied', false, 'row', v_row);
  end if;

  -- Atomic insert-or-add. One statement: concurrent callers serialize on the
  -- unique arbiter / row lock, so no increment is lost and none is doubled.
  -- On conflict only the counter column is bumped; the other columns keep
  -- whatever the winning row already had.
  if p_entity = 'habit_logs' then
    insert into public.habit_logs
      (id, owner, habit_id, log_date, status, value, note, created_at)
    values
      (p_record_id, auth.uid(),
       (p_seed->>'habit_id')::uuid,
       (p_seed->>'log_date')::date,
       coalesce(p_seed->>'status', 'done'),
       p_delta,
       p_seed->>'note',
       coalesce(p_created_at, now()))
    on conflict (habit_id, log_date)
    do update set value = public.habit_logs.value + p_delta
    returning to_jsonb(habit_logs) into v_row;
  elsif p_entity = 'limit_logs' then
    insert into public.limit_logs
      (id, owner, limit_id, log_date, minutes_used, created_at)
    values
      (p_record_id, auth.uid(),
       (p_seed->>'limit_id')::uuid,
       (p_seed->>'log_date')::date,
       p_delta::int,
       coalesce(p_created_at, now()))
    on conflict (limit_id, log_date)
    do update set minutes_used = public.limit_logs.minutes_used + p_delta::int
    returning to_jsonb(limit_logs) into v_row;
  else
    -- reading_logs has no natural unique key: identity is the client UUID,
    -- so independent per-device rows each increment atomically and totals
    -- stay correct.
    insert into public.reading_logs
      (id, owner, book_id, log_date, pages, note, created_at)
    values
      (p_record_id, auth.uid(),
       (p_seed->>'book_id')::uuid,
       (p_seed->>'log_date')::date,
       p_delta::int,
       p_seed->>'note',
       coalesce(p_created_at, now()))
    on conflict (id)
    do update set pages = public.reading_logs.pages + p_delta::int
    returning to_jsonb(reading_logs) into v_row;
  end if;

  return jsonb_build_object('applied', true, 'row', v_row);
end;
$$;

-- The app calls this RPC with the authenticated user's JWT (anon key +
-- session). No service-role involvement.
grant execute on function
  public.apply_increment(uuid, text, uuid, text, numeric, jsonb, timestamptz)
  to authenticated;
