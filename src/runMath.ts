import type {
  ActiveRun,
  ActivePartialPacingFeatures,
  ActiveShortTargetResult,
  ActiveTargetDistanceResult,
  ActivityWindow,
  AnalysisSegment,
  AnalysisSegments,
  ArtifactModel,
  CoachReadySummary,
  CurrentPatch,
  DataQualityScores,
  ElevationGrounding,
  ExportPayload,
  FinalizationDiagnostics,
  GpsPoint,
  GpsGapInterpolation,
  GreenLakeCalibration,
  GroundedDebriefContext,
  InferredRunFacts,
  InterpolationFeatures,
  MeasurementReconciliation,
  MotionWindow,
  PatchExecutionAssessment,
  PermissionState,
  PostRunState,
  PreRunState,
  RecordingLifecycle,
  RouteDirection,
  RouteDirectionInference,
  RouteLibrary,
  RouteConfirmationPrompt,
  RouteSnappedShortSummary,
  RouteSnapping,
  RunClassification,
  RunMode,
  ShortRunDiagnostic,
  SplitFeature,
  SubjectiveDebrief,
  TargetedFollowupPrompt,
  TargetDistanceResult,
  TargetInference,
  Usability,
} from "./types";

const METERS_PER_MILE = 1609.344;
const METERS_PER_KM = 1000;
const POOR_ACCURACY_THRESHOLD_METERS = 25;
const STOPPED_SPEED_THRESHOLD_MPS = 0.5;
const SUSPICIOUS_SPEED_MPS = 7;
const IMPOSSIBLE_SPEED_MPS = 8;
const SUSPICIOUS_ACCELERATION_MPS2 = 4;
const SUSPICIOUS_GRADE_PERCENT = 20;
const TARGET_DISTANCE_TOLERANCE_METERS = 5;
const SEGMENT_ARTIFACT_FRACTION_THRESHOLD = 0.1;
const ROUTE_MEMORY_KEY_FOR_MATH = "greenlake_autoresearch_logger_route_memory_v0_1";
const CONTROLLED_START_BANDS_FOR_MATH = [
  { minSecondsPerKm: 335, maxSecondsPerKm: 340 },
  { minSecondsPerKm: 335, maxSecondsPerKm: 345 },
  { minSecondsPerKm: 340, maxSecondsPerKm: 350 },
  { minSecondsPerKm: null, maxSecondsPerKm: null },
  { minSecondsPerKm: null, maxSecondsPerKm: null },
] as const;

const PATCH_LIBRARY: Record<string, { description: string; thesis: string }> = {
  baseline_calibration_v1: {
    description: "Establish repeatable Green Lake baseline and identify first limiter.",
    thesis: "Unknown: distinguish pacing discipline, late-run durability, fatigue, weather sensitivity, and route execution.",
  },
  controlled_start_v1: {
    description: "Reduce late fade by starting controlled and aiming for steadier kilometer splits.",
    thesis: "Speed access exists; sustainable 5K pace and controlled opening effort are the current limiter.",
  },
  controlled_start_v2: {
    description: "Green Lake controlled-start patch with flatter first kilometer and less late fade.",
    thesis: "Validate whether disciplined opening pace preserves enough durability to improve the final third.",
  },
  extend_sustainable_pace_v1: {
    description: "Extend short-run sustainable pace with a controlled-fast 2000m diagnostic.",
    thesis: "Short speed reserve exists; the next diagnostic should test how far controlled-fast pace can extend.",
  },
};

interface TrackPoint extends GpsPoint {
  cumulative_meters: number;
}

interface TrackStateAtDistance {
  elapsed: number;
  altitude: number | null;
  accuracy: number | null;
}

export function haversineMeters(a: Pick<GpsPoint, "lat" | "lon">, b: Pick<GpsPoint, "lat" | "lon">): number {
  const earthRadiusMeters = 6371000;
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const deltaLat = toRadians(b.lat - a.lat);
  const deltaLon = toRadians(b.lon - a.lon);
  const sinLat = Math.sin(deltaLat / 2);
  const sinLon = Math.sin(deltaLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function createGpsPointFromPosition(
  position: GeolocationPosition,
  elapsedSeconds: number,
  previousPoint: GpsPoint | null,
): GpsPoint {
  const coords = position.coords;
  const timestamp = Number.isFinite(position.timestamp) ? position.timestamp : Date.now();
  const pointBase = {
    t_elapsed_seconds: round(elapsedSeconds, 3),
    timestamp_utc: new Date(timestamp).toISOString(),
    lat: coords.latitude,
    lon: coords.longitude,
    altitude_meters: nullableNumber(coords.altitude),
    altitude_accuracy_meters: nullableNumber(coords.altitudeAccuracy),
    speed_mps: nullableNumber(coords.speed),
    heading_degrees: nullableNumber(coords.heading),
    horizontal_accuracy_meters: nullableNumber(coords.accuracy),
    accuracy_ok: nullableNumber(coords.accuracy) !== null ? coords.accuracy <= POOR_ACCURACY_THRESHOLD_METERS : false,
    speed_available: nullableNumber(coords.speed) !== null,
  };

  let possibleGpsJump = false;
  let segmentSpeed: number | null = null;
  let segmentAcceleration: number | null = null;
  let segmentGrade: number | null = null;
  if (previousPoint) {
    const dt = elapsedSeconds - previousPoint.t_elapsed_seconds;
    if (dt > 0) {
      const segmentMeters = haversineMeters(previousPoint, pointBase);
      segmentSpeed = segmentMeters / dt;
      const previousSpeed = previousPoint.segment_speed_mps ?? previousPoint.speed_mps;
      if (dt >= 0.5 && previousSpeed !== null && previousSpeed !== undefined && Number.isFinite(previousSpeed)) {
        segmentAcceleration = (segmentSpeed - previousSpeed) / dt;
      }
      if (
        previousPoint.altitude_meters !== null &&
        pointBase.altitude_meters !== null &&
        segmentMeters >= 5
      ) {
        segmentGrade = ((pointBase.altitude_meters - previousPoint.altitude_meters) / segmentMeters) * 100;
      }
      possibleGpsJump =
        segmentMeters > 35 &&
        segmentSpeed > 8.5 &&
        (pointBase.horizontal_accuracy_meters === null || pointBase.horizontal_accuracy_meters > 15);
    }
  }

  return {
    ...pointBase,
    possible_gps_jump: possibleGpsJump,
    segment_speed_mps: segmentSpeed === null ? null : round(segmentSpeed, 3),
    segment_acceleration_mps2: segmentAcceleration === null ? null : round(segmentAcceleration, 3),
    segment_grade_percent: segmentGrade === null ? null : round(segmentGrade, 2),
    impossible_speed: segmentSpeed !== null && segmentSpeed > IMPOSSIBLE_SPEED_MPS,
    suspicious_speed: segmentSpeed !== null && segmentSpeed > SUSPICIOUS_SPEED_MPS,
    suspicious_acceleration:
      segmentAcceleration !== null && Math.abs(segmentAcceleration) > SUSPICIOUS_ACCELERATION_MPS2,
    suspicious_grade: segmentGrade !== null && Math.abs(segmentGrade) > SUSPICIOUS_GRADE_PERCENT,
    tiny_dt_segment:
      previousPoint !== null && elapsedSeconds - previousPoint.t_elapsed_seconds > 0 && elapsedSeconds - previousPoint.t_elapsed_seconds < 0.5,
  };
}

export function buildExportPayload(run: ActiveRun, createdAtUtc = new Date().toISOString()): ExportPayload {
  const features = computeFeatures(run);
  const weatherFetchSuccess = Boolean(run.weather.start_weather.fetched_at_utc || run.weather.finish_weather.fetched_at_utc);
  const notes = uniqueStrings([...run.data_quality_notes, ...features.dataQualityNotes]);

  return {
    schema_version: "0.1.16",
    app: {
      name: "Green Lake AutoResearch Logger",
      version: "0.1.16",
      platform: "web",
      user_agent: navigator.userAgent,
      created_at_utc: createdAtUtc,
    },
    runner: {
      runner_id: "user_001",
      goal: {
        type: "race_time",
        description: "Run a sub-25 5K",
        target_distance_meters: 5000,
        target_time_seconds: 1500,
        target_pace_seconds_per_mile: 483.0,
      },
    },
    training_state_before_run: {
      mode: run.pre_run.mode,
      active_patch_id: run.pre_run.active_patch_id,
      active_patch_description: patchDescription(run.pre_run.active_patch_id),
      current_thesis: patchThesis(run.pre_run.active_patch_id),
    },
    pre_run: exportPreRun(run.pre_run),
    run_metadata: {
      run_id: run.run_metadata.run_id,
      start_time_local: run.run_metadata.start_time_local,
      start_time_utc: run.run_metadata.start_time_utc,
      end_time_local: run.run_metadata.end_time_local,
      end_time_utc: run.run_metadata.end_time_utc,
      timezone: run.run_metadata.timezone,
    },
    permissions_and_capabilities: exportPermissions(run.permissions, weatherFetchSuccess, run.pwa_state),
    recording_lifecycle: {
      ...run.recording_lifecycle,
      missing_gps_time_seconds: features.interpolation.missing_gps_time_seconds,
      gps_stale_event_count: run.recording_lifecycle.gps_stale_events.length,
      recording_reliability: features.recordingReliability,
    },
    pre_run_gps_warmup: run.pre_run_gps_warmup,
    finalization: features.finalization,
    activity_window: features.activityWindow,
    weather: run.weather,
    summary: features.summary,
    active_summary: features.activeSummary,
    gps_quality: features.gpsQuality,
    interpolation_features: features.interpolation,
    splits: features.splits,
    target_distance_result: features.targetDistanceResult,
    target_distance_splits: features.targetDistanceSplits,
    active_target_distance_result: features.activeTargetDistanceResult,
    active_short_target_result: features.activeShortTargetResult,
    active_target_distance_splits: features.activeTargetDistanceSplits,
    pacing_features: features.pacing,
    active_partial_pacing_features: features.activePartialPacing,
    elevation_features: features.elevation,
    elevation_grounding: features.elevationGrounding,
    motion_features: features.motion,
    route_features: features.route,
    route_direction: features.routeDirection,
    run_classification: features.runClassification,
    target_inference: features.targetInference,
    route_library: features.routeLibrary,
    route_snapping: features.routeSnapping,
    route_snapped_summary: features.routeSnappedSummary,
    route_snapped_splits: features.routeSnappedSplits,
    measurement_reconciliation: features.measurementReconciliation,
    external_observations: [],
    inferred_run_facts: features.inferredRunFacts,
    targeted_followup_prompts: features.targetedFollowupPrompts,
    route_confirmation_prompt: features.routeConfirmationPrompt,
    analysis_segments: features.analysisSegments,
    green_lake_calibration: features.greenLakeCalibration,
    short_run_diagnostic: features.shortRunDiagnostic,
    artifact_model: features.artifactModel,
    data_quality_scores: features.dataQualityScores,
    usability: features.usability,
    subjective_debrief: buildSubjectiveDebrief(run.post_run),
    ux_prompt_policy: buildUxPromptPolicy(),
    current_patch: buildCurrentPatch(run.pre_run.active_patch_id),
    grounded_debrief_context: features.groundedDebriefContext,
    coach_ready_summary: features.coachReadySummary,
    patch_execution_assessment: features.patchExecutionAssessment,
    time_series: {
      gps_points: run.gps_points,
      analysis_points: features.analysisPoints,
      downsampled_points_5s: downsampleGps(features.analysisPoints, 5),
    },
    post_run: exportPostRun(run.post_run),
    data_quality_notes: notes,
    checkpoints: run.checkpoints,
    in_run_notes: run.in_run_notes,
  };
}

export interface LiveStats {
  distanceMeters: number;
  distanceMiles: number;
  averagePaceSecondsPerMile: number | null;
  currentPaceSecondsPerMile: number | null;
  lastAccuracy: number | null;
}

export function computeLiveStats(points: GpsPoint[], elapsedSeconds: number): LiveStats {
  const track = buildTrack(points);
  const distanceMeters = track.length > 0 ? track[track.length - 1].cumulative_meters : 0;
  const averagePaceSecondsPerMile =
    distanceMeters > 5 && elapsedSeconds > 0 ? elapsedSeconds / (distanceMeters / METERS_PER_MILE) : null;
  const currentPaceSecondsPerMile = computeCurrentPace(points);
  const lastAccuracy =
    points.length > 0 ? points[points.length - 1].horizontal_accuracy_meters ?? null : null;

  return {
    distanceMeters,
    distanceMiles: distanceMeters / METERS_PER_MILE,
    averagePaceSecondsPerMile,
    currentPaceSecondsPerMile,
    lastAccuracy,
  };
}

function computeFeatures(run: ActiveRun) {
  const analysisPoints = getAnalysisPoints(run);
  const points = analysisPoints;
  const track = buildTrack(points);
  const durationSeconds = computeDurationSeconds(run, points);
  const distanceMeters = track.length > 0 ? track[track.length - 1].cumulative_meters : 0;
  const distanceMiles = distanceMeters / METERS_PER_MILE;
  const distanceKm = distanceMeters / METERS_PER_KM;
  const movement = computeMovement(points, durationSeconds);
  const gpsQuality = computeGpsQuality(points);
  const interpolation = computeInterpolationFeatures(points, distanceMeters);
  const finalization = computeFinalization(run, analysisPoints);
  const activityWindow = computeActivityWindow(points, run, track);
  const activeStart = activityWindow.inferred_activity_start_elapsed_seconds ?? 0;
  const activeEnd = activityWindow.inferred_activity_end_elapsed_seconds ?? durationSeconds;
  const activePoints = getWindowPoints(points, activeStart, activeEnd);
  const activeTrack = buildTrack(activePoints);
  const activeDurationSeconds = activityWindow.active_duration_seconds ?? computeDurationFromPoints(activePoints);
  const activeDistanceMeters = activeTrack.length > 0 ? activeTrack[activeTrack.length - 1].cumulative_meters : 0;
  const activeDistanceMiles = activeDistanceMeters / METERS_PER_MILE;
  const activeDistanceKm = activeDistanceMeters / METERS_PER_KM;
  const activeMovement = computeMovement(activePoints, activeDurationSeconds);
  const activeInterpolation = computeInterpolationFeatures(activePoints, activeDistanceMeters);
  const recordingReliability = computeRecordingReliability(
    interpolation.missing_gps_time_seconds,
    run.recording_lifecycle,
    gpsQuality.gps_gap_count_over_10_seconds,
    durationSeconds,
  );
  const elevation = computeElevation(points, distanceMeters, gpsQuality.p90_horizontal_accuracy_meters as number | null);
  const splits = {
    miles: buildRepeatingSplits(track, METERS_PER_MILE, "mile"),
    kilometers: buildRepeatingSplits(track, METERS_PER_KM, "kilometer"),
    thirds: buildThirdSplits(track),
  };
  const targetDistanceResult = computeTargetDistanceResult(track, run.pre_run.intended_distance_meters);
  const targetDistanceSplits = buildTargetDistanceSplits(track, run.pre_run.intended_distance_meters);
  const activeTargetDistanceResult = computeActiveTargetDistanceResult(
    activeTrack,
    run.pre_run.intended_distance_meters,
    activeStart,
    activeInterpolation.interpolation_confidence,
    targetDistanceResult,
    activityWindow,
  );
  const activeTargetDistanceSplits = buildActiveTargetDistanceSplits(activeTrack, run.pre_run.intended_distance_meters);
  const analysisSegments = computeAnalysisSegments(activeTrack, activeStart);
  const activePartialPacing = computeActivePartialPacingFeatures(activeTrack, analysisSegments);
  const pacing = computePacingFeatures(track, splits.thirds);
  const routeDirection = inferRouteDirection(activePoints.length >= 2 ? activePoints : points, run.pre_run.route_direction);
  const routeTruth = classifyRoute(run.pre_run, activeDistanceMeters, distanceMeters, points);
  const runClassification = buildRunClassification(routeTruth, run.pre_run, activeDistanceMeters, distanceMeters, points);
  const targetInference = inferTargetDistance(run.pre_run, runClassification);
  const routeSnapping = computeRouteSnapping(routeTruth, runClassification, points, activeDistanceMeters, distanceMeters);
  const activeShortTargetResult = computeActiveShortTargetResult(
    activeTrack,
    targetInference,
    runClassification,
    routeSnapping,
    activeInterpolation,
  );
  const routeSnappedSummary = buildRouteSnappedShortSummary(
    routeSnapping,
    activeTrack,
    activeDurationSeconds,
    activeShortTargetResult,
  );
  const routeSnappedSplits = buildRouteSnappedSplits(activeTrack, routeSnappedSummary.enabled);
  const baseRoute = computeRouteFeatures(points, routeDirection.inferred, run.pre_run.route_name);
  const route = {
    ...baseRoute,
    route_type: routeTruth.routeType,
    route_id: routeTruth.routeId,
    route_truth_notes: routeTruth.notes,
    route_memory_saved_for_future_matching: routeTruth.saveForFutureMatching,
  };
  const greenLakeEnabled = routeTruth.greenLakeEnabled;
  const motion = computeMotionFeatures(
    run.motion_windows,
    durationSeconds,
    run.permissions,
    run.pre_run.phone_position,
    run.motion_debug,
  );
  const artifactModel = computeArtifactModel(points);
  const elevationGrounding = computeElevationGrounding(points);
  const dataQualityScores = computeDataQualityScores(
    recordingReliability,
    run.recording_lifecycle,
    activityWindow,
    activeTargetDistanceResult,
    activeShortTargetResult,
    gpsQuality,
    activeInterpolation,
    elevationGrounding,
    motion,
    greenLakeEnabled,
    activeDistanceMeters,
  );
  const shortRunDiagnostic = buildShortRunDiagnostic(
    activeDistanceMeters,
    activeDurationSeconds,
    activePartialPacing,
    analysisSegments,
    dataQualityScores,
    activeShortTargetResult,
  );
  const usability = buildUsability(dataQualityScores, greenLakeEnabled, shortRunDiagnostic, routeTruth, activeTargetDistanceResult);
  const inferredRunFacts = computeInferredRunFacts(
    activityWindow,
    activeTargetDistanceResult,
    computePacingFeatures(activeTrack, activeTargetDistanceSplits.thirds),
    activeInterpolation,
    run.recording_lifecycle,
    elevationGrounding,
    motion,
    routeTruth.routeId,
    routeDirection.inferred,
    routeSnapping,
    run.weather.start_weather.fetched_at_utc !== null || run.weather.finish_weather.fetched_at_utc !== null,
  );
  const targetedFollowupPrompts = buildTargetedFollowups(inferredRunFacts, analysisSegments, activityWindow);
  const greenLakeCalibration = buildGreenLakeCalibration(
    greenLakeEnabled,
    points,
    distanceMeters,
    route,
    routeDirection,
  );
  const activePacing = computePacingFeatures(activeTrack, activeTargetDistanceSplits.thirds);
  const measurementReconciliation = buildMeasurementReconciliation(
    durationSeconds,
    activeDurationSeconds,
    interpolation,
    activeInterpolation,
    routeSnapping,
    routeSnappedSummary,
    dataQualityScores,
  );
  const patchExecutionAssessment = buildPatchExecutionAssessment(run.pre_run, activeTargetDistanceSplits);
  const groundedDebriefContext = buildGroundedDebriefContext(
    run,
    activityWindow,
    activeTargetDistanceResult,
    inferredRunFacts,
    dataQualityScores,
    targetedFollowupPrompts,
  );
  const coachReadySummary = buildCoachReadySummary(
    greenLakeEnabled,
    activeTargetDistanceResult,
    activePacing,
    dataQualityScores,
    run.post_run,
    shortRunDiagnostic,
    activePartialPacing,
    runClassification,
    measurementReconciliation,
    usability,
    patchExecutionAssessment,
    activeShortTargetResult,
  );
  const notes = buildQualityNotes(
    points,
    gpsQuality,
    run.motion_windows,
    run.weather.start_weather.fetched_at_utc,
    targetDistanceResult,
    interpolation,
    recordingReliability,
  );
  const activeDistanceConfidence =
    dataQualityScores.distance_confidence === "high" && activeInterpolation.interpolation_confidence !== "high"
      ? "medium"
      : dataQualityScores.distance_confidence;

  return {
    analysisPoints,
    finalization,
    activityWindow,
    summary: {
      duration_seconds: finiteOrNull(round(durationSeconds, 2)),
      distance_meters: finiteOrNull(round(distanceMeters, 2)),
      raw_recorded_distance_meters: interpolation.raw_recorded_distance_meters,
      interpolated_distance_estimate_meters: interpolation.interpolated_distance_estimate_meters,
      distance_confidence:
        recordingReliability === "high" && interpolation.interpolation_confidence !== "high" ? "medium" : recordingReliability,
      distance_miles: finiteOrNull(round(distanceMiles, 4)),
      average_pace_seconds_per_mile:
        distanceMiles > 0 ? finiteOrNull(round(durationSeconds / distanceMiles, 2)) : null,
      average_pace_seconds_per_km: distanceKm > 0 ? finiteOrNull(round(durationSeconds / distanceKm, 2)) : null,
      moving_time_seconds: finiteOrNull(round(movement.movingSeconds, 2)),
      stopped_time_seconds: finiteOrNull(round(movement.stoppedSeconds, 2)),
      average_speed_mps: durationSeconds > 0 ? finiteOrNull(round(distanceMeters / durationSeconds, 3)) : null,
      max_speed_mps: movement.maxSpeedMps,
    },
    activeSummary: {
      duration_seconds: finiteOrNull(round(activeDurationSeconds, 2)),
      distance_meters: finiteOrNull(round(activeDistanceMeters, 2)),
      raw_recorded_distance_meters: activeInterpolation.raw_recorded_distance_meters,
      interpolated_distance_estimate_meters: activeInterpolation.interpolated_distance_estimate_meters,
      distance_confidence: activeDistanceConfidence,
      distance_miles: finiteOrNull(round(activeDistanceMiles, 4)),
      average_pace_seconds_per_mile:
        activeDistanceMiles > 0 ? finiteOrNull(round(activeDurationSeconds / activeDistanceMiles, 2)) : null,
      average_pace_seconds_per_km:
        activeDistanceKm > 0 ? finiteOrNull(round(activeDurationSeconds / activeDistanceKm, 2)) : null,
      moving_time_seconds: finiteOrNull(round(activeMovement.movingSeconds, 2)),
      stopped_time_seconds: finiteOrNull(round(activeMovement.stoppedSeconds, 2)),
      average_speed_mps: activeDurationSeconds > 0 ? finiteOrNull(round(activeDistanceMeters / activeDurationSeconds, 3)) : null,
      speed_p95_mps: artifactModel.rolling_speed_p95_mps,
      max_plausible_speed_mps: artifactModel.max_display_speed_mps,
    },
    gpsQuality,
    interpolation,
    recordingReliability,
    splits,
    targetDistanceResult,
    targetDistanceSplits,
    activeTargetDistanceResult,
    activeShortTargetResult,
    activeTargetDistanceSplits,
    pacing: { ...pacing, active_window: activePacing },
    elevation,
    elevationGrounding,
    route,
    routeDirection,
    runClassification,
    targetInference,
    routeSnapping,
    routeSnappedSummary,
    routeSnappedSplits,
    routeLibrary: buildRouteLibrary(routeTruth, points, distanceMeters, run.run_metadata.run_id),
    measurementReconciliation,
    motion,
    inferredRunFacts,
    targetedFollowupPrompts,
    routeConfirmationPrompt: buildRouteConfirmationPrompt(routeTruth, routeSnapping),
    analysisSegments,
    greenLakeCalibration,
    artifactModel,
    dataQualityScores,
    usability,
    groundedDebriefContext,
    coachReadySummary,
    patchExecutionAssessment,
    shortRunDiagnostic,
    activePartialPacing,
    dataQualityNotes: notes,
  };
}

function buildTrack(points: GpsPoint[]): TrackPoint[] {
  if (points.length === 0) {
    return [];
  }

  let cumulative = 0;
  const track: TrackPoint[] = [{ ...points[0], cumulative_meters: 0 }];

  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const current = points[i];
    const segmentMeters = isExcludedSegment(current) ? 0 : haversineMeters(previous, current);
    cumulative += segmentMeters;
    track.push({ ...current, cumulative_meters: cumulative });
  }

  return track;
}

function computeDurationSeconds(run: ActiveRun, points: GpsPoint[]): number {
  if (run.run_metadata.end_time_utc && Number.isFinite(run.elapsed_offset_seconds) && run.elapsed_offset_seconds > 0) {
    return Math.max(0, run.elapsed_offset_seconds);
  }

  if (points.length > 0) {
    return Math.max(0, points[points.length - 1].t_elapsed_seconds);
  }

  if (run.run_metadata.end_time_utc && run.run_metadata.start_time_utc) {
    const start = Date.parse(run.run_metadata.start_time_utc);
    const end = Date.parse(run.run_metadata.end_time_utc);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      return (end - start) / 1000;
    }
  }

  return Math.max(0, run.elapsed_offset_seconds);
}

