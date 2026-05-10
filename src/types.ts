export type Screen = "setup" | "live" | "stop" | "post" | "export";

export type PermissionStatusText = "unknown" | "ready" | "denied" | "unavailable";
export type WakeLockStatusText = "active" | "inactive" | "failed" | "unavailable";
export type WeatherStatusText = "will_fetch_after_gps" | "fetched" | "unavailable" | "fetching";

export type RouteDirection = "clockwise" | "counterclockwise" | "unknown";
export type PhonePosition = "waist_belt" | "shorts_pocket" | "armband" | "handheld" | "other" | "unknown";
export type SorenessLevel = "none" | "mild" | "moderate" | "severe" | "unknown";
export type YesNoUnsure = "yes" | "no" | "unsure" | "unknown";
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

export interface PainState {
  present: boolean;
  location: string | null;
  severity_1_to_10: number | null;
}

export interface PreRunState {
  runner_id: "user_001";
  goal: "sub_25_5k";
  route_name: string;
  mode: "training_calibration";
  active_patch_id: "baseline_calibration_v1";
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
  estimated_motion_frequency_hz_optional: number | null;
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

export interface TargetDistanceResult {
  intended_distance_meters: number;
  target_reached: boolean;
  elapsed_at_target_distance_seconds: number | null;
  pace_to_target_seconds_per_mile: number | null;
  pace_to_target_seconds_per_km: number | null;
  overshoot_meters: number | null;
  distance_recorded_meters: number | null;
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

export interface ActiveRun {
  run_metadata: RunMetadata;
  pre_run: PreRunState;
  post_run: PostRunState;
  permissions: PermissionState;
  weather: WeatherState;
  gps_points: GpsPoint[];
  motion_windows: MotionWindow[];
  checkpoints: Checkpoint[];
  data_quality_notes: string[];
  recording_lifecycle: RecordingLifecycle;
  pre_run_gps_warmup: PreRunGpsWarmup;
  motion_debug: MotionDebug;
  pwa_state: PwaState;
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
  schema_version: "0.1.2";
  app: {
    name: "Green Lake AutoResearch Logger";
    version: "0.1.2";
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
    mode: "training_calibration";
    active_patch_id: "baseline_calibration_v1";
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
  weather: WeatherState;
  summary: Record<string, unknown>;
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
  pacing_features: Record<string, unknown>;
  elevation_features: Record<string, unknown>;
  motion_features: Record<string, unknown>;
  route_features: Record<string, unknown>;
  time_series: {
    gps_points: GpsPoint[];
    downsampled_points_5s: GpsPoint[];
  };
  post_run: Record<string, unknown>;
  data_quality_notes: string[];
  checkpoints?: Checkpoint[];
}
