import "server-only";

// lib/google/googleApi.ts
//
// SERVER ONLY. Thin authenticated Google Calendar API (v3) client.
//
// Takes an injected fetchImpl (default: the global fetch) so it is
// unit-testable without network access. Retries are bounded: a single retry
// with a 1s backoff on 429/5xx, then a typed error. No tokens are ever
// logged or returned in errors.

import type { GoogleApiEvent, GoogleEventBody } from "./eventMapping";

export type FetchImpl = typeof fetch;

export class GoogleApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GoogleApiError";
    this.status = status;
  }
}

/** 401: Google rejected the access token (caller should refresh / revoke). */
export class GoogleAuthError extends GoogleApiError {
  constructor(message = "Google rejected the access token.") {
    super(401, message);
    this.name = "GoogleAuthError";
  }
}

/** 412: If-Match precondition failed — the Google event changed remotely. */
export class GoogleConflictError extends GoogleApiError {
  constructor(message = "The Google event changed since it was last read.") {
    super(412, message);
    this.name = "GoogleConflictError";
  }
}

/** 404: the Google event no longer exists. */
export class GoogleNotFoundError extends GoogleApiError {
  constructor(message = "The Google event was not found.") {
    super(404, message);
    this.name = "GoogleNotFoundError";
  }
}

/** 410: the incremental sync token expired — a full resync is required. */
export class SyncTokenInvalidError extends GoogleApiError {
  constructor(
    message = "The Google sync token expired; a full resync is required."
  ) {
    super(410, message);
    this.name = "SyncTokenInvalidError";
  }
}

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One retry with a 1s backoff on 429 / 5xx. Returns the final response for
 * the caller to interpret; throws GoogleApiError when the retried response
 * is still 429/5xx.
 */
async function fetchWithRetry(
  fetchImpl: FetchImpl,
  url: string,
  init?: RequestInit
): Promise<Response> {
  let res = await fetchImpl(url, init);
  if (res.status === 429 || res.status >= 500) {
    await sleep(1000);
    res = await fetchImpl(url, init);
    if (res.status === 429 || res.status >= 500) {
      throw new GoogleApiError(
        res.status,
        `Google Calendar API request failed after retry (status ${res.status}).`
      );
    }
  }
  return res;
}

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

function eventsUrl(calendarId: string, eventId?: string): string {
  const base = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`;
  return eventId ? `${base}/${encodeURIComponent(eventId)}` : base;
}

export interface ListEventsOpts {
  syncToken?: string;
  pageToken?: string;
  timeMin?: string;
  timeMax?: string;
}

export interface ListEventsResult {
  items: GoogleApiEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

/**
 * events.list. Always singleEvents=false (recurring masters stay whole) and
 * showDeleted=true (deletions surface as status:"cancelled").
 * Per the API, syncToken is mutually exclusive with timeMin/timeMax.
 */
export async function listEvents(
  fetchImpl: FetchImpl,
  accessToken: string,
  calendarId: string,
  opts: ListEventsOpts = {}
): Promise<ListEventsResult> {
  const params = new URLSearchParams({
    singleEvents: "false",
    showDeleted: "true",
    maxResults: "250",
  });
  if (opts.syncToken) {
    params.set("syncToken", opts.syncToken);
  } else {
    if (opts.timeMin) params.set("timeMin", opts.timeMin);
    if (opts.timeMax) params.set("timeMax", opts.timeMax);
  }
  if (opts.pageToken) params.set("pageToken", opts.pageToken);

  const res = await fetchWithRetry(
    fetchImpl,
    `${eventsUrl(calendarId)}?${params.toString()}`,
    { headers: authHeaders(accessToken) }
  );
  if (res.status === 401) throw new GoogleAuthError();
  if (res.status === 410) throw new SyncTokenInvalidError();
  if (!res.ok) {
    throw new GoogleApiError(
      res.status,
      `Google events.list failed (status ${res.status}).`
    );
  }

  const data = (await res.json()) as {
    items?: GoogleApiEvent[];
    nextPageToken?: string;
    nextSyncToken?: string;
  };
  return {
    items: data.items ?? [],
    nextPageToken: data.nextPageToken,
    nextSyncToken: data.nextSyncToken,
  };
}

/** events.get — fetch a single event (used to refresh after a 412). */
export async function getEvent(
  fetchImpl: FetchImpl,
  accessToken: string,
  calendarId: string,
  eventId: string
): Promise<GoogleApiEvent> {
  const res = await fetchWithRetry(fetchImpl, eventsUrl(calendarId, eventId), {
    headers: authHeaders(accessToken),
  });
  if (res.status === 401) throw new GoogleAuthError();
  if (res.status === 404) throw new GoogleNotFoundError();
  if (!res.ok) {
    throw new GoogleApiError(
      res.status,
      `Google events.get failed (status ${res.status}).`
    );
  }
  return (await res.json()) as GoogleApiEvent;
}

/** events.insert — returns the new event's id and etag. */
export async function createEvent(
  fetchImpl: FetchImpl,
  accessToken: string,
  calendarId: string,
  body: GoogleEventBody
): Promise<{ id: string; etag: string }> {
  const res = await fetchWithRetry(fetchImpl, eventsUrl(calendarId), {
    method: "POST",
    headers: { ...authHeaders(accessToken), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new GoogleAuthError();
  if (!res.ok) {
    throw new GoogleApiError(
      res.status,
      `Google events.insert failed (status ${res.status}).`
    );
  }
  const data = (await res.json()) as { id?: string; etag?: string };
  if (!data.id) {
    throw new GoogleApiError(
      res.status,
      "Google events.insert returned no event id."
    );
  }
  return { id: data.id, etag: data.etag ?? "" };
}

/**
 * events.update — sends If-Match with the last-known etag when provided, so
 * a concurrent remote edit surfaces as GoogleConflictError instead of being
 * silently overwritten.
 */
export async function updateEvent(
  fetchImpl: FetchImpl,
  accessToken: string,
  calendarId: string,
  eventId: string,
  body: GoogleEventBody,
  etag?: string | null
): Promise<{ id: string; etag: string }> {
  const headers: Record<string, string> = {
    ...authHeaders(accessToken),
    "Content-Type": "application/json",
  };
  if (etag) headers["If-Match"] = etag;
  const res = await fetchWithRetry(fetchImpl, eventsUrl(calendarId, eventId), {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new GoogleAuthError();
  if (res.status === 412) throw new GoogleConflictError();
  if (res.status === 404) throw new GoogleNotFoundError();
  if (!res.ok) {
    throw new GoogleApiError(
      res.status,
      `Google events.update failed (status ${res.status}).`
    );
  }
  const data = (await res.json()) as { id?: string; etag?: string };
  return { id: data.id ?? eventId, etag: data.etag ?? "" };
}

/** events.delete — a 404 is treated as success (already gone). */
export async function deleteEvent(
  fetchImpl: FetchImpl,
  accessToken: string,
  calendarId: string,
  eventId: string
): Promise<void> {
  const res = await fetchWithRetry(fetchImpl, eventsUrl(calendarId, eventId), {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  if (res.status === 401) throw new GoogleAuthError();
  if (res.status === 404) return;
  if (!res.ok) {
    throw new GoogleApiError(
      res.status,
      `Google events.delete failed (status ${res.status}).`
    );
  }
}
