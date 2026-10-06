/**
 * V4.2 session helpers. The sync engine needs one stable browser client for
 * `onAuthStateChange`; per-operation code keeps using `createClient()` from
 * `@/lib/supabase/client` unchanged.
 *
 * IMPORTANT: offline code paths use `getSession()` (local cookie read), never
 * `getUser()` (network round-trip), so the offline experience keeps working
 * with no connectivity.
 */
import { createBrowserClient } from "@supabase/ssr";
import { getPublicSupabaseEnvOrThrow } from "@/lib/supabase/env";

type BrowserClient = ReturnType<typeof createBrowserClient>;

let shared: BrowserClient | null = null;

/** Stable per-tab browser client for auth-state subscription. Client-only. */
export function browserClient(): BrowserClient {
  if (!shared) {
    const { url, anonKey } = getPublicSupabaseEnvOrThrow(
      "Supabase sync session client misconfigured"
    );
    shared = createBrowserClient(url, anonKey);
  }
  return shared;
}

/**
 * Resolve the current user id from the locally stored session.
 * Returns null when there is no session or it cannot be refreshed.
 * May touch the network ONLY to refresh an expiring session.
 */
export async function getSessionUserId(): Promise<string | null> {
  try {
    const supabase = browserClient();
    const { data, error } = await supabase.auth.getSession();
    if (error) return null;
    const session = data.session;
    if (!session?.user) return null;
    const expiresAtMs = (session.expires_at ?? 0) * 1000;
    if (expiresAtMs && expiresAtMs < Date.now() + 30_000) {
      // Session expiring/expired: try a refresh (needs network; fails offline).
      const { data: refreshed, error: refreshError } =
        await supabase.auth.refreshSession();
      if (refreshError || !refreshed.session?.user) return null;
      return refreshed.session.user.id;
    }
    return session.user.id;
  } catch {
    return null;
  }
}
