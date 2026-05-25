import {
  Activity,
  Clipboard,
  Download,
  Map as MapIcon,
  Lock,
  MapPin,
  Play,
  RefreshCw,
  Share2,
  Square,
  Trash2,
} from "lucide-react";
import { encode as encodeMsgpack } from "@msgpack/msgpack";
import { strToU8, zipSync } from "fflate";
import L from "leaflet";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import { buildExportPayload, computeLiveStats, createGpsPointFromPosition } from "./runMath";
import type {
  ActiveRun,
  BreathingRecoveredAfter,
  Checkpoint,
  ExportPayload,
  FinalizationDiagnostics,
  GpsPoint,
  LifecycleEvent,
  MotionWindow,
  MotionDebug,
  PermissionState,
  PhonePosition,
  PreRunGpsWarmup,
  PostRunState,
  PreRunState,
  PrimaryLimiter,
  PwaState,
  RecordingLifecycle,
  RouteDirection,
  RunMode,
  Screen,
  SimpleEffort,
  SorenessLevel,
  WeatherStatusText,
} from "./types";
import { emptyWeatherSnapshot, fetchOpenMeteoWeather } from "./weather";

const APP_NAME = "Green Lake AutoResearch Logger";
const APP_VERSION = "0.1.7";
const TIMEZONE = "America/Los_Angeles";
const STORAGE_KEY = "greenlake_autoresearch_logger_active_run_v0_1";
const ROUTE_MEMORY_KEY = "greenlake_autoresearch_logger_route_memory_v0_1";
const MSGPACK_MIME = "application/msgpack";
const ZIP_MIME = "application/zip";
const MOTION_WINDOW_SECONDS = 5;
const ACCEPTABLE_GPS_ACCURACY_METERS = 25;
const CONTROLLED_START_PATCH_ID = "controlled_start_v1";
const CONTROLLED_START_BANDS = [
  { km: 1, label: "Km 1", minSecondsPerKm: 335, maxSecondsPerKm: 340, text: "5:35-5:40" },
  { km: 2, label: "Km 2", minSecondsPerKm: 335, maxSecondsPerKm: 345, text: "5:35-5:45" },
  { km: 3, label: "Km 3", minSecondsPerKm: 340, maxSecondsPerKm: 350, text: "5:40-5:50" },
  { km: 4, label: "Km 4", minSecondsPerKm: null, maxSecondsPerKm: null, text: "hold steady" },
  { km: 5, label: "Km 5", minSecondsPerKm: null, maxSecondsPerKm: null, text: "squeeze if stable" },
] as const;
const RUN_MODE_OPTIONS: Array<{ value: RunMode; label: string }> = [
  { value: "short_run_diagnostic", label: "short run diagnostic" },
  { value: "green_lake_5k_calibration", label: "Green Lake 5K calibration" },
  { value: "instrumentation_validation", label: "instrumentation validation" },
  { value: "easy_run", label: "easy run" },
  { value: "recovery_run", label: "recovery run" },
  { value: "record_mode", label: "record mode" },
  { value: "training_calibration", label: "training calibration" },
];
const RPE_ANCHORS = [
  "1-2 very easy / walking",
  "3-4 easy, conversational",
  "5-6 moderate, controlled",
  "7 hard but sustainable",
  "8 very hard",
  "9 near max",
  "10 all-out",
];

interface MotionBucket {
  start: number;
  end: number;
  sampleCount: number;
  accelX: number[];
  accelY: number[];
  accelZ: number[];
  accelMagnitude: number[];
  accelIncludingGravityMagnitude: number[];
  rotationAlpha: number[];
  rotationBeta: number[];
  rotationGamma: number[];
  rotationMagnitude: number[];
}

interface ExportArtifacts {
  json_bytes: number;
  msgpack_bytes: Uint8Array;
  msgpack_filename: string;
  zip_bytes: Uint8Array;
  zip_filename: string;
}

const defaultPreRun: PreRunState = {
  runner_id: "user_001",
  goal: "sub_25_5k",
  route_name: "Home block short run",
  mode: "short_run_diagnostic",
  active_patch_id: CONTROLLED_START_PATCH_ID,
  route_direction: "unknown",
  phone_position: "unknown",
  intended_distance_meters: 1500,
  energy_before_run_1_to_5: null,
  soreness_before_run: "unknown",
  pain_before_run: {
    present: false,
    location: null,
    severity_1_to_10: null,
  },
  free_text: "",
};

const defaultPostRun: PostRunState = {
  rpe_1_to_10: null,
  rpe_estimation_source: "not_answered",
  perceived_effort_simple: "unknown",
  energy_after_run_1_to_5: null,
  soreness_after_run: "unknown",
  pain_after_run: {
    present: false,
    location: null,
    severity_1_to_10: null,
  },
  primary_limiter: "unknown",
  started_too_fast: "unknown",
  final_third_harder_than_expected: "unknown",
  interruption: "none",
  immediate_pulse_bpm_manual: null,
  pulse_after_3_to_5_min_bpm_manual: null,
  breathing_recovered_after: "unknown",
  subjective_debrief_skipped: false,
  subjective_debrief_skip_reason: null,
  free_text: "",
};

function defaultPermissions(): PermissionState {
  const geolocationAvailable = "geolocation" in navigator;
  const motionAvailable = typeof window !== "undefined" && "DeviceMotionEvent" in window;
  const wakeLockAvailable = typeof navigator !== "undefined" && "wakeLock" in navigator;

  return {
    geolocation_available: geolocationAvailable,
    geolocation_permission: geolocationAvailable ? "unknown" : "unavailable",
    device_motion_available: motionAvailable,
    device_motion_permission: motionAvailable ? "unknown" : "unavailable",
    wake_lock_available: wakeLockAvailable,
    wake_lock_used: false,
    wake_lock_status: wakeLockAvailable ? "inactive" : "unavailable",
    wake_lock_error_message: null,
    weather_status: "will_fetch_after_gps",
  };
}

function defaultRecordingLifecycle(): RecordingLifecycle {
  return {
    wake_lock_events: [],
    visibility_events: [],
    pagehide_events: [],
    pageshow_events: [],
    gps_stale_events: [],
  };
}

function defaultWarmup(): PreRunGpsWarmup {
  return {
    armed_at_utc: null,
    started_at_utc: null,
    warmup_duration_seconds: null,
    best_accuracy_meters: null,
    last_accuracy_before_start_meters: null,
  };
}

function defaultMotionDebug(): MotionDebug {
  return {
    request_status: "not_requested",
    requested_at_utc: null,
    result_at_utc: null,
    first_event_at_utc: null,
    first_event_elapsed_seconds: null,
    sample_events_seen: 0,
    no_samples_note_added: false,
  };
}

function defaultFinalization(): FinalizationDiagnostics {
  return {
    stop_clicked_at_utc: null,
    stopped_at_elapsed_seconds: null,
    gps_watch_cleared: false,
    motion_listener_removed: false,
    gps_stale_timers_cleared: false,
    finish_point_source: "none",
    stop_point: null,
    post_stop_gps_callback_count: 0,
    post_stop_gps_first_timestamp_utc: null,
    post_stop_gps_last_timestamp_utc: null,
    post_stop_gps_drift_meters: null,
    points_excluded_after_stop: 0,
    analysis_point_count: null,
    raw_point_count: null,
    stored_analysis_point_count: null,
    post_stop_callback_count: 0,
    total_callbacks_seen: null,
    post_stop_first_callback_classification: null,
  };
}

function detectPwaState(storagePersisted: boolean | null = null): PwaState {
  return {
    display_mode_standalone:
      window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true,
    service_worker_controller: Boolean(navigator.serviceWorker?.controller),
    storage_persisted: storagePersisted,
  };
}

function createBlankRun(
  preRun: PreRunState,
  permissions: PermissionState,
  warmup: PreRunGpsWarmup,
  pwaState: PwaState,
  motionDebug: MotionDebug,
): ActiveRun {
  const now = new Date();
  return {
    status: "running",
    run_metadata: {
      run_id: `greenlake_${now.toISOString().replace(/[-:.]/g, "").slice(0, 15)}`,
      start_time_local: formatLocalIso(now),
      start_time_utc: now.toISOString(),
      end_time_local: null,
      end_time_utc: null,
      timezone: TIMEZONE,
    },
    pre_run: preRun,
    post_run: defaultPostRun,
    permissions,
    weather: {
      start_weather: emptyWeatherSnapshot(true),
      finish_weather: emptyWeatherSnapshot(false),
    },
    gps_points: [],
    motion_windows: [],
    checkpoints: [],
    data_quality_notes: [],
    recording_lifecycle: defaultRecordingLifecycle(),
    pre_run_gps_warmup: warmup,
    motion_debug: motionDebug,
    pwa_state: pwaState,
    finalization: defaultFinalization(),
    elapsed_offset_seconds: 0,
    last_saved_at_utc: now.toISOString(),
  };
}

