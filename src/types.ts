export type Screen = "home" | "setup" | "recovery" | "live" | "stop" | "post" | "export";
export type RunStatus = "idle" | "armed" | "running" | "stopping" | "stopped" | "discarded";

export type PermissionStatusText = "unknown" | "ready" | "denied" | "unavailable";
export type WakeLockStatusText = "active" | "inactive" | "failed" | "unavailable";
export type WeatherStatusText = "will_fetch_after_gps" | "fetched" | "unavailable" | "fetching";

export type RouteDirection = "clockwise" | "counterclockwise" | "unknown";
export type PhonePosition = "waist_belt" | "shorts_pocket" | "armband" | "handheld" | "other" | "unknown";
export type SorenessLevel = "none" | "mild" | "moderate" | "severe" | "unknown";
export type YesNoUnsure = "yes" | "no" | "unsure" | "unknown";
export type RunMode =
  | "green_lake_5k_calibration"
  | "short_run_diagnostic"
  | "easy_run"
  | "recovery_run"
  | "instrumentation_validation"
  | "record_mode"
  | "training_calibration";
export type PrimaryLimiter =
  | "breathing"
  | "legs"
  | "heat"
  | "hills"
  | "pacing"
  | "motivation"
  | "time"
  | "other"
  | "unknown";
export type Interruption = "none" | "traffic" | "crowd" | "GPS issue" | "bathroom" | "other";
export type BreathingRecoveredAfter = "<1 min" | "1-3 min" | "3-5 min" | ">5 min" | "unknown";
export type SimpleEffort = "easy" | "moderate" | "hard" | "very_hard" | "max" | "not_sure" | "unknown";
export type Confidence = "low" | "medium" | "high";

export interface PainState {
  present: boolean;
  location: string | null;
  severity_1_to_10: number | null;
}

export interface PreRunState {
  runner_id: "user_001";
  goal: "sub_25_5k";
  route_name: string;
  mode: RunMode;
  active_patch_id: string;
  route_direction: RouteDirection;
  phone_position: PhonePosition;
  intended_distance_meters: number;
  energy_before_run_1_to_5: number | null;
  soreness_before_run: SorenessLevel;
  pain_before_run: PainState;
  free_text: string;
}

export interface PostRunState {
  rpe_1_to_10: number | null;
  rpe_estimation_source: "manual" | "simple_effort_fallback" | "not_answered";
  perceived_effort_simple: SimpleEffort;
  energy_after_run_1_to_5: number | null;
  soreness_after_run: SorenessLevel;
  pain_after_run: PainState;
  primary_limiter: PrimaryLimiter;
  started_too_fast: YesNoUnsure;
  final_third_harder_than_expected: YesNoUnsure;
  interruption: Interruption;
  immediate_pulse_bpm_manual: number | null;
  pulse_after_3_to_5_min_bpm_manual: number | null;
  breathing_recovered_after: BreathingRecoveredAfter;
  subjective_debrief_skipped: boolean;
  subjective_debrief_skip_reason: string | null;
  free_text: string;
}

export interface PermissionState {
  geolocation_available: boolean;
  geolocation_permission: PermissionStatusText;
  device_motion_available: boolean;
  device_motion_permission: PermissionStatusText;
  wake_lock_available: boolean;
  wake_lock_used: boolean;
  wake_lock_status: WakeLockStatusText;
  wake_lock_error_message: string | null;
  weather_status: WeatherStatusText;
}

export interface GpsPoint {
  t_elapsed_seconds: number;
  timestamp_utc: string;
  lat: number;
  lon: number;
  altitude_meters: number | null;
  altitude_accuracy_meters: number | null;
  speed_mps: number | null;
  heading_degrees: number | null;
  horizontal_accuracy_meters: number | null;
  accuracy_ok: boolean;
  speed_available: boolean;
  possible_gps_jump: boolean;
  segment_speed_mps?: number | null;
  segment_acceleration_mps2?: number | null;
  segment_grade_percent?: number | null;
  impossible_speed?: boolean;
  suspicious_speed?: boolean;
  suspicious_acceleration?: boolean;
  suspicious_grade?: boolean;
  tiny_dt_segment?: boolean;
}

