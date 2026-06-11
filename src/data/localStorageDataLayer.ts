import type { DataLayer } from "./DataLayer";
import type {
  AISynthesis,
  CustomMetric,
  CustomMetricEntry,
  CustomMetricInput,
  DailyLog,
  EveningLogInput,
  Goal,
  GoalInput,
  Habit,
  HabitCompletion,
  HabitInput,
  MorningLogInput,
  SynthesisType,
  UserProfile,
  WeeklyLog,
  WeeklyLogInput,
  WeeklyRollup,
} from "../types/domain";
import { todayISO } from "../lib/dates";

/**
 * localStorage-backed DataLayer (MVP).
 *
 * Mirrors the Postgres schema's integrity rules in code: unique (user, date)
 * per daily log, unique (habit, date) per completion, required-field checks
 * before a log half is marked done, and range checks identical to the SQL
 * check constraints. Data written here is shaped exactly like the API
 * payloads the FastAPI backend will accept, so migration is an export/import.
 */

const NS = "vivid:v1";
const LOCAL_USER_ID = "local-user";

type CollectionKey =
  | "profile"
  | "daily_logs"
  | "habits"
  | "habit_completions"
  | "weekly_logs"
  | "goals"
  | "ai_syntheses"
  | "custom_metrics"
  | "custom_metric_entries"
  | "seq";

function key(k: CollectionKey): string {
  return `${NS}:${k}`;
}

function read<T>(k: CollectionKey, fallback: T): T {
  const raw = localStorage.getItem(key(k));
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function write(k: CollectionKey, value: unknown): void {
  localStorage.setItem(key(k), JSON.stringify(value));
}

function nextId(): number {
  const n = read<number>("seq", 0) + 1;
  write("seq", n);
  return n;
}

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(`[vivid:data] ${message}`);
}

function inRange(v: number, lo: number, hi: number): boolean {
  return Number.isFinite(v) && v >= lo && v <= hi;
}

function emptyDailyLog(date: string): DailyLog {
  return {
    id: nextId(),
    user_id: LOCAL_USER_ID,
    date,
    bodyweight: null,
    sleep_hours: null,
    sleep_minutes: null,
    morning_readiness: null,
    rhr: null,
    hrv: null,
    caffeine_delay: null,
    morning_done: false,
    deep_work_hours: null,
    training_done: null,
    macro_adherence: null,
    caloric_variance_pct: null,
    discretionary_spend: null,
    daily_reflection: null,
    workout_rpe: null,
    screen_time_hours: null,
    evening_done: false,
    sleep_total_minutes: null,
  };
}

export class LocalStorageDataLayer implements DataLayer {
  // ── User ─────────────────────────────────────────────────────────────────

  async getProfile(): Promise<UserProfile | null> {
    return read<UserProfile | null>("profile", null);
  }

  async saveProfile(
    profile: Omit<UserProfile, "id" | "created_at"> & Partial<Pick<UserProfile, "id" | "created_at">>,
  ): Promise<UserProfile> {
    const existing = await this.getProfile();
    const full: UserProfile = {
      ...profile,
      id: existing?.id ?? profile.id ?? LOCAL_USER_ID,
      created_at: existing?.created_at ?? profile.created_at ?? new Date().toISOString(),
    };
    write("profile", full);
    return full;
  }

  async updateProfile(patch: Partial<Omit<UserProfile, "id" | "created_at">>): Promise<UserProfile> {
    const existing = await this.getProfile();
    assert(existing !== null, "updateProfile: no profile exists");
    const updated: UserProfile = { ...existing, ...patch };
    write("profile", updated);
    return updated;
  }

  async deleteAllData(): Promise<void> {
    const keys: CollectionKey[] = [
      "profile",
      "daily_logs",
      "habits",
      "habit_completions",
      "weekly_logs",
      "goals",
      "ai_syntheses",
      "custom_metrics",
      "custom_metric_entries",
      "seq",
    ];
    for (const k of keys) localStorage.removeItem(key(k));
  }

  // ── Daily logs ───────────────────────────────────────────────────────────

