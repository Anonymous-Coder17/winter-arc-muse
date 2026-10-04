// V4.3.1.1: Google OAuth transaction hardening — unit + static security tests.
//
// Deterministic: no network, no real Google/Supabase credentials. Covers:
//  - lib/google/oauthTransactions.ts (create/consume/delete against a fake
//    chainable Supabase client): tampering, replay, user isolation, expiry.
//  - lib/google/server.ts resolveConnectionAction (pure): the real function
//    source is extracted and imported from a scratch .ts module, because
//    server.ts also imports next/server which cannot resolve under plain
//    node. This still tests the shipped code, not a copy.
//  - Static route safety for the new txn-cookie scheme: httpOnly +
//    SameSite=lax + narrow path + 10-minute maxAge; no token material in
//    client storage or redirect URLs; no userId trusted from the cookie.
//  - Import-graph: server-only modules stay server-side.
//  - Security regression: no service-role key usage, GOOGLE_CLIENT_SECRET
//    confined to server-only modules, no token strings in SW/IDB paths.
//
// Run with:
//   TZ='Asia/Kolkata' node --test --import ./tests/hooks.mjs tests/google_oauth_transaction.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

// tokenVault reads the key at use-time; a fixed-shape random test key is
// enough (no network, no real credentials anywhere in this file).
process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("hex");

import {
  createOAuthTransaction,
  consumeOAuthTransaction,
  deleteOAuthTransaction,
} from "../lib/google/oauthTransactions";
import { validateState } from "../lib/google/oauthCore";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

function readSource(...parts) {
  return readFileSync(join(ROOT, ...parts), "utf8");
}

