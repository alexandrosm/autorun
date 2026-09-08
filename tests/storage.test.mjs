import test from "node:test";
import assert from "node:assert/strict";
import { openRunDatabase, putRunDatabaseValue, getRunDatabaseValue, deleteRunDatabaseValue } from "../src/storage.ts";

function installIndexedDb(t, indexedDB) {
  for (const [name, value] of Object.entries({ window: { indexedDB }, indexedDB })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else delete globalThis[name];
    });
  }
}

test("a synchronously denied database open returns each caller's unavailable result", async (t) => {
  installIndexedDb(t, { open() { throw new DOMException("Storage denied", "SecurityError"); } });
  assert.equal(await openRunDatabase(), null);
  assert.equal(await putRunDatabaseValue("draft", { saved: true }), false);
  assert.equal(await getRunDatabaseValue("draft"), null);
  assert.equal(await deleteRunDatabaseValue("draft"), false);
});

test("a blocked open settles immediately and closes a connection delivered later", async (t) => {
  let closed = false;
  const request = { result: { close() { closed = true; } } };
  installIndexedDb(t, { open: () => request });
  const opened = openRunDatabase();
  request.onblocked();
  assert.equal(await opened, null);
  request.onsuccess();
  assert.equal(closed, true);
});

test("an abandoned blocked open aborts a later schema upgrade", async (t) => {
  let aborted = false;
  let created = false;
  const request = {
    transaction: { abort() { aborted = true; } },
    result: {
      objectStoreNames: { contains: () => false },
      createObjectStore() { created = true; },
    },
  };
  installIndexedDb(t, { open: () => request });
  const opened = openRunDatabase();
  request.onblocked();
  assert.equal(await opened, null);
  request.onupgradeneeded();
  assert.equal(aborted, true);
  assert.equal(created, false);
});

test("a throwing schema upgrade settles even before its eventual error event", async (t) => {
  let aborted = false;
  const request = {
    transaction: { abort() { aborted = true; } },
    result: {
      objectStoreNames: { contains: () => false },
      createObjectStore() { throw new DOMException("Storage full", "QuotaExceededError"); },
    },
  };
  installIndexedDb(t, { open: () => request });
  const opened = openRunDatabase();
  request.onupgradeneeded();
  assert.equal(await opened, null);
  assert.equal(aborted, true);
});

function installReadTransaction(t, outcome) {
  let closed = false;
  const result = { captured: "run" };
  const readRequest = { result };
  const transaction = {
    objectStore: () => ({ get: () => readRequest }),
  };
  const database = {
    close() { closed = true; },
    transaction() {
      queueMicrotask(() => {
        readRequest.onsuccess();
        queueMicrotask(() => transaction[outcome]());
      });
      return transaction;
    },
  };
  installIndexedDb(t, {
    open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess());
      return request;
    },
  });
  return { result, isClosed: () => closed };
}

test("a successful read followed by a transaction abort returns unavailable, not the record", async (t) => {
  const database = installReadTransaction(t, "onabort");
  assert.equal(await getRunDatabaseValue("draft"), null);
  assert.equal(database.isClosed(), true);
});

test("a committed read returns the stored record and releases the connection", async (t) => {
  const database = installReadTransaction(t, "oncomplete");
  assert.deepEqual(await getRunDatabaseValue("draft"), database.result);
  assert.equal(database.isClosed(), true);
});
