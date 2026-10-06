export type PublicSupabaseEnv = {
  url: string;
  anonKey: string;
};

const BUILD_FALLBACK_ENV: PublicSupabaseEnv = {
  url: "https://placeholder.supabase.co",
  anonKey: "placeholder-anon-key",
};

function isProductionBuildPhase(): boolean {
  return process.env.NEXT_PHASE === "phase-production-build";
}

function parseSupabaseUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function getPublicSupabaseEnvError(): string | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();

  if (!url) {
    return "Missing NEXT_PUBLIC_SUPABASE_URL";
  }
  if (!anonKey) {
    return "Missing NEXT_PUBLIC_SUPABASE_ANON_KEY";
  }
  if (!parseSupabaseUrl(url)) {
    return "Invalid NEXT_PUBLIC_SUPABASE_URL";
  }
  return null;
}

export function getPublicSupabaseEnvOrThrow(
  context: string,
  options?: { allowBuildFallback?: boolean }
): PublicSupabaseEnv {
  const error = getPublicSupabaseEnvError();
  if (error) {
    if (options?.allowBuildFallback && isProductionBuildPhase()) {
      return BUILD_FALLBACK_ENV;
    }
    throw new Error(`${context}: ${error}. Check Vercel/Supabase environment variables.`);
  }
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!.trim(),
  };
}
