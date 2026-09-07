import test from "node:test";
import assert from "node:assert/strict";
import { buildExportPayload, computeLiveStats, haversineMeters } from "../src/runMath.ts";

const epoch = Date.UTC(2026, 0, 1);
const timestamp = (seconds) => new Date(epoch + seconds * 1000).toISOString();
const pain = () => ({ present: false, location: null, severity_1_to_10: null });
const weather = () => ({
  source: "open_meteo", fetched_at_utc: null, temperature_f: null,
  relative_humidity_percent: null, apparent_temperature_f: null,
  precipitation_in: null, rain_in: null, weather_code: null,
  cloud_cover_percent: null, wind_speed_mph: null, wind_direction_degrees: null,
  wind_gusts_mph: null, raw: null,
});

// Straight equatorial tracks with explicit optional segment flags; no saved runs.
function gps(rows) {
  return rows.map(([seconds, meters, overrides = {}], index) => ({
    t_elapsed_seconds: seconds, timestamp_utc: timestamp(seconds),
    lat: 0, lon: meters / 6371000 * 180 / Math.PI,
    altitude_meters: null, altitude_accuracy_meters: null,
    horizontal_accuracy_meters: 5, accuracy_ok: true,
    speed_mps: null, speed_available: false, heading_degrees: null,
    segment_speed_mps: index === 0 ? null : (meters - rows[index - 1][1]) / (seconds - rows[index - 1][0]),
    possible_gps_jump: false, ...overrides,
  }));
}

function exportRun(points, preRun = {}) {
  const end = points.at(-1)?.t_elapsed_seconds ?? 0;
  return buildExportPayload({
    status: "stopped",
    run_metadata: {
      run_id: "synthetic-math-boundary", start_time_local: timestamp(0), start_time_utc: timestamp(0),
      end_time_local: timestamp(end), end_time_utc: timestamp(end), timezone: "UTC",
    },
    pre_run: {
      runner_id: "user_001", goal: "sub_25_5k", route_name: "Synthetic route",
      mode: "record_mode", active_patch_id: "none", route_direction: "unknown",
      phone_position: "unknown", intended_distance_meters: 5000,
      energy_before_run_1_to_5: null, soreness_before_run: "unknown",
      pain_before_run: pain(), free_text: "", ...preRun,
    },
    post_run: {
      rpe_1_to_10: null, rpe_estimation_source: "not_answered", perceived_effort_simple: "unknown",
      energy_after_run_1_to_5: null, soreness_after_run: "unknown", pain_after_run: pain(),
      primary_limiter: "unknown", started_too_fast: "unknown", final_third_harder_than_expected: "unknown",
      interruption: "none", immediate_pulse_bpm_manual: null, pulse_after_3_to_5_min_bpm_manual: null,
      breathing_recovered_after: "unknown", subjective_debrief_skipped: true,
      subjective_debrief_skip_reason: null, free_text: "", protocol_answers: {},
    },
    permissions: {
      geolocation_available: true, geolocation_permission: "ready",
      device_motion_available: false, device_motion_permission: "unavailable",
      wake_lock_available: false, wake_lock_used: false, wake_lock_status: "unavailable",
      wake_lock_error_message: null, weather_status: "unavailable",
    },
    weather: { start_weather: weather(), finish_weather: weather() },
    gps_points: points, motion_windows: [], checkpoints: [], in_run_notes: [], data_quality_notes: [],
    recording_lifecycle: { wake_lock_events: [], visibility_events: [], pagehide_events: [], pageshow_events: [], gps_stale_events: [] },
    pre_run_gps_warmup: { armed_at_utc: null, started_at_utc: timestamp(0), warmup_duration_seconds: null, best_accuracy_meters: null, last_accuracy_before_start_meters: null },
    motion_debug: { request_status: "unavailable", requested_at_utc: null, result_at_utc: null, first_event_at_utc: null, first_event_elapsed_seconds: null, sample_events_seen: 0, no_samples_note_added: false },
    pwa_state: { display_mode_standalone: false, service_worker_controller: false, storage_persisted: null },
    finalization: {
      stop_clicked_at_utc: timestamp(end), stopped_at_elapsed_seconds: end,
      gps_watch_cleared: true, motion_listener_removed: true, gps_stale_timers_cleared: true,
      finish_point_source: points.length ? "last_valid_pre_stop_gps" : "none", stop_point: points.at(-1) ?? null,
      post_stop_gps_callback_count: 0, post_stop_gps_first_timestamp_utc: null, post_stop_gps_last_timestamp_utc: null,
      post_stop_gps_drift_meters: null, points_excluded_after_stop: 0, analysis_point_count: points.length,
      raw_point_count: points.length, stored_analysis_point_count: points.length, post_stop_callback_count: 0,
      total_callbacks_seen: points.length, post_stop_first_callback_classification: null,
      gps_callback_cleanup_status: "clean", cleanup_failed: false,
    },
    elapsed_offset_seconds: end, last_saved_at_utc: timestamp(end),
  }, timestamp(end));
}

