// V4.8 — export regression tests.
// Verifies buildUserExport: owner-scoped data only, no secrets/tokens,
// all intended categories present, safe failure modes.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildUserExport,
  EXPORT_TABLES,
  EXPORT_VERSION,
} from "@/lib/export";

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

// Minimal mock of the Supabase query builder used by buildUserExport.
// Respects the select() column list so secret-column exclusion is tested.
function mockSupabase(tables) {
  return {
    from(table) {
      const rows = tables[table] ?? [];
      return {
        select(cols) {
          const wanted =
            cols === "*"
              ? null
              : cols.split(",").map((c) => c.trim());
          return {
            eq(col, val) {
              const filtered = rows
                .filter((r) => r[col] === val)
                .map((r) =>
                  wanted ? Object.fromEntries(wanted.map((c) => [c, r[c]])) : r
                );
              return Promise.resolve({ data: filtered, error: null });
            },
          };
        },
      };
    },
  };
}

function failingSupabase() {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return Promise.resolve({
                data: null,
                error: new Error("db down"),
              });
            },
          };
        },
      };
    },
  };
}

const seedTables = {
  challenges: [
    { id: "c1", owner: A, title: "Arc" },
    { id: "c2", owner: B, title: "Other" },
  ],
  calendar_events: [{ id: "e1", owner: A, title: "Work" }],
  habits: [{ id: "h1", owner: A, name: "Meditation" }],
  // Google connection WITH a token column present in the DB row: the export
  // must not select it (explicit column list), so it must be absent.
  google_calendar_connections: [
    {
      id: "g1",
      owner: A,
      google_account_id: "g-acct",
      email: "a@example.com",
      refresh_token_enc: "SECRET-CIPHERTEXT",
      access_token_enc: "SECRET-CIPHERTEXT",
    },
  ],
  google_oauth_transactions: [{ id: "t1", owner: A }],
  sync_applied_mutations: [{ mutation_id: "m1", owner_id: A }],
};

// ---------------------------------------------------------------------------
// §1 — owner scoping
// ---------------------------------------------------------------------------

test("EXPORT: contains only the authenticated user's data", async () => {
  const payload = await buildUserExport(mockSupabase(seedTables), A);
  assert.equal(payload.data.challenges.length, 1);
  assert.equal(payload.data.challenges[0].id, "c1");
  // No row owned by B appears anywhere.
  const all = Object.values(payload.data).flat();
  for (const row of all) {
    const owner = row.owner ?? row.owner_id ?? row.id;
    assert.notEqual(owner, B, "user B's data leaked into export");
  }
});

// ---------------------------------------------------------------------------
// §2 — no secrets
// ---------------------------------------------------------------------------

test("EXPORT: contains no secrets or tokens", async () => {
  const payload = await buildUserExport(mockSupabase(seedTables), A);
  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes("SECRET-CIPHERTEXT"), "token ciphertext leaked");
  assert.ok(!serialized.includes("refresh_token"), "refresh_token field leaked");
  assert.ok(!serialized.includes("access_token"), "access_token field leaked");
  // The connection row is present but stripped to safe metadata.
  const conns = payload.data.google_calendar_connections;
  assert.equal(conns.length, 1);
  assert.ok(!("refresh_token_enc" in conns[0]));
  assert.ok(!("access_token_enc" in conns[0]));
  assert.equal(conns[0].google_account_id, "g-acct");
});

test("EXPORT: transient security/internal tables are excluded", async () => {
  const payload = await buildUserExport(mockSupabase(seedTables), A);
  assert.deepEqual(payload.data.google_oauth_transactions, []);
  assert.deepEqual(payload.data.sync_applied_mutations, []);
});

// ---------------------------------------------------------------------------
// §3 — shape and categories
// ---------------------------------------------------------------------------

test("EXPORT: payload has the documented top-level shape", async () => {
  const payload = await buildUserExport(mockSupabase(seedTables), A);
  assert.equal(payload.export_version, EXPORT_VERSION);
  assert.ok(typeof payload.exported_at === "string");
  assert.ok(!Number.isNaN(Date.parse(payload.exported_at)));
  assert.ok(typeof payload.data === "object");
});

test("EXPORT: every user-owned table has a key in data", async () => {
  const payload = await buildUserExport(mockSupabase(seedTables), A);
  for (const spec of EXPORT_TABLES) {
    assert.ok(
      spec.table in payload.data,
      `missing data key for table ${spec.table}`
    );
    assert.ok(Array.isArray(payload.data[spec.table]));
  }
});

test("EXPORT: sync_token cursor is not exported", async () => {
  // The sync_state column list must not include Google's sync cursor.
  const spec = EXPORT_TABLES.find(
    (s) => s.table === "google_calendar_sync_state"
  );
  assert.ok(spec && spec.columns);
  assert.ok(!spec.columns.includes("sync_token"));
});

// ---------------------------------------------------------------------------
// §4 — safe failures
// ---------------------------------------------------------------------------

test("EXPORT: rejects a missing/invalid user id", async () => {
  await assert.rejects(buildUserExport(mockSupabase(seedTables), ""));
  await assert.rejects(buildUserExport(mockSupabase(seedTables), null));
});

test("EXPORT: database errors become a generic failure", async () => {
  await assert.rejects(
    buildUserExport(failingSupabase(), A),
    /Failed to build the user data export/
  );
});
