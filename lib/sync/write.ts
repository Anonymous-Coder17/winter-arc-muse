/**
 * V4.2 local-first write facade.
 *
 * `db` is the only way UI code mutates data: every write lands in the
 * per-user IndexedDB immediately (so the UI updates while offline) and
 * enqueues a durable mutation describing how to replay it against Supabase.
 * The sync engine (engine.ts) owns replay; this module never touches the
 * network and never touches `window` at import time.
 *
 * Reads (`list`/`get`/`count`) hit the local cache, which the engine keeps
 * converged with Supabase via delta pulls.
 */
import type { DbPort, ListOpts } from "./ports";
import {
  DELETE_GUARD,
  newUuid,
  nowIso,
  stripLocalMeta,
  type LocalMeta,
  type LocalRow,
  type Mutation,
  type MutationOp,
  type TableName,
} from "./types";

export interface SyncContext {
  getPort(): DbPort;
  getUserId(): string | null;
  kick(reason: string): void;
}

let ctx: SyncContext | null = null;

/** Installed once by the sync engine at startup. */
export function setSyncContext(c: SyncContext): void {
  ctx = c;
}

function cx(): SyncContext {
  if (!ctx || !ctx.getUserId()) throw new Error("Not signed in.");
  return ctx;
}

export function getPort(): DbPort {
  return cx().getPort();
}

function withMeta(
  row: Record<string, any>,
  dirty: 0 | 1,
  deleted: 0 | 1,
  prev?: LocalMeta
): Record<string, any> {
  const now = nowIso();
  return {
    ...row,
    _dirty: dirty,
    _deleted: deleted,
    _local_created_at: prev?._local_created_at ?? now,
    _local_updated_at: now,
    _sync_error: null,
  };
}

async function enqueue(
  port: DbPort,
  ownerId: string,
  m: {
    entity: TableName;
    op: MutationOp;
    record_id: string;
    payload: Record<string, any>;
    natural_key_cols?: string[] | null;
    field?: string | null;
    delta?: number | null;
    base?: number | null;
    tolerance?: "drop-on-conflict" | null;
  }
): Promise<Mutation> {
  const mutation: Mutation = {
    mutation_id: newUuid(),
    owner_id: ownerId,
    entity: m.entity,
    op: m.op,
    record_id: m.record_id,
    payload: m.payload,
    natural_key_cols: m.natural_key_cols ?? null,
    field: m.field ?? null,
    delta: m.delta ?? null,
    base: m.base ?? null,
    created_at: nowIso(),
    retry_count: 0,
    last_error: null,
    status: "pending",
    next_retry_at: null,
    tolerance: m.tolerance ?? null,
  };
  await port.put("_mutations", mutation);
  return mutation;
}

/** Drop queued mutations for a record (used when a tombstone is resurrected). */
export async function dropQueuedMutations(
  port: DbPort,
  recordId: string,
  ops?: MutationOp[]
): Promise<void> {
  const queued = await port.list("_mutations", {
    eq: { record_id: recordId },
  });
  for (const m of queued) {
    if (!ops || ops.includes(m.op)) {
      await port.remove("_mutations", m.mutation_id);
    }
  }
}

/** Local equivalent of the V2.2 `prevent_historical_data_loss` trigger. */
async function assertDeletable(
  port: DbPort,
  table: TableName,
  id: string
): Promise<void> {
  const guards = DELETE_GUARD[table];
  if (!guards) return;
  let total = 0;
  for (const [childTable, fk] of guards) {
    total += await port.count(childTable, { eq: { [fk]: id } });
  }
  if (total > 0) {
    throw new Error(
      `Cannot delete from "${table}": ${total} historical record(s) still reference it. Archive it instead of deleting.`
    );
  }
}

function ownerFor(table: TableName, row: Record<string, any>, userId: string): string {
  if (table === "profiles") {
    if (!row.id) throw new Error("profiles rows require an explicit id.");
    return row.id;
  }
  return row.owner ?? userId;
}

export interface NaturalKey {
  /** Index name in STORE_DEFS, e.g. "habit_id_log_date". */
  index: string;
  cols: string[];
}

