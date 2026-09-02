export interface ChangelogEntry {
  version: string;
  notes: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
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
