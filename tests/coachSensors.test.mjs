import test from "node:test";
import assert from "node:assert/strict";
import { CoachSensorRecorder } from "../src/coachSensors.ts";

function fixture() {
  const originals = Object.fromEntries(["window", "document", "performance"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let clock = 1000;
  const host = Object.assign(new EventTarget(), {
    DeviceMotionEvent: class {},
    DeviceOrientationEvent: class { static requestPermission = async () => "granted"; },
    setInterval: () => 1,
    clearInterval: () => {},
  });
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const context = { screen: "live", run_id: "fixture_run", elapsed_seconds: 0 };
  const rows = [];
  let motionPermission = "ready";
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: host },
    document: { configurable: true, value: document },
    performance: { configurable: true, value: { now: () => clock, timeOrigin: Date.now() - 1000 } },
  });
  const sensor = new CoachSensorRecorder({
    getContext: () => context,
    getMotionPermission: () => motionPermission,
    sink: { record() {}, sensor: (type, columns, units, row) => rows.push({ type, columns, units, row }) },
    onSummary() {},
  });
  return {
    sensor, rows, host, document, context,
    motionPermission(value) { motionPermission = value; },
    at(value) { clock = value; context.elapsed_seconds = (clock - 1000) / 1000; },
    emit(type, values, timestamp = clock) {
      const event = Object.assign(new Event(type), values);
      Object.defineProperty(event, "timeStamp", { value: timestamp });
      host.dispatchEvent(event);
    },
    close() {
      sensor.stop();
      for (const [key, descriptor] of Object.entries(originals)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}

const movement = { acceleration: { x: 1, y: 0, z: null }, accelerationIncludingGravity: null, rotationRate: null, interval: 20 };

test("denied permissions withhold even delivered motion and orientation events", async () => {
  const f = fixture();
  try {
    f.host.DeviceOrientationEvent.requestPermission = async () => "denied";
    f.motionPermission("denied");
    await f.sensor.requestPermissions();
    f.sensor.start();
    f.at(1100);
    f.emit("deviceorientation", { alpha: 15, beta: 2, gamma: 1, absolute: false });
    f.emit("devicemotion", movement);
    assert.deepEqual(f.rows, []);
    assert.equal(f.sensor.snapshot().orientation.status, "denied");
    assert.equal(f.sensor.snapshot().motion.status, "denied");
  } finally { f.close(); }
});

test("hidden, pre-resume queued and stopped samples never enter a run's raw stream", () => {
  const f = fixture();
  try {
    f.sensor.start();
    f.at(1100); f.emit("devicemotion", movement);
    f.document.visibilityState = "hidden";
    f.document.dispatchEvent(new Event("visibilitychange"));
    f.at(2100); f.emit("devicemotion", movement);
    f.document.visibilityState = "visible";
    f.document.dispatchEvent(new Event("visibilitychange"));
    f.at(2200); f.emit("devicemotion", movement, 2050);
    f.at(2300); f.emit("devicemotion", movement);
    f.sensor.stop();
    f.at(2400); f.emit("devicemotion", movement);
    assert.deepEqual(f.rows.map(value => value.row[0]), [0.1, 1.3]);
    const gap = f.sensor.snapshot().motion.gaps.find(value => value.reason === "hidden");
    assert.equal(gap.start.elapsed_seconds, 0.1);
    assert.equal(gap.end.elapsed_seconds, 1.1);
  } finally { f.close(); }
});

test("null-only events do not claim measurements and the raw motion rate is bounded", () => {
  const f = fixture();
  try {
    f.sensor.start();
    f.at(1100); f.emit("devicemotion", { acceleration: null, accelerationIncludingGravity: null, rotationRate: null, interval: 20 });
    assert.equal(f.sensor.snapshot().motion.samples, 0);
    assert.equal(f.sensor.snapshot().motion.null_events, 1);
    assert.equal(f.sensor.snapshot().motion.actual_rate_hz, null);
    f.at(1150); f.emit("devicemotion", movement);
    f.at(1170); f.emit("devicemotion", movement);
    f.at(1200); f.emit("devicemotion", movement);
    assert.equal(f.rows.length, 3);
    assert.deepEqual(f.rows[1].row.slice(2, 5), [1, 0, null]);
    assert.equal(f.sensor.snapshot().motion.actual_rate_hz, 20);
  } finally { f.close(); }
});

test("a late permission completion cannot reactivate a stopped sensor session", async () => {
  const f = fixture();
  try {
    const gate = Promise.withResolvers();
    f.host.DeviceOrientationEvent.requestPermission = () => gate.promise;
    const request = f.sensor.requestPermissions();
    f.sensor.start();
    f.sensor.stop();
    gate.resolve("granted");
    await request;
    f.at(1100); f.emit("deviceorientation", { alpha: 15, beta: 2, gamma: 1 });
    assert.deepEqual(f.rows, []);
    assert.equal(f.sensor.snapshot().recording, false);
    assert.notEqual(f.sensor.snapshot().orientation.permission, "granted");
  } finally { f.close(); }
});
