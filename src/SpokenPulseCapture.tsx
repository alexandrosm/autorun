import { useEffect, useRef, useState } from "react";
import { analyzeSpokenPulse, SpokenBeatDetector } from "./spokenPulse";
import type { SpokenPulseFrame } from "./spokenPulse";
import type { SpokenPulseMeasurement } from "./types";
import "./spoken-pulse.css";

interface SpokenPulseCaptureProps {
  stoppedAtUtc: string | null;
  onComplete: (measurement: SpokenPulseMeasurement, audio: Blob) => Promise<boolean>;
  onCancel: () => void;
  onPhaseChange?: (phase: string) => void;
}

type Phase = "ready" | "starting" | "calibrating" | "capturing" | "finishing" | "result" | "error" | "saving" | "saved";
interface View { phase: Phase; elapsed: number; count: number; pulse: boolean; message: string }
interface Result { measurement: SpokenPulseMeasurement; audio: Blob }
interface Session { dispose: () => void; finish: (reason: string) => void }
const WINDOW_START = 3;
const WINDOW_END = 33;
const INITIAL_VIEW: View = { phase: "ready", elapsed: 0, count: 0, pulse: false, message: "Ready when you are. The microphone only opens when you press Start." };

function microphoneError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access was denied. You can change browser permissions and try again, or skip. Nothing was saved.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No usable microphone was found. Nothing was saved.";
  if (name === "NotReadableError" || name === "AbortError") return "The microphone could not start. Close other apps using it before trying again. Nothing was saved.";
  return "Audio capture could not start in this browser. Nothing was saved. You can try again or skip.";
}

function audioExtension(type: string): string {
  if (type.includes("mp4")) return "m4a";
  if (type.includes("ogg")) return "ogg";
  if (type.includes("wav")) return "wav";
  return "webm";
}

