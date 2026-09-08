import type { CaptureContext, CaptureSink, SensorBatch } from "./captureTypes";

type SensorKind = SensorBatch["type"];
type SensorPermission = "unsupported" | "managed_by_app" | "not_required" | "not_requested" | "pending" | "granted" | "denied" | "error";
type GapReason = "hidden" | "stopped" | "no_samples" | "sensor_error";

interface SampleTime {
  timestamp_utc_ms: number;
  elapsed_seconds: number | null;
}

interface SensorGap {
  reason: GapReason;
  start: SampleTime;
  end: SampleTime | null;
}

interface SensorSummary {
  supported: boolean;
  permission: SensorPermission;
  status: "unsupported" | "denied" | "error" | "paused" | "stopped" | "no_samples" | "sampling";
  events_seen: number;
  // Null-only events among the rate-limited rows; metadata is not a measurement.
  null_events: number;
  samples: number;
  first_sample: SampleTime | null;
  last_sample: SampleTime | null;
  // Non-null sample intervals / their monotonic duration, within foreground segments.
  actual_rate_hz: number | null;
  gaps: SensorGap[];
  gap_count: number;
  dropped_gaps: number;
  error_name: string | null;
}

export interface CoachSensorSummary {
  measurement_scope: "phone_movement_orientation_and_ambient_light";
  run_id: string | null;
  started_at_utc_ms: number | null;
  stopped_at_utc_ms: number | null;
  recording: boolean;
  foreground_seconds: number;
  motion: SensorSummary;
  orientation: SensorSummary;
  ambient_light: SensorSummary;
}

interface Options {
  getContext: () => CaptureContext;
  sink: CaptureSink;
  onSummary: (summary: CoachSensorSummary) => void;
  getMotionPermission?: () => "unknown" | "ready" | "denied" | "unavailable";
}

interface PermissionConstructor {
  requestPermission?: () => Promise<string>;
}

interface LightSensor extends EventTarget {
  illuminance: number | null;
  timestamp: number | null;
  start(): void;
  stop(): void;
}

type SensorWindow = Window & {
  DeviceMotionEvent?: PermissionConstructor;
  DeviceOrientationEvent?: PermissionConstructor;
  AmbientLightSensor?: new (options: { frequency: number }) => LightSensor;
};

interface SensorState {
  supported: boolean;
  permission: SensorPermission;
  events: number;
  nullEvents: number;
  samples: number;
  first: SampleTime | null;
  last: SampleTime | null;
  lastStoredMono: number;
  previousSampleMono: number | null;
  sampleIntervals: number;
  sampleDurationMs: number;
  waitingSinceMono: number;
  waitingSince: SampleTime | null;
  gaps: SensorGap[];
  gapCount: number;
  droppedGaps: number;
  openGap: SensorGap | null;
  errorName: string | null;
}

const KINDS: SensorKind[] = ["motion", "orientation", "ambient_light"];
const COLUMNS: Record<SensorKind, string[]> = {
  motion: ["elapsed_seconds", "timestamp_utc_ms", "acceleration_x", "acceleration_y", "acceleration_z", "acceleration_including_gravity_x", "acceleration_including_gravity_y", "acceleration_including_gravity_z", "rotation_rate_alpha", "rotation_rate_beta", "rotation_rate_gamma", "reported_interval_ms"],
  orientation: ["elapsed_seconds", "timestamp_utc_ms", "alpha", "beta", "gamma", "absolute", "compass_heading", "compass_accuracy"],
  ambient_light: ["elapsed_seconds", "timestamp_utc_ms", "illuminance"],
};
const UNITS: Record<SensorKind, string[]> = {
  motion: ["s", "ms_since_unix_epoch", "m/s^2", "m/s^2", "m/s^2", "m/s^2", "m/s^2", "m/s^2", "deg/s", "deg/s", "deg/s", "ms"],
  orientation: ["s", "ms_since_unix_epoch", "deg", "deg", "deg", "boolean_0_or_1", "deg", "deg"],
  ambient_light: ["s", "ms_since_unix_epoch", "lux"],
};
const MIN_INTERVAL: Record<SensorKind, number> = { motion: 50, orientation: 200, ambient_light: 1000 };
const SILENCE_INTERVAL: Record<SensorKind, number> = { motion: 2000, orientation: 2000, ambient_light: 10000 };
const MAX_GAPS = 24;

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function makeState(supported: boolean, permission: SensorPermission): SensorState {
  return {
    supported, permission, events: 0, nullEvents: 0, samples: 0, first: null, last: null,
    lastStoredMono: -Infinity, waitingSinceMono: 0, waitingSince: null,
    previousSampleMono: null, sampleIntervals: 0, sampleDurationMs: 0,
    gaps: [], gapCount: 0, droppedGaps: 0, openGap: null, errorName: null,
  };
}

