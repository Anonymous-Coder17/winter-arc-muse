import { createBrowserClient } from "@supabase/ssr";

function env(name: string): string {
  // Build-time safe: pages prerender without env vars; real calls happen at
  // runtime once the user configures .env.local. Missing keys surface as a
  // clear error only when auth/data is actually used.
  return process.env[name] ?? "";
}

/** Supabase client for browser components ("use client"). */
export function createClient() {
  return createBrowserClient(
    env("NEXT_PUBLIC_SUPABASE_URL"),
    env("NEXT_PUBLIC_SUPABASE_ANON_KEY")
  );
}
