/**
 * V4.3.1 calendar provider registry.
 *
 * The app asks for a provider by name and gets the port (`CalendarProvider`);
 * the concrete adapter is chosen here. Future providers (Outlook, iCloud,
 * …) plug in as new entries — callers never touch the constructors.
 *
 * Client-safe: re-exports only the port types and the Google adapter.
 * Never `lib/google/tokenVault` or any server-only module.
 */
import { ProviderError, type CalendarProvider } from "./types";
import { GoogleCalendarProvider } from "./google";

export type { CalendarProvider } from "./types";
export type {
  GoogleCalendarInfo,
  GoogleConnectionState,
  GoogleConnectionStatus,
  GoogleSyncCalendarResult,
  GoogleSyncConflict,
  GoogleSyncResult,
  GoogleSyncStatus,
} from "./types";
export {
  ProviderError,
  ProviderNotSignedInError,
  ProviderOfflineError,
  ProviderRevokedError,
} from "./types";

export type CalendarProviderName = "google";

/**
 * Factory: return the adapter for `name`.
 *
 * The no-arg Google adapter has no user id wired, so its cache writes are
 * skipped until the app passes a `getUserId` resolver. For a wired instance,
 * construct `new GoogleCalendarProvider(fetch, getUserId)` directly.
 */
export function getCalendarProvider(name: CalendarProviderName): CalendarProvider {
  switch (name) {
    case "google":
      return new GoogleCalendarProvider();
    default:
      // Unreachable with the typed name, but fail loudly at runtime anyway.
      throw new ProviderError(
        "unknown_provider",
        `Unknown calendar provider: ${String(name)}`
      );
  }
}
