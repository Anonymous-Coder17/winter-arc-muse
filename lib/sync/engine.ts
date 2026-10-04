/**
 * V4.2 sync engine.
 *
 * Owns the per-user IndexedDB (`DbPort`), the durable mutation queue, and the
 * push/pull cycle against Supabase. Supabase stays the single cloud source of
 * truth; the local DB is a cache + mutation layer.
 *
 * Conflict policy (documented for the V4.2 report):
 * - Append-only logs (study/reading/hifz/workout sessions, incidents, sets):
 *   independent records keyed by stable client UUIDs; retries never duplicate
 *   (insert checks existence first; natural-key upserts are idempotent).
 * - Additive counters (limit minutes, reading pages): the mutation carries a
 *   delta; replay applies the delta on top of the latest remote value, so
 *   concurrent offline increments on two devices never lose counts. A retry
 *   that finds the exact expected value already present is treated as success.
 * - Mutable config/records (habits, tasks, events, books, journal text,
 *   reviews, …): last-write-wins by wall clock. `updated_at` is server-stamped
 *   and trustworthy; the local write time is client-stamped (clock-skew
 *   caveat documented). The loser is recorded in `_conflicts`, never silently
 *   dropped.
 * - Deletions: tombstones. A delete wins only if the remote row is unchanged
 *   since we last saw it; a concurrent remote update resurrects the row
 *   (update-wins) and is logged. A remote delete of our pending update
 *   resurrects via re-insert (update-wins). V2.2 deletion guards are enforced
 *   locally before a tombstone is even created, and a remote 23001 rejection
 *   restores the local row instead of diverging.
 *
 * No browser globals are touched at module import time. Everything client-only
 * runs behind `start()` (called from AppShell).
 */
import {
  backoffDelayMs,
  DB_NAME_PREFIX,
  MAX_RETRIES,
  newUuid,
  nowIso,
  PUSH_LEVEL,
  SHELL_CACHE,
  stripLocalMeta,
  TABLES,
  type ConflictRecord,
  type LocalRow,
  type Mutation,
  type TableName,
} from "./types";
import { openIdbPort, type DbPort } from "./ports";
import { setSyncContext, dropQueuedMutations } from "./write";
import {
  classifyRemoteError,
  SupabaseRemote,
  type Remote,
  type RemoteTable,
} from "./remote";
import { browserClient, getSessionUserId } from "./session";

export type NetState = "online" | "offline" | "unknown";

export interface SyncSnapshot {
  started: boolean;
  userId: string | null;
  net: NetState;
  syncing: boolean;
  /** Queued (incl. scheduled retries). */
  pending: number;
  /** Failed visibly; user work preserved, retryable. */
  failed: number;
  conflictCount: number;
  lastSyncAt: string | null;
  authIssue: boolean;
  /** Record ids with pending/failed mutations (per-data sync status). */
  pendingIds: Set<string>;
}

type Outcome = "ok" | "superseded" | "retry" | "failed" | "auth-stop";

const freshSnapshot = (): SyncSnapshot => ({
  started: false,
  userId: null,
  net: "unknown",
  syncing: false,
  pending: 0,
  failed: 0,
  conflictCount: 0,
  lastSyncAt: null,
  authIssue: false,
  pendingIds: new Set(),
});

function cleanRow(row: Record<string, any>): Record<string, any> {
  return {
    ...row,
    _dirty: 0,
    _deleted: 0,
    _local_created_at: (row.created_at as string) ?? nowIso(),
    _local_updated_at: nowIso(),
    _sync_error: null,
  };
}

class SyncEngine {
  private started = false;
  private port: DbPort | null = null;
  private userId: string | null = null;
  private syncing = false;
  private stopRequested = false;
  private kickTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private switching: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private readyWaiters: Array<() => void> = [];
  private snap: SyncSnapshot = freshSnapshot();
  private remoteOverride: Remote | null = null;
  private supabaseRemote: SupabaseRemote | null = null;

  // ------------------------------------------------------------------ status

