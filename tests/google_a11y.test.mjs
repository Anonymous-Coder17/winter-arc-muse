// V4.3.3: Google Calendar integration accessibility + responsive tests.
//
// Static source audits of the Google Calendar UI surfaces. Reading source is
// the established pattern here for UI contracts (see tests/google.test.mjs
// static audits). Covers:
//  - components/settings/GoogleCalendarSection.tsx — no color-only status,
//    labelled buttons, live regions, role=alert errors, responsive classes.
//  - components/calendar/DayView.tsx — Google indicator accessibility.
//  - components/ui.tsx + app/globals.css — focus visibility is never reset
//    on interactive elements.
//  - components/calendar/forms.tsx — labelled Google selector.
//
// Deterministic: no network, no DOM, no real credentials.
// Run with:
//   TZ='Asia/Kolkata' node --test --import ./tests/hooks.mjs tests/google_a11y.test.mjs
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
const dayViewSrc = readFileSync(
  join(ROOT, "components/calendar/DayView.tsx"),
  "utf8"
);
const formsSrc = readFileSync(
  join(ROOT, "components/calendar/forms.tsx"),
  "utf8"
);
const uiSrc = readFileSync(join(ROOT, "components/ui.tsx"), "utf8");
const globalsCss = readFileSync(join(ROOT, "app/globals.css"), "utf8");

// ---------------------------------------------------------------------------
// No color-only status: every StateDot is paired with adjacent visible text.
// ---------------------------------------------------------------------------

test("every StateDot in the settings section is paired with adjacent text", () => {
  const usages = [...sectionSrc.matchAll(/<StateDot[^/]*\/>/g)];
  assert.ok(
    usages.length >= 3,
    `expected >=3 StateDot usages in GoogleCalendarSection, found ${usages.length}`
  );
  for (const m of usages) {
    // The status text follows the dot (StateDot then adjacent <span>).
    const after = sectionSrc.slice(m.index, m.index + 300);
    const hasText =
      />\s*Connected\s*</.test(after) ||
      />\s*Connection revoked\s*</.test(after) ||
      /syncLabel/.test(after);
    assert.ok(
      hasText,
      `StateDot at offset ${m.index} must sit next to visible text, not stand alone`
    );
  }
});

test("DayView Google indicator pairs the dot with a visible text label", () => {
  assert.ok(
    /<StateDot[^/]*\/>[\s\S]{0,120}>\s*Google\s*</.test(dayViewSrc),
    "DayView must render visible 'Google' text right after the dot"
  );
  assert.ok(
    dayViewSrc.includes('aria-label="Synced with Google Calendar"'),
    "DayView Google indicator must carry an accessible name"
  );
  // The dot itself must not be the only name source.
  assert.ok(
    dayViewSrc.includes('title="Synced with Google Calendar"'),
    "title mirrors the accessible name for sighted users"
  );
});

// ---------------------------------------------------------------------------
// Buttons: every button has an accessible label.
// ---------------------------------------------------------------------------

/** Extract all <button ...>...</button> blocks from a source string. */
function buttons(src) {
  return [...src.matchAll(/<button\b([\s\S]*?)>([\s\S]*?)<\/button>/g)].map(
    (m) => ({ attrs: m[1], inner: m[2], full: m[0] })
  );
}

test("every button in GoogleCalendarSection has an accessible label", () => {
  const btns = buttons(sectionSrc);
  assert.ok(btns.length > 0, "expected buttons in GoogleCalendarSection");
  for (const b of btns) {
    const aria = /aria-label=/.test(b.attrs);
    const text = b.inner.replace(/<[^>]*>/g, "").replace(/[{}…\s]/g, "");
    assert.ok(
      aria || text.length > 0,
      `button lacks an accessible label: ${b.full.slice(0, 120)}`
    );
  }
});

test("every button in the event form's Google selector has an accessible label", () => {
  const btns = buttons(formsSrc);
  for (const b of btns) {
    const aria = /aria-label=/.test(b.attrs);
    const text = b.inner.replace(/<[^>]*>/g, "").replace(/[{}…\s]/g, "");
    assert.ok(
      aria || text.length > 0,
      `form button lacks an accessible label: ${b.full.slice(0, 120)}`
    );
  }
});

test("calendar toggles expose both aria-pressed and an explicit aria-label", () => {
  assert.ok(sectionSrc.includes("aria-pressed={cal.selected}"));
  assert.ok(
    sectionSrc.includes("aria-label="),
    "calendar toggle buttons must carry an aria-label (Include/Exclude …)"
  );
});

