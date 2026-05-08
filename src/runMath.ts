import type {
  ActiveRun,
  ExportPayload,
  GpsPoint,
  MotionWindow,
  PermissionState,
  PostRunState,
  PreRunState,
  SplitFeature,
  TargetDistanceResult,
} from "./types";

const METERS_PER_MILE = 1609.344;
const METERS_PER_KM = 1000;
const POOR_ACCURACY_THRESHOLD_METERS = 25;
const STOPPED_SPEED_THRESHOLD_MPS = 0.5;

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
  if (previousPoint) {
    const dt = elapsedSeconds - previousPoint.t_elapsed_seconds;
    if (dt > 0) {
      const segmentMeters = haversineMeters(previousPoint, pointBase);
      const segmentSpeed = segmentMeters / dt;
      possibleGpsJump =
        segmentMeters > 35 &&
        segmentSpeed > 8.5 &&
        (pointBase.horizontal_accuracy_meters === null || pointBase.horizontal_accuracy_meters > 15);
    }
  }

  return {
    ...pointBase,
    possible_gps_jump: possibleGpsJump,
  };
}

export function buildExportPayload(run: ActiveRun, createdAtUtc = new Date().toISOString()): ExportPayload {
  const features = computeFeatures(run);
  const weatherFetchSuccess = Boolean(run.weather.start_weather.fetched_at_utc || run.weather.finish_weather.fetched_at_utc);
  const notes = uniqueStrings([...run.data_quality_notes, ...features.dataQualityNotes]);

  return {
    schema_version: "0.1.1",
    app: {
      name: "Green Lake AutoResearch Logger",
      version: "0.1.1",
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
    permissions_and_capabilities: exportPermissions(run.permissions, weatherFetchSuccess),
    weather: run.weather,
    summary: features.summary,
    gps_quality: features.gpsQuality,
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
  const motion = computeMotionFeatures(run.motion_windows, durationSeconds, run.permissions, run.pre_run.phone_position);
  const notes = buildQualityNotes(
    points,
    gpsQuality,
    run.motion_windows,
    run.weather.start_weather.fetched_at_utc,
    targetDistanceResult,
  );

  return {
    summary: {
      duration_seconds: finiteOrNull(round(durationSeconds, 2)),
      distance_meters: finiteOrNull(round(distanceMeters, 2)),
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
    const segmentMeters = current.possible_gps_jump ? 0 : haversineMeters(previous, current);
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

    const segmentMeters = current.possible_gps_jump ? 0 : haversineMeters(previous, current);
    const segmentSpeed = segmentMeters / dt;
    const bestSpeed = Math.max(segmentSpeed, current.speed_mps ?? 0);
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
    if (previous.altitude_meters === null || current.altitude_meters === null || current.possible_gps_jump) {
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
      maxGrade = maxGrade === null ? Math.abs(grade) : Math.max(maxGrade, Math.abs(grade));
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
      current.possible_gps_jump
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

function exportPermissions(permissions: PermissionState, weatherFetchSuccess: boolean) {
  return {
    geolocation_available: permissions.geolocation_available,
    geolocation_permission: permissions.geolocation_permission,
    device_motion_available: permissions.device_motion_available,
    device_motion_permission: permissions.device_motion_permission,
    wake_lock_available: permissions.wake_lock_available,
    wake_lock_used: permissions.wake_lock_used,
    weather_fetch_success: weatherFetchSuccess,
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
    if (!windowPoints[i].possible_gps_jump) {
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