export interface MotionWindow {
  window_start_elapsed_seconds: number;
  window_end_elapsed_seconds: number;
  sample_count: number;
  accel_x_mean: number | null;
  accel_y_mean: number | null;
  accel_z_mean: number | null;
  accel_magnitude_mean: number | null;
  accel_magnitude_std: number | null;
  accel_magnitude_max: number | null;
  accel_including_gravity_magnitude_mean: number | null;
  rotation_alpha_std: number | null;
  rotation_beta_std: number | null;
  rotation_gamma_std: number | null;
  estimated_motion_sample_rate_hz_optional: number | null;
  rotation_rate_magnitude_mean: number | null;
  rotation_rate_magnitude_std: number | null;
}

export interface WeatherSnapshot {
  source: "open_meteo";
  fetched_at_utc: string | null;
  latitude?: number | null;
  longitude?: number | null;
  temperature_f: number | null;
  relative_humidity_percent: number | null;
  apparent_temperature_f: number | null;
  precipitation_in: number | null;
  rain_in: number | null;
  weather_code: number | null;
  cloud_cover_percent: number | null;
  wind_speed_mph: number | null;
  wind_direction_degrees: number | null;
  wind_gusts_mph: number | null;
  fallback_source?: "finish_weather" | null;
  raw: unknown | null;
}

export interface WeatherState {
  start_weather: WeatherSnapshot;
  finish_weather: WeatherSnapshot;
}

export interface RunMetadata {
  run_id: string;
  start_time_local: string;
  start_time_utc: string;
  end_time_local: string | null;
  end_time_utc: string | null;
  timezone: string;
}

export interface Checkpoint {
  t_elapsed_seconds: number;
  timestamp_utc: string;
  label: string;
  distance_meters?: number;
}

export interface InRunNote {
  note_id: string;
  timestamp_utc: string;
  t_elapsed_seconds: number;
  distance_meters: number | null;
  lat: number | null;
  lon: number | null;
  note_type: "run_observation" | "app_feedback" | "route_note" | "other";
  tags: string[];
  text: string;
}

export interface TargetDistanceResult {
  intended_distance_meters: number;
  target_reached: boolean;
  elapsed_at_target_distance_seconds: number | null;
  pace_to_target_seconds_per_mile: number | null;
  pace_to_target_seconds_per_km: number | null;
  overshoot_meters: number | null;
  distance_recorded_meters: number | null;
}

export interface ActiveTargetDistanceResult {
  intended_distance_meters: number;
  target_reached: boolean;
  active_elapsed_at_target_distance_seconds: number | null;
  recording_elapsed_at_target_distance_seconds: number | null;
  active_pace_to_target_seconds_per_mile: number | null;
  active_pace_to_target_seconds_per_km: number | null;
  overshoot_meters: number | null;
  distance_recorded_meters: number | null;
  stop_time_seconds: number | null;
  time_after_target_seconds: number | null;
  distance_after_target_meters: number | null;
  target_distance_confidence: "unknown" | "low" | "medium" | "high";
  target_detection_method:
    | "active_cumulative_crossing"
    | "recording_target_minus_activity_start"
    | "recording_target_with_active_tolerance"
    | "not_reached";
  target_distance_tolerance_meters: number;
  diagnostic_note: string | null;
}

export interface LifecycleEvent {
  event: string;
  timestamp_utc: string;
  t_elapsed_seconds: number | null;
  message?: string;
  error_message?: string | null;
}

export interface WakeLockLifecycleEvent extends LifecycleEvent {
  status: WakeLockStatusText | "requested" | "released" | "reacquire_attempt";
}

