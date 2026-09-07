import type { SelfiePulseEstimate, SelfiePulseSample } from "./types";

// POS: Wang et al., doi:10.1109/TBME.2016.2609282. This is an independent
// implementation of the published temporal normalization/projection equations.
// These conservative engineering gates are NOT clinically validated thresholds.
const MIN_SECONDS = 20;
const MAX_SECONDS = 30;
const MAX_SAMPLES = 1801;
const MIN_FPS = 12;
const MAX_FPS = 60;
const POS_SECONDS = 1.6;
const MIN_BPM = 40;
const MAX_BPM = 220;
// Examine outside the accepted range as well, rather than folding an out-of-range
// maximum onto an apparently physiological boundary. Grid spacing is not accuracy.
const SPECTRUM_MIN_BPM = 30;
const SPECTRUM_MAX_BPM = 240;
const MAX_ROI_SPREAD_BPM = 6;
const MIN_CHROMATIC_FRACTION = 0.02;
const MIN_PULSE_RMS = 0.00001;

type Channels = readonly [Float64Array, Float64Array, Float64Array];

interface RegionPulse {
  signal: Float64Array;
  energy: number;
  bpm: number;
  quality: number;
}

function reject(
  reason: string,
  fps = 0,
  seconds = 0,
  quality = 0,
): SelfiePulseEstimate {
  return {
    heart_rate_bpm: null,
    signal_quality: quality,
    frames_per_second: fps,
    usable_seconds: seconds,
    reason,
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function removeLinearDrift(signal: Float64Array): number {
  const count = signal.length;
  const center = (count - 1) / 2;
  let sum = 0;
  let moment = 0;
  for (let i = 0; i < count; i += 1) {
    sum += signal[i];
    moment += (i - center) * signal[i];
  }
  const mean = sum / count;
  const slope = moment / (count * (count * count - 1) / 12);
  let energy = 0;
  for (let i = 0; i < count; i += 1) {
    const value = signal[i] - mean - slope * (i - center);
    signal[i] = value;
    energy += value * value;
  }
  return energy;
}

function extractPos(channels: Channels, fps: number): Float64Array | null {
  const [red, green, blue] = channels;
  const count = red.length;
  const width = Math.round(POS_SECONDS * fps);
  const pulse = new Float64Array(count);
  const first = new Float64Array(width);
  const second = new Float64Array(width);
  let redSum = 0;
  let greenSum = 0;
  let blueSum = 0;
  for (let i = 0; i < width; i += 1) {
    redSum += red[i];
    greenSum += green[i];
    blueSum += blue[i];
  }
  let normalizedEnergy = 0;
  let normalizedChromaticEnergy = 0;
  let rawEnergy = 0;
  let rawChromaticEnergy = 0;
  let usableWindows = 0;
  const windows = count - width + 1;
  for (let start = 0; start < windows; start += 1) {
    const redMean = redSum / width;
    const greenMean = greenSum / width;
    const blueMean = blueSum / width;
    let firstSum = 0;
    let secondSum = 0;
    let firstSquares = 0;
    let secondSquares = 0;
    for (let j = 0; j < width; j += 1) {
      const i = start + j;
      const rawRed = red[i] - redMean;
      const rawGreen = green[i] - greenMean;
      const rawBlue = blue[i] - blueMean;
      const r = rawRed / redMean;
      const g = rawGreen / greenMean;
      const b = rawBlue / blueMean;
      const common = (r + g + b) / 3;
      const rawCommon = (rawRed + rawGreen + rawBlue) / 3;
      normalizedEnergy += r * r + g * g + b * b;
      normalizedChromaticEnergy += (r - common) ** 2 + (g - common) ** 2 + (b - common) ** 2;
      rawEnergy += rawRed * rawRed + rawGreen * rawGreen + rawBlue * rawBlue;
      rawChromaticEnergy += (rawRed - rawCommon) ** 2 + (rawGreen - rawCommon) ** 2 + (rawBlue - rawCommon) ** 2;
      const x = g - b;
      const y = -2 * r + g + b;
      first[j] = x;
      second[j] = y;
      firstSum += x;
      secondSum += y;
      firstSquares += x * x;
      secondSquares += y * y;
    }
    const firstMean = firstSum / width;
    const secondMean = secondSum / width;
    const firstVariance = Math.max(0, firstSquares / width - firstMean * firstMean);
    const secondVariance = Math.max(0, secondSquares / width - secondMean * secondMean);
    // Do not stabilize a degenerate projection by inventing a denominator.
    if (firstVariance > 1e-12 && secondVariance > 1e-12) {
      const alpha = Math.sqrt(firstVariance / secondVariance);
      for (let j = 0; j < width; j += 1) {
        pulse[start + j] += first[j] - firstMean + alpha * (second[j] - secondMean);
      }
      usableWindows += 1;
    }
    if (start + width < count) {
      redSum += red[start + width] - red[start];
      greenSum += green[start + width] - green[start];
      blueSum += blue[start + width] - blue[start];
    }
  }
  // Multiplicative lighting is common-mode after normalization; additive flicker
  // is common-mode in raw RGB. Reject both, including tiny rounding residuals.
  // Chromatic lighting/motion can still imitate pulse: no camera-only algorithm
  // can identify every such artifact, and ROI agreement is not medical accuracy.
  if (
    usableWindows < windows * 0.95 ||
    normalizedEnergy <= 1e-12 ||
    rawEnergy <= 1e-12 ||
    normalizedChromaticEnergy / normalizedEnergy < MIN_CHROMATIC_FRACTION ||
    rawChromaticEnergy / rawEnergy < MIN_CHROMATIC_FRACTION
  ) {
    return null;
  }
  for (let i = 0; i < count; i += 1) {
    // Number of complete sliding windows covering this frame. Dividing the
    // overlap-add avoids an artificial envelope at the ends of the scan.
    const overlaps = Math.min(i, count - width) - Math.max(0, i - width + 1) + 1;
    pulse[i] /= overlaps;
  }
  return pulse;
}

function estimateRegion(
  signal: Float64Array,
  fps: number,
  hann: Float64Array,
): RegionPulse | string {
  const count = signal.length;
  const energy = removeLinearDrift(signal);
  if (!Number.isFinite(energy) || energy / count < MIN_PULSE_RMS ** 2) {
    return "The skin-color pulse is too weak. Try steady daylight and keep your face still.";
  }
  const windowed = new Float64Array(count);
  for (let i = 0; i < count; i += 1) windowed[i] = signal[i] * hann[i];
  const powers = new Float64Array(SPECTRUM_MAX_BPM - SPECTRUM_MIN_BPM + 1);
  let peakIndex = 0;
  let totalPower = 0;
  for (let bin = 0; bin < powers.length; bin += 1) {
    const frequency = (SPECTRUM_MIN_BPM + bin) / 60;
    const coefficient = 2 * Math.cos(2 * Math.PI * frequency / fps);
    let previous = 0;
    let beforePrevious = 0;
    // Goertzel evaluates this frequency without trig or allocations per sample.
    for (let i = 0; i < count; i += 1) {
      const current = windowed[i] + coefficient * previous - beforePrevious;
      beforePrevious = previous;
      previous = current;
    }
    const power = Math.max(0, previous * previous + beforePrevious * beforePrevious - coefficient * previous * beforePrevious);
    powers[bin] = power;
    totalPower += power;
    if (power > powers[peakIndex]) peakIndex = bin;
  }
  const peakBpm = SPECTRUM_MIN_BPM + peakIndex;
  const peakPower = powers[peakIndex];
  if (!Number.isFinite(totalPower) || totalPower <= 0 || peakBpm < MIN_BPM || peakBpm > MAX_BPM) {
    return "No clear pulse within the supported 40–220 bpm range. Rest, then retry in steady light.";
  }
  // A Hann main lobe spans roughly +/- 2/T Hz. Do not mistake its neighboring
  // bins for independent peaks. Noise and competitor checks use that resolution.
  const mainLobeBpm = Math.max(4, 120 * fps / count);
  let peakBandPower = 0;
  let competitorPower = 0;
  const background: number[] = [];
  for (let bin = 0; bin < powers.length; bin += 1) {
    if (Math.abs(bin - peakIndex) <= mainLobeBpm) {
      peakBandPower += powers[bin];
    } else {
      background.push(powers[bin]);
      if (powers[bin] > competitorPower) competitorPower = powers[bin];
    }
  }
  background.sort((a, b) => a - b);
  const noiseFloor = background[Math.floor(background.length / 2)];
  const prominence = peakPower / Math.max(noiseFloor, peakPower * 1e-12);
  const concentration = peakBandPower / totalPower;
  const competingRatio = competitorPower / peakPower;
  if (prominence < 8 || concentration < 0.45 || competingRatio > 0.4) {
    return "The pulse signal is noisy or has competing rhythms. Keep still and avoid flickering lights.";
  }
  // A dominant second harmonic can otherwise double the reported heart rate.
  // With a meaningful subharmonic, withhold rather than guess which is the pulse.
  if (peakBpm / 2 >= MIN_BPM) {
    let subharmonicPower = 0;
    for (let bin = 0; bin < powers.length; bin += 1) {
      if (Math.abs(SPECTRUM_MIN_BPM + bin - peakBpm / 2) <= mainLobeBpm) {
        subharmonicPower = Math.max(subharmonicPower, powers[bin]);
      }
    }
    if (subharmonicPower > peakPower * 0.15) {
      return "The pulse rhythm is ambiguous. Rest, hold still, and try another scan.";
    }
  }
  const lag = Math.round(60 * fps / peakBpm);
  let correlation = 0;
  let leftEnergy = 0;
  let rightEnergy = 0;
  for (let i = lag; i < count; i += 1) {
    correlation += signal[i] * signal[i - lag];
    leftEnergy += signal[i] * signal[i];
    rightEnergy += signal[i - lag] * signal[i - lag];
  }
  const periodicity = correlation / Math.sqrt(leftEnergy * rightEnergy);
  if (!Number.isFinite(periodicity) || periodicity < 0.35) {
    return "The pulse is not repeating clearly. Keep your face still in even light and retry.";
  }
  // Parabolic refinement reduces grid quantization only; it does not improve
  // the physical resolution or justify sub-bpm precision in the returned result.
  const left = powers[peakIndex - 1];
  const right = powers[peakIndex + 1];
  const curvature = left - 2 * peakPower + right;
  const offset = curvature < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (left - right) / curvature)) : 0;
  const bpm = peakBpm + offset;
  if (bpm < MIN_BPM || bpm > MAX_BPM) {
    return "The pulse is at the edge of the supported range. Rest, then retry.";
  }
  return {
    signal,
    energy,
    bpm,
    // An algorithmic signal score in [0,1], never an accuracy probability.
    quality: clamp01(
      0.4 * concentration +
      0.2 * (1 - competingRatio) +
      0.2 * clamp01(Math.log10(prominence) / 2) +
      0.2 * clamp01(periodicity),
    ),
  };
}

