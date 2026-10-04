/**
 * V4.3.1 Google Calendar provider (client-side adapter).
 *
 * Talks only to the server API routes (`/api/google/...`), which hold the
 * OAuth tokens in the server-side token vault. This adapter never sees a
 * token, never stores one, and has no import path that could reach one —
 * client-safe by construction (see types.ts).
 *
 * Error mapping (mirrors lib/sync/remote.ts's classifyRemoteError tone):
 * - offline (`navigator.onLine === false`, or fetch throws TypeError) ->
 *   ProviderOfflineError. We never claim a sync happened.
 * - fetch followed a redirect to /login, or a 401 without a revocation
 *   flag -> ProviderNotSignedInError (the app session is gone).
 * - 401 with `{ revoked: true }` -> ProviderRevokedError.
 * - 409 from /api/google/sync -> ProviderError with code "not_connected".
 * - other non-2xx -> ProviderError with an `http_<status>` code.
 *
 * After every successful read or mutation the metadata cache (googleMeta.ts)
 * is updated so the UI can render the last-known state while offline.
 *
 * V4.3.2: `syncEvents` runs the server-side event sync and records the
 * result in the cache; `getSyncStatus` reads it back without touching the
 * network; `createEventMapping` links a local event to a Google calendar.
 * The synced event-id set is tracked locally from this device's own mapping
 * calls — the sync contract carries no event ids, and no new server route
 * may be added, so ids learned from other devices are not visible here.
 */
import type {
  CalendarProvider,
  GoogleCalendarInfo,
  GoogleConnectionState,
  GoogleSyncResult,
  GoogleSyncStatus,
} from "./types";
import {
  ProviderError,
  ProviderNotSignedInError,
  ProviderOfflineError,
  ProviderRevokedError,
} from "./types";
import {
  clearMetaCache,
  emptySyncMeta,
  metaCacheAvailable,
  readMetaCache,
  readSyncMeta,
  writeMetaCache,
  writeSyncMeta,
  type GoogleSyncMeta,
} from "./googleMeta";

const OAUTH_START = "/api/google/oauth/start";
const DISCONNECT = "/api/google/oauth/disconnect";
const CALENDARS = "/api/google/calendars";
const SELECTIONS = "/api/google/selections";
const SYNC = "/api/google/sync";
const MAPPINGS = "/api/google/mappings";

type FetchFn = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

/** Default fetch that stays bound to globalThis (safe as a bare reference). */
const defaultFetch: FetchFn = (input, init) => globalThis.fetch(input, init);

function nowIso(): string {
  return new Date().toISOString();
}

function disconnectedState(): GoogleConnectionState {
  return { status: "disconnected", email: null, calendars: [], lastCheckedAt: nowIso() };
}

export class GoogleCalendarProvider implements CalendarProvider {
  private fetchFn: FetchFn;
  /**
   * Resolves the current app user id for cache isolation. The app wires this
   * (e.g. from the Supabase session). Without an id, cache writes are
   * skipped — we never write one user's metadata under another's key.
   */
  private getUserId: () => string | null;

  constructor(fetchFn?: FetchFn, getUserId?: () => string | null) {
    this.fetchFn = fetchFn ?? defaultFetch;
    this.getUserId = getUserId ?? (() => null);
  }

  // ------------------------------------------------------------------
  // CalendarProvider
  // ------------------------------------------------------------------

  async getStatus(): Promise<GoogleConnectionState> {
    try {
      return await this.fetchStatus();
    } catch (err) {
      await this.noteCheckOutcome(err);
      throw err;
    }
  }

  /**
   * Start the OAuth flow. This navigates the browser (302 chain), so it is
   * a `void` navigation — not a fetch.
   */
  connect(): void {
    if (typeof window === "undefined" || !window.location) {
      throw new ProviderError("no_window", "connect() requires a browser window");
    }
    window.location.assign(OAUTH_START);
  }