// ---------------------------------------------------------------------------
// Live regions + alerts.
// ---------------------------------------------------------------------------

test("disconnect two-tap announces through aria-live", () => {
  assert.ok(
    /aria-live="polite"/.test(sectionSrc),
    "disconnect button must carry aria-live=polite"
  );
  assert.ok(
    sectionSrc.includes('aria-describedby="gcal-disconnect-note"'),
    "disconnect must describe what disconnecting does"
  );
  assert.ok(
    sectionSrc.includes("gcal-disconnect-note"),
    "the described-by target must exist"
  );
});

test("sync status line is a polite live region", () => {
  assert.ok(
    /<span[\s\S]*?role="status"[\s\S]*?aria-live="polite"[\s\S]*?>[\s\S]*?syncLabel/.test(
      sectionSrc
    ),
    "sync status must render role=status with aria-live=polite around the label"
  );
});

test("errors and post-OAuth notices are announced, not silent", () => {
  assert.ok(
    (sectionSrc.match(/role="alert"/g) ?? []).length >= 3,
    "error surfaces must use role=alert"
  );
  assert.ok(
    sectionSrc.includes('role="status"'),
    "transient notices must use role=status"
  );
});

// ---------------------------------------------------------------------------
// Focus visibility: no outline:none on interactive elements without a
// visible replacement.
// ---------------------------------------------------------------------------

test("no outline:none reset on button classes in app/globals.css", () => {
  const css = globalsCss.replace(/\s+/g, " ");
  const btnBlocks = [...css.matchAll(/\.(btn-[a-z]+|seg-btn|input|textarea)\s*\{[^}]*\}/g)];
  for (const m of btnBlocks) {
    const cls = m[0].slice(0, 30);
    if (cls.startsWith(".input") || cls.startsWith(".textarea")) continue; // checked separately
    assert.ok(
      !m[0].includes("outline-none") && !/outline:\s*none/.test(m[0]),
      `interactive class must keep focus outline: ${m[0].slice(0, 80)}`
    );
  }
});

test("the .input outline:none is always paired with a visible focus ring", () => {
  const css = globalsCss.replace(/\s+/g, " ");
  const inputs = [...css.matchAll(/\.(input|textarea)\s*\{[^}]*\}/g)];
  assert.ok(inputs.length > 0, "expected .input rule in globals.css");
  for (const m of inputs) {
    if (!m[0].includes("outline-none")) continue;
    assert.ok(
      /focus:ring/.test(m[0]),
      ".input outline:none must be paired with a focus:ring replacement"
    );
  }
});

test("components/ui.tsx has no outline:none on interactive elements", () => {
  assert.ok(
    !uiSrc.includes("outline-none"),
    "components/ui.tsx must not reset outlines"
  );
});

// ---------------------------------------------------------------------------
// Responsive: flexible layout, no fixed pixel widths, no truncation traps.
// ---------------------------------------------------------------------------

test("Google section uses responsive patterns (flex-wrap, truncate, break-all, shrink-0)", () => {
  for (const cls of ["flex-wrap", "truncate", "break-all", "shrink-0"]) {
    assert.ok(
      sectionSrc.includes(cls),
      `GoogleCalendarSection must use the responsive class "${cls}"`
    );
  }
});

test("Google section has no fixed pixel widths", () => {
  const fixed = sectionSrc.match(/w-\[\d+px\]/g) ?? [];
  assert.deepEqual(fixed, [], "no w-[NNNpx] fixed widths in the Google section");
});

test("email and calendar names can wrap or truncate instead of overflowing", () => {
  assert.ok(
    /state\.email[\s\S]{0,200}break-all/.test(sectionSrc),
    "email must use break-all"
  );
  assert.ok(
    /truncate[\s\S]{0,80}cal\.summary|cal\.summary[\s\S]{0,40}truncate/.test(
      sectionSrc.replace(/\s+/g, " ")
    ),
    "calendar names must truncate"
  );
});

test("forms.tsx Google selector has an explicit label for the select", () => {
  assert.ok(
    formsSrc.includes('label="Google Calendar"'),
    "the select must be inside a labelled Field"
  );
  assert.ok(
    /<select/.test(formsSrc),
    "the selector must be a native select (accessible by default)"
  );
});
