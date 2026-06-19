import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApp } from "@/context/AppContext";
import { SkeletonBlock } from "@/components/Skeleton";
import { addDays, parseISODate, toISODate, todayISO, weekStartISO } from "@/lib/dates";
import type { ApiError } from "@/lib/http";
import type {
  DailyLog,
  Goal,
  GoalDirection,
  GoalInput,
  Habit,
  HabitCompletion,
  HabitInput,
  HabitValueType,
  Pillar,
} from "@/types/domain";

/**
 * Goals (build step 13 + polish). The standalone management layer for custom
 * Habits and progress-based Goals. Goals are DISPLAY-ONLY (§6.7) — progress is
 * rendered, never scored.
 *
 * This pass adds: pass/fail bar color (green when the condition is met, crimson
 * when not) with a static target marker on metric bars; clean "3 / 5" counters;
 * a natural-language description + right-aligned time-remaining on one line; an
 * "On Track" status for in-flight metric goals (vs. "Complete" only when the
 * timeframe is over or a frequency target is reached); and an edit flow (pencil
 * → the create modal prefilled → dispatches an update PUT, not a new row).
 *
 * Vocabulary mapping (brief → real schema):
 *   At least / No more than  →  direction "above" (gte) / "below" (lte)
 *   habit-frequency / metric-average  →  type "habit" / "metric"
 * Progress is measured over the current ISO week; duration sets the deadline
 * (target_date) since the schema carries no time_frame column — the week/month
 * timeframe is inferred from target_date.
 */

const PILLAR_ORDER: Pillar[] = ["Health", "Fitness", "Finances"];
const MAX_ACTIVE_GOALS = 10;
const MAX_GOALS_PER_TARGET = 2;

const POSITIVE = "#2A933C"; // green — condition met
const NEGATIVE = "#C02416"; // crimson — condition not met / over limit

type Agg = "avg" | "sum";
type Unit = "hours" | "money" | "bpm" | "ms" | "points";

interface MetricDef {
  key: string;
  label: string;
  agg: Agg;
  pillar: Pillar | null;
  unit: Unit;
  placeholder: string; // contextual threshold hint
  step: number; // contextual step increment
}

/** System metrics a metric-average goal can target, each mapped to a real
 *  daily_logs column with the aggregation, placeholder, and step it measures. */
const SYSTEM_METRICS: MetricDef[] = [
  { key: "sleep_hours", label: "Avg Sleep", agg: "avg", pillar: "Health", unit: "hours", placeholder: "8", step: 0.5 },
  { key: "morning_readiness", label: "Avg Readiness", agg: "avg", pillar: "Health", unit: "points", placeholder: "7", step: 1 },
  { key: "rhr", label: "Avg Resting HR", agg: "avg", pillar: "Health", unit: "bpm", placeholder: "55", step: 1 },
  { key: "hrv", label: "Avg HRV", agg: "avg", pillar: "Health", unit: "ms", placeholder: "60", step: 1 },
  { key: "deep_work_hours", label: "Total Deep Work", agg: "sum", pillar: "Fitness", unit: "hours", placeholder: "4", step: 0.5 },
  { key: "discretionary_spend", label: "Total Spend", agg: "sum", pillar: "Finances", unit: "money", placeholder: "100", step: 10 },
];

function metricDef(key: string | null): MetricDef | undefined {
  return key ? SYSTEM_METRICS.find((m) => m.key === key) : undefined;
}

/** Prefix/suffix affixes derived from a metric's unit. */
function affix(unit: Unit): { prefix?: string; suffix?: string } {
  switch (unit) {
    case "money":
      return { prefix: "$" };
    case "hours":
      return { suffix: "hours" };
    case "bpm":
      return { suffix: "bpm" };
    case "ms":
      return { suffix: "ms" };
    case "points":
      return {};
  }
}

/** Type-safe accessor for the metric columns a goal may target. */
function metricValue(log: DailyLog, key: string): number | null {
  switch (key) {
    case "sleep_hours":
      return log.sleep_hours;
    case "morning_readiness":
      return log.morning_readiness;
    case "rhr":
      return log.rhr;
    case "hrv":
      return log.hrv;
    case "deep_work_hours":
      return log.deep_work_hours;
    case "discretionary_spend":
      return log.discretionary_spend;
    default:
      return null;
  }
}

function fmtUnit(v: number, unit: Unit, sym: string): string {
  switch (unit) {
    case "hours":
      return `${v.toFixed(1)}h`;
    case "money":
      return `${sym}${v.toFixed(0)}`;
    case "bpm":
      return `${Math.round(v)} bpm`;
    case "ms":
      return `${Math.round(v)} ms`;
    case "points":
      return v.toFixed(1);
  }
}

function endOfMonthISO(iso: string): string {
  const d = parseISODate(iso);
  return toISODate(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

/** "8" not "8.0", "8.5" kept. */
function trimNum(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(1)));
}

/** Natural-language threshold, e.g. "8 hours", "$100", "55 bpm". */
function thresholdPhrase(v: number, unit: Unit, sym: string): string {
  switch (unit) {
    case "hours":
      return `${trimNum(v)} hours`;
    case "money":
      return `${sym}${trimNum(v)}`;
    case "bpm":
      return `${Math.round(v)} bpm`;
    case "ms":
      return `${Math.round(v)} ms`;
    case "points":
      return trimNum(v);
  }
}

/** The fully-constructed sentence used as the goal card title (and stored as the
 *  row's name, since the schema's name column is NOT NULL). */
function buildGoalTitle(
  goal: Goal,
  habitName: string,
  sym: string,
  habitUnit?: string | null,
): string {
  const tf = goalTimeframe(goal.target_date);
  const recur = goal.is_recurring ? "every" : "this";
  if (goal.type === "habit") {
    const n = goal.target_value ?? "";
    const name = habitName || "habit";
    // Numeric habit → an over/under threshold on its unit; binary → frequency.
    if (goal.direction && habitUnit) {
      const op = goal.direction === "below" ? "under" : "over";
      return `Complete ${op} ${n} ${habitUnit} of ${name} ${recur} ${tf}`;
    }
    return `Complete ${name} ${n} times ${recur} ${tf}`;
  }
  const def = metricDef(goal.metric_key);
  const op = goal.direction === "below" ? "no more than" : "at least";
  const phrase = thresholdPhrase(goal.target_value ?? 0, def?.unit ?? "points", sym);
  return `${def?.label ?? "Metric"} is ${op} ${phrase} ${recur} ${tf}`;
}

