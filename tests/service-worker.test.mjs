import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
const scope = "https://fixture.invalid/autorun/";
const shell = '<html><script type="module" src="/autorun/assets/main.js"></script><link rel="stylesheet" href="/autorun/assets/main.css"></html>';
const cameraAssets = [
  "mediapipe/vision_wasm_internal.js",
  "mediapipe/vision_wasm_internal.wasm",
  "mediapipe/vision_wasm_nosimd_internal.js",
  "mediapipe/vision_wasm_nosimd_internal.wasm",
  "models/blaze_face_short_range.tflite",
];

function worker() {
  const handlers = new Map();
  const buckets = new Map([
    ["other-app", new Map([["https://fixture.invalid/other/data", new Response("keep this data")]])],
    ["greenlake-autoresearch-logger-vold", new Map([[scope, new Response("old shell")]])],
  ]);
  const network = new Map([
    [scope, new Response(shell, { headers: { "Content-Type": "text/html" } })],
    [`${scope}assets/main.js`, new Response("window.booted = true;")],
    [`${scope}assets/main.css`, new Response("body { color: green; }")],
    ...cameraAssets.map((path) => [`${scope}${path}`, new Response(`camera asset: ${path}`)]),
  ]);
  const key = (request) => typeof request === "string" ? new URL(request, scope).href : request.url;
  const cachedHeaders = new WeakMap();
  const put = (bucket, request, response) => {
    const stored = response.clone();
    cachedHeaders.set(stored, new Headers(typeof request === "string" ? undefined : request.headers));
    bucket.set(key(request), stored);
  };
  const match = (bucket, request, options = {}) => {
    const response = bucket.get(key(request));
    if (!response) return undefined;
    const incoming = new Headers(typeof request === "string" ? undefined : request.headers);
    const stored = cachedHeaders.get(response) ?? new Headers();
    const vary = response.headers.get("vary");
    if (!options.ignoreVary && vary && vary.split(",").some(field => {
      const name = field.trim().toLowerCase();
      return name === "*" || incoming.get(name) !== stored.get(name);
    })) return undefined;
    return response.clone();
  };
  const fetch = async (request) => {
    const response = network.get(key(request));
    if (!response) throw new TypeError("Network unavailable");
    return response.clone();
  };
  const caches = {
    keys: async () => [...buckets.keys()],
    delete: async (name) => buckets.delete(name),
    open: async (name) => {
      if (!buckets.has(name)) buckets.set(name, new Map());
      const bucket = buckets.get(name);
      return {
        match: async (request, options) => match(bucket, request, options),
        put: async (request, response) => put(bucket, request, response),
        addAll: async (requests) => {
          const responses = await Promise.all(requests.map(fetch));
          if (responses.some(response => !response.ok)) throw new TypeError("Cache download failed");
          requests.forEach((request, index) => put(bucket, request, responses[index]));
        },
      };
    },
    match: async (request, options) => {
      for (const bucket of buckets.values()) {
        const response = match(bucket, request, options);
        if (response) return response;
      }
    },
  };
  const windows = [{ id: "home", url: scope }];
  let activatedEarly = false;
  vm.runInNewContext(source, {
    self: {
      registration: { scope },
      location: { origin: new URL(scope).origin },
      clients: { claim: async () => {}, matchAll: async () => windows },
      skipWaiting: async () => { activatedEarly = true; },
      addEventListener: (event, handler) => handlers.set(event, handler),
    },
    caches, fetch, URL, Response,
  });
  const dispatch = async (type, fields = {}) => {
    const pending = [];
    let response;
    handlers.get(type)({
      ...fields,
      waitUntil: (promise) => pending.push(promise),
      respondWith: (promise) => { response = promise; },
    });
    const resolved = response ? await response : undefined;
    await Promise.all(pending);
    return resolved;
  };
  const request = (url, mode = "cors", headers = {}) =>
    dispatch("fetch", { request: { url, mode, method: "GET", headers: new Headers(headers) } });
  return { dispatch, request, network, buckets, windows, activatedEarly: () => activatedEarly };
}

test("an activated update boots offline before any client has fetched its scripts or styles", async () => {
  const app = worker();
  await app.dispatch("install");
  await app.dispatch("activate");
  app.network.clear();
  assert.equal(await (await app.request(scope, "navigate")).text(), shell);
  assert.equal(await (await app.request(`${scope}assets/main.js`)).text(), "window.booted = true;");
  assert.equal(await (await app.request(`${scope}assets/main.css`)).text(), "body { color: green; }");
  for (const path of cameraAssets) {
    assert.equal(await (await app.request(`${scope}${path}`)).text(), `camera asset: ${path}`);
  }
});

