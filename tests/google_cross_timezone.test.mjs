// V4.3.2.2: cross-timezone sync correctness — the local interpretation
// timezone.
//
// A timed Google event is rendered locally as a bare wall-clock in the
// DISPLAY zone of the importing device. The mapping now stores that zone as
// `local_timezone` (migration 0012), and the push path interprets the
// wall-clock in the STORED zone — never blindly in the current device zone.
// Deterministic: no network, no real Google credentials. Covers:
//   - X1: title-only edit from a device in a different timezone does NOT
//     move the event (the V4.3.2.2 regression).
//   - X2: same, with the Google event in Asia/Kolkata and the second device
//     in America/Los_Angeles.
//   - X3: a genuine time edit in the same zone still moves the event by the
//     wall-clock delta (editing is not frozen).
//   - X4: a genuine time edit from a device in a different zone is
//     interpreted in the edit zone, and the stored zone follows the edit.
//   - X5: DST — the IANA identifier stays authoritative across the
//     EDT->EST transition (no hard-coded offsets).
//   - X6: legacy mappings without local_timezone fall back to the sync-call
//     zone (documented pre-V4.3.2.2 behavior) and the fallback is NOT
//     persisted.
//   - X7: all-day events are untouched by timezone interpretation.
//
// Run with:
//   TZ='Asia/Kolkata' node --test --import ./tests/hooks.mjs tests/google_cross_timezone.test.mjs
import { register } from "node:module";
register(new URL("./resolve-next-server-stub.mjs", import.meta.url).href);

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = "ab".repeat(32);

import { encryptToken } from "../lib/google/tokenVault";

const { runGoogleSync } = await import("../lib/google/eventSync");

const READ_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.events";

// ---------------------------------------------------------------------------
// Minimal fakes (same shape as tests/google_roundtrip.test.mjs)
// ---------------------------------------------------------------------------

