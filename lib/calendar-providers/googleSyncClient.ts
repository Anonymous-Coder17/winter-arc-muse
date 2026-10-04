/**
 * V4.3.2 shared client-side Google event-sync flow.
 *
 * One place for the full sync sequence, shared by the Settings section and
 * the Calendar page so the two can never drift apart:
 *
 *   1. `engine.syncNow()` — push local edits to the cloud first, so the
 *      Google sync sees the latest app events.
 *   2. `provider.syncEvents(timeZone)` — POST /api/google/sync; the server
 *      imports/updates/deletes/pushes and records the result in the metadata
 *      cache.
 *   3. `engine.syncNow()` — pull the rows the server just imported, so the
 *      calendar views show them immediately.
 *
 * Concurrent calls share a single in-flight run (no overlapping syncs).
 *
 * Client-safe: imports only the sync engine and the provider port types.
 * Never `lib/google/*` (server-only).
 */
import { engine } from "@/lib/sync/engine";
import type { CalendarProvider, GoogleSyncResult } from "./types";

let inFlight: Promise<GoogleSyncResult> | null = null;

export function triggerGoogleSync(
  provider: CalendarProvider
): Promise<GoogleSyncResult> {
  if (inFlight) return inFlight;
  const run = (async (): Promise<GoogleSyncResult> => {
    // Push local changes first so Google sync sees the latest app events.
    await engine.syncNow();
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const result = await provider.syncEvents(timeZone);
    // Pull imported events so the calendar shows them right away. The
    // engine's sync tick also re-triggers data hooks that tag synced events.
    await engine.syncNow();
    return result;
  })();
  inFlight = run;
  const clear = () => {
    if (inFlight === run) inFlight = null;
  };
  run.then(clear, clear);
  return run;
}
