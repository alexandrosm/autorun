import L from "leaflet";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import { haversineMeters } from "./runMath";
import type { Checkpoint, GpsPoint } from "./types";
import "./route-map.css";

export interface RunRouteMapProps {
  points: readonly GpsPoint[];
  checkpoints?: readonly Checkpoint[];
  units: "metric" | "imperial";
  live?: boolean;
  allowSpeedColor?: boolean;
}

type ColorMode = "plain" | "speed" | "elevation";
type Range = { min: number; max: number } | null;
type Segment = {
  from: L.LatLng;
  to: L.LatLng;
  gapSeconds: number | null;
  unreliable: boolean;
  speed: number | null;
  elevation: number | null;
};
type Span = { color: string; dashed: boolean; positions: L.LatLng[] };

const COLORS = ["#2c7bb6", "#008fc2", "#00a6ca", "#41b6a6", "#90c987", "#d5d65e", "#f5b94a", "#ed853b", "#d94b35"];
const PLAIN_COLOR = "#12683f";
const UNKNOWN_COLOR = "#667078";
const GAP_COLOR = "#a95b09";
// Match the logger's poor horizontal accuracy and suspicious-speed thresholds.
const MAX_HORIZONTAL_ACCURACY_METERS = 25;
const MAX_SPEED_MPS = 7;
const MAX_ALTITUDE_ACCURACY_METERS = 20;
const EMPTY_CHECKPOINTS: readonly Checkpoint[] = [];

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validPosition(point: GpsPoint): boolean {
  return finite(point.lat) && finite(point.lon) && Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180;
}

function goodPosition(point: GpsPoint): boolean {
  return point.accuracy_ok && finite(point.horizontal_accuracy_meters) &&
    point.horizontal_accuracy_meters >= 0 && point.horizontal_accuracy_meters <= MAX_HORIZONTAL_ACCURACY_METERS;
}

function goodAltitude(point: GpsPoint): boolean {
  return finite(point.altitude_meters) && finite(point.altitude_accuracy_meters) &&
    point.altitude_accuracy_meters >= 0 && point.altitude_accuracy_meters <= MAX_ALTITUDE_ACCURACY_METERS;
}

function includeValue(range: Range, value: number | null): Range {
  if (value === null) return range;
  if (!range) return { min: value, max: value };
  range.min = Math.min(range.min, value);
  range.max = Math.max(range.max, value);
  return range;
}

function prepareRoute(points: readonly GpsPoint[]) {
  const positions = points.map((point) => validPosition(point) ? L.latLng(point.lat, point.lon) : null);
  const validPositions: L.LatLng[] = [];
  const segments: Segment[] = [];
  let speedRange: Range = null;
  let elevationRange: Range = null;
  let firstIndex = -1;
  let lastIndex = -1;
  for (let i = 0; i < positions.length; i += 1) {
    const position = positions[i];
    if (position) {
      validPositions.push(position);
      if (firstIndex < 0) firstIndex = i;
      lastIndex = i;
    }
    if (i === 0 || !position || !positions[i - 1]) continue;
    const previous = points[i - 1];
    const current = points[i];
    const dt = current.t_elapsed_seconds - previous.t_elapsed_seconds;
    const gapSeconds = finite(dt) && dt > 5 ? dt : null;
    const geometricSpeed = dt >= 0.5 ? haversineMeters(previous, current) / dt : null;
    const unreliable = !finite(dt) || dt < 0.5 || !finite(geometricSpeed) || geometricSpeed > MAX_SPEED_MPS ||
      !goodPosition(previous) || !goodPosition(current) ||
      previous.possible_gps_jump || current.possible_gps_jump ||
      previous.impossible_speed === true || current.impossible_speed === true ||
      current.tiny_dt_segment === true || current.suspicious_speed === true || current.suspicious_acceleration === true;
    // Do not substitute zero, or infer a recorded speed where both numeric fields are absent.
    const recordedSpeed = finite(current.segment_speed_mps) ? current.segment_speed_mps :
      current.speed_available && finite(current.speed_mps) ? current.speed_mps : null;
    const speed = !unreliable && gapSeconds === null && recordedSpeed !== null &&
      recordedSpeed >= 0 && recordedSpeed <= MAX_SPEED_MPS ? recordedSpeed : null;
    const elevation = !unreliable && gapSeconds === null && !current.suspicious_grade &&
      goodAltitude(previous) && goodAltitude(current)
      ? (previous.altitude_meters! + current.altitude_meters!) / 2 : null;
    segments.push({ from: positions[i - 1]!, to: position, gapSeconds, unreliable, speed, elevation });
    speedRange = includeValue(speedRange, speed);
    elevationRange = includeValue(elevationRange, elevation);
  }
  return { positions, validPositions, segments, speedRange, elevationRange, firstIndex, lastIndex };
}