/**
 * Analyze three simultaneous forehead/cheek RGB means without retaining input.
 * All timestamps must be strictly increasing monotonic seconds. Only the recent
 * 30s (at most 1801 frames) is examined; old failures cannot poison a later scan.
 * Motion is normalized face-box displacement plus fractional scale change per
 * frame: reject a jump >0.08 or accumulated motion >0.30 per second. Clipping is
 * the fraction of sampled pixels with ANY channel near saturation/black: reject
 * any frame >2% or the window mean >0.5%. This is not the fraction of ROI means.
 * Rejected readings ALWAYS have null BPM. The score is algorithmic, not medical.
 */
export function analyzeSelfiePulse(samples: readonly SelfiePulseSample[]): SelfiePulseEstimate {
  if (samples.length < 2) return reject("Keep your face in view for at least 20 seconds.");
  const last = samples[samples.length - 1];
  if (!Number.isFinite(last.timestamp_seconds)) return reject("Camera timing is invalid. Restart the scan.");
  let start = samples.length - 1;
  const oldestAllowed = Math.max(0, samples.length - MAX_SAMPLES);
  while (start > oldestAllowed) {
    const timestamp = samples[start - 1].timestamp_seconds;
    if (!Number.isFinite(timestamp)) return reject("Camera timing is invalid. Restart the scan.");
    if (last.timestamp_seconds - timestamp > MAX_SECONDS) break;
    start -= 1;
  }
  const rawCount = samples.length - start;
  const seconds = last.timestamp_seconds - samples[start].timestamp_seconds;
  if (!Number.isFinite(seconds) || seconds <= 0) return reject("Camera timing is invalid. Restart the scan.");
  const intervals: number[] = [];
  let maxGap = 0;
  let totalMotion = 0;
  let totalClipped = 0;
  for (let i = start; i < samples.length; i += 1) {
    const sample = samples[i];
    if (
      !Number.isFinite(sample.timestamp_seconds) ||
      !Number.isFinite(sample.motion) || sample.motion < 0 ||
      !Number.isFinite(sample.clipped_fraction) || sample.clipped_fraction < 0 || sample.clipped_fraction > 1
    ) {
      return reject("Camera samples are invalid. Restart the scan.");
    }
    if (i > start) {
      const gap = sample.timestamp_seconds - samples[i - 1].timestamp_seconds;
      if (gap <= 0) return reject("Camera frames are duplicated or out of order. Restart the scan.");
      intervals.push(gap);
      maxGap = Math.max(maxGap, gap);
      // The first sample's motion compares with a frame outside this window.
      totalMotion += sample.motion;
      if (sample.motion > 0.08) return reject("Too much face movement. Hold the phone and your head steady.");
    }
    if (sample.clipped_fraction > 0.02) return reject("Parts of your face are too bright or dark. Use soft, even light.");
    totalClipped += sample.clipped_fraction;
    for (const region of sample.regions) {
      for (const channel of region) {
        if (!Number.isFinite(channel) || channel <= 5 || channel >= 250) {
          return reject("Skin colors are too dark, clipped, or invalid. Move into soft, even light.");
        }
      }
    }
  }
  if (seconds < MIN_SECONDS || intervals.length === 0) {
    return reject("Keep your face still and in view for at least 20 uninterrupted seconds.", (rawCount - 1) / seconds, seconds);
  }
  intervals.sort((a, b) => a - b);
  const medianInterval = intervals[Math.floor(intervals.length / 2)];
  const fps = (rawCount - 1) / seconds;
  if (fps < MIN_FPS || 1 / medianInterval < MIN_FPS || fps > MAX_FPS * 1.05) {
    return reject("Camera frame rate is unsuitable. Improve the light and close other camera apps.", fps, seconds);
  }
  if (maxGap > 0.2 || maxGap > medianInterval * 3) {
    return reject("Camera frames were interrupted. Keep the app visible and start a fresh steady scan.", fps, seconds);
  }
  if (totalMotion / seconds > 0.3) {
    return reject("Too much face movement. Hold the phone and your head steady.", fps, seconds);
  }
  if (totalClipped / rawCount > 0.005) {
    return reject("Too many skin pixels are clipped. Use soft, even light without glare.", fps, seconds);
  }
  // Uniform interpolation fixes modest camera jitter, never long gaps. Sampling
  // uses the observed mean rate (capped at 60Hz), not an invented camera rate.
  const count = Math.floor(seconds * Math.min(MAX_FPS, fps)) + 1;
  const uniformFps = (count - 1) / seconds;
  const channels: Channels[] = Array.from({ length: 3 }, () => [
    new Float64Array(count), new Float64Array(count), new Float64Array(count),
  ]);
  let rightIndex = start + 1;
  for (let i = 0; i < count; i += 1) {
    const timestamp = samples[start].timestamp_seconds + i / uniformFps;
    while (rightIndex < samples.length - 1 && samples[rightIndex].timestamp_seconds < timestamp) rightIndex += 1;
    const before = samples[rightIndex - 1];
    const after = samples[rightIndex];
    const fraction = clamp01((timestamp - before.timestamp_seconds) / (after.timestamp_seconds - before.timestamp_seconds));
    for (let region = 0; region < 3; region += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        const left = before.regions[region][channel];
        channels[region][channel][i] = left + fraction * (after.regions[region][channel] - left);
      }
    }
  }
  const hann = new Float64Array(count);
  for (let i = 0; i < count; i += 1) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (count - 1));
  const estimates: RegionPulse[] = [];
  for (const region of channels) {
    const pulse = extractPos(region, uniformFps);
    if (!pulse) {
      return reject("No distinct skin-color pulse: the signal is flat or dominated by lighting. Try steady daylight.", fps, seconds);
    }
    const estimate = estimateRegion(pulse, uniformFps, hann);
    if (typeof estimate === "string") return reject(estimate, fps, seconds);
    estimates.push(estimate);
  }
  const low = Math.min(...estimates.map((estimate) => estimate.bpm));
  const high = Math.max(...estimates.map((estimate) => estimate.bpm));
  if (high - low > MAX_ROI_SPREAD_BPM) {
    return reject("Forehead and cheeks disagree on the pulse. Keep still in even light and retry.", fps, seconds);
  }
  let weakestAgreement = 1;
  for (let left = 0; left < estimates.length; left += 1) {
    for (let right = left + 1; right < estimates.length; right += 1) {
      let cross = 0;
      for (let i = 0; i < count; i += 1) cross += estimates[left].signal[i] * estimates[right].signal[i];
      const agreement = cross / Math.sqrt(estimates[left].energy * estimates[right].energy);
      if (!Number.isFinite(agreement) || agreement < 0.45) {
        return reject("Skin regions do not share a stable pulse. Hold still and avoid uneven or flickering light.", fps, seconds);
      }
      weakestAgreement = Math.min(weakestAgreement, agreement);
    }
  }
  let bpmSum = 0;
  let qualitySum = 0;
  for (const estimate of estimates) {
    bpmSum += estimate.bpm;
    qualitySum += estimate.quality;
  }
  return {
    heart_rate_bpm: Math.round(bpmSum / estimates.length),
    signal_quality: clamp01(qualitySum / estimates.length * (0.8 + 0.2 * clamp01(weakestAgreement))),
    frames_per_second: fps,
    usable_seconds: seconds,
    reason: null,
  };
}
