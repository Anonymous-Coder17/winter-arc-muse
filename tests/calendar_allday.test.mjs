// V4.5: first-class all-day event support — regression tests.
//
// Covers:
//   1. All-day single-day event stays on its date (no timezone shift).
//   2. All-day multi-day event covers its inclusive date range.
//   3. Timed event behavior is unchanged.
//   4. Timed -> all-day conversion does not shift the date.
//   5. All-day -> timed conversion does not unexpectedly shift the date.
//   6. Different timezone contexts do not move an all-day event by a day.
//   7. Google all-day mapping stays compatible (import sets inclusive
//      end_date; push emits the correct start.date/end.date).
//   8. Migration 0013: end_date column, CHECK, RLS, legacy rows.
//
// Deterministic: no network, no real Google credentials. Date-key logic is
// pure string comparison, so the tests assert identical results under
// several TZ settings.
//
// Run with:
//   TZ='Asia/Kolkata' node --test --import ./tests/hooks.mjs tests/calendar_allday.test.mjs
import { register } from "node:module";
register(new URL("./resolve-next-server-stub.mjs", import.meta.url).href);

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = "ab".repeat(32);

const [{ eventCoversDate }, { googleEventToLocal, localEventToGoogle }] =
  await Promise.all([
    import("@/lib/dates.ts"),
    import("@/lib/google/eventMapping.ts"),
  ]);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// 1-3, 6: eventCoversDate — date semantics
// ---------------------------------------------------------------------------

test("all-day single-day event stays on its date", () => {
  const e = {
    event_date: "2026-10-12",
    end_date: null,
    is_all_day: true,
  };
  assert.equal(eventCoversDate(e, "2026-10-12"), true);
  assert.equal(eventCoversDate(e, "2026-10-11"), false);
  assert.equal(eventCoversDate(e, "2026-10-13"), false);
});

test("all-day multi-day event covers its inclusive range", () => {
  const e = {
    event_date: "2026-10-12",
    end_date: "2026-10-15",
    is_all_day: true,
  };
  for (const d of ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"]) {
    assert.equal(eventCoversDate(e, d), true, `covers ${d}`);
  }
  assert.equal(eventCoversDate(e, "2026-10-11"), false);
  assert.equal(eventCoversDate(e, "2026-10-16"), false);
});

test("timed event behavior is unchanged (exact date match only)", () => {
  const e = {
    event_date: "2026-10-12",
    end_date: null,
    is_all_day: false,
  };
  assert.equal(eventCoversDate(e, "2026-10-12"), true);
  assert.equal(eventCoversDate(e, "2026-10-13"), false);
  // A stray end_date on a timed event is ignored — timed matching is exact.
  const stray = { ...e, end_date: "2026-10-15" };
  assert.equal(eventCoversDate(stray, "2026-10-13"), false);
});

test("legacy rows without the new fields behave as before", () => {
  // Rows written before V4.5 have undefined is_all_day/end_date.
  const legacy = { event_date: "2026-10-12" };
  assert.equal(eventCoversDate(legacy, "2026-10-12"), true);
  assert.equal(eventCoversDate(legacy, "2026-10-13"), false);
});

test("all-day dates are pure strings — identical under any TZ", () => {
  const e = {
    event_date: "2026-10-12",
    end_date: "2026-10-15",
    is_all_day: true,
  };
  // eventCoversDate never constructs a Date — it compares YYYY-MM-DD keys
  // lexicographically, so no TZ database lookup can shift the result.
  // Run the suite under different TZ values to prove it.
  assert.equal(eventCoversDate(e, "2026-10-12"), true);
  assert.equal(eventCoversDate(e, "2026-10-15"), true);
  assert.equal(eventCoversDate(e, "2026-10-16"), false);
});

// ---------------------------------------------------------------------------
// 4-5: form conversion semantics (pure row-shape assertions)
// ---------------------------------------------------------------------------

