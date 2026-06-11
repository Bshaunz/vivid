import { useEffect, useState } from "react";
import { useForm, type UseFormRegisterReturn } from "react-hook-form";
import { useApp } from "@/context/AppContext";
import { NumberStepper } from "@/components/NumberStepper";
import { todayISO } from "@/lib/dates";
import type { DailyLog, Habit } from "@/types/domain";

/**
 * Evening Log — Output State (~90 sec target).
 *
 * Same frictionless rules as MorningLog: single viewport, uncontrolled RHF
 * inputs, no native pickers. Sequence: binary toggles first (training,
 * macros), then deep work hours (numeric by schema — the Fitness score needs
 * min(hours/4, 1), so it is a ±0.5 stepper, never a boolean), then spend,
 * habit checklist (hidden at 0 habits), collapsed optionals, reflection.
 *
 * Binary toggles default to NOTHING selected — an unanswered toggle blocks
 * submit rather than fabricating a false. Habit checkboxes are the one
 * exception: unchecked at evening submit is a real "not completed today".
 */

interface EveningFormValues {
  training_done: "yes" | "no" | null;
  macro_adherence: "yes" | "no" | null;
  deep_work_hours: string;
  discretionary_spend: string;
  caloric_variance_pct: string;
  workout_rpe: string;
  screen_time_hours: string;
  daily_reflection: string;
  habits: Record<string, boolean>;
}

export default function EveningLog() {
  const { data, todayLog, ready, habits } = useApp();
  const [completionSeed, setCompletionSeed] = useState<Record<string, boolean> | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      const today = todayISO();
      const rows = await data.getHabitCompletions(today, today);
      if (cancelled) return;
      const seed: Record<string, boolean> = {};
      for (const r of rows) seed[String(r.habit_id)] = r.completed;
      setCompletionSeed(seed);
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, data]);

  if (!ready || completionSeed === null) return null;

  if (todayLog?.evening_done && !editing) {
    return <EveningComplete log={todayLog} onEdit={() => setEditing(true)} />;
  }

  return (
    <EveningForm
      existing={todayLog}
      habits={habits}
      completionSeed={completionSeed}
      onSaved={() => setEditing(false)}
    />
  );
}

// ── Completed state ──────────────────────────────────────────────────────────

function EveningComplete({ log, onEdit }: { log: DailyLog; onEdit: () => void }) {
  const { profile } = useApp();
  const currency = profile?.currency ?? "CAD";

  return (
    <main className="mx-auto flex h-dvh max-w-[390px] flex-col px-5 pb-5 pt-6">
      <header className="mb-6">
        <p className="label">{log.date}</p>
        <h1 className="text-2xl font-extrabold tracking-tight">Evening logged</h1>
      </header>

      <section className="grid grid-cols-3 gap-3">
        <SummaryCard label="Deep work" value={`${log.deep_work_hours}h`} />
        <SummaryCard label="Training" value={log.training_done ? "Yes" : "No"} />
        <SummaryCard label={`Spend (${currency})`} value={log.discretionary_spend ?? "--"} />
      </section>

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

function SummaryCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-[14px] border border-card-border bg-card p-3">
      <p className="label mb-1">{label}</p>
      <p className="text-xl font-bold">{value}</p>
    </div>
  );
}

// ── Form ─────────────────────────────────────────────────────────────────────