/** Whole calendar days from `today` to `target` (negative once it has passed). */
function daysUntil(targetISO: string, todayISOStr: string): number {
  const ms = parseISODate(targetISO).getTime() - parseISODate(todayISOStr).getTime();
  return Math.round(ms / 86_400_000);
}

function timeLeftLabel(targetISO: string, todayISOStr: string): string {
  if (!targetISO) return "";
  const d = daysUntil(targetISO, todayISOStr);
  if (d < 0) return "Ended";
  if (d === 0) return "Last day";
  return `${d} day${d === 1 ? "" : "s"} left`;
}

/** The schema has no time_frame column — infer it from the deadline: a target
 *  date within the current ISO week is weekly, otherwise monthly. */
function goalTimeframe(targetISO: string): "week" | "month" {
  if (!targetISO) return "week";
  return targetISO <= addDays(weekStartISO(), 6) ? "week" : "month";
}

// ── progress model ─────────────────────────────────────────────────────────────

interface Progress {
  current: number;
  target: number;
  fillPct: number; // 0–100 fill against the bar's scale
  markerPct: number | null; // metric goals: the target tick position
  met: boolean; // condition satisfied right now (drives green/crimson)
  breached: boolean; // an lte limit was exceeded
  currentLabel: string;
  targetLabel: string;
}

function computeProgress(
  goal: Goal,
  habits: Habit[],
  logs: DailyLog[],
  comps: HabitCompletion[],
  sym: string,
): Progress {
  if (goal.type === "habit") {
    const habit = habits.find((h) => h.id === goal.habit_id);
    const target = goal.target_value ?? habit?.frequency_count ?? 1;
    // Sessions logged this period. Numeric habits don't persist the per-session
    // quantity in this schema, so completions stand in as the measured count.
    const current = comps.filter((c) => c.habit_id === goal.habit_id && c.completed).length;
    const fillPct = target > 0 ? Math.min(100, (current / target) * 100) : 0;
    const below = goal.direction === "below"; // numeric "under" goals
    return {
      current,
      target,
      fillPct,
      markerPct: null, // habit goals have no fixed target tick → no ticker
      met: below ? current <= target : target > 0 && current >= target,
      breached: below && current > target,
      currentLabel: `${current}`,
      targetLabel: `${target}`,
    };
  }

  // metric-average goal — the bar is scaled so the target lands exactly on the
  // fixed ticker: 25% for "at least" (maximize), 75% for "no more than"
  // (minimize). maxScale = target / anchor makes current == target read as
  // anchor%. Guard against a 0/negative target (→ empty bar, no NaN width).
  const def = metricDef(goal.metric_key);
  const unit: Unit = def?.unit ?? "points";
  const values = logs
    .map((l) => (goal.metric_key ? metricValue(l, goal.metric_key) : null))
    .filter((v): v is number => v != null);
  const sum = values.reduce((a, b) => a + b, 0);
  const current = def?.agg === "sum" ? sum : values.length ? sum / values.length : 0;
  const target = goal.target_value ?? 0;
  const below = goal.direction === "below";
  const anchor = below ? 0.75 : 0.25; // ticker position as a fraction
  const maxScale = target > 0 ? target / anchor : 0;
  return {
    current,
    target,
    fillPct: maxScale > 0 ? Math.min(100, Math.max(0, (current / maxScale) * 100)) : 0,
    markerPct: below ? 75 : 25,
    met: below ? current <= target : target > 0 && current >= target,
    breached: below ? current > target : false,
    currentLabel: fmtUnit(current, unit, sym),
    targetLabel: fmtUnit(target, unit, sym),
  };
}

function goalPillar(goal: Goal, habits: Habit[]): Pillar | null {
  if (goal.pillar) return goal.pillar;
  if (goal.type === "habit") return habits.find((h) => h.id === goal.habit_id)?.pillar ?? null;
  return metricDef(goal.metric_key)?.pillar ?? null;
}

/** Count active goals already tied to a given habit/metric target. */
function activeTargetCount(goals: Goal[], kind: "habit" | "metric", id: number | string | null): number {
  if (id === null || id === "") return 0;
  return goals.filter((g) =>
    kind === "habit" ? g.type === "habit" && g.habit_id === id : g.type === "metric" && g.metric_key === id,
  ).length;
}

// ── screen ──────────────────────────────────────────────────────────────────────

/** A destructive action awaiting confirmation in the shared dialog. */
type PendingDelete = { kind: "habit"; habit: Habit } | { kind: "goal"; goal: Goal };