function getAnalysisPoints(run: ActiveRun): GpsPoint[] {
  const stopAtUtc = run.finalization?.stop_clicked_at_utc ?? run.run_metadata.end_time_utc;
  const stopElapsed = run.finalization?.stopped_at_elapsed_seconds ?? run.elapsed_offset_seconds;

  if (!stopAtUtc && !(Number.isFinite(stopElapsed) && stopElapsed > 0 && run.status !== "running")) {
    return run.gps_points;
  }

  const stopTime = stopAtUtc ? Date.parse(stopAtUtc) : null;
  return run.gps_points.filter((point) => {
    const pointTime = Date.parse(point.timestamp_utc);
    const beforeStopTime = stopTime === null || !Number.isFinite(pointTime) || pointTime <= stopTime;
    const beforeStopElapsed =
      stopElapsed === null || !Number.isFinite(stopElapsed) || point.t_elapsed_seconds <= stopElapsed + 0.05;
    return beforeStopTime && beforeStopElapsed;
  });
}

function computeFinalization(run: ActiveRun, analysisPoints: GpsPoint[]): FinalizationDiagnostics {
  const rawPoints = run.gps_points;
  const stopPoint = run.finalization?.stop_point ?? analysisPoints[analysisPoints.length - 1] ?? null;
  const analysisSet = new Set(analysisPoints);
  const latePoints = rawPoints.filter((point) => !analysisSet.has(point));
  const firstLate = latePoints[0] ?? null;
  const lastLate = latePoints[latePoints.length - 1] ?? null;
  const postStopCount = Math.max(run.finalization?.post_stop_gps_callback_count ?? 0, latePoints.length);
  const drift =
    stopPoint && lastLate
      ? haversineMeters(stopPoint, lastLate)
      : run.finalization?.post_stop_gps_drift_meters ?? null;
  const stopTime = run.finalization?.stop_clicked_at_utc ? Date.parse(run.finalization.stop_clicked_at_utc) : null;
  const firstLateTime = firstLate ? Date.parse(firstLate.timestamp_utc) : null;
  const driftMeters = drift === null ? null : round(drift, 2);
  const harmlessSingleCallback = postStopCount === 1 && (driftMeters === null || driftMeters <= 1);
  const firstLateClassification =
    firstLate && stopPoint && firstLate.timestamp_utc === stopPoint.timestamp_utc
      ? "duplicate_stop_point"
      : firstLate && stopTime !== null && firstLateTime !== null && firstLateTime <= stopTime
        ? "duplicate_stop_point"
        : harmlessSingleCallback
          ? "harmless_late_callback"
          : firstLate || postStopCount > 0
            ? "post_stop_callback"
            : null;
  const cleanupStatus: FinalizationDiagnostics["gps_callback_cleanup_status"] =
    run.finalization?.gps_callback_cleanup_status === "failed"
      ? "failed"
      : postStopCount > 1 || (driftMeters !== null && driftMeters > 5)
        ? "callbacks_after_stop"
        : "clean";

  return {
    stop_clicked_at_utc: run.finalization?.stop_clicked_at_utc ?? run.run_metadata.end_time_utc,
    stopped_at_elapsed_seconds: run.finalization?.stopped_at_elapsed_seconds ?? run.elapsed_offset_seconds,
    gps_watch_cleared: Boolean(run.finalization?.gps_watch_cleared),
    motion_listener_removed: Boolean(run.finalization?.motion_listener_removed),
    gps_stale_timers_cleared: Boolean(run.finalization?.gps_stale_timers_cleared),
    finish_point_source: stopPoint ? "last_valid_pre_stop_gps" : "none",
    stop_point: stopPoint,
    post_stop_gps_callback_count: postStopCount,
    post_stop_gps_first_timestamp_utc:
      run.finalization?.post_stop_gps_first_timestamp_utc ?? firstLate?.timestamp_utc ?? null,
    post_stop_gps_last_timestamp_utc:
      run.finalization?.post_stop_gps_last_timestamp_utc ?? lastLate?.timestamp_utc ?? null,
    post_stop_gps_drift_meters: driftMeters,
    points_excluded_after_stop: Math.max(run.finalization?.points_excluded_after_stop ?? 0, latePoints.length),
    analysis_point_count: analysisPoints.length,
    raw_point_count: rawPoints.length,
    stored_analysis_point_count: analysisPoints.length,
    post_stop_callback_count: postStopCount,
    total_callbacks_seen: rawPoints.length + Math.max(0, postStopCount - latePoints.length),
    post_stop_first_callback_classification: firstLateClassification,
    gps_callback_cleanup_status: cleanupStatus,
    cleanup_failed: cleanupStatus !== "clean",
  };
}

function computeDurationFromPoints(points: GpsPoint[]): number {
  if (points.length < 2) {
    return 0;
  }
  return Math.max(0, points[points.length - 1].t_elapsed_seconds - points[0].t_elapsed_seconds);
}

function computeActivityWindow(points: GpsPoint[], run: ActiveRun, track: TrackPoint[]): ActivityWindow {
  const recordingEnd = computeDurationSeconds(run, points);
  const totalDistance = track.length > 0 ? track[track.length - 1].cumulative_meters : 0;
  let startElapsed: number | null = null;
  let confidence: ActivityWindow["inferred_activity_start_confidence"] = "unknown";
  let method: string | null = null;
  const notes: string[] = [];

  let sustainedStart: number | null = null;
  for (let i = 1; i < points.length; i += 1) {
    const current = points[i];
    const previous = points[i - 1];
    const speed = plausibleSpeedForPoint(current);
    const acceptable =
      current.accuracy_ok &&
      !isExcludedSegment(current) &&
      current.horizontal_accuracy_meters !== null &&
      current.horizontal_accuracy_meters <= POOR_ACCURACY_THRESHOLD_METERS;
    if (acceptable && speed !== null && speed > 1.6) {
      sustainedStart ??= previous.t_elapsed_seconds;
      if (current.t_elapsed_seconds - sustainedStart >= 8) {
        startElapsed = sustainedStart;
        confidence = "high";
        method = "sustained_gps_speed_over_1_6_mps_for_8s";
        notes.push("Activity start inferred from sustained plausible GPS speed.");
        break;
      }
    } else if (speed === null || speed <= 0.8) {
      sustainedStart = null;
    }
  }

  if (startElapsed === null && points.length > 1) {
    for (let i = 1; i < track.length; i += 1) {
      const point = track[i];
      if (!point.accuracy_ok || isExcludedSegment(point)) {
        continue;
      }
      if (point.cumulative_meters > 30) {
        let startIndex = i;
        while (startIndex > 0 && track[startIndex - 1].cumulative_meters > 5) {
          startIndex -= 1;
        }
        startElapsed = track[startIndex].t_elapsed_seconds;
        confidence = "medium";
        method = "cumulative_displacement_over_30m";
        notes.push("Activity start inferred from displacement after GPS warmup.");
        break;
      }
    }
  }

  if (startElapsed === null && totalDistance > 30 && points[0]) {
    startElapsed = points[0].t_elapsed_seconds;
    confidence = "low";
    method = "fallback_first_recorded_point";
    notes.push("Could not isolate idle preamble; using first analysis GPS point.");
  }

  const activityStart = startElapsed ?? null;
  const activeEnd = points[points.length - 1]?.t_elapsed_seconds ?? (recordingEnd > 0 ? recordingEnd : null);
  const activePoints = activityStart === null || activeEnd === null ? [] : getWindowPoints(points, activityStart, activeEnd);
  const activeTrack = buildTrack(activePoints);
  const activeDistance = activeTrack.length > 0 ? activeTrack[activeTrack.length - 1].cumulative_meters : null;
  const idlePreamble = activityStart === null ? null : Math.max(0, activityStart);
  const excludedIntervals =
    idlePreamble !== null && idlePreamble >= 5
      ? [
          {
            start_elapsed_seconds: 0,
            end_elapsed_seconds: round(activityStart ?? 0, 2),
            duration_seconds: round(idlePreamble, 2),
            reason: "stationary_preamble" as const,
          },
        ]
      : [];

  if (idlePreamble !== null && idlePreamble >= 5) {
    notes.push(`Excluded ${round(idlePreamble, 1)}s idle preamble from active-run analysis.`);
  }

  return {
    recording_start_elapsed_seconds: 0,
    inferred_activity_start_elapsed_seconds: activityStart === null ? null : round(activityStart, 3),
    inferred_activity_start_confidence: confidence,
    idle_preamble_seconds: idlePreamble === null ? null : round(idlePreamble, 2),
    inferred_activity_end_elapsed_seconds: activeEnd === null ? null : round(activeEnd, 3),
    active_duration_seconds:
      activityStart !== null && activeEnd !== null ? round(Math.max(0, activeEnd - activityStart), 2) : null,
    active_distance_meters: activeDistance === null ? null : round(activeDistance, 2),
    analysis_basis: activityStart !== null && idlePreamble !== null && idlePreamble >= 5 ? "activity_window" : "recording_window",
    detection_method: method,
    detection_notes: notes,
    excluded_intervals: excludedIntervals,
  };
}

function getWindowPoints(points: GpsPoint[], startElapsed: number, endElapsed: number): GpsPoint[] {
  const selected = points.filter(
    (point) => point.t_elapsed_seconds >= startElapsed && point.t_elapsed_seconds <= endElapsed,
  );
  return selected;
}

function plausibleSpeedForPoint(point: GpsPoint): number | null {
  const candidates = [point.segment_speed_mps, point.speed_mps].filter(isNumber);
  const plausible = candidates.filter((speed) => speed > 0 && speed <= SUSPICIOUS_SPEED_MPS);
  return plausible.length > 0 ? Math.max(...plausible) : null;
}

function computeMovement(points: GpsPoint[], durationSeconds: number) {
  let movingSeconds = 0;
  let maxSpeedMps: number | null = null;

  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const current = points[i];
    const dt = current.t_elapsed_seconds - previous.t_elapsed_seconds;
    if (dt <= 0) {
      continue;
    }

    const excluded = isExcludedSegment(current);
    const segmentMeters = excluded ? 0 : haversineMeters(previous, current);
    const segmentSpeed = segmentMeters / dt;
    const deviceSpeed = excluded ? 0 : current.speed_mps ?? 0;
    const bestSpeed = Math.max(segmentSpeed, deviceSpeed);
    if (bestSpeed >= STOPPED_SPEED_THRESHOLD_MPS) {
      movingSeconds += dt;
    }
    if (Number.isFinite(bestSpeed)) {
      maxSpeedMps = maxSpeedMps === null ? bestSpeed : Math.max(maxSpeedMps, bestSpeed);
    }
  }

  return {
    movingSeconds: Math.min(durationSeconds, movingSeconds),
    stoppedSeconds: Math.max(0, durationSeconds - movingSeconds),
    maxSpeedMps: maxSpeedMps === null ? null : round(maxSpeedMps, 3),
  };
}

function computeGpsQuality(points: GpsPoint[]) {
  const accuracies = points
    .map((point) => point.horizontal_accuracy_meters)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  let gapsOver5 = 0;
  let gapsOver10 = 0;

  for (let i = 1; i < points.length; i += 1) {
    const gap = points[i].t_elapsed_seconds - points[i - 1].t_elapsed_seconds;
    if (gap > 5) {
      gapsOver5 += 1;
    }
    if (gap > 10) {
      gapsOver10 += 1;
    }
  }

  return {
    gps_point_count: points.length,
    median_horizontal_accuracy_meters: roundOrNull(median(accuracies), 2),
    p90_horizontal_accuracy_meters: roundOrNull(percentile(accuracies, 0.9), 2),
    poor_accuracy_points_count: points.filter(
      (point) =>
        point.horizontal_accuracy_meters !== null &&
        point.horizontal_accuracy_meters > POOR_ACCURACY_THRESHOLD_METERS,
    ).length,
    poor_accuracy_threshold_meters: POOR_ACCURACY_THRESHOLD_METERS,
    gps_gap_count_over_5_seconds: gapsOver5,
    gps_gap_count_over_10_seconds: gapsOver10,
    possible_gps_jump_count: points.filter((point) => point.possible_gps_jump).length,
    impossible_speed_segment_count: points.filter((point) => point.impossible_speed).length,
    suspicious_speed_segment_count: points.filter((point) => point.suspicious_speed).length,
    suspicious_acceleration_segment_count: points.filter((point) => point.suspicious_acceleration).length,
    suspicious_grade_segment_count: points.filter((point) => point.suspicious_grade).length,
  };
}

