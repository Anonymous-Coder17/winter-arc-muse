// V4.3.3: Google Calendar configuration tests.
//
// Covers lib/google/server.ts config gating and the config-related docs:
//  - isGoogleConfigured() predicate logic (server-only module; imported the
//    same way google_sync.test.mjs imports lib modules — the next/server stub
//    is registered first, server-only is handled by tests/hooks.mjs).
//  - GOOGLE_NOT_CONFIGURED_MESSAGE is secret-free and never names a variable.
//  - googleNotConfiguredResponse() returns the generic 500 JSON body.
//  - getRedirectUri() falls back to the request origin when unconfigured.
//  - Static: all four /api/google routes call the config gate.
//  - Static: docs/google-calendar-setup.md + .env.example document the real
//    env var names with SERVER-ONLY warnings and state E2E was not performed.
//
// Deterministic: no network, no real credentials. Env mutations are saved
// and restored within each test.
// Run with:
//   TZ='Asia/Kolkata' node --test --import ./tests/hooks.mjs tests/google_config.test.mjs
import { register } from "node:module";

// next/server is not resolvable under plain node; stub it the same way
// tests/google_sync.test.mjs does (before the dynamic import below).
register(new URL("./resolve-next-server-stub.mjs", import.meta.url).href);

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Dynamic: the next/server stub above must be registered first.
const {
  getRedirectUri,
  GOOGLE_NOT_CONFIGURED_MESSAGE,
  googleNotConfiguredResponse,
  isGoogleConfigured,
} = await import("../lib/google/server");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const REQUIRED_VARS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_TOKEN_ENCRYPTION_KEY",
];
const OPTIONAL_VARS = ["GOOGLE_REDIRECT_URI"];

/** Run fn with the given env overrides; restore the original env after. */
function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const k of Object.keys(overrides)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ---------------------------------------------------------------------------
// isGoogleConfigured() predicate logic.
// ---------------------------------------------------------------------------

test("isGoogleConfigured is true only when all three required vars are non-empty", () => {
  const full = {
    GOOGLE_CLIENT_ID: "id",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_TOKEN_ENCRYPTION_KEY: "k".repeat(64),
  };
  withEnv(full, () => {
    assert.equal(isGoogleConfigured(), true, "all vars present");
  });
  for (const missing of REQUIRED_VARS) {
    withEnv({ ...full, [missing]: undefined }, () => {
      assert.equal(
        isGoogleConfigured(),
        false,
        `must be false when ${missing} is unset`
      );
    });
    withEnv({ ...full, [missing]: "   " }, () => {
      assert.equal(
        isGoogleConfigured(),
        false,
        `must be false when ${missing} is blank`
      );
    });
  }
  withEnv(
    {
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
      GOOGLE_TOKEN_ENCRYPTION_KEY: undefined,
    },
    () => {
      assert.equal(isGoogleConfigured(), false, "all missing -> false");
    }
  );
});

test("isGoogleConfigured ignores the optional redirect URI", () => {
  const full = {
    GOOGLE_CLIENT_ID: "id",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_TOKEN_ENCRYPTION_KEY: "k".repeat(64),
  };
  withEnv({ ...full, GOOGLE_REDIRECT_URI: undefined }, () => {
    assert.equal(isGoogleConfigured(), true, "redirect URI is optional");
  });
});

test("isGoogleConfigured trims whitespace-only values", () => {
  withEnv(
    {
      GOOGLE_CLIENT_ID: "  id  ",
      GOOGLE_CLIENT_SECRET: "secret",
      GOOGLE_TOKEN_ENCRYPTION_KEY: "key",
    },
    () => {
      assert.equal(isGoogleConfigured(), true, "padded values still count");
    }
  );
});

// ---------------------------------------------------------------------------
// The not-configured message: generic, secret-free, never names a variable.
// ---------------------------------------------------------------------------

test("GOOGLE_NOT_CONFIGURED_MESSAGE is the exact expected copy", () => {
  assert.equal(
    GOOGLE_NOT_CONFIGURED_MESSAGE,
    "Google Calendar integration is not configured on this server."
  );
});

test("not-configured message never names a variable and carries no secret", () => {
  const probeSecrets = ["s3cr3t-probe-value", "probe-encryption-key"];
  withEnv(
    {
      GOOGLE_CLIENT_ID: probeSecrets[0],
      GOOGLE_CLIENT_SECRET: probeSecrets[1],
      GOOGLE_TOKEN_ENCRYPTION_KEY: "kk".repeat(32),
    },
    () => {
      const msg = GOOGLE_NOT_CONFIGURED_MESSAGE;
      for (const name of [...REQUIRED_VARS, ...OPTIONAL_VARS]) {
        assert.ok(
          !msg.includes(name),
          `message must never name the missing variable (${name})`
        );
      }
      for (const secret of probeSecrets) {
        assert.ok(
          !msg.includes(secret),
          "message must never carry a secret value"
        );
      }
      assert.ok(
        !/NEXT_PUBLIC/i.test(msg),
        "message must not mention NEXT_PUBLIC"
      );
    }
  );
});

