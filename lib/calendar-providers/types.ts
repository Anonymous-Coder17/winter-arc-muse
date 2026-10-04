/**
 * V4.3.1 calendar provider abstraction (client-safe).
 *
 * `CalendarProvider` is the port the app talks to; `GoogleCalendarProvider`
 * (google.ts) is the adapter. The client NEVER sees OAuth tokens: the server
 * API routes (`/api/google/...`) hold them in the token vault, and these
 * types carry only connection metadata — status, account email, calendar
 * list. Nothing here can leak a credential because nothing here can hold one.
 *
 * Client-safety rule: this module (and everything under
 * `lib/calendar-providers/`) must NEVER import `lib/google/tokenVault` or
 * any other server-only module. The import-graph test enforces this.
 */

/** Lifecycle of the user's Google connection, as the client sees it. */
export type GoogleConnectionStatus =
  | "disconnected" // never connected, or explicitly disconnected
  | "connected" // live connection; the calendars list is fresh
  | "revoked" // Google revoked the grant; the user must reconnect
  | "error" // the last status check failed unexpectedly
  | "unknown"; // never checked yet

export interface GoogleCalendarInfo {
  id: string;
  summary: string;
  primary: boolean;
  /** IANA zone from Google (e.g. "Asia/Kolkata"); null when Google sends none. */
  timeZone: string | null;
  /** Whether the user selected this calendar for future sync. */
  selected: boolean;
}

export interface GoogleConnectionState {
  status: GoogleConnectionStatus;
  email: string | null;
  calendars: GoogleCalendarInfo[];
  /** ISO timestamp of the last successful check; null when never checked. */
  lastCheckedAt: string | null;
}

export interface CalendarProvider {
  /**
   * Current connection state. Writes the metadata cache on success so the
   * UI can render something honest while offline. Throws ProviderOfflineError
   * when offline, ProviderNotSignedInError when the app session is gone,
   * ProviderRevokedError when Google revoked the grant.
   */
  getStatus(): Promise<GoogleConnectionState>;
  /** Start the OAuth flow. Navigates to /api/google/oauth/start (not fetch). */
  connect(): void;
  /** Revoke server-side, then mark the cached state disconnected. */
  disconnect(): Promise<void>;
  /** Re-fetch calendars + selections from the server and update the cache. */
  refreshCalendars(): Promise<GoogleCalendarInfo[]>;
  /** Toggle one calendar's selection; persists via the server, then cache. */
  setCalendarSelected(calendarId: string, selected: boolean): Promise<void>;
  /** Drop the local metadata cache (e.g. on account switch or logout). */
  clearCache(): Promise<void>;
}

/** Base error for provider failures. `code` is machine-readable. */
export class ProviderError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "ProviderError";
    this.code = code;
    // Keep instanceof working when targeting ES5-style output.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** No usable app session: sign-in redirect, or 401 without a revocation flag. */
export class ProviderNotSignedInError extends ProviderError {
  constructor(message = "Not signed in") {
    super("not_signed_in", message);
    this.name = "ProviderNotSignedInError";
  }
}

/** Device is offline, or the request never reached the server. Never claim a sync happened. */
export class ProviderOfflineError extends ProviderError {
  constructor(message = "Device is offline") {
    super("offline", message);
    this.name = "ProviderOfflineError";
  }
}

/** Google revoked the grant (401 with revoked flag). The user must reconnect. */
export class ProviderRevokedError extends ProviderError {
  constructor(message = "Google access was revoked") {
    super("revoked", message);
    this.name = "ProviderRevokedError";
  }
}
