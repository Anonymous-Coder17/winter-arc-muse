// V4.3.2.1: Google Calendar round-trip correctness — timezone preservation
// and all-day semantics.
//
// Deterministic: no network, no real Google credentials. Covers:
//   - Timezone round-trip: a Google event's own timezone survives
//     import -> local title-only edit -> push (the local DISPLAY zone must
//     never leak into the Google event).
//   - DST: the timezone IDENTIFIER is authoritative — offsets come from the
//     tz database, never hard-coded.
//   - All-day round-trip: start.date/end.date (exclusive end) survive
//     import -> edit -> push; the event stays all-day on Google.
//   - Timed regression: genuine local time edits move the event while
//     keeping its Google timezone.
//   - Local-only regression: unmapped local events are never touched.
//   - Differing start/end Google timezones are preserved separately.
//   - Calendar-timezone fallback for zone-less Google events.
//
// Run with:
//   TZ='Asia/Kolkata' node --test --import ./tests/hooks.mjs tests/google_roundtrip.test.mjs
import { register } from "node:module";
register(new URL("./resolve-next-server-stub.mjs", import.meta.url).href);

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = "ab".repeat(32);

import {
  addDays,
  diffDays,
  googleAllDayRange,
  googleEndTimeZone,
  googleEventToLocal,
  googleStartTimeZone,
  isAllDayGoogleEvent,
  localEventToGoogle,
  zonedTimeToUtc,
} from "../lib/google/eventMapping";
import { encryptToken } from "../lib/google/tokenVault";

const { NotConnectedError, runGoogleSync } = await import(
  "../lib/google/eventSync"
);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const READ_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.events";

// ---------------------------------------------------------------------------
// Minimal fakes (same shape as tests/google_sync.test.mjs)
// ---------------------------------------------------------------------------

let __seq = 0;
function fakeId(prefix) {
  __seq += 1;
  return `${prefix}-rt-${__seq}`;
}

function jsonRes(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    url: "https://www.googleapis.com/calendar/v3/",
    json: async () => payload,
  };
}

class FakeBuilder {
  constructor(rows, table) {
    this._rows = rows;
    this._table = table;
    this._op = null;
    this._arg = undefined;
    this._filters = [];
    this._single = null;
  }
  select() {
    if (this._op === null) this._op = "select";
    return this;
  }
  insert(row) {
    this._op = "insert";
    this._arg = row;
    return this;
  }
  update(patch) {
    this._op = "update";
    this._arg = patch;
    return this;
  }
  delete() {
    this._op = "delete";
    return this;
  }
  upsert(row) {
    this._op = "upsert";
    this._arg = row;
    return this;
  }
  eq(col, val) {
    this._filters.push((r) => r[col] === val);
    return this;
  }
  not(col, op, val) {
    if (op !== "is") throw new Error(`fake: not() only supports "is", got ${op}`);
    this._filters.push((r) => r[col] !== val);
    return this;
  }
  is(col, val) {
    this._filters.push((r) => r[col] === val);
    return this;
  }
  in(col, vals) {
    this._filters.push((r) => vals.includes(r[col]));
    return this;
  }
  order(col, { ascending = true } = {}) {
    this._order = { col, ascending };
    return this;
  }
  limit(n) {
    this._limit = n;
    return this;
  }
  single() {
    this._single = "single";
    return this;
  }
  maybeSingle() {
    this._single = "maybe";
    return this;
  }
  _matches() {
    return this._rows.filter((r) => this._filters.every((f) => f(r)));
  }
  _execute() {
    const op = this._op ?? "select";
    let matched = this._matches();
    if (op === "select") {
      if (this._order) {
        const { col, ascending } = this._order;
        matched = [...matched].sort((a, b) => {
          const av = a[col];
          const bv = b[col];
          if (av === bv) return 0;
          if (av == null) return 1;
          if (bv == null) return -1;
          return (av < bv ? -1 : 1) * (ascending ? 1 : -1);
        });
      }
      if (this._limit != null) matched = matched.slice(0, this._limit);
      if (this._single === "single") {
        return matched.length > 0
          ? { data: matched[0], error: null }
          : { data: null, error: new Error("fake: no rows") };
      }
      if (this._single === "maybe") return { data: matched[0] ?? null, error: null };
      return { data: matched, error: null };
    }
    if (op === "insert") {
      const row = { ...this._arg };
      if (row.id == null) row.id = fakeId(this._table);
      const t = new Date(Date.now() - 1000).toISOString();
      if (row.created_at == null) row.created_at = t;
      if (row.updated_at == null) row.updated_at = t;
      this._rows.push(row);
      return { data: row, error: null };
    }
    if (op === "upsert") {
      const row = { ...this._arg };
      const existing = this._rows.find(
        (r) => r.owner === row.owner && r.google_calendar_id === row.google_calendar_id
      );
      if (existing) Object.assign(existing, row);
      else {
        if (row.id == null) row.id = fakeId(this._table);
        this._rows.push(row);
      }
      return { data: null, error: null };
    }
    if (op === "update") {
      for (const r of matched) Object.assign(r, this._arg);
      return { data: null, error: null };
    }
    if (op === "delete") {
      const doomed = new Set(matched);
      for (let i = this._rows.length - 1; i >= 0; i--) {
        if (doomed.has(this._rows[i])) this._rows.splice(i, 1);
      }
      return { data: null, error: null };
    }
    throw new Error(`fake: unknown op ${op}`);
  }
  then(resolve, reject) {
    try {
      resolve(this._execute());
    } catch (err) {
      reject(err);
    }
  }
}

