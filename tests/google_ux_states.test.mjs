// V4.3.3: Google Calendar integration UX-state tests.
//
// Static/behavioral tests of the connection-state representation in the
// settings UI. Reading source (not rendering) is the established pattern in
// this repo for UI-state coverage (see tests/google.test.mjs static audits).
// Covers:
//  - components/settings/GoogleCalendarSection.tsx — all sync/connection
//    state branches, Sync Now behavior, calendar selection, disconnect
//    two-tap, conflict notice, error announcement.
//  - components/calendar/forms.tsx — Google calendar selector hints.
//  - components/calendar/DayView.tsx — visible "Google" label on the dot.
//
// Deterministic: no network, no DOM, no real credentials.
// Run with:
//   TZ='Asia/Kolkata' node --test --import ./tests/hooks.mjs tests/google_ux_states.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sectionSrc = readFileSync(
  join(ROOT, "components/settings/GoogleCalendarSection.tsx"),
  "utf8"
);
const formsSrc = readFileSync(
  join(ROOT, "components/calendar/forms.tsx"),
  "utf8"
);
const dayViewSrc = readFileSync(
  join(ROOT, "components/calendar/DayView.tsx"),
  "utf8"
);

// ---------------------------------------------------------------------------
// syncLabel derivation: every connection/sync state maps to a friendly label.
// ---------------------------------------------------------------------------

test("syncLabel covers all states: syncing, offline, reconnect, rate-limit, failed, synced, never", () => {
  const labels = [
    '"Syncing…"',
    '"Offline — changes will sync when connected"',
    '"Reconnect required"',
    '"Sync paused — try again in a bit"', // rate_limited friendly wording
    '"Sync failed"',
    '"Synced"', // prefix of `Synced ${timeAgo(...)}`
    '"Not synced yet"',
  ];
  for (const label of labels) {
    // "Synced" is a template-literal prefix (Synced ${timeAgo(...)}); the
    // rest are plain double-quoted literals assigned to syncLabel.
    const frag =
      label === '"Synced"' ? "syncLabel = `Synced" : `syncLabel = ${label}`;
    assert.ok(
      sectionSrc.includes(frag) || sectionSrc.includes(label),
      `syncLabel derivation must cover ${label}`
    );
  }
});

test("syncLabel branch order: syncing first, then offline, then revoked, then errors, then lastSyncedAt", () => {
  const order = [
    "if (syncing)",
    'syncError === "offline"',
    'status === "revoked"',
    'syncError === "rate_limited"',
    "if (syncError)",
    "sync?.lastSyncedAt",
  ];
  const idx = order.map((frag) => sectionSrc.indexOf(frag));
  for (const [i, frag] of order.entries()) {
    assert.ok(idx[i] >= 0, `missing syncLabel branch: ${frag}`);
  }
  for (let i = 1; i < idx.length; i++) {
    assert.ok(
      idx[i] > idx[i - 1],
      `syncLabel branch "${order[i]}" must come after "${order[i - 1]}"`
    );
  }
});

// ---------------------------------------------------------------------------
// Connection states: disconnected / connecting / connected / revoked.
// ---------------------------------------------------------------------------

test("disconnected branch offers Connect with plain non-technical copy", () => {
  assert.ok(sectionSrc.includes('status === "disconnected"'));
  assert.ok(
    />\s*Connect Google Calendar\s*</.test(sectionSrc),
    "disconnected branch must offer a Connect Google Calendar button"
  );
});

test("connecting state: OAuth return shows a 'Connecting…' label, not a generic load", () => {
  assert.ok(
    sectionSrc.includes('pendingLabel.current = "Connecting…"'),
    "post-OAuth gcal=connected must arm the Connecting… label"
  );
  assert.ok(
    sectionSrc.includes("<LoadingBlock label={loadingLabel} />"),
    "loading renders with the pending label"
  );
});

test("revoked branch renders a Reconnect affordance", () => {
  assert.ok(sectionSrc.includes('status === "revoked"'));
  assert.ok(
    />\s*Reconnect Google Calendar\s*</.test(sectionSrc),
    "revoked/write-blocked states must render a Reconnect button"
  );
});

// ---------------------------------------------------------------------------
// Sync Now behavior: guard, disabled state, offline short-circuit.
// ---------------------------------------------------------------------------

