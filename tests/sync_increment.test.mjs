// V4.2.2 additive-counter sync tests.
//
// The engine's execIncrement replays increments through remote.applyIncrement
// — an atomic, ledger-idempotent server op — instead of client-side
// read/modify/write. These tests pin the fixed behavior:
//   - concurrent increments on two/three devices all survive (commutative),
//   - a lost response + retry applies exactly once (ledger, never value sniffing),
//   - natural-key create races merge into ONE row and losers adopt the winner id,
//   - mutation identity is account-scoped (cross-owner reuse -> 42501),
//   - local writes are immediate and queued as pending.
//
// Deterministic: MemoryPort + MemoryRemote, plus real IndexedDB
// (fake-indexeddb) for the restart test. No sleeps.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

let ports, remote2, engine2, write2, types2;
async function load() { if (ports) return; ports = await import("../lib/sync/ports.ts"); remote2 = await import("../lib/sync/remote.ts"); engine2 = await import("../lib/sync/engine.ts"); write2 = await import("../lib/sync/write.ts"); types2 = await import("../lib/sync/types.ts"); }
const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";
function setup() {
  const port = new ports.MemoryPort();
  const remote = new remote2.MemoryRemote();
  remote.uniques.set("habit_logs", [["habit_id", "log_date"]]);
  remote.uniques.set("limit_logs", [["limit_id", "log_date"]]);
  engine2.engine.testReset();
  engine2.engine.testInject(port, remote, USER_A);
  return { port, remote, db: write2.getDb() };
}
beforeEach(async () => { await load(); });

// ------------------------------------------------------------------ helpers

const DAY = "2026-10-04";
const LIM_SEED = { limit_id: "lim", log_date: DAY, minutes_used: 0 };
const LIM_NK = ["limit_id", "log_date"];
const HAB_SEED = { habit_id: "h", log_date: DAY, status: "done", value: 0 };
const HAB_NK = ["habit_id", "log_date"];

/** Fresh world: new remote (with the natural-key uniques), no devices yet. */
function world() {
  engine2.engine.testReset();
  const remote = new remote2.MemoryRemote();
  remote.uniques.set("habit_logs", [["habit_id", "log_date"]]);
  remote.uniques.set("limit_logs", [["limit_id", "log_date"]]);
  return { remote };
}

/** Inject `port` as `user` and run `fn(db, port)` — one "device" action block. */
async function asDevice(port, remote, user, fn) {
  engine2.engine.testInject(port, remote, user);
  return fn(write2.getDb(), port);
}

/**
 * Rebuild the applyIncrement seed exactly the way execIncrement builds it
 * from the local row: strip local `_` meta, drop id/owner/timestamps/field.
 */
function engineSeed(localRow, field) {
  const seed = {};
  for (const [k, v] of Object.entries(localRow)) {
    if (k.startsWith("_")) continue;
    if (k === "id" || k === "owner" || k === "created_at" || k === "updated_at" || k === field)
      continue;
    seed[k] = v;
  }
  return seed;
}

/** The exact applyIncrement args the engine would send for a queued mutation. */
async function incrementArgs(port, m) {
  const local = await port.get(m.entity, m.record_id);
  return {
    mutation_id: m.mutation_id,
    owner_id: m.owner_id,
    entity: m.entity,
    record_id: m.record_id,
    field: m.field,
    delta: m.delta,
    seed: engineSeed(local, m.field),
    created_at: m.created_at,
  };
}

/**
 * Deterministic "newer": re-seed the remote row with an updated_at safely in
 * the future so a later pull is guaranteed to see it as newer than any local
 * absorb that happened in the same millisecond. Row data is unchanged; only
 * used to de-flake pull convergence in multi-device tests.
 */
async function forceRemoteNewer(remote, table, id) {
  const row = await remote.table(table).getById(id);
  remote.seed(table, {
    ...row,
    updated_at: new Date(Date.now() + 60_000).toISOString(),
  });
}

