-- ============================================================================
-- winter-arc-muse · V1 schema
-- Normalized, extensible tables for the 30-Day Transformation app.
-- Every user-owned table: owner uuid FK -> auth.users(id), created_at,
-- updated_at, and Row Level Security so a user can only read/write their
-- own rows. Nothing here tracks the five daily prayers (see constraints).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- helper: stamp updated_at on row modification
-- ---------------------------------------------------------------------------
create or replace function public.handle_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles
-- One row per authenticated user. Created on signup (or lazily on first
-- login) by the application layer.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.profiles enable row level security;

create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);
create policy "profiles_insert_own"
  on public.profiles for insert
  with check (auth.uid() = id);
create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id);

create trigger profiles_updated_at
  before update on public.profiles
  for each row execute function public.handle_updated_at();

-- ---------------------------------------------------------------------------
-- challenges
-- A 30-day challenge. V1 revolves around ONE active challenge at a time
-- (is_active flag); the schema permits future history without dead ends.
-- Incidents/relapses are recorded elsewhere and NEVER reset this row.
-- ---------------------------------------------------------------------------
create table if not exists public.challenges (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null references auth.users(id) on delete cascade,
  title       text not null default '30-Day Transformation',
  subtitle    text,
  start_date  date not null,
  duration_days int not null default 30 check (duration_days > 0),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.challenges enable row level security;

create policy "challenges_all_own"
  on public.challenges for all
  using (auth.uid() = owner)
  with check (auth.uid() = owner);

create trigger challenges_updated_at
  before update on public.challenges
  for each row execute function public.handle_updated_at();

create index if not exists challenges_owner_idx
  on public.challenges (owner, is_active);

-- ---------------------------------------------------------------------------
-- habits
-- Customizable habits. `tracking` is the tracking model and is extensible:
--   'completion'  -> done / not done (V1)
--   'count'       -> numeric amount (future: Hifz ayahs, pages read)
--   'duration'    -> minutes (future: study, meditation timer)
-- `frequency` is kept simple in V1: 'daily' or 'weekly' with weekly_target.
-- `sort_order` preserves user ordering.
-- ---------------------------------------------------------------------------
create table if not exists public.habits (
  id            uuid primary key default gen_random_uuid(),
  owner         uuid not null references auth.users(id) on delete cascade,
  name          text not null,
  description   text,
  tracking      text not null default 'completion'
                check (tracking in ('completion', 'count', 'duration')),
  frequency     text not null default 'daily'
                check (frequency in ('daily', 'weekly')),
  weekly_target int,
  preferred_time time,
  sort_order    int not null default 0,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table public.habits enable row level security;

create policy "habits_all_own"
  on public.habits for all
  using (auth.uid() = owner)
  with check (auth.uid() = owner);

create trigger habits_updated_at
  before update on public.habits
  for each row execute function public.handle_updated_at();

create index if not exists habits_owner_idx
  on public.habits (owner, is_active, sort_order);

-- ---------------------------------------------------------------------------
-- habit_logs
-- One row per habit per day. `status` records what ACTUALLY happened
-- ('done' | 'not_done'); `value` carries the extensible tracking payload
-- (numeric amount or minutes) when tracking != 'completion'. Absence of a
-- row means "not recorded" — never conflated with 'not_done'.
-- ---------------------------------------------------------------------------
create table if not exists public.habit_logs (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null references auth.users(id) on delete cascade,
  habit_id    uuid not null references public.habits(id) on delete cascade,
  log_date    date not null,
  status      text not null default 'done'
              check (status in ('done', 'not_done')),
  value       numeric,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (habit_id, log_date)
);
alter table public.habit_logs enable row level security;

create policy "habit_logs_all_own"
  on public.habit_logs for all
  using (auth.uid() = owner)
  with check (auth.uid() = owner);

create trigger habit_logs_updated_at
  before update on public.habit_logs
  for each row execute function public.handle_updated_at();

create index if not exists habit_logs_owner_date_idx
  on public.habit_logs (owner, log_date);

-- ---------------------------------------------------------------------------
-- abstinence_rules  (Category A — abstain completely)
-- Behaviors the user intends to completely abstain from.
-- Incidents are logged against these rules; they are recorded data and
-- must never reset the challenge. Kept fully separate from usage_limits.
-- ---------------------------------------------------------------------------
create table if not exists public.abstinence_rules (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  notes       text,
  start_date  date not null default current_date,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.abstinence_rules enable row level security;

create policy "abstinence_rules_all_own"
  on public.abstinence_rules for all
  using (auth.uid() = owner)
  with check (auth.uid() = owner);

create trigger abstinence_rules_updated_at
  before update on public.abstinence_rules
  for each row execute function public.handle_updated_at();

create index if not exists abstinence_rules_owner_idx
  on public.abstinence_rules (owner, is_active);

-- ---------------------------------------------------------------------------
-- abstinence_incidents
-- A recorded incident against an abstinence rule. Data only — it carries no
-- reset/punishment semantics at the schema level.
-- ---------------------------------------------------------------------------
create table if not exists public.abstinence_incidents (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null references auth.users(id) on delete cascade,
  rule_id     uuid not null references public.abstinence_rules(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  trigger     text,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.abstinence_incidents enable row level security;

create policy "abstinence_incidents_all_own"
  on public.abstinence_incidents for all
  using (auth.uid() = owner)
  with check (auth.uid() = owner);

create trigger abstinence_incidents_updated_at
  before update on public.abstinence_incidents
  for each row execute function public.handle_updated_at();

create index if not exists abstinence_incidents_owner_time_idx
  on public.abstinence_incidents (owner, occurred_at desc);

-- ---------------------------------------------------------------------------
-- usage_limits  (Category B — allowed but limited)
-- Daily minute caps for permitted-but-limited behaviors (e.g. YouTube,
-- WhatsApp). Deliberately separate tables/model from abstinence.
-- ---------------------------------------------------------------------------
create table if not exists public.usage_limits (
  id             uuid primary key default gen_random_uuid(),
  owner          uuid not null references auth.users(id) on delete cascade,
  name           text not null,
  daily_limit_min int not null check (daily_limit_min > 0),
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
alter table public.usage_limits enable row level security;

create policy "usage_limits_all_own"
  on public.usage_limits for all
  using (auth.uid() = owner)
  with check (auth.uid() = owner);

create trigger usage_limits_updated_at
  before update on public.usage_limits
  for each row execute function public.handle_updated_at();

create index if not exists usage_limits_owner_idx
  on public.usage_limits (owner, is_active);

-- ---------------------------------------------------------------------------
-- limit_logs
-- One row per limit per day; minutes_used accumulates. Remaining and
-- over-limit are DERIVED in the app (limit - used), never stored, so the
-- source of truth stays a single number.
-- ---------------------------------------------------------------------------
create table if not exists public.limit_logs (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null references auth.users(id) on delete cascade,
  limit_id    uuid not null references public.usage_limits(id) on delete cascade,
  log_date    date not null,
  minutes_used int not null default 0 check (minutes_used >= 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (limit_id, log_date)
);
alter table public.limit_logs enable row level security;

create policy "limit_logs_all_own"
  on public.limit_logs for all
  using (auth.uid() = owner)
  with check (auth.uid() = owner);

create trigger limit_logs_updated_at
  before update on public.limit_logs
  for each row execute function public.handle_updated_at();

create index if not exists limit_logs_owner_date_idx
  on public.limit_logs (owner, log_date);

-- ---------------------------------------------------------------------------
-- tasks
-- Persistent tasks. `state` distinguishes PLANNED from ACTUAL:
--   'planned'   -> scheduled/intended, not yet done
--   'done'      -> actually completed
--   'not_done'  -> day passed without completion (recorded reality)
-- `kind` tags the domain so Training/Study pages can surface their own
-- items without fake data: 'general' | 'workout' | 'study' | 'hifz' |
-- 'reading' | 'journal'.
-- ---------------------------------------------------------------------------
create table if not exists public.tasks (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null references auth.users(id) on delete cascade,
  title       text not null,
  task_date   date not null,
  start_time  time,
  end_time    time,
  kind        text not null default 'general'
              check (kind in ('general','workout','study','hifz','reading','journal')),
  state       text not null default 'planned'
              check (state in ('planned','done','not_done')),
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.tasks enable row level security;

create policy "tasks_all_own"
  on public.tasks for all
  using (auth.uid() = owner)
  with check (auth.uid() = owner);

create trigger tasks_updated_at
  before update on public.tasks
  for each row execute function public.handle_updated_at();

create index if not exists tasks_owner_date_idx
  on public.tasks (owner, task_date, start_time);

-- ---------------------------------------------------------------------------
-- calendar_events
-- Time-boxed events on the calendar. Events describe what is PLANNED at a
-- time; completion/state lives on tasks. Kept separate from tasks so the
-- calendar can render both without conflating them.
-- ---------------------------------------------------------------------------
create table if not exists public.calendar_events (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null references auth.users(id) on delete cascade,
  title       text not null,
  event_date  date not null,
  start_time  time not null,
  end_time    time not null,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (start_time < end_time)
);
alter table public.calendar_events enable row level security;

create policy "calendar_events_all_own"
  on public.calendar_events for all
  using (auth.uid() = owner)
  with check (auth.uid() = owner);

create trigger calendar_events_updated_at
  before update on public.calendar_events
  for each row execute function public.handle_updated_at();

create index if not exists calendar_events_owner_date_idx
  on public.calendar_events (owner, event_date, start_time);

-- ---------------------------------------------------------------------------
-- daily_records
-- Free-form daily capture that genuinely helps V1: journal entries, study
-- session notes, workout notes. `kind` is extensible for V2–V5
-- ('journal' | 'study_session' | 'workout_session' | 'note' | 'review').
-- The five daily prayers must never be recorded here (application rule).
-- ---------------------------------------------------------------------------
create table if not exists public.daily_records (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null references auth.users(id) on delete cascade,
  record_date date not null,
  kind        text not null default 'note'
              check (kind in ('note','journal','study_session','workout_session','review')),
  title       text,
  body        text,
  minutes     int check (minutes is null or minutes >= 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.daily_records enable row level security;

create policy "daily_records_all_own"
  on public.daily_records for all
  using (auth.uid() = owner)
  with check (auth.uid() = owner);

create trigger daily_records_updated_at
  before update on public.daily_records
  for each row execute function public.handle_updated_at();

create index if not exists daily_records_owner_date_idx
  on public.daily_records (owner, record_date, created_at);

-- ---------------------------------------------------------------------------
-- uniqueness guards (safe to re-run)
-- Lazy seeding (lib/seed.ts) and quick-create paths (quickLogCount) run a
-- check-then-insert; without these, a two-tab/double-submit race could
-- duplicate default rows. Names are unique per owner, case-insensitively.
-- ---------------------------------------------------------------------------
create unique index if not exists habits_owner_name_uidx
  on public.habits (owner, lower(name));
create unique index if not exists abstinence_rules_owner_name_uidx
  on public.abstinence_rules (owner, lower(name));
create unique index if not exists usage_limits_owner_name_uidx
  on public.usage_limits (owner, lower(name));

-- ---------------------------------------------------------------------------
-- seed defaults (application-layer convenience; safe to re-run)
-- Inserts the V1 default seed rows for a user id passed by the app.
-- The app calls this via RPC-like inserts only when the user has no data.
-- NOTE: keep the seed free of any five-daily-prayer items. Tahajjud is
-- seeded as an OPTIONAL weekly habit (2x/week), editable/removable.
-- ---------------------------------------------------------------------------