  async disconnect(): Promise<void> {
    await this.requestJson(DISCONNECT, { method: "POST" });
    await this.saveCache(disconnectedState());
  }

  async refreshCalendars(): Promise<GoogleCalendarInfo[]> {
    const { json } = await this.requestJson(CALENDARS);
    if (!json || json.connected !== true) {
      throw new ProviderNotSignedInError("Google is not connected");
    }
    const calendars = await this.withSelections(json.calendars);
    await this.saveCache({
      status: "connected",
      email: typeof json.email === "string" ? json.email : null,
      calendars,
      lastCheckedAt: nowIso(),
    });
    return calendars;
  }

  async setCalendarSelected(calendarId: string, selected: boolean): Promise<void> {
    const { json } = await this.requestJson(SELECTIONS, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selections: [{ google_calendar_id: calendarId, selected }] }),
    });
    const returned = Array.isArray(json?.selections) ? json.selections : [];
    // Merge the server's authoritative selection flags into the cache.
    const flags = new Map<string, boolean>(
      returned.map((s: any) => [String(s.google_calendar_id), !!s.selected])
    );
    const uid = this.userId();
    if (!uid) return;
    const prev = await this.safeRead(uid);
    if (!prev) return;
    const calendars = prev.calendars.map((c) =>
      flags.has(c.id) ? { ...c, selected: flags.get(c.id) as boolean } : c
    );
    await this.saveCache({ ...prev, calendars, lastCheckedAt: nowIso() });
  }

  async clearCache(): Promise<void> {
    const uid = this.userId();
    if (uid) await clearMetaCache(uid);
  }

  /**
   * Run a two-way Google event sync (POST /api/google/sync) and record the
   * result in the metadata cache. The caller's own engine sync should run
   * before (to push local edits) and after (to pull imported events); see
   * `triggerGoogleSync` in googleSyncClient.ts.
   */
  async syncEvents(timeZone: string): Promise<GoogleSyncResult> {
    let json: any;
    try {
      ({ json } = await this.requestJson(SYNC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ timeZone }),
      }));
    } catch (err) {
      if (err instanceof ProviderError && err.code === "http_409") {
        throw new ProviderError(
          "not_connected",
          "Google Calendar is not connected"
        );
      }
      throw err;
    }
    const result = sanitizeSyncResult(json);
    await this.recordSyncResult(result);
    return result;
  }

  /**
   * Last-known sync state from the metadata cache. Cache-only: never throws
   * offline; nulls/empties when nothing has been recorded yet.
   */
  async getSyncStatus(): Promise<GoogleSyncStatus> {
    const uid = this.userId();
    if (!uid || !metaCacheAvailable()) {
      return { lastSyncedAt: null, lastResult: null, syncedEventIds: [] };
    }
    const sync = await this.safeReadSync(uid);
    return {
      lastSyncedAt: sync?.lastGoogleSyncAt ?? null,
      lastResult: sync?.lastGoogleSyncResult ?? null,
      syncedEventIds: sync?.googleSyncedEventIds ?? [],
    };
  }

  /**
   * Link a local event to one of the user's SELECTED Google calendars
   * (POST /api/google/mappings) so the next sync pushes it to Google. On
   * success the event id joins the cached synced-id set. The client's
   * display zone is sent so the server can record the mapping's
   * local_timezone (V4.3.2.2).
   */
  async createEventMapping(
    localEventId: string,
    googleCalendarId: string
  ): Promise<void> {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    await this.requestJson(MAPPINGS, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ localEventId, googleCalendarId, timeZone }),
    });
    const uid = this.userId();
    if (!uid || !metaCacheAvailable()) return;
    const sync = (await this.safeReadSync(uid)) ?? emptySyncMeta();
    const ids = new Set(sync.googleSyncedEventIds);
    ids.add(localEventId);
    try {
      await writeSyncMeta(uid, {
        lastGoogleSyncAt: sync.lastGoogleSyncAt,
        lastGoogleSyncResult: sync.lastGoogleSyncResult,
        googleSyncedEventIds: [...ids],
      });
    } catch {
      // Cache write failure must not fail a confirmed server-side mapping.
    }
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private userId(): string | null {
    try {
      return this.getUserId() || null;
    } catch {
      return null;
    }
  }

  private assertOnline(): void {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      throw new ProviderOfflineError();
    }
  }

  /**
   * One JSON request against the server API with the standard error mapping.
   * Never throws on offline without saying so (ProviderOfflineError).
   */
  private async requestJson(
    path: string,
    init?: RequestInit
  ): Promise<{ json: any }> {
    this.assertOnline();
    let res: Response;
    try {
      res = await this.fetchFn(path, init);
    } catch (err) {
      // Network-level failure: DNS, CORS, or the device dropped offline
      // mid-request (navigator.onLine can lag behind reality).
      if (err instanceof TypeError) {
        throw new ProviderOfflineError("Network request failed");
      }
      throw err;
    }
    // Middleware sign-in redirect: fetch follows it transparently, so we
    // detect it from the final URL instead of the status code.
    if (res.redirected && /\/login(\?|#|$)/.test(res.url)) {
      throw new ProviderNotSignedInError("Signed out — please sign in again");
    }
    if (res.status === 401) {
      let body: any = null;
      try {
        body = await res.clone().json();
      } catch {
        body = null; // non-JSON 401: treat as session loss, not revocation
      }
      if (body && body.revoked === true) {
        throw new ProviderRevokedError();
      }
      throw new ProviderNotSignedInError("Session expired — please sign in again");
    }
    if (!res.ok) {
      throw new ProviderError(
        `http_${res.status}`,
        `Google provider request failed: ${path} (${res.status})`
      );
    }
    const json = await res.json().catch(() => null);
    return { json };
  }

  private async fetchStatus(): Promise<GoogleConnectionState> {
    const { json } = await this.requestJson(CALENDARS);
    if (!json || json.connected === false) {
      const state = disconnectedState();
      await this.saveCache(state);
      return state;
    }
    const calendars = await this.withSelections(json.calendars);
    const state: GoogleConnectionState = {
      status: "connected",
      email: typeof json.email === "string" ? json.email : null,
      calendars,
      lastCheckedAt: nowIso(),
    };
    await this.saveCache(state);
    return state;
  }

  /**
   * Merge the Google calendar list with the server's selection rows.
   * A calendar with no selection row is treated as selected (opt-out model);
   * the server seeds rows for every known calendar on connect.
   */
  private async withSelections(raw: unknown): Promise<GoogleCalendarInfo[]> {
    const { json } = await this.requestJson(SELECTIONS);
    const sels = Array.isArray(json?.selections) ? json.selections : [];
    const byId = new Map<string, any>(
      sels.map((s: any) => [String(s.google_calendar_id), s])
    );
    return (Array.isArray(raw) ? raw : []).map((c: any) => {
      const sel = byId.get(String(c.id));
      return {
        id: String(c.id),
        summary: String(c.summary ?? ""),
        primary: !!c.primary,
        timeZone: typeof c.timeZone === "string" ? c.timeZone : null,
        selected: sel ? !!sel.selected : true,
      };
    });
  }

  /**
   * Record what a failed status check means for the cache. Offline and
   * sign-in loss leave the last-known state untouched (it is still the
   * honestest thing we have). Revocation is a real state change and is
   * written as "revoked". Any other failure marks the check "error" while
   * keeping the last-known calendars for offline display.
   */
  private async noteCheckOutcome(err: unknown): Promise<void> {
    if (
      err instanceof ProviderOfflineError ||
      err instanceof ProviderNotSignedInError
    ) {
      return;
    }
    const uid = this.userId();
    if (!uid) return;
    const prev = await this.safeRead(uid);
    if (err instanceof ProviderRevokedError) {
      await this.saveCache({
        status: "revoked",
        email: prev?.email ?? null,
        calendars: prev?.calendars ?? [],
        lastCheckedAt: nowIso(),
      });
      return;
    }
    await this.saveCache({
      status: "error",
      email: prev?.email ?? null,
      calendars: prev?.calendars ?? [],
      lastCheckedAt: nowIso(),
    });
  }

  /** Best-effort cache write: skipped without a user id or IndexedDB. */
  private async saveCache(state: GoogleConnectionState): Promise<void> {
    const uid = this.userId();
    if (!uid || !metaCacheAvailable()) return;
    await writeMetaCache(uid, state);
  }

  private async safeRead(uid: string): Promise<GoogleConnectionState | null> {
    try {
      return await readMetaCache(uid);
    } catch {
      return null;
    }
  }

  private async safeReadSync(uid: string): Promise<GoogleSyncMeta | null> {
    try {
      return await readSyncMeta(uid);
    } catch {
      return null;
    }
  }

  /**
   * Record a completed sync in the metadata cache: last sync time, the full
   * (sanitized) result, and the existing tracked event ids. Cache failures
   * never fail the sync itself — the sync happened; only the display cache
   * is best-effort.
   */
  private async recordSyncResult(result: GoogleSyncResult): Promise<void> {
    const uid = this.userId();
    if (!uid || !metaCacheAvailable()) return;
    const prev = (await this.safeReadSync(uid)) ?? emptySyncMeta();
    try {
      await writeSyncMeta(uid, {
        lastGoogleSyncAt: result.syncedAt,
        lastGoogleSyncResult: result,
        googleSyncedEventIds: prev.googleSyncedEventIds,
      });
    } catch {
      // Display cache only — the sync result stands on its own.
    }
  }
}

