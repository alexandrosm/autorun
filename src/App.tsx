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
import { Component, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import "leaflet/dist/leaflet.css";
import { buildExportPayload, computeLiveStats, createGpsPointFromPosition } from "./runMath";
import type { LiveStats } from "./runMath";
import type {
  ActiveRun,
  BreathingRecoveredAfter,
  Checkpoint,
  ExportPayload,
  FinalizationDiagnostics,
  GpsPoint,
  InRunNote,
  Interruption,
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
  YesNoUnsure,
} from "./types";
import { emptyWeatherSnapshot, fetchOpenMeteoWeather } from "./weather";

const APP_NAME = "Green Lake AutoResearch Logger";
const APP_VERSION = "0.1.18";
const TIMEZONE = "America/Los_Angeles";
const STORAGE_KEY = "greenlake_autoresearch_logger_active_run_v0_1";
const IDB_DB_NAME = "greenlake_autoresearch_logger";
const IDB_STORE_NAME = "runs";
const IDB_ACTIVE_RUN_KEY = "active_run";
const IDB_HISTORY_PREFIX = "completed_run:";
const RUN_HISTORY_INDEX_KEY = "greenlake_autoresearch_logger_run_history_index_v0_1";
const RUN_HISTORY_PAYLOAD_PREFIX = "greenlake_autoresearch_logger_run_history_payload:";
const MAX_RUN_HISTORY_ITEMS = 50;
const ROUTE_MEMORY_KEY = "greenlake_autoresearch_logger_route_memory_v0_1";
const CURRENT_PATCH_KEY = "greenlake_autoresearch_logger_current_patch_v0_1";
const LAB_SYNC_KEY = "greenlake_autoresearch_logger_lab_sync_v0_1";
const MSGPACK_MIME = "application/msgpack";
const ZIP_MIME = "application/zip";
const MOTION_WINDOW_SECONDS = 5;
const ACCEPTABLE_GPS_ACCURACY_METERS = 25;
const GPS_READY_ACCURACY_METERS = 25;
const GPS_READY_FIX_AGE_SECONDS = 5;
const START_GPS_TIMEOUT_SECONDS = 15;
const START_COUNTDOWN_SECONDS = 3;
const CONTROLLED_START_PATCH_ID = "controlled_start_v1";
const CONTROLLED_START_BANDS = [
  { km: 1, label: "Km 1", minSecondsPerKm: 335, maxSecondsPerKm: 340, text: "5:35-5:40" },
  { km: 2, label: "Km 2", minSecondsPerKm: 335, maxSecondsPerKm: 345, text: "5:35-5:45" },
  { km: 3, label: "Km 3", minSecondsPerKm: 340, maxSecondsPerKm: 350, text: "5:40-5:50" },
  { km: 4, label: "Km 4", minSecondsPerKm: null, maxSecondsPerKm: null, text: "hold steady" },
  { km: 5, label: "Km 5", minSecondsPerKm: null, maxSecondsPerKm: null, text: "squeeze only if stable" },
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
  coach_summary_json: string;
  coach_summary_bytes: number;
  coach_summary_filename: string;
  msgpack_bytes: Uint8Array;
  msgpack_filename: string;
  zip_bytes: Uint8Array;
  zip_filename: string;
}

interface RunHistoryEntry {
  history_id: string;
  run_id: string | null;
  filename: string;
  created_at_utc: string;
  start_time_utc: string | null;
  route_name: string;
  inferred_mode: string;
  route_id: string | null;
  distance_meters: number | null;
  duration_seconds: number | null;
  target_time_seconds: number | null;
  schema_version: string;
  app_version: string;
  json_bytes: number;
  gps_point_count: number;
  in_run_note_count: number;
  storage_kind: "indexeddb" | "localstorage";
  synced_at_utc?: string | null;
}

interface LabSyncStatus {
  status: "idle" | "syncing" | "ok" | "offline";
  detail: string;
}

interface RunHistoryActions {
  onDownloadJson: (entry: RunHistoryEntry) => void;
  onDownloadMsgpack: (entry: RunHistoryEntry) => void;
  onCopyJson: (entry: RunHistoryEntry) => void;
  onDelete: (entry: RunHistoryEntry) => void;
  onSyncToLab: () => void;
  labConfigured: boolean;
  labSync: LabSyncStatus;
}

const defaultPreRun: PreRunState = {
  runner_id: "user_001",
  goal: "sub_25_5k",
  route_name: "Inferred from GPS",
  mode: "record_mode",
  active_patch_id: CONTROLLED_START_PATCH_ID,
  route_direction: "unknown",
  phone_position: "unknown",
  intended_distance_meters: 5000,
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
    gps_callback_cleanup_status: "clean",
    cleanup_failed: false,
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
    in_run_notes: [],
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
  const [preRun, setPreRun] = useState<PreRunState>(
    initialRun?.pre_run ?? { ...defaultPreRun, active_patch_id: loadCurrentPatchId() },
  );
  const [permissions, setPermissions] = useState<PermissionState>(initialRun?.permissions ?? defaultPermissions);
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(initialRun);
  const [screen, setScreen] = useState<Screen>(
    initialRun ? "recovery" : "home",
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
  const [pendingStart, setPendingStart] = useState(false);
  const [gpsStartTimedOut, setGpsStartTimedOut] = useState(false);
  const [countdownSeconds, setCountdownSeconds] = useState<number | null>(null);
  const [gpsStaleSeconds, setGpsStaleSeconds] = useState(0);
  const [serviceWorkerUpdateReady, setServiceWorkerUpdateReady] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<Event | null>(null);
  const [pwaState, setPwaState] = useState<PwaState>(initialRun?.pwa_state ?? detectPwaState());
  const [runHistory, setRunHistory] = useState<RunHistoryEntry[]>(() => loadRunHistoryIndex());

  const gpsWatchIdRef = useRef<number | null>(null);
  const gpsWatchIdsRef = useRef<Set<number>>(new Set());
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
  const recoverySuppressedRef = useRef(false);
  const countdownIntervalRef = useRef<number | null>(null);
  const startRunRef = useRef<() => void>(() => {});
  const startGpsTimeoutRef = useRef<number | null>(null);
  const lastTickWallRef = useRef<number | null>(null);
  const lastTickPerfRef = useRef<number | null>(null);

  const liveStats = useMemo(
    () => computeLiveStats(activeRun?.gps_points ?? [], elapsedSeconds),
    [activeRun?.gps_points, elapsedSeconds],
  );

  const exportPayload = useMemo(
    () => (screen === "export" && activeRun ? buildExportPayload(activeRun, exportCreatedAt) : null),
    [activeRun, exportCreatedAt, screen],
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
    const patchChanges = (target: PermissionState) =>
      (Object.keys(patch) as Array<keyof PermissionState>).some((key) => target[key] !== patch[key]);
    setPermissions((current) => (patchChanges(current) ? { ...current, ...patch } : current));
    setActiveRun((run) =>
      run && patchChanges(run.permissions) ? { ...run, permissions: { ...run.permissions, ...patch } } : run,
    );
  }, []);

  const appendQualityNote = useCallback((note: string) => {
    setActiveRun((run) => {
      if (!run || run.data_quality_notes.includes(note)) {
        return run;
      }
      return { ...run, data_quality_notes: [...run.data_quality_notes, note] };
    });
  }, []);

  const reconcileElapsedClock = useCallback(() => {
    if (runStartPerfRef.current === null || lastTickWallRef.current === null || lastTickPerfRef.current === null) {
      return;
    }
    const missingSeconds =
      (Date.now() - lastTickWallRef.current - (performance.now() - lastTickPerfRef.current)) / 1000;
    if (missingSeconds > 1) {
      runStartPerfRef.current -= missingSeconds * 1000;
      lastTickWallRef.current = Date.now();
      lastTickPerfRef.current = performance.now();
      appendQualityNote(
        `Recovered ${round(missingSeconds, 1)}s of suspended-clock time into elapsed after page resume.`,
      );
    }
  }, [appendQualityNote]);

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
    let cleared = false;
    if ("geolocation" in navigator) {
      for (const watchId of gpsWatchIdsRef.current) {
        navigator.geolocation.clearWatch(watchId);
        cleared = true;
      }
      if (gpsWatchIdRef.current !== null && !gpsWatchIdsRef.current.has(gpsWatchIdRef.current)) {
        navigator.geolocation.clearWatch(gpsWatchIdRef.current);
        cleared = true;
      }
    }
    gpsWatchIdsRef.current.clear();
    gpsWatchIdRef.current = null;
    return cleared;
  }, []);

  const stopWarmupWatch = useCallback(() => {
    if (warmupWatchIdRef.current !== null && "geolocation" in navigator) {
      navigator.geolocation.clearWatch(warmupWatchIdRef.current);
      warmupWatchIdRef.current = null;
    }
    setWarmupStatus((current) => ({ ...current, active: false }));
  }, []);

  const armGps = useCallback((silent = false) => {
    if (!("geolocation" in navigator)) {
      updatePermissions({ geolocation_available: false, geolocation_permission: "unavailable" });
      if (!silent) {
        setActionMessage("GPS unavailable.");
      }
      return;
    }
    if (warmupWatchIdRef.current !== null) {
      if (!silent) {
        setActionMessage("GPS warmup already armed.");
      }
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
    if (!silent) {
      setActionMessage("GPS warmup armed.");
    }

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
        if (error.code === error.PERMISSION_DENIED) {
          stopWarmupWatch();
          updatePermissions({ geolocation_permission: "denied" });
          if (!silent) {
            setActionMessage("GPS denied.");
          }
          return;
        }
        updatePermissions({ geolocation_permission: "unavailable" });
        if (!silent) {
          setActionMessage("GPS warmup is still waiting for a usable fix.");
        }
      },
      {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 10000,
      },
    );
  }, [stopWarmupWatch, updatePermissions]);

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

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const elapsed = getElapsedSeconds();
        if (activeRunRef.current && activeRunRef.current.status !== "running") {
          stopGpsWatch();
        }
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
                gps_callback_cleanup_status: callbackCount > 3 ? "failed" : "callbacks_after_stop",
                cleanup_failed: true,
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
    gpsWatchIdRef.current = watchId;
    gpsWatchIdsRef.current.add(watchId);
  }, [appendQualityNote, fetchWeatherForRun, getElapsedSeconds, stopGpsWatch, updatePermissions]);

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
        const previous = wakeLockRef.current;
        wakeLockRef.current = lock;
        if (previous && previous !== lock && !previous.released) {
          try {
            await previous.release();
          } catch {
            // The displaced sentinel may already be released by the browser.
          }
        }
        lock.addEventListener("release", () => {
          appendLifecycleEvent("wake_lock_events", {
            event: "wake_lock_released",
            timestamp_utc: new Date().toISOString(),
            t_elapsed_seconds: runStartPerfRef.current === null ? null : round(getElapsedSeconds(), 2),
            status: "released",
          });
          if (wakeLockRef.current === lock || wakeLockRef.current === null) {
            updatePermissions({ wake_lock_status: "inactive" });
          }
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

  const requestMotionPermission = useCallback(async (silent = false) => {
    if (!permissions.device_motion_available) {
      updatePermissions({ device_motion_permission: "unavailable" });
      updateMotionDebug({
        request_status: "unavailable",
        requested_at_utc: new Date().toISOString(),
        result_at_utc: new Date().toISOString(),
      });
      if (!silent) {
        setActionMessage("Motion unavailable.");
      }
      return;
    }
    if (permissions.device_motion_permission === "ready") {
      if (!silent) {
        setActionMessage("Motion already enabled.");
      }
      return;
    }
    if (permissions.device_motion_permission === "denied" || permissions.device_motion_permission === "unavailable") {
      if (!silent) {
        setActionMessage("Motion permission was denied or unavailable. Reset site permissions in the browser to retry.");
      }
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
        if (!silent) {
          setActionMessage(result === "granted" ? "Motion ready." : "Motion denied.");
        }
      } else {
        updatePermissions({ device_motion_permission: "ready" });
        updateMotionDebug({ request_status: "granted", result_at_utc: new Date().toISOString() });
        if (!silent) {
          setActionMessage("Motion ready.");
        }
      }
    } catch {
      updatePermissions({ device_motion_permission: "denied" });
      updateMotionDebug({ request_status: "failed", result_at_utc: new Date().toISOString() });
      if (!silent) {
        setActionMessage("Motion permission failed.");
      }
    }
  }, [
    permissions.device_motion_available,
    permissions.device_motion_permission,
    updateMotionDebug,
    updatePermissions,
  ]);

  const clearStartTimers = useCallback(() => {
    if (countdownIntervalRef.current !== null) {
      window.clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    if (startGpsTimeoutRef.current !== null) {
      window.clearTimeout(startGpsTimeoutRef.current);
      startGpsTimeoutRef.current = null;
    }
  }, []);

  const startRun = useCallback(() => {
    clearStartTimers();
    setPendingStart(false);
    setGpsStartTimedOut(false);
    setCountdownSeconds(null);
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
    recoverySuppressedRef.current = false;
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
  }, [
    clearStartTimers,
    fetchWeatherForRun,
    motionDebugDraft,
    permissions,
    preRun,
    pwaState,
    requestWakeLock,
    startGpsWatch,
    stopWarmupWatch,
    warmup,
    warmupStatus.latestAccuracy,
    warmupStatus.latestPoint,
  ]);

  startRunRef.current = startRun;

  const beginStartCountdown = useCallback(
    (startAnyway = false) => {
      clearStartTimers();
      setPendingStart(false);
      setGpsStartTimedOut(false);
      setCountdownSeconds(START_COUNTDOWN_SECONDS);
      setActionMessage(startAnyway ? "Starting without a fresh GPS fix." : "Starting in 3...");
      let nextSecond = START_COUNTDOWN_SECONDS;
      countdownIntervalRef.current = window.setInterval(() => {
        nextSecond -= 1;
        if (nextSecond <= 0) {
          clearStartTimers();
          setCountdownSeconds(null);
          startRunRef.current();
          return;
        }
        setCountdownSeconds(nextSecond);
      }, 1000);
    },
    [clearStartTimers],
  );

  const handleStartPressed = useCallback(() => {
    void requestMotionPermission(true);
    void requestWakeLock(true);

    if (isWarmupGpsReady(warmupStatus.latestPoint, warmupStatus.latestAccuracy)) {
      beginStartCountdown();
      return;
    }

    setPendingStart(true);
    setGpsStartTimedOut(false);
    setActionMessage("Getting GPS. Countdown will start when the fix is fresh.");
    if (!warmupStatus.active) {
      armGps(true);
    }

    if (startGpsTimeoutRef.current !== null) {
      window.clearTimeout(startGpsTimeoutRef.current);
    }
    startGpsTimeoutRef.current = window.setTimeout(() => {
      setGpsStartTimedOut(true);
      setActionMessage("GPS is not ready yet. Keep waiting, or start anyway.");
    }, START_GPS_TIMEOUT_SECONDS * 1000);
  }, [
    armGps,
    beginStartCountdown,
    requestMotionPermission,
    requestWakeLock,
    warmupStatus.active,
    warmupStatus.latestAccuracy,
    warmupStatus.latestPoint,
  ]);

  const stopRun = async () => {
    if (!activeRunRef.current || activeRunRef.current.status !== "running") {
      return;
    }
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
          gps_callback_cleanup_status: "clean",
          cleanup_failed: false,
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
              gps_callback_cleanup_status:
                run.finalization.post_stop_gps_callback_count > 0 ? "callbacks_after_stop" : "clean",
              cleanup_failed: run.finalization.post_stop_gps_callback_count > 0,
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

  const resumeRecoveredRun = () => {
    if (!activeRun) {
      setScreen("home");
      return;
    }
    const offset = activeRun.elapsed_offset_seconds ?? elapsedSeconds;
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
    runStartPerfRef.current = performance.now() - offset * 1000;
    setElapsedSeconds(offset);
    setScreen("live");
    startGpsWatch();
    void requestWakeLock(true);
    setActionMessage("Recovered run resumed.");
  };

  const finalizeRecoveredRun = () => {
    if (!activeRun) {
      setScreen("home");
      return;
    }
    const now = new Date();
    const stopElapsed = activeRun.finalization.stopped_at_elapsed_seconds ?? activeRun.elapsed_offset_seconds ?? elapsedSeconds;
    const stopPoint = activeRun.finalization.stop_point ?? activeRun.gps_points[activeRun.gps_points.length - 1] ?? null;
    stopGpsWatch();
    setActiveRun((run) =>
      run
        ? {
            ...run,
            status: "stopped",
            elapsed_offset_seconds: stopElapsed,
            run_metadata: {
              ...run.run_metadata,
              end_time_local: run.run_metadata.end_time_local ?? formatLocalIso(now),
              end_time_utc: run.run_metadata.end_time_utc ?? now.toISOString(),
            },
            finalization: {
              ...run.finalization,
              stop_clicked_at_utc: run.finalization.stop_clicked_at_utc ?? now.toISOString(),
              stopped_at_elapsed_seconds: stopElapsed,
              gps_watch_cleared: true,
              motion_listener_removed: true,
              gps_stale_timers_cleared: true,
              finish_point_source: stopPoint ? "last_valid_pre_stop_gps" : "none",
              stop_point: stopPoint,
            },
          }
        : run,
    );
    runStartPerfRef.current = null;
    setElapsedSeconds(stopElapsed);
    setScreen("post");
    setActionMessage("Recovered run finalized.");
  };

  const discardRun = () => {
    const confirmed = window.confirm("Discard the active run and local draft?");
    if (!confirmed) {
      return;
    }
    stopGpsWatch();
    stopWarmupWatch();
    clearStartTimers();
    if (startWeatherRetryTimeoutRef.current !== null) {
      window.clearTimeout(startWeatherRetryTimeoutRef.current);
      startWeatherRetryTimeoutRef.current = null;
    }
    void releaseWakeLock();
    recoverySuppressedRef.current = true;
    localStorage.removeItem(STORAGE_KEY);
    void deleteRunFromIndexedDb();
    setActiveRun(null);
    setPreRun(defaultPreRun);
    setPermissions(defaultPermissions());
    setWarmup(defaultWarmup());
    setWarmupStatus({ active: false, latestPoint: null, latestAccuracy: null });
    setMotionDebugDraft(defaultMotionDebug());
    setElapsedSeconds(0);
    setPendingStart(false);
    setGpsStartTimedOut(false);
    setCountdownSeconds(null);
    setActionMessage("");
    runStartPerfRef.current = null;
    motionBucketRef.current = null;
    motionEventsSeenRef.current = 0;
    startWeatherFetchStartedRef.current = false;
    targetReachedNotifiedRef.current = false;
    setScreen("home");
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

  const addInRunNote = (note: Pick<InRunNote, "note_type" | "tags" | "text">) => {
    const trimmed = note.text.trim();
    if (!trimmed) {
      setActionMessage("Note text is empty.");
      return;
    }
    const elapsed = getElapsedSeconds();
    setActiveRun((run) => {
      if (!run) {
        return run;
      }
      const latestPoint = run.gps_points[run.gps_points.length - 1] ?? null;
      const inRunNote: InRunNote = {
        note_id: `note_${run.in_run_notes.length + 1}`,
        timestamp_utc: new Date().toISOString(),
        t_elapsed_seconds: round(elapsed, 2),
        distance_meters: round(liveStats.distanceMeters, 2),
        lat: latestPoint?.lat ?? null,
        lon: latestPoint?.lon ?? null,
        note_type: note.note_type,
        tags: note.tags,
        text: trimmed,
      };
      return { ...run, in_run_notes: [...run.in_run_notes, inRunNote] };
    });
    setActionMessage("In-run note saved.");
  };

  const continueToPostRun = () => {
    setScreen("post");
  };

  const continueToExport = () => {
    const createdAt = new Date().toISOString();
    if (activeRun) {
      const payload = buildExportPayload(activeRun, createdAt);
      const filename = buildExportFilename(activeRun.run_metadata.start_time_utc);
      saveRouteMemory(payload);
      void saveCompletedRunToHistory(payload, filename).then((nextHistory) => {
        setRunHistory(nextHistory);
        // The run now lives in history: the crash-recovery draft is obsolete.
        recoverySuppressedRef.current = true;
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch {
          // Draft cleanup is best effort.
        }
        void deleteRunFromIndexedDb();
        setActionMessage("Export ready. Run saved to local history.");
        void syncRunsToLab();
      }).catch(() => setActionMessage("Export ready. Local history save failed; download still works."));
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

  const confirmHomeBlockRoute = () => {
    if (!activeRun) {
      return;
    }
    const payload = buildExportPayload(activeRun, new Date().toISOString());
    saveRouteMemory(payload, { confirmRoute: true });
    setActionMessage("Home-block short route confirmed for future route snapping.");
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

  const downloadCoachSummary = () => {
    if (!exportArtifacts) {
      return;
    }
    downloadBlob(
      new Blob([exportArtifacts.coach_summary_json], { type: "application/json" }),
      exportArtifacts.coach_summary_filename,
    );
    setActionMessage("Coach summary download started.");
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

  const loadHistoryPayload = async (entry: RunHistoryEntry): Promise<ExportPayload | null> => {
    const payload = await loadCompletedRunFromHistory(entry.history_id);
    if (!payload) {
      setActionMessage("Historic run payload is unavailable on this device.");
      return null;
    }
    return payload;
  };

  const downloadHistoryJson = (entry: RunHistoryEntry) => {
    void loadHistoryPayload(entry).then((payload) => {
      if (!payload) {
        return;
      }
      downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), entry.filename);
      setActionMessage("Historic JSON download started.");
    });
  };

  const downloadHistoryMsgpack = (entry: RunHistoryEntry) => {
    void loadHistoryPayload(entry).then((payload) => {
      if (!payload) {
        return;
      }
      downloadBlob(bytesToBlob(encodeMsgpack(payload), MSGPACK_MIME), replaceFileExtension(entry.filename, ".msgpack"));
      setActionMessage("Historic MessagePack download started.");
    });
  };

  const copyHistoryJson = (entry: RunHistoryEntry) => {
    void loadHistoryPayload(entry).then(async (payload) => {
      if (!payload) {
        return;
      }
      try {
        await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
        setActionMessage("Historic JSON copied.");
      } catch {
        setActionMessage("Clipboard unavailable. Use historic download.");
      }
    });
  };

  const deleteHistoryEntry = (entry: RunHistoryEntry) => {
    const confirmed = window.confirm("Delete this saved historic run from this device?");
    if (!confirmed) {
      return;
    }
    void deleteCompletedRunFromHistory(entry.history_id).then((nextHistory) => {
      setRunHistory(nextHistory);
      setActionMessage("Historic run deleted from local history.");
    });
  };

  const [labEndpoint, setLabEndpoint] = useState(() => loadLabSyncSettings().endpoint);
  const [labSync, setLabSync] = useState<LabSyncStatus>({ status: "idle", detail: "" });
  const labSyncBusyRef = useRef(false);

  const handleLabEndpointChange = useCallback((value: string) => {
    setLabEndpoint(value);
    saveLabSyncSettings({ endpoint: value });
  }, []);

  const syncRunsToLab = useCallback(async (announce = false) => {
    const endpoint = normalizeLabEndpoint(loadLabSyncSettings().endpoint);
    if (!endpoint || labSyncBusyRef.current) {
      return;
    }
    const popupTransport = endpoint.startsWith("http://") && window.location.protocol === "https:";
    const pending = loadRunHistoryIndex().filter((entry) => !entry.synced_at_utc);
    if (popupTransport && !announce) {
      // Popups need a user gesture; background flushes just report what's waiting.
      setLabSync(
        pending.length === 0
          ? { status: "ok", detail: "All saved runs are in the lab." }
          : {
              status: "idle",
              detail: `${pending.length} run${pending.length === 1 ? "" : "s"} waiting — tap "Sync to lab".`,
            },
      );
      return;
    }
    labSyncBusyRef.current = true;
    setLabSync({ status: "syncing", detail: "Contacting lab…" });
    try {
      let sent = 0;
      let failed = 0;
      if (popupTransport) {
        const result = await syncRunsViaPopup(endpoint, pending);
        if (!result) {
          setLabSync({ status: "offline", detail: "Popup was blocked. Allow popups for this app to sync." });
          if (announce) {
            setActionMessage("Popup was blocked. Allow popups for this app to sync.");
          }
          return;
        }
        sent = result.sent;
        failed = result.failed;
        if (pending.length > 0 && sent === 0) {
          setLabSync({ status: "offline", detail: "Lab receiver did not answer. Is the bridge running?" });
          if (announce) {
            setActionMessage("Lab receiver did not answer. Is the bridge running?");
          }
          setRunHistory(loadRunHistoryIndex());
          return;
        }
      } else {
        if (!(await probeLabEndpoint(endpoint))) {
          setLabSync({ status: "offline", detail: "Lab not reachable from this network." });
          if (announce) {
            setActionMessage("Lab is not reachable from this network.");
          }
          return;
        }
        for (const entry of pending) {
          const payload = await loadCompletedRunFromHistory(entry.history_id);
          if (payload && (await uploadRunToLab(endpoint, payload))) {
            sent += 1;
            markRunSynced(entry.history_id);
          } else {
            failed += 1;
          }
        }
      }
      setRunHistory(loadRunHistoryIndex());
      const detail =
        pending.length === 0
          ? "All saved runs are in the lab."
          : `Sent ${sent} of ${pending.length} run${pending.length === 1 ? "" : "s"} to the lab.`;
      setLabSync({ status: failed > 0 ? "offline" : "ok", detail });
      if (announce) {
        setActionMessage(detail);
      }
    } finally {
      labSyncBusyRef.current = false;
    }
  }, []);

  useEffect(() => {
    const lab = new URLSearchParams(window.location.search).get("lab");
    if (lab) {
      const normalized = normalizeLabEndpoint(lab);
      saveLabSyncSettings({ endpoint: normalized });
      setLabEndpoint(normalized);
      setActionMessage("Lab sync endpoint saved from link.");
    }
    if (loadLabSyncSettings().endpoint) {
      void syncRunsToLab();
    }
  }, [syncRunsToLab]);

  const historyActions: RunHistoryActions = {
    onDownloadJson: downloadHistoryJson,
    onDownloadMsgpack: downloadHistoryMsgpack,
    onCopyJson: copyHistoryJson,
    onDelete: deleteHistoryEntry,
    onSyncToLab: () => {
      void syncRunsToLab(true);
    },
    labConfigured: labEndpoint.trim().length > 0,
    labSync,
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
    if (!waiting) {
      window.location.reload();
      return;
    }
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      () => {
        window.location.reload();
      },
      { once: true },
    );
    waiting.postMessage({ type: "SKIP_WAITING" });
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
    if (screen !== "live" || !activeRun || activeRun.status !== "running" || activeRun.run_metadata.end_time_utc) {
      return undefined;
    }

    if (gpsWatchIdRef.current === null) {
      startGpsWatch();
    }

    const intervalId = window.setInterval(() => {
      const elapsed = getElapsedSeconds();
      setElapsedSeconds(elapsed);
      lastTickWallRef.current = Date.now();
      lastTickPerfRef.current = performance.now();
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

    const handleControllerChange = () => {
      setPwaState((current) => detectPwaState(current.storage_persisted));
    };
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
        scope: import.meta.env.BASE_URL,
      }).then((registration) => {
        serviceWorkerRegistrationRef.current = registration;
        setPwaState((current) => detectPwaState(current.storage_persisted));
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
      navigator.serviceWorker.addEventListener("controllerchange", handleControllerChange);
    }

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.removeEventListener("controllerchange", handleControllerChange);
      }
    };
  }, []);

  useEffect(() => {
    // Heal stale drafts: a draft whose run is already in history (or that cannot
    // be recovered at all) must never re-enter the recovery state on boot.
    let storedRaw: Partial<ActiveRun> | null = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      storedRaw = raw ? (JSON.parse(raw) as Partial<ActiveRun>) : null;
    } catch {
      storedRaw = null;
    }
    if (!storedRaw) {
      return;
    }
    const normalized = normalizeStoredRun(storedRaw);
    if (!normalized || runAlreadyExported(normalized)) {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // Draft cleanup is best effort.
      }
      void deleteRunFromIndexedDb();
    }
  }, []);

  useEffect(() => {
    if (activeRun || recoverySuppressedRef.current) {
      return;
    }
    let canceled = false;
    void loadRunFromIndexedDb().then((storedRun) => {
      if (canceled || !storedRun) {
        return;
      }
      if (runAlreadyExported(storedRun)) {
        void deleteRunFromIndexedDb();
        return;
      }
      setActiveRun(storedRun);
      setPreRun(storedRun.pre_run);
      setPermissions(storedRun.permissions);
      setWarmup(storedRun.pre_run_gps_warmup);
      setMotionDebugDraft(storedRun.motion_debug);
      setElapsedSeconds(storedRun.elapsed_offset_seconds);
      setScreen("recovery");
      setActionMessage("Recovered a saved run draft from device storage.");
    });
    return () => {
      canceled = true;
    };
  }, [activeRun]);

  useEffect(() => {
    if (
      screen !== "setup" ||
      activeRun ||
      warmupStatus.active ||
      warmup.armed_at_utc ||
      permissions.geolocation_permission === "denied" ||
      permissions.geolocation_permission === "unavailable"
    ) {
      return;
    }
    armGps(true);
  }, [
    activeRun,
    armGps,
    permissions.geolocation_permission,
    screen,
    warmup.armed_at_utc,
    warmupStatus.active,
  ]);

  useEffect(() => {
    if (
      !pendingStart ||
      countdownSeconds !== null ||
      !isWarmupGpsReady(warmupStatus.latestPoint, warmupStatus.latestAccuracy)
    ) {
      return;
    }
    beginStartCountdown();
  }, [
    beginStartCountdown,
    countdownSeconds,
    pendingStart,
    warmupStatus.latestAccuracy,
    warmupStatus.latestPoint,
  ]);

  useEffect(() => {
    if (
      !activeRun ||
      screen !== "live" ||
      activeRun.pre_run.intended_distance_meters <= 0 ||
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
      if (document.visibilityState === "visible") {
        reconcileElapsedClock();
      }
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
      reconcileElapsedClock();
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
      reconcileElapsedClock();
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
  }, [appendLifecycleEvent, getElapsedSeconds, permissions.wake_lock_available, reconcileElapsedClock, requestWakeLock, screen]);

  useEffect(() => {
    if (!activeRun || screen === "export") {
      return;
    }
    const persistDraft = () => {
      const run = activeRunRef.current;
      if (!run) {
        return;
      }
      const savedRun: ActiveRun = {
        ...run,
        elapsed_offset_seconds: screen === "live" ? elapsedSecondsRef.current : run.elapsed_offset_seconds,
        last_saved_at_utc: new Date().toISOString(),
      };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(savedRun));
      } catch {
        // localStorage can hit quota on large drafts; the IndexedDB copy below still saves.
      }
      void saveRunToIndexedDb(savedRun);
    };
    const timeoutId = window.setTimeout(persistDraft, 500);
    const intervalId = window.setInterval(persistDraft, 2000);
    return () => {
      window.clearTimeout(timeoutId);
      window.clearInterval(intervalId);
    };
  }, [activeRun !== null, activeRun?.status, screen]);

  useEffect(() => {
    setActiveRun((run) => (run ? { ...run, pwa_state: pwaState } : run));
  }, [pwaState]);

  useEffect(() => {
    saveCurrentPatchId(preRun.active_patch_id);
  }, [preRun.active_patch_id]);

  useEffect(() => {
    return () => {
      clearStartTimers();
      stopGpsWatch();
      stopWarmupWatch();
      if (startWeatherRetryTimeoutRef.current !== null) {
        window.clearTimeout(startWeatherRetryTimeoutRef.current);
      }
      void releaseWakeLock();
    };
  }, [clearStartTimers, releaseWakeLock, stopGpsWatch, stopWarmupWatch]);

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

      {screen === "home" ? (
        <HomeScreen
          runHistory={runHistory}
          historyActions={historyActions}
          labEndpoint={labEndpoint}
          onLabEndpointChange={handleLabEndpointChange}
          onStartNew={() => setScreen("setup")}
        />
      ) : null}

      {screen === "setup" ? (
        <SetupScreen
          preRun={preRun}
          permissions={permissions}
          warmup={warmup}
          warmupStatus={warmupStatus}
          pendingStart={pendingStart}
          gpsStartTimedOut={gpsStartTimedOut}
          countdownSeconds={countdownSeconds}
          appVisible={document.visibilityState === "visible"}
          setPreRun={setPreRun}
          onGps={requestGpsPermission}
          onArmGps={() => armGps(false)}
          onStopWarmup={stopWarmupWatch}
          onMotion={() => void requestMotionPermission(false)}
          onWakeLock={() => void requestWakeLock(false)}
          onStart={handleStartPressed}
          onStartAnyway={() => beginStartCountdown(true)}
          onBack={() => setScreen("home")}
        />
      ) : null}

      {screen === "recovery" && activeRun ? (
        <RecoveryScreen
          run={activeRun}
          onResume={resumeRecoveredRun}
          onFinalize={finalizeRecoveredRun}
          onDiscard={discardRun}
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
          onAddNote={addInRunNote}
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
          onConfirmRoute={confirmHomeBlockRoute}
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
          onDownloadCoachSummary={downloadCoachSummary}
          runHistory={runHistory}
          historyActions={historyActions}
          onBackToPost={() => setScreen("post")}
          onDiscard={discardRun}
        />
      ) : null}
    </main>
  );
}

