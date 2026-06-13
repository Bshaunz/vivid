/**
 * Data-layer smoke test: runs the real LocalStorageDataLayer against an
 * in-memory localStorage shim and exercises the exact paths the Morning,
 * Evening and Weekly log screens call (v4.0 schema). Run: npx tsx scripts/smoke.ts
 */
import assert from "node:assert/strict";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
};

const { LocalStorageDataLayer } = await import("../src/data/localStorageDataLayer");
const { todayISO, weekStartISO, addDays } = await import("../src/lib/dates");

const dl = new LocalStorageDataLayer();
const today = todayISO();
const week = weekStartISO(today);

// Morning path (what MorningLog.onSubmit sends) — bodyweight is NOT here.
await dl.saveMorningLog(today, {
  morning_readiness: 8,
  sleep_hours: 7.5,
  rhr: null,
  hrv: null,
});
// Bodyweight is its own entity, written separately by the quick-entry.
await dl.addBodyweightEntry(185.2);

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
  training_done: true,
  deep_work_hours: 3.5,
  discretionary_spend: 42.5,
  macro_adherence: false,
  caloric_variance_pct: -10,
  workout_rpe: 7,
  daily_reflection: "Solid day.",
});

await dl.setHabitCompletion(habit.id, today, true);

// Round-trip assertions
const log = await dl.getDailyLog(today);
assert.ok(log, "daily log exists");
assert.equal(log.morning_done, true);
assert.equal(log.evening_done, true);
assert.equal(log.sleep_hours, 7.5);
assert.equal(log.training_done, true);
assert.equal(log.macro_adherence, false);
assert.equal(log.caloric_variance_pct, -10);
assert.equal(log.discretionary_spend, 42.5);
assert.equal("bodyweight" in log, false, "bodyweight is not a daily_logs field in v4");

// Morning + evening wrote to the SAME row (unique user/date)
const logs = await dl.getDailyLogs(today, today);
assert.equal(logs.length, 1, "one row per user per day");

// Completion round-trip
const comps = await dl.getHabitCompletions(today, today);
assert.equal(comps.length, 1);
assert.equal(comps[0].completed, true);

// Bodyweight is scored ONLY as a weekly median. Add three more same-week
// samples so the set is {185.2, 181.0, 184.0, 200.0}: median = 184.6, but the
// mean would be 187.55 — the gap proves we take the median, not the average.
const otherDay = week === today ? addDays(today, 1) : addDays(today, -1);
await dl.addBodyweightEntry(181.0, `${otherDay}T06:00:00.000Z`);
await dl.addBodyweightEntry(184.0, `${otherDay}T12:00:00.000Z`);
await dl.addBodyweightEntry(200.0, `${otherDay}T20:00:00.000Z`); // outlier
const bw = await dl.getWeeklyBodyweight(week);
assert.ok(bw, "weekly bodyweight derived");
assert.equal(bw.n_samples, 4, "all in-week samples counted");
assert.equal(bw.weekly_median_bodyweight, 184.6, "median of {181,184,185.2,200}, not the mean (187.55)");
assert.equal(bw.low_confidence, false, "4 samples = full confidence");

// Rest day: a not-trained day still counts as a completed evening log but NOT
// as a training session (training_done = false).
await dl.saveEveningLog(otherDay, {
  training_done: false,
  deep_work_hours: 1,
  discretionary_spend: 0,
  macro_adherence: true,
});
const restLog = await dl.getDailyLog(otherDay);
assert.equal(restLog?.training_done, false);

// Weekly summary: median bw + sessions (not-trained day excluded)
const summary = await dl.getWeeklySummary(week);
assert.equal(summary.median_bodyweight, 184.6, "summary uses the median");
assert.equal(summary.training_sessions, 1, "not-trained day must not count as a session");
assert.equal(summary.evenings_logged, 2);

// Weekly review path (what WeeklyLog.onSubmit sends): only capital + bottleneck.
const saved = await dl.saveWeeklyLog({
  week_start: week,
  capital_allocated: 500,
  bottleneck_audit: "Evening logging slipped twice after late training.",
});
const fetched = await dl.getWeeklyLog(week);
assert.ok(fetched, "weekly log exists");
assert.equal(fetched.id, saved.id);
assert.equal(fetched.capital_allocated, 500);
assert.equal("posts_published" in fetched, false, "no off-whitelist weekly fields in v4");

// Saving the same week again updates in place — one row per (user, week)
await dl.saveWeeklyLog({ ...fetched, capital_allocated: 750 });
const weeks = await dl.listWeeklyLogs();
assert.equal(weeks.length, 1, "upsert, not duplicate");
assert.equal(weeks[0].capital_allocated, 750);

// Goals are display-only but still shape-validated like the goal_shape check.
const metricGoal = await dl.createGoal({
  name: "Cut to 180",
  type: "metric",
  metric_key: "weekly_median_bodyweight",
  target_value: 180,
  direction: "below",
  habit_id: null,
  pillar: "Fitness",
  target_date: addDays(today, 60),
  is_active: true,
  completed: false,
});
assert.ok(metricGoal.id, "metric goal created");
await assert.rejects(
  dl.createGoal({
    name: "Broken metric goal",
    type: "metric",
    metric_key: null,
    target_value: null,
    direction: null,
    habit_id: null,
    pillar: null,
    target_date: addDays(today, 30),
    is_active: true,
    completed: false,
  }),
  /metric goal requires/,
);

// Constraint mirror: invalid input must throw, not silently store
await assert.rejects(
  dl.addBodyweightEntry(-5),
  /bodyweight/,
);
await assert.rejects(
  dl.saveMorningLog(today, { morning_readiness: 99, sleep_hours: 7 }),
  /morning_readiness/,
);
await assert.rejects(
  dl.saveEveningLog(today, { training_done: true, deep_work_hours: 30, discretionary_spend: 0 }),
  /deep_work_hours/,
);

console.log(
  "SMOKE PASS — v4 daily round-trip, weekly-median bodyweight semantics, not-trained-day summary, weekly review persistence + upsert, goal shape validation, constraint rejection all verified",
);
