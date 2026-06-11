/**
 * Data-layer smoke test: runs the real LocalStorageDataLayer against an
 * in-memory localStorage shim and exercises the exact paths the Morning and
 * Evening log screens call. Run: npx tsx scripts/smoke.ts
 */
import assert from "node:assert/strict";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
};

const { LocalStorageDataLayer } = await import("../src/data/localStorageDataLayer");
const { todayISO, weekStartISO } = await import("../src/lib/dates");

const dl = new LocalStorageDataLayer();
const today = todayISO();

// Morning path (what MorningLog.onSubmit sends)
await dl.saveMorningLog(today, {
  bodyweight: 185.2,
  sleep_hours: 7,
  sleep_minutes: 45,
  morning_readiness: 8,
  rhr: null,
  hrv: null,
  caffeine_delay: null,
});

// Habit + evening path (what EveningLog.onSubmit sends)
const habit = await dl.createHabit({
  name: "Read 30 minutes",
  description: null,
  pillar: "Health",
  frequency_type: "daily",
  frequency_count: 1,
  frequency_days: null,
  is_preset: true,
  is_active: true,
});

await dl.saveEveningLog(today, {
  deep_work_hours: 3.5,
  training_done: true,
  macro_adherence: false,
  discretionary_spend: 42.5,
  caloric_variance_pct: -10,
  daily_reflection: "Solid day.",
  workout_rpe: 7,
  screen_time_hours: null,
});

await dl.setHabitCompletion(habit.id, today, true);

// Round-trip assertions
const log = await dl.getDailyLog(today);
assert.ok(log, "daily log exists");
assert.equal(log.morning_done, true);
assert.equal(log.evening_done, true);
assert.equal(log.sleep_total_minutes, 7 * 60 + 45, "generated column mirrored");
assert.equal(log.bodyweight, 185.2);
assert.equal(log.training_done, true);
assert.equal(log.macro_adherence, false);
assert.equal(log.caloric_variance_pct, -10);
assert.equal(log.discretionary_spend, 42.5);
assert.equal(log.screen_time_hours, null, "untouched optional stays null");

// Morning + evening wrote to the SAME row (unique user/date)
const logs = await dl.getDailyLogs(today, today);
assert.equal(logs.length, 1, "one row per user per day");

// Completion round-trip
const comps = await dl.getHabitCompletions(today, today);
assert.equal(comps.length, 1);
assert.equal(comps[0].completed, true);

// Weekly rollup sees today
const rollup = await dl.getWeeklyRollup(weekStartISO(today));
assert.equal(rollup.avg_bodyweight_7d, 185.2);
assert.equal(rollup.total_training_sessions, 1);
assert.equal(rollup.morning_logs_completed, 1);
assert.equal(rollup.evening_logs_completed, 1);

// Constraint mirror: invalid input must throw, not silently store
await assert.rejects(
  dl.saveMorningLog(today, {
    bodyweight: -5,
    sleep_hours: 7,
    sleep_minutes: 0,
    morning_readiness: 8,
  }),
  /bodyweight/,
);
await assert.rejects(
  dl.saveEveningLog(today, {
    deep_work_hours: 30,
    training_done: true,
    macro_adherence: true,
    discretionary_spend: 0,
  }),
  /deep_work_hours/,
);

console.log("SMOKE PASS — morning/evening round-trip, single row per day, rollup, null semantics, constraint rejection all verified");