export interface Db {
  list<T = Record<string, any>>(table: TableName, opts?: ListOpts): Promise<LocalRow<T>[]>;
  get<T = Record<string, any>>(table: TableName, id: string): Promise<LocalRow<T> | null>;
  getByNaturalKey<T = Record<string, any>>(
    table: TableName,
    key: NaturalKey,
    values: Record<string, unknown>
  ): Promise<LocalRow<T> | null>;
  insert<T extends Record<string, any>>(
    table: TableName,
    row: T & { id?: string }
  ): Promise<LocalRow<T>>;
  update<T extends Record<string, any>>(
    table: TableName,
    id: string,
    patch: Partial<T>
  ): Promise<LocalRow<T>>;
  /**
   * Insert-or-update by id or natural key. Returns the local row.
   * Resurrects tombstoned rows (dropping their queued delete).
   */
  upsert<T extends Record<string, any>>(
    table: TableName,
    row: T & { id?: string },
    naturalKey?: NaturalKey,
    opts?: { tolerance?: "drop-on-conflict" | null }
  ): Promise<LocalRow<T>>;
  /**
   * Add `delta` to a numeric field (limit minutes, reading pages).
   * The mutation replays as "apply delta on top of the latest remote value",
   * so concurrent offline increments on two devices never lose counts.
   */
  increment<T extends Record<string, any>>(
    table: TableName,
    id: string | undefined,
    field: string,
    delta: number,
    seedRow: Record<string, any>,
    naturalKeyCols?: string[]
  ): Promise<LocalRow<T>>;
  /** Tombstone a row and queue a remote delete. Guarded tables throw when children exist. */
  remove(table: TableName, id: string): Promise<void>;
  count(table: TableName, opts?: ListOpts): Promise<number>;
}

async function findExisting(
  port: DbPort,
  table: TableName,
  row: Record<string, any>,
  naturalKey?: NaturalKey
): Promise<Record<string, any> | null> {
  if (row.id) {
    const byId = await port.get(table, String(row.id));
    if (byId) return byId;
  }
  if (naturalKey) {
    const key = naturalKey.cols.map((c) => row[c]);
    return port.getByIndex(table, naturalKey.index, key.length === 1 ? key[0] : key);
  }
  return null;
}

