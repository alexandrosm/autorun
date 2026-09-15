import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const recorderUrl = new URL("../src/sessionLog.ts", import.meta.url).href;
// Node's type stripper does not resolve Vite's extensionless runtime imports.
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === "./storage" && context.parentURL?.startsWith(recorderUrl) ? "./storage.ts" : specifier, context);
} });

class Scroller extends EventTarget {
  constructor(parent = null) {
    super();
    this.parentElement = parent;
    this.children = [];
    this.scrollTop = 0;
    this.tagName = parent ? "DIV" : "HTML";
    if (parent) parent.children.push(this);
  }
  closest(selector) {
    for (let element = this; element; element = element.parentElement) {
      if (selector === "[data-session-ignore]" && element.ignored) return element;
      if (selector === "[data-session-target]" && element.target) return element;
      if (selector.startsWith("button,a,") && element.tagName === "BUTTON") return element;
      if (selector.startsWith("input,textarea,") && element.editable) return element;
    }
    return null;
  }
  getAttribute(name) { return name === "data-session-target" ? this.target ?? null : null; }
}

async function fixture(t) {
  const names = ["window", "document", "navigator", "screen", "performance", "localStorage", "Element", "HTMLInputElement", "HTMLDetailsElement", "clearInterval"];
  const originals = Object.fromEntries(names.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let clock = 1000;
  const timers = new Map();
  const root = new Scroller();
  const document = Object.assign(new EventTarget(), { scrollingElement: root, visibilityState: "visible" });
  const storage = new Map();
  const host = Object.assign(new EventTarget(), {
    innerWidth: 390, innerHeight: 844, devicePixelRatio: 1, scrollY: 0,
    matchMedia: () => ({ matches: false }),
    setInterval: fn => { const id = timers.size + 1; timers.set(id, fn); return id; },
  });
  const values = {
    window: host, document, navigator: { onLine: true, maxTouchPoints: 0 },
    screen: {}, performance: { now: () => clock, timeOrigin: 0 }, Element: Scroller,
    HTMLInputElement: class extends Scroller {},
    HTMLDetailsElement: class extends Scroller {},
    localStorage: {
      get length() { return storage.size; }, key: i => [...storage.keys()][i] ?? null,
      getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    },
    clearInterval: id => timers.delete(id),
  };
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  let recorder;
  t.after(async () => {
    try { recorder?.stop(); await recorder?.flush(); }
    finally {
      for (const [key, descriptor] of Object.entries(originals)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    }
  });
  const module = await import(`${recorderUrl}?case=${crypto.randomUUID()}`);
  const context = { screen: "home", run_id: null, elapsed_seconds: null };
  recorder = new module.SessionRecorder({
    appVersion: "fixture", getContext: () => context, onStatus() {},
  });
  recorder.start();
  const emit = (type, target = root, data = {}, trusted = true) => {
    const event = new Event(type);
    Object.defineProperties(event, { target: { value: target }, isTrusted: { value: trusted } });
    Object.assign(event, data);
    const destination = ["pagehide", "pageshow", "resize", "online", "offline", "error", "unhandledrejection"].includes(type) ? host : document;
    destination.dispatchEvent(event);
  };
  return {
    recorder, root, emit, context, window: host,
    acknowledge: module.markSessionChunkSynced,
    visibility(value) { document.visibilityState = value; emit("visibilitychange"); },
    at(value) { clock = value; for (const tick of timers.values()) tick(); },
    scroll(y, target = root) { target.scrollTop = y; emit("scroll", target); },
    async events() { await recorder.flush(); return (await module.listSessionChunks(Infinity)).flatMap(c => c.events); },
    async chunks() { await recorder.flush(); return module.listSessionChunks(Infinity); },
  };
}

test("automatic page movement and idle flushes do not create activity details", async t => {
  const f = await fixture(t);
  const initial = await f.chunks();
  assert.deepEqual(initial, []);
  for (let time = 2000; time <= 20000; time += 1000) {
    f.at(time);
    f.scroll(time % 2000 ? 1 : 0);
  }
  assert.deepEqual(await f.chunks(), initial);
  f.at(30000);
  assert.deepEqual(await f.chunks(), initial);
});

test("idle browsing stays pending context across flushes and sync checkpoints", async t => {
  const f = await fixture(t);
  f.recorder.recordState("capability", { sensor: "gps", permission: "ready" });
  // Representative sub-100px moves: the phone exports only a coarse distance bucket.
  for (const [time, y] of [[2000, 16], [4000, 32], [6000, 48], [8000, 32], [10000, 48], [12000, 64]]) {
    f.at(time);
    f.emit("touchmove");
    f.scroll(y);
    await f.recorder.flushForSync();
    assert.deepEqual(await f.chunks(), []);
  }
  const button = new Scroller(f.root);
  button.tagName = "BUTTON";
  button.target = "start-setup";
  f.at(14000);
  f.emit("click", button);
  const original = await f.chunks();
  const events = original.flatMap(chunk => chunk.events);
  assert.deepEqual(events.filter(event => event.kind === "scroll").map(event => ({
    target: event.target, time: event.t_ms, data: event.data,
  })), [{ target: "html.0", time: 11000, data: { direction: 1, distance_bucket: 0 } }]);
  assert.equal(events.filter(event => event.kind === "click" && event.target === "start-setup").length, 1);
  assert.equal(events.find(event => event.kind === "capability").data.permission, "ready");
  // Already queued activity does not turn subsequent browsing into another batch.
  f.at(16000);
  f.emit("touchmove");
  f.scroll(1080); // Large navigation is context too, not just the phone's small moves.
  await f.recorder.flushForSync();
  assert.deepEqual(await f.chunks(), original);
});

test("live-run scrolling accumulates small motion per container and expires after input stops", async t => {
  const f = await fixture(t);
  Object.assign(f.context, { screen: "live", run_id: "run_scroll", elapsed_seconds: 12 });
  f.scroll(300); // Browser-restored position before the gesture.
  const nested = new Scroller(f.root);
  nested.scrollTop = 40;
  f.emit("wheel");
  f.scroll(303);
  f.scroll(306);
  assert.equal((await f.events()).filter(e => e.kind === "scroll").length, 0);
  f.scroll(310);
  f.emit("wheel", nested);
  f.scroll(60, nested);
  f.at(2100);
  f.emit("wheel");
  f.scroll(190);
  f.at(3200);
  f.emit("wheel");
  f.scroll(80);
  const gestures = (await f.events()).filter(e => e.kind === "scroll");
  assert.deepEqual(gestures.map(e => [e.target, e.data.direction, e.data.distance_bucket]), [
    ["html.0", 1, 0], ["div.0", 1, 0], ["html.0", -1, 1], ["html.0", -1, 1],
  ]);
  f.at(5000);
  f.scroll(800);
  assert.deepEqual((await f.events()).filter(e => e.kind === "scroll"), gestures);
});

test("synthetic input, hover and typing cannot turn layout changes into scroll activity", async t => {
  const f = await fixture(t);
  f.emit("wheel", f.root, {}, false); f.scroll(100);
  f.emit("pointermove", f.root, { buttons: 0 }); f.scroll(200);
  f.emit("keydown", f.root, { key: "a" }); f.scroll(300);
  const editor = new Scroller(f.root);
  editor.editable = true;
  f.emit("keydown", editor, { key: " " }); f.scroll(400);
  assert.equal((await f.events()).filter(e => e.kind === "scroll").length, 0);
  f.emit("keydown", f.root, { key: "PageDown" }); f.scroll(600);
  f.recorder.record("click", {}, "sync-lab");
  f.recorder.record("click", {}, "sync-lab");
  const events = await f.events();
  assert.equal(events.filter(e => e.kind === "scroll").length, 1);
  assert.equal(events.filter(e => e.kind === "click").length, 2);
  assert.ok(events.every(e => !Object.hasOwn(e.data ?? {}, "key")));
});

test("disabling or restarting recording cannot reuse a stale scroll gesture", async t => {
  const f = await fixture(t);
  Object.assign(f.context, { screen: "live", run_id: "run_scroll", elapsed_seconds: 12 });
  f.emit("touchstart");
  f.recorder.setEnabled(false);
  f.recorder.setEnabled(true);
  f.scroll(100);
  f.emit("pointerdown");
  f.recorder.stop();
  await f.recorder.flush();
  f.recorder.start();
  f.scroll(200);
  assert.equal((await f.events()).filter(e => e.kind === "scroll").length, 0);
  f.emit("touchmove"); f.scroll(220);
  assert.equal((await f.events()).filter(e => e.kind === "scroll").length, 1);
});

test("a passive wheel event retains the position from before compositor scrolling", async t => {
  const f = await fixture(t);
  Object.assign(f.context, { screen: "live", run_id: "run_scroll", elapsed_seconds: 12 });
  f.root.scrollTop = 150; // Compositor moves first; wheel and scroll callbacks follow.
  f.emit("wheel");
  f.emit("scroll");
  const gestures = (await f.events()).filter(e => e.kind === "scroll");
  assert.deepEqual(gestures.map(e => e.data), [{ direction: 1, distance_bucket: 1 }]);
});

test("inspection, transport and idle lifecycle do not start upload batches", async t => {
  const f = await fixture(t);
  const panel = new Scroller(f.root);
  panel.ignored = true;
  const button = new Scroller(panel);
  button.tagName = "BUTTON";
  for (const type of ["focusin", "pointerdown", "click", "focusout"]) f.emit(type, button);
  const details = new HTMLDetailsElement(panel);
  details.open = true;
  f.emit("toggle", details);
  f.emit("keydown", button, { key: "PageDown" });
  f.scroll(200);
  f.visibility("hidden");
  f.emit("pagehide", f.window, { persisted: true });
  f.emit("pageshow", f.window, { persisted: true });
  f.visibility("visible");
  await f.recorder.flushForSync();
  f.at(10000);
  assert.deepEqual(await f.chunks(), []);
  f.recorder.stop();
  f.recorder.start();
  assert.deepEqual(await f.chunks(), []);
});

test("real interaction admits latest observed state without duplicate capabilities", async t => {
  const f = await fixture(t);
  f.at(2000);
  f.recorder.recordState("capability", { sensor: "gps", permission: "unknown" });
  f.recorder.recordState("capability", { sensor: "motion", permission: "denied" });
  f.at(3000);
  f.recorder.recordState("capability", { sensor: "gps", permission: "ready" });
  f.recorder.recordState("capability", { sensor: "motion", permission: "denied" });
  assert.deepEqual(await f.chunks(), []);
  const button = new Scroller(f.root);
  button.tagName = "BUTTON";
  button.target = "start-setup";
  f.at(4000);
  f.emit("focusin", button);
  f.emit("click", button);
  f.emit("click", button);
  const events = await f.events();
  assert.equal(events.filter(e => e.kind === "click" && e.target === "start-setup").length, 2);
  assert.deepEqual(events.filter(e => e.kind === "capability").map(e => [e.data.sensor, e.data.permission, e.t_ms]), [
    ["motion", "denied", 1000], ["gps", "ready", 2000],
  ]);
  assert.deepEqual(events.map(e => e.seq), events.map((_, i) => i));
});

test("sync preserves queued evidence and new errors without a housekeeping tail", async t => {
  const f = await fixture(t);
  f.recorder.record("export_run");
  f.emit("wheel");
  await f.recorder.flushForSync();
  const original = await f.chunks();
  f.recorder.recordState("battery", { charging: false, level_percent: 95 });
  f.visibility("hidden");
  f.emit("pagehide", f.window, { persisted: false });
  f.visibility("visible");
  f.scroll(300); // The sync boundary ended the earlier gesture.
  f.at(10000);
  assert.deepEqual(await f.chunks(), original);
  // No IndexedDB in this fixture: a receipt cannot be durably saved.
  assert.equal(await f.acknowledge(original[0].chunk_id), false);
  assert.deepEqual(await f.chunks(), original);
  f.emit("error", f.window, { error: new TypeError("private error text"), lineno: 42 });
  const after = await f.chunks();
  assert.deepEqual(after.find(c => c.chunk_id === original[0].chunk_id), original[0]);
  const fresh = after.filter(c => c.chunk_id !== original[0].chunk_id).flatMap(c => c.events);
  assert.deepEqual(fresh.find(e => e.kind === "battery").data, { charging: false, level_percent: 95 });
  assert.equal(fresh.find(e => e.kind === "error").data.error_type, "TypeError");
  assert.ok(fresh.every(e => !JSON.stringify(e).includes("private error text")));
});

test("live-run state transitions and sensor rows survive idle admission and opt-out", async t => {
  const f = await fixture(t);
  Object.assign(f.context, { screen: "live", run_id: "run_capture", elapsed_seconds: 12 });
  f.recorder.sensor("motion", ["t"], ["ms"], [1]);
  f.visibility("hidden");
  f.visibility("visible");
  f.visibility("hidden");
  f.visibility("visible");
  f.recorder.setEnabled(false);
  f.recorder.sensor("motion", ["t"], ["ms"], [2]);
  f.recorder.setEnabled(true);
  f.recorder.sensor("motion", ["t"], ["ms"], [3]);
  const chunks = await f.chunks();
  assert.deepEqual(chunks.flatMap(c => c.sensors).flatMap(b => b.rows), [[1], [3]]);
  const events = chunks.flatMap(c => c.events);
  assert.deepEqual(events.filter(e => e.kind === "visibility").map(e => e.data.visibility), ["hidden", "visible", "hidden", "visible"]);
  assert.ok(events.filter(e => e.kind === "visibility").every(e => e.run_id === "run_capture"));
  assert.deepEqual(events.filter(e => e.kind.startsWith("recording_")).map(e => e.kind), ["recording_disabled", "recording_enabled"]);
});
