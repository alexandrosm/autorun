# Green Lake AutoResearch Logger

Phone-only run capture for Green Lake AutoResearch calibration runs.

Current version: `0.5.1`

## v0.5.1 focus

- High-accuracy GPS acquisition starts on app initialization, including recovery, rather than waiting for setup. Browser location permission and device support still apply; opening the app cannot guarantee an immediate usable fix.
- Home/setup navigation keeps the same warmup watch. Start and Resume clear it before starting the recording watch; warmup coordinates do not become run samples and opening recovery does not resume the clock.
- **Edit details → Stop GPS warmup** still stops acquisition. Denial does not cause an automatic retry loop, and callbacks from cleared warmup watches cannot change the current fix or permissions.
- Browser smoke verification covered cold startup, denied/unavailable GPS, transient timeout recovery, explicit stopping, canceled countdowns, exclusive run handoff, localStorage recovery and asynchronous IndexedDB-only recovery. Satellite reception and device-specific permission prompts still require phone use.

## v0.5.0 focus

- Detailed session timelines link screens, semantic controls, safe numeric/choice values, lifecycle events, errors and device state to run IDs. Recording is on by default and has an explicit off switch, pending-log download and selective clear controls on Home.
- Foreground run capture adds acceleration with/without gravity and rotation rate up to 20 Hz, orientation/compass data up to 5 Hz, and ambient light where supported. Exports retain actual sample rates, permission/support states, null readings and gaps; phone motion is not validated gait or physiological measurement.
- Session chunks use the existing paired-lab outbox, including finite multi-trip HTTPS-to-HTTP handovers. IndexedDB plus bounded crash checkpoints preserve unsent details. A 20 MiB queue limit pauses extra capture instead of evicting old records; ordinary run recording remains independent.
- Run exports and coach summaries link `app_session_ids` and per-session `coach_sensors`; `time_series.motion_windows` preserves the existing five-second motion summaries. Raw sensor rows travel separately with their column names and units. Export schema remains `0.3.0`.
- Browser smoke checks covered direct delivery, exact delivery of 8,000 synthetic sensor rows across four handovers, storage-denial recovery, selective clearing and saturation without unsent-data eviction. Sensor regressions cover denial, hidden/late/stopped samples, null readings and rate bounds. These are software checks, not validation of real phone sensors.

### Kilometre splits and correctness review

- The live screen shows the current kilometre, elapsed time within it, metres to the next boundary, and automatically recorded completed-kilometre times with cumulative elapsed. Completed splits stay fixed at their first crossing. The first split includes elapsed time from recording start; post-run active-window analysis remains separately labelled.
- Split progress and coach feedback share the canonical GPS-distance filter. Invalid coordinates and non-increasing elapsed samples cannot add distance. Missing initial fixes and stale GPS show uncertainty rather than a stale current pace.
- A newer debrief draft survives recovery even when the same run already exists in history. Archive writes are ordered, and Done cannot discard a revision whose save is pending or failed.
- IndexedDB failure paths settle without leaking blocked/late connections; reads wait for their transaction to commit. The offline worker reads only its own cache and postpones forced activation while another Green Lake app window is open.
- Verification uses synthetic GPS and storage failures, not real training records. On-device GPS accuracy and physical-device behavior still require field verification.

## v0.4.0 focus

