import type {
  AISynthesis,
  BodyweightEntry,
  DailyLog,
  EveningLogInput,
  Goal,
  GoalInput,
  Habit,
  HabitCompletion,
  HabitInput,
  MorningLogInput,
  UserProfile,
  WeeklyBodyweight,
  WeeklyLog,
  WeeklyLogInput,
  WeeklySummary,
} from "../types/domain";

/**
 * DataLayer — the single contract between the UI and persistence.
 *
 * UI components import ONLY this interface (via useApp()). They never touch
 * localStorage, fetch, or supabase-js directly. Every method is async even
 * where the current backing store is synchronous, so swapping in the
 * FastAPI/Supabase implementation changes zero call sites.
 *
 * All `date` parameters are `YYYY-MM-DD`. All `week_start` parameters are the
 * ISO Monday of the week, matching the weekly_logs check constraint.
 */
export interface DataLayer {
  // ── User ─────────────────────────────────────────────────────────────────
  getProfile(): Promise<UserProfile | null>;
  saveProfile(
    profile: Omit<UserProfile, "id" | "created_at"> & Partial<Pick<UserProfile, "id" | "created_at">>,
  ): Promise<UserProfile>;
  updateProfile(patch: Partial<Omit<UserProfile, "id" | "created_at">>): Promise<UserProfile>;
  /** PIPEDA: delete account and all data. */
  deleteAllData(): Promise<void>;

  // ── Daily logs ───────────────────────────────────────────────────────────
  getDailyLog(date: string): Promise<DailyLog | null>;
  /** Inclusive range, ascending by date. */
  getDailyLogs(fromDate: string, toDate: string): Promise<DailyLog[]>;
  /** Upserts the day row, sets morning fields, marks morning_done. */
  saveMorningLog(date: string, input: MorningLogInput): Promise<DailyLog>;
  /** Upserts the day row, sets evening fields, marks evening_done. */
  saveEveningLog(date: string, input: EveningLogInput): Promise<DailyLog>;

  // ── Bodyweight (separate entity: many per day; scored only as weekly median) ─
  addBodyweightEntry(value: number, loggedAt?: string): Promise<BodyweightEntry>;
  /** Inclusive range by calendar day of logged_at, ascending. */
  getBodyweightEntries(fromDate: string, toDate: string): Promise<BodyweightEntry[]>;
  /** Most recent sample, or null. Used as a placeholder hint, never prefilled. */
  getLatestBodyweight(): Promise<BodyweightEntry | null>;
  /** Median of the ISO week's samples — the only bodyweight value anything
   *  scores or charts (§4). Null when the week has no samples. */
  getWeeklyBodyweight(weekStart: string): Promise<WeeklyBodyweight | null>;

  // ── Habits ───────────────────────────────────────────────────────────────
  listHabits(opts?: { activeOnly?: boolean }): Promise<Habit[]>;
  createHabit(input: HabitInput): Promise<Habit>;
  updateHabit(id: number, patch: Partial<HabitInput>): Promise<Habit>;
  /** Soft delete: sets is_active = false, preserves completion history. */
  archiveHabit(id: number): Promise<void>;

  // ── Habit completions ────────────────────────────────────────────────────
  setHabitCompletion(habitId: number, date: string, completed: boolean): Promise<HabitCompletion>;
  /** Inclusive range, all habits. */
  getHabitCompletions(fromDate: string, toDate: string): Promise<HabitCompletion[]>;

  // ── Weekly logs ──────────────────────────────────────────────────────────
  getWeeklyLog(weekStart: string): Promise<WeeklyLog | null>;
  listWeeklyLogs(limit?: number): Promise<WeeklyLog[]>;
  saveWeeklyLog(input: WeeklyLogInput): Promise<WeeklyLog>;
  /** Read-only anchors for the Sunday review (median bw + sessions logged). */
  getWeeklySummary(weekStart: string): Promise<WeeklySummary>;

  // ── Goals (display-only) ───────────────────────────────────────────────────
  listGoals(opts?: { activeOnly?: boolean }): Promise<Goal[]>;
  createGoal(input: GoalInput): Promise<Goal>;
  updateGoal(id: number, patch: Partial<GoalInput>): Promise<Goal>;
  deleteGoal(id: number): Promise<void>;

  // ── AI syntheses ─────────────────────────────────────────────────────────
  listSyntheses(opts?: { limit?: number }): Promise<AISynthesis[]>;
  getSynthesisForWeek(weekStart: string): Promise<AISynthesis | null>;
}
