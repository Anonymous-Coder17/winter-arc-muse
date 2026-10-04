// V4.3.1: Google Calendar integration foundation — unit + safety tests.
//
// Deterministic: no network, no real Google credentials. Covers:
//  - lib/google/oauthCore.ts        (PKCE, auth URL, state validation)
//  - lib/google/tokenVault.ts       (AES-256-GCM roundtrip + failure modes)
//  - lib/calendar-providers/google.ts (provider behavior with injected fetch)
//  - lib/calendar-providers/googleMeta.ts (IndexedDB metadata cache, credential-key rejection)
//  - Import-graph security          (secrets can never reach client bundles)
//  - Static route safety            (state validation, disconnect scope, no NEXT_PUBLIC, no token logging)
//
// Run with:
//   TZ='Asia/Kolkata' node --test --import ./tests/hooks.mjs tests/google.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import "fake-indexeddb/auto"; // global indexedDB, like the sync tests

import {
  GOOGLE_AUTH_URL,
  GOOGLE_CALENDAR_SCOPES,
  buildAuthUrl,
  codeChallenge,
  newCodeVerifier,
  newOAuthState,
  validateState,
} from "../lib/google/oauthCore";
import { decryptToken, encryptToken } from "../lib/google/tokenVault";
import { GoogleCalendarProvider } from "../lib/calendar-providers/google";
import {
  ProviderError,
  ProviderNotSignedInError,
  ProviderOfflineError,
  ProviderRevokedError,
} from "../lib/calendar-providers/types";
import {
  clearAllMetaCache,
  clearMetaCache,
  gcalMetaKey,
  metaCacheAvailable,
  openGcalMeta,
  readMetaCache,
  writeMetaCache,
} from "../lib/calendar-providers/googleMeta";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// oauthCore: PKCE
// ---------------------------------------------------------------------------

test("oauthCore: codeChallenge matches the RFC 7636 Appendix B test vector", () => {
  // https://datatracker.ietf.org/doc/html/rfc7636#appendix-B
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  assert.equal(
    codeChallenge(verifier),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
  );
});

test("oauthCore: verifier/challenge pair is well-formed (base64url S256)", () => {
  const verifier = newCodeVerifier();
  assert.match(verifier, /^[A-Za-z0-9\-_]{43}$/, "32 random bytes, base64url");
  const challenge = codeChallenge(verifier);
  assert.match(challenge, /^[A-Za-z0-9\-_]{43}$/, "SHA-256 digest, base64url");
  assert.notEqual(challenge, verifier);
  const again = newCodeVerifier();
  assert.notEqual(again, verifier, "verifiers are random");
  assert.equal(newOAuthState().length, 64, "state is 32 bytes as hex");
});

test("oauthCore: GOOGLE_CALENDAR_SCOPES is the read-only foundation scope", () => {
  assert.ok(
    GOOGLE_CALENDAR_SCOPES.includes(
      "https://www.googleapis.com/auth/calendar.readonly"
    ),
    "calendar.readonly must be requested"
  );
});

test("oauthCore: buildAuthUrl carries every required OAuth2/PKCE parameter", () => {
  const state = "state-abc-123";
  const challenge = "challenge-xyz";
  const url = new URL(
    buildAuthUrl({
      clientId: "test-client-id",
      redirectUri: "https://app.example.com/api/google/oauth/callback",
      state,
      challenge,
      scopes: GOOGLE_CALENDAR_SCOPES,
    })
  );
  assert.equal(url.origin + url.pathname, GOOGLE_AUTH_URL);
  const p = url.searchParams;
  assert.equal(p.get("response_type"), "code");
  assert.equal(p.get("access_type"), "offline", "requests a refresh token");
  assert.equal(p.get("prompt"), "consent", "forces re-consent so offline access is granted");
  assert.equal(p.get("code_challenge_method"), "S256");
  assert.equal(p.get("code_challenge"), challenge);
  assert.equal(p.get("state"), state);
  assert.equal(p.get("client_id"), "test-client-id");
  assert.equal(
    p.get("redirect_uri"),
    "https://app.example.com/api/google/oauth/callback"
  );
  assert.ok(
    p.get("scope")?.includes("https://www.googleapis.com/auth/calendar.readonly"),
    "calendar.readonly scope present"
  );
});