/** Foreground phone measurements, not gait, impact force, or medical measurements. */
export class CoachSensorRecorder {
  private options: Options;
  private host: SensorWindow | null;
  private states: Record<SensorKind, SensorState>;
  private runId: string | null = null;
  private startedAt: number | null = null;
  private stoppedAt: number | null = null;
  private active = false;
  private listening = false;
  private foregroundMs = 0;
  private foregroundStart: number | null = null;
  private timer: number | undefined;
  private light: LightSensor | null = null;
  private permissionGeneration = 0;
  private permissionRequest: Promise<void> | null = null;

  constructor(options: Options) {
    this.options = options;
    this.host = typeof window === "undefined" ? null : window as SensorWindow;
    const motion = this.host?.DeviceMotionEvent;
    const orientation = this.host?.DeviceOrientationEvent;
    const light = typeof this.host?.AmbientLightSensor === "function";
    this.states = {
      motion: makeState(Boolean(motion), !motion ? "unsupported" : motion.requestPermission ? "managed_by_app" : "not_required"),
      orientation: makeState(Boolean(orientation), !orientation ? "unsupported" : orientation.requestPermission ? "not_requested" : "not_required"),
      ambient_light: makeState(light, light ? "not_requested" : "unsupported"),
    };
  }

  requestPermissions(): Promise<void> {
    if (this.permissionRequest) return this.permissionRequest;
    const constructor = this.host?.DeviceOrientationEvent;
    if (!constructor?.requestPermission) {
      this.publish();
      return Promise.resolve();
    }
    const generation = ++this.permissionGeneration;
    this.states.orientation.permission = "pending";
    // Invoke before any await: iOS requires the original Start gesture's activation.
    let request: Promise<string>;
    try {
      request = constructor.requestPermission();
    } catch (error) {
      this.permissionResult(generation, "error", error);
      return Promise.resolve();
    }
    this.publish();
    this.permissionRequest = Promise.resolve(request).then(
      (result) => this.permissionResult(generation, result === "granted" ? "granted" : "denied"),
      (error: unknown) => this.permissionResult(generation, "error", error),
    ).finally(() => {
      if (generation === this.permissionGeneration) this.permissionRequest = null;
    });
    return this.permissionRequest;
  }

  start(): void {
    const context = this.options.getContext();
    if (!this.host || !context.run_id) return;
    if (this.active && this.runId === context.run_id) return;
    if (this.active) this.stop();
    if (this.runId !== context.run_id) {
      for (const kind of KINDS) {
        const previous = this.states[kind];
        this.states[kind] = makeState(previous.supported, previous.permission);
      }
      this.runId = context.run_id;
      this.startedAt = Date.now();
      this.foregroundMs = 0;
    }
    this.active = true;
    this.stoppedAt = null;
    document.addEventListener("visibilitychange", this.visibilityChanged);
    if (document.visibilityState === "visible") this.attach();
    else this.pauseGaps("hidden");
    this.timer = this.host.setInterval(() => {
      if (!this.validContext()) return;
      this.checkSilence();
      this.publish();
    }, 5000);
    this.publish();
  }