function seedRemoteLimit(remote, minutes) {
  remote.seed("limit_logs", {
    id: "ll",
    owner: USER_A,
    limit_id: "lim",
    log_date: DAY,
    minutes_used: minutes,
    created_at: "2026-10-04T00:00:00.000Z",
    updated_at: "2026-10-04T00:00:00.000Z",
  });
}

// ------------------------------------------------------------------- tests

test("increment: THE BUG — concurrent equal increments both survive (20+5+5=30)", async () => {
  const { port, remote, db } = setup();
  seedRemoteLimit(remote, 20);
  // Device A offline: +5, not synced yet.
  await db.increment("limit_logs", "ll", "minutes_used", 5, LIM_SEED, LIM_NK);
  assert.equal((await db.get("limit_logs", "ll")).minutes_used, 5, "local write is immediate");
  // Device B syncs first: its +5 already landed on the server.
  await remote.table("limit_logs").updateById("ll", { minutes_used: 25 });
  // A syncs. Old code read 25 and wrote back base+delta on a stale base,
  // converging to 25. New code adds the delta on top of the latest value.
  await engine2.engine.testSync();
  assert.equal((await remote.table("limit_logs").getById("ll")).minutes_used, 30, "remote: 20+5+5");
  assert.equal((await db.get("limit_logs", "ll")).minutes_used, 30, "local converged");
  assert.equal((await port.list("_mutations", {})).length, 0, "queue drained");
});

test("increment: concurrent different deltas, both orders → 32", async () => {
  for (const order of [["A", "B"], ["B", "A"]]) {
    const { remote } = world();
    seedRemoteLimit(remote, 20);
    const portA = new ports.MemoryPort();
    const portB = new ports.MemoryPort();
    // Both devices offline: A +5, B +7 on the same natural key.
    await asDevice(portA, remote, USER_A, (db) =>
      db.increment("limit_logs", undefined, "minutes_used", 5, LIM_SEED, LIM_NK));
    await asDevice(portB, remote, USER_A, (db) =>
      db.increment("limit_logs", undefined, "minutes_used", 7, LIM_SEED, LIM_NK));
    for (const who of order) {
      await asDevice(who === "A" ? portA : portB, remote, USER_A, async () => {
        await engine2.engine.testSync();
      });
    }
    const tag = "order " + order.join(",");
    const rrows = await remote.table("limit_logs").selectDelta(null);
    assert.equal(rrows.length, 1, tag + ": single remote row");
    assert.equal(rrows[0].minutes_used, 32, tag + ": remote 20+5+7");
    // Converge both locals.
    await forceRemoteNewer(remote, "limit_logs", "ll");
    for (const [p, label] of [[portA, "A"], [portB, "B"]]) {
      await asDevice(p, remote, USER_A, async (db) => {
        await engine2.engine.testSync();
        const rows = await db.list("limit_logs", {});
        assert.equal(rows.length, 1, tag + ": " + label + " local row count");
        assert.equal(rows[0].minutes_used, 32, tag + ": " + label + " local value");
      });
    }
  }
});

test("increment: lost response + retry applies exactly once → 25", async () => {
  const { port, remote, db } = setup();
  seedRemoteLimit(remote, 20);
  await db.increment("limit_logs", "ll", "minutes_used", 5, LIM_SEED, LIM_NK);
  const [m] = await port.list("_mutations", {});
  const args = await incrementArgs(port, m);
  // The server applies the increment but the response is "lost".
  const r1 = await remote.applyIncrement(args);
  assert.equal(r1.applied, true, "first application applies");
  assert.equal(r1.row.minutes_used, 25, "remote 20+5");
  // The engine still has the mutation queued and retries it.
  await engine2.engine.testSync();
  assert.equal(
    (await remote.table("limit_logs").getById("ll")).minutes_used,
    25,
    "retry did not double-apply"
  );
  assert.equal((await db.get("limit_logs", "ll")).minutes_used, 25, "local converged");
  assert.equal((await port.list("_mutations", {})).length, 0, "queue drained");
});