function computeInterpolationFeatures(points: GpsPoint[], rawRecordedDistanceMeters: number): InterpolationFeatures {
  const gaps: GpsGapInterpolation[] = [];
  let estimatedMissingDistance = 0;
  let missingGpsTime = 0;

  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const current = points[i];
    const dt = current.t_elapsed_seconds - previous.t_elapsed_seconds;
    if (dt <= 5) {
      continue;
    }

    const straightLineDistance = haversineMeters(previous, current);
    const surroundingSpeed = surroundingPlausibleSpeed(points, i);
    const speedBasedDistance =
      surroundingSpeed !== null && surroundingSpeed <= SUSPICIOUS_SPEED_MPS ? surroundingSpeed * dt : null;
    const useSpeedBased =
      speedBasedDistance !== null &&
      speedBasedDistance > straightLineDistance &&
      speedBasedDistance <= SUSPICIOUS_SPEED_MPS * dt;
    const chosenDistance = useSpeedBased ? speedBasedDistance : straightLineDistance;
    const rawContribution = isExcludedSegment(current) ? 0 : straightLineDistance;

    estimatedMissingDistance += Math.max(0, chosenDistance - rawContribution);
    missingGpsTime += dt;
    gaps.push({
      start_elapsed_seconds: round(previous.t_elapsed_seconds, 2),
      end_elapsed_seconds: round(current.t_elapsed_seconds, 2),
      duration_seconds: round(dt, 2),
      last_point: pickGapPoint(previous),
      next_point: pickGapPoint(current),
      straight_line_distance_meters: round(straightLineDistance, 2),
      surrounding_speed_mps: surroundingSpeed === null ? null : round(surroundingSpeed, 3),
      speed_based_distance_estimate_meters: speedBasedDistance === null ? null : round(speedBasedDistance, 2),
      chosen_distance_estimate_meters: round(chosenDistance, 2),
      method: useSpeedBased ? "speed_based" : "straight_line",
      confidence: "low",
    });
  }

  return {
    raw_recorded_distance_meters: points.length > 0 ? round(rawRecordedDistanceMeters, 2) : null,
    interpolated_distance_estimate_meters:
      points.length > 0 ? round(rawRecordedDistanceMeters + estimatedMissingDistance, 2) : null,
    estimated_missing_distance_meters: points.length > 0 ? round(estimatedMissingDistance, 2) : null,
    missing_gps_time_seconds: round(missingGpsTime, 2),
    interpolation_confidence: gaps.length === 0 ? "high" : "low",
    gaps,
  };
}

function computeRecordingReliability(
  missingGpsTimeSeconds: number,
  lifecycle: RecordingLifecycle,
  gpsGapCountOver10: number,
  durationSeconds: number,
): "high" | "medium" | "low" {
  const missingRatio = durationSeconds > 0 ? missingGpsTimeSeconds / durationSeconds : 0;
  const hiddenEvents = lifecycle.visibility_events.filter((event) => event.visibility_state === "hidden").length;
  if (gpsGapCountOver10 > 1 || missingGpsTimeSeconds > 30 || missingRatio > 0.08) {
    return "low";
  }
  if (gpsGapCountOver10 > 0 || missingGpsTimeSeconds > 5 || lifecycle.gps_stale_events.length > 0 || hiddenEvents > 0) {
    return "medium";
  }
  return "high";
}

function surroundingPlausibleSpeed(points: GpsPoint[], gapEndIndex: number): number | null {
  const candidates = [
    points[gapEndIndex - 1]?.segment_speed_mps,
    points[gapEndIndex + 1]?.segment_speed_mps,
    points[gapEndIndex - 2]?.segment_speed_mps,
    points[gapEndIndex + 2]?.segment_speed_mps,
  ].filter((value): value is number => value !== null && value !== undefined && value > 0 && value <= SUSPICIOUS_SPEED_MPS);

  return mean(candidates);
}

function pickGapPoint(point: GpsPoint) {
  return {
    t_elapsed_seconds: point.t_elapsed_seconds,
    timestamp_utc: point.timestamp_utc,
    lat: point.lat,
    lon: point.lon,
    horizontal_accuracy_meters: point.horizontal_accuracy_meters,
  };
}

function computeElevation(points: GpsPoint[], totalDistanceMeters: number, p90Accuracy: number | null) {
  let gain = 0;
  let loss = 0;
  let maxGrade: number | null = null;
  let altitudePairCount = 0;

  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const current = points[i];
    if (
      previous.altitude_meters === null ||
      current.altitude_meters === null ||
      isExcludedSegment(current) ||
      current.suspicious_grade
    ) {
      continue;
    }
    altitudePairCount += 1;
    const delta = current.altitude_meters - previous.altitude_meters;
    const segmentMeters = haversineMeters(previous, current);
    if (delta > 0) {
      gain += delta;
    } else {
      loss += Math.abs(delta);
    }
    if (segmentMeters >= 5) {
      const grade = (delta / segmentMeters) * 100;
      if (Math.abs(grade) <= SUSPICIOUS_GRADE_PERCENT) {
        maxGrade = maxGrade === null ? Math.abs(grade) : Math.max(maxGrade, Math.abs(grade));
      }
    }
  }

  const altitudeCoverage = points.length > 1 ? altitudePairCount / (points.length - 1) : 0;
  const confidence =
    totalDistanceMeters > 1000 && altitudeCoverage > 0.5 && p90Accuracy !== null && p90Accuracy <= 25
      ? "medium"
      : "low";

  return {
    total_elevation_gain_meters: round(gain, 2),
    total_elevation_loss_meters: round(loss, 2),
    max_grade_percent_observed: maxGrade === null ? null : round(maxGrade, 2),
    grade_adjusted_features_placeholder: null,
    elevation_confidence: confidence,
  };
}

function buildRepeatingSplits(track: TrackPoint[], splitMeters: number, prefix: "mile" | "kilometer"): SplitFeature[] {
  if (track.length < 2) {
    return [];
  }

  const total = track[track.length - 1].cumulative_meters;
  const splits: SplitFeature[] = [];
  let start = 0;
  let index = 1;

  while (start < total) {
    const end = Math.min(total, start + splitMeters);
    splits.push(buildSplit(track, start, end, `${prefix}_${index}`, index));
    start = end;
    index += 1;
  }

  return splits;
}

function buildThirdSplits(track: TrackPoint[]): SplitFeature[] {
  const fallbackNames = ["first_third", "middle_third", "final_third"];
  if (track.length < 2) {
    return fallbackNames.map((name) => emptySplit(name));
  }

  const total = track[track.length - 1].cumulative_meters;
  if (total <= 0) {
    return fallbackNames.map((name) => emptySplit(name));
  }

  const third = total / 3;
  return fallbackNames.map((name, index) => buildSplit(track, index * third, (index + 1) * third, name));
}

function buildTargetDistanceSplits(track: TrackPoint[], intendedDistanceMeters: number) {
  const thirdNames = ["first_third", "middle_third", "final_third"];
  if (track.length < 2 || intendedDistanceMeters <= 0) {
    return {
      miles: [],
      kilometers: [],
      thirds: thirdNames.map((name) => emptySplit(name)),
    };
  }

  const recordedDistance = track[track.length - 1].cumulative_meters;
  const cappedDistance = Math.min(recordedDistance, intendedDistanceMeters);

  return {
    miles: buildRepeatingSplitsToDistance(track, METERS_PER_MILE, "mile", cappedDistance),
    kilometers: buildRepeatingSplitsToDistance(track, METERS_PER_KM, "kilometer", cappedDistance),
    thirds: buildThirdSplitsForDistance(track, intendedDistanceMeters, cappedDistance),
  };
}

function buildRepeatingSplitsToDistance(
  track: TrackPoint[],
  splitMeters: number,
  prefix: string,
  maxDistanceMeters: number,
): SplitFeature[] {
  if (track.length < 2 || maxDistanceMeters <= 0) {
    return [];
  }

  const splits: SplitFeature[] = [];
  let start = 0;
  let index = 1;

  while (start < maxDistanceMeters) {
    const end = Math.min(maxDistanceMeters, start + splitMeters);
    splits.push(buildSplit(track, start, end, `${prefix}_${index}`, index));
    start = end;
    index += 1;
  }

  return splits;
}

function buildThirdSplitsForDistance(
  track: TrackPoint[],
  intendedDistanceMeters: number,
  availableDistanceMeters: number,
): SplitFeature[] {
  const thirdNames = ["first_third", "middle_third", "final_third"];
  if (track.length < 2 || intendedDistanceMeters <= 0 || availableDistanceMeters <= 0) {
    return thirdNames.map((name) => emptySplit(name));
  }

  const thirdDistance = intendedDistanceMeters / 3;
  return thirdNames.map((name, index) => {
    const start = index * thirdDistance;
    const intendedEnd = (index + 1) * thirdDistance;
    if (availableDistanceMeters <= start) {
      return emptySplit(name);
    }
    return buildSplit(track, start, Math.min(intendedEnd, availableDistanceMeters), name);
  });
}

function computeTargetDistanceResult(track: TrackPoint[], intendedDistanceMeters: number): TargetDistanceResult {
  const recordedDistance = track.length > 0 ? track[track.length - 1].cumulative_meters : 0;
  const targetReached = intendedDistanceMeters > 0 && recordedDistance >= intendedDistanceMeters;
  const targetState = targetReached ? stateAtDistance(track, intendedDistanceMeters) : null;
  const elapsed = targetState?.elapsed ?? null;

  return {
    intended_distance_meters: intendedDistanceMeters,
    target_reached: targetReached,
    elapsed_at_target_distance_seconds: elapsed === null ? null : round(elapsed, 2),
    pace_to_target_seconds_per_mile:
      elapsed === null ? null : round(elapsed / (intendedDistanceMeters / METERS_PER_MILE), 2),
    pace_to_target_seconds_per_km:
      elapsed === null ? null : round(elapsed / (intendedDistanceMeters / METERS_PER_KM), 2),
    overshoot_meters: targetReached ? round(Math.max(0, recordedDistance - intendedDistanceMeters), 2) : null,
    distance_recorded_meters: track.length > 0 ? round(recordedDistance, 2) : null,
  };
}

function computeActiveTargetDistanceResult(
  track: TrackPoint[],
  intendedDistanceMeters: number,
  activeStartElapsed: number,
  interpolationConfidence: InterpolationFeatures["interpolation_confidence"],
  recordingTargetDistanceResult: TargetDistanceResult,
  activityWindow: ActivityWindow,
): ActiveTargetDistanceResult {
  const recordedDistance = track.length > 0 ? track[track.length - 1].cumulative_meters : 0;
  const activeCrossed = intendedDistanceMeters > 0 && recordedDistance >= intendedDistanceMeters;
  const activeWithinTolerance =
    intendedDistanceMeters > 0 &&
    recordingTargetDistanceResult.target_reached &&
    recordedDistance >= intendedDistanceMeters - TARGET_DISTANCE_TOLERANCE_METERS;
  const recordingTargetAfterActivityStart =
    recordingTargetDistanceResult.target_reached &&
    recordingTargetDistanceResult.elapsed_at_target_distance_seconds !== null &&
    recordingTargetDistanceResult.elapsed_at_target_distance_seconds >= activeStartElapsed;
  const targetReached = activeCrossed || activeWithinTolerance || recordingTargetAfterActivityStart;
  const targetState = activeCrossed ? stateAtDistance(track, intendedDistanceMeters) : null;
  let recordingElapsed = targetState?.elapsed ?? null;
  let method: ActiveTargetDistanceResult["target_detection_method"] = "not_reached";

  if (activeCrossed) {
    method = "active_cumulative_crossing";
  } else if (recordingTargetAfterActivityStart && recordingTargetDistanceResult.elapsed_at_target_distance_seconds !== null) {
    recordingElapsed = recordingTargetDistanceResult.elapsed_at_target_distance_seconds;
    method = activeWithinTolerance
      ? "recording_target_with_active_tolerance"
      : "recording_target_minus_activity_start";
  } else if (activeWithinTolerance && track.length > 0) {
    recordingElapsed = track[track.length - 1].t_elapsed_seconds;
    method = "recording_target_with_active_tolerance";
  }

  const activeElapsed = recordingElapsed === null ? null : Math.max(0, recordingElapsed - activeStartElapsed);
  const confidence =
    targetReached && interpolationConfidence === "high" && activityWindow.inferred_activity_start_confidence !== "unknown"
      ? "high"
      : targetReached
        ? "medium"
        : "low";

  return {
    intended_distance_meters: intendedDistanceMeters,
    target_reached: targetReached,
    active_elapsed_at_target_distance_seconds: activeElapsed === null ? null : round(activeElapsed, 2),
    recording_elapsed_at_target_distance_seconds: recordingElapsed === null ? null : round(recordingElapsed, 2),
    active_pace_to_target_seconds_per_mile:
      activeElapsed === null ? null : round(activeElapsed / (intendedDistanceMeters / METERS_PER_MILE), 2),
    active_pace_to_target_seconds_per_km:
      activeElapsed === null ? null : round(activeElapsed / (intendedDistanceMeters / METERS_PER_KM), 2),
    overshoot_meters: targetReached ? round(Math.max(0, recordedDistance - intendedDistanceMeters), 2) : null,
    distance_recorded_meters: track.length > 0 ? round(recordedDistance, 2) : null,
    stop_time_seconds: activityWindow.active_duration_seconds,
    time_after_target_seconds:
      activeElapsed !== null && activityWindow.active_duration_seconds !== null
        ? round(Math.max(0, activityWindow.active_duration_seconds - activeElapsed), 2)
        : null,
    distance_after_target_meters: targetReached ? round(Math.max(0, recordedDistance - intendedDistanceMeters), 2) : null,
    target_distance_confidence: confidence,
    target_detection_method: method,
    target_distance_tolerance_meters: TARGET_DISTANCE_TOLERANCE_METERS,
    diagnostic_note:
      method === "recording_target_minus_activity_start"
        ? "Active target time was derived from recording target crossing minus inferred activity start."
        : method === "recording_target_with_active_tolerance"
          ? "Active track ended within tolerance of target and recording target crossing was used."
          : null,
  };
}

function computeActiveShortTargetResult(
  track: TrackPoint[],
  targetInference: TargetInference,
  classification: RunClassification,
  routeSnapping: RouteSnapping,
  activeInterpolation: InterpolationFeatures,
): ActiveShortTargetResult {
  const targetDistance = classification.inferred_mode === "short_run_diagnostic"
    ? targetInference.target_distance_meters
    : null;
  const activeDistance = track.length > 0 ? track[track.length - 1].cumulative_meters : 0;
  const snappedDistance = routeSnapping.snapped_distance_meters ?? null;
  const chosenBasis =
    routeSnapping.distance_basis === "route_snapped"
      ? "route_snapped"
      : activeInterpolation.interpolation_confidence === "high"
        ? "active_gps"
        : "artifact_filtered_gps";
  const availableDistance = chosenBasis === "route_snapped" && snappedDistance !== null ? snappedDistance : activeDistance;

  if (targetDistance === null || targetDistance <= 0) {
    return {
      target_distance_meters: null,
      target_reached: false,
      active_elapsed_at_target_seconds: null,
      pace_seconds_per_km: null,
      pace_seconds_per_mile: null,
      confidence: "unknown",
      chosen_distance_basis: null,
      diagnostic_note: "Short target was not inferred for this run.",
    };
  }

  const targetReached = availableDistance >= targetDistance;
  const targetState = targetReached ? stateAtDistance(track, Math.min(targetDistance, activeDistance)) : null;
  const activeStartElapsed = track[0]?.t_elapsed_seconds ?? 0;
  const elapsed = targetState?.elapsed === undefined ? null : Math.max(0, targetState.elapsed - activeStartElapsed);
  const confidence: ActiveShortTargetResult["confidence"] =
    targetReached && routeSnapping.distance_basis === "route_snapped" && routeSnapping.confidence === "high"
      ? "high"
      : targetReached && activeInterpolation.interpolation_confidence === "high"
        ? "high"
        : targetReached
          ? "medium"
          : "low";

  return {
    target_distance_meters: targetDistance,
    target_reached: targetReached,
    active_elapsed_at_target_seconds: elapsed === null ? null : round(elapsed, 2),
    pace_seconds_per_km: elapsed === null ? null : round(elapsed / (targetDistance / METERS_PER_KM), 2),
    pace_seconds_per_mile: elapsed === null ? null : round(elapsed / (targetDistance / METERS_PER_MILE), 2),
    confidence,
    chosen_distance_basis: chosenBasis,
    diagnostic_note: targetReached
      ? `Short target used ${chosenBasis} as the distance basis.`
      : "Short target distance was not reached.",
  };
}

interface ActiveTargetSplits {
  miles: SplitFeature[];
  kilometers: SplitFeature[];
  thirds: SplitFeature[];
  fixed_100m: SplitFeature[];
  fixed_200m: SplitFeature[];
  fixed_500m: SplitFeature[];
}

function buildActiveTargetDistanceSplits(track: TrackPoint[], intendedDistanceMeters: number): ActiveTargetSplits {
  const base = buildTargetDistanceSplits(track, intendedDistanceMeters);
  const recordedDistance = track.length > 0 ? track[track.length - 1].cumulative_meters : 0;
  const cappedDistance = Math.min(recordedDistance, intendedDistanceMeters);
  return {
    ...base,
    fixed_100m: buildRepeatingSplitsToDistance(track, 100, "meter_100", cappedDistance),
    fixed_200m: buildRepeatingSplitsToDistance(track, 200, "meter_200", cappedDistance),
    fixed_500m: buildRepeatingSplitsToDistance(track, 500, "meter_500", cappedDistance),
  };
}

