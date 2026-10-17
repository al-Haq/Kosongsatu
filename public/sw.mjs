// Nawlogic Invoice service worker (installable app, roadmap no. 85).
// It caches only the app shell (scripts, styles, fonts, icons) and an offline
// page. API responses, client links, PDFs and any other page are never cached:
// pages always come from the network, and the offline page is shown only when
// the network cannot be reached.
const VERSION = "nawlogic-shell-v1";
const PRECACHE = ["/offline.html", "/app.css", "/assets/nawlogic-logo.png", "/assets/favicon.svg", "/assets/icons/icon-192.png"];
const SHELL = /^\/(?:[\w-]+\.(?:mjs|css)|ext\/[\w-]+\.(?:mjs|css)|assets\/[\w./-]+\.(?:png|svg|ttf|woff2)|manifest\.webmanifest)$/;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("nawlogic-shell-") && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Other origins and the API are left to the browser untouched.
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate") {
    // Pages (the workspace, client links) are never cached.
    event.respondWith(fetch(request).catch(() => caches.match("/offline.html")));
    return;
  }
  if (!SHELL.test(url.pathname) || url.pathname === "/sw.mjs" || url.search) return;
  // Network first, so updates arrive at once; the cached copy is the fallback.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit || Response.error())),
  );
});