  stop(): void {
    // Invalidate pending permission completions, even if start() never ran.
    this.permissionGeneration += 1;
    this.permissionRequest = null;
    if (this.states.orientation.permission === "pending") this.states.orientation.permission = "not_requested";
    if (!this.active) return;
    this.checkSilence();
    this.detach();
    document.removeEventListener("visibilitychange", this.visibilityChanged);
    this.host?.clearInterval(this.timer);
    this.timer = undefined;
    this.pauseGaps("stopped");
    this.active = false;
    this.stoppedAt = Date.now();
    this.publish();
  }

  snapshot(): CoachSensorSummary {
    const foregroundSeconds = (this.foregroundMs + (this.foregroundStart === null ? 0 : Math.max(0, performance.now() - this.foregroundStart))) / 1000;
    const summary = (kind: SensorKind): SensorSummary => {
      const state = this.states[kind];
      const appPermission = kind === "motion" ? this.options.getMotionPermission?.() : undefined;
      const permission: SensorPermission = appPermission === undefined ? state.permission
        : appPermission === "ready" ? "granted" : appPermission === "denied" ? "denied"
        : appPermission === "unavailable" ? "unsupported" : "not_requested";
      return {
        supported: state.supported,
        permission,
        status: !state.supported ? "unsupported" : permission === "denied" ? "denied" : state.errorName ? "error" : !this.active ? "stopped" : !this.listening ? "paused" : state.previousSampleMono === null || state.openGap ? "no_samples" : "sampling",
        events_seen: state.events, null_events: state.nullEvents, samples: state.samples,
        first_sample: state.first ? { ...state.first } : null,
        last_sample: state.last ? { ...state.last } : null,
        actual_rate_hz: state.sampleDurationMs > 0 ? state.sampleIntervals * 1000 / state.sampleDurationMs : null,
        gaps: state.gaps.map((gap) => ({ reason: gap.reason, start: { ...gap.start }, end: gap.end ? { ...gap.end } : null })),
        gap_count: state.gapCount, dropped_gaps: state.droppedGaps, error_name: state.errorName,
      };
    };
    return {
      measurement_scope: "phone_movement_orientation_and_ambient_light",
      run_id: this.runId, started_at_utc_ms: this.startedAt, stopped_at_utc_ms: this.stoppedAt,
      recording: this.active && this.listening, foreground_seconds: foregroundSeconds,
      motion: summary("motion"), orientation: summary("orientation"), ambient_light: summary("ambient_light"),
    };
  }

  private permissionResult(generation: number, result: SensorPermission, error?: unknown): void {
    if (generation !== this.permissionGeneration) return;
    this.states.orientation.permission = result;
    this.states.orientation.errorName = result === "error" ? (error instanceof Error ? error.name.slice(0, 80) : "PermissionError") : null;
    this.options.sink.record("sensor_permission", { sensor: "orientation", result }, "coach_sensors");
    this.publish();
  }

  private validContext(): CaptureContext | null {
    if (!this.active) return null;
    const context = this.options.getContext();
    return context.run_id === this.runId ? context : null;
  }

  private now(): SampleTime {
    const context = this.options.getContext();
    return { timestamp_utc_ms: Date.now(), elapsed_seconds: context.run_id === this.runId ? finite(context.elapsed_seconds) : null };
  }

  private visibilityChanged = (): void => {
    if (!this.active) return;
    if (document.visibilityState === "visible") this.attach();
    else {
      this.checkSilence();
      this.detach();
      this.pauseGaps("hidden");
    }
    this.publish();
  };

