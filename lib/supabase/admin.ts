import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * V4.8.1 (Complete Account Deletion): privileged Supabase admin client.
 *
 * This module exists for ONE purpose: deleting the authenticated user's
 * Supabase Auth identity (auth.users) during account deletion. It must NOT
 * be used for ordinary application operations — every other server path
 * uses the session-based RLS-enforced client from lib/supabase/server.ts.
 *
 * Credential protection:
 * - The key comes from SUPABASE_SERVICE_ROLE_KEY (server env only). It is
 *   NEVER a NEXT_PUBLIC_ variable, so it cannot reach the client bundle.
 * - `import "server-only"` makes any client-side import a build error.
 * - The key is never returned in an API response, never written to
 *   IndexedDB/localStorage, and never logged.
 * - The client is configured with persistSession/autoRefreshToken disabled
 *   so it never persists or refreshes a browser session.
 *
 * Deployment requirement: SUPABASE_SERVICE_ROLE_KEY must be set in the
 * server environment (see .env.example). The account-deletion route fails
 * fast with a safe generic error when it is missing — before deleting any
 * application data.
 */

/** Create the privileged admin client. Throws when misconfigured. */
export function createAdminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    // Message names the missing configuration for server logs only; the
    // route returns a safe generic 500 to the client.
    throw new Error(
      "createAdminClient: SUPABASE_SERVICE_ROLE_KEY is not configured"
    );
  }
  return createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

/**
 * Permanently delete a Supabase Auth user (auth.users).
 *
 * @param admin  Client from createAdminClient(). Accepts the client as a
 *               parameter (rather than creating it) so the deletion logic
 *               is unit-testable with a mock admin client.
 * @param userId The authenticated user's id. Callers MUST pass the SESSION
 *               user id — never a client-provided value. The route enforces
 *               this; this function additionally rejects empty values.
 * @throws Error when the Auth deletion fails. The caller (route) converts
 *         this to a safe generic 500 and never forwards details.
 */
export async function deleteAuthUser(
  admin: SupabaseClient,
  userId: string
): Promise<void> {
  if (!userId || typeof userId !== "string") {
    throw new Error("deleteAuthUser: userId is required");
  }
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) {
    throw new Error(`deleteAuthUser: Auth deletion failed for user`);
  }
}
