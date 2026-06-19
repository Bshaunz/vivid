import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useApp } from "@/context/AppContext";
import { useToast } from "@/components/Toast";
import { SubmittedCard } from "@/screens/MorningLog";
import { LogSkeleton } from "@/components/Skeleton";
import {
  PrimaryButton,
  Prompt,
  StepShell,
  SummaryCard,
  WizardHeader,
  scrollSelfIntoView,
} from "@/components/wizard";
import { addDays, parseISODate, todayISO, weekStartISO } from "@/lib/dates";
import * as api from "@/lib/apiClient";
import type { DailyLog, Habit, WorkoutStatus } from "@/types/domain";

/**
 * Evening Log — MVP "Token Contract" wizard (PM).
 *
 * Crisp, layout-enforced tracking instead of dense scoring inputs:
 *  1. Training tracker — Trained / Rest / Skipped against the week's token
 *     quota (profile targets, default 4 workouts / 3 rest). Rest is hard-blocked
 *     at 0 rest days left; Skipped touches no tokens but logs the §6.5 penalty
 *     (workout_status="skipped" → training block 0.0).
 *  2. Habits (skipped entirely when none are due today) — binary tap-to-toggle;
 *     numeric tap-to-fill an inline stepper, any value > 0 marks it complete.
 *  3. Deep work, 4. Spend — kept as their own steps (required to score the day).
 *  5. Summary + reflection → one combined "Log Evening" write.
 *
 * Reuses the shared wizard primitives + the verified summary-tile rules.
 */

const DEFAULT_WORKOUT_TARGET = 4;
const DEFAULT_REST_TARGET = 3;

interface EveningDraft {
  status: WorkoutStatus | null;
  done: Record<number, boolean>; // habitId → completed
  qty: Record<number, string>; // numeric habit volume
  deepWork: string;
  spend: string;
  reflection: string;
}

interface Seed {
  done: Record<number, boolean>;
  qty: Record<number, string>;
  priorTrained: number; // trained days earlier this week (excl. today)
  priorRest: number; // rest days earlier this week (excl. today)
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

function todayIsoDow(): number {
  return ((parseISODate(todayISO()).getDay() + 6) % 7) + 1; // Mon=1 … Sun=7
}

function dueToday(h: Habit): boolean {
  const dow = todayIsoDow();
  return !h.frequency_days || h.frequency_days.some((d) => d === dow);
}

function validNum(s: string, lo: number, hi: number): boolean {
  const n = parseFloat(s);
  return Number.isFinite(n) && n >= lo && n <= hi;
}

function sanitizeDecimal(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, "");
  const parts = cleaned.split(".");
  return parts.length > 2 ? `${parts[0]}.${parts.slice(1).join("")}` : cleaned;
}

function initDraft(existing: DailyLog | null, seed: Seed): EveningDraft {
  const done = existing?.evening_done ?? false;
  return {
    status: done ? (existing?.workout_status ?? null) : null,
    done: { ...seed.done },
    qty: { ...seed.qty },
    deepWork: done && existing?.deep_work_hours != null ? String(existing.deep_work_hours) : "0",
    spend: done && existing?.discretionary_spend != null ? String(existing.discretionary_spend) : "",
    reflection: done ? (existing?.daily_reflection ?? "") : "",
  };
}

// ── Entry point ───────────────────────────────────────────────────────────────