/**
 * Validate the /api/google/sync response shape before caching it. The
 * server contract is trusted but the network is not: an unexpected shape is
 * a hard error, never silently cached.
 */
function sanitizeSyncResult(json: unknown): GoogleSyncResult {
  const fail = (): never => {
    throw new ProviderError(
      "bad_sync_response",
      "The sync response had an unexpected shape."
    );
  };
  if (json === null || typeof json !== "object" || Array.isArray(json)) fail();
  const r = json as Record<string, unknown>;
  if (typeof r.syncedAt !== "string") fail();
  for (const k of ["imported", "updated", "deleted", "pushed"] as const) {
    if (typeof r[k] !== "number" || !Number.isFinite(r[k]) || (r[k] as number) < 0) fail();
  }
  if (typeof r.writeBlocked !== "boolean") fail();
  if (!Array.isArray(r.conflicts)) fail();
  const conflicts = (r.conflicts as unknown[]).map((c) => {
    if (c === null || typeof c !== "object" || Array.isArray(c)) fail();
    const cc = c as Record<string, unknown>;
    if (
      (cc.localEventId !== null && typeof cc.localEventId !== "string") ||
      typeof cc.title !== "string" ||
      typeof cc.reason !== "string"
    ) {
      fail();
    }
    return {
      localEventId: cc.localEventId as string | null,
      title: cc.title as string,
      reason: cc.reason as string,
    };
  });
  if (!Array.isArray(r.calendars)) fail();
  const calendars = (r.calendars as unknown[]).map((c) => {
    if (c === null || typeof c !== "object" || Array.isArray(c)) fail();
    const cc = c as Record<string, unknown>;
    if (typeof cc.calendarId !== "string" || typeof cc.ok !== "boolean") fail();
    return {
      calendarId: cc.calendarId as string,
      ok: cc.ok as boolean,
      ...(typeof cc.error === "string" ? { error: cc.error } : {}),
    };
  });
  return {
    syncedAt: r.syncedAt as string,
    imported: r.imported as number,
    updated: r.updated as number,
    deleted: r.deleted as number,
    pushed: r.pushed as number,
    conflicts,
    writeBlocked: r.writeBlocked as boolean,
    calendars,
  };
}
