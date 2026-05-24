# Green Lake AutoResearch Logger

Phone-only run capture for Green Lake AutoResearch calibration runs.

Current version: `0.1.6`

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
