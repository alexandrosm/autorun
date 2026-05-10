# Green Lake AutoResearch Logger

Phone-only run capture for Green Lake AutoResearch calibration runs.

Current version: `0.1.2`

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
