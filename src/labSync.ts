export type ProbeResult = { status: "reachable" | "unavailable" | "invalid"; sessionSchema: string | null };
export type UploadResult = "stored" | "rejected" | "failed";
export type UploadIdentity = { run_id: string } | { note_id: string } | { session_id: string; chunk_id: string };

/** Fetch cannot distinguish a policy refusal from a network failure by timing. */
export async function probeLabEndpoint(endpoint: string, timeoutMs = 4000): Promise<ProbeResult> {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${endpoint}/api/runs/ping`, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) return { status: "invalid", sessionSchema: null };
    const acknowledgement = await response.json();
    return {
      status: acknowledgement?.ok === true ? "reachable" : "invalid",
      sessionSchema: typeof acknowledgement?.app_session_schema === "string" ? acknowledgement.app_session_schema : null,
    };
  } catch (error) {
    return { status: error instanceof SyntaxError ? "invalid" : "unavailable", sessionSchema: null };
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

/** Only an explicit receipt for this exact item may retire its local copy. */
export async function postToLab(url: string, body: string, expected: UploadIdentity, timeoutMs = 60000): Promise<UploadResult> {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
    if (response.ok) {
      const acknowledgement = await response.json();
      return acknowledgement?.ok === true && Object.entries(expected).every(([key, value]) => acknowledgement[key] === value)
        ? "stored" : "failed";
    }
    if (response.status === 408 || response.status === 425 || response.status === 429) return "failed";
    return response.status >= 400 && response.status < 500 ? "rejected" : "failed";
  } catch {
    return "failed";
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}