test("oauthCore: validateState accepts exact matches, rejects mismatch and empty", () => {
  assert.equal(validateState("abc123", "abc123"), true);
  assert.equal(validateState("abc123", "abc124"), false, "mismatch rejected");
  assert.equal(validateState("abc123", "abc1234"), false, "length mismatch rejected");
  assert.equal(validateState("", "abc123"), false, "empty expected rejected");
  assert.equal(validateState("abc123", ""), false, "empty actual rejected");
  assert.equal(validateState("", ""), false, "both empty rejected");
});

// ---------------------------------------------------------------------------
// tokenVault
// ---------------------------------------------------------------------------

const KEY_ENV = "GOOGLE_TOKEN_ENCRYPTION_KEY";
const HEX_KEY = randomBytes(32).toString("hex"); // 64-char hex
const B64_KEY = randomBytes(32).toString("base64"); // 44-char base64

function withKey(key, fn) {
  const prev = process.env[KEY_ENV];
  process.env[KEY_ENV] = key;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = prev;
  }
}

test("tokenVault: encrypt/decrypt roundtrip with a hex key", () => {
  withKey(HEX_KEY, () => {
    const plain = "ya29.test-refresh-token-material";
    const blob = encryptToken(plain);
    assert.ok(blob.startsWith("v1:"), "versioned blob");
    assert.equal(blob.split(":").length, 4, "v1:iv:ciphertext:tag");
    assert.equal(decryptToken(blob), plain);
    // Random IV: the same plaintext encrypts to a different blob each time.
    assert.notEqual(encryptToken(plain), blob);
  });
});

test("tokenVault: encrypt/decrypt roundtrip with a base64 key", () => {
  withKey(B64_KEY, () => {
    const plain = "1//0g-test-oauth-refresh-token";
    assert.equal(decryptToken(encryptToken(plain)), plain);
  });
});

test("tokenVault: wrong key yields ONLY the generic error (no key/token material)", () => {
  const plain = "super-secret-token-value";
  const blob = withKey(HEX_KEY, () => encryptToken(plain));
  const otherKey = randomBytes(32).toString("hex");
  const err = catchSync(() => withKey(otherKey, () => decryptToken(blob)));
  assert.equal(err.message, "Token decryption failed.");
  assert.ok(!err.message.includes(plain), "plaintext must not leak");
  assert.ok(!err.message.includes(HEX_KEY), "key material must not leak");
  assert.ok(!err.message.includes(blob), "blob must not leak");
});

test("tokenVault: tampered blob yields ONLY the generic error", () => {
  const plain = "tamper-target-token";
  const blob = withKey(HEX_KEY, () => encryptToken(plain));
  const parts = blob.split(":");
  // Flip one character of the ciphertext segment (keep it valid base64).
  const ct = parts[2];
  parts[2] = (ct[0] === "A" ? "B" : "A") + ct.slice(1);
  const tampered = parts.join(":");
  const err = catchSync(() => withKey(HEX_KEY, () => decryptToken(tampered)));
  assert.equal(err.message, "Token decryption failed.");
  assert.ok(!err.message.includes(plain), "plaintext must not leak");
});

test("tokenVault: malformed blobs yield ONLY the generic error", () => {
  const cases = ["", "v1:not-enough-parts", "v2:AAAA:BBBB:CCCC", "garbage"];
  for (const bad of cases) {
    const err = catchSync(() => withKey(HEX_KEY, () => decryptToken(bad)));
    assert.equal(err.message, "Token decryption failed.", `for ${JSON.stringify(bad)}`);
  }
});