test("increment: five retries of one mutation apply exactly once", async () => {
  const { port, remote, db } = setup();
  await db.increment("limit_logs", undefined, "minutes_used", 5, LIM_SEED, LIM_NK);
  const [m] = await port.list("_mutations", {});
  const args = await incrementArgs(port, m);
  const results = [];
  for (let i = 0; i < 5; i++) results.push(await remote.applyIncrement(args));
  assert.equal(results[0].applied, true, "first call applies");
  for (let i = 1; i < 5; i++) {
    assert.equal(results[i].applied, false, `retry ${i} hits the ledger`);
    assert.equal(results[i].row.minutes_used, 5, `retry ${i} value unchanged`);
  }
  // The mutation is still queued locally (responses were "lost"); draining it
  // through the engine must not change the value either.
  await engine2.engine.testSync();
  const rrows = await remote.table("limit_logs").selectDelta(null);
  assert.equal(rrows.length, 1, "exactly one remote row");
  assert.equal(rrows[0].minutes_used, 5, "still exactly 5");
  assert.equal((await port.list("_mutations", {})).length, 0, "queue drained");
});

test("increment: natural-key create race → 12, both orders, no duplicates", async () => {
  for (const first of ["A", "B"]) {
    const { remote } = world();
    const portA = new ports.MemoryPort();
    const portB = new ports.MemoryPort();
    // No remote row exists. Both devices create offline on the same natural key.
    const rowA = await asDevice(portA, remote, USER_A, (db) =>
      db.increment("habit_logs", undefined, "value", 5, HAB_SEED, HAB_NK));
    const rowB = await asDevice(portB, remote, USER_A, (db) =>
      db.increment("habit_logs", undefined, "value", 7, HAB_SEED, HAB_NK));
    const winnerId = first === "A" ? rowA.id : rowB.id;
    const winnerPort = first === "A" ? portA : portB;
    const loserPort = first === "A" ? portB : portA;
    await asDevice(winnerPort, remote, USER_A, async () => {
      await engine2.engine.testSync();
    });
    await asDevice(loserPort, remote, USER_A, async () => {
      await engine2.engine.testSync();
    });
    const tag = "winner " + first;
    const rrows = await remote.table("habit_logs").selectDelta(null);
    assert.equal(rrows.length, 1, tag + ": exactly one remote row, no duplicates");
    assert.equal(rrows[0].id, winnerId, tag + ": winner row kept");
    assert.equal(rrows[0].value, 12, tag + ": remote 5+7 merged");
    // Converge the winner's stale local copy, then check both devices.
    await forceRemoteNewer(remote, "habit_logs", winnerId);
    await asDevice(winnerPort, remote, USER_A, async () => {
      await engine2.engine.testSync();
    });
    for (const [p, label] of [[portA, "A"], [portB, "B"]]) {
      await asDevice(p, remote, USER_A, async (db) => {
        const rows = await db.list("habit_logs", {});
        assert.equal(rows.length, 1, tag + ": " + label + " local row count");
        assert.equal(rows[0].id, winnerId, tag + ": " + label + " adopted winner id");
        assert.equal(rows[0].value, 12, tag + ": " + label + " local value");
      });
    }
  }
});

