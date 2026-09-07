import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
const scope = "https://fixture.invalid/autorun/";
const shell = '<html><script type="module" src="/autorun/assets/main.js"></script><link rel="stylesheet" href="/autorun/assets/main.css"></html>';

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
  ]);
  const key = (request) => typeof request === "string" ? new URL(request, scope).href : request.url;
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
        match: async (request) => bucket.get(key(request))?.clone(),
        put: async (request, response) => { bucket.set(key(request), response.clone()); },
        addAll: async (requests) => {
          const responses = await Promise.all(requests.map(fetch));
          if (responses.some(response => !response.ok)) throw new TypeError("Cache download failed");
          requests.forEach((request, index) => bucket.set(key(request), responses[index]));
        },
      };
    },
    match: async (request) => {
      for (const bucket of buckets.values()) {
        const response = bucket.get(key(request));
        if (response) return response.clone();
      }
    },
  };
  vm.runInNewContext(source, {
    self: {
      registration: { scope },
      location: { origin: new URL(scope).origin },
      clients: { claim: async () => {} },
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
  const request = (url, mode = "cors") => dispatch("fetch", { request: { url, mode, method: "GET" } });
  return { dispatch, request, network, buckets };
}

test("an activated update boots offline before any client has fetched its scripts or styles", async () => {
  const app = worker();
  await app.dispatch("install");
  await app.dispatch("activate");
  app.network.clear();
  assert.equal(await (await app.request(scope, "navigate")).text(), shell);
  assert.equal(await (await app.request(`${scope}assets/main.js`)).text(), "window.booted = true;");
  assert.equal(await (await app.request(`${scope}assets/main.css`)).text(), "body { color: green; }");
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
  app.network.delete(`${scope}assets/main.js`);
  await assert.rejects(app.dispatch("install"));
  assert.equal(await app.buckets.get("greenlake-autoresearch-logger-vold").get(scope).text(), "old shell");
});
