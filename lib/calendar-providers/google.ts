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
 * - other non-2xx -> ProviderError with an `http_<status>` code.
 *
 * After every successful read or mutation the metadata cache (googleMeta.ts)
 * is updated so the UI can render the last-known state while offline.
 */
import type {
  CalendarProvider,
  GoogleCalendarInfo,
  GoogleConnectionState,
} from "./types";
import {
  ProviderError,
  ProviderNotSignedInError,
  ProviderOfflineError,
  ProviderRevokedError,
} from "./types";
import {
  clearMetaCache,
  metaCacheAvailable,
  readMetaCache,
  writeMetaCache,
} from "./googleMeta";

const OAUTH_START = "/api/google/oauth/start";
const DISCONNECT = "/api/google/oauth/disconnect";
const CALENDARS = "/api/google/calendars";
const SELECTIONS = "/api/google/selections";

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
}