export interface VisibilityLifecycleEvent extends LifecycleEvent {
  visibility_state?: DocumentVisibilityState;
}

export interface GpsStaleEvent extends LifecycleEvent {
  stale_seconds: number;
  last_gps_elapsed_seconds: number | null;
  threshold_seconds: number;
}

export interface RecordingLifecycle {
  wake_lock_events: WakeLockLifecycleEvent[];
  visibility_events: VisibilityLifecycleEvent[];
  pagehide_events: LifecycleEvent[];
  pageshow_events: LifecycleEvent[];
  gps_stale_events: GpsStaleEvent[];
}

export interface PreRunGpsWarmup {
  armed_at_utc: string | null;
  started_at_utc: string | null;
  warmup_duration_seconds: number | null;
  best_accuracy_meters: number | null;
  last_accuracy_before_start_meters: number | null;
}

export interface MotionDebug {
  request_status: "not_requested" | "requested" | "granted" | "denied" | "unavailable" | "failed";
  requested_at_utc: string | null;
  result_at_utc: string | null;
  first_event_at_utc: string | null;
  first_event_elapsed_seconds: number | null;
  sample_events_seen: number;
  no_samples_note_added: boolean;
}

export interface PwaState {
  display_mode_standalone: boolean;
  service_worker_controller: boolean;
  storage_persisted: boolean | null;
}

export interface GpsGapInterpolation {
  start_elapsed_seconds: number;
  end_elapsed_seconds: number;
  duration_seconds: number;
  last_point: Pick<GpsPoint, "t_elapsed_seconds" | "timestamp_utc" | "lat" | "lon" | "horizontal_accuracy_meters">;
  next_point: Pick<GpsPoint, "t_elapsed_seconds" | "timestamp_utc" | "lat" | "lon" | "horizontal_accuracy_meters">;
  straight_line_distance_meters: number;
  surrounding_speed_mps: number | null;
  speed_based_distance_estimate_meters: number | null;
  chosen_distance_estimate_meters: number;
  method: "straight_line" | "speed_based" | "route_based_placeholder";
  confidence: "low" | "medium" | "high";
}

export interface InterpolationFeatures {
  raw_recorded_distance_meters: number | null;
  interpolated_distance_estimate_meters: number | null;
  estimated_missing_distance_meters: number | null;
  missing_gps_time_seconds: number;
  interpolation_confidence: "low" | "medium" | "high";
  gaps: GpsGapInterpolation[];
}

export interface FinalizationDiagnostics {
  stop_clicked_at_utc: string | null;
  stopped_at_elapsed_seconds: number | null;
  gps_watch_cleared: boolean;
  motion_listener_removed: boolean;
  gps_stale_timers_cleared: boolean;
  finish_point_source: "last_valid_pre_stop_gps" | "none";
  stop_point: GpsPoint | null;
  post_stop_gps_callback_count: number;
  post_stop_gps_first_timestamp_utc: string | null;
  post_stop_gps_last_timestamp_utc: string | null;
  post_stop_gps_drift_meters: number | null;
  points_excluded_after_stop: number;
  analysis_point_count: number | null;
  raw_point_count: number | null;
  stored_analysis_point_count: number | null;
  post_stop_callback_count: number;
  total_callbacks_seen: number | null;
  post_stop_first_callback_classification:
    | "post_stop_callback"
    | "duplicate_stop_point"
    | "harmless_late_callback"
    | null;
  gps_callback_cleanup_status: "clean" | "callbacks_after_stop" | "failed";
  cleanup_failed: boolean;
}