test("tokenVault: missing key throws a clear config error (never generic)", () => {
  const prev = process.env[KEY_ENV];
  delete process.env[KEY_ENV];
  try {
    const enc = catchSync(() => encryptToken("x"));
    assert.match(enc.message, /not configured/);
    assert.ok(enc.message.includes(KEY_ENV), "names the env var");
    const dec = catchSync(() => decryptToken("v1:a:b:c"));
    assert.match(dec.message, /not configured/);
  } finally {
    if (prev === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = prev;
  }
});

test("tokenVault: invalid key throws a clear config error without echoing the value", () => {
  const bad = "too-short";
  const enc = catchSync(() => withKey(bad, () => encryptToken("x")));
  assert.match(enc.message, /invalid/);
  assert.ok(!enc.message.includes(bad), "raw key value must not be echoed");
  const dec = catchSync(() => withKey(bad, () => decryptToken("v1:a:b:c")));
  assert.match(dec.message, /invalid/);
});

// ---------------------------------------------------------------------------
// Provider (injected mock fetch; no network)
// ---------------------------------------------------------------------------

function okJson(payload, extra = {}) {
  return {
    ok: true,
    status: 200,
    redirected: false,
    url: "https://app.example.com/api/google/calendars",
    json: async () => payload,
    ...extra,
  };
}

function status401(payload) {
  return {
    ok: false,
    status: 401,
    redirected: false,
    url: "https://app.example.com/api/google/calendars",
    clone: () => ({ json: async () => payload }),
    json: async () => payload,
  };
}

const CONNECTED_STATE = {
  status: "connected",
  email: "user@example.com",
  lastCheckedAt: "2026-10-04T00:00:00.000Z",
  calendars: [
    { id: "cal-1", summary: "Work", primary: true, timeZone: "Asia/Kolkata", selected: true },
  ],
};

async function freshMeta() {
  await clearAllMetaCache();
}

// assert.throws/assert.rejects return undefined in this Node version, so the
// tests below capture errors explicitly instead.
function catchSync(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new assert.AssertionError({ message: "expected function to throw" });
}

async function catchAsync(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new assert.AssertionError({ message: "expected function to reject" });
}

function setOffline(on) {
  // Node exposes `navigator` as a getter-only global, so toggle it via
  // defineProperty and restore the original descriptor afterwards.
  if (on) {
    savedNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: false },
      configurable: true,
      writable: true,
    });
  } else if (savedNavigatorDesc) {
    Object.defineProperty(globalThis, "navigator", savedNavigatorDesc);
    savedNavigatorDesc = undefined;
  }
}

let savedNavigatorDesc;

test("provider: getStatus when disconnected returns {connected:false} state", async () => {
  await freshMeta();
  const provider = new GoogleCalendarProvider(async () => okJson({ connected: false }));
  const state = await provider.getStatus();
  assert.equal(state.status, "disconnected");
  assert.equal(state.email, null);
  assert.deepEqual(state.calendars, []);
});

test("provider: getStatus merges calendars with server selection rows", async () => {
  await freshMeta();
  const calls = [];
  const fetchFn = async (input, init) => {
    calls.push(String(input));
    if (String(input).endsWith("/selections")) {
      return okJson({ selections: [{ google_calendar_id: "cal-1", selected: false }] });
    }
    return okJson({
      connected: true,
      email: "user@example.com",
      calendars: [
        { id: "cal-1", summary: "Work", primary: true, timeZone: "Asia/Kolkata" },
        { id: "cal-2", summary: "Personal", timeZone: null },
      ],
    });
  };
  const provider = new GoogleCalendarProvider(fetchFn, () => "user-merge");
  const state = await provider.getStatus();
  assert.equal(state.status, "connected");
  assert.equal(state.email, "user@example.com");
  const byId = new Map(state.calendars.map((c) => [c.id, c]));
  assert.equal(byId.get("cal-1").selected, false, "server selection row wins");
  assert.equal(byId.get("cal-2").selected, true, "opt-out default: no row means selected");
  assert.equal(byId.get("cal-1").timeZone, "Asia/Kolkata");
  assert.ok(calls.some((u) => u.endsWith("/api/google/calendars")));
  assert.ok(calls.some((u) => u.endsWith("/api/google/selections")));
});