function RecoveryScreen({
  run,
  onResume,
  onFinalize,
  onDiscard,
}: {
  run: ActiveRun;
  onResume: () => void;
  onFinalize: () => void;
  onDiscard: () => void;
}) {
  const isStopped = Boolean(run.run_metadata.end_time_utc) || run.status === "stopped";
  const pointCount = run.gps_points.length;
  const savedAt = run.last_saved_at_utc ? new Date(run.last_saved_at_utc).toLocaleTimeString() : "unknown";

  return (
    <section className="screen-stack">
      <section className="result-panel">
        <h2>Saved run found</h2>
        <p className="filename">
          {pointCount} GPS points, saved {savedAt}
        </p>
      </section>

      <section className="health-panel">
        <div className="health-header">
          <strong>Recovery options</strong>
          <span>{isStopped ? "stopped draft" : "active draft"}</span>
        </div>
        <div className="health-grid">
          <div className="health-item ok">
            <span>Status</span>
            <strong>{run.status}</strong>
          </div>
          <div className="health-item ok">
            <span>Elapsed</span>
            <strong>{formatDuration(run.elapsed_offset_seconds)}</strong>
          </div>
          <div className="health-item ok">
            <span>Route</span>
            <strong>{run.pre_run.route_name}</strong>
          </div>
          <div className="health-item ok">
            <span>Patch</span>
            <strong>{run.pre_run.active_patch_id}</strong>
          </div>
        </div>
      </section>

      <section className="button-grid vertical">
        {!isStopped ? (
          <button type="button" className="primary-button" onClick={onResume}>
            <Play size={18} />
            Resume recording
          </button>
        ) : null}
        <button type="button" className={isStopped ? "primary-button" : "secondary-button"} onClick={onFinalize}>
          <Clipboard size={18} />
          Finalize previous run
        </button>
        <button type="button" className="danger-button" onClick={onDiscard}>
          <Trash2 size={18} />
          Discard previous run
        </button>
      </section>
    </section>
  );
}