test("runSync is guarded against duplicate requests (syncingRef)", () => {
  assert.ok(
    /async function runSync\(\) \{\s*\n\s*if \(syncingRef\.current\) return;/.test(
      sectionSrc
    ),
    "runSync must bail when syncingRef.current is set"
  );
  assert.ok(
    sectionSrc.includes("syncingRef.current = false;"),
    "syncingRef must be released in the finally path"
  );
});

test("Sync now button is disabled while syncing or offline", () => {
  assert.ok(
    sectionSrc.includes("disabled={syncing || offline || liveOffline}"),
    "Sync now must be disabled while syncing or offline"
  );
  assert.ok(
    sectionSrc.includes('setSyncError("offline")'),
    "offline start short-circuits with the offline label"
  );
});

test("offline uses navigator.onLine and degrades to the cached sync label", () => {
  assert.ok(sectionSrc.includes("navigator.onLine === false"));
  assert.ok(
    sectionSrc.includes("Offline — changes will sync when connected"),
    "offline must show the friendly cached label, not an error code"
  );
});

// ---------------------------------------------------------------------------
// 429 rate-limit mapping: friendly, non-technical, no leak of internals.
// ---------------------------------------------------------------------------

test("http_429 maps to a friendly rate_limited state with non-technical copy", () => {
  assert.ok(
    sectionSrc.includes('err.code === "http_429"'),
    "429 must be detected via the provider's http_429 code"
  );
  assert.ok(
    sectionSrc.includes('setSyncError("rate_limited")'),
    "429 must set the rate_limited state"
  );
  assert.ok(
    sectionSrc.includes("Sync paused — try again in a bit"),
    "rate-limited sync label must be friendly"
  );
  assert.ok(
    sectionSrc.includes(
      "Google is temporarily limiting requests. Waiting a moment,"
    ),
    "rate-limit explainer must be non-technical"
  );
});

test("user-facing copy never exposes a raw status code or URL", () => {
  // Strip the mechanical comparisons AND code comments — neither is
  // user-facing. What remains must not leak "429".
  const scrubbed = sectionSrc
    .replace(/\/\/[^\n]*/g, "")
    .replace(/err\.code === "http_429"/g, "")
    .replace(/syncError === "rate_limited"/g, "");
  assert.ok(!scrubbed.includes("429"), "no raw 429 in user-facing copy");
  // The friendly explainer paragraph must not contain a URL.
  const explainer = scrubbed.slice(
    scrubbed.indexOf("Google is temporarily limiting requests.")
  );
  assert.ok(
    !/https?:\/\//.test(explainer.slice(0, 400)),
    "rate-limit copy must not contain a URL"
  );
});

// ---------------------------------------------------------------------------
// Calendar selection.
// ---------------------------------------------------------------------------

test("calendar selection toggle updates state and is exposed via aria-pressed", () => {
  assert.ok(
    sectionSrc.includes("aria-pressed={cal.selected}"),
    "each calendar toggle must expose aria-pressed"
  );
  assert.ok(
    sectionSrc.includes("Included") && sectionSrc.includes("Not included"),
    "toggle text must read Included / Not included"
  );
  assert.ok(
    sectionSrc.includes("provider.setCalendarSelected(cal.id, !cal.selected)"),
    "toggle must persist the flipped selection"
  );
  assert.ok(
    sectionSrc.includes("selected: !cal.selected"),
    "toggle must optimistically update local state"
  );
  assert.ok(
    sectionSrc.includes("disabled={togglingId !== null}"),
    "toggles must disable while one toggle is in flight"
  );
});

// ---------------------------------------------------------------------------
// Disconnect two-tap: aria-live announcement.
// ---------------------------------------------------------------------------

test("disconnect two-tap arms, confirms, and announces via aria-live", () => {
  assert.ok(sectionSrc.includes("disconnectArmed"), "two-tap arming state");
  assert.ok(
    sectionSrc.includes('"Tap again to confirm"'),
    "second-tap confirmation copy"
  );
  assert.ok(
    /aria-live="polite"[\s\S]*?aria-describedby="gcal-disconnect-note"/.test(
      sectionSrc
    ),
    "disconnect button must carry aria-live and a described-by note"
  );
  assert.ok(
    sectionSrc.includes("Disconnecting…"),
    "disconnecting label while the call is in flight"
  );
});

// ---------------------------------------------------------------------------
// Conflict notice: Google-wins is surfaced, dismissible.
// ---------------------------------------------------------------------------

test("conflict notice renders Google-wins copy and a dismiss action", () => {
  assert.ok(
    sectionSrc.includes("Google&apos;s version was kept for these events"),
    "conflict notice must state Google's version was kept"
  );
  assert.ok(
    sectionSrc.includes("dismissConflicts"),
    "conflict notice must be dismissible"
  );
});

// ---------------------------------------------------------------------------
// Error announcement.
// ---------------------------------------------------------------------------

test("error states are announced with role=alert", () => {
  assert.ok(
    sectionSrc.includes('<div role="alert">'),
    "ErrorState must be wrapped in role=alert"
  );
  assert.ok(
    sectionSrc.includes("renderAlertError"),
    "renderAlertError wraps ErrorState in role=alert"
  );
  const alertCount = (sectionSrc.match(/role="alert"/g) ?? []).length;
  assert.ok(
    alertCount >= 3,
    `expected at least 3 role=alert usages, found ${alertCount}`
  );
});

// ---------------------------------------------------------------------------
// Event form: Google calendar selector hints.
// ---------------------------------------------------------------------------

test("event form Google selector has plain-language hints", () => {
  assert.ok(
    formsSrc.includes('label="Google Calendar"') ||
      formsSrc.includes('label={"Google Calendar"}'),
    "selector must be labelled Google Calendar"
  );
  assert.ok(
    formsSrc.includes("This event syncs with Google Calendar."),
    "already-mapped events must say so plainly"
  );
  assert.ok(
    formsSrc.includes("pushes it to Google on the next sync"),
    "selector hint must explain the push timing"
  );
});

// ---------------------------------------------------------------------------
// DayView: visible text label next to the Google dot.
// ---------------------------------------------------------------------------

test("DayView Google indicator pairs the dot with visible text", () => {
  assert.ok(
    dayViewSrc.includes('aria-label="Synced with Google Calendar"'),
    "DayView Google indicator must have an accessible name"
  );
  assert.ok(
    />\s*Google\s*</.test(dayViewSrc),
    "DayView must render a visible 'Google' text label next to the dot"
  );
});