export interface ActivityWindow {
  recording_start_elapsed_seconds: number;
  inferred_activity_start_elapsed_seconds: number | null;
  inferred_activity_start_confidence: "unknown" | "low" | "medium" | "high";
  idle_preamble_seconds: number | null;
  inferred_activity_end_elapsed_seconds: number | null;
  active_duration_seconds: number | null;
  active_distance_meters: number | null;
  analysis_basis: "recording_window" | "activity_window";
  detection_method: string | null;
  detection_notes: string[];
  excluded_intervals: Array<{
    start_elapsed_seconds: number;
    end_elapsed_seconds: number;
    duration_seconds: number;
    reason: "stationary_preamble" | "gps_warmup" | "app_background_gap" | "unknown";
  }>;
}

export interface AnalysisSegment {
  segment_id: string;
  start_distance_meters: number;
  end_distance_meters: number;
  start_recording_elapsed_seconds: number | null;
  end_recording_elapsed_seconds: number | null;
  start_active_elapsed_seconds: number | null;
  end_active_elapsed_seconds: number | null;
  duration_seconds: number | null;
  pace_seconds_per_mile: number | null;
  pace_seconds_per_km: number | null;
  elevation_gain_meters: number | null;
  elevation_loss_meters: number | null;
  avg_grade_percent: number | null;
  avg_horizontal_accuracy_meters: number | null;
  speed_p50_mps: number | null;
  speed_p95_mps: number | null;
  artifact_excluded_point_count: number;
  artifact_excluded_distance_meters: number;
  artifact_excluded_fraction: number;
  flags: string[];
}

export interface AnalysisSegments {
  fixed_distance_100m: AnalysisSegment[];
  fixed_distance_200m: AnalysisSegment[];
  fixed_distance_500m: AnalysisSegment[];
  fixed_time_30s: AnalysisSegment[];
  detected_events: Record<string, unknown>[];
  detected_loops: Record<string, unknown>[];
}

export interface InferredRunFacts {
  started_late: boolean | null;
  idle_preamble_seconds: number | null;
  route_id: string | null;
  route_direction: RouteDirection;
  target_reached: boolean | null;
  overshoot_meters: number | null;
  late_fade_detected: boolean | null;
  negative_split_detected: boolean | null;
  first_segment_faster_than_later: boolean | null;
  first_segment_slower_than_later: boolean | null;
  stop_or_slowdown_events: Record<string, unknown>[];
  slowdown_events: Record<string, unknown>[];
  probable_interruptions: Record<string, unknown>[];
  gps_gaps_during_active_window: GpsGapInterpolation[];
  off_route_events: Record<string, unknown>[];
  recording_backgrounded_during_active_window: boolean | null;
  route_direction_inferred: RouteDirection;
  loop_count_inferred: number | null;
  elevation_gain_loss_available: boolean | null;
  weather_context_available: boolean | null;
  motion_usable: boolean | null;
}

export interface TargetedFollowupPrompt {
  id: string;
  prompt: string;
  default_answer?: string;
  reason: string;
}

export interface GreenLakeCalibration {
  enabled: boolean;
  calibration_run_number: number;
  start_point: Pick<GpsPoint, "lat" | "lon" | "timestamp_utc" | "t_elapsed_seconds"> | null;
  finish_point: Pick<GpsPoint, "lat" | "lon" | "timestamp_utc" | "t_elapsed_seconds"> | null;
  route_direction_user_selected: RouteDirection;
  route_direction_inferred: RouteDirection;
  course_fingerprint: {
    bounding_box: Record<string, number | null> | null;
    polyline_simplified: Array<[number, number]> | null;
    distance_meters: number | null;
    start_finish_distance_meters: number | null;
  };
  known_route_match_score_0_to_1: number | null;
  course_saved_for_future_matching: boolean;
}

export interface ElevationGrounding {
  raw_gps_altitude_available: boolean;
  altitude_accuracy_available: boolean;
  raw_elevation_gain_meters: number | null;
  raw_elevation_loss_meters: number | null;
  smoothed_elevation_gain_meters: number | null;
  smoothed_elevation_loss_meters: number | null;
  smoothing_method: "median_or_rolling_lowpass";
  map_or_dem_elevation_available: false;
  map_or_dem_elevation_placeholder: null;
  chosen_elevation_model: "smoothed_gps" | "raw_gps" | "none";
  elevation_confidence: "low" | "medium" | "high";
  elevation_notes: string[];
}