const dbImpl: Db = {
  async list<T = Record<string, any>>(table: TableName, opts?: ListOpts) {
    return (await getPort().list(table, opts)) as LocalRow<T>[];
  },

  async get<T = Record<string, any>>(table: TableName, id: string) {
    const row = await getPort().get(table, id);
    return (row ?? null) as LocalRow<T> | null;
  },

  async getByNaturalKey<T = Record<string, any>>(
    table: TableName,
    key: NaturalKey,
    values: Record<string, unknown>
  ) {
    const k = key.cols.map((c) => values[c]);
    const row = await getPort().getByIndex(table, key.index, k.length === 1 ? k[0] : k);
    return (row ?? null) as LocalRow<T> | null;
  },

  async insert<T extends Record<string, any>>(
    table: TableName,
    row: T & { id?: string }
  ): Promise<LocalRow<T>> {
    const { getPort: gp, getUserId, kick } = cx();
    const port = gp();
    const userId = getUserId()!;
    const id = String((row as any).id ?? newUuid());
    // An explicit id matching a tombstone resurrects it instead of duplicating.
    const tombstoned = await port.get(table, id);
    const full: Record<string, any> = {
      ...(row as Record<string, any>),
      id,
    };
    // profiles rows have no owner column (their PK is the user id); ownerFor is
    // still called so its "requires an explicit id" validation fires.
    const owner = ownerFor(table, row as Record<string, any>, userId);
    if (table !== "profiles") full.owner = owner;
    const rec = withMeta(full, 1, 0, (tombstoned ?? undefined) as LocalMeta | undefined);
    await port.put(table, rec);
    if (tombstoned?._deleted) await dropQueuedMutations(port, id, ["delete"]);
    await enqueue(port, userId, {
      entity: table,
      op: "insert",
      record_id: id,
      payload: stripLocalMeta(rec),
    });
    kick("write");
    return rec as LocalRow<T>;
  },

  async update<T extends Record<string, any>>(
    table: TableName,
    id: string,
    patch: Partial<T>
  ): Promise<LocalRow<T>> {
    const { getPort: gp, getUserId, kick } = cx();
    const port = gp();
    const userId = getUserId()!;
    const existing = await port.get(table, String(id));
    if (!existing || existing._deleted) throw new Error("Record not found.");
    const cleanPatch = stripLocalMeta({ ...(patch as Record<string, any>) });
    delete (cleanPatch as any).id;
    const rec = withMeta({ ...existing, ...cleanPatch }, 1, 0, existing as LocalMeta);
    await port.put(table, rec);
    await enqueue(port, userId, {
      entity: table,
      op: "update",
      record_id: String(id),
      payload: cleanPatch,
    });
    kick("write");
    return rec as LocalRow<T>;
  },

  async upsert<T extends Record<string, any>>(
    table: TableName,
    row: T & { id?: string },
    naturalKey?: NaturalKey,
    opts?: { tolerance?: "drop-on-conflict" | null }
  ): Promise<LocalRow<T>> {
    const { getPort: gp, getUserId, kick } = cx();
    const port = gp();
    const userId = getUserId()!;
    const existing = await findExisting(port, table, row as Record<string, any>, naturalKey);
    const clean = stripLocalMeta({ ...(row as Record<string, any>) });
    if (existing) {
      const merged: Record<string, any> = { ...existing, ...clean, id: existing.id };
      // Drop any legacy polluted owner key on profiles rows so they stop
      // re-emitting an owner column in queued mutations.
      if (table === "profiles") delete merged.owner;
      const rec = withMeta(merged, 1, 0, existing as LocalMeta);
      await port.put(table, rec);
      if (existing._deleted) await dropQueuedMutations(port, existing.id, ["delete"]);
      await enqueue(port, userId, {
        entity: table,
        op: "upsert",
        record_id: existing.id,
        payload: stripLocalMeta(rec),
        natural_key_cols: naturalKey?.cols ?? null,
        tolerance: opts?.tolerance ?? null,
      });
      kick("write");
      return rec as LocalRow<T>;
    }
    const id = String((row as any).id ?? newUuid());
    // profiles rows have no owner column; ownerFor still validates the id.
    const owner = ownerFor(table, row as Record<string, any>, userId);
    const fresh: Record<string, any> = { ...clean, id };
    if (table !== "profiles") fresh.owner = owner;
    const rec = withMeta(fresh, 1, 0);
    await port.put(table, rec);
    await enqueue(port, userId, {
      entity: table,
      op: "upsert",
      record_id: id,
      payload: stripLocalMeta(rec),
      natural_key_cols: naturalKey?.cols ?? null,
      tolerance: opts?.tolerance ?? null,
    });
    kick("write");
    return rec as LocalRow<T>;
  },

  async increment<T extends Record<string, any>>(
    table: TableName,
    id: string | undefined,
    field: string,
    delta: number,
    seedRow: Record<string, any>,
    naturalKeyCols?: string[]
  ): Promise<LocalRow<T>> {
    const { getPort: gp, getUserId, kick } = cx();
    const port = gp();
    const userId = getUserId()!;
    const rid = id ? String(id) : newUuid();
    const existing = id ? await port.get(table, rid) : null;
    if (existing?._deleted) throw new Error("Record not found.");
    const base = Number(existing?.[field] ?? (seedRow as any)[field] ?? 0);
    // profiles rows have no owner column; ownerFor still validates the id.
    const owner = ownerFor(table, (existing ?? seedRow) as Record<string, any>, userId);
    const mergedInc: Record<string, any> = {
      ...(existing ?? { ...(seedRow as Record<string, any>), id: rid }),
      id: rid,
      [field]: base + delta,
    };
    if (table !== "profiles") mergedInc.owner = owner;
    const rec = withMeta(
      mergedInc,
      1,
      0,
      (existing ?? undefined) as LocalMeta | undefined
    );
    await port.put(table, rec);
    await enqueue(port, userId, {
      entity: table,
      op: "increment",
      record_id: rid,
      payload: stripLocalMeta(rec),
      natural_key_cols: naturalKeyCols ?? null,
      field,
      delta,
      base,
    });
    kick("write");
    return rec as LocalRow<T>;
  },

  async remove(table: TableName, id: string): Promise<void> {
    const { getPort: gp, getUserId, kick } = cx();
    const port = gp();
    const userId = getUserId()!;
    const rid = String(id);
    await assertDeletable(port, table, rid);
    const existing = await port.get(table, rid);
    if (!existing || existing._deleted) return;
    const rec = withMeta(existing, 1, 1, existing as LocalMeta);
    await port.put(table, rec);
    await enqueue(port, userId, {
      entity: table,
      op: "delete",
      record_id: rid,
      payload: {},
    });
    kick("write");
  },

  async count(table: TableName, opts?: ListOpts): Promise<number> {
    return getPort().count(table, opts);
  },
};

/** The local-first database. Throws "Not signed in." when no user DB is open. */
export function getDb(): Db {
  cx();
  return dbImpl;
}
