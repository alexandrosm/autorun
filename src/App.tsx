import {
  Activity,
  Clipboard,
  Download,
  Lock,
  MapPin,
  Play,
  RefreshCw,
  Share2,
  Square,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildExportPayload, computeLiveStats, createGpsPointFromPosition } from "./runMath";
import type {
  ActiveRun,
  BreathingRecoveredAfter,
  Checkpoint,
  GpsPoint,
  MotionWindow,
  PermissionState,
  PhonePosition,
  PostRunState,
  PreRunState,
  PrimaryLimiter,
  RouteDirection,
  Screen,
  SorenessLevel,
  WeatherStatusText,
  YesNoUnsure,
} from "./types";
import { emptyWeatherSnapshot, fetchOpenMeteoWeather } from "./weather";

const APP_NAME = "Green Lake AutoResearch Logger";
const APP_VERSION = "0.1.0";
const TIMEZONE = "America/Los_Angeles";
const STORAGE_KEY = "greenlake_autoresearch_logger_active_run_v0_1";
const MOTION_WINDOW_SECONDS = 5;

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

const defaultPreRun: PreRunState = {
  runner_id: "user_001",
  goal: "sub_25_5k",
  route_name: "Green Lake calibrated 5K",
  mode: "training_calibration",
  active_patch_id: "baseline_calibration_v1",
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
    weather_status: "will_fetch_after_gps",
  };
}

