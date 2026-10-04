import "server-only";

// lib/google/eventSync.ts
//
// SERVER ONLY. Two-way Google Calendar event sync orchestrator (V4.3.2).
//
// Google -> app: incremental sync per selected calendar via sync tokens
//   (full windowed resync when a token expires). Local rows are created,
//   updated, or removed to mirror Google; each link lives in
//   google_event_mappings.
// App -> Google: local events linked for sync (origin "synced", or Google
//   events already linked) are created/updated/deleted on Google with
//   If-Match etags. Runs only when the connection was granted the
//   calendar.events scope; otherwise writeBlocked=true and the push phase
//   is skipped.
//
// Conflict policy (V4.3.2): Google wins on concurrent modification; the conflict is returned to the caller and surfaced in UI, never silent. Rationale: Google is the shared/external system; deterministic; user is informed.
//
// All timestamps are ISO strings. Every database read/write is owner-scoped.
// Retries are bounded inside lib/google/googleApi.ts; there are no unbounded
// loops here (event pagination is capped at MAX_SYNC_PAGES).

import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptToken } from "./tokenVault";
import {
  getUserConnection,
  InvalidGrantError,
  isInvalidGrant,
  refreshConnectionAccessToken,
} from "./server";
import type { GoogleCalendarConnection } from "./types";
import {
  createEvent,
  deleteEvent,
  getEvent,
  GoogleAuthError,
  GoogleConflictError,
  GoogleNotFoundError,
  listEvents,
  SyncTokenInvalidError,
  updateEvent,
  type FetchImpl,
} from "./googleApi";
import {
  googleEventToLocal,
  localEventToGoogle,
  type GoogleApiEvent,
  type LocalEventDraft,
} from "./eventMapping";

/** Thrown when the user has no Google Calendar connection at all. */
export class NotConnectedError extends Error {}

/** Thrown when the stored grant is dead (revoked by Google or the user). */
export class RevokedError extends Error {}

export interface GoogleSyncConflict {
  localEventId: string | null;
  title: string;
  reason: string;
}

export interface GoogleSyncCalendarResult {
  calendarId: string;
  ok: boolean;
  error?: string;
}

export interface GoogleSyncResult {
  syncedAt: string;
  imported: number;
  updated: number;
  deleted: number;
  pushed: number;
  conflicts: GoogleSyncConflict[];
  writeBlocked: boolean;
  calendars: GoogleSyncCalendarResult[];
}

export interface RunGoogleSyncArgs {
  supabase: SupabaseClient;
  userId: string;
  /** IANA time zone used to interpret Google events as wall-clock time. */
  timeZone: string;
  fetchImpl?: typeof fetch;
}

/** Scope that unlocks the app -> Google push phase. */
const WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.events";

/** 60s early-expiry skew so a token never dies mid-request. */
const EXPIRY_SKEW_MS = 60_000;

/** Server-side pagination cap for a single calendar's event fetch. */
const MAX_SYNC_PAGES = 20;

/** Incremental resync window when no sync token exists (ISO bounds). */
const INITIAL_SYNC_DAYS_BACK = 30;
const INITIAL_SYNC_DAYS_FORWARD = 180;

const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