let __seq = 0;
function fakeId(prefix) {
  __seq += 1;
  return `${prefix}-xtz-${__seq}`;
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
  upsert(row, opts) {
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
      if (row.id == null) row.id = fakeId(this._table);
      this._rows.push(row);
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

/** Simulate a local edit "now" (after the last sync). */
function touchLocal(store, localId, fields) {
  const row = store.calendar_events.find((e) => e.id === localId);
  Object.assign(row, fields, {
    updated_at: new Date(Date.now() + 60_000).toISOString(),
  });
  return row;
}

function runSync(store, google, { timeZone }) {
  return runGoogleSync({
    supabase: makeSupabase(store),
    userId: USER_A,
    timeZone,
    fetchImpl: google.fetchImpl,
  });
}

// ---------------------------------------------------------------------------
// X1: title-only edit from a device in another timezone must NOT move it
// ---------------------------------------------------------------------------

test("X1: title-only edit from a device in another timezone does not move the event", async () => {
  const store = makeStore();
  seedConnection(store);
  const g = makeGoogle();
  // Google: 09:00–10:00 America/New_York on 2026-10-05 (EDT, UTC-4).
  const gEvent = {
    id: "gev-x1",
    etag: "e1",
    summary: "Standup",
    status: "confirmed",
    start: { dateTime: "2026-10-05T13:00:00Z", timeZone: "America/New_York" },
    end: { dateTime: "2026-10-05T14:00:00Z", timeZone: "America/New_York" },
  };
  g.onList(() => jsonRes(200, { items: [gEvent], nextSyncToken: "tok-1" }));

  // Device 1 is in Asia/Kolkata: 13:00Z renders as 18:30 IST.
  const first = await runSync(store, g, { timeZone: "Asia/Kolkata" });
  assert.equal(first.imported, 1);
  const local = store.calendar_events[0];
  assert.equal(local.event_date, "2026-10-05");
  assert.equal(local.start_time, "18:30");
  assert.equal(local.end_time, "19:30");

  const mapping = store.google_event_mappings[0];
  assert.equal(mapping.google_timezone, "America/New_York");
  assert.equal(
    mapping.local_timezone,
    "Asia/Kolkata",
    "the display zone used at import is stored as local_timezone"
  );

  // Title-only edit, then sync from a device in America/New_York.
  // The stored local wall-clock is NOT modified — only the title.
  touchLocal(store, local.id, { title: "Standup (renamed)" });

  let putBody = null;
  g.onEvent("PUT", "gev-x1", ({ body }) => {
    putBody = body;
    return jsonRes(200, { id: "gev-x1", etag: "e2" });
  });
  const second = await runSync(store, g, { timeZone: "America/New_York" });
  assert.equal(second.pushed, 1);
  assert.ok(putBody, "events.update called");
  // The Google event must remain 09:00 America/New_York — it must NOT
  // become 18:30 America/New_York (the V4.3.2.2 bug).
  assert.equal(putBody.start.dateTime, "2026-10-05T09:00:00");
  assert.equal(putBody.start.timeZone, "America/New_York");
  assert.equal(putBody.end.dateTime, "2026-10-05T10:00:00");
  assert.equal(putBody.end.timeZone, "America/New_York");
  // A title-only edit does not change the interpretation zone.
  assert.equal(
    store.google_event_mappings[0].local_timezone,
    "Asia/Kolkata",
    "title-only edits leave local_timezone untouched"
  );
});

// ---------------------------------------------------------------------------
// X2: same scenario, Google event in Asia/Kolkata, second device in LA
// ---------------------------------------------------------------------------

test("X2: title-only edit across Kolkata -> Los Angeles does not move the event", async () => {
  const store = makeStore();
  seedConnection(store);
  const g = makeGoogle();
  // Google: 14:00–15:00 Asia/Kolkata on 2026-10-05 = 08:30–09:30Z.
  const gEvent = {
    id: "gev-x2",
    etag: "e1",
    summary: "Call",
    status: "confirmed",
    start: { dateTime: "2026-10-05T08:30:00Z", timeZone: "Asia/Kolkata" },
    end: { dateTime: "2026-10-05T09:30:00Z", timeZone: "Asia/Kolkata" },
  };
  g.onList(() => jsonRes(200, { items: [gEvent], nextSyncToken: "tok-1" }));

  // Device 1 in America/New_York (EDT): 08:30Z -> 04:30.
  const first = await runSync(store, g, { timeZone: "America/New_York" });
  assert.equal(first.imported, 1);
  const local = store.calendar_events[0];
  assert.equal(local.event_date, "2026-10-05");
  assert.equal(local.start_time, "04:30");
  assert.equal(local.end_time, "05:30");
  const mapping = store.google_event_mappings[0];
  assert.equal(mapping.google_timezone, "Asia/Kolkata");
  assert.equal(mapping.local_timezone, "America/New_York");

  touchLocal(store, local.id, { title: "Call (renamed)" });
  let putBody = null;
  g.onEvent("PUT", "gev-x2", ({ body }) => {
    putBody = body;
    return jsonRes(200, { id: "gev-x2", etag: "e2" });
  });
  // Device 2 in America/Los_Angeles.
  const second = await runSync(store, g, { timeZone: "America/Los_Angeles" });
  assert.equal(second.pushed, 1);
  assert.equal(putBody.start.dateTime, "2026-10-05T14:00:00");
  assert.equal(putBody.start.timeZone, "Asia/Kolkata");
  assert.equal(putBody.end.dateTime, "2026-10-05T15:00:00");
  assert.equal(putBody.end.timeZone, "Asia/Kolkata");
});

// ---------------------------------------------------------------------------
// X3: genuine time edit in the same zone still works
// ---------------------------------------------------------------------------

test("X3: genuine time edit in the same zone moves the event by the wall-clock delta", async () => {
  const store = makeStore();
  seedConnection(store);
  const g = makeGoogle();
  const gEvent = {
    id: "gev-x3",
    etag: "e1",
    summary: "Standup",
    status: "confirmed",
    start: { dateTime: "2026-10-05T13:00:00Z", timeZone: "America/New_York" },
    end: { dateTime: "2026-10-05T14:00:00Z", timeZone: "America/New_York" },
  };
  g.onList(() => jsonRes(200, { items: [gEvent], nextSyncToken: "tok-1" }));

  await runSync(store, g, { timeZone: "Asia/Kolkata" });
  const local = store.calendar_events[0];
  assert.equal(local.start_time, "18:30");

  // User intentionally moves 18:30 -> 19:30 while operating in Asia/Kolkata.
  touchLocal(store, local.id, { start_time: "19:30", end_time: "20:30" });

  let putBody = null;
  g.onEvent("PUT", "gev-x3", ({ body }) => {
    putBody = body;
    return jsonRes(200, { id: "gev-x3", etag: "e2" });
  });
  const second = await runSync(store, g, { timeZone: "Asia/Kolkata" });
  assert.equal(second.pushed, 1);
  // 19:30 IST = 14:00Z = 10:00 America/New_York: the event moves one hour,
  // keeps its Google timezone, and editing is not frozen.
  assert.equal(putBody.start.dateTime, "2026-10-05T10:00:00");
  assert.equal(putBody.start.timeZone, "America/New_York");
  assert.equal(putBody.end.dateTime, "2026-10-05T11:00:00");
  assert.equal(
    store.google_event_mappings[0].local_timezone,
    "Asia/Kolkata",
    "same-zone edit keeps the interpretation zone"
  );
});

// ---------------------------------------------------------------------------
// X4: genuine time edit from another zone is interpreted in the edit zone
// ---------------------------------------------------------------------------

test("X4: genuine time edit from another zone uses the edit zone and updates local_timezone", async () => {
  const store = makeStore();
  seedConnection(store);
  const g = makeGoogle();
  const gEvent = {
    id: "gev-x4",
    etag: "e1",
    summary: "Standup",
    status: "confirmed",
    start: { dateTime: "2026-10-05T13:00:00Z", timeZone: "America/New_York" },
    end: { dateTime: "2026-10-05T14:00:00Z", timeZone: "America/New_York" },
  };
  g.onList(() => jsonRes(200, { items: [gEvent], nextSyncToken: "tok-1" }));

  // Imported on a device in Asia/Kolkata: local 18:30, stored zone Kolkata.
  await runSync(store, g, { timeZone: "Asia/Kolkata" });
  const local = store.calendar_events[0];
  assert.equal(
    store.google_event_mappings[0].local_timezone,
    "Asia/Kolkata"
  );

  // On the New York device the user changes 18:30 -> 19:30 (their wall-clock).
  touchLocal(store, local.id, { start_time: "19:30", end_time: "20:30" });

  let putBody = null;
  g.onEvent("PUT", "gev-x4", ({ body }) => {
    putBody = body;
    return jsonRes(200, { id: "gev-x4", etag: "e2" });
  });
  const second = await runSync(store, g, { timeZone: "America/New_York" });
  assert.equal(second.pushed, 1);
  // 19:30 America/New_York = 23:30Z: the edit zone wins for genuine edits.
  assert.equal(putBody.start.dateTime, "2026-10-05T19:30:00");
  assert.equal(putBody.start.timeZone, "America/New_York");
  assert.equal(putBody.end.dateTime, "2026-10-05T20:30:00");
  // The stored interpretation zone follows the edit, keeping the next
  // round-trip stable.
  assert.equal(
    store.google_event_mappings[0].local_timezone,
    "America/New_York",
    "local_timezone follows a genuine cross-zone edit"
  );
});

// ---------------------------------------------------------------------------
// X5: DST — the IANA identifier is authoritative, never a fixed offset
// ---------------------------------------------------------------------------

test("X5: cross-timezone round-trip across the EDT->EST transition", async () => {
  const store = makeStore();
  seedConnection(store);
  const g = makeGoogle();
  // 2026-12-01 09:00 America/New_York is EST (UTC-5) -> 14:00Z.
  // (X1 covered the same wall-clock in EDT/UTC-4: the identifier, not a
  // fixed -4/-5 offset, must drive the conversion.)
  const gEvent = {
    id: "gev-x5",
    etag: "e1",
    summary: "Winter standup",
    status: "confirmed",
    start: { dateTime: "2026-12-01T14:00:00Z", timeZone: "America/New_York" },
    end: { dateTime: "2026-12-01T15:00:00Z", timeZone: "America/New_York" },
  };
  g.onList(() => jsonRes(200, { items: [gEvent], nextSyncToken: "tok-1" }));

  await runSync(store, g, { timeZone: "Asia/Kolkata" });
  const local = store.calendar_events[0];
  assert.equal(local.start_time, "19:30");
  assert.equal(local.end_time, "20:30");

  touchLocal(store, local.id, { title: "Winter standup (renamed)" });
  let putBody = null;
  g.onEvent("PUT", "gev-x5", ({ body }) => {
    putBody = body;
    return jsonRes(200, { id: "gev-x5", etag: "e2" });
  });
  const second = await runSync(store, g, { timeZone: "America/New_York" });
  assert.equal(second.pushed, 1);
  assert.equal(putBody.start.dateTime, "2026-12-01T09:00:00");
  assert.equal(putBody.start.timeZone, "America/New_York");
  assert.equal(putBody.end.dateTime, "2026-12-01T10:00:00");
});

// ---------------------------------------------------------------------------
// X6: legacy mappings without local_timezone use the documented fallback
// ---------------------------------------------------------------------------

test("X6: legacy mapping without local_timezone falls back to the sync-call zone (documented)", async () => {
  const store = makeStore();
  seedConnection(store);
  const g = makeGoogle();
  const gEvent = {
    id: "gev-x6",
    etag: "e1",
    summary: "Standup",
    status: "confirmed",
    start: { dateTime: "2026-10-05T13:00:00Z", timeZone: "America/New_York" },
    end: { dateTime: "2026-10-05T14:00:00Z", timeZone: "America/New_York" },
  };
  g.onList(() => jsonRes(200, { items: [gEvent], nextSyncToken: "tok-1" }));

  await runSync(store, g, { timeZone: "Asia/Kolkata" });
  const local = store.calendar_events[0];
  // Simulate a row written before V4.3.2.2 (migration 0012 had not run).
  store.google_event_mappings[0].local_timezone = null;

  touchLocal(store, local.id, { title: "Standup (renamed)" });
  let putBody = null;
  g.onEvent("PUT", "gev-x6", ({ body }) => {
    putBody = body;
    return jsonRes(200, { id: "gev-x6", etag: "e2" });
  });
  const second = await runSync(store, g, { timeZone: "America/New_York" });
  assert.equal(second.pushed, 1);
  // Documented legacy behavior: the wall-clock is interpreted in the
  // current sync-call zone (the pre-V4.3.2.2 semantics). This is exactly
  // why new mappings must always store local_timezone.
  assert.equal(putBody.start.dateTime, "2026-10-05T18:30:00");
  assert.equal(putBody.start.timeZone, "America/New_York");
  // The fallback is transient: nothing is invented or persisted.
  assert.equal(
    store.google_event_mappings[0].local_timezone,
    null,
    "legacy fallback is not persisted"
  );
});

// ---------------------------------------------------------------------------
// X7: all-day events carry no timezone interpretation
// ---------------------------------------------------------------------------

test("X7: all-day round-trip is unaffected by device timezones", async () => {
  const store = makeStore();
  seedConnection(store);
  const g = makeGoogle();
  const gEvent = {
    id: "gev-x7",
    etag: "e1",
    summary: "Holiday",
    status: "confirmed",
    start: { date: "2026-10-10" },
    end: { date: "2026-10-12" },
  };
  g.onList(() => jsonRes(200, { items: [gEvent], nextSyncToken: "tok-1" }));

  await runSync(store, g, { timeZone: "Asia/Kolkata" });
  const local = store.calendar_events[0];
  assert.equal(local.is_all_day, true);
  assert.equal(local.event_date, "2026-10-10");

  touchLocal(store, local.id, { title: "Holiday (renamed)" });
  let putBody = null;
  g.onEvent("PUT", "gev-x7", ({ body }) => {
    putBody = body;
    return jsonRes(200, { id: "gev-x7", etag: "e2" });
  });
  const second = await runSync(store, g, { timeZone: "America/New_York" });
  assert.equal(second.pushed, 1);
  assert.equal(putBody.start.date, "2026-10-10");
  assert.equal(putBody.end.date, "2026-10-12");
  assert.ok(!("dateTime" in putBody.start), "stays an all-day event");
});