export default function EveningLog() {
  const { data, todayLog, ready, habits } = useApp();
  const [seed, setSeed] = useState<Seed | null>(null);
  const [editing, setEditing] = useState(false);

  const dueHabits = useMemo(() => habits.filter(dueToday), [habits]);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      const today = todayISO();
      const weekStart = weekStartISO(today);
      // Token pools reset to the weekly baseline every Monday (the ISO week
      // start): on the reset day there are no earlier-this-week logs to have
      // spent tokens against, so skip that read and let both pools sit at the
      // full target. Guarantees the Monday-morning reset regardless of backend.
      const isResetDay = today === weekStart;
      try {
        const [comps, priorLogs] = await Promise.all([
          data.getHabitCompletions(today, today),
          isResetDay
            ? Promise.resolve([] as DailyLog[])
            : data.getDailyLogs(weekStart, addDays(today, -1)), // this week, before today
        ]);
        if (cancelled) return;
        const done: Record<number, boolean> = {};
        const qty: Record<number, string> = {};
        for (const r of comps) {
          done[r.habit_id] = r.completed;
          if (r.quantity != null) qty[r.habit_id] = String(r.quantity);
        }
        setSeed({
          done,
          qty,
          priorTrained: priorLogs.filter((l) => l.workout_status === "trained").length,
          priorRest: priorLogs.filter((l) => l.workout_status === "rest").length,
        });
      } catch (err) {
        if (cancelled) return;
        console.error("EveningLog: seed load failed — using empty", err);
        setSeed({ done: {}, qty: {}, priorTrained: 0, priorRest: 0 });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, data]);

  if (!ready || seed === null) return <LogSkeleton title="Evening" />;

  if (todayLog?.evening_done && !editing) {
    return <EveningComplete log={todayLog} onEdit={() => setEditing(true)} />;
  }

  return (
    <EveningWizard
      existing={todayLog}
      dueHabits={dueHabits}
      seed={seed}
      onSaved={() => setEditing(false)}
    />
  );
}

// ── Wizard ────────────────────────────────────────────────────────────────────

type EveStep = "training" | "habits" | "deepwork" | "spend" | "final";

function EveningWizard({
  existing,
  dueHabits,
  seed,
  onSaved,
}: {
  existing: DailyLog | null;
  dueHabits: Habit[];
  seed: Seed;
  onSaved: () => void;
}) {
  const { data, profile, refresh } = useApp();
  const { show } = useToast();

  const [draft, setDraft] = useState<EveningDraft>(() => initDraft(existing, seed));
  const [step, setStep] = useState(0);
  const [submitted, setSubmitted] = useState(false);

  const steps = useMemo<EveStep[]>(() => {
    const s: EveStep[] = ["training"];
    if (dueHabits.length > 0) s.push("habits"); // §2: skip entirely when none due
    s.push("deepwork", "spend", "final");
    return s;
  }, [dueHabits.length]);

  const idx = Math.min(step, steps.length - 1);
  const current = steps[idx];
  const goNext = () => setStep((s) => Math.min(steps.length - 1, s + 1));
  const goBack = () => setStep((s) => Math.max(0, s - 1));
  const goToKind = (k: EveStep) => {
    const i = steps.indexOf(k);
    if (i >= 0) setStep(i);
  };

  // Token balances — weekly target minus what's been spent earlier this week.
  const workoutTarget = profile?.weekly_workout_target ?? DEFAULT_WORKOUT_TARGET;
  const restTarget = profile?.weekly_rest_target ?? DEFAULT_REST_TARGET;
  const baseWorkoutsLeft = Math.max(0, workoutTarget - seed.priorTrained);
  const baseRestLeft = Math.max(0, restTarget - seed.priorRest);
  const workoutsLeft = Math.max(0, baseWorkoutsLeft - (draft.status === "trained" ? 1 : 0));
  const restLeft = Math.max(0, baseRestLeft - (draft.status === "rest" ? 1 : 0));

  const mutation = useMutation({
    mutationFn: async () => {
      const date = todayISO();
      const res = await api.saveEveningLog({
        date,
        training_done: draft.status === "trained",
        workout_status: draft.status,
        deep_work_hours: parseFloat(draft.deepWork),
        discretionary_spend: parseFloat(draft.spend),
        macro_adherence: null,
        caloric_variance_pct: null,
        workout_rpe: null,
        daily_reflection: draft.reflection.trim() === "" ? null : draft.reflection.trim(),
        bodyweight: null,
      });
      for (const h of dueHabits) {
        const done = draft.done[h.id] === true;
        const raw = draft.qty[h.id];
        const q =
          done && h.value_type === "numeric" && raw && Number.isFinite(parseFloat(raw))
            ? parseFloat(raw)
            : null;
        await data.setHabitCompletion(h.id, date, done, q);
      }
      return res;
    },
    onMutate: () => setSubmitted(true),
    onError: () => {
      setSubmitted(false);
      show("Couldn't save your evening log — try again");
    },
    onSuccess: async () => {
      await refresh();
      onSaved();
    },
  });

  const submit = () => {
    if (draft.status === null) {
      goToKind("training");
      return;
    }
    if (!validNum(draft.deepWork, 0, 24)) {
      goToKind("deepwork");
      show("Deep work must be 0–24 hours.");
      return;
    }
    if (!validNum(draft.spend, 0, 1e9)) {
      goToKind("spend");
      show("Enter a valid spend amount.");
      return;
    }
    mutation.mutate();
  };

  if (submitted) return <SubmittedCard title="Evening logged" pending={mutation.isPending} />;

  return (
    <main className="mx-auto flex h-full max-w-[390px] flex-col gap-3 overflow-hidden px-5 pb-5 pt-6">
      <WizardHeader step={idx} total={steps.length} onBack={goBack} />
      <section key={idx} className="step-in flex min-h-0 flex-1 flex-col">
        {current === "training" && (
          <TrainingStep
            status={draft.status}
            workoutsLeft={workoutsLeft}
            restLeft={restLeft}
            restDisabled={baseRestLeft === 0}
            onSelect={(s) => setDraft((d) => ({ ...d, status: s }))}
            onNext={goNext}
          />
        )}
        {current === "habits" && <HabitsStep draft={draft} setDraft={setDraft} dueHabits={dueHabits} onNext={goNext} />}
        {current === "deepwork" && (
          <BigNumberStep
            prompt="How many hours of deep work?"
            value={draft.deepWork}
            suffix="hrs"
            placeholder="0"
            autoFocus
            maxLength={5}
            valid={validNum(draft.deepWork, 0, 24)}
            onChange={(v) => setDraft((d) => ({ ...d, deepWork: sanitizeDecimal(v) }))}
            onNext={goNext}
          />
        )}
        {current === "spend" && (
          <BigNumberStep
            prompt="What did you spend today?"
            value={draft.spend}
            prefix="$"
            placeholder="0.00"
            autoFocus
            maxLength={6}
            valid={validNum(draft.spend, 0, 1e9)}
            onChange={(v) => setDraft((d) => ({ ...d, spend: sanitizeDecimal(v) }))}
            onNext={goNext}
          />
        )}
        {current === "final" && (
          <FinalStep
            draft={draft}
            setDraft={setDraft}
            dueHabits={dueHabits}
            pending={mutation.isPending}
            onSubmit={submit}
          />
        )}
      </section>
    </main>
  );
}

