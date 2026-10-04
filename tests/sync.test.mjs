// V4.2 offline-first sync tests: storage, isolation, offline writes, queue,
// sync, conflicts, tombstones, auth, logout/account-switching, auth expiry,
// failure recovery, and date/time boundaries. Deterministic: MemoryPort +
// MemoryRemote, plus real IndexedDB (fake-indexeddb) for the
// storage/persistence/restart tests.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { toDayKey, utcToDayKey } from "../lib/dates.ts";
import { challengeDayNumber } from "../lib/types.ts";

const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";

let ports, remote2, engine2, write2, types2;

async function load() {
  if (ports) return;
  ports = await import("../lib/sync/ports.ts");
  remote2 = await import("../lib/sync/remote.ts");
  engine2 = await import("../lib/sync/engine.ts");
  write2 = await import("../lib/sync/write.ts");
  types2 = await import("../lib/sync/types.ts");
}

function setup() {
  const port = new ports.MemoryPort();
  const remote = new remote2.MemoryRemote();
  remote.uniques.set("habit_logs", [["habit_id", "log_date"]]);
  remote.uniques.set("limit_logs", [["limit_id", "log_date"]]);
  remote.uniques.set("journal_entries", [["owner", "entry_date"]]);
  remote.uniques.set("training_schedule", [["owner", "weekday"]]);
  engine2.engine.testReset();
  engine2.engine.testInject(port, remote, USER_A);
  return { port, remote, db: write2.getDb() };
}

function cleanRow(row, dirty = 0) {
  return {
    ...row,
    _dirty: dirty,
    _deleted: 0,
    _local_created_at: "2026-01-01T00:00:00.000Z",
    _local_updated_at: "2026-01-01T00:00:00.000Z",
    _sync_error: null,
  };
}

async function mutations(port, status) {
  const all = await port.list("_mutations", {});
  return status ? all.filter((m) => m.status === status) : all;
}

beforeEach(async () => {
  await load();
});

// ---------------------------------------------------------------- storage

async function idbReady() {
  await import("fake-indexeddb/auto");
}

test("idb: initializes all stores and indexes", async () => {
  await idbReady();
  const { indexedDB } = await import("fake-indexeddb");
  const port = await ports.openIdbPort("test-schema-" + Date.now());
  // Write one row per entity store to prove every store exists and accepts puts.
  for (const t of types2.TABLES) {
    const row = t === "profiles" ? { id: USER_A } : { id: "x-" + t, owner: USER_A };
    await port.put(t, cleanRow(row));
  }
  for (const t of types2.TABLES) {
    assert.equal(await port.count(t, {}), 1, "store missing: " + t);
  }
  port.close();
  await new Promise((res) => {
    const req = indexedDB.deleteDatabase("test-schema-x");
    req.onsuccess = req.onerror = () => res();
  });
});

test("idb: indexed lookup, range query, and persistence across reopen", async () => {
  await idbReady();
  const { indexedDB } = await import("fake-indexeddb");
  const name = "test-persist-" + Date.now();
  const p1 = await ports.openIdbPort(name);
  await p1.put("habit_logs", cleanRow({ id: "hl1", owner: USER_A, habit_id: "h1", log_date: "2026-10-01" }));
  await p1.put("habit_logs", cleanRow({ id: "hl2", owner: USER_A, habit_id: "h1", log_date: "2026-10-03" }));
  await p1.put("tasks", cleanRow({ id: "t1", owner: USER_A, task_date: "2026-10-02", title: "x" }));
  // Compound unique index lookup.
  const found = await p1.getByIndex("habit_logs", "habit_id_log_date", ["h1", "2026-10-03"]);
  assert.equal(found?.id, "hl2");
  // Range query on indexed date column.
  const ranged = await p1.list("habit_logs", {
    gte: { log_date: "2026-10-02" },
    lte: { log_date: "2026-10-04" },
  });
  assert.deepEqual(ranged.map((r) => r.id), ["hl2"]);
  // Queue entry persists too.
  await p1.put("_mutations", { mutation_id: "m1", owner_id: USER_A, entity: "tasks", op: "insert", record_id: "t1", payload: {}, created_at: "2026-10-04T00:00:00Z", retry_count: 0, last_error: null, status: "pending", next_retry_at: null });
  p1.close();
  // Reopen: everything survives the "restart".
  const p2 = await ports.openIdbPort(name);
  assert.equal(await p2.count("habit_logs", {}), 2);
  assert.equal(await p2.count("_mutations", {}), 1);
  assert.equal((await p2.get("tasks", "t1"))?.title, "x");
  p2.close();
  await new Promise((res) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = req.onerror = () => res();
  });
});

test("idb: tombstones are hidden from list() unless requested", async () => {
  await idbReady();
  const { indexedDB } = await import("fake-indexeddb");
  const name = "test-tomb-" + Date.now();
  const p = await ports.openIdbPort(name);
  await p.put("tasks", cleanRow({ id: "t1", owner: USER_A, task_date: "2026-10-04" }));
  await p.put("tasks", { ...cleanRow({ id: "t2", owner: USER_A, task_date: "2026-10-04" }), _deleted: 1 });
  assert.equal(await p.count("tasks", {}), 1);
  assert.equal(await p.count("tasks", { includeDeleted: true }), 2);
  p.close();
  await new Promise((res) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = req.onerror = () => res();
  });
});

// ------------------------------------------------------------ user isolation

test("user isolation: B cannot see A's local data", async () => {
  const { port, db } = setup();
  await db.insert("tasks", { task_date: "2026-10-04", title: "A's task" });
  assert.equal(await db.count("tasks", {}), 1);
  // Switch to a separate per-user database for B.
  const portB = new ports.MemoryPort();
  const remoteB = new remote2.MemoryRemote();
  engine2.engine.testInject(portB, remoteB, USER_B);
  const dbB = write2.getDb();
  assert.equal(await dbB.count("tasks", {}), 0);
  assert.equal(await dbB.get("tasks", "whatever"), null);
});

test("user isolation: A's queued mutations are never executed as B", async () => {
  const { port, remote, db } = setup();
  await db.insert("tasks", { task_date: "2026-10-04", title: "A's task" });
  assert.equal((await mutations(port)).length, 1);
  // B takes over with the SAME port (shared device, account switch).
  engine2.engine.testInject(port, remote, USER_B);
  await engine2.engine.testSync();
  // Nothing synced: the mutation belongs to A, the session is B.
  assert.equal(remote.rows.get("tasks")?.size ?? 0, 0);
  assert.equal((await mutations(port, "pending")).length, 1);
});

