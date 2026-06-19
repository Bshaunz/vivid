# VIVID — Goals, Habits & Evening Log Technical Specification

> **Ground-truth context brick** for the two habit-tracking surfaces — often
> conflated by name, so keep them straight:
>
> - **`src/screens/Goals.tsx`** — the standalone Habits/Goals **management** screen
>   (the `/goals` route). Goals are **DISPLAY-ONLY (CLAUDE.md §6.7): progress is
>   rendered, never scored.** Covered in §§1–5.
> - **`src/screens/EveningLog.tsx`** — the PM **logging wizard** (rendered by
>   `Log.tsx`'s "evening" tab; it has no route of its own). This is the screen the
>   product brief keeps calling "Goals.tsx" — it is a *different file*. Covered in §6.
>
> Reflects the codebase as built through the Evening Log refinement pass. Treat every
> formula, class string, and string template below as authoritative — match it exactly
> when extending either screen.

---

## 1. ARCHITECTURAL BLUEPRINT

Two **decoupled** data models. A Habit is a *stateless definition* (what you do);
a Goal is a *stateful container* (a target laid over a habit or a system metric).
Both are 1:1 mirrors of `supabase/migrations/0001_init.sql` + `0004_habit_value_type.sql`,
typed in `src/types/domain.ts` with snake_case fields so the localStorage → FastAPI/Supabase
swap needs no mapping layer.

### 1.1 Habit — stateless tracking definition

```ts
interface Habit {
  id: number;
  user_id: string;
  name: string;                 // the RAW action title, e.g. "Running", "Deep Work"
  description: string | null;
  pillar: Pillar | null;        // "Health" | "Fitness" | "Finances" | null (Uncategorized)
  frequency_type: FrequencyType;// custom habits are always "daily" here
  frequency_count: number;      // custom habits are always 1 here
  frequency_days: Weekday[] | null;
  value_type: HabitValueType;   // "binary" | "numeric"  ← the tracking SHAPE
  unit_label: string | null;    // numeric only, e.g. "miles", "pages" (≤40 chars); null for binary
  target_per_session: number|null; // ALWAYS null from this UI — quantity is logged ad hoc, not stored
  is_preset: boolean;
  is_active: boolean;           // soft-archive flag (delete = is_active=false)
  created_at: string;
}
```

- **`value_type` is the discriminator.** `"binary"` = done/not-done completion.
  `"numeric"` = the habit measures a quantity in `unit_label`. Migration `0004`
  added `value_type` (NOT NULL, default `'binary'`), `unit_label`, `target_per_session`.
- **Completions are always done/not-done** (`HabitCompletion.completed: boolean`).
  The per-session quantity is **not persisted** — numeric habits count *logged sessions*,
  and that metadata is display-only.
- **Deletion is a SOFT archive** (`is_active=false`) to preserve completion history
  for scoring. See §5.

### 1.2 Goal — stateful target container

```ts
interface Goal {
  id: number;
  user_id: string;
  name: string;                 // NOT NULL → stores the synthesized sentence (buildGoalTitle), ≤80 chars
  type: GoalType;               // "metric" | "habit"
  // metric goals:
  metric_key: string | null;    // a SYSTEM_METRICS key (daily_logs column)
  target_value: number | null;  // the threshold / frequency count
  direction: GoalDirection|null;// "above" (gte) | "below" (lte) | null
  // habit goals:
  habit_id: number | null;
  pillar: Pillar | null;        // display badge only
  target_date: string;          // deadline; the timeframe (week/month) is INFERRED from it
  is_active: boolean;
  completed: boolean;
  is_recurring: boolean;        // true → "every" period; false → "this" period
  created_at: string;
}
```

**Subtype discriminator — `type` + `direction`:**

| Goal subtype        | `type`    | `direction`        | Target meaning                    | Progress bar |
| ------------------- | --------- | ------------------ | --------------------------------- | ------------ |
| Binary-habit        | `habit`   | **`null`**         | completion **frequency** (N times)| no ticker    |
| Numeric-habit       | `habit`   | `above` / `below`  | over/under N **units**            | no ticker    |
| Metric-average      | `metric`  | `above` / `below`  | gte/lte a metric threshold        | fixed ticker |

> **Key rule:** a habit goal with `direction == null` is binary (frequency);
> any non-null `direction` means a numeric threshold. Used throughout for status text.

**Schema honesty notes (do not drift):**
- There is **no `time_frame` column.** Timeframe is inferred from `target_date`:
  `goalTimeframe()` returns `"week"` when `target_date <= weekStart+6`, else `"month"`.
- There is **no `operator` column.** The brief's "At Least / No More Than" maps onto
  `direction` `"above"` / `"below"`.
- Progress is measured over the **current ISO week** (`logs`/`comps` fetched
  `weekStart…weekEnd`); `target_date` only sets the deadline label.

### 1.3 System metrics (the metric-goal target table)

`SYSTEM_METRICS: MetricDef[]` maps each goal-able metric to a real `daily_logs`
column, its aggregation, unit, contextual placeholder, and step:

| key                  | label            | agg   | pillar    | unit  | placeholder | step |
| -------------------- | ---------------- | ----- | --------- | ----- | ----------- | ---- |
| `sleep_hours`        | Avg Sleep        | `avg` | Health    | hours | 8           | 0.5  |
| `morning_readiness`  | Avg Readiness    | `avg` | Health    | points| 7           | 1    |
| `rhr`                | Avg Resting HR   | `avg` | Health    | bpm   | 55          | 1    |
| `hrv`                | Avg HRV          | `avg` | Health    | ms    | 60          | 1    |
| `deep_work_hours`    | Total Deep Work  | `sum` | Fitness   | hours | 4           | 0.5  |
| `discretionary_spend`| Total Spend      | `sum` | Finances  | money | 100         | 10   |

### 1.4 State handlers (component-level)

- Data via `useApp()`: `habits`/`goals` are `useQuery({ activeOnly: true })`; `refresh()`
  `Promise.all`-invalidates `qk.habits`, `qk.goals`, `qk.dashboard`, etc.
- Week data: two local `useQuery`s keyed `["goals","week-logs"|"week-comps", weekStart]`.
- `afterWrite()` → `refresh()` + invalidate both week queries.
- `closeAfterDelete()` → `afterWrite()` + `setPendingDelete(null)` (used as `onSettled` on both delete mutations).
- Mutations: `createHabitM`, `updateHabitM`, `archiveHabitM` (cascade, §5),
  `createGoalM`, `updateGoalM`, `deleteGoalM`. Create/update use `onSuccess`; deletes use `onSettled`.

---

## 2. INLINE NATURAL-LANGUAGE SENTENCE FORMULAS

All builders are composed from inline primitives — `InlineText`, `InlineNumber`,
`InlineSelect` — inside a flex paragraph: `flex flex-wrap items-center gap-x-1.5 gap-y-2.5`.
The `gap-x-1.5` supplies inter-token spacing, so **every interpolated value must be
its own flex item** (see the spacing fix in §2.3).

### 2.1 Completion (binary) Habit builder — `HabitModal`

```
I want to [Action] • Linked to [Pillar]
```
- `[Action]` = `InlineText` placeholder **`Meditate`** (no "e.g."), `maxLength={80}`, autofocus.
- `[Pillar]` = `InlineSelect` (`Uncategorized` + the three pillars).
- `•` separator: `<span className="text-white/30">•</span>`.

### 2.2 Numeric Habit builder — `HabitModal` ([Action, Quantity-by-Unit] rule)

```
I want to track [Action] by logging how many [Unit] • Linked to [Pillar]
```
- `[Action]` = `InlineText` placeholder **`Running`**, `maxLength={80}`.
- `[Unit]` = `InlineText` placeholder **`miles`**, `maxLength={40}`, `widthCls="w-24"`.
- **"per session" was removed** — the sentence ends at the unit; quantity is logged ad hoc,
  so `target_per_session` is always saved as `null`.
- Placeholders carry **no `e.g.,` prefix** anywhere.

### 2.3 Volumetric (numeric-habit) Goal builder — `GoalWizardModal`

```
Complete [over|under] [Threshold] [unit_label] of [Habit] [this|every] [week|month].
```
Example: **"Complete over 5 miles of Running this week."**

- `[over|under]` = `InlineSelect` on `operator` (`above`→"over", `below`→"under").
- `[Threshold]` = `InlineNumber` placeholder `5`, `min={0} step={1}`.
- **`[unit_label]` SPACING FIX:** the unit is rendered as its **own flex item** so the
  `gap-x-1.5` produces a real space — this fixed the bunched `"5milesof"` bug:

  ```tsx
  <InlineNumber value={threshold} … />
  <span>{selectedHabitUnit}</span>   {/* ← wrapper makes it a distinct flex item */}
  of
  <InlineSelect value={habitId} … />
  ```
  A bare `{selectedHabitUnit}` adjacent to bare text would merge into one anonymous
  flex item with **no** gap. The `<span>` is the fix — render it as **"[unit] of [action]"**.

### 2.4 Binary-habit Goal builder — `GoalWizardModal`

```
Complete [Habit] [Times] times [this|every] [week|month].
```
Example: **"Complete Meditate 3 times this week."**
- `[Times]` = `InlineNumber`, clamped `1…habitMax` where `habitMax = duration === "week" ? 7 : 31`.

### 2.5 Metric-average Goal builder — `GoalWizardModal`

```
[Metric label] is [at least|no more than] [Threshold] [this|every] [week|month].
```
- `[at least|no more than]` = `InlineSelect` on `operator` (`above`→"at least", `below`→"no more than").
- `[Threshold]` = `InlineNumber` with `placeholder={selectedMetric?.placeholder ?? ""}`
  (**no `e.g.` prefix**), `step` and `prefix`/`suffix` derived from the metric's unit
  (`$` prefix for money; `hours`/`bpm`/`ms` suffix; points bare).

### 2.6 Stored title — `buildGoalTitle()` (also the goal-card title)

The `name` column is NOT NULL, so the synthesized sentence is stored as the row name
(`.slice(0, 80)`). `recur = is_recurring ? "every" : "this"`, `tf = goalTimeframe(target_date)`:

| Subtype       | Template                                                       |
| ------------- | ------------------------------------------------------------- |
| Numeric-habit | `Complete {over\|under} {n} {habitUnit} of {name} {recur} {tf}`|
| Binary-habit  | `Complete {name} {n} times {recur} {tf}`                      |
| Metric        | `{label} is {at least\|no more than} {phrase} {recur} {tf}`   |

`thresholdPhrase()` formats the metric value: `"8 hours"`, `"$100"`, `"55 bpm"`, `"60 ms"`, points bare.

---

## 3. CARD PRESENTATION & TYPOGRAPHY RULES

### 3.1 Section headers (high prominence + breathing room)

Both "Active Goals" and "Habits" headers:

```tsx
<div className="mb-6 flex items-center justify-between">
  <h2 className="text-2xl font-bold tracking-tight text-white"> … </h2>
```
- `text-2xl font-bold tracking-tight text-white` for crisp contrast.
- `mb-6` bottom margin on the header row.
- Active Goals appends a muted counter: `<span className="ml-2 text-sm font-semibold text-white/40">{goals.length}/{MAX_ACTIVE_GOALS}</span>` (`MAX_ACTIVE_GOALS = 10`).

### 3.2 Habit card — `HabitCardView` (title is the RAW action name)

- **Title = `habit.name` verbatim.** No synthesized strings ("Miles of Running") ever
  appear on a habit card or the habit live-preview header — unit metadata is
  **goal-card-only**. Style: `truncate text-sm font-medium text-white`.
- **Weekly tracker meta** (unit-aware), `text-[11px] text-white/40`:
  ```ts
  const unit = habit.value_type === "numeric" ? habit.unit_label?.trim() : "";
  const meta = unit ? `${completed} ${unit} this week` : `${completed} done this week`;
  ```
  - Numeric → **"12 miles this week"**, **"15 hours this week"**.
  - Binary (and any unit-less numeric) → **"X done this week"**.
  - `completed` = count of logged completions this week. Zero states render cleanly
    ("0 miles this week" / "0 done this week").
- Pillar shown via `PillarBadge`; actions (pencil/trash) passed in by `HabitRow`.

### 3.3 Goal card — `GoalCard` (full synthesized sentence + badge row)

- **Title = the full `buildGoalTitle()` sentence**, `text-sm font-semibold leading-snug text-white`.
- **Badge row:** optional `PillarBadge` + a `Recurring` `Badge`, with right-aligned
  `timeLeftLabel()` (`"3 days left"` / `"Last day"` / `"Ended"`), `text-[11px] tabular-nums text-white/50`.
- Progress bar (§4) + a `current / target` counter (`tabular-nums`) and a status word (§4.4).
- The read-only wizard preview passes **no** `onEdit`/`onDelete`, so it shows no action icons.

---

## 4. DYNAMIC PROGRESS BAR & STATUS MATHEMATICS

Computed in `computeProgress()`, returning `Progress { current, target, fillPct,
markerPct, met, breached, currentLabel, targetLabel }`.

### 4.1 Habit goals (binary + numeric) — no ticker

```
current  = count of completed HabitCompletions for habit_id this week
target   = goal.target_value ?? habit.frequency_count ?? 1
fillPct  = target > 0 ? min(100, (current / target) * 100) : 0
markerPct = null                       // habit goals have NO fixed target tick
below    = direction === "below"       // numeric "under" goals only
met      = below ? current <= target : (target > 0 && current >= target)
breached = below && current > target
```

### 4.2 Metric goals — fixed-ticker scaling (reverse-engineered)

The bar is **scaled so the target always lands on a fixed ticker position** — 25% for
maximize ("at least"), 75% for minimize ("no more than"). This is achieved by scaling
the bar's max to `target / anchor`:

```
def     = metricDef(goal.metric_key)
values  = this week's non-null values of that metric column
current = def.agg === "sum" ? Σ values : mean(values)   // sum vs avg per metric
target  = goal.target_value ?? 0
below   = direction === "below"

anchor   = below ? 0.75 : 0.25         // ticker position as a fraction
maxScale = target > 0 ? target / anchor : 0
fillPct  = maxScale > 0 ? clamp((current / maxScale) * 100, 0, 100) : 0
markerPct = below ? 75 : 25
met      = below ? current <= target : (target > 0 && current >= target)
breached = below ? current > target : false
```

**Why it works — at `current == target`:**
```
fillPct = (target / maxScale) * 100 = (target / (target/anchor)) * 100 = anchor * 100
```
- **"At Least" (gte / above):** `anchor = 0.25` → `maxScale = target / 0.25` → target sits at **25%**.
  Hitting target fills only a quarter, leaving visible "room to overachieve."
- **"No More Than" (lte / below):** `anchor = 0.75` → `maxScale = target / 0.75` → target sits at **75%**.
  Headroom shrinks toward the cap as you approach it; crossing it overflows past the marker.
- Guard: `target <= 0 → maxScale = 0 → fillPct = 0` (empty bar, never `NaN` width).

### 4.3 Bar rendering

```tsx
<div className="relative h-2 w-full rounded-full bg-white/10">
  <div className="h-full rounded-full transition-all duration-300"
       style={{ width: `${progress.fillPct}%`,
                backgroundColor: progress.met ? POSITIVE : NEGATIVE }} />
  {progress.markerPct !== null && (
    <span className="absolute top-1/2 h-3 w-1.5 -translate-x-1/2 -translate-y-1/2
                     rounded-full bg-white shadow-[0_0_4px_rgba(0,0,0,0.85)]"
          style={{ left: `${progress.markerPct}%` }} />
  )}
</div>
```
- Fill is **green (`POSITIVE #2A933C`) when `met`, crimson (`NEGATIVE #C02416`) otherwise.**
- The white target tick renders **only for metric goals** (`markerPct !== null`).

### 4.4 Status text evaluation (bottom-right of the card)

```ts
if (goal.type === "habit" && goal.direction == null) {        // binary habit (frequency)
  status = progress.met ? "Complete" : "In progress";
  tone   = progress.met ? "text-positive" : "text-white/40";
} else if (progress.breached) {                                // numeric "under" past cap / metric over limit
  status = "Over limit";  tone = "text-negative";
} else if (progress.met) {
  status = timeframeOver ? "Complete" : "On Track";            // ← minimization/in-flight rule
  tone   = "text-positive";
} else {
  status = "Behind";      tone = "text-negative";
}
```
where `timeframeOver = goal.target_date !== "" && todayISO() > goal.target_date`.

**Minimization "On Track" rule (the key refinement):** for a numeric/metric goal whose
condition is currently met while its period is still active, show **green "On Track"**,
*not* "Complete." A minimize ("no more than") goal under budget mid-period is provisionally
on track — only a **closed period** (`timeframeOver`) reads "Complete." Binary frequency
goals still read "Complete" the instant the count is reached. Crossing a `below` cap →
**"Over limit"** in crimson.

Status word styling: `font-semibold` + the tone class.

---

## 5. DESTRUCTIVE ACTIONS & CONFIRMATION FLOWS

### 5.1 Intercept → confirm (no immediate delete)

Trash taps never mutate directly. They set `pendingDelete`, which opens a shared dialog;
the mutation fires only on an explicit **Delete** confirm.

```ts
type PendingDelete = { kind: "habit"; habit: Habit } | { kind: "goal"; goal: Goal };
// GoalCard:  onDelete={() => setPendingDelete({ kind: "goal",  goal: g })}
// HabitRow:  onArchive={() => setPendingDelete({ kind: "habit", habit: h })}
function confirmDelete() {
  if (pendingDelete?.kind === "habit") archiveHabitM.mutate(pendingDelete.habit.id);
  else if (pendingDelete) deleteGoalM.mutate(pendingDelete.goal.id);
}
```

### 5.2 Cascading habit deletion (`archiveHabitM`)

A habit is a **soft archive** (`is_active=false`, preserves completion history), so its
goals would dangle. Goals are display-only (not scoring history), so they're **hard-deleted**.
Order is **goals-first** so a mid-flight failure never leaves an archived habit with
orphaned goals. There is **no batch/transaction** in the DataLayer — this is an ordered
best-effort sequence; `onSettled: closeAfterDelete` re-syncs **both** the habits and goals
arrays whether the cascade fully succeeds or fails partway (no manual refresh needed).

```ts
mutationFn: async (id) => {
  const tied = (await data.listGoals({ activeOnly: false })).filter(g => g.habit_id === id);
  for (const g of tied) await data.deleteGoal(g.id);   // ALL goals (active + archived) first
  await data.archiveHabit(id);                          // then soft-archive the habit
}
```

### 5.3 Confirmation dialog — `ConfirmDialog` (mobile-first)

- **Layout:** `fixed inset-0 z-40 flex items-end justify-center bg-black/70 sm:items-center`
  → **bottom-sheet on mobile** (`items-end`), **centered card on desktop** (`sm:items-center`).
  Panel: `w-full max-w-[340px] rounded-t-[16px] … sm:rounded-[16px]`, safe-area bottom padding.
- **A11y:** `role="alertdialog"`, `aria-modal`. Focus moves to **Cancel** on open; `Tab`/`Shift+Tab`
  are trapped to cycle the two buttons (`button:not([disabled])`); **Escape** and **backdrop tap**
  close via a ref-stabilized `onClose`; focus is restored to the trigger on unmount.
- **In-flight guard:** parent `onClose` is `() => { if (!deleteInFlight) setPendingDelete(null); }`,
  so the sheet can't be dismissed mid-delete; buttons disable and the confirm shows **"Deleting…"**.
- **Titles:** `"Delete Habit?"` / `"Delete Goal?"`.
- **Cascade warning** (habit with `linkedActiveGoals > 0` only):
  > **Warning: Deleting this habit will also permanently remove its associated active goals.**

  Rendered in a distinct bordered box: `border border-negative/40 bg-negative/10 … font-semibold text-negative`.
  `linkedActiveGoals = goals.filter(g => g.habit_id === pendingDelete.habit.id).length`.

### 5.4 Buttons

```tsx
{/* Cancel — muted outline/background, closes without action */}
<button className="h-11 flex-1 rounded-[8px] border border-card-border bg-bg
                   text-sm font-semibold text-white/80 hover:text-white disabled:opacity-40">
  Cancel
</button>

{/* Delete — high-contrast crimson, confirms & runs the cascade */}
<button className="h-11 flex-1 rounded-[8px] bg-negative text-sm font-bold text-white
                   hover:bg-negative/90 disabled:opacity-60">
  {pending ? "Deleting…" : confirmLabel /* "Delete" */}
</button>
```

### 5.5 Crimson theme & color tokens

| Token / constant         | Value     | Usage                                                            |
| ------------------------ | --------- | --------------------------------------------------------------- |
| `--color-negative` / `NEGATIVE` | **`#C02416`** | crimson — Delete button, "Over limit"/"Behind", warning box, unmet bar |
| `--color-positive` / `POSITIVE` | `#2A933C` | green — met bar, "Complete"/"On Track"                          |
| `PILLAR_HUE.Health`      | `#C02416` | red pillar badge                                                |
| `PILLAR_HUE.Fitness`     | `#3266AD` | blue pillar badge                                               |
| `PILLAR_HUE.Finances`    | `#2A933C` | green pillar badge                                              |

Tailwind v4 `@theme` generates `bg-negative` / `text-negative` / `border-negative` plus
opacity variants used here: `bg-negative/90` (Delete hover), `bg-negative/10` + `border-negative/40`
(warning box). The crimson `#C02416` is the single source of truth for destructive accent
(equivalently `bg-red-600`); prefer the `bg-negative` token over a raw hex in new code.

---

## 6. EVENING LOG WIZARD — `src/screens/EveningLog.tsx`

> The PM "Token Contract" logging wizard. Default export `EveningLog()`, mounted by
> `Log.tsx` for the `"evening"` tab (**not** the `/goals` route). Reuses the shared
> primitives in `src/components/wizard.tsx` (§6.11). Strict TS throughout; compiles
> with `tsc -b` at 0 errors.

### 6.1 Screen state machine

```ts
type EveStep = "training" | "habits" | "deepwork" | "spend" | "final";
```
- `steps` is built per render: `["training", …, "deepwork", "spend", "final"]` with
  `"habits"` inserted **only when `dueHabits.length > 0`** (the habits step is skipped
  entirely when nothing is due today). `idx = min(step, steps.length-1)`; `goNext`/`goBack`
  clamp to range; `goToKind(k)` jumps to a step by name (used by validation).
- The step panel mounts with `key={idx}` + the `.step-in` keyframe for the fade-rise
  transition between steps.
- Entry `EveningLog()` gates on `useApp()` `ready` + a loaded `seed`
  (`<LogSkeleton title="Evening" />` until then). If `todayLog?.evening_done && !editing`
  → renders `EveningComplete` (§6.10); otherwise `EveningWizard`.

### 6.2 Draft + seed types

```ts
interface EveningDraft {
  status: WorkoutStatus | null;     // "trained" | "rest" | "skipped" | null
  done: Record<number, boolean>;    // habitId → completed
  qty:  Record<number, string>;     // habitId → numeric volume (raw string)
  deepWork: string; spend: string; reflection: string;
}
interface Seed {
  done: Record<number, boolean>; qty: Record<number, string>;
  priorTrained: number;             // trained days earlier THIS week (excl. today)
  priorRest: number;                // rest days earlier this week (excl. today)
}
```
`initDraft(existing, seed)` hydrates from `todayLog` **only when `evening_done`** (so an
in-progress visit starts blank): `deepWork` defaults `"0"`, `spend`/`reflection` `""`,
`status` null unless already logged. `done`/`qty` always seed from `seed`.

### 6.3 Seed load + Monday token reset

`EveningLog()`'s effect (keyed `[ready, data]`) runs an async IIFE that fetches today's
habit completions and this week's prior daily logs:
```ts
const today = todayISO();
const weekStart = weekStartISO(today);   // ISO Monday (lib/dates.ts)
const isResetDay = today === weekStart;  // Monday: no prior-this-week logs exist
const [comps, priorLogs] = await Promise.all([
  data.getHabitCompletions(today, today),
  isResetDay ? Promise.resolve([]) : data.getDailyLogs(weekStart, addDays(today, -1)),
]);
```
- **Monday reset rule:** on the ISO week start there are no earlier-this-week logs to have
  spent tokens against, so the prior-logs read is **skipped** and both token pools sit at
  full target — deterministic, backend-independent.
- `priorTrained`/`priorRest` = counts of `workout_status === "trained"`/`"rest"` in
  `priorLogs`. On any seed failure → empty seed (`{}, {}, 0, 0`) + a `console.error`.

### 6.4 Token contract (Step-1 balances)

```
DEFAULT_WORKOUT_TARGET = 4      DEFAULT_REST_TARGET = 3
workoutTarget = profile?.weekly_workout_target ?? 4
restTarget    = profile?.weekly_rest_target    ?? 3
baseWorkoutsLeft = max(0, workoutTarget - seed.priorTrained)
baseRestLeft     = max(0, restTarget    - seed.priorRest)
workoutsLeft = max(0, baseWorkoutsLeft - (status === "trained" ? 1 : 0))
restLeft     = max(0, baseRestLeft     - (status === "rest"    ? 1 : 0))
restDisabled = baseRestLeft === 0      // hard-block Rest at 0 remaining
```

### 6.5 Step 1 · Training tracker — `TrainingStep`
- Prompt (verbatim): **"Did you workout today?"**
- Two `TokenPill`s: **"Workouts left"** / **"Rest days left"** (big `tabular-nums` value
  over a `.label`).
- Three stacked full-width (`h-16`) `TrainOption` buttons, in order:
  **"Trained"** (`status==="trained"`), **"Skipped"** (`"skipped"`), **"Rest Day"** (`"rest"`).
  Active = `border-accent bg-accent text-white` + a `CheckBadge`. Rest is `disabled` when
  `restDisabled`; below it a crimson notice renders:
  > You have 0 Rest Days left. To log today, you must select another option.

  (`border-negative/40 bg-negative/10 … text-negative`).
- Footer `PrimaryButton` "Next" is disabled while `status === null`.
- A "skipped" status logs the CLAUDE.md §6.5 training penalty (status `"skipped"` → training
  block 0.0) but spends **no** token; `training_done` is the boolean mirror of `status==="trained"`.

### 6.6 Step 2 · Habits — `HabitsStep`
- Prompt (verbatim): **"What habits did you complete today?"**
- Each due habit renders by `value_type`:
  - **binary** → `BinaryHabitCard`: the whole card is the toggle (`onToggle` → `toggleDone`),
    `aria-pressed`, accent when done, static `CheckBadge`.
  - **numeric** → `NumericHabitCard` (§6.6.1).
- Handlers (all in `HabitsStep`):
  ```ts
  toggleDone(h)  // flips done[h.id] — used by BOTH card types
  setQty(h, v)   // qty[h.id] = sanitizeDecimal(v)          — does NOT touch done
  stepQty(h, ±1) // qty[h.id] = clamp≥0(parseFloat ± delta) — does NOT touch done
  ```
  **`done` is driven solely by the tap toggle** (decoupled from quantity), so typing/stepping
  never collapses the reveal mid-edit. Save treats a numeric habit marked done with no value
  as `done=true, quantity=null`.

#### 6.6.1 Numeric reveal animation — `NumericHabitCard`
The card **header** (habit name + static `CheckBadge`) is a `<button>` that toggles done.
The stepper/input lives in a **reveal region hidden until done**, expanded with the app's
fade-and-rise language:
```tsx
<div className={`grid transition-[grid-template-rows] duration-300 ease-out
                 ${done ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`} aria-hidden={!done}>
  <div className="overflow-hidden">
    <div className={`flex … px-4 pb-4 transition-all duration-300 ease-out
                     ${done ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0"}`}>
      <StepBtn tabIndex={done?0:-1} …>−</StepBtn>
      <input maxLength={5} tabIndex={done?0:-1} inputMode="decimal" … />
      <StepBtn tabIndex={done?0:-1} …>+</StepBtn>
      {habit.unit_label && <span …>{unit_label}</span>}
    </div>
  </div>
</div>
```
- `grid-template-rows: 0fr→1fr` (transitioned) drives the height collapse/expand; the inner
  `opacity` + `-translate-y-1→0` is the rise. The collapsed region is `aria-hidden` and its
  controls carry `tabIndex={-1}` (out of tab order). `StepBtn` gained an optional `tabIndex` prop.
- `CheckBadge` is now **static** (a filled `✓` disc or an empty ring) — the card, not the
  badge, is the control. (The earlier "tap badge to clear the value" interaction was removed.)
- `maxLength={5}` on the numeric input (overflow protection, per §6.7).

### 6.7 Steps 3 & 4 · Deep work / Spend — `BigNumberStep`
Shared hero-number step: `text-6xl`, `w-[260px] min-w-0 max-w-full`, centered, `tabular-nums`,
`border-b-2 … focus:border-accent`. Optional `prefix`/`suffix`/`maxLength` props. Enter blurs
the field + advances when `valid`.

| Step     | prompt                          | affix         | placeholder | maxLength | valid range        |
| -------- | ------------------------------- | ------------- | ----------- | --------- | ------------------ |
| deepwork | "How many hours of deep work?"  | suffix `hrs`  | `0`         | **5**     | `validNum(0, 24)`  |
| spend    | "What did you spend today?"     | prefix `$`    | `0.00`      | **6**     | `validNum(0, 1e9)` |

- `sanitizeDecimal` strips non-`[0-9.]` and collapses extra dots on every change.
- `maxLength` physically caps input so large strings can't clip the container; the wider
  `260px` box + `min-w-0 max-w-full` lets up to ~6 digits render fully without truncation.
- Affix spans are `shrink-0 text-2xl text-white/40` so they never wrap or get squeezed.

### 6.8 Step 5 · Summary + reflection — `FinalStep`
- Prompt (verbatim): **"Clear your head. Any evening reflections?"**
- `<textarea rows={3} maxLength={1000}>` (placeholder "Tonight's reflection… (optional)").
- **4-square review grid** (`grid grid-cols-2 gap-3`) of `SummaryCard`s, mirroring Morning Log:

  | tile      | value                                          | unit          |
  | --------- | ---------------------------------------------- | ------------- |
  | Training  | `statusLabel` ("Trained"/"Rest"/"Skipped"/"--")| —             |
  | Deep work | `draft.deepWork || "0"`                        | `h`           |
  | Spend     | `<SpendValue amount={draft.spend} />` or `"--"`| —             |
  | Habits\*  | `String(doneCount)`                            | **`completed`** |

  \* Habits tile renders only when `dueHabits.length > 0`. `doneCount =
  dueHabits.filter(h => draft.done[h.id]).length`.
- **`SpendValue({amount})`** renders a muted, smaller `$` (`text-xs font-semibold text-white/40`
  — the exact size/color of a SummaryCard unit suffix) immediately followed by the amount.
  Shared by `FinalStep` and `EveningComplete` so both read identically. The old `$`-in-the-string
  and `(/ total)` habit suffix are gone.
- Footer button text: "Log Evening" / "Logging…".

### 6.9 Save mutation + validation
`submit()` guards before mutating: jump to `training` if `status===null`; to `deepwork` if
`!validNum(deepWork,0,24)` (toast "Deep work must be 0–24 hours."); to `spend` if
`!validNum(spend,0,1e9)` (toast "Enter a valid spend amount."). Then `mutation.mutate()`:
```ts
api.saveEveningLog({ date, training_done: status==="trained", workout_status: status,
  deep_work_hours: parseFloat(deepWork), discretionary_spend: parseFloat(spend),
  macro_adherence: null, caloric_variance_pct: null, workout_rpe: null,
  daily_reflection: reflection.trim() || null, bodyweight: null });
// then, per due habit: data.setHabitCompletion(h.id, date, done, qtyOrNull)
//   qty persisted only when done && value_type==="numeric" && finite parseFloat(raw)
```
`onMutate` flips `submitted` → renders `<SubmittedCard title="Evening logged" pending=… />`
(imported from `MorningLog`). `onError` reverts + toasts "Couldn't save your evening log — try
again". `onSuccess` `await refresh()` then `onSaved()`.

### 6.10 Completed state — `EveningComplete`
Rendered when `todayLog.evening_done` and not editing. `useApp()` → `{ data, habits }`.
- Header: `.label` date + `<h1>Evening logged</h1>`.
- Fetches the completed-habit count in an effect (`getHabitCompletions(date,date)` → count of
  `completed`), like `MorningComplete`'s bodyweight fetch, since the `daily_log` row carries no
  per-habit state. `showHabits = habits.some(dueToday)`.
- Same **4-square grid** as §6.8: Training (`statusLabel` derived from `workout_status`, falling
  back to `training_done`), Deep work (`deep_work_hours ?? "--"`, unit `h`), Spend
  (`<SpendValue amount={discretionary_spend} />` or `"--"`), Habits (`habitsDone ?? "--"`, unit
  `completed` **only when** the count is non-null).
- Optional reflection block; an `Edit` button → `setEditing(true)` re-opens the wizard.

### 6.11 Shared wizard primitives — `src/components/wizard.tsx`
Used by **both** the Morning and Evening wizards (one layout/typography contract):
- `StepShell({children, footer})` — scrollable centered body + pinned footer (keeps inputs
  above the mobile keyboard). `Prompt` — centered `text-[26px] font-extrabold` heading.
  `PrimaryButton` — full-width white CTA. `WizardHeader({step,total,onBack})` — back chevron +
  progress dots.
- `SummaryCard({label, value, unit?})` — finished-log tile, `h-[84px]`. **Input-resilient:**
  `min-w-0 overflow-hidden` on the tile + a `whitespace-nowrap` value row so a long value sits
  at its true grid-track width and never overflows/overlaps a sibling; `unit` is a `shrink-0`
  `text-xs text-white/40` suffix. `value: ReactNode`, so `SpendValue` / `"4" + unit="completed"`
  compose cleanly.
- `scrollSelfIntoView(e)` — defers past the keyboard resize, then `scrollIntoView` the focused field.

---

### Cross-cutting invariants
- **Two screens, one habit model:** `Goals.tsx` (manage) and `EveningLog.tsx` (log) both read
  `useApp().habits`; only the Evening Log **writes** completions (`setHabitCompletion`). Don't
  cross-wire them — the brief's "Goals.tsx" almost always means the Evening Log wizard (§6).
- **`tsconfig.app.json` has `noUnusedLocals` + `noUnusedParameters`** — any orphaned
  non-exported top-level function is a compile error; delete it rather than leave it.
- **Goals never feed a score** (§6.7). Anything here is presentational.
- **Inline-sentence spacing:** interpolated values must each be their own flex child
  (`<span>`-wrap bare expressions) so `gap-x-1.5` renders a space (§2.3).