// ── Step 1 · Training tracker (token contract) ────────────────────────────────

function TrainingStep({
  status,
  workoutsLeft,
  restLeft,
  restDisabled,
  onSelect,
  onNext,
}: {
  status: WorkoutStatus | null;
  workoutsLeft: number;
  restLeft: number;
  restDisabled: boolean;
  onSelect: (s: WorkoutStatus) => void;
  onNext: () => void;
}) {
  return (
    <StepShell
      footer={
        <PrimaryButton onClick={onNext} disabled={status === null}>
          Next
        </PrimaryButton>
      }
    >
      <Prompt>Did you workout today?</Prompt>

      <div className="flex gap-3">
        <TokenPill label="Workouts left" value={workoutsLeft} />
        <TokenPill label="Rest days left" value={restLeft} />
      </div>

      <div className="flex flex-col gap-3">
        <TrainOption label="Trained" active={status === "trained"} onClick={() => onSelect("trained")} />
        <TrainOption label="Skipped" active={status === "skipped"} onClick={() => onSelect("skipped")} />
        <div>
          <TrainOption
            label="Rest Day"
            active={status === "rest"}
            disabled={restDisabled}
            onClick={() => onSelect("rest")}
          />
          {restDisabled && (
            <p className="mt-2 rounded-[10px] border border-negative/40 bg-negative/10 px-3 py-2 text-[12px] font-semibold leading-snug text-negative">
              You have 0 Rest Days left. To log today, you must select another option.
            </p>
          )}
        </div>
      </div>
    </StepShell>
  );
}

function TokenPill({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-1 flex-col items-center rounded-[14px] border border-card-border bg-card py-3">
      <span className="text-3xl font-extrabold tabular-nums text-white">{value}</span>
      <span className="label mt-0.5">{label}</span>
    </div>
  );
}

