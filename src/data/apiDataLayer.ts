import type { DataLayer } from "./DataLayer";
import { request } from "@/lib/http";
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
 * HTTP-backed DataLayer — the live runtime implementation. Every method maps to
 * a FastAPI endpoint; responses are snake_case and so deserialize straight into
 * the domain types. The server owns ownership/validation (§3.1, §3.5), so this
 * layer is a thin transport.
 *
 * Synthesis reads are live as of step 10 (GET /api/synthesis*); generation is a
 * server-only POST exposed via apiClient.generateWeeklySynthesis, not DataLayer.
 */
export class ApiDataLayer implements DataLayer {
  // ── User ─────────────────────────────────────────────────────────────────
  getProfile(): Promise<UserProfile | null> {
    return request<UserProfile>("GET", "/api/profile");
  }

  saveProfile(
    profile: Omit<UserProfile, "id" | "created_at"> & Partial<Pick<UserProfile, "id" | "created_at">>,
  ): Promise<UserProfile> {
    return request<UserProfile>("PUT", "/api/profile", profile);
  }

  updateProfile(patch: Partial<Omit<UserProfile, "id" | "created_at">>): Promise<UserProfile> {
    return request<UserProfile>("PUT", "/api/profile", patch);
  }

  async deleteAllData(): Promise<void> {
    // Account deletion endpoint lands with Settings (build step 14).
    throw new Error("deleteAllData: not implemented on the API yet");
  }

  // ── Daily logs ─────────────────────────────────────────────────────────────
  getDailyLog(date: string): Promise<DailyLog | null> {
    return request<DailyLog | null>("GET", `/api/logs/${date}`);
  }

  getDailyLogs(fromDate: string, toDate: string): Promise<DailyLog[]> {
    return request<DailyLog[]>("GET", `/api/logs?from=${fromDate}&to=${toDate}`);
  }

  async saveMorningLog(date: string, input: MorningLogInput): Promise<DailyLog> {
    const res = await request<{ log: DailyLog }>("POST", "/api/logs/morning", { date, ...input });
    return res.log;
  }

  async saveEveningLog(date: string, input: EveningLogInput): Promise<DailyLog> {
    const res = await request<{ log: DailyLog }>("POST", "/api/logs/evening", { date, ...input });
    return res.log;
  }

  // ── Bodyweight ─────────────────────────────────────────────────────────────
  addBodyweightEntry(value: number, loggedAt?: string): Promise<BodyweightEntry> {
    return request<BodyweightEntry>("POST", "/api/bodyweight", {
      value,
      ...(loggedAt ? { logged_at: loggedAt } : {}),
    });
  }

  getBodyweightEntries(fromDate: string, toDate: string): Promise<BodyweightEntry[]> {
    return request<BodyweightEntry[]>("GET", `/api/bodyweight?from=${fromDate}&to=${toDate}`);
  }

  getLatestBodyweight(): Promise<BodyweightEntry | null> {
    return request<BodyweightEntry | null>("GET", "/api/bodyweight/latest");
  }

  getWeeklyBodyweight(weekStart: string): Promise<WeeklyBodyweight | null> {
    return request<WeeklyBodyweight | null>("GET", `/api/bodyweight/weekly/${weekStart}`);
  }

  // ── Habits ───────────────────────────────────────────────────────────────
  listHabits(opts?: { activeOnly?: boolean }): Promise<Habit[]> {
    return request<Habit[]>("GET", `/api/habits?active_only=${opts?.activeOnly ? "true" : "false"}`);
  }

  createHabit(input: HabitInput): Promise<Habit> {
    return request<Habit>("POST", "/api/habits", input);
  }

  updateHabit(id: number, patch: Partial<HabitInput>): Promise<Habit> {
    return request<Habit>("PUT", `/api/habits/${id}`, patch);
  }

  archiveHabit(id: number): Promise<void> {
    return request<void>("DELETE", `/api/habits/${id}`);
  }

  // ── Habit completions ────────────────────────────────────────────────────
  setHabitCompletion(
    habitId: number,
    date: string,
    completed: boolean,
    quantity: number | null = null,
  ): Promise<HabitCompletion> {
    return request<HabitCompletion>("PUT", `/api/habits/${habitId}/completion`, {
      date,
      completed,
      quantity,
    });
  }

  getHabitCompletions(fromDate: string, toDate: string): Promise<HabitCompletion[]> {
    return request<HabitCompletion[]>("GET", `/api/habits/completions?from=${fromDate}&to=${toDate}`);
  }

  // ── Weekly logs ──────────────────────────────────────────────────────────
  getWeeklyLog(weekStart: string): Promise<WeeklyLog | null> {
    return request<WeeklyLog | null>("GET", `/api/weekly/${weekStart}`);
  }

  listWeeklyLogs(limit?: number): Promise<WeeklyLog[]> {
    return request<WeeklyLog[]>("GET", `/api/weekly${limit !== undefined ? `?limit=${limit}` : ""}`);
  }

  saveWeeklyLog(input: WeeklyLogInput): Promise<WeeklyLog> {
    return request<WeeklyLog>("POST", "/api/weekly", input);
  }

  getWeeklySummary(weekStart: string): Promise<WeeklySummary> {
    return request<WeeklySummary>("GET", `/api/weekly/${weekStart}/summary`);
  }

  // ── Goals (display-only) ───────────────────────────────────────────────────
  listGoals(opts?: { activeOnly?: boolean }): Promise<Goal[]> {
    return request<Goal[]>("GET", `/api/goals?active_only=${opts?.activeOnly ? "true" : "false"}`);
  }

  createGoal(input: GoalInput): Promise<Goal> {
    return request<Goal>("POST", "/api/goals", input);
  }

  updateGoal(id: number, patch: Partial<GoalInput>): Promise<Goal> {
    return request<Goal>("PUT", `/api/goals/${id}`, patch);
  }

  deleteGoal(id: number): Promise<void> {
    return request<void>("DELETE", `/api/goals/${id}`);
  }

  // ── AI syntheses ────────────────────────────────────────────────────────────
  listSyntheses(opts?: { limit?: number }): Promise<AISynthesis[]> {
    const q = opts?.limit !== undefined ? `?limit=${opts.limit}` : "";
    return request<AISynthesis[]>("GET", `/api/synthesis${q}`);
  }

  getSynthesisForWeek(weekStart: string): Promise<AISynthesis | null> {
    return request<AISynthesis | null>("GET", `/api/synthesis/weekly/${weekStart}`);
  }
}
