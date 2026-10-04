// V4.1 PWA foundation tests: manifest validity, icon assets, service
// worker safety boundaries, and middleware/metadata wiring.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");

function pngSize(p) {
  const buf = readFileSync(p);
  assert.equal(
    buf.subarray(0, 8).toString("hex"),
    "89504e470d0a1a0a",
    "not a PNG: " + p
  );
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

test("manifest is valid, complete, and all icons resolve with correct sizes", () => {
  const raw = readFileSync(path.join(PUBLIC, "manifest.webmanifest"), "utf8");
  const m = JSON.parse(raw);
  assert.ok(m.name, "manifest needs a name");
  assert.ok(m.short_name, "manifest needs a short_name");
  assert.ok(m.description, "manifest needs a description");
  assert.equal(m.start_url, "/");
  assert.equal(m.scope, "/");
  assert.equal(m.display, "standalone");
  assert.equal(m.theme_color, "#0B0D10");
  assert.equal(m.background_color, "#0B0D10");
  assert.ok(Array.isArray(m.icons) && m.icons.length >= 2);
  const sizes = m.icons.map((i) => i.sizes);
  assert.ok(sizes.includes("192x192"), "needs a 192 icon");
  assert.ok(sizes.includes("512x512"), "needs a 512 icon");
  assert.ok(
    m.icons.some((i) => i.purpose === "maskable"),
    "needs a maskable icon"
  );
  for (const icon of m.icons) {
    assert.ok(icon.src.startsWith("/"), "icon src must be absolute: " + icon.src);
    assert.equal(icon.type, "image/png");
    const p = path.join(PUBLIC, icon.src.replace(/^\//, ""));
    assert.ok(existsSync(p), "missing icon file: " + icon.src);
    const [w, h] = pngSize(p);
    const [ew, eh] = icon.sizes.split("x").map(Number);
    assert.deepEqual([w, h], [ew, eh], "wrong dimensions: " + icon.src);
  }
});

test("apple touch icon exists at 180x180", () => {
  const p = path.join(PUBLIC, "icons", "apple-touch-icon.png");
  assert.ok(existsSync(p));
  assert.deepEqual(pngSize(p), [180, 180]);
});

test("service worker only caches immutable same-origin static assets", () => {
  const sw = readFileSync(path.join(PUBLIC, "sw.js"), "utf8");
  // Lifecycle present.
  assert.match(sw, /skipWaiting/);
  assert.match(sw, /clients\.claim/);
  // Guards: GET only, same-origin only, /_next/static/ only.
  assert.match(sw, /request\.method !== "GET"/);
  assert.match(sw, /url\.origin !== self\.location\.origin/);
  assert.match(sw, /startsWith\("\/_next\/static\/"\)/);
  // The static-asset branch keeps its single cache.put call site.
  const staticSection = sw.slice(0, sw.indexOf("App-shell navigations"));
  const puts = staticSection.match(/cache\.put\(/g) || [];
  assert.equal(puts.length, 1, "expected a single cache.put in the static branch");
  assert.match(sw, /winter-arc-static-v1/);
});

test("service worker shell cache stays conservative (V4.2 offline shell)", () => {
  const sw = readFileSync(path.join(PUBLIC, "sw.js"), "utf8");
  // Separate, explicitly named cache — never mixed with static assets.
  assert.match(sw, /winter-arc-shell-v1/);
  assert.ok(
    sw.indexOf("winter-arc-shell-v1") !== sw.indexOf("winter-arc-static-v1"),
    "shell cache must be a distinct cache name"
  );
  // Navigations only: the shell branch bails for non-navigate requests.
  assert.match(sw, /request\.mode !== "navigate"/);
  // Auth callbacks and API routes are never cached.
  assert.match(sw, /startsWith\("\/auth\/"\)/);
  assert.match(sw, /startsWith\("\/api\/"\)/);
  // Only OK responses are stored (no redirects / errors).
  const okPuts = sw.match(/response && response\.ok/g) || [];
  assert.equal(okPuts.length, 2, "both cache branches must gate on response.ok");
  // Activate preserves exactly the two known caches.
  assert.match(sw, /key !== STATIC_CACHE && key !== SHELL_CACHE/);
  // An offline fallback page exists for never-cached navigations.
  assert.match(sw, /offlineFallback/);
});

test("logout purges the cached app shell (no cross-account shell reuse)", () => {
  const engine = readFileSync(path.join(ROOT, "lib", "sync", "engine.ts"), "utf8");
  assert.match(engine, /caches\.delete/, "engine must purge the shell cache on logout/switch");
  const types = readFileSync(path.join(ROOT, "lib", "sync", "types.ts"), "utf8");
  assert.match(types, /winter-arc-shell-v1/);
  assert.match(engine, /SHELL_CACHE/);
});

test("middleware does not auth-gate PWA assets", () => {
  const mw = readFileSync(path.join(ROOT, "middleware.ts"), "utf8");
  assert.match(mw, /sw\\\\\.js/, "sw.js must bypass the middleware matcher");
  assert.match(
    mw,
    /manifest\\\\\.webmanifest/,
    "manifest must bypass the middleware matcher"
  );
});

test("root layout wires manifest, icons, and theme metadata", () => {
  const layout = readFileSync(path.join(ROOT, "app", "layout.tsx"), "utf8");
  assert.match(layout, /manifest\.webmanifest/);
  assert.match(layout, /appleWebApp/);
  assert.match(layout, /themeColor/);
  assert.match(layout, /viewportFit/);
  assert.match(layout, /PwaRegister/);
});