test("logout closes the user database: getDb throws until next login", async () => {
  const { db } = setup();
  await db.insert("tasks", { task_date: "2026-10-04", title: "x" });
  await engine2.engine.handleLogout();
  assert.throws(() => write2.getDb(), /Not signed in/);
});

// ------------------------------------------------------------- offline writes

test("offline insert: stable client UUID, dirty flag, queued mutation", async () => {
  const { port, db } = setup();
  const row = await db.insert("tasks", { task_date: "2026-10-04", title: "Do it" });
  assert.match(row.id, /^[0-9a-f-]{36}$/);
  assert.equal(row.owner, USER_A, "owner auto-injected");
  assert.equal(row._dirty, 1);
  const [m] = await mutations(port);
  assert.equal(m.op, "insert");
  assert.equal(m.record_id, row.id, "mutation references the stable id");
  assert.equal(m.status, "pending");
});

test("offline update enqueues a patch; remove creates a tombstone", async () => {
  const { port, db } = setup();
  const row = await db.insert("tasks", { task_date: "2026-10-04", title: "Do it" });
  await port.remove("_mutations", (await mutations(port))[0].mutation_id); // isolate
  await db.update("tasks", row.id, { title: "Done it" });
  const [m] = await mutations(port);
  assert.equal(m.op, "update");
  assert.deepEqual(Object.keys(m.payload), ["title"]);
  await db.remove("tasks", row.id);
  assert.equal(await db.count("tasks", {}), 0, "tombstone hidden from list");
  assert.equal(await db.count("tasks", { includeDeleted: true }), 1);
  const ops = (await mutations(port)).map((x) => x.op).sort();
  assert.deepEqual(ops, ["delete", "update"]);
});

test("local delete guard mirrors V2.2: parent with history cannot be deleted", async () => {
  const { port, db } = setup();
  const w = await db.insert("workouts", { name: "HSPU" });
  await db.insert("workout_sessions", { workout_id: w.id, session_date: "2026-10-04", status: "completed" });
  await port.remove("_mutations", (await mutations(port))[0].mutation_id);
  await port.remove("_mutations", (await mutations(port))[0].mutation_id);
  await assert.rejects(() => db.remove("workouts", w.id), /Archive it instead of deleting/);
  assert.equal(await db.count("workouts", {}), 1, "row preserved");
});

// ------------------------------------------------------------------- queue

test("queue: transient failure schedules a retry; retry does not duplicate", async () => {
  const { port, remote, db } = setup();
  await db.insert("tasks", { task_date: "2026-10-04", title: "x" });
  remote.failNext = new TypeError("fetch failed");
  await engine2.engine.testSync();
  let [m] = await mutations(port);
  assert.equal(m.status, "pending");
  assert.equal(m.retry_count, 1);
  assert.ok(m.next_retry_at > new Date().toISOString(), "backoff scheduled");
  assert.equal(m.record_id, (await db.list("tasks"))[0].id, "same record id kept");
  // Fire the retry now.
  await port.put("_mutations", { ...m, next_retry_at: "2000-01-01T00:00:00.000Z" });
  await engine2.engine.testSync();
  assert.equal((await mutations(port)).length, 0);
  assert.equal(remote.rows.get("tasks")?.size, 1, "exactly one remote row");
});

test("queue: natural-key upsert is idempotent across retries", async () => {
  const { port, remote, db } = setup();
  const h = await db.insert("habits", { name: "Meditation" });
  await engine2.engine.testSync();
  await db.upsert(
    "habit_logs",
    { habit_id: h.id, log_date: "2026-10-04", status: "done" },
    { index: "habit_id_log_date", cols: ["habit_id", "log_date"] }
  );
  remote.failNext = { status: 503, message: "overloaded" };
  await engine2.engine.testSync();
  assert.equal((await mutations(port, "pending")).length, 1);
  const [m] = await mutations(port);
  await port.put("_mutations", { ...m, next_retry_at: "2000-01-01T00:00:00.000Z" });
  await engine2.engine.testSync();
  assert.equal(remote.rows.get("habit_logs")?.size, 1, "no duplicate log row");
});

// -------------------------------------------------------------------- sync

test("sync: push marks rows clean and absorbs server timestamps", async () => {
  const { port, remote, db } = setup();
  const row = await db.insert("tasks", { task_date: "2026-10-04", title: "x" });
  await engine2.engine.testSync();
  assert.equal((await mutations(port)).length, 0);
  const local = await db.get("tasks", row.id);
  assert.equal(local._dirty, 0);
  assert.ok(local.updated_at, "server updated_at absorbed");
  assert.equal(remote.rows.get("tasks")?.get(row.id)?.title, "x");
});

test("sync: pull inserts new remote rows and updates changed ones", async () => {
  const { port, remote, db } = setup();
  remote.seed("tasks", { id: "r1", owner: USER_A, task_date: "2026-10-04", title: "remote", created_at: "2026-01-02T00:00:00Z", updated_at: "2026-01-02T00:00:00Z" });
  await engine2.engine.testSync();
  const row = await db.get("tasks", "r1");
  assert.equal(row?.title, "remote");
  assert.equal(row?._dirty, 0);
  // Remote edit → pulled on next sync.
  remote.seed("tasks", { id: "r1", owner: USER_A, task_date: "2026-10-04", title: "remote v2", created_at: "2026-01-02T00:00:00Z", updated_at: "2026-03-01T00:00:00Z" });
  await engine2.engine.testSync();
  assert.equal((await db.get("tasks", "r1"))?.title, "remote v2");
});

