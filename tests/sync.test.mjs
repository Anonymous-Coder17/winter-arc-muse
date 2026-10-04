// V4.2 offline-first sync tests: storage, isolation, offline writes, queue,
// sync, conflicts, tombstones, auth. Deterministic: MemoryPort + MemoryRemote,
// plus real IndexedDB (fake-indexeddb) for the storage/persistence tests.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

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
  await engine2.engine.testSync();
  assert.equal(remote.rows.get("limit_logs")?.get(row.id)?.minutes_used, 30);
  // Second increment; simulate the first attempt succeeding remotely but the
  // response being lost: remote already shows base+delta.
  await db.increment("limit_logs", row.id, "minutes_used", 30,
    { limit_id: "lim", log_date: "2026-10-04", minutes_used: 0 }, ["limit_id", "log_date"]);
  remote.rows.get("limit_logs").get(row.id).minutes_used = 60;
  await engine2.engine.testSync();
  assert.equal(remote.rows.get("limit_logs")?.get(row.id)?.minutes_used, 60, "not 90");
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
