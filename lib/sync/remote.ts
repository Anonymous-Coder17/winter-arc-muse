/**
 * V4.2 remote layer. `Remote` is the interface the sync engine pushes to and
 * pulls from. `SupabaseRemote` is the production implementation: it uses the
 * normal authenticated browser client, so every operation still passes through
 * RLS. No service-role keys, no admin bypasses — the client never holds them.
 *
 * `MemoryRemote` is an in-memory implementation for the deterministic tests.
 */
import type { TableName } from "./types";

export interface RemoteTable {
  /** Rows with updated_at > since (all rows when since is null), ascending. */
  selectDelta(since: string | null): Promise<Record<string, any>[]>;
  listIds(): Promise<Array<{ id: string; updated_at: string }>>;
  getById(id: string): Promise<Record<string, any> | null>;
  getByNatural(values: Record<string, unknown>): Promise<Record<string, any> | null>;
  insert(row: Record<string, any>): Promise<Record<string, any>>;
  upsertById(row: Record<string, any>): Promise<Record<string, any>>;
  upsertNatural(row: Record<string, any>, cols: string[]): Promise<Record<string, any>>;
  updateById(id: string, patch: Record<string, any>): Promise<Record<string, any>>;
  deleteById(id: string): Promise<void>;
}

export interface Remote {
  table(name: TableName): RemoteTable;
}

export type FailureKind =
  | "transient"
  | "permanent"
  | "auth"
  | "unique"
  | "restrict";

/**
 * Classify a remote failure so the engine can decide: retry with backoff,
 * fail visibly, stop for re-auth, or treat a constraint as a benign race.
 */
export function classifyRemoteError(err: any): FailureKind {
  if (!err || typeof err !== "object") {
    return err instanceof TypeError ? "transient" : "transient";
  }
  const code = String((err as any).code ?? "");
  const status = Number((err as any).status ?? 0);
  const message = String((err as any).message ?? "");
  // Postgres unique violation (seed races, natural-key races).
  if (code === "23505") return "unique";
  // V2.2 deletion guard / reading_logs RESTRICT.
  if (code === "23001" || code === "23503") return "restrict";
  // Auth: expired/invalid JWT, RLS denial (wrong user).
  if (status === 401 || status === 403 || code === "42501") return "auth";
  if (/^PGRST301/.test(code)) return "auth";
  // Rate limit / overloaded / gateway.
  if (status === 408 || status === 429 || status >= 500) return "transient";
  // Network-level failure (offline mid-request, DNS, CORS).
  if (/fetch failed|failed to fetch|networkerror|load failed|network request failed/i.test(message))
    return "transient";
  // Bad request / not found / unprocessable: retrying won't help.
  if (status === 400 || status === 404 || status === 406 || status === 422)
    return "permanent";
  // Unknown: retry cautiously (bounded retries cap the damage).
  return "transient";
}

type SupabaseClientLike = {
  from(table: string): any;
};

/** Production remote: the authenticated browser Supabase client (RLS applies). */
export class SupabaseRemote implements Remote {
  private getClient: () => SupabaseClientLike;
  constructor(getClient: () => SupabaseClientLike) {
    this.getClient = getClient;
  }

  table(name: TableName): RemoteTable {
    const client = this.getClient();
    const q = () => client.from(name);
    return {
      async selectDelta(since: string | null) {
        let query = q().select("*").order("updated_at", { ascending: true });
        if (since) query = query.gt("updated_at", since);
        const { data, error } = await query;
        if (error) throw error;
        return data ?? [];
      },
      async listIds() {
        const { data, error } = await q().select("id,updated_at");
        if (error) throw error;
        return (data ?? []).map((r: any) => ({
          id: String(r.id),
          updated_at: String(r.updated_at),
        }));
      },
      async getById(id: string) {
        const { data, error } = await q().select("*").eq("id", id).maybeSingle();
        if (error) throw error;
        return data ?? null;
      },
      async getByNatural(values: Record<string, unknown>) {
        let query = q().select("*");
        for (const [k, v] of Object.entries(values)) query = query.eq(k, v);
        const { data, error } = await query.maybeSingle();
        if (error) throw error;
        return data ?? null;
      },
      async insert(row: Record<string, any>) {
        const { data, error } = await q().insert(row).select().single();
        if (error) throw error;
        return data;
      },
      async upsertById(row: Record<string, any>) {
        const { data, error } = await q()
          .upsert(row, { onConflict: "id" })
          .select()
          .single();
        if (error) throw error;
        return data;
      },
      async upsertNatural(row: Record<string, any>, cols: string[]) {
        const { data, error } = await q()
          .upsert(row, { onConflict: cols.join(",") })
          .select()
          .single();
        if (error) throw error;
        return data;
      },
      async updateById(id: string, patch: Record<string, any>) {
        const { data, error } = await q()
          .update(patch)
          .eq("id", id)
          .select()
          .single();
        if (error) throw error;
        return data;
      },
      async deleteById(id: string) {
        const { error } = await q().delete().eq("id", id);
        if (error) throw error;
      },
    };
  }
}