function makeStore() {
  return {
    google_calendar_connections: [],
    google_calendar_selections: [],
    google_event_mappings: [],
    google_calendar_sync_state: [],
    calendar_events: [],
  };
}

function makeSupabase(store) {
  return {
    from: (table) => {
      if (!(table in store)) throw new Error(`fake: unknown table ${table}`);
      return new FakeBuilder(store[table], table);
    },
  };
}

function makeGoogle() {
  const calls = [];
  let listImpl = null;
  const eventImpls = new Map();
  async function fetchImpl(url, init = {}) {
    const method = (init.method || "GET").toUpperCase();
    const u = new URL(String(url));
    const headers = init.headers || {};
    let body;
    try {
      body = init.body ? JSON.parse(init.body) : undefined;
    } catch {
      body = undefined;
    }
    calls.push({ method, url: String(url), params: u.searchParams, headers, body });
    const m = u.pathname.match(
      /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/
    );
    if (!m) throw new Error(`google mock: unexpected path ${u.pathname}`);
    const ctx = {
      method,
      calendarId: decodeURIComponent(m[1]),
      eventId: m[2] ? decodeURIComponent(m[2]) : null,
      params: u.searchParams,
      headers,
      body,
      calls,
    };
    if (method === "GET" && !ctx.eventId) {
      if (!listImpl) throw new Error("google mock: events.list not stubbed");
      return listImpl(ctx);
    }
    const fn =
      eventImpls.get(`${method} ${ctx.eventId ?? ""}`) ??
      eventImpls.get(`${method} *`);
    if (!fn) throw new Error(`google mock: unmocked ${method} ${ctx.eventId}`);
    return fn(ctx);
  }
  return {
    calls,
    fetchImpl: (url, init) => fetchImpl(url, init),
    onList(fn) {
      listImpl = fn;
    },
    onEvent(method, eventId, fn) {
      eventImpls.set(`${method} ${eventId}`, fn);
    },
  };
}

const USER_A = "user-a";
const CAL_1 = "cal-1";
const GACCT = "gacct-1";
const T0 = "2026-09-01T00:00:00.000Z";

function seedConnection(store, { scopes = [READ_SCOPE, WRITE_SCOPE] } = {}) {
  const conn = {
    id: fakeId("conn"),
    owner: USER_A,
    google_account_id: GACCT,
    email: `${USER_A}@example.com`,
    status: "connected",
    refresh_token_enc: null,
    access_token_enc: encryptToken(`access-token-for-${USER_A}`),
    token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    scopes,
    created_at: T0,
    updated_at: T0,
  };
  store.google_calendar_connections.push(conn);
  store.google_calendar_selections.push({
    id: fakeId("sel"),
    owner: USER_A,
    connection_id: conn.id,
    google_calendar_id: CAL_1,
    calendar_name: "Primary",
    time_zone: null,
    selected: true,
    created_at: T0,
    updated_at: T0,
  });
  return conn;
}