test("provider: 401 with {revoked:true} -> ProviderRevokedError, cache marked revoked", async () => {
  await freshMeta();
  const provider = new GoogleCalendarProvider(
    async () => status401({ revoked: true }),
    () => "user-revoked"
  );
  await writeMetaCache("user-revoked", { ...CONNECTED_STATE });
  const err = await provider.getStatus().then(
    () => { throw new Error("expected rejection"); },
    (e) => e
  );
  assert.ok(err instanceof ProviderRevokedError, `got ${err?.constructor?.name}`);
  assert.equal(err.code, "revoked");
  const cached = await readMetaCache("user-revoked");
  assert.ok(cached, "cache row exists");
  assert.equal(cached.status, "revoked", "cache honestly reflects revocation");
  assert.deepEqual(cached.calendars, CONNECTED_STATE.calendars, "last-known calendars kept");
});

test("provider: 401 without revoked flag -> ProviderNotSignedInError, cache untouched", async () => {
  await freshMeta();
  const provider = new GoogleCalendarProvider(
    async () => status401({ error: "Unauthorized" }),
    () => "user-nosess"
  );
  await writeMetaCache("user-nosess", { ...CONNECTED_STATE });
  const err = await provider.getStatus().then(
    () => { throw new Error("expected rejection"); },
    (e) => e
  );
  assert.ok(err instanceof ProviderNotSignedInError, `got ${err?.constructor?.name}`);
  assert.equal(err.code, "not_signed_in");
  const cached = await readMetaCache("user-nosess");
  assert.equal(cached?.status, "connected", "stale-check state is left alone on session loss");
});

test("provider: fetch redirect to /login -> ProviderNotSignedInError", async () => {
  await freshMeta();
  const provider = new GoogleCalendarProvider(async () =>
    okJson({}, { redirected: true, url: "https://app.example.com/login?next=%2Fsettings" })
  );
  const err = await provider.getStatus().then(
    () => { throw new Error("expected rejection"); },
    (e) => e
  );
  assert.ok(err instanceof ProviderNotSignedInError, `got ${err?.constructor?.name}`);
});

test("provider: navigator.onLine === false -> ProviderOfflineError, no fetch attempted", async () => {
  await freshMeta();
  let calls = 0;
  const provider = new GoogleCalendarProvider(async () => { calls++; return okJson({}); });
  setOffline(true);
  try {
    const err = await provider.getStatus().then(
      () => { throw new Error("expected rejection"); },
      (e) => e
    );
    assert.ok(err instanceof ProviderOfflineError, `got ${err?.constructor?.name}`);
    assert.equal(calls, 0, "offline check happens before any fetch");
  } finally {
    setOffline(false);
  }
});

test("provider: fetch TypeError -> ProviderOfflineError", async () => {
  await freshMeta();
  const provider = new GoogleCalendarProvider(async () => {
    throw new TypeError("fetch failed");
  });
  const err = await provider.getStatus().then(
    () => { throw new Error("expected rejection"); },
    (e) => e
  );
  assert.ok(err instanceof ProviderOfflineError, `got ${err?.constructor?.name}`);
});

test("provider: offline honesty — never resolves cached state as fresh", async () => {
  await freshMeta();
  await writeMetaCache("user-offline-honest", { ...CONNECTED_STATE });
  const provider = new GoogleCalendarProvider(
    async () => okJson({ connected: true }),
    () => "user-offline-honest"
  );
  setOffline(true);
  try {
    const outcome = await provider.getStatus().then(
      (s) => ({ resolved: true, state: s }),
      (e) => ({ resolved: false, error: e })
    );
    assert.equal(outcome.resolved, false, "must not resolve the cache as if it were live");
    assert.ok(outcome.error instanceof ProviderOfflineError);
  } finally {
    setOffline(false);
  }
});