function TrainOption({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={active}
      onClick={onClick}
      className={`flex h-16 w-full items-center justify-between rounded-[14px] border px-5 text-left text-base font-bold transition-colors ${
        disabled
          ? "border-card-border bg-card text-white/25"
          : active
            ? "border-accent bg-accent text-white"
            : "border-card-border bg-card text-white/80 active:bg-white/5"
      }`}
    >
      <span>{label}</span>
      {active && <CheckBadge done />}
    </button>
  );
}

// ── Step 2 · Habits (binary toggle / numeric inline) ──────────────────────────

function HabitsStep({
  draft,
  setDraft,
  dueHabits,
  onNext,
}: {
  draft: EveningDraft;
  setDraft: (updater: (prev: EveningDraft) => EveningDraft) => void;
  dueHabits: Habit[];
  onNext: () => void;
}) {
  // Both card types toggle the same `done` flag. For numeric habits this also
  // gates the reveal of the quantity input (see NumericHabitCard) — marking the
  // habit complete is what expands the field; the entered value is optional.
  const toggleDone = (h: Habit) =>
    setDraft((d) => ({ ...d, done: { ...d.done, [h.id]: !d.done[h.id] } }));

  // Quantity edits no longer flip `done` — completion is driven solely by the
  // tap toggle, so typing/stepping while revealed never collapses the input.
  const setQty = (h: Habit, v: string) =>
    setDraft((d) => ({ ...d, qty: { ...d.qty, [h.id]: sanitizeDecimal(v) } }));

  const stepQty = (h: Habit, delta: number) =>
    setDraft((d) => {
      const cur = parseFloat(d.qty[h.id] ?? "0");
      const next = Math.max(0, (Number.isFinite(cur) ? cur : 0) + delta);
      return { ...d, qty: { ...d.qty, [h.id]: String(Math.round(next * 100) / 100) } };
    });

  return (
    <StepShell footer={<PrimaryButton onClick={onNext}>Next</PrimaryButton>}>
      <Prompt>What habits did you complete today?</Prompt>

      <div className="flex flex-col gap-2.5">
        {dueHabits.map((h) =>
          h.value_type === "numeric" ? (
            <NumericHabitCard
              key={h.id}
              habit={h}
              value={draft.qty[h.id] ?? ""}
              done={draft.done[h.id] === true}
              onToggle={() => toggleDone(h)}
              onChange={(v) => setQty(h, v)}
              onStep={(delta) => stepQty(h, delta)}
            />
          ) : (
            <BinaryHabitCard
              key={h.id}
              habit={h}
              done={draft.done[h.id] === true}
              onToggle={() => toggleDone(h)}
            />
          ),
        )}
      </div>
    </StepShell>
  );
}

/** Static done indicator (a filled check or an empty ring). The whole habit card
 *  is the toggle, so the badge itself is never interactive. */
function CheckBadge({ done }: { done: boolean }) {
  return done ? (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white text-sm font-bold text-black">
      ✓
    </span>
  ) : (
    <span className="h-7 w-7 shrink-0 rounded-full border-2 border-white/20" />
  );
}

function BinaryHabitCard({ habit, done, onToggle }: { habit: Habit; done: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={done}
      onClick={onToggle}
      className={`flex items-center justify-between gap-3 rounded-[14px] border p-4 text-left transition-colors ${
        done ? "border-accent bg-accent text-white" : "border-card-border bg-card text-white/75"
      }`}
    >
      <span className="min-w-0 flex-1 text-sm font-semibold">{habit.name}</span>
      <CheckBadge done={done} />
    </button>
  );
}

/** Numeric habit. The card header is the complete/uncomplete toggle; the value
 *  stepper stays hidden until the habit is marked done, then expands in with a
 *  height + fade-and-rise transition (the app's reveal language). */
