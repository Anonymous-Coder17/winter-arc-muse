/* Winter Arc PWA foundation (V4.1). Conservative by design.
 *
 * WHAT IS CACHED:
 *   Same-origin `/_next/static/*` immutable build assets only (JS/CSS chunks
 *   with content-hashed filenames). Cache-first is safe here because a new
 *   build produces new filenames; stale chunks are purged on activate.
 *
 * WHAT IS NEVER CACHED:
 *   - Navigations / HTML pages (including /login, /calendar, etc.)
 *   - API routes and /auth/* callbacks
 *   - Cross-origin requests (Supabase, CDNs) — the fetch handler returns
 *     early for any non-same-origin URL
 *   - Any authenticated or user-specific data: journal content, workout
 *     history, study history, analytics, habits, tasks — none of these
 *     ever enter a cache
 *   - Auth tokens or cookies are never read, written, or stored here
 *
 * The worker exists to establish installability and a safe lifecycle for the
 * future V4.2 offline architecture. When in doubt, it does not cache.
 */

const STATIC_CACHE = "winter-arc-static-v1";

self.addEventListener("install", () => {
  // Take over immediately so the installed app runs the current worker.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key !== STATIC_CACHE).map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Never intercept cross-origin traffic (Supabase API, CDNs, fonts).
  if (url.origin !== self.location.origin) return;
  // Only immutable build assets. Everything else (pages, API, auth) is
  // network-only so private content can never be served from cache.
  if (!url.pathname.startsWith("/_next/static/")) return;

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
});
