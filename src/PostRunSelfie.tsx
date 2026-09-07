import { useEffect, useRef, useState } from "react";
import { FaceDetector, FilesetResolver } from "@mediapipe/tasks-vision";
import { analyzeSelfiePulse } from "./selfiePulse";
import type { SelfieBiometrics, SelfiePulseEstimate, SelfiePulseSample } from "./types";
import "./selfie-camera.css";

interface PostRunSelfieProps {
  stoppedAtUtc: string | null;
  onComplete: (result: SelfieBiometrics) => void;
  onSkip: () => void;
}

type Phase = "starting" | "capturing" | "paused" | "result" | "error";
interface View {
  phase: Phase;
  elapsed: number;
  windowSeconds: number;
  guidance: string;
  estimate: SelfiePulseEstimate | null;
}
interface PulseWindow {
  center: number;
  estimate: SelfiePulseEstimate & { heart_rate_bpm: number };
}
interface FaceBox { x: number; y: number; width: number; height: number }
interface Patch { x: number; y: number; width: number; height: number }
type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number, metadata: { mediaTime: number }) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

const CAPTURE_SECONDS = 60;
const WINDOW_SECONDS = 22;
const PATCH_SIZE = 32;
const INITIAL_VIEW: View = {
  phase: "starting", elapsed: 0, windowSeconds: 0,
  guidance: "Opening the front camera. Allow camera access to try a reading.", estimate: null,
};

function cameraError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Camera permission was denied. Allow camera access in your browser settings and retry, or skip.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No usable front camera was found. You can skip this scan.";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "The camera could not start. Close other apps using it, then retry, or skip.";
  }
  return "The camera could not start. Retry, or skip this scan.";
}