function NumericHabitCard({
  habit,
  value,
  done,
  onToggle,
  onChange,
  onStep,
}: {
  habit: Habit;
  value: string;
  done: boolean;
  onToggle: () => void;
  onChange: (v: string) => void;
  onStep: (delta: number) => void;
}) {
  return (
    <div
      className={`overflow-hidden rounded-[14px] border transition-colors ${
        done ? "border-accent bg-accent/15" : "border-card-border bg-card"
      }`}
    >
      <button
        type="button"
        aria-pressed={done}
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 p-4 text-left"
      >
        <span className="min-w-0 flex-1 text-sm font-semibold text-white">{habit.name}</span>
        <CheckBadge done={done} />
      </button>

      {/* Reveal region — collapses to 0 height until the habit is marked done.
          grid-template-rows 0fr→1fr animates the height; the inner row fades and
          rises to match the wizard's step-in language. Hidden from a11y/tab
          order while collapsed. */}
      <div
        className={`grid transition-[grid-template-rows] duration-300 ease-out ${
          done ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
        aria-hidden={!done}
      >
        <div className="overflow-hidden">
          <div
            className={`flex items-center gap-2 px-4 pb-4 transition-all duration-300 ease-out ${
              done ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0"
            }`}
          >
            <StepBtn label="decrease" tabIndex={done ? 0 : -1} onClick={() => onStep(-1)}>
              −
            </StepBtn>
            <input
              type="text"
              inputMode="decimal"
              maxLength={5}
              tabIndex={done ? 0 : -1}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onFocus={scrollSelfIntoView}
              placeholder="0"
              aria-label={`${habit.name} ${habit.unit_label ?? ""}`}
              className="min-w-0 flex-1 bg-transparent text-center text-2xl font-extrabold tabular-nums outline-none placeholder:text-white/20"
            />
            <StepBtn label="increase" tabIndex={done ? 0 : -1} onClick={() => onStep(1)}>
              +
            </StepBtn>
            {habit.unit_label && (
              <span className="ml-1 shrink-0 text-sm font-semibold text-white/40">{habit.unit_label}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StepBtn({
  children,
  label,
  onClick,
  tabIndex,
}: {
  children: string;
  label: string;
  onClick: () => void;
  tabIndex?: number;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      tabIndex={tabIndex}
      onClick={onClick}
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-card-border text-2xl font-semibold text-white/70 active:bg-white/10"
    >
      {children}
    </button>
  );
}

// ── Steps 3 & 4 · Deep work / Spend (big number) ──────────────────────────────

function BigNumberStep({
  prompt,
  value,
  onChange,
  onNext,
  valid,
  prefix,
  suffix,
  placeholder,
  autoFocus,
  maxLength,
}: {
  prompt: string;
  value: string;
  onChange: (v: string) => void;
  onNext: () => void;
  valid: boolean;
  prefix?: string;
  suffix?: string;
  placeholder?: string;
  autoFocus?: boolean;
  maxLength?: number;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const tryNext = () => valid && onNext();
  return (
    <StepShell
      footer={
        <PrimaryButton onClick={tryNext} disabled={!valid}>
          Next
        </PrimaryButton>
      }
    >
      <Prompt>{prompt}</Prompt>
      <div className="flex min-w-0 items-end justify-center gap-2">
        {prefix && <span className="shrink-0 pb-3 text-2xl font-bold text-white/40">{prefix}</span>}
        <input
          ref={ref}
          type="text"
          inputMode="decimal"
          enterKeyHint="next"
          autoFocus={autoFocus}
          value={value}
          maxLength={maxLength}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              ref.current?.blur();
              tryNext();
            }
          }}
          onFocus={scrollSelfIntoView}
          placeholder={placeholder}
          className="w-[260px] min-w-0 max-w-full border-b-2 border-card-border bg-transparent pb-2 text-center text-6xl font-extrabold tabular-nums outline-none placeholder:text-white/15 focus:border-accent"
        />
        {suffix && <span className="shrink-0 pb-3 text-2xl font-bold text-white/40">{suffix}</span>}
      </div>
    </StepShell>
  );
}

// ── Summary tile helpers ──────────────────────────────────────────────────────

/** Spend-tile value: a muted, smaller "$" — same size/color utility as the
 *  SummaryCard unit suffix (e.g. the deep-work "h") — immediately followed by the
 *  amount. Shared by the in-wizard review tile and the saved-log view. */
function SpendValue({ amount }: { amount: number | string }) {
  return (
    <>
      <span className="text-xs font-semibold text-white/40">$</span>
      {amount}
    </>
  );
}

// ── Step 5 · Summary + reflection ─────────────────────────────────────────────

function FinalStep({
  draft,
  setDraft,
  dueHabits,
  pending,
  onSubmit,
}: {
  draft: EveningDraft;
  setDraft: (updater: (prev: EveningDraft) => EveningDraft) => void;
  dueHabits: Habit[];
  pending: boolean;
  onSubmit: () => void;
}) {
  const statusLabel =
    draft.status === "trained" ? "Trained" : draft.status === "rest" ? "Rest" : draft.status === "skipped" ? "Skipped" : "--";
  const doneCount = dueHabits.filter((h) => draft.done[h.id]).length;

  return (
    <StepShell
      footer={
        <PrimaryButton onClick={onSubmit} disabled={pending}>
          {pending ? "Logging…" : "Log Evening"}
        </PrimaryButton>
      }
    >
      <Prompt>Clear your head. Any evening reflections?</Prompt>

      <textarea
        rows={3}
        maxLength={1000}
        value={draft.reflection}
        onChange={(e) => setDraft((d) => ({ ...d, reflection: e.target.value }))}
        onFocus={scrollSelfIntoView}
        placeholder="Tonight's reflection… (optional)"
        className="w-full resize-none rounded-[14px] border border-card-border bg-card p-4 text-base leading-relaxed outline-none placeholder:text-white/25 focus:border-accent"
      />

      <div className="grid grid-cols-2 gap-3">
        <SummaryCard label="Training" value={statusLabel} />
        <SummaryCard label="Deep work" value={draft.deepWork || "0"} unit="h" />
        <SummaryCard label="Spend" value={draft.spend !== "" ? <SpendValue amount={draft.spend} /> : "--"} />
        {dueHabits.length > 0 && <SummaryCard label="Habits" value={String(doneCount)} unit="completed" />}
      </div>
    </StepShell>
  );
}

// ── Completed state ───────────────────────────────────────────────────────────

function EveningComplete({ log, onEdit }: { log: DailyLog; onEdit: () => void }) {
  const { data, habits } = useApp();
  const [habitsDone, setHabitsDone] = useState<number | null>(null);

  // Completed-habit count for the tile — fetched like MorningComplete's
  // bodyweight, since the daily_log row alone doesn't carry per-habit state.
  useEffect(() => {
    let cancelled = false;
    data
      .getHabitCompletions(log.date, log.date)
      .then((comps) => {
        if (!cancelled) setHabitsDone(comps.filter((c) => c.completed).length);
      })
      .catch(() => {
        if (!cancelled) setHabitsDone(null);
      });
    return () => {
      cancelled = true;
    };
  }, [data, log.date]);

  const showHabits = habits.some(dueToday);
  const statusLabel =
    log.workout_status === "trained"
      ? "Trained"
      : log.workout_status === "rest"
        ? "Rest"
        : log.workout_status === "skipped"
          ? "Skipped"
          : log.training_done == null
            ? "--"
            : log.training_done
              ? "Yes"
              : "No";

  return (
    <main className="mx-auto flex h-full max-w-[390px] flex-col px-5 pb-5 pt-6">
      <header className="mb-6">
        <p className="label">{log.date}</p>
        <h1 className="text-2xl font-extrabold tracking-tight">Evening logged</h1>
      </header>

      {/* 4-square metric grid — mirrors the Morning Log's finished-tile format. */}
      <section className="grid grid-cols-2 gap-3">
        <SummaryCard label="Training" value={statusLabel} />
        <SummaryCard label="Deep work" value={log.deep_work_hours ?? "--"} unit="h" />
        <SummaryCard
          label="Spend"
          value={log.discretionary_spend != null ? <SpendValue amount={log.discretionary_spend} /> : "--"}
        />
        {showHabits && (
          <SummaryCard
            label="Habits"
            value={habitsDone ?? "--"}
            unit={habitsDone != null ? "completed" : undefined}
          />
        )}
      </section>

      {log.daily_reflection && (
        <div className="mt-3 flex min-h-0 flex-col rounded-[14px] border border-card-border bg-card p-4">
          <p className="label mb-1">Reflection</p>
          <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-white/80">
            {log.daily_reflection}
          </p>
        </div>
      )}

      <button
        type="button"
        onClick={onEdit}
        className="mt-auto h-14 rounded-[14px] border border-card-border bg-card text-base font-semibold text-white/80 active:bg-white/10"
      >
        Edit
      </button>
    </main>
  );
}
