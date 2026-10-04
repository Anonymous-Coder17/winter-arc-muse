-- ============================================================================
-- winter-arc-muse · V2 schema — Training + Study
-- Extends the V1 schema with structured training and study systems.
--   Workout → Exercise → Session → Sets
--   Subject → Topic → Study Session
-- Every user-owned table: owner uuid FK -> auth.users(id), created_at,
-- updated_at, Row Level Security (auth.uid() = owner), plus DB-level guards
-- so child rows cannot reference another user's parent rows.
-- Nothing here tracks the five daily prayers or gamifies anything.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- workouts
-- A workout definition. Two fundamentally different types:
--   'structured' -> exercises with sets/reps or time (e.g. HSPU)
--   'completion' -> done/not-done only (e.g. 20-min Abs video)
-- ---------------------------------------------------------------------------
create table if not exists public.workouts (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  type        text not null default 'structured'
              check (type in ('structured', 'completion')),
  description text,
  video_ref   text,
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.workouts enable row level security;

create policy "workouts_all_own"
  on public.workouts for all
  using (auth.uid() = owner)
  with check (auth.uid() = owner);

create trigger workouts_updated_at
  before update on public.workouts
  for each row execute function public.handle_updated_at();

create index if not exists workouts_owner_idx
  on public.workouts (owner, is_active, sort_order);
create unique index if not exists workouts_owner_name_uidx
  on public.workouts (owner, lower(name));

-- ---------------------------------------------------------------------------
-- workout_exercises
-- Exercises belonging to a structured workout. exercise_type decides what a
-- set records: 'reps' (Wall HSPU 5/5/4) or 'time' (Handstand Hold 18s).
-- ---------------------------------------------------------------------------
create table if not exists public.workout_exercises (
  id            uuid primary key default gen_random_uuid(),
  owner         uuid not null references auth.users(id) on delete cascade,
  workout_id    uuid not null references public.workouts(id) on delete cascade,
  name          text not null,
  exercise_type text not null default 'reps'
                check (exercise_type in ('reps', 'time')),
  sort_order    int not null default 0,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table public.workout_exercises enable row level security;

-- Owner-only, and the referenced workout must belong to the same user.
create policy "workout_exercises_all_own"
  on public.workout_exercises for all
  using (auth.uid() = owner)
  with check (
    auth.uid() = owner
    and exists (
      select 1 from public.workouts w
      where w.id = workout_id and w.owner = auth.uid()
    )
  );

create trigger workout_exercises_updated_at
  before update on public.workout_exercises
  for each row execute function public.handle_updated_at();

create index if not exists workout_exercises_workout_idx
  on public.workout_exercises (workout_id, sort_order);
create unique index if not exists workout_exercises_workout_name_uidx
  on public.workout_exercises (workout_id, lower(name));

-- ---------------------------------------------------------------------------
-- workout_sessions
-- One row per performed (or in-progress) workout. `status` is the actual
-- state: 'in_progress' | 'completed' | 'cancelled'. Planned-vs-actual stays
-- separate: the weekly training_schedule holds the plan; this table holds
-- what actually happened.
-- ---------------------------------------------------------------------------
create table if not exists public.workout_sessions (
  id           uuid primary key default gen_random_uuid(),
  owner        uuid not null references auth.users(id) on delete cascade,
  workout_id   uuid not null references public.workouts(id) on delete cascade,
  session_date date not null,
  started_at   timestamptz not null default now(),
  completed_at timestamptz,
  status       text not null default 'in_progress'
               check (status in ('in_progress', 'completed', 'cancelled')),
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (completed_at is null or completed_at >= started_at)
);
alter table public.workout_sessions enable row level security;

create policy "workout_sessions_all_own"
  on public.workout_sessions for all
  using (auth.uid() = owner)
  with check (
    auth.uid() = owner
    and exists (
      select 1 from public.workouts w
      where w.id = workout_id and w.owner = auth.uid()
    )
  );

create trigger workout_sessions_updated_at
  before update on public.workout_sessions
  for each row execute function public.handle_updated_at();

create index if not exists workout_sessions_owner_date_idx
  on public.workout_sessions (owner, session_date desc);
create index if not exists workout_sessions_workout_idx
  on public.workout_sessions (workout_id, session_date desc);

-- ---------------------------------------------------------------------------
-- workout_sets
-- Individual sets inside a session. A set records reps OR duration_seconds
-- depending on the exercise type; the other stays null.
-- ---------------------------------------------------------------------------
create table if not exists public.workout_sets (
  id               uuid primary key default gen_random_uuid(),
  owner            uuid not null references auth.users(id) on delete cascade,
  session_id       uuid not null references public.workout_sessions(id) on delete cascade,
  exercise_id      uuid not null references public.workout_exercises(id) on delete cascade,
  set_number       int not null check (set_number > 0),
  reps             int check (reps is null or reps >= 0),
  duration_seconds int check (duration_seconds is null or duration_seconds >= 0),
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (session_id, exercise_id, set_number)
);
alter table public.workout_sets enable row level security;

create policy "workout_sets_all_own"
  on public.workout_sets for all
  using (auth.uid() = owner)
  with check (
    auth.uid() = owner
    and exists (
      select 1 from public.workout_sessions s
      where s.id = session_id and s.owner = auth.uid()
    )
    and exists (
      select 1 from public.workout_exercises e
      where e.id = exercise_id and e.owner = auth.uid()
    )
  );

create trigger workout_sets_updated_at
  before update on public.workout_sets
  for each row execute function public.handle_updated_at();

create index if not exists workout_sets_session_idx
  on public.workout_sets (session_id, exercise_id, set_number);

-- ---------------------------------------------------------------------------
-- training_schedule
-- The weekly plan, data-driven (not hard-coded): one row per weekday per
-- user. weekday: 0 = Monday … 6 = Sunday. workout_id NULL means REST —
-- a first-class rest day, never a failed workout.
-- ---------------------------------------------------------------------------
create table if not exists public.training_schedule (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null references auth.users(id) on delete cascade,
  weekday    int not null check (weekday >= 0 and weekday <= 6),
  workout_id uuid references public.workouts(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner, weekday)
);
alter table public.training_schedule enable row level security;

create policy "training_schedule_all_own"
  on public.training_schedule for all
  using (auth.uid() = owner)
  with check (
    auth.uid() = owner
    and (workout_id is null or exists (
      select 1 from public.workouts w
      where w.id = workout_id and w.owner = auth.uid()
    ))
  );

create trigger training_schedule_updated_at
  before update on public.training_schedule
  for each row execute function public.handle_updated_at();

create index if not exists training_schedule_owner_idx
  on public.training_schedule (owner, weekday);

-- ---------------------------------------------------------------------------
-- subjects
-- Study subjects, fully user-defined (never hard-coded).
-- ---------------------------------------------------------------------------
create table if not exists public.subjects (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  description text,
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.subjects enable row level security;

create policy "subjects_all_own"
  on public.subjects for all
  using (auth.uid() = owner)
  with check (auth.uid() = owner);

create trigger subjects_updated_at
  before update on public.subjects
  for each row execute function public.handle_updated_at();

create index if not exists subjects_owner_idx
  on public.subjects (owner, is_active, sort_order);
create unique index if not exists subjects_owner_name_uidx
  on public.subjects (owner, lower(name));

-- ---------------------------------------------------------------------------
-- topics
-- Topics belong to exactly one subject.
-- ---------------------------------------------------------------------------
create table if not exists public.topics (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null references auth.users(id) on delete cascade,
  subject_id  uuid not null references public.subjects(id) on delete cascade,
  name        text not null,
  description text,
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.topics enable row level security;

create policy "topics_all_own"
  on public.topics for all
  using (auth.uid() = owner)
  with check (
    auth.uid() = owner
    and exists (
      select 1 from public.subjects s
      where s.id = subject_id and s.owner = auth.uid()
    )
  );

create trigger topics_updated_at
  before update on public.topics
  for each row execute function public.handle_updated_at();

create index if not exists topics_subject_idx
  on public.topics (subject_id, sort_order);
create unique index if not exists topics_subject_name_uidx
  on public.topics (subject_id, lower(name));

-- ---------------------------------------------------------------------------
-- study_sessions
-- A completed (or in-progress) study block. started_at/completed_at are the
-- source of truth; duration_seconds is stored from them at finish time so
-- history never depends on a frontend timer. Planned blocks live on as
-- tasks (kind='study'); this table holds what actually happened.
-- ---------------------------------------------------------------------------
create table if not exists public.study_sessions (
  id               uuid primary key default gen_random_uuid(),
  owner            uuid not null references auth.users(id) on delete cascade,
  subject_id       uuid not null references public.subjects(id) on delete cascade,
  topic_id         uuid references public.topics(id) on delete set null,
  session_date     date not null,
  started_at       timestamptz not null,
  completed_at     timestamptz,
  duration_seconds int not null default 0 check (duration_seconds >= 0),
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (completed_at is null or completed_at >= started_at)
);
alter table public.study_sessions enable row level security;

create policy "study_sessions_all_own"
  on public.study_sessions for all
  using (auth.uid() = owner)
  with check (
    auth.uid() = owner
    and exists (
      select 1 from public.subjects s
      where s.id = subject_id and s.owner = auth.uid()
    )
    and (topic_id is null or exists (
      select 1 from public.topics t
      where t.id = topic_id and t.owner = auth.uid()
    ))
  );

create trigger study_sessions_updated_at
  before update on public.study_sessions
  for each row execute function public.handle_updated_at();

create index if not exists study_sessions_owner_date_idx
  on public.study_sessions (owner, session_date desc);
create index if not exists study_sessions_subject_idx
  on public.study_sessions (subject_id, session_date desc);