test("crossorigin boot assets use their precache even when the server varies by Origin", async () => {
  const app = worker();
  for (const asset of ["assets/main.js", "assets/main.css"]) {
    const original = app.network.get(`${scope}${asset}`);
    app.network.set(`${scope}${asset}`, new Response(await original.text(), { headers: { Vary: "Origin" } }));
  }
  await app.dispatch("install");
  await app.dispatch("activate");
  app.network.clear();
  const headers = { Origin: new URL(scope).origin };
  assert.equal(await (await app.request(`${scope}assets/main.js`, "cors", headers)).text(), "window.booted = true;");
  assert.equal(await (await app.request(`${scope}assets/main.css`, "cors", headers)).text(), "body { color: green; }");
});

test("non-static responses still respect their Vary headers", async () => {
  const app = worker();
  const url = `${scope}api/example`;
  app.network.set(url, new Response("English", { headers: { Vary: "Accept-Language" } }));
  await app.request(url, "cors", { "Accept-Language": "en" });
  app.network.clear();
  assert.equal(await (await app.request(url, "cors", { "Accept-Language": "en" })).text(), "English");
  await assert.rejects(app.request(url, "cors", { "Accept-Language": "fr" }));
});

test("activation preserves other apps' cached data on the same origin", async () => {
  const app = worker();
  await app.dispatch("install");
  await app.dispatch("activate");
  assert.equal(await app.buckets.get("other-app").get("https://fixture.invalid/other/data").text(), "keep this data");
  assert.equal(app.buckets.has("greenlake-autoresearch-logger-vold"), false);
});

test("a server failure cannot replace the last bootable offline shell", async () => {
  const app = worker();
  await app.dispatch("install");
  await app.dispatch("activate");
  app.network.set(scope, new Response("temporary outage", { status: 503 }));
  assert.equal(await (await app.request(scope, "navigate")).text(), shell);
  app.network.clear();
  assert.equal(await (await app.request(scope, "navigate")).text(), shell);
});

test("an incomplete shell download fails installation instead of retiring the old cache", async () => {
  const app = worker();
  app.network.delete(`${scope}models/blaze_face_short_range.tflite`);
  await assert.rejects(app.dispatch("install"));
  assert.equal(await app.buckets.get("greenlake-autoresearch-logger-vold").get(scope).text(), "old shell");
});

test("offline fetches use this worker's shell and assets, not another app's cache", async () => {
  const app = worker();
  const unrelated = app.buckets.get("other-app");
  unrelated.set(scope, new Response("unrelated shell"));
  unrelated.set(`${scope}assets/main.js`, new Response("unrelated script"));
  await app.dispatch("install");
  await app.dispatch("activate");
  app.network.clear();
  assert.equal(await (await app.request(scope, "navigate")).text(), shell);
  assert.equal(await (await app.request(`${scope}assets/main.js`)).text(), "window.booted = true;");
  assert.equal(await unrelated.get(scope).text(), "unrelated shell");
});

test("an active worker cannot borrow an uncached asset from a waiting update", async () => {
  const app = worker();
  await app.dispatch("install");
  await app.dispatch("activate");
  const url = `${scope}assets/next-release.js`;
  app.buckets.set("greenlake-autoresearch-logger-vnext", new Map([[url, new Response("not active yet")]]));
  app.network.clear();
  await assert.rejects(app.request(url));
  assert.equal(await (await app.request(scope, "navigate")).text(), shell);
});

test("a Home tab cannot activate an update while another app window remains open", async () => {
  const app = worker();
  const notices = [];
  const source = { id: "home", postMessage: (message) => notices.push(message) };
  app.windows.push({ id: "run", url: scope }, { id: "unrelated", url: "https://fixture.invalid/other/" });
  await app.dispatch("message", { data: { type: "SKIP_WAITING" }, source });
  assert.equal(app.activatedEarly(), false);
  assert.equal(notices[0]?.type, "UPDATE_DEFERRED_OTHER_CLIENTS");
  app.windows.splice(1, 1);
  await app.dispatch("message", { data: { type: "SKIP_WAITING" }, source });
  assert.equal(app.activatedEarly(), true);
});