test("googleNotConfiguredResponse returns a 500 JSON body with only the message", async () => {
  const res = googleNotConfiguredResponse();
  assert.equal(res.status, 500);
  assert.ok(
    (res.headers.get("content-type") ?? "").includes("application/json"),
    "response must be JSON"
  );
  const body = await res.json();
  assert.deepEqual(body, { error: GOOGLE_NOT_CONFIGURED_MESSAGE });
});

// ---------------------------------------------------------------------------
// getRedirectUri: configured value wins; otherwise request origin.
// ---------------------------------------------------------------------------

test("getRedirectUri uses GOOGLE_REDIRECT_URI when set, else request origin", () => {
  const req = new Request("https://app.example.com/x");
  withEnv({ GOOGLE_REDIRECT_URI: "https://other.example.com/cb" }, () => {
    assert.equal(
      getRedirectUri(req),
      "https://other.example.com/cb",
      "explicit redirect URI wins"
    );
  });
  withEnv({ GOOGLE_REDIRECT_URI: undefined }, () => {
    assert.equal(
      getRedirectUri(req),
      "https://app.example.com/api/google/oauth/callback",
      "falls back to <origin>/api/google/oauth/callback"
    );
  });
});

// ---------------------------------------------------------------------------
// Static: every /api/google route has an early config gate.
// ---------------------------------------------------------------------------

const ROUTES = {
  "oauth/start": "app/api/google/oauth/start/route.ts",
  "oauth/callback": "app/api/google/oauth/callback/route.ts",
  sync: "app/api/google/sync/route.ts",
  calendars: "app/api/google/calendars/route.ts",
};

test("all four google routes import the config gate from lib/google/server", () => {
  for (const [name, rel] of Object.entries(ROUTES)) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    assert.ok(
      src.includes("isGoogleConfigured"),
      `${name} must import isGoogleConfigured`
    );
    assert.ok(
      src.match(/if\s*\(\s*!isGoogleConfigured\(\)/),
      `${name} must call isGoogleConfigured() in an early guard`
    );
  }
});

test("routes return the generic config response or a config redirect", () => {
  const start = readFileSync(join(ROOT, ROUTES["oauth/start"]), "utf8");
  const sync = readFileSync(join(ROOT, ROUTES["sync"]), "utf8");
  const calendars = readFileSync(join(ROOT, ROUTES["calendars"]), "utf8");
  const callback = readFileSync(join(ROOT, ROUTES["oauth/callback"]), "utf8");
  for (const [name, src] of [
    ["oauth/start", start],
    ["sync", sync],
    ["calendars", calendars],
  ]) {
    assert.ok(
      src.includes("return googleNotConfiguredResponse();"),
      `${name} must return googleNotConfiguredResponse()`
    );
  }
  assert.ok(
    callback.includes("?gcal=error&reason=config"),
    "oauth/callback must redirect with reason=config (never env details)"
  );
});

// ---------------------------------------------------------------------------
// Static: docs + .env.example document the real var names.
// ---------------------------------------------------------------------------

test("docs/google-calendar-setup.md documents the env vars with SERVER-ONLY warnings", () => {
  const doc = readFileSync(join(ROOT, "docs/google-calendar-setup.md"), "utf8");
  for (const name of [...REQUIRED_VARS, ...OPTIONAL_VARS]) {
    assert.ok(
      doc.includes(name),
      `setup doc must document ${name}`
    );
  }
  assert.ok(/SERVER-ONLY/.test(doc), "doc must carry SERVER-ONLY warnings");
  assert.ok(
    /never sent to[\s\S]{0,20}the browser/i.test(doc),
    "doc must state secrets never reach the browser"
  );
  assert.ok(
    doc.includes("not configured on this server"),
    "doc must document the missing-config message"
  );
  assert.ok(
    /NOT been performed|not.*performed|has never run/i.test(doc),
    "doc must explicitly state real E2E was not performed"
  );
});

test(".env.example documents the same var names without real values", () => {
  const env = readFileSync(join(ROOT, ".env.example"), "utf8");
  for (const name of [...REQUIRED_VARS, ...OPTIONAL_VARS]) {
    assert.ok(env.includes(`${name}=`), `.env.example must document ${name}`);
  }
  for (const name of REQUIRED_VARS) {
    const line = env
      .split("\n")
      .find((l) => l.startsWith(`${name}=`));
    assert.ok(line !== undefined, `${name} must have a line`);
    assert.ok(
      !/sk-|AIza|ya29/.test(line),
      `${name} line must not contain a real-looking secret`
    );
  }
});

test("server.ts itself never hard-codes a credential value", () => {
  const src = readFileSync(join(ROOT, "lib/google/server.ts"), "utf8");
  for (const name of [...REQUIRED_VARS, ...OPTIONAL_VARS]) {
    // Only process.env lookups, never a literal value on the right-hand side.
    const literal = new RegExp(`["']${name}["']\\s*[:=]\\s*["']\\w+["']`);
    assert.ok(
      !literal.test(src),
      `server.ts must not hard-code a value for ${name}`
    );
  }
});
