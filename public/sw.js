const CACHE_NAME = "greenlake-autoresearch-logger-v0.3.2-reliability";
const APP_SCOPE = self.registration.scope;
const CACHE_PREFIX = "greenlake-autoresearch-logger-";

async function cacheAppShell() {
  const response = await fetch(APP_SCOPE, { cache: "reload" });
  if (!response.ok) throw new Error("App shell download failed");
  const html = await response.clone().text();
  const assets = [];
  for (const tag of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    if (!/^<script\b/i.test(tag[0]) && !/\brel=["']stylesheet["']/i.test(tag[0])) continue;
    const source = tag[0].match(/\b(?:src|href)=["']([^"']+)["']/i)?.[1];
    if (!source) continue;
    const url = new URL(source, APP_SCOPE);
    if (url.origin === self.location.origin) assets.push(url.href);
  }
  const cache = await caches.open(CACHE_NAME);
  // Installation must finish the whole bootable shell before the old cache retires.
  await cache.addAll(assets);
  await cache.put(APP_SCOPE, response);
}

self.addEventListener("install", (event) => {
  event.waitUntil(cacheAppShell());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          if (response.ok) return response;
          return (await caches.match(APP_SCOPE)) ?? response;
        })
        .catch(async () => (await caches.match(APP_SCOPE)) ?? Response.error()),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        return cached;
      }
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {}));
        }
        return response;
      });
    }),
  );
});