test("provider: setCalendarSelected sends the correct PUT body and updates cache", async () => {
  await freshMeta();
  const calls = [];
  const fetchFn = async (input, init) => {
    calls.push({ input: String(input), init });
    return okJson({ selections: [{ google_calendar_id: "cal-1", selected: false }] });
  };
  const provider = new GoogleCalendarProvider(fetchFn, () => "user-sel");
  await writeMetaCache("user-sel", { ...CONNECTED_STATE });
  await provider.setCalendarSelected("cal-1", false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, "/api/google/selections");
  assert.equal(calls[0].init.method, "PUT");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    selections: [{ google_calendar_id: "cal-1", selected: false }],
  });
  const cached = await readMetaCache("user-sel");
  assert.equal(cached?.calendars[0].selected, false, "cache reflects the server's authoritative flag");
});

test("provider: disconnect POSTs to the disconnect route and caches disconnected", async () => {
  await freshMeta();
  const calls = [];
  const fetchFn = async (input, init) => {
    calls.push({ input: String(input), init });
    return okJson({ ok: true });
  };
  const provider = new GoogleCalendarProvider(fetchFn, () => "user-disc");
  await writeMetaCache("user-disc", { ...CONNECTED_STATE });
  await provider.disconnect();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, "/api/google/oauth/disconnect");
  assert.equal(calls[0].init.method, "POST");
  const cached = await readMetaCache("user-disc");
  assert.equal(cached?.status, "disconnected");
});

test("provider: connect() navigates to /api/google/oauth/start (no fetch)", () => {
  let assigned = null;
  globalThis.window = { location: { assign: (u) => { assigned = u; } } };
  try {
    let fetched = false;
    const provider = new GoogleCalendarProvider(async () => { fetched = true; return okJson({}); });
    provider.connect();
    assert.equal(assigned, "/api/google/oauth/start");
    assert.equal(fetched, false, "connect is a navigation, not a fetch");
  } finally {
    delete globalThis.window;
  }
});

test("provider: unknown HTTP errors surface as ProviderError with http_<status> code", async () => {
  await freshMeta();
  const provider = new GoogleCalendarProvider(async () =>
    okJson({}, { ok: false, status: 503 })
  );
  const err = await provider.getStatus().then(
    () => { throw new Error("expected rejection"); },
    (e) => e
  );
  assert.ok(err instanceof ProviderError);
  assert.equal(err.code, "http_503");
});

// ---------------------------------------------------------------------------
// googleMeta: credential-key rejection, whitelisting, isolation
// ---------------------------------------------------------------------------

const GOOD_STATE = {
  status: "connected",
  email: "user@example.com",
  lastCheckedAt: "2026-10-04T00:00:00.000Z",
  calendars: [
    { id: "cal-1", summary: "Work", primary: true, timeZone: "Asia/Kolkata", selected: true },
    { id: "cal-2", summary: "Personal", primary: false, timeZone: null, selected: false },
  ],
};

test("googleMeta: accepts and round-trips the whitelisted shape", async () => {
  await freshMeta();
  assert.equal(metaCacheAvailable(), true);
  await writeMetaCache("user-a", GOOD_STATE);
  const back = await readMetaCache("user-a");
  assert.deepEqual(back, GOOD_STATE);
});

test("googleMeta: writeMetaCache rejects top-level credential-like keys and writes nothing", async () => {
  await freshMeta();
  for (const key of ["access_token", "refresh_token", "client_secret", "accessToken", "REFRESH"]) {
    const bad = { ...GOOD_STATE, [key]: "token-material" };
    const err = await catchAsync(() => writeMetaCache("user-bad", bad));
    assert.equal(err.code, "cache_rejected_credential_key");
    assert.ok(!err.message.includes("token-material"), "credential value not echoed");
    assert.equal(await readMetaCache("user-bad"), null, "nothing was written");
  }
});