export interface ArtifactModel {
  raw_segment_count: number | null;
  segments_used_for_distance: number | null;
  segments_excluded_impossible_speed: number | null;
  segments_excluded_gps_jump: number | null;
  segments_excluded_tiny_dt: number | null;
  segments_excluded_low_accuracy: number | null;
  rolling_speed_p95_mps: number | null;
  max_display_speed_mps: number | null;
  artifact_notes: string[];
}

export interface DataQualityScores {
  recording_reliability_overall: "low" | "medium" | "high";
  lifecycle_reliability: "low" | "medium" | "high";
  sensor_reliability: "low" | "medium" | "high";
  analysis_reliability: "low" | "medium" | "high";
  analysis_reliability_pace_distance: "low" | "medium" | "high";
  analysis_reliability_motion: "none" | "low" | "medium" | "high";
  analysis_reliability_elevation: "low" | "medium" | "high";
  active_window_reliability: "low" | "medium" | "high";
  target_distance_confidence: "low" | "medium" | "high";
  pace_confidence: "low" | "medium" | "high";
  distance_confidence: "low" | "medium" | "high";
  elevation_confidence: "low" | "medium" | "high";
  motion_confidence: "none" | "low" | "medium" | "high";
  green_lake_calibration_usable: boolean;
  usable_for_pacing_calibration: boolean;
  usable_for_fitness_baseline: boolean;
  usable_for_motion_analysis: boolean;
  usable_for_elevation_analysis: boolean;
  usable_for_short_pacing_calibration: boolean;
  usable_for_short_speed_reserve: boolean;
  reasons: string[];
}

export interface ActiveShortTargetResult {
  target_distance_meters: number | null;
  target_reached: boolean;
  active_elapsed_at_target_seconds: number | null;
  pace_seconds_per_km: number | null;
  pace_seconds_per_mile: number | null;
  confidence: "unknown" | Confidence;
  chosen_distance_basis: "route_snapped" | "active_gps" | "artifact_filtered_gps" | "raw_gps" | null;
  diagnostic_note: string | null;
}

export interface RouteSnappedShortSummary {
  enabled: boolean;
  route_id: string | null;
  route_snapped_distance_meters: number | null;
  route_snapped_duration_seconds: number | null;
  route_snapped_1500m_time_seconds: number | null;
  loop_length_meters: number | null;
  loop_count: number | null;
  loop_progress_meters: number | null;
  confidence: "unknown" | Confidence;
  notes: string[];
}

export interface RouteConfirmationPrompt {
  id: string;
  route_id: string;
  prompt: string;
  reason: string;
  eligible: boolean;
  default_answer: "yes" | "no";
}

export interface Usability {
  usable_for_pacing_calibration: boolean;
  usable_for_fitness_baseline: boolean;
  usable_for_short_run_diagnostic: boolean;
  usable_for_motion_analysis: boolean;
  usable_for_elevation_analysis: true | "low_confidence";
  usable_for_route_learning: boolean;
  usable_for_coach_update: boolean;
  reasons: string[];
}

export interface ShortRunDiagnostic {
  enabled: boolean;
  active_distance_meters: number | null;
  active_duration_seconds: number | null;
  active_pace_seconds_per_mile: number | null;
  estimated_1500m_time_seconds: number | null;
  estimated_1mile_time_seconds: number | null;
  fixed_500m_pattern: Array<{
    segment_id: string;
    distance_meters: number | null;
    duration_seconds: number | null;
    pace_seconds_per_mile: number | null;
  }>;
  pacing_pattern: "positive_split" | "even" | "negative_split" | "unknown";
  short_run_usable: boolean;
  confidence: "low" | "medium" | "high";
  limitations: string[];
}