  getSnapshot(): SyncSnapshot {
    return this.snap;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private patchSnap(p: Partial<SyncSnapshot>): void {
    this.snap = { ...this.snap, ...p };
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* listener errors must not break sync */
      }
    }
  }

  /** Resolves once a per-user DB is open (first auth + initial pull). */
  whenReady(): Promise<void> {
    if (this.port && this.userId) return Promise.resolve();
    return new Promise((res) => {
      this.readyWaiters.push(res);
    });
  }

  private flushReady(): void {
    const w = this.readyWaiters;
    this.readyWaiters = [];
    for (const fn of w) fn();
  }

  private remote(): Remote {
    if (this.remoteOverride) return this.remoteOverride;
    if (!this.supabaseRemote) {
      this.supabaseRemote = new SupabaseRemote(() => browserClient());
    }
    return this.supabaseRemote;
  }

  // -------------------------------------------------------------- lifecycle

  start(): void {
    if (this.started || typeof window === "undefined") return;
    this.started = true;
    setSyncContext({
      getPort: () => {
        if (!this.port) throw new Error("Not signed in.");
        return this.port;
      },
      getUserId: () => this.userId,
      kick: () => this.kick(),
    });
    try {
      browserClient().auth.onAuthStateChange((_event, session) => {
        void this.onAuthEvent(session?.user?.id ?? null);
      });
    } catch {
      /* auth unavailable (e.g. missing env keys): stay inert */
    }
    void getSessionUserId()
      .then((uid) => {
        if (uid) void this.onAuthEvent(uid);
      })
      .catch(() => {});
    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onOffline);
    document.addEventListener("visibilitychange", this.onVisible);
    this.heartbeatTimer = window.setInterval(() => void this.heartbeat(), 45_000);
    this.patchSnap({ started: true });
    this.notify();
  }

  stop(): void {
    this.started = false;
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.onOnline);
      window.removeEventListener("offline", this.onOffline);
      document.removeEventListener("visibilitychange", this.onVisible);
      if (this.heartbeatTimer) window.clearInterval(this.heartbeatTimer);
      if (this.kickTimer) window.clearTimeout(this.kickTimer);
    }
    this.heartbeatTimer = null;
    this.kickTimer = null;
    this.closePort();
    this.userId = null;
  }

  private onOnline = (): void => {
    this.patchSnap({ net: "online" });
    this.kick();
    this.notify();
  };

  private onOffline = (): void => {
    this.patchSnap({ net: "offline" });
    this.notify();
  };

  private onVisible = (): void => {
    if (typeof document !== "undefined" && !document.hidden) this.kick();
  };

  private async heartbeat(): Promise<void> {
    if (!this.userId) {
      const uid = await getSessionUserId().catch(() => null);
      if (uid) void this.onAuthEvent(uid);
      return;
    }
    this.kick();
  }

  private async onAuthEvent(uid: string | null): Promise<void> {
    if (!uid) {
      await this.handleLogout();
      return;
    }
    if (uid === this.userId && this.port) {
      this.kick();
      return;
    }
    if (!this.switching) {
      this.switching = this.switchUser(uid).finally(() => {
        this.switching = null;
      });
    }
    await this.switching;
  }

  /** Explicit logout: close the user's DB and purge the cached app shell. */
  async handleLogout(): Promise<void> {
    this.closePort();
    this.userId = null;
    await this.purgeShellCache();
    const started = this.snap.started;
    this.snap = { ...freshSnapshot(), started };
    this.notify();
  }

  private closePort(): void {
    try {
      this.port?.close();
    } catch {
      /* ignore */
    }
    this.port = null;
  }

  private async purgeShellCache(): Promise<void> {
    try {
      if (typeof caches !== "undefined") await caches.delete(SHELL_CACHE);
    } catch {
      /* ignore */
    }
  }

  private async switchUser(uid: string): Promise<void> {
    this.closePort();
    this.userId = uid;
    this.patchSnap({
      userId: uid,
      authIssue: false,
      pending: 0,
      failed: 0,
      conflictCount: 0,
      pendingIds: new Set(),
      lastSyncAt: null,
    });
    this.notify();
    // Never serve one account's cached app shell to another.
    await this.purgeShellCache();
    try {
      this.port = await openIdbPort(DB_NAME_PREFIX + uid);
    } catch {
      this.port = null;
      return;
    }
    // Crash recovery: mutations stuck in `inflight` go back to pending.
    const stuck = await this.port.list("_mutations", { eq: { status: "inflight" } });
    for (const m of stuck) {
      await this.port.put("_mutations", {
        ...m,
        status: "pending",
        next_retry_at: null,
      });
    }
    const done = await this.metaGet("initial_pull_done");
    if (!done) {
      try {
        await this.pull();
        await this.metaPut("initial_pull_done", "1");
      } catch {
        /* offline on first launch: hooks read the empty cache; sync retries */
      }
    }
    this.flushReady();
    await this.refreshCounts().catch(() => {});
    this.notify();
    this.kick();
  }

  // ------------------------------------------------------------ sync driver

  /** Debounced "something changed, sync soon". Safe to call from writes. */
  kick(): void {
    if (!this.started || typeof window === "undefined") return;
    if (this.kickTimer) window.clearTimeout(this.kickTimer);
    this.kickTimer = window.setTimeout(() => {
      this.kickTimer = null;
      void this.syncNow();
    }, 700);
  }

  async syncNow(): Promise<void> {
    if (typeof window === "undefined") return;
    if (!this.started || this.syncing) return;
    const run = () => this.cycle();
    try {
      const nav = navigator as any;
      if (nav?.locks?.request) {
        await nav.locks.request("winter-arc-sync", run);
        return;
      }
    } catch {
      /* fall through to direct run */
    }
    await run();
  }

  /** Retry visibly-failed mutations now (slow backoff also retries them). */
  async retryFailed(): Promise<void> {
    const port = this.port;
    if (!port) return;
    const failed = await port.list("_mutations", { eq: { status: "failed" } });
    for (const m of failed) {
      await port.put("_mutations", {
        ...m,
        status: "pending",
        next_retry_at: null,
        last_error: null,
      });
    }
    await this.refreshCounts();
    this.notify();
    this.kick();
  }

  private async cycle(): Promise<void> {
    if (this.syncing) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      this.patchSnap({ net: "offline" });
      this.notify();
      return;
    }
    const port = this.port;
    const uid = this.userId;
    if (!port || !uid) return;
    this.syncing = true;
    this.stopRequested = false;
    this.patchSnap({ syncing: true, net: "online" });
    this.notify();
    try {
      const sessionUid = await getSessionUserId();
      if (!sessionUid) {
        this.patchSnap({ authIssue: true });
        return;
      }
      if (sessionUid !== uid) {
        await this.switchUser(sessionUid);
        return;
      }
      this.patchSnap({ authIssue: false });
      await this.push();
      if (!this.stopRequested) {
        await this.pull();
        this.patchSnap({ lastSyncAt: nowIso() });
      }
    } catch {
      /* Unexpected mid-cycle failure: stay calm, retry on next kick. */
    } finally {
      await this.refreshCounts().catch(() => {});
      this.syncing = false;
      this.patchSnap({ syncing: false });
      this.notify();
    }
  }

  // ------------------------------------------------------------------- push

  private async push(): Promise<void> {
    const port = this.port!;
    const uid = this.userId!;
    const now = nowIso();
    const all = await port.list("_mutations", {
      eq: { owner_id: uid },
      order: [{ col: "created_at", ascending: true }],
    });
    const due = all.filter(
      (m) =>
        (m.status === "pending" || m.status === "failed") &&
        (!m.next_retry_at || m.next_retry_at <= now)
    );
    due.sort(
      (a, b) =>
        PUSH_LEVEL[a.entity as TableName] - PUSH_LEVEL[b.entity as TableName] ||
        (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0)
    );
    for (const m of due) {
      if (this.stopRequested) break;
      await this.executeClaimed(m as Mutation);
    }
    await this.refreshCounts();
  }

  private async executeClaimed(m: Mutation): Promise<void> {
    const port = this.port!;
    m.status = "inflight";
    await port.put("_mutations", m);
    this.notify();
    let outcome: Outcome;
    try {
      outcome = await this.execute(m);
    } catch (e) {
      outcome = await this.handleOpError(port, this.remote().table(m.entity), m, e);
    }
    if (outcome === "auth-stop") {
      m.status = "pending";
      m.next_retry_at = null;
      m.last_error = "Sign-in needed.";
      await port.put("_mutations", m);
      return;
    }
    if (outcome === "ok" || outcome === "superseded") {
      await port.remove("_mutations", m.mutation_id);
      await this.markRecordClean(m);
      return;
    }
    if (outcome === "retry") {
      m.retry_count += 1;
      m.status = "pending";
      m.next_retry_at = new Date(
        Date.now() + backoffDelayMs(m.retry_count)
      ).toISOString();
      await port.put("_mutations", m);
      return;
    }
    // failed: visible, work preserved; transient-exhausted retries on slow backoff.
    m.status = "failed";
    await port.put("_mutations", m);
    const local = await port.get(m.entity, m.record_id);
    if (local) {
      await port.put(m.entity, { ...local, _sync_error: m.last_error });
    }
    await this.refreshCounts();
    this.notify();
  }

  private async execute(m: Mutation): Promise<Outcome> {
    const port = this.port!;
    const R = this.remote().table(m.entity);
    try {
      switch (m.op) {
        case "insert":
          return await this.execInsert(port, R, m);
        case "update":
          return await this.execUpdate(port, R, m);
        case "upsert":
          return await this.execUpsert(port, R, m);
        case "increment":
          return await this.execIncrement(port, R, m);
        case "delete":
          return await this.execDelete(port, R, m);
      }
    } catch (e) {
      return await this.handleOpError(port, R, m, e);
    }
  }

  /** Strip local meta; inserts carry honest client timestamps (the DB trigger
   * only stamps updated_at on UPDATE, so explicit insert values survive). */
  private sendable(row: Record<string, any>, isInsert: boolean): Record<string, any> {
    const out = stripLocalMeta({ ...row });
    if (isInsert) {
      out.created_at = (row as any)._local_created_at ?? nowIso();
      out.updated_at = (row as any)._local_updated_at ?? nowIso();
    } else {
      delete out.created_at;
      delete out.updated_at;
    }
    return out;
  }

  private async absorbRemote(
    port: DbPort,
    entity: TableName,
    remoteRow: Record<string, any>,
    dropLocalId?: string
  ): Promise<void> {
    if (dropLocalId && dropLocalId !== String(remoteRow.id)) {
      await port.remove(entity, dropLocalId);
    }
    const prev = await port.get(entity, String(remoteRow.id));
    await port.put(entity, {
      ...cleanRow(remoteRow),
      _local_created_at:
        (prev as any)?._local_created_at ?? (remoteRow.created_at as string) ?? nowIso(),
    });
  }

  private async logConflict(
    port: DbPort,
    m: Mutation,
    kind: ConflictRecord["kind"],
    detail: string
  ): Promise<void> {
    const rec: ConflictRecord = {
      id: newUuid(),
      owner_id: m.owner_id,
      created_at: nowIso(),
      entity: m.entity,
      record_id: m.record_id,
      kind,
      detail,
    };
    await port.put("_conflicts", rec);
  }

  private async execInsert(
    port: DbPort,
    R: RemoteTable,
    m: Mutation
  ): Promise<Outcome> {
    const existing = await R.getById(m.record_id);
    if (existing) {
      // Retry after a lost response: the row is already there. Idempotent.
      await this.absorbRemote(port, m.entity, existing);
      return "ok";
    }
    const created = await R.insert(this.sendable(m.payload, true));
    await this.absorbRemote(port, m.entity, created);
    return "ok";
  }

  private async execUpdate(
    port: DbPort,
    R: RemoteTable,
    m: Mutation
  ): Promise<Outcome> {
    const local = (await port.get(m.entity, m.record_id)) as LocalRow | null;
    if (!local || local._deleted) return "ok";
    const remote = await R.getById(m.record_id);
    if (!remote) {
      // Deleted on another device; the user's edit wins → re-insert latest state.
      const created = await R.insert(this.sendable(local, true)).catch(async (e) => {
        if (classifyRemoteError(e) === "unique") return R.getById(m.record_id);
        throw e;
      });
      if (created) await this.absorbRemote(port, m.entity, created);
      return "ok";
    }
    if (
      remote.updated_at &&
      (local as any).updated_at &&
      remote.updated_at > (local as any).updated_at
    ) {
      // Concurrent remote change: last-write-wins by wall clock.
      if (local._local_updated_at > remote.updated_at) {
        const updated = await R.updateById(m.record_id, this.sendable(m.payload, false));
        await this.absorbRemote(port, m.entity, updated);
        return "ok";
      }
      await this.absorbRemote(port, m.entity, remote);
      await this.logConflict(
        port,
        m,
        "update-lost",
        `Kept the newer cloud version (updated ${remote.updated_at}); the offline edit was superseded.`
      );
      return "superseded";
    }
    const updated = await R.updateById(m.record_id, this.sendable(m.payload, false));
    await this.absorbRemote(port, m.entity, updated);
    return "ok";
  }

  private async execUpsert(
    port: DbPort,
    R: RemoteTable,
    m: Mutation
  ): Promise<Outcome> {
    const cols = m.natural_key_cols ?? [];
    const payload = this.sendable(m.payload, true);
    const local = (await port.get(m.entity, m.record_id)) as LocalRow | null;
    if (!local || local._deleted) return "ok";
    const keyVals: Record<string, unknown> = {};
    for (const c of cols) keyVals[c] = (payload as any)[c];
    let remote = cols.length
      ? await R.getByNatural(keyVals)
      : await R.getById(m.record_id);
    if (!remote) {
      try {
        const created = await R.insert(payload);
        await this.absorbRemote(port, m.entity, created);
        return "ok";
      } catch (e) {
        if (classifyRemoteError(e) !== "unique") throw e;
        remote =
          (cols.length ? await R.getByNatural(keyVals) : await R.getById(m.record_id)) ??
          null;
        if (!remote) throw e;
      }
    }
    if (String((remote as any).id) !== m.record_id) {
      // Another device won the natural-key race: adopt the cloud row.
      await this.absorbRemote(port, m.entity, remote as Record<string, any>, m.record_id);
      await dropQueuedMutations(port, m.record_id);
      await this.logConflict(
        port,
        m,
        "natural-key-adopted",
        "Another device created this record first; kept the cloud version."
      );
      return "superseded";
    }
    if (
      (remote as any).updated_at &&
      (local as any).updated_at &&
      (remote as any).updated_at > (local as any).updated_at
    ) {
      if (local._local_updated_at > (remote as any).updated_at) {
        const res = cols.length
          ? await R.upsertNatural(payload, cols)
          : await R.upsertById(payload);
        await this.absorbRemote(port, m.entity, res);
        return "ok";
      }
      await this.absorbRemote(port, m.entity, remote as Record<string, any>);
      await this.logConflict(
        port,
        m,
        "upsert-lost",
        `Kept the newer cloud version (updated ${(remote as any).updated_at}); the offline edit was superseded.`
      );
      return "superseded";
    }
    const res = cols.length
      ? await R.upsertNatural(payload, cols)
      : await R.upsertById(payload);
    await this.absorbRemote(port, m.entity, res);
    return "ok";
  }

  private async execIncrement(
    port: DbPort,
    R: RemoteTable,
    m: Mutation
  ): Promise<Outcome> {
    const field = m.field!;
    const delta = m.delta!;
    const base = m.base ?? 0;
    const cols = m.natural_key_cols ?? [];
    const local = (await port.get(m.entity, m.record_id)) as LocalRow | null;
    if (!local || local._deleted) return "ok";
    const keyVals: Record<string, unknown> = {};
    for (const c of cols) keyVals[c] = (local as any)[c];
    const remote = cols.length
      ? await R.getByNatural(keyVals)
      : await R.getById(m.record_id);
    if (remote && String((remote as any).id) !== m.record_id) {
      // Natural-key race: adopt the cloud row, apply our delta on top of it.
      await this.absorbRemote(port, m.entity, remote as Record<string, any>, m.record_id);
      await this.logConflict(
        port,
        m,
        "natural-key-adopted",
        "Another device created this record first; kept the cloud version and applied the change on top."
      );
      const newVal = Number((remote as any)[field] ?? 0) + delta;
      const res = await R.upsertById(
        this.sendable({ ...stripLocalMeta(remote as Record<string, any>), [field]: newVal }, false)
      );
      await this.absorbRemote(port, m.entity, res);
      return "ok";
    }
    const rVal = remote ? Number((remote as any)[field] ?? 0) : null;
    if (rVal !== null && rVal === base + delta) {
      // A previous attempt already applied this delta (response was lost).
      await this.absorbRemote(port, m.entity, remote as Record<string, any>);
      return "ok";
    }
    const newVal = (rVal ?? base) + delta;
    const payload = this.sendable({ ...stripLocalMeta(local), [field]: newVal }, !remote);
    const res = remote
      ? cols.length
        ? await R.upsertNatural(payload, cols)
        : await R.upsertById(payload)
      : await R.insert(payload);
    await this.absorbRemote(port, m.entity, res);
    return "ok";
  }

  private async execDelete(
    port: DbPort,
    R: RemoteTable,
    m: Mutation
  ): Promise<Outcome> {
    const local = (await port.get(m.entity, m.record_id)) as LocalRow | null;
    const remote = await R.getById(m.record_id);
    if (!remote) {
      if (local) await port.remove(m.entity, m.record_id);
      return "ok";
    }
    if (local && !local._deleted) return "ok"; // resurrected locally meanwhile
    if (
      (local as any)?.updated_at &&
      remote.updated_at &&
      remote.updated_at > (local as any).updated_at
    ) {
      // Updated on another device after our delete: update wins, resurrect.
      await this.absorbRemote(port, m.entity, remote);
      await this.logConflict(
        port,
        m,
        "delete-lost",
        "This record was updated on another device after you deleted it, so it was kept."
      );
      return "superseded";
    }
    await R.deleteById(m.record_id); // 23001 (V2.2 guard) → handleOpError
    await port.remove(m.entity, m.record_id); // GC the tombstone
    return "ok";
  }

  private async handleOpError(
    port: DbPort,
    R: RemoteTable,
    m: Mutation,
    e: unknown
  ): Promise<Outcome> {
    const kind = classifyRemoteError(e);
    const message =
      e && typeof e === "object" && "message" in e
        ? String((e as { message: unknown }).message)
        : String(e);
    if (kind === "auth") {
      this.stopRequested = true;
      this.patchSnap({ authIssue: true });
      return "auth-stop";
    }
    if (kind === "unique") {
      if (m.tolerance === "drop-on-conflict") {
        // Seed race: defaults already exist in the cloud. Converge via pull.
        await this.logConflict(port, m, "seed-dropped", "Defaults already existed in the cloud; kept the cloud version.");
        return "superseded";
      }
      if (m.op === "insert") {
        const existing = await R.getById(m.record_id).catch(() => null);
        if (existing) {
          await this.absorbRemote(port, m.entity, existing);
          return "ok";
        }
      }
      m.last_error = `Sync conflict: ${message}`;
      m.next_retry_at = null; // needs a human look; no auto-retry
      return "failed";
    }
    if (kind === "restrict") {
      // V2.2 deletion guard (or reading_logs RESTRICT): restore local state.
      const remote = await R.getById(m.record_id).catch(() => null);
      if (remote) {
        await this.absorbRemote(port, m.entity, remote);
      } else if (m.op === "delete") {
        const local = await port.get(m.entity, m.record_id);
        if (local) {
          await port.put(m.entity, { ...local, _deleted: 0, _dirty: 0, _sync_error: null });
        }
      }
      m.last_error = `Couldn't sync: ${message}`;
      m.next_retry_at = null;
      return "failed";
    }
    if (kind === "permanent") {
      m.last_error = message;
      m.next_retry_at = null;
      return "failed";
    }
    // Transient: bounded fast retries, then visible failure with slow backoff.
    if (m.retry_count >= MAX_RETRIES) {
      m.last_error = `Still failing after ${MAX_RETRIES} tries: ${message}`;
      const slowMs = Math.min(
        15 * 60 * 1000 * Math.pow(2, m.retry_count - MAX_RETRIES),
        4 * 60 * 60 * 1000
      );
      m.next_retry_at = new Date(Date.now() + slowMs).toISOString();
      return "failed";
    }
    m.last_error = message;
    return "retry";
  }

  private async markRecordClean(m: Mutation): Promise<void> {
    const port = this.port!;
    const remaining = await port.list("_mutations", {
      eq: { record_id: m.record_id },
    });
    if (remaining.length === 0) {
      const local = await port.get(m.entity, m.record_id);
      if (local && (local as any)._dirty) {
        await port.put(m.entity, { ...local, _dirty: 0, _sync_error: null });
      }
    }
  }

  // ------------------------------------------------------------------- pull

  private async pull(): Promise<void> {
    for (const table of TABLES) {
      if (this.stopRequested) break;
      await this.pullTable(table);
    }
  }

  private async pullTable(table: TableName): Promise<void> {
    const port = this.port!;
    const lastPull = await this.metaGet(`last_pull:${table}`);
    const R = this.remote().table(table);
    let deltas: Record<string, any>[];
    let idRows: Array<{ id: string; updated_at: string }>;
    try {
      deltas = await R.selectDelta(lastPull);
      idRows = await R.listIds();
    } catch (e) {
      if (classifyRemoteError(e) === "auth") {
        this.stopRequested = true;
        this.patchSnap({ authIssue: true });
        return;
      }
      throw e;
    }
    const remoteIds = new Set(idRows.map((r) => r.id));
    // Skew-safe watermark: max updated_at actually seen.
    let watermark = lastPull ?? "";
    for (const r of deltas) {
      if (r.updated_at && r.updated_at > watermark) watermark = r.updated_at;
    }
    for (const r of idRows) {
      if (r.updated_at && r.updated_at > watermark) watermark = r.updated_at;
    }
    for (const row of deltas) {
      const local = (await port.get(table, String(row.id))) as LocalRow | null;
      if (!local) {
        await port.put(table, cleanRow(row));
      } else if (local._deleted || local._dirty) {
        // Owned by push (pending local work or tombstone): never clobber.
      } else if (
        !(local as any).updated_at ||
        (row.updated_at && row.updated_at > (local as any).updated_at)
      ) {
        await port.put(table, {
          ...cleanRow(row),
          _local_created_at: local._local_created_at,
        });
      }
    }
    // Reconcile remote deletes: drop clean local rows absent from the cloud.
    const locals = await port.list(table, { includeDeleted: true });
    for (const local of locals as LocalRow[]) {
      if (local._deleted) {
        if (!remoteIds.has(local.id)) {
          await port.remove(table, local.id);
          await dropQueuedMutations(port, local.id, ["delete"]);
        }
        continue;
      }
      if (!local._dirty && !remoteIds.has(local.id)) {
        await port.remove(table, local.id);
      }
    }
    if (watermark) await this.metaPut(`last_pull:${table}`, watermark);
  }

  // ------------------------------------------------------------------ meta

  private async metaGet(key: string): Promise<string | null> {
    const row = await this.port!.get("_meta", key);
    return row ? String((row as any).value) : null;
  }

  private async metaPut(key: string, value: string): Promise<void> {
    await this.port!.put("_meta", { key, value });
  }

  private async refreshCounts(): Promise<void> {
    const port = this.port;
    const uid = this.userId;
    if (!port || !uid) {
      this.patchSnap({ pending: 0, failed: 0, pendingIds: new Set() });
      return;
    }
    const muts = await port.list("_mutations", { eq: { owner_id: uid } });
    let pending = 0;
    let failed = 0;
    const ids = new Set<string>();
    for (const m of muts as Mutation[]) {
      ids.add(m.record_id);
      if (m.status === "failed") failed += 1;
      else pending += 1;
    }
    const conflictCount = await port.count("_conflicts", {});
    this.patchSnap({ pending, failed, conflictCount, pendingIds: ids });
  }

  // -------------------------------------------------------------- test seam

  /** Test-only: bypass auth + IndexedDB with injected doubles. */
  testInject(port: DbPort, remote: Remote, userId: string): void {
    this.closePort();
    this.port = port;
    this.remoteOverride = remote;
    this.userId = userId;
    setSyncContext({
      getPort: () => {
        if (!this.port) throw new Error("Not signed in.");
        return this.port;
      },
      getUserId: () => this.userId,
      kick: () => {},
    });
    this.patchSnap({ started: true, userId });
    this.flushReady();
    this.notify();
  }

  /** Test-only: run one push+pull cycle without browser APIs. */
  async testSync(): Promise<void> {
    this.stopRequested = false;
    await this.push();
    if (!this.stopRequested) {
      try {
        await this.pull();
      } catch {
        /* transient mid-pull failure: next cycle resumes per-table */
      }
    }
    await this.refreshCounts();
    this.patchSnap({ lastSyncAt: nowIso() });
  }

  /** Test-only: full reset. */
  testReset(): void {
    this.closePort();
    this.port = null;
    this.userId = null;
    this.remoteOverride = null;
    this.supabaseRemote = null;
    this.snap = freshSnapshot();
    this.listeners.clear();
    this.readyWaiters = [];
    this.stopRequested = false;
    this.syncing = false;
  }
}

export const engine = new SyncEngine();
