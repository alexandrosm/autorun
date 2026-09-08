export interface SpokenPulseFrame {
  time_seconds: number;
  rms: number;
  clipped_fraction: number;
}

export interface SpokenPulseEstimate {
  beat_offsets_seconds: number[];
  estimated_bpm: number | null;
  reason: string | null;
}

// Engineering gates for short spoken syllables, not validated physiological limits.
const MIN_SOUND_SECONDS = 0.02;
const QUIET_RESET_SECONDS = 0.07;
const REFRACTORY_SECONDS = 0.18;
const MAX_SOUND_SECONDS = 0.4;
const MAX_FRAME_GAP_SECONDS = 0.06;
const MAX_FRAMES = 4000;
const MAX_ONSETS = 160;
const EPSILON = 1e-7;

function validFrame(frame: SpokenPulseFrame): boolean {
  return Number.isFinite(frame.time_seconds) && Number.isFinite(frame.rms)
    && frame.rms >= 0 && frame.rms <= 1
    && Number.isFinite(frame.clipped_fraction)
    && frame.clipped_fraction >= 0 && frame.clipped_fraction <= 1;
}

/** Detects sound energy onsets only. It cannot identify a heartbeat or a word. */
export class SpokenBeatDetector {
  readonly beatOffsetsSeconds: number[] = [];
  private readonly onThreshold: number;
  private readonly offThreshold: number;
  private previousTime: number | null = null;
  private soundStart: number | null = null;
  private quietStart: number | null = null;
  private counted = false;
  private failureReason: string | null = null;

  constructor(noiseRms: number) {
    const noise = Number.isFinite(noiseRms) && noiseRms >= 0 ? noiseRms : 0;
    this.onThreshold = Math.max(0.008, noise * 3.5);
    this.offThreshold = Math.max(0.004, noise * 1.8);
    if (noise !== noiseRms) this.failureReason = "The background sound calibration was invalid.";
  }

  // The final analyzer also checks coverage, clipping and spacing. Live onsets
  // remain provisional even when this local detector has no reason to withhold.
  get reason(): string | null {
    return this.failureReason;
  }

  push(frame: SpokenPulseFrame): boolean {
    if (!validFrame(frame)) {
      this.failureReason ??= "The sound samples contained invalid values.";
      return false;
    }
    const time = frame.time_seconds;
    if (this.previousTime !== null && (time <= this.previousTime
      || time - this.previousTime > MAX_FRAME_GAP_SECONDS + EPSILON)) {
      this.failureReason ??= "There was a gap or timing discontinuity in the sound samples.";
      this.soundStart = null;
      this.quietStart = null;
      this.counted = false;
    }
    this.previousTime = time;

    if (this.soundStart !== null && frame.rms < this.offThreshold) {
      // A click shorter than the minimum syllable duration never becomes a beat.
      if (!this.counted) {
        this.soundStart = null;
      } else {
        this.quietStart ??= time;
        if (time - this.quietStart >= QUIET_RESET_SECONDS - EPSILON) {
          this.soundStart = null;
          this.quietStart = null;
          this.counted = false;
        }
      }
      return false;
    }

    if (this.soundStart === null) {
      if (frame.rms < this.onThreshold) return false;
      this.soundStart = time;
      this.quietStart = null;
      this.counted = false;
    } else {
      this.quietStart = null;
    }

    if (time - this.soundStart > MAX_SOUND_SECONDS + EPSILON) {
      this.failureReason ??= "Some sounds were sustained rather than separated short syllables.";
    }
    if (this.counted || time - this.soundStart < MIN_SOUND_SECONDS - EPSILON) return false;
    this.counted = true;
    const previousOnset = this.beatOffsetsSeconds[this.beatOffsetsSeconds.length - 1];
    if (previousOnset !== undefined && this.soundStart - previousOnset < REFRACTORY_SECONDS - EPSILON) {
      // Never silently turn a rapid sequence into a plausible half-rate result.
      this.failureReason ??= "Some sound onsets were too close together to separate reliably.";
      return false;
    }
    if (this.beatOffsetsSeconds.length >= MAX_ONSETS) {
      this.failureReason ??= "There were too many sound onsets in this capture.";
      return false;
    }
    this.beatOffsetsSeconds.push(this.soundStart);
    return true;
  }
}

/**
 * Estimate the cadence of spoken sounds during the fixed 30-second window.
 * Calibration is recording time 0.4–2 seconds; the start cue at 2.5 is excluded.
 * Neither a regular cadence nor these gates establish that sounds matched a pulse.
 */