export interface ActivePartialPacingFeatures {
  actual_distance_thirds: SplitFeature[];
  fixed_500m_trend: "fading" | "steady" | "speeding_up" | "unknown";
  first_500m_pace: number | null;
  second_500m_pace: number | null;
  final_partial_pace: number | null;
  early_fast_then_fade_detected: boolean | null;
  late_fade_seconds_per_mile: number | null;
  confidence: "low" | "medium" | "high";
}

export interface CoachReadySummary {
  run_type: string | null;
  chosen_distance_basis: string | null;
  active_time_seconds: number | null;
  target_time_seconds: number | null;
  pace_seconds_per_mile: number | null;
  baseline_green_lake_5k_time_seconds: number | null;
  baseline_green_lake_5k_pace_seconds_per_mile: number | null;
  pacing_pattern: "positive_split" | "even" | "negative_split" | "unknown";
  late_fade_seconds_per_mile: number | null;
  short_run_estimate_1500m_seconds: number | null;
  recommended_patch_id: string | null;
  subjective_cost_available: boolean;
  primary_limiter: PrimaryLimiter;
  pain_present: boolean;
  usable_for_runner_update: boolean;
  usable_for_next_strategy_update: boolean;
  next_best_test: string | null;
  short_run: {
    usable_for_runner_update: boolean;
    estimated_1500m_time_seconds: number | null;
    latest_estimated_1500m_time_seconds: number | null;
    prior_best_short_1500m_estimate_seconds: number | null;
    delta_vs_prior_best: number | null;
    speed_reserve_vs_sub25_5k_pace_seconds: number | null;
    recommended_next_short_test: string | null;
    comparison_to_prior_short_runs: string | null;
    comparison_to_green_lake_baseline_pace: string | null;
    interpretation: string | null;
    recommended_patch_id: string | null;
  };
}

export interface PatchExecutionAssessment {
  patch_id: string;
  intended_strategy: Record<string, string>;
  actual_splits: Array<{
    split_id: string;
    distance_meters: number | null;
    duration_seconds: number | null;
    pace_seconds_per_km: number | null;
    status: "too_fast" | "in_band" | "too_slow" | "not_applicable" | "unknown";
    target_band_seconds_per_km: {
      min: number | null;
      max: number | null;
    };
  }>;
  followed_patch: boolean | null;
  evaluated_as: "record_mode_result" | "controlled_start_calibration" | "not_evaluated";
  reason: string;
}

export interface RouteDirectionInference {
  user_selected: RouteDirection | null;
  inferred: RouteDirection;
  confidence: "unknown" | Confidence;
  method: "signed_winding_around_route_centroid" | "manual_override" | "insufficient_track";
  manual_override_used: boolean;
  signed_winding_radians: number | null;
}

export interface RunClassification {
  inferred_mode: RunMode | "free_run";
  inferred_route_type: "known_course" | "home_block_or_short_route" | "instrumentation_validation" | "free_run";
  route_id: string | null;
  route_confidence: "unknown" | Confidence;
  mode_confidence: "unknown" | Confidence;
  reasons: string[];
  manual_overrides: string[];
}

export interface TargetInference {
  target_distance_meters: number | null;
  source: "inferred_from_route_and_patch" | "inferred_from_route" | "inferred_from_patch" | "manual_override" | "none";
  confidence: "unknown" | Confidence;
  manual_override_used: boolean;
}

