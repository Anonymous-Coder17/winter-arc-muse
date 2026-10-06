import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { CookieMethodsServer } from "@supabase/ssr";
import { getPublicSupabaseEnvOrThrow } from "@/lib/supabase/env";

/** Supabase client for Server Components / Route Handlers / Server Actions. */
export async function createClient() {
  const { url, anonKey } = getPublicSupabaseEnvOrThrow(
    "Supabase server client misconfigured",
    { allowBuildFallback: true }
  );
  const cookieStore = await cookies();
  const cookieMethods: CookieMethodsServer = {
    getAll: () => cookieStore.getAll(),
    setAll: (cookiesToSet) => {
      try {
        cookiesToSet.forEach(({ name, value, options }) =>
          cookieStore.set(name, value, options)
        );
      } catch {
        // Called from a Server Component where writes are ignored.
      }
    },
  };
  return createServerClient(url, anonKey, { cookies: cookieMethods });
}
