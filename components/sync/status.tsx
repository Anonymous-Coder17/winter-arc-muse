"use client";

import { useEffect, useState } from "react";
import { engine, type SyncSnapshot } from "@/lib/sync/engine";
import { StateDot } from "@/components/ui";

/** Re-render on every sync-engine state change. */
export function useSyncStatus(): SyncSnapshot {
  const [snap, setSnap] = useState<SyncSnapshot>(() => engine.getSnapshot());
  useEffect(() => engine.subscribe(() => setSnap({ ...engine.getSnapshot() })), []);
  return snap;
}

/**
 * A tick counter that bumps on every engine state change. Data hooks include
 * it in their load-effect deps so they re-read the local DB after each sync.
 */
export function useSyncTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => engine.subscribe(() => setTick((t) => t + 1)), []);
  return tick;
}

/** True when a record has queued (unsynced or failed) mutations. */
export function useRecordPending(id: string | null | undefined): boolean {
  const snap = useSyncStatus();
  return !!id && snap.pendingIds.has(id);
}

/**
 * Small, calm connectivity indicator. Mounted once in AppShell (all pages).
 * Vocabulary is deliberately non-technical: Offline / Syncing… / Synced /
 * Saved offline / Sync issue.
 */
export function ConnectivityBadge() {
  const snap = useSyncStatus();
  if (!snap.started || !snap.userId) return null;

  let label: string;
  let tone: "ok" | "warn" | "bad" | "idle";
  let title = "";

  if (snap.net === "offline") {
    tone = "warn";
    label = snap.pending > 0 ? `Offline · ${snap.pending} saved` : "Offline";
    title = "You're offline. Changes are saved on this device and will sync when you're back online.";
  } else if (snap.authIssue) {
    tone = "bad";
    label = "Sign-in needed";
    title = "Your session expired. Sign in again to sync.";
  } else if (snap.failed > 0) {
    tone = "bad";
    label = "Sync issue";
    title = `${snap.failed} change${snap.failed === 1 ? "" : "s"} couldn't reach the cloud. Your work is safe on this device and will keep retrying.`;
  } else if (snap.syncing) {
    tone = "idle";
    label = "Syncing…";
    title = "Syncing with the cloud…";
  } else if (snap.pending > 0) {
    tone = "warn";
    label = `${snap.pending} pending`;
    title = `${snap.pending} change${snap.pending === 1 ? "" : "s"} saved on this device, waiting to sync.`;
  } else {
    tone = "ok";
    label = "Synced";
    title = snap.lastSyncAt
      ? `Everything is synced as of ${new Date(snap.lastSyncAt).toLocaleTimeString()}.`
      : "Everything is synced.";
  }

  return (
    <span
      role="status"
      aria-live="polite"
      title={title}
      className="inline-flex items-center gap-1.5 rounded-full border hairline px-2.5 py-1 text-[11px] font-medium t-secondary surface-flat"
    >
      <StateDot tone={tone} />
      {label}
    </span>
  );
}
