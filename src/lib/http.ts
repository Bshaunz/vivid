/**
 * Shared HTTP layer. Resolves the API base once and exposes a typed `request`.
 *
 * Base resolution: VITE_API_URL wins; in dev it defaults to the local FastAPI
 * (localhost:8000); in prod an unset value means same-origin. The app is now
 * API-first — localStorage is no longer a runtime data source.
 *
 * Auth: every request carries the active Supabase session as a Bearer token
 * (see authHeader). When Supabase is unconfigured (local dev → backend
 * DEV_MODE bypass) no header is sent and the backend uses its dev user.
 */
import { supabase } from "@/lib/supabase";

const RAW_BASE =
  (import.meta.env.VITE_API_URL as string | undefined) ??
  (import.meta.env.DEV ? "http://127.0.0.1:8000" : "");

export const API_BASE = RAW_BASE.replace(/\/$/, "");

/** The Authorization header for the current session, or {} when signed out /
 *  unconfigured. getSession() reads from localStorage (no network) and the
 *  client auto-refreshes the JWT, so this is always a live, unexpired token. */
async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface ApiError extends Error {
  status?: number;
  /** FastAPI `detail` string, when the error body carried one. */
  detail?: string;
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
  const headers: Record<string, string> = {
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
    ...(await authHeader()),
  };
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
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
    // Surface FastAPI's `detail` (string form) so callers can show the reason.
    let detail: string | undefined;
    try {
      const data = (await res.json()) as { detail?: unknown };
      if (typeof data?.detail === "string") detail = data.detail;
    } catch {
      /* non-JSON body — fall back to the generic message */
    }
    const err: ApiError = new Error(detail ?? `Request failed (${res.status})`);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
