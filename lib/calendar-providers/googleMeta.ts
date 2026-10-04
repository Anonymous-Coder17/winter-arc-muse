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
} from "./types";

const DB_NAME = "winter-arc-gcal-v1";
const STORE = "meta";

interface MetaRow {
  key: string;
  state: GoogleConnectionState;
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
// Public cache API.
// ---------------------------------------------------------------------------

/**
 * Write the connection metadata for one user. Validates the whitelist and
 * rejects credential-like keys (throws, never writes them). Display cache
 * only — never a sync source.
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
  const row: MetaRow = {
    key: gcalMetaKey(userId),
    state: sanitize(state),
    updatedAt: new Date().toISOString(),
  };
  await db.put(STORE, row);
  db.close();
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
