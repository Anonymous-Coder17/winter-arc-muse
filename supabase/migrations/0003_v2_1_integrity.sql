-- ============================================================================
-- winter-arc-muse · V2.1 — data integrity & historical safety
-- Incremental hardening of the V2 schema. No data is destroyed.
--
-- 1. Relationship integrity (declarative composite foreign keys):
--    - a workout_set's exercise must belong to the same workout as its
--      session  (workout_sets.workout_id is backfilled from the session)
--    - a study_session's topic must belong to its subject
-- 2. Historical safety:
--    - workout_exercises gains is_active so exercises can be archived
--      instead of destructively deleted (deleting an exercise used to
--      cascade-delete its recorded sets).
-- Existing rows are preserved; constraints fail loudly if old data ever
-- violates them instead of silently dropping anything.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1a. workout_exercises.is_active — archive exercises, don't delete them.
-- ---------------------------------------------------------------------------
alter table public.workout_exercises
  add column if not exists is_active boolean not null default true;

create index if not exists workout_exercises_workout_active_idx
  on public.workout_exercises (workout_id, is_active, sort_order);

-- ---------------------------------------------------------------------------
-- 1b. Composite uniqueness on the parent pairs, so composite foreign keys
--     can reference them. (id is already the PK; the pair is needed for
--     the composite FK syntax.)
-- ---------------------------------------------------------------------------
create unique index if not exists workout_sessions_id_workout_uidx
  on public.workout_sessions (id, workout_id);

create unique index if not exists workout_exercises_id_workout_uidx
  on public.workout_exercises (id, workout_id);

create unique index if not exists topics_id_subject_uidx
  on public.topics (id, subject_id);

-- ---------------------------------------------------------------------------
-- 1c. workout_sets.workout_id — the guard column.
--     Backfilled from the session, then NOT NULL, then two composite FKs:
--       (session_id,  workout_id) -> workout_sessions(id, workout_id)
--       (exercise_id, workout_id) -> workout_exercises(id, workout_id)
--     Together they make it impossible for a set to mix an exercise from
--     workout B into a session of workout A — for the same user or any
--     user. The pre-existing simple FKs are kept (harmless, same cascades).
-- ---------------------------------------------------------------------------
alter table public.workout_sets
  add column if not exists workout_id uuid;

-- Backfill from the session's workout. On a healthy database every row
-- resolves; if any row cannot, the migration stops here loudly.
update public.workout_sets s
  set workout_id = ws.workout_id
  from public.workout_sessions ws
  where ws.id = s.session_id
    and s.workout_id is null;

alter table public.workout_sets
  alter column workout_id set not null;

alter table public.workout_sets
  add constraint workout_sets_session_workout_fkey
  foreign key (session_id, workout_id)
  references public.workout_sessions (id, workout_id)
  on delete cascade;

alter table public.workout_sets
  add constraint workout_sets_exercise_workout_fkey
  foreign key (exercise_id, workout_id)
  references public.workout_exercises (id, workout_id)
  on delete cascade;

create index if not exists workout_sets_workout_idx
  on public.workout_sets (workout_id, session_id);

-- ---------------------------------------------------------------------------
-- 1d. study_sessions: the topic must belong to the session's subject.
--     (topic_id, subject_id) -> topics(id, subject_id).
--     topic_id NULL (no topic) is untouched — NULL FK columns are not
--     checked, which is exactly the "optional topic" semantics.
-- ---------------------------------------------------------------------------
alter table public.study_sessions
  add constraint study_sessions_topic_subject_fkey
  foreign key (topic_id, subject_id)
  references public.topics (id, subject_id)
  on delete set null;

-- ---------------------------------------------------------------------------
-- 2. RLS policies are unchanged in meaning: owner-only on every table.
--    The with-check guards on workout_sets / study_sessions already verify
--    the referenced session/exercise/subject/topic belong to auth.uid();
--    the composite FKs above add the cross-table consistency guarantee.
--    No policy is weakened by this migration.
-- ---------------------------------------------------------------------------
