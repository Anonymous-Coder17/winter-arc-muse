import { createBrowserClient } from "@supabase/ssr";
import { getPublicSupabaseEnvOrThrow } from "@/lib/supabase/env";

/** Supabase client for browser components ("use client"). */
export function createClient() {
  const { url, anonKey } = getPublicSupabaseEnvOrThrow(
    "Supabase browser client misconfigured"
  );
  return createBrowserClient(url, anonKey);
}
