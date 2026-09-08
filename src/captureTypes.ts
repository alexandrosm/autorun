export interface CaptureContext {
  screen: string;
  run_id: string | null;
  elapsed_seconds: number | null;
}

export type CaptureValue = string | number | boolean | null;

export interface SessionEvent extends CaptureContext {
  seq: number;
  at_utc: string;
  t_ms: number;
  kind: string;
  target?: string;
  data?: Record<string, CaptureValue>;
}

// Row order and units travel with every batch. Null means unavailable, not zero.
export interface SensorBatch {
  run_id: string;
  type: "motion" | "orientation" | "ambient_light";
  columns: string[];
  units: string[];
  rows: Array<Array<number | null>>;
}

export interface AppSessionChunk {
  schema_version: "1";
  session_id: string;
  chunk_id: string;
  sequence: number;
  started_at_utc: string;
  created_at_utc: string;
  app_version: string;
  environment: Record<string, CaptureValue>;
  reason: string;
  events: SessionEvent[];
  sensors: SensorBatch[];
  dropped_records: number;
}

export interface SessionRecordingStatus {
  enabled: boolean;
  pending_chunks: number;
  paused: boolean;
  pending_bytes: number;
  dropped_records: number;
  persistence_error: string | null;
}

export interface CaptureSink {
  record(kind: string, data?: Record<string, CaptureValue>, target?: string): void;
  sensor(type: SensorBatch["type"], columns: string[], units: string[], row: Array<number | null>): void;
}
