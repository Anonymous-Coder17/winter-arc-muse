/**
 * V4.2 storage ports. `DbPort` is the interface every sync algorithm is
 * written against. `IdbPort` is the production IndexedDB implementation
 * (via the tiny `idb` wrapper). `MemoryPort` is an equivalent in-memory
 * implementation used by the deterministic test suite.
 *
 * No browser globals are touched at module import time.
 */
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import {
  DB_VERSION,
  type StoreName,
  type TableName,
  TABLES,
} from "./types";

export interface OrderSpec {
  col: string;
  ascending: boolean;
}

export interface ListOpts {
  eq?: Record<string, unknown>;
  gt?: Record<string, unknown>;
  gte?: Record<string, unknown>;
  lt?: Record<string, unknown>;
  lte?: Record<string, unknown>;
  in?: Record<string, unknown[]>;
  order?: OrderSpec[];
  limit?: number;
  /** Tombstoned rows are excluded unless this is true. */
  includeDeleted?: boolean;
}

export interface DbPort {
  list(store: StoreName, opts?: ListOpts): Promise<Record<string, any>[]>;
  get(store: StoreName, id: string): Promise<Record<string, any> | null>;
  getByIndex(
    store: StoreName,
    index: string,
    key: unknown
  ): Promise<Record<string, any> | null>;
  put(store: StoreName, row: Record<string, any>): Promise<void>;
  /** Hard delete (tombstone GC, remote-delete reconciliation). */
  remove(store: StoreName, id: string): Promise<void>;
  count(store: StoreName, opts?: ListOpts): Promise<number>;
  close(): void;
}

interface IndexDef {
  name: string;
  keyPath: string | string[];
  unique?: boolean;
}

const IDX = (
  name: string,
  keyPath: string | string[],
  unique = false
): IndexDef => ({ name, keyPath, unique });

/** Index per store. Compound unique indexes back natural-key upserts. */
export const STORE_DEFS: Record<StoreName, { indexes: IndexDef[] }> = {
  tasks: { indexes: [IDX("task_date", "task_date")] },
  calendar_events: { indexes: [IDX("event_date", "event_date")] },
  habits: { indexes: [] },
  habit_logs: {
    indexes: [
      IDX("log_date", "log_date"),
      IDX("habit_id_log_date", ["habit_id", "log_date"], true),
    ],
  },
  challenges: { indexes: [IDX("is_active", "is_active")] },
  abstinence_rules: { indexes: [] },
  abstinence_incidents: { indexes: [IDX("occurred_at", "occurred_at")] },
  usage_limits: { indexes: [] },
  limit_logs: {
    indexes: [
      IDX("log_date", "log_date"),
      IDX("limit_id_log_date", ["limit_id", "log_date"], true),
    ],
  },
  workouts: { indexes: [] },
  workout_exercises: { indexes: [IDX("workout_id", "workout_id")] },
  workout_sessions: {
    indexes: [IDX("session_date", "session_date"), IDX("workout_id", "workout_id")],
  },
  workout_sets: {
    indexes: [
      IDX("session_id", "session_id"),
      IDX(
        "session_exercise_set",
        ["session_id", "exercise_id", "set_number"],
        true
      ),
    ],
  },
  training_schedule: { indexes: [IDX("weekday", "weekday", true)] },
  subjects: { indexes: [] },
  topics: { indexes: [IDX("subject_id", "subject_id")] },
  study_sessions: {
    indexes: [IDX("session_date", "session_date"), IDX("subject_id", "subject_id")],
  },
  journal_entries: { indexes: [IDX("entry_date", "entry_date", true)] },
  daily_reviews: { indexes: [IDX("review_date", "review_date", true)] },
  weekly_reviews: { indexes: [IDX("week_start", "week_start", true)] },
  challenge_reviews: { indexes: [IDX("challenge_id", "challenge_id", true)] },
  books: { indexes: [] },
  reading_logs: {
    indexes: [IDX("log_date", "log_date"), IDX("book_id", "book_id")],
  },
  profiles: { indexes: [] },
  daily_records: { indexes: [IDX("record_date", "record_date")] },
  _mutations: {
    indexes: [
      IDX("status", "status"),
      IDX("record_id", "record_id"),
      IDX("created_at", "created_at"),
      IDX("owner_id", "owner_id"),
    ],
  },
  _meta: { indexes: [] },
  _conflicts: { indexes: [IDX("created_at", "created_at")] },
};

function keyPathFor(store: StoreName): string {
  if (store === "_mutations") return "mutation_id";
  if (store === "_meta") return "key";
  return "id";
}

// Loosely typed: store names are dynamic (25 entity stores + 3 internal).
type WinterArcDB = any;

function isEntityStore(store: StoreName): store is TableName {
  return (TABLES as readonly string[]).includes(store);
}