export function SpokenPulseCapture({ stoppedAtUtc, onComplete, onCancel, onPhaseChange }: SpokenPulseCaptureProps) {
  const [view, setView] = useState<View>(INITIAL_VIEW);
  const [position, setPosition] = useState<SpokenPulseMeasurement["recovery_position"]>("unknown");
  const [result, setResult] = useState<Result | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [matched, setMatched] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const sessionRef = useRef<Session | null>(null);
  const savingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; sessionRef.current?.dispose(); sessionRef.current = null; };
  }, []);
  useEffect(() => { onPhaseChange?.(view.phase); }, [view.phase, onPhaseChange]);
  useEffect(() => {
    if (!result) { setAudioUrl(null); return; }
    const url = URL.createObjectURL(result.audio);
    setAudioUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [result]);

  function start() {
    if (sessionRef.current || savingRef.current) return;
    setResult(null);
    setMatched(false);
    setSaveError(null);
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined" || typeof AudioContext === "undefined" || typeof AudioWorkletNode === "undefined" || !crypto.randomUUID) {
      setView({ ...INITIAL_VIEW, phase: "error", message: "This reading needs HTTPS, microphone recording and AudioWorklet support. Use a current browser, or skip. Nothing was saved." });
      return;
    }

    let disposed = false;
    let finishing = false;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let meter: AudioWorkletNode | null = null;
    let recorder: MediaRecorder | null = null;
    let timer: number | undefined;
    let stopTimeout: number | undefined;
    let startedClock: number | null = null;
    let startedWallClock = 0;
    let recordingUtc = 0;
    let detector: SpokenBeatDetector | null = null;
    let lastPulseClock = -Infinity;
    let lastFrameClock = 0;
    let endReason: string | null = null;
    let stopResolved = false;
    let resolveStopped: ((stopped: boolean) => void) | null = null;
    const frames: SpokenPulseFrame[] = [];
    const chunks: Blob[] = [];
    const cues: OscillatorNode[] = [];
    const measurementId = `pulse_${crypto.randomUUID()}`;
    const voiceNoteId = `pulse_${crypto.randomUUID()}`;
    const recoveryPosition = position;
    const isCurrent = () => !disposed && mountedRef.current;

    function releaseCapture() {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
      stream?.getTracks().forEach((track) => {
        track.removeEventListener("ended", trackEnded);
        track.removeEventListener("mute", trackMuted);
        track.stop();
      });
      stream = null;
      source?.disconnect();
      source = null;
      if (meter) { meter.port.onmessage = null; meter.onprocessorerror = null; meter.disconnect(); meter.port.close(); meter = null; }
      for (const cue of cues) { try { cue.stop(); } catch { /* Already ended. */ } cue.disconnect(); }
      if (context) { context.onstatechange = null; void context.close().catch(() => {}); context = null; }
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        if (recorder.state !== "inactive") { try { recorder.stop(); } catch { /* Resources are still released below. */ } }
      }
      window.clearTimeout(stopTimeout);
      resolveStopped?.(false);
      resolveStopped = null;
      releaseCapture();
      chunks.length = 0;
      frames.length = 0;
    }

    function fail(message: string) {
      dispose();
      if (mountedRef.current) {
        sessionRef.current = null;
        setView({ ...INITIAL_VIEW, phase: "error", message });
      }
    }

    function visibilityChanged() {
      if (document.hidden) void finish("The app was hidden; the reading was interrupted. No BPM can be confirmed.");
    }
    function trackEnded() { void finish("The microphone disconnected; the reading was interrupted. No BPM can be confirmed."); }
    function trackMuted() { void finish("The microphone stopped delivering audio; the reading was interrupted. No BPM can be confirmed."); }

    async function finish(reason: string | null) {
      if (disposed || finishing) return;
      if (startedClock === null || !context || !recorder) {
        fail(reason ? `${reason} No recording was available; nothing was saved.` : "No recording was available; nothing was saved.");
        return;
      }
      finishing = true;
      endReason = reason;
      const endOffset = Math.max(0, Math.min(WINDOW_END, context.currentTime - startedClock));
      // An interruption during preparation has a zero-length window, not a future timestamp.
      const startOffset = Math.min(WINDOW_START, endOffset);
      if (isCurrent()) setView((previous) => ({ ...previous, phase: "finishing", pulse: false, message: "Microphone off. Finishing the local audio file…" }));
      const stopped = new Promise<boolean>((resolve) => {
        resolveStopped = resolve;
        if (stopResolved) { resolve(true); return; }
        stopTimeout = window.setTimeout(() => { resolveStopped = null; resolve(false); }, 4000);
      });
      try { if (recorder.state !== "inactive") recorder.stop(); }
      catch { endReason = "The audio recorder could not finish cleanly. No BPM can be confirmed."; }
      releaseCapture();
      const receivedStop = await stopped;
      window.clearTimeout(stopTimeout);
      if (!isCurrent()) return;
      if (!receivedStop || chunks.length === 0) {
        fail("The recorder did not provide a completed audio file. No reading or audio was saved. You can try again or skip.");
        return;
      }
      const audio = new Blob(chunks, { type: recorder.mimeType || chunks[0].type });
      if (!audio.size) { fail("The recording was empty. No reading or audio was saved."); return; }
      let estimate;
      try {
        estimate = analyzeSpokenPulse(frames, { windowStartSeconds: startOffset, windowEndSeconds: endOffset, interrupted: endReason !== null });
      } catch {
        endReason = "Sound analysis failed. You can keep the audio, but no BPM can be confirmed.";
        estimate = { beat_offsets_seconds: [], estimated_bpm: null, reason: endReason };
      }
      const startedAt = recordingUtc + startOffset * 1000;
      const delay = stoppedAtUtc === null ? NaN : (startedAt - Date.parse(stoppedAtUtc)) / 1000;
      const measurement: SpokenPulseMeasurement = {
        measurement_id: measurementId, voice_note_id: voiceNoteId,
        method: "palpated_spoken_beats",
        status: estimate.estimated_bpm !== null && !endReason ? "unconfirmed" : "insufficient_signal",
        started_at_utc: new Date(startedAt).toISOString(),
        ended_at_utc: new Date(recordingUtc + endOffset * 1000).toISOString(),
        duration_seconds: endOffset - startOffset,
        seconds_after_run_stop: Number.isFinite(delay) && delay >= 0 ? delay : null,
        recovery_position: recoveryPosition,
        recording_started_at_utc: new Date(recordingUtc).toISOString(),
        window_start_offset_seconds: startOffset,
        detected_beat_offsets_seconds: estimate.beat_offsets_seconds,
        estimated_bpm: endReason ? null : estimate.estimated_bpm,
        reason: endReason ?? estimate.reason,
      };
      dispose();
      sessionRef.current = null;
      setResult({ measurement, audio });
      setView({ phase: "result", elapsed: measurement.duration_seconds, count: measurement.detected_beat_offsets_seconds.length, pulse: false, message: measurement.estimated_bpm === null ? "No usable estimate. The audio is available below, but has not been saved." : "Experimental estimate — unconfirmed and not saved. Check the sounds before deciding." });
    }

    function cue(at: number) {
      if (!context) return;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 660;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.12, at + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.001, at + 0.065);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
      oscillator.start(at);
      oscillator.stop(at + 0.07);
      cues.push(oscillator);
    }

    async function acquire() {
      try {
        // Resume inside the explicit gesture, before the permission await (mobile browsers).
        context = new AudioContext();
        const resume = context.resume();
        // Attach a rejection handler immediately, while the permission prompt may remain open.
        const resumed = resume.then(() => true, () => false);
        const acquired = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
        if (!isCurrent()) { acquired.getTracks().forEach((track) => track.stop()); return; }
        stream = acquired;
        stream.getAudioTracks().forEach((track) => { track.addEventListener("ended", trackEnded); track.addEventListener("mute", trackMuted); });
        if (!await resumed || !context || context.state !== "running") throw new Error("AudioContext unavailable");
        await context.audioWorklet.addModule(new URL("./spoken-pulse-worklet.js", import.meta.url));
        if (!isCurrent() || !context) return;
        if (document.hidden || context.state !== "running" || stream.getAudioTracks().some((track) => track.readyState !== "live" || track.muted)) {
          fail("Audio capture was interrupted before recording began. Nothing was saved."); return;
        }
        meter = new AudioWorkletNode(context, "spoken-pulse-meter", { channelCount: 1, channelCountMode: "explicit", numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        source = context.createMediaStreamSource(stream);
        source.connect(meter);
        // The processor outputs silence: this connection keeps it alive without mic playback.
        meter.connect(context.destination);
        meter.onprocessorerror = () => { void finish("Audio analysis stopped unexpectedly. No BPM can be confirmed."); };
        const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"].find((type) => MediaRecorder.isTypeSupported(type));
        recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32000 });
        recorder.ondataavailable = (event) => { if (!disposed && event.data.size > 0) chunks.push(event.data); };
        recorder.onstop = () => {
          stopResolved = true;
          resolveStopped?.(true);
          resolveStopped = null;
          if (!finishing && !disposed) void finish("The audio recorder stopped unexpectedly. No BPM can be confirmed.");
        };
        recorder.onerror = () => {
          endReason = "The audio recorder reported an error. No BPM can be confirmed.";
          if (!finishing) void finish(endReason);
        };
        startedClock = context.currentTime;
        startedWallClock = performance.now();
        recordingUtc = Date.now();
        recorder.start(250);
        lastFrameClock = performance.now();
        meter.port.onmessage = (event: MessageEvent<{ frames: SpokenPulseFrame[] }>) => {
          if (!isCurrent() || finishing || startedClock === null || !Array.isArray(event.data?.frames)) return;
          lastFrameClock = performance.now();
          for (const frame of event.data.frames) {
            const relative = { ...frame, time_seconds: frame.time_seconds - startedClock };
            if (relative.time_seconds < 0 || relative.time_seconds >= WINDOW_END) continue;
            frames.push(relative);
            if (relative.time_seconds < WINDOW_START) continue;
            if (!detector) {
              const calibration = frames.filter((sample) => sample.time_seconds >= 0.4 && sample.time_seconds <= 2).map((sample) => sample.rms).sort((a, b) => a - b);
              detector = new SpokenBeatDetector(calibration.length ? calibration[Math.floor((calibration.length - 1) * 0.8)] : 0);
            }
            if (detector.push({ ...relative, time_seconds: relative.time_seconds - WINDOW_START })) lastPulseClock = performance.now();
          }
        };
        context.onstatechange = () => {
          if (context && context.state !== "running" && !finishing) void finish("Audio processing was suspended. No BPM can be confirmed.");
        };
        cue(startedClock + 2.5);
        cue(startedClock + WINDOW_END);
        setView({ ...INITIAL_VIEW, phase: "calibrating", message: "Stay quiet for the background check. After the short cue, begin when the screen says Go." });
        timer = window.setInterval(() => {
          if (!isCurrent() || finishing || !context || startedClock === null) return;
          const elapsed = context.currentTime - startedClock;
          const wallElapsed = (performance.now() - startedWallClock) / 1000;
          if (context.state !== "running" || Math.abs(wallElapsed - elapsed) > 0.75 || performance.now() - lastFrameClock > 1500) {
            void finish("Audio timing was interrupted. No BPM can be confirmed."); return;
          }
          if (elapsed >= WINDOW_END + 0.12) { void finish(null); return; }
          const measuring = elapsed >= WINDOW_START && elapsed < WINDOW_END;
          setView({ phase: elapsed < WINDOW_START ? "calibrating" : "capturing", elapsed: Math.min(30, Math.max(0, elapsed - WINDOW_START)), count: detector?.beatOffsetsSeconds.length ?? 0, pulse: measuring && performance.now() - lastPulseClock < 230, message: elapsed < 2 ? "Stay quiet: checking background noise." : elapsed < WINDOW_START ? "Get ready. Begin saying ‘ta’ when Go appears." : elapsed < WINDOW_END ? "Go — say one short ‘ta’ for each pulse you feel." : "Done — stop saying ‘ta’. Finishing audio…" });
        }, 100);
      } catch (error) {
        if (isCurrent()) {
          if (startedClock !== null && recorder?.state !== "inactive") void finish("Audio capture failed during the reading. No BPM can be confirmed.");
          else fail(microphoneError(error));
        }
      }
    }

    sessionRef.current = { dispose, finish: (reason) => { void finish(reason); } };
    document.addEventListener("visibilitychange", visibilityChanged);
    setView({ ...INITIAL_VIEW, phase: "starting", message: "Opening the microphone. Allow access to begin, or cancel." });
    if (document.hidden) { visibilityChanged(); return; }
    void acquire();
  }

  async function save(confirm: boolean) {
    if (!result || savingRef.current || (confirm && (!matched || result.measurement.estimated_bpm === null))) return;
    savingRef.current = true;
    setSaveError(null);
    setView((previous) => ({ ...previous, phase: "saving", message: "Saving audio and reading on this device…" }));
    const measurement: SpokenPulseMeasurement = confirm ? { ...result.measurement, status: "confirmed" } : {
      ...result.measurement,
      status: result.measurement.estimated_bpm === null ? "insufficient_signal" : "rejected",
      estimated_bpm: null,
      reason: result.measurement.estimated_bpm === null ? result.measurement.reason : "User kept the audio without confirming the experimental estimate.",
    };
    try {
      const saved = await onComplete(measurement, result.audio);
      if (!mountedRef.current) return;
      if (saved) {
        setResult({ measurement, audio: result.audio });
        setView((previous) => ({ ...previous, phase: "saved", message: "Audio and reading saved on this device." }));
      }
      else {
        setSaveError("Save did not complete. Your audio is still here. Retry saving or download it before leaving.");
        setView((previous) => ({ ...previous, phase: "result", message: "Not saved — the result is still available." }));
      }
    } catch {
      if (mountedRef.current) {
        setSaveError("Save failed. Your audio is still here. Retry saving or download it before leaving.");
        setView((previous) => ({ ...previous, phase: "result", message: "Not saved — the result is still available." }));
      }
    } finally { savingRef.current = false; }
  }

  function cancel() {
    if (savingRef.current) return;
    sessionRef.current?.dispose();
    sessionRef.current = null;
    onCancel();
  }

  const capturing = view.phase === "calibrating" || view.phase === "capturing";
  const saving = view.phase === "saving";
  const saved = view.phase === "saved";
  const preparing = view.phase === "ready" || view.phase === "error";
  const measurement = result?.measurement;
  return (
    <section className="spoken-pulse-screen" aria-labelledby="spoken-pulse-title">
      <header>
        <p className="eyebrow">Optional post-run reading</p>
        <h2 id="spoken-pulse-title">Speak your wrist pulse</h2>
        <p className="spoken-pulse-notice">Experimental sound-rate estimate, not direct heartbeat sensing or a medical measurement.</p>
      </header>
      {preparing && <>
      <ol className="spoken-pulse-instructions">
        <li>Be safely stationary if possible. Do not try this while running; skip if you feel unwell.</li>
        <li>Feel your wrist pulse with two fingers, not your thumb. Rest the phone close enough to hear you.</li>
        <li>Stay quiet for the 2-second background check. A short cue prepares you; start at <strong>Go</strong>.</li>
        <li>For 30 seconds, say one short <strong>“ta”</strong> for every beat you feel. Do not guess or follow a rhythm from the screen. Stop at the end cue.</li>
      </ol>
      <label className="spoken-pulse-position" htmlFor="spoken-pulse-position">Recovery position during this reading
        <select id="spoken-pulse-position" value={position} disabled={view.phase !== "ready" && view.phase !== "error"} onChange={(event) => setPosition(event.target.value as SpokenPulseMeasurement["recovery_position"])}>
          <option value="unknown">Not specified</option><option value="seated">Seated</option><option value="standing">Standing</option><option value="walking">Walking (prefer stopping safely first)</option>
        </select>
      </label>
      </>}
      {capturing && <p>Feel your wrist pulse. After Go, say one short <strong>“ta”</strong> for each beat until the end cue.</p>}
      <div className="spoken-pulse-status" role="status" aria-live="polite" aria-atomic="true"><p>{view.message}</p></div>
      {capturing && <div className="spoken-pulse-progress">
        <label htmlFor="spoken-pulse-progress">{view.elapsed.toFixed(0)} / 30 seconds</label>
        <progress id="spoken-pulse-progress" max={30} value={view.elapsed} />
        <div className="spoken-pulse-feedback"><span className={`spoken-pulse-marker${view.pulse ? " spoken-pulse-marker-active" : ""}`} aria-hidden="true" /><span>{view.count} detected sounds</span></div>
        <small>The marker follows detected sounds; it is not a metronome or a verified heartbeat counter.</small>
      </div>}
      {measurement && <div className="spoken-pulse-result">
        {measurement.estimated_bpm !== null ? <><span>Experimental estimate · {saved ? "saved" : "unconfirmed"}</span><strong>{Math.round(measurement.estimated_bpm)} <small>bpm</small></strong></> : <strong className="spoken-pulse-no-estimate">No usable BPM estimate</strong>}
        {measurement.reason && <p>{measurement.reason}</p>}
        <dl><div><dt>Detected sounds</dt><dd>{measurement.detected_beat_offsets_seconds.length}</dd></div><div><dt>Measurement window</dt><dd>{measurement.duration_seconds.toFixed(1)} seconds</dd></div><div><dt>Started after run stop</dt><dd>{measurement.seconds_after_run_stop === null ? "Unknown" : `${measurement.seconds_after_run_stop.toFixed(1)} seconds`}</dd></div><div><dt>Recovery position</dt><dd>{measurement.recovery_position}</dd></div></dl>
        <p className="spoken-pulse-hint">Window starts {measurement.window_start_offset_seconds.toFixed(1)} seconds into the recording. Replay to check the count. Confirm only if you made exactly one sound per felt beat and the detection matched.</p>
        {audioUrl && <><audio controls preload="metadata" src={audioUrl} aria-label="Replay spoken wrist-pulse recording" /><a className="spoken-pulse-download" href={audioUrl} download={`${measurement.voice_note_id}.${audioExtension(result!.audio.type)}`}>Download audio to this device</a></>}
        {!saved && measurement.estimated_bpm !== null && <label className="spoken-pulse-confirm"><input type="checkbox" checked={matched} disabled={saving} onChange={(event) => setMatched(event.target.checked)} /><span>I made one sound per beat and the detection matched.</span></label>}
      </div>}
      {saveError && <p className="spoken-pulse-error" role="alert">{saveError}</p>}
      <div className="spoken-pulse-actions">
        {(view.phase === "ready" || view.phase === "error") && <button type="button" className="spoken-pulse-primary" data-session-target="start-spoken-pulse" onClick={start}>Start 30-second reading</button>}
        {capturing && <button type="button" data-session-target="stop-spoken-pulse-early" onClick={() => sessionRef.current?.finish("You stopped the reading early. No BPM can be confirmed.")}>Stop early · keep audio for review</button>}
        {result && !saved && <>
          {measurement?.estimated_bpm !== null && <button type="button" className="spoken-pulse-primary" data-session-target="confirm-spoken-pulse" disabled={saving || !matched} onClick={() => { void save(true); }}>Confirm and save estimate + audio</button>}
          <button type="button" data-session-target="save-spoken-pulse-audio-only" disabled={saving} onClick={() => { void save(false); }}>Keep audio without a pulse estimate</button>
          <button type="button" disabled={saving} onClick={() => { setResult(null); setMatched(false); setSaveError(null); setView(INITIAL_VIEW); }}>Discard this unsaved attempt and try again</button>
        </>}
        <button type="button" className="spoken-pulse-skip" data-session-target="cancel-spoken-pulse" disabled={saving} onClick={cancel}>{saved ? "Done" : result ? "Discard unsaved attempt and close" : "Cancel / skip spoken pulse"}</button>
      </div>
      <p className="spoken-pulse-limitations">Missed or extra sounds, breathing, background noise and spoken timing can make this estimate wrong even when signal checks pass. This is not validated HRV or a diagnostic tool. Confirmation records your check, not medical accuracy. Nothing is saved until you choose a save option; saved audio can be included in your run’s coach sync.</p>
    </section>
  );
}
