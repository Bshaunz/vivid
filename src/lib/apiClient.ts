/**
 * Scored-write helpers for the log endpoints. These return the computed scores
 * (the engine runs server-side on every save), which the log screens surface
 * immediately. Reads and CRUD go through ApiDataLayer; this module is just the
 * thin "save and get my scores back" path.
 */
import { request } from "@/lib/http";
import type { AISynthesis } from "@/types/domain";

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

export function saveMorningLog(payload: MorningPayload): Promise<LogSaveResponse> {
  return request<LogSaveResponse>("POST", "/api/logs/morning", payload);
}

export function saveEveningLog(payload: EveningPayload): Promise<LogSaveResponse> {
  return request<LogSaveResponse>("POST", "/api/logs/evening", payload);
}

/**
 * Generate (or, with force, regenerate) the weekly AI synthesis for an ISO-week
 * Monday. The client only ever names the week — the cross-pillar payload is
 * assembled server-side from the authenticated user's own data (§3.1). Lives
 * here rather than on DataLayer because generation is a server-only capability;
 * the retired LocalStorageDataLayer can't synthesize, so the read contract
 * (listSyntheses / getSynthesisForWeek) stays stable.
 *
 * Surfaces the server's status codes to callers: 404 (no logged days),
 * 429 (token budget), as ApiError.status.
 */
export function generateWeeklySynthesis(weekStart: string, force = false): Promise<AISynthesis> {
  return request<AISynthesis>("POST", "/api/synthesis/weekly", { week_start: weekStart, force });
}
