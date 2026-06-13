/**
 * Scored-write helpers for the log endpoints. These return the computed scores
 * (the engine runs server-side on every save), which the log screens surface
 * immediately. Reads and CRUD go through ApiDataLayer; this module is just the
 * thin "save and get my scores back" path.
 */
import { request } from "@/lib/http";

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
