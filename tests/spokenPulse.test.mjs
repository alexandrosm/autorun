import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSpokenPulse, SpokenBeatDetector } from "../src/spokenPulse.ts";

const window = { windowStartSeconds: 3, windowEndSeconds: 33 };
const syllable = [0.012, 0.035, 0.055, 0.045, 0.025, 0.012, 0.006, 0.002];

function regularOnsets(interval = 0.5, start = 0.2) {
  const onsets = [];
  for (let time = start; time < 29.8; time += interval) onsets.push(Math.round(time * 100) / 100);
  return onsets;
}

function recording(onsets = regularOnsets(), shape = syllable, noise = 0.001) {
  const frames = Array.from({ length: 3300 }, (_, i) => ({
    time_seconds: i / 100,
    rms: noise,
    clipped_fraction: 0,
  }));
  for (const onset of onsets) {
    const start = Math.round((3 + onset) * 100);
    for (let i = 0; i < shape.length && start + i < frames.length; i++) {
      frames[start + i].rms = Math.max(frames[start + i].rms, noise + shape[i]);
    }
  }
  // This brief start cue is intentionally louder than the spoken syllables.
  for (let i = 250; i < 260; i++) frames[i].rms = 0.2;
  return frames;
}

function assertOnsets(actual, expected) {
  assert.equal(actual.length, expected.length);
  actual.forEach((onset, index) => assert.ok(Math.abs(onset - expected[index]) < 1e-9,
    `onset ${index}: ${onset} instead of ${expected[index]}`));
}

function withheld(frames, reason, options = window) {
  const result = analyzeSpokenPulse(frames, options);
  assert.equal(result.estimated_bpm, null);
  assert.match(result.reason, reason);
  return result;
}

test("short spoken envelopes produce their onsets, and rate uses first-to-last intervals rather than window boundaries", () => {
  const onsets = regularOnsets(0.5, 0.43);
  const result = analyzeSpokenPulse(recording(onsets), window);
  assertOnsets(result.beat_offsets_seconds, onsets);
  assert.ok(Math.abs(result.estimated_bpm - 120) < 1e-9);
  assert.equal(result.reason, null);
  assert.notEqual(result.estimated_bpm, onsets.length * 60 / 30);
});

test("a syllable with a brief low-energy trough and a second peak is counted once", () => {
  const shape = [0.012, 0.04, 0.065, 0.04, 0.01, 0.001, 0.001, 0.001, 0.015, 0.03, 0.02, 0.008, 0.002];
  const onsets = regularOnsets();
  const result = analyzeSpokenPulse(recording(onsets, shape), window);
  assertOnsets(result.beat_offsets_seconds, onsets);
  assert.ok(Math.abs(result.estimated_bpm - 120) < 1e-9);
});

test("single-frame clicks and two-frame blips are not promoted into syllables", () => {
  const frames = recording();
  for (let i = 345; i < 3280; i += 50) {
    frames[i].rms = 0.09;
    frames[i + 1].rms = 0.09;
  }
  const result = analyzeSpokenPulse(frames, window);
  assertOnsets(result.beat_offsets_seconds, regularOnsets());
  assert.ok(Math.abs(result.estimated_bpm - 120) < 1e-9);
  const clicksOnly = recording([], syllable);
  for (let i = 330; i < 3280; i += 50) clicksOnly[i].rms = 0.1;
  assert.deepEqual(withheld(clicksOnly, /Too few distinct sounds/).beat_offsets_seconds, []);
});

test("live feedback waits for minimum support while retaining the first threshold-crossing time", () => {
  const detector = new SpokenBeatDetector(0.001);
  assert.equal(detector.push({ time_seconds: 0, rms: 0.02, clipped_fraction: 0 }), false);
  assert.equal(detector.push({ time_seconds: 0.01, rms: 0.04, clipped_fraction: 0 }), false);
  assert.equal(detector.push({ time_seconds: 0.02, rms: 0.03, clipped_fraction: 0 }), true);
  assert.deepEqual(detector.beatOffsetsSeconds, [0]);
});

test("modest human timing variation remains visible instead of being regularized", () => {
  const onsets = regularOnsets().map((time, index) => Math.round((time + 0.025 * Math.sin(index * 0.8)) * 100) / 100);
  const result = analyzeSpokenPulse(recording(onsets), window);
  assertOnsets(result.beat_offsets_seconds, onsets);
  assert.equal(result.reason, null);
  assert.equal(result.estimated_bpm, 60 * (onsets.length - 1)
    / (result.beat_offsets_seconds.at(-1) - result.beat_offsets_seconds[0]));
});

test("a gradual cadence decline is accepted without deleting beats or forcing a constant rhythm", () => {
  const onsets = [];
  for (let time = 0.2; time < 29.7; time += 0.34 + 0.01 * time) onsets.push(Math.round(time * 100) / 100);
  const result = analyzeSpokenPulse(recording(onsets), window);
  assertOnsets(result.beat_offsets_seconds, onsets);
  assert.equal(result.reason, null);
  assert.ok(Math.abs(result.estimated_bpm - 60 * (onsets.length - 1) / (onsets.at(-1) - onsets[0])) < 1e-9);
});