export default function App() {
  const [initialRun] = useState(loadStoredRun);
  const [preRun, setPreRun] = useState<PreRunState>(initialRun?.pre_run ?? defaultPreRun);
  const [permissions, setPermissions] = useState<PermissionState>(initialRun?.permissions ?? defaultPermissions);
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(initialRun);
  const [screen, setScreen] = useState<Screen>(
    initialRun ? (initialRun.run_metadata.end_time_utc ? "export" : "live") : "setup",
  );
  const [elapsedSeconds, setElapsedSeconds] = useState(initialRun?.elapsed_offset_seconds ?? 0);
  const [exportCreatedAt, setExportCreatedAt] = useState(new Date().toISOString());
  const [actionMessage, setActionMessage] = useState("");
  const [warmup, setWarmup] = useState<PreRunGpsWarmup>(initialRun?.pre_run_gps_warmup ?? defaultWarmup());
  const [motionDebugDraft, setMotionDebugDraft] = useState<MotionDebug>(initialRun?.motion_debug ?? defaultMotionDebug());
  const [warmupStatus, setWarmupStatus] = useState<{
    active: boolean;
    latestPoint: GpsPoint | null;
    latestAccuracy: number | null;
  }>({ active: false, latestPoint: null, latestAccuracy: null });
  const [gpsStaleSeconds, setGpsStaleSeconds] = useState(0);
  const [serviceWorkerUpdateReady, setServiceWorkerUpdateReady] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<Event | null>(null);
  const [pwaState, setPwaState] = useState<PwaState>(initialRun?.pwa_state ?? detectPwaState());

  const gpsWatchIdRef = useRef<number | null>(null);
  const warmupWatchIdRef = useRef<number | null>(null);
  const elapsedSecondsRef = useRef(initialRun?.elapsed_offset_seconds ?? 0);
  const runStartPerfRef = useRef<number | null>(
    initialRun && !initialRun.run_metadata.end_time_utc
      ? performance.now() - initialRun.elapsed_offset_seconds * 1000
      : null,
  );
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const motionBucketRef = useRef<MotionBucket | null>(null);
  const startWeatherFetchStartedRef = useRef(Boolean(initialRun?.weather.start_weather.fetched_at_utc));
  const targetReachedNotifiedRef = useRef(
    Boolean(initialRun?.checkpoints.some((checkpoint) => checkpoint.label === "target_distance_reached")),
  );
  const stale5LoggedRef = useRef(false);
  const stale10LoggedRef = useRef(false);
  const motionEventsSeenRef = useRef(initialRun?.motion_debug.sample_events_seen ?? 0);
  const activeRunRef = useRef<ActiveRun | null>(initialRun);
  const serviceWorkerRegistrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const startWeatherRetryTimeoutRef = useRef<number | null>(null);

  const liveStats = useMemo(
    () => computeLiveStats(activeRun?.gps_points ?? [], elapsedSeconds),
    [activeRun?.gps_points, elapsedSeconds],
  );

  const exportPayload = useMemo(
    () => (activeRun ? buildExportPayload(activeRun, exportCreatedAt) : null),
    [activeRun, exportCreatedAt],
  );
  const exportJson = useMemo(
    () => (exportPayload ? JSON.stringify(exportPayload, null, 2) : ""),
    [exportPayload],
  );
  const exportFilename = useMemo(
    () => (activeRun ? buildExportFilename(activeRun.run_metadata.start_time_utc) : "greenlake_run_user_001.json"),
    [activeRun],
  );
  const exportArtifacts = useMemo(
    () => (exportPayload ? buildExportArtifacts(exportPayload, exportJson, exportFilename) : null),
    [exportPayload, exportJson, exportFilename],
  );
  const targetCheckpointRecorded = Boolean(
    activeRun?.checkpoints.some((checkpoint) => checkpoint.label === "target_distance_reached"),
  );
  const targetReached =
    targetCheckpointRecorded ||
    liveStats.distanceMeters >= (activeRun?.pre_run.intended_distance_meters ?? Infinity);

  elapsedSecondsRef.current = elapsedSeconds;
  activeRunRef.current = activeRun;

  const getElapsedSeconds = useCallback(() => {
    if (runStartPerfRef.current === null) {
      return elapsedSecondsRef.current;
    }
    return Math.max(0, (performance.now() - runStartPerfRef.current) / 1000);
  }, []);

  const updatePermissions = useCallback((patch: Partial<PermissionState>) => {
    setPermissions((current) => {
      const next = { ...current, ...patch };
      setActiveRun((run) => (run ? { ...run, permissions: next } : run));
      return next;
    });
  }, []);

  const appendQualityNote = useCallback((note: string) => {
    setActiveRun((run) => {
      if (!run || run.data_quality_notes.includes(note)) {
        return run;
      }
      return { ...run, data_quality_notes: [...run.data_quality_notes, note] };
    });
  }, []);

  const appendLifecycleEvent = useCallback(
    <K extends keyof RecordingLifecycle>(key: K, event: RecordingLifecycle[K][number]) => {
      setActiveRun((run) => {
        if (!run) {
          return run;
        }
        return {
          ...run,
          recording_lifecycle: {
            ...run.recording_lifecycle,
            [key]: [...run.recording_lifecycle[key], event],
          },
        };
      });
    },
    [],
  );

  const updateMotionDebug = useCallback((patch: Partial<MotionDebug>) => {
    setMotionDebugDraft((current) => ({ ...current, ...patch }));
    setActiveRun((run) =>
      run ? { ...run, motion_debug: { ...run.motion_debug, ...patch } } : run,
    );
  }, []);

  const stopGpsWatch = useCallback(() => {
    if (gpsWatchIdRef.current !== null && "geolocation" in navigator) {
      navigator.geolocation.clearWatch(gpsWatchIdRef.current);
      gpsWatchIdRef.current = null;
      return true;
    }
    return false;
  }, []);

  const stopWarmupWatch = useCallback(() => {
    if (warmupWatchIdRef.current !== null && "geolocation" in navigator) {
      navigator.geolocation.clearWatch(warmupWatchIdRef.current);
      warmupWatchIdRef.current = null;
    }
    setWarmupStatus((current) => ({ ...current, active: false }));
  }, []);

  const armGps = useCallback(() => {
    if (!("geolocation" in navigator)) {
      updatePermissions({ geolocation_available: false, geolocation_permission: "unavailable" });
      setActionMessage("GPS unavailable.");
      return;
    }
    if (warmupWatchIdRef.current !== null) {
      setActionMessage("GPS warmup already armed.");
      return;
    }

    const armedAt = new Date().toISOString();
    setWarmup({
      armed_at_utc: armedAt,
      started_at_utc: null,
      warmup_duration_seconds: null,
      best_accuracy_meters: null,
      last_accuracy_before_start_meters: null,
    });
    setWarmupStatus({ active: true, latestPoint: null, latestAccuracy: null });
    setActionMessage("GPS warmup armed.");

    warmupWatchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const point = createGpsPointFromPosition(position, 0, null);
        const accuracy = point.horizontal_accuracy_meters;
        updatePermissions({ geolocation_permission: "ready" });
        setWarmupStatus({ active: true, latestPoint: point, latestAccuracy: accuracy });
        setWarmup((current) => ({
          ...current,
          best_accuracy_meters:
            accuracy === null
              ? current.best_accuracy_meters
              : current.best_accuracy_meters === null
                ? accuracy
                : Math.min(current.best_accuracy_meters, accuracy),
          last_accuracy_before_start_meters: accuracy,
        }));
      },
      (error) => {
        updatePermissions({
          geolocation_permission: error.code === error.PERMISSION_DENIED ? "denied" : "unavailable",
        });
        setWarmupStatus((current) => ({ ...current, active: false }));
        setActionMessage(error.code === error.PERMISSION_DENIED ? "GPS denied." : "GPS warmup unavailable.");
      },
      {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 10000,
      },
    );
  }, [updatePermissions]);

  const fetchWeatherForRun = useCallback(
    async (kind: "start" | "finish", lat: number, lon: number, retryAttempt = 0) => {
      updatePermissions({ weather_status: "fetching" });
      try {
        const snapshot = await fetchOpenMeteoWeather(lat, lon);
        setActiveRun((run) => {
          if (!run) {
            return run;
          }
          const shouldBackfillStart = kind === "finish" && !run.weather.start_weather.fetched_at_utc;
          return {
            ...run,
            weather: {
              ...run.weather,
              [kind === "start" ? "start_weather" : "finish_weather"]: snapshot,
              ...(shouldBackfillStart
                ? {
                    start_weather: {
                      ...snapshot,
                      fallback_source: "finish_weather" as const,
                    },
                  }
                : {}),
            },
          };
        });
        updatePermissions({ weather_status: "fetched" });
      } catch (error) {
        if (kind === "start" && retryAttempt === 0) {
          appendQualityNote("Start weather fetch failed; retry scheduled.");
          startWeatherRetryTimeoutRef.current = window.setTimeout(() => {
            startWeatherRetryTimeoutRef.current = null;
            void fetchWeatherForRun("start", lat, lon, 1);
          }, 30000);
          return;
        }
        updatePermissions({ weather_status: "unavailable" });
        appendQualityNote(`${kind === "start" ? "Start" : "Finish"} weather fetch failed.`);
      }
    },
    [appendQualityNote, updatePermissions],
  );

  const startGpsWatch = useCallback(() => {
    if (!("geolocation" in navigator)) {
      updatePermissions({ geolocation_available: false, geolocation_permission: "unavailable" });
      appendQualityNote("Geolocation API was unavailable.");
      return;
    }
    if (gpsWatchIdRef.current !== null) {
      return;
    }

    gpsWatchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const elapsed = getElapsedSeconds();
        const pointForWeather: { current: GpsPoint | null } = { current: null };
        const pointCountForWeather: { current: number } = { current: 0 };
        stale5LoggedRef.current = false;
        stale10LoggedRef.current = false;
        setGpsStaleSeconds(0);

        setActiveRun((run) => {
          if (!run) {
            return run;
          }
          if (run.status !== "running") {
            const latePoint = createGpsPointFromPosition(
              position,
              run.finalization.stopped_at_elapsed_seconds ?? elapsed,
              run.gps_points[run.gps_points.length - 1] ?? null,
            );
            const stopPoint = run.finalization.stop_point;
            const drift = stopPoint ? haversineMetersForApp(stopPoint, latePoint) : run.finalization.post_stop_gps_drift_meters;
            const callbackCount = run.finalization.post_stop_gps_callback_count + 1;
            return {
              ...run,
              finalization: {
                ...run.finalization,
                post_stop_gps_callback_count: callbackCount,
                post_stop_callback_count: callbackCount,
                post_stop_gps_first_timestamp_utc:
                  run.finalization.post_stop_gps_first_timestamp_utc ?? latePoint.timestamp_utc,
                post_stop_gps_last_timestamp_utc: latePoint.timestamp_utc,
                post_stop_gps_drift_meters: drift === null ? null : round(drift, 2),
                points_excluded_after_stop: run.finalization.points_excluded_after_stop + 1,
                total_callbacks_seen: run.gps_points.length + callbackCount,
                post_stop_first_callback_classification:
                  run.finalization.post_stop_first_callback_classification ?? "post_stop_callback",
              },
            };
          }
          const previousPoint = run.gps_points[run.gps_points.length - 1] ?? null;
          const point = createGpsPointFromPosition(position, elapsed, previousPoint);
          pointForWeather.current = point;
          pointCountForWeather.current = run.gps_points.length + 1;
          return {
            ...run,
            gps_points: [...run.gps_points, point],
            elapsed_offset_seconds: elapsed,
          };
        });

        updatePermissions({ geolocation_permission: "ready" });

        if (
          !startWeatherFetchStartedRef.current &&
          pointForWeather.current &&
          (pointForWeather.current.accuracy_ok || pointCountForWeather.current >= 5)
        ) {
          startWeatherFetchStartedRef.current = true;
          void fetchWeatherForRun("start", pointForWeather.current.lat, pointForWeather.current.lon);
        }
      },
      (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          updatePermissions({ geolocation_permission: "denied" });
          appendQualityNote("GPS permission was denied.");
        } else {
          updatePermissions({ geolocation_permission: "unavailable" });
          appendQualityNote(`GPS watch failed: ${error.message}`);
        }
      },
      {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 10000,
      },
    );
  }, [appendQualityNote, fetchWeatherForRun, getElapsedSeconds, updatePermissions]);

  const releaseWakeLock = useCallback(async () => {
    const lock = wakeLockRef.current;
    wakeLockRef.current = null;
    if (lock && !lock.released) {
      try {
        await lock.release();
      } catch {
        // A released wake lock is already inactive, so no extra state is needed.
      }
    }
    updatePermissions({ wake_lock_status: navigator.wakeLock ? "inactive" : "unavailable" });
  }, [updatePermissions]);

  const requestWakeLock = useCallback(
    async (silent = false) => {
      if (!navigator.wakeLock) {
        updatePermissions({
          wake_lock_available: false,
          wake_lock_status: "unavailable",
          wake_lock_error_message: "Wake Lock API unavailable",
        });
        appendLifecycleEvent("wake_lock_events", {
          event: "wake_lock_unavailable",
          timestamp_utc: new Date().toISOString(),
          t_elapsed_seconds: runStartPerfRef.current === null ? null : round(getElapsedSeconds(), 2),
          status: "unavailable",
          error_message: "Wake Lock API unavailable",
        });
        if (!silent) {
          setActionMessage("Wake lock unavailable.");
        }
        return;
      }
      try {
        appendLifecycleEvent("wake_lock_events", {
          event: "wake_lock_requested",
          timestamp_utc: new Date().toISOString(),
          t_elapsed_seconds: runStartPerfRef.current === null ? null : round(getElapsedSeconds(), 2),
          status: "requested",
        });
        const lock = await navigator.wakeLock.request("screen");
        wakeLockRef.current = lock;
        lock.addEventListener("release", () => {
          appendLifecycleEvent("wake_lock_events", {
            event: "wake_lock_released",
            timestamp_utc: new Date().toISOString(),
            t_elapsed_seconds: runStartPerfRef.current === null ? null : round(getElapsedSeconds(), 2),
            status: "released",
          });
          updatePermissions({ wake_lock_status: "inactive" });
        });
        updatePermissions({
          wake_lock_available: true,
          wake_lock_status: "active",
          wake_lock_used: true,
          wake_lock_error_message: null,
        });
        appendLifecycleEvent("wake_lock_events", {
          event: "wake_lock_active",
          timestamp_utc: new Date().toISOString(),
          t_elapsed_seconds: runStartPerfRef.current === null ? null : round(getElapsedSeconds(), 2),
          status: "active",
        });
        if (!silent) {
          setActionMessage("Wake lock active.");
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Wake lock request failed";
        updatePermissions({ wake_lock_status: "failed", wake_lock_error_message: errorMessage });
        appendLifecycleEvent("wake_lock_events", {
          event: "wake_lock_failed",
          timestamp_utc: new Date().toISOString(),
          t_elapsed_seconds: runStartPerfRef.current === null ? null : round(getElapsedSeconds(), 2),
          status: "failed",
          error_message: errorMessage,
        });
        if (!silent) {
          setActionMessage("Wake lock is not active. Keep the app visible and screen on or GPS may stop.");
        }
      }
    },
    [appendLifecycleEvent, getElapsedSeconds, updatePermissions],
  );

  const requestGpsPermission = () => {
    if (!("geolocation" in navigator)) {
      updatePermissions({ geolocation_available: false, geolocation_permission: "unavailable" });
      setActionMessage("GPS unavailable.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      () => {
        updatePermissions({ geolocation_permission: "ready" });
        setActionMessage("GPS ready.");
      },
      (error) => {
        updatePermissions({ geolocation_permission: error.code === error.PERMISSION_DENIED ? "denied" : "unavailable" });
        setActionMessage(error.code === error.PERMISSION_DENIED ? "GPS denied." : "GPS unavailable.");
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 },
    );
  };

  const requestMotionPermission = async () => {
    if (!permissions.device_motion_available) {
      updatePermissions({ device_motion_permission: "unavailable" });
      updateMotionDebug({
        request_status: "unavailable",
        requested_at_utc: new Date().toISOString(),
        result_at_utc: new Date().toISOString(),
      });
      setActionMessage("Motion unavailable.");
      return;
    }

    try {
      updateMotionDebug({ request_status: "requested", requested_at_utc: new Date().toISOString() });
      const requestPermission = (
        DeviceMotionEvent as unknown as { requestPermission?: () => Promise<"granted" | "denied"> }
      ).requestPermission;
      if (typeof requestPermission === "function") {
        const result = await requestPermission();
        updatePermissions({ device_motion_permission: result === "granted" ? "ready" : "denied" });
        updateMotionDebug({
          request_status: result === "granted" ? "granted" : "denied",
          result_at_utc: new Date().toISOString(),
        });
        setActionMessage(result === "granted" ? "Motion ready." : "Motion denied.");
      } else {
        updatePermissions({ device_motion_permission: "ready" });
        updateMotionDebug({ request_status: "granted", result_at_utc: new Date().toISOString() });
        setActionMessage("Motion ready.");
      }
    } catch {
      updatePermissions({ device_motion_permission: "denied" });
      updateMotionDebug({ request_status: "failed", result_at_utc: new Date().toISOString() });
      setActionMessage("Motion permission failed.");
    }
  };

  const startRun = () => {
    const startedAt = new Date();
    const warmupStartedAt = warmup.armed_at_utc ? Date.parse(warmup.armed_at_utc) : null;
    const finalWarmup: PreRunGpsWarmup = {
      ...warmup,
      started_at_utc: startedAt.toISOString(),
      warmup_duration_seconds:
        warmupStartedAt !== null && Number.isFinite(warmupStartedAt)
          ? round((startedAt.getTime() - warmupStartedAt) / 1000, 2)
          : null,
      last_accuracy_before_start_meters: warmupStatus.latestAccuracy ?? warmup.last_accuracy_before_start_meters,
    };
    stopWarmupWatch();
    setWarmup(finalWarmup);

    const run = createBlankRun(preRun, permissions, finalWarmup, pwaState, motionDebugDraft);
    setActiveRun(run);
    setElapsedSeconds(0);
    setExportCreatedAt(new Date().toISOString());
    setActionMessage("");
    runStartPerfRef.current = performance.now();
    motionBucketRef.current = null;
    motionEventsSeenRef.current = 0;
    startWeatherFetchStartedRef.current = false;
    targetReachedNotifiedRef.current = false;
    stale5LoggedRef.current = false;
    stale10LoggedRef.current = false;
    setGpsStaleSeconds(0);
    setScreen("live");
    startGpsWatch();
    if (warmupStatus.latestPoint && warmupStatus.latestPoint.accuracy_ok) {
      startWeatherFetchStartedRef.current = true;
      void fetchWeatherForRun("start", warmupStatus.latestPoint.lat, warmupStatus.latestPoint.lon);
    }
    void requestWakeLock(true);
  };

  const stopRun = async () => {
    const elapsed = getElapsedSeconds();
    const stopClickedAt = new Date();
    const currentRun = activeRunRef.current;
    const preStopPoints = currentRun?.gps_points.filter((point) => point.t_elapsed_seconds <= elapsed + 0.05) ?? [];
    const stopPoint = preStopPoints[preStopPoints.length - 1] ?? null;
    if (currentRun) {
      activeRunRef.current = {
        ...currentRun,
        status: "stopping",
        finalization: {
          ...currentRun.finalization,
          stop_clicked_at_utc: stopClickedAt.toISOString(),
          stopped_at_elapsed_seconds: round(elapsed, 2),
          stop_point: stopPoint,
          finish_point_source: stopPoint ? "last_valid_pre_stop_gps" : "none",
        },
      };
    }
    setActiveRun((run) =>
      run
        ? {
            ...run,
            status: "stopping",
            finalization: {
              ...run.finalization,
              stop_clicked_at_utc: stopClickedAt.toISOString(),
              stopped_at_elapsed_seconds: round(elapsed, 2),
              stop_point: stopPoint,
              finish_point_source: stopPoint ? "last_valid_pre_stop_gps" : "none",
              raw_point_count: run.gps_points.length,
              stored_analysis_point_count: preStopPoints.length,
              total_callbacks_seen: run.gps_points.length + run.finalization.post_stop_gps_callback_count,
            },
          }
        : run,
    );
    flushMotionBucket(elapsed);
    const gpsCleared = stopGpsWatch();
    if (activeRunRef.current) {
      activeRunRef.current = {
        ...activeRunRef.current,
        status: "stopped",
        elapsed_offset_seconds: elapsed,
        run_metadata: {
          ...activeRunRef.current.run_metadata,
          end_time_local: formatLocalIso(stopClickedAt),
          end_time_utc: stopClickedAt.toISOString(),
        },
        finalization: {
          ...activeRunRef.current.finalization,
          gps_watch_cleared: gpsCleared || activeRunRef.current.finalization.gps_watch_cleared,
          motion_listener_removed: true,
          gps_stale_timers_cleared: true,
        },
      };
    }
    stale5LoggedRef.current = false;
    stale10LoggedRef.current = false;
    setGpsStaleSeconds(0);
    await releaseWakeLock();
    setActiveRun((run) =>
      run
        ? {
            ...run,
            status: "stopped",
            elapsed_offset_seconds: elapsed,
            run_metadata: {
              ...run.run_metadata,
              end_time_local: formatLocalIso(stopClickedAt),
              end_time_utc: stopClickedAt.toISOString(),
            },
            finalization: {
              ...run.finalization,
              stop_clicked_at_utc: stopClickedAt.toISOString(),
              stopped_at_elapsed_seconds: round(elapsed, 2),
              gps_watch_cleared: gpsCleared || run.finalization.gps_watch_cleared,
              motion_listener_removed: true,
              gps_stale_timers_cleared: true,
              finish_point_source: stopPoint ? "last_valid_pre_stop_gps" : "none",
              stop_point: stopPoint,
              analysis_point_count: run.gps_points.filter((point) => point.t_elapsed_seconds <= elapsed + 0.05).length,
              raw_point_count: run.gps_points.length,
              stored_analysis_point_count: run.gps_points.filter((point) => point.t_elapsed_seconds <= elapsed + 0.05).length,
              post_stop_callback_count: run.finalization.post_stop_gps_callback_count,
              total_callbacks_seen: run.gps_points.length + run.finalization.post_stop_gps_callback_count,
            },
          }
        : run,
    );
    runStartPerfRef.current = null;
    setElapsedSeconds(elapsed);
    setScreen("stop");

    if (stopPoint) {
      void fetchWeatherForRun("finish", stopPoint.lat, stopPoint.lon);
    }
  };

  const resumeRun = () => {
    setActiveRun((run) =>
      run
        ? {
            ...run,
            status: "running",
            run_metadata: {
              ...run.run_metadata,
              end_time_local: null,
              end_time_utc: null,
            },
            finalization: defaultFinalization(),
          }
        : run,
    );
    runStartPerfRef.current = performance.now() - elapsedSeconds * 1000;
    setScreen("live");
    startGpsWatch();
    if (permissions.wake_lock_used) {
      void requestWakeLock(true);
    }
  };

  const discardRun = () => {
    const confirmed = window.confirm("Discard the active run and local draft?");
    if (!confirmed) {
      return;
    }
    stopGpsWatch();
    stopWarmupWatch();
    if (startWeatherRetryTimeoutRef.current !== null) {
      window.clearTimeout(startWeatherRetryTimeoutRef.current);
      startWeatherRetryTimeoutRef.current = null;
    }
    void releaseWakeLock();
    localStorage.removeItem(STORAGE_KEY);
    setActiveRun(null);
    setPreRun(defaultPreRun);
    setPermissions(defaultPermissions());
    setWarmup(defaultWarmup());
    setWarmupStatus({ active: false, latestPoint: null, latestAccuracy: null });
    setMotionDebugDraft(defaultMotionDebug());
    setElapsedSeconds(0);
    setActionMessage("");
    runStartPerfRef.current = null;
    motionBucketRef.current = null;
    motionEventsSeenRef.current = 0;
    startWeatherFetchStartedRef.current = false;
    targetReachedNotifiedRef.current = false;
    setScreen("setup");
  };

  const addCheckpoint = () => {
    const elapsed = getElapsedSeconds();
    setActiveRun((run) => {
      if (!run) {
        return run;
      }
      const checkpoint: Checkpoint = {
        t_elapsed_seconds: round(elapsed, 2),
        timestamp_utc: new Date().toISOString(),
        label: `checkpoint_${run.checkpoints.length + 1}`,
        distance_meters: round(liveStats.distanceMeters, 2),
      };
      return { ...run, checkpoints: [...run.checkpoints, checkpoint] };
    });
    setActionMessage("Checkpoint saved.");
  };

  const continueToPostRun = () => {
    setScreen("post");
  };

  const continueToExport = () => {
    const createdAt = new Date().toISOString();
    if (activeRun) {
      saveRouteMemory(buildExportPayload(activeRun, createdAt));
    }
    setExportCreatedAt(createdAt);
    setScreen("export");
  };

  const updatePostRun = (patch: Partial<PostRunState>) => {
    setActiveRun((run) => (run ? { ...run, post_run: { ...run.post_run, ...patch } } : run));
  };

  const updatePostRunPain = (patch: Partial<PostRunState["pain_after_run"]>) => {
    setActiveRun((run) =>
      run
        ? {
            ...run,
            post_run: {
              ...run.post_run,
              pain_after_run: { ...run.post_run.pain_after_run, ...patch },
            },
          }
        : run,
    );
  };

  const downloadJson = () => {
    if (!exportJson) {
      return;
    }
    downloadBlob(new Blob([exportJson], { type: "application/json" }), exportFilename);
    setActionMessage("JSON download started.");
  };

  const downloadMsgpack = () => {
    if (!exportArtifacts) {
      return;
    }
    downloadBlob(bytesToBlob(exportArtifacts.msgpack_bytes, MSGPACK_MIME), exportArtifacts.msgpack_filename);
    setActionMessage("MessagePack download started.");
  };

  const downloadZip = () => {
    if (!exportArtifacts) {
      return;
    }
    downloadBlob(bytesToBlob(exportArtifacts.zip_bytes, ZIP_MIME), exportArtifacts.zip_filename);
    setActionMessage("ZIP download started.");
  };

  const copyJson = async () => {
    if (!exportJson) {
      return;
    }
    try {
      await navigator.clipboard.writeText(exportJson);
      setActionMessage("JSON copied.");
    } catch {
      setActionMessage("Clipboard unavailable. Use Download JSON.");
    }
  };

  const copyMsgpackBase64 = async () => {
    if (!exportArtifacts) {
      return;
    }
    try {
      await navigator.clipboard.writeText(bytesToBase64(exportArtifacts.msgpack_bytes));
      setActionMessage("MessagePack base64 copied.");
    } catch {
      setActionMessage("Clipboard unavailable. Use Download MessagePack.");
    }
  };

  const copyZipBase64 = async () => {
    if (!exportArtifacts) {
      return;
    }
    try {
      await navigator.clipboard.writeText(bytesToBase64(exportArtifacts.zip_bytes));
      setActionMessage("ZIP base64 copied.");
    } catch {
      setActionMessage("Clipboard unavailable. Use Download ZIP.");
    }
  };

  const shareJson = async () => {
    if (!exportJson || !navigator.share) {
      downloadJson();
      return;
    }

    const file = new File([exportJson], exportFilename, { type: "application/json" });
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: APP_NAME });
      } else {
        await navigator.share({ title: APP_NAME, text: exportJson });
      }
      setActionMessage("Share sheet opened.");
    } catch {
      setActionMessage("Share canceled or unavailable. Download remains available.");
    }
  };

  const installPwa = async () => {
    const promptEvent = installPrompt as Event & { prompt?: () => Promise<void> };
    if (!promptEvent.prompt) {
      setActionMessage("Install prompt is not available in this browser.");
      return;
    }
    await promptEvent.prompt();
    setInstallPrompt(null);
  };

  const applyServiceWorkerUpdate = () => {
    const waiting = serviceWorkerRegistrationRef.current?.waiting;
    if (waiting) {
      waiting.postMessage({ type: "SKIP_WAITING" });
    }
    window.location.reload();
  };

  const appendMotionWindow = useCallback((windowSummary: MotionWindow) => {
    setActiveRun((run) =>
      run ? { ...run, motion_windows: [...run.motion_windows, windowSummary] } : run,
    );
  }, []);

  const flushMotionBucket = useCallback(
    (endElapsed: number) => {
      const bucket = motionBucketRef.current;
      if (!bucket || bucket.sampleCount === 0) {
        motionBucketRef.current = null;
        return;
      }
      const windowSummary = summarizeMotionBucket({ ...bucket, end: Math.min(bucket.end, endElapsed) });
      appendMotionWindow(windowSummary);
      motionBucketRef.current = null;
    },
    [appendMotionWindow],
  );

  useEffect(() => {
    if (screen !== "live" || !activeRun || activeRun.run_metadata.end_time_utc) {
      return undefined;
    }

    if (gpsWatchIdRef.current === null) {
      startGpsWatch();
    }

    const intervalId = window.setInterval(() => {
      const elapsed = getElapsedSeconds();
      setElapsedSeconds(elapsed);
      const currentRun = activeRunRef.current;
      const latestPoint = currentRun?.gps_points[currentRun.gps_points.length - 1] ?? null;
      if (!latestPoint) {
        return;
      }
      const staleSeconds = Math.max(0, elapsed - latestPoint.t_elapsed_seconds);
      setGpsStaleSeconds(staleSeconds);
      if (staleSeconds > 5 && !stale5LoggedRef.current) {
        stale5LoggedRef.current = true;
        appendLifecycleEvent("gps_stale_events", {
          event: "gps_stale_over_5_seconds",
          timestamp_utc: new Date().toISOString(),
          t_elapsed_seconds: round(elapsed, 2),
          stale_seconds: round(staleSeconds, 2),
          last_gps_elapsed_seconds: latestPoint.t_elapsed_seconds,
          threshold_seconds: 5,
        });
      }
      if (staleSeconds > 10 && !stale10LoggedRef.current) {
        stale10LoggedRef.current = true;
        appendLifecycleEvent("gps_stale_events", {
          event: "gps_stale_over_10_seconds",
          timestamp_utc: new Date().toISOString(),
          t_elapsed_seconds: round(elapsed, 2),
          stale_seconds: round(staleSeconds, 2),
          last_gps_elapsed_seconds: latestPoint.t_elapsed_seconds,
          threshold_seconds: 10,
        });
      }
    }, 500);

    return () => window.clearInterval(intervalId);
  }, [activeRun, appendLifecycleEvent, getElapsedSeconds, screen, startGpsWatch]);

  useEffect(() => {
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);

    if ("storage" in navigator && navigator.storage?.persisted) {
      void navigator.storage.persisted().then(async (alreadyPersisted) => {
        const persisted = alreadyPersisted || (navigator.storage.persist ? await navigator.storage.persist() : false);
        setPwaState(detectPwaState(persisted));
      });
    }

    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
        scope: import.meta.env.BASE_URL,
      }).then((registration) => {
        serviceWorkerRegistrationRef.current = registration;
        setPwaState(detectPwaState(pwaState.storage_persisted));
        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) {
            return;
          }
          installing.addEventListener("statechange", () => {
            if (installing.state === "installed" && navigator.serviceWorker.controller) {
              setServiceWorkerUpdateReady(true);
            }
          });
        });
      });
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        setPwaState(detectPwaState(pwaState.storage_persisted));
      });
    }

    return () => window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
  }, []);

  useEffect(() => {
    if (
      !activeRun ||
      screen !== "live" ||
      targetCheckpointRecorded ||
      targetReachedNotifiedRef.current ||
      liveStats.distanceMeters < activeRun.pre_run.intended_distance_meters
    ) {
      return;
    }

    targetReachedNotifiedRef.current = true;
    const checkpoint: Checkpoint = {
      t_elapsed_seconds: round(getElapsedSeconds(), 2),
      timestamp_utc: new Date().toISOString(),
      label: "target_distance_reached",
      distance_meters: round(liveStats.distanceMeters, 2),
    };

    setActiveRun((run) => {
      if (!run || run.checkpoints.some((checkpoint) => checkpoint.label === "target_distance_reached")) {
        return run;
      }

      return { ...run, checkpoints: [...run.checkpoints, checkpoint] };
    });

    if ("vibrate" in navigator) {
      navigator.vibrate([200]);
    }
    setActionMessage("Target reached. You can stop now.");
  }, [activeRun, getElapsedSeconds, liveStats.distanceMeters, screen, targetCheckpointRecorded]);

  useEffect(() => {
    if (screen !== "live" || permissions.device_motion_permission !== "ready") {
      return undefined;
    }

    const handleMotion = (event: DeviceMotionEvent) => {
      const elapsed = getElapsedSeconds();
      const bucketStart = Math.floor(elapsed / MOTION_WINDOW_SECONDS) * MOTION_WINDOW_SECONDS;
      const currentBucket = motionBucketRef.current;
      motionEventsSeenRef.current += 1;

      if (motionEventsSeenRef.current === 1) {
        updateMotionDebug({
          first_event_at_utc: new Date().toISOString(),
          first_event_elapsed_seconds: round(elapsed, 2),
          sample_events_seen: motionEventsSeenRef.current,
        });
      } else if (motionEventsSeenRef.current % 25 === 0) {
        updateMotionDebug({ sample_events_seen: motionEventsSeenRef.current });
      }

      if (!currentBucket || bucketStart > currentBucket.start) {
        if (currentBucket?.sampleCount) {
          appendMotionWindow(summarizeMotionBucket(currentBucket));
        }
        motionBucketRef.current = createMotionBucket(bucketStart);
      }

      addMotionSample(motionBucketRef.current, event);
    };

    window.addEventListener("devicemotion", handleMotion);
    return () => window.removeEventListener("devicemotion", handleMotion);
  }, [appendMotionWindow, getElapsedSeconds, permissions.device_motion_permission, screen, updateMotionDebug]);

  useEffect(() => {
    if (screen !== "live" || permissions.device_motion_permission !== "ready" || activeRun?.motion_debug.no_samples_note_added) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      if (motionEventsSeenRef.current === 0) {
        appendQualityNote("Device motion permission was ready, but no motion samples arrived after 10 seconds.");
        updateMotionDebug({ no_samples_note_added: true, sample_events_seen: 0 });
      }
    }, 10000);

    return () => window.clearTimeout(timeoutId);
  }, [activeRun?.motion_debug.no_samples_note_added, appendQualityNote, permissions.device_motion_permission, screen, updateMotionDebug]);

  useEffect(() => {
    const handleVisibility = () => {
      if (activeRunRef.current && screen === "live") {
        appendLifecycleEvent("visibility_events", {
          event: "visibilitychange",
          timestamp_utc: new Date().toISOString(),
          t_elapsed_seconds: round(getElapsedSeconds(), 2),
          visibility_state: document.visibilityState,
        });
      }
      if (document.visibilityState === "visible" && screen === "live" && permissions.wake_lock_available) {
        appendLifecycleEvent("wake_lock_events", {
          event: "wake_lock_reacquire_attempt",
          timestamp_utc: new Date().toISOString(),
          t_elapsed_seconds: round(getElapsedSeconds(), 2),
          status: "reacquire_attempt",
        });
        void requestWakeLock(true);
      }
    };
    const handlePageHide = () => {
      if (activeRunRef.current && screen === "live") {
        appendLifecycleEvent("pagehide_events", lifecycleEvent("pagehide", getElapsedSeconds()));
      }
    };
    const handlePageShow = () => {
      if (activeRunRef.current && screen === "live") {
        appendLifecycleEvent("pageshow_events", lifecycleEvent("pageshow", getElapsedSeconds()));
      }
    };
    const handleFreeze = () => {
      if (activeRunRef.current && screen === "live") {
        appendLifecycleEvent("visibility_events", {
          event: "freeze",
          timestamp_utc: new Date().toISOString(),
          t_elapsed_seconds: round(getElapsedSeconds(), 2),
          visibility_state: document.visibilityState,
        });
      }
    };
    const handleResume = () => {
      if (activeRunRef.current && screen === "live") {
        appendLifecycleEvent("visibility_events", {
          event: "resume",
          timestamp_utc: new Date().toISOString(),
          t_elapsed_seconds: round(getElapsedSeconds(), 2),
          visibility_state: document.visibilityState,
        });
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("pageshow", handlePageShow);
    document.addEventListener("freeze", handleFreeze);
    document.addEventListener("resume", handleResume);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("pageshow", handlePageShow);
      document.removeEventListener("freeze", handleFreeze);
      document.removeEventListener("resume", handleResume);
    };
  }, [appendLifecycleEvent, getElapsedSeconds, permissions.wake_lock_used, requestWakeLock, screen]);

  useEffect(() => {
    if (!activeRun) {
      return;
    }
    const savedRun: ActiveRun = {
      ...activeRun,
      elapsed_offset_seconds: screen === "live" ? elapsedSeconds : activeRun.elapsed_offset_seconds,
      last_saved_at_utc: new Date().toISOString(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedRun));
  }, [activeRun, elapsedSeconds, screen]);

  useEffect(() => {
    setActiveRun((run) => (run ? { ...run, pwa_state: pwaState } : run));
  }, [pwaState]);

  useEffect(() => {
    return () => {
      stopGpsWatch();
      if (startWeatherRetryTimeoutRef.current !== null) {
        window.clearTimeout(startWeatherRetryTimeoutRef.current);
      }
      void releaseWakeLock();
    };
  }, [releaseWakeLock, stopGpsWatch]);

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">v{APP_VERSION}</p>
          <h1>{APP_NAME}</h1>
        </div>
        <div className="screen-chip">{screenLabel(screen)}</div>
      </header>

      {actionMessage ? <div className="notice">{actionMessage}</div> : null}
      {serviceWorkerUpdateReady ? (
        <button type="button" className="update-banner" onClick={applyServiceWorkerUpdate}>
          New version ready. Tap to update.
        </button>
      ) : null}
      {installPrompt ? (
        <button type="button" className="install-banner" onClick={() => void installPwa()}>
          Install app
        </button>
      ) : null}

      {screen === "setup" ? (
        <SetupScreen
          preRun={preRun}
          permissions={permissions}
          warmup={warmup}
          warmupStatus={warmupStatus}
          appVisible={document.visibilityState === "visible"}
          setPreRun={setPreRun}
          onGps={requestGpsPermission}
          onArmGps={armGps}
          onStopWarmup={stopWarmupWatch}
          onMotion={requestMotionPermission}
          onWakeLock={() => void requestWakeLock(false)}
          onStart={startRun}
        />
      ) : null}

      {screen === "live" && activeRun ? (
        <LiveScreen
          run={activeRun}
          elapsedSeconds={elapsedSeconds}
          liveStats={liveStats}
          targetReached={targetReached}
          gpsStaleSeconds={gpsStaleSeconds}
          onCheckpoint={addCheckpoint}
          onStop={() => void stopRun()}
          onDiscard={discardRun}
        />
      ) : null}

      {screen === "stop" && activeRun ? (
        <StopScreen
          run={activeRun}
          elapsedSeconds={elapsedSeconds}
          liveStats={liveStats}
          onContinue={continueToPostRun}
          onResume={resumeRun}
          onDiscard={discardRun}
        />
      ) : null}

      {screen === "post" && activeRun ? (
        <PostRunScreen
          run={activeRun}
          postRun={activeRun.post_run}
          updatePostRun={updatePostRun}
          updatePostRunPain={updatePostRunPain}
          onExport={continueToExport}
        />
      ) : null}

      {screen === "export" && activeRun ? (
        <ExportScreen
          exportPayload={exportPayload}
          exportJson={exportJson}
          exportArtifacts={exportArtifacts}
          filename={exportFilename}
          onDownload={downloadJson}
          onCopy={() => void copyJson()}
          onShare={() => void shareJson()}
          onDownloadMsgpack={downloadMsgpack}
          onCopyMsgpack={() => void copyMsgpackBase64()}
          onDownloadZip={downloadZip}
          onCopyZip={() => void copyZipBase64()}
          onBackToPost={() => setScreen("post")}
          onDiscard={discardRun}
        />
      ) : null}
    </main>
  );
}