test("sync: pull reconciles remote deletes for clean rows only", async () => {
  const { port, remote, db } = setup();
  const a = await db.insert("tasks", { task_date: "2026-10-04", title: "a" });
  const b = await db.insert("tasks", { task_date: "2026-10-04", title: "b" });
  await engine2.engine.testSync();
  // Remote delete of a (another device); local dirty edit of b.
  remote.rows.get("tasks").delete(a.id);
  await db.update("tasks", b.id, { title: "b edited" });
  remote.failNext = new TypeError("fetch failed"); // keep b's update queued
  await engine2.engine.testSync();
  assert.equal(await db.get("tasks", a.id), null, "clean row removed after remote delete");
  assert.equal((await db.get("tasks", b.id))?.title, "b edited", "dirty row untouched by pull");
  const [m] = await mutations(port);
  await port.put("_mutations", { ...m, next_retry_at: "2000-01-01T00:00:00.000Z", retry_count: 0 });
  remote.failNext = null;
  await engine2.engine.testSync();
  assert.equal(remote.rows.get("tasks")?.get(b.id)?.title, "b edited");
});

test("sync: reconnect flushes the offline queue in parent-before-child order", async () => {
  const { port, remote, db } = setup();
  const w = await db.insert("workouts", { name: "HSPU" });
  const s = await db.insert("workout_sessions", { workout_id: w.id, session_date: "2026-10-04", status: "in_progress" });
  await db.insert("workout_sets", { session_id: s.id, exercise_id: "e1", workout_id: w.id, set_number: 1, reps: 5 });
  remote.offline = true;
  await engine2.engine.testSync();
  assert.equal(remote.rows.get("workouts")?.size ?? 0, 0, "nothing pushed while offline");
  assert.equal((await mutations(port, "pending")).length, 3);
  remote.offline = false;
  for (const m of await mutations(port)) {
    await port.put("_mutations", { ...m, next_retry_at: "2000-01-01T00:00:00.000Z", retry_count: 0 });
  }
  await engine2.engine.testSync();
  assert.equal(remote.rows.get("workouts")?.size, 1);
  assert.equal(remote.rows.get("workout_sessions")?.size, 1);
  assert.equal(remote.rows.get("workout_sets")?.size, 1);
  const order = remote.log.map((l) => l.table);
  assert.ok(order.indexOf("workouts") < order.indexOf("workout_sessions"), "parents pushed before children: " + order.join(","));
});

// --------------------------------------------------------------- conflicts