function createBlankRun(preRun: PreRunState, permissions: PermissionState): ActiveRun {
  const now = new Date();
  return {
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

  const gpsWatchIdRef = useRef<number | null>(null);
  const elapsedSecondsRef = useRef(initialRun?.elapsed_offset_seconds ?? 0);
  const runStartPerfRef = useRef<number | null>(
    initialRun && !initialRun.run_metadata.end_time_utc
      ? performance.now() - initialRun.elapsed_offset_seconds * 1000
      : null,
  );
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const motionBucketRef = useRef<MotionBucket | null>(null);
  const startWeatherFetchStartedRef = useRef(Boolean(initialRun?.weather.start_weather.fetched_at_utc));

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

  elapsedSecondsRef.current = elapsedSeconds;

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

  const stopGpsWatch = useCallback(() => {
    if (gpsWatchIdRef.current !== null && "geolocation" in navigator) {
      navigator.geolocation.clearWatch(gpsWatchIdRef.current);
      gpsWatchIdRef.current = null;
    }
  }, []);

  const fetchWeatherForRun = useCallback(
    async (kind: "start" | "finish", lat: number, lon: number) => {
      updatePermissions({ weather_status: "fetching" });
      try {
        const snapshot = await fetchOpenMeteoWeather(lat, lon);
        setActiveRun((run) => {
          if (!run) {
            return run;
          }
          return {
            ...run,
            weather: {
              ...run.weather,
              [kind === "start" ? "start_weather" : "finish_weather"]: snapshot,
            },
          };
        });
        updatePermissions({ weather_status: "fetched" });
      } catch (error) {
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

        setActiveRun((run) => {
          if (!run) {
            return run;
          }
          const previousPoint = run.gps_points[run.gps_points.length - 1] ?? null;
          const point = createGpsPointFromPosition(position, elapsed, previousPoint);
          pointForWeather.current = point;
          return {
            ...run,
            gps_points: [...run.gps_points, point],
            elapsed_offset_seconds: elapsed,
          };
        });

        updatePermissions({ geolocation_permission: "ready" });

        if (!startWeatherFetchStartedRef.current && pointForWeather.current) {
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
        updatePermissions({ wake_lock_available: false, wake_lock_status: "unavailable" });
        if (!silent) {
          setActionMessage("Wake lock unavailable.");
        }
        return;
      }
      try {
        const lock = await navigator.wakeLock.request("screen");
        wakeLockRef.current = lock;
        lock.addEventListener("release", () => {
          updatePermissions({ wake_lock_status: "inactive" });
        });
        updatePermissions({ wake_lock_available: true, wake_lock_status: "active", wake_lock_used: true });
        if (!silent) {
          setActionMessage("Wake lock active.");
        }
      } catch {
        updatePermissions({ wake_lock_status: "inactive" });
        if (!silent) {
          setActionMessage("Wake lock could not be enabled.");
        }
      }
    },
    [updatePermissions],
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
      setActionMessage("Motion unavailable.");
      return;
    }

    try {
      const requestPermission = (
        DeviceMotionEvent as unknown as { requestPermission?: () => Promise<"granted" | "denied"> }
      ).requestPermission;
      if (typeof requestPermission === "function") {
        const result = await requestPermission();
        updatePermissions({ device_motion_permission: result === "granted" ? "ready" : "denied" });
        setActionMessage(result === "granted" ? "Motion ready." : "Motion denied.");
      } else {
        updatePermissions({ device_motion_permission: "ready" });
        setActionMessage("Motion ready.");
      }
    } catch {
      updatePermissions({ device_motion_permission: "denied" });
      setActionMessage("Motion permission failed.");
    }
  };

  const startRun = () => {
    const run = createBlankRun(preRun, permissions);
    setActiveRun(run);
    setElapsedSeconds(0);
    setExportCreatedAt(new Date().toISOString());
    setActionMessage("");
    runStartPerfRef.current = performance.now();
    motionBucketRef.current = null;
    startWeatherFetchStartedRef.current = false;
    setScreen("live");
    startGpsWatch();
    if (permissions.wake_lock_used || permissions.wake_lock_status === "active") {
      void requestWakeLock(true);
    }
  };

  const stopRun = async () => {
    const elapsed = getElapsedSeconds();
    flushMotionBucket(elapsed);
    stopGpsWatch();
    await releaseWakeLock();
    const now = new Date();
    setActiveRun((run) =>
      run
        ? {
            ...run,
            elapsed_offset_seconds: elapsed,
            run_metadata: {
              ...run.run_metadata,
              end_time_local: formatLocalIso(now),
              end_time_utc: now.toISOString(),
            },
          }
        : run,
    );
    runStartPerfRef.current = null;
    setElapsedSeconds(elapsed);
    setScreen("stop");

    const lastPoint = activeRun?.gps_points[activeRun.gps_points.length - 1];
    if (lastPoint) {
      void fetchWeatherForRun("finish", lastPoint.lat, lastPoint.lon);
    }
  };

  const resumeRun = () => {
    setActiveRun((run) =>
      run
        ? {
            ...run,
            run_metadata: {
              ...run.run_metadata,
              end_time_local: null,
              end_time_utc: null,
            },
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
    void releaseWakeLock();
    localStorage.removeItem(STORAGE_KEY);
    setActiveRun(null);
    setPreRun(defaultPreRun);
    setPermissions(defaultPermissions());
    setElapsedSeconds(0);
    setActionMessage("");
    runStartPerfRef.current = null;
    motionBucketRef.current = null;
    startWeatherFetchStartedRef.current = false;
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
      };
      return { ...run, checkpoints: [...run.checkpoints, checkpoint] };
    });
    setActionMessage("Checkpoint saved.");
  };

  const continueToPostRun = () => {
    setScreen("post");
  };

  const continueToExport = () => {
    setExportCreatedAt(new Date().toISOString());
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
    const blob = new Blob([exportJson], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFilename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setActionMessage("JSON download started.");
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
      setElapsedSeconds(getElapsedSeconds());
    }, 500);

    return () => window.clearInterval(intervalId);
  }, [activeRun, getElapsedSeconds, screen, startGpsWatch]);

  useEffect(() => {
    if (screen !== "live" || permissions.device_motion_permission !== "ready") {
      return undefined;
    }

    const handleMotion = (event: DeviceMotionEvent) => {
      const elapsed = getElapsedSeconds();
      const bucketStart = Math.floor(elapsed / MOTION_WINDOW_SECONDS) * MOTION_WINDOW_SECONDS;
      const currentBucket = motionBucketRef.current;

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
  }, [appendMotionWindow, getElapsedSeconds, permissions.device_motion_permission, screen]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "visible" && screen === "live" && permissions.wake_lock_used) {
        void requestWakeLock(true);
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [permissions.wake_lock_used, requestWakeLock, screen]);

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
    return () => {
      stopGpsWatch();
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

      {screen === "setup" ? (
        <SetupScreen
          preRun={preRun}
          permissions={permissions}
          setPreRun={setPreRun}
          onGps={requestGpsPermission}
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
          postRun={activeRun.post_run}
          updatePostRun={updatePostRun}
          updatePostRunPain={updatePostRunPain}
          onExport={continueToExport}
        />
      ) : null}

      {screen === "export" && activeRun ? (
        <ExportScreen
          exportJson={exportJson}
          filename={exportFilename}
          onDownload={downloadJson}
          onCopy={() => void copyJson()}
          onShare={() => void shareJson()}
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
  setPreRun,
  onGps,
  onMotion,
  onWakeLock,
  onStart,
}: {
  preRun: PreRunState;
  permissions: PermissionState;
  setPreRun: (next: PreRunState) => void;
  onGps: () => void;
  onMotion: () => void;
  onWakeLock: () => void;
  onStart: () => void;
}) {
  const setPain = (patch: Partial<PreRunState["pain_before_run"]>) => {
    setPreRun({
      ...preRun,
      pain_before_run: { ...preRun.pain_before_run, ...patch },
    });
  };

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
        <button type="button" className="secondary-button" onClick={onMotion}>
          <Activity size={18} />
          Request motion
        </button>
        <button type="button" className="secondary-button" onClick={onWakeLock}>
          <Lock size={18} />
          Enable wake lock
        </button>
      </section>

      <section className="form-panel">
        <ReadonlyField label="Runner ID" value={preRun.runner_id} />
        <ReadonlyField label="Goal" value={preRun.goal} />
        <ReadonlyField label="Mode" value={preRun.mode} />
        <ReadonlyField label="Active patch" value={preRun.active_patch_id} />

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

      <button type="button" className="primary-button sticky-action" onClick={onStart}>
        <Play size={20} />
        Start run
      </button>
    </section>
  );
}

function LiveScreen({
  run,
  elapsedSeconds,
  liveStats,
  onCheckpoint,
  onStop,
  onDiscard,
}: {
  run: ActiveRun;
  elapsedSeconds: number;
  liveStats: ReturnType<typeof computeLiveStats>;
  onCheckpoint: () => void;
  onStop: () => void;
  onDiscard: () => void;
}) {
  const remainingMeters = Math.max(0, run.pre_run.intended_distance_meters - liveStats.distanceMeters);

  return (
    <section className="screen-stack live-screen">
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

      <section className="status-grid compact">
        <StatusItem label="GPS points" value={String(run.gps_points.length)} />
        <StatusItem label="Motion windows" value={String(run.motion_windows.length)} />
        <StatusItem label="Wake lock" value={wakeLabel(run.permissions.wake_lock_status)} />
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
  postRun,
  updatePostRun,
  updatePostRunPain,
  onExport,
}: {
  postRun: PostRunState;
  updatePostRun: (patch: Partial<PostRunState>) => void;
  updatePostRunPain: (patch: Partial<PostRunState["pain_after_run"]>) => void;
  onExport: () => void;
}) {
  return (
    <section className="screen-stack">
      <section className="form-panel">
        <label>
          RPE
          <select
            value={postRun.rpe_1_to_10 ?? ""}
            onChange={(event) => updatePostRun({ rpe_1_to_10: numberFromInput(event.target.value) })}
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
          Started too fast
          <select
            value={postRun.started_too_fast}
            onChange={(event) => updatePostRun({ started_too_fast: event.target.value as YesNoUnsure })}
          >
            <YesNoUnsureOptions />
          </select>
        </label>

        <label>
          Final third harder than expected
          <select
            value={postRun.final_third_harder_than_expected}
            onChange={(event) =>
              updatePostRun({ final_third_harder_than_expected: event.target.value as YesNoUnsure })
            }
          >
            <YesNoUnsureOptions />
          </select>
        </label>

        <label>
          Interruption
          <select
            value={postRun.interruption}
            onChange={(event) => updatePostRun({ interruption: event.target.value as PostRunState["interruption"] })}
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
      </section>

      <button type="button" className="primary-button sticky-action" onClick={onExport}>
        Continue to export
      </button>
    </section>
  );
}

function ExportScreen({
  exportJson,
  filename,
  onDownload,
  onCopy,
  onShare,
  onBackToPost,
  onDiscard,
}: {
  exportJson: string;
  filename: string;
  onDownload: () => void;
  onCopy: () => void;
  onShare: () => void;
  onBackToPost: () => void;
  onDiscard: () => void;
}) {
  return (
    <section className="screen-stack">
      <section className="result-panel">
        <h2>Export ready</h2>
        <p className="filename">{filename}</p>
      </section>

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

function YesNoUnsureOptions() {
  return (
    <>
      <option value="unknown">unknown</option>
      <option value="yes">yes</option>
      <option value="no">no</option>
      <option value="unsure">unsure</option>
    </>
  );
}

function loadStoredRun(): ActiveRun | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as ActiveRun;
  } catch {
    return null;
  }
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

function numberFromInput(value: string): number | null {
  if (value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

function formatPace(secondsPerMile: number | null): string {
  if (secondsPerMile === null || !Number.isFinite(secondsPerMile)) {
    return "--";
  }
  const minutes = Math.floor(secondsPerMile / 60);
  const seconds = Math.round(secondsPerMile % 60);
  return `${minutes}:${pad2(seconds)} /mi`;
}

function formatAccuracy(meters: number | null): string {
  return meters === null ? "unknown" : `${Math.round(meters)} m`;
}

function permissionLabel(value: string): string {
  return value === "ready" || value === "denied" || value === "unavailable" ? value : "unknown";
}

function wakeLabel(value: string): string {
  return value === "active" || value === "unavailable" ? value : "inactive";
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