function SetupScreen({
  preRun,
  permissions,
  warmup,
  warmupStatus,
  appVisible,
  setPreRun,
  onGps,
  onArmGps,
  onStopWarmup,
  onMotion,
  onWakeLock,
  onStart,
}: {
  preRun: PreRunState;
  permissions: PermissionState;
  warmup: PreRunGpsWarmup;
  warmupStatus: { active: boolean; latestPoint: GpsPoint | null; latestAccuracy: number | null };
  appVisible: boolean;
  setPreRun: (next: PreRunState) => void;
  onGps: () => void;
  onArmGps: () => void;
  onStopWarmup: () => void;
  onMotion: () => void;
  onWakeLock: () => void;
  onStart: () => void;
}) {
  const [motionSkipped, setMotionSkipped] = useState(false);
  const [preflightOverride, setPreflightOverride] = useState(false);
  const setPain = (patch: Partial<PreRunState["pain_before_run"]>) => {
    setPreRun({
      ...preRun,
      pain_before_run: { ...preRun.pain_before_run, ...patch },
    });
  };
  const preflightItems = buildPreflightItems(preRun, permissions, warmupStatus, motionSkipped, appVisible);
  const preflightReady = preflightItems.every((item) => item.ok);
  const canStart = preflightReady || preflightOverride;

  return (
    <section className="screen-stack">
      <section className="status-grid">
        <StatusItem label="GPS" value={permissionLabel(permissions.geolocation_permission)} />
        <StatusItem label="Motion" value={permissionLabel(permissions.device_motion_permission)} />
        <StatusItem label="Wake lock" value={wakeLabel(permissions.wake_lock_status)} />
        <StatusItem label="Weather" value={weatherLabel(permissions.weather_status)} />
      </section>

      <section className="button-grid">
        <button type="button" className="secondary-button" onClick={onGps}>
          <MapPin size={18} />
          Request GPS
        </button>
        <button type="button" className="secondary-button" onClick={warmupStatus.active ? onStopWarmup : onArmGps}>
          <MapPin size={18} />
          {warmupStatus.active ? "Stop warmup" : "Arm GPS"}
        </button>
        <button type="button" className="secondary-button" onClick={onMotion}>
          <Activity size={18} />
          Request motion
        </button>
      </section>

      <section className="button-grid">
        <button type="button" className="secondary-button" onClick={onWakeLock}>
          <Lock size={18} />
          Enable wake lock
        </button>
      </section>

      {warmupStatus.active || warmup.armed_at_utc ? (
        <section className="warmup-panel">
          <div>
            <span>GPS warmup</span>
            <strong>{warmupReadyLabel(warmupStatus.latestAccuracy)}</strong>
          </div>
          <div>
            <span>Current accuracy</span>
            <strong>{formatAccuracy(warmupStatus.latestAccuracy)}</strong>
          </div>
          <div>
            <span>Best accuracy</span>
            <strong>{formatAccuracy(warmup.best_accuracy_meters)}</strong>
          </div>
        </section>
      ) : null}

      <section className="preflight-panel">
        <div className="preflight-header">
          <strong>Preflight</strong>
          <span>{preflightReady ? "ready" : "needs attention"}</span>
        </div>
        <div className="preflight-list">
          {preflightItems.map((item) => (
            <div className={item.ok ? "preflight-item ok" : "preflight-item warn"} key={item.label}>
              <span>{item.ok ? "OK" : "CHECK"}</span>
              <strong>{item.label}</strong>
              <small>{item.detail}</small>
            </div>
          ))}
        </div>
        <label className="preflight-check">
          <input
            type="checkbox"
            checked={motionSkipped}
            onChange={(event) => setMotionSkipped(event.target.checked)}
          />
          Skip motion for this run
        </label>
        {!preflightReady ? (
          <label className="preflight-check">
            <input
              type="checkbox"
              checked={preflightOverride}
              onChange={(event) => setPreflightOverride(event.target.checked)}
            />
            Start anyway
          </label>
        ) : null}
      </section>

      <button
        type="button"
        className="secondary-button full-width-button"
        onClick={() =>
          setPreRun({
            ...preRun,
            mode: "short_run_diagnostic",
            route_name: "Home block short run",
            intended_distance_meters: 1500,
            active_patch_id: CONTROLLED_START_PATCH_ID,
            route_direction: "unknown",
          })
        }
      >
        Use short run diagnostic
      </button>

      <button
        type="button"
        className="secondary-button full-width-button"
        onClick={() =>
          setPreRun({
            ...preRun,
            mode: "instrumentation_validation",
            route_name: "instrumentation validation",
            intended_distance_meters: 300,
          })
        }
      >
        Use validation mode
      </button>

      <button
        type="button"
        className="secondary-button full-width-button"
        onClick={() =>
          setPreRun({
            ...preRun,
            mode: "green_lake_5k_calibration",
            route_name: "Green Lake calibrated 5K",
            intended_distance_meters: 5000,
            active_patch_id: CONTROLLED_START_PATCH_ID,
            route_direction: "unknown",
          })
        }
      >
        Use Green Lake 5K calibration
      </button>

      <section className="preflight-panel">
        <div className="preflight-header">
          <strong>Strategy patch</strong>
          <span>{preRun.active_patch_id}</span>
        </div>
        <div className="preflight-list">
          <div className="preflight-item ok">
            <span>PATCH</span>
            <strong>controlled_start_v1</strong>
            <small>Mission: reduce late fade with a controlled first kilometer.</small>
          </div>
          {CONTROLLED_START_BANDS.map((band) => (
            <div className="preflight-item ok" key={band.km}>
              <span>{band.label}</span>
              <strong>{band.text}</strong>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="secondary-button full-width-button"
          onClick={() => setPreRun({ ...preRun, active_patch_id: CONTROLLED_START_PATCH_ID })}
        >
          Load controlled start
        </button>
      </section>

      {preRun.mode === "green_lake_5k_calibration" ? (
        <section className="preflight-panel">
          <div className="preflight-header">
            <strong>Green Lake checklist</strong>
            <span>before start</span>
          </div>
          <div className="preflight-list">
            {[
              "Install/open PWA",
              "Put phone in fixed position",
              "Arm GPS and wait for ready",
              "Confirm wake lock active",
              "Start actual run only when ready to move",
              "Keep app visible",
              "Stop after target reached banner",
            ].map((item) => (
              <div className="preflight-item ok" key={item}>
                <span>STEP</span>
                <strong>{item}</strong>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="form-panel">
        <ReadonlyField label="Runner ID" value={preRun.runner_id} />
        <ReadonlyField label="Goal" value={preRun.goal} />

        <label>
          Run mode
          <select
            value={preRun.mode}
            onChange={(event) => setPreRun(applyRunModeDefaults(preRun, event.target.value as RunMode))}
          >
            {RUN_MODE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          Active patch
          <select
            value={preRun.active_patch_id}
            onChange={(event) => setPreRun({ ...preRun, active_patch_id: event.target.value })}
          >
            <option value="baseline_calibration_v1">baseline_calibration_v1</option>
            <option value={CONTROLLED_START_PATCH_ID}>controlled_start_v1</option>
          </select>
        </label>

        <label>
          Route
          <input
            value={preRun.route_name}
            onChange={(event) => setPreRun({ ...preRun, route_name: event.target.value })}
          />
        </label>

        <label>
          Route direction
          <select
            value={preRun.route_direction}
            onChange={(event) =>
              setPreRun({ ...preRun, route_direction: event.target.value as RouteDirection })
            }
          >
            <option value="unknown">unknown</option>
            <option value="clockwise">clockwise</option>
            <option value="counterclockwise">counterclockwise</option>
          </select>
        </label>

        <label>
          Phone position
          <select
            value={preRun.phone_position}
            onChange={(event) => setPreRun({ ...preRun, phone_position: event.target.value as PhonePosition })}
          >
            <option value="unknown">unknown</option>
            <option value="waist_belt">waist belt</option>
            <option value="shorts_pocket">shorts pocket</option>
            <option value="armband">armband</option>
            <option value="handheld">handheld</option>
            <option value="other">other</option>
          </select>
        </label>

        <label>
          Target distance, meters
          <input
            type="number"
            min="100"
            inputMode="numeric"
            value={preRun.intended_distance_meters}
            onChange={(event) =>
              setPreRun({ ...preRun, intended_distance_meters: numberFromInput(event.target.value) ?? 5000 })
            }
          />
        </label>

        <label>
          Energy before
          <select
            value={preRun.energy_before_run_1_to_5 ?? ""}
            onChange={(event) =>
              setPreRun({ ...preRun, energy_before_run_1_to_5: numberFromInput(event.target.value) })
            }
          >
            <option value="">unknown</option>
            {[1, 2, 3, 4, 5].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>

        <label>
          Soreness before
          <select
            value={preRun.soreness_before_run}
            onChange={(event) =>
              setPreRun({ ...preRun, soreness_before_run: event.target.value as SorenessLevel })
            }
          >
            <SorenessOptions includeUnknown />
          </select>
        </label>

        <div className="toggle-row">
          <span>Pain before</span>
          <label className="switch-label">
            <input
              type="checkbox"
              checked={preRun.pain_before_run.present}
              onChange={(event) => setPain({ present: event.target.checked })}
            />
            <span>{preRun.pain_before_run.present ? "yes" : "no"}</span>
          </label>
        </div>

        {preRun.pain_before_run.present ? (
          <div className="paired-fields">
            <label>
              Pain location
              <input
                value={preRun.pain_before_run.location ?? ""}
                onChange={(event) => setPain({ location: event.target.value || null })}
              />
            </label>
            <label>
              Pain severity
              <input
                type="number"
                min="1"
                max="10"
                inputMode="numeric"
                value={preRun.pain_before_run.severity_1_to_10 ?? ""}
                onChange={(event) => setPain({ severity_1_to_10: numberFromInput(event.target.value) })}
              />
            </label>
          </div>
        ) : null}

        <label>
          Pre-run note
          <textarea
            rows={3}
            value={preRun.free_text}
            onChange={(event) => setPreRun({ ...preRun, free_text: event.target.value })}
          />
        </label>
      </section>

      <button type="button" className="primary-button sticky-action" onClick={onStart} disabled={!canStart}>
        <Play size={20} />
        {warmup.armed_at_utc ? "Start actual run" : "Start run"}
      </button>
    </section>
  );
}

function LiveScreen({
  run,
  elapsedSeconds,
  liveStats,
  targetReached,
  gpsStaleSeconds,
  onCheckpoint,
  onStop,
  onDiscard,
}: {
  run: ActiveRun;
  elapsedSeconds: number;
  liveStats: ReturnType<typeof computeLiveStats>;
  targetReached: boolean;
  gpsStaleSeconds: number;
  onCheckpoint: () => void;
  onStop: () => void;
  onDiscard: () => void;
}) {
  const remainingMeters = Math.max(0, run.pre_run.intended_distance_meters - liveStats.distanceMeters);
  const gpsStale = gpsStaleSeconds > 10;
  const strategyStatus =
    run.pre_run.active_patch_id === CONTROLLED_START_PATCH_ID ? computeControlledStartStatus(run.gps_points) : null;

  return (
    <section className="screen-stack live-screen">
      {targetReached ? (
        <section className="target-banner">
          <strong>Target reached</strong>
          <span>You can stop now.</span>
        </section>
      ) : null}

      {gpsStale ? (
        <section className="warning-banner">
          <strong>GPS stale</strong>
          <span>Keep app visible.</span>
        </section>
      ) : null}

      {run.permissions.wake_lock_available && run.permissions.wake_lock_status !== "active" ? (
        <section className="warning-banner">
          <strong>Wake lock inactive</strong>
          <span>Keep screen on.</span>
        </section>
      ) : null}

      <section className="metric-hero">
        <div>
          <span>Elapsed</span>
          <strong>{formatDuration(elapsedSeconds)}</strong>
        </div>
        <div>
          <span>Distance</span>
          <strong>{formatMeters(liveStats.distanceMeters)}</strong>
        </div>
      </section>

      <section className="metrics-grid">
        <Metric label="Average pace" value={formatPace(liveStats.averagePaceSecondsPerMile)} />
        <Metric label="Current pace" value={formatPace(liveStats.currentPaceSecondsPerMile)} />
        <Metric label="GPS accuracy" value={formatAccuracy(liveStats.lastAccuracy)} />
        <Metric label="Remaining" value={formatMeters(remainingMeters)} />
      </section>

      {strategyStatus ? (
        <section className="health-panel">
          <div className="health-header">
            <strong>Controlled start</strong>
            <span>{strategyStatus.statusLabel}</span>
          </div>
          <div className="health-grid">
            <div className="health-item ok">
              <span>Current km</span>
              <strong>{strategyStatus.band.label}</strong>
            </div>
            <div className={strategyStatus.status === "outside" ? "health-item warn" : "health-item ok"}>
              <span>Split pace</span>
              <strong>{formatPaceKm(strategyStatus.currentSplitSecondsPerKm)}</strong>
            </div>
            <div className="health-item ok">
              <span>Target</span>
              <strong>{strategyStatus.band.text}</strong>
            </div>
          </div>
        </section>
      ) : null}

      <LiveMap run={run} liveStats={liveStats} />

      <section className="status-grid compact">
        <StatusItem label="GPS points" value={String(run.gps_points.length)} />
        <StatusItem label="Motion windows" value={String(run.motion_windows.length)} />
        <StatusItem label="Wake lock" value={wakeLabel(run.permissions.wake_lock_status)} />
        <StatusItem label="Recording" value={gpsStale ? "GPS stale" : "healthy"} />
        <StatusItem label="Weather" value={weatherLabel(run.permissions.weather_status)} />
      </section>

      <section className="button-grid">
        <button type="button" className="secondary-button" onClick={onCheckpoint}>
          <Clipboard size={18} />
          Checkpoint
        </button>
        <button type="button" className="danger-button" onClick={onStop}>
          <Square size={18} />
          Stop run
        </button>
      </section>

      <button type="button" className="link-button" onClick={onDiscard}>
        Emergency discard
      </button>
    </section>
  );
}

function LiveMap({
  run,
  liveStats,
}: {
  run: ActiveRun;
  liveStats: ReturnType<typeof computeLiveStats>;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);
  const [tileFailure, setTileFailure] = useState(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) {
      return undefined;
    }

    const map = L.map(containerRef.current, {
      attributionControl: false,
      zoomControl: false,
      dragging: true,
    }).setView([47.679, -122.328], 14);

    const tileLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      crossOrigin: true,
    });
    tileLayer.on("tileerror", () => setTileFailure(true));
    tileLayer.addTo(map);

    layerGroupRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      layerGroupRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layers = layerGroupRef.current;
    if (!map || !layers) {
      return;
    }

    layers.clearLayers();
    const points = run.gps_points;
    if (points.length === 0) {
      return;
    }

    const latLngs = points.map((point) => L.latLng(point.lat, point.lon));
    const first = points[0];
    const latest = points[points.length - 1];

    L.polyline(latLngs, { color: "#12683f", weight: 4, opacity: 0.85 }).addTo(layers);
    L.circleMarker([first.lat, first.lon], {
      radius: 6,
      color: "#0f5d38",
      fillColor: "#ffffff",
      fillOpacity: 1,
      weight: 3,
    }).addTo(layers);
    L.circleMarker([latest.lat, latest.lon], {
      radius: 7,
      color: "#10231b",
      fillColor: "#2dd078",
      fillOpacity: 1,
      weight: 3,
    }).addTo(layers);

    if (latest.horizontal_accuracy_meters !== null) {
      L.circle([latest.lat, latest.lon], {
        radius: latest.horizontal_accuracy_meters,
        color: "#2b7a58",
        fillColor: "#2b7a58",
        fillOpacity: 0.1,
        weight: 1,
      }).addTo(layers);
    }

    for (let i = 1; i < points.length; i += 1) {
      const gap = points[i].t_elapsed_seconds - points[i - 1].t_elapsed_seconds;
      if (gap > 5) {
        L.circleMarker([(points[i].lat + points[i - 1].lat) / 2, (points[i].lon + points[i - 1].lon) / 2], {
          radius: gap > 10 ? 7 : 5,
          color: "#b15b00",
          fillColor: "#ffb35b",
          fillOpacity: 0.9,
          weight: 2,
        }).addTo(layers);
      }
    }

    const targetCheckpoint = run.checkpoints.find((checkpoint) => checkpoint.label === "target_distance_reached");
    if (targetCheckpoint) {
      const targetPoint = nearestPointByElapsed(points, targetCheckpoint.t_elapsed_seconds);
      if (targetPoint) {
        L.circleMarker([targetPoint.lat, targetPoint.lon], {
          radius: 8,
          color: "#12683f",
          fillColor: "#f7d154",
          fillOpacity: 1,
          weight: 3,
        }).addTo(layers);
      }
    }

    const bounds = L.latLngBounds(latLngs);
    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.25), { animate: false, maxZoom: 17 });
    }
  }, [run.checkpoints, run.gps_points]);

  return (
    <section className="map-panel">
      <div className="map-toolbar">
        <span>
          <MapIcon size={15} />
          Track
        </span>
        <strong>{formatMeters(liveStats.distanceMeters)}</strong>
      </div>
      <div className="map-frame">
        <div ref={containerRef} className="live-map" />
        {tileFailure ? (
          <div className="map-fallback-message">
            Map tiles unavailable. Recording still active.
          </div>
        ) : null}
      </div>
    </section>
  );
}

function StopScreen({
  run,
  elapsedSeconds,
  liveStats,
  onContinue,
  onResume,
  onDiscard,
}: {
  run: ActiveRun;
  elapsedSeconds: number;
  liveStats: ReturnType<typeof computeLiveStats>;
  onContinue: () => void;
  onResume: () => void;
  onDiscard: () => void;
}) {
  const exportPayload = buildExportPayload(run);
  const medianAccuracy = exportPayload.gps_quality.median_horizontal_accuracy_meters as number | null;
  const activityWindow = exportPayload.activity_window;
  const activeTarget = exportPayload.active_target_distance_result;
  const activeReliability = exportPayload.data_quality_scores.active_window_reliability;

  return (
    <section className="screen-stack">
      <section className="result-panel">
        <h2>Run stopped.</h2>
        <div className="metrics-grid">
          <Metric label="Duration" value={formatDuration(elapsedSeconds)} />
          <Metric label="Distance" value={formatMeters(liveStats.distanceMeters)} />
          <Metric label="Average pace" value={formatPace(liveStats.averagePaceSecondsPerMile)} />
          <Metric label="GPS quality" value={medianAccuracy === null ? "unknown" : `${medianAccuracy} m median`} />
        </div>
      </section>

      <section className="health-panel">
        <div className="health-header">
          <strong>Detected run facts</strong>
          <span>{activityWindow.analysis_basis}</span>
        </div>
        <div className="health-grid">
          <div className="health-item ok">
            <span>Idle preamble</span>
            <strong>{activityWindow.idle_preamble_seconds === null ? "unknown" : `${Math.round(activityWindow.idle_preamble_seconds)} s`}</strong>
          </div>
          <div className={activeTarget.target_reached ? "health-item ok" : "health-item warn"}>
            <span>Target</span>
            <strong>{activeTarget.target_reached ? "reached" : "not reached"}</strong>
          </div>
          <div className={activeReliability === "low" ? "health-item warn" : "health-item ok"}>
            <span>Active GPS</span>
            <strong>{activeReliability}</strong>
          </div>
          <div className="health-item ok">
            <span>Post-stop filter</span>
            <strong>{exportPayload.finalization.points_excluded_after_stop} excluded</strong>
          </div>
        </div>
      </section>

      <section className="button-grid vertical">
        <button type="button" className="primary-button" onClick={onContinue}>
          Save and continue
        </button>
        <button type="button" className="secondary-button" onClick={onResume}>
          <RefreshCw size={18} />
          Resume run
        </button>
        <button type="button" className="danger-button" onClick={onDiscard}>
          <Trash2 size={18} />
          Discard run
        </button>
      </section>
    </section>
  );
}

function PostRunScreen({
  run,
  postRun,
  updatePostRun,
  updatePostRunPain,
  onExport,
}: {
  run: ActiveRun;
  postRun: PostRunState;
  updatePostRun: (patch: Partial<PostRunState>) => void;
  updatePostRunPain: (patch: Partial<PostRunState["pain_after_run"]>) => void;
  onExport: () => void;
}) {
  const exportPayload = buildExportPayload(run);
  const debriefRequired =
    run.pre_run.mode === "training_calibration" || run.pre_run.mode === "green_lake_5k_calibration";
  const debriefComplete = subjectiveDebriefCompleteForApp(postRun);
  const skipComplete = postRun.subjective_debrief_skipped && Boolean(postRun.subjective_debrief_skip_reason?.trim());
  const canContinue = !debriefRequired || debriefComplete || skipComplete;

  return (
    <section className="screen-stack">
      <section className="health-panel">
        <div className="health-header">
          <strong>Objective facts I inferred</strong>
          <span>{exportPayload.data_quality_scores.pace_confidence}</span>
        </div>
        <div className="preflight-list">
          {exportPayload.grounded_debrief_context.objective_facts.slice(0, 4).map((fact) => (
            <div className="preflight-item ok" key={fact}>
              <span>FACT</span>
              <strong>{fact}</strong>
            </div>
          ))}
          {exportPayload.targeted_followup_prompts.slice(0, 2).map((prompt) => (
            <div className="preflight-item warn" key={prompt.id}>
              <span>FOLLOW</span>
              <strong>{prompt.prompt}</strong>
              <small>{prompt.reason}</small>
            </div>
          ))}
        </div>
      </section>

      <section className="form-panel">
        <section className="preflight-panel">
          <div className="preflight-header">
            <strong>RPE anchors</strong>
            <span>effort</span>
          </div>
          <div className="preflight-list">
            {RPE_ANCHORS.map((anchor) => (
              <div className="preflight-item ok" key={anchor}>
                <span>RPE</span>
                <strong>{anchor}</strong>
              </div>
            ))}
          </div>
        </section>

        <label>
          RPE
          <select
            value={postRun.rpe_1_to_10 ?? ""}
            onChange={(event) => {
              const value = numberFromInput(event.target.value);
              updatePostRun({
                rpe_1_to_10: value,
                rpe_estimation_source: value === null ? "not_answered" : "manual",
              });
            }}
          >
            <option value="">unknown</option>
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>

        <label>
          How did it feel?
          <select
            value={postRun.perceived_effort_simple}
            onChange={(event) => {
              const effort = event.target.value as SimpleEffort;
              const fallbackRpe = rpeFromSimpleEffort(effort);
              updatePostRun({
                perceived_effort_simple: effort,
                rpe_1_to_10: fallbackRpe,
                rpe_estimation_source: fallbackRpe === null ? "not_answered" : "simple_effort_fallback",
              });
            }}
          >
            <option value="unknown">unknown</option>
            <option value="easy">easy</option>
            <option value="moderate">moderate</option>
            <option value="hard">hard</option>
            <option value="very_hard">very hard</option>
            <option value="max">max</option>
            <option value="not_sure">not sure</option>
          </select>
        </label>

        <label>
          Energy after
          <select
            value={postRun.energy_after_run_1_to_5 ?? ""}
            onChange={(event) =>
              updatePostRun({ energy_after_run_1_to_5: numberFromInput(event.target.value) })
            }
          >
            <option value="">unknown</option>
            {[1, 2, 3, 4, 5].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>

        <label>
          Soreness after
          <select
            value={postRun.soreness_after_run}
            onChange={(event) => updatePostRun({ soreness_after_run: event.target.value as SorenessLevel })}
          >
            <SorenessOptions includeUnknown />
          </select>
        </label>

        <div className="toggle-row">
          <span>Pain after</span>
          <label className="switch-label">
            <input
              type="checkbox"
              checked={postRun.pain_after_run.present}
              onChange={(event) => updatePostRunPain({ present: event.target.checked })}
            />
            <span>{postRun.pain_after_run.present ? "yes" : "no"}</span>
          </label>
        </div>

        {postRun.pain_after_run.present ? (
          <div className="paired-fields">
            <label>
              Pain location
              <input
                value={postRun.pain_after_run.location ?? ""}
                onChange={(event) => updatePostRunPain({ location: event.target.value || null })}
              />
            </label>
            <label>
              Pain severity
              <input
                type="number"
                min="1"
                max="10"
                inputMode="numeric"
                value={postRun.pain_after_run.severity_1_to_10 ?? ""}
                onChange={(event) =>
                  updatePostRunPain({ severity_1_to_10: numberFromInput(event.target.value) })
                }
              />
            </label>
          </div>
        ) : null}

        <label>
          Primary limiter
          <select
            value={postRun.primary_limiter}
            onChange={(event) => updatePostRun({ primary_limiter: event.target.value as PrimaryLimiter })}
          >
            <option value="unknown">unknown</option>
            <option value="breathing">breathing</option>
            <option value="legs">legs</option>
            <option value="heat">heat</option>
            <option value="hills">hills</option>
            <option value="motivation">motivation</option>
            <option value="other">other</option>
          </select>
        </label>

        <div className="paired-fields">
          <label>
            Immediate pulse
            <input
              type="number"
              min="1"
              inputMode="numeric"
              value={postRun.immediate_pulse_bpm_manual ?? ""}
              onChange={(event) => updatePostRun({ immediate_pulse_bpm_manual: numberFromInput(event.target.value) })}
            />
          </label>
          <label>
            Pulse 3-5 min
            <input
              type="number"
              min="1"
              inputMode="numeric"
              value={postRun.pulse_after_3_to_5_min_bpm_manual ?? ""}
              onChange={(event) =>
                updatePostRun({ pulse_after_3_to_5_min_bpm_manual: numberFromInput(event.target.value) })
              }
            />
          </label>
        </div>

        <label>
          Breathing recovered after
          <select
            value={postRun.breathing_recovered_after}
            onChange={(event) =>
              updatePostRun({ breathing_recovered_after: event.target.value as BreathingRecoveredAfter })
            }
          >
            <option value="unknown">unknown</option>
            <option value="<1 min">&lt;1 min</option>
            <option value="1-3 min">1-3 min</option>
            <option value="3-5 min">3-5 min</option>
            <option value=">5 min">&gt;5 min</option>
          </select>
        </label>

        <label>
          Post-run note
          <textarea
            rows={4}
            value={postRun.free_text}
            onChange={(event) => updatePostRun({ free_text: event.target.value })}
          />
        </label>

        {debriefRequired ? (
          <section className="preflight-panel">
            <div className="preflight-header">
              <strong>Subjective debrief</strong>
              <span>{debriefComplete ? "complete" : skipComplete ? "skipped" : "required"}</span>
            </div>
            <label className="preflight-check">
              <input
                type="checkbox"
                checked={postRun.subjective_debrief_skipped}
                onChange={(event) =>
                  updatePostRun({
                    subjective_debrief_skipped: event.target.checked,
                    subjective_debrief_skip_reason: event.target.checked
                      ? postRun.subjective_debrief_skip_reason
                      : null,
                  })
                }
              />
              Skip subjective debrief
            </label>
            {postRun.subjective_debrief_skipped ? (
              <label>
                Skip reason
                <input
                  value={postRun.subjective_debrief_skip_reason ?? ""}
                  onChange={(event) =>
                    updatePostRun({ subjective_debrief_skip_reason: event.target.value || null })
                  }
                />
              </label>
            ) : null}
            {!canContinue ? (
              <p className="filename">RPE, energy, soreness, pain status, and limiter are required for calibration unless skipped with a reason.</p>
            ) : null}
          </section>
        ) : null}
      </section>

      <button type="button" className="primary-button sticky-action" onClick={onExport} disabled={!canContinue}>
        Continue to export
      </button>
    </section>
  );
}

function ExportScreen({
  exportPayload,
  exportJson,
  exportArtifacts,
  filename,
  onDownload,
  onCopy,
  onShare,
  onDownloadMsgpack,
  onCopyMsgpack,
  onDownloadZip,
  onCopyZip,
  onBackToPost,
  onDiscard,
}: {
  exportPayload: ExportPayload | null;
  exportJson: string;
  exportArtifacts: ExportArtifacts | null;
  filename: string;
  onDownload: () => void;
  onCopy: () => void;
  onShare: () => void;
  onDownloadMsgpack: () => void;
  onCopyMsgpack: () => void;
  onDownloadZip: () => void;
  onCopyZip: () => void;
  onBackToPost: () => void;
  onDiscard: () => void;
}) {
  const health = exportPayload ? buildRunHealth(exportPayload) : [];

  return (
    <section className="screen-stack">
      <section className="result-panel">
        <h2>Export ready</h2>
        <p className="filename">{filename}</p>
      </section>

      {health.length > 0 ? (
        <section className="health-panel">
          <div className="health-header">
            <strong>Run health</strong>
            <span>{health.some((item) => item.status === "warn") ? "review" : "ready"}</span>
          </div>
          <div className="health-grid">
            {health.map((item) => (
              <div className={`health-item ${item.status}`} key={item.label}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {exportArtifacts ? (
        <section className="health-panel">
          <div className="health-header">
            <strong>Export sizes</strong>
            <span>try smaller</span>
          </div>
          <div className="health-grid">
            <div className="health-item ok">
              <span>JSON</span>
              <strong>{formatBytes(exportArtifacts.json_bytes)}</strong>
            </div>
            <div className="health-item ok">
              <span>MessagePack</span>
              <strong>{formatBytes(exportArtifacts.msgpack_bytes.byteLength)}</strong>
            </div>
            <div className="health-item ok">
              <span>ZIP</span>
              <strong>{formatBytes(exportArtifacts.zip_bytes.byteLength)}</strong>
            </div>
          </div>
        </section>
      ) : null}

      <section className="button-grid vertical">
        <button type="button" className="primary-button" onClick={onDownload}>
          <Download size={18} />
          Download JSON
        </button>
        <button type="button" className="secondary-button" onClick={onShare}>
          <Share2 size={18} />
          Share JSON
        </button>
        <button type="button" className="secondary-button" onClick={onCopy}>
          <Clipboard size={18} />
          Copy JSON
        </button>
      </section>

      <section className="button-grid vertical">
        <button type="button" className="secondary-button" onClick={onDownloadMsgpack}>
          <Download size={18} />
          Download MessagePack
        </button>
        <button type="button" className="secondary-button" onClick={onCopyMsgpack}>
          <Clipboard size={18} />
          Copy MessagePack base64
        </button>
        <button type="button" className="secondary-button" onClick={onDownloadZip}>
          <Download size={18} />
          Download ZIP
        </button>
        <button type="button" className="secondary-button" onClick={onCopyZip}>
          <Clipboard size={18} />
          Copy ZIP base64
        </button>
      </section>

      <textarea className="json-preview" readOnly value={exportJson} />

      <section className="button-grid">
        <button type="button" className="secondary-button" onClick={onBackToPost}>
          Edit post-run
        </button>
        <button type="button" className="link-button" onClick={onDiscard}>
          Clear local draft
        </button>
      </section>
    </section>
  );
}

function StatusItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="status-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function buildPreflightItems(
  preRun: PreRunState,
  permissions: PermissionState,
  warmupStatus: { latestAccuracy: number | null },
  motionSkipped: boolean,
  appVisible: boolean,
) {
  const gpsOk =
    warmupStatus.latestAccuracy !== null && warmupStatus.latestAccuracy <= ACCEPTABLE_GPS_ACCURACY_METERS;
  const motionOk =
    motionSkipped ||
    permissions.device_motion_permission === "ready" ||
    permissions.device_motion_permission === "denied" ||
    permissions.device_motion_permission === "unavailable";
  const targetOk = Number.isFinite(preRun.intended_distance_meters) && preRun.intended_distance_meters >= 100;

  return [
    {
      label: "GPS warmed",
      ok: gpsOk,
      detail: gpsOk ? formatAccuracy(warmupStatus.latestAccuracy) : "arm GPS and wait for <=25 m",
    },
    {
      label: "Wake lock active",
      ok: permissions.wake_lock_status === "active",
      detail: permissions.wake_lock_status === "active" ? "screen should stay on" : "enable wake lock or keep screen on",
    },
    {
      label: "Motion decision",
      ok: motionOk,
      detail:
        permissions.device_motion_permission === "ready"
          ? "motion ready"
          : motionSkipped
            ? "motion skipped"
            : "request motion or skip it",
    },
    {
      label: "App visible",
      ok: appVisible,
      detail: appVisible ? "foreground tab" : "bring app to foreground",
    },
    {
      label: "Target set",
      ok: targetOk,
      detail: targetOk ? `${Math.round(preRun.intended_distance_meters)} m` : "set at least 100 m",
    },
  ];
}

function buildRunHealth(exportPayload: ExportPayload) {
  const lifecycle = exportPayload.recording_lifecycle;
  const hiddenEvents =
    lifecycle.visibility_events.filter((event) => event.visibility_state === "hidden").length +
    lifecycle.pagehide_events.length;
  const staleCount = lifecycle.gps_stale_event_count;
  const wakeActive =
    Boolean(exportPayload.permissions_and_capabilities.wake_lock_used) ||
    lifecycle.wake_lock_events.some((event) => event.status === "active");
  const rawDistance = exportPayload.interpolation_features.raw_recorded_distance_meters;
  const interpolatedDistance = exportPayload.interpolation_features.interpolated_distance_estimate_meters;
  const distanceConfidence = exportPayload.data_quality_scores.distance_confidence;
  const motionWindows = Number(exportPayload.motion_features.window_count ?? 0);
  const motionDebug = exportPayload.motion_features.motion_permission_debug as
    | { sample_events_seen?: number; request_status?: string }
    | undefined;
  const motionSamples = motionWindows > 0 || Number(motionDebug?.sample_events_seen ?? 0) > 0;
  const shortRunUsable = exportPayload.short_run_diagnostic.short_run_usable;

  return [
    {
      label: "Target",
      value: exportPayload.active_target_distance_result.target_reached
        ? "reached"
        : shortRunUsable
          ? "short run"
          : "not reached",
      status: exportPayload.active_target_distance_result.target_reached || shortRunUsable ? "ok" : "warn",
    },
    {
      label: "Wake lock",
      value: wakeActive ? "used" : "not used",
      status: wakeActive ? "ok" : "warn",
    },
    {
      label: "Background",
      value: `${hiddenEvents}`,
      status: hiddenEvents === 0 ? "ok" : "warn",
    },
    {
      label: "GPS stale",
      value: `${staleCount}`,
      status: staleCount === 0 ? "ok" : "warn",
    },
    {
      label: "Missing GPS",
      value: `${Math.round(lifecycle.missing_gps_time_seconds)} s`,
      status: lifecycle.missing_gps_time_seconds <= 5 ? "ok" : "warn",
    },
    {
      label: "Distance",
      value:
        rawDistance === null || interpolatedDistance === null
          ? "unknown"
          : `${Math.round(rawDistance)} m raw / ${Math.round(interpolatedDistance)} m est`,
      status: distanceConfidence === "high" ? "ok" : "warn",
    },
    {
      label: "Confidence",
      value: `${exportPayload.data_quality_scores.active_window_reliability}/${distanceConfidence}`,
      status: exportPayload.data_quality_scores.active_window_reliability === "low" ? "warn" : "ok",
    },
    {
      label: "Motion",
      value: motionSamples ? "samples" : motionDebug?.request_status ?? "none",
      status: motionSamples ? "ok" : "warn",
    },
  ] satisfies Array<{ label: string; value: string; status: "ok" | "warn" }>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ReadonlyField({ label, value }: { label: string; value: string }) {
  return (
    <label>
      {label}
      <input value={value} readOnly />
    </label>
  );
}

function SorenessOptions({ includeUnknown = false }: { includeUnknown?: boolean }) {
  return (
    <>
      {includeUnknown ? <option value="unknown">unknown</option> : null}
      <option value="none">none</option>
      <option value="mild">mild</option>
      <option value="moderate">moderate</option>
      <option value="severe">severe</option>
    </>
  );
}

function applyRunModeDefaults(preRun: PreRunState, mode: RunMode): PreRunState {
  if (mode === "green_lake_5k_calibration") {
    return {
      ...preRun,
      mode,
      route_name: "Green Lake calibrated 5K",
      intended_distance_meters: 5000,
      active_patch_id: preRun.active_patch_id || CONTROLLED_START_PATCH_ID,
    };
  }
  if (mode === "short_run_diagnostic") {
    return {
      ...preRun,
      mode,
      route_name: preRun.route_name.toLowerCase().includes("green lake") ? "Home block short run" : preRun.route_name,
      intended_distance_meters: preRun.intended_distance_meters === 5000 ? 1500 : preRun.intended_distance_meters,
      active_patch_id: preRun.active_patch_id || CONTROLLED_START_PATCH_ID,
    };
  }
  if (mode === "instrumentation_validation") {
    return {
      ...preRun,
      mode,
      route_name: "instrumentation validation",
      intended_distance_meters: 300,
    };
  }
  return {
    ...preRun,
    mode,
  };
}

function loadStoredRun(): ActiveRun | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    return normalizeStoredRun(JSON.parse(raw) as Partial<ActiveRun>);
  } catch {
    return null;
  }
}

function normalizeStoredRun(run: Partial<ActiveRun>): ActiveRun {
  const postRun = {
    ...defaultPostRun,
    ...run.post_run,
    pain_after_run: {
      ...defaultPostRun.pain_after_run,
      ...run.post_run?.pain_after_run,
    },
  };
  return {
    status: run.status ?? (run.run_metadata?.end_time_utc ? "stopped" : "running"),
    run_metadata: run.run_metadata!,
    pre_run: run.pre_run ?? defaultPreRun,
    post_run: postRun,
    permissions: { ...defaultPermissions(), ...run.permissions },
    weather: run.weather ?? {
      start_weather: emptyWeatherSnapshot(true),
      finish_weather: emptyWeatherSnapshot(false),
    },
    gps_points: run.gps_points ?? [],
    motion_windows: run.motion_windows ?? [],
    checkpoints: run.checkpoints ?? [],
    data_quality_notes: run.data_quality_notes ?? [],
    recording_lifecycle: {
      ...defaultRecordingLifecycle(),
      ...run.recording_lifecycle,
    },
    pre_run_gps_warmup: { ...defaultWarmup(), ...run.pre_run_gps_warmup },
    motion_debug: { ...defaultMotionDebug(), ...run.motion_debug },
    pwa_state: { ...detectPwaState(), ...run.pwa_state },
    finalization: { ...defaultFinalization(), ...run.finalization },
    elapsed_offset_seconds: run.elapsed_offset_seconds ?? 0,
    last_saved_at_utc: run.last_saved_at_utc ?? new Date().toISOString(),
  };
}

function saveRouteMemory(exportPayload: ExportPayload) {
  const routeId = exportPayload.route_features.route_id;
  if (typeof routeId !== "string" || routeId.length === 0) {
    return;
  }
  try {
    const raw = localStorage.getItem(ROUTE_MEMORY_KEY);
    const current = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    current[routeId] = {
      route_id: routeId,
      route_type: exportPayload.route_features.route_type ?? null,
      route_name: exportPayload.pre_run.route_name ?? null,
      last_run_id: exportPayload.run_metadata.run_id ?? null,
      updated_at_utc: exportPayload.app.created_at_utc,
      active_distance_meters: exportPayload.active_summary.distance_meters ?? null,
      bounding_box: exportPayload.route_features.bounding_box ?? null,
      course_fingerprint: exportPayload.green_lake_calibration.course_fingerprint,
    };
    localStorage.setItem(ROUTE_MEMORY_KEY, JSON.stringify(current));
  } catch {
    // Route memory is opportunistic; export should never depend on localStorage writes.
  }
}

function buildExportArtifacts(exportPayload: ExportPayload, exportJson: string, jsonFilename: string): ExportArtifacts {
  const msgpackBytes = encodeMsgpack(exportPayload);
  return {
    json_bytes: new TextEncoder().encode(exportJson).byteLength,
    msgpack_bytes: msgpackBytes,
    msgpack_filename: replaceFileExtension(jsonFilename, ".msgpack"),
    zip_bytes: zipSync({ [jsonFilename]: strToU8(exportJson) }, { level: 9 }),
    zip_filename: replaceFileExtension(jsonFilename, ".json.zip"),
  };
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function bytesToBlob(bytes: Uint8Array, type: string): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer], { type });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.byteLength; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function replaceFileExtension(filename: string, extension: string): string {
  return filename.replace(/\.json$/i, extension);
}

function createMotionBucket(start: number): MotionBucket {
  return {
    start,
    end: start + MOTION_WINDOW_SECONDS,
    sampleCount: 0,
    accelX: [],
    accelY: [],
    accelZ: [],
    accelMagnitude: [],
    accelIncludingGravityMagnitude: [],
    rotationAlpha: [],
    rotationBeta: [],
    rotationGamma: [],
    rotationMagnitude: [],
  };
}

function addMotionSample(bucket: MotionBucket | null, event: DeviceMotionEvent) {
  if (!bucket) {
    return;
  }
  bucket.sampleCount += 1;

  const ax = numeric(event.acceleration?.x);
  const ay = numeric(event.acceleration?.y);
  const az = numeric(event.acceleration?.z);
  const gx = numeric(event.accelerationIncludingGravity?.x);
  const gy = numeric(event.accelerationIncludingGravity?.y);
  const gz = numeric(event.accelerationIncludingGravity?.z);
  const alpha = numeric(event.rotationRate?.alpha);
  const beta = numeric(event.rotationRate?.beta);
  const gamma = numeric(event.rotationRate?.gamma);

  pushIfNumber(bucket.accelX, ax);
  pushIfNumber(bucket.accelY, ay);
  pushIfNumber(bucket.accelZ, az);
  pushIfNumber(bucket.rotationAlpha, alpha);
  pushIfNumber(bucket.rotationBeta, beta);
  pushIfNumber(bucket.rotationGamma, gamma);

  if (ax !== null && ay !== null && az !== null) {
    bucket.accelMagnitude.push(Math.sqrt(ax * ax + ay * ay + az * az));
  }
  if (gx !== null && gy !== null && gz !== null) {
    bucket.accelIncludingGravityMagnitude.push(Math.sqrt(gx * gx + gy * gy + gz * gz));
  }
  if (alpha !== null && beta !== null && gamma !== null) {
    bucket.rotationMagnitude.push(Math.sqrt(alpha * alpha + beta * beta + gamma * gamma));
  }
}

function summarizeMotionBucket(bucket: MotionBucket): MotionWindow {
  const duration = Math.max(0.001, bucket.end - bucket.start);
  return {
    window_start_elapsed_seconds: round(bucket.start, 2),
    window_end_elapsed_seconds: round(bucket.end, 2),
    sample_count: bucket.sampleCount,
    accel_x_mean: roundOrNull(mean(bucket.accelX), 5),
    accel_y_mean: roundOrNull(mean(bucket.accelY), 5),
    accel_z_mean: roundOrNull(mean(bucket.accelZ), 5),
    accel_magnitude_mean: roundOrNull(mean(bucket.accelMagnitude), 5),
    accel_magnitude_std: roundOrNull(std(bucket.accelMagnitude), 5),
    accel_magnitude_max: roundOrNull(max(bucket.accelMagnitude), 5),
    accel_including_gravity_magnitude_mean: roundOrNull(mean(bucket.accelIncludingGravityMagnitude), 5),
    rotation_alpha_std: roundOrNull(std(bucket.rotationAlpha), 5),
    rotation_beta_std: roundOrNull(std(bucket.rotationBeta), 5),
    rotation_gamma_std: roundOrNull(std(bucket.rotationGamma), 5),
    estimated_motion_frequency_hz_optional: round(bucket.sampleCount / duration, 3),
    rotation_rate_magnitude_mean: roundOrNull(mean(bucket.rotationMagnitude), 5),
    rotation_rate_magnitude_std: roundOrNull(std(bucket.rotationMagnitude), 5),
  };
}

function haversineMetersForApp(a: Pick<GpsPoint, "lat" | "lon">, b: Pick<GpsPoint, "lat" | "lon">): number {
  const earthRadiusMeters = 6371000;
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const deltaLat = toRadians(b.lat - a.lat);
  const deltaLon = toRadians(b.lon - a.lon);
  const sinLat = Math.sin(deltaLat / 2);
  const sinLon = Math.sin(deltaLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function numeric(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pushIfNumber(values: number[], value: number | null) {
  if (value !== null) {
    values.push(value);
  }
}

function mean(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function std(values: number[]): number | null {
  if (values.length <= 1) {
    return values.length === 1 ? 0 : null;
  }
  const average = mean(values) ?? 0;
  const variance = mean(values.map((value) => (value - average) ** 2)) ?? 0;
  return Math.sqrt(variance);
}

function max(values: number[]): number | null {
  return values.length > 0 ? Math.max(...values) : null;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function roundOrNull(value: number | null, digits: number): number | null {
  return value === null ? null : round(value, digits);
}

function lifecycleEvent(event: string, elapsedSeconds: number): LifecycleEvent {
  return {
    event,
    timestamp_utc: new Date().toISOString(),
    t_elapsed_seconds: round(elapsedSeconds, 2),
  };
}

function numberFromInput(value: string): number | null {
  if (value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rpeFromSimpleEffort(value: SimpleEffort): number | null {
  switch (value) {
    case "easy":
      return 3;
    case "moderate":
      return 5;
    case "hard":
      return 7;
    case "very_hard":
      return 8;
    case "max":
      return 10;
    case "not_sure":
    case "unknown":
      return null;
  }
}

function formatDuration(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const secs = safeSeconds % 60;
  if (hours > 0) {
    return `${hours}:${pad2(minutes)}:${pad2(secs)}`;
  }
  return `${minutes}:${pad2(secs)}`;
}

function formatMeters(meters: number): string {
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(2)} km`;
  }
  return `${Math.round(meters)} m`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

function formatPace(secondsPerMile: number | null): string {
  if (secondsPerMile === null || !Number.isFinite(secondsPerMile)) {
    return "--";
  }
  const minutes = Math.floor(secondsPerMile / 60);
  const seconds = Math.round(secondsPerMile % 60);
  return `${minutes}:${pad2(seconds)} /mi`;
}

function formatPaceKm(secondsPerKm: number | null): string {
  if (secondsPerKm === null || !Number.isFinite(secondsPerKm)) {
    return "--";
  }
  const minutes = Math.floor(secondsPerKm / 60);
  const seconds = Math.round(secondsPerKm % 60);
  return `${minutes}:${pad2(seconds)} /km`;
}

function formatAccuracy(meters: number | null): string {
  return meters === null ? "unknown" : `${Math.round(meters)} m`;
}

function warmupReadyLabel(accuracy: number | null): string {
  if (accuracy === null) {
    return "warming";
  }
  return accuracy <= ACCEPTABLE_GPS_ACCURACY_METERS ? "GPS ready" : "improving";
}

function nearestPointByElapsed(points: GpsPoint[], elapsedSeconds: number): GpsPoint | null {
  if (points.length === 0) {
    return null;
  }
  return points.reduce((nearest, point) =>
    Math.abs(point.t_elapsed_seconds - elapsedSeconds) < Math.abs(nearest.t_elapsed_seconds - elapsedSeconds)
      ? point
      : nearest,
  );
}

function computeControlledStartStatus(points: GpsPoint[]) {
  if (points.length < 2) {
    return null;
  }
  const track = buildAppTrack(points);
  const latest = track[track.length - 1];
  const currentKm = Math.min(5, Math.max(1, Math.floor(latest.cumulative_meters / 1000) + 1));
  const band = CONTROLLED_START_BANDS[currentKm - 1];
  const kmStartDistance = (currentKm - 1) * 1000;
  const kmStartElapsed = elapsedAtDistanceForApp(track, kmStartDistance) ?? track[0].t_elapsed_seconds;
  const splitDistance = Math.max(0, latest.cumulative_meters - kmStartDistance);
  const splitElapsed = Math.max(0, latest.t_elapsed_seconds - kmStartElapsed);
  const currentSplitSecondsPerKm = splitDistance >= 50 ? splitElapsed / (splitDistance / 1000) : null;
  const inBand =
    currentSplitSecondsPerKm !== null &&
    band.minSecondsPerKm !== null &&
    band.maxSecondsPerKm !== null &&
    currentSplitSecondsPerKm >= band.minSecondsPerKm &&
    currentSplitSecondsPerKm <= band.maxSecondsPerKm;
  const outside =
    currentSplitSecondsPerKm !== null &&
    band.minSecondsPerKm !== null &&
    band.maxSecondsPerKm !== null &&
    !inBand;
  return {
    band,
    currentSplitSecondsPerKm,
    status: outside ? "outside" : "ok",
    statusLabel: band.minSecondsPerKm === null ? "steady" : inBand ? "in band" : outside ? "watch pace" : "warming",
  };
}

function buildAppTrack(points: GpsPoint[]): Array<GpsPoint & { cumulative_meters: number }> {
  let cumulative = 0;
  return points.map((point, index) => {
    if (index > 0 && !point.impossible_speed && !point.possible_gps_jump) {
      cumulative += haversineMetersForApp(points[index - 1], point);
    }
    return { ...point, cumulative_meters: cumulative };
  });
}

function elapsedAtDistanceForApp(
  track: Array<GpsPoint & { cumulative_meters: number }>,
  distanceMeters: number,
): number | null {
  if (track.length === 0) {
    return null;
  }
  if (distanceMeters <= 0) {
    return track[0].t_elapsed_seconds;
  }
  for (let i = 1; i < track.length; i += 1) {
    const previous = track[i - 1];
    const current = track[i];
    if (current.cumulative_meters < distanceMeters || current.cumulative_meters === previous.cumulative_meters) {
      continue;
    }
    const ratio = (distanceMeters - previous.cumulative_meters) / (current.cumulative_meters - previous.cumulative_meters);
    return previous.t_elapsed_seconds + (current.t_elapsed_seconds - previous.t_elapsed_seconds) * ratio;
  }
  return null;
}

function subjectiveDebriefCompleteForApp(postRun: PostRunState): boolean {
  const painComplete =
    !postRun.pain_after_run.present ||
    (Boolean(postRun.pain_after_run.location?.trim()) && postRun.pain_after_run.severity_1_to_10 !== null);
  return (
    postRun.rpe_1_to_10 !== null &&
    postRun.energy_after_run_1_to_5 !== null &&
    postRun.soreness_after_run !== "unknown" &&
    postRun.primary_limiter !== "unknown" &&
    painComplete
  );
}

function permissionLabel(value: string): string {
  return value === "ready" || value === "denied" || value === "unavailable" ? value : "unknown";
}

function wakeLabel(value: string): string {
  return value === "active" || value === "unavailable" || value === "failed" ? value : "inactive";
}

function weatherLabel(value: WeatherStatusText): string {
  switch (value) {
    case "fetched":
      return "fetched";
    case "fetching":
      return "fetching";
    case "unavailable":
      return "unavailable";
    default:
      return "will fetch after GPS";
  }
}

function screenLabel(screen: Screen): string {
  switch (screen) {
    case "setup":
      return "pre-run";
    case "live":
      return "live";
    case "stop":
      return "stopped";
    case "post":
      return "post-run";
    case "export":
      return "export";
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatLocalIso(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

function buildExportFilename(startTimeUtc: string): string {
  const date = new Date(startTimeUtc);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `greenlake_run_user_001_${get("year")}-${get("month")}-${get("day")}T${get("hour")}${get(
    "minute",
  )}${get("second")}.json`;
}