function EveningForm({
  existing,
  habits,
  completionSeed,
  onSaved,
}: {
  existing: DailyLog | null;
  habits: Habit[];
  completionSeed: Record<string, boolean>;
  onSaved: () => void;
}) {
  const { data, profile, refresh } = useApp();
  const currency = profile?.currency ?? "CAD";

  const fromExisting = existing?.evening_done ?? false;
  const {
    register,
    handleSubmit,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<EveningFormValues>({
    defaultValues: {
      training_done:
        fromExisting && existing?.training_done != null ? (existing.training_done ? "yes" : "no") : null,
      macro_adherence:
        fromExisting && existing?.macro_adherence != null ? (existing.macro_adherence ? "yes" : "no") : null,
      deep_work_hours:
        fromExisting && existing?.deep_work_hours != null ? String(existing.deep_work_hours) : "0",
      discretionary_spend:
        fromExisting && existing?.discretionary_spend != null ? String(existing.discretionary_spend) : "",
      caloric_variance_pct:
        fromExisting && existing?.caloric_variance_pct != null ? String(existing.caloric_variance_pct) : "",
      workout_rpe: fromExisting && existing?.workout_rpe != null ? String(existing.workout_rpe) : "",
      screen_time_hours:
        fromExisting && existing?.screen_time_hours != null ? String(existing.screen_time_hours) : "",
      daily_reflection: fromExisting ? (existing?.daily_reflection ?? "") : "",
      habits: completionSeed,
    },
  });

  const stepDeepWork = (delta: number) => {
    const cur = parseFloat(getValues("deep_work_hours"));
    const base = Number.isFinite(cur) ? cur : 0;
    const next = Math.max(0, Math.min(24, Math.round((base + delta) * 2) / 2));
    setValue("deep_work_hours", String(next));
  };

  const onSubmit = handleSubmit(async (v) => {
    await data.saveEveningLog(todayISO(), {
      deep_work_hours: parseFloat(v.deep_work_hours),
      training_done: v.training_done === "yes",
      macro_adherence: v.macro_adherence === "yes",
      discretionary_spend: parseFloat(v.discretionary_spend),
      caloric_variance_pct: v.caloric_variance_pct === "" ? null : parseFloat(v.caloric_variance_pct),
      daily_reflection: v.daily_reflection.trim() === "" ? null : v.daily_reflection.trim(),
      workout_rpe: v.workout_rpe === "" ? null : Number(v.workout_rpe),
      screen_time_hours: v.screen_time_hours === "" ? null : parseFloat(v.screen_time_hours),
    });
    for (const h of habits) {
      await data.setHabitCompletion(h.id, todayISO(), v.habits?.[String(h.id)] === true);
    }
    await refresh();
    onSaved();
  });

  return (
    <main className="mx-auto flex h-dvh max-w-[390px] flex-col gap-4 overflow-hidden px-5 pb-5 pt-6">
      <header>
        <p className="label">{todayISO()}</p>
        <h1 className="text-2xl font-extrabold tracking-tight">Evening</h1>
      </header>

      <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col gap-4">
        {/* 1 — Binary toggles first */}
        <BinaryToggleRow
          label="Training completed"
          hasError={!!errors.training_done}
          registration={register("training_done", { required: true })}
        />
        <BinaryToggleRow
          label="Macro adherence"
          hasError={!!errors.macro_adherence}
          registration={register("macro_adherence", { required: true })}
        />

        {/* 2 — Deep work hours: numeric by schema (fitness score = min(h/4, 1)) */}
        <div className="flex">
        <NumberStepper
          label="Deep work hours"
          inputMode="decimal"
          registration={register("deep_work_hours", {
            required: true,
            validate: (v) => Number.isFinite(parseFloat(v)) && parseFloat(v) >= 0 && parseFloat(v) <= 24,
          })}
          onDecrement={() => stepDeepWork(-0.5)}
          onIncrement={() => stepDeepWork(0.5)}
        />
        </div>

        {/* 3 — Discretionary spend: decimal keypad */}
        <div className="flex flex-col gap-2">
          <span className="label text-center">
            Discretionary spend ({currency})
            {errors.discretionary_spend && <span className="text-white"> — required</span>}
          </span>
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            className="h-16 w-full rounded-[14px] border border-card-border bg-card text-center text-4xl font-extrabold outline-none placeholder:text-white/20 focus:border-white/40"
            {...register("discretionary_spend", {
              required: true,
              validate: (v) => Number.isFinite(parseFloat(v)) && parseFloat(v) >= 0,
            })}
          />
        </div>

        {/* 4 — Habit checklist (hidden at 0 habits); scrolls internally if long */}
        {habits.length > 0 && (
          <div className="flex min-h-0 flex-col gap-2">
            <span className="label text-center">Habits</span>
            <div className="flex min-h-0 flex-col gap-1.5 overflow-y-auto">
              {habits.map((h) => (
                <label
                  key={h.id}
                  className="flex shrink-0 cursor-pointer items-center justify-between rounded-[30px] border border-card-border bg-card px-4 py-2.5 text-sm font-semibold text-white/60 has-[:checked]:border-accent has-[:checked]:text-white"
                >
                  <input type="checkbox" className="sr-only" {...register(`habits.${h.id}` as const)} />
                  {h.name}
                  <span className="text-xs uppercase tracking-wide text-white/30">done</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* 5 — Optionals, collapsed off the fast path */}
        <details className="group">
          <summary className="label cursor-pointer list-none text-center group-open:mb-3">
            Variance · RPE · Screen time +
          </summary>
          <div className="flex items-stretch gap-3">
            <OptionalNumberInput label="Cal var %" inputMode="decimal" registration={register("caloric_variance_pct", { validate: (v) => v === "" || Number.isFinite(parseFloat(v)) })} />
            <OptionalNumberInput label="RPE 1–10" registration={register("workout_rpe", { validate: (v) => v === "" || (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 10) })} />
            <OptionalNumberInput label="Screen h" inputMode="decimal" registration={register("screen_time_hours", { validate: (v) => v === "" || (Number.isFinite(parseFloat(v)) && parseFloat(v) >= 0 && parseFloat(v) <= 24) })} />
          </div>
        </details>

        {/* 6 — Reflection, optional, at the bottom */}
        <textarea
          rows={2}
          placeholder="Daily reflection (optional)"
          className="w-full resize-none rounded-[8px] border border-card-border bg-card p-3 text-sm outline-none placeholder:text-white/20 focus:border-white/40"
          {...register("daily_reflection")}
        />

        {/* 7 — Massive submit pinned to the viewport bottom */}
        <button
          type="submit"
          disabled={isSubmitting}
          className="mt-auto h-16 shrink-0 rounded-[14px] bg-white text-lg font-bold text-black active:bg-white/80 disabled:opacity-50"
        >
          Log evening
        </button>
      </form>
    </main>
  );
}

function BinaryToggleRow({
  label,
  hasError,
  registration,
}: {
  label: string;
  hasError: boolean;
  registration: UseFormRegisterReturn;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-[14px] border border-card-border bg-card py-2 pl-4 pr-2">
      <span className="text-sm font-semibold">
        {label}
        {hasError && <span className="label block text-white">required</span>}
      </span>
      <div className="flex gap-1">
        {(["yes", "no"] as const).map((opt) => (
          <label
            key={opt}
            className="flex h-11 w-16 cursor-pointer items-center justify-center rounded-[30px] border border-card-border text-xs font-semibold uppercase text-white/50 has-[:checked]:border-accent has-[:checked]:bg-accent has-[:checked]:text-white"
          >
            <input type="radio" value={opt} className="sr-only" {...registration} />
            {opt}
          </label>
        ))}
      </div>
    </div>
  );
}

function OptionalNumberInput({
  label,
  registration,
  inputMode = "numeric",
}: {
  label: string;
  registration: UseFormRegisterReturn;
  inputMode?: "numeric" | "decimal";
}) {
  return (
    <div className="flex flex-1 flex-col gap-2">
      <span className="label text-center">{label}</span>
      <input
        type="text"
        inputMode={inputMode}
        placeholder="--"
        className="h-12 w-full rounded-[8px] border border-card-border bg-card text-center text-xl font-bold outline-none placeholder:text-white/20 focus:border-white/40"
        {...registration}
      />
    </div>
  );
}
