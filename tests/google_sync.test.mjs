// V4.3.2: Google Calendar event sync — unit + orchestrator tests.
//
// Deterministic: no network, no real Google credentials. Covers:
//  - lib/google/eventMapping.ts (pure converters: Google <-> local events)
//  - lib/google/googleApi.ts    (injected-fetch API client + typed errors)
//  - lib/google/eventSync.ts    (runGoogleSync against a fake in-memory
//                               Supabase store + scripted Google fetch)
//  - Static security            (import graph, no token logging, no
//                               NEXT_PUBLIC in the new routes)
//
// Run with:
//   TZ='Asia/Kolkata' node --test --import ./tests/hooks.mjs tests/google_sync.test.mjs
//
// NOTE: eventSync.ts -> lib/google/server.ts imports `next/server`, which is
// not resolvable under plain node. tests/resolve-next-server-stub.mjs maps it
// to a minimal stub; it is registered here (before the dynamic import below)
// so the test file stays self-contained and the shared tests/hooks.mjs is
// untouched. The stub only satisfies the import binding — no NextResponse
// method is ever called.
import { register } from "node:module";
register(new URL("./resolve-next-server-stub.mjs", import.meta.url).href);

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Deterministic test key for the AES-256-GCM token vault (64 hex chars).
process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = "ab".repeat(32);

import {
  googleEventToLocal,
  isAllDayGoogleEvent,
  localEventToGoogle,
} from "../lib/google/eventMapping";
import {
  createEvent,
  deleteEvent,
  getEvent,
  GoogleApiError,
  GoogleAuthError,
  GoogleConflictError,
  GoogleNotFoundError,
  listEvents,
  SyncTokenInvalidError,
  updateEvent,
} from "../lib/google/googleApi";
import { encryptToken } from "../lib/google/tokenVault";

// Dynamic: the next/server stub above must be registered first.
const { NotConnectedError, RevokedError, runGoogleSync } = await import(
  "../lib/google/eventSync"
);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const READ_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.events";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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
  return {
    date: `${v("year")}-${v("month")}-${v("day")}`,
    time: `${hour}:${v("minute")}`,
  };
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

// ---------------------------------------------------------------------------
// Fake in-memory Supabase client
// ---------------------------------------------------------------------------
// Implements exactly the query-builder chain surface that
// lib/google/eventSync.ts uses:
//   from().select/insert/update/delete/upsert
//   .eq / .not("is") / .is / .in / .order / .limit / .single / .maybeSingle
// Every read/write applies the filters it is given, so the owner's
// `.eq("owner", userId)` scoping behaves like the real client.

let __seq = 0;
function fakeId(prefix) {
  __seq += 1;
  return `${prefix}-fake-${__seq}`;
}

