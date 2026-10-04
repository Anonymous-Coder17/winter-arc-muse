"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { engine } from "@/lib/sync/engine";
import { getCalendarProvider } from "@/lib/calendar-providers";
import { readMetaCache } from "@/lib/calendar-providers/googleMeta";
import type {
  GoogleCalendarInfo,
  GoogleConnectionState,
} from "@/lib/calendar-providers/types";
import {
  EmptyState,
  ErrorState,
  LoadingBlock,
  StateDot,
} from "@/components/ui";

const provider = getCalendarProvider("google");

type Notice = { kind: "ok" | "warn" | "error"; text: string } | null;

function GoogleCalendarSectionInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [state, setState] = useState<GoogleConnectionState | null>(null);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [nonce, setNonce] = useState(0);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [disconnectArmed, setDisconnectArmed] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const armedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Connection status: live first, last-known cache when offline.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
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
    };
  }, [nonce]);

  // Post-OAuth feedback: show a transient note, then clean the query param.
  useEffect(() => {
    const gcal = searchParams.get("gcal");
    if (!gcal) return;
    if (gcal === "connected") {
      setNotice({ kind: "ok", text: "Connected." });
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
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not update the calendar."
      );
    } finally {
      setTogglingId(null);
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

  if (loading) return <LoadingBlock />;
  if (error && !state)
    return <ErrorState message={error} onRetry={() => setNonce((n) => n + 1)} />;
  if (!state) return <LoadingBlock />;

  const status = state.status;

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
            Connect Google Calendar to choose which calendars will participate
            in a future integration. Event sync isn&apos;t part of this version.
          </p>
          <button className="btn-primary" onClick={() => provider.connect()}>
            Connect Google Calendar
          </button>
        </>
      )}

      {status === "connected" && (
        <>
          <div className="flex items-center gap-2 mb-4">
            <StateDot tone="ok" />
            <span className="text-sm font-medium t-primary">Connected</span>
            {state.email && (
              <span className="text-sm t-secondary">{state.email}</span>
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
                  <span className="text-sm t-primary flex items-baseline gap-2">
                    {cal.summary}
                    {cal.primary && (
                      <span className="text-xs t-faint">Primary</span>
                    )}
                  </span>
                  <button
                    className={`seg-btn !min-h-[36px] ${
                      cal.selected ? "seg-btn-active" : ""
                    }`}
                    disabled={togglingId !== null}
                    onClick={() => onToggleCalendar(cal)}
                    aria-pressed={cal.selected}
                    aria-label={`${cal.selected ? "Exclude" : "Include"} ${cal.summary}`}
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
          >
            {disconnecting
              ? "Disconnecting…"
              : disconnectArmed
                ? "Tap again to confirm"
                : "Disconnect"}
          </button>
          <p className="text-xs t-faint mt-2">
            Disconnecting removes the connection only. Your app events and
            Google events are never deleted.
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

      {status === "error" && (
        <ErrorState
          message="Google Calendar ran into a problem. You can try again, or reconnect below."
          onRetry={() => setNonce((n) => n + 1)}
        />
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