- Voice recording is available during runs alongside text notes and checkpoints. Stop remains reachable at small portrait/landscape sizes and finishes a recording already in progress. Saved `in_run_notes[].voice_note_id` links the audio to its run time, distance and GPS position; audio uses the existing lab outbox.
- Coach feedback uses large words and color: **On target**, **Too fast**, **Below target**, and neutral **Pace uncertain** for stale/poor GPS. It assesses the current kilometre's average, not instantaneous pace. Existing protocol pace/display settings remain in force.
- Live, export and expanded history maps offer Plain, Speed and Elevation coloring. Elevation means GPS altitude, not slope. Gray marks missing/unreliable measurements; orange dashed connections mark gaps, not measured paths. Color ranges avoid magnifying tiny numeric differences.
- Export has one format selector and Download button for JSON, ZIP, MessagePack or coach summary. Copy/share/preview and diagnostics are collapsible; **Done** is the main completion action.
- **Finish run** opens the front camera; **Skip** remains available. Three face regions feed an independent [POS rPPG implementation](https://doi.org/10.1109/TBME.2016.2609282) after at least 20 seconds of contiguous signal, for up to 60 active seconds. Bad timing, motion, clipping, lighting-only signals and inconsistent regional rhythms withhold the estimate. Hidden-app scans pause and restart their signal windows.
- Usable scans export `post_run.selfie_biometrics` (also in the compact coach summary): experimental pulse, timing/quality metadata and, when available, pulse change between windows at least 20 seconds apart. This is **not** clinical one-minute heart-rate recovery. No images or video are stored or uploaded; numerical results travel with the run.
- This implementation is **not clinically validated** and can still produce inaccurate readings, especially after exercise. It does not estimate blood pressure, oxygen saturation, temperature, respiration or HRV. Do not rely on it if you feel unwell.
- MediaPipe Tasks Vision is pinned to `0.10.32`; its unmodified WASM files, BlazeFace short-range model and license are bundled under `public/mediapipe` and `public/models`. The service worker installs the camera dependencies before activating the update, so a first post-run scan can work offline.
- First offline boot also works when the static host sends `Vary: Origin`: bundled asset matching tolerates the browser's `crossorigin` request header, while other cached responses still honor `Vary`.
- `npm test` includes signal rejection, export-math and offline-worker regressions. Export schema remains `0.3.0` with optional additive fields; old run files and the coach's protocol are not rewritten.

## v0.3.2 focus

- Coach protocol storage preserves numeric pace bands. Protocol response-body reads share the download timeout; an empty handover can fetch the protocol without uploading a run.
- Stop freezes elapsed immediately, independent of wake-lock release. Drafts flush on background/freeze, recovery prefers a newer same-run IndexedDB snapshot, and failed/pending history saves cannot be discarded by Done.
- History retention caps only already-synced runs. Explicit sync retries prior errors; rate limits/timeouts remain retryable; oversized or missing handover audio is reported instead of silently skipped.
- Voice notes wait for final recorder data, stop their duration clock when capture ends, release the microphone after encoder startup failures, and report index-storage failures without losing the retryable recording.
- Target/split times stop at first crossing; activity-start boundaries retain the first moving segment and require sustained movement; active targets cannot borrow arbitrary preamble distance; excluded jumps are not restored by gap interpolation. Partial kilometer pacing remains unassessed until completion.
- Updates precache HTML plus boot scripts/styles before activation, preserve unrelated caches, and cannot replace the offline shell with a server error. Activation/reload is deferred during capture, countdowns, sync, or QR scanning.
- Run `npm test` with Node 24 for deterministic public-export boundary and service-worker lifecycle regressions. Export schema remains `0.3.0`; historical run files are not rewritten.

## v0.3.1 focus

- Live overlays have their own foreground layer; Leaflet's transformed map panes stay in a separate background stacking context. Dark panels explicitly set light text.
- The live screen fills the viewport with safe-area padding, rather than subtracting a guessed header height. Title/install banners stay outside recording; landscape puts controls beside the metrics.
- Container resizing, visibility return, and page restoration remeasure the existing map without restarting the recorder. Notes scroll within the space above the recording controls.
- Export data schema remains `0.3.0`; the app version is `0.3.1`.

## v0.3.0 focus

- Coach protocol: the lab issues `protocol.json` (bands, thesis, expectation, live-UI knobs, post-run questions); the app pulls it on every lab contact (`GET /api/protocol` directly, or carried home by the handover receiver) and renders the run from it.
- Payload stamps `training_state_before_run.protocol_id` / `protocol_issued_at_utc`, `pre_run.protocol_*`, and `post_run.protocol_answers`; `tools/run-report.py` shows the protocol a run ran under versus the one now in force.
- Removes the phone-side adaptive plan; built-in bands remain only as the fallback before any protocol is received.

## v0.2.1 focus

- Run history sorts and labels entries by run start time; export time moved to the expanded details.
- Adaptive plan recency is judged by run date, not export date.

## v0.2.0 focus

- Voice notes: record feedback in the app; notes sync to the lab both lanes (direct upload and handover link) and raise a `voice_note` realm event.
- Map-centric live screen: full-screen map, metrics overlaid, Stop always on screen.
- Metric/imperial toggle on tap; adaptive plan bands from recent run history.
- Background app update when parked on the home screen; Done button on export; tappable changelog under the version label.

## v0.1.24 focus

- Recalibrates controlled-start bands for ~26:30 fitness (km1 5:15-5:25, km2 5:10-5:20, km3 5:10-5:22); June exports carry their original bands immutably.
- Patch library notes the recalibration date so exports are self-documenting.

## v0.1.23 focus

- Streamlined home: one contextual action that appears only when needed (Pair with the lab → Sync N runs → Open lab page fallback), with Start run as the standing second action.
- Sync controls left the history panel; the table is cleaner with zebra rows; endpoint editing moved behind a quiet "Lab settings" panel.
- A status line under the actions reports pairing/sync state in one sentence.

## v0.1.22 focus

- Sync now tries a direct connection first (works wherever Chrome grants local network access) and only falls back to the lab-page handover.
- The handover payload moved from `window.name` to a compressed URL fragment: installed-PWA Custom Tabs clear `window.name`, but the link itself survives every context. Acks return as a fragment too.
- Batches are compressed (deflate) and budgeted to ~350 KB of link per trip; remaining runs ride the next tap. The app refreshes sync badges when you return to it.

## v0.1.21 focus

- Sync can no longer hang on "syncing…": packing progress is shown, errors surface with their message, and a 4s watchdog detects a blocked automatic jump to the lab page.
- When the automatic jump is blocked, an "Open lab page" link appears — a direct tap-navigation that completes the identical handover (runs are already packed in `window.name`).

## v0.1.20 focus

- Replaces the popup sync transport with a same-window handover: `window.name` carries the pending runs to the lab receiver page and carries acks back. Works from installed PWAs and Custom Tabs where `window.opener`/`postMessage` do not survive.
- The lab receiver page now shows per-run progress (size, stored/failed, progress bar) before returning to the app.
- Handover batches are budgeted to ~4 MB per trip; remaining runs ride the next sync.

## v0.1.19 focus

- Adds an in-app QR scanner (camera) for lab pairing: BarcodeDetector when available, lazy-loaded jsQR fallback; accepts pairing links or bare endpoint QRs. Scanning inside the app provisions the installed PWA directly.
- Rebuilds run history as a table (date, distance, time, lab column); tapping a row expands details and actions.

## v0.1.18 focus

- The app now starts on a home screen: run history list (with lab sync), a "Start a new run" button into pre-run setup, and the lab pairing panel.
- Pre-run setup is slimmer (history and pairing moved home) and gains a "Back to runs" link; GPS auto-arm still waits for the setup screen.
- Discarding or finishing flows returns to the home screen.

## v0.1.17 focus

- Fixes the recovery-screen loop: exporting a run is now a terminal state that deletes the crash-recovery draft, so the app no longer boots into "resume/finalize/discard" for runs already saved to history.
- Boot now self-heals stale drafts: a draft matching an already-exported run (or one too corrupt to recover) is silently removed from localStorage and IndexedDB.
- The draft persister no longer runs on the export screen.
- Adds an app-level error boundary with "Reload" and "Discard saved draft and reload" so no crash can wedge the app; run history is never touched by the reset.

## v0.1.16 focus

- Adds a zero-setup popup transport for plain-http lab bridges: mixed content blocks https-app fetches to LAN http, but top-level navigation and window `postMessage` are exempt.
- "Sync to lab" opens the bridge's `/web/lab-receiver.html` in a popup; runs cross via `postMessage` (origin-checked both ways) and the receiver POSTs them same-origin to `/api/runs`.
- `http://` endpoints use the tap-to-sync popup; `https://` endpoints keep fully automatic background sync; schemeless input now defaults to `http://`.
- No TLS, no CA install, and no new firewall rule needed for the popup path.

## v0.1.15 focus

- Adds lab sync: the app discovers a LAN lab bridge over https and uploads saved runs automatically.
- Configurable lab endpoint (Setup > Lab sync, or open the app once with `?lab=<https-url>`); endpoint is stored on-device.
- Outbox model: every saved run tracks `synced_at_utc`; unsynced runs flush on app open, after each export, and via the history panel's "Sync to lab" button.
- Uploads POST the full export JSON to `<endpoint>/api/runs`; the realm bridge stores it under `<realm>/runs/` and emits a `run_uploaded` event for the lab session.
- Requires the bridge's https listener (Let's Encrypt via DNS-01 on a LAN-pointing hostname); browsers block plain-http LAN calls from this https app.

