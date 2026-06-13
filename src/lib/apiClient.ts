/**
 * Thin FastAPI client for the log endpoints (build step 5).
 *
 * Transitional by design: the backend currently exposes only morning/evening,
 * so reads still come from the local DataLayer cache. When VITE_API_URL is set,
 * a save POSTs to the real API (server-side validation + scoring) and the
 * computed scores come back in the response. When it is unset, the client is a
 * no-op and the app runs purely on localStorage — so the UI works offline and
 * in pure-frontend demos with the identical optimistic flow.
 */

const BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "");

export interface ApiError extends Error {
  status?: number;
}

export interface PillarScoreOut {
  score: number | null;
  core_composite: number | null;
  blocks: Record<string, number | null>;
  dropped: string[];
  habit_weight: number;
  habit_rate: number | null;
}

export interface ScoresOut {
  day_score: number;
  composite: number;
  pillar_scores: Record<string, number>;
  pillar_weights: Record<string, number>;
  unassigned_weight: number;
  pillars: Record<string, PillarScoreOut>;
}

export interface LogSaveResponse {
  scores: ScoresOut;
}

export interface MorningPayload {
  date: string;
  morning_readiness: number;
  sleep_hours: number;
  rhr?: number | null;
  hrv?: number | null;
  bodyweight?: number | null;
}

export interface EveningPayload {
  date: string;
  training_done: boolean;
  deep_work_hours: number;
  discretionary_spend: number;
  macro_adherence?: boolean | null;
  caloric_variance_pct?: number | null;
  workout_rpe?: number | null;
  daily_reflection?: string | null;
  bodyweight?: number | null;
}

/** True when a real backend is wired; lets screens write-through to local too. */
export function apiConfigured(): boolean {
  return !!BASE;
}

async function post<T>(path: string, body: unknown): Promise<T | null> {
  if (!BASE) return null; // local-only mode
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    const err: ApiError = new Error("Network error");
    throw Object.assign(err, { cause });
  }
  if (!res.ok) {
    const err: ApiError = new Error(`Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

export function saveMorningLog(payload: MorningPayload): Promise<LogSaveResponse | null> {
  return post<LogSaveResponse>("/api/logs/morning", payload);
}

export function saveEveningLog(payload: EveningPayload): Promise<LogSaveResponse | null> {
  return post<LogSaveResponse>("/api/logs/evening", payload);
}