export interface RouteSnapping {
  enabled: boolean;
  route_id: string | null;
  route_prior_strength: "none" | Confidence;
  raw_gps_distance_meters: number | null;
  artifact_filtered_gps_distance_meters: number | null;
  snapped_distance_meters: number | null;
  distance_basis: "raw_gps" | "artifact_filtered_gps" | "route_snapped";
  median_projection_error_meters: number | null;
  p90_projection_error_meters: number | null;
  max_projection_error_meters: number | null;
  projection_error_by_segment: Array<{
    segment_id: string;
    start_distance_meters: number;
    end_distance_meters: number;
    median_projection_error_meters: number | null;
    p90_projection_error_meters: number | null;
    max_projection_error_meters: number | null;
  }>;
  off_route_event_count: number;
  route_progress_meters: number | null;
  loop_count: number | null;
  confidence: "unknown" | Confidence;
  notes: string[];
}

export interface MeasurementReconciliation {
  distance_estimates: {
    raw_gps: number | null;
    artifact_filtered_gps: number | null;
    route_snapped: number | null;
    provider_speed_integral: number | null;
    external_app: number | null;
  };
  time_estimates: {
    recording_elapsed: number | null;
    active_elapsed: number | null;
    external_app: number | null;
  };
  chosen_basis: "route_snapped" | "active_gps" | "artifact_filtered_gps" | "raw_gps";
  confidence: "unknown" | Confidence;
  notes: string[];
}

export interface ExternalObservation {
  source: string;
  reported_time_seconds: number | null;
  reported_distance_meters: number | null;
  notes: string;
}

export interface SubjectiveDebrief {
  effort_label: SimpleEffort;
  rpe_estimated: number | null;
  rpe_source: "effort_label_mapping" | "manual" | "not_answered";
  pain_present: boolean;
  pain_location: string | null;
  pain_severity_1_to_10: number | null;
  primary_limiter: PrimaryLimiter;
  free_text: string;
}

export interface UxPromptPolicy {
  max_pre_run_required_inputs: number;
  max_post_run_required_inputs: number;
  max_adaptive_followups: number;
  allow_skip_all_subjective: boolean;
  skip_requires_reason: boolean;
}

export interface CurrentPatch {
  patch_id: string;
  mission: string;
  status: "active" | "inactive";
  evaluation_window: string;
  strategy: Record<string, string>;
}

export interface RouteLibrary {
  routes: Array<{
    route_id: string;
    type: "known_course" | "sidewalk_loop" | "free_run";
    polyline: Array<[number, number]>;
    distance_meters: number | null;
    loop_length_meters: number | null;
    start_zones: Record<string, unknown>[];
    finish_zones: Record<string, unknown>[];
    aliases: string[];
    calibration_status: "learned" | "needs_user_confirmation" | "confirmed";
    created_from_run_id: string | null;
    confidence: Confidence;
  }>;
}

export interface GroundedDebriefContext {
  objective_facts: string[];
  subjective_inputs: string[];
  conflicts_or_tensions: string[];
  suggested_followup_questions: string[];
  coach_safe_summary: {
    usable_for_fitness_update: boolean;
    usable_for_pacing_update: boolean;
    usable_for_app_debug: boolean;
    primary_data_limitations: string[];
  };
}

export interface ActiveRun {
  status: RunStatus;
  run_metadata: RunMetadata;
  pre_run: PreRunState;
  post_run: PostRunState;
  permissions: PermissionState;
  weather: WeatherState;
  gps_points: GpsPoint[];
  motion_windows: MotionWindow[];
  checkpoints: Checkpoint[];
  in_run_notes: InRunNote[];
  data_quality_notes: string[];
  recording_lifecycle: RecordingLifecycle;
  pre_run_gps_warmup: PreRunGpsWarmup;
  motion_debug: MotionDebug;
  pwa_state: PwaState;
  finalization: FinalizationDiagnostics;
  elapsed_offset_seconds: number;
  last_saved_at_utc: string;
}

export interface SplitFeature {
  name?: string;
  index?: number;
  distance_meters: number | null;
  duration_seconds: number | null;
  pace_seconds_per_mile: number | null;
  elevation_gain_meters: number | null;
  elevation_loss_meters: number | null;
  avg_horizontal_accuracy_meters: number | null;
}

