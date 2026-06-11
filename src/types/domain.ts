/**
 * VIVID domain types — 1:1 mirror of supabase/migrations/0001_init.sql.
 *
 * Field names are snake_case to match the database columns exactly, so the
 * localStorage → FastAPI/Supabase swap requires no mapping layer. Dates are
 * ISO strings: `YYYY-MM-DD` for date columns, full ISO 8601 for timestamps.
 */

export type Pillar = "Health" | "Fitness" | "Finances";
export type FrequencyType = "daily" | "weekly" | "monthly";
export type GoalType = "metric" | "habit";
export type MetricDirection = "above" | "below";
export type SynthesisType = "weekly" | "daily" | "ondemand";
export type CustomMetricType = "number" | "scale" | "boolean";
export type UpdateFrequency = "daily" | "weekly";
export type CurrencyCode = "CAD" | "USD";
export type UnitPreference = "lbs" | "kg";

/** 0 = Sunday … 6 = Saturday */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface NotificationPrefs {
  morning_time?: string; // "07:00"
  evening_time?: string; // "21:00"
  weekly_time?: string; // "18:00" (Sunday)
}

export interface UserProfile {
  id: string;
  email: string;
  name: string | null;
  currency: CurrencyCode;
  unit_pref: UnitPreference;
  active_pillars: Pillar[];
  daily_budget: number | null;
  notification_prefs: NotificationPrefs;
  consent_accepted_at: string;
  created_at: string;
}

export interface DailyLog {
  id: number;
  user_id: string;
  date: string;

  // Morning Log — Input State
  bodyweight: number | null;
  sleep_hours: number | null;
  sleep_minutes: number | null;
  morning_readiness: number | null;
  rhr: number | null;
  hrv: number | null;
  caffeine_delay: boolean | null;
  morning_done: boolean;

  // Evening Log — Output State
  deep_work_hours: number | null;
  training_done: boolean | null;
  macro_adherence: boolean | null;
  caloric_variance_pct: number | null;
  discretionary_spend: number | null;
  daily_reflection: string | null;
  workout_rpe: number | null;
  screen_time_hours: number | null;
  evening_done: boolean;

  /** Derived: sleep_hours * 60 + sleep_minutes (generated column in Postgres) */
  sleep_total_minutes: number | null;
}

/** Required morning fields are non-optional — the type enforces completeness. */
export interface MorningLogInput {
  bodyweight: number;
  sleep_hours: number;
  sleep_minutes: number;
  morning_readiness: number;
  rhr?: number | null;
  hrv?: number | null;
  caffeine_delay?: boolean | null;
}

/** Required evening fields are non-optional — the type enforces completeness. */
export interface EveningLogInput {
  deep_work_hours: number;
  training_done: boolean;
  macro_adherence: boolean;
  discretionary_spend: number;
  caloric_variance_pct?: number | null;
  daily_reflection?: string | null;
  workout_rpe?: number | null;
  screen_time_hours?: number | null;
}

export interface Habit {
  id: number;
  user_id: string;
  name: string;
  description: string | null;
  /** null = unassigned → contributes directly to Day Score */
  pillar: Pillar | null;
  frequency_type: FrequencyType;
  frequency_count: number;
  frequency_days: Weekday[] | null;
  is_preset: boolean;
  is_active: boolean;
  created_at: string;
}

export type HabitInput = Omit<Habit, "id" | "user_id" | "created_at">;

export interface HabitCompletion {
  id: number;
  user_id: string;
  habit_id: number;
  date: string;
  completed: boolean;
}

export interface WeeklyLog {
  id: number;
  user_id: string;
  /** ISO Monday of the week under review */
  week_start: string;
  avg_bodyweight_7d: number | null;
  bodyweight_goal: number | null;
  total_training_sessions: number | null;
  capital_allocated: number | null;
  bottleneck_audit: string | null;
  posts_published: number | null;
  followers: number | null;
  waitlist_signups: number | null;
}

export type WeeklyLogInput = Omit<WeeklyLog, "id" | "user_id">;

/** Mirror of v_weekly_rollup — prefills the Sunday review. */
export interface WeeklyRollup {
  week_start: string;
  avg_bodyweight_7d: number | null;
  total_training_sessions: number;
  morning_logs_completed: number;
  evening_logs_completed: number;
}

export interface Goal {
  id: number;
  user_id: string;
  name: string;
  type: GoalType;

  metric_key: string | null;
  metric_target_value: number | null;
  metric_current_value: number | null;
  metric_direction: MetricDirection | null;

  habit_id: number | null;
  habit_target_days: number | null;
  habit_completed_days: number | null;
  habit_target_rate: number | null;

  /** null = tracked and displayed, not scored */
  pillar: Pillar | null;
  target_date: string;
  is_active: boolean;
  completed: boolean;
  created_at: string;
}

export type GoalInput = Omit<Goal, "id" | "user_id" | "created_at">;

export interface AISynthesis {
  id: number;
  user_id: string;
  generated_at: string;
  type: SynthesisType;
  content: string;
}

export interface CustomMetric {
  id: number;
  user_id: string;
  name: string;
  unit: string | null;
  type: CustomMetricType;
  update_frequency: UpdateFrequency;
  created_at: string;
}

export type CustomMetricInput = Omit<CustomMetric, "id" | "user_id" | "created_at">;

export interface CustomMetricEntry {
  id: number;
  user_id: string;
  metric_id: number;
  date: string;
  value: number;
}