function HomeScreen({
  runHistory,
  historyActions,
  labEndpoint,
  onLabEndpointChange,
  onStartNew,
}: {
  runHistory: RunHistoryEntry[];
  historyActions: RunHistoryActions;
  labEndpoint: string;
  onLabEndpointChange: (value: string) => void;
  onStartNew: () => void;
}) {
  return (
    <section className="screen-stack">
      <button type="button" className="primary-button" onClick={onStartNew}>
        <Play size={20} />
        Start a new run
      </button>

      <RunHistoryPanel entries={runHistory} actions={historyActions} />

      <details className="preflight-panel" open={labEndpoint.trim().length === 0}>
        <summary>{labEndpoint.trim() ? "Lab pairing" : "Pair with the lab"}</summary>
        <label>
          Lab endpoint URL
          <input
            value={labEndpoint}
            inputMode="url"
            placeholder="http://192.168.1.11:8787"
            onChange={(event) => onLabEndpointChange(event.target.value)}
          />
        </label>
        <p className="filename">
          {labEndpoint.trim()
            ? labEndpoint.trim().startsWith("http://")
              ? 'Paired. On home WiFi, tap "Sync to lab" above to hand runs over.'
              : "Paired over https: runs upload automatically whenever the lab answers."
            : "Easiest way: on the lab computer open the bridge's /pair page and scan its QR with this phone's camera."}
        </p>
      </details>
    </section>
  );
}