export interface ExportPayload {
  schema_version: "0.1.20";
  app: {
    name: "Green Lake AutoResearch Logger";
    version: "0.1.20";
    platform: "web";
    user_agent: string;
    created_at_utc: string;
  };
  runner: {
    runner_id: "user_001";
    goal: {
      type: "race_time";
      description: "Run a sub-25 5K";
      target_distance_meters: 5000;
      target_time_seconds: 1500;
      target_pace_seconds_per_mile: 483.0;
    };
  };
  training_state_before_run: {
    mode: PreRunState["mode"];
    active_patch_id: string;
    active_patch_description: string;
    current_thesis: string;
  };
  pre_run: Record<string, unknown>;
  run_metadata: Record<string, unknown>;
  permissions_and_capabilities: Record<string, unknown>;
  recording_lifecycle: RecordingLifecycle & {
    missing_gps_time_seconds: number;
    gps_stale_event_count: number;
    recording_reliability: "high" | "medium" | "low";
  };
  pre_run_gps_warmup: PreRunGpsWarmup;
  finalization: FinalizationDiagnostics;
  activity_window: ActivityWindow;
  weather: WeatherState;
  summary: Record<string, unknown>;
  active_summary: Record<string, unknown>;
  gps_quality: Record<string, unknown>;
  interpolation_features: InterpolationFeatures;
  splits: {
    miles: SplitFeature[];
    kilometers: SplitFeature[];
    thirds: SplitFeature[];
  };
  target_distance_result: TargetDistanceResult;
  target_distance_splits: {
    miles: SplitFeature[];
    kilometers: SplitFeature[];
    thirds: SplitFeature[];
  };
  active_target_distance_result: ActiveTargetDistanceResult;
  active_short_target_result: ActiveShortTargetResult;
  active_target_distance_splits: {
    miles: SplitFeature[];
    kilometers: SplitFeature[];
    thirds: SplitFeature[];
    fixed_100m: SplitFeature[];
    fixed_200m: SplitFeature[];
    fixed_500m: SplitFeature[];
  };
  pacing_features: Record<string, unknown>;
  active_partial_pacing_features: ActivePartialPacingFeatures;
  elevation_features: Record<string, unknown>;
  elevation_grounding: ElevationGrounding;
  motion_features: Record<string, unknown>;
  route_features: Record<string, unknown>;
  route_direction: RouteDirectionInference;
  run_classification: RunClassification;
  target_inference: TargetInference;
  route_library: RouteLibrary;
  route_snapping: RouteSnapping;
  route_snapped_summary: RouteSnappedShortSummary;
  route_snapped_splits: {
    fixed_100m: SplitFeature[];
    fixed_200m: SplitFeature[];
    fixed_500m: SplitFeature[];
  };
  measurement_reconciliation: MeasurementReconciliation;
  external_observations: ExternalObservation[];
  inferred_run_facts: InferredRunFacts;
  targeted_followup_prompts: TargetedFollowupPrompt[];
  route_confirmation_prompt: RouteConfirmationPrompt | null;
  analysis_segments: AnalysisSegments;
  green_lake_calibration: GreenLakeCalibration;
  short_run_diagnostic: ShortRunDiagnostic;
  artifact_model: ArtifactModel;
  data_quality_scores: DataQualityScores;
  usability: Usability;
  subjective_debrief: SubjectiveDebrief;
  ux_prompt_policy: UxPromptPolicy;
  current_patch: CurrentPatch;
  grounded_debrief_context: GroundedDebriefContext;
  coach_ready_summary: CoachReadySummary;
  patch_execution_assessment: PatchExecutionAssessment;
  time_series: {
    gps_points: GpsPoint[];
    analysis_points: GpsPoint[];
    downsampled_points_5s: GpsPoint[];
  };
  post_run: Record<string, unknown>;
  data_quality_notes: string[];
  checkpoints: Checkpoint[];
  in_run_notes: InRunNote[];
}