/**
 * In-memory Remote for deterministic tests. Supports unique-constraint
 * simulation, injected failures, and offline mode.
 */
export class MemoryRemote implements Remote {
  /** table -> id -> row */
  rows = new Map<TableName, Map<string, Record<string, any>>>();
  /** table -> list of unique column sets */
  uniques = new Map<TableName, string[][]>();
  /** When set, every call fails with this error (consumed per call). */
  failNext: any = null;
  /** When true, every call throws a network TypeError. */
  offline = false;
  /** Log of operations for assertions. */
  log: Array<{ table: TableName; op: string; id?: string }> = [];

  private tableRows(t: TableName): Map<string, Record<string, any>> {
    let m = this.rows.get(t);
    if (!m) {
      m = new Map();
      this.rows.set(t, m);
    }
    return m;
  }

  private checkFail() {
    if (this.offline) throw new TypeError("fetch failed");
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
  }

  private checkUnique(
    t: TableName,
    row: Record<string, any>,
    ignoreId?: string
  ): void {
    for (const cols of this.uniques.get(t) ?? []) {
      for (const [id, r] of this.tableRows(t)) {
        if (ignoreId && id === ignoreId) continue;
        if (cols.every((c) => r[c] === row[c])) {
          throw { code: "23505", status: 409, message: `duplicate key (${cols.join(",")})` };
        }
      }
    }
  }

  seed(t: TableName, row: Record<string, any>): void {
    this.tableRows(t).set(String(row.id), { ...row });
  }

  table(name: TableName): RemoteTable {
    const self = this;
    return {
      async selectDelta(since: string | null) {
        self.checkFail();
        const rows = [...self.tableRows(name).values()];
        const out = since ? rows.filter((r) => r.updated_at > since) : rows;
        out.sort((a, b) => (a.updated_at < b.updated_at ? -1 : 1));
        return out.map((r) => ({ ...r }));
      },
      async listIds() {
        self.checkFail();
        return [...self.tableRows(name).values()].map((r) => ({
          id: String(r.id),
          updated_at: String(r.updated_at),
        }));
      },
      async getById(id: string) {
        self.checkFail();
        const r = self.tableRows(name).get(String(id));
        return r ? { ...r } : null;
      },
      async getByNatural(values: Record<string, unknown>) {
        self.checkFail();
        for (const r of self.tableRows(name).values()) {
          if (Object.entries(values).every(([k, v]) => r[k] === v))
            return { ...r };
        }
        return null;
      },
      async insert(row: Record<string, any>) {
        self.checkFail();
        self.log.push({ table: name, op: "insert", id: String(row.id) });
        if (self.tableRows(name).has(String(row.id))) {
          throw { code: "23505", status: 409, message: "duplicate key (id)" };
        }
        self.checkUnique(name, row);
        const now = new Date().toISOString();
        const created = {
          ...row,
          created_at: row.created_at ?? now,
          updated_at: row.updated_at ?? now,
        };
        self.tableRows(name).set(String(row.id), created);
        return { ...created };
      },
      async upsertById(row: Record<string, any>) {
        self.checkFail();
        self.log.push({ table: name, op: "upsertById", id: String(row.id) });
        const now = new Date().toISOString();
        const prev = self.tableRows(name).get(String(row.id));
        self.checkUnique(name, row, String(row.id));
        const merged = {
          ...(prev ?? {}),
          ...row,
          created_at: prev?.created_at ?? row.created_at ?? now,
          updated_at: now,
        };
        self.tableRows(name).set(String(row.id), merged);
        return { ...merged };
      },
      async upsertNatural(row: Record<string, any>, cols: string[]) {
        self.checkFail();
        self.log.push({ table: name, op: "upsertNatural", id: String(row.id) });
        const now = new Date().toISOString();
        let target: Record<string, any> | null = null;
        for (const r of self.tableRows(name).values()) {
          if (cols.every((c) => r[c] === row[c])) {
            target = r;
            break;
          }
        }
        if (!target) return self.table(name).insert(row);
        self.checkUnique(name, row, String(target.id));
        const merged = { ...target, ...row, id: target.id, updated_at: now };
        self.tableRows(name).set(String(target.id), merged);
        return { ...merged };
      },
      async updateById(id: string, patch: Record<string, any>) {
        self.checkFail();
        self.log.push({ table: name, op: "updateById", id });
        const prev = self.tableRows(name).get(String(id));
        if (!prev) throw { code: "PGRST116", status: 406, message: "no rows" };
        const merged = { ...prev, ...patch, updated_at: new Date().toISOString() };
        self.tableRows(name).set(String(id), merged);
        return { ...merged };
      },
      async deleteById(id: string) {
        self.checkFail();
        self.log.push({ table: name, op: "deleteById", id });
        self.tableRows(name).delete(String(id));
      },
    };
  }
}
