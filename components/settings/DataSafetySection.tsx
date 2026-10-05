"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { engine } from "@/lib/sync/engine";
import { DB_NAME_PREFIX } from "@/lib/sync/types";
import { clearCache as clearGoogleMetaCache } from "@/lib/calendar-providers/googleMeta";
import { DELETE_CONFIRMATION_PHRASE } from "@/lib/accountDeletion";
import { ErrorState } from "@/components/ui";

/**
 * V4.8 (Data & Account Safety) — "Your Data" settings section.
 *
 * Two capabilities, both server-enforced:
 *  1. Export my data — downloads a JSON archive of the authenticated user's
 *     data (GET /api/export). Secrets are stripped server-side.
 *  2. Delete my account — permanently deletes all of the user's application
 *     data (POST /api/account/delete) after deliberate typed confirmation.
 *     Google Calendar events are never touched; the Google grant is revoked
 *     best-effort and the encrypted tokens are dropped with the connection.
 */
export default function DataSafetySection() {
  const router = useRouter();
  const [exportBusy, setExportBusy] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const [deleteStep, setDeleteStep] = useState<"idle" | "warn" | "done">("idle");
  const [confirmText, setConfirmText] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function onExport() {
    setExportBusy(true);
    setExportMsg(null);
    setExportError(null);
    try {
      const res = await fetch("/api/export");
      if (!res.ok) {
        throw new Error(
          res.status === 401
            ? "You are not signed in."
            : "Export failed. Please try again."
        );
      }
      const blob = await res.blob();
      const stamp = new Date().toISOString().slice(0, 10);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `winter-arc-export-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setExportMsg("Your data has been downloaded as a JSON file.");
    } catch (err) {
      setExportError(
        err instanceof Error ? err.message : "Export failed. Please try again."
      );
    } finally {
      setExportBusy(false);
    }
  }

  async function onDeleteAccount(e: FormEvent) {
    e.preventDefault();
    if (confirmText !== DELETE_CONFIRMATION_PHRASE) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const userId = engine.getSnapshot().userId;
      const res = await fetch("/api/account/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: DELETE_CONFIRMATION_PHRASE }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          body?.error ?? "Account deletion failed. Please try again."
        );
      }
      // Server has deleted all application data. Purge local state:
      // close the user's local DB, drop the orphaned IndexedDB database
      // (best-effort), clear caches, and sign out.
      await engine.handleLogout();
      try {
        if (userId && typeof indexedDB !== "undefined") {
          indexedDB.deleteDatabase(DB_NAME_PREFIX + userId);
        }
      } catch {
        /* best-effort: orphaned local rows are inaccessible without a session */
      }
      try {
        await clearGoogleMetaCache();
      } catch {
        /* best-effort */
      }
      const supabase = createClient();
      await supabase.auth.signOut();
      setDeleteStep("done");
      router.replace("/login");
      router.refresh();
    } catch (err) {
      setDeleteError(
        err instanceof Error
          ? err.message
          : "Account deletion failed. Please try again."
      );
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Export */}
      <div>
        <h3 className="text-sm font-semibold t-primary mb-1">Export my data</h3>
        <p className="text-sm t-secondary mb-3">
          Download a copy of your Winter Arc data as a JSON file. Only your
          data is included — never passwords, tokens, or secrets.
        </p>
        <button
          className="btn-secondary"
          onClick={onExport}
          disabled={exportBusy}
          aria-busy={exportBusy}
        >
          {exportBusy ? "Preparing export…" : "Export my data"}
        </button>
        {exportMsg && (
          <p className="text-sm text-emerald-600 dark:text-emerald-400 mt-2" role="status">
            {exportMsg}
          </p>
        )}
        {exportError && (
          <div className="mt-2">
            <ErrorState message={exportError} onRetry={onExport} />
          </div>
        )}
      </div>

      {/* Delete account */}
      <div className="border-t border-black/10 dark:border-white/10 pt-5">
        <h3 className="text-sm font-semibold t-primary mb-1">Delete my account</h3>
        {deleteStep === "idle" && (
          <>
            <p className="text-sm t-secondary mb-3">
              Permanently delete your Winter Arc account and all associated app
              data.
            </p>
            <button
              className="btn-danger"
              onClick={() => {
                setDeleteStep("warn");
                setDeleteError(null);
                setConfirmText("");
              }}
            >
              Delete my account
            </button>
          </>
        )}
        {deleteStep === "warn" && (
          <form onSubmit={onDeleteAccount} className="flex flex-col gap-3">
            <div
              className="rounded-xl border border-red-500/40 bg-red-500/10 p-4"
              role="alert"
            >
              <p className="text-sm font-semibold t-primary mb-2">
                This permanently deletes your Winter Arc account and associated
                app data.
              </p>
              <ul className="text-sm t-secondary list-disc pl-5 space-y-1">
                <li>All challenges, calendar events, habits, and logs</li>
                <li>Training, study, Hifz, books, and reading history</li>
                <li>Journal entries and reviews</li>
                <li>Your Google Calendar connection (events on Google are not touched)</li>
              </ul>
              <p className="text-sm t-secondary mt-2">
                This cannot be undone. Export your data first if you want a copy.
              </p>
            </div>
            <label className="text-sm t-primary" htmlFor="delete-confirm">
              Type{" "}
              <code className="rounded bg-black/10 dark:bg-white/10 px-1.5 py-0.5 text-[13px] font-mono">
                {DELETE_CONFIRMATION_PHRASE}
              </code>{" "}
              to confirm.
            </label>
            <input
              id="delete-confirm"
              type="text"
              className="input"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={DELETE_CONFIRMATION_PHRASE}
              autoComplete="off"
              aria-describedby="delete-confirm-hint"
            />
            <p id="delete-confirm-hint" className="text-xs t-faint">
              The confirmation must match exactly.
            </p>
            {deleteError && (
              <div>
                <ErrorState message={deleteError} onRetry={() => setDeleteStep("idle")} />
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setDeleteStep("idle");
                  setDeleteError(null);
                  setConfirmText("");
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn-danger"
                disabled={deleteBusy || confirmText !== DELETE_CONFIRMATION_PHRASE}
                aria-busy={deleteBusy}
              >
                {deleteBusy ? "Deleting…" : "Permanently delete my account"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
