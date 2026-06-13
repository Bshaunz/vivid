import { useQuery } from "@tanstack/react-query";
import { request } from "@/lib/http";
import type { ScoresOut } from "@/lib/apiClient";

/**
 * The single dashboard read. Everything on Home and Pillars derives from this
 * one payload — no parallel fetch flows. `days` parameterizes the window; the
 * duration selector swaps it, and TanStack caches per window.
 */

export interface DailyAnalysisRow {
  date: string;
  morning_readiness: number | null;
  sleep_hours: number | null;
  rhr: number | null;
  hrv: number | null;
  training_done: boolean | null;
  workout_rpe: number | null;
  deep_work_hours: number | null;
  macro_adherence: boolean | null;
  caloric_variance_pct: number | null;
  discretionary_spend: number | null;
  morning_done: boolean;
  evening_done: boolean;
  due_count: number;
  completed_count: number;
  habit_completion_ratio: number | null;
}

export interface DayScorePoint {
  date: string;
  day_score: number;
  health: number | null;
  fitness: number | null;
  finance: number | null;
}

export interface WeeklyBodyweightRow {
  week_start: string;
  weekly_median_bodyweight: number;
  n_samples: number;
  low_confidence: boolean;
}

export interface DashboardData {
  from_date: string;
  to_date: string;
  days: DailyAnalysisRow[];
  today_scores: ScoresOut;
  score_series: DayScorePoint[];
  latest_bodyweight: number | null;
  weekly_bodyweight: WeeklyBodyweightRow[];
}

export function useDashboard(days: number) {
  return useQuery({
    queryKey: ["dashboard", days],
    queryFn: () => request<DashboardData>("GET", `/api/dashboard?days=${days}`),
  });
}
