/**
 * Shared HTTP layer. Resolves the API base once and exposes a typed `request`.
 *
 * Base resolution: VITE_API_URL wins; in dev it defaults to the local FastAPI
 * (localhost:8000); in prod an unset value means same-origin. The app is now
 * API-first — localStorage is no longer a runtime data source.
 */
const RAW_BASE =
  (import.meta.env.VITE_API_URL as string | undefined) ??
  (import.meta.env.DEV ? "http://127.0.0.1:8000" : "");

export const API_BASE = RAW_BASE.replace(/\/$/, "");

export interface ApiError extends Error {
  status?: number;
}

const TIMEOUT_MS = 15_000;

export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const hasBody = body !== undefined;
  // Bound every request: a hung backend rejects with a clear timeout error
  // (surfaced as an error state / toast) instead of spinning indefinitely.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: hasBody ? { "Content-Type": "application/json" } : undefined,
      body: hasBody ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (cause) {
    const aborted = cause instanceof DOMException && cause.name === "AbortError";
    const err: ApiError = new Error(aborted ? "Request timed out" : "Network error");
    throw Object.assign(err, { cause });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const err: ApiError = new Error(`Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