/** Simulate a local title-only edit "now" (after the last sync). */
function touchLocal(store, localId, fields) {
  const row = store.calendar_events.find((e) => e.id === localId);
  Object.assign(row, fields, {
    updated_at: new Date(Date.now() + 60_000).toISOString(),
  });
  return row;
}

function runSync(store, google, { timeZone = "Asia/Kolkata" } = {}) {
  return runGoogleSync({
    supabase: makeSupabase(store),
    userId: USER_A,
    timeZone,
    fetchImpl: google.fetchImpl,
  });
}

/** Wall-clock { date, time } for an instant in an IANA zone (test oracle). */
function wallClock(iso, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const v = (t) => parts.find((p) => p.type === t)?.value ?? "";
  let hour = v("hour");
  if (hour === "24") hour = "00";
  return { date: `${v("year")}-${v("month")}-${v("day")}`, time: `${hour}:${v("minute")}` };
}

// ---------------------------------------------------------------------------
// A. Timezone round-trip through the real sync engine
// ---------------------------------------------------------------------------

test("roundtrip T1: Google tz survives import -> title-only edit -> push", async () => {
  const store = makeStore();
  seedConnection(store);
  const g = makeGoogle();
  // Google event: 09:00–10:00 America/New_York (EDT, UTC-4 on 2026-10-05).
  const gEvent = {
    id: "gev-tz",
    etag: "e1",
    summary: "Standup",
    status: "confirmed",
    start: { dateTime: "2026-10-05T13:00:00Z", timeZone: "America/New_York" },
    end: { dateTime: "2026-10-05T14:00:00Z", timeZone: "America/New_York" },
  };
  g.onList(() => jsonRes(200, { items: [gEvent], nextSyncToken: "tok-1" }));

  // Device is in Asia/Kolkata.
  const first = await runSync(store, g, { timeZone: "Asia/Kolkata" });
  assert.equal(first.imported, 1);

  const local = store.calendar_events[0];
  // Local DISPLAY follows the device zone: 13:00Z -> 18:30 IST.
  assert.equal(local.event_date, "2026-10-05");
  assert.equal(local.start_time, "18:30");
  assert.equal(local.end_time, "19:30");
  assert.equal(local.is_all_day, false);

  const mapping = store.google_event_mappings[0];
  assert.equal(
    mapping.google_timezone,
    "America/New_York",
    "Google timezone preserved as sync metadata"
  );

  // User edits ONLY the title.
  touchLocal(store, local.id, { title: "Standup (renamed)" });

  let putBody = null;
  g.onEvent("PUT", "gev-tz", ({ body }) => {
    putBody = body;
    return jsonRes(200, { id: "gev-tz", etag: "e2" });
  });
  const second = await runSync(store, g, { timeZone: "Asia/Kolkata" });
  assert.equal(second.pushed, 1);
  assert.ok(putBody, "events.update called");
  assert.equal(putBody.summary, "Standup (renamed)", "title change pushed");
  // The event keeps its Google timezone AND wall-clock time — it must NOT
  // silently become 18:30 Asia/Kolkata.
  assert.equal(putBody.start.dateTime, "2026-10-05T09:00:00");
  assert.equal(putBody.start.timeZone, "America/New_York");
  assert.equal(putBody.end.dateTime, "2026-10-05T10:00:00");
  assert.equal(putBody.end.timeZone, "America/New_York");
  assert.ok(!("date" in putBody.start), "timed event stays timed");
});