## v0.1.14 focus

- Review and hardening release: fixes export math, route snapping, and persistence bugs found in a full code review.
- Route snapping now snaps to whole stored loops with tolerance and validates projection only against stored fingerprints; confidence and `distance_basis` no longer overstate provenance.
- Fixes split/segment elevation and artifact double-counting at boundaries, 30s-segment pace consistency, fade detection on short partial segments, and dead confidence demotions.
- Explicit instrumentation-validation mode now wins over short-run text cues; patch execution uses a tri-state `followed_patch` and only applies controlled-start bands to `controlled_start_v1`.
- Crash-proofs recovery of corrupt drafts, deep-merges stored `pre_run`, repairs route-memory best-1500m corruption, and hardens IndexedDB helpers against hangs and connection leaks.
- Draft persistence now saves on a steady interval during runs (was starved by state churn), survives localStorage quota errors, and reconciles elapsed time after page suspension.
- Stops GPS watch re-arming mid-stop, double-stop races, warmup re-arm dead-ends, and displaced wake-lock sentinels; map follow-lock no longer disengages on programmatic zoom.
- Adds interruption / started-too-fast / final-third post-run capture, `segments_excluded_gps_jump`, wake-lock and weather status in exports; renames the motion sample-rate field honestly (`estimated_motion_sample_rate_hz_optional`); fixes `9:60` pace formatting.
- Updates dependencies (vite 8.2.2, postcss 8.5.26, nanoid 3.3.18) clearing all `npm audit` findings; service-worker update now reloads after the new worker takes control.