test("conflict: last-write-wins — newer local edit wins", async () => {
  const { port, remote, db } = setup();
  const id = "habit-1";
  const base = { id, owner: USER_A, name: "v1", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
  remote.seed("habits", base);
  await port.put("habits", cleanRow(base));
  // Another device edits (older than our upcoming edit).
  remote.seed("habits", { ...base, name: "remote v2", updated_at: "2026-06-01T00:00:00Z" });
  await db.update("habits", id, { name: "local v3" }); // _local_updated_at = now (Oct) > Jun
  await engine2.engine.testSync();
  assert.equal(remote.rows.get("habits")?.get(id)?.name, "local v3");
  assert.equal((await mutations(port)).length, 0);
});

test("conflict: last-write-wins — newer remote edit wins, logged, not lost silently", async () => {
  const { port, remote, db } = setup();
  const id = "habit-1";
  const base = { id, owner: USER_A, name: "v1", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
  remote.seed("habits", base);
  await port.put("habits", cleanRow(base));
  remote.seed("habits", { ...base, name: "remote v2", updated_at: "2026-12-01T00:00:00Z" });
  await db.update("habits", id, { name: "local v3" }); // now (Oct) < Dec → loses
  await engine2.engine.testSync();
  assert.equal((await db.get("habits", id))?.name, "remote v2");
  assert.equal((await mutations(port)).length, 0, "losing mutation superseded, not stuck");
  const conflicts = await port.list("_conflicts", {});
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kind, "update-lost");
});

test("conflict: append-only records from two devices are both preserved", async () => {
  const { port, remote, db } = setup();
  const sub = await db.insert("subjects", { name: "Math" });
  await engine2.engine.testSync();
  // "Another device" logs a session directly in the cloud.
  remote.seed("study_sessions", { id: "other-device-id", owner: USER_A, subject_id: sub.id, session_date: "2026-10-04", started_at: "2026-10-04T08:00:00Z", duration_seconds: 1500, created_at: "2026-10-04T08:00:00Z", updated_at: "2026-10-04T08:00:00Z" });
  await db.insert("study_sessions", { subject_id: sub.id, session_date: "2026-10-04", started_at: "2026-10-04T09:00:00Z", duration_seconds: 1800 });
  await engine2.engine.testSync();
  assert.equal(remote.rows.get("study_sessions")?.size, 2, "both sessions preserved");
  assert.equal(await db.count("study_sessions", {}), 2);
});

test("conflict: concurrent increments apply the delta on top (no lost counts)", async () => {
  const { port, remote, db } = setup();
  const id = "ll-1";
  const base = { id, owner: USER_A, limit_id: "lim", log_date: "2026-10-04", minutes_used: 20, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
  remote.seed("limit_logs", base);
  await port.put("limit_logs", cleanRow(base));
  await db.increment("limit_logs", id, "minutes_used", 30, { limit_id: "lim", log_date: "2026-10-04", minutes_used: 0 }, ["limit_id", "log_date"]);
  // Another device adds 5 meanwhile.
  remote.seed("limit_logs", { ...base, minutes_used: 25, updated_at: "2026-06-01T00:00:00Z" });
  await engine2.engine.testSync();
  assert.equal(remote.rows.get("limit_logs")?.get(id)?.minutes_used, 55, "25 + our delta 30");
  assert.equal((await db.get("limit_logs", id))?.minutes_used, 55);
});

test("idempotency: increment retry after a lost response does not double-count", async () => {
  const { port, remote, db } = setup();
  const row = await db.increment("limit_logs", undefined, "minutes_used", 30,
    { limit_id: "lim", log_date: "2026-10-04", minutes_used: 0 }, ["limit_id", "log_date"]);
  // Simulate the RPC succeeding on the server but the response being lost:
  // apply the SAME mutation identity directly, leaving it queued, then let
  // the engine retry it. The ledger -- not the numeric value -- proves it
  // was already applied.
  const [m] = await port.list("_mutations", {});
  const seed = { limit_id: "lim", log_date: "2026-10-04" };
  const first = await remote.applyIncrement({
    mutation_id: m.mutation_id,
    owner_id: m.owner_id,
    entity: m.entity,
    record_id: m.record_id,
    field: m.field,
    delta: m.delta,
    seed,
    created_at: m.created_at,
  });
  assert.equal(first.applied, true);
  assert.equal(first.row.minutes_used, 30);
  await engine2.engine.testSync();
  assert.equal(remote.rows.get("limit_logs")?.get(row.id)?.minutes_used, 30, "not 60");
  assert.equal((await port.list("_mutations", {})).length, 0, "mutation consumed");
});

test("idempotency: insert retried after success converges without duplicates", async () => {
  const { port, remote, db } = setup();
  const row = await db.insert("tasks", { task_date: "2026-10-04", title: "x" });
  // First attempt actually reached the cloud; the response was lost.
  remote.seed("tasks", { id: row.id, owner: USER_A, task_date: "2026-10-04", title: "x", created_at: "2026-10-04T00:00:00Z", updated_at: "2026-10-04T00:00:00Z" });
  await engine2.engine.testSync();
  assert.equal(remote.rows.get("tasks")?.size, 1);
  assert.equal((await mutations(port)).length, 0);
});

// -------------------------------------------------------------- tombstones

test("tombstone: local delete → queued delete → remote delete → GC", async () => {
  const { port, remote, db } = setup();
  const row = await db.insert("tasks", { task_date: "2026-10-04", title: "x" });
  await engine2.engine.testSync();
  await db.remove("tasks", row.id);
  assert.equal((await mutations(port, "pending")).length, 1);
  await engine2.engine.testSync();
  assert.equal(remote.rows.get("tasks")?.size ?? 0, 0);
  assert.equal(await db.count("tasks", { includeDeleted: true }), 0, "tombstone garbage-collected");
  assert.equal((await mutations(port)).length, 0);
});

test("tombstone: remote 23001 rejection restores the local row and fails visibly", async () => {
  const { port, remote, db } = setup();
  const row = await db.insert("tasks", { task_date: "2026-10-04", title: "x" });
  await engine2.engine.testSync();
  await db.remove("tasks", row.id);
  remote.failNext = { code: "23001", status: 409, message: "Cannot delete: historical records reference it" };
  await engine2.engine.testSync();
  const restored = await db.get("tasks", row.id);
  assert.ok(restored, "local row restored");
  assert.equal(restored._deleted, 0);
  const [m] = await mutations(port, "failed");
  assert.ok(m, "mutation failed visibly");
  assert.match(m.last_error, /Couldn't sync/);
  const snap = engine2.engine.getSnapshot();
  assert.equal(snap.failed, 1);
});

test("tombstone: delete loses to a concurrent remote update (resurrect + log)", async () => {
  const { port, remote, db } = setup();
  const id = "task-1";
  const base = { id, owner: USER_A, task_date: "2026-10-04", title: "v1", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
  remote.seed("tasks", base);
  await port.put("tasks", cleanRow(base));
  remote.seed("tasks", { ...base, title: "v2", updated_at: "2026-12-01T00:00:00Z" });
  await db.remove("tasks", id);
  await engine2.engine.testSync();
  const row = await db.get("tasks", id);
  assert.equal(row?.title, "v2", "resurrected with the remote update");
  assert.equal(row?._deleted, 0);
  const conflicts = await port.list("_conflicts", {});
  assert.equal(conflicts[0]?.kind, "delete-lost");
});

test("upsert resurrects a tombstone and drops its queued delete", async () => {
  const { port, remote, db } = setup();
  const row = await db.insert("journal_entries",
    { entry_date: "2026-10-04", content: "morning" },
    undefined);
  await engine2.engine.testSync();
  await db.remove("journal_entries", row.id);
  assert.equal((await mutations(port, "pending")).length, 1);
  await db.upsert("journal_entries",
    { id: row.id, entry_date: "2026-10-04", content: "evening rewrite" },
    { index: "entry_date", cols: ["entry_date"] });
  assert.equal((await mutations(port)).filter((m) => m.op === "delete").length, 0);
  const resurrected = await db.get("journal_entries", row.id);
  assert.equal(resurrected?._deleted, 0);
  assert.equal(resurrected?.content, "evening rewrite");
});

// ------------------------------------------------------------------ auth

test("auth: mutations for the wrong user are never executed", async () => {
  const { port, remote } = setup();
  await port.put("_mutations", {
    mutation_id: "m-wrong", owner_id: USER_A, entity: "tasks", op: "insert",
    record_id: "r1", payload: { id: "r1", task_date: "2026-10-04" },
    created_at: "2026-10-04T00:00:00Z", retry_count: 0, last_error: null,
    status: "pending", next_retry_at: null,
  });
  engine2.engine.testInject(port, remote, USER_B);
  await engine2.engine.testSync();
  assert.equal(remote.rows.get("tasks")?.size ?? 0, 0, "A's mutation not run as B");
  assert.equal((await mutations(port, "pending")).length, 1, "still queued for A");
});

test("auth: 401 during push stops the cycle and flags authIssue; work is kept", async () => {
  const { port, remote, db } = setup();
  await db.insert("tasks", { task_date: "2026-10-04", title: "x" });
  remote.failNext = { status: 401, message: "JWT expired" };
  await engine2.engine.testSync();
  assert.equal(engine2.engine.getSnapshot().authIssue, true);
  assert.equal((await mutations(port, "pending")).length, 1, "mutation kept, not failed");
  assert.equal(remote.rows.get("tasks")?.size ?? 0, 0);
});

// ------------------------------------------------------- error classification

test("classifyRemoteError maps failures to retry policy", async () => {
  await load();
  const c = remote2.classifyRemoteError;
  assert.equal(c({ code: "23505", status: 409 }), "unique");
  assert.equal(c({ code: "23001" }), "restrict");
  assert.equal(c({ code: "23503" }), "restrict");
  assert.equal(c({ status: 401 }), "auth");
  assert.equal(c({ status: 403 }), "auth");
  assert.equal(c({ code: "42501" }), "auth");
  assert.equal(c(new TypeError("fetch failed")), "transient");
  assert.equal(c({ status: 429 }), "transient");
  assert.equal(c({ status: 503 }), "transient");
  assert.equal(c({ status: 400 }), "permanent");
  assert.equal(c({ status: 422 }), "permanent");
});

test("backoff is bounded", async () => {
  await load();
  const b = types2.backoffDelayMs;
  assert.equal(b(0), 5000);
  assert.equal(b(1), 10000);
  assert.ok(b(100) <= 300000, "capped at 5 minutes");
});

test("sync snapshot reports pending/failed counts and pending ids", async () => {
  const { port, remote, db } = setup();
  const a = await db.insert("tasks", { task_date: "2026-10-04", title: "a" });
  const b = await db.insert("tasks", { task_date: "2026-10-04", title: "b" });
  // First mutation fails permanently; second is not due yet (scheduled retry).
  const [first, second] = await mutations(port);
  remote.failNext = { status: 400, message: "bad request" };
  await port.put("_mutations", { ...first, next_retry_at: "2000-01-01T00:00:00.000Z" });
  await port.put("_mutations", { ...second, next_retry_at: "2999-01-01T00:00:00.000Z" });
  await engine2.engine.testSync();
  const snap = engine2.engine.getSnapshot();
  assert.equal(snap.failed, 1);
  assert.equal(snap.pending, 1);
  assert.ok(snap.pendingIds.has(a.id));
  assert.ok(snap.pendingIds.has(b.id));
});

// ------------------------------------------------------------ profiles sync

test("profiles: upsert/insert never attach an owner column", async () => {
  const { port, db } = setup();
  // profiles' PK is the user id; public.profiles has NO owner column.
  const row = await db.upsert("profiles", { id: USER_A, display_name: "x" });
  assert.ok(!("owner" in row), "local profile row must not carry owner");
  assert.equal(row.id, USER_A);
  const [m] = await mutations(port);
  assert.equal(m.op, "upsert");
  assert.ok(!("owner" in m.payload), "queued mutation payload must not carry owner");
  assert.equal(m.owner_id, USER_A, "mutation envelope still carries owner_id");
  const row2 = await db.insert("profiles", { id: USER_A });
  assert.ok(!("owner" in row2), "inserted profile row must not carry owner");
  const ms = await mutations(port);
  for (const mut of ms) {
    assert.ok(!("owner" in mut.payload), "no queued mutation may carry owner");
  }
});

test("profiles: sync push delivers no owner column to remote", async () => {
  const { port, remote, db } = setup();
  await db.upsert("profiles", { id: USER_A, display_name: "x" });
  await engine2.engine.testSync();
  const local = await db.get("profiles", USER_A);
  assert.ok(!("owner" in local), "absorbed local row must not carry owner");
  const remoteRow = remote.rows.get("profiles")?.get(USER_A);
  assert.ok(remoteRow, "profile was pushed to the remote");
  assert.ok(!("owner" in remoteRow), "remote profile row must not carry owner");
});

// --------------------------------------------- logout / account switching
// Hard requirement: no cross-account leakage. Production keeps a separate
// IndexedDB database per user (openIdbPort(DB_NAME_PREFIX + uid)), so a
// login after logout opens a different database; these tests pin that.

test("logout/login: B sees none of A's data, queue, conflicts, or watermarks", async () => {
  // A logs in with her own per-user database.
  const portA = new ports.MemoryPort();
  const remoteA = new remote2.MemoryRemote();
  engine2.engine.testReset();
  engine2.engine.testInject(portA, remoteA, USER_A);
  const dbA = write2.getDb();

  // A caches data locally and creates offline mutations.
  await dbA.insert("tasks", { task_date: "2026-10-04", title: "A's task" });
  await dbA.insert("habit_logs", { habit_id: "h1", log_date: "2026-10-04", status: "done" });
  await portA.put("_conflicts", {
    id: "c1", owner_id: USER_A, created_at: "2026-10-04T00:00:00Z",
    entity: "tasks", record_id: "r1", kind: "update-lost", detail: "x",
  });
  await portA.put("_meta", { key: "last_pull:tasks", value: "2026-10-04T00:00:00.000Z" });
  await portA.put("_meta", { key: "initial_pull_done", value: "1" });
  assert.equal((await mutations(portA, "pending")).length, 2);

  // A logs out: the database is closed and the engine forgets the user.
  await engine2.engine.handleLogout();
  assert.throws(() => write2.getDb(), /Not signed in/);
  const snap = engine2.engine.getSnapshot();
  assert.equal(snap.userId, null);
  assert.equal(snap.pending, 0);
  assert.equal(snap.failed, 0);
  assert.equal(snap.authIssue, false);
  assert.equal(snap.syncing, false);

  // B logs in: production opens a DIFFERENT per-user database for B.
  const portB = new ports.MemoryPort();
  const remoteB = new remote2.MemoryRemote();
  engine2.engine.testInject(portB, remoteB, USER_B);
  const dbB = write2.getDb();
  assert.equal(engine2.engine.getSnapshot().userId, USER_B);

  // B sees none of A's world: no records, no queued mutations, no conflicts,
  // no pull watermarks.
  assert.equal(await dbB.count("tasks", {}), 0, "B sees no tasks of A");
  assert.equal(await dbB.count("habit_logs", {}), 0);
  assert.equal((await mutations(portB)).length, 0, "no pending mutations for B");
  assert.equal(await portB.count("_conflicts", {}), 0, "no conflicts leak");
  assert.equal(await portB.get("_meta", "last_pull:tasks"), null, "no watermarks leak");
  assert.equal(await portB.get("_meta", "initial_pull_done"), null);

  // A's data is still intact in A's own store (durable for A's next login):
  // logout closed it but neither wiped it nor handed it to B.
  assert.equal(await portA.count("tasks", {}), 1);
  assert.equal((await mutations(portA, "pending")).length, 2);
  assert.equal(await portA.count("_conflicts", {}), 1);
  assert.equal((await portA.get("_meta", "last_pull:tasks"))?.value, "2026-10-04T00:00:00.000Z");
});

test("logout/login: A's offline mutation never executes under B's session", async () => {
  const portA = new ports.MemoryPort();
  const remoteA = new remote2.MemoryRemote();
  engine2.engine.testReset();
  engine2.engine.testInject(portA, remoteA, USER_A);
  const dbA = write2.getDb();

  // A works offline; the mutation queues durably and stays queued.
  remoteA.offline = true;
  const row = await dbA.insert("tasks", { task_date: "2026-10-04", title: "A's offline task" });
  await engine2.engine.testSync();
  const [m] = await mutations(portA);
  assert.equal(m.owner_id, USER_A);
  assert.equal(m.record_id, row.id);
  assert.equal(remoteA.rows.get("tasks")?.size ?? 0, 0, "nothing reached A's cloud while offline");

  // A logs out; B logs in on the same device with B's own cloud.
  await engine2.engine.handleLogout();
  const portB = new ports.MemoryPort();
  const remoteB = new remote2.MemoryRemote();
  engine2.engine.testInject(portB, remoteB, USER_B);
  const dbB = write2.getDb();
  await dbB.insert("tasks", { task_date: "2026-10-04", title: "B's task" });

  // Network reconnects; B runs a full sync cycle.
  await engine2.engine.testSync();
  const bTitles = [...(remoteB.rows.get("tasks")?.values() ?? [])].map((r) => r.title);
  assert.deepEqual(bTitles, ["B's task"], "only B's work reached B's cloud");
  assert.equal((await mutations(portB)).length, 0, "B's queue drained");
  assert.equal(await portB.count("_conflicts", {}), 0);

  // A's mutation was never executed, transferred, or dropped: still queued
  // under A's owner in A's own store, ready for A's next login.
  const held = await mutations(portA, "pending");
  assert.equal(held.length, 1, "A's mutation still queued for A");
  assert.equal(held[0].owner_id, USER_A, "still owned by A, never silently transferred");
  assert.equal(held[0].record_id, row.id);
  assert.equal(remoteA.rows.get("tasks")?.size ?? 0, 0, "A's cloud untouched by B's session");
});

// ------------------------------------------------------- auth session expiry
// The engine detects an expired/invalid session when any remote op fails
// with 401/403 (classifyRemoteError -> "auth"); MemoryRemote.failNext is the
// auth-failure mode for these tests.

test("auth: expired session pauses sync with bounded attempts; queue stays durable", async () => {
  const { port, remote, db } = setup();
  const row = await db.insert("tasks", { task_date: "2026-10-04", title: "offline work" });
  // Offline first: the mutation queues durably.
  remote.offline = true;
  await engine2.engine.testSync();
  remote.offline = false;
  const [queued] = await mutations(port);
  await port.put("_mutations", { ...queued, next_retry_at: "2000-01-01T00:00:00.000Z" });
  const retriesBefore = queued.retry_count;

  // Count raw remote attempts: every table op goes through remote.table().
  let remoteCalls = 0;
  const origTable = remote.table.bind(remote);
  remote.table = (name) => {
    const t = origTable(name);
    const counted = { ...t };
    for (const k of Object.keys(t)) {
      const fn = t[k].bind(t);
      counted[k] = async (...args) => {
        remoteCalls++;
        return fn(...args);
      };
    }
    return counted;
  };

  // The session is expired: every attempt gets a 401.
  for (let i = 0; i < 3; i++) {
    remote.failNext = { status: 401, message: "JWT expired" };
    await engine2.engine.testSync();
  }
  assert.equal(remoteCalls, 3, "exactly one attempt per sync trigger — no retry storm");
  assert.equal(remote.rows.get("tasks")?.size ?? 0, 0, "nothing reached the cloud");

  // The mutation is durable and untouched by the auth failures.
  const [m] = await mutations(port, "pending");
  assert.ok(m, "mutation still queued");
  assert.equal(m.record_id, row.id, "same record");
  assert.equal(m.retry_count, retriesBefore, "auth stops do not burn backoff retries");
  assert.equal(m.next_retry_at, null, "no autonomous retry scheduled for auth failures");
  assert.equal(m.last_error, "Sign-in needed.");
  assert.equal(m.payload.title, "offline work", "payload intact");

  // User-facing state: useSyncStatus()/ConnectivityBadge read this flag and
  // render it as "Sign-in needed" (see components/sync/status.tsx).
  assert.equal(engine2.engine.getSnapshot().authIssue, true);
});

test("auth: after re-authentication the queued mutation resumes and syncs", async () => {
  const { port, remote, db } = setup();
  const row = await db.insert("tasks", { task_date: "2026-10-04", title: "queued during outage" });
  remote.failNext = { status: 401, message: "JWT expired" };
  await engine2.engine.testSync();
  assert.equal(engine2.engine.getSnapshot().authIssue, true);
  assert.equal((await mutations(port, "pending")).length, 1);

  // Session restored (user signs in again): the correct user's queued
  // mutation resumes and syncs successfully.
  remote.failNext = null;
  await engine2.engine.testSync();
  assert.equal((await mutations(port)).length, 0, "queue drained");
  const pushed = remote.rows.get("tasks")?.get(row.id);
  assert.equal(pushed?.title, "queued during outage");
  assert.equal(pushed?.owner, USER_A, "synced as the correct user");
  assert.equal((await db.get("tasks", row.id))?._dirty, 0);
});

// ------------------------------------------------------- failure recovery

test("recovery: queued mutation survives a browser restart and retries successfully", async () => {
  await idbReady();
  const { indexedDB } = await import("fake-indexeddb");
  const name = "test-restart-" + Date.now();

  // Session 1: write, attempt a push, fail mid-push, "close the browser".
  const port1 = await ports.openIdbPort(name);
  const remote = new remote2.MemoryRemote();
  engine2.engine.testReset();
  engine2.engine.testInject(port1, remote, USER_A);
  const db1 = write2.getDb();
  const row = await db1.insert("tasks", { task_date: "2026-10-04", title: "survives restart" });
  remote.failNext = new TypeError("fetch failed"); // network drops mid-push
  await engine2.engine.testSync();
  const [m] = await port1.list("_mutations", {});
  assert.equal(m.status, "pending");
  assert.equal(m.retry_count, 1);
  assert.ok(m.next_retry_at > new Date().toISOString(), "backoff scheduled");
  assert.equal(remote.rows.get("tasks")?.size ?? 0, 0);
  port1.close(); // browser closed

  // Session 2: reopen the same persisted database, network back.
  const port2 = await ports.openIdbPort(name);
  engine2.engine.testReset();
  engine2.engine.testInject(port2, remote, USER_A);
  const db2 = write2.getDb();

  // The mutation is still there and still retryable.
  const held = await port2.list("_mutations", {});
  assert.equal(held.length, 1, "mutation survived the restart");
  assert.equal(held[0].record_id, row.id);
  assert.equal(held[0].status, "pending");
  assert.equal(held[0].payload.title, "survives restart", "payload intact");
  assert.equal((await db2.get("tasks", row.id))?.title, "survives restart", "local row survived too");

  // Backoff hasn't elapsed yet; simulate the wait, then retry.
  await port2.put("_mutations", { ...held[0], next_retry_at: "2000-01-01T00:00:00.000Z" });
  await engine2.engine.testSync();
  assert.equal((await port2.list("_mutations", {})).length, 0, "queue drained after retry");
  assert.equal(remote.rows.get("tasks")?.get(row.id)?.title, "survives restart");

  port2.close();
  await new Promise((res) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = req.onerror = () => res();
  });
});

test("recovery: mutation stuck inflight by a crash is reset to pending on next login", async () => {
  await idbReady();
  const { indexedDB } = await import("fake-indexeddb");
  const name = "test-inflight-" + Date.now();
  const port1 = await ports.openIdbPort(name);
  const remote = new remote2.MemoryRemote();
  engine2.engine.testReset();
  engine2.engine.testInject(port1, remote, USER_A);
  const db1 = write2.getDb();
  const row = await db1.insert("tasks", { task_date: "2026-10-04", title: "crashed mid-push" });
  // Simulate a crash between claim and completion: the mutation is inflight.
  const [m] = await port1.list("_mutations", {});
  await port1.put("_mutations", { ...m, status: "inflight" });
  port1.close(); // process dies here

  // Next login reopens the same database and runs crash recovery.
  const port2 = await ports.openIdbPort(name);
  engine2.engine.testReset();
  engine2.engine.testInject(port2, remote, USER_A);
  await engine2.engine.testRecoverInflight();
  const [recovered] = await port2.list("_mutations", {});
  assert.equal(recovered.status, "pending", "inflight reset to pending");
  assert.equal(recovered.next_retry_at, null, "immediately retryable");
  await engine2.engine.testSync();
  assert.equal((await port2.list("_mutations", {})).length, 0);
  assert.equal(remote.rows.get("tasks")?.get(row.id)?.title, "crashed mid-push");

  port2.close();
  await new Promise((res) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = req.onerror = () => res();
  });
});

test("recovery: mid-sync connection drop retries without duplicating pushed rows", async () => {
  const { port, remote, db } = setup();
  const a = await db.insert("tasks", { task_date: "2026-10-04", title: "a" });
  const b = await db.insert("tasks", { task_date: "2026-10-04", title: "b" });
  const c = await db.insert("tasks", { task_date: "2026-10-04", title: "c" });
  // The connection drops on one push attempt mid-batch.
  remote.failNext = new TypeError("fetch failed");
  await engine2.engine.testSync();
  // Exactly one mutation is scheduled for retry; the rest pushed fine.
  assert.equal((await mutations(port, "pending")).length, 1);
  assert.equal(remote.rows.get("tasks")?.size, 2);

  // Retry the failed one: it must converge without duplicating anything.
  const [m] = await mutations(port);
  await port.put("_mutations", { ...m, next_retry_at: "2000-01-01T00:00:00.000Z" });
  await engine2.engine.testSync();
  assert.equal(remote.rows.get("tasks")?.size, 3, "exactly-once logical effect");
  assert.deepEqual(
    [...remote.rows.get("tasks").keys()].sort(),
    [a.id, b.id, c.id].sort(),
    "same stable ids, no duplicates"
  );
  assert.deepEqual(
    [...remote.rows.get("tasks").values()].map((r) => r.title).sort(),
    ["a", "b", "c"]
  );
  assert.equal((await mutations(port)).length, 0, "queue drained");
});

// ------------------------------------------------- date/time boundaries
// Timezone model (lib/dates.ts): day keys are LOCAL YYYY-MM-DD strings.
// The sync write path never transforms date fields — these tests pin that:
// records created around local midnight must keep their local day key
// through local storage, the mutation payload, and the cloud row.
// (Tests run with TZ='Asia/Kolkata' per package.json; no DST there.)

test("dates: records around local midnight keep their local day keys through sync", async () => {
  const { port, remote, db } = setup();
  // Two instants straddling local midnight. The second is still Oct 4 in UTC,
  // so any UTC-slicing bug would mis-attribute it to "2026-10-04".
  assert.equal(new Date("2026-10-05T00:00:30+05:30").toISOString().slice(0, 10), "2026-10-04");
  const beforeKey = toDayKey(new Date("2026-10-04T23:59:30+05:30")); // "2026-10-04"
  const afterKey = toDayKey(new Date("2026-10-05T00:00:30+05:30")); // "2026-10-05"
  assert.equal(beforeKey, "2026-10-04");
  assert.equal(afterKey, "2026-10-05");

  const med = await db.insert("habits", { name: "Meditation" });
  await db.insert("habit_logs", { habit_id: med.id, log_date: beforeKey, status: "done" });
  await db.insert("habit_logs", { habit_id: med.id, log_date: afterKey, status: "done" });
  // Hifz is tracked as habit logs (zero-vs-no-record preserved).
  const hifz = await db.insert("habits", { name: "Hifz" });
  await db.insert("habit_logs", { habit_id: hifz.id, log_date: afterKey, status: "done", value: 5 });

  await db.insert("tasks", { task_date: beforeKey, title: "before midnight" });
  await db.insert("tasks", { task_date: afterKey, title: "after midnight" });

  const journalId = (await db.insert("journal_entries", { entry_date: afterKey, content: "after midnight thoughts" })).id;
  await db.insert("journal_entries", { entry_date: beforeKey, content: "before midnight thoughts" });

  const w = await db.insert("workouts", { name: "HSPU" });
  await db.insert("workout_sessions", { workout_id: w.id, session_date: beforeKey, status: "completed" });
  await db.insert("workout_sessions", { workout_id: w.id, session_date: afterKey, status: "completed" });

  const sub = await db.insert("subjects", { name: "Math" });
  await db.insert("study_sessions", { subject_id: sub.id, session_date: beforeKey, started_at: "2026-10-04T23:00:00+05:30", duration_seconds: 1800 });
  await db.insert("study_sessions", { subject_id: sub.id, session_date: afterKey, started_at: "2026-10-05T00:00:30+05:30", duration_seconds: 1500 });

  const book = await db.insert("books", { title: "Deep Work" });
  await db.insert("reading_logs", { book_id: book.id, log_date: beforeKey, pages: 10 });
  await db.insert("reading_logs", { book_id: book.id, log_date: afterKey, pages: 12 });

  const lim = await db.insert("usage_limits", { name: "YouTube", daily_limit_min: 45 });
  await db.insert("limit_logs", { limit_id: lim.id, log_date: beforeKey, minutes_used: 20 });
  await db.insert("limit_logs", { limit_id: lim.id, log_date: afterKey, minutes_used: 10 });

  await db.insert("daily_reviews", { review_date: beforeKey, wins: "a" });
  await db.insert("daily_reviews", { review_date: afterKey, wins: "b" });

  const rule = await db.insert("abstinence_rules", { name: "No doomscrolling" });
  const incBefore = await db.insert("abstinence_incidents", { rule_id: rule.id, occurred_at: "2026-10-04T23:59:30+05:30" });
  const incAfter = await db.insert("abstinence_incidents", { rule_id: rule.id, occurred_at: "2026-10-05T00:00:30+05:30" });

  await engine2.engine.testSync();
  assert.equal((await mutations(port)).length, 0, "everything pushed");

  const remoteDates = (table, col) =>
    [...(remote.rows.get(table)?.values() ?? [])].map((r) => r[col]).sort();
  const expected = [beforeKey, afterKey].sort();
  for (const [table, col] of [
    ["tasks", "task_date"],
    ["journal_entries", "entry_date"],
    ["workout_sessions", "session_date"],
    ["study_sessions", "session_date"],
    ["reading_logs", "log_date"],
    ["limit_logs", "log_date"],
    ["daily_reviews", "review_date"],
  ]) {
    assert.deepEqual(remoteDates(table, col), expected, `${table}.${col} preserved through sync`);
  }
  // Habit logs carry two habits; check per habit.
  const logsFor = (hid) =>
    [...(remote.rows.get("habit_logs")?.values() ?? [])]
      .filter((r) => r.habit_id === hid)
      .map((r) => r.log_date)
      .sort();
  assert.deepEqual(logsFor(med.id), expected, "habit log dates preserved");
  assert.deepEqual(logsFor(hifz.id), [afterKey], "Hifz date preserved");

  // The journal entry's date field survives verbatim, locally and remotely.
  assert.equal((await db.get("journal_entries", journalId))?.entry_date, afterKey);
  assert.equal(remote.rows.get("journal_entries")?.get(journalId)?.entry_date, afterKey);

  // Incident instants are preserved exactly and attributed to the local day.
  const rIncBefore = remote.rows.get("abstinence_incidents")?.get(incBefore.id);
  const rIncAfter = remote.rows.get("abstinence_incidents")?.get(incAfter.id);
  assert.equal(rIncBefore?.occurred_at, "2026-10-04T23:59:30+05:30");
  assert.equal(rIncAfter?.occurred_at, "2026-10-05T00:00:30+05:30");
  assert.equal(utcToDayKey(rIncBefore.occurred_at), "2026-10-04");
  assert.equal(utcToDayKey(rIncAfter.occurred_at), "2026-10-05");
});

test("dates: study session spanning midnight keeps its instants and start-day attribution", async () => {
  const { port, remote, db } = setup();
  const sub = await db.insert("subjects", { name: "Math" });
  // Starts 23:30 local Oct 4, ends 00:30 local Oct 5: the model (timestamptz
  // instants + a local session_date) supports sessions spanning midnight.
  const span = await db.insert("study_sessions", {
    subject_id: sub.id,
    session_date: toDayKey(new Date("2026-10-04T23:30:00+05:30")),
    started_at: "2026-10-04T23:30:00+05:30",
    completed_at: "2026-10-05T00:30:00+05:30",
    duration_seconds: 3600,
  });
  assert.equal(span.session_date, "2026-10-04", "attributed to the start day");

  await engine2.engine.testSync();
  assert.equal((await mutations(port)).length, 0);
  const r = remote.rows.get("study_sessions")?.get(span.id);
  assert.equal(r?.started_at, "2026-10-04T23:30:00+05:30", "start instant preserved");
  assert.equal(r?.completed_at, "2026-10-05T00:30:00+05:30", "end instant preserved");
  assert.equal(r?.session_date, "2026-10-04", "session date preserved");
  assert.equal((await db.get("study_sessions", span.id))?.session_date, "2026-10-04");
});

test("dates: challenge day flips at local midnight, not UTC midnight", async () => {
  const { remote, db } = setup();
  const row = await db.insert("challenges", {
    title: "30-Day Transformation",
    start_date: "2026-09-05",
    duration_days: 30,
    is_active: true,
  });
  await engine2.engine.testSync();
  const rc = remote.rows.get("challenges")?.get(row.id);
  assert.equal(rc?.start_date, "2026-09-05", "challenge start_date preserved through sync");

  const challenge = { ...rc, owner: USER_A };
  // Just before local midnight Oct 4 → Day 30; just after → Day 31.
  assert.equal(challengeDayNumber(challenge, new Date("2026-10-04T23:59:30+05:30")), 30);
  assert.equal(challengeDayNumber(challenge, new Date("2026-10-05T00:00:30+05:30")), 31);
  // 00:30 UTC is 06:00 local — still Day 30 locally. UTC midnight is NOT the boundary.
  assert.equal(challengeDayNumber(challenge, new Date("2026-10-04T00:30:00Z")), 30);
});

test("dates: insert timestamps are honest ISO and survive the write path", async () => {
  const { port, remote, db } = setup();
  const row = await db.insert("tasks", { task_date: "2026-10-04", title: "x" });
  assert.ok(!Number.isNaN(Date.parse(row._local_created_at)), "local created is ISO");
  assert.ok(!Number.isNaN(Date.parse(row._local_updated_at)), "local updated is ISO");
  const [m] = await mutations(port);
  assert.ok(!("created_at" in m.payload), "queue payload defers timestamps to send time");
  await engine2.engine.testSync();
  const r = remote.rows.get("tasks")?.get(row.id);
  assert.equal(r?.created_at, row._local_created_at, "cloud created_at matches the honest local stamp");
  assert.equal(r?.updated_at, row._local_updated_at, "cloud updated_at matches the honest local stamp");
  const local = await db.get("tasks", row.id);
  assert.equal(local?.created_at, row._local_created_at, "absorbed back locally");
});