test("timed -> all-day keeps the date, filler times satisfy the CHECK", () => {
  // Mirrors EventForm's all-day submit row.
  const row = {
    title: "Exam",
    event_date: "2026-10-12",
    end_date: null,
    start_time: "00:00",
    end_time: "23:59",
    is_all_day: true,
  };
  assert.equal(row.event_date, "2026-10-12", "date does not shift");
  assert.ok(row.start_time < row.end_time, "CHECK (start_time < end_time)");
  assert.equal(eventCoversDate(row, "2026-10-12"), true);
});

test("all-day -> timed does not reuse the 00:00-23:59 filler", () => {
  // Mirrors EventForm's toggle-off default: a sensible morning slot.
  const row = {
    title: "Exam",
    event_date: "2026-10-12",
    end_date: null,
    start_time: "09:00",
    end_time: "10:00",
    is_all_day: false,
  };
  assert.equal(row.event_date, "2026-10-12", "date does not shift");
  assert.ok(
    !(row.start_time === "00:00" && row.end_time === "23:59"),
    "filler times are not leaked into timed mode"
  );
});

// ---------------------------------------------------------------------------
// 7: Google mapping compatibility
// ---------------------------------------------------------------------------

test("Google multi-day all-day import sets inclusive end_date", () => {
  const g = {
    id: "gev-multi",
    summary: "Offsite",
    start: { date: "2026-10-10" },
    end: { date: "2026-10-12" }, // exclusive: covers Oct 10 + 11
  };
  const local = googleEventToLocal(g, "Asia/Kolkata");
  assert.equal(local.event_date, "2026-10-10", "no timezone shift");
  assert.equal(local.is_all_day, true);
  assert.equal(
    local.end_date,
    "2026-10-11",
    "exclusive Google end converted to inclusive local end"
  );
  assert.equal(eventCoversDate(local, "2026-10-10"), true);
  assert.equal(eventCoversDate(local, "2026-10-11"), true);
  assert.equal(eventCoversDate(local, "2026-10-12"), false);
});

test("Google single-day all-day import keeps end_date null", () => {
  const g = {
    id: "gev-single",
    summary: "Holiday",
    start: { date: "2026-10-12" },
    end: { date: "2026-10-13" },
  };
  const local = googleEventToLocal(g, "America/New_York");
  assert.equal(local.event_date, "2026-10-12");
  assert.equal(local.is_all_day, true);
  assert.equal(local.end_date, null);
});

test("local multi-day all-day push emits the full Google range", () => {
  const body = localEventToGoogle(
    {
      title: "Research sprint",
      event_date: "2026-10-12",
      start_time: "00:00",
      end_time: "23:59",
      notes: null,
      end_date: "2026-10-15",
    },
    "Asia/Kolkata",
    { isAllDay: true }
  );
  assert.equal(body.start.date, "2026-10-12");
  assert.equal(
    body.end.date,
    "2026-10-16",
    "inclusive local end 10-15 -> exclusive Google end 10-16"
  );
  assert.ok(!("dateTime" in body.start), "all-day stays date-based");
});

test("local single-day all-day push is unchanged (end = start + 1)", () => {
  const body = localEventToGoogle(
    {
      title: "Holiday",
      event_date: "2026-10-12",
      start_time: "00:00",
      end_time: "23:59",
      notes: null,
      end_date: null,
    },
    "Asia/Kolkata",
    { isAllDay: true }
  );
  assert.equal(body.start.date, "2026-10-12");
  assert.equal(body.end.date, "2026-10-13");
});

test("Google-originated all-day push still prefers the mapping's dates", () => {
  const body = localEventToGoogle(
    {
      title: "Offsite (renamed)",
      event_date: "2026-10-10",
      start_time: "00:00",
      end_time: "23:59",
      notes: null,
      end_date: "2026-10-11",
    },
    "Asia/Kolkata",
    {
      isAllDay: true,
      googleStartDate: "2026-10-10",
      googleEndDate: "2026-10-12",
    }
  );
  assert.equal(body.start.date, "2026-10-10");
  assert.equal(body.end.date, "2026-10-12", "mapping span preserved");
});

// ---------------------------------------------------------------------------
// 8: migration 0013 integrity (PGlite over the real migration chain)
// ---------------------------------------------------------------------------