test("increment: three devices +3+5+7 → 15 in multiple orders", async () => {
  for (const order of [["A", "B", "C"], ["C", "B", "A"]]) {
    const { remote } = world();
    const devPorts = { A: new ports.MemoryPort(), B: new ports.MemoryPort(), C: new ports.MemoryPort() };
    const deltas = { A: 3, B: 5, C: 7 };
    const ids = {};
    for (const name of ["A", "B", "C"]) {
      const row = await asDevice(devPorts[name], remote, USER_A, (db) =>
        db.increment("limit_logs", undefined, "minutes_used", deltas[name], LIM_SEED, LIM_NK));
      ids[name] = row.id;
    }
    for (const name of order) {
      await asDevice(devPorts[name], remote, USER_A, async () => {
        await engine2.engine.testSync();
      });
    }
    const tag = "order " + order.join(",");
    const winnerId = ids[order[0]];
    const rrows = await remote.table("limit_logs").selectDelta(null);
    assert.equal(rrows.length, 1, tag + ": exactly one remote row");
    assert.equal(rrows[0].id, winnerId, tag + ": first-synced device won the race");
    assert.equal(rrows[0].minutes_used, 15, tag + ": remote 3+5+7");
    // Converge every device.
    await forceRemoteNewer(remote, "limit_logs", winnerId);
    for (const name of ["A", "B", "C"]) {
      await asDevice(devPorts[name], remote, USER_A, async (db) => {
        await engine2.engine.testSync();
        const rows = await db.list("limit_logs", {});
        assert.equal(rows.length, 1, tag + ": device " + name + " row count");
        assert.equal(rows[0].id, winnerId, tag + ": device " + name + " adopted winner id");
        assert.equal(rows[0].minutes_used, 15, tag + ": device " + name + " value");
      });
    }
  }
});

test("increment: mixed retries + concurrency → 17", async () => {
  const { remote } = world();
  const portA = new ports.MemoryPort();
  const portB = new ports.MemoryPort();
  const portC = new ports.MemoryPort();
  // Three devices, same natural key, no row initially. A:+5, B:+5, C:+7.
  await asDevice(portA, remote, USER_A, (db) =>
    db.increment("limit_logs", undefined, "minutes_used", 5, LIM_SEED, LIM_NK));
  const mA = (await portA.list("_mutations", {}))[0];
  const argsA = await incrementArgs(portA, mA);
  const rowB = await asDevice(portB, remote, USER_A, (db) =>
    db.increment("limit_logs", undefined, "minutes_used", 5, LIM_SEED, LIM_NK));
  const mB = (await portB.list("_mutations", {}))[0];
  const argsB = await incrementArgs(portB, mB);
  await asDevice(portC, remote, USER_A, (db) =>
    db.increment("limit_logs", undefined, "minutes_used", 7, LIM_SEED, LIM_NK));
  // B syncs → 5.
  await asDevice(portB, remote, USER_A, async () => {
    await engine2.engine.testSync();
  });
  assert.equal((await remote.table("limit_logs").getById(rowB.id)).minutes_used, 5);
  // A "syncs" but the response is lost: the server applied it, A's mutation
  // stays queued.
  const ra = await remote.applyIncrement(argsA);
  assert.equal(ra.applied, true, "A's direct apply lands");
  assert.equal(ra.row.minutes_used, 10, "remote 5+5");
  // C syncs → 17.
  await asDevice(portC, remote, USER_A, async () => {
    await engine2.engine.testSync();
  });
  assert.equal((await remote.table("limit_logs").getById(rowB.id)).minutes_used, 17, "remote 5+5+7");
  // A retries through the engine → ledger hit, still 17.
  await asDevice(portA, remote, USER_A, async () => {
    await engine2.engine.testSync();
  });
  assert.equal((await remote.table("limit_logs").getById(rowB.id)).minutes_used, 17, "A retry is a no-op");
  assert.equal((await portA.list("_mutations", {})).length, 0, "A drained");
  // B "retries accidentally" → ledger hit, still 17.
  const rb = await remote.applyIncrement(argsB);
  assert.equal(rb.applied, false, "B's accidental retry hits the ledger");
  assert.equal(rb.row.minutes_used, 17, "value unchanged");
  // Final drains: every queue empty, remote exactly 17, one row.
  for (const p of [portA, portB, portC]) {
    await asDevice(p, remote, USER_A, async () => {
      await engine2.engine.testSync();
    });
    assert.equal((await p.list("_mutations", {})).length, 0, "queue empty");
  }
  const rrows = await remote.table("limit_logs").selectDelta(null);
  assert.equal(rrows.length, 1, "exactly one remote row");
  assert.equal(rrows[0].minutes_used, 17, "final 5+5+7");
});