function buildSplit(track: TrackPoint[], startMeters: number, endMeters: number, name: string, index?: number): SplitFeature {
  const start = stateAtDistance(track, startMeters);
  const end = stateAtDistance(track, endMeters);
  const distance = Math.max(0, endMeters - startMeters);
  const duration = start && end ? Math.max(0, end.elapsed - start.elapsed) : null;
  const elevation = elevationInRange(track, startMeters, endMeters);
  const avgAccuracy = averageAccuracyInRange(track, startMeters, endMeters);

  return {
    name,
    index,
    distance_meters: round(distance, 2),
    duration_seconds: duration === null ? null : round(duration, 2),
    pace_seconds_per_mile:
      duration !== null && distance > 0 ? round(duration / (distance / METERS_PER_MILE), 2) : null,
    elevation_gain_meters: elevation.gain,
    elevation_loss_meters: elevation.loss,
    avg_horizontal_accuracy_meters: avgAccuracy,
  };
}

function emptySplit(name: string): SplitFeature {
  return {
    name,
    distance_meters: null,
    duration_seconds: null,
    pace_seconds_per_mile: null,
    elevation_gain_meters: null,
    elevation_loss_meters: null,
    avg_horizontal_accuracy_meters: null,
  };
}

function stateAtDistance(track: TrackPoint[], distanceMeters: number): TrackStateAtDistance | null {
  if (track.length === 0) {
    return null;
  }

  if (distanceMeters <= 0) {
    const first = track[0];
    return {
      elapsed: first.t_elapsed_seconds,
      altitude: first.altitude_meters,
      accuracy: first.horizontal_accuracy_meters,
    };
  }

  const final = track[track.length - 1];
  if (distanceMeters >= final.cumulative_meters) {
    return {
      elapsed: final.t_elapsed_seconds,
      altitude: final.altitude_meters,
      accuracy: final.horizontal_accuracy_meters,
    };
  }

  for (let i = 1; i < track.length; i += 1) {
    const previous = track[i - 1];
    const current = track[i];
    if (current.cumulative_meters < distanceMeters || current.cumulative_meters === previous.cumulative_meters) {
      continue;
    }

    const ratio =
      (distanceMeters - previous.cumulative_meters) / (current.cumulative_meters - previous.cumulative_meters);
    return {
      elapsed: interpolate(previous.t_elapsed_seconds, current.t_elapsed_seconds, ratio),
      altitude:
        previous.altitude_meters !== null && current.altitude_meters !== null
          ? interpolate(previous.altitude_meters, current.altitude_meters, ratio)
          : null,
      accuracy:
        previous.horizontal_accuracy_meters !== null && current.horizontal_accuracy_meters !== null
          ? interpolate(previous.horizontal_accuracy_meters, current.horizontal_accuracy_meters, ratio)
          : null,
    };
  }

  return null;
}

function rangeOverlapFraction(
  segmentStart: number,
  segmentEnd: number,
  startMeters: number,
  endMeters: number,
): number {
  const span = segmentEnd - segmentStart;
  if (span <= 0) {
    return segmentStart >= startMeters && segmentStart < endMeters ? 1 : 0;
  }
  const overlap = Math.min(segmentEnd, endMeters) - Math.max(segmentStart, startMeters);
  return overlap > 0 ? Math.min(1, overlap / span) : 0;
}

function elevationInRange(track: TrackPoint[], startMeters: number, endMeters: number) {
  let gain = 0;
  let loss = 0;

  for (let i = 1; i < track.length; i += 1) {
    const previous = track[i - 1];
    const current = track[i];
    if (
      previous.altitude_meters === null ||
      current.altitude_meters === null ||
      isExcludedSegment(current) ||
      current.suspicious_grade
    ) {
      continue;
    }
    const fraction = rangeOverlapFraction(previous.cumulative_meters, current.cumulative_meters, startMeters, endMeters);
    if (fraction <= 0) {
      continue;
    }
    const delta = (current.altitude_meters - previous.altitude_meters) * fraction;
    if (delta > 0) {
      gain += delta;
    } else {
      loss += Math.abs(delta);
    }
  }

  return {
    gain: round(gain, 2),
    loss: round(loss, 2),
  };
}

function averageAccuracyInRange(track: TrackPoint[], startMeters: number, endMeters: number): number | null {
  const values = track
    .filter((point) => point.cumulative_meters >= startMeters && point.cumulative_meters <= endMeters)
    .map((point) => point.horizontal_accuracy_meters)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  return roundOrNull(mean(values), 2);
}

function computeAnalysisSegments(track: TrackPoint[], activeStartElapsed: number): AnalysisSegments {
  return {
    fixed_distance_100m: buildFixedDistanceSegments(track, 100, activeStartElapsed),
    fixed_distance_200m: buildFixedDistanceSegments(track, 200, activeStartElapsed),
    fixed_distance_500m: buildFixedDistanceSegments(track, 500, activeStartElapsed),
    fixed_time_30s: buildFixedTimeSegments(track, 30, activeStartElapsed),
    detected_events: [],
    detected_loops: [],
  };
}

function buildFixedDistanceSegments(
  track: TrackPoint[],
  segmentMeters: 100 | 200 | 500,
  activeStartElapsed: number,
): AnalysisSegment[] {
  if (track.length < 2) {
    return [];
  }
  const total = track[track.length - 1].cumulative_meters;
  const segments: AnalysisSegment[] = [];
  let start = 0;
  let index = 1;
  while (start < total) {
    const end = Math.min(total, start + segmentMeters);
    segments.push(buildAnalysisSegment(track, start, end, `${segmentMeters}m_${String(index).padStart(3, "0")}`, activeStartElapsed));
    start = end;
    index += 1;
  }
  return segments;
}

function buildFixedTimeSegments(track: TrackPoint[], seconds: number, activeStartElapsed: number): AnalysisSegment[] {
  if (track.length < 2) {
    return [];
  }
  const startElapsed = track[0].t_elapsed_seconds;
  const endElapsed = track[track.length - 1].t_elapsed_seconds;
  const segments: AnalysisSegment[] = [];
  let windowStart = startElapsed;
  let index = 1;
  while (windowStart < endElapsed) {
    const windowEnd = Math.min(endElapsed, windowStart + seconds);
    const startDistance = distanceAtElapsed(track, windowStart);
    const endDistance = distanceAtElapsed(track, windowEnd);
    const segment = buildAnalysisSegment(
      track,
      startDistance ?? 0,
      endDistance ?? startDistance ?? 0,
      `30s_${String(index).padStart(3, "0")}`,
      activeStartElapsed,
    );
    const windowDuration = windowEnd - windowStart;
    const windowDistance =
      startDistance !== null && endDistance !== null ? Math.max(0, endDistance - startDistance) : null;
    segments.push({
      ...segment,
      start_recording_elapsed_seconds: round(windowStart, 2),
      end_recording_elapsed_seconds: round(windowEnd, 2),
      start_active_elapsed_seconds: round(Math.max(0, windowStart - activeStartElapsed), 2),
      end_active_elapsed_seconds: round(Math.max(0, windowEnd - activeStartElapsed), 2),
      duration_seconds: round(windowDuration, 2),
      pace_seconds_per_mile:
        windowDistance !== null && windowDistance > 0 && windowDuration > 0
          ? round(windowDuration / (windowDistance / METERS_PER_MILE), 2)
          : null,
      pace_seconds_per_km:
        windowDistance !== null && windowDistance > 0 && windowDuration > 0
          ? round(windowDuration / (windowDistance / METERS_PER_KM), 2)
          : null,
    });
    windowStart = windowEnd;
    index += 1;
  }
  return segments;
}

function buildAnalysisSegment(
  track: TrackPoint[],
  startMeters: number,
  endMeters: number,
  segmentId: string,
  activeStartElapsed: number,
): AnalysisSegment {
  const start = stateAtDistance(track, startMeters);
  const end = stateAtDistance(track, endMeters);
  const duration = start && end ? Math.max(0, end.elapsed - start.elapsed) : null;
  const distance = Math.max(0, endMeters - startMeters);
  const elevation = elevationInRange(track, startMeters, endMeters);
  const speeds = speedsInRange(track, startMeters, endMeters);
  const artifactStats = artifactStatsInRange(track, startMeters, endMeters, distance);
  const flags = segmentFlags(track, startMeters, endMeters, speeds, elevation, duration, distance, artifactStats);
  const avgGrade =
    distance >= 5 && elevation.gain !== null && elevation.loss !== null
      ? ((elevation.gain - elevation.loss) / distance) * 100
      : null;

  return {
    segment_id: segmentId,
    start_distance_meters: round(startMeters, 2),
    end_distance_meters: round(endMeters, 2),
    start_recording_elapsed_seconds: start === null ? null : round(start.elapsed, 2),
    end_recording_elapsed_seconds: end === null ? null : round(end.elapsed, 2),
    start_active_elapsed_seconds: start === null ? null : round(Math.max(0, start.elapsed - activeStartElapsed), 2),
    end_active_elapsed_seconds: end === null ? null : round(Math.max(0, end.elapsed - activeStartElapsed), 2),
    duration_seconds: duration === null ? null : round(duration, 2),
    pace_seconds_per_mile: duration !== null && distance > 0 ? round(duration / (distance / METERS_PER_MILE), 2) : null,
    pace_seconds_per_km: duration !== null && distance > 0 ? round(duration / (distance / METERS_PER_KM), 2) : null,
    elevation_gain_meters: elevation.gain,
    elevation_loss_meters: elevation.loss,
    avg_grade_percent: avgGrade === null ? null : round(avgGrade, 2),
    avg_horizontal_accuracy_meters: averageAccuracyInRange(track, startMeters, endMeters),
    speed_p50_mps: roundOrNull(percentile(speeds, 0.5), 3),
    speed_p95_mps: roundOrNull(percentile(speeds, 0.95), 3),
    artifact_excluded_point_count: artifactStats.pointCount,
    artifact_excluded_distance_meters: artifactStats.distanceMeters,
    artifact_excluded_fraction: artifactStats.fraction,
    flags,
  };
}

function artifactStatsInRange(
  track: TrackPoint[],
  startMeters: number,
  endMeters: number,
  segmentDistanceMeters: number,
) {
  let pointCount = 0;
  let distanceMeters = 0;
  for (let i = 1; i < track.length; i += 1) {
    const previous = track[i - 1];
    const current = track[i];
    if (!(current.impossible_speed || current.possible_gps_jump || current.tiny_dt_segment)) {
      continue;
    }
    const fraction = rangeOverlapFraction(previous.cumulative_meters, current.cumulative_meters, startMeters, endMeters);
    if (fraction <= 0) {
      continue;
    }
    const midpoint = (previous.cumulative_meters + current.cumulative_meters) / 2;
    if (midpoint >= startMeters && midpoint < endMeters) {
      pointCount += 1;
    }
    if (current.impossible_speed || current.possible_gps_jump) {
      distanceMeters += haversineMeters(previous, current) * fraction;
    }
  }
  return {
    pointCount,
    distanceMeters: round(distanceMeters, 2),
    fraction: segmentDistanceMeters > 0 ? round(Math.min(1, distanceMeters / segmentDistanceMeters), 4) : 0,
  };
}

function speedsInRange(track: TrackPoint[], startMeters: number, endMeters: number): number[] {
  return track
    .filter((point) => point.cumulative_meters >= startMeters && point.cumulative_meters <= endMeters)
    .map(plausibleSpeedForPoint)
    .filter(isNumber);
}

function segmentFlags(
  track: TrackPoint[],
  startMeters: number,
  endMeters: number,
  speeds: number[],
  elevation: { gain: number; loss: number },
  duration: number | null,
  distance: number,
  artifactStats: { pointCount: number; distanceMeters: number; fraction: number },
): string[] {
  const flags = new Set<string>();
  if (startMeters === 0) {
    flags.add("startup");
  }
  const points = track.filter((point) => point.cumulative_meters >= startMeters && point.cumulative_meters <= endMeters);
  if (artifactStats.fraction > SEGMENT_ARTIFACT_FRACTION_THRESHOLD) {
    flags.add("artifact_excluded");
  }
  if (points.some((point, index) => index > 0 && point.t_elapsed_seconds - points[index - 1].t_elapsed_seconds > 5)) {
    flags.add("gps_gap");
  }
  if (averageAccuracyInRange(track, startMeters, endMeters) !== null && (averageAccuracyInRange(track, startMeters, endMeters) ?? 0) > 25) {
    flags.add("low_confidence");
  }
  const p50 = percentile(speeds, 0.5);
  if ((p50 !== null && p50 < STOPPED_SPEED_THRESHOLD_MPS) || (duration !== null && distance < 5 && duration > 10)) {
    flags.add("stationary");
    flags.add("possible_interruption");
  }
  if (elevation.gain > 3 && elevation.gain > elevation.loss * 1.5) {
    flags.add("uphill");
  }
  if (elevation.loss > 3 && elevation.loss > elevation.gain * 1.5) {
    flags.add("downhill");
  }
  if (p50 !== null && p50 < 1.5 && distance >= 50) {
    flags.add("slowdown");
  }
  return [...flags];
}

function distanceAtElapsed(track: TrackPoint[], elapsed: number): number | null {
  if (track.length === 0) {
    return null;
  }
  if (elapsed <= track[0].t_elapsed_seconds) {
    return track[0].cumulative_meters;
  }
  const final = track[track.length - 1];
  if (elapsed >= final.t_elapsed_seconds) {
    return final.cumulative_meters;
  }
  for (let i = 1; i < track.length; i += 1) {
    const previous = track[i - 1];
    const current = track[i];
    if (current.t_elapsed_seconds < elapsed) {
      continue;
    }
    const dt = current.t_elapsed_seconds - previous.t_elapsed_seconds;
    const ratio = dt > 0 ? (elapsed - previous.t_elapsed_seconds) / dt : 0;
    return interpolate(previous.cumulative_meters, current.cumulative_meters, ratio);
  }
  return null;
}

function computeActivePartialPacingFeatures(
  activeTrack: TrackPoint[],
  analysisSegments: AnalysisSegments,
): ActivePartialPacingFeatures {
  const actualThirds = buildThirdSplits(activeTrack);
  const fixed500 = analysisSegments.fixed_distance_500m;
  const first500 = fixed500[0]?.pace_seconds_per_mile ?? null;
  const second500 = fixed500[1]?.pace_seconds_per_mile ?? null;
  const finalPartial = fixed500[fixed500.length - 1]?.pace_seconds_per_mile ?? null;
  const substantialPaces = fixed500
    .filter((segment) => {
      const length = (segment.end_distance_meters ?? 0) - (segment.start_distance_meters ?? 0);
      return length >= 250;
    })
    .map((segment) => segment.pace_seconds_per_mile)
    .filter(isNumber);
  const firstPace = substantialPaces[0] ?? null;
  const lastPace = substantialPaces[substantialPaces.length - 1] ?? null;
  const fade = firstPace !== null && lastPace !== null ? round(Math.max(0, lastPace - firstPace), 2) : null;
  const trend =
    firstPace === null || lastPace === null
      ? "unknown"
      : lastPace - firstPace > 15
        ? "fading"
        : firstPace - lastPace > 15
          ? "speeding_up"
          : "steady";
  const distance = activeTrack.length > 0 ? activeTrack[activeTrack.length - 1].cumulative_meters : 0;
  const confidence = distance >= 1000 && substantialPaces.length >= 2 ? "high" : distance >= 800 ? "medium" : "low";

  return {
    actual_distance_thirds: actualThirds,
    fixed_500m_trend: trend,
    first_500m_pace: first500,
    second_500m_pace: second500,
    final_partial_pace: finalPartial,
    early_fast_then_fade_detected: fade === null ? null : fade > 15,
    late_fade_seconds_per_mile: fade,
    confidence,
  };
}

function computePacingFeatures(track: TrackPoint[], thirds: SplitFeature[]) {
  const first = thirds[0]?.pace_seconds_per_mile ?? null;
  const middle = thirds[1]?.pace_seconds_per_mile ?? null;
  const final = thirds[2]?.pace_seconds_per_mile ?? null;
  const firstHalf = buildHalfSplitPace(track, 0);
  const secondHalf = buildHalfSplitPace(track, 1);
  const validThirdPaces = [first, middle, final].filter((value): value is number => value !== null);

  return {
    first_third_pace_seconds_per_mile: first,
    middle_third_pace_seconds_per_mile: middle,
    final_third_pace_seconds_per_mile: final,
    final_vs_first_delta_seconds_per_mile: first !== null && final !== null ? round(final - first, 2) : null,
    final_vs_middle_delta_seconds_per_mile: middle !== null && final !== null ? round(final - middle, 2) : null,
    late_fade_score_seconds_per_mile:
      first !== null && middle !== null && final !== null ? round(Math.max(0, final - Math.min(first, middle)), 2) : null,
    negative_split: firstHalf !== null && secondHalf !== null ? secondHalf < firstHalf : null,
    pace_variability_score: validThirdPaces.length >= 2 ? round(std(validThirdPaces), 2) : null,
  };
}

function buildHalfSplitPace(track: TrackPoint[], halfIndex: 0 | 1): number | null {
  if (track.length < 2) {
    return null;
  }
  const total = track[track.length - 1].cumulative_meters;
  if (total <= 0) {
    return null;
  }
  const start = halfIndex === 0 ? 0 : total / 2;
  const end = halfIndex === 0 ? total / 2 : total;
  const split = buildSplit(track, start, end, "half");
  return split.pace_seconds_per_mile;
}

function computeRouteFeatures(points: GpsPoint[], routeDirection: string, routeName: string) {
  const first = points[0] ?? null;
  const last = points[points.length - 1] ?? null;
  let minLat: number | null = null;
  let maxLat: number | null = null;
  let minLon: number | null = null;
  let maxLon: number | null = null;
  for (const point of points) {
    minLat = minLat === null || point.lat < minLat ? point.lat : minLat;
    maxLat = maxLat === null || point.lat > maxLat ? point.lat : maxLat;
    minLon = minLon === null || point.lon < minLon ? point.lon : minLon;
    maxLon = maxLon === null || point.lon > maxLon ? point.lon : maxLon;
  }

  return {
    start_lat: first?.lat ?? null,
    start_lon: first?.lon ?? null,
    finish_lat: last?.lat ?? null,
    finish_lon: last?.lon ?? null,
    start_finish_distance_meters: first && last ? round(haversineMeters(first, last), 2) : null,
    bounding_box: {
      min_lat: minLat,
      max_lat: maxLat,
      min_lon: minLon,
      max_lon: maxLon,
    },
    route_direction: routeDirection,
    route_name: routeName,
    route_match_score_0_to_1: null,
  };
}