  async getDailyLog(date: string): Promise<DailyLog | null> {
    const logs = read<DailyLog[]>("daily_logs", []);
    return logs.find((l) => l.date === date) ?? null;
  }

  async getDailyLogs(fromDate: string, toDate: string): Promise<DailyLog[]> {
    const logs = read<DailyLog[]>("daily_logs", []);
    return logs
      .filter((l) => l.date >= fromDate && l.date <= toDate)
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  private upsertDailyLog(date: string, mutate: (log: DailyLog) => void): DailyLog {
    const logs = read<DailyLog[]>("daily_logs", []);
    let log = logs.find((l) => l.date === date);
    if (!log) {
      log = emptyDailyLog(date);
      logs.push(log);
    }
    mutate(log);
    // mirror the generated column
    log.sleep_total_minutes =
      log.sleep_hours !== null && log.sleep_minutes !== null
        ? log.sleep_hours * 60 + log.sleep_minutes
        : null;
    write("daily_logs", logs);
    return log;
  }

  async saveMorningLog(date: string, input: MorningLogInput): Promise<DailyLog> {
    assert(input.bodyweight > 0, "bodyweight must be > 0");
    assert(inRange(input.sleep_hours, 0, 24), "sleep_hours must be 0–24");
    assert(inRange(input.sleep_minutes, 0, 59), "sleep_minutes must be 0–59");
    assert(inRange(input.morning_readiness, 1, 10), "morning_readiness must be 1–10");
    if (input.rhr != null) assert(inRange(input.rhr, 20, 250), "rhr out of range");
    if (input.hrv != null) assert(inRange(input.hrv, 0, 300), "hrv out of range");

    return this.upsertDailyLog(date, (log) => {
      log.bodyweight = input.bodyweight;
      log.sleep_hours = input.sleep_hours;
      log.sleep_minutes = input.sleep_minutes;
      log.morning_readiness = input.morning_readiness;
      log.rhr = input.rhr ?? null;
      log.hrv = input.hrv ?? null;
      log.caffeine_delay = input.caffeine_delay ?? null;
      log.morning_done = true;
    });
  }

  async saveEveningLog(date: string, input: EveningLogInput): Promise<DailyLog> {
    assert(inRange(input.deep_work_hours, 0, 24), "deep_work_hours must be 0–24");
    assert(input.discretionary_spend >= 0, "discretionary_spend must be >= 0");
    if (input.workout_rpe != null) assert(inRange(input.workout_rpe, 1, 10), "workout_rpe must be 1–10");
    if (input.screen_time_hours != null)
      assert(inRange(input.screen_time_hours, 0, 24), "screen_time_hours must be 0–24");

    return this.upsertDailyLog(date, (log) => {
      log.deep_work_hours = input.deep_work_hours;
      log.training_done = input.training_done;
      log.macro_adherence = input.macro_adherence;
      log.caloric_variance_pct = input.caloric_variance_pct ?? null;
      log.discretionary_spend = input.discretionary_spend;
      log.daily_reflection = input.daily_reflection ?? null;
      log.workout_rpe = input.workout_rpe ?? null;
      log.screen_time_hours = input.screen_time_hours ?? null;
      log.evening_done = true;
    });
  }

  // ── Habits ───────────────────────────────────────────────────────────────

  async listHabits(opts?: { activeOnly?: boolean }): Promise<Habit[]> {
    const habits = read<Habit[]>("habits", []);
    return opts?.activeOnly ? habits.filter((h) => h.is_active) : habits;
  }

  async createHabit(input: HabitInput): Promise<Habit> {
    assert(input.name.trim().length > 0, "habit name required");
    assert(input.frequency_count >= 1, "frequency_count must be >= 1");
    const habits = read<Habit[]>("habits", []);
    const habit: Habit = {
      ...input,
      id: nextId(),
      user_id: LOCAL_USER_ID,
      created_at: new Date().toISOString(),
    };
    habits.push(habit);
    write("habits", habits);
    return habit;
  }

  async updateHabit(id: number, patch: Partial<HabitInput>): Promise<Habit> {
    const habits = read<Habit[]>("habits", []);
    const idx = habits.findIndex((h) => h.id === id);
    assert(idx !== -1, `updateHabit: habit ${id} not found`);
    habits[idx] = { ...habits[idx], ...patch };
    write("habits", habits);
    return habits[idx];
  }

  async archiveHabit(id: number): Promise<void> {
    await this.updateHabit(id, { is_active: false });
  }

  // ── Habit completions ────────────────────────────────────────────────────

  async setHabitCompletion(habitId: number, date: string, completed: boolean): Promise<HabitCompletion> {
    const habits = read<Habit[]>("habits", []);
    assert(habits.some((h) => h.id === habitId), `setHabitCompletion: habit ${habitId} not found`);

    const completions = read<HabitCompletion[]>("habit_completions", []);
    let row = completions.find((c) => c.habit_id === habitId && c.date === date);
    if (row) {
      row.completed = completed;
    } else {
      row = { id: nextId(), user_id: LOCAL_USER_ID, habit_id: habitId, date, completed };
      completions.push(row);
    }
    write("habit_completions", completions);
    return row;
  }

  async getHabitCompletions(fromDate: string, toDate: string): Promise<HabitCompletion[]> {
    const completions = read<HabitCompletion[]>("habit_completions", []);
    return completions
      .filter((c) => c.date >= fromDate && c.date <= toDate)
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  // ── Weekly logs ──────────────────────────────────────────────────────────

  async getWeeklyLog(weekStart: string): Promise<WeeklyLog | null> {
    const logs = read<WeeklyLog[]>("weekly_logs", []);
    return logs.find((l) => l.week_start === weekStart) ?? null;
  }

  async listWeeklyLogs(limit?: number): Promise<WeeklyLog[]> {
    const logs = read<WeeklyLog[]>("weekly_logs", []).sort((a, b) =>
      b.week_start.localeCompare(a.week_start),
    );
    return limit !== undefined ? logs.slice(0, limit) : logs;
  }

  async saveWeeklyLog(input: WeeklyLogInput): Promise<WeeklyLog> {
    const logs = read<WeeklyLog[]>("weekly_logs", []);
    const idx = logs.findIndex((l) => l.week_start === input.week_start);
    if (idx !== -1) {
      logs[idx] = { ...logs[idx], ...input };
      write("weekly_logs", logs);
      return logs[idx];
    }
    const log: WeeklyLog = { ...input, id: nextId(), user_id: LOCAL_USER_ID };
    logs.push(log);
    write("weekly_logs", logs);
    return log;
  }

  async getWeeklyRollup(weekStart: string): Promise<WeeklyRollup> {
    const weekEnd = ((d) => {
      const [y, m, day] = d.split("-").map(Number);
      const dt = new Date(y, m - 1, day + 6);
      return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
    })(weekStart);

    const logs = await this.getDailyLogs(weekStart, weekEnd);
    const weights = logs.map((l) => l.bodyweight).filter((b): b is number => b !== null);
    return {
      week_start: weekStart,
      avg_bodyweight_7d:
        weights.length > 0
          ? Math.round((weights.reduce((s, w) => s + w, 0) / weights.length) * 100) / 100
          : null,
      total_training_sessions: logs.filter((l) => l.training_done === true).length,
      morning_logs_completed: logs.filter((l) => l.morning_done).length,
      evening_logs_completed: logs.filter((l) => l.evening_done).length,
    };
  }

  // ── Goals ────────────────────────────────────────────────────────────────

  async listGoals(opts?: { activeOnly?: boolean }): Promise<Goal[]> {
    const goals = read<Goal[]>("goals", []);
    return opts?.activeOnly ? goals.filter((g) => g.is_active) : goals;
  }

  async createGoal(input: GoalInput): Promise<Goal> {
    // mirror of the goal_shape check constraint
    if (input.type === "metric") {
      assert(
        input.metric_key !== null && input.metric_target_value !== null && input.metric_direction !== null,
        "metric goal requires metric_key, metric_target_value, metric_direction",
      );
    } else {
      assert(
        input.habit_id !== null && (input.habit_target_days !== null || input.habit_target_rate !== null),
        "habit goal requires habit_id and a target (days or rate)",
      );
    }
    const goals = read<Goal[]>("goals", []);
    const goal: Goal = {
      ...input,
      id: nextId(),
      user_id: LOCAL_USER_ID,
      created_at: new Date().toISOString(),
    };
    goals.push(goal);
    write("goals", goals);
    return goal;
  }

  async updateGoal(id: number, patch: Partial<GoalInput>): Promise<Goal> {
    const goals = read<Goal[]>("goals", []);
    const idx = goals.findIndex((g) => g.id === id);
    assert(idx !== -1, `updateGoal: goal ${id} not found`);
    goals[idx] = { ...goals[idx], ...patch };
    write("goals", goals);
    return goals[idx];
  }

  async deleteGoal(id: number): Promise<void> {
    const goals = read<Goal[]>("goals", []).filter((g) => g.id !== id);
    write("goals", goals);
  }

  // ── AI syntheses ─────────────────────────────────────────────────────────

  async listSyntheses(opts?: { type?: SynthesisType; limit?: number }): Promise<AISynthesis[]> {
    let rows = read<AISynthesis[]>("ai_syntheses", []).sort((a, b) =>
      b.generated_at.localeCompare(a.generated_at),
    );
    if (opts?.type) rows = rows.filter((r) => r.type === opts.type);
    return opts?.limit !== undefined ? rows.slice(0, opts.limit) : rows;
  }

  async addSynthesis(type: SynthesisType, content: string): Promise<AISynthesis> {
    const rows = read<AISynthesis[]>("ai_syntheses", []);
    const row: AISynthesis = {
      id: nextId(),
      user_id: LOCAL_USER_ID,
      generated_at: new Date().toISOString(),
      type,
      content,
    };
    rows.push(row);
    write("ai_syntheses", rows);
    return row;
  }

  async countOnDemandToday(): Promise<number> {
    const today = todayISO();
    return read<AISynthesis[]>("ai_syntheses", []).filter(
      (r) => r.type === "ondemand" && r.generated_at.slice(0, 10) === today,
    ).length;
  }

  // ── Custom metrics ───────────────────────────────────────────────────────

  async listCustomMetrics(): Promise<CustomMetric[]> {
    return read<CustomMetric[]>("custom_metrics", []);
  }

  async createCustomMetric(input: CustomMetricInput): Promise<CustomMetric> {
    assert(input.name.trim().length > 0, "custom metric name required");
    const metrics = read<CustomMetric[]>("custom_metrics", []);
    const metric: CustomMetric = {
      ...input,
      id: nextId(),
      user_id: LOCAL_USER_ID,
      created_at: new Date().toISOString(),
    };
    metrics.push(metric);
    write("custom_metrics", metrics);
    return metric;
  }

  async deleteCustomMetric(id: number): Promise<void> {
    write("custom_metrics", read<CustomMetric[]>("custom_metrics", []).filter((m) => m.id !== id));
    write(
      "custom_metric_entries",
      read<CustomMetricEntry[]>("custom_metric_entries", []).filter((e) => e.metric_id !== id),
    );
  }

  async setCustomMetricEntry(metricId: number, date: string, value: number): Promise<CustomMetricEntry> {
    const metrics = read<CustomMetric[]>("custom_metrics", []);
    assert(metrics.some((m) => m.id === metricId), `setCustomMetricEntry: metric ${metricId} not found`);

    const entries = read<CustomMetricEntry[]>("custom_metric_entries", []);
    let entry = entries.find((e) => e.metric_id === metricId && e.date === date);
    if (entry) {
      entry.value = value;
    } else {
      entry = { id: nextId(), user_id: LOCAL_USER_ID, metric_id: metricId, date, value };
      entries.push(entry);
    }
    write("custom_metric_entries", entries);
    return entry;
  }

  async getCustomMetricEntries(metricId: number, fromDate: string, toDate: string): Promise<CustomMetricEntry[]> {
    return read<CustomMetricEntry[]>("custom_metric_entries", [])
      .filter((e) => e.metric_id === metricId && e.date >= fromDate && e.date <= toDate)
      .sort((a, b) => a.date.localeCompare(b.date));
  }
}
