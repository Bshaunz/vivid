import type { DataLayer } from "./DataLayer";
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
import { addDays } from "../lib/dates";

/**
 * localStorage-backed DataLayer (MVP).
 *
 * Mirrors the v4 Postgres schema's integrity rules in code: unique (user,date)
 * per daily log, unique (user,habit,date) per completion, required-field checks
 * before a log half is marked done, and range checks identical to the SQL
 * check constraints. Data written here is shaped exactly like the API payloads
 * the FastAPI backend will accept, so migration is an export/import.
 *
 * Bodyweight is a separate collection (many per day) and is exposed to the rest
 * of the app only as a weekly median — raw values are never scored (§4).
 */

const NS = "vivid:v1";
const LOCAL_USER_ID = "local-user";

type CollectionKey =
  | "profile"
  | "daily_logs"
  | "bodyweight_entries"
  | "habits"
  | "habit_completions"
  | "weekly_logs"
  | "goals"
  | "ai_syntheses"
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

/** Median of a numeric list. Caller guarantees non-empty. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function emptyDailyLog(date: string): DailyLog {
  return {
    id: nextId(),
    user_id: LOCAL_USER_ID,
    date,
    morning_readiness: null,
    sleep_hours: null,
    rhr: null,
    hrv: null,
    morning_done: false,
    training_done: null,
    workout_rpe: null,
    deep_work_hours: null,
    macro_adherence: null,
    caloric_variance_pct: null,
    discretionary_spend: null,
    daily_reflection: null,
    evening_done: false,
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
      "bodyweight_entries",
      "habits",
      "habit_completions",
      "weekly_logs",
      "goals",
      "ai_syntheses",
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
    write("daily_logs", logs);
    return log;
  }

  async saveMorningLog(date: string, input: MorningLogInput): Promise<DailyLog> {
    assert(inRange(input.morning_readiness, 1, 10), "morning_readiness must be 1–10");
    assert(inRange(input.sleep_hours, 0, 16), "sleep_hours must be 0–16");
    if (input.rhr != null) assert(inRange(input.rhr, 20, 250), "rhr out of range");
    if (input.hrv != null) assert(inRange(input.hrv, 0, 300), "hrv out of range");

    return this.upsertDailyLog(date, (log) => {
      log.morning_readiness = input.morning_readiness;
      log.sleep_hours = input.sleep_hours;
      log.rhr = input.rhr ?? null;
      log.hrv = input.hrv ?? null;
      log.morning_done = true;
    });
  }

  async saveEveningLog(date: string, input: EveningLogInput): Promise<DailyLog> {
    assert(typeof input.training_done === "boolean", "training_done is required");
    assert(inRange(input.deep_work_hours, 0, 24), "deep_work_hours must be 0–24");
    assert(input.discretionary_spend >= 0, "discretionary_spend must be >= 0");
    if (input.workout_rpe != null) assert(inRange(input.workout_rpe, 1, 10), "workout_rpe must be 1–10");

    return this.upsertDailyLog(date, (log) => {
      log.training_done = input.training_done;
      log.deep_work_hours = input.deep_work_hours;
      log.discretionary_spend = input.discretionary_spend;
      log.macro_adherence = input.macro_adherence ?? null;
      log.caloric_variance_pct = input.caloric_variance_pct ?? null;
      log.workout_rpe = input.workout_rpe ?? null;
      log.daily_reflection = input.daily_reflection ?? null;
      log.evening_done = true;
    });
  }

  // ── Bodyweight ─────────────────────────────────────────────────────────────

  async addBodyweightEntry(value: number, loggedAt?: string): Promise<BodyweightEntry> {
    assert(inRange(value, 30, 660), "bodyweight must be 30–660");
    const entries = read<BodyweightEntry[]>("bodyweight_entries", []);
    const entry: BodyweightEntry = {
      id: nextId(),
      user_id: LOCAL_USER_ID,
      logged_at: loggedAt ?? new Date().toISOString(),
      value,
    };
    entries.push(entry);
    write("bodyweight_entries", entries);
    return entry;
  }

  async getBodyweightEntries(fromDate: string, toDate: string): Promise<BodyweightEntry[]> {
    // toDate is inclusive by calendar day, so compare against its end-of-day.
    const toExclusive = addDays(toDate, 1);
    return read<BodyweightEntry[]>("bodyweight_entries", [])
      .filter((e) => {
        const day = e.logged_at.slice(0, 10);
        return day >= fromDate && day < toExclusive;
      })
      .sort((a, b) => a.logged_at.localeCompare(b.logged_at));
  }

  async getLatestBodyweight(): Promise<BodyweightEntry | null> {
    const entries = read<BodyweightEntry[]>("bodyweight_entries", []);
    if (entries.length === 0) return null;
    return entries.reduce((latest, e) => (e.logged_at > latest.logged_at ? e : latest));
  }

  async getWeeklyBodyweight(weekStart: string): Promise<WeeklyBodyweight | null> {
    const weekEnd = addDays(weekStart, 6);
    const samples = (await this.getBodyweightEntries(weekStart, weekEnd)).map((e) => e.value);
    if (samples.length === 0) return null;
    return {
      week_start: weekStart,
      weekly_median_bodyweight: Math.round(median(samples) * 100) / 100,
      n_samples: samples.length,
      low_confidence: samples.length < 3,
    };
  }

  // ── Habits ───────────────────────────────────────────────────────────────

  async listHabits(opts?: { activeOnly?: boolean }): Promise<Habit[]> {
    const habits = read<Habit[]>("habits", []);
    return opts?.activeOnly ? habits.filter((h) => h.is_active) : habits;
  }

  async createHabit(input: HabitInput): Promise<Habit> {
    assert(input.name.trim().length > 0, "habit name required");
    assert(input.name.length <= 80, "habit name must be <= 80 chars");
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
    assert(input.capital_allocated >= 0, "capital_allocated must be >= 0");
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

  async getWeeklySummary(weekStart: string): Promise<WeeklySummary> {
    const weekEnd = addDays(weekStart, 6);
    const logs = await this.getDailyLogs(weekStart, weekEnd);
    const bw = await this.getWeeklyBodyweight(weekStart);
    return {
      week_start: weekStart,
      median_bodyweight: bw?.weekly_median_bodyweight ?? null,
      n_bw_samples: bw?.n_samples ?? 0,
      low_confidence: bw?.low_confidence ?? false,
      training_sessions: logs.filter((l) => l.training_done === true).length,
      evenings_logged: logs.filter((l) => l.evening_done).length,
    };
  }

  // ── Goals (display-only) ───────────────────────────────────────────────────

  async listGoals(opts?: { activeOnly?: boolean }): Promise<Goal[]> {
    const goals = read<Goal[]>("goals", []);
    return opts?.activeOnly ? goals.filter((g) => g.is_active) : goals;
  }

  async createGoal(input: GoalInput): Promise<Goal> {
    // mirror of the goal_shape check constraint
    if (input.type === "metric") {
      assert(
        input.metric_key !== null && input.target_value !== null && input.direction !== null,
        "metric goal requires metric_key, target_value, direction",
      );
    } else {
      assert(input.habit_id !== null, "habit goal requires habit_id");
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

  async listSyntheses(opts?: { limit?: number }): Promise<AISynthesis[]> {
    const rows = read<AISynthesis[]>("ai_syntheses", []).sort((a, b) =>
      b.generated_at.localeCompare(a.generated_at),
    );
    return opts?.limit !== undefined ? rows.slice(0, opts.limit) : rows;
  }

  async getSynthesisForWeek(weekStart: string): Promise<AISynthesis | null> {
    const weekEnd = addDays(weekStart, 7); // exclusive upper bound
    return (
      read<AISynthesis[]>("ai_syntheses", [])
        .filter((r) => {
          const day = r.generated_at.slice(0, 10);
          return day >= weekStart && day < weekEnd;
        })
        .sort((a, b) => b.generated_at.localeCompare(a.generated_at))[0] ?? null
    );
  }
}