class FakeBuilder {
  constructor(rows, table) {
    this._rows = rows;
    this._table = table;
    this._op = null;
    this._arg = undefined;
    this._filters = [];
    this._order = null;
    this._limit = null;
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
  _finishSelect(rows) {
    let out = rows;
    if (this._order) {
      const { col, ascending } = this._order;
      out = [...out].sort((a, b) => {
        const av = a[col];
        const bv = b[col];
        if (av === bv) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        return (av < bv ? -1 : 1) * (ascending ? 1 : -1);
      });
    }
    if (this._limit != null) out = out.slice(0, this._limit);
    if (this._single === "single") {
      return out.length > 0
        ? { data: out[0], error: null }
        : { data: null, error: new Error("fake: no rows") };
    }
    if (this._single === "maybe") return { data: out[0] ?? null, error: null };
    return { data: out, error: null };
  }
  _execute() {
    const op = this._op ?? "select";
    if (op === "select") return this._finishSelect(this._matches());
    if (op === "insert") {
      const row = { ...this._arg };
      if (row.id == null) row.id = fakeId(this._table);
      // Insert timestamps sit slightly in the past so a freshly imported row
      // is never seen as "locally modified" by the push phase's
      // `updated_at > last_synced_at` check (deterministic, no Date mocking).
      const t = new Date(Date.now() - 1000).toISOString();
      if (row.created_at == null) row.created_at = t;
      if (row.updated_at == null) row.updated_at = t;
      this._rows.push(row);
      return this._finishSelect([row]);
    }
    if (op === "upsert") {
      const row = { ...this._arg };
      // Only caller: google_calendar_sync_state, onConflict owner,google_calendar_id.
      const existing = this._rows.find(
        (r) =>
          r.owner === row.owner && r.google_calendar_id === row.google_calendar_id
      );
      if (existing) Object.assign(existing, row);
      else {
        if (row.id == null) row.id = fakeId(this._table);
        this._rows.push(row);
      }
      return { data: null, error: null };
    }
    if (op === "update") {
      for (const r of this._matches()) Object.assign(r, this._arg);
      return { data: null, error: null };
    }
    if (op === "delete") {
      const doomed = new Set(this._matches());
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

// ---------------------------------------------------------------------------
// Scripted Google Calendar API mock (injected fetchImpl)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Sync-scenario fixtures
// ---------------------------------------------------------------------------

const USER_A = "user-a";
const USER_B = "user-b";
const CAL_1 = "cal-1";
const GACCT = "gacct-1";
const T0 = "2026-09-01T00:00:00.000Z";
const T1 = "2026-09-02T00:00:00.000Z";
const T2 = "2026-09-03T00:00:00.000Z";

function seedConnection(store, { owner = USER_A, scopes = [READ_SCOPE, WRITE_SCOPE] } = {}) {
  const conn = {
    id: fakeId("conn"),
    owner,
    google_account_id: GACCT,
    email: `${owner}@example.com`,
    status: "connected",
    refresh_token_enc: null,
    access_token_enc: encryptToken(`access-token-for-${owner}`),
    token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    scopes,
    created_at: T0,
    updated_at: T0,
  };
  store.google_calendar_connections.push(conn);
  store.google_calendar_selections.push({
    id: fakeId("sel"),
    owner,
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

function seedLocal(store, owner, fields = {}) {
  const row = {
    id: fakeId("local"),
    owner,
    title: "Untitled",
    event_date: "2026-10-05",
    start_time: "09:00",
    end_time: "10:00",
    notes: null,
    created_at: T0,
    updated_at: T0,
    ...fields,
  };
  store.calendar_events.push(row);
  return row;
}

function seedMapping(store, owner, fields = {}) {
  const row = {
    id: fakeId("map"),
    owner,
    local_event_id: null,
    google_account_id: GACCT,
    google_calendar_id: CAL_1,
    google_event_id: null,
    google_etag: null,
    origin: "google",
    google_timezone: null,
    recurrence: null,
    last_synced_at: null,
    created_at: T0,
    updated_at: T0,
    ...fields,
  };
  store.google_event_mappings.push(row);
  return row;
}

function seedSyncState(store, owner, syncToken) {
  const row = {
    id: fakeId("state"),
    owner,
    google_account_id: GACCT,
    google_calendar_id: CAL_1,
    sync_token: syncToken,
    last_synced_at: T0,
    created_at: T0,
    updated_at: T0,
  };
  store.google_calendar_sync_state.push(row);
  return row;
}

function gTimed(id, etag, summary, startIso, endIso, extra = {}) {
  return {
    id,
    etag,
    summary,
    status: "confirmed",
    start: { dateTime: startIso },
    end: { dateTime: endIso },
    ...extra,
  };
}

function gAllDay(id, etag, summary, date, endDate = null) {
  return {
    id,
    etag,
    summary,
    status: "confirmed",
    start: { date },
    // Google's end.date is EXCLUSIVE: a single-day event on `date` carries
    // end.date = date + 1.
    end: { date: endDate ?? date },
  };
}

function runSync(store, google, { userId = USER_A, timeZone = "Asia/Kolkata" } = {}) {
  return runGoogleSync({
    supabase: makeSupabase(store),
    userId,
    timeZone,
    fetchImpl: google.fetchImpl,
  });
}

function googleBody(summary) {
  return {
    summary,
    start: { dateTime: "2026-10-05T09:30:00", timeZone: "Asia/Kolkata" },
    end: { dateTime: "2026-10-05T10:30:00", timeZone: "Asia/Kolkata" },
  };
}

// ---------------------------------------------------------------------------
// A. Pure mapping (lib/google/eventMapping.ts, plain node)
// ---------------------------------------------------------------------------

test("mapping A1: timed event converts to the target zone wall-clock", () => {
  const tz = "Asia/Kolkata";
  const d = googleEventToLocal(
    {
      summary: "Yoga",
      start: { dateTime: "2026-10-05T04:00:00Z" },
      end: { dateTime: "2026-10-05T05:30:00Z" },
    },
    tz
  );
  const s = wallClock("2026-10-05T04:00:00Z", tz);
  const e = wallClock("2026-10-05T05:30:00Z", tz);
  assert.equal(d.title, "Yoga");
  assert.equal(d.event_date, s.date);
  assert.equal(d.start_time, s.time);
  assert.equal(d.end_time, e.time);
  // Sanity on the known answer (IST is UTC+5:30, no DST): 04:00Z -> 09:30.
  assert.equal(s.date, "2026-10-05");
  assert.equal(s.time, "09:30");
  assert.equal(e.time, "11:00");
});

test("mapping A2: event crossing midnight in the target zone rolls the date", () => {
  const tz = "Asia/Kolkata";
  const d = googleEventToLocal(
    {
      summary: "Late call",
      start: { dateTime: "2026-10-04T22:00:00Z" }, // 03:30 IST next day
      end: { dateTime: "2026-10-04T23:30:00Z" }, // 05:00 IST next day
    },
    tz
  );
  const s = wallClock("2026-10-04T22:00:00Z", tz);
  assert.equal(d.event_date, s.date);
  assert.equal(d.start_time, s.time);
  assert.equal(d.event_date, "2026-10-05", "date rolled past midnight");
  assert.equal(d.start_time, "03:30");
  assert.equal(d.end_time, "05:00");
});

test("mapping A3: all-day event becomes 00:00-23:59 on its date", () => {
  const g = { summary: "Diwali", start: { date: "2026-10-20" }, end: { date: "2026-10-21" } };
  assert.equal(isAllDayGoogleEvent(g), true);
  assert.equal(
    isAllDayGoogleEvent({ start: { dateTime: "2026-10-05T04:00:00Z" } }),
    false,
    "timed events are not all-day"
  );
  assert.equal(isAllDayGoogleEvent({}), false, "missing start is not all-day");
  const d = googleEventToLocal(g, "Asia/Kolkata");
  assert.equal(d.event_date, "2026-10-20");
  assert.equal(d.start_time, "00:00");
  assert.equal(d.end_time, "23:59");
  assert.equal(d.is_all_day, true, "all-day semantics retained on the draft");
});

test("mapping A4: title/notes truncation, missing summary, missing notes", () => {
  const timed = {
    start: { dateTime: "2026-10-05T04:00:00Z" },
    end: { dateTime: "2026-10-05T05:00:00Z" },
  };
  const d = googleEventToLocal(
    { ...timed, summary: "t".repeat(250), description: "n".repeat(2500) },
    "Asia/Kolkata"
  );
  assert.equal(d.title.length, 200, "title truncated to 200 chars");
  assert.equal(d.notes.length, 2000, "notes truncated to 2000 chars");
  const d2 = googleEventToLocal({ ...timed }, "Asia/Kolkata");
  assert.equal(d2.title, "(No title)", "missing summary falls back");
  assert.equal(d2.notes, null, "missing description -> null notes");
  const d3 = googleEventToLocal({ ...timed, summary: "" }, "Asia/Kolkata");
  assert.equal(d3.title, "(No title)", "empty summary falls back");
});

test("mapping A5: end<=start clamps to start+30m so start_time < end_time holds", () => {
  const bad = {
    summary: "Broken",
    start: { dateTime: "2026-10-05T04:00:00Z" }, // 09:30 IST
    end: { dateTime: "2026-10-05T03:00:00Z" }, // 08:30 IST — before start
  };
  const d = googleEventToLocal(bad, "Asia/Kolkata");
  assert.equal(d.event_date, "2026-10-05", "row stays single-day");
  assert.equal(d.start_time, "09:30");
  assert.equal(d.end_time, "10:00", "clamped to start + 30 minutes");
  assert.ok(d.start_time < d.end_time, "CHECK(start_time < end_time) holds");
  const zero = googleEventToLocal(
    {
      summary: "Zero",
      start: { dateTime: "2026-10-05T04:00:00Z" },
      end: { dateTime: "2026-10-05T04:00:00Z" },
    },
    "Asia/Kolkata"
  );
  assert.equal(zero.start_time, "09:30");
  assert.equal(zero.end_time, "10:00");
});

test("mapping A6: localEventToGoogle emits wall-clock + timeZone; round-trip preserves wall-clock", () => {
  const local = {
    title: "Study",
    event_date: "2026-10-05",
    start_time: "09:30",
    end_time: "10:30",
    notes: "Ch 5",
  };
  const body = localEventToGoogle(local, "Asia/Kolkata");
  assert.equal(body.summary, "Study");
  assert.equal(body.start.dateTime, "2026-10-05T09:30:00");
  assert.equal(body.start.timeZone, "Asia/Kolkata");
  assert.equal(body.end.dateTime, "2026-10-05T10:30:00");
  assert.equal(body.end.timeZone, "Asia/Kolkata");
  assert.equal(body.description, "Ch 5");
  const noNotes = localEventToGoogle({ ...local, notes: null }, "Asia/Kolkata");
  assert.ok(!("description" in noNotes), "null notes -> no description key");
  // Round-trip: Google returns the instant with its zone offset; the
  // wall-clock the user entered must survive.
  const back = googleEventToLocal(
    {
      summary: "Study",
      start: { dateTime: "2026-10-05T09:30:00+05:30" },
      end: { dateTime: "2026-10-05T10:30:00+05:30" },
    },
    "Asia/Kolkata"
  );
  assert.equal(back.event_date, "2026-10-05");
  assert.equal(back.start_time, "09:30");
  assert.equal(back.end_time, "10:30");
});

// ---------------------------------------------------------------------------
// B. googleApi.ts with injected fetch mock
// ---------------------------------------------------------------------------

test("api B1: listEvents builds correct URL params with a sync token", async () => {
  const g = makeGoogle();
  g.onList(({ params }) => {
    assert.equal(params.get("singleEvents"), "false");
    assert.equal(params.get("showDeleted"), "true");
    assert.equal(params.get("maxResults"), "250");
    assert.equal(params.get("syncToken"), "st-1");
    assert.equal(params.get("pageToken"), "p-1");
    assert.equal(params.get("timeMin"), null, "syncToken excludes timeMin");
    assert.equal(params.get("timeMax"), null, "syncToken excludes timeMax");
    return jsonRes(200, { items: [], nextSyncToken: "tok" });
  });
  const res = await listEvents(g.fetchImpl, "tok", "cal-9", {
    syncToken: "st-1",
    pageToken: "p-1",
  });
  assert.deepEqual(res.items, []);
  assert.equal(res.nextSyncToken, "tok");
  assert.ok(
    g.calls[0].headers.Authorization === "Bearer tok",
    "bearer auth header sent"
  );
});

test("api B2: listEvents sends timeMin/timeMax (and encodes the id) without a sync token", async () => {
  const g = makeGoogle();
  g.onList(({ params }) => {
    assert.equal(params.get("timeMin"), "2026-01-01T00:00:00.000Z");
    assert.equal(params.get("timeMax"), "2026-12-31T00:00:00.000Z");
    assert.equal(params.get("syncToken"), null);
    return jsonRes(200, { items: [{ id: "x" }] });
  });
  const res = await listEvents(g.fetchImpl, "tok", "my cal/id", {
    timeMin: "2026-01-01T00:00:00.000Z",
    timeMax: "2026-12-31T00:00:00.000Z",
  });
  assert.equal(res.items.length, 1);
  assert.ok(g.calls[0].url.includes("my%20cal%2Fid"), "calendar id is encoded");
});

test("api B3: 410 -> SyncTokenInvalidError, 401 -> GoogleAuthError", async () => {
  const g410 = makeGoogle();
  g410.onList(() => jsonRes(410, { error: { code: 410 } }));
  await assert.rejects(listEvents(g410.fetchImpl, "tok", "cal"), SyncTokenInvalidError);

  const g401 = makeGoogle();
  g401.onList(() => jsonRes(401, { error: { code: 401 } }));
  await assert.rejects(listEvents(g401.fetchImpl, "tok", "cal"), GoogleAuthError);
});

test("api B4: 429 retries exactly once, then throws GoogleApiError", async () => {
  const g = makeGoogle();
  g.onList(() => jsonRes(429, {}));
  await assert.rejects(
    listEvents(g.fetchImpl, "tok", "cal"),
    (err) => {
      assert.ok(err instanceof GoogleApiError);
      assert.equal(err.status, 429);
      return true;
    }
  );
  assert.equal(g.calls.length, 2, "one retry, then give up");
});

test("api B5: 429 then 200 succeeds on the retry", async () => {
  const g = makeGoogle();
  let n = 0;
  g.onList(() =>
    ++n === 1
      ? jsonRes(429, {})
      : jsonRes(200, { items: [{ id: "a" }], nextSyncToken: "t" })
  );
  const res = await listEvents(g.fetchImpl, "tok", "cal");
  assert.equal(res.items.length, 1);
  assert.equal(g.calls.length, 2);
});

test("api B6: updateEvent sends If-Match when an etag is given; 412 -> GoogleConflictError", async () => {
  const g = makeGoogle();
  g.onEvent("PUT", "ev-1", ({ headers }) => {
    assert.equal(headers["If-Match"], "etag-1");
    return jsonRes(412, { error: { code: 412 } });
  });
  await assert.rejects(
    updateEvent(g.fetchImpl, "tok", "cal", "ev-1", googleBody("x"), "etag-1"),
    GoogleConflictError
  );
});

test("api B7: updateEvent without an etag sends no If-Match", async () => {
  const g = makeGoogle();
  g.onEvent("PUT", "ev-1", ({ headers, body }) => {
    assert.equal(headers["If-Match"], undefined, "no If-Match without etag");
    assert.equal(body.summary, "renamed");
    assert.equal(body.start.timeZone, "Asia/Kolkata");
    return jsonRes(200, { id: "ev-1", etag: "etag-2" });
  });
  const res = await updateEvent(g.fetchImpl, "tok", "cal", "ev-1", googleBody("renamed"));
  assert.deepEqual(res, { id: "ev-1", etag: "etag-2" });
});

test("api B8: deleteEvent treats 404 as success", async () => {
  const g = makeGoogle();
  g.onEvent("DELETE", "ev-gone", () => jsonRes(404, {}));
  await deleteEvent(g.fetchImpl, "tok", "cal", "ev-gone"); // must not throw
  assert.equal(g.calls[0].method, "DELETE");
  assert.ok(g.calls[0].url.endsWith("/events/ev-gone"));
});

test("api B9: createEvent posts JSON and returns the new id/etag", async () => {
  const g = makeGoogle();
  g.onEvent("POST", "", ({ headers, body }) => {
    assert.equal(headers["Content-Type"], "application/json");
    assert.ok(headers.Authorization.startsWith("Bearer "));
    assert.equal(body.summary, "Brand new");
    return jsonRes(200, { id: "new-id", etag: "e0" });
  });
  const res = await createEvent(g.fetchImpl, "tok", "cal", googleBody("Brand new"));
  assert.deepEqual(res, { id: "new-id", etag: "e0" });
  assert.ok(g.calls[0].url.endsWith("/events"), "insert posts to the collection");
});

test("api B10: getEvent 404 -> GoogleNotFoundError", async () => {
  const g = makeGoogle();
  g.onEvent("GET", "ev-x", () => jsonRes(404, {}));
  await assert.rejects(getEvent(g.fetchImpl, "tok", "cal", "ev-x"), GoogleNotFoundError);
});

// ---------------------------------------------------------------------------
// C. runGoogleSync with a fake in-memory store + scripted Google fetch
// ---------------------------------------------------------------------------

test("sync: throws NotConnectedError when no connection exists", async () => {
  const store = makeStore();
  const g = makeGoogle();
  await assert.rejects(runSync(store, g), NotConnectedError);
  assert.equal(g.calls.length, 0, "no Google calls before failing fast");
});

test("sync: throws RevokedError when the connection is revoked", async () => {
  const store = makeStore();
  const conn = seedConnection(store);
  conn.status = "revoked";
  const g = makeGoogle();
  await assert.rejects(runSync(store, g), RevokedError);
});

test("sync: throws on an invalid timeZone before any I/O", async () => {
  const store = makeStore();
  seedConnection(store);
  const g = makeGoogle();
  await assert.rejects(runSync(store, g, { timeZone: "Not/AZone" }), /Invalid timeZone/);
  assert.equal(g.calls.length, 0, "no Google calls with a bad zone");
});

test("sync C1: initial import creates local events + mappings, stores the sync token", async () => {
  const store = makeStore();
  seedConnection(store);
  const g = makeGoogle();
  g.onList(() =>
    jsonRes(200, {
      items: [
        gTimed(
          "gev-1",
          "e1",
          "Yoga class",
          "2026-10-05T04:00:00Z",
          "2026-10-05T05:00:00Z",
          {
            description: "Bring a mat",
            start: {
              dateTime: "2026-10-05T04:00:00Z",
              timeZone: "America/New_York",
            },
            end: {
              dateTime: "2026-10-05T05:00:00Z",
              timeZone: "America/New_York",
            },
          }
        ),
        gAllDay("gev-2", "e2", "Diwali", "2026-10-20", "2026-10-21"),
      ],
      nextSyncToken: "tok-1",
    })
  );
  const res = await runSync(store, g);

  assert.equal(res.imported, 2);
  assert.equal(res.updated, 0);
  assert.equal(res.deleted, 0);
  assert.equal(res.pushed, 0);
  assert.equal(res.writeBlocked, false);
  assert.deepEqual(res.calendars, [{ calendarId: CAL_1, ok: true }]);

  const listCall = g.calls.find((c) => c.method === "GET");
  assert.ok(listCall.params.get("timeMin"), "initial sync uses the window");
  assert.equal(listCall.params.get("syncToken"), null, "no token on first sync");

  const yoga = store.calendar_events.find((e) => e.title === "Yoga class");
  assert.ok(yoga, "timed event imported");
  assert.equal(yoga.owner, USER_A);
  assert.equal(yoga.event_date, "2026-10-05");
  assert.equal(yoga.start_time, "09:30");
  assert.equal(yoga.end_time, "10:30");
  assert.equal(yoga.notes, "Bring a mat");

  const diwali = store.calendar_events.find((e) => e.title === "Diwali");
  assert.ok(diwali, "all-day event imported");
  assert.equal(diwali.event_date, "2026-10-20");
  assert.equal(diwali.start_time, "00:00");
  assert.equal(diwali.end_time, "23:59");
  assert.equal(diwali.is_all_day, true, "all-day flag set on the local row");

  assert.equal(store.google_event_mappings.length, 2);
  for (const m of store.google_event_mappings) {
    assert.equal(m.owner, USER_A);
    assert.equal(m.origin, "google", "imports are Google-origin");
    assert.ok(m.local_event_id, "linked to the local row");
    assert.ok(m.google_event_id, "linked to the Google event");
    assert.ok(m.last_synced_at, "last_synced_at stamped");
  }
  const map1 = store.google_event_mappings.find((m) => m.google_event_id === "gev-1");
  assert.equal(map1.google_etag, "e1");
  assert.equal(map1.local_event_id, yoga.id);
  // The mapping preserves the GOOGLE event's timezone — never the display zone.
  assert.equal(map1.google_timezone, "America/New_York");
  assert.equal(map1.google_end_timezone, null, "same start/end zone");
  assert.equal(map1.google_start_date, null, "timed events carry no all-day dates");
  assert.equal(map1.google_end_date, null);
  const map2 = store.google_event_mappings.find((m) => m.google_event_id === "gev-2");
  assert.equal(map2.google_timezone, null, "all-day events have no timezone");
  assert.equal(map2.google_start_date, "2026-10-20");
  assert.equal(
    map2.google_end_date,
    "2026-10-21",
    "all-day exclusive end date preserved"
  );

  assert.equal(store.google_calendar_sync_state.length, 1);
  assert.equal(store.google_calendar_sync_state[0].sync_token, "tok-1");
});

test("sync C2: second run with unchanged etags imports nothing (no duplicates)", async () => {
  const store = makeStore();
  seedConnection(store);
  const g = makeGoogle();
  g.onList(() =>
    jsonRes(200, {
      items: [gTimed("gev-1", "e1", "Yoga", "2026-10-05T04:00:00Z", "2026-10-05T05:00:00Z")],
      nextSyncToken: "tok-2",
    })
  );
  const first = await runSync(store, g);
  assert.equal(first.imported, 1);
  const second = await runSync(store, g);
  assert.equal(second.imported, 0);
  assert.equal(second.updated, 0);
  assert.equal(second.deleted, 0);
  assert.equal(store.calendar_events.length, 1, "no duplicate local row");
  assert.equal(store.google_event_mappings.length, 1, "no duplicate mapping");
  const getCalls = g.calls.filter((c) => c.method === "GET");
  assert.equal(getCalls.length, 2);
  assert.equal(getCalls[1].params.get("syncToken"), "tok-2", "stored token reused");
});

test("sync C3: Google-side edit (etag changed, local untouched) updates the local event", async () => {
  const store = makeStore();
  seedConnection(store);
  const local = seedLocal(store, USER_A, {
    title: "Yoga",
    event_date: "2026-10-05",
    start_time: "09:30",
    end_time: "10:30",
    updated_at: T1,
  });
  seedMapping(store, USER_A, {
    local_event_id: local.id,
    google_event_id: "gev-1",
    google_etag: "e1",
    origin: "google",
    last_synced_at: T1,
    google_timezone: "Asia/Kolkata",
  });
  const g = makeGoogle();
  g.onList(() =>
    jsonRes(200, {
      items: [
        gTimed("gev-1", "e2", "Yoga (rescheduled)", "2026-10-05T05:00:00Z", "2026-10-05T06:00:00Z"),
      ],
      nextSyncToken: "tok-9",
    })
  );
  const res = await runSync(store, g);
  assert.equal(res.updated, 1);
  assert.deepEqual(res.conflicts, [], "no conflict when only Google changed");
  const after = store.calendar_events.find((e) => e.id === local.id);
  assert.equal(after.title, "Yoga (rescheduled)");
  assert.equal(after.start_time, "10:30", "05:00Z in Asia/Kolkata");
  assert.equal(after.end_time, "11:30");
  assert.equal(store.google_event_mappings[0].google_etag, "e2", "new etag stored");
});

test("sync C4: cancelled Google event deletes the untouched local copy; tombstone is not re-imported", async () => {
  const store = makeStore();
  seedConnection(store);
  const local = seedLocal(store, USER_A, { title: "Yoga", updated_at: T1 });
  seedMapping(store, USER_A, {
    local_event_id: local.id,
    google_event_id: "gev-1",
    google_etag: "e1",
    origin: "google",
    last_synced_at: T1,
  });
  const g = makeGoogle();
  g.onList(() =>
    jsonRes(200, { items: [{ id: "gev-1", status: "cancelled" }], nextSyncToken: "tok-9" })
  );
  const first = await runSync(store, g);
  assert.equal(first.deleted, 1);
  assert.equal(store.calendar_events.length, 0, "local row deleted");
  assert.equal(
    store.google_event_mappings[0].local_event_id,
    null,
    "mapping tombstoned"
  );
  // A later sync must not re-import the cancelled event.
  const second = await runSync(store, g);
  assert.equal(second.imported, 0);
  assert.equal(second.deleted, 0);
  assert.equal(store.calendar_events.length, 0);
  assert.equal(store.google_event_mappings[0].local_event_id, null);
});

test("sync C5: local event linked for sync (no Google id) is created on Google", async () => {
  const store = makeStore();
  seedConnection(store);
  const local = seedLocal(store, USER_A, {
    title: "Study",
    event_date: "2026-10-05",
    start_time: "09:30",
    end_time: "10:30",
    notes: "Ch 5",
    updated_at: T1,
  });
  const map = seedMapping(store, USER_A, {
    local_event_id: local.id,
    google_event_id: null,
    google_etag: null,
    origin: "synced",
    last_synced_at: T1,
    google_timezone: "Asia/Kolkata",
  });
  const g = makeGoogle();
  g.onList(() => jsonRes(200, { items: [], nextSyncToken: "tok-1" }));
  g.onEvent("POST", "", ({ calendarId }) => {
    assert.equal(calendarId, CAL_1, "created on the mapped calendar");
    return jsonRes(200, { id: "gev-new", etag: "e1" });
  });
  const res = await runSync(store, g);
  assert.equal(res.pushed, 1);
  const post = g.calls.find((c) => c.method === "POST");
  assert.ok(post, "events.insert called");
  assert.equal(post.body.summary, "Study");
  assert.equal(post.body.start.dateTime, "2026-10-05T09:30:00");
  assert.equal(post.body.start.timeZone, "Asia/Kolkata");
  assert.equal(post.body.end.dateTime, "2026-10-05T10:30:00");
  assert.equal(post.body.description, "Ch 5");
  const afterMap = store.google_event_mappings.find((m) => m.id === map.id);
  assert.equal(afterMap.google_event_id, "gev-new", "mapping linked to the new Google id");
  assert.equal(afterMap.google_etag, "e1");
});

test("sync C6: locally edited event is pushed with If-Match", async () => {
  const store = makeStore();
  seedConnection(store);
  const local = seedLocal(store, USER_A, {
    title: "Yoga edited",
    event_date: "2026-10-05",
    start_time: "09:30",
    end_time: "10:30",
    updated_at: T2, // edited after the last sync
  });
  const map = seedMapping(store, USER_A, {
    local_event_id: local.id,
    google_event_id: "gev-6",
    google_etag: "e-old",
    origin: "google",
    last_synced_at: T1,
    google_timezone: "Asia/Kolkata",
  });
  const g = makeGoogle();
  g.onList(() =>
    jsonRes(200, {
      items: [gTimed("gev-6", "e-old", "Yoga", "2026-10-05T04:00:00Z", "2026-10-05T05:00:00Z")],
      nextSyncToken: "tok-1",
    })
  );
  g.onEvent("PUT", "gev-6", ({ headers }) => {
    assert.equal(headers["If-Match"], "e-old", "push is conditional on the last-known etag");
    return jsonRes(200, { id: "gev-6", etag: "e-new" });
  });
  const res = await runSync(store, g);
  assert.equal(res.pushed, 1);
  assert.deepEqual(res.conflicts, []);
  const put = g.calls.find((c) => c.method === "PUT");
  assert.ok(put, "events.update called");
  assert.equal(put.body.summary, "Yoga edited");
  const afterMap = store.google_event_mappings.find((m) => m.id === map.id);
  assert.equal(afterMap.google_etag, "e-new", "new etag stored");
});

test("sync C7: deleted local event (origin synced) deletes the Google copy and drops the mapping", async () => {
  const store = makeStore();
  seedConnection(store);
  const map = seedMapping(store, USER_A, {
    local_event_id: "local-gone", // user deleted the local row
    google_event_id: "gev-7",
    google_etag: "e7",
    origin: "synced",
    last_synced_at: T1,
  });
  const g = makeGoogle();
  g.onList(() =>
    jsonRes(200, {
      items: [gTimed("gev-7", "e7", "Gone", "2026-10-05T04:00:00Z", "2026-10-05T05:00:00Z")],
      nextSyncToken: "tok-1",
    })
  );
  g.onEvent("DELETE", "gev-7", () => jsonRes(204, {}));
  const res = await runSync(store, g);
  assert.equal(res.deleted, 1);
  const del = g.calls.find((c) => c.method === "DELETE");
  assert.ok(del, "events.delete called on Google");
  assert.ok(del.url.includes("/events/gev-7"));
  assert.equal(store.google_event_mappings.length, 0, "tombstone mapping removed");
});

test("sync C8: local copy of a Google-origin event deleted by the user — Google copy never deleted, never re-imported", async () => {
  const store = makeStore();
  seedConnection(store);
  const map = seedMapping(store, USER_A, {
    local_event_id: "gone-8",
    google_event_id: "gev-8",
    google_etag: "e8",
    origin: "google",
    last_synced_at: T1,
  });
  const g = makeGoogle();
  g.onList(() =>
    jsonRes(200, {
      items: [gTimed("gev-8", "e8", "Real event", "2026-10-05T04:00:00Z", "2026-10-05T05:00:00Z")],
      nextSyncToken: "tok-1",
    })
  );
  const first = await runSync(store, g);
  assert.equal(first.deleted, 0);
  assert.ok(!g.calls.some((c) => c.method === "DELETE"), "user's real Google event never deleted");
  const tomb = store.google_event_mappings.find((m) => m.id === map.id);
  assert.ok(tomb, "mapping row kept");
  assert.equal(tomb.local_event_id, null, "mapping tombstoned");
  const second = await runSync(store, g);
  assert.equal(second.imported, 0, "tombstoned Google event is not re-imported");
  assert.equal(store.calendar_events.length, 0);
  assert.ok(!g.calls.some((c) => c.method === "DELETE"));
});

test("sync C9: Google changed AND local edited — Google wins locally, conflict logged", async () => {
  const store = makeStore();
  seedConnection(store);
  const local = seedLocal(store, USER_A, {
    title: "Local title",
    event_date: "2026-10-05",
    start_time: "09:30",
    end_time: "10:30",
    updated_at: T2, // edited after the last sync
  });
  seedMapping(store, USER_A, {
    local_event_id: local.id,
    google_event_id: "gev-9",
    google_etag: "e-old",
    origin: "google",
    last_synced_at: T1,
    google_timezone: "Asia/Kolkata",
  });
  const g = makeGoogle();
  g.onList(() =>
    jsonRes(200, {
      items: [gTimed("gev-9", "e-new", "Google title", "2026-10-05T06:00:00Z", "2026-10-05T07:00:00Z")],
      nextSyncToken: "tok-1",
    })
  );
  const res = await runSync(store, g);
  assert.equal(res.updated, 1);
  assert.equal(res.conflicts.length, 1);
  assert.equal(res.conflicts[0].reason, "both-changed-google-kept");
  assert.equal(res.conflicts[0].localEventId, local.id);
  const after = store.calendar_events.find((e) => e.id === local.id);
  assert.equal(after.title, "Google title", "Google version applied locally");
  assert.equal(after.start_time, "11:30", "06:00Z in Asia/Kolkata");
});

test("sync C10: push hits 412 — Google version applied locally, conflict logged", async () => {
  const store = makeStore();
  seedConnection(store);
  const local = seedLocal(store, USER_A, {
    title: "Local edit",
    event_date: "2026-10-05",
    start_time: "09:30",
    end_time: "10:30",
    updated_at: T2, // edited after the last sync
  });
  seedMapping(store, USER_A, {
    local_event_id: local.id,
    google_event_id: "gev-10",
    google_etag: "e-old",
    origin: "google",
    last_synced_at: T1,
    google_timezone: "Asia/Kolkata",
  });
  const g = makeGoogle();
  g.onList(() =>
    jsonRes(200, {
      items: [gTimed("gev-10", "e-old", "Google v1", "2026-10-05T04:00:00Z", "2026-10-05T05:00:00Z")],
      nextSyncToken: "tok-1",
    })
  );
  g.onEvent("PUT", "gev-10", () => jsonRes(412, { error: { code: 412 } }));
  g.onEvent("GET", "gev-10", () =>
    jsonRes(200, gTimed("gev-10", "e-new", "Google v2", "2026-10-05T08:00:00Z", "2026-10-05T09:00:00Z"))
  );
  const res = await runSync(store, g);
  assert.equal(res.updated, 1);
  assert.equal(res.pushed, 0, "the push did not land");
  assert.equal(res.conflicts.length, 1);
  assert.equal(res.conflicts[0].reason, "both-changed-google-kept");
  const after = store.calendar_events.find((e) => e.id === local.id);
  assert.equal(after.title, "Google v2", "latest Google version applied");
  assert.equal(after.start_time, "13:30", "08:00Z in Asia/Kolkata");
  assert.equal(store.google_event_mappings[0].google_etag, "e-new");
});

test("sync C11: paginated list is fully consumed, single nextSyncToken stored", async () => {
  const store = makeStore();
  seedConnection(store);
  const g = makeGoogle();
  let n = 0;
  g.onList(({ params }) => {
    n += 1;
    if (n === 1) {
      assert.equal(params.get("pageToken"), null, "first page has no pageToken");
      return jsonRes(200, {
        items: [gTimed("gev-a", "ea", "A", "2026-10-05T04:00:00Z", "2026-10-05T05:00:00Z")],
        nextPageToken: "p2",
      });
    }
    assert.equal(params.get("pageToken"), "p2", "second page follows the token");
    return jsonRes(200, {
      items: [gTimed("gev-b", "eb", "B", "2026-10-06T04:00:00Z", "2026-10-06T05:00:00Z")],
      nextSyncToken: "tok-final",
    });
  });
  const res = await runSync(store, g);
  assert.equal(res.imported, 2, "both pages consumed");
  assert.equal(g.calls.filter((c) => c.method === "GET").length, 2);
  assert.equal(store.google_calendar_sync_state[0].sync_token, "tok-final");
});

test("sync C12: 410 on the stored token triggers a full resync and the new token is stored", async () => {
  const store = makeStore();
  seedConnection(store);
  seedSyncState(store, USER_A, "dead-token");
  const g = makeGoogle();
  g.onList(({ params }) => {
    if (params.get("syncToken") === "dead-token") {
      return jsonRes(410, { error: { code: 410 } });
    }
    assert.equal(params.get("syncToken"), null, "resync drops the dead token");
    assert.ok(params.get("timeMin"), "resync uses the initial window");
    assert.ok(params.get("timeMax"));
    return jsonRes(200, {
      items: [gTimed("gev-1", "e1", "Yoga", "2026-10-05T04:00:00Z", "2026-10-05T05:00:00Z")],
      nextSyncToken: "tok-new",
    });
  });
  const res = await runSync(store, g);
  assert.equal(res.imported, 1);
  assert.equal(store.google_calendar_sync_state[0].sync_token, "tok-new");
});

test("sync C13: without the calendar.events scope, Google->app runs but app->Google is skipped", async () => {
  const store = makeStore();
  seedConnection(store, { scopes: [READ_SCOPE] });
  const local = seedLocal(store, USER_A, { title: "Local only", updated_at: T1 });
  seedMapping(store, USER_A, {
    local_event_id: local.id,
    google_event_id: null,
    origin: "synced",
    last_synced_at: T1,
  });
  const g = makeGoogle();
  g.onList(() =>
    jsonRes(200, {
      items: [gTimed("gev-1", "e1", "From Google", "2026-10-05T04:00:00Z", "2026-10-05T05:00:00Z")],
      nextSyncToken: "tok-1",
    })
  );
  const res = await runSync(store, g);
  assert.equal(res.writeBlocked, true);
  assert.equal(res.imported, 1, "Google->app still runs");
  assert.ok(
    !g.calls.some((c) => c.method === "POST" || c.method === "PUT" || c.method === "DELETE"),
    "no Google writes issued"
  );
  const map = store.google_event_mappings.find((m) => m.local_event_id === local.id);
  assert.equal(map.google_event_id, null, "local-only mapping left unpushed");
});

test("sync C14: another user's rows are never touched", async () => {
  const store = makeStore();
  seedConnection(store, { owner: USER_A });
  seedConnection(store, { owner: USER_B });
  const bLocal = seedLocal(store, USER_B, { title: "B event", updated_at: T1 });
  const bMap = seedMapping(store, USER_B, {
    local_event_id: bLocal.id,
    google_event_id: null,
    origin: "synced",
    last_synced_at: T1,
  });
  const g = makeGoogle();
  g.onList(() => jsonRes(200, { items: [], nextSyncToken: "tok-1" }));
  const res = await runSync(store, g, { userId: USER_A });
  assert.ok(!g.calls.some((c) => c.method !== "GET"), "no Google writes at all");
  assert.equal(res.pushed, 0);
  const bMapAfter = store.google_event_mappings.find((m) => m.id === bMap.id);
  assert.equal(bMapAfter.google_event_id, null, "B's mapping untouched");
  assert.equal(bMapAfter.local_event_id, bLocal.id, "B's link untouched");
  assert.equal(
    store.calendar_events.find((e) => e.id === bLocal.id).title,
    "B event",
    "B's event untouched"
  );
});

test("sync C15: display uses the sync timeZone, the mapping keeps the Google timezone", async () => {
  const store = makeStore();
  seedConnection(store);
  const g = makeGoogle();
  g.onList(() =>
    jsonRes(200, {
      items: [
        {
          id: "gev-1",
          etag: "e1",
          summary: "Midnight ET",
          status: "confirmed",
          // The event's own Google timezone: 00:00–01:00 America/New_York
          // (EDT, UTC-4 on 2026-10-05).
          start: { dateTime: "2026-10-05T04:00:00Z", timeZone: "America/New_York" },
          end: { dateTime: "2026-10-05T05:00:00Z", timeZone: "America/New_York" },
        },
      ],
      nextSyncToken: "tok-1",
    })
  );
  // Device is in Asia/Kolkata: local display follows the device zone...
  const res = await runSync(store, g, { timeZone: "Asia/Kolkata" });
  assert.equal(res.imported, 1);
  const ev = store.calendar_events[0];
  const s = wallClock("2026-10-05T04:00:00Z", "Asia/Kolkata");
  const e = wallClock("2026-10-05T05:00:00Z", "Asia/Kolkata");
  assert.equal(ev.event_date, s.date);
  assert.equal(ev.start_time, s.time);
  assert.equal(ev.end_time, e.time);
  assert.equal(s.time, "09:30", "04:00Z renders as 09:30 IST");
  // ...but the mapping preserves the GOOGLE timezone, not the display zone.
  assert.equal(
    store.google_event_mappings[0].google_timezone,
    "America/New_York"
  );
});

// ---------------------------------------------------------------------------
// D. Static security (source scans, following the tests/google.test.mjs convention)
// ---------------------------------------------------------------------------

function walkSource(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      walkSource(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function importSpecifiers(src) {
  const specs = [];
  for (const m of src.matchAll(/\bfrom\s+["']([^"']+)["']/g)) specs.push(m[1]);
  for (const m of src.matchAll(/\bimport\s+["']([^"']+)["']/g)) specs.push(m[1]);
  for (const m of src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) specs.push(m[1]);
  return specs;
}

/** True when an import specifier in `file` resolves into lib/google/. */
function specIsLibGoogleImport(file, spec) {
  let abs;
  if (spec.startsWith("@/")) {
    abs = join(ROOT, spec.slice(2).replace(/\.tsx?$/, ""));
  } else if (spec.startsWith(".")) {
    abs = resolve(dirname(file), spec.replace(/\.tsx?$/, ""));
  } else {
    return false;
  }
  const rel = relative(ROOT, abs).replace(/\\/g, "/");
  return rel === "lib/google" || rel.startsWith("lib/google/");
}

test("security D1: nothing under lib/calendar-providers/ or components/ imports lib/google/", () => {
  // The provider layer and UI must stay decoupled from the server-only
  // Google integration: no credential-adjacent code can leak client-side.
  const violations = [];
  for (const dir of [join(ROOT, "lib/calendar-providers"), join(ROOT, "components")]) {
    for (const file of walkSource(dir)) {
      const rel = relative(ROOT, file).replace(/\\/g, "/");
      for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
        if (specIsLibGoogleImport(file, spec)) {
          violations.push(`${rel} imports lib/google via "${spec}"`);
        }
      }
    }
  }
  assert.deepEqual(violations, [], "client-reachable code must not import lib/google");
});

test("security D2: sync and mappings routes never console.log (no token material in logs)", () => {
  for (const p of ["app/api/google/sync/route.ts", "app/api/google/mappings/route.ts"]) {
    const src = readFileSync(join(ROOT, p), "utf8");
    assert.ok(!src.includes("console."), `${p} must not log anything`);
  }
});

test("security D3: no NEXT_PUBLIC in the new Google routes", () => {
  for (const p of ["app/api/google/sync/route.ts", "app/api/google/mappings/route.ts"]) {
    const src = readFileSync(join(ROOT, p), "utf8");
    assert.ok(
      !src.includes("NEXT_PUBLIC"),
      `${p} must never read client-exposed env`
    );
  }
});
