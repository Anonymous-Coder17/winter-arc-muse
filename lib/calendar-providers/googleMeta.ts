/**
 * V4.3.1 Google connection METADATA cache (client-side, IndexedDB via idb).
 *
 * What this is: an offline-safe copy of the *display* state — connection
 * status, account email, calendar list, selection flags — so the settings UI
 * can render something honest when the device is offline.
 *
 * What this is NOT:
 * - Not a sync source. It never drives event data and never claims a sync
 *   happened. The provider throws ProviderOfflineError on offline checks;
 *   readers of this cache must show it as "last known state".
 * - Never a credential store. `writeMetaCache` enforces a strict whitelist
 *   (status/email/calendars/lastCheckedAt) AND rejects any key matching
 *   /token|secret|refresh|access/i at any depth. A row containing a
 *   credential-like key is refused, never written.
 *
 * Per-user isolation: key = `gcal:meta:<userId>`. The provider can only write
 * when it knows the user id; without one, cache writes are skipped.
 *
 * Client-safe: imports only `./types` and the `idb` dependency. Never
 * `lib/google/tokenVault` or any server-only module.
 */
import { openDB, type IDBPDatabase } from "idb";
import {
  ProviderError,
  type GoogleCalendarInfo,
  type GoogleConnectionState,
  type GoogleConnectionStatus,
  type GoogleSyncResult,
} from "./types";

const DB_NAME = "winter-arc-gcal-v1";
const STORE = "meta";

/**
 * V4.3.2 event-sync metadata, stored alongside the connection state in the
 * same per-user row. Display cache only — never a sync source, never a
 * credential store (the same credential-key rejection applies here).
 */
export interface GoogleSyncMeta {
  /** ISO timestamp of the last successful sync; null when never synced. */
  lastGoogleSyncAt: string | null;
  /**
   * The last sync result (sanitized: counts + conflict summaries only).
   * The UI reads conflicts/writeBlocked from this.
   */
  lastGoogleSyncResult: GoogleSyncResult | null;
  /**
   * Local event ids with a Google sync mapping, tracked from this device's
   * own createEventMapping calls. Bounded (see MAX_SYNCED_IDS).
   */
  googleSyncedEventIds: string[];
}

export function emptySyncMeta(): GoogleSyncMeta {
  return {
    lastGoogleSyncAt: null,
    lastGoogleSyncResult: null,
    googleSyncedEventIds: [],
  };
}

/** Cap the tracked id set so the cache cannot grow without bound. */
const MAX_SYNCED_IDS = 5000;

interface MetaRow {
  key: string;
  state: GoogleConnectionState;
  /** Absent on rows written before V4.3.2; readers must tolerate that. */
  sync?: GoogleSyncMeta;
  updatedAt: string;
}

/** Per-user isolation key. */
export function gcalMetaKey(userId: string): string {
  return `gcal:meta:${userId}`;
}

/** False outside a browser (SSR, tests without IndexedDB). */
export function metaCacheAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

/** Open the metadata DB (version 1), creating the `meta` store if needed. */
export function openGcalMeta(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "key" });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Safety validation: whitelist + credential-key rejection.
// ---------------------------------------------------------------------------

const TOP_KEYS = ["status", "email", "calendars", "lastCheckedAt"] as const;
const CAL_KEYS = ["id", "summary", "primary", "timeZone", "selected"] as const;
const STATUSES: readonly GoogleConnectionStatus[] = [
  "disconnected",
  "connected",
  "revoked",
  "error",
  "unknown",
];

/** Any key looking like this must never be cached, at any depth. */
const CREDENTIAL_KEY = /token|secret|refresh|access/i;