export function analyzeSpokenPulse(
  frames: readonly SpokenPulseFrame[],
  options: { windowStartSeconds: number; windowEndSeconds: number; interrupted?: boolean },
): SpokenPulseEstimate {
  const { windowStartSeconds: start, windowEndSeconds: end } = options;
  const duration = end - start;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 3 || duration <= 0) {
    return { beat_offsets_seconds: [], estimated_bpm: null, reason: "The measurement window was invalid." };
  }
  if (frames.length > MAX_FRAMES) {
    return { beat_offsets_seconds: [], estimated_bpm: null, reason: "The capture exceeded the supported sound sample limit." };
  }

  const calibration: number[] = [];
  let calibrationFirst = Infinity;
  let calibrationLast = -Infinity;
  let calibrationGap = false;
  let invalid = false;
  let previousTime = -Infinity;
  for (const frame of frames) {
    const valid = validFrame(frame);
    if (!valid || frame.time_seconds <= previousTime) invalid = true;
    previousTime = frame.time_seconds;
    if (!valid || frame.time_seconds < 0.4 || frame.time_seconds > 2) continue;
    calibration.push(frame.rms);
    if (Number.isFinite(calibrationLast) && frame.time_seconds - calibrationLast > MAX_FRAME_GAP_SECONDS + EPSILON) {
      calibrationGap = true;
    }
    calibrationFirst = Math.min(calibrationFirst, frame.time_seconds);
    calibrationLast = frame.time_seconds;
  }
  calibration.sort((a, b) => a - b);
  const percentile = (fraction: number) => calibration[Math.floor((calibration.length - 1) * fraction)] ?? 0;
  const noise = percentile(0.8);
  const detector = new SpokenBeatDetector(noise);
  let first = Infinity;
  let last = -Infinity;
  let measurementFrames = 0;
  let loudFrames = 0;
  let clipped = false;
  let clippedTotal = 0;
  const quietThreshold = Math.max(0.004, noise * 1.8);
  const relativeFrame: SpokenPulseFrame = { time_seconds: 0, rms: 0, clipped_fraction: 0 };
  for (const frame of frames) {
    if (!validFrame(frame) || frame.time_seconds < start || frame.time_seconds >= end) continue;
    first = Math.min(first, frame.time_seconds);
    last = frame.time_seconds;
    measurementFrames++;
    if (frame.rms >= quietThreshold) loudFrames++;
    if (frame.clipped_fraction >= 0.02) clipped = true;
    clippedTotal += frame.clipped_fraction;
    relativeFrame.time_seconds = frame.time_seconds - start;
    relativeFrame.rms = frame.rms;
    relativeFrame.clipped_fraction = frame.clipped_fraction;
    detector.push(relativeFrame);
  }
  const onsets = detector.beatOffsetsSeconds;
  const reject = (reason: string): SpokenPulseEstimate => ({
    beat_offsets_seconds: onsets, estimated_bpm: null, reason,
  });
  if (options.interrupted) return reject("The recording was interrupted; no rate estimate is offered.");
  if (duration < 29.9 || duration > 30.1) return reject("A complete 30-second measurement is required for a rate estimate.");
  if (invalid) return reject("The sound samples contained invalid values or out-of-order times.");
  if (calibration.length < 100 || calibrationFirst > 0.45 || calibrationLast < 1.95 || calibrationGap) {
    return reject("The initial quiet background calibration was incomplete.");
  }
  if (noise > 0.035 || percentile(0.9) > Math.max(0.012, percentile(0.5) * 4)) {
    return reject("The initial calibration was too loud or variable; try a quieter setting and stay silent before the start cue.");
  }
  if (measurementFrames < 2500 || first > start + 0.06 || last < end - 0.08) {
    return reject("Sound samples did not cover the full measurement window.");
  }
  if (clipped || clippedTotal / measurementFrames > 0.0005) {
    return reject("The microphone signal clipped; try speaking more softly or moving the phone farther away.");
  }
  if (detector.reason) return reject(detector.reason);
  if (loudFrames / measurementFrames > 0.55) {
    return reject("There was too much continuous sound to separate short syllables reliably.");
  }
  if (onsets.length < 15) return reject("Too few distinct sounds were detected above the background noise.");
  const span = onsets[onsets.length - 1] - onsets[0];
  if (onsets[0] > 1.6 || duration - onsets[onsets.length - 1] > 1.6 || span < duration * 0.85) {
    return reject("Separated sounds did not cover enough of the measurement window.");
  }
  let previousInterval = 0;
  let squaredChanges = 0;
  for (let i = 1; i < onsets.length; i++) {
    const interval = onsets[i] - onsets[i - 1];
    // A 10ms energy frame quantizes each onset; allow one frame of interval
    // uncertainty, then check the much less quantized whole-span rate below.
    if (interval < 60 / 220 - 0.01 - EPSILON || interval > 60 / 40 + 0.01 + EPSILON) {
      return reject("Some sound intervals were outside the supported 40–220 per-minute range; no beats were added or removed.");
    }
    if (i > 1) {
      if (Math.max(interval, previousInterval) / Math.min(interval, previousInterval) > 1.45) {
        return reject("Sound spacing changed abruptly, possibly from missed or extra syllables; no beats were added or removed.");
      }
      const change = (interval - previousInterval) / ((interval + previousInterval) / 2);
      squaredChanges += change * change;
    }
    previousInterval = interval;
  }
  if (Math.sqrt(squaredChanges / (onsets.length - 2)) > 0.18) {
    return reject("Sound spacing was too irregular for a single rate estimate.");
  }
  const bpm = 60 * (onsets.length - 1) / span;
  if (bpm < 39.9 || bpm > 220.1) {
    return reject("The sound cadence was outside the supported 40–220 per-minute range.");
  }
  return {
    beat_offsets_seconds: onsets,
    estimated_bpm: bpm,
    reason: null,
  };
}