function inferRouteDirection(points: GpsPoint[], userSelected: RouteDirection): RouteDirectionInference {
  if (points.length < 8) {
    return {
      user_selected: userSelected === "unknown" ? null : userSelected,
      inferred: userSelected === "unknown" ? "unknown" : userSelected,
      confidence: userSelected === "unknown" ? "unknown" : "medium",
      method: userSelected === "unknown" ? "insufficient_track" : "manual_override",
      manual_override_used: userSelected !== "unknown",
      signed_winding_radians: null,
    };
  }

  const meanLat = mean(points.map((point) => point.lat)) ?? points[0].lat;
  const meanLon = mean(points.map((point) => point.lon)) ?? points[0].lon;
  const cosLat = Math.cos(toRadians(meanLat));
  const angles = points.map((point) => {
    const x = (point.lon - meanLon) * cosLat;
    const y = point.lat - meanLat;
    return Math.atan2(y, x);
  });
  let winding = 0;
  for (let index = 1; index < angles.length; index += 1) {
    let delta = angles[index] - angles[index - 1];
    while (delta > Math.PI) {
      delta -= Math.PI * 2;
    }
    while (delta < -Math.PI) {
      delta += Math.PI * 2;
    }
    winding += delta;
  }

  const absWinding = Math.abs(winding);
  const inferred: RouteDirection = absWinding >= Math.PI ? (winding > 0 ? "counterclockwise" : "clockwise") : "unknown";
  const confidence: RouteDirectionInference["confidence"] =
    inferred === "unknown" ? "unknown" : absWinding >= Math.PI * 1.6 ? "high" : "medium";

  return {
    user_selected: userSelected === "unknown" ? null : userSelected,
    inferred,
    confidence,
    method: "signed_winding_around_route_centroid",
    manual_override_used: false,
    signed_winding_radians: round(winding, 3),
  };
}

function computeArtifactModel(points: GpsPoint[]): ArtifactModel {
  const segmentPoints = points.slice(1);
  const plausibleSpeeds = segmentPoints.map(plausibleSpeedForPoint).filter(isNumber);
  const impossible = segmentPoints.filter((point) => point.impossible_speed).length;
  const gpsJump = segmentPoints.filter((point) => point.possible_gps_jump).length;
  const tinyDt = segmentPoints.filter((point) => point.tiny_dt_segment).length;
  const lowAccuracy = segmentPoints.filter(
    (point) =>
      point.horizontal_accuracy_meters !== null &&
      point.horizontal_accuracy_meters > POOR_ACCURACY_THRESHOLD_METERS,
  ).length;
  const excludedForDistance = segmentPoints.filter(
    (point) => point.impossible_speed || point.possible_gps_jump,
  ).length;
  const notes: string[] = [];
  if (impossible > 0) {
    notes.push("Impossible-speed segments were excluded from distance, pace, elevation-grade, and max-speed calculations.");
  }
  if (gpsJump > 0) {
    notes.push("Possible GPS-jump segments were excluded from distance calculations.");
  }
  if (tinyDt > 0) {
    notes.push("Sub-0.5s GPS intervals were ignored for acceleration artifact flags.");
  }
  if (lowAccuracy > 0) {
    notes.push("Low-accuracy segments were retained with flags unless also impossible-speed artifacts.");
  }
  let maxSpeed: number | null = null;
  for (const speed of plausibleSpeeds) {
    if (maxSpeed === null || speed > maxSpeed) {
      maxSpeed = speed;
    }
  }

  return {
    raw_segment_count: segmentPoints.length,
    segments_used_for_distance: segmentPoints.length - excludedForDistance,
    segments_excluded_impossible_speed: impossible,
    segments_excluded_gps_jump: gpsJump,
    segments_excluded_tiny_dt: tinyDt,
    segments_excluded_low_accuracy: lowAccuracy,
    rolling_speed_p95_mps: roundOrNull(percentile(plausibleSpeeds, 0.95), 3),
    max_display_speed_mps: maxSpeed === null ? null : round(maxSpeed, 3),
    artifact_notes: notes,
  };
}

function computeElevationGrounding(points: GpsPoint[]): ElevationGrounding {
  const altitudePoints = points.filter((point) => point.altitude_meters !== null);
  const altitudeAccuracyPoints = altitudePoints.filter((point) => point.altitude_accuracy_meters !== null);
  const raw = computeGainLoss(points, false);
  const smoothedPoints = smoothAltitudePoints(points);
  const smoothed = computeGainLoss(smoothedPoints, true);
  const rawAvailable = altitudePoints.length >= 2;
  const altitudeAccuracyAvailable =
    altitudePoints.length > 0 && altitudeAccuracyPoints.length / altitudePoints.length >= 0.5;
  const notes: string[] = [];
  if (!rawAvailable) {
    notes.push("No usable GPS altitude sequence was available.");
  }
  if (!altitudeAccuracyAvailable) {
    notes.push("Altitude accuracy was missing for most points; confidence is capped.");
  }
  if (points.some((point) => point.suspicious_grade)) {
    notes.push("Suspicious raw grade spikes were excluded from chosen elevation metrics.");
  }
  const track = buildTrack(points);
  const distanceMeters = track.length > 0 ? track[track.length - 1].cumulative_meters : 0;
  if (distanceMeters > 0 && distanceMeters < 3000 && (smoothed.gain > 30 || smoothed.loss > 30)) {
    notes.push("Smoothed elevation gain/loss appears high for a short local route; do not use for coaching.");
  }
  const confidence: ElevationGrounding["elevation_confidence"] =
    rawAvailable && altitudeAccuracyAvailable && points.length > 50 ? "medium" : "low";

  return {
    raw_gps_altitude_available: rawAvailable,
    altitude_accuracy_available: altitudeAccuracyAvailable,
    raw_elevation_gain_meters: rawAvailable ? raw.gain : null,
    raw_elevation_loss_meters: rawAvailable ? raw.loss : null,
    smoothed_elevation_gain_meters: rawAvailable ? smoothed.gain : null,
    smoothed_elevation_loss_meters: rawAvailable ? smoothed.loss : null,
    smoothing_method: "median_or_rolling_lowpass",
    map_or_dem_elevation_available: false,
    map_or_dem_elevation_placeholder: null,
    chosen_elevation_model: rawAvailable ? "smoothed_gps" : "none",
    elevation_confidence: confidence,
    elevation_notes: notes,
  };
}

function computeGainLoss(points: GpsPoint[], skipSuspiciousGrade: boolean) {
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const current = points[i];
    if (
      previous.altitude_meters === null ||
      current.altitude_meters === null ||
      isExcludedSegment(current) ||
      (skipSuspiciousGrade && current.suspicious_grade)
    ) {
      continue;
    }
    const delta = current.altitude_meters - previous.altitude_meters;
    if (Math.abs(delta) < 0.5) {
      continue;
    }
    if (delta > 0) {
      gain += delta;
    } else {
      loss += Math.abs(delta);
    }
  }
  return { gain: round(gain, 2), loss: round(loss, 2) };
}

function smoothAltitudePoints(points: GpsPoint[]): GpsPoint[] {
  return points.map((point, index) => {
    if (point.altitude_meters === null) {
      return point;
    }
    const nearby = points
      .slice(Math.max(0, index - 2), Math.min(points.length, index + 3))
      .map((candidate) => candidate.altitude_meters)
      .filter(isNumber);
    return {
      ...point,
      altitude_meters: roundOrNull(median(nearby), 3),
    };
  });
}

function computeMotionFeatures(
  windows: MotionWindow[],
  durationSeconds: number,
  permissions: PermissionState,
  phonePosition: string,
  motionDebug: ActiveRun["motion_debug"],
) {
  const usableWindows = windows.filter((window) => hasUsableMotionWindow(window));
  const early = selectMotionWindows(usableWindows, durationSeconds, 0);
  const late = selectMotionWindows(usableWindows, durationSeconds, 2);
  const earlyMean = mean(early.map((window) => window.accel_magnitude_std).filter(isNumber));
  const lateMean = mean(late.map((window) => window.accel_magnitude_std).filter(isNumber));
  const numericAccelerationSamples = windows.reduce(
    (sum, window) => sum + (window.accel_magnitude_mean !== null ? window.sample_count : 0),
    0,
  );
  const numericGravitySamples = windows.reduce(
    (sum, window) => sum + (window.accel_including_gravity_magnitude_mean !== null ? window.sample_count : 0),
    0,
  );
  const numericRotationSamples = windows.reduce(
    (sum, window) => sum + (window.rotation_rate_magnitude_mean !== null ? window.sample_count : 0),
    0,
  );
  const usableSampleCount = usableWindows.reduce((sum, window) => sum + window.sample_count, 0);
  const motionPermission =
    permissions.device_motion_permission === "ready"
      ? "granted"
      : permissions.device_motion_permission === "unknown"
        ? motionDebug.request_status
        : permissions.device_motion_permission;
  const motionUsable = usableWindows.length > 0 && usableSampleCount >= 10;
  const motionSupportedByBrowser =
    !permissions.device_motion_available
      ? false
      : !(permissions.device_motion_permission === "ready" && motionDebug.sample_events_seen > 0 && usableSampleCount === 0);
  const unusableReason = motionUsable
    ? null
    : permissions.device_motion_available
      ? motionDebug.sample_events_seen > 0
        ? "events_present_but_numeric_fields_null_or_too_sparse"
        : "no_motion_events_observed"
      : "device_motion_unavailable";

  return {
    motion_available: permissions.device_motion_available && (permissions.device_motion_permission === "ready" || windows.length > 0),
    motion_supported_by_browser: motionSupportedByBrowser,
    motion_permission: motionPermission,
    motion_usable: motionUsable,
    motion_unusable_reason: unusableReason,
    phone_position: phonePosition,
    window_seconds: 5,
    window_count: usableWindows.length,
    usable_sample_count: usableSampleCount,
    event_count: motionDebug.sample_events_seen,
    numeric_acceleration_sample_count: numericAccelerationSamples,
    numeric_acceleration_including_gravity_sample_count: numericGravitySamples,
    numeric_rotation_rate_sample_count: numericRotationSamples,
    late_run_motion_change_score:
      earlyMean !== null && lateMean !== null ? round(lateMean - earlyMean, 4) : null,
    cadence_estimate_spm: null,
    cadence_confidence: "not_computed",
    motion_permission_debug: motionDebug,
    windows,
  };
}

function hasUsableMotionWindow(window: MotionWindow): boolean {
  return (
    window.sample_count >= 2 &&
    (window.accel_magnitude_mean !== null ||
      window.accel_including_gravity_magnitude_mean !== null ||
      window.rotation_rate_magnitude_mean !== null)
  );
}

function selectMotionWindows(windows: MotionWindow[], durationSeconds: number, thirdIndex: 0 | 1 | 2): MotionWindow[] {
  if (durationSeconds <= 0 || windows.length === 0) {
    return [];
  }
  const start = (durationSeconds / 3) * thirdIndex;
  const end = (durationSeconds / 3) * (thirdIndex + 1);
  return windows.filter((window) => {
    const midpoint = (window.window_start_elapsed_seconds + window.window_end_elapsed_seconds) / 2;
    return midpoint >= start && midpoint <= end;
  });
}

function computeDataQualityScores(
  recordingReliability: "high" | "medium" | "low",
  lifecycle: RecordingLifecycle,
  activityWindow: ActivityWindow,
  activeTargetDistanceResult: ActiveTargetDistanceResult,
  activeShortTargetResult: ActiveShortTargetResult,
  gpsQuality: Record<string, unknown>,
  activeInterpolation: InterpolationFeatures,
  elevationGrounding: ElevationGrounding,
  motion: Record<string, unknown>,
  greenLakeEnabled: boolean,
  activeDistanceMeters: number,
): DataQualityScores {
  const reasons: string[] = [];
  const activeGapOver10 = activeInterpolation.gaps.filter((gap) => gap.duration_seconds > 10).length;
  const p90Accuracy = Number(gpsQuality.p90_horizontal_accuracy_meters ?? Infinity);
  const poorAccuracyCount = Number(gpsQuality.poor_accuracy_points_count ?? 0);
  const pointCount = Number(gpsQuality.gps_point_count ?? 0);
  const poorAccuracyRatio = pointCount > 0 ? poorAccuracyCount / pointCount : 1;
  const hiddenEventCount = lifecycle.visibility_events.filter((event) => event.visibility_state === "hidden").length;
  const lifecycleIncidentCount =
    hiddenEventCount + lifecycle.pagehide_events.length + lifecycle.gps_stale_events.length;

  let activeReliability: "high" | "medium" | "low" = "high";
  if (activityWindow.inferred_activity_start_confidence === "unknown" || activeGapOver10 > 0 || poorAccuracyRatio > 0.25) {
    activeReliability = "low";
  } else if (
    activityWindow.inferred_activity_start_confidence === "low" ||
    activeInterpolation.gaps.length > 0 ||
    p90Accuracy > 15
  ) {
    activeReliability = "medium";
  }

  if (activityWindow.inferred_activity_start_confidence === "unknown") {
    reasons.push("Activity start could not be inferred.");
  }
  if (activeGapOver10 > 0) {
    reasons.push("Active window contained GPS gaps over 10 seconds.");
  }
  if (poorAccuracyRatio > 0.25) {
    reasons.push("More than 25% of active GPS points had poor accuracy.");
  }

  const targetReachedForAnalysis =
    activeTargetDistanceResult.target_reached || activeShortTargetResult.target_reached;
  const effectiveTargetConfidence =
    activeShortTargetResult.target_reached && activeShortTargetResult.confidence !== "unknown"
      ? activeShortTargetResult.confidence
      : activeTargetDistanceResult.target_distance_confidence;
  const targetConfidence =
    targetReachedForAnalysis && activeReliability === "high" && effectiveTargetConfidence === "high"
      ? "high"
      : targetReachedForAnalysis && activeReliability !== "low"
        ? "medium"
        : "low";
  const distanceConfidence =
    activeReliability === "high" && activeInterpolation.interpolation_confidence === "high"
      ? "high"
      : activeReliability === "low"
        ? "low"
        : "medium";
  const paceConfidence =
    distanceConfidence === "high" && targetConfidence !== "high" ? "medium" : distanceConfidence;
  const motionConfidence = motion.motion_usable ? "medium" : "none";
  const lifecycleReliability =
    activeGapOver10 > 0 || activeInterpolation.missing_gps_time_seconds > 30
      ? "low"
      : lifecycleIncidentCount > 0
        ? "medium"
        : "high";
  const sensorReliability =
    activeGapOver10 > 0 || poorAccuracyRatio > 0.25
      ? "low"
      : p90Accuracy <= 10 && activeInterpolation.gaps.length === 0
        ? "high"
        : "medium";
  const paceDistanceReliability =
    targetConfidence === "high" && distanceConfidence === "high" && paceConfidence === "high"
      ? "high"
      : targetConfidence === "low" || distanceConfidence === "low" || paceConfidence === "low"
        ? "low"
        : "medium";
  const motionAnalysisReliability = motionConfidence;
  const elevationAnalysisReliability = elevationGrounding.elevation_confidence;
  const analysisReliability = paceDistanceReliability;
  const usableForPacingCalibration =
    targetReachedForAnalysis && activeReliability !== "low" && distanceConfidence !== "low";
  const usableForShortPacingCalibration =
    activeDistanceMeters >= 1000 &&
    activeReliability !== "low" &&
    distanceConfidence !== "low" &&
    activeGapOver10 === 0;
  const usableForShortSpeedReserve = usableForShortPacingCalibration && activeDistanceMeters <= 3000;
  const usableForFitnessBaseline = greenLakeEnabled && usableForPacingCalibration && targetConfidence !== "low";
  const usableForMotionAnalysis = Boolean(motion.motion_usable);
  const usableForElevationAnalysis = elevationGrounding.elevation_confidence !== "low";
  const greenLakeUsable = greenLakeEnabled && usableForPacingCalibration;

  if (!targetReachedForAnalysis && !usableForShortPacingCalibration) {
    reasons.push("Target distance was not reached in the active window.");
  }
  if (!motion.motion_usable) {
    reasons.push("Motion signal was unavailable or unusable; pacing calibration can still be valid.");
  }

  return {
    recording_reliability_overall: recordingReliability,
    lifecycle_reliability: lifecycleReliability,
    sensor_reliability: sensorReliability,
    analysis_reliability: analysisReliability,
    analysis_reliability_pace_distance: paceDistanceReliability,
    analysis_reliability_motion: motionAnalysisReliability,
    analysis_reliability_elevation: elevationAnalysisReliability,
    active_window_reliability: activeReliability,
    target_distance_confidence: targetConfidence,
    pace_confidence: paceConfidence,
    distance_confidence: distanceConfidence,
    elevation_confidence: elevationGrounding.elevation_confidence,
    motion_confidence: motionConfidence,
    green_lake_calibration_usable: greenLakeUsable,
    usable_for_pacing_calibration: usableForPacingCalibration,
    usable_for_fitness_baseline: usableForFitnessBaseline,
    usable_for_motion_analysis: usableForMotionAnalysis,
    usable_for_elevation_analysis: usableForElevationAnalysis,
    usable_for_short_pacing_calibration: usableForShortPacingCalibration,
    usable_for_short_speed_reserve: usableForShortSpeedReserve,
    reasons,
  };
}

function buildShortRunDiagnostic(
  activeDistanceMeters: number,
  activeDurationSeconds: number,
  partialPacing: ActivePartialPacingFeatures,
  segments: AnalysisSegments,
  scores: DataQualityScores,
  shortTarget: ActiveShortTargetResult,
): ShortRunDiagnostic {
  const enabled = activeDistanceMeters >= 800 && activeDistanceMeters <= 3000;
  const activePaceSecondsPerMile =
    activeDistanceMeters > 0 ? round(activeDurationSeconds / (activeDistanceMeters / METERS_PER_MILE), 2) : null;
  const estimated1500 =
    shortTarget.target_distance_meters === 1500 && shortTarget.active_elapsed_at_target_seconds !== null
      ? shortTarget.active_elapsed_at_target_seconds
      : enabled && activeDistanceMeters > 0
        ? round(activeDurationSeconds * (1500 / activeDistanceMeters), 2)
        : null;
  const estimatedMile =
    enabled && activeDistanceMeters > 0
      ? round(activeDurationSeconds * (METERS_PER_MILE / activeDistanceMeters), 2)
      : null;
  const limitations: string[] = [];
  if (!enabled) {
    limitations.push("Active distance was outside the 800-3000m short-run diagnostic range.");
  }
  if (!scores.usable_for_short_pacing_calibration) {
    limitations.push(
      "Short-run pacing calibration requires at least 1000m active distance, non-low reliability, and no GPS gaps over 10s.",
    );
  }
  if (scores.motion_confidence === "none") {
    limitations.push("Motion signal was not usable; short-run interpretation is GPS-only.");
  }

  return {
    enabled,
    active_distance_meters: activeDistanceMeters > 0 ? round(activeDistanceMeters, 2) : null,
    active_duration_seconds: activeDurationSeconds > 0 ? round(activeDurationSeconds, 2) : null,
    active_pace_seconds_per_mile: activePaceSecondsPerMile,
    estimated_1500m_time_seconds: estimated1500,
    estimated_1mile_time_seconds: estimatedMile,
    fixed_500m_pattern: segments.fixed_distance_500m.map((segment) => ({
      segment_id: segment.segment_id,
      distance_meters: round(segment.end_distance_meters - segment.start_distance_meters, 2),
      duration_seconds: segment.duration_seconds,
      pace_seconds_per_mile: segment.pace_seconds_per_mile,
    })),
    pacing_pattern: pacingPatternFromPartial(partialPacing),
    short_run_usable: enabled && scores.usable_for_short_pacing_calibration,
    confidence:
      enabled && scores.usable_for_short_pacing_calibration && partialPacing.confidence === "high"
        ? "high"
        : enabled && scores.usable_for_short_pacing_calibration
          ? "medium"
          : "low",
    limitations,
  };
}