test("googleMeta: writeMetaCache rejects nested credential-like keys and writes nothing", async () => {
  await freshMeta();
  const nested = {
    ...GOOD_STATE,
    calendars: [
      {
        id: "cal-1",
        summary: "Work",
        primary: true,
        timeZone: "Asia/Kolkata",
        selected: true,
        extra: { nested: { refresh_token: "shh" } },
      },
    ],
  };
  const err = await catchAsync(() => writeMetaCache("user-nested", nested));
  assert.equal(err.code, "cache_rejected_credential_key");
  assert.equal(await readMetaCache("user-nested"), null, "nothing was written");
});

test("googleMeta: rejects non-whitelisted keys (strict shape)", async () => {
  await freshMeta();
  const err = await catchAsync(() =>
    writeMetaCache("user-shape", { ...GOOD_STATE, extraField: 1 })
  );
  assert.equal(err.code, "cache_invalid_shape");
  assert.equal(await readMetaCache("user-shape"), null);
});

test("googleMeta: per-user isolation — A's write is invisible to B", async () => {
  await freshMeta();
  await writeMetaCache("user-x", { ...GOOD_STATE, email: "x@example.com" });
  await writeMetaCache("user-y", { ...GOOD_STATE, email: "y@example.com" });
  assert.equal((await readMetaCache("user-x"))?.email, "x@example.com");
  assert.equal((await readMetaCache("user-y"))?.email, "y@example.com");
  assert.notEqual(gcalMetaKey("user-x"), gcalMetaKey("user-y"));
});

test("googleMeta: clearMetaCache drops one user, clearAllMetaCache drops everyone", async () => {
  await freshMeta();
  await writeMetaCache("user-c1", GOOD_STATE);
  await writeMetaCache("user-c2", GOOD_STATE);
  await clearMetaCache("user-c1");
  assert.equal(await readMetaCache("user-c1"), null);
  assert.ok(await readMetaCache("user-c2"), "other user untouched");
  await clearAllMetaCache();
  assert.equal(await readMetaCache("user-c2"), null);
});

test("googleMeta: corrupt rows are dropped on read, never served", async () => {
  await freshMeta();
  await writeMetaCache("user-corrupt", GOOD_STATE);
  // Tamper the row directly at the IndexedDB level (bypasses writeMetaCache).
  const db = await openGcalMeta();
  try {
    await db.put("meta", {
      key: gcalMetaKey("user-corrupt"),
      state: { status: "not-a-real-status", email: 42 },
      updatedAt: new Date().toISOString(),
    });
  } finally {
    db.close();
  }
  assert.equal(await readMetaCache("user-corrupt"), null, "corrupt row not served");
  assert.equal(await readMetaCache("user-corrupt"), null, "corrupt row dropped, stays gone");
});

// ---------------------------------------------------------------------------
// Import-graph security: secrets can never reach client bundles
// ---------------------------------------------------------------------------

