"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { engine } from "@/lib/sync/engine";
import { GoogleCalendarProvider } from "@/lib/calendar-providers/google";
import { triggerGoogleSync } from "@/lib/calendar-providers/googleSyncClient";
import {
  readMetaCache,
  writeSyncMeta,
} from "@/lib/calendar-providers/googleMeta";
import type {
  GoogleCalendarInfo,
  GoogleConnectionState,
  GoogleSyncStatus,
} from "@/lib/calendar-providers/types";
import {
  ProviderError,
  ProviderOfflineError,
  ProviderRevokedError,
} from "@/lib/calendar-providers/types";
import {
  EmptyState,
  ErrorState,
  LoadingBlock,
  StateDot,
} from "@/components/ui";

/**
 * Wired with the app user id so the provider can write the metadata cache
 * (connection state + V4.3.2 sync state). The resolver is lazy — it reads the
 * engine snapshot at call time, never at module load.
 */
const provider = new GoogleCalendarProvider(
  undefined,
  () => engine.getSnapshot().userId
);

type Notice = { kind: "ok" | "warn" | "error"; text: string } | null;

/** Calm relative time for "Last synced": "just now", "5 minutes ago", … */
function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return "unknown";
  if (ms < 60_000) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString();
}

function GoogleCalendarSectionInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [state, setState] = useState<GoogleConnectionState | null>(null);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  // Label for the loading state. After an OAuth return the reload is a
  // "Connecting…" step, not a generic load — the label makes that visible.
  const [loadingLabel, setLoadingLabel] = useState("Loading…");
  const pendingLabel = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [nonce, setNonce] = useState(0);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [disconnectArmed, setDisconnectArmed] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  // V4.3.2 event sync.
  const [sync, setSync] = useState<GoogleSyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const syncingRef = useRef(false);
  const syncDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Connection status: live first, last-known cache when offline.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      // Consume a pending label (e.g. "Connecting…" after OAuth) exactly once.
      const label = pendingLabel.current ?? "Loading…";
      pendingLabel.current = null;
      setLoadingLabel(label);
      setError(null);
      try {
        await engine.whenReady();
        const userId = engine.getSnapshot().userId;
        if (!userId) {
          if (!cancelled) setError("Not signed in.");
          return;
        }
        let next: GoogleConnectionState | null = null;
        let wasOffline = false;
        try {
          next = await provider.getStatus();
        } catch {
          // Offline: fall back to the last known status.
          wasOffline = true;
          next = await readMetaCache(userId);
        }
        if (cancelled) return;
        if (!next) {
          setError("Could not load Google Calendar status. Try again.");
          return;
        }
        setOffline(wasOffline);
        setState(next);
        // Last-known sync state (cache-only; cheap and offline-safe).
        try {
          const s = await provider.getSyncStatus();
          if (!cancelled) setSync(s);
        } catch {
          // The sync panel falls back to "Not synced yet".
        }
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Failed to load.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
      if (armedTimer.current) clearTimeout(armedTimer.current);
      if (syncDebounce.current) clearTimeout(syncDebounce.current);
    };
  }, [nonce]);

  // Post-OAuth feedback: show a transient note, then clean the query param.
  useEffect(() => {
    const gcal = searchParams.get("gcal");
    if (!gcal) return;
    if (gcal === "connected") {
      setNotice({ kind: "ok", text: "Connected." });
      // The reload below is the tail of the connect flow — label it so the
      // loading state reads "Connecting…", not a generic "Loading…".
      pendingLabel.current = "Connecting…";
      setNonce((n) => n + 1);
    } else if (gcal === "cancelled") {
      setNotice({ kind: "warn", text: "Connection cancelled." });
    } else {
      setNotice({
        kind: "error",
        text: "The connection didn't complete. You can try again.",
      });
    }
    router.replace("/settings", { scroll: false });
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [searchParams, router]);

  async function onToggleCalendar(cal: GoogleCalendarInfo) {
    if (togglingId) return;
    setTogglingId(cal.id);
    setError(null);
    try {
      await provider.setCalendarSelected(cal.id, !cal.selected);
      setState((s) =>
        s
          ? {
              ...s,
              calendars: s.calendars.map((c) =>
                c.id === cal.id ? { ...c, selected: !cal.selected } : c
              ),
            }
          : s
      );
      // The selection changed what sync covers — re-sync shortly after.
      if (syncDebounce.current) clearTimeout(syncDebounce.current);
      syncDebounce.current = setTimeout(() => {
        void runSync();
      }, 1500);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not update the calendar."
      );
    } finally {
      setTogglingId(null);
    }
  }

  /**
   * V4.3.2 sync flow: engine push -> Google sync -> engine pull. The shared
   * triggerGoogleSync guards against overlapping runs; syncingRef guards the
   * button UI on top of it.
   */
  async function runSync() {
    if (syncingRef.current) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setSyncError("offline");
      return;
    }
    syncingRef.current = true;
    setSyncing(true);
    setSyncError(null);
    try {
      await triggerGoogleSync(provider);
      const s = await provider.getSyncStatus();
      setSync(s);
    } catch (err) {
      if (err instanceof ProviderRevokedError) {
        // Reload connection state so the revoked branch renders.
        setNonce((n) => n + 1);
      } else if (err instanceof ProviderOfflineError) {
        setSyncError("offline");
      } else if (
        err instanceof ProviderError &&
        err.code === "not_connected"
      ) {
        setNonce((n) => n + 1);
      } else if (err instanceof ProviderError && err.code === "http_429") {
        // Temporary throttle from Google. No auto-retry — the user retries
        // manually, so a 429 can never turn into request spam.
        setSyncError("rate_limited");
      } else {
        setSyncError(
          err instanceof Error ? err.message : "Sync didn't complete."
        );
      }
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }

  /** Dismiss the conflict notice: clears conflicts from the cached result. */
  async function dismissConflicts() {
    const uid = engine.getSnapshot().userId;
    if (!uid) return;
    try {
      const s = await provider.getSyncStatus();
      if (!s.lastResult) return;
      const cleared = { ...s.lastResult, conflicts: [] };
      await writeSyncMeta(uid, {
        lastGoogleSyncAt: s.lastSyncedAt,
        lastGoogleSyncResult: cleared,
        googleSyncedEventIds: s.syncedEventIds,
      });
      setSync({ ...s, lastResult: cleared });
    } catch {
      // Dismissal is cosmetic; a failed write just leaves the notice up.
    }
  }

  async function onDisconnect() {
    if (!disconnectArmed) {
      setDisconnectArmed(true);
      if (armedTimer.current) clearTimeout(armedTimer.current);
      armedTimer.current = setTimeout(() => setDisconnectArmed(false), 4000);
      return;
    }
    setDisconnecting(true);
    try {
      await provider.disconnect();
      setDisconnectArmed(false);
      setNonce((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disconnect.");
    } finally {
      setDisconnecting(false);
    }
  }

  function renderNotice() {
    if (!notice) return null;
    const tone =
      notice.kind === "ok"
        ? "text-emerald-600 dark:text-emerald-400"
        : notice.kind === "warn"
          ? "text-amber-600 dark:text-amber-400"
          : "text-red-500 dark:text-red-400";
    return (
      <p className={`text-sm ${tone} mb-3`} role="status">
        {notice.text}
      </p>
    );
  }

  /** ErrorState announced assertively — a failed load must not be silent. */
  function renderAlertError(message: string, onRetry?: () => void) {
    return (
      <div role="alert">
        <ErrorState message={message} onRetry={onRetry} />
      </div>
    );
  }

  if (loading)
    return (
      <div role="status">
        <LoadingBlock label={loadingLabel} />
      </div>
    );
  if (error && !state)
    return renderAlertError(error, () => setNonce((n) => n + 1));
  if (!state)
    return (
      <div role="status">
        <LoadingBlock label={loadingLabel} />
      </div>
    );

  const status = state.status;

  // V4.3.2 sync status line (shown in the connected branch below).
  const syncResult = sync?.lastResult ?? null;
  const syncConflicts = syncResult?.conflicts ?? [];
  const syncWriteBlocked = !!syncResult?.writeBlocked;
  const liveOffline =
    typeof navigator !== "undefined" && navigator.onLine === false;
  let syncTone: "ok" | "warn" | "bad" | "idle";
  let syncLabel: string;
  if (syncing) {
    syncTone = "idle";
    syncLabel = "Syncing…";
  } else if (offline || liveOffline || syncError === "offline") {
    syncTone = "warn";
    syncLabel = "Offline — changes will sync when connected";
  } else if (status === "revoked" || syncWriteBlocked) {
    syncTone = "warn";
    syncLabel = "Reconnect required";
  } else if (syncError === "rate_limited") {
    syncTone = "warn";
    syncLabel = "Sync paused — try again in a bit";
  } else if (syncError) {
    syncTone = "bad";
    syncLabel = "Sync failed";
  } else if (sync?.lastSyncedAt) {
    syncTone = "ok";
    syncLabel = `Synced ${timeAgo(sync.lastSyncedAt)}`;
  } else {
    syncTone = "idle";
    syncLabel = "Not synced yet";
  }

  return (
    <>
      {renderNotice()}
      {error && state && (
        <p className="text-sm text-red-500 dark:text-red-400 mb-3" role="alert">
          {error}
        </p>
      )}

      {(status === "disconnected" || status === "unknown") && (
        <>
          <p className="text-sm t-secondary mb-4">
            Connect Google Calendar to choose which calendars sync with the
            app. Events flow both ways once sync runs.
          </p>
          <button className="btn-primary" onClick={() => provider.connect()}>
            Connect Google Calendar
          </button>
        </>
      )}

      {status === "connected" && (
        <>
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            <StateDot tone="ok" />
            <span className="text-sm font-medium t-primary">Connected</span>
            {state.email && (
              <span className="text-sm t-secondary break-all">
                {state.email}
              </span>
            )}
          </div>

          {/* V4.3.2 event sync */}
          <div className="mb-4 rounded-xl border hairline px-3 py-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <span
                role="status"
                aria-live="polite"
                className="flex items-center gap-2 text-sm"
              >
                <StateDot tone={syncTone} />
                <span className="t-primary font-medium">{syncLabel}</span>
              </span>
              <button
                className="btn-secondary !min-h-[36px]"
                onClick={() => void runSync()}
                disabled={syncing || offline || liveOffline}
              >
                {syncing ? "Syncing…" : "Sync now"}
              </button>
            </div>
            <p className="text-xs t-faint mt-2">
              Last synced:{" "}
              {sync?.lastSyncedAt ? timeAgo(sync.lastSyncedAt) : "Never"}
            </p>
            {syncError === "rate_limited" && (
              <p
                className="text-sm text-amber-600 dark:text-amber-400 mt-2"
                role="alert"
              >
                Google is temporarily limiting requests. Waiting a moment,
                then trying again usually works.{" "}
                <button className="underline" onClick={() => void runSync()}>
                  Try again
                </button>
              </p>
            )}
            {syncError &&
              syncError !== "offline" &&
              syncError !== "rate_limited" && (
                <p
                  className="text-sm text-red-500 dark:text-red-400 mt-2"
                  role="alert"
                >
                  Sync didn&apos;t complete.{" "}
                  <button className="underline" onClick={() => void runSync()}>
                    Try again
                  </button>
                </p>
              )}
            {syncConflicts.length > 0 && (
              <div
                className="mt-3 rounded-xl bg-amber-500/10 px-3 py-2.5"
                role="status"
              >
                <p className="text-sm t-primary font-medium mb-1">
                  Google&apos;s version was kept for these events
                </p>
                <ul className="text-sm t-secondary list-disc pl-5 flex flex-col gap-0.5">
                  {syncConflicts.map((c, i) => (
                    <li key={`${c.title}-${i}`}>{c.title}</li>
                  ))}
                </ul>
                <button
                  className="btn-ghost !min-h-[32px] text-xs mt-2"
                  onClick={() => void dismissConflicts()}
                >
                  Dismiss
                </button>
              </div>
            )}
            {syncWriteBlocked && (
              <div className="mt-3 rounded-xl bg-amber-500/10 px-3 py-2.5">
                <p className="text-sm t-secondary">
                  Reconnect Google Calendar to enable creating and editing
                  Google events from the app.
                </p>
                <button
                  className="btn-primary !min-h-[36px] mt-2"
                  onClick={() => provider.connect()}
                >
                  Reconnect
                </button>
              </div>
            )}
          </div>

          {state.calendars.length === 0 ? (
            <EmptyState
              title="No calendars found"
              body="Your Google account has no calendars to choose from."
            />
          ) : (
            <div className="flex flex-col gap-1 mb-4">
              {state.calendars.map((cal) => (
                <div
                  key={cal.id}
                  className="flex items-center justify-between gap-3 rounded-xl px-3 py-2 hover:bg-black/5 dark:hover:bg-white/5"
                >
                  <span className="text-sm t-primary flex items-baseline gap-2 min-w-0 flex-1">
                    <span className="truncate">{cal.summary}</span>
                    {cal.primary && (
                      <span className="text-xs t-faint shrink-0">Primary</span>
                    )}
                  </span>
                  <button
                    className={`seg-btn !min-h-[36px] shrink-0 whitespace-nowrap disabled:opacity-50 ${
                      cal.selected ? "seg-btn-active" : ""
                    }`}
                    disabled={togglingId !== null}
                    onClick={() => onToggleCalendar(cal)}
                    aria-pressed={cal.selected}
                    aria-label={
                      togglingId === cal.id
                        ? `Updating ${cal.summary}…`
                        : `${cal.selected ? "Exclude" : "Include"} ${cal.summary}`
                    }
                  >
                    {togglingId === cal.id
                      ? "…"
                      : cal.selected
                        ? "Included"
                        : "Not included"}
                  </button>
                </div>
              ))}
            </div>
          )}

          <button
            className="btn-danger"
            onClick={onDisconnect}
            disabled={disconnecting}
            aria-live="polite"
            aria-describedby="gcal-disconnect-note"
          >
            {disconnecting
              ? "Disconnecting…"
              : disconnectArmed
                ? "Tap again to confirm"
                : "Disconnect"}
          </button>
          <p id="gcal-disconnect-note" className="text-xs t-faint mt-2">
            Disconnecting removes the connection only — your app events stay,
            and nothing is deleted from Google. You can reconnect anytime.
          </p>
        </>
      )}

      {status === "revoked" && (
        <>
          <div className="flex items-center gap-2 mb-3">
            <StateDot tone="warn" />
            <span className="text-sm font-medium t-primary">
              Connection revoked
            </span>
          </div>
          <p className="text-sm t-secondary mb-4">
            Google revoked access to your calendars. Reconnect to choose
            calendars again.
          </p>
          <button className="btn-primary" onClick={() => provider.connect()}>
            Reconnect Google Calendar
          </button>
        </>
      )}

      {status === "error" &&
        renderAlertError(
          "Google Calendar ran into a problem. You can try again, or reconnect below.",
          () => setNonce((n) => n + 1)
        )}

      {offline && (
        <p className="text-xs t-faint mt-3">
          You&apos;re offline — showing last known status.
        </p>
      )}
    </>
  );
}

export default function GoogleCalendarSection() {
  return (
    <section className="surface card-pad" aria-label="Google Calendar">
      <h2 className="section-title mb-3">Google Calendar</h2>
      <Suspense fallback={<LoadingBlock />}>
        <GoogleCalendarSectionInner />
      </Suspense>
    </section>
  );
}
