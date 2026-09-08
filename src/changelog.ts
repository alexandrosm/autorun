export interface ChangelogEntry {
  version: string;
  notes: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.5.0",
    notes: [
      "Detailed session timelines link screen changes, named controls, safe choices, errors and device state to your runs. No raw typing, clipboard contents or screenshots are captured.",
      "During runs, record phone acceleration and rotation up to 20 Hz, orientation up to 5 Hz, and ambient light where supported. Permission denials, gaps and actual sample rates remain explicit.",
      "Session details use the existing lab sync. Large transfers continue through a finite set of lab-page trips; acknowledged chunks leave the phone.",
      "Turn extra recording off, download pending details or clear them from Home. The bounded queue pauses capture instead of evicting unsent records; saved runs and voice notes are unaffected.",
      "See the current kilometre, metres remaining, and each completed kilometre's split and total time while running.",
      "Invalid GPS samples no longer inflate distance. No-fix and stale-GPS states withhold current pace.",
      "Edited debriefs remain recoverable after a previous export; Done waits for the current revision to save.",
      "Storage failures and blocked database opens are handled safely. Updates wait while another app window is open, and offline caches stay isolated.",
    ],
  },
  {
    version: "0.4.0",
    notes: [
      "Record voice notes during a run. Notes keep their time, distance and GPS context; Stop stays reachable and saves audio already being recorded.",
      "Large, color-coded On target / Too fast / Below target feedback follows the coach's kilometre pace band. Stale or poor GPS shows Pace uncertain instead.",
      "Color live, exported and saved routes by speed or GPS altitude. Missing or unreliable values stay gray; recording gaps are dashed and marked.",
      "Exports use one format selector and one Download button. Copy, share, previews and diagnostics are tucked away; Done comes first.",
      "Finish run opens an optional front-camera pulse scan. An experimental estimate and pulse change are saved only from usable signals; images never leave the device.",
      "Camera assets are bundled for offline use after the update finishes. Camera pulse is not medical measurement: motion, lighting and camera processing can prevent or distort a reading.",
    ],
  },
  {
    version: "0.3.2",
    notes: [
      "Coach pace limits now survive saving and reopening the app; protocol downloads also time out if the response body stalls.",
      "Stop no longer waits on wake-lock release. Recovery uses the newest draft, suspension flushes the authoritative clock, and failed exports stay recoverable.",
      "Unsynced runs are never removed by the history limit. Failed and oversized uploads can be retried explicitly, including voice notes.",
      "Voice recording handles unavailable encoders, final audio chunks, interrupted durations, and storage failures without claiming a failed save succeeded.",
      "Target/split timing uses the first crossing; rejected GPS jumps stay excluded; partial kilometers cannot prove a pacing patch was followed.",
      "Updates cache a complete offline app before activation and wait for recording, countdowns, voice capture, and QR scanning to finish.",
    ],
  },
  {
    version: "0.3.1",
    notes: [
      "Live overlays and map tiles now occupy separate layers, with explicit light text on the dark panels.",
      "Recording uses the whole viewport: no title or install banner pushes Stop offscreen, including in landscape.",
      "The map remeasures itself after resizing or returning to the browser, without restarting recording.",
      "In-run notes scroll separately from Stop and the other recording controls.",
    ],
  },
  {
    version: "0.3.0",
    notes: [
      "The coach now runs the experiment: bands, pre-run expectation, live display, and post-run questions arrive as a protocol from the lab.",
      "Every export is stamped with the protocol it ran under, so results are judged against the plan that was actually in force.",
      "Protocol arrives on any lab contact — direct, via the handover link, or the moment you pair.",
      "Live screen fixed: legible HUD, map controls reachable, elapsed no longer freezes under motion sampling, km 1 measured from when you start moving.",
      "Sync fixed: off-WiFi taps no longer hang on a dead page; stuck uploads time out; items the lab rejects are marked instead of retried forever.",
      "Voice notes: mic released on every path; a note survives the phone taking the microphone; synced audio is freed from the phone.",
      "Replaces the phone-side adaptive plan heuristic.",
    ],
  },
  {
    version: "0.2.1",
    notes: [
      "Run history shows and sorts by when you ran, not when the export was created.",
      "Expanded run details show the export time separately.",
    ],
  },
  {
    version: "0.2.0",
    notes: [
      "Voice notes: record feedback in the app; notes sync to the lab with your runs.",
      "Map-centric running screen with metrics overlaid and Stop always in reach.",
      "Tap any distance or pace to switch between metric and imperial.",
      "Run plan adapts to your recent runs; live bands follow the plan.",
      "App updates itself in the background when you're safely on the home screen.",
      "Done button on the export screen returns straight home.",
      "This changelog, behind a tap on the version label.",
    ],
  },
  {
    version: "0.1.24",
    notes: ["Controlled-start bands recalibrated for ~26:30 fitness (was tuned for a ~28min runner)."],
  },
  {
    version: "0.1.23",
    notes: ["Streamlined home: contextual pair/sync action, Start run, quiet settings."],
  },
  {
    version: "0.1.22",
    notes: [
      "Sync tries a direct connection first, then hands runs over inside a compressed link.",
      "Fixes sync from the installed app (Custom Tabs cleared the old handover channel).",
    ],
  },
  {
    version: "0.1.21",
    notes: ["Sync watchdog: no more silent hangs; an Open-lab-page fallback appears when blocked."],
  },
  {
    version: "0.1.20",
    notes: ["Lab receiver page shows per-run progress while storing."],
  },
  {
    version: "0.1.19",
    notes: ["In-app QR scanner for pairing; run history became a proper table."],
  },
  {
    version: "0.1.18",
    notes: ["New home screen: run list, Start a new run, lab pairing."],
  },
  {
    version: "0.1.17",
    notes: ["Fixed the recovery-screen loop; exporting now clears the crash draft; added an error boundary."],
  },
  {
    version: "0.1.16",
    notes: ["Popup handover for plain-http labs (superseded in 0.1.22)."],
  },
  {
    version: "0.1.15",
    notes: ["Lab sync: outbox, endpoint pairing, auto-upload."],
  },
  {
    version: "0.1.14",
    notes: ["Review and hardening release: export math, route snapping, persistence, and recovery fixes."],
  },
];