test("roundtrip T2: DST — the timezone identifier is authoritative, not a fixed offset", async () => {
  // Winter: 09:00 America/New_York is EST (UTC-5) -> 14:00Z.
  const winter = {
    id: "gev-w",
    etag: "e1",
    summary: "Winter standup",
    status: "confirmed",
    start: { dateTime: "2026-12-01T14:00:00Z", timeZone: "America/New_York" },
    end: { dateTime: "2026-12-01T15:00:00Z", timeZone: "America/New_York" },
  };
  const d = googleEventToLocal(winter, "Asia/Kolkata");
  // 14:00Z -> 19:30 IST.
  assert.equal(d.start_time, "19:30");
  assert.equal(d.end_time, "20:30");

  // Push back with the preserved zone: must be 09:00 America/New_York again.
  // A hard-coded UTC-5 assumption would ALSO pass here, so also check summer.
  const bodyW = localEventToGoogle(
    { title: "Winter standup", event_date: "2026-12-01", start_time: "19:30", end_time: "20:30", notes: null },
    "Asia/Kolkata",
    { googleStartTimeZone: "America/New_York" }
  );
  assert.equal(bodyW.start.dateTime, "2026-12-01T09:00:00");
  assert.equal(bodyW.start.timeZone, "America/New_York");

  // Summer: 09:00 America/New_York is EDT (UTC-4) -> 13:00Z.
  // A hard-coded UTC-5 offset would emit 08:00 here — the identifier must win.
  const bodyS = localEventToGoogle(
    { title: "Summer standup", event_date: "2026-07-01", start_time: "18:30", end_time: "19:30", notes: null },
    "Asia/Kolkata",
    { googleStartTimeZone: "America/New_York" }
  );
  assert.equal(bodyS.start.dateTime, "2026-07-01T09:00:00");
  assert.equal(bodyS.start.timeZone, "America/New_York");
  assert.equal(bodyS.end.dateTime, "2026-07-01T10:00:00");
});

test("roundtrip T3: genuine local time edit moves the event, keeps the Google zone", async () => {
  const store = makeStore();
  seedConnection(store);
  const g = makeGoogle();
  const gEvent = {
    id: "gev-move",
    etag: "e1",
    summary: "Lunch",
    status: "confirmed",
    start: { dateTime: "2026-10-05T16:00:00Z", timeZone: "America/New_York" },
    end: { dateTime: "2026-10-05T17:00:00Z", timeZone: "America/New_York" },
  };
  g.onList(() => jsonRes(200, { items: [gEvent], nextSyncToken: "tok-1" }));
  await runSync(store, g, { timeZone: "Asia/Kolkata" });

  const local = store.calendar_events[0];
  assert.equal(local.start_time, "21:30", "16:00Z -> 21:30 IST");

  // User moves it to 22:00–23:00 local (Kolkata) wall-clock.
  touchLocal(store, local.id, { start_time: "22:00", end_time: "23:00" });

  let putBody = null;
  g.onEvent("PUT", "gev-move", ({ body }) => {
    putBody = body;
    return jsonRes(200, { id: "gev-move", etag: "e2" });
  });
  const res = await runSync(store, g, { timeZone: "Asia/Kolkata" });
  assert.equal(res.pushed, 1);
  // 22:00 IST = 16:30Z = 12:30 EDT — the edit is honored, the Google zone kept.
  assert.equal(putBody.start.dateTime, "2026-10-05T12:30:00");
  assert.equal(putBody.start.timeZone, "America/New_York");
  assert.equal(putBody.end.dateTime, "2026-10-05T13:30:00");
  assert.equal(putBody.end.timeZone, "America/New_York");
});

// ---------------------------------------------------------------------------
// B. All-day round-trip through the real sync engine
// ---------------------------------------------------------------------------

test("roundtrip A1: all-day event survives import -> title edit -> push", async () => {
  const store = makeStore();
  seedConnection(store);
  const g = makeGoogle();
  // Google exclusive end: Oct 10 + Oct 11 (NOT three days).
  const gEvent = {
    id: "gev-ad",
    etag: "e1",
    summary: "Offsite",
    status: "confirmed",
    start: { date: "2026-10-10" },
    end: { date: "2026-10-12" },
  };
  g.onList(() => jsonRes(200, { items: [gEvent], nextSyncToken: "tok-1" }));
  const first = await runSync(store, g, { timeZone: "Asia/Kolkata" });
  assert.equal(first.imported, 1);

  const local = store.calendar_events[0];
  assert.equal(local.event_date, "2026-10-10", "no timezone shift on all-day dates");
  assert.equal(local.is_all_day, true, "all-day flag set");

  const mapping = store.google_event_mappings[0];
  assert.equal(mapping.google_timezone, null, "all-day events have no timezone");
  assert.equal(mapping.google_start_date, "2026-10-10");
  assert.equal(mapping.google_end_date, "2026-10-12", "exclusive end preserved");

  touchLocal(store, local.id, { title: "Offsite (renamed)" });

  let putBody = null;
  g.onEvent("PUT", "gev-ad", ({ body }) => {
    putBody = body;
    return jsonRes(200, { id: "gev-ad", etag: "e2" });
  });
  const second = await runSync(store, g, { timeZone: "Asia/Kolkata" });
  assert.equal(second.pushed, 1);
  assert.ok(putBody, "events.update called");
  assert.equal(putBody.summary, "Offsite (renamed)");
  assert.equal(putBody.start.date, "2026-10-10");
  assert.equal(putBody.end.date, "2026-10-12", "exclusive end unchanged");
  assert.ok(!("dateTime" in putBody.start), "stays an all-day Google event");
  assert.ok(!("dateTime" in putBody.end), "stays an all-day Google event");
});