function walkSource(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      walkSource(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function importSpecifiers(src) {
  const specs = [];
  for (const m of src.matchAll(/\bfrom\s+["']([^"']+)["']/g)) specs.push(m[1]);
  for (const m of src.matchAll(/\bimport\s+["']([^"']+)["']/g)) specs.push(m[1]);
  for (const m of src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) specs.push(m[1]);
  return specs;
}

function normaliseSpec(spec) {
  return spec.replace(/^@\//, "").replace(/\.tsx?$/, "");
}

function isTokenVaultSpec(spec) {
  return /(^|\/)tokenVault$/.test(normaliseSpec(spec));
}

function isServerOnlySpec(spec) {
  return normaliseSpec(spec) === "server-only" || /\/server-only$/.test(normaliseSpec(spec));
}

function allSourceFiles() {
  return [
    ...walkSource(join(ROOT, "app")),
    ...walkSource(join(ROOT, "lib")),
    ...walkSource(join(ROOT, "components")),
  ];
}

function isTokenVaultImporter(relPath) {
  return relPath.startsWith("app/api/google/") || relPath.startsWith("lib/google/");
}

test("security: no client-reachable file imports tokenVault or server-only", () => {
  const monitored = [
    "lib/calendar-providers/",
    "components/",
    "app/(app)/",
  ];
  const violations = [];
  for (const file of allSourceFiles()) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    if (!monitored.some((prefix) => rel.startsWith(prefix))) continue;
    const specs = importSpecifiers(readFileSync(file, "utf8"));
    for (const spec of specs) {
      if (isTokenVaultSpec(spec)) violations.push(`${rel} imports tokenVault via ${spec}`);
      if (isServerOnlySpec(spec)) violations.push(`${rel} imports server-only via ${spec}`);
    }
  }
  assert.deepEqual(violations, [], "client-reachable files must never import secrets");
});

test("security: tokenVault is imported only from app/api/google/ or lib/google/", () => {
  const violations = [];
  for (const file of allSourceFiles()) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    const specs = importSpecifiers(readFileSync(file, "utf8"));
    const bad = specs.filter(isTokenVaultSpec);
    if (bad.length > 0 && !isTokenVaultImporter(rel)) {
      violations.push(`${rel} imports tokenVault via ${bad.join(", ")}`);
    }
  }
  assert.deepEqual(violations, [], "tokenVault importers must all be server-side");
  // Sanity: the check above must have real signal — at least one server-side
  // importer exists.
  const importers = allSourceFiles().filter((file) =>
    importSpecifiers(readFileSync(file, "utf8")).some(isTokenVaultSpec)
  );
  assert.ok(importers.length >= 2, "expected server-side tokenVault importers to exist");
});

// ---------------------------------------------------------------------------
// Static route safety
// ---------------------------------------------------------------------------

function readSource(...parts) {
  return readFileSync(join(ROOT, ...parts), "utf8");
}

test("safety: OAuth callback route consumes the server-side transaction and validates state", () => {
  // V4.3.1.1: the old cookie-carried state scheme is gone. The callback
  // consumes the server-side transaction row (single-use; deleted on
  // consume) and validates the returned state against the transaction's
  // stored state with the timing-safe comparator. The browser cookie holds
  // only the random transaction id.
  const src = readSource("app/api/google/oauth/callback/route.ts");
  assert.ok(
    /consumeOAuthTransaction\(\s*supabase\s*,\s*user\.id\s*,\s*txnId\s*\)/.test(src),
    "callback must consume the server-side OAuth transaction for the session user"
  );
  assert.ok(
    /validateState\(\s*txn\.state\s*,\s*returnedState\s*\)/.test(src),
    "callback must compare the returned state against the transaction state"
  );
  for (const legacy of [
    "readOAuthCookie",
    "cookie.state",
    "cookie.verifier",
    "cookie.userId",
  ]) {
    assert.ok(
      !src.includes(legacy),
      `callback must not use the old cookie-carried scheme (${legacy})`
    );
  }
});

test("safety: disconnect route never touches app data tables", () => {
  const src = readSource("app/api/google/oauth/disconnect/route.ts");
  assert.ok(!src.includes("calendar_events"), "disconnect must not reference calendar_events");
  assert.ok(!/\btasks\b/.test(src), "disconnect must not reference tasks");
});

test("safety: no route under app/api/google/ references NEXT_PUBLIC env", () => {
  const routes = walkSource(join(ROOT, "app/api/google"));
  assert.ok(routes.length > 0, "expected google routes to exist");
  const offenders = routes.filter((f) => readFileSync(f, "utf8").includes("NEXT_PUBLIC"));
  assert.deepEqual(
    offenders.map((f) => relative(ROOT, f)),
    [],
    "server routes must never read client-exposed env"
  );
});

test("safety: lib/google never console.logs token material", () => {
  const files = walkSource(join(ROOT, "lib/google"));
  assert.ok(files.length > 0, "expected lib/google files to exist");
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/console\.(log|warn|error|debug|info|trace).*token/gi)) {
      offenders.push(`${relative(ROOT, f)}: ${m[0].slice(0, 80)}`);
    }
  }
  assert.deepEqual(offenders, [], "no token logging in lib/google");
});