/** Row shapes for the 0010 sync tables (owner RLS on all of them). */
interface EventMappingRow {
  owner: string;
  local_event_id: string | null;
  google_account_id: string;
  google_calendar_id: string;
  google_event_id: string | null;
  google_etag: string | null;
  origin: "google" | "synced";
  google_timezone: string | null;
  recurrence: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CalendarEventRow {
  id: string;
  owner: string;
  title: string;
  event_date: string;
  start_time: string;
  end_time: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

async function markConnectionRevoked(
  supabase: SupabaseClient,
  conn: GoogleCalendarConnection,
  userId: string
): Promise<void> {
  await supabase
    .from("google_calendar_connections")
    .update({ status: "revoked", updated_at: new Date().toISOString() })
    .eq("id", conn.id)
    .eq("owner", userId);
}

/**
 * Reuse-or-refresh access token, mirroring the /api/google/calendars route:
 * decrypt the stored token while it is still valid, otherwise refresh via
 * Google. On InvalidGrantError the connection is marked revoked and a
 * RevokedError is thrown.
 */
async function getAccessToken(
  supabase: SupabaseClient,
  userId: string,
  conn: GoogleCalendarConnection
): Promise<string> {
  const expiresAt = conn.token_expires_at
    ? Date.parse(conn.token_expires_at)
    : Number.NaN;
  const stillValid =
    conn.access_token_enc &&
    Number.isFinite(expiresAt) &&
    expiresAt - EXPIRY_SKEW_MS > Date.now();

  if (stillValid && conn.access_token_enc) {
    try {
      return decryptToken(conn.access_token_enc);
    } catch {
      // Fall through to refresh below.
    }
  }
  try {
    return await refreshConnectionAccessToken(supabase, conn);
  } catch (err) {
    if (err instanceof InvalidGrantError || isInvalidGrant(err)) {
      await markConnectionRevoked(supabase, conn, userId);
      throw new RevokedError("Google revoked the OAuth grant.");
    }
    throw err;
  }
}

/**
 * Fetch every page of events.list for one calendar (capped at
 * MAX_SYNC_PAGES). Incremental when a sync token exists; otherwise a
 * windowed initial sync (now-30d .. now+180d). Returns the collected items
 * and the next sync token (only present on the final page).
 */
async function fetchAllPages(
  fetchImpl: FetchImpl,
  accessToken: string,
  calendarId: string,
  syncToken: string | null
): Promise<{ items: GoogleApiEvent[]; syncToken: string | null }> {
  const items: GoogleApiEvent[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | null = null;
  const nowMs = Date.now();
  const timeMin = new Date(
    nowMs - INITIAL_SYNC_DAYS_BACK * 24 * 60 * 60 * 1000
  ).toISOString();
  const timeMax = new Date(
    nowMs + INITIAL_SYNC_DAYS_FORWARD * 24 * 60 * 60 * 1000
  ).toISOString();

  for (let page = 0; page < MAX_SYNC_PAGES; page++) {
    const res = await listEvents(fetchImpl, accessToken, calendarId, {
      syncToken: syncToken ?? undefined,
      pageToken,
      ...(syncToken ? {} : { timeMin, timeMax }),
    });
    items.push(...res.items);
    if (!res.nextPageToken) {
      nextSyncToken = res.nextSyncToken ?? null;
      break;
    }
    pageToken = res.nextPageToken;
  }
  return { items, syncToken: nextSyncToken };
}

async function loadLocalEvent(
  supabase: SupabaseClient,
  userId: string,
  localEventId: string
): Promise<CalendarEventRow | null> {
  const { data } = await supabase
    .from("calendar_events")
    .select("*")
    .eq("id", localEventId)
    .eq("owner", userId)
    .maybeSingle();
  return (data ?? null) as CalendarEventRow | null;
}

/** Null out the local link on a mapping (tombstone); never touches Google. */
async function clearMappingLink(
  supabase: SupabaseClient,
  userId: string,
  mapping: EventMappingRow
): Promise<void> {
  if (!mapping.local_event_id) return;
  await supabase
    .from("google_event_mappings")
    .update({ local_event_id: null })
    .eq("owner", userId)
    .eq("local_event_id", mapping.local_event_id);
}

async function updateLocalFromDraft(
  supabase: SupabaseClient,
  userId: string,
  localEventId: string,
  draft: LocalEventDraft
): Promise<void> {
  const { error } = await supabase
    .from("calendar_events")
    .update({
      title: draft.title,
      event_date: draft.event_date,
      start_time: draft.start_time,
      end_time: draft.end_time,
      notes: draft.notes,
    })
    .eq("id", localEventId)
    .eq("owner", userId);
  if (error) {
    throw new Error("Could not update the local event from Google.");
  }
}

/**
 * Shared "Google deleted it" handling: when the local copy is untouched
 * since the last sync, delete it and tombstone the mapping; otherwise keep
 * the local copy and record a conflict. (Google still wins the tie-break
 * only when both sides changed — here the user is told instead.)
 */
async function handleGoogleDeleted(
  supabase: SupabaseClient,
  userId: string,
  mapping: EventMappingRow,
  local: CalendarEventRow,
  result: GoogleSyncResult
): Promise<void> {
  const untouched =
    !mapping.last_synced_at || local.updated_at <= mapping.last_synced_at;
  if (untouched) {
    await supabase
      .from("calendar_events")
      .delete()
      .eq("id", local.id)
      .eq("owner", userId);
    await clearMappingLink(supabase, userId, mapping);
    result.deleted++;
  } else {
    result.conflicts.push({
      localEventId: local.id,
      title: local.title,
      reason: "google-deleted-locally-edited",
    });
  }
}

async function updateMappingGoogleRef(
  supabase: SupabaseClient,
  userId: string,
  mapping: EventMappingRow,
  googleEventId: string,
  etag: string | null,
  now: string
): Promise<void> {
  // Identified by (owner, local_event_id) — unique and never null here, so
  // no null-comparison pitfalls on google_event_id.
  await supabase
    .from("google_event_mappings")
    .update({
      google_event_id: googleEventId,
      google_etag: etag,
      last_synced_at: now,
    })
    .eq("owner", userId)
    .eq("local_event_id", mapping.local_event_id as string);
}

/**
 * Google -> app for one event item. Handles cancelled events, new imports,
 * tombstones, unchanged skips, Google-side edits, and both-changed
 * conflicts (Google wins, conflict recorded).
 */
async function applyGoogleItem(
  supabase: SupabaseClient,
  userId: string,
  googleAccountId: string,
  calendarId: string,
  timeZone: string,
  item: GoogleApiEvent,
  now: string,
  result: GoogleSyncResult
): Promise<void> {
  const googleEventId = item.id as string;

  const { data: mappingRow } = await supabase
    .from("google_event_mappings")
    .select("*")
    .eq("owner", userId)
    .eq("google_calendar_id", calendarId)
    .eq("google_event_id", googleEventId)
    .maybeSingle();
  const mapping = (mappingRow ?? null) as EventMappingRow | null;

  if (item.status === "cancelled") {
    if (mapping?.local_event_id) {
      const local = await loadLocalEvent(
        supabase,
        userId,
        mapping.local_event_id
      );
      if (!local) {
        // Local row already gone: convert to a tombstone, stay silent.
        await clearMappingLink(supabase, userId, mapping);
        return;
      }
      await handleGoogleDeleted(supabase, userId, mapping, local, result);
    }
    return;
  }

  if (!mapping) {
    // Brand-new Google event: import it and link it (origin "google").
    const draft = googleEventToLocal(item, timeZone);
    const { data: inserted, error: insertError } = await supabase
      .from("calendar_events")
      .insert({
        owner: userId,
        title: draft.title,
        event_date: draft.event_date,
        start_time: draft.start_time,
        end_time: draft.end_time,
        notes: draft.notes,
      })
      .select("id")
      .single();
    if (insertError || !inserted) {
      throw new Error(`Could not import Google event ${googleEventId}.`);
    }
    const localId = (inserted as { id: string }).id;
    const { error: mapError } = await supabase
      .from("google_event_mappings")
      .insert({
        owner: userId,
        local_event_id: localId,
        google_account_id: googleAccountId,
        google_calendar_id: calendarId,
        google_event_id: googleEventId,
        google_etag: item.etag ?? null,
        origin: "google",
        google_timezone: timeZone,
        recurrence: item.recurrence?.[0] ?? null,
        last_synced_at: now,
      });
    if (mapError) {
      // Avoid an orphaned local event when the link row fails.
      await supabase
        .from("calendar_events")
        .delete()
        .eq("id", localId)
        .eq("owner", userId);
      throw new Error(`Could not link imported Google event ${googleEventId}.`);
    }
    result.imported++;
    return;
  }

  if (!mapping.local_event_id) {
    // Tombstone: the user removed the local copy of this Google event (or a
    // Google deletion was already processed). Never re-import.
    return;
  }

  if (item.etag != null && item.etag === mapping.google_etag) {
    return; // Unchanged since the last sync.
  }

  const local = await loadLocalEvent(supabase, userId, mapping.local_event_id);
  if (!local) {
    // Local row deleted by the user outside the mapping: tombstone it so
    // the Google copy is never re-imported (and never deleted — it is the
    // user's real Google event).
    await clearMappingLink(supabase, userId, mapping);
    return;
  }

  const draft = googleEventToLocal(item, timeZone);
  const locallyModified =
    local.updated_at > (mapping.last_synced_at ?? local.created_at);
  await updateLocalFromDraft(supabase, userId, local.id, draft);
  await supabase
    .from("google_event_mappings")
    .update({ google_etag: item.etag ?? null, last_synced_at: now })
    .eq("owner", userId)
    .eq("local_event_id", mapping.local_event_id);
  if (locallyModified) {
    result.conflicts.push({
      localEventId: local.id,
      title: draft.title,
      reason: "both-changed-google-kept",
    });
  }
  result.updated++;
}

/**
 * Google -> app for one calendar: load the sync token, fetch (incremental
 * or full), apply every item, persist the new token. A 401 marks the
 * connection revoked and aborts the whole sync with RevokedError.
 */
async function syncCalendarFromGoogle(
  supabase: SupabaseClient,
  userId: string,
  conn: GoogleCalendarConnection,
  timeZone: string,
  fetchImpl: FetchImpl,
  accessToken: string,
  calendarId: string,
  now: string,
  result: GoogleSyncResult
): Promise<void> {
  try {
    const { data: stateRow } = await supabase
      .from("google_calendar_sync_state")
      .select("sync_token")
      .eq("owner", userId)
      .eq("google_calendar_id", calendarId)
      .maybeSingle();
    let syncToken: string | null =
      (stateRow as { sync_token: string | null } | null)?.sync_token ?? null;

    let fetched: { items: GoogleApiEvent[]; syncToken: string | null };
    let tokenInvalidated = false;
    try {
      fetched = await fetchAllPages(fetchImpl, accessToken, calendarId, syncToken);
    } catch (err) {
      if (err instanceof SyncTokenInvalidError) {
        // Token expired: drop it and fall back to a full windowed resync.
        tokenInvalidated = true;
        syncToken = null;
        fetched = await fetchAllPages(fetchImpl, accessToken, calendarId, null);
      } else {
        throw err;
      }
    }

    for (const item of fetched.items) {
      if (!item.id) continue;
      await applyGoogleItem(
        supabase,
        userId,
        conn.google_account_id,
        calendarId,
        timeZone,
        item,
        now,
        result
      );
    }

    const upsertRow: Record<string, unknown> = {
      owner: userId,
      google_account_id: conn.google_account_id,
      google_calendar_id: calendarId,
      last_synced_at: now,
    };
    if (fetched.syncToken) {
      upsertRow.sync_token = fetched.syncToken;
    } else if (tokenInvalidated) {
      // Clear the dead token so the next sync starts fresh.
      upsertRow.sync_token = null;
    }
    await supabase
      .from("google_calendar_sync_state")
      .upsert(upsertRow, { onConflict: "owner,google_calendar_id" });
  } catch (err) {
    if (err instanceof GoogleAuthError) {
      await markConnectionRevoked(supabase, conn, userId);
      throw new RevokedError("Google rejected the access token.");
    }
    throw err;
  }
}

/**
 * App -> Google push phase. Only runs when the connection granted the
 * calendar.events scope. Per-mapping errors are recorded as conflicts so one
 * bad mapping never aborts the rest.
 */
async function pushLocalChanges(
  supabase: SupabaseClient,
  userId: string,
  timeZone: string,
  fetchImpl: FetchImpl,
  accessToken: string,
  now: string,
  result: GoogleSyncResult
): Promise<void> {
  const { data: mappingRows } = await supabase
    .from("google_event_mappings")
    .select("*")
    .eq("owner", userId)
    .not("local_event_id", "is", null);
  const mappings = ((mappingRows ?? []) as EventMappingRow[]).filter(
    (m) => m.local_event_id
  );

  const localIds = [
    ...new Set(mappings.map((m) => m.local_event_id as string)),
  ];
  const { data: eventRows } = localIds.length > 0
    ? await supabase
        .from("calendar_events")
        .select("*")
        .eq("owner", userId)
        .in("id", localIds)
    : { data: [] as CalendarEventRow[] };
  const localById = new Map(
    ((eventRows ?? []) as CalendarEventRow[]).map((e) => [e.id, e])
  );

  for (const mapping of mappings) {
    const localEventId = mapping.local_event_id as string;
    const local = localById.get(localEventId) ?? null;
    try {
      if (!local) {
        // Local row deleted by the user: tombstone the mapping so the
        // Google copy is never re-imported — and never deleted here (for
        // origin "google" it is the user's real Google event).
        await clearMappingLink(supabase, userId, mapping);
        continue;
      }
      const tz = mapping.google_timezone ?? timeZone;
      if (!mapping.google_event_id) {
        // New local event linked for sync: create it on Google.
        const created = await createEvent(
          fetchImpl,
          accessToken,
          mapping.google_calendar_id,
          localEventToGoogle(local, tz)
        );
        await updateMappingGoogleRef(
          supabase,
          userId,
          mapping,
          created.id,
          created.etag,
          now
        );
        result.pushed++;
        continue;
      }
      if (local.updated_at > (mapping.last_synced_at ?? EPOCH_ISO)) {
        try {
          const saved = await updateEvent(
            fetchImpl,
            accessToken,
            mapping.google_calendar_id,
            mapping.google_event_id,
            localEventToGoogle(local, tz),
            mapping.google_etag
          );
          await updateMappingGoogleRef(
            supabase,
            userId,
            mapping,
            saved.id,
            saved.etag,
            now
          );
          result.pushed++;
        } catch (err) {
          if (err instanceof GoogleConflictError) {
            // Google copy changed too: Google wins — refresh the local row.
            const latest = await getEvent(
              fetchImpl,
              accessToken,
              mapping.google_calendar_id,
              mapping.google_event_id
            );
            const draft = googleEventToLocal(latest, tz);
            await updateLocalFromDraft(supabase, userId, local.id, draft);
            await updateMappingGoogleRef(
              supabase,
              userId,
              mapping,
              mapping.google_event_id,
              latest.etag ?? null,
              now
            );
            result.updated++;
            result.conflicts.push({
              localEventId: local.id,
              title: draft.title,
              reason: "both-changed-google-kept",
            });
          } else if (err instanceof GoogleNotFoundError) {
            // Deleted on Google between import and push: mirror the
            // cancelled-event rules.
            await handleGoogleDeleted(supabase, userId, mapping, local, result);
          } else {
            throw err;
          }
        }
      }
    } catch (err) {
      if (err instanceof GoogleAuthError) throw err;
      result.conflicts.push({
        localEventId,
        title: local?.title ?? "(unknown)",
        reason: `push-failed:${err instanceof Error ? err.message : "unknown error"}`,
      });
    }
  }

  // Tombstoned "synced" mappings: the user deleted the local event after it
  // was pushed — delete the Google copy, then drop the mapping row.
  // (origin "google" tombstones are the user's real Google events: never
  // deleted.)
  const { data: tombRows } = await supabase
    .from("google_event_mappings")
    .select("*")
    .eq("owner", userId)
    .eq("origin", "synced")
    .is("local_event_id", null)
    .not("google_event_id", "is", null);
  for (const row of ((tombRows ?? []) as EventMappingRow[])) {
    try {
      if (row.google_event_id) {
        await deleteEvent(
          fetchImpl,
          accessToken,
          row.google_calendar_id,
          row.google_event_id
        );
      }
      await supabase
        .from("google_event_mappings")
        .delete()
        .eq("owner", userId)
        .eq("google_calendar_id", row.google_calendar_id)
        .eq("google_event_id", row.google_event_id as string);
      result.deleted++;
    } catch (err) {
      if (err instanceof GoogleAuthError) throw err;
      // Leave the tombstone for the next sync to retry.
    }
  }
}

/**
 * Run a two-way Google Calendar sync for the session user.
 *
 * Throws NotConnectedError when no connection exists, RevokedError when the
 * stored grant is dead (the connection is marked revoked first). Otherwise
 * returns per-calendar import results plus push-phase counters; one failing
 * calendar never aborts the others.
 */
export async function runGoogleSync(
  args: RunGoogleSyncArgs
): Promise<GoogleSyncResult> {
  const { supabase, userId, timeZone } = args;
  const fetchImpl: FetchImpl = args.fetchImpl ?? fetch;

  // Fail fast: every conversion below depends on a valid IANA zone.
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    throw new Error(`Invalid timeZone: ${timeZone}`);
  }

  const now = new Date().toISOString();
  const result: GoogleSyncResult = {
    syncedAt: now,
    imported: 0,
    updated: 0,
    deleted: 0,
    pushed: 0,
    conflicts: [],
    writeBlocked: false,
    calendars: [],
  };

  // (a) Connection — owner always comes from the session user id.
  const conn = await getUserConnection(supabase, userId);
  if (!conn) throw new NotConnectedError("No Google Calendar connection.");
  if (conn.status === "revoked") {
    throw new RevokedError("The Google Calendar connection was revoked.");
  }

  // (b) Write access comes from the scopes granted at consent time.
  const canWrite = (conn.scopes ?? []).includes(WRITE_SCOPE);
  result.writeBlocked = !canWrite;

  // (c) Access token, reuse-or-refresh.
  const accessToken = await getAccessToken(supabase, userId, conn);

  // (d) Selected calendars.
  const { data: selections } = await supabase
    .from("google_calendar_selections")
    .select("google_calendar_id")
    .eq("owner", userId)
    .eq("selected", true);
  const calendarIds = ((selections ?? []) as Array<{
    google_calendar_id: string;
  }>)
    .map((s) => s.google_calendar_id)
    .filter(Boolean);

  // (e/f) Google -> app, per calendar. One failing calendar is recorded and
  // the rest still sync.
  for (const calendarId of calendarIds) {
    try {
      await syncCalendarFromGoogle(
        supabase,
        userId,
        conn,
        timeZone,
        fetchImpl,
        accessToken,
        calendarId,
        now,
        result
      );
      result.calendars.push({ calendarId, ok: true });
    } catch (err) {
      if (err instanceof RevokedError) throw err;
      result.calendars.push({
        calendarId,
        ok: false,
        error: err instanceof Error ? err.message : "Unknown sync error.",
      });
    }
  }

  // (g) App -> Google, only with the write scope.
  if (canWrite) {
    try {
      await pushLocalChanges(
        supabase,
        userId,
        timeZone,
        fetchImpl,
        accessToken,
        now,
        result
      );
    } catch (err) {
      if (err instanceof GoogleAuthError) {
        await markConnectionRevoked(supabase, conn, userId);
        throw new RevokedError("Google rejected the access token.");
      }
      throw err;
    }
  }

  return result;
}