function matches(
  row: Record<string, any>,
  opts: ListOpts | undefined,
  skipCols: Set<string>
): boolean {
  if (!opts) return true;
  const groups: Array<[Record<string, unknown> | undefined, (a: any, b: any) => boolean]> = [
    [opts.eq, (a, b) => a === b],
    [opts.gt, (a, b) => a != null && b != null && a > b],
    [opts.gte, (a, b) => a != null && b != null && a >= b],
    [opts.lt, (a, b) => a != null && b != null && a < b],
    [opts.lte, (a, b) => a != null && b != null && a <= b],
  ];
  for (const [group, cmp] of groups) {
    if (!group) continue;
    for (const [col, val] of Object.entries(group)) {
      if (skipCols.has(col)) continue;
      if (!cmp(row[col], val)) return false;
    }
  }
  if (opts.in) {
    for (const [col, vals] of Object.entries(opts.in)) {
      if (skipCols.has(col)) continue;
      if (!vals.includes(row[col])) return false;
    }
  }
  return true;
}

function sortRows(
  rows: Record<string, any>[],
  order: OrderSpec[] | undefined
): Record<string, any>[] {
  if (!order || order.length === 0) return rows;
  const copy = [...rows];
  copy.sort((a, b) => {
    for (const { col, ascending } of order) {
      const av = a[col];
      const bv = b[col];
      if (av === bv) continue;
      // Match Postgres default: NULLS LAST for ASC, NULLS FIRST for DESC.
      if (av == null) return ascending ? 1 : -1;
      if (bv == null) return ascending ? -1 : 1;
      const c = av < bv ? -1 : 1;
      return ascending ? c : -c;
    }
    return 0;
  });
  return copy;
}

function applyTombstoneFilter(
  rows: Record<string, any>[],
  store: StoreName,
  opts: ListOpts | undefined
): Record<string, any>[] {
  if (!isEntityStore(store) || opts?.includeDeleted) return rows;
  return rows.filter((r) => r._deleted !== 1);
}

/** Pick an index to narrow the scan, and the columns it already covers. */
function pickIndex(
  store: StoreName,
  opts: ListOpts | undefined
): { def: IndexDef; getAll: (idx: any) => Promise<Record<string, any>[]>; covered: Set<string> } | null {
  if (!opts) return null;
  const IDBKR: typeof IDBKeyRange | undefined = (globalThis as any).IDBKeyRange;
  const defs = STORE_DEFS[store].indexes;
  for (const def of defs) {
    const cols = Array.isArray(def.keyPath) ? def.keyPath : [def.keyPath];
    if (cols.length > 1) {
      // Compound index: usable when eq covers a leading prefix of the key.
      const prefix: unknown[] = [];
      for (const c of cols) {
        if (opts.eq && c in opts.eq) prefix.push((opts.eq as Record<string, unknown>)[c]);
        else break;
      }
      if (prefix.length === 0) continue;
      const covered = new Set(cols.slice(0, prefix.length));
      if (prefix.length === cols.length) {
        const key = prefix.length === 1 ? prefix[0] : prefix;
        return { def, getAll: (idx) => idx.getAll(key), covered };
      }
      if (!IDBKR) continue;
      const range = IDBKR.bound(prefix, [...prefix, []]);
      return { def, getAll: (idx) => idx.getAll(range), covered };
    }
    const col = cols[0];
    if (opts.eq && col in opts.eq) {
      const key = (opts.eq as Record<string, unknown>)[col];
      return { def, getAll: (idx) => idx.getAll(key), covered: new Set([col]) };
    }
    const lo = opts.gte?.[col] ?? opts.gt?.[col];
    const hi = opts.lte?.[col] ?? opts.lt?.[col];
    if ((lo !== undefined || hi !== undefined) && IDBKR) {
      const loEx = opts.gte?.[col] === undefined && opts.gt?.[col] !== undefined;
      const hiEx = opts.lte?.[col] === undefined && opts.lt?.[col] !== undefined;
      const range =
        lo !== undefined && hi !== undefined
          ? IDBKR.bound(lo, hi, loEx, hiEx)
          : lo !== undefined
            ? IDBKR.lowerBound(lo, loEx)
            : IDBKR.upperBound(hi!, hiEx);
      const covered = new Set<string>();
      if (lo !== undefined) covered.add(col);
      if (hi !== undefined) covered.add(col);
      return { def, getAll: (idx) => idx.getAll(range), covered };
    }
  }
  return null;
}

export class IdbPort implements DbPort {
  private db: IDBPDatabase<any>;
  constructor(db: IDBPDatabase<any>) {
    this.db = db;
  }

  private async tx<T>(
    store: StoreName,
    mode: IDBTransactionMode,
    fn: (s: any) => Promise<T>
  ): Promise<T> {
    const tx = this.db.transaction(store as any, mode);
    const result = await fn(tx.objectStore(store));
    await tx.done;
    return result;
  }

