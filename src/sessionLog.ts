import type { AppSessionChunk, CaptureContext, CaptureSink, CaptureValue, SensorBatch, SessionEvent, SessionRecordingStatus } from "./captureTypes";
import { IDB_STORE_NAME, openRunDatabase as openSharedRunDatabase } from "./storage";

const PREFIX = "session_chunk:";
const CHECKPOINT_PREFIX = "greenlake_session_checkpoint:";
const ENABLED_KEY = "greenlake_detailed_recording";
const MAX_PENDING_BYTES = 20 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 256 * 1024;
const CHUNK_TARGET_BYTES = 16 * 1024;
const MAX_CHUNK_BYTES = 96 * 1024;
const DEFAULT_BATCH = 12;
const encoder = new TextEncoder();
const waiting = new Map<string, AppSessionChunk>();
const recorders = new Set<SessionRecorder>();
const activeClears = new Set<Set<string>>();
const pendingDrops = new Map<string, number>();
let waitingBytes = 0;
let storageError: string | null = null;
let queue: Promise<unknown> = Promise.resolve();
let pendingBytes = 0;
let pendingCount = 0;
let capacityBlocked = false;
const META_PREFIX = "session_meta:";
const TOTALS_KEY = "session_totals";
const storedWaiting = new Set<string>();
interface QueueTotals { bytes: number; count: number; drops: Record<string, number> }
interface ChunkMeta { bytes: number; session_id: string; dropped_records: number }
const emptyTotals = (): QueueTotals => ({ bytes: 0, count: 0, drops: {} });

function adjustTotals(totals: QueueTotals, meta: ChunkMeta, direction: 1 | -1): void {
  totals.bytes = Math.max(0, totals.bytes + direction * meta.bytes);
  totals.count = Math.max(0, totals.count + direction);
  const drops = Math.max(0, (totals.drops[meta.session_id] ?? 0) + direction * meta.dropped_records);
  if (drops) totals.drops[meta.session_id] = drops;
  else delete totals.drops[meta.session_id];
}

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work, work);
  queue = result.catch(() => undefined);
  return result;
}

async function openRunDatabase(): Promise<IDBDatabase | null> {
  try {
    return await openSharedRunDatabase();
  } catch {
    storageError = "Session database access was denied; retaining crash checkpoints.";
    return null;
  }
}

function byteSize(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function identifier(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function token(value: string, fallback = "redacted"): string {
  return /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,95}$/.test(value) ? value : fallback;
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(value);
}

function retainWaiting(chunk: AppSessionChunk): void {
  if (waiting.has(chunk.chunk_id)) return;
  waiting.set(chunk.chunk_id, chunk);
  waitingBytes += byteSize(chunk);
}

function retireWaiting(id: string): void {
  const chunk = waiting.get(id);
  if (!chunk) return;
  waitingBytes -= byteSize(chunk);
  waiting.delete(id);
  storedWaiting.delete(id);
}

const PRIVATE_KEY = /password|secret|token|payload|clipboard|question|answer|message|stack|url|href|query|hash|transcript|filename|email|address|text|content/i;
const STRING_KEY = /^(state|status|reason|source|screen|type|input_type|operation|permission|error_type|category|visibility|orientation|effective_type|connection_type|mode|action|phase|sensor|method|protocol_id|run_id|session_id|value|target|format|unit|result)$/;

function safeData(data?: Record<string, CaptureValue>): Record<string, CaptureValue> | undefined {
  if (!data) return undefined;
  const result: Record<string, CaptureValue> = {};
  for (const [key, value] of Object.entries(data).slice(0, 64)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) || PRIVATE_KEY.test(key)) continue;
    if (value === null || typeof value === "boolean") result[key] = value;
    else if (typeof value === "number") result[key] = Number.isFinite(value) ? value : null;
    else if (typeof value === "string") result[key] = STRING_KEY.test(key) ? token(value) : "redacted";
  }
  return Object.keys(result).length ? result : undefined;
}

function checkpointKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key?.startsWith(CHECKPOINT_PREFIX)) keys.push(key);
  }
  return keys;
}

function checkpoint(chunk: AppSessionChunk): boolean {
  try {
    const key = CHECKPOINT_PREFIX + chunk.chunk_id;
    const json = JSON.stringify(chunk);
    let size = encoder.encode(json).byteLength;
    for (const other of checkpointKeys()) {
      if (other !== key) size += encoder.encode(localStorage.getItem(other) ?? "").byteLength;
    }
    if (size > MAX_CHECKPOINT_BYTES) {
      storageError = "Crash checkpoint storage is full; keep this app open and sync to the lab.";
      return false;
    }
    localStorage.setItem(key, json);
    return true;
  } catch {
    storageError = "Crash checkpoint could not be saved; recent activity may be lost if the app closes.";
    return false;
  }
}

function removeCheckpoint(id: string): boolean {
  try {
    localStorage.removeItem(CHECKPOINT_PREFIX + id);
    return true;
  } catch {
    storageError = "A saved checkpoint could not be retired; an acknowledged chunk may be sent again.";
    return false;
  }
}

// Only our versioned, size-bounded records are accepted from the crash journal.
function isChunk(value: unknown): value is AppSessionChunk {
  if (!value || typeof value !== "object") return false;
  const c = value as AppSessionChunk;
  return c.schema_version === "1" && safeId(c.chunk_id) && safeId(c.session_id)
    && Number.isSafeInteger(c.sequence) && c.sequence >= 0
    && typeof c.started_at_utc === "string" && typeof c.created_at_utc === "string"
    && typeof c.app_version === "string" && typeof c.reason === "string"
    && !!c.environment && typeof c.environment === "object"
    && Array.isArray(c.events) && c.events.length <= 256
    && Array.isArray(c.sensors) && c.sensors.length <= 32
    && Number.isSafeInteger(c.dropped_records) && c.dropped_records >= 0
    && byteSize(c) <= MAX_CHUNK_BYTES;
}

function recoverCheckpoints(): void {
  try {
    for (const key of checkpointKeys()) {
      try {
        const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
        if (!isChunk(value) || key !== CHECKPOINT_PREFIX + value.chunk_id) {
          storageError = "A session checkpoint is damaged; it was retained, not deleted.";
          continue;
        }
        retainWaiting(value);
      } catch {
        storageError = "A session checkpoint is unreadable; it was retained, not deleted.";
      }
    }
  } catch {
    storageError = "Session crash checkpoints are unavailable in this browser.";
  }
}

async function readStored(): Promise<AppSessionChunk[]> {
  const db = await openRunDatabase();
  if (!db) throw new Error("Session database is unavailable; retaining crash checkpoints.");
  try {
    return await new Promise<AppSessionChunk[]>((resolve, reject) => {
      const rows: AppSessionChunk[] = [];
      const tx = db.transaction(IDB_STORE_NAME, "readonly");
      const request = tx.objectStore(IDB_STORE_NAME).openCursor(IDBKeyRange.bound(PREFIX, PREFIX + "\uffff"));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (isChunk(cursor.value)) rows.push(cursor.value);
        else storageError = "A stored session chunk is damaged; it was retained, not deleted.";
        cursor.continue();
      };
      tx.oncomplete = () => resolve(rows);
      tx.onerror = tx.onabort = () => reject(new Error("Session database could not be read."));
    });
  } finally {
    db.close();
  }
}

