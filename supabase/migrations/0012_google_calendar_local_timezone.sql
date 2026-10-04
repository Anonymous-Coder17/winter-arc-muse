-- 0012_google_calendar_local_timezone.sql
--
-- V4.3.2.2: preserve the local interpretation timezone for timed synced
-- Google Calendar events.
--
-- A timed Google event is rendered locally as a bare wall-clock
-- (calendar_events.event_date / start_time / end_time) in the DISPLAY
-- timezone of the device that performed the import. Until now that display
-- zone was stored nowhere: the push path re-interpreted the wall-clock in
-- whatever zone the *current* sync call happened to use. A title-only edit
-- from a device in a different timezone therefore re-interpreted e.g. 18:30
-- (Asia/Kolkata) as 18:30 America/New_York and silently moved the event.
--
-- The mapping now records BOTH zones, kept strictly separate:
--   google_timezone : the GOOGLE event's own start timezone (sync metadata,
--     since 0011 — never the display zone).
--   local_timezone  : the IANA zone in which the local wall-clock
--     representation was interpreted when it was created (import or the
--     last Google-driven rewrite). The push path interprets the local
--     wall-clock in this zone — never blindly in the current device zone.
--
-- Legacy rows (written before this migration) have local_timezone NULL.
-- The push path falls back to the current sync-call zone for those rows,
-- which is exactly the pre-V4.3.2.2 behavior — documented, deterministic,
-- and never silently inventing a zone that cannot be recovered.
--
-- This migration does not modify any existing table, policy, trigger,
-- constraint, function, or index from 0001–0011. Additive only.

-- ---------------------------------------------------------------------------
-- google_event_mappings.local_timezone
-- ---------------------------------------------------------------------------
alter table public.google_event_mappings
  add column if not exists local_timezone text;

comment on column public.google_event_mappings.local_timezone is
  'IANA timezone in which the local wall-clock representation (event_date / start_time / end_time) was interpreted when created. Used by the sync push path to reconstruct the Google event; never the Google event''s own timezone (see google_timezone). NULL for rows written before V4.3.2.2 — the push path falls back to the current sync zone for those.';