  private attach(): void {
    if (this.listening || !this.validContext() || !this.host || document.visibilityState !== "visible") return;
    this.listening = true;
    this.foregroundStart = performance.now();
    const time = this.now();
    for (const kind of KINDS) {
      const state = this.states[kind];
      this.closeGap(state, time);
      state.waitingSince = time;
      state.waitingSinceMono = performance.now();
      state.previousSampleMono = null;
    }
    if (this.states.motion.supported) this.host.addEventListener("devicemotion", this.motion);
    if (this.states.orientation.supported) {
      this.host.addEventListener("deviceorientation", this.orientation);
      this.host.addEventListener("deviceorientationabsolute", this.orientation);
    }
    const Light = this.host.AmbientLightSensor;
    if (Light) {
      try {
        this.light = new Light({ frequency: 1 });
        this.light.addEventListener("reading", this.lightReading);
        this.light.addEventListener("error", this.lightError);
        this.light.addEventListener("activate", this.lightActivated);
        this.light.start();
      } catch (error) {
        this.lightFailed(error);
      }
    }
  }

  private detach(): void {
    this.listening = false;
    if (this.foregroundStart !== null) this.foregroundMs += Math.max(0, performance.now() - this.foregroundStart);
    this.foregroundStart = null;
    this.host?.removeEventListener("devicemotion", this.motion);
    this.host?.removeEventListener("deviceorientation", this.orientation);
    this.host?.removeEventListener("deviceorientationabsolute", this.orientation);
    this.stopLight();
  }

  private stopLight(): void {
    if (!this.light) return;
    const sensor = this.light;
    this.light = null;
    sensor.removeEventListener("reading", this.lightReading);
    sensor.removeEventListener("error", this.lightError);
    sensor.removeEventListener("activate", this.lightActivated);
    try { sensor.stop(); } catch { /* A failed or already-disconnected sensor is no longer used. */ }
  }

  private motion = (event: DeviceMotionEvent): void => {
    const context = this.beginSample("motion", event.timeStamp);
    if (!context) return;
    const a = event.acceleration;
    const g = event.accelerationIncludingGravity;
    const r = event.rotationRate;
    const values = [finite(a?.x), finite(a?.y), finite(a?.z), finite(g?.x), finite(g?.y), finite(g?.z), finite(r?.alpha), finite(r?.beta), finite(r?.gamma)];
    this.sample("motion", context, values, event.timeStamp, [finite(event.interval)]);
  };

  private orientation = (event: Event): void => {
    const context = this.beginSample("orientation", event.timeStamp);
    if (!context) return;
    const value = event as DeviceOrientationEvent & { webkitCompassHeading?: number; webkitCompassAccuracy?: number };
    const accuracy = finite(value.webkitCompassAccuracy);
    const values = [finite(value.alpha), finite(value.beta), finite(value.gamma), typeof value.absolute === "boolean" ? Number(value.absolute) : null, finite(value.webkitCompassHeading), accuracy];
    // The absolute flag alone is metadata, not an orientation measurement.
    this.sample("orientation", context, values, event.timeStamp, [], values.some((item, index) => index !== 3 && index !== 5 && item !== null));
  };

  private lightReading = (event: Event): void => {
    if (!this.light || event.target !== this.light) return;
    const context = this.beginSample("ambient_light", this.light.timestamp);
    if (!context) return;
    this.sample("ambient_light", context, [finite(this.light.illuminance)], this.light.timestamp);
  };

  private lightActivated = (event: Event): void => {
    if (!this.light || event.target !== this.light || !this.listening) return;
    this.states.ambient_light.permission = "granted";
    this.states.ambient_light.errorName = null;
    this.publish();
  };

  private lightError = (event: Event): void => {
    if (!this.light || event.target !== this.light) return;
    this.lightFailed((event as Event & { error?: DOMException }).error);
  };

  private lightFailed(error: unknown): void {
    const state = this.states.ambient_light;
    state.errorName = error instanceof Error ? error.name.slice(0, 80) : "SensorError";
    state.permission = state.errorName === "NotAllowedError" || state.errorName === "SecurityError" ? "denied" : "error";
    this.openGap(state, "sensor_error", this.now());
    this.stopLight();
    this.options.sink.record("sensor_error", { sensor: "ambient_light", error_name: state.errorName }, "coach_sensors");
    this.publish();
  }