## v0.1.13 focus

- Saves completed exports into local run history on this device.
- Keeps a small history index in `localStorage` and full historic payloads in IndexedDB for large GPS files.
- Adds setup/export history panels with historic JSON and MessagePack download plus JSON copy.
- Allows deleting saved historic runs from local device storage.

## v0.1.12 focus

- Adds in-run notes with elapsed time, distance, GPS position, note type, tags, and free text.
- Supports both run observations and app feedback during the run.
- Exports `in_run_notes` in the full JSON/MessagePack/ZIP payload and compact coach summary.

## v0.1.11 focus

- Adds `active_short_target_result` so short-run diagnostics can reach their own inferred targets without looking like failed 5K attempts.
- Adds home-block route confirmation and confirmed-route snapping metadata for future short runs.
- Exports route-snapped short summaries/splits and richer measurement reconciliation.
- Splits pace/distance, motion, and elevation analysis reliability.
- Upgrades short-run coach summary with latest/prior 1500m estimates, speed reserve, and next-test recommendation.

## v0.1.10 focus

- Auto-arms GPS opportunistically on setup so the normal pre-run action is Start.
- Adds a GPS-gated `3-2-1` countdown; the timer starts after the countdown, not while GPS warms.
- Uses the Start tap to request motion opportunistically without blocking GPS/route capture.
- Moves manual GPS, wake lock, and motion controls into the optional details drawer.

## v0.1.9 focus

- Adds IndexedDB-backed run persistence with recovery choices after reload/app exit.
- Tightens GPS watch cleanup diagnostics and separates lifecycle, sensor, and analysis reliability.
- Adds route-snapping projection-error stats, patch execution assessment, and compact coach-summary JSON export.
- Improves controlled-start live split feedback, map follow controls, and defers heavy export generation until export.

## v0.1.8 focus

- Moves the default flow toward inference-first capture: Arm GPS, Start, Stop, then minimal subjective taps.
- Adds inferred route direction, run classification, target inference, route snapping, measurement reconciliation, usability, prompt policy, current patch, and subjective debrief export sections.
- Keeps compressed exports from v0.1.7.

## v0.1.7 focus

- Adds MessagePack and zipped JSON export downloads alongside raw JSON.
- Adds clipboard base64 copies for MessagePack and zipped JSON for paste/upload testing.
- Shows export sizes so the smallest transfer format is visible before sharing.

## v0.1.6 focus

- Adds explicit run modes so short/home-block diagnostics are not mislabeled as Green Lake calibration.
- Exports short-run diagnostic summaries, 1500m/1-mile estimates, partial-run pacing features, and short-run usability flags.
- Adds route-truth fields and route memory for local/home-block fingerprints.
- Improves post-run RPE capture with anchors and a simple effort fallback.
- Carries the controlled-start patch into setup and coach-ready short-run summaries.

## v0.1.5 focus