async function storeChunk(chunk: AppSessionChunk): Promise<boolean> {
  const db = await openRunDatabase();
  if (!db) {
    storageError = "Session database is unavailable; retaining crash checkpoints.";
    return false;
  }
  try {
    return await new Promise<boolean>((resolve) => {
      const tx = db.transaction(IDB_STORE_NAME, "readwrite");
      const store = tx.objectStore(IDB_STORE_NAME);
      let accepted = false;
      const totalsRequest = store.get(TOTALS_KEY);
      totalsRequest.onsuccess = () => {
        const totals: QueueTotals = totalsRequest.result ?? emptyTotals();
        const existing = store.get(PREFIX + chunk.chunk_id);
        existing.onsuccess = () => {
          if (existing.result) {
            accepted = JSON.stringify(existing.result) === JSON.stringify(chunk);
            if (!accepted) storageError = "Session chunk identity conflict; both copies were retained for recovery.";
            return;
          }
          const meta: ChunkMeta = { bytes: byteSize(chunk), session_id: chunk.session_id, dropped_records: chunk.dropped_records };
          if (totals.bytes + meta.bytes > MAX_PENDING_BYTES) {
            capacityBlocked = true;
            storageError = "Session storage is full (20 MB). Capture is paused; sync or explicitly clear recorded sessions.";
            return;
          }
          store.add(chunk, PREFIX + chunk.chunk_id);
          store.add(meta, META_PREFIX + chunk.chunk_id);
          adjustTotals(totals, meta, 1);
          store.put(totals, TOTALS_KEY);
          accepted = true;
        };
      };
      tx.oncomplete = () => resolve(accepted);
      tx.onerror = tx.onabort = () => {
        storageError = "Session database write failed; retaining crash checkpoints.";
        resolve(false);
      };
    });
  } catch {
    storageError = "Session database write failed; retaining crash checkpoints.";
    return false;
  } finally {
    db.close();
  }
}

async function settle(): Promise<void> {
  storageError = null;
  recoverCheckpoints();
  for (const [id, chunk] of waiting) {
    if (await storeChunk(chunk)) {
      storedWaiting.add(id);
      if (removeCheckpoint(id)) retireWaiting(id);
    }
  }
  const db = await openRunDatabase();
  if (db) {
    try {
      // Aggregate metadata is updated atomically with each chunk. Never rescan
      // megabytes of old sensor rows on every five-second live checkpoint.
      const totals = await new Promise<QueueTotals>((resolve, reject) => {
        const tx = db.transaction(IDB_STORE_NAME, "readonly");
        const request = tx.objectStore(IDB_STORE_NAME).get(TOTALS_KEY);
        let value = emptyTotals();
        request.onsuccess = () => { value = request.result ?? emptyTotals(); };
        tx.oncomplete = () => resolve(value);
        tx.onerror = tx.onabort = () => reject(new Error("Session queue totals could not be read."));
      });
      pendingCount = totals.count;
      pendingBytes = totals.bytes;
      pendingDrops.clear();
      for (const [id, count] of Object.entries(totals.drops)) pendingDrops.set(id, count);
      for (const [id, chunk] of waiting) {
        if (storedWaiting.has(id)) continue;
        pendingCount += 1;
        pendingBytes += byteSize(chunk);
        pendingDrops.set(chunk.session_id, (pendingDrops.get(chunk.session_id) ?? 0) + chunk.dropped_records);
      }
    } catch {
      storageError = "Session queue totals could not be read; captured records are retained.";
    } finally {
      db.close();
    }
  } else {
    pendingCount = Math.max(pendingCount, waiting.size);
    pendingBytes = Math.max(pendingBytes, waitingBytes);
    storageError = "Session database is unavailable; retaining crash checkpoints.";
  }
  capacityBlocked = pendingBytes >= MAX_PENDING_BYTES;
  if (capacityBlocked) storageError = "Session storage is full (20 MB). Capture is paused; sync or explicitly clear recorded sessions.";
  for (const recorder of recorders) recorder.publishStatus();
}

export function getDetailedRecordingEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== "false";
  } catch {
    storageError = "Recording preferences are unavailable; detailed recording defaults to enabled.";
    return true;
  }
}

