import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSelfiePulse } from "../src/selfiePulse.ts";

function samples(bpms = [153, 153, 153]) {
  const colors = [[150, 110, 85], [142, 98, 77], [157, 115, 92]];
  return Array.from({ length: 751 }, (_, i) => {
    const timestamp = i / 30 + 0.002 * Math.sin(i * 0.7);
    return {
      timestamp_seconds: timestamp,
      regions: colors.map((color, region) => {
        const wave = Math.sin(2 * Math.PI * bpms[region] / 60 * timestamp);
        return color.map((channel, index) => channel + [0.08, 0.7, 0.2][index] * wave);
      }),
      motion: 0,
      clipped_fraction: 0,
    };
  });
}

function withheld(input) {
  const estimate = analyzeSelfiePulse(input);
  assert.equal(estimate.heart_rate_bpm, null);
  assert.equal(typeof estimate.reason, "string");
}

test("modest frame jitter preserves the common pulse across different skin regions", () => {
  const estimate = analyzeSelfiePulse(samples());
  assert.ok(Math.abs(estimate.heart_rate_bpm - 153) <= 1, JSON.stringify(estimate));
  assert.equal(estimate.reason, null);
});

test("flat colors and common-mode lighting cannot masquerade as a physiological pulse", () => {
  for (const lighting of ["flat", "additive", "multiplicative"]) {
    const input = samples();
    for (const sample of input) {
      const wave = Math.sin(2 * Math.PI * 1.8 * sample.timestamp_seconds);
      sample.regions = [[150, 110, 85], [142, 98, 77], [157, 115, 92]].map(region =>
        region.map(channel => lighting === "flat" ? channel : lighting === "additive" ? channel + 4 * wave : channel * (1 + 0.02 * wave)));
    }
    withheld(input);
  }
});

test("incompatible regional rhythms and out-of-range peaks are withheld rather than averaged or clamped", () => {
  withheld(samples([72, 110, 153]));
  withheld(samples([35, 35, 35]));
  withheld(samples([235, 235, 235]));
});

test("a plausible rhythm is not accepted across interrupted frames, movement or clipped pixels", () => {
  const gap = samples();
  gap.splice(340, 12);
  withheld(gap);
  const moving = samples();
  moving[400].motion = 0.12;
  withheld(moving);
  const clipped = samples();
  clipped[400].clipped_fraction = 0.1;
  withheld(clipped);
});

test("independent color noise cannot produce a reported pulse", () => {
  let seed = 19237;
  const noise = () => {
    seed = Math.imul(seed, 1664525) + 1013904223 | 0;
    return (seed >>> 0) / 4294967296 - 0.5;
  };
  const input = samples();
  for (const sample of input) sample.regions = sample.regions.map(region => region.map(channel => channel + 6 * noise()));
  withheld(input);
});