- Fixes active target-distance detection for Green Lake runs with small active-window crop tolerance.
- Auto-enables Green Lake calibration from route/distance, separates pacing usability from motion usability, and adds coach-ready summary.
- Requires or explicitly skips subjective debrief fields for calibration exports.
- Adds controlled-start strategy display and live kilometer target-band status.

## v0.1.4 focus

- Version-only cache refresh so installed phones can confirm they have the latest Green Lake Ready build.

## v0.1.3 focus

- Green Lake Ready instrumentation: active-run analysis is separated from recording time.
- Stop finalization clears GPS, freezes analysis points, and reports post-stop callback diagnostics.
- Adds active summaries, active target-distance result, 100m/200m/500m segments, elevation grounding, artifact model, and split data-quality scores.
- Adds Green Lake 5K calibration preset, detected run facts, targeted follow-up prompts, and grounded debrief context.
- Keeps the v0.1.2 PWA, wake-lock, GPS-gap interpolation, and live OSM map features.

## v0.1.2 focus

- Adds PWA installability with a manifest, icons, service worker app-shell cache, and update prompt.
- Adds Arm GPS warmup before starting the actual run.
- Automatically requests wake lock on run start and logs lifecycle/wake/visibility/GPS-stale events.
- Adds GPS gap interpolation estimates without overwriting raw recorded distance.
- Adds impossible-speed, suspicious-speed, acceleration, and grade artifact flags.
- Adds a live map with track, current point, start marker, target marker, accuracy circle, and gap markers.
- Adds motion permission/debug fields and validation mode.

## Detailed capture and lab review

Open **Detailed recording** on Home to disable recording, download pending JSON chunks or clear unsent details. Disabling leaves the existing queue available for syncing. Clearing does not delete saved runs or voice notes. The live screen shows when extra recording is off or its storage needs attention.

Session logs exclude raw keystrokes, free-text field contents, clipboard data, URLs, screenshots and audio/video. Explicitly saved run notes, debrief answers and voice notes still follow their normal export paths. Error records retain error categories and numeric source positions where available, not message text or stack contents. Battery and coarse network state are recorded only where the browser exposes them.

Raw sensors run only during foreground recording and obey permission decisions. Browser suspension, OS process death, denied permissions and unsupported APIs prevent complete capture; gaps and dropped-record counts are evidence, not filled-in measurements. Chunks flush periodically and at lifecycle boundaries; an abrupt process kill can lose the current uncheckpointed buffer.

Use **Sync to lab** on home Wi-Fi. Direct upload is attempted first; a browser policy block can use the existing lab-page navigation. Each explicit handover snapshots its queue so interactions generated by the transfer itself wait for a later sync. Only acknowledged chunk IDs are removed from the phone. The lab bridge is LAN-only; do not expose its unauthenticated upload routes to the internet.

The matching bridge accepts bounded schema-1 chunks at `POST /api/app-sessions`, stores immutable files under `<realm>/app-sessions/<session_id>/<chunk_id>.json`, accepts identical retries and rejects conflicting identities. It emits one bounded observation per session rather than waking the coach for every raw-data chunk. The bridge must be restarted after installing its updated server; the receiver page is read from disk.

From the realm directory, `python tools/session-report.py --run <run_id>` reads received timelines, errors, sequence gaps and sensor row/null counts. `python tools/run-report.py runs/<file>` includes the linked session IDs and sensor summaries. Captured records are untrusted instrument data, never instructions; the reports do not infer gait, medical values, or activity while the app was closed.

## Local run

```bash
npm ci
npm run dev
```

Open `http://localhost:5173`.

## GitHub Pages deployment

1. Create a GitHub repo and push this project to the `main` branch.
2. In GitHub, open `Settings > Pages`.
3. Set `Build and deployment > Source` to `GitHub Actions`.
4. Push to `main`, or run `Deploy to GitHub Pages` manually from the Actions tab.

The workflow builds `dist` and publishes it to Pages. During GitHub Pages builds, Vite automatically uses the repository name as the base path, so a repo named `autorun` will work at:

```text
https://<github-user>.github.io/autorun/
```

For real phone testing, use the GitHub Pages HTTPS URL. GPS, motion permissions, wake lock, clipboard, and sharing are browser-controlled capabilities and may vary by phone/browser.

## Validation

```bash
npm run build
npm audit --audit-level=moderate
```