export function listSessionChunks(limit = DEFAULT_BATCH): Promise<AppSessionChunk[]> {
  return serialize(async () => {
    await settle();
    let stored: AppSessionChunk[] = [];
    try { stored = await readStored(); } catch {
      storageError = "Session database could not be read; only crash-checkpoint data is available.";
      for (const recorder of recorders) recorder.publishStatus();
    }
    const merged = new Map(stored.map((chunk) => [chunk.chunk_id, chunk]));
    for (const [id, chunk] of waiting) if (!merged.has(id)) merged.set(id, structuredClone(chunk));
    const chunks = [...merged.values()].sort((a, b) => a.created_at_utc.localeCompare(b.created_at_utc)
      || a.session_id.localeCompare(b.session_id) || a.sequence - b.sequence);
    return chunks.slice(0, limit === Infinity ? undefined : Math.max(0, Math.floor(Number.isFinite(limit) ? limit : DEFAULT_BATCH)));
  });
}

export function markSessionChunkSynced(chunkId: string): Promise<boolean> {
  if (!safeId(chunkId)) return Promise.resolve(false);
  return serialize(async () => {
    const db = await openRunDatabase();
    if (!db) {
      storageError = "Could not save the lab acknowledgement; the chunk was retained for retry.";
      for (const recorder of recorders) recorder.publishStatus();
      return false;
    }
    let deleted = false;
    try {
      deleted = await new Promise<boolean>((resolve) => {
        const tx = db.transaction(IDB_STORE_NAME, "readwrite");
        const store = tx.objectStore(IDB_STORE_NAME);
        const totalsRequest = store.get(TOTALS_KEY);
        totalsRequest.onsuccess = () => {
          const totals: QueueTotals = totalsRequest.result ?? emptyTotals();
          const metaRequest = store.get(META_PREFIX + chunkId);
          metaRequest.onsuccess = () => {
            if (metaRequest.result) adjustTotals(totals, metaRequest.result, -1);
            store.delete(PREFIX + chunkId);
            store.delete(META_PREFIX + chunkId);
            store.put(totals, TOTALS_KEY);
          };
        };
        tx.oncomplete = () => resolve(true);
        tx.onerror = tx.onabort = () => resolve(false);
      });
    } catch {
      deleted = false;
    } finally {
      db.close();
    }
    if (!deleted || !removeCheckpoint(chunkId)) {
      storageError = "Could not retire an acknowledged session chunk; it was retained for retry.";
      for (const recorder of recorders) recorder.publishStatus();
      return false;
    }
    retireWaiting(chunkId);
    await settle();
    return true;
  });
}

type RecorderOptions = {
  appVersion: string;
  getContext: () => CaptureContext;
  onStatus: (status: SessionRecordingStatus) => void;
};

type Battery = EventTarget & { charging: boolean; level: number };
type Connection = EventTarget & { effectiveType?: string; type?: string; downlink?: number; rtt?: number; saveData?: boolean };

export class SessionRecorder implements CaptureSink {
  readonly sessionId = identifier("session");
  private readonly startedAt = new Date().toISOString();
  private readonly clockStart = performance.now();
  private readonly options: RecorderOptions;
  private enabled = getDetailedRecordingEnabled();
  private started = false;
  private startedOnce = false;
  private generation = 0;
  private sequence = 0;
  private eventSequence = 0;
  private buffer: AppSessionChunk | null = null;
  private bufferBytes = 0;
  private sensorRows = 0;
  private dropped = 0;
  private unreportedDropped = 0;
  private localError: string | null = null;
  private previousStatus = "";
  private listeners: Array<() => void> = [];
  private timer: number | null = null;
  private lastSeal = performance.now();
  private lastScroll = 0;
  private previousScrollY = 0;

  constructor(options: RecorderOptions) {
    this.options = options;
  }