export default function Goals() {
  const { data, habits, goals, loading, refresh } = useApp();
  const qc = useQueryClient();

  const weekStart = weekStartISO();
  const weekEnd = addDays(weekStart, 6);
  const sym = "$"; // CAD and USD both render with $

  const logsQ = useQuery({
    queryKey: ["goals", "week-logs", weekStart],
    queryFn: () => data.getDailyLogs(weekStart, weekEnd),
  });
  const compsQ = useQuery({
    queryKey: ["goals", "week-comps", weekStart],
    queryFn: () => data.getHabitCompletions(weekStart, weekEnd),
  });

  // Modal state. `editing*` non-null means the modal is in edit (PUT) mode.
  const [habitModalOpen, setHabitModalOpen] = useState(false);
  const [editingHabit, setEditingHabit] = useState<Habit | null>(null);
  const [goalModalOpen, setGoalModalOpen] = useState(false);
  const [editingGoal, setEditingGoal] = useState<Goal | null>(null);
  // Pending destructive action — non-null opens the confirm dialog; the
  // underlying mutation only fires on an explicit "Delete" confirm.
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

  function closeHabitModal() {
    setHabitModalOpen(false);
    setEditingHabit(null);
  }
  function closeGoalModal() {
    setGoalModalOpen(false);
    setEditingGoal(null);
  }

  async function afterWrite() {
    await refresh(); // re-syncs qk.habits, qk.goals, qk.dashboard
    await qc.invalidateQueries({ queryKey: ["goals", "week-comps", weekStart] });
    await qc.invalidateQueries({ queryKey: ["goals", "week-logs", weekStart] });
  }

  // Once a delete settles (success OR failure) re-sync state and dismiss the
  // confirmation dialog, so the UI always reflects what actually persisted.
  async function closeAfterDelete() {
    await afterWrite();
    setPendingDelete(null);
  }

  const createHabitM = useMutation({
    mutationFn: (input: HabitInput) => data.createHabit(input),
    onSuccess: async () => {
      await afterWrite();
      closeHabitModal();
    },
  });
  const updateHabitM = useMutation({
    mutationFn: (v: { id: number; patch: Partial<HabitInput> }) => data.updateHabit(v.id, v.patch),
    onSuccess: async () => {
      await afterWrite();
      closeHabitModal();
    },
  });
  // Deleting a habit cascades to its goals. The habit is a *soft* archive
  // (is_active=false, to preserve completion history for scoring), so without
  // this its goals would dangle — pointing at a habit that's hidden from the
  // active list. Goals are display-only (§6.7), not scoring history, so they're
  // hard-deleted. We pull *all* goals (active + archived), drop them first, then
  // archive the habit, so a mid-flight failure can never leave an archived habit
  // with orphaned goals. The DataLayer exposes no batch/transaction, so this is
  // an ordered best-effort sequence; onSettled re-syncs both the habits and
  // goals arrays whether the cascade fully succeeds or fails partway.
  const archiveHabitM = useMutation({
    mutationFn: async (id: number) => {
      const tied = (await data.listGoals({ activeOnly: false })).filter((g) => g.habit_id === id);
      for (const g of tied) await data.deleteGoal(g.id);
      await data.archiveHabit(id);
    },
    onSettled: closeAfterDelete,
  });
  const createGoalM = useMutation({
    mutationFn: (input: GoalInput) => data.createGoal(input),
    onSuccess: async () => {
      await afterWrite();
      closeGoalModal();
    },
  });
  const updateGoalM = useMutation({
    mutationFn: (v: { id: number; patch: Partial<GoalInput> }) => data.updateGoal(v.id, v.patch),
    onSuccess: async () => {
      await afterWrite();
      closeGoalModal();
    },
  });
  const deleteGoalM = useMutation({
    mutationFn: (id: number) => data.deleteGoal(id),
    onSettled: closeAfterDelete,
  });

  const logs = logsQ.data ?? [];
  const comps = compsQ.data ?? [];
  const weekReady = !logsQ.isLoading && !compsQ.isLoading;
  const atGlobalLimit = goals.length >= MAX_ACTIVE_GOALS;

  const progressByGoal = useMemo(() => {
    const map = new Map<number, Progress>();
    for (const g of goals) map.set(g.id, computeProgress(g, habits, logs, comps, sym));
    return map;
  }, [goals, habits, logs, comps]);

  const habitGroups = useMemo(() => {
    const groups: { label: string; pillar: Pillar | null; items: Habit[] }[] = [
      ...PILLAR_ORDER.map((p) => ({ label: p, pillar: p as Pillar | null, items: [] as Habit[] })),
      { label: "Uncategorized", pillar: null, items: [] as Habit[] },
    ];
    for (const h of habits) {
      const g = groups.find((x) => x.pillar === (h.pillar ?? null));
      g?.items.push(h);
    }
    return groups.filter((g) => g.items.length > 0);
  }, [habits]);

  // Create vs. update dispatch. Goal updates send only GoalUpdate-allowed fields
  // (the target — type/metric_key/habit_id — is immutable, so the editor locks it).
  function submitHabit(input: HabitInput) {
    if (editingHabit) {
      updateHabitM.mutate({
        id: editingHabit.id,
        patch: {
          name: input.name,
          pillar: input.pillar,
          value_type: input.value_type,
          unit_label: input.unit_label,
          target_per_session: input.target_per_session,
        },
      });
    } else {
      createHabitM.mutate(input);
    }
  }
  function submitGoal(input: GoalInput) {
    if (editingGoal) {
      updateGoalM.mutate({
        id: editingGoal.id,
        patch: {
          name: input.name,
          target_value: input.target_value,
          direction: input.direction,
          pillar: input.pillar,
          target_date: input.target_date,
          is_recurring: input.is_recurring,
        },
      });
    } else {
      createGoalM.mutate(input);
    }
  }

  const habitPending = createHabitM.isPending || updateHabitM.isPending;
  const habitError = createHabitM.isError || updateHabitM.isError;
  const goalPending = createGoalM.isPending || updateGoalM.isPending;
  const goalError = (createGoalM.error ?? updateGoalM.error) as ApiError | null;

  const deleteInFlight = archiveHabitM.isPending || deleteGoalM.isPending;
  // Active goals tied to the habit awaiting deletion — drives the cascade warning.
  const linkedActiveGoals =
    pendingDelete?.kind === "habit"
      ? goals.filter((g) => g.habit_id === pendingDelete.habit.id).length
      : 0;
  function confirmDelete() {
    if (!pendingDelete) return;
    if (pendingDelete.kind === "habit") archiveHabitM.mutate(pendingDelete.habit.id);
    else deleteGoalM.mutate(pendingDelete.goal.id);
  }

  return (
    <main className="mx-auto flex min-h-full max-w-[390px] flex-col gap-7 px-5 pb-10 pt-6">
      <header>
        <p className="label">Track & Target</p>
        <h1 className="text-2xl font-extrabold tracking-tight">Goals</h1>
      </header>

      {/* ── Active goals grid ─────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-2xl font-bold tracking-tight text-white">
            Active Goals
            {goals.length > 0 && (
              <span className="ml-2 text-sm font-semibold text-white/40">
                {goals.length}/{MAX_ACTIVE_GOALS}
              </span>
            )}
          </h2>
          <button
            type="button"
            onClick={() => {
              setEditingGoal(null);
              setGoalModalOpen(true);
            }}
            disabled={atGlobalLimit}
            className="text-xs font-semibold text-white/70 hover:text-white disabled:cursor-not-allowed disabled:text-white/20"
          >
            + New Goal
          </button>
        </div>

        {atGlobalLimit && (
          <p className="rounded-[10px] border border-card-border bg-card/40 px-3 py-2 text-[11px] text-white/40">
            Maximum of 10 active goals reached. Archive a goal to create a new one.
          </p>
        )}

        {loading ? (
          <SkeletonBlock className="h-28 w-full" />
        ) : goals.length === 0 ? (
          <EmptyGoals
            onCreate={() => {
              setEditingGoal(null);
              setGoalModalOpen(true);
            }}
          />
        ) : (
          <div className="flex flex-col gap-3">
            {goals.map((g) => (
              <GoalCard
                key={g.id}
                goal={g}
                pillar={goalPillar(g, habits)}
                habitName={habits.find((h) => h.id === g.habit_id)?.name}
                habitUnit={habits.find((h) => h.id === g.habit_id)?.unit_label}
                sym={sym}
                progress={weekReady ? progressByGoal.get(g.id) : undefined}
                onEdit={() => {
                  setEditingGoal(g);
                  setGoalModalOpen(true);
                }}
                onDelete={() => setPendingDelete({ kind: "goal", goal: g })}
                deleting={deleteGoalM.isPending && deleteGoalM.variables === g.id}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── Habit manager ─────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-2xl font-bold tracking-tight text-white">Habits</h2>
          <button
            type="button"
            onClick={() => {
              setEditingHabit(null);
              setHabitModalOpen(true);
            }}
            className="text-xs font-semibold text-white/70 hover:text-white"
          >
            + Add Custom Habit
          </button>
        </div>

        {loading ? (
          <SkeletonBlock className="h-24 w-full" />
        ) : habits.length === 0 ? (
          <EmptyHabits
            onCreate={() => {
              setEditingHabit(null);
              setHabitModalOpen(true);
            }}
          />
        ) : (
          <div className="flex flex-col gap-5">
            {habitGroups.map((group) => (
              <div key={group.label} className="flex flex-col gap-2">
                <p className="label">{group.label}</p>
                <div className="flex flex-col gap-2">
                  {group.items.map((h) => (
                    <HabitRow
                      key={h.id}
                      habit={h}
                      completed={comps.filter((c) => c.habit_id === h.id && c.completed).length}
                      onEdit={() => {
                        setEditingHabit(h);
                        setHabitModalOpen(true);
                      }}
                      onArchive={() => setPendingDelete({ kind: "habit", habit: h })}
                      archiving={archiveHabitM.isPending && archiveHabitM.variables === h.id}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {habitModalOpen && (
        <HabitModal
          editHabit={editingHabit}
          onClose={closeHabitModal}
          onSubmit={submitHabit}
          pending={habitPending}
          error={habitError}
        />
      )}
      {goalModalOpen && (
        <GoalWizardModal
          editGoal={editingGoal}
          habits={habits}
          goals={goals}
          logs={logs}
          comps={comps}
          sym={sym}
          weekEnd={weekEnd}
          onClose={closeGoalModal}
          onSubmit={submitGoal}
          pending={goalPending}
          error={goalError}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={pendingDelete.kind === "habit" ? "Delete Habit?" : "Delete Goal?"}
          confirmLabel="Delete"
          pending={deleteInFlight}
          onClose={() => {
            if (!deleteInFlight) setPendingDelete(null);
          }}
          onConfirm={confirmDelete}
        >
          {pendingDelete.kind === "habit" ? (
            <>
              <span className="font-semibold text-white/80">“{pendingDelete.habit.name}”</span> and
              its completion history will be permanently removed.
              {linkedActiveGoals > 0 && (
                <span className="mt-3 block rounded-[8px] border border-negative/40 bg-negative/10 px-3 py-2 font-semibold text-negative">
                  Warning: Deleting this habit will also permanently remove its associated active
                  goals.
                </span>
              )}
            </>
          ) : (
            <>This goal will be permanently deleted. This action can’t be undone.</>
          )}
        </ConfirmDialog>
      )}
    </main>
  );
}

// ── goal card (shared by the grid AND the live preview) ─────────────────────────

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-card-border bg-bg/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-white/50">
      {children}
    </span>
  );
}

/** Per-pillar hue for the colored badge, uniform across the page. */
const PILLAR_HUE: Record<Pillar, string> = {
  Health: "#C02416", // red
  Fitness: "#3266AD", // blue
  Finances: "#2A933C", // green
};

function PillarBadge({ pillar }: { pillar: Pillar }) {
  const hue = PILLAR_HUE[pillar];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]"
      style={{ color: hue, borderColor: `${hue}55`, backgroundColor: `${hue}1a` }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: hue }} aria-hidden />
      {pillar}
    </span>
  );
}

