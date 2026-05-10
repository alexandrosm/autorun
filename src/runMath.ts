import type {
  ActiveRun,
  ExportPayload,
  GpsPoint,
  GpsGapInterpolation,
  InterpolationFeatures,
  MotionWindow,
  PermissionState,
  PostRunState,
  PreRunState,
  RecordingLifecycle,
  SplitFeature,
  TargetDistanceResult,
} from "./types";

const METERS_PER_MILE = 1609.344;
const METERS_PER_KM = 1000;
const POOR_ACCURACY_THRESHOLD_METERS = 25;
const STOPPED_SPEED_THRESHOLD_MPS = 0.5;
const SUSPICIOUS_SPEED_MPS = 7;
const IMPOSSIBLE_SPEED_MPS = 8;
const SUSPICIOUS_ACCELERATION_MPS2 = 4;
const SUSPICIOUS_GRADE_PERCENT = 20;

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
      if (previousSpeed !== null && previousSpeed !== undefined && Number.isFinite(previousSpeed)) {
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
  };
}

export function buildExportPayload(run: ActiveRun, createdAtUtc = new Date().toISOString()): ExportPayload {
  const features = computeFeatures(run);
  const weatherFetchSuccess = Boolean(run.weather.start_weather.fetched_at_utc || run.weather.finish_weather.fetched_at_utc);
  const notes = uniqueStrings([...run.data_quality_notes, ...features.dataQualityNotes]);

  return {
    schema_version: "0.1.2",
    app: {
      name: "Green Lake AutoResearch Logger",
      version: "0.1.2",
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
      mode: "training_calibration",
      active_patch_id: "baseline_calibration_v1",
      active_patch_description: "Establish repeatable Green Lake baseline and identify first limiter.",
      current_thesis:
        "Unknown: distinguish pacing discipline, late-run durability, fatigue, weather sensitivity, and route execution.",
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
    weather: run.weather,
    summary: features.summary,
    gps_quality: features.gpsQuality,
    interpolation_features: features.interpolation,
    splits: features.splits,
    target_distance_result: features.targetDistanceResult,
    target_distance_splits: features.targetDistanceSplits,
    pacing_features: features.pacing,
    elevation_features: features.elevation,
    motion_features: features.motion,
    route_features: features.route,
    time_series: {
      gps_points: run.gps_points,
      downsampled_points_5s: downsampleGps(run.gps_points, 5),
    },
    post_run: exportPostRun(run.post_run),
    data_quality_notes: notes,
    checkpoints: run.checkpoints,
  };
}

export function computeLiveStats(points: GpsPoint[], elapsedSeconds: number) {
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
  const points = run.gps_points;
  const track = buildTrack(points);
  const durationSeconds = computeDurationSeconds(run, points);
  const distanceMeters = track.length > 0 ? track[track.length - 1].cumulative_meters : 0;
  const distanceMiles = distanceMeters / METERS_PER_MILE;
  const distanceKm = distanceMeters / METERS_PER_KM;
  const movement = computeMovement(points, durationSeconds);
  const gpsQuality = computeGpsQuality(points);
  const interpolation = computeInterpolationFeatures(points, distanceMeters);
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
  const pacing = computePacingFeatures(track, splits.thirds);
  const route = computeRouteFeatures(points, run.pre_run.route_direction, run.pre_run.route_name);
  const motion = computeMotionFeatures(
    run.motion_windows,
    durationSeconds,
    run.permissions,
    run.pre_run.phone_position,
    run.motion_debug,
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

  return {
    summary: {
      duration_seconds: finiteOrNull(round(durationSeconds, 2)),
      distance_meters: finiteOrNull(round(distanceMeters, 2)),
      raw_recorded_distance_meters: interpolation.raw_recorded_distance_meters,
      interpolated_distance_estimate_meters: interpolation.interpolated_distance_estimate_meters,
      distance_confidence: recordingReliability === "high" && interpolation.interpolation_confidence === "high" ? "high" : recordingReliability,
      distance_miles: finiteOrNull(round(distanceMiles, 4)),
      average_pace_seconds_per_mile:
        distanceMiles > 0 ? finiteOrNull(round(durationSeconds / distanceMiles, 2)) : null,
      average_pace_seconds_per_km: distanceKm > 0 ? finiteOrNull(round(durationSeconds / distanceKm, 2)) : null,
      moving_time_seconds: finiteOrNull(round(movement.movingSeconds, 2)),
      stopped_time_seconds: finiteOrNull(round(movement.stoppedSeconds, 2)),
      average_speed_mps: durationSeconds > 0 ? finiteOrNull(round(distanceMeters / durationSeconds, 3)) : null,
      max_speed_mps: movement.maxSpeedMps,
    },
    gpsQuality,
    interpolation,
    recordingReliability,
    splits,
    targetDistanceResult,
    targetDistanceSplits,
    pacing,
    elevation,
    route,
    motion,
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
  if (gpsGapCountOver10 > 1 || missingGpsTimeSeconds > 30 || missingRatio > 0.08 || hiddenEvents > 0) {
    return "low";
  }
  if (gpsGapCountOver10 > 0 || missingGpsTimeSeconds > 5 || lifecycle.gps_stale_events.length > 0) {
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
  prefix: "mile" | "kilometer",
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
    overshoot_meters: targetReached ? round(recordedDistance - intendedDistanceMeters, 2) : null,
    distance_recorded_meters: track.length > 0 ? round(recordedDistance, 2) : null,
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

function elevationInRange(track: TrackPoint[], startMeters: number, endMeters: number) {
  let gain = 0;
  let loss = 0;

  for (let i = 1; i < track.length; i += 1) {
    const previous = track[i - 1];
    const current = track[i];
    const segmentStart = previous.cumulative_meters;
    const segmentEnd = current.cumulative_meters;
    if (
      segmentEnd <= startMeters ||
      segmentStart >= endMeters ||
      previous.altitude_meters === null ||
      current.altitude_meters === null ||
      isExcludedSegment(current) ||
      current.suspicious_grade
    ) {
      continue;
    }
    const delta = current.altitude_meters - previous.altitude_meters;
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
  const latitudes = points.map((point) => point.lat);
  const longitudes = points.map((point) => point.lon);

  return {
    start_lat: first?.lat ?? null,
    start_lon: first?.lon ?? null,
    finish_lat: last?.lat ?? null,
    finish_lon: last?.lon ?? null,
    start_finish_distance_meters: first && last ? round(haversineMeters(first, last), 2) : null,
    bounding_box: {
      min_lat: latitudes.length > 0 ? Math.min(...latitudes) : null,
      max_lat: latitudes.length > 0 ? Math.max(...latitudes) : null,
      min_lon: longitudes.length > 0 ? Math.min(...longitudes) : null,
      max_lon: longitudes.length > 0 ? Math.max(...longitudes) : null,
    },
    route_direction: routeDirection,
    route_name: routeName,
    route_match_score_0_to_1: null,
  };
}

function computeMotionFeatures(
  windows: MotionWindow[],
  durationSeconds: number,
  permissions: PermissionState,
  phonePosition: string,
  motionDebug: ActiveRun["motion_debug"],
) {
  const early = selectMotionWindows(windows, durationSeconds, 0);
  const late = selectMotionWindows(windows, durationSeconds, 2);
  const earlyMean = mean(early.map((window) => window.accel_magnitude_std).filter(isNumber));
  const lateMean = mean(late.map((window) => window.accel_magnitude_std).filter(isNumber));

  return {
    motion_available: permissions.device_motion_available && (permissions.device_motion_permission === "ready" || windows.length > 0),
    phone_position: phonePosition,
    window_seconds: 5,
    window_count: windows.length,
    late_run_motion_change_score:
      earlyMean !== null && lateMean !== null ? round(lateMean - earlyMean, 4) : null,
    cadence_estimate_spm: null,
    cadence_confidence: "not_computed",
    motion_permission_debug: motionDebug,
    windows,
  };
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

function exportPreRun(preRun: PreRunState) {
  return {
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
    weather_fetch_success: weatherFetchSuccess,
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

function isNumber(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