  publishStatus(): void {
    const status: SessionRecordingStatus = {
      enabled: this.enabled,
      paused: capacityBlocked || waitingBytes >= MAX_CHECKPOINT_BYTES - MAX_CHUNK_BYTES,
      pending_chunks: pendingCount,
      pending_bytes: pendingBytes,
      dropped_records: this.dropped + [...pendingDrops].reduce((sum, [id, count]) => sum + (id === this.sessionId ? 0 : count), 0),
      persistence_error: capacityBlocked || waitingBytes >= MAX_CHECKPOINT_BYTES - MAX_CHUNK_BYTES
        ? "Recording paused because unsent storage is full. Sync to the lab; no unsent records were evicted."
        : this.localError ?? storageError,
    };
    const encoded = JSON.stringify(status);
    if (encoded === this.previousStatus) return;
    this.previousStatus = encoded;
    this.options.onStatus(status);
  }

  private context(): CaptureContext {
    const context = this.options.getContext();
    return {
      screen: token(context.screen),
      run_id: safeId(context.run_id) ? context.run_id : null,
      elapsed_seconds: typeof context.elapsed_seconds === "number" && Number.isFinite(context.elapsed_seconds)
        ? Math.max(0, context.elapsed_seconds) : null,
    };
  }

  private environment(): Record<string, CaptureValue> {
    return {
      viewport_width: window.innerWidth,
      viewport_height: window.innerHeight,
      pixel_ratio: window.devicePixelRatio,
      touch_points: navigator.maxTouchPoints,
      standalone: window.matchMedia("(display-mode: standalone)").matches,
      online: navigator.onLine,
      timezone_offset_minutes: new Date().getTimezoneOffset(),
      time_origin_ms: performance.timeOrigin,
    };
  }

  private ensureBuffer(): AppSessionChunk {
    if (!this.buffer) {
      this.buffer = {
        schema_version: "1",
        session_id: this.sessionId,
        chunk_id: identifier("chunk"),
        sequence: this.sequence++,
        started_at_utc: this.startedAt,
        created_at_utc: new Date().toISOString(),
        app_version: token(this.options.appVersion),
        environment: this.environment(),
        reason: "checkpoint",
        events: [],
        sensors: [],
        dropped_records: this.unreportedDropped,
      };
      for (const protectedIds of activeClears) protectedIds.add(this.buffer.chunk_id);
      this.unreportedDropped = 0;
      this.bufferBytes = byteSize(this.buffer);
      this.sensorRows = 0;
    }
    return this.buffer;
  }

  private accepts(): boolean {
    if (!this.started || !this.enabled) return false;
    if (capacityBlocked || pendingBytes + this.bufferBytes >= MAX_PENDING_BYTES || waitingBytes >= MAX_CHECKPOINT_BYTES - MAX_CHUNK_BYTES) {
      this.dropped += 1;
      this.unreportedDropped += 1;
      return false;
    }
    return true;
  }

  record(kind: string, data?: Record<string, CaptureValue>, target?: string): void {
    if (!this.accepts()) return;
    const event: SessionEvent = {
      ...this.context(), seq: this.eventSequence++, at_utc: new Date().toISOString(),
      t_ms: Math.max(0, Math.round(performance.now() - this.clockStart)), kind: token(kind),
    };
    if (target) event.target = token(target);
    const cleaned = safeData(data);
    if (cleaned) event.data = cleaned;
    const bytes = byteSize(event) + 1;
    if (this.buffer && (this.bufferBytes + bytes > CHUNK_TARGET_BYTES || this.buffer.events.length >= 256)) this.seal("size");
    this.ensureBuffer().events.push(event);
    this.bufferBytes += bytes;
  }

