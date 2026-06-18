/**
 * VIVID domain types — 1:1 mirror of supabase/migrations/0001_init.sql (v4.0).
 *
 * Field names are snake_case to match the DB columns exactly, so the
 * localStorage → FastAPI/Supabase swap needs no mapping layer. Dates are ISO
 * strings: `YYYY-MM-DD` for date columns, full ISO 8601 for timestamps.
 *
 * v4 contract (do not drift):
 *  - Bodyweight is NOT on daily_logs. It lives in bodyweight_entries (many per
 *    day) and is consumed only as a weekly median (WeeklyBodyweight).
 *  - daily_logs has training_done(bool), not a 3-state status. Rest days are a
 *    scoring concern derived from habit frequency_days, never logged here.
 *  - No screen_time, no caffeine_delay, no custom metrics — cut in §4.
 *  - Goals are display-only: they feed no score (§6.7).
 */

export type Pillar = "Health" | "Fitness" | "Finances";
export type FrequencyType = "daily" | "weekly" | "monthly";
export type GoalType = "metric" | "habit";
export type GoalDirection = "above" | "below";
/** MVP ships weekly only; post-launch types are added by migration. */
export type SynthesisType = "weekly";
export type CurrencyCode = "CAD" | "USD";
export type UnitPreference = "lbs" | "kg";

/** ISO weekday: 1 = Monday … 7 = Sunday (matches Postgres isodow). */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Metrics eligible for the baseline/deviation layer (§6.8). */
export type BaselineMetricKey =
  | "morning_readiness"
  | "sleep_hours"
  | "rhr"
  | "hrv"
  | "deep_work_hours"
  | "discretionary_spend"
  | "weekly_median_bodyweight";

export interface UserProfile {
  id: string;
  email: string;
  name: string | null;
  currency: CurrencyCode;
  unit_pref: UnitPreference;
  active_pillars: Pillar[];
  daily_budget: number | null;
  /** Profile setting in v4, not a weekly-log field. Drives bw_trend (§6.3). */
  bodyweight_goal: number | null;
  consent_timestamp: string;
  created_at: string;
}

export interface DailyLog {
  id: number;
  user_id: string;
  date: string;

  // Morning (AM)
  morning_readiness: number | null; // 1–10
  sleep_hours: number | null; // float, 0–16
  rhr: number | null;
  hrv: number | null;
  morning_done: boolean;

  // Evening (PM)
  training_done: boolean | null;
  workout_rpe: number | null; // 1–10
  deep_work_hours: number | null;
  macro_adherence: boolean | null;
  caloric_variance_pct: number | null;
  discretionary_spend: number | null;
  daily_reflection: string | null;
  evening_done: boolean;
}

/** Required morning fields are non-optional — the type enforces completeness. */
export interface MorningLogInput {
  morning_readiness: number;
  sleep_hours: number;
  rhr?: number | null;
  hrv?: number | null;
}

/** Required evening fields are non-optional — the type enforces completeness. */
export interface EveningLogInput {
  training_done: boolean;
  deep_work_hours: number;
  discretionary_spend: number;
  macro_adherence?: boolean | null;
  caloric_variance_pct?: number | null;
  workout_rpe?: number | null;
  daily_reflection?: string | null;
}

/** Raw bodyweight sample. Many per day allowed; never scored or charted raw. */
export interface BodyweightEntry {
  id: number;
  user_id: string;
  logged_at: string; // ISO 8601 timestamp
  value: number;
}

/** Derived (v_weekly_bodyweight) — the ONLY bodyweight series anything scores
 *  or charts. low_confidence flags weeks with 1–2 samples (§4 bodyweight rule). */
export interface WeeklyBodyweight {
  week_start: string;
  weekly_median_bodyweight: number;
  n_samples: number;
  low_confidence: boolean;
}

export interface Habit {
  id: number;
  user_id: string;
  name: string;
  description: string | null;
  /** null = unassigned → contributes to Day Score u_weight block (§6.7). */
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
  /** ISO Monday of the week under review. */
  week_start: string;
  capital_allocated: number;
  bottleneck_audit: string | null;
}

export type WeeklyLogInput = Omit<WeeklyLog, "id" | "user_id">;

/** Read-only anchors prefilling the Sunday review, computed from the week's
 *  own logs and bodyweight entries — never persisted into weekly_logs. */
export interface WeeklySummary {
  week_start: string;
  /** Weekly median from bodyweight_entries (§4), null when no samples. */
  median_bodyweight: number | null;
  n_bw_samples: number;
  low_confidence: boolean;
  training_sessions: number; // count of training_done = true
  evenings_logged: number;
}

/** DISPLAY-ONLY in MVP (§6.7): progress is rendered, never scored. */
export interface Goal {
  id: number;
  user_id: string;
  name: string;
  type: GoalType;

  // metric goals
  metric_key: string | null;
  target_value: number | null;
  direction: GoalDirection | null;

  // habit goals
  habit_id: number | null;

  /** Display badge only. */
  pillar: Pillar | null;
  target_date: string;
  is_active: boolean;
  completed: boolean;
  created_at: string;
}

export type GoalInput = Omit<Goal, "id" | "user_id" | "created_at">;

export interface Baseline {
  id: number;
  user_id: string;
  metric_key: BaselineMetricKey;
  window_days: number;
  mean: number;
  sd: number;
  n_observations: number;
  computed_at: string;
}

export interface AISynthesis {
  id: number;
  user_id: string;
  generated_at: string;
  type: SynthesisType;
  /** ISO Monday of the synthesized week (added step 10). */
  week_start: string;
  /** 0–100, deterministic mean Day Score recomputed by the engine on read
   *  (added step 10). Never produced by the LLM. */
  optimization_score: number;
  /** Bullet insights parsed server-side from `content` (added step 10). */
  insights: string[];
  content: string;
  tokens_in: number;
  tokens_out: number;
  model: string;
  /** True when the POST returned an idempotent cache hit rather than a fresh
   *  generation (present on generate responses; absent on stored reads). */
  cached?: boolean;
}