function rejectCredentialKeys(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => rejectCredentialKeys(v, `${path}[${i}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (CREDENTIAL_KEY.test(k)) {
        throw new ProviderError(
          "cache_rejected_credential_key",
          `Refusing to cache a credential-like key "${k}" at ${path}`
        );
      }
      rejectCredentialKeys(v, `${path}.${k}`);
    }
  }
}

/**
 * Validate that `state` is exactly the whitelisted shape — nothing more —
 * and contains no credential-like keys. Throws ProviderError otherwise.
 */
function validateState(state: unknown): asserts state is GoogleConnectionState {
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    throw new ProviderError("cache_invalid_shape", "Connection state must be an object");
  }
  const s = state as Record<string, unknown>;
  // Credential scan runs FIRST: a credential-like key is always reported as
  // such, even if it would also fail the whitelist below.
  rejectCredentialKeys(s, "$");
  for (const k of Object.keys(s)) {
    if (!(TOP_KEYS as readonly string[]).includes(k)) {
      throw new ProviderError(
        "cache_invalid_shape",
        `Unexpected top-level key "${k}" in connection state cache`
      );
    }
  }
  if (!STATUSES.includes(s.status as GoogleConnectionStatus)) {
    throw new ProviderError("cache_invalid_shape", `Invalid status "${String(s.status)}"`);
  }
  if (s.email !== null && typeof s.email !== "string") {
    throw new ProviderError("cache_invalid_shape", "email must be a string or null");
  }
  if (s.lastCheckedAt !== null && typeof s.lastCheckedAt !== "string") {
    throw new ProviderError("cache_invalid_shape", "lastCheckedAt must be a string or null");
  }
  if (!Array.isArray(s.calendars)) {
    throw new ProviderError("cache_invalid_shape", "calendars must be an array");
  }
  for (const c of s.calendars) {
    if (c === null || typeof c !== "object" || Array.isArray(c)) {
      throw new ProviderError("cache_invalid_shape", "Each calendar must be an object");
    }
    for (const k of Object.keys(c)) {
      if (!(CAL_KEYS as readonly string[]).includes(k)) {
        throw new ProviderError(
          "cache_invalid_shape",
          `Unexpected calendar key "${k}" in connection state cache`
        );
      }
    }
    const cal = c as Record<string, unknown>;
    if (
      typeof cal.id !== "string" ||
      typeof cal.summary !== "string" ||
      typeof cal.primary !== "boolean" ||
      (cal.timeZone !== null && typeof cal.timeZone !== "string") ||
      typeof cal.selected !== "boolean"
    ) {
      throw new ProviderError("cache_invalid_shape", "Calendar has invalid field types");
    }
  }
}

/** Rebuild the state from whitelisted fields only, so nothing extra leaks in. */
function sanitize(state: GoogleConnectionState): GoogleConnectionState {
  const calendars: GoogleCalendarInfo[] = state.calendars.map((c) => ({
    id: c.id,
    summary: c.summary,
    primary: c.primary,
    timeZone: c.timeZone,
    selected: c.selected,
  }));
  return {
    status: state.status,
    email: state.email,
    calendars,
    lastCheckedAt: state.lastCheckedAt,
  };
}

// ---------------------------------------------------------------------------
// V4.3.2 sync-metadata validation.
// ---------------------------------------------------------------------------

const SYNC_KEYS = [
  "lastGoogleSyncAt",
  "lastGoogleSyncResult",
  "googleSyncedEventIds",
] as const;
const RESULT_KEYS = [
  "syncedAt",
  "imported",
  "updated",
  "deleted",
  "pushed",
  "conflicts",
  "writeBlocked",
  "calendars",
] as const;
const CONFLICT_KEYS = ["localEventId", "title", "reason"] as const;
const CALRES_KEYS = ["calendarId", "ok", "error"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function invalid(msg: string): ProviderError {
  return new ProviderError("cache_invalid_shape", msg);
}

function checkCount(v: unknown, name: string): void {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw invalid(`${name} must be a non-negative number`);
  }
}

/**
 * Validate that `sync` is exactly the whitelisted sync shape — nothing more
 * — and contains no credential-like keys. Throws ProviderError otherwise.
 */
function validateSyncMeta(sync: unknown): asserts sync is GoogleSyncMeta {
  if (!isRecord(sync)) throw invalid("Sync metadata must be an object");
  // Credential scan first, same policy as the connection state.
  rejectCredentialKeys(sync, "$.sync");
  for (const k of Object.keys(sync)) {
    if (!(SYNC_KEYS as readonly string[]).includes(k)) {
      throw invalid(`Unexpected sync key "${k}" in metadata cache`);
    }
  }
  if (sync.lastGoogleSyncAt !== null && typeof sync.lastGoogleSyncAt !== "string") {
    throw invalid("lastGoogleSyncAt must be a string or null");
  }
  if (sync.lastGoogleSyncResult !== null) {
    validateSyncResult(sync.lastGoogleSyncResult);
  }
  if (!Array.isArray(sync.googleSyncedEventIds)) {
    throw invalid("googleSyncedEventIds must be an array");
  }
  if (sync.googleSyncedEventIds.length > MAX_SYNCED_IDS) {
    throw invalid("googleSyncedEventIds exceeds the cache cap");
  }
  for (const id of sync.googleSyncedEventIds) {
    if (typeof id !== "string" || id.length === 0) {
      throw invalid("googleSyncedEventIds must contain non-empty strings");
    }
  }
}

/** Validate a cached sync result's shape (whitelisted keys, sane values). */
function validateSyncResult(result: unknown): asserts result is GoogleSyncResult {
  if (!isRecord(result)) throw invalid("lastGoogleSyncResult must be an object");
  rejectCredentialKeys(result, "$.sync.lastGoogleSyncResult");
  for (const k of Object.keys(result)) {
    if (!(RESULT_KEYS as readonly string[]).includes(k)) {
      throw invalid(`Unexpected sync-result key "${k}" in metadata cache`);
    }
  }
  if (typeof result.syncedAt !== "string") {
    throw invalid("syncedAt must be a string");
  }
  checkCount(result.imported, "imported");
  checkCount(result.updated, "updated");
  checkCount(result.deleted, "deleted");
  checkCount(result.pushed, "pushed");
  if (typeof result.writeBlocked !== "boolean") {
    throw invalid("writeBlocked must be a boolean");
  }
  if (!Array.isArray(result.conflicts)) {
    throw invalid("conflicts must be an array");
  }
  for (const c of result.conflicts) {
    if (!isRecord(c)) throw invalid("Each conflict must be an object");
    for (const k of Object.keys(c)) {
      if (!(CONFLICT_KEYS as readonly string[]).includes(k)) {
        throw invalid(`Unexpected conflict key "${k}" in metadata cache`);
      }
    }
    if (
      (c.localEventId !== null && typeof c.localEventId !== "string") ||
      typeof c.title !== "string" ||
      typeof c.reason !== "string"
    ) {
      throw invalid("Conflict has invalid field types");
    }
  }
  if (!Array.isArray(result.calendars)) {
    throw invalid("calendars must be an array");
  }
  for (const c of result.calendars) {
    if (!isRecord(c)) throw invalid("Each calendar result must be an object");
    for (const k of Object.keys(c)) {
      if (!(CALRES_KEYS as readonly string[]).includes(k)) {
        throw invalid(`Unexpected calendar-result key "${k}" in metadata cache`);
      }
    }
    if (
      typeof c.calendarId !== "string" ||
      typeof c.ok !== "boolean" ||
      (c.error !== undefined && typeof c.error !== "string")
    ) {
      throw invalid("Calendar result has invalid field types");
    }
  }
}

/** Rebuild the sync metadata from whitelisted fields only. */
function sanitizeSyncMeta(sync: GoogleSyncMeta): GoogleSyncMeta {
  const r = sync.lastGoogleSyncResult;
  return {
    lastGoogleSyncAt: sync.lastGoogleSyncAt,
    lastGoogleSyncResult: r
      ? {
          syncedAt: r.syncedAt,
          imported: r.imported,
          updated: r.updated,
          deleted: r.deleted,
          pushed: r.pushed,
          conflicts: r.conflicts.map((c) => ({
            localEventId: c.localEventId,
            title: c.title,
            reason: c.reason,
          })),
          writeBlocked: r.writeBlocked,
          calendars: r.calendars.map((c) => ({
            calendarId: c.calendarId,
            ok: c.ok,
            ...(c.error !== undefined ? { error: c.error } : {}),
          })),
        }
      : null,
    googleSyncedEventIds: [...new Set(sync.googleSyncedEventIds)].slice(
      0,
      MAX_SYNCED_IDS
    ),
  };
}

/** The connection state written when a sync row exists before any status check. */
function defaultConnectionState(): GoogleConnectionState {
  return {
    status: "disconnected",
    email: null,
    calendars: [],
    lastCheckedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Public cache API.
// ---------------------------------------------------------------------------

/**
 * Write the connection metadata for one user. Validates the whitelist and
 * rejects credential-like keys (throws, never writes them). Display cache
 * only — never a sync source.
 *
 * V4.3.2: the per-user sync block (`lastGoogleSyncAt`, `lastGoogleSyncResult`,
 * `googleSyncedEventIds`) is preserved across connection-state writes — a
 * status check must never wipe the sync history.
 */
export async function writeMetaCache(
  userId: string,
  state: GoogleConnectionState
): Promise<void> {
  if (!metaCacheAvailable()) {
    throw new ProviderError("cache_unavailable", "IndexedDB is not available");
  }
  if (!userId) {
    throw new ProviderError("cache_invalid_user", "userId is required for the metadata cache");
  }
  validateState(state);
  const db = await openGcalMeta();
  try {
    let sync: GoogleSyncMeta | undefined;
    try {
      const existing = (await db.get(STORE, gcalMetaKey(userId))) as
        | MetaRow
        | undefined;
      if (existing?.sync) {
        validateSyncMeta(existing.sync);
        sync = existing.sync;
      }
    } catch {
      // Corrupt sync block: drop it rather than propagating a lie.
      sync = undefined;
    }
    const row: MetaRow = {
      key: gcalMetaKey(userId),
      state: sanitize(state),
      ...(sync ? { sync } : {}),
      updatedAt: new Date().toISOString(),
    };
    await db.put(STORE, row);
  } finally {
    db.close();
  }
}

/**
 * Read the last-known connection metadata for one user, or null when there
 * is none (or the row is corrupt — a corrupt row is dropped). Offline
 * display only; a returned row is "last known", never "just synced".
 */
export async function readMetaCache(
  userId: string
): Promise<GoogleConnectionState | null> {
  if (!metaCacheAvailable() || !userId) return null;
  const db = await openGcalMeta();
  let row: MetaRow | undefined;
  try {
    row = await db.get(STORE, gcalMetaKey(userId));
  } finally {
    db.close();
  }
  if (!row) return null;
  try {
    validateState(row.state);
  } catch {
    // Corrupt cache: drop it rather than serving a lie.
    await clearMetaCache(userId);
    return null;
  }
  return row.state;
}

/** Drop one user's metadata cache. */
export async function clearMetaCache(userId: string): Promise<void> {
  if (!metaCacheAvailable() || !userId) return;
  const db = await openGcalMeta();
  try {
    await db.delete(STORE, gcalMetaKey(userId));
  } finally {
    db.close();
  }
}

/**
 * V4.3.2: read the event-sync metadata for one user (last sync time, last
 * result, tracked synced event ids). Returns null when there is none, when
 * the sync block is corrupt, or when the cache is unavailable. Cache-only:
 * never touches the network.
 */
export async function readSyncMeta(
  userId: string
): Promise<GoogleSyncMeta | null> {
  if (!metaCacheAvailable() || !userId) return null;
  const db = await openGcalMeta();
  let row: MetaRow | undefined;
  try {
    row = (await db.get(STORE, gcalMetaKey(userId))) as MetaRow | undefined;
  } finally {
    db.close();
  }
  if (!row?.sync) return null;
  try {
    validateSyncMeta(row.sync);
  } catch {
    // Corrupt sync block: treat as absent; the next write repairs it.
    return null;
  }
  return row.sync;
}

/**
 * V4.3.2: write the event-sync metadata for one user. Validates the
 * whitelist and rejects credential-like keys (throws, never writes them).
 * The connection-state block is preserved; when no row exists yet, a
 * default disconnected state is stored alongside the sync block.
 */
export async function writeSyncMeta(
  userId: string,
  sync: GoogleSyncMeta
): Promise<void> {
  if (!metaCacheAvailable()) {
    throw new ProviderError("cache_unavailable", "IndexedDB is not available");
  }
  if (!userId) {
    throw new ProviderError("cache_invalid_user", "userId is required for the metadata cache");
  }
  validateSyncMeta(sync);
  const db = await openGcalMeta();
  try {
    const key = gcalMetaKey(userId);
    let state = defaultConnectionState();
    try {
      const existing = (await db.get(STORE, key)) as MetaRow | undefined;
      if (existing) {
        validateState(existing.state);
        state = existing.state;
      }
    } catch {
      // Corrupt connection state: fall back to the default rather than
      // refusing to record a real sync.
    }
    const row: MetaRow = {
      key,
      state: sanitize(state),
      sync: sanitizeSyncMeta(sync),
      updatedAt: new Date().toISOString(),
    };
    await db.put(STORE, row);
  } finally {
    db.close();
  }
}

/** Drop every user's metadata cache. Call on logout. */
export async function clearAllMetaCache(): Promise<void> {
  if (!metaCacheAvailable()) return;
  const db = await openGcalMeta();
  try {
    await db.clear(STORE);
  } finally {
    db.close();
  }
}

/**
 * No-arg convenience for logout flows: clears the whole metadata cache
 * (all users). Same as `clearAllMetaCache()`.
 */
export async function clearCache(): Promise<void> {
  await clearAllMetaCache();
}
