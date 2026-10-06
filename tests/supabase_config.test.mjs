import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getPublicSupabaseEnvError,
  getPublicSupabaseEnvOrThrow,
} from "@/lib/supabase/env";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function withPublicEnv(next, env = {}) {
  const oldUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const oldKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if ("NEXT_PUBLIC_SUPABASE_URL" in env) {
    process.env.NEXT_PUBLIC_SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
  } else {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  }
  if ("NEXT_PUBLIC_SUPABASE_ANON_KEY" in env) {
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  } else {
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  }
  try {
    next();
  } finally {
    if (oldUrl !== undefined) process.env.NEXT_PUBLIC_SUPABASE_URL = oldUrl;
    else delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (oldKey !== undefined) process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = oldKey;
    else delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  }
}

test("public supabase env validation reports missing/invalid values", () => {
  withPublicEnv(() => {
    assert.equal(getPublicSupabaseEnvError(), "Missing NEXT_PUBLIC_SUPABASE_URL");
  });
  withPublicEnv(
    () => {
      assert.equal(getPublicSupabaseEnvError(), "Missing NEXT_PUBLIC_SUPABASE_ANON_KEY");
    },
    { NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co" }
  );
  withPublicEnv(
    () => {
      assert.equal(getPublicSupabaseEnvError(), "Invalid NEXT_PUBLIC_SUPABASE_URL");
    },
    {
      NEXT_PUBLIC_SUPABASE_URL: "notaurl",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
    }
  );
});

test("public supabase env validation returns trimmed values when configured", () => {
  withPublicEnv(
    () => {
      const cfg = getPublicSupabaseEnvOrThrow("test");
      assert.equal(cfg.url, "https://example.supabase.co");
      assert.equal(cfg.anonKey, "anon-key");
      assert.equal(getPublicSupabaseEnvError(), null);
    },
    {
      NEXT_PUBLIC_SUPABASE_URL: "  https://example.supabase.co ",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: " anon-key ",
    }
  );
});

test("server client env can use build-phase fallback only during next build", () => {
  const oldPhase = process.env.NEXT_PHASE;
  try {
    process.env.NEXT_PHASE = "phase-production-build";
    withPublicEnv(() => {
      const cfg = getPublicSupabaseEnvOrThrow("test", { allowBuildFallback: true });
      assert.equal(cfg.url, "https://placeholder.supabase.co");
      assert.equal(cfg.anonKey, "placeholder-anon-key");
    });
  } finally {
    if (oldPhase !== undefined) process.env.NEXT_PHASE = oldPhase;
    else delete process.env.NEXT_PHASE;
  }
});

test("supabase runtime code now fails fast on misconfiguration", () => {
  const browser = readFileSync(join(ROOT, "lib/supabase/client.ts"), "utf8");
  const server = readFileSync(join(ROOT, "lib/supabase/server.ts"), "utf8");
  const session = readFileSync(join(ROOT, "lib/sync/session.ts"), "utf8");
  const middleware = readFileSync(join(ROOT, "middleware.ts"), "utf8");

  assert.match(browser, /getPublicSupabaseEnvOrThrow/);
  assert.match(server, /getPublicSupabaseEnvOrThrow/);
  assert.match(session, /getPublicSupabaseEnvOrThrow/);
  assert.match(middleware, /getPublicSupabaseEnvError/);
  assert.match(middleware, /NextResponse\.json/);
  assert.doesNotMatch(middleware, /No Supabase keys configured yet/);
});