function pacingPatternFromPartial(partialPacing: ActivePartialPacingFeatures): ShortRunDiagnostic["pacing_pattern"] {
  if (partialPacing.fixed_500m_trend === "fading") {
    return "positive_split";
  }
  if (partialPacing.fixed_500m_trend === "speeding_up") {
    return "negative_split";
  }
  if (partialPacing.fixed_500m_trend === "steady") {
    return "even";
  }
  return "unknown";
}

function computeInferredRunFacts(
  activityWindow: ActivityWindow,
  activeTargetDistanceResult: ActiveTargetDistanceResult,
  activePacing: Record<string, unknown>,
  activeInterpolation: InterpolationFeatures,
  lifecycle: RecordingLifecycle,
  elevationGrounding: ElevationGrounding,
  motion: Record<string, unknown>,
  routeId: string | null,
  routeDirection: RouteDirection,
  routeSnapping: RouteSnapping,
  weatherAvailable: boolean,
): InferredRunFacts {
  const idle = activityWindow.idle_preamble_seconds;
  const lateFade = nullableBooleanFromNumber(activePacing.late_fade_score_seconds_per_mile, 15);
  const negativeSplit =
    typeof activePacing.negative_split === "boolean" ? activePacing.negative_split : null;
  const firstPace = asNumber(activePacing.first_third_pace_seconds_per_mile);
  const middlePace = asNumber(activePacing.middle_third_pace_seconds_per_mile);
  const finalPace = asNumber(activePacing.final_third_pace_seconds_per_mile);
  const activeStart = activityWindow.inferred_activity_start_elapsed_seconds ?? 0;
  const activeEnd = activityWindow.inferred_activity_end_elapsed_seconds ?? Infinity;
  const hiddenDuringActive = lifecycle.visibility_events.some(
    (event) =>
      event.visibility_state === "hidden" &&
      event.t_elapsed_seconds !== null &&
      event.t_elapsed_seconds >= activeStart &&
      event.t_elapsed_seconds <= activeEnd,
  );

  return {
    started_late: idle === null ? null : idle >= 10,
    idle_preamble_seconds: idle,
    route_id: routeId,
    route_direction: routeDirection,
    target_reached: activeTargetDistanceResult.target_reached,
    overshoot_meters: activeTargetDistanceResult.overshoot_meters,
    late_fade_detected: lateFade,
    negative_split_detected: negativeSplit,
    first_segment_faster_than_later:
      firstPace !== null && middlePace !== null && finalPace !== null ? firstPace < Math.min(middlePace, finalPace) : null,
    first_segment_slower_than_later:
      firstPace !== null && middlePace !== null && finalPace !== null ? firstPace > Math.max(middlePace, finalPace) : null,
    stop_or_slowdown_events: [],
    slowdown_events: [],
    probable_interruptions: [],
    gps_gaps_during_active_window: activeInterpolation.gaps,
    off_route_events: [],
    recording_backgrounded_during_active_window: hiddenDuringActive,
    route_direction_inferred: routeDirection,
    loop_count_inferred: routeSnapping.loop_count,
    elevation_gain_loss_available: elevationGrounding.smoothed_elevation_gain_meters !== null,
    weather_context_available: weatherAvailable,
    motion_usable: Boolean(motion.motion_usable),
  };
}

function buildTargetedFollowups(
  facts: InferredRunFacts,
  segments: AnalysisSegments,
  activityWindow: ActivityWindow,
): TargetedFollowupPrompt[] {
  const prompts: TargetedFollowupPrompt[] = [];
  if (facts.started_late && facts.idle_preamble_seconds !== null) {
    prompts.push({
      id: "confirm_idle_preamble",
      prompt: `I detected about ${Math.round(facts.idle_preamble_seconds)} seconds before real movement. Exclude that from run analysis?`,
      default_answer: "yes",
      reason: "GPS speed and displacement indicate stationary preamble.",
    });
  }
  const slowSegment = segments.fixed_distance_100m.find((segment) => segment.flags.includes("slowdown"));
  if (slowSegment) {
    prompts.push({
      id: `slowdown_event_${Math.round(slowSegment.start_distance_meters)}m`,
      prompt: `I detected a slowdown around ${Math.round(slowSegment.start_distance_meters)}m. Was that traffic, breathing, legs, or intentional?`,
      reason: "Segment pace dropped relative to plausible running speed.",
    });
  }
  const longGap = facts.gps_gaps_during_active_window.find((gap) => gap.duration_seconds > 10);
  if (longGap) {
    prompts.push({
      id: "confirm_gps_gap_context",
      prompt: `I detected a ${Math.round(longGap.duration_seconds)} second GPS gap during the active window. Did the app leave the foreground?`,
      reason: "Long active-window GPS gaps reduce pace and distance confidence.",
    });
  }
  if (activityWindow.inferred_activity_start_confidence === "low") {
    prompts.push({
      id: "confirm_activity_start",
      prompt: "I could not confidently detect the true movement start. Was the timer started immediately before running?",
      reason: "Activity-window inference used a low-confidence fallback.",
    });
  }
  return prompts.slice(0, 1);
}

function buildRouteConfirmationPrompt(
  routeTruth: RouteTruth,
  routeSnapping: RouteSnapping,
): RouteConfirmationPrompt | null {
  if (routeSnapping.route_id !== "home_block_short_loop_v1") {
    return null;
  }
  const alreadyConfirmed = routeTruth.routeId
    ? loadStoredRouteMemory(routeTruth.routeId)?.calibration_status === "confirmed"
    : false;
  const projectionAvailable = routeSnapping.p90_projection_error_meters !== null;
  const projectionOk = !projectionAvailable || (routeSnapping.p90_projection_error_meters ?? 0) <= 35;
  if (alreadyConfirmed || !projectionOk) {
    return null;
  }
  return {
    id: "confirm_home_block_short_route",
    route_id: "home_block_short_loop_v1",
    prompt: "Use this as your confirmed home-block short route?",
    reason: projectionAvailable
      ? "The route was classified as home-block short route and projection errors against the stored fingerprint were low."
      : "The route was classified as home-block short route; confirming stores this run as its first fingerprint.",
    eligible: true,
    default_answer: "yes",
  };
}

function buildGreenLakeCalibration(
  enabled: boolean,
  points: GpsPoint[],
  distanceMeters: number,
  route: Record<string, unknown>,
  routeDirection: RouteDirectionInference,
): GreenLakeCalibration {
  const first = points[0] ?? null;
  const last = points[points.length - 1] ?? null;
  return {
    enabled,
    calibration_run_number: enabled ? 1 : 0,
    start_point: first ? pickCoursePoint(first) : null,
    finish_point: last ? pickCoursePoint(last) : null,
    route_direction_user_selected: routeDirection.user_selected ?? "unknown",
    route_direction_inferred: routeDirection.inferred,
    course_fingerprint: {
      bounding_box: (route.bounding_box as Record<string, number | null> | undefined) ?? null,
      polyline_simplified: points.length > 0 ? simplifyPolyline(points) : null,
      distance_meters: points.length > 0 ? round(distanceMeters, 2) : null,
      start_finish_distance_meters: (route.start_finish_distance_meters as number | null | undefined) ?? null,
    },
    known_route_match_score_0_to_1: null,
    course_saved_for_future_matching: enabled,
  };
}

interface RouteTruth {
  greenLakeEnabled: boolean;
  routeType: "green_lake_calibration" | "home_block_or_short_route" | RunMode;
  routeId: string | null;
  saveForFutureMatching: boolean;
  nearGreenLake: boolean;
  shortCue: boolean;
  notes: string[];
}

function classifyRoute(
  preRun: PreRunState,
  activeDistanceMeters: number,
  recordedDistanceMeters: number,
  points: GpsPoint[],
): RouteTruth {
  const routeText = `${preRun.route_name} ${preRun.free_text}`.toLowerCase();
  const shortCue = /\b(home block|short run|test run|block|sidewalk|short diagnostic)\b/.test(routeText);
  const greenLakeName = preRun.route_name.toLowerCase().includes("green lake");
  const targetIs5k = Math.abs(preRun.intended_distance_meters - 5000) <= TARGET_DISTANCE_TOLERANCE_METERS;
  const nearGreenLake = points.some(
    (point) => point.lat >= 47.67 && point.lat <= 47.69 && point.lon >= -122.35 && point.lon <= -122.325,
  );
  const explicitGreenLake = preRun.mode === "green_lake_5k_calibration" && !shortCue;
  const strongGreenLakeSignal = targetIs5k && activeDistanceMeters > 4500 && nearGreenLake && !shortCue;
  const greenLakeEnabled = explicitGreenLake || strongGreenLakeSignal;
  const routeType = greenLakeEnabled
    ? "green_lake_calibration"
    : shortCue || activeDistanceMeters < 3000
      ? "home_block_or_short_route"
      : preRun.mode;
  const routeId = routeType === "home_block_or_short_route" ? "home_block_short_loop_v1" : greenLakeEnabled ? "green_lake_5k_v1" : null;
  const notes: string[] = [];
  if (shortCue && greenLakeName) {
    notes.push("Short/home-block language overrode Green Lake route name.");
  }
  if (greenLakeName && !greenLakeEnabled) {
    notes.push("Green Lake name alone did not enable Green Lake calibration.");
  }
  if (greenLakeName && targetIs5k && activeDistanceMeters > 4500 && !nearGreenLake) {
    notes.push("Route did not fall inside the rough Green Lake area check.");
  }
  if (points.length > 0 && recordedDistanceMeters < 3000) {
    notes.push("Route fingerprint was treated as a short/local route.");
  }
  return {
    greenLakeEnabled,
    routeType,
    routeId,
    saveForFutureMatching: Boolean(routeId),
    nearGreenLake,
    shortCue,
    notes,
  };
}

function buildRunClassification(
  routeTruth: RouteTruth,
  preRun: PreRunState,
  activeDistanceMeters: number,
  recordedDistanceMeters: number,
  points: GpsPoint[],
): RunClassification {
  const startFinish = points.length > 1 ? haversineMeters(points[0], points[points.length - 1]) : null;
  const smallLoop = startFinish !== null && startFinish < 120 && activeDistanceMeters >= 800 && activeDistanceMeters <= 3000;
  const reasons = [...routeTruth.notes];
  const manualOverrides: string[] = [];
  if (preRun.mode !== "record_mode") {
    manualOverrides.push(`pre_run.mode=${preRun.mode}`);
  }
  if (routeTruth.greenLakeEnabled) {
    reasons.push(routeTruth.nearGreenLake ? "Track fell inside the Green Lake area and covered a near-5K distance." : "User selected Green Lake calibration mode.");
    return {
      inferred_mode: "green_lake_5k_calibration",
      inferred_route_type: "known_course",
      route_id: "green_lake_5k_v1",
      route_confidence: routeTruth.nearGreenLake && activeDistanceMeters > 4500 ? "high" : "medium",
      mode_confidence: routeTruth.nearGreenLake && activeDistanceMeters > 4500 ? "high" : "medium",
      reasons,
      manual_overrides: manualOverrides,
    };
  }
  if (preRun.mode === "instrumentation_validation") {
    reasons.push("User selected instrumentation validation mode.");
    return {
      inferred_mode: "instrumentation_validation",
      inferred_route_type: "instrumentation_validation",
      route_id: null,
      route_confidence: "medium",
      mode_confidence: "high",
      reasons,
      manual_overrides: manualOverrides,
    };
  }
  if (routeTruth.shortCue || smallLoop || (activeDistanceMeters >= 800 && activeDistanceMeters <= 3000 && recordedDistanceMeters < 3200)) {
    reasons.push(smallLoop ? "Start/finish proximity and active distance indicate a short loop route." : "Active distance fits short-run diagnostic range.");
    return {
      inferred_mode: "short_run_diagnostic",
      inferred_route_type: "home_block_or_short_route",
      route_id: "home_block_short_loop_v1",
      route_confidence: smallLoop || routeTruth.shortCue ? "high" : "medium",
      mode_confidence: activeDistanceMeters >= 800 ? "high" : "medium",
      reasons,
      manual_overrides: manualOverrides,
    };
  }
  if (preRun.intended_distance_meters <= 500 && recordedDistanceMeters <= 700) {
    reasons.push("Very short target and recorded distance indicate instrumentation validation.");
    return {
      inferred_mode: "instrumentation_validation",
      inferred_route_type: "instrumentation_validation",
      route_id: null,
      route_confidence: "medium",
      mode_confidence: "high",
      reasons,
      manual_overrides: manualOverrides,
    };
  }
  return {
    inferred_mode: "free_run",
    inferred_route_type: "free_run",
    route_id: null,
    route_confidence: points.length > 0 ? "low" : "unknown",
    mode_confidence: points.length > 0 ? "low" : "unknown",
    reasons: reasons.length > 0 ? reasons : ["No known-route or short-run classifier reached medium confidence."],
    manual_overrides: manualOverrides,
  };
}

function inferTargetDistance(preRun: PreRunState, classification: RunClassification): TargetInference {
  if (classification.inferred_mode === "green_lake_5k_calibration") {
    return {
      target_distance_meters: 5000,
      source: "inferred_from_route_and_patch",
      confidence: "high",
      manual_override_used: false,
    };
  }
  if (classification.inferred_mode === "short_run_diagnostic") {
    return {
      target_distance_meters: preRun.intended_distance_meters >= 800 && preRun.intended_distance_meters <= 3000 ? preRun.intended_distance_meters : 1500,
      source: "inferred_from_route",
      confidence: classification.mode_confidence === "high" ? "medium" : "low",
      manual_override_used: false,
    };
  }
  if (preRun.active_patch_id === "controlled_start_v1") {
    return {
      target_distance_meters: 5000,
      source: "inferred_from_patch",
      confidence: "medium",
      manual_override_used: false,
    };
  }
  return {
    target_distance_meters: preRun.intended_distance_meters > 0 ? preRun.intended_distance_meters : null,
    source: preRun.intended_distance_meters > 0 ? "manual_override" : "none",
    confidence: preRun.intended_distance_meters > 0 ? "low" : "unknown",
    manual_override_used: preRun.intended_distance_meters > 0,
  };
}

function computeRouteSnapping(
  routeTruth: RouteTruth,
  classification: RunClassification,
  points: GpsPoint[],
  activeDistanceMeters: number,
  recordedDistanceMeters: number,
): RouteSnapping {
  const greenLakeSnapped = routeTruth.greenLakeEnabled && classification.route_confidence === "high" && activeDistanceMeters >= 4990;
  const routeId = classification.route_id;
  const storedRoute = routeId ? loadStoredRouteMemory(routeId) : null;
  const storedRoutePolyline = storedRoute?.polyline ?? null;
  const routeConfirmed = storedRoute?.calibration_status === "confirmed";
  const projection =
    storedRoutePolyline && storedRoutePolyline.length >= 2
      ? computeProjectionDiagnostics(points, storedRoutePolyline)
      : null;
  const projectionStatsAvailable = projection !== null && projection.errorCount > 0;
  const p90Projection = projection?.p90_projection_error_meters ?? null;
  const onStoredRoute = projectionStatsAvailable && p90Projection !== null && p90Projection <= 35;
  const lowProjectionError = onStoredRoute && p90Projection !== null && p90Projection <= 20;
  const homeBlockEligible = Boolean(
    routeId === "home_block_short_loop_v1" &&
      routeConfirmed &&
      storedRoutePolyline &&
      activeDistanceMeters >= 800 &&
      onStoredRoute,
  );
  const snappedDistance = greenLakeSnapped
    ? 5000
    : homeBlockEligible && storedRoute?.loop_length_meters
      ? estimateRouteSnappedDistance(activeDistanceMeters, storedRoute.loop_length_meters)
      : null;
  const homeBlockSnapped = homeBlockEligible && snappedDistance !== null;
  const snappingEnabled = greenLakeSnapped || homeBlockSnapped;
  const highConfidenceSnap = snappingEnabled && lowProjectionError;
  const snapConfidence: RouteSnapping["confidence"] = highConfidenceSnap
    ? "high"
    : snappingEnabled || classification.route_confidence === "high"
      ? "medium"
      : "low";
  const loopLength = storedRoute?.loop_length_meters ?? null;
  return {
    enabled: snappingEnabled,
    route_id: routeId,
    route_prior_strength: snappingEnabled ? "high" : classification.route_confidence === "medium" ? "medium" : "none",
    raw_gps_distance_meters: points.length > 0 ? round(recordedDistanceMeters, 2) : null,
    artifact_filtered_gps_distance_meters: points.length > 0 ? round(activeDistanceMeters, 2) : null,
    snapped_distance_meters: snappedDistance === null ? null : round(snappedDistance, 2),
    distance_basis: snappingEnabled ? "route_snapped" : "artifact_filtered_gps",
    median_projection_error_meters: projection?.median_projection_error_meters ?? null,
    p90_projection_error_meters: projection?.p90_projection_error_meters ?? null,
    max_projection_error_meters: projection?.max_projection_error_meters ?? null,
    projection_error_by_segment: projection?.projection_error_by_segment ?? [],
    off_route_event_count: projection?.off_route_event_count ?? 0,
    route_progress_meters: snappedDistance !== null ? round(snappedDistance, 2) : activeDistanceMeters > 0 ? round(activeDistanceMeters, 2) : null,
    loop_count: greenLakeSnapped
      ? 1
      : homeBlockEligible && loopLength !== null && loopLength > 0
        ? Math.max(1, Math.round(activeDistanceMeters / loopLength))
        : null,
    confidence: snapConfidence,
    notes: greenLakeSnapped
      ? [
          "Known-route snapping used Green Lake 5K prior distance because route confidence was high.",
          projectionStatsAvailable
            ? "Projection-error stats were computed against the stored route fingerprint."
            : "No stored route fingerprint was available, so route-snap confidence was capped below high.",
        ]
      : homeBlockSnapped
        ? [
            "Confirmed home-block route snapping used the stored route fingerprint.",
            "Projection-error stats were computed against the stored route fingerprint.",
          ]
        : homeBlockEligible
          ? ["Active distance was not close to a whole number of stored loops, so artifact-filtered GPS distance was retained."]
          : routeId === "home_block_short_loop_v1" && routeConfirmed && storedRoutePolyline && !onStoredRoute
            ? ["Projection error against the stored route fingerprint was too high, so route snapping was disabled."]
            : ["Route snapping retained artifact-filtered GPS distance until a confirmed route polyline is available."],
  };
}