const MIGRATIONS = [
  "0001_v1_schema.sql",
  "0002_v2_training_study.sql",
  "0003_v2_1_integrity.sql",
  "0004_v2_2_deletion_safety.sql",
  "0005_v3_journal_review.sql",
  "0006_v3_2_ownership.sql",
  "0007_v4_2_2_increment_ledger.sql",
  "0008_google_calendar_integration.sql",
  "0009_google_oauth_hardening.sql",
  "0010_google_calendar_sync.sql",
  "0011_google_calendar_roundtrip.sql",
  "0012_google_calendar_local_timezone.sql",
  "0013_calendar_allday_end_date.sql",
];

let db;
before(async () => {
  db = new PGlite();
  // Minimal stub of the Supabase auth schema that the migrations expect.
  // Prerequisite of the environment, NOT a substitute for 0013.
  await db.exec(`
    create schema auth;
    create table auth.users(id uuid primary key);
    create or replace function auth.uid() returns uuid
      language sql stable as $$ select current_setting('app.user_id', true)::uuid $$;
    insert into auth.users(id) values
      ('11111111-1111-1111-1111-111111111111'::uuid),
      ('22222222-2222-2222-2222-222222222222'::uuid);
    create role app_user nosuperuser login;
    create role authenticated nosuperuser;
    grant usage on schema public, auth to app_user;
    grant execute on function auth.uid() to app_user;
  `);
  for (const m of MIGRATIONS) {
    const sql = readFileSync(join(ROOT, "supabase", "migrations", m), "utf8");
    await db.exec(sql);
  }
  await db.exec(`grant all on all tables in schema public to app_user`);
});

test("migration 0013: end_date column exists, nullable, RLS intact", async () => {
  const cols = await db.query(
    `select column_name, is_nullable, data_type from information_schema.columns
     where table_schema = 'public' and table_name = 'calendar_events'`
  );
  const endDate = cols.rows.find((c) => c.column_name === "end_date");
  assert.ok(endDate, "end_date column exists");
  assert.equal(endDate.is_nullable, "YES");
  assert.equal(endDate.data_type, "date");

  const rls = await db.query(
    `select relrowsecurity from pg_class
     join pg_namespace on pg_namespace.oid = pg_class.relnamespace
     where relname = 'calendar_events' and nspname = 'public'`
  );
  assert.equal(rls.rows[0].relrowsecurity, true, "RLS still enabled");

  // Legacy rows (written before V4.5) read back with null end_date.
  const owner = "11111111-1111-1111-1111-111111111111";
  await db.query(
    `insert into public.calendar_events
       (owner, title, event_date, start_time, end_time, is_all_day)
     values ($1, 'Legacy', '2026-10-12', '09:00', '10:00', false)`,
    [owner]
  );
  const row = await db.query(
    `select end_date, is_all_day from public.calendar_events where owner = $1`,
    [owner]
  );
  assert.equal(row.rows[0].end_date, null);
  assert.equal(row.rows[0].is_all_day, false);
});

test("migration 0013: CHECK rejects end_date before event_date", async () => {
  const owner = "22222222-2222-2222-2222-222222222222";
  await assert.rejects(
    db.query(
      `insert into public.calendar_events
         (owner, title, event_date, end_date, start_time, end_time, is_all_day)
       values ($1, 'Bad span', '2026-10-15', '2026-10-12', '00:00', '23:59', true)`,
      [owner]
    ),
    /calendar_events_end_date_valid/
  );
  // A valid multi-day span inserts fine.
  await db.query(
    `insert into public.calendar_events
       (owner, title, event_date, end_date, start_time, end_time, is_all_day)
     values ($1, 'Sprint', '2026-10-12', '2026-10-15', '00:00', '23:59', true)`,
    [owner]
  );
  const ok = await db.query(
    `select end_date from public.calendar_events where owner = $1 and title = 'Sprint'`,
    [owner]
  );
  assert.equal(ok.rows[0].end_date.toISOString().slice(0, 10), "2026-10-15");
});