function SetupScreen({
  preRun,
  permissions,
  warmup,
  warmupStatus,
  pendingStart,
  gpsStartTimedOut,
  countdownSeconds,
  appVisible,
  setPreRun,
  onGps,
  onArmGps,
  onStopWarmup,
  onMotion,
  onWakeLock,
  onStart,
  onStartAnyway,
  onBack,
}: {
  preRun: PreRunState;
  permissions: PermissionState;
  warmup: PreRunGpsWarmup;
  warmupStatus: { active: boolean; latestPoint: GpsPoint | null; latestAccuracy: number | null };
  pendingStart: boolean;
  gpsStartTimedOut: boolean;
  countdownSeconds: number | null;
  appVisible: boolean;
  setPreRun: (next: PreRunState) => void;
  onGps: () => void;
  onArmGps: () => void;
  onStopWarmup: () => void;
  onMotion: () => void;
  onWakeLock: () => void;
  onStart: () => void;
  onStartAnyway: () => void;
  onBack: () => void;
}) {
  const setPain = (patch: Partial<PreRunState["pain_before_run"]>) => {
    setPreRun({
      ...preRun,
      pain_before_run: { ...preRun.pain_before_run, ...patch },
    });
  };
  const gpsReady = isWarmupGpsReady(warmupStatus.latestPoint, warmupStatus.latestAccuracy);
  const preflightItems = buildPreflightItems(preRun, permissions, warmupStatus, appVisible);
  const preflightReady = preflightItems.every((item) => item.ok);
  const canStart = countdownSeconds === null && !pendingStart;
  const startLabel =
    countdownSeconds !== null
      ? String(countdownSeconds)
      : pendingStart
        ? "Getting GPS..."
        : gpsReady
          ? "Start"
          : "Start (get GPS first)";

  return (
    <section className="screen-stack">
      <section className="result-panel">
        <p className="eyebrow">Today's mission</p>
        <h2>Controlled start</h2>
        <p className="filename">Likely route and target will be inferred from GPS. Current patch: {preRun.active_patch_id}.</p>
      </section>

      <section className="status-grid">
        <StatusItem label="GPS" value={permissionLabel(permissions.geolocation_permission)} />
        <StatusItem label="Wake lock" value={wakeLabel(permissions.wake_lock_status)} />
        <StatusItem label="Weather" value={weatherLabel(permissions.weather_status)} />
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

      {pendingStart || countdownSeconds !== null ? (
        <section className={countdownSeconds !== null ? "target-banner countdown-banner" : "warmup-panel"}>
          {countdownSeconds !== null ? (
            <>
              <strong>{countdownSeconds}</strong>
              <span>Go on zero.</span>
            </>
          ) : (
            <>
              <div>
                <span>Start requested</span>
                <strong>Getting GPS</strong>
              </div>
              <div>
                <span>Accuracy</span>
                <strong>{formatAccuracy(warmupStatus.latestAccuracy)}</strong>
              </div>
              <div>
                <span>Countdown</span>
                <strong>auto-starts when ready</strong>
              </div>
            </>
          )}
        </section>
      ) : null}

      {gpsStartTimedOut ? (
        <section className="warning-banner">
          <strong>GPS not ready</strong>
          <span>Keep waiting or start anyway.</span>
          <button type="button" className="inline-warning-button" onClick={onStartAnyway}>
            Start anyway
          </button>
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
      </section>

      <details className="form-panel">
        <summary>Edit details</summary>
        <section className="button-grid">
          <button type="button" className="secondary-button" onClick={warmupStatus.active ? onStopWarmup : onArmGps}>
            <MapPin size={18} />
            {warmupStatus.active ? "Stop GPS warmup" : "Arm GPS"}
          </button>
          <button type="button" className="secondary-button" onClick={onWakeLock}>
            <Lock size={18} />
            Enable wake lock
          </button>
          <button type="button" className="secondary-button" onClick={onGps}>
            <MapPin size={18} />
            Request GPS
          </button>
          <button type="button" className="secondary-button" onClick={onMotion}>
            <Activity size={18} />
            Request motion
          </button>
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

      <section>
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
      </details>

      <button type="button" className="link-button" onClick={onBack}>
        Back to runs
      </button>

      <button type="button" className="primary-button sticky-action" onClick={onStart} disabled={!canStart}>
        <Play size={20} />
        {startLabel}
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
  onAddNote,
  onStop,
  onDiscard,
}: {
  run: ActiveRun;
  elapsedSeconds: number;
  liveStats: LiveStats;
  targetReached: boolean;
  gpsStaleSeconds: number;
  onCheckpoint: () => void;
  onAddNote: (note: Pick<InRunNote, "note_type" | "tags" | "text">) => void;
  onStop: () => void;
  onDiscard: () => void;
}) {
  const remainingMeters = Math.max(0, run.pre_run.intended_distance_meters - liveStats.distanceMeters);
  const gpsStale = gpsStaleSeconds > 10;
  const strategyStatus =
    run.pre_run.active_patch_id === CONTROLLED_START_PATCH_ID && run.pre_run.mode === "green_lake_5k_calibration"
      ? computeControlledStartStatus(run.gps_points)
      : null;

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
            <div className={strategyStatus.status === "in_band" ? "health-item ok" : "health-item warn"}>
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
        <LiveNoteControl onAddNote={onAddNote} />
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
  liveStats: LiveStats;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);
  const [tileFailure, setTileFailure] = useState(false);
  const [followLocked, setFollowLocked] = useState(true);
  const programmaticMoveRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) {
      return undefined;
    }

    const map = L.map(containerRef.current, {
      attributionControl: false,
      zoomControl: true,
      dragging: true,
      touchZoom: true,
      scrollWheelZoom: false,
    }).setView([47.679, -122.328], 14);
    map.on("dragstart zoomstart", () => {
      if (!programmaticMoveRef.current) {
        setFollowLocked(false);
      }
    });

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
    if (followLocked && latest) {
      programmaticMoveRef.current = true;
      map.setView([latest.lat, latest.lon], Math.max(map.getZoom(), 16), { animate: false });
      programmaticMoveRef.current = false;
    } else if (bounds.isValid() && points.length < 5) {
      programmaticMoveRef.current = true;
      map.fitBounds(bounds.pad(0.25), { animate: false, maxZoom: 17 });
      programmaticMoveRef.current = false;
    }
  }, [followLocked, run.checkpoints, run.gps_points]);

  return (
    <section className="map-panel">
      <div className="map-toolbar">
        <span>
          <MapIcon size={15} />
          Track
        </span>
        <strong>{formatMeters(liveStats.distanceMeters)}</strong>
      </div>
      <div className="map-controls">
        <button type="button" className={followLocked ? "map-control active" : "map-control"} onClick={() => setFollowLocked(true)}>
          Lock follow
        </button>
        <button
          type="button"
          className="map-control"
          onClick={() => {
            mapRef.current?.invalidateSize();
            setFollowLocked(true);
          }}
        >
          Reset map
        </button>
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

const IN_RUN_NOTE_TAGS = [
  "breathing",
  "legs",
  "traffic",
  "hill",
  "felt_good",
  "gps",
  "map",
  "export",
  "ui_lag",
  "app_bug",
] as const;

function LiveNoteControl({
  onAddNote,
}: {
  onAddNote: (note: Pick<InRunNote, "note_type" | "tags" | "text">) => void;
}) {
  const [open, setOpen] = useState(false);
  const [noteType, setNoteType] = useState<InRunNote["note_type"]>("run_observation");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [text, setText] = useState("");

  const toggleTag = (tag: string) => {
    setSelectedTags((current) =>
      current.includes(tag) ? current.filter((value) => value !== tag) : [...current, tag],
    );
  };

  const save = () => {
    onAddNote({ note_type: noteType, tags: selectedTags, text });
    setText("");
    setSelectedTags([]);
    setOpen(false);
  };

  if (!open) {
    return (
      <button type="button" className="secondary-button" onClick={() => setOpen(true)}>
        <Clipboard size={18} />
        Note
      </button>
    );
  }

  return (
    <section className="live-note-panel">
      <div className="paired-fields">
        <label>
          Type
          <select value={noteType} onChange={(event) => setNoteType(event.target.value as InRunNote["note_type"])}>
            <option value="run_observation">run observation</option>
            <option value="app_feedback">app feedback</option>
            <option value="route_note">route note</option>
            <option value="other">other</option>
          </select>
        </label>
      </div>
      <div className="tag-grid">
        {IN_RUN_NOTE_TAGS.map((tag) => (
          <button
            key={tag}
            type="button"
            className={selectedTags.includes(tag) ? "tag-button active" : "tag-button"}
            onClick={() => toggleTag(tag)}
          >
            {tag.replace(/_/g, " ")}
          </button>
        ))}
      </div>
      <label>
        Note
        <textarea
          rows={3}
          value={text}
          placeholder="Run note or app feedback"
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <section className="button-grid">
        <button type="button" className="secondary-button" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button type="button" className="primary-button" onClick={save} disabled={!text.trim()}>
          Save note
        </button>
      </section>
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
  liveStats: LiveStats;
  onContinue: () => void;
  onResume: () => void;
  onDiscard: () => void;
}) {
  const exportPayload = useMemo(
    () => buildExportPayload({ ...run, post_run: defaultPostRun }),
    [
      run.checkpoints,
      run.data_quality_notes,
      run.elapsed_offset_seconds,
      run.finalization,
      run.gps_points,
      run.in_run_notes,
      run.motion_debug,
      run.motion_windows,
      run.permissions,
      run.pre_run,
      run.pre_run_gps_warmup,
      run.pwa_state,
      run.recording_lifecycle,
      run.run_metadata,
      run.status,
      run.weather,
    ],
  );
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
  onConfirmRoute,
  onExport,
}: {
  run: ActiveRun;
  postRun: PostRunState;
  updatePostRun: (patch: Partial<PostRunState>) => void;
  updatePostRunPain: (patch: Partial<PostRunState["pain_after_run"]>) => void;
  onConfirmRoute: () => void;
  onExport: () => void;
}) {
  const exportPayload = useMemo(
    () => buildExportPayload({ ...run, post_run: defaultPostRun }),
    [
      run.checkpoints,
      run.data_quality_notes,
      run.elapsed_offset_seconds,
      run.finalization,
      run.gps_points,
      run.in_run_notes,
      run.motion_debug,
      run.motion_windows,
      run.permissions,
      run.pre_run,
      run.pre_run_gps_warmup,
      run.pwa_state,
      run.recording_lifecycle,
      run.run_metadata,
      run.status,
      run.weather,
    ],
  );

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
          {exportPayload.route_confirmation_prompt ? (
            <div className="preflight-item warn">
              <span>ROUTE</span>
              <strong>{exportPayload.route_confirmation_prompt.prompt}</strong>
              <small>{exportPayload.route_confirmation_prompt.reason}</small>
              <button type="button" className="secondary-button full-width-button" onClick={onConfirmRoute}>
                Confirm route
              </button>
            </div>
          ) : null}
        </div>
      </section>

      <section className="form-panel">
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
            <option value="unknown">not sure</option>
            <option value="easy">easy</option>
            <option value="moderate">moderate</option>
            <option value="hard">hard</option>
            <option value="very_hard">very hard</option>
            <option value="max">max</option>
          </select>
        </label>

        <details className="preflight-panel">
          <summary>Optional RPE and recovery details</summary>
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
        </details>

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
            <option value="pacing">pacing</option>
            <option value="motivation">motivation</option>
            <option value="time">time</option>
            <option value="other">other</option>
          </select>
        </label>

        <label>
          Interruptions
          <select
            value={postRun.interruption}
            onChange={(event) => updatePostRun({ interruption: event.target.value as Interruption })}
          >
            <option value="none">none</option>
            <option value="traffic">traffic</option>
            <option value="crowd">crowd</option>
            <option value="GPS issue">GPS issue</option>
            <option value="bathroom">bathroom</option>
            <option value="other">other</option>
          </select>
        </label>

        <div className="paired-fields">
          <label>
            Started too fast?
            <select
              value={postRun.started_too_fast}
              onChange={(event) => updatePostRun({ started_too_fast: event.target.value as YesNoUnsure })}
            >
              <option value="unknown">unknown</option>
              <option value="yes">yes</option>
              <option value="no">no</option>
              <option value="unsure">unsure</option>
            </select>
          </label>
          <label>
            Final third harder?
            <select
              value={postRun.final_third_harder_than_expected}
              onChange={(event) =>
                updatePostRun({ final_third_harder_than_expected: event.target.value as YesNoUnsure })
              }
            >
              <option value="unknown">unknown</option>
              <option value="yes">yes</option>
              <option value="no">no</option>
              <option value="unsure">unsure</option>
            </select>
          </label>
        </div>

        <details className="preflight-panel">
          <summary>Optional recovery details</summary>
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
        </details>

        <label>
          Post-run note
          <textarea
            rows={4}
            value={postRun.free_text}
            onChange={(event) => updatePostRun({ free_text: event.target.value })}
          />
        </label>

      </section>

      <button type="button" className="primary-button sticky-action" onClick={onExport}>
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
  onDownloadCoachSummary,
  runHistory,
  historyActions,
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
  onDownloadCoachSummary: () => void;
  runHistory: RunHistoryEntry[];
  historyActions: RunHistoryActions;
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
            <div className="health-item ok">
              <span>Coach summary</span>
              <strong>{formatBytes(exportArtifacts.coach_summary_bytes)}</strong>
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
        <button type="button" className="secondary-button" onClick={onDownloadCoachSummary}>
          <Download size={18} />
          Download coach_summary.json
        </button>
      </section>

      <textarea className="json-preview" readOnly value={exportJson} />

      <RunHistoryPanel entries={runHistory} actions={historyActions} currentHistoryId={exportPayload?.run_metadata.run_id as string | undefined} />

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

function RunHistoryPanel({
  entries,
  actions,
  currentHistoryId,
}: {
  entries: RunHistoryEntry[];
  actions: RunHistoryActions;
  currentHistoryId?: string;
}) {
  return (
    <section className="health-panel run-history-panel">
      <div className="health-header">
        <strong>Local run history</strong>
        <span>
          {entries.length} saved
          {actions.labConfigured ? ` · ${entries.filter((entry) => entry.synced_at_utc).length} in lab` : ""}
        </span>
      </div>

      {actions.labConfigured ? (
        <div className="history-sync-row">
          <button type="button" className="secondary-button" onClick={actions.onSyncToLab}>
            <RefreshCw size={16} />
            Sync to lab
          </button>
          <small>{actions.labSync.status === "syncing" ? "Syncing…" : actions.labSync.detail}</small>
        </div>
      ) : null}

      {entries.length === 0 ? (
        <p className="history-empty">Completed exports will be saved on this device for later download.</p>
      ) : (
        <div className="history-list">
          {entries.map((entry) => {
            const isCurrent = entry.history_id === currentHistoryId || entry.run_id === currentHistoryId;
            return (
              <section className={isCurrent ? "history-item current" : "history-item"} key={entry.history_id}>
                <div className="history-main">
                  <strong>{formatHistoryDate(entry.created_at_utc)}</strong>
                  <span>{entry.route_name}</span>
                  <small>
                    {entry.inferred_mode} · {formatNullableMeters(entry.distance_meters)} ·{" "}
                    {formatNullableDuration(entry.duration_seconds)} · {formatBytes(entry.json_bytes)}
                  </small>
                  <small>
                    {entry.gps_point_count} GPS points · {entry.in_run_note_count} notes · {entry.storage_kind}
                    {actions.labConfigured ? ` · ${entry.synced_at_utc ? "in lab" : "not in lab"}` : ""}
                  </small>
                </div>
                <div className="history-actions">
                  <button type="button" className="secondary-button" onClick={() => actions.onDownloadJson(entry)}>
                    <Download size={16} />
                    JSON
                  </button>
                  <button type="button" className="secondary-button" onClick={() => actions.onDownloadMsgpack(entry)}>
                    <Download size={16} />
                    MsgPack
                  </button>
                  <button type="button" className="secondary-button" onClick={() => actions.onCopyJson(entry)}>
                    <Clipboard size={16} />
                    Copy
                  </button>
                  <button type="button" className="link-button" onClick={() => actions.onDelete(entry)}>
                    <Trash2 size={16} />
                    Delete
                  </button>
                </div>
              </section>
            );
          })}
        </div>
      )}
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
  appVisible: boolean,
) {
  const gpsOk =
    warmupStatus.latestAccuracy !== null && warmupStatus.latestAccuracy <= ACCEPTABLE_GPS_ACCURACY_METERS;
  const targetOk = Number.isFinite(preRun.intended_distance_meters) && preRun.intended_distance_meters >= 100;

  return [
    {
      label: "GPS warmed",
      ok: gpsOk,
      detail: gpsOk ? formatAccuracy(warmupStatus.latestAccuracy) : "warming automatically",
    },
    {
      label: "Wake lock",
      ok: permissions.wake_lock_status !== "failed",
      detail: permissions.wake_lock_status === "active" ? "active" : "Start will request it",
    },
    {
      label: "Motion",
      ok: true,
      detail: permissions.device_motion_permission === "ready" ? "will record if samples arrive" : "optional; Start will try once",
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
  const cleanupStatus = exportPayload.finalization.gps_callback_cleanup_status;

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
      value: `${exportPayload.data_quality_scores.analysis_reliability}/${distanceConfidence}`,
      status: exportPayload.data_quality_scores.analysis_reliability === "low" ? "warn" : "ok",
    },
    {
      label: "GPS cleanup",
      value: cleanupStatus,
      status: cleanupStatus === "clean" || cleanupStatus === "callbacks_after_stop" ? "ok" : "warn",
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

function runAlreadyExported(run: ActiveRun): boolean {
  return loadRunHistoryIndex().some((entry) => entry.run_id === run.run_metadata.run_id);
}

function loadStoredRun(): ActiveRun | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const run = normalizeStoredRun(JSON.parse(raw) as Partial<ActiveRun>);
    if (!run || runAlreadyExported(run)) {
      return null;
    }
    return run;
  } catch {
    return null;
  }
}

function openRunDatabase(): Promise<IDBDatabase | null> {
  if (!("indexedDB" in window)) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const request = indexedDB.open(IDB_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
        db.createObjectStore(IDB_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

async function saveRunToIndexedDb(run: ActiveRun): Promise<void> {
  const db = await openRunDatabase();
  if (!db) {
    return;
  }
  try {
    await new Promise<void>((resolve) => {
      const transaction = db.transaction(IDB_STORE_NAME, "readwrite");
      transaction.objectStore(IDB_STORE_NAME).put(run, IDB_ACTIVE_RUN_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    });
  } catch {
    // Draft saving is best effort; the localStorage copy is the fallback.
  } finally {
    db.close();
  }
}

async function loadRunFromIndexedDb(): Promise<ActiveRun | null> {
  const db = await openRunDatabase();
  if (!db) {
    return null;
  }
  try {
    const value = await new Promise<Partial<ActiveRun> | null>((resolve) => {
      const transaction = db.transaction(IDB_STORE_NAME, "readonly");
      transaction.onerror = () => resolve(null);
      transaction.onabort = () => resolve(null);
      const request = transaction.objectStore(IDB_STORE_NAME).get(IDB_ACTIVE_RUN_KEY);
      request.onsuccess = () => resolve((request.result as Partial<ActiveRun> | undefined) ?? null);
      request.onerror = () => resolve(null);
    });
    return value ? normalizeStoredRun(value) : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

async function deleteRunFromIndexedDb(): Promise<void> {
  const db = await openRunDatabase();
  if (!db) {
    return;
  }
  try {
    await new Promise<void>((resolve) => {
      const transaction = db.transaction(IDB_STORE_NAME, "readwrite");
      transaction.objectStore(IDB_STORE_NAME).delete(IDB_ACTIVE_RUN_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    });
  } catch {
    // Draft deletion is best effort.
  } finally {
    db.close();
  }
}

async function putRunDatabaseValue(key: string, value: unknown): Promise<boolean> {
  const db = await openRunDatabase();
  if (!db) {
    return false;
  }
  try {
    return await new Promise<boolean>((resolve) => {
      const transaction = db.transaction(IDB_STORE_NAME, "readwrite");
      transaction.objectStore(IDB_STORE_NAME).put(value, key);
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => resolve(false);
      transaction.onabort = () => resolve(false);
    });
  } catch {
    return false;
  } finally {
    db.close();
  }
}

async function getRunDatabaseValue<T>(key: string): Promise<T | null> {
  const db = await openRunDatabase();
  if (!db) {
    return null;
  }
  try {
    return await new Promise<T | null>((resolve) => {
      const transaction = db.transaction(IDB_STORE_NAME, "readonly");
      transaction.onerror = () => resolve(null);
      transaction.onabort = () => resolve(null);
      const request = transaction.objectStore(IDB_STORE_NAME).get(key);
      request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  } finally {
    db.close();
  }
}

async function deleteRunDatabaseValue(key: string): Promise<boolean> {
  const db = await openRunDatabase();
  if (!db) {
    return false;
  }
  try {
    return await new Promise<boolean>((resolve) => {
      const transaction = db.transaction(IDB_STORE_NAME, "readwrite");
      transaction.objectStore(IDB_STORE_NAME).delete(key);
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => resolve(false);
      transaction.onabort = () => resolve(false);
    });
  } catch {
    return false;
  } finally {
    db.close();
  }
}

function loadRunHistoryIndex(): RunHistoryEntry[] {
  try {
    const raw = localStorage.getItem(RUN_HISTORY_INDEX_KEY);
    if (!raw) {
      return [];
    }
    const entries = JSON.parse(raw) as Partial<RunHistoryEntry>[];
    if (!Array.isArray(entries)) {
      return [];
    }
    return entries
      .filter((entry): entry is RunHistoryEntry => Boolean(entry.history_id && entry.filename && entry.created_at_utc))
      .slice(0, MAX_RUN_HISTORY_ITEMS);
  } catch {
    return [];
  }
}

function saveRunHistoryIndex(entries: RunHistoryEntry[]) {
  localStorage.setItem(RUN_HISTORY_INDEX_KEY, JSON.stringify(entries.slice(0, MAX_RUN_HISTORY_ITEMS)));
}

interface LabSyncSettings {
  endpoint: string;
}

function loadLabSyncSettings(): LabSyncSettings {
  try {
    const raw = localStorage.getItem(LAB_SYNC_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<LabSyncSettings>) : {};
    return { endpoint: typeof parsed.endpoint === "string" ? parsed.endpoint : "" };
  } catch {
    return { endpoint: "" };
  }
}

function saveLabSyncSettings(settings: LabSyncSettings) {
  try {
    localStorage.setItem(LAB_SYNC_KEY, JSON.stringify(settings));
  } catch {
    // Lab sync settings are best effort.
  }
}

function normalizeLabEndpoint(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

async function probeLabEndpoint(endpoint: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 4000);
    const response = await fetch(`${endpoint}/api/runs/ping`, { signal: controller.signal });
    window.clearTimeout(timeoutId);
    return response.ok;
  } catch {
    return false;
  }
}

async function uploadRunToLab(endpoint: string, payload: ExportPayload): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function markRunSynced(historyId: string) {
  const entries = loadRunHistoryIndex().map((entry) =>
    entry.history_id === historyId ? { ...entry, synced_at_utc: new Date().toISOString() } : entry,
  );
  try {
    saveRunHistoryIndex(entries);
  } catch {
    // Sync markers are best effort; unsynced runs retry next flush.
  }
}

async function syncRunsViaPopup(
  endpoint: string,
  pending: RunHistoryEntry[],
): Promise<{ sent: number; failed: number } | null> {
  const receiver = window.open(`${endpoint}/web/lab-receiver.html`, "lab-receiver");
  if (!receiver) {
    return null;
  }
  const targetOrigin = new URL(endpoint).origin;
  let sent = 0;
  let failed = 0;
  const acks: Record<string, (ok: boolean) => void> = {};
  let readyResolve: (() => void) | null = null;
  const onMessage = (event: MessageEvent) => {
    if (event.origin !== targetOrigin || !event.data || typeof event.data !== "object") {
      return;
    }
    const data = event.data as { type?: string; id?: string; ok?: boolean };
    if (data.type === "lab-receiver-ready") {
      readyResolve?.();
    } else if (data.type === "run-ack" && typeof data.id === "string") {
      acks[data.id]?.(Boolean(data.ok));
    }
  };
  window.addEventListener("message", onMessage);
  try {
    const ready = await new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => resolve(false), 8000);
      readyResolve = () => {
        window.clearTimeout(timer);
        resolve(true);
      };
    });
    if (!ready) {
      receiver.close();
      return { sent: 0, failed: pending.length };
    }
    for (const entry of pending) {
      const payload = await loadCompletedRunFromHistory(entry.history_id);
      if (!payload) {
        failed += 1;
        continue;
      }
      const ok = await new Promise<boolean>((resolve) => {
        const timer = window.setTimeout(() => resolve(false), 20000);
        acks[entry.history_id] = (value) => {
          window.clearTimeout(timer);
          resolve(value);
        };
        receiver.postMessage({ type: "run", id: entry.history_id, payload }, targetOrigin);
      });
      delete acks[entry.history_id];
      if (ok) {
        sent += 1;
        markRunSynced(entry.history_id);
      } else {
        failed += 1;
      }
    }
    receiver.postMessage({ type: "done" }, targetOrigin);
    return { sent, failed };
  } finally {
    window.removeEventListener("message", onMessage);
  }
}

async function saveCompletedRunToHistory(payload: ExportPayload, filename: string): Promise<RunHistoryEntry[]> {
  const json = JSON.stringify(payload);
  const historyId = buildHistoryId(payload);
  let storageKind: RunHistoryEntry["storage_kind"] = "indexeddb";
  const savedInIndexedDb = await putRunDatabaseValue(`${IDB_HISTORY_PREFIX}${historyId}`, payload);
  if (savedInIndexedDb) {
    try {
      localStorage.removeItem(`${RUN_HISTORY_PAYLOAD_PREFIX}${historyId}`);
    } catch {
      // Removing a stale fallback copy is best effort.
    }
  } else {
    try {
      localStorage.setItem(`${RUN_HISTORY_PAYLOAD_PREFIX}${historyId}`, json);
      storageKind = "localstorage";
    } catch {
      return loadRunHistoryIndex();
    }
  }

  const entry = buildRunHistoryEntry(payload, filename, historyId, storageKind, new TextEncoder().encode(json).byteLength);
  const existing = loadRunHistoryIndex();
  const next = [entry, ...existing.filter((item) => item.history_id !== historyId)].slice(0, MAX_RUN_HISTORY_ITEMS);
  const pruned = [entry, ...existing.filter((item) => item.history_id !== historyId)].slice(MAX_RUN_HISTORY_ITEMS);
  saveRunHistoryIndex(next);
  await Promise.all(pruned.map((item) => deleteCompletedRunPayload(item.history_id)));
  return next;
}

async function loadCompletedRunFromHistory(historyId: string): Promise<ExportPayload | null> {
  const indexedDbPayload = await getRunDatabaseValue<ExportPayload>(`${IDB_HISTORY_PREFIX}${historyId}`);
  if (indexedDbPayload) {
    return indexedDbPayload;
  }
  try {
    const raw = localStorage.getItem(`${RUN_HISTORY_PAYLOAD_PREFIX}${historyId}`);
    return raw ? (JSON.parse(raw) as ExportPayload) : null;
  } catch {
    return null;
  }
}

async function deleteCompletedRunFromHistory(historyId: string): Promise<RunHistoryEntry[]> {
  const next = loadRunHistoryIndex().filter((entry) => entry.history_id !== historyId);
  try {
    saveRunHistoryIndex(next);
  } catch {
    return loadRunHistoryIndex();
  }
  await deleteCompletedRunPayload(historyId);
  return next;
}

async function deleteCompletedRunPayload(historyId: string): Promise<void> {
  await deleteRunDatabaseValue(`${IDB_HISTORY_PREFIX}${historyId}`);
  try {
    localStorage.removeItem(`${RUN_HISTORY_PAYLOAD_PREFIX}${historyId}`);
  } catch {
    // Deleting history payloads is best effort.
  }
}

function buildHistoryId(payload: ExportPayload): string {
  return (
    stringFromUnknown(payload.run_metadata.run_id) ??
    stringFromUnknown(payload.run_metadata.start_time_utc) ??
    payload.app.created_at_utc
  ).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function buildRunHistoryEntry(
  payload: ExportPayload,
  filename: string,
  historyId: string,
  storageKind: RunHistoryEntry["storage_kind"],
  jsonBytes: number,
): RunHistoryEntry {
  const activeSummary = payload.active_summary as Record<string, unknown>;
  const summary = payload.summary as Record<string, unknown>;
  const distanceMeters =
    numberFromUnknown(payload.route_snapping.snapped_distance_meters) ??
    numberFromUnknown(payload.route_snapped_summary.route_snapped_distance_meters) ??
    numberFromUnknown(activeSummary.distance_meters) ??
    numberFromUnknown(summary.distance_meters);
  const durationSeconds =
    numberFromUnknown(activeSummary.duration_seconds) ??
    numberFromUnknown(summary.duration_seconds) ??
    numberFromUnknown(payload.active_target_distance_result.active_elapsed_at_target_distance_seconds) ??
    numberFromUnknown(payload.active_short_target_result.active_elapsed_at_target_seconds);

  return {
    history_id: historyId,
    run_id: stringFromUnknown(payload.run_metadata.run_id),
    filename,
    created_at_utc: payload.app.created_at_utc,
    start_time_utc: stringFromUnknown(payload.run_metadata.start_time_utc),
    route_name: stringFromUnknown(payload.pre_run.route_name) ?? payload.run_classification.route_id ?? "unknown route",
    inferred_mode: payload.run_classification.inferred_mode,
    route_id: payload.run_classification.route_id,
    distance_meters: distanceMeters,
    duration_seconds: durationSeconds,
    target_time_seconds: payload.coach_ready_summary.target_time_seconds,
    schema_version: payload.schema_version,
    app_version: payload.app.version,
    json_bytes: jsonBytes,
    gps_point_count: payload.time_series.gps_points.length,
    in_run_note_count: payload.in_run_notes.length,
    storage_kind: storageKind,
  };
}

function normalizeStoredRun(run: Partial<ActiveRun>): ActiveRun | null {
  const runMetadata = run.run_metadata;
  if (!runMetadata || typeof runMetadata.run_id !== "string" || typeof runMetadata.start_time_utc !== "string") {
    return null;
  }
  const postRun = {
    ...defaultPostRun,
    ...run.post_run,
    pain_after_run: {
      ...defaultPostRun.pain_after_run,
      ...run.post_run?.pain_after_run,
    },
  };
  return {
    status: run.status ?? (runMetadata.end_time_utc ? "stopped" : "running"),
    run_metadata: runMetadata,
    pre_run: { ...defaultPreRun, ...run.pre_run },
    post_run: postRun,
    permissions: { ...defaultPermissions(), ...run.permissions },
    weather: run.weather ?? {
      start_weather: emptyWeatherSnapshot(true),
      finish_weather: emptyWeatherSnapshot(false),
    },
    gps_points: run.gps_points ?? [],
    motion_windows: run.motion_windows ?? [],
    checkpoints: run.checkpoints ?? [],
    in_run_notes: run.in_run_notes ?? [],
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

function saveRouteMemory(exportPayload: ExportPayload, options: { confirmRoute?: boolean } = {}) {
  const routeId = exportPayload.route_features.route_id;
  if (typeof routeId !== "string" || routeId.length === 0) {
    return;
  }
  try {
    const raw = localStorage.getItem(ROUTE_MEMORY_KEY);
    const current = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const existing = (current[routeId] ?? {}) as Record<string, unknown>;
    const routeLibraryEntry = exportPayload.route_library.routes.find((route) => route.route_id === routeId);
    const latestShortEstimate = exportPayload.coach_ready_summary.short_run.latest_estimated_1500m_time_seconds;
    const priorBestRaw = existing.best_short_1500m_estimate_seconds;
    const priorBest =
      typeof priorBestRaw === "number" && Number.isFinite(priorBestRaw) && priorBestRaw > 0 ? priorBestRaw : null;
    const bestShort =
      latestShortEstimate === null
        ? priorBest
        : priorBest === null
          ? latestShortEstimate
          : Math.min(priorBest, latestShortEstimate);
    current[routeId] = {
      ...existing,
      route_id: routeId,
      route_type: exportPayload.route_features.route_type ?? null,
      route_name: exportPayload.pre_run.route_name ?? null,
      last_run_id: exportPayload.run_metadata.run_id ?? null,
      updated_at_utc: exportPayload.app.created_at_utc,
      active_distance_meters: exportPayload.active_summary.distance_meters ?? null,
      bounding_box: exportPayload.route_features.bounding_box ?? null,
      course_fingerprint: exportPayload.green_lake_calibration.course_fingerprint,
      calibration_status: options.confirmRoute
        ? "confirmed"
        : existing.calibration_status ?? routeLibraryEntry?.calibration_status ?? null,
      loop_length_meters:
        routeId === "home_block_short_loop_v1"
          ? routeLibraryEntry?.loop_length_meters ?? exportPayload.active_summary.distance_meters ?? null
          : routeLibraryEntry?.loop_length_meters ?? null,
      start_zones: routeLibraryEntry?.start_zones ?? existing.start_zones ?? [],
      finish_zones: routeLibraryEntry?.finish_zones ?? existing.finish_zones ?? [],
      best_short_1500m_estimate_seconds: bestShort,
    };
    localStorage.setItem(ROUTE_MEMORY_KEY, JSON.stringify(current));
  } catch {
    // Route memory is opportunistic; export should never depend on localStorage writes.
  }
}

function loadCurrentPatchId(): string {
  try {
    return localStorage.getItem(CURRENT_PATCH_KEY) || CONTROLLED_START_PATCH_ID;
  } catch {
    return CONTROLLED_START_PATCH_ID;
  }
}

function saveCurrentPatchId(patchId: string) {
  try {
    localStorage.setItem(CURRENT_PATCH_KEY, patchId);
  } catch {
    // Current patch persistence is best effort.
  }
}

function buildExportArtifacts(exportPayload: ExportPayload, exportJson: string, jsonFilename: string): ExportArtifacts {
  const msgpackBytes = encodeMsgpack(exportPayload);
  const coachSummaryJson = JSON.stringify(buildCompactCoachSummary(exportPayload), null, 2);
  return {
    json_bytes: new TextEncoder().encode(exportJson).byteLength,
    coach_summary_json: coachSummaryJson,
    coach_summary_bytes: new TextEncoder().encode(coachSummaryJson).byteLength,
    coach_summary_filename: replaceFileExtension(jsonFilename, ".coach_summary.json"),
    msgpack_bytes: msgpackBytes,
    msgpack_filename: replaceFileExtension(jsonFilename, ".msgpack"),
    zip_bytes: zipSync({ [jsonFilename]: strToU8(exportJson) }, { level: 9 }),
    zip_filename: replaceFileExtension(jsonFilename, ".json.zip"),
  };
}

function buildCompactCoachSummary(exportPayload: ExportPayload) {
  return {
    schema_version: exportPayload.schema_version,
    app_version: exportPayload.app.version,
    run_id: exportPayload.run_metadata.run_id ?? null,
    created_at_utc: exportPayload.app.created_at_utc,
    run_classification: exportPayload.run_classification,
    route_direction: exportPayload.route_direction,
    route_snapping: exportPayload.route_snapping,
    route_snapped_summary: exportPayload.route_snapped_summary,
    active_target_distance_result: exportPayload.active_target_distance_result,
    active_short_target_result: exportPayload.active_short_target_result,
    active_target_distance_splits: {
      kilometers: exportPayload.active_target_distance_splits.kilometers,
      fixed_500m: exportPayload.active_target_distance_splits.fixed_500m,
    },
    data_quality_scores: exportPayload.data_quality_scores,
    usability: exportPayload.usability,
    subjective_debrief: exportPayload.subjective_debrief,
    coach_ready_summary: exportPayload.coach_ready_summary,
    patch_execution_assessment: exportPayload.patch_execution_assessment,
    route_confirmation_prompt: exportPayload.route_confirmation_prompt,
    in_run_notes: exportPayload.in_run_notes,
    data_quality_notes: exportPayload.data_quality_notes,
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
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
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
    estimated_motion_sample_rate_hz_optional: round(bucket.sampleCount / duration, 3),
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

function numberFromUnknown(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringFromUnknown(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
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

function formatNullableDuration(seconds: number | null): string {
  return seconds === null ? "unknown time" : formatDuration(seconds);
}

function formatMeters(meters: number): string {
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(2)} km`;
  }
  return `${Math.round(meters)} m`;
}

function formatNullableMeters(meters: number | null): string {
  return meters === null ? "unknown distance" : formatMeters(meters);
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

function formatHistoryDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "unknown date";
  }
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatPace(secondsPerMile: number | null): string {
  if (secondsPerMile === null || !Number.isFinite(secondsPerMile)) {
    return "--";
  }
  const totalSeconds = Math.round(secondsPerMile);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${pad2(seconds)} /mi`;
}

function formatPaceKm(secondsPerKm: number | null): string {
  if (secondsPerKm === null || !Number.isFinite(secondsPerKm)) {
    return "--";
  }
  const totalSeconds = Math.round(secondsPerKm);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
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

function isWarmupGpsReady(point: GpsPoint | null, accuracy: number | null): boolean {
  if (!point || accuracy === null || accuracy > GPS_READY_ACCURACY_METERS) {
    return false;
  }
  const fixTime = Date.parse(point.timestamp_utc);
  if (!Number.isFinite(fixTime)) {
    return false;
  }
  return Date.now() - fixTime <= GPS_READY_FIX_AGE_SECONDS * 1000;
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
  const tooFast =
    currentSplitSecondsPerKm !== null &&
    band.minSecondsPerKm !== null &&
    currentSplitSecondsPerKm < band.minSecondsPerKm;
  const tooSlow =
    currentSplitSecondsPerKm !== null &&
    band.maxSecondsPerKm !== null &&
    currentSplitSecondsPerKm > band.maxSecondsPerKm;
  return {
    band,
    currentSplitSecondsPerKm,
    status: band.minSecondsPerKm === null ? "steady" : inBand ? "in_band" : tooFast ? "too_fast" : tooSlow ? "too_slow" : "warming",
    statusLabel:
      band.minSecondsPerKm === null
        ? "steady"
        : inBand
          ? "in band"
          : tooFast
            ? currentKm === 1 && currentSplitSecondsPerKm !== null && currentSplitSecondsPerKm < 330
              ? "too fast for test"
              : "too fast"
            : tooSlow
              ? "too slow"
              : "warming",
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
    case "home":
      return "home";
    case "setup":
      return "pre-run";
    case "recovery":
      return "recovery";
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
  const parsed = Date.parse(startTimeUtc);
  const date = Number.isFinite(parsed) ? new Date(parsed) : new Date();
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

export class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error === null) {
      return this.props.children;
    }
    return (
      <main className="app-shell">
        <section className="result-panel">
          <h2>The app hit an unexpected error.</h2>
          <p className="filename">{String(this.state.error)}</p>
          <p>Saved run history is safe. Discarding the draft only removes the in-progress run snapshot.</p>
          <div className="button-grid vertical">
            <button type="button" className="primary-button" onClick={() => window.location.reload()}>
              Reload
            </button>
            <button
              type="button"
              className="danger-button"
              onClick={() => {
                try {
                  localStorage.removeItem(STORAGE_KEY);
                } catch {
                  // Draft cleanup is best effort.
                }
                void deleteRunFromIndexedDb().then(() => window.location.reload());
              }}
            >
              Discard saved draft and reload
            </button>
          </div>
        </section>
      </main>
    );
  }
}
