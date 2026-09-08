export interface LabHandoverBatch {
  id: string;
  endpoint: string;
  expires_at: number;
  run_ids: string[];
  note_ids: string[];
  session_ids: string[];
}

const KEY = "greenlake_lab_handover_batch";
const safeIds = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 25000
  && value.every((id) => typeof id === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(id));

export function loadLabHandoverBatch(): LabHandoverBatch | null {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "null") as LabHandoverBatch | null;
    if (!value || typeof value.id !== "string" || !/^[a-f0-9-]{36}$/.test(value.id)
      || typeof value.endpoint !== "string" || !Number.isFinite(value.expires_at) || value.expires_at < Date.now()
      || !safeIds(value.run_ids) || !safeIds(value.note_ids) || !safeIds(value.session_ids)) return null;
    return value;
  } catch {
    return null;
  }
}

export function saveLabHandoverBatch(batch: LabHandoverBatch): void {
  localStorage.setItem(KEY, JSON.stringify(batch));
}

export function createLabHandoverBatch(endpoint: string, runIds: string[], noteIds: string[], sessionIds: string[]): LabHandoverBatch {
  const batch: LabHandoverBatch = {
    id: crypto.randomUUID(), endpoint, expires_at: Date.now() + 30 * 60 * 1000,
    run_ids: runIds, note_ids: noteIds, session_ids: sessionIds,
  };
  saveLabHandoverBatch(batch);
  return batch;
}

export function clearLabHandoverBatch(): void {
  localStorage.removeItem(KEY);
}

export function labHandoverPendingCount(batch: LabHandoverBatch): number {
  return batch.run_ids.length + batch.note_ids.length + batch.session_ids.length;
}