  sensor(type: SensorBatch["type"], columns: string[], units: string[], row: Array<number | null>): void {
    if (!this.accepts()) return;
    const runId = this.context().run_id;
    if (!runId) return;
    if (!["motion", "orientation", "ambient_light"].includes(type) || columns.length < 1 || columns.length > 32
      || columns.length !== units.length || columns.length !== row.length
      || columns.some((column) => !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(column))
      || units.some((unit) => !/^[A-Za-z0-9_/.^%°²³ -]{0,32}$/.test(unit))) {
      this.dropped += 1;
      this.unreportedDropped += 1;
      return;
    }
    const cleanRow = row.map((value) => typeof value === "number" && Number.isFinite(value) ? value : null);
    const bytes = byteSize(cleanRow) + 1;
    if (this.buffer && (this.bufferBytes + bytes + 1024 > CHUNK_TARGET_BYTES || this.sensorRows >= 1024)) this.seal("size");
    let buffer = this.ensureBuffer();
    const matches = (batch: SensorBatch) => batch.run_id === runId && batch.type === type
      && batch.columns.length === columns.length && batch.columns.every((column, i) => column === columns[i] && batch.units[i] === units[i]);
    let batch = buffer.sensors.find(matches);
    if (!batch && buffer.sensors.length >= 32) {
      this.seal("size");
      buffer = this.ensureBuffer();
    }
    if (!batch) {
      batch = { run_id: runId, type, columns: [...columns], units: [...units], rows: [] };
      this.bufferBytes += byteSize(batch) + 1;
      buffer.sensors.push(batch);
    }
    batch.rows.push(cleanRow);
    this.bufferBytes += bytes;
    this.sensorRows += 1;
  }


  private seal(reason: string): boolean {
    if (!this.buffer && this.unreportedDropped > 0 && waitingBytes < MAX_CHECKPOINT_BYTES - MAX_CHUNK_BYTES) this.ensureBuffer();
    if (!this.buffer) return false;
    const chunk = this.buffer;
    chunk.reason = token(reason);
    chunk.dropped_records += this.unreportedDropped;
    this.unreportedDropped = 0;
    this.buffer = null;
    this.bufferBytes = 0;
    this.sensorRows = 0;
    this.lastSeal = performance.now();
    retainWaiting(chunk);
    checkpoint(chunk);
    this.publishStatus();
    void serialize(settle);
    return true;
  }

  flush(reason = "flush"): Promise<void> {
    const sealed = this.seal(reason);
    return sealed ? queue.then(() => undefined) : serialize(async () => { await settle(); });
  }

  refreshStatus(): Promise<void> {
    return serialize(async () => {
      await settle();
      this.publishStatus();
    });
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    if (!enabled) {
      this.record("recording_disabled");
      this.seal("disabled");
    }
    this.enabled = enabled;
    try {
      localStorage.setItem(ENABLED_KEY, String(enabled));
      this.localError = null;
    } catch {
      this.localError = "Recording preference could not be saved; it may reset after reload.";
    }
    if (enabled) this.record("recording_enabled");
    this.publishStatus();
  }

