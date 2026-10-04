-- ============================================================================
-- winter-arc-muse · V2.2 — database historical-deletion safety
-- Final hardening pass before V3. No schema shape changes, no data changes.
--
-- Problem: the UI archives workouts/exercises/subjects/topics instead of
-- deleting them, but the underlying foreign keys are still ON DELETE
-- CASCADE — so a *direct* database DELETE of one of those parents would
-- silently destroy historical sessions/sets. V2.2 makes the database itself
-- reject such deletes.
--
-- Design decision (why a trigger guard, not plain RESTRICT):
--   Changing the inter-table FKs to RESTRICT would also break the existing
--   top-level account-deletion path: deleting the auth.users row cascades
--   through the owner -> auth.users ON DELETE CASCADE hierarchy, and a
--   RESTRICT in the middle of that chain makes the whole purge fail.
--   Instead, a BEFORE DELETE trigger rejects a direct delete while
--   historical children exist, but allows the delete when the owning
--   auth.users row is already gone in the same transaction — i.e. the
--   delete is part of an intentional whole-account purge, which keeps
--   working exactly as before through the existing cascade hierarchy.
--   The rejection uses errcode 23001 (restrict_violation), the same SQLSTATE
--   a RESTRICT constraint would raise.
--
-- Guarded tables and what counts as protected history:
--   workouts          -> any workout_exercises or workout_sessions rows
--   workout_exercises -> any workout_sets rows
--   subjects          -> any topics or study_sessions rows
--   topics            -> any study_sessions rows
--
-- Deleting a parent with no historical children still succeeds (nothing to
-- protect), and archiving is unaffected (it is an UPDATE, not a DELETE).
-- ============================================================================

create or replace function public.prevent_historical_data_loss()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_children integer := 0;
  v_owner_exists boolean;
begin
  if TG_TABLE_NAME = 'workouts' then
    select count(*) into v_children from (
      select 1 from public.workout_exercises where workout_id = OLD.id
      union all
      select 1 from public.workout_sessions  where workout_id = OLD.id
    ) s;
  elsif TG_TABLE_NAME = 'workout_exercises' then
    select count(*) into v_children
      from public.workout_sets where exercise_id = OLD.id;
  elsif TG_TABLE_NAME = 'subjects' then
    select count(*) into v_children from (
      select 1 from public.topics         where subject_id = OLD.id
      union all
      select 1 from public.study_sessions where subject_id = OLD.id
    ) s;
  elsif TG_TABLE_NAME = 'topics' then
    select count(*) into v_children
      from public.study_sessions where topic_id = OLD.id;
  else
    -- Not a guarded table; allow.
    return OLD;
  end if;

  if v_children > 0 then
    -- If the owning user row is already gone in this transaction, this
    -- delete is part of an intentional whole-account purge: allow the
    -- existing ON DELETE CASCADE hierarchy to remove the dataset.
    select exists(select 1 from auth.users where id = OLD.owner)
      into v_owner_exists;
    if v_owner_exists then
      raise exception
        'Cannot delete from "%": % historical record(s) still reference it. Archive it instead of deleting.',
        TG_TABLE_NAME, v_children
        using errcode = 'restrict_violation';
    end if;
  end if;

  return OLD;
end;
$$;

-- Attach the guard to the four historical parent tables (idempotent).
drop trigger if exists workouts_deletion_guard on public.workouts;
create trigger workouts_deletion_guard
  before delete on public.workouts
  for each row execute function public.prevent_historical_data_loss();

drop trigger if exists workout_exercises_deletion_guard on public.workout_exercises;
create trigger workout_exercises_deletion_guard
  before delete on public.workout_exercises
  for each row execute function public.prevent_historical_data_loss();

drop trigger if exists subjects_deletion_guard on public.subjects;
create trigger subjects_deletion_guard
  before delete on public.subjects
  for each row execute function public.prevent_historical_data_loss();

drop trigger if exists topics_deletion_guard on public.topics;
create trigger topics_deletion_guard
  before delete on public.topics
  for each row execute function public.prevent_historical_data_loss();

-- RLS policies are untouched: the guard is a data-protection rule, not an
-- access rule. Owner FKs (owner -> auth.users ON DELETE CASCADE) are
-- untouched: whole-account purge keeps working through them.
