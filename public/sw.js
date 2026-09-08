const CACHE_NAME = "greenlake-autoresearch-logger-v0.6.0-spoken-pulse";
const APP_SCOPE = self.registration.scope;
const CACHE_PREFIX = "greenlake-autoresearch-logger-";
const STATIC_ASSET_PREFIXES = ["assets/", "mediapipe/", "models/"].map((path) => new URL(path, APP_SCOPE).href);

async function cacheAppShell() {
  const response = await fetch(APP_SCOPE, { cache: "reload" });
  if (!response.ok) throw new Error("App shell download failed");
  const html = await response.clone().text();
  // Install on-device camera dependencies before the first offline post-run scan.
  const assets = [
    "mediapipe/vision_wasm_internal.js",
    "mediapipe/vision_wasm_internal.wasm",
    "mediapipe/vision_wasm_nosimd_internal.js",
    "mediapipe/vision_wasm_nosimd_internal.wasm",
    "models/blaze_face_short_range.tflite",
  ].map((path) => new URL(path, APP_SCOPE).href);
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
    event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // A Home tab cannot retire caches underneath another tab's active run.
      const otherAppClients = clients.some((client) =>
        client.url.startsWith(APP_SCOPE) && client.id !== event.source?.id,
      );
      if (otherAppClients) {
        event.source?.postMessage({ type: "UPDATE_DEFERRED_OTHER_CLIENTS" });
        return;
      }
      return self.skipWaiting();
    }));
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
          return (await (await caches.open(CACHE_NAME)).match(APP_SCOPE)) ?? response;
        })
        .catch(async () => (await (await caches.open(CACHE_NAME)).match(APP_SCOPE)) ?? Response.error()),
    );
    return;
  }

  event.respondWith(
    // crossorigin scripts/styles send Origin, unlike the installer's requests.
    // These bundled files do not vary by headers; dynamic responses still may.
    caches.open(CACHE_NAME).then((cache) => cache.match(request, {
      ignoreVary: STATIC_ASSET_PREFIXES.some((prefix) => url.href.startsWith(prefix)),
    })).then((cached) => {
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
