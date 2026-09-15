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
  closest() { return null; }
  getAttribute() { return null; }
}

async function fixture(t) {
  const names = ["window", "document", "navigator", "screen", "performance", "localStorage", "Element", "HTMLInputElement", "clearInterval"];
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
  recorder = new module.SessionRecorder({
    appVersion: "fixture", getContext: () => ({ screen: "home", run_id: null, elapsed_seconds: null }), onStatus() {},
  });
  recorder.start();
  const emit = (type, target = root, data = {}, trusted = true) => {
    const event = new Event(type);
    Object.defineProperties(event, { target: { value: target }, isTrusted: { value: trusted } });
    Object.assign(event, data);
    document.dispatchEvent(event);
  };
  return {
    recorder, root, emit,
    at(value) { clock = value; for (const tick of timers.values()) tick(); },
    scroll(y, target = root) { target.scrollTop = y; emit("scroll", target); },
    async events() { await recorder.flush(); return (await module.listSessionChunks(Infinity)).flatMap(c => c.events); },
    async chunks() { await recorder.flush(); return module.listSessionChunks(Infinity); },
  };
}

test("automatic page movement and idle flushes do not create activity details", async t => {
  const f = await fixture(t);
  const initial = await f.chunks();
  for (let time = 2000; time <= 20000; time += 1000) {
    f.at(time);
    f.scroll(time % 2000 ? 1 : 0);
  }
  assert.deepEqual(await f.chunks(), initial);
  f.at(30000);
  assert.deepEqual(await f.chunks(), initial);
});

test("user scrolling accumulates small motion per container and expires after input stops", async t => {
  const f = await fixture(t);
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
  const gestures = (await f.events()).filter(e => e.kind === "scroll");
  assert.deepEqual(gestures.map(e => [e.target, e.data.direction, e.data.distance_bucket]), [
    ["html.0", 1, 0], ["div.0", 1, 0], ["html.0", -1, 1],
  ]);
  f.at(4000);
  f.scroll(800);
  assert.deepEqual((await f.events()).filter(e => e.kind === "scroll"), gestures);
});

test("synthetic input, hover and typing cannot turn layout changes into scroll activity", async t => {
  const f = await fixture(t);
  f.emit("wheel", f.root, {}, false); f.scroll(100);
  f.emit("pointermove", f.root, { buttons: 0 }); f.scroll(200);
  f.emit("keydown", f.root, { key: "a" }); f.scroll(300);
  const editor = new Scroller(f.root);
  editor.closest = () => editor;
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
  f.root.scrollTop = 150; // Compositor moves first; wheel and scroll callbacks follow.
  f.emit("wheel");
  f.emit("scroll");
  const gestures = (await f.events()).filter(e => e.kind === "scroll");
  assert.deepEqual(gestures.map(e => e.data), [{ direction: 1, distance_bucket: 1 }]);
});