test("roundtrip A2: moving an all-day event preserves its span", async () => {
  const store = makeStore();
  seedConnection(store);
  const g = makeGoogle();
  g.onList(() =>
    jsonRes(200, {
      items: [
        {
          id: "gev-ad2",
          etag: "e1",
          summary: "Conference",
          status: "confirmed",
          start: { date: "2026-10-10" },
          end: { date: "2026-10-12" },
        },
      ],
      nextSyncToken: "tok-1",
    })
  );
  await runSync(store, g, { timeZone: "Asia/Kolkata" });
  const local = store.calendar_events[0];

  // User moves the event one day later; the 2-day span must be preserved.
  touchLocal(store, local.id, { event_date: "2026-10-11" });

  let putBody = null;
  g.onEvent("PUT", "gev-ad2", ({ body }) => {
    putBody = body;
    return jsonRes(200, { id: "gev-ad2", etag: "e2" });
  });
  const res = await runSync(store, g, { timeZone: "Asia/Kolkata" });
  assert.equal(res.pushed, 1);
  assert.equal(putBody.start.date, "2026-10-11");
  assert.equal(putBody.end.date, "2026-10-13", "span preserved across the move");
});

// ---------------------------------------------------------------------------
// C. Timezone metadata extraction + conversion units
// ---------------------------------------------------------------------------

test("roundtrip U1: Google timezone extraction prefers start.timeZone", () => {
  const g = {
    start: { dateTime: "2026-10-05T13:00:00Z", timeZone: "America/New_York" },
    end: { dateTime: "2026-10-05T14:00:00Z", timeZone: "America/Chicago" },
  };
  assert.equal(googleStartTimeZone(g, null), "America/New_York");
  assert.equal(
    googleEndTimeZone(g, "America/New_York"),
    "America/Chicago",
    "differing end zone preserved separately"
  );
  assert.equal(
    googleEndTimeZone(
      { start: { timeZone: "America/New_York" }, end: { timeZone: "America/New_York" } },
      "America/New_York"
    ),
    null,
    "identical end zone collapses to null"
  );
  assert.equal(
    googleStartTimeZone({ start: { dateTime: "2026-10-05T13:00:00Z" } }, "America/Denver"),
    "America/Denver",
    "calendar zone is the fallback for zone-less events"
  );
  assert.equal(
    googleStartTimeZone({ start: { dateTime: "2026-10-05T13:00:00Z" } }, null),
    null,
    "null when no zone is known anywhere"
  );
});

test("roundtrip U2: all-day range uses exclusive end; missing end defaults to one day", () => {
  assert.deepEqual(
    googleAllDayRange({ start: { date: "2026-10-10" }, end: { date: "2026-10-12" } }),
    { startDate: "2026-10-10", endDate: "2026-10-12" }
  );
  assert.deepEqual(
    googleAllDayRange({ start: { date: "2026-10-10" } }),
    { startDate: "2026-10-10", endDate: "2026-10-11" },
    "missing end.date defaults to a single day"
  );
  assert.equal(
    googleAllDayRange({ start: { dateTime: "2026-10-05T13:00:00Z" } }),
    null,
    "timed events have no all-day range"
  );
  assert.equal(addDays("2026-10-10", 2), "2026-10-12");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01", "year boundary");
  assert.equal(diffDays("2026-10-10", "2026-10-12"), 2);
});