function estimateRouteSnappedDistance(activeDistanceMeters: number, loopLengthMeters: number): number | null {
  if (loopLengthMeters <= 0 || activeDistanceMeters <= 0) {
    return null;
  }
  const wholeLoops = Math.max(1, Math.round(activeDistanceMeters / loopLengthMeters));
  const snapped = wholeLoops * loopLengthMeters;
  const tolerance = Math.max(30, loopLengthMeters * 0.07);
  return Math.abs(activeDistanceMeters - snapped) <= tolerance ? snapped : null;
}

function buildRouteLibrary(
  routeTruth: RouteTruth,
  points: GpsPoint[],
  distanceMeters: number,
  runId: string,
): RouteLibrary {
  if (!routeTruth.routeId || points.length < 2) {
    return { routes: [] };
  }
  const storedRoute = loadStoredRouteMemory(routeTruth.routeId);
  const calibrationStatus = routeTruth.greenLakeEnabled
    ? "learned"
    : storedRoute?.calibration_status ?? "needs_user_confirmation";
  return {
    routes: [
      {
        route_id: routeTruth.routeId,
        type: routeTruth.greenLakeEnabled ? "known_course" : "sidewalk_loop",
        polyline: simplifyPolyline(points),
        distance_meters: routeTruth.greenLakeEnabled ? 5000 : round(distanceMeters, 2),
        loop_length_meters: routeTruth.greenLakeEnabled ? null : storedRoute?.loop_length_meters ?? round(distanceMeters, 2),
        start_zones: buildCrossingZones(points[0] ?? null),
        finish_zones: buildCrossingZones(points[points.length - 1] ?? null),
        aliases: routeTruth.greenLakeEnabled ? ["Green Lake calibrated 5K"] : ["Home block short route"],
        calibration_status: calibrationStatus,
        created_from_run_id: runId,
        confidence: routeTruth.greenLakeEnabled ? "medium" : calibrationStatus === "confirmed" ? "high" : "low",
      },
    ],
  };
}

function loadStoredRouteMemory(routeId: string): {
  polyline: Array<[number, number]> | null;
  calibration_status: "learned" | "needs_user_confirmation" | "confirmed" | null;
  loop_length_meters: number | null;
  best_short_1500m_estimate_seconds: number | null;
} | null {
  try {
    const raw = localStorage.getItem(ROUTE_MEMORY_KEY_FOR_MATH);
    if (!raw) {
      return null;
    }
    const routeMemory = JSON.parse(raw) as Record<
      string,
      {
        course_fingerprint?: { polyline_simplified?: unknown };
        calibration_status?: unknown;
        loop_length_meters?: unknown;
        best_short_1500m_estimate_seconds?: unknown;
      }
    >;
    const memory = routeMemory[routeId];
    if (!memory) {
      return null;
    }
    const polyline = memory.course_fingerprint?.polyline_simplified;
    const parsed = Array.isArray(polyline)
      ? polyline
          .map((pair): [number, number] | null => {
            if (!Array.isArray(pair) || pair.length < 2) {
              return null;
            }
            const lat = Number(pair[0]);
            const lon = Number(pair[1]);
            return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null;
          })
          .filter((pair): pair is [number, number] => pair !== null)
      : [];
    const calibrationStatus =
      memory.calibration_status === "confirmed" ||
      memory.calibration_status === "learned" ||
      memory.calibration_status === "needs_user_confirmation"
        ? memory.calibration_status
        : null;
    const loopLength = Number(memory.loop_length_meters);
    const bestShort = Number(memory.best_short_1500m_estimate_seconds);
    return {
      polyline: parsed.length >= 2 ? parsed : null,
      calibration_status: calibrationStatus,
      loop_length_meters: Number.isFinite(loopLength) && loopLength > 0 ? loopLength : null,
      best_short_1500m_estimate_seconds: Number.isFinite(bestShort) && bestShort > 0 ? bestShort : null,
    };
  } catch {
    return null;
  }
}

function buildCrossingZones(point: GpsPoint | null): Record<string, unknown>[] {
  if (!point) {
    return [];
  }
  return [
    {
      lat: round(point.lat, 6),
      lon: round(point.lon, 6),
      radius_meters: 25,
      source: "run_endpoint",
    },
  ];
}

function computeProjectionDiagnostics(points: GpsPoint[], polyline: Array<[number, number]>) {
  if (points.length === 0 || polyline.length < 2) {
    return null;
  }

  const origin = { lat: polyline[0][0], lon: polyline[0][1] };
  const routePoints = polyline.map(([lat, lon]) => latLonToMeters(lat, lon, origin));
  const track = buildTrack(points);
  const errors = points.map((point) => {
    const xy = latLonToMeters(point.lat, point.lon, origin);
    return minDistanceToPolylineMeters(xy, routePoints);
  });
  const validErrors = errors.filter(isNumber);

  if (validErrors.length === 0) {
    return null;
  }

  const totalDistance = track.length > 0 ? track[track.length - 1].cumulative_meters : 0;
  const segmentSize = 1000;
  const projection_error_by_segment: RouteSnapping["projection_error_by_segment"] = [];
  for (let start = 0, index = 1; start < totalDistance; start += segmentSize, index += 1) {
    const end = Math.min(totalDistance, start + segmentSize);
    const segmentErrors = track
      .map((point, pointIndex) => ({ point, error: errors[pointIndex] }))
      .filter(
        ({ point, error }) =>
          point.cumulative_meters >= start && (point.cumulative_meters < end || end === totalDistance) && isNumber(error),
      )
      .map(({ error }) => error);
    projection_error_by_segment.push({
      segment_id: `projection_${index}`,
      start_distance_meters: round(start, 2),
      end_distance_meters: round(end, 2),
      median_projection_error_meters: roundOrNull(median(segmentErrors), 2),
      p90_projection_error_meters: roundOrNull(percentile(segmentErrors, 0.9), 2),
      max_projection_error_meters:
        segmentErrors.length > 0 ? round(segmentErrors.reduce((a, b) => (b > a ? b : a), 0), 2) : null,
    });
  }

  return {
    errorCount: validErrors.length,
    median_projection_error_meters: roundOrNull(median(validErrors), 2),
    p90_projection_error_meters: roundOrNull(percentile(validErrors, 0.9), 2),
    max_projection_error_meters: round(validErrors.reduce((a, b) => (b > a ? b : a), 0), 2),
    off_route_event_count: validErrors.filter((error) => error > 35).length,
    projection_error_by_segment,
  };
}

function latLonToMeters(lat: number, lon: number, origin: { lat: number; lon: number }) {
  const metersPerDegreeLat = 111_320;
  const metersPerDegreeLon = 111_320 * Math.cos(toRadians(origin.lat));
  return {
    x: (lon - origin.lon) * metersPerDegreeLon,
    y: (lat - origin.lat) * metersPerDegreeLat,
  };
}

function minDistanceToPolylineMeters(
  point: { x: number; y: number },
  polyline: Array<{ x: number; y: number }>,
): number {
  let best = Infinity;
  for (let i = 1; i < polyline.length; i += 1) {
    best = Math.min(best, distanceToSegmentMeters(point, polyline[i - 1], polyline[i]));
  }
  return best;
}

function distanceToSegmentMeters(
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }
  const rawT = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
  const t = Math.max(0, Math.min(1, rawT));
  const projection = { x: start.x + t * dx, y: start.y + t * dy };
  return Math.hypot(point.x - projection.x, point.y - projection.y);
}

function buildMeasurementReconciliation(
  durationSeconds: number,
  activeDurationSeconds: number,
  interpolation: InterpolationFeatures,
  activeInterpolation: InterpolationFeatures,
  routeSnapping: RouteSnapping,
  routeSnappedSummary: RouteSnappedShortSummary,
  scores: DataQualityScores,
): MeasurementReconciliation {
  const chosenBasis =
    routeSnapping.distance_basis === "route_snapped"
      ? "route_snapped"
      : scores.distance_confidence === "high"
        ? "active_gps"
        : "artifact_filtered_gps";
  return {
    distance_estimates: {
      raw_gps: interpolation.raw_recorded_distance_meters,
      artifact_filtered_gps: activeInterpolation.raw_recorded_distance_meters,
      route_snapped: routeSnapping.snapped_distance_meters ?? routeSnappedSummary.route_snapped_distance_meters,
      provider_speed_integral: null,
      external_app: null,
    },
    time_estimates: {
      recording_elapsed: round(durationSeconds, 2),
      active_elapsed: round(activeDurationSeconds, 2),
      external_app: null,
    },
    chosen_basis: chosenBasis,
    confidence: routeSnapping.confidence === "high" || scores.distance_confidence === "high" ? "high" : scores.distance_confidence,
    notes: routeSnapping.distance_basis === "route_snapped"
      ? ["Route-snapped distance is the preferred basis for this export."]
      : ["Artifact-filtered active GPS remains the preferred basis until route snapping is confirmed."],
  };
}

function buildRouteSnappedShortSummary(
  routeSnapping: RouteSnapping,
  activeTrack: TrackPoint[],
  activeDurationSeconds: number,
  shortTarget: ActiveShortTargetResult,
): RouteSnappedShortSummary {
  const enabled =
    routeSnapping.enabled &&
    routeSnapping.route_id === "home_block_short_loop_v1" &&
    routeSnapping.distance_basis === "route_snapped";
  const routeDistance = routeSnapping.snapped_distance_meters ?? null;
  const routeMemory = routeSnapping.route_id ? loadStoredRouteMemory(routeSnapping.route_id) : null;
  const loopLength = routeMemory?.loop_length_meters ?? null;
  const wholeLoops =
    loopLength !== null && routeDistance !== null && loopLength > 0
      ? Math.floor(routeDistance / loopLength + 1e-6)
      : null;
  const loopCount = wholeLoops !== null ? Math.max(1, wholeLoops) : routeSnapping.loop_count;
  const loopProgress =
    wholeLoops !== null && routeDistance !== null && loopLength !== null
      ? round(Math.max(0, routeDistance - wholeLoops * loopLength), 2)
      : null;
  const trackFallback1500 =
    activeTrack.length > 1 && (routeDistance ?? 0) >= 1500
      ? (() => {
          const targetState = stateAtDistance(activeTrack, 1500);
          const activeStart = activeTrack[0]?.t_elapsed_seconds ?? 0;
          return targetState ? round(Math.max(0, targetState.elapsed - activeStart), 2) : null;
        })()
      : null;
  const target1500 =
    shortTarget.target_distance_meters === 1500 && shortTarget.active_elapsed_at_target_seconds !== null
      ? shortTarget.active_elapsed_at_target_seconds
      : trackFallback1500;

  return {
    enabled,
    route_id: routeSnapping.route_id,
    route_snapped_distance_meters: enabled ? routeDistance : null,
    route_snapped_duration_seconds: enabled ? round(activeDurationSeconds, 2) : null,
    route_snapped_1500m_time_seconds: enabled ? target1500 : null,
    loop_length_meters: loopLength,
    loop_count: loopCount,
    loop_progress_meters: loopProgress,
    confidence: enabled ? routeSnapping.confidence : "unknown",
    notes: enabled
      ? ["Confirmed short-route snapping is available for this run."]
      : ["Short-route snapping is disabled until the home-block route is confirmed."],
  };
}

function buildRouteSnappedSplits(activeTrack: TrackPoint[], enabled: boolean) {
  if (!enabled) {
    return {
      fixed_100m: [],
      fixed_200m: [],
      fixed_500m: [],
    };
  }
  const distance = activeTrack.length > 0 ? activeTrack[activeTrack.length - 1].cumulative_meters : 0;
  return {
    fixed_100m: buildRepeatingSplitsToDistance(activeTrack, 100, "route_snapped_100m", distance),
    fixed_200m: buildRepeatingSplitsToDistance(activeTrack, 200, "route_snapped_200m", distance),
    fixed_500m: buildRepeatingSplitsToDistance(activeTrack, 500, "route_snapped_500m", distance),
  };
}

function buildUsability(
  scores: DataQualityScores,
  greenLakeEnabled: boolean,
  shortRun: ShortRunDiagnostic,
  routeTruth: RouteTruth,
  activeTargetDistanceResult: ActiveTargetDistanceResult,
): Usability {
  const usableForPacing = scores.usable_for_pacing_calibration || shortRun.short_run_usable;
  const usableForFitness = greenLakeEnabled && activeTargetDistanceResult.target_reached && scores.pace_confidence !== "low";
  return {
    usable_for_pacing_calibration: scores.usable_for_pacing_calibration,
    usable_for_fitness_baseline: usableForFitness,
    usable_for_short_run_diagnostic: shortRun.short_run_usable,
    usable_for_motion_analysis: scores.usable_for_motion_analysis,
    usable_for_elevation_analysis: scores.usable_for_elevation_analysis ? true : "low_confidence",
    usable_for_route_learning: Boolean(routeTruth.routeId),
    usable_for_coach_update: usableForPacing || usableForFitness,
    reasons: scores.reasons,
  };
}

function buildGroundedDebriefContext(
  run: ActiveRun,
  activityWindow: ActivityWindow,
  activeTargetDistanceResult: ActiveTargetDistanceResult,
  facts: InferredRunFacts,
  scores: DataQualityScores,
  prompts: TargetedFollowupPrompt[],
): GroundedDebriefContext {
  const objectiveFacts: string[] = [];
  const limitations: string[] = [...scores.reasons];
  if (activityWindow.idle_preamble_seconds !== null) {
    objectiveFacts.push(`Inferred ${Math.round(activityWindow.idle_preamble_seconds)}s idle preamble before active running.`);
  }
  if (activeTargetDistanceResult.target_reached) {
    const targetElapsed = activeTargetDistanceResult.active_elapsed_at_target_distance_seconds;
    objectiveFacts.push(
      targetElapsed !== null
        ? `Target ${Math.round(activeTargetDistanceResult.intended_distance_meters)}m reached at active_elapsed_at_target_distance_seconds = ${targetElapsed}.`
        : `Target ${Math.round(activeTargetDistanceResult.intended_distance_meters)}m was reached, but time at target could not be derived.`,
    );
  } else {
    objectiveFacts.push(`Target ${Math.round(activeTargetDistanceResult.intended_distance_meters)}m was not reached in active analysis.`);
  }
  if (facts.late_fade_detected !== null) {
    objectiveFacts.push(facts.late_fade_detected ? "Active-window segments indicate late fade." : "Active-window segments do not indicate late fade.");
  }
  if (facts.gps_gaps_during_active_window.length === 0) {
    objectiveFacts.push("No active-window GPS gaps over 5s.");
  }

  const subjectiveInputs = [
    run.post_run.rpe_1_to_10 === null
      ? null
      : `RPE = ${run.post_run.rpe_1_to_10} (${run.post_run.rpe_estimation_source})`,
    run.post_run.perceived_effort_simple === "unknown"
      ? null
      : `Simple effort = ${run.post_run.perceived_effort_simple}`,
    run.post_run.energy_after_run_1_to_5 === null ? null : `Energy after = ${run.post_run.energy_after_run_1_to_5}`,
    run.post_run.primary_limiter === "unknown" ? null : `Primary limiter = ${run.post_run.primary_limiter}`,
    run.post_run.pain_after_run.present ? `Pain = ${run.post_run.pain_after_run.location ?? "present"}` : "Pain = false",
  ].filter((value): value is string => value !== null);

  return {
    objective_facts: objectiveFacts,
    subjective_inputs: subjectiveInputs,
    conflicts_or_tensions: [],
    suggested_followup_questions: prompts.map((prompt) => prompt.prompt),
    coach_safe_summary: {
      usable_for_fitness_update: scores.usable_for_fitness_baseline,
      usable_for_pacing_update: scores.usable_for_pacing_calibration && scores.pace_confidence !== "low",
      usable_for_app_debug: true,
      primary_data_limitations: limitations,
    },
  };
}

