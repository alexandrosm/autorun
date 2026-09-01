# Green Lake AutoResearch Logger

Phone-only run capture for Green Lake AutoResearch calibration runs.

Current version: `0.1.24`

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