test("roundtrip U3: zonedTimeToUtc honors DST via the identifier", () => {
  // 09:00 America/New_York in July is EDT (UTC-4).
  assert.equal(
    zonedTimeToUtc("2026-07-01", "09:00", "America/New_York").toISOString(),
    "2026-07-01T13:00:00.000Z"
  );
  // 09:00 America/New_York in December is EST (UTC-5) — no hard-coded offset.
  assert.equal(
    zonedTimeToUtc("2026-12-01", "09:00", "America/New_York").toISOString(),
    "2026-12-01T14:00:00.000Z"
  );
  // Asia/Kolkata has no DST: UTC+5:30 year-round.
  assert.equal(
    zonedTimeToUtc("2026-10-05", "18:30", "Asia/Kolkata").toISOString(),
    "2026-10-05T13:00:00.000Z"
  );
});

test("roundtrip U4: localEventToGoogle all-day emits date/date (never dateTime)", () => {
  const body = localEventToGoogle(
    { title: "Diwali", event_date: "2026-10-20", start_time: "00:00", end_time: "23:59", notes: null },
    "Asia/Kolkata",
    { isAllDay: true, googleStartDate: "2026-10-20", googleEndDate: "2026-10-21" }
  );
  assert.equal(body.start.date, "2026-10-20");
  assert.equal(body.end.date, "2026-10-21");
  assert.ok(!("dateTime" in body.start));
  assert.ok(!("timeZone" in body.start), "all-day bodies carry no timezone");

  // No stored range: single-day default.
  const single = localEventToGoogle(
    { title: "X", event_date: "2026-10-20", start_time: "00:00", end_time: "23:59", notes: null },
    "Asia/Kolkata",
    { isAllDay: true }
  );
  assert.equal(single.end.date, "2026-10-21");
});

test("roundtrip U5: localEventToGoogle timed default keeps the given zone", () => {
  // No preserved Google zone (e.g. a local event pushed for the first time):
  // wall-clock is expressed in the sync zone, unchanged behavior.
  const body = localEventToGoogle(
    { title: "Study", event_date: "2026-10-05", start_time: "09:30", end_time: "10:30", notes: "Ch 5" },
    "Asia/Kolkata"
  );
  assert.equal(body.start.dateTime, "2026-10-05T09:30:00");
  assert.equal(body.start.timeZone, "Asia/Kolkata");
  assert.equal(body.end.dateTime, "2026-10-05T10:30:00");
  assert.equal(body.end.timeZone, "Asia/Kolkata");
  assert.equal(body.description, "Ch 5");
});

// ---------------------------------------------------------------------------
// D. Regressions: local-only events, zone-less events, differing end zones
// ---------------------------------------------------------------------------

test("roundtrip R1: local-only event (no mapping) is never touched by sync", async () => {
  const store = makeStore();
  seedConnection(store);
  const lonely = {
    id: fakeId("local"),
    owner: USER_A,
    title: "Local only",
    event_date: "2026-10-05",
    start_time: "09:00",
    end_time: "10:00",
    is_all_day: false,
    notes: null,
    created_at: T0,
    updated_at: T0,
  };
  store.calendar_events.push(lonely);
  const g = makeGoogle();
  g.onList(() => jsonRes(200, { items: [], nextSyncToken: "tok-1" }));
  const res = await runSync(store, g, { timeZone: "Asia/Kolkata" });
  assert.equal(res.pushed, 0);
  assert.ok(
    !g.calls.some((c) => c.method === "POST" || c.method === "PUT"),
    "no Google writes for unmapped events"
  );
  assert.equal(store.google_event_mappings.length, 0, "no mapping created");
  const after = store.calendar_events.find((e) => e.id === lonely.id);
  assert.equal(after.title, "Local only", "untouched");
  assert.equal(after.is_all_day, false);
});

