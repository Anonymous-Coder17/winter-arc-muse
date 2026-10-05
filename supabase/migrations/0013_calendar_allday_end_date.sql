-- V4.5: calendar_events.end_date — inclusive last date for multi-day
-- all-day events.
--
-- The local calendar model was single-day (event_date only). First-class
-- all-day support needs multi-day spans (e.g. Oct 12 -> Oct 15), which the
-- existing schema cannot represent: hence this one additive, nullable
-- column. No existing column is touched; RLS is unchanged (the existing
-- calendar_events_all_own policy covers all columns).
--
-- Convention (documented, V4.5):
--   * end_date is the INCLUSIVE last date the event covers ("End date:
--     Oct 15" in the UI means the event is visible on Oct 15).
--   * NULL (or = event_date) means a single-day event.
--   * Only meaningful when is_all_day = true; timed events keep NULL.
--   * Pure calendar dates (YYYY-MM-DD) — never timestamps, never shifted
--     by timezone conversion. The Google sync boundary converts between
--     this inclusive local convention and Google's exclusive end.date.
-- ---------------------------------------------------------------------------

alter table public.calendar_events
  add column if not exists end_date date;

-- end_date, when set, must not precede the event's start date.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'calendar_events_end_date_valid'
  ) then
    alter table public.calendar_events
      add constraint calendar_events_end_date_valid
      check (end_date is null or end_date >= event_date);
  end if;
end $$;