test("increment: survives browser restart (fake-indexeddb) → exactly once", async () => {
  await import("fake-indexeddb/auto");
  const { indexedDB } = await import("fake-indexeddb");
  const { remote } = world();
  const name = "inc-restart-" + Date.now();
  const p1 = await ports.openIdbPort(name);
  await asDevice(p1, remote, USER_A, (db) =>
    db.increment("limit_logs", undefined, "minutes_used", 5, LIM_SEED, LIM_NK));
  assert.equal(await p1.count("_mutations", {}), 1, "mutation queued before restart");
  p1.close();
  // "Restart": reopen the same database; the queued mutation must survive.
  const p2 = await ports.openIdbPort(name);
  assert.equal(await p2.count("_mutations", {}), 1, "queued mutation survived restart");
  await asDevice(p2, remote, USER_A, async () => {
    await engine2.engine.testSync();
  });
  const rrows = await remote.table("limit_logs").selectDelta(null);
  assert.equal(rrows.length, 1, "exactly one remote row");
  assert.equal(rrows[0].minutes_used, 5, "applied exactly once");
  assert.equal(await p2.count("_mutations", {}), 0, "queue drained after restart sync");
  p2.close();
  await new Promise((res) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = req.onerror = () => res();
  });
});

test("increment: mutation identity is account-scoped", async () => {
  const { port, remote, db } = setup();
  await db.increment(
    "limit_logs", undefined, "minutes_used", 5,
    { limit_id: "lim-a", log_date: DAY, minutes_used: 0 }, LIM_NK
  );
  const [m] = await port.list("_mutations", {});
  const args = await incrementArgs(port, m);
  const r1 = await remote.applyIncrement(args);
  assert.equal(r1.applied, true, "owner A applies");
  assert.equal(r1.row.minutes_used, 5);
  // The same mutation id presented by another account is rejected.
  let err = null;
  try {
    await remote.applyIncrement({ ...args, owner_id: USER_B });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "cross-owner reuse rejects");
  assert.equal(err.code, "42501", "RLS-style denial code");
  // B works on its own natural key: syncs fine, A's remote row untouched.
  const portB = new ports.MemoryPort();
  await asDevice(portB, remote, USER_B, async (dbB) => {
    await dbB.increment(
      "limit_logs", undefined, "minutes_used", 7,
      { limit_id: "lim-b", log_date: DAY, minutes_used: 0 }, LIM_NK
    );
    await engine2.engine.testSync();
  });
  const rows = await remote.table("limit_logs").selectDelta(null);
  assert.equal(rows.length, 2, "one row per account");
  const aRow = rows.find((r) => r.owner === USER_A);
  const bRow = rows.find((r) => r.owner === USER_B);
  assert.equal(aRow.limit_id, "lim-a");
  assert.equal(aRow.minutes_used, 5, "A's remote row untouched by B");
  assert.equal(bRow.limit_id, "lim-b");
  assert.equal(bRow.minutes_used, 7, "B's own increment applied");
});

test("increment: local write is immediate and marked pending", async () => {
  const { port, remote, db } = setup();
  const row = await db.increment("limit_logs", undefined, "minutes_used", 5, LIM_SEED, LIM_NK);
  assert.equal(row.minutes_used, 5, "local value updated instantly");
  const ms = await port.list("_mutations", {});
  assert.equal(ms.length, 1, "one mutation queued");
  assert.equal(ms[0].op, "increment");
  assert.equal(ms[0].status, "pending", "marked pending");
  assert.equal(ms[0].field, "minutes_used");
  assert.equal(ms[0].delta, 5);
  // The engine refreshes its snapshot on a sync pass; simulate an offline
  // attempt so the snapshot reflects the queued work (mutation stays pending).
  remote.offline = true;
  await engine2.engine.testSync();
  remote.offline = false;
  assert.ok(engine2.engine.getSnapshot().pending > 0, "snapshot shows pending work");
  const [m2] = await port.list("_mutations", {});
  assert.equal(m2.status, "pending", "still queued for retry");
});