export function PostRunSelfie({ stoppedAtUtc, onComplete, onSkip }: PostRunSelfieProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const samplesRef = useRef<SelfiePulseSample[]>([]);
  const sessionRef = useRef<{ stop: () => void; finish: () => void } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<View>(INITIAL_VIEW);
  const [result, setResult] = useState<SelfieBiometrics | null>(null);

  useEffect(() => {
    const video = videoRef.current as FrameVideo | null;
    if (!video) return;
    let disposed = false;
    let stream: MediaStream | null = null;
    let detector: FaceDetector | null = null;
    let frameHandle: number | null = null;
    let animationHandle: number | null = null;
    let timer: number | undefined;
    let phase: Phase = "starting";
    let guidance = INITIAL_VIEW.guidance;
    let estimate: SelfiePulseEstimate | null = null;
    let firstWindow: PulseWindow | null = null;
    let lastWindow: PulseWindow | null = null;
    let acceptedWindows = 0;
    let previousBox: FaceBox | null = null;
    let previousLight: number | null = null;
    let previousFrameTime: number | null = null;
    let lastVideoTime = -1;
    let lastAnalysisTime = -Infinity;
    let stableSince: number | null = null;
    let startedAt: string | null = null;
    let startedClock = 0;
    let pausedAt: number | null = null;
    let pausedMilliseconds = 0;
    let lastFrameClock = 0;
    const canvas = document.createElement("canvas");
    canvas.width = PATCH_SIZE * 3;
    canvas.height = PATCH_SIZE;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    samplesRef.current = [];
    setView(INITIAL_VIEW);
    setResult(null);

    function resetSignal(reason: string) {
      samplesRef.current.length = 0;
      previousBox = null;
      previousLight = null;
      previousFrameTime = null;
      stableSince = null;
      firstWindow = null;
      lastWindow = null;
      acceptedWindows = 0;
      estimate = null;
      guidance = reason;
    }

    function stop() {
      disposed = true;
      if (frameHandle !== null) video?.cancelVideoFrameCallback?.(frameHandle);
      if (animationHandle !== null) cancelAnimationFrame(animationHandle);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
      stream?.getTracks().forEach((track) => {
        track.removeEventListener("ended", cameraEnded);
        track.stop();
      });
      stream = null;
      if (video) { video.pause(); video.srcObject = null; }
      detector?.close();
      detector = null;
      samplesRef.current.length = 0;
      canvas.width = 0;
      canvas.height = 0;
    }

    function elapsedSeconds() {
      if (!startedAt) return 0;
      return Math.max(0, ((pausedAt ?? performance.now()) - startedClock - pausedMilliseconds) / 1000);
    }

    function publish() {
      if (disposed) return;
      const samples = samplesRef.current;
      setView({
        phase, elapsed: Math.min(CAPTURE_SECONDS, elapsedSeconds()),
        windowSeconds: samples.length > 1 ? samples[samples.length - 1].timestamp_seconds - samples[0].timestamp_seconds : 0,
        guidance, estimate,
      });
    }

    function fail(message: string) {
      stop();
      setView({ phase: "error", elapsed: 0, windowSeconds: 0, guidance: message, estimate: null });
    }

    function cameraEnded() { fail("The camera disconnected. Retry, or continue without a reading."); }

    function finish() {
      if (disposed || !startedAt) return;
      const endedAt = new Date().toISOString();
      const duration = (performance.now() - startedClock) / 1000;
      const startAfterStop = stoppedAtUtc === null ? NaN : (Date.parse(startedAt) - Date.parse(stoppedAtUtc)) / 1000;
      const last = lastWindow as PulseWindow | null;
      const first = firstWindow as PulseWindow | null;
      const interval = first && last ? last.center - first.center : 0;
      const hasTrend = interval >= 20;
      const complete: SelfieBiometrics = {
        method: "face_camera_pos_rppg",
        status: last ? "estimated" : "insufficient_signal",
        started_at_utc: startedAt,
        ended_at_utc: endedAt,
        duration_seconds: Math.round(duration * 10) / 10,
        seconds_after_run_stop: Number.isFinite(startAfterStop) && startAfterStop >= 0 ? Math.round(startAfterStop * 10) / 10 : null,
        heart_rate_bpm: last?.estimate.heart_rate_bpm ?? null,
        first_heart_rate_bpm: hasTrend && first ? first.estimate.heart_rate_bpm : null,
        last_heart_rate_bpm: hasTrend && last ? last.estimate.heart_rate_bpm : null,
        heart_rate_change_bpm: hasTrend && first && last ? Math.round((last.estimate.heart_rate_bpm - first.estimate.heart_rate_bpm) * 10) / 10 : null,
        trend_interval_seconds: hasTrend ? Math.round(interval * 10) / 10 : null,
        signal_quality: last?.estimate.signal_quality ?? estimate?.signal_quality ?? 0,
        accepted_window_count: acceptedWindows,
        frame_rate_hz: last?.estimate.frames_per_second ?? estimate?.frames_per_second ?? 0,
        notes: [
          "Experimental face-camera pulse estimate; not a medical device. No images recorded or uploaded.",
          last ? "Pulse is estimated from the latest usable window, not an instantaneous measurement." : `No reliable pulse reading: ${guidance}`,
          hasTrend ? "Pulse change is last minus first over the stated scan interval; this is not clinical one-minute heart-rate recovery." : "No pulse-change estimate: two usable windows at least 20 seconds apart were not available.",
          ...(pausedMilliseconds > 0 || pausedAt !== null ? ["The scan was paused while the app was hidden; signal windows were restarted."] : []),
        ],
      };
      stop();
      setResult(complete);
      setView({ phase: "result", elapsed: Math.min(CAPTURE_SECONDS, duration), windowSeconds: 0, guidance: last ? "Scan complete." : "No reliable reading this time.", estimate: last?.estimate ?? null });
    }

    function visibilityChanged() {
      if (disposed || !startedAt) return;
      if (document.hidden) {
        pausedAt = performance.now();
        phase = "paused";
        stream?.getVideoTracks().forEach((track) => { track.enabled = false; });
        resetSignal("Scan paused while the app is hidden. Return to start a fresh signal window.");
      } else {
        if (pausedAt !== null) pausedMilliseconds += performance.now() - pausedAt;
        pausedAt = null;
        phase = "capturing";
        stream?.getVideoTracks().forEach((track) => { track.enabled = true; });
        lastVideoTime = -1;
        lastFrameClock = performance.now();
        resetSignal("Hold still in even light. Starting a fresh signal window.");
      }
      publish();
    }

    function processFrame(mediaTime: number, now: number) {
      if (disposed || phase !== "capturing" || document.hidden || !detector || !context) return;
      if (video!.readyState < 2 || mediaTime === lastVideoTime) return;
      lastVideoTime = mediaTime;
      lastFrameClock = now;
      if (previousFrameTime !== null && (mediaTime <= previousFrameTime || mediaTime - previousFrameTime > 0.2)) {
        resetSignal("Video frames were interrupted. Hold still while a fresh window builds.");
      }
      previousFrameTime = mediaTime;
      const width = video!.videoWidth;
      const height = video!.videoHeight;
      const faces = detector.detectForVideo(video!, now).detections;
      if (faces.length !== 1) {
        resetSignal(faces.length ? "Only one face should be visible in the camera." : "Bring your whole face into view and look toward the camera.");
        return;
      }
      const face = faces[0];
      const bounds = face.boundingBox;
      if (!bounds || face.keypoints.length < 3) { resetSignal("Face landmarks are not clear. Face the camera in even light."); return; }
      const box: FaceBox = { x: bounds.originX, y: bounds.originY, width: bounds.width, height: bounds.height };
      if (box.width < width * 0.25 || box.height < height * 0.32) { resetSignal("Move a little closer so your face fills more of the preview."); return; }
      if (box.x < 0 || box.y < 0 || box.x + box.width > width || box.y + box.height > height) { resetSignal("Move back slightly so your whole face is visible."); return; }
      const eyeA = { x: face.keypoints[0].x * width, y: face.keypoints[0].y * height };
      const eyeB = { x: face.keypoints[1].x * width, y: face.keypoints[1].y * height };
      const eyeX = (eyeA.x + eyeB.x) / 2;
      const eyeY = (eyeA.y + eyeB.y) / 2;
      const eyeDistance = Math.abs(eyeB.x - eyeA.x);
      const noseX = face.keypoints[2].x * width;
      if (Math.abs(eyeA.y - eyeB.y) > box.width * 0.12 || eyeDistance < box.width * 0.25 || Math.abs(noseX - eyeX) > box.width * 0.14) {
        resetSignal("Look straight at the camera with your head upright."); return;
      }
      const motion = previousBox ?
        Math.hypot((box.x + box.width / 2 - previousBox.x - previousBox.width / 2) / box.width,
          (box.y + box.height / 2 - previousBox.y - previousBox.height / 2) / box.height) +
        Math.abs(Math.log(box.width / previousBox.width)) + Math.abs(Math.log(box.height / previousBox.height)) : 0;
      previousBox = box;
      if (motion > 0.075) { resetSignal("Movement detected. Rest your phone and keep your face still."); return; }
      const patches: Patch[] = [
        { x: eyeX - box.width * 0.14, y: eyeY - box.height * 0.24, width: box.width * 0.28, height: box.height * 0.12 },
        { x: eyeA.x - box.width * 0.09, y: eyeY + box.height * 0.15, width: box.width * 0.18, height: box.height * 0.16 },
        { x: eyeB.x - box.width * 0.09, y: eyeY + box.height * 0.15, width: box.width * 0.18, height: box.height * 0.16 },
      ];
      if (patches.some((patch) => patch.x < 0 || patch.y < 0 || patch.x + patch.width > width || patch.y + patch.height > height)) {
        resetSignal("Keep your forehead and both cheeks fully in view."); return;
      }
      for (let region = 0; region < 3; region++) {
        const patch = patches[region];
        context.drawImage(video!, patch.x, patch.y, patch.width, patch.height, region * PATCH_SIZE, 0, PATCH_SIZE, PATCH_SIZE);
      }
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const regions: [[number, number, number], [number, number, number], [number, number, number]] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      let clipped = 0;
      for (let y = 0; y < PATCH_SIZE; y++) {
        for (let region = 0; region < 3; region++) {
          const sums = regions[region];
          for (let x = 0; x < PATCH_SIZE; x++) {
            const index = (y * canvas.width + region * PATCH_SIZE + x) * 4;
            const red = pixels[index]; const green = pixels[index + 1]; const blue = pixels[index + 2];
            sums[0] += red; sums[1] += green; sums[2] += blue;
            if (red <= 3 || green <= 3 || blue <= 3 || red >= 252 || green >= 252 || blue >= 252) clipped++;
          }
        }
      }
      for (const region of regions) for (let channel = 0; channel < 3; channel++) region[channel] /= PATCH_SIZE * PATCH_SIZE;
      const clippedFraction = clipped / (PATCH_SIZE * PATCH_SIZE * 3);
      const light = regions.reduce((sum, region) => sum + (region[0] + region[1] + region[2]) / 3, 0) / 3;
      if (light < 30 || light > 225 || clippedFraction > 0.02) { resetSignal("Lighting is too dark or bright. Use soft, even light on your face."); return; }
      if (previousLight !== null && Math.abs(light - previousLight) / previousLight > 0.08) { resetSignal("Lighting changed. Keep the phone and lighting steady."); return; }
      previousLight = light;
      if (stableSince === null) stableSince = mediaTime;
      if (mediaTime - stableSince < 1.5) { guidance = "Face found. Hold still while the camera settles."; return; }
      const samples = samplesRef.current;
      samples.push({ timestamp_seconds: mediaTime, regions, motion, clipped_fraction: clippedFraction });
      // A bounded contiguous window; no camera frames or images are retained.
      let expired = 0;
      while (expired < samples.length && (mediaTime - samples[expired].timestamp_seconds > WINDOW_SECONDS || samples.length - expired > 1800)) expired++;
      if (expired) samples.splice(0, expired);
      const span = mediaTime - samples[0].timestamp_seconds;
      if (span < 20) { guidance = "Keep still. Building at least 20 seconds of continuous signal."; return; }
      if (now - lastAnalysisTime < 1000) return;
      lastAnalysisTime = now;
      estimate = analyzeSelfiePulse(samples);
      if (estimate.heart_rate_bpm !== null && estimate.usable_seconds >= 20) {
        const accepted: PulseWindow = { center: (samples[0].timestamp_seconds + mediaTime) / 2, estimate: { ...estimate, heart_rate_bpm: estimate.heart_rate_bpm } };
        if (!firstWindow) firstWindow = accepted;
        lastWindow = accepted;
        acceptedWindows++;
        guidance = "Usable experimental pulse signal. Use it now, or stay still for pulse change over the scan.";
      } else {
        // Do not offer an old value as a current reading after quality deteriorates.
        lastWindow = null;
        guidance = estimate.reason ?? "Pulse signal is not reliable yet. Keep still in even light.";
      }
    }

    function scheduleFrame() {
      if (disposed) return;
      if (typeof video!.requestVideoFrameCallback === "function") {
        frameHandle = video!.requestVideoFrameCallback((now, metadata) => {
          try { processFrame(metadata.mediaTime, now); }
          catch { fail("Face analysis stopped unexpectedly. Retry, or continue without a reading."); }
          scheduleFrame();
        });
      } else {
        animationHandle = requestAnimationFrame((now) => {
          try { processFrame(video!.currentTime, now); }
          catch { fail("Face analysis stopped unexpectedly. Retry, or continue without a reading."); }
          scheduleFrame();
        });
      }
    }

    async function start() {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        fail("Camera scanning needs HTTPS and a browser with camera support. You can skip this scan."); return;
      }
      if (!context) { fail("This browser cannot read the camera signal. You can skip this scan."); return; }
      try {
        const acquired = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "user" }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } },
        });
        if (disposed) { acquired.getTracks().forEach((track) => track.stop()); return; }
        stream = acquired;
        stream.getVideoTracks().forEach((track) => track.addEventListener("ended", cameraEnded));
        video!.srcObject = stream;
        await video!.play();
        if (disposed) return;
      } catch (error) { if (!disposed) fail(cameraError(error)); return; }
      guidance = "Loading the on-device face detector. Camera images stay on this device.";
      publish();
      try {
        const fileset = await FilesetResolver.forVisionTasks(`${import.meta.env.BASE_URL}mediapipe`);
        if (disposed) return;
        const created = await FaceDetector.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: `${import.meta.env.BASE_URL}models/blaze_face_short_range.tflite`, delegate: "CPU" },
          runningMode: "VIDEO", minDetectionConfidence: 0.75, minSuppressionThreshold: 0.3,
        });
        if (disposed) { created.close(); return; }
        detector = created;
      } catch { if (!disposed) fail("The on-device face detector could not load. Connect once to download the app's camera assets, then retry, or skip."); return; }
      startedAt = new Date().toISOString();
      startedClock = performance.now();
      lastFrameClock = startedClock;
      phase = "capturing";
      guidance = "Face the camera in even light. Rest your phone and keep still.";
      document.addEventListener("visibilitychange", visibilityChanged);
      if (document.hidden) visibilityChanged();
      publish();
      timer = window.setInterval(() => {
        if (disposed) return;
        if (phase === "capturing" && performance.now() - lastFrameClock > 1000) {
          resetSignal("Waiting for fresh camera frames. Check that the camera is not blocked or in use elsewhere.");
        }
        if (phase === "capturing" && elapsedSeconds() >= CAPTURE_SECONDS) finish();
        else publish();
      }, 250);
      scheduleFrame();
    }

    sessionRef.current = { stop, finish };
    void start();
    return () => { stop(); sessionRef.current = null; };
  }, [attempt, stoppedAtUtc]);

  const skip = () => { sessionRef.current?.stop(); onSkip(); };
  const usable = view.phase === "capturing" && view.estimate?.heart_rate_bpm !== null && view.estimate !== null && view.estimate.usable_seconds >= 20;
  const done = view.phase === "result";
  const failed = view.phase === "error";
  return (
    <section className="selfie-screen" aria-labelledby="selfie-title">
      <header>
        <p className="eyebrow">Optional post-run scan</p>
        <h2 id="selfie-title">Camera pulse check</h2>
        <p className="selfie-notice">Experimental, not a medical device. Stay seated or stand safely; do not scan while moving. No images are saved or uploaded.</p>
      </header>
      <div className="selfie-actions">
        {done && result ? <button type="button" className="selfie-primary" onClick={() => onComplete(result)}>Continue{result.status === "estimated" ? " with reading" : " without a reading"}</button> :
          <button type="button" className="selfie-primary" disabled={!usable} onClick={() => sessionRef.current?.finish()}>Use reading</button>}
        {(done || failed) && <button type="button" onClick={() => { sessionRef.current?.stop(); setAttempt((value) => value + 1); }}>Retry camera scan</button>}
        <button type="button" className="selfie-skip" onClick={skip}>{failed ? "Continue without scanning" : "Skip camera scan"}</button>
      </div>
      <div className={`selfie-preview${done || failed ? " selfie-preview-ended" : ""}`}>
        <video ref={videoRef} autoPlay muted playsInline aria-label="Mirrored front-camera preview" />
        {!done && !failed && <div className="selfie-face-guide" aria-hidden="true" />}
        {(done || failed) && <span>{result?.status === "estimated" ? "Scan complete" : "Camera off"}</span>}
      </div>
      <div className="selfie-status" role="status" aria-live="polite" aria-atomic="true">
        <p>{view.guidance}</p>
        {!done && !failed && <p className="selfie-hint">Keep your forehead and both cheeks visible. Look straight ahead, avoid talking, and use even light without glare.</p>}
      </div>
      {!done && !failed && <div className="selfie-progress">
        <label htmlFor="selfie-progress">{Math.floor(view.elapsed)} / {CAPTURE_SECONDS} seconds{view.phase === "paused" ? " · paused" : ""}</label>
        <progress id="selfie-progress" max={CAPTURE_SECONDS} value={view.elapsed} />
        <small>Continuous signal: {Math.floor(view.windowSeconds)} seconds · at least 20 needed</small>
      </div>}
      <div className="selfie-reading">
        {((usable && view.estimate) || result?.status === "estimated") ? <>
          <span className="selfie-reading-label">Estimated pulse</span>
          <strong>{Math.round(result?.heart_rate_bpm ?? view.estimate!.heart_rate_bpm!)} <small>bpm</small></strong>
        </> : <p>{done ? "No reliable pulse estimate. Try again in steady light, or continue." : "No usable pulse estimate yet."}</p>}
        {(view.estimate || result) && <small>Signal quality: {Math.round(Math.max(0, Math.min(1, result?.signal_quality ?? view.estimate?.signal_quality ?? 0)) * 100)}% (not medical accuracy)</small>}
        {result?.heart_rate_change_bpm != null && <p>Pulse change over scan: <b>{result.heart_rate_change_bpm > 0 ? "+" : ""}{result.heart_rate_change_bpm} bpm</b> across {result.trend_interval_seconds} seconds. Not one-minute heart-rate recovery.</p>}
      </div>
      <p className="selfie-limitations">Motion, skin visibility, lighting and camera processing can prevent a reading or make it inaccurate. This cannot measure blood pressure, oxygen saturation, temperature, respiration or HRV. If you feel unwell, do not rely on the camera.</p>
    </section>
  );
}