test("roundtrip R2: zone-less Google event falls back to the calendar timezone", async () => {
  const store = makeStore();
  seedConnection(store);
  // The Google calendar itself is in America/Denver.
  store.google_calendar_selections[0].time_zone = "America/Denver";
  const g = makeGoogle();
  g.onList(() =>
    jsonRes(200, {
      items: [
        {
          id: "gev-plain",
          etag: "e1",
          summary: "No tz event",
          status: "confirmed",
          start: { dateTime: "2026-10-05T14:00:00Z" },
          end: { dateTime: "2026-10-05T15:00:00Z" },
        },
      ],
      nextSyncToken: "tok-1",
    })
  );
  const res = await runSync(store, g, { timeZone: "Asia/Kolkata" });
  assert.equal(res.imported, 1);
  const mapping = store.google_event_mappings[0];
  assert.equal(
    mapping.google_timezone,
    "America/Denver",
    "calendar zone used when the event carries none"
  );
});

test("roundtrip R3: differing Google start/end timezones are preserved separately", async () => {
  const store = makeStore();
  seedConnection(store);
  const g = makeGoogle();
  const gEvent = {
    id: "gev-2tz",
    etag: "e1",
    summary: "Cross-zone call",
    status: "confirmed",
    start: { dateTime: "2026-10-05T13:00:00Z", timeZone: "America/New_York" },
    end: { dateTime: "2026-10-05T14:30:00Z", timeZone: "America/Chicago" },
  };
  g.onList(() => jsonRes(200, { items: [gEvent], nextSyncToken: "tok-1" }));
  await runSync(store, g, { timeZone: "Asia/Kolkata" });
  const mapping = store.google_event_mappings[0];
  assert.equal(mapping.google_timezone, "America/New_York");
  assert.equal(mapping.google_end_timezone, "America/Chicago");

  const local = store.calendar_events[0];
  touchLocal(store, local.id, { title: "Cross-zone call (renamed)" });
  let putBody = null;
  g.onEvent("PUT", "gev-2tz", ({ body }) => {
    putBody = body;
    return jsonRes(200, { id: "gev-2tz", etag: "e2" });
  });
  await runSync(store, g, { timeZone: "Asia/Kolkata" });
  // 13:00Z -> 09:00 EDT; 14:30Z -> 09:30 CDT.
  assert.equal(putBody.start.dateTime, "2026-10-05T09:00:00");
  assert.equal(putBody.start.timeZone, "America/New_York");
  assert.equal(putBody.end.dateTime, "2026-10-05T09:30:00");
  assert.equal(putBody.end.timeZone, "America/Chicago");
});

// ---------------------------------------------------------------------------
// E. Static security: the OAuth/token architecture is untouched
// ---------------------------------------------------------------------------

test("roundtrip S1: round-trip code keeps secrets server-side; migration 0011 is additive", () => {
  // eventMapping.ts is the pure, client-importable module: it must never
  // touch token material. (eventSync.ts legitimately decrypts the
  // server-side access token — it is server-only; the existing D1-D3 tests
  // pin the import graph and log hygiene.)
  const mappingSrc = readFileSync(join(ROOT, "lib/google/eventMapping.ts"), "utf8");
  assert.ok(!mappingSrc.includes("refresh_token"), "eventMapping.ts never mentions refresh tokens");
  assert.ok(!mappingSrc.includes("access_token"), "eventMapping.ts never mentions access tokens");
  assert.ok(!mappingSrc.includes("client_secret"), "eventMapping.ts never mentions the client secret");
  assert.ok(!mappingSrc.includes('import "server-only"'), "eventMapping.ts stays client-importable");

  const names = readdirSync(join(ROOT, "supabase/migrations"));
  assert.ok(
    names.includes("0011_google_calendar_roundtrip.sql"),
    "migration 0011 exists"
  );
  // No destructive operations in the new migration.
  const m11 = readFileSync(
    join(ROOT, "supabase/migrations/0011_google_calendar_roundtrip.sql"),
    "utf8"
  ).toLowerCase();
  assert.ok(!m11.includes("drop table"), "0011 drops no tables");
  assert.ok(!m11.match(/delete\s+from/), "0011 deletes no rows");
  assert.ok(!m11.includes("truncate"), "0011 truncates nothing");
  // Earlier migrations are untouched by this version.
  for (const f of names.filter((n) => n < "0011_google_calendar_roundtrip.sql")) {
    const src = readFileSync(join(ROOT, "supabase/migrations", f), "utf8");
    assert.ok(
      !src.includes("is_all_day") && !src.includes("google_end_timezone"),
      `${f} untouched by 0011`
    );
  }
});