function valueColor(value: number, range: NonNullable<Range>): string {
  const fraction = range.max === range.min ? 0.5 : (value - range.min) / (range.max - range.min);
  return COLORS[Math.min(COLORS.length - 1, Math.max(0, Math.round(fraction * (COLORS.length - 1))))];
}

function buildSpans(segments: readonly Segment[], mode: ColorMode, range: Range): Span[] {
  const spans: Span[] = [];
  let span: Span | undefined;
  for (const segment of segments) {
    const value = mode === "speed" ? segment.speed : segment.elevation;
    const unknown = mode === "plain" ? segment.unreliable : value === null || range === null;
    const dashed = segment.gapSeconds !== null || unknown;
    const color = segment.gapSeconds !== null ? GAP_COLOR : unknown ? UNKNOWN_COLOR :
      mode === "plain" ? PLAIN_COLOR : valueColor(value!, range!);
    if (span && span.color === color && span.dashed === dashed && span.positions[span.positions.length - 1] === segment.from) {
      span.positions.push(segment.to);
    } else {
      span = { color, dashed, positions: [segment.from, segment.to] };
      spans.push(span);
    }
  }
  return spans;
}

export function RunRouteMap({ points, checkpoints = EMPTY_CHECKPOINTS, units, live = false, allowSpeedColor = true }: RunRouteMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const routeLayerRef = useRef<L.LayerGroup | null>(null);
  const markerLayerRef = useRef<L.LayerGroup | null>(null);
  const rendererRef = useRef<L.SVG | null>(null);
  const programmaticMoveRef = useRef(false);
  const [tileFailure, setTileFailure] = useState(false);
  const [followLocked, setFollowLocked] = useState(true);
  const [selectedMode, setSelectedMode] = useState<ColorMode>("plain");
  // Enforce blinding synchronously, including the render where the prop changes.
  const mode = selectedMode === "speed" && !allowSpeedColor ? "plain" : selectedMode;
  const route = useMemo(() => prepareRoute(points), [points]);
  const observedRange = mode === "speed" ? route.speedRange : mode === "elevation" ? route.elevationRange : null;
  const range = useMemo(() => {
    if (!observedRange || observedRange.min === observedRange.max) return observedRange;
    // Do not paint sub-resolution jitter across the whole rainbow.
    const minimumSpan = mode === "speed" ? 0.5 : 5;
    if (observedRange.max - observedRange.min >= minimumSpan) return observedRange;
    const center = (observedRange.min + observedRange.max) / 2;
    const min = mode === "speed" ? Math.max(0, center - minimumSpan / 2) : center - minimumSpan / 2;
    return { min, max: min + minimumSpan };
  }, [mode, observedRange]);
  const spans = useMemo(() => buildSpans(route.segments, mode, range), [route, mode, range]);
  const viewportRef = useRef({ route, live, followLocked });
  viewportRef.current = { route, live, followLocked };

  useEffect(() => {
    if (!allowSpeedColor && selectedMode === "speed") setSelectedMode("plain");
  }, [allowSpeedColor, selectedMode]);

  function resetViewport() {
    const map = mapRef.current;
    if (!map) return;
    programmaticMoveRef.current = true;
    map.invalidateSize({ animate: false });
    if (live && route.lastIndex >= 0) {
      map.setView(route.positions[route.lastIndex]!, Math.max(map.getZoom(), 16), { animate: false });
    } else if (route.validPositions.length > 0) {
      map.fitBounds(L.latLngBounds(route.validPositions), { padding: [28, 28], maxZoom: 17, animate: false });
    }
    programmaticMoveRef.current = false;
    setFollowLocked(true);
  }

  useLayoutEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const renderer = L.svg({ padding: 0.3 });
    const map = L.map(containerRef.current, {
      attributionControl: false,
      zoomControl: false,
      dragging: true,
      touchZoom: true,
      scrollWheelZoom: false,
      renderer,
    }).setView([47.679, -122.328], 14);
    map.on("dragstart zoomstart", () => {
      if (!programmaticMoveRef.current) setFollowLocked(false);
    });
    let cycleHadTileError = false;
    const tiles = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, crossOrigin: true });
    tiles.on("loading", () => { cycleHadTileError = false; });
    tiles.on("tileerror", () => { cycleHadTileError = true; setTileFailure(true); });
    tiles.on("load", () => setTileFailure(cycleHadTileError));
    tiles.addTo(map);
    rendererRef.current = renderer;
    routeLayerRef.current = L.layerGroup().addTo(map);
    markerLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    let resizeFrame: number | undefined;
    const refreshSize = () => {
      if (document.visibilityState !== "visible") return;
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = undefined;
        programmaticMoveRef.current = true;
        map.invalidateSize({ animate: false, debounceMoveend: true });
        const current = viewportRef.current;
        if (current.followLocked) {
          if (current.live && current.route.lastIndex >= 0) {
            map.setView(current.route.positions[current.route.lastIndex]!, Math.max(map.getZoom(), 16), { animate: false });
          } else if (!current.live && current.route.validPositions.length > 0) {
            map.fitBounds(L.latLngBounds(current.route.validPositions), { padding: [28, 28], maxZoom: 17, animate: false });
          }
        }
        programmaticMoveRef.current = false;
      });
    };
    const resizeObserver = new ResizeObserver(refreshSize);
    resizeObserver.observe(containerRef.current);
    document.addEventListener("visibilitychange", refreshSize);
    window.addEventListener("pageshow", refreshSize);
    refreshSize();
    return () => {
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", refreshSize);
      window.removeEventListener("pageshow", refreshSize);
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
      // Remove paths before detaching their shared renderer.
      routeLayerRef.current?.clearLayers();
      markerLayerRef.current?.clearLayers();
      map.remove();
      mapRef.current = null;
      rendererRef.current = null;
      routeLayerRef.current = null;
      markerLayerRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const layers = routeLayerRef.current;
    const renderer = rendererRef.current;
    if (!layers || !renderer) return;
    layers.clearLayers();
    for (const span of spans) {
      L.polyline(span.positions, {
        renderer, color: span.color, weight: 5, opacity: 0.95, dashArray: span.dashed ? "5 7" : undefined,
        interactive: false,
      }).addTo(layers);
    }
  }, [spans]);

  useEffect(() => {
    const layers = markerLayerRef.current;
    const renderer = rendererRef.current;
    if (!layers || !renderer) return;
    layers.clearLayers();
    if (route.lastIndex < 0) return;
    const first = route.positions[route.firstIndex]!;
    const latest = route.positions[route.lastIndex]!;
    const accuracy = points[route.lastIndex].horizontal_accuracy_meters;
    if (finite(accuracy) && accuracy >= 0) {
      const distance = units === "metric" ? `${Math.round(accuracy)} m` : `${Math.round(accuracy * 3.28084)} ft`;
      L.circle(latest, { renderer, radius: accuracy, color: "#2b7a58", fillOpacity: 0.1, weight: 1 })
        .bindTooltip(`Reported GPS accuracy: ±${distance}`).addTo(layers);
    }
    L.circleMarker(first, { renderer, radius: 6, color: "#0f5d38", fillColor: "#ffffff", fillOpacity: 1, weight: 3 })
      .bindTooltip("Start").addTo(layers);
    L.circleMarker(latest, { renderer, radius: 7, color: "#10231b", fillColor: "#2dd078", fillOpacity: 1, weight: 3 })
      .bindTooltip(live ? "Latest GPS position" : "End").addTo(layers);
    for (const segment of route.segments) {
      if (segment.gapSeconds === null) continue;
      L.circleMarker([(segment.from.lat + segment.to.lat) / 2, (segment.from.lng + segment.to.lng) / 2], {
        renderer, radius: segment.gapSeconds > 10 ? 7 : 5, color: GAP_COLOR, fillColor: "#ffb35b", fillOpacity: 0.9, weight: 2,
      }).bindTooltip(`GPS gap: ${Math.round(segment.gapSeconds)} s. Dashed connection is not a measured route.`).addTo(layers);
    }
    const target = checkpoints.find((checkpoint) => checkpoint.label === "target_distance_reached");
    if (target && finite(target.t_elapsed_seconds)) {
      let bestIndex = -1;
      let bestDelta = Infinity;
      for (let i = 0; i < points.length; i += 1) {
        const delta = Math.abs(points[i].t_elapsed_seconds - target.t_elapsed_seconds);
        if (route.positions[i] && delta < bestDelta) { bestIndex = i; bestDelta = delta; }
      }
      if (bestIndex >= 0) {
        L.circleMarker(route.positions[bestIndex]!, { renderer, radius: 8, color: PLAIN_COLOR, fillColor: "#f7d154", fillOpacity: 1, weight: 3 })
          .bindTooltip("Target distance reached").addTo(layers);
      }
    }
  }, [route, points, checkpoints, live, units]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !followLocked || route.lastIndex < 0) return;
    programmaticMoveRef.current = true;
    if (live) {
      map.setView(route.positions[route.lastIndex]!, Math.max(map.getZoom(), 16), { animate: false });
    } else {
      map.fitBounds(L.latLngBounds(route.validPositions), { padding: [28, 28], maxZoom: 17, animate: false });
    }
    programmaticMoveRef.current = false;
  }, [route, live, followLocked]);

  const valueUnit = mode === "speed" ? units === "metric" ? "km/h" : "mph" : units === "metric" ? "m" : "ft";
  const formatValue = (value: number) => {
    const converted = mode === "speed" ? value * (units === "metric" ? 3.6 : 2.236936) : value * (units === "metric" ? 1 : 3.28084);
    return `${converted.toFixed(mode === "speed" ? 1 : 0)} ${valueUnit}`;
  };
  const controls = (
    <div className={`${live ? "map-controls " : ""}route-map-controls`}>
      <div className="route-map-modes" role="group" aria-label="Route color">
        {(["plain", ...(allowSpeedColor ? ["speed" as const] : []), "elevation"] as const).map((option) => (
          <button key={option} type="button" data-session-target={`route-color.${option}`} className="route-map-button" aria-pressed={mode === option} onClick={() => setSelectedMode(option)}>
            {option === "plain" ? "Plain" : option === "speed" ? "Speed" : "Elevation"}
          </button>
        ))}
      </div>
      <div className="route-map-navigation">
        {live ? <button type="button" data-session-target="map-follow" className="route-map-button" aria-pressed={followLocked} onClick={resetViewport}>Lock follow</button> : null}
        <button type="button" data-session-target="map-reset" className="route-map-button" onClick={resetViewport}>{live ? "Reset map" : "Reset to fit"}</button>
      </div>
      <div className="route-map-legend" aria-live="polite">
        {mode !== "plain" ? <Fragment>
          <strong>{mode === "speed" ? "GPS speed" : "GPS altitude · not slope"}</strong>
          {range ? <Fragment>
            <div className="route-map-gradient" style={{ background: range.min === range.max ? COLORS[4] : `linear-gradient(90deg, ${COLORS.join(", ")})` }} />
            <div className="route-map-range"><span>{formatValue(range.min)}</span><span>{range.min === range.max ? "Constant" : formatValue(range.max)}</span></div>
          </Fragment> : <span>No reliable {mode === "speed" ? "speed" : "altitude"} values.</span>}
          {mode === "elevation" ? <span>GPS estimate; vertical accuracy unknown or &gt;{units === "metric" ? "20 m" : "66 ft"} is gray.</span> : null}
        </Fragment> : null}
        <div className="route-map-keys">
          <span><i className="route-map-unknown" />Gray: unknown / poor GPS</span>
          <span><i className="route-map-gap" />Orange: gap &gt;5 s, not measured</span>
        </div>
        {route.firstIndex < 0 ? <span>No GPS route available.</span> : null}
        {tileFailure ? <span className="route-map-fallback">Map tiles unavailable. {live ? "Recording still active; route remains visible." : "Saved route remains visible."}</span> : null}
        <a className="route-map-attribution" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>
      </div>
    </div>
  );
  const frame = <div className={live ? "map-frame route-map-frame" : "route-map-static-frame"}><div ref={containerRef} className={live ? "live-map route-map-canvas" : "route-map-canvas"} aria-label={live ? "Live GPS route map" : "Saved GPS route map"} /></div>;
  return live ? <Fragment>{controls}{frame}</Fragment> : <section className="route-map-static" aria-label="Run route">{controls}{frame}</section>;
}
