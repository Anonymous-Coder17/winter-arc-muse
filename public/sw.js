/* Winter Arc PWA (V4.1 foundation + V4.2 offline shell). Conservative by design.
 *
 * WHAT IS CACHED:
 *   1. Same-origin `/_next/static/*` immutable build assets (JS/CSS chunks
 *      with content-hashed filenames), cache-first. A new build produces new
 *      filenames; stale chunks are purged on activate. (Unchanged V4.1.)
 *   2. Same-origin navigation responses (the app shell HTML), network-first
 *      with cache fallback, in a SEPARATE cache. This lets the installed app
 *      launch while offline; all user data still loads client-side from the
 *      per-user IndexedDB after auth — the shell HTML itself carries no
 *      private content. The shell cache is purged on logout / account switch
 *      by the app (see engine.handleLogout → caches.delete), so one account
 *      never sees another's cached shell.
 *
 * WHAT IS NEVER CACHED:
 *   - Non-GET requests; cross-origin requests (Supabase API, CDNs, fonts)
 *   - /auth/* callbacks (one-time code exchange) and /api/* routes
 *   - Any Supabase/authenticated data response — offline data lives in
 *     IndexedDB, never in this worker's caches
 *   - Non-OK responses (redirects, errors) are never stored
 *   - Auth tokens or cookies are never read, written, or stored here
 */

const STATIC_CACHE = "winter-arc-static-v1";
const SHELL_CACHE = "winter-arc-shell-v1";
const NAV_TIMEOUT_MS = 6000;

self.addEventListener("install", () => {
  // Take over immediately so the installed app runs the current worker.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== STATIC_CACHE && key !== SHELL_CACHE)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

function fetchWithTimeout(request, ms) {
  return Promise.race([
    fetch(request),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("nav-timeout")), ms)
    ),
  ]);
}

function offlineFallback() {
  const html =
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>Winter Arc — Offline</title>" +
    "<style>body{background:#0B0D10;color:#E8EAF0;font-family:system-ui,sans-serif;" +
    "display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}" +
    ".c{text-align:center;padding:2rem;max-width:22rem}" +
    "h1{font-size:1.1rem;font-weight:600;margin:0 0 .5rem}" +
    "p{font-size:.85rem;color:#9BA3AF;margin:0 0 1.25rem}" +
    "button{background:#5A6AE0;color:#fff;border:0;border-radius:.75rem;" +
    "padding:.65rem 1.4rem;font-size:.9rem;cursor:pointer}</style></head>" +
    "<body><div class=\"c\"><h1>\u2744 Winter Arc</h1>" +
    "<p>You're offline and this page hasn't been opened before. " +
    "Reconnect, open the app once, and it will work offline afterwards.</p>" +
    "<button onclick=\"location.reload()\">Retry</button></div></body></html>";
  return new Response(html, {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Never intercept cross-origin traffic (Supabase API, CDNs, fonts).
  if (url.origin !== self.location.origin) return;

  // 1) Immutable build assets: cache-first (V4.1 behavior, unchanged).
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((response) => {
            if (response && response.ok) {
              const copy = response.clone();
              caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          })
      )
    );
    return;
  }

  // 2) App-shell navigations: network-first, cache fallback, offline page.
  //    Auth callbacks and API routes are never cached.
  if (request.mode !== "navigate") return;
  if (url.pathname.startsWith("/auth/") || url.pathname.startsWith("/api/")) return;

  event.respondWith(
    (async () => {
      try {
        const response = await fetchWithTimeout(request, NAV_TIMEOUT_MS);
        if (response && response.ok) {
          const copy = response.clone();
          // Fire-and-forget cache update; the network response wins this load.
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      } catch {
        const hit = await caches.match(request);
        if (hit) return hit;
        // PWA start_url ("/") has no cached entry of its own; fall back to
        // the cached app shell when one exists.
        const shell = await caches.match("/calendar");
        if (shell) return shell;
        return offlineFallback();
      }
    })()
  );
});