// ---------------------------------------------------------------------------
// Fake Supabase client
// ---------------------------------------------------------------------------
//
// Implements only the chainable surface used by oauthTransactions.ts:
//   from(table) -> { insert, update, delete }
//     .eq(col, v) .lt(col, v) .gt(col, v) .is(col, v) .select(cols)
//     .maybeSingle()
// Bare awaits (no terminal) work because the query object is thenable.
// Rows live in an in-memory Map keyed by id; tests can reach the store via
// the __store handle to simulate tampering.
class FakeTxnQuery {
  constructor(store) {
    this.store = store;
    this.filters = [];
    this.op = null;
    this.patch = null;
    this.columns = null;
  }
  eq(col, val) {
    this.filters.push((r) => r[col] === val);
    return this;
  }
  lt(col, val) {
    this.filters.push((r) => r[col] < val);
    return this;
  }
  gt(col, val) {
    this.filters.push((r) => r[col] > val);
    return this;
  }
  is(col, val) {
    this.filters.push((r) => (val === null ? r[col] == null : r[col] === val));
    return this;
  }
  select(cols) {
    this.columns = cols;
    return this;
  }
  insert(row) {
    const stored = { ...row };
    this.store.set(stored.id, stored);
    return FakeTxnQuery.resolved({ data: [stored], error: null });
  }
  update(patch) {
    this.op = "update";
    this.patch = patch;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  matched() {
    return [...this.store.values()].filter((r) =>
      this.filters.every((f) => f(r))
    );
  }
  project(row) {
    if (!this.columns) return { ...row };
    const out = {};
    for (const c of this.columns.split(",").map((s) => s.trim())) {
      out[c] = row[c];
    }
    return out;
  }
  run() {
    if (this.op === "delete") {
      const rows = this.matched();
      for (const r of rows) this.store.delete(r.id);
      return { data: rows, error: null };
    }
    if (this.op === "update") {
      const rows = this.matched();
      for (const r of rows) Object.assign(r, this.patch);
      return { data: rows.map((r) => this.project(r)), error: null };
    }
    return { data: this.matched().map((r) => this.project(r)), error: null };
  }
  maybeSingle() {
    const { data, error } = this.run();
    return Promise.resolve({
      data: data.length > 0 ? data[0] : null,
      error,
    });
  }
  then(resolve, reject) {
    return Promise.resolve(this.run()).then(resolve, reject);
  }
  static resolved(value) {
    return { then: (res, rej) => Promise.resolve(value).then(res, rej) };
  }
}

function makeFakeSupabase() {
  const store = new Map();
  return {
    __store: store,
    from(table) {
      assert.equal(
        table,
        "google_oauth_transactions",
        "fake only models the txn table"
      );
      return new FakeTxnQuery(store);
    },
  };
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------
// Tampering
// ---------------------------------------------------------------------------

test("oauthTxn: create -> consume returns the original state and verifier, row is gone", async () => {
  const supabase = makeFakeSupabase();
  const state = "state-abc-123";
  const verifier = "verifier-secret-xyz";
  const txnId = await createOAuthTransaction(supabase, A, {
    state,
    verifier,
    ttlSeconds: 600,
  });
  assert.match(txnId, UUID_V4, "transaction id is a random UUID");

  const consumed = await consumeOAuthTransaction(supabase, A, txnId);
  assert.ok(consumed, "first consume succeeds");
  assert.equal(consumed.state, state, "stored state round-trips intact");
  assert.equal(consumed.verifier, verifier, "verifier decrypts to the original");

  // The row is deleted on consume: nothing is left to steal or replay.
  assert.equal(supabase.__store.has(txnId), false, "row deleted on consume");
  assert.equal(
    await consumeOAuthTransaction(supabase, A, txnId),
    null,
    "second consume returns null"
  );
});

test("oauthTxn: state tampering is caught at the validateState step", async () => {
  const supabase = makeFakeSupabase();
  const state = "state-original-456";
  const txnId = await createOAuthTransaction(supabase, A, {
    state,
    verifier: "verifier-for-state-test",
    ttlSeconds: 600,
  });
  const txn = await consumeOAuthTransaction(supabase, A, txnId);
  assert.ok(txn, "consume succeeds");

  // The stored state lives server-side; an attacker who swaps the state
  // returned by Google fails the timing-safe comparison.
  assert.equal(validateState(txn.state, state), true, "exact state validates");
  assert.equal(
    validateState(txn.state, "attacker-chosen-state"),
    false,
    "tampered state rejected"
  );
  assert.equal(
    validateState(txn.state, state.slice(0, -1)),
    false,
    "truncated state rejected"
  );
  assert.equal(validateState(txn.state, ""), false, "empty state rejected");
});

test("oauthTxn: start route cookie carries ONLY the transaction id", () => {
  const src = readSource("app/api/google/oauth/start/route.ts");
  // The state and verifier go server-side into the transaction row...
  assert.ok(
    /createOAuthTransaction\(\s*supabase\s*,\s*user\.id\s*,\s*\{\s*state,\s*verifier,/.test(
      src
    ),
    "state + verifier are stored server-side, bound to the session user"
  );
  // ...and the cookie carries only the random id.
  assert.ok(
    /setOAuthTxnCookie\(\s*res\s*,\s*txnId\s*,\s*request\s*\)/.test(src),
    "cookie is set with the txn id alone"
  );
  assert.ok(
    !src.includes("res.cookies.set"),
    "start route never sets cookies directly (no ad-hoc cookie values)"
  );
});

test("oauthTxn: consume with a different userId returns null", async () => {
  const supabase = makeFakeSupabase();
  const txnId = await createOAuthTransaction(supabase, A, {
    state: "s-user",
    verifier: "v-user",
    ttlSeconds: 600,
  });
  assert.equal(
    await consumeOAuthTransaction(supabase, B, txnId),
    null,
    "user B cannot consume user A's transaction"
  );
  assert.equal(
    supabase.__store.has(txnId),
    true,
    "failed cross-user consume leaves the row untouched"
  );
});

test("oauthTxn: corrupted verifier_enc throws the generic decryption error", async () => {
  const supabase = makeFakeSupabase();
  const verifier = "verifier-very-secret-material";
  const txnId = await createOAuthTransaction(supabase, A, {
    state: "state-tamper-verifier",
    verifier,
    ttlSeconds: 600,
  });
  // Bit-rot / attacker flip inside the ciphertext: format stays plausible,
  // the GCM auth tag no longer verifies.
  const row = supabase.__store.get(txnId);
  const blob = row.verifier_enc;
  row.verifier_enc =
    blob.slice(0, 20) + (blob[20] === "A" ? "B" : "A") + blob.slice(21);

  const err = await consumeOAuthTransaction(supabase, A, txnId).then(
    () => {
      throw new Error("expected decryption to fail");
    },
    (e) => e
  );
  assert.equal(err.message, "Token decryption failed.", "generic error only");
  assert.ok(
    !err.message.includes(verifier),
    "error must not leak the verifier"
  );
  assert.ok(
    !err.message.includes("state-tamper-verifier"),
    "error must not leak the state"
  );
});

test("oauthTxn: an expired transaction cannot be consumed", async () => {
  const supabase = makeFakeSupabase();
  const txnId = await createOAuthTransaction(supabase, A, {
    state: "s-exp",
    verifier: "v-exp",
    ttlSeconds: 600,
  });
  // Age the row past its TTL (simulates clock passing / TTL tampering).
  supabase.__store.get(txnId).expires_at = new Date(
    Date.now() - 1000
  ).toISOString();
  assert.equal(
    await consumeOAuthTransaction(supabase, A, txnId),
    null,
    "expired transaction returns null"
  );
});

test("oauthTxn: unknown transaction ids cannot be consumed", async () => {
  const supabase = makeFakeSupabase();
  const txnId = await createOAuthTransaction(supabase, A, {
    state: "s-swap",
    verifier: "v-swap",
    ttlSeconds: 600,
  });
  assert.equal(
    await consumeOAuthTransaction(supabase, A, randomUUID()),
    null,
    "random unknown id returns null"
  );
  assert.equal(
    await consumeOAuthTransaction(supabase, B, txnId),
    null,
    "A's txn id consumed as B returns null"
  );
  assert.equal(
    supabase.__store.has(txnId),
    true,
    "A's row survives the swap attempts"
  );
});

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

test("oauthTxn: a transaction id is strictly single-use (no replay)", async () => {
  const supabase = makeFakeSupabase();
  const txnId = await createOAuthTransaction(supabase, A, {
    state: "s-replay",
    verifier: "v-replay",
    ttlSeconds: 600,
  });
  const first = await consumeOAuthTransaction(supabase, A, txnId);
  assert.ok(first, "first consume succeeds");
  const second = await consumeOAuthTransaction(supabase, A, txnId);
  assert.equal(second, null, "second consume with the same id returns null");
  // No row remains that a second connection/token/selection flow could use.
  assert.equal(
    [...supabase.__store.values()].filter((r) => r.id === txnId).length,
    0,
    "no transaction row survives the first consume"
  );
});

// ---------------------------------------------------------------------------
// User isolation
// ---------------------------------------------------------------------------

test("oauthTxn: B's failed consume leaves A's transaction valid", async () => {
  const supabase = makeFakeSupabase();
  const txnId = await createOAuthTransaction(supabase, A, {
    state: "s-iso",
    verifier: "v-iso",
    ttlSeconds: 600,
  });
  assert.equal(
    await consumeOAuthTransaction(supabase, B, txnId),
    null,
    "B gets nothing"
  );
  const consumed = await consumeOAuthTransaction(supabase, A, txnId);
  assert.ok(consumed, "A can still consume afterwards");
  assert.equal(consumed.state, "s-iso");
  assert.equal(consumed.verifier, "v-iso");
});

test("oauthTxn: deleteOAuthTransaction removes the row and never throws", async () => {
  const supabase = makeFakeSupabase();
  const txnId = await createOAuthTransaction(supabase, A, {
    state: "s-del",
    verifier: "v-del",
    ttlSeconds: 600,
  });
  await deleteOAuthTransaction(supabase, A, txnId);
  assert.equal(supabase.__store.has(txnId), false, "row deleted");
  assert.equal(
    await consumeOAuthTransaction(supabase, A, txnId),
    null,
    "deleted transaction cannot be consumed"
  );
  // Best-effort: unknown ids and cross-user deletes are silent no-ops.
  await deleteOAuthTransaction(supabase, A, randomUUID());
  await deleteOAuthTransaction(supabase, B, txnId);
});

// ---------------------------------------------------------------------------
// resolveConnectionAction (pure) — extracted from the real server.ts
// ---------------------------------------------------------------------------

// server.ts also imports next/server, which cannot resolve under plain node,
// so the pure function is extracted from the shipped source and imported
// from a scratch .ts module (Node type-strips the annotations). The
// extraction is sanity-checked so a drift in the real file fails loudly.
function extractFunctionSource(src, name) {
  const start = src.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, `${name} must exist in lib/google/server.ts`);
  // Skip past the parameter list first: type annotations may contain
  // braces (e.g. `existing: { google_account_id: string } | null`).
  let i = src.indexOf("(", start);
  let pdepth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "(") pdepth++;
    else if (src[i] === ")") {
      pdepth--;
      if (pdepth === 0) break;
    }
  }
  assert.ok(pdepth === 0, "unbalanced parens while extracting function");
  // The body opening brace comes after the return-type annotation.
  i = src.indexOf("{", i);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  assert.ok(depth === 0, "unbalanced braces while extracting function");
  return src.slice(start, i + 1).replace(/^export /, "");
}

const serverSrc = readSource("lib/google/server.ts");
const extracted = extractFunctionSource(serverSrc, "resolveConnectionAction");
assert.ok(
  extracted.includes('"insert"') &&
    extracted.includes('"update"') &&
    extracted.includes('"replace"'),
  "extracted the real decision body (all three actions present)"
);
const scratchPath = join(tmpdir(), `resolveConnectionAction-${process.pid}.ts`);
writeFileSync(scratchPath, `${extracted}\nexport { resolveConnectionAction };\n`);
const { resolveConnectionAction } = await import(pathToFileURL(scratchPath).href);
unlinkSync(scratchPath);

test("resolveConnectionAction: insert / update / replace", () => {
  assert.equal(
    resolveConnectionAction(null, "google-sub-1"),
    "insert",
    "no existing connection -> insert"
  );
  assert.equal(
    resolveConnectionAction({ google_account_id: "google-sub-1" }, "google-sub-1"),
    "update",
    "same Google account -> update in place"
  );
  assert.equal(
    resolveConnectionAction({ google_account_id: "google-sub-old" }, "google-sub-new"),
    "replace",
    "different Google account -> replace"
  );
});

// ---------------------------------------------------------------------------
// Cookie security (static source checks)
// ---------------------------------------------------------------------------

test("cookie: txn cookie is httpOnly, SameSite=lax, narrow path, 10-minute maxAge", () => {
  assert.ok(
    serverSrc.includes('GCAL_OAUTH_TXN_COOKIE = "gcal_oauth_txn"'),
    "cookie name constant"
  );
  assert.ok(
    serverSrc.includes('GCAL_OAUTH_TXN_COOKIE_PATH = "/api/google/oauth/callback"'),
    "cookie path is scoped to the callback route only"
  );
  assert.ok(
    serverSrc.includes("GCAL_OAUTH_TXN_COOKIE_MAX_AGE_SECONDS = 600"),
    "cookie lifetime matches the transaction TTL"
  );
  const setFn = extractFunctionSource(serverSrc, "setOAuthTxnCookie");
  assert.ok(/httpOnly:\s*true/.test(setFn), "httpOnly");
  assert.ok(/sameSite:\s*"lax"/.test(setFn), "SameSite=lax");
  assert.ok(
    /path:\s*GCAL_OAUTH_TXN_COOKIE_PATH/.test(setFn),
    "narrow callback-only path"
  );
  assert.ok(
    /maxAge:\s*GCAL_OAUTH_TXN_COOKIE_MAX_AGE_SECONDS/.test(setFn),
    "10-minute maxAge"
  );
});

test("cookie: old cookie-carried scheme is fully deleted from server.ts", () => {
  for (const legacy of [
    "OAuthCookiePayload",
    "encodeOAuthCookie",
    "readOAuthCookie",
    "clearOAuthCookie",
    "GCAL_OAUTH_COOKIE",
  ]) {
    assert.ok(
      !serverSrc.includes(legacy),
      `server.ts must not contain the old scheme (${legacy})`
    );
  }
  // (GCAL_OAUTH_TXN_COOKIE legitimately contains the substring
  // "GCAL_OAUTH_"; the bare legacy name above must be absent.)
});

test("cookie: callback never touches client storage or puts tokens in redirect URLs", () => {
  for (const route of [
    "app/api/google/oauth/callback/route.ts",
    "app/api/google/oauth/start/route.ts",
  ]) {
    const src = readSource(route);
    assert.ok(!src.includes("localStorage"), `${route}: no localStorage`);
    assert.ok(!src.includes("indexedDB"), `${route}: no indexedDB`);
    assert.ok(!src.includes("sessionStorage"), `${route}: no sessionStorage`);
  }
  const cb = readSource("app/api/google/oauth/callback/route.ts");
  for (const line of cb.split("\n")) {
    if (line.includes("?gcal=")) {
      assert.ok(
        !/token/i.test(line),
        `redirect flag line must not carry token material: ${line.trim()}`
      );
    }
  }
});

test("cookie: no userId is ever trusted from the cookie", () => {
  const cb = readSource("app/api/google/oauth/callback/route.ts");
  assert.ok(!cb.includes("cookie.userId"), "no cookie.userId");
  assert.ok(!cb.includes("cookies.get"), "no raw cookie reads");
  assert.ok(
    !/userId.*cookie|cookie.*userId/i.test(cb),
    "no userId/cookie association anywhere"
  );
  // The only identity source is the session.
  assert.ok(
    /const\s*\{\s*data:\s*\{\s*user\s*\},?\s*\}\s*=\s*await\s*supabase\.auth\.getUser\(\)/.test(
      cb
    ),
    "session user is the only identity source"
  );
  // The cookie reader yields a bare id, nothing structured.
  assert.ok(
    /const txnId = readOAuthTxnCookie\(request\);/.test(cb),
    "callback reads only the txn id from the cookie"
  );
});

test("routes: no console logging in app/api/google routes", () => {
  const offenders = [];
  for (const file of walkSource(join(ROOT, "app/api/google"))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(
      /console\.(log|warn|error|debug|info|trace)/g
    )) {
      offenders.push(`${relative(ROOT, file)}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [], "google routes must not console-log");
});

// ---------------------------------------------------------------------------
// Import-graph security
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

const SERVER_ONLY_MODULES = [
  "lib/google/server",
  "lib/google/oauthTransactions",
  "lib/google/tokenVault",
];

test("imports: server-only modules carry the marker; client code never imports them", () => {
  for (const mod of SERVER_ONLY_MODULES) {
    const src = readFileSync(join(ROOT, mod + ".ts"), "utf8");
    assert.ok(
      src.includes('import "server-only"'),
      `${mod}.ts must import server-only`
    );
  }
  const modRe = new RegExp(
    `(^|/)(${SERVER_ONLY_MODULES.map((m) =>
      m.replace(/\//g, "\\/")
    ).join("|")})$`
  );
  const violations = [];
  for (const root of [join(ROOT, "components"), join(ROOT, "app/(app)")]) {
    for (const file of walkSource(root)) {
      const rel = relative(ROOT, file).replace(/\\/g, "/");
      for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
        const norm = spec.replace(/^@\//, "").replace(/\.tsx?$/, "");
        if (modRe.test(norm)) {
          violations.push(`${rel} imports server-only module via ${spec}`);
        }
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    "components and app routes must never import the server-only google modules"
  );
});

// ---------------------------------------------------------------------------
// Security regression (static)
// ---------------------------------------------------------------------------

function allSourceFiles() {
  return [
    ...walkSource(join(ROOT, "app")),
    ...walkSource(join(ROOT, "lib")),
    ...walkSource(join(ROOT, "components")),
  ];
}

test("regression: no service-role key usage in app/lib/components (comments only)", () => {
  const suspicious = [];
  for (const file of allSourceFiles()) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (/service-role|SERVICE_ROLE|service_role/i.test(line)) {
        const t = line.trim();
        if (
          !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"))
        ) {
          suspicious.push(
            `${relative(ROOT, file)}:${i + 1}: ${t.slice(0, 100)}`
          );
        }
      }
    });
  }
  assert.deepEqual(
    suspicious,
    [],
    "service-role may only be mentioned in comments (it is never used)"
  );
});

test("regression: GOOGLE_CLIENT_SECRET stays inside server-only modules", () => {
  const offenders = [];
  for (const file of allSourceFiles()) {
    const src = readFileSync(file, "utf8");
    if (
      src.includes("GOOGLE_CLIENT_SECRET") &&
      !src.includes('import "server-only"')
    ) {
      offenders.push(relative(ROOT, file));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "GOOGLE_CLIENT_SECRET must only appear in server-only modules"
  );
});

test("regression: no token material in the service worker or IndexedDB meta-cache paths", () => {
  const sw = readFileSync(join(ROOT, "public/sw.js"), "utf8");
  assert.ok(
    !/refresh_token|access_token/i.test(sw),
    "service worker must never reference token material"
  );
  assert.ok(!/document\.cookie/i.test(sw), "service worker never touches cookies");
  const meta = readFileSync(
    join(ROOT, "lib/calendar-providers/googleMeta.ts"),
    "utf8"
  );
  assert.ok(
    !/refresh_token|access_token/i.test(meta),
    "IndexedDB meta-cache code must never reference token keys"
  );
});