test("target and final distance split finish at first arrival, not trailing stationary samples", () => {
  const points = gps([[0, 0], [300, 1000], [330, 1000], [360, 1000, { impossible_speed: true }]]);
  const payload = exportRun(points, { intended_distance_meters: haversineMeters(points[0], points[1]) });
  assert.equal(payload.target_distance_result.elapsed_at_target_distance_seconds, 300);
  assert.equal(payload.splits.kilometers[0].duration_seconds, 300);
  assert.equal(payload.summary.duration_seconds, 360);
  const interior = exportRun(gps([[0, 0], [300.03, 1000.1], [330.03, 1000.1], [630.06, 2000.2]]));
  assert.deepEqual(interior.splits.kilometers.slice(0, 2).map(split => split.duration_seconds), [300, 330]);
});

test("recording target cannot complete a substantially shorter active track", () => {
  const payload = exportRun(gps([[0, 0], [100, 100], [110, 100], [120, 130], [600, 1500]]), { intended_distance_meters: 1450 });
  assert.equal(payload.activity_window.inferred_activity_start_elapsed_seconds, 110);
  assert.equal(payload.target_distance_result.target_reached, true);
  assert.equal(payload.active_summary.distance_meters, 1400);
  assert.equal(payload.active_target_distance_result.target_reached, false);
  assert.equal(payload.active_target_distance_result.active_elapsed_at_target_distance_seconds, null);
  assert.equal(payload.active_target_distance_result.active_pace_to_target_seconds_per_km, null);
  const tolerance = exportRun(gps([[0, 0], [3, 3], [10, 3], [20, 33], [510, 1500]]), { intended_distance_meters: 1499 });
  assert.equal(tolerance.active_target_distance_result.target_reached, true);
  assert.equal(tolerance.active_target_distance_result.target_detection_method, "recording_target_with_active_tolerance");
});

test("interpolation does not restore rejected GPS jumps, but retains supported speed estimates", () => {
  const rejected = gps([[0, 0], [10, 1000, { impossible_speed: true }]]);
  const payload = exportRun(rejected);
  assert.equal(computeLiveStats(rejected, 10).distanceMeters, 0);
  assert.equal(payload.interpolation_features.raw_recorded_distance_meters, 0);
  assert.equal(payload.interpolation_features.interpolated_distance_estimate_meters, 0);
  assert.equal(payload.interpolation_features.gaps[0].straight_line_distance_meters, 1000);
  assert.equal(payload.interpolation_features.missing_gps_time_seconds, 10);
  const supported = exportRun(gps([[0, 0], [1, 3], [11, 1003, { impossible_speed: true }], [12, 1006]]));
  assert.equal(supported.interpolation_features.interpolated_distance_estimate_meters, 36);
  assert.equal(supported.interpolation_features.gaps[0].chosen_distance_estimate_meters, 30);
  const flagged = exportRun(gps([[0, 0, { possible_gps_jump: true, segment_speed_mps: 3 }], [10, 1000, { impossible_speed: true }]]));
  assert.equal(flagged.interpolation_features.interpolated_distance_estimate_meters, 0);
});

test("displacement fallback keeps the first moving segment", () => {
  const payload = exportRun(gps([[0, 0], [10, 15], [20, 30], [30, 45]]));
  assert.equal(payload.activity_window.inferred_activity_start_elapsed_seconds, 0);
  assert.equal(payload.active_summary.distance_meters, 45);
  assert.equal(payload.active_summary.duration_seconds, 30);
});

test("sustained activity start cannot bridge an interruption below its speed threshold", () => {
  const payload = exportRun(gps([[0, 0], [4, 12], [8, 16], [12, 28], [16, 40]]));
  assert.equal(payload.activity_window.inferred_activity_start_elapsed_seconds, 8);
  assert.equal(payload.activity_window.inferred_activity_start_confidence, "high");
  assert.equal(payload.active_summary.distance_meters, 24);
});

test("partial opening kilometer cannot establish successful patch execution", () => {
  const preRun = {
    mode: "green_lake_5k_calibration", active_patch_id: "controlled_start_v1",
    plan_bands: [{ km: 1, label: "Opening", minSecondsPerKm: 310, maxSecondsPerKm: 330, text: "5:10-5:30" }],
  };
  const partial = exportRun(gps([[0, 0], [160, 500]]), preRun).patch_execution_assessment;
  assert.equal(partial.actual_splits[0].pace_seconds_per_km, 320);
  assert.equal(partial.actual_splits[0].status, "unknown");
  assert.equal(partial.followed_patch, null);
  const complete = exportRun(gps([[0, 0], [320.032, 1000.1]]), preRun).patch_execution_assessment;
  assert.equal(complete.actual_splits[0].status, "in_band");
  assert.equal(complete.followed_patch, true);
});