/** Presentational habit card shared by the manager grid (with actions) and the
 *  creator's live preview (read-only). `name` is the habit's raw action title —
 *  numeric unit metadata surfaces only on goal cards, never on the habit itself. */
function HabitCardView({
  name,
  pillar,
  meta,
  actions,
}: {
  name: string;
  pillar: Pillar | null;
  meta?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-[10px] border border-card-border bg-card px-4 py-3">
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className="truncate text-sm font-medium text-white">{name || "Habit name"}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          {pillar && <PillarBadge pillar={pillar} />}
          {meta && <span className="text-[11px] text-white/40">{meta}</span>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2.5">{actions}</div>}
    </div>
  );
}

function GoalCard({
  goal,
  pillar,
  habitName,
  habitUnit,
  sym,
  progress,
  onEdit,
  onDelete,
  deleting,
}: {
  goal: Goal;
  pillar: Pillar | null;
  habitName?: string;
  habitUnit?: string | null;
  sym: string;
  progress: Progress | undefined;
  onEdit?: () => void;
  onDelete?: () => void;
  deleting?: boolean;
}) {
  const today = todayISO();
  const timeframeOver = goal.target_date !== "" && today > goal.target_date;
  const title = buildGoalTitle(goal, habitName ?? "", sym, habitUnit);

  let status = "";
  let statusTone = "text-white/40";
  if (progress) {
    if (goal.type === "habit" && goal.direction == null) {
      // Binary habit → completion frequency: hitting N times reads "Complete".
      status = progress.met ? "Complete" : "In progress";
      statusTone = progress.met ? "text-positive" : "text-white/40";
    } else if (progress.breached) {
      // Numeric "under" habit past its cap, or a metric limit exceeded.
      status = "Over limit";
      statusTone = "text-negative";
    } else if (progress.met) {
      // Met while the period is still open is provisional → "On Track"; only a
      // closed period (numeric/metric) or a reached frequency reads "Complete".
      status = timeframeOver ? "Complete" : "On Track";
      statusTone = "text-positive";
    } else {
      status = "Behind";
      statusTone = "text-negative";
    }
  }

  return (
    <article className="flex flex-col gap-3 rounded-[14px] border border-card-border bg-card p-4">
      {/* Title = the fully-constructed natural-language description. */}
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-sm font-semibold leading-snug text-white">{title}</p>
        {(onEdit || onDelete) && (
          <div className="flex shrink-0 items-center gap-2.5">
            {onEdit && (
              <button
                type="button"
                onClick={onEdit}
                aria-label="Edit goal"
                className="text-white/30 hover:text-white"
              >
                <PencilIcon />
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                onClick={onDelete}
                disabled={deleting}
                aria-label="Delete goal"
                className="text-white/30 hover:text-negative disabled:opacity-40"
              >
                <TrashIcon />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Tags row: optional Pillar + Recurring badges, time-remaining right. */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {pillar && <PillarBadge pillar={pillar} />}
          {goal.is_recurring && <Badge>Recurring</Badge>}
        </div>
        {progress && (
          <span className="shrink-0 text-[11px] tabular-nums text-white/50">
            {timeLeftLabel(goal.target_date, today)}
          </span>
        )}
      </div>

      {progress ? (
        <>
          <div className="relative h-2 w-full rounded-full bg-white/10">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${progress.fillPct}%`,
                backgroundColor: progress.met ? POSITIVE : NEGATIVE,
              }}
            />
            {progress.markerPct !== null && (
              <span
                aria-hidden
                className="absolute top-1/2 h-3 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_4px_rgba(0,0,0,0.85)]"
                style={{ left: `${progress.markerPct}%` }}
              />
            )}
          </div>

          <div className="flex items-center justify-between text-[11px]">
            <span className="font-semibold tabular-nums text-white/80">
              {progress.currentLabel} / {progress.targetLabel}
            </span>
            <span className={`font-semibold ${statusTone}`}>{status}</span>
          </div>
        </>
      ) : (
        <SkeletonBlock className="h-2 w-full" />
      )}
    </article>
  );
}

// ── habit row ─────────────────────────────────────────────────────────────────

function HabitRow({
  habit,
  completed,
  onEdit,
  onArchive,
  archiving,
}: {
  habit: Habit;
  completed: number;
  onEdit: () => void;
  onArchive: () => void;
  archiving: boolean;
}) {
  // Numeric habits surface their unit ("12 miles this week"); binary habits (and
  // any unit-less numeric) fall back to "done". `completed` is the count of
  // logged sessions — the per-session quantity isn't persisted (display-only).
  const unit = habit.value_type === "numeric" ? habit.unit_label?.trim() : "";
  const meta = unit ? `${completed} ${unit} this week` : `${completed} done this week`;
  return (
    <HabitCardView
      name={habit.name}
      pillar={habit.pillar}
      meta={meta}
      actions={
        <>
          <button
            type="button"
            onClick={onEdit}
            aria-label={`Edit habit ${habit.name}`}
            className="text-white/30 hover:text-white"
          >
            <PencilIcon />
          </button>
          <button
            type="button"
            onClick={onArchive}
            disabled={archiving}
            aria-label={`Archive habit ${habit.name}`}
            className="text-white/30 hover:text-negative disabled:opacity-40"
          >
            <TrashIcon />
          </button>
        </>
      }
    />
  );
}

// ── empty states ────────────────────────────────────────────────────────────────

function EmptyGoals({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-[14px] border border-dashed border-card-border bg-card/40 px-5 py-8 text-center">
      <p className="text-sm font-semibold text-white">No goals yet</p>
      <p className="max-w-[260px] text-xs text-white/40">
        Set a progress target on a habit or a system metric. Goals are display-only — they never
        affect your scores.
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="mt-1 rounded-[8px] border border-card-border bg-card px-4 py-2 text-xs font-semibold text-white/80 hover:text-white"
      >
        Create your first goal
      </button>
    </div>
  );
}

function EmptyHabits({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-[14px] border border-dashed border-card-border bg-card/40 px-5 py-8 text-center">
      <p className="text-sm font-semibold text-white">No habits defined</p>
      <p className="max-w-[260px] text-xs text-white/40">
        Add a custom habit to start tracking completions and to tie habit-frequency goals to it.
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="mt-1 rounded-[8px] border border-card-border bg-card px-4 py-2 text-xs font-semibold text-white/80 hover:text-white"
      >
        + Add Custom Habit
      </button>
    </div>
  );
}

// ── modal shell + form primitives ──────────────────────────────────────────────

function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-30 flex items-end justify-center bg-black/60"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90dvh] w-full max-w-[390px] overflow-y-auto rounded-t-[14px] border border-card-border bg-card p-5"
        style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-bold text-white">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-white/40 hover:text-white"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Mobile-first confirmation for destructive actions: a bottom-sheet on phones,
 *  a centered card on larger screens. Focus moves to Cancel on open and is
 *  trapped inside (Tab cycles between the two buttons); Escape or a backdrop tap
 *  closes; focus is restored to the trigger on unmount. */
function ConfirmDialog({
  title,
  confirmLabel,
  onConfirm,
  onClose,
  pending,
  children,
}: {
  title: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  pending?: boolean;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Hold the latest onClose so the mount-only effect's listeners never go stale.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const restoreTo = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const nodes = panelRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])");
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      restoreTo?.focus();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/70 sm:items-center"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[340px] rounded-t-[16px] border border-card-border bg-card p-5 sm:rounded-[16px]"
        style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
      >
        <h3 className="text-lg font-bold text-white">{title}</h3>
        <div className="mt-2 text-sm leading-relaxed text-white/60">{children}</div>
        <div className="mt-5 flex gap-3">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            disabled={pending}
            className="h-11 flex-1 rounded-[8px] border border-card-border bg-bg text-sm font-semibold text-white/80 hover:text-white disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="h-11 flex-1 rounded-[8px] bg-negative text-sm font-bold text-white hover:bg-negative/90 disabled:opacity-60"
          >
            {pending ? "Deleting…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={`h-11 rounded-[8px] border text-sm font-semibold disabled:opacity-50 ${
            value === o.value
              ? "border-accent bg-accent/30 text-white"
              : "border-card-border bg-bg text-white/50"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── inline sentence primitives (natural-language builder) ────────────────────────

function InlineSelect({
  value,
  onChange,
  ariaLabel,
  disabled,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span className="relative inline-flex items-center">
      <select
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="max-w-[170px] cursor-pointer truncate appearance-none rounded-[6px] bg-accent/25 py-1 pl-2 pr-6 text-sm font-semibold text-white outline-none hover:bg-accent/40 focus:bg-accent/40 disabled:cursor-default disabled:opacity-70 disabled:hover:bg-accent/25"
      >
        {children}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-white/60" />
    </span>
  );
}

function InlineNumber({
  value,
  onChange,
  ariaLabel,
  placeholder,
  min,
  max,
  step,
  prefix,
  suffix,
}: {
  value: string;
  onChange: (v: string) => void;
  ariaLabel: string;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  prefix?: string;
  suffix?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-[6px] bg-accent/25 px-2 py-1 focus-within:bg-accent/40">
      {prefix && <span className="text-sm font-semibold text-white/70">{prefix}</span>}
      <input
        aria-label={ariaLabel}
        type="number"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        min={min}
        max={max}
        step={step}
        className="w-12 bg-transparent text-center text-sm font-semibold text-white outline-none placeholder:text-white/40"
      />
      {suffix && <span className="text-sm font-semibold text-white/70">{suffix}</span>}
    </span>
  );
}

function InlineText({
  value,
  onChange,
  ariaLabel,
  placeholder,
  widthCls,
  maxLength,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  ariaLabel: string;
  placeholder?: string;
  widthCls?: string;
  maxLength?: number;
  autoFocus?: boolean;
}) {
  return (
    <span className="inline-flex items-center rounded-[6px] bg-accent/25 px-2 py-1 focus-within:bg-accent/40">
      <input
        aria-label={ariaLabel}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        autoFocus={autoFocus}
        className={`${widthCls ?? "w-32"} bg-transparent text-sm font-semibold text-white outline-none placeholder:text-white/40`}
      />
    </span>
  );
}

// ── habit modal (create + edit) ─────────────────────────────────────────────────

function HabitModal({
  editHabit,
  onClose,
  onSubmit,
  pending,
  error,
}: {
  editHabit: Habit | null;
  onClose: () => void;
  onSubmit: (input: HabitInput) => void;
  pending: boolean;
  error: boolean;
}) {
  const [name, setName] = useState(editHabit?.name ?? "");
  const [pillar, setPillar] = useState<"" | Pillar>(editHabit?.pillar ?? "");
  const [valueType, setValueType] = useState<HabitValueType>(editHabit?.value_type ?? "binary");
  const [unitLabel, setUnitLabel] = useState(editHabit?.unit_label ?? "");

  const isNumeric = valueType === "numeric";
  // Numeric habits need an action + a unit; the system label is derived, never typed.
  const numericReady = !isNumeric || unitLabel.trim().length > 0;
  const valid = name.trim().length > 0 && numericReady;
  // The habit card always shows the raw action title; the unit is goal-card-only.
  const previewName = name.trim();

  function submit() {
    if (!valid) return;
    onSubmit({
      name: name.trim(),
      description: editHabit?.description ?? null,
      pillar: pillar === "" ? null : pillar,
      // Frequency controls are intentionally omitted — custom habits are daily
      // completions; the tracking shape (binary vs numeric) carries the detail.
      frequency_type: "daily",
      frequency_count: 1,
      frequency_days: editHabit?.frequency_days ?? null,
      value_type: valueType,
      unit_label: isNumeric ? unitLabel.trim() : null,
      // Numeric habits capture only the unit ("how many [unit]"); the actual
      // quantity is logged ad hoc, so no fixed per-session default is stored.
      target_per_session: null,
      is_preset: editHabit?.is_preset ?? false,
      is_active: true,
    });
  }

  const pillarSelect = (
    <InlineSelect
      value={pillar}
      onChange={(v) => setPillar(v as "" | Pillar)}
      ariaLabel="Linked pillar"
    >
      <option className="bg-bg" value="">
        Uncategorized
      </option>
      {PILLAR_ORDER.map((p) => (
        <option className="bg-bg" key={p} value={p}>
          {p}
        </option>
      ))}
    </InlineSelect>
  );

  return (
    <ModalShell title={editHabit ? "Edit Habit" : "Add Custom Habit"} onClose={onClose}>
      <div className="flex flex-col gap-5">
        {/* Tracking type toggle */}
        <Field label="Tracking type">
          <Segmented
            value={valueType}
            onChange={setValueType}
            options={[
              { value: "binary", label: "Completion" },
              { value: "numeric", label: "Numeric" },
            ]}
          />
        </Field>

        {/* Natural-language sentence — same inline aesthetic as the goal builder. */}
        <div className="rounded-[10px] border border-card-border bg-bg/50 px-4 py-4">
          {isNumeric ? (
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-2.5 text-base leading-relaxed text-white/70">
              I want to track
              <InlineText
                value={name}
                onChange={setName}
                ariaLabel="Action"
                placeholder="Running"
                maxLength={80}
                autoFocus
              />
              by logging how many
              <InlineText
                value={unitLabel}
                onChange={setUnitLabel}
                ariaLabel="Unit"
                placeholder="miles"
                maxLength={40}
                widthCls="w-24"
              />
              <span className="text-white/30">•</span>
              Linked to
              {pillarSelect}
            </p>
          ) : (
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-2.5 text-base leading-relaxed text-white/70">
              I want to
              <InlineText
                value={name}
                onChange={setName}
                ariaLabel="Action"
                placeholder="Meditate"
                maxLength={80}
                autoFocus
              />
              <span className="text-white/30">•</span>
              Linked to
              {pillarSelect}
            </p>
          )}
        </div>

        {/* Live preview — the actual habit card, titled with the derived label. */}
        <div className="flex flex-col gap-2">
          <p className="label">Live preview</p>
          <HabitCardView name={previewName} pillar={pillar === "" ? null : pillar} />
        </div>

        {error && <p className="text-xs font-semibold text-negative">Couldn’t save. Try again.</p>}

        <button
          type="button"
          onClick={submit}
          disabled={!valid || pending}
          className="h-11 rounded-[8px] bg-white text-sm font-bold text-black disabled:opacity-40"
        >
          {pending ? "Saving…" : editHabit ? "Save Changes" : "Add Habit"}
        </button>
      </div>
    </ModalShell>
  );
}

// ── goal wizard modal (create + edit, natural-language builder + preview) ────────

function GoalWizardModal({
  editGoal,
  habits,
  goals,
  logs,
  comps,
  sym,
  weekEnd,
  onClose,
  onSubmit,
  pending,
  error,
}: {
  editGoal: Goal | null;
  habits: Habit[];
  goals: Goal[];
  logs: DailyLog[];
  comps: HabitCompletion[];
  sym: string;
  weekEnd: string;
  onClose: () => void;
  onSubmit: (input: GoalInput) => void;
  pending: boolean;
  error: ApiError | null;
}) {
  const isEdit = editGoal !== null;
  const [targetKind, setTargetKind] = useState<"habit" | "metric">(
    editGoal?.type ?? (habits.length > 0 ? "habit" : "metric"),
  );
  const [habitId, setHabitId] = useState<string>(
    editGoal?.habit_id != null ? String(editGoal.habit_id) : habits[0] ? String(habits[0].id) : "",
  );
  const [metricKey, setMetricKey] = useState<string>(editGoal?.metric_key ?? SYSTEM_METRICS[0].key);
  const [operator, setOperator] = useState<GoalDirection>(editGoal?.direction ?? "above");
  const [duration, setDuration] = useState<"week" | "month">(
    editGoal ? goalTimeframe(editGoal.target_date) : "week",
  );
  const [isRecurring, setIsRecurring] = useState(editGoal?.is_recurring ?? false);
  const [habitTimes, setHabitTimes] = useState(
    editGoal?.type === "habit" && editGoal.target_value != null ? String(editGoal.target_value) : "3",
  );
  const [threshold, setThreshold] = useState(
    // Threshold drives metric goals AND numeric-habit goals (over/under a unit).
    editGoal != null &&
      editGoal.target_value != null &&
      (editGoal.type === "metric" || editGoal.direction != null)
      ? String(editGoal.target_value)
      : "",
  );

  const selectedHabit = habits.find((h) => String(h.id) === habitId);
  const selectedMetric = metricDef(metricKey);
  const metricAffix = selectedMetric ? affix(selectedMetric.unit) : {};
  // A numeric habit is goaled by an over/under threshold on its unit, like a
  // metric; a binary habit is goaled by a completion frequency ("N times").
  const isNumericHabit = targetKind === "habit" && selectedHabit?.value_type === "numeric";
  const usesThreshold = targetKind === "metric" || isNumericHabit;

  // Strict, duration-aware ceiling on habit frequency: 7/week, 31/month.
  const habitMax = duration === "week" ? 7 : 31;
  useEffect(() => {
    setHabitTimes((cur) => {
      const n = Number(cur);
      return Number.isFinite(n) && n > habitMax ? String(habitMax) : cur;
    });
  }, [habitMax]);

  function setHabitTimesClamped(v: string) {
    if (v === "") return setHabitTimes("");
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    setHabitTimes(String(Math.min(habitMax, Math.max(1, Math.floor(n)))));
  }

  // Guardrail: ≤2 active goals per exact target. Skipped while editing — the
  // target is locked and already counted.
  const selectedTargetCount =
    targetKind === "habit"
      ? activeTargetCount(goals, "habit", selectedHabit ? selectedHabit.id : null)
      : activeTargetCount(goals, "metric", metricKey);
  const atTargetLimit = !isEdit && selectedTargetCount >= MAX_GOALS_PER_TARGET;

  const targetValue = usesThreshold ? Number(threshold) : Number(habitTimes);
  const hasTarget = Number.isFinite(targetValue) && targetValue > 0;
  const habitSelectable = targetKind === "habit" ? habits.length > 0 && habitId !== "" : true;
  const valid = hasTarget && habitSelectable && !atTargetLimit;

  const target_date = duration === "week" ? weekEnd : endOfMonthISO(todayISO());

  // Synthetic goal for the live preview — reacts instantly to builder state.
  const previewGoal: Goal = {
    id: -1,
    user_id: "",
    created_at: "",
    name: "", // title is derived from the fields, not a stored custom name
    type: targetKind,
    metric_key: targetKind === "metric" ? metricKey : null,
    target_value: hasTarget ? targetValue : null,
    direction: usesThreshold ? operator : null,
    habit_id: targetKind === "habit" && selectedHabit ? selectedHabit.id : null,
    pillar: targetKind === "habit" ? selectedHabit?.pillar ?? null : selectedMetric?.pillar ?? null,
    target_date,
    is_active: true,
    completed: false,
    is_recurring: isRecurring,
  };
  const previewProgress = computeProgress(previewGoal, habits, logs, comps, sym);
  const selectedHabitUnit = selectedHabit?.value_type === "numeric" ? selectedHabit.unit_label : null;
  // The name column is NOT NULL — store the constructed sentence as the name.
  const derivedName = buildGoalTitle(
    previewGoal,
    selectedHabit?.name ?? "",
    sym,
    selectedHabitUnit,
  ).slice(0, 80);

  function submit() {
    if (!valid) return;
    onSubmit({
      name: derivedName || "Goal",
      type: targetKind,
      metric_key: previewGoal.metric_key,
      target_value: targetValue,
      direction: previewGoal.direction,
      habit_id: previewGoal.habit_id,
      pillar: previewGoal.pillar,
      target_date,
      is_active: true,
      completed: false,
      is_recurring: isRecurring,
    });
  }

  const recurringSelect = (
    <InlineSelect
      value={isRecurring ? "every" : "this"}
      onChange={(v) => setIsRecurring(v === "every")}
      ariaLabel="Recurrence"
    >
      <option className="bg-bg" value="this">
        this
      </option>
      <option className="bg-bg" value="every">
        every
      </option>
    </InlineSelect>
  );

  const durationSelect = (
    <InlineSelect value={duration} onChange={(v) => setDuration(v as "week" | "month")} ariaLabel="Duration">
      <option className="bg-bg" value="week">
        week
      </option>
      <option className="bg-bg" value="month">
        month
      </option>
    </InlineSelect>
  );

  return (
    <ModalShell title={isEdit ? "Edit Goal" : "New Goal"} onClose={onClose}>
      <div className="flex flex-col gap-5">
        {/* Target type toggle + optional custom name */}
        <Field label="Target type">
          <Segmented
            value={targetKind}
            onChange={setTargetKind}
            disabled={isEdit}
            options={[
              { value: "habit", label: "Habit" },
              { value: "metric", label: "System Metric" },
            ]}
          />
        </Field>

        {/* Natural-language sentence */}
        <div className="rounded-[10px] border border-card-border bg-bg/50 px-4 py-4">
          {targetKind === "habit" ? (
            habits.length === 0 ? (
              <p className="text-sm text-white/50">
                No habits yet — add a custom habit first to set a habit-frequency goal.
              </p>
            ) : isNumericHabit ? (
              // Numeric habit → over/under a unit threshold: "Complete over 5
              // miles of Running this week."
              <p className="flex flex-wrap items-center gap-x-1.5 gap-y-2.5 text-base leading-relaxed text-white/70">
                Complete
                <InlineSelect
                  value={operator}
                  onChange={(v) => setOperator(v as GoalDirection)}
                  ariaLabel="Operator"
                >
                  <option className="bg-bg" value="above">
                    over
                  </option>
                  <option className="bg-bg" value="below">
                    under
                  </option>
                </InlineSelect>
                <InlineNumber
                  value={threshold}
                  onChange={setThreshold}
                  ariaLabel="Threshold"
                  placeholder="5"
                  min={0}
                  step={1}
                />
                <span>{selectedHabitUnit}</span>
                of
                <InlineSelect value={habitId} onChange={setHabitId} ariaLabel="Habit" disabled={isEdit}>
                  {habits.map((h) => (
                    <option className="bg-bg" key={h.id} value={String(h.id)}>
                      {h.name}
                    </option>
                  ))}
                </InlineSelect>
                {recurringSelect}
                {durationSelect}.
              </p>
            ) : (
              // Binary habit → completion frequency: "Complete Meditate 3 times
              // this week."
              <p className="flex flex-wrap items-center gap-x-1.5 gap-y-2.5 text-base leading-relaxed text-white/70">
                Complete
                <InlineSelect value={habitId} onChange={setHabitId} ariaLabel="Habit" disabled={isEdit}>
                  {habits.map((h) => (
                    <option className="bg-bg" key={h.id} value={String(h.id)}>
                      {h.name}
                    </option>
                  ))}
                </InlineSelect>
                <InlineNumber
                  value={habitTimes}
                  onChange={setHabitTimesClamped}
                  ariaLabel="Times"
                  placeholder="3"
                  min={1}
                  max={habitMax}
                  step={1}
                />
                times
                {recurringSelect}
                {durationSelect}.
              </p>
            )
          ) : (
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-2.5 text-base leading-relaxed text-white/70">
              <InlineSelect value={metricKey} onChange={setMetricKey} ariaLabel="System metric" disabled={isEdit}>
                {SYSTEM_METRICS.map((m) => (
                  <option className="bg-bg" key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </InlineSelect>
              is
              <InlineSelect
                value={operator}
                onChange={(v) => setOperator(v as GoalDirection)}
                ariaLabel="Operator"
              >
                <option className="bg-bg" value="above">
                  at least
                </option>
                <option className="bg-bg" value="below">
                  no more than
                </option>
              </InlineSelect>
              <InlineNumber
                value={threshold}
                onChange={setThreshold}
                ariaLabel="Threshold"
                placeholder={selectedMetric?.placeholder ?? ""}
                min={0}
                step={selectedMetric?.step}
                prefix={metricAffix.prefix}
                suffix={metricAffix.suffix}
              />
              {recurringSelect}
              {durationSelect}.
            </p>
          )}
        </div>

        {atTargetLimit && (
          <p className="rounded-[8px] border border-negative/40 bg-negative/10 px-3 py-2 text-[11px] font-semibold text-negative">
            This {targetKind} already has {MAX_GOALS_PER_TARGET} active goals. Choose another, or
            archive one first.
          </p>
        )}

        {/* Live preview */}
        <div className="flex flex-col gap-2">
          <p className="label">Live preview</p>
          <GoalCard
            goal={previewGoal}
            pillar={previewGoal.pillar}
            habitName={selectedHabit?.name}
            habitUnit={selectedHabitUnit}
            sym={sym}
            progress={hasTarget ? previewProgress : undefined}
          />
          {!hasTarget && (
            <p className="text-[11px] text-white/35">Enter a target to preview progress.</p>
          )}
        </div>

        {error && (
          <p className="text-xs font-semibold text-negative">
            {error.detail ?? "Couldn’t save. Try again."}
          </p>
        )}

        <button
          type="button"
          onClick={submit}
          disabled={!valid || pending}
          className="h-11 rounded-[8px] bg-white text-sm font-bold text-black disabled:opacity-40"
        >
          {pending ? "Saving…" : isEdit ? "Save Changes" : "Create Goal"}
        </button>
      </div>
    </ModalShell>
  );
}

// ── icons ─────────────────────────────────────────────────────────────────────

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M11.5 2.5l2 2L6 12l-2.7.7.7-2.7 7.5-7.5z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2.5 4h11M6 4V2.5h4V4M5 4l.5 9h5L11 4M6.5 6.5v4M9.5 6.5v4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