  private beginSample(kind: SensorKind, timestamp: number | null): CaptureContext | null {
    if (!this.listening || document.visibilityState !== "visible") return null;
    const context = this.validContext();
    if (!context) return null;
    const state = this.states[kind];
    const motionPermission = kind === "motion" ? this.options.getMotionPermission?.() : undefined;
    if (state.permission === "denied" || state.permission === "error"
      || (motionPermission !== undefined && motionPermission !== "ready")) return null;
    const stamp = finite(timestamp);
    const eventMono = stamp !== null && stamp > 0 ? (stamp > 1e12 ? stamp - performance.timeOrigin : stamp) : null;
    // Discard queued measurements acquired before this foreground/run segment.
    if (eventMono !== null && this.foregroundStart !== null && eventMono < this.foregroundStart) return null;
    state.events += 1;
    const mono = performance.now();
    if (mono - state.lastStoredMono < MIN_INTERVAL[kind]) return null;
    state.lastStoredMono = mono;
    return context;
  }

  private sample(kind: SensorKind, context: CaptureContext, values: Array<number | null>, timestamp: number | null, metadata: Array<number | null> = [], hasMeasurement = values.some((value) => value !== null)): void {
    const state = this.states[kind];
    const mono = state.lastStoredMono;
    if (!hasMeasurement) state.nullEvents += 1;
    // DOM and Generic Sensor timestamps are monotonic milliseconds since timeOrigin;
    // older WebKit uses epoch milliseconds. Receipt UTC is used only if absent.
    const stamp = finite(timestamp);
    const utc = stamp !== null && stamp > 0 ? (stamp > 1e12 ? stamp : performance.timeOrigin + stamp) : Date.now();
    const time = { timestamp_utc_ms: finite(utc) ?? Date.now(), elapsed_seconds: finite(context.elapsed_seconds) };
    this.options.sink.sensor(kind, COLUMNS[kind], UNITS[kind], [time.elapsed_seconds, time.timestamp_utc_ms, ...values, ...metadata]);
    if (!hasMeasurement) return;
    if (state.waitingSince && mono - state.waitingSinceMono > SILENCE_INTERVAL[kind]) this.openGap(state, "no_samples", state.waitingSince);
    this.closeGap(state, time);
    state.samples += 1;
    if (state.previousSampleMono !== null) {
      state.sampleIntervals += 1;
      state.sampleDurationMs += mono - state.previousSampleMono;
    }
    state.previousSampleMono = mono;
    state.first ??= time;
    state.last = time;
    state.waitingSince = time;
    state.waitingSinceMono = mono;
    state.errorName = null;
    // Receipt is evidence of availability; do not invent a platform permission result.
  }

  private checkSilence(): void {
    if (!this.listening) return;
    const mono = performance.now();
    for (const kind of KINDS) {
      const state = this.states[kind];
      if (state.supported && state.waitingSince && !state.openGap && mono - state.waitingSinceMono > SILENCE_INTERVAL[kind]) this.openGap(state, "no_samples", state.waitingSince);
    }
  }

  private pauseGaps(reason: "hidden" | "stopped"): void {
    const time = this.now();
    for (const kind of KINDS) {
      if (this.states[kind].supported) this.openGap(this.states[kind], reason, time);
    }
    this.options.sink.record("sensor_capture_paused", { reason }, "coach_sensors");
  }

  private openGap(state: SensorState, reason: GapReason, start: SampleTime): void {
    if (state.openGap?.reason === reason) return;
    this.closeGap(state, start);
    const gap: SensorGap = { reason, start, end: null };
    state.openGap = gap;
    state.gaps.push(gap);
    state.gapCount += 1;
    if (state.gaps.length > MAX_GAPS) {
      state.gaps.shift();
      state.droppedGaps += 1;
    }
  }

  private closeGap(state: SensorState, end: SampleTime): void {
    if (!state.openGap) return;
    state.openGap.end = end;
    state.openGap = null;
  }

  private publish(): void {
    this.options.onSummary(this.snapshot());
  }
}