test("calibrated background noise and the excluded start cue do not count as syllables", () => {
  const onsets = regularOnsets();
  const result = analyzeSpokenPulse(recording(onsets, syllable, 0.012), window);
  assertOnsets(result.beat_offsets_seconds, onsets.map(time => time + 0.01));
  assert.ok(Math.abs(result.estimated_bpm - 120) < 1e-9);
  const quiet = recording([]);
  for (let i = 300; i < quiet.length; i++) quiet[i].rms = 0.001 + 0.002 * (1 + Math.sin(i * 1.73));
  withheld(quiet, /Too few distinct sounds/);
});

test("silence, an unusable calibration and continuous post-calibration noise withhold estimates", () => {
  withheld(recording([]), /Too few distinct sounds/);
  withheld(recording(regularOnsets(), syllable, 0.05), /calibration was too loud or variable/);
  const contaminated = recording();
  for (let i = 90; i < 130; i++) contaminated[i].rms = 0.06;
  withheld(contaminated, /calibration was too loud or variable/);
  const continuous = recording([]);
  for (let i = 300; i < continuous.length; i++) continuous[i].rms = 0.04;
  withheld(continuous, /sustained/);
});

test("long sustained syllables and excessive sound occupancy are rejected even with regular starts", () => {
  withheld(recording(regularOnsets(0.75), Array(48).fill(0.04)), /sustained/);
  withheld(recording(regularOnsets(0.5), Array(32).fill(0.04)), /too much continuous sound/);
});

test("clipped syllables with otherwise regular spacing retain onsets but withhold a rate", () => {
  const clipped = recording();
  clipped[1022].clipped_fraction = 0.05;
  assertOnsets(withheld(clipped, /microphone signal clipped/).beat_offsets_seconds, regularOnsets());
  const repeatedClipping = recording();
  for (const frame of repeatedClipping) if (frame.rms > 0.01) frame.clipped_fraction = 0.005;
  withheld(repeatedClipping, /microphone signal clipped/);
});

test("an internal audio gap or incomplete window cannot be accepted as a clean cadence", () => {
  const gap = recording();
  gap.splice(1410, 10);
  withheld(gap, /gap or timing discontinuity/);
  withheld(recording().slice(0, 3270), /full measurement window/);
  const calibrationGap = recording();
  calibrationGap.splice(100, 10);
  withheld(calibrationGap, /calibration was incomplete/);
});

test("an early stop and an interruption retain detected evidence without offering a rate", () => {
  const early = withheld(recording().slice(0, 1500), /complete 30-second measurement/,
    { windowStartSeconds: 3, windowEndSeconds: 15 });
  assertOnsets(early.beat_offsets_seconds, regularOnsets().filter(time => time < 12));
  const interrupted = withheld(recording(), /recording was interrupted/, { ...window, interrupted: true });
  assertOnsets(interrupted.beat_offsets_seconds, regularOnsets());
});

test("out-of-range cadence is withheld rather than clamped or folded into a plausible rate", () => {
  withheld(recording(regularOnsets(0.2)), /outside the supported 40–220/);
  withheld(recording(regularOnsets(1.6)), /outside the supported 40–220/);
  withheld(recording(regularOnsets(0.15), [0.025, 0.04, 0.02]), /too close together/);
});

test("frame quantization at the supported cadence boundaries does not become false irregularity", () => {
  for (const bpm of [40, 220]) {
    const onsets = regularOnsets(60 / bpm);
    const result = analyzeSpokenPulse(recording(onsets), window);
    assertOnsets(result.beat_offsets_seconds, onsets);
    assert.equal(result.reason, null);
    assert.ok(Math.abs(result.estimated_bpm - bpm) < 0.1);
  }
});

test("missing or extra spoken beats are not silently repaired", () => {
  const missing = regularOnsets();
  missing.splice(24, 1);
  assertOnsets(withheld(recording(missing), /spacing changed abruptly/).beat_offsets_seconds, missing);
  const extra = regularOnsets();
  extra.splice(24, 0, extra[23] + 0.25);
  assertOnsets(withheld(recording(extra), /outside the supported 40–220/).beat_offsets_seconds, extra);
});

test("excessively irregular spacing within the rate range does not become a single estimate", () => {
  const onsets = [0.2];
  while (onsets.at(-1) < 29) {
    const interval = onsets.length % 2 ? 0.45 : 0.6;
    onsets.push(Math.round((onsets.at(-1) + interval) * 100) / 100);
  }
  assertOnsets(withheld(recording(onsets), /too irregular/).beat_offsets_seconds, onsets);
});

test("a short block of otherwise regular sounds cannot stand in for the whole window", () => {
  withheld(recording(regularOnsets().filter(time => time >= 4 && time <= 26)), /did not cover enough/);
});

test("malformed and out-of-order frames cannot contribute to an accepted estimate", () => {
  const invalid = recording();
  invalid[1100].rms = NaN;
  withheld(invalid, /invalid values or out-of-order/);
  const reversed = recording();
  [reversed[1200], reversed[1201]] = [reversed[1201], reversed[1200]];
  withheld(reversed, /invalid values or out-of-order/);
});
