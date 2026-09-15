import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { probeLabEndpoint, postToLab } from "../src/labSync.ts";
import { createLabHandoverBatch, loadLabHandoverBatch, saveLabHandoverBatch } from "../src/labHandover.ts";

async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("a delayed fetch refusal is ambiguous, not proof that navigation cannot reach the lab", async (t) => {
  const endpoint = await serve(t, (request) => { setTimeout(() => request.destroy(), 1600); });
  const result = await probeLabEndpoint(endpoint);
  assert.equal(result.status, "unavailable");
});

test("probe and upload deadlines include a stalled response body", async (t) => {
  const endpoint = await serve(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"ok":');
  });
  assert.equal((await probeLabEndpoint(endpoint, 40)).status, "unavailable");
  assert.equal(await postToLab(endpoint, "{}", { note_id: "note_one" }, 40), "failed");
});

test("uploads require a true receipt for the exact item before they may be retired", async (t) => {
  let receipt = { ok: true, note_id: "note_other" };
  const endpoint = await serve(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(receipt));
  });
  assert.equal(await postToLab(endpoint, "{}", { note_id: "note_one" }), "failed");
  receipt = { ok: "true", note_id: "note_one" };
  assert.equal(await postToLab(endpoint, "{}", { note_id: "note_one" }), "failed");
  receipt = { ok: true, note_id: "note_one" };
  assert.equal(await postToLab(endpoint, "{}", { note_id: "note_one" }), "stored");
  receipt = { ok: true, chunk_id: "chunk_one", session_id: "wrong_session" };
  assert.equal(await postToLab(endpoint, "{}", { chunk_id: "chunk_one", session_id: "session_one" }), "failed");
});

test("temporary refusal remains retryable while rejected payloads need attention", async (t) => {
  let status = 429;
  const endpoint = await serve(t, (_request, response) => { response.writeHead(status); response.end(); });
  assert.equal(await postToLab(endpoint, "{}", { run_id: "run_one" }), "failed");
  status = 400;
  assert.equal(await postToLab(endpoint, "{}", { run_id: "run_one" }), "rejected");
});

test("a saved large handover snapshot can reload and shrink without absorbing new data", (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const data = new Map();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
  });
  const ids = Array.from({ length: 25001 }, (_, i) => `chunk_${i}`);
  const batch = createLabHandoverBatch("http://lab.invalid", [], [], ids);
  assert.deepEqual(loadLabHandoverBatch(), batch);
  batch.session_ids = batch.session_ids.slice(100);
  saveLabHandoverBatch(batch);
  assert.deepEqual(loadLabHandoverBatch()?.session_ids, ids.slice(100));
});