  async list(store: StoreName, opts: ListOpts = {}): Promise<Record<string, any>[]> {
    if (opts.in) {
      for (const vals of Object.values(opts.in)) {
        if (vals.length === 0) return [];
      }
    }
    return this.tx(store, "readonly", async (s) => {
      const picked = pickIndex(store, opts);
      const rows: Record<string, any>[] = picked
        ? await picked.getAll(s.index(picked.def.name))
        : await s.getAll();
      let out = rows.filter((row) => matches(row, opts, picked?.covered ?? new Set()));
      out = applyTombstoneFilter(out, store, opts);
      out = sortRows(out, opts.order);
      if (opts.limit !== undefined) out = out.slice(0, opts.limit);
      return out;
    });
  }

  async get(store: StoreName, id: string): Promise<Record<string, any> | null> {
    return this.tx(store, "readonly", async (s) => {
      const row = await s.get(id);
      return row ?? null;
    });
  }

  async getByIndex(
    store: StoreName,
    index: string,
    key: unknown
  ): Promise<Record<string, any> | null> {
    return this.tx(store, "readonly", async (s) => {
      const row = await s.index(index).get(key as any);
      return row ?? null;
    });
  }

  async put(store: StoreName, row: Record<string, any>): Promise<void> {
    await this.tx(store, "readwrite", async (s) => {
      await s.put(row);
    });
  }

  async remove(store: StoreName, id: string): Promise<void> {
    await this.tx(store, "readwrite", async (s) => {
      await s.delete(id);
    });
  }

  async count(store: StoreName, opts: ListOpts = {}): Promise<number> {
    const rows = await this.list(store, opts);
    return rows.length;
  }

  close(): void {
    this.db.close();
  }
}

/** Open (or create) the per-user IndexedDB database. */
export async function openIdbPort(dbName: string): Promise<IdbPort> {
  const db: IDBPDatabase<WinterArcDB> = await openDB(dbName, DB_VERSION, {
    upgrade(u: any) {
      for (const [name, def] of Object.entries(STORE_DEFS)) {
        if (u.objectStoreNames.contains(name)) continue;
        const store = u.createObjectStore(name, { keyPath: keyPathFor(name as StoreName) });
        for (const idx of def.indexes) {
          store.createIndex(idx.name, idx.keyPath, { unique: !!idx.unique });
        }
      }
    },
  });
  return new IdbPort(db);
}

/** In-memory DbPort — behaviorally equivalent, used by the test suite. */
export class MemoryPort implements DbPort {
  private data = new Map<StoreName, Map<string, Record<string, any>>>();

  private map(store: StoreName): Map<string, Record<string, any>> {
    let m = this.data.get(store);
    if (!m) {
      m = new Map();
      this.data.set(store, m);
    }
    return m;
  }

  private keyOf(store: StoreName, row: Record<string, any>): string {
    return String(row[keyPathFor(store)]);
  }

  async list(store: StoreName, opts: ListOpts = {}): Promise<Record<string, any>[]> {
    if (opts.in) {
      for (const vals of Object.values(opts.in)) {
        if (vals.length === 0) return [];
      }
    }
    let rows = [...this.map(store).values()];
    rows = rows.filter((r) => matches(r, opts, new Set()));
    rows = applyTombstoneFilter(rows, store, opts);
    rows = sortRows(rows, opts.order);
    if (opts.limit !== undefined) rows = rows.slice(0, opts.limit);
    return rows.map((r) => ({ ...r }));
  }

  async get(store: StoreName, id: string): Promise<Record<string, any> | null> {
    const row = this.map(store).get(String(id));
    return row ? { ...row } : null;
  }

  async getByIndex(
    store: StoreName,
    index: string,
    key: unknown
  ): Promise<Record<string, any> | null> {
    const def = STORE_DEFS[store].indexes.find((d) => d.name === index);
    if (!def) return null;
    const cols = Array.isArray(def.keyPath) ? def.keyPath : [def.keyPath];
    const want = Array.isArray(key) ? key : [key];
    for (const row of this.map(store).values()) {
      let ok = true;
      for (let i = 0; i < cols.length && i < want.length; i++) {
        if (row[cols[i]] !== want[i]) {
          ok = false;
          break;
        }
      }
      if (ok && want.length <= cols.length) return { ...row };
    }
    return null;
  }

  async put(store: StoreName, row: Record<string, any>): Promise<void> {
    this.map(store).set(this.keyOf(store, row), { ...row });
  }

  async remove(store: StoreName, id: string): Promise<void> {
    this.map(store).delete(String(id));
  }

  async count(store: StoreName, opts: ListOpts = {}): Promise<number> {
    return (await this.list(store, opts)).length;
  }

  close(): void {
    // in-memory; nothing to release
  }
}