  clear(): Promise<void> {
    // Reset live buffers synchronously: captures after this call get new identities.
    const ids = new Set(waiting.keys());
    const protectedIds = new Set<string>();
    activeClears.add(protectedIds);
    for (const recorder of recorders) {
      if (recorder.buffer) ids.add(recorder.buffer.chunk_id);
      recorder.buffer = null;
      recorder.bufferBytes = 0;
      recorder.sensorRows = 0;
      recorder.dropped = 0;
      recorder.unreportedDropped = 0;
    }
    try {
      for (const key of checkpointKeys()) ids.add(key.slice(CHECKPOINT_PREFIX.length));
    } catch {
      this.localError = "Could not enumerate crash checkpoints for clearing.";
    }
    return serialize(async () => {
      const db = await openRunDatabase();
      if (!db) {
        this.localError = "Could not clear session storage; recorded chunks were retained.";
        this.publishStatus();
        return;
      }
      let cleared = false;
      try {
        cleared = await new Promise<boolean>((resolve) => {
          const tx = db.transaction(IDB_STORE_NAME, "readwrite");
          const store = tx.objectStore(IDB_STORE_NAME);
          const cursorRequest = store.openKeyCursor(IDBKeyRange.bound(PREFIX, PREFIX + "\uffff"));
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (cursor) {
              const id = String(cursor.key).slice(PREFIX.length);
              if (!protectedIds.has(id)) {
                store.delete(cursor.primaryKey);
                store.delete(META_PREFIX + id);
              }
              cursor.continue();
              return;
            }
            const totals = emptyTotals();
            const metas = store.openCursor(IDBKeyRange.bound(META_PREFIX, META_PREFIX + "\uffff"));
            metas.onsuccess = () => {
              const meta = metas.result;
              if (!meta) { store.put(totals, TOTALS_KEY); return; }
              adjustTotals(totals, meta.value, 1);
              meta.continue();
            };
          };
          tx.oncomplete = () => resolve(true);
          tx.onerror = tx.onabort = () => resolve(false);
        });
      } catch {
        cleared = false;
      } finally {
        db.close();
      }
      if (cleared) {
        let checkpointsCleared = true;
        for (const id of ids) {
          if (removeCheckpoint(id)) retireWaiting(id);
          else checkpointsCleared = false;
        }
        this.localError = checkpointsCleared ? null : "Some crash checkpoints could not be cleared.";
      } else this.localError = "Could not clear session storage; recorded chunks were retained.";
      await settle();
      this.publishStatus();
    }).finally(() => { activeClears.delete(protectedIds); });
  }

  private listen(target: EventTarget, type: string, listener: EventListener, capture = false): void {
    target.addEventListener(type, listener, { capture, passive: true });
    this.listeners.push(() => target.removeEventListener(type, listener, capture));
  }

  private target(element: Element): string {
    const explicit = element.closest("[data-session-target]")?.getAttribute("data-session-target");
    if (explicit) return token(explicit);
    const type = element instanceof HTMLInputElement ? token(element.type) : element.tagName.toLowerCase();
    // Structural identity is useful without copying a label, question, name, or id.
    const siblings = element.parentElement?.children;
    const index = siblings ? Array.prototype.indexOf.call(siblings, element) as number : 0;
    return `${type}.${Math.max(0, index)}`;
  }

  private control(event: Event): void {
    const origin = event.target;
    if (!(origin instanceof Element)) return;
    const element = origin.closest("button,a,input,select,textarea,summary,[role=button],[data-session-target],form");
    if (!element) return;
    const data: Record<string, CaptureValue> = { type: element.tagName.toLowerCase() };
    if (element instanceof HTMLInputElement) data.input_type = token(element.type);
    if (event.type === "change") {
      if (element instanceof HTMLInputElement) {
        if (element.type === "checkbox" || element.type === "radio") data.checked = element.checked;
        else if (element.type === "number" || element.type === "range") data.number = Number.isFinite(element.valueAsNumber) ? element.valueAsNumber : null;
        else if (element.type !== "password" && element.type !== "hidden" && element.type !== "file") data.length = element.value.length;
      } else if (element instanceof HTMLTextAreaElement) data.length = element.value.length;
      else if (element instanceof HTMLSelectElement) {
        data.selected_index = element.selectedIndex;
        data.selected_count = element.selectedOptions.length;
        const safeValue = element.selectedOptions[0]?.getAttribute("data-session-value");
        if (safeValue) data.value = token(safeValue);
      }
      const safeValue = element.getAttribute("data-session-value");
      if (safeValue && !(element instanceof HTMLInputElement && ["password", "hidden", "file"].includes(element.type))
        && !(element instanceof HTMLTextAreaElement)) data.value = token(safeValue);
    }
    this.record(event.type === "focusin" ? "focus" : event.type === "focusout" ? "blur" : event.type, data, this.target(element));
  }

  private viewport(): void {
    this.record("viewport", {
      width: window.innerWidth, height: window.innerHeight,
      orientation: token(screen.orientation?.type ?? "unavailable"),
      angle: screen.orientation?.angle ?? null,
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const generation = ++this.generation;
    recorders.add(this);
    if (!this.startedOnce) {
      this.startedOnce = true;
      this.record("session_start");
    }
    for (const type of ["click", "change", "focusin", "focusout", "submit"]) this.listen(document, type, (event) => this.control(event), true);
    this.listen(document, "toggle", (event) => {
      if (event.target instanceof HTMLDetailsElement) this.record("details", { open: event.target.open }, this.target(event.target));
    }, true);
    this.listen(document, "scroll", (event) => {
      const now = performance.now();
      if (now - this.lastScroll < 1000) return;
      const element = event.target instanceof Element ? event.target : document.scrollingElement;
      const y = element?.scrollTop ?? window.scrollY;
      this.record("scroll", { direction: Math.sign(y - this.previousScrollY), distance_bucket: Math.min(20, Math.floor(Math.abs(y - this.previousScrollY) / 100)) }, element ? this.target(element) : "document");
      this.previousScrollY = y;
      this.lastScroll = now;
    }, true);
    this.listen(document, "visibilitychange", () => {
      this.record("visibility", { visibility: document.visibilityState });
      if (document.visibilityState === "hidden") this.seal("hidden");
      else void this.refreshStatus();
    });
    this.listen(window, "pagehide", (event) => {
      this.record("pagehide", { persisted: (event as PageTransitionEvent).persisted });
      this.seal("pagehide");
    });
    this.listen(window, "pageshow", (event) => {
      this.record("pageshow", { persisted: (event as PageTransitionEvent).persisted });
      void this.refreshStatus();
    });
    this.listen(window, "resize", () => this.viewport());
    if (screen.orientation) this.listen(screen.orientation, "change", () => this.viewport());
    for (const type of ["online", "offline"]) this.listen(window, type, () => this.record("connectivity", { online: navigator.onLine }));
    this.listen(window, "error", (event) => {
      const error = (event as ErrorEvent).error as unknown;
      const name = error instanceof Error && ["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError"].includes(error.name) ? error.name : "unknown";
      const detail = event as ErrorEvent;
      this.record("error", {
        error_type: name, category: event.target === window ? "runtime" : "resource",
        line: detail.lineno || null, column: detail.colno || null,
      });
    }, true);
    this.listen(window, "unhandledrejection", () => this.record("unhandled_rejection", { reason: "redacted" }));
    const nav = navigator as Navigator & { connection?: Connection; getBattery?: () => Promise<Battery> };
    if (nav.connection) {
      const connection = nav.connection;
      const report = () => this.record("network", {
        effective_type: token(connection.effectiveType ?? "unavailable"),
        connection_type: token(connection.type ?? "unavailable"),
        downlink_mbps: typeof connection.downlink === "number" ? Math.round(connection.downlink) : null,
        rtt_ms: typeof connection.rtt === "number" ? Math.round(connection.rtt / 50) * 50 : null,
        save_data: connection.saveData ?? null,
      });
      report();
      this.listen(connection, "change", report);
    } else this.record("network", { status: "unsupported" });
    if (nav.getBattery) {
      void Promise.resolve().then(() => nav.getBattery!()).then((battery) => {
        if (!this.started || this.generation !== generation) return;
        const report = () => this.record("battery", { charging: battery.charging, level_percent: Number.isFinite(battery.level) ? Math.round(battery.level * 20) * 5 : null });
        report();
        this.listen(battery, "chargingchange", report);
        this.listen(battery, "levelchange", report);
      }).catch(() => {
        if (this.started && this.generation === generation) this.record("battery", { status: "unavailable" });
      });
    } else this.record("battery", { status: "unsupported" });
    this.timer = window.setInterval(() => {
      if (performance.now() - this.lastSeal >= 5000 && (this.buffer || this.unreportedDropped > 0)) this.seal("interval");
      this.publishStatus();
    }, 1000);
    void this.refreshStatus();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.generation += 1;
    for (const remove of this.listeners) remove();
    this.listeners = [];
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    // No synthetic stop event: StrictMode cleanup is not a real user session end.
    void this.flush("stop");
    recorders.delete(this);
  }
}