function buildPatchExecutionAssessment(
  preRun: PreRunState,
  activeTargetSplits: ActiveTargetSplits,
): PatchExecutionAssessment {
  const isControlledStart = preRun.active_patch_id === "controlled_start_v1";
  const intendedStrategy = buildCurrentPatch(preRun.active_patch_id).strategy;
  const actualSplits = activeTargetSplits.kilometers.slice(0, 5).map((split, index) => {
    const band = isControlledStart ? CONTROLLED_START_BANDS_FOR_MATH[index] ?? null : null;
    const paceSecondsPerKm =
      split.duration_seconds !== null && split.distance_meters !== null && split.distance_meters > 0
        ? round(split.duration_seconds / (split.distance_meters / METERS_PER_KM), 2)
        : null;
    let status: PatchExecutionAssessment["actual_splits"][number]["status"] = "unknown";
    if (!band || band.minSecondsPerKm === null || band.maxSecondsPerKm === null) {
      status = "not_applicable";
    } else if (paceSecondsPerKm === null) {
      status = "unknown";
    } else if (paceSecondsPerKm < band.minSecondsPerKm) {
      status = "too_fast";
    } else if (paceSecondsPerKm > band.maxSecondsPerKm) {
      status = "too_slow";
    } else {
      status = "in_band";
    }

    return {
      split_id: `km_${index + 1}`,
      distance_meters: split.distance_meters,
      duration_seconds: split.duration_seconds,
      pace_seconds_per_km: paceSecondsPerKm,
      status,
      target_band_seconds_per_km: {
        min: band?.minSecondsPerKm ?? null,
        max: band?.maxSecondsPerKm ?? null,
      },
    };
  });

  if (!isControlledStart) {
    return {
      patch_id: preRun.active_patch_id,
      intended_strategy: intendedStrategy,
      actual_splits: actualSplits,
      followed_patch: null,
      evaluated_as: "not_evaluated",
      reason: "No structured execution assessment is defined for this patch.",
    };
  }

  const km1 = actualSplits[0] ?? null;
  const km1Known =
    km1 !== null && (km1.status === "in_band" || km1.status === "too_fast" || km1.status === "too_slow");
  const followedKm1 = km1?.status === "in_band";
  const isCalibration = preRun.mode === "green_lake_5k_calibration";
  const evaluatedAs: PatchExecutionAssessment["evaluated_as"] = isCalibration
    ? "controlled_start_calibration"
    : "record_mode_result";
  const followedPatch = isCalibration && km1Known ? followedKm1 : null;
  const reason = !km1Known
    ? "Insufficient split data to evaluate controlled_start_v1."
    : !isCalibration
      ? "Run was not a Green Lake calibration, so controlled_start_v1 execution was recorded but not scored."
      : km1?.status === "too_fast"
        ? "Km 1 was faster than the controlled-start target band."
        : km1?.status === "too_slow"
          ? "Km 1 was slower than the controlled-start target band."
          : "Opening kilometer matched the controlled-start target band.";

  return {
    patch_id: preRun.active_patch_id,
    intended_strategy: intendedStrategy,
    actual_splits: actualSplits,
    followed_patch: followedPatch,
    evaluated_as: evaluatedAs,
    reason,
  };
}

function buildCoachReadySummary(
  greenLakeEnabled: boolean,
  activeTargetDistanceResult: ActiveTargetDistanceResult,
  activePacing: Record<string, unknown>,
  scores: DataQualityScores,
  postRun: PostRunState,
  shortRun: ShortRunDiagnostic,
  partialPacing: ActivePartialPacingFeatures,
  classification: RunClassification,
  reconciliation: MeasurementReconciliation,
  usability: Usability,
  patchExecutionAssessment: PatchExecutionAssessment,
  activeShortTargetResult: ActiveShortTargetResult,
): CoachReadySummary {
  const targetTime = activeTargetDistanceResult.active_elapsed_at_target_distance_seconds;
  const firstPace = asNumber(activePacing.first_third_pace_seconds_per_mile);
  const finalPace = asNumber(activePacing.final_third_pace_seconds_per_mile);
  const lateFade = asNumber(activePacing.late_fade_score_seconds_per_mile);
  const negativeSplit = typeof activePacing.negative_split === "boolean" ? activePacing.negative_split : null;
  let pacingPattern: CoachReadySummary["pacing_pattern"] = "unknown";
  if (negativeSplit === true) {
    pacingPattern = "negative_split";
  } else if (firstPace !== null && finalPace !== null) {
    pacingPattern = finalPace - firstPace > 20 ? "positive_split" : Math.abs(finalPace - firstPace) <= 20 ? "even" : "negative_split";
  }
  const subjectiveCostAvailable = subjectiveDebriefComplete(postRun);
  const isShortDiagnostic = classification.inferred_mode === "short_run_diagnostic";
  const priorBestShort = loadStoredRouteMemory("home_block_short_loop_v1")?.best_short_1500m_estimate_seconds ?? null;
  const latestShortEstimate =
    activeShortTargetResult.target_distance_meters === 1500 && activeShortTargetResult.active_elapsed_at_target_seconds !== null
      ? activeShortTargetResult.active_elapsed_at_target_seconds
      : shortRun.estimated_1500m_time_seconds;
  const speedReserveVsSub25 =
    latestShortEstimate === null ? null : round(latestShortEstimate - 450, 2);
  const recommendedPatch =
    isShortDiagnostic
      ? "extend_sustainable_pace_v1"
      : pacingPattern === "positive_split" && lateFade !== null && lateFade > 15
        ? "controlled_start_v2"
        : null;
  const shortRecommendedPatch =
    shortRun.enabled ? "extend_sustainable_pace_v1" : recommendedPatch;

  return {
    run_type: classification.inferred_mode,
    chosen_distance_basis: reconciliation.chosen_basis,
    active_time_seconds: reconciliation.time_estimates.active_elapsed,
    target_time_seconds: activeTargetDistanceResult.target_reached ? targetTime : null,
    pace_seconds_per_mile:
      targetTime !== null && activeTargetDistanceResult.target_reached
        ? round(targetTime / (activeTargetDistanceResult.intended_distance_meters / METERS_PER_MILE), 2)
        : shortRun.active_pace_seconds_per_mile,
    baseline_green_lake_5k_time_seconds: greenLakeEnabled && activeTargetDistanceResult.target_reached ? targetTime : null,
    baseline_green_lake_5k_pace_seconds_per_mile:
      greenLakeEnabled && targetTime !== null
        ? round(targetTime / (activeTargetDistanceResult.intended_distance_meters / METERS_PER_MILE), 2)
        : null,
    pacing_pattern: pacingPattern,
    late_fade_seconds_per_mile: lateFade,
    short_run_estimate_1500m_seconds: shortRun.estimated_1500m_time_seconds,
    recommended_patch_id: recommendedPatch,
    subjective_cost_available: subjectiveCostAvailable,
    primary_limiter: postRun.primary_limiter,
    pain_present: postRun.pain_after_run.present,
    usable_for_runner_update: usability.usable_for_coach_update,
    usable_for_next_strategy_update: scores.usable_for_pacing_calibration && recommendedPatch !== null,
    next_best_test:
      recommendedPatch === "controlled_start_v2" || patchExecutionAssessment.followed_patch === false
        ? "controlled_start_green_lake_5k"
        : shortRun.short_run_usable
          ? "2000m_controlled_fast_short_diagnostic"
          : null,
    short_run: {
      usable_for_runner_update: shortRun.short_run_usable,
      estimated_1500m_time_seconds: shortRun.estimated_1500m_time_seconds,
      latest_estimated_1500m_time_seconds: latestShortEstimate,
      prior_best_short_1500m_estimate_seconds: priorBestShort,
      delta_vs_prior_best:
        latestShortEstimate !== null && priorBestShort !== null ? round(latestShortEstimate - priorBestShort, 2) : null,
      speed_reserve_vs_sub25_5k_pace_seconds: speedReserveVsSub25,
      recommended_next_short_test: shortRun.short_run_usable ? "2000m controlled-fast" : null,
      comparison_to_prior_short_runs:
        priorBestShort !== null && latestShortEstimate !== null
          ? `Latest 1500m estimate is ${round(latestShortEstimate - priorBestShort, 2)}s versus prior best.`
          : shortRun.enabled
            ? "No prior best short-run estimate is available yet."
            : null,
      comparison_to_green_lake_baseline_pace:
        shortRun.active_pace_seconds_per_mile !== null
          ? "Short-run pace can be compared with the current Green Lake baseline pace, but should not be extrapolated directly to 5K."
          : null,
      interpretation:
        latestShortEstimate !== null && latestShortEstimate < 450
          ? "Short-run speed reserve exceeds sub-25 5K pace."
          : shortRun.enabled && partialPacing.early_fast_then_fade_detected
          ? "Short run shows fast start followed by pacing drift; useful as speed-reserve and pacing-drift evidence."
          : shortRun.enabled
            ? "Short run is usable for short-distance pacing diagnostics."
            : null,
      recommended_patch_id: shortRecommendedPatch,
    },
  };
}

function subjectiveDebriefComplete(postRun: PostRunState): boolean {
  if (postRun.subjective_debrief_skipped && postRun.subjective_debrief_skip_reason) {
    return false;
  }
  const painComplete =
    !postRun.pain_after_run.present ||
    (Boolean(postRun.pain_after_run.location) && postRun.pain_after_run.severity_1_to_10 !== null);
  return (
    (postRun.rpe_1_to_10 !== null || postRun.perceived_effort_simple !== "unknown") &&
    postRun.primary_limiter !== "unknown" &&
    painComplete
  );
}

function nullableBooleanFromNumber(value: unknown, threshold: number): boolean | null {
  const numberValue = asNumber(value);
  return numberValue === null ? null : numberValue > threshold;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pickCoursePoint(point: GpsPoint) {
  return {
    lat: point.lat,
    lon: point.lon,
    timestamp_utc: point.timestamp_utc,
    t_elapsed_seconds: point.t_elapsed_seconds,
  };
}

function simplifyPolyline(points: GpsPoint[]): Array<[number, number]> {
  const stride = Math.max(1, Math.ceil(points.length / 200));
  const simplified = points
    .filter((_, index) => index % stride === 0)
    .map((point): [number, number] => [round(point.lat, 6), round(point.lon, 6)]);
  const final = points[points.length - 1];
  if (final) {
    const finalPair: [number, number] = [round(final.lat, 6), round(final.lon, 6)];
    const lastPair = simplified[simplified.length - 1];
    if (!lastPair || lastPair[0] !== finalPair[0] || lastPair[1] !== finalPair[1]) {
      simplified.push(finalPair);
    }
  }
  return simplified;
}

function buildQualityNotes(
  points: GpsPoint[],
  gpsQuality: Record<string, unknown>,
  windows: MotionWindow[],
  startWeatherFetchedAt: string | null,
  targetDistanceResult: TargetDistanceResult,
  interpolation: InterpolationFeatures,
  recordingReliability: "high" | "medium" | "low",
): string[] {
  const notes: string[] = [];
  if (points.length === 0) {
    notes.push("No GPS points were recorded.");
  }
  const poorAccuracyCount = Number(gpsQuality.poor_accuracy_points_count ?? 0);
  if (points.length > 0 && poorAccuracyCount / points.length > 0.25) {
    notes.push("More than 25% of GPS points exceeded the 25 meter accuracy threshold.");
  }
  if (Number(gpsQuality.gps_gap_count_over_10_seconds ?? 0) > 0) {
    notes.push("At least one GPS callback gap exceeded 10 seconds.");
  }
  if (Number(gpsQuality.possible_gps_jump_count ?? 0) > 0) {
    notes.push("Possible GPS jumps were flagged and excluded from distance/split calculations.");
  }
  if (Number(gpsQuality.impossible_speed_segment_count ?? 0) > 0) {
    notes.push("Impossible-speed GPS segments were excluded from distance, pace, and max-speed calculations.");
  }
  if (Number(gpsQuality.suspicious_speed_segment_count ?? 0) > 0) {
    notes.push("Suspicious-speed GPS segments were detected and retained unless they exceeded the impossible-speed threshold.");
  }
  if (Number(gpsQuality.suspicious_acceleration_segment_count ?? 0) > 0) {
    notes.push("Suspicious acceleration changes were detected in GPS-derived segment speeds.");
  }
  if (Number(gpsQuality.suspicious_grade_segment_count ?? 0) > 0) {
    notes.push("Suspicious grade changes were detected; elevation and grade confidence should remain low.");
  }
  if (recordingReliability === "low") {
    notes.push("Recording reliability was low; use interpolated distance only as a rough estimate.");
  }
  if (interpolation.gaps.length > 0) {
    notes.push("GPS gaps were detected and interpolation estimates were added without overwriting raw distance.");
  }
  if (windows.length === 0) {
    notes.push("No motion windows were recorded.");
  }
  if (!startWeatherFetchedAt) {
    notes.push("Start weather was not fetched.");
  }
  const recordedDistance = targetDistanceResult.distance_recorded_meters;
  const intendedDistance = targetDistanceResult.intended_distance_meters;
  if (recordedDistance !== null && recordedDistance - intendedDistance > 100) {
    notes.push("Run overshot intended distance by more than 100 meters; use target_distance_result for 5K analysis.");
  }
  if (recordedDistance !== null && intendedDistance - recordedDistance > 100) {
    notes.push("Run ended more than 100 meters short of intended distance; 5K analysis is incomplete.");
  }
  return notes;
}

function patchDescription(patchId: string): string {
  return PATCH_LIBRARY[patchId]?.description ?? "Manual/local coach patch selected before run.";
}

function patchThesis(patchId: string): string {
  return PATCH_LIBRARY[patchId]?.thesis ?? "Manual patch: evaluate objective split pattern against post-run subjective cost.";
}

function buildSubjectiveDebrief(postRun: PostRunState): SubjectiveDebrief {
  const rpeSource =
    postRun.rpe_estimation_source === "manual"
      ? "manual"
      : postRun.rpe_1_to_10 !== null && postRun.perceived_effort_simple !== "unknown"
        ? "effort_label_mapping"
        : "not_answered";
  return {
    effort_label: postRun.perceived_effort_simple,
    rpe_estimated: postRun.rpe_1_to_10,
    rpe_source: rpeSource,
    pain_present: postRun.pain_after_run.present,
    pain_location: postRun.pain_after_run.location,
    pain_severity_1_to_10: postRun.pain_after_run.severity_1_to_10,
    primary_limiter: postRun.primary_limiter,
    free_text: postRun.free_text,
  };
}

function buildUxPromptPolicy() {
  return {
    max_pre_run_required_inputs: 0,
    max_post_run_required_inputs: 3,
    max_adaptive_followups: 1,
    allow_skip_all_subjective: true,
    skip_requires_reason: false,
  };
}

function buildCurrentPatch(patchId: string): CurrentPatch {
  return {
    patch_id: patchId,
    mission:
      patchId === "controlled_start_v1"
        ? "Reduce late fade by controlling the opening pace."
        : patchDescription(patchId),
    status: "active" as const,
    evaluation_window:
      patchId === "controlled_start_v1" ? "next comparable Green Lake run" : "next comparable run",
    strategy:
      patchId === "controlled_start_v1"
        ? {
            km1: "5:35-5:40",
            km2: "5:35-5:45",
            km3: "5:40-5:50",
            km4: "hold steady",
            km5: "squeeze only if stable",
          }
        : {},
  };
}

function exportPreRun(preRun: PreRunState) {
  return {
    mode: preRun.mode,
    active_patch_id: preRun.active_patch_id,
    route_name: preRun.route_name,
    route_direction: preRun.route_direction,
    phone_position: preRun.phone_position,
    intended_distance_meters: preRun.intended_distance_meters,
    energy_before_run_1_to_5: preRun.energy_before_run_1_to_5,
    soreness_before_run: preRun.soreness_before_run,
    pain_before_run: preRun.pain_before_run,
    free_text: preRun.free_text,
  };
}

function exportPostRun(postRun: PostRunState) {
  return {
    rpe_1_to_10: postRun.rpe_1_to_10,
    rpe_estimation_source: postRun.rpe_estimation_source,
    perceived_effort_simple: postRun.perceived_effort_simple,
    energy_after_run_1_to_5: postRun.energy_after_run_1_to_5,
    soreness_after_run: postRun.soreness_after_run,
    pain_after_run: postRun.pain_after_run,
    primary_limiter: postRun.primary_limiter,
    started_too_fast: postRun.started_too_fast,
    final_third_harder_than_expected: postRun.final_third_harder_than_expected,
    interruption: postRun.interruption,
    immediate_pulse_bpm_manual: postRun.immediate_pulse_bpm_manual,
    pulse_after_3_to_5_min_bpm_manual: postRun.pulse_after_3_to_5_min_bpm_manual,
    breathing_recovered_after: postRun.breathing_recovered_after,
    subjective_debrief_skipped: postRun.subjective_debrief_skipped,
    subjective_debrief_skip_reason: postRun.subjective_debrief_skip_reason,
    free_text: postRun.free_text,
  };
}

function exportPermissions(permissions: PermissionState, weatherFetchSuccess: boolean, pwaState: ActiveRun["pwa_state"]) {
  return {
    geolocation_available: permissions.geolocation_available,
    geolocation_permission: permissions.geolocation_permission,
    device_motion_available: permissions.device_motion_available,
    device_motion_permission: permissions.device_motion_permission,
    wake_lock_available: permissions.wake_lock_available,
    wake_lock_used: permissions.wake_lock_used,
    wake_lock_error_message: permissions.wake_lock_error_message,
    wake_lock_status: permissions.wake_lock_status,
    weather_fetch_success: weatherFetchSuccess,
    weather_status: permissions.weather_status,
    pwa_display_mode_standalone: pwaState.display_mode_standalone,
    service_worker_controller: pwaState.service_worker_controller,
    storage_persisted: pwaState.storage_persisted,
  };
}

function computeCurrentPace(points: GpsPoint[]): number | null {
  if (points.length < 2) {
    return null;
  }

  const latest = points[points.length - 1];
  let startIndex = 0;
  for (let i = points.length - 1; i >= 0; i -= 1) {
    if (latest.t_elapsed_seconds - points[i].t_elapsed_seconds >= 20) {
      startIndex = i;
      break;
    }
  }
  const windowPoints = points.slice(startIndex);
  if (windowPoints.length < 2) {
    return null;
  }

  let distance = 0;
  for (let i = 1; i < windowPoints.length; i += 1) {
    if (!isExcludedSegment(windowPoints[i])) {
      distance += haversineMeters(windowPoints[i - 1], windowPoints[i]);
    }
  }

  const dt = latest.t_elapsed_seconds - windowPoints[0].t_elapsed_seconds;
  if (dt < 10 || distance < 15) {
    return null;
  }
  return round(dt / (distance / METERS_PER_MILE), 2);
}

function downsampleGps(points: GpsPoint[], seconds: number): GpsPoint[] {
  const sampled: GpsPoint[] = [];
  let lastTime = -Infinity;
  for (const point of points) {
    if (point.t_elapsed_seconds - lastTime >= seconds || sampled.length === 0) {
      sampled.push(point);
      lastTime = point.t_elapsed_seconds;
    }
  }
  const final = points[points.length - 1];
  if (final && sampled[sampled.length - 1] !== final) {
    sampled.push(final);
  }
  return sampled;
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function nullableNumber(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isExcludedSegment(point: GpsPoint): boolean {
  return Boolean(point.possible_gps_jump || point.impossible_speed);
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function roundOrNull(value: number | null, digits: number): number | null {
  return value === null ? null : round(value, digits);
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function interpolate(a: number, b: number, ratio: number): number {
  return a + (b - a) * ratio;
}

function mean(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function std(values: number[]): number {
  if (values.length <= 1) {
    return 0;
  }
  const average = mean(values) ?? 0;
  const variance = mean(values.map((value) => (value - average) ** 2)) ?? 0;
  return Math.sqrt(variance);
}

function median(values: number[]): number | null {
  return percentile(values, 0.5);
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sorted[lower];
  }
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
