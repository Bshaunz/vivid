import { useEffect, useState } from "react";
import { useForm, type UseFormRegisterReturn } from "react-hook-form";
import { useApp } from "@/context/AppContext";
import { NumberStepper } from "@/components/NumberStepper";
import { addDays, todayISO } from "@/lib/dates";
import type { DailyLog } from "@/types/domain";

/**
 * Morning Log — Input State (~45 sec target).
 *
 * Frictionless rules enforced here:
 * - Single viewport, no scroll: h-dvh flex column, submit pinned at bottom.
 * - Keypad-first: bodyweight autofocuses on mount with inputmode="decimal",
 *   so the numeric keypad is up before the user touches anything.
 * - All inputs uncontrolled (RHF register) — zero re-renders while typing.
 * - Steppers and segment control need no keyboard, so tapping past the
 *   bodyweight field dismisses the keypad naturally.
 * - Optional fields (rhr / hrv / caffeine_delay) collapsed by default;
 *   untouched means null in the data, never a fabricated false/zero.
 */

interface MorningFormValues {
  bodyweight: string;
  sleep_hours: string;
  sleep_minutes: string;
  morning_readiness: string; // "1".."10"
  rhr: string;
  hrv: string;
  caffeine_delay: "yes" | "no" | null;
}

interface Seed {
  /** Most recent logged bodyweight — shown as placeholder, never prefilled. */
  lastBodyweight: number | null;
  /** Yesterday's sleep as stepper starting point, else 7h 30m. */
  sleepHours: number;
  sleepMinutes: number;
}

const READINESS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

export default function MorningLog() {
  const { data, todayLog, ready } = useApp();
  const [seed, setSeed] = useState<Seed | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      const today = todayISO();
      const recent = await data.getDailyLogs(addDays(today, -14), addDays(today, -1));
      const lastWeighed = [...recent].reverse().find((l) => l.bodyweight !== null);
      const yesterday = recent.find((l) => l.date === addDays(today, -1));
      if (cancelled) return;
      setSeed({
        lastBodyweight: lastWeighed?.bodyweight ?? null,
        sleepHours: yesterday?.sleep_hours ?? 7,
        sleepMinutes: yesterday?.sleep_minutes ?? 30,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, data]);

  if (!ready || !seed) return null;

  if (todayLog?.morning_done && !editing) {
    return <MorningComplete log={todayLog} onEdit={() => setEditing(true)} />;
  }

  return <MorningForm seed={seed} existing={todayLog} onSaved={() => setEditing(false)} />;
}

// ── Completed state ──────────────────────────────────────────────────────────

function MorningComplete({ log, onEdit }: { log: DailyLog; onEdit: () => void }) {
  const { profile } = useApp();
  const unit = profile?.unit_pref ?? "lbs";

  return (
    <main className="mx-auto flex h-dvh max-w-[390px] flex-col px-5 pb-5 pt-6">
      <header className="mb-6">
        <p className="label">{log.date}</p>
        <h1 className="text-2xl font-extrabold tracking-tight">Morning logged</h1>
      </header>

      <section className="grid grid-cols-3 gap-3">
        <SummaryCard label={`Weight (${unit})`} value={log.bodyweight ?? "--"} />
        <SummaryCard label="Sleep" value={`${log.sleep_hours}h ${String(log.sleep_minutes).padStart(2, "0")}m`} />
        <SummaryCard label="Readiness" value={log.morning_readiness ?? "--"} />
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

function MorningForm({
  seed,
  existing,
  onSaved,
}: {
  seed: Seed;
  existing: DailyLog | null;
  onSaved: () => void;
}) {
  const { data, profile, refresh } = useApp();
  const unit = profile?.unit_pref ?? "lbs";

  const fromExisting = existing?.morning_done ?? false;
  const {
    register,
    handleSubmit,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<MorningFormValues>({
    defaultValues: {
      bodyweight: fromExisting && existing?.bodyweight != null ? String(existing.bodyweight) : "",
      sleep_hours: String(fromExisting ? (existing?.sleep_hours ?? seed.sleepHours) : seed.sleepHours),
      sleep_minutes: String(fromExisting ? (existing?.sleep_minutes ?? seed.sleepMinutes) : seed.sleepMinutes),
      morning_readiness:
        fromExisting && existing?.morning_readiness != null ? String(existing.morning_readiness) : "",
      rhr: fromExisting && existing?.rhr != null ? String(existing.rhr) : "",
      hrv: fromExisting && existing?.hrv != null ? String(existing.hrv) : "",
      caffeine_delay:
        fromExisting && existing?.caffeine_delay != null ? (existing.caffeine_delay ? "yes" : "no") : null,
    },
  });

  const stepField = (name: "sleep_hours" | "sleep_minutes", delta: number, lo: number, hi: number) => {
    const cur = Number(getValues(name));
    const base = Number.isFinite(cur) ? cur : 0;
    setValue(name, String(clampInt(base + delta, lo, hi)));
  };

  const onSubmit = handleSubmit(async (v) => {
    await data.saveMorningLog(todayISO(), {
      bodyweight: parseFloat(v.bodyweight),
      sleep_hours: Number(v.sleep_hours),
      sleep_minutes: Number(v.sleep_minutes),
      morning_readiness: Number(v.morning_readiness),
      rhr: v.rhr === "" ? null : Number(v.rhr),
      hrv: v.hrv === "" ? null : Number(v.hrv),
      caffeine_delay: v.caffeine_delay === null ? null : v.caffeine_delay === "yes",
    });
    await refresh();
    onSaved();
  });

  return (
    <main className="mx-auto flex h-dvh max-w-[390px] flex-col gap-5 overflow-hidden px-5 pb-5 pt-6">
      <header>
        <p className="label">{todayISO()}</p>
        <h1 className="text-2xl font-extrabold tracking-tight">Morning</h1>
      </header>

      <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col gap-5">
        {/* 1 — Bodyweight: keypad-first */}
        <div className="flex flex-col gap-2">
          <span className="label text-center">
            Bodyweight ({unit}){errors.bodyweight && <span className="text-white"> — required</span>}
          </span>
          <input
            type="text"
            inputMode="decimal"
            autoFocus
            placeholder={seed.lastBodyweight !== null ? String(seed.lastBodyweight) : "0.0"}
            className="h-20 w-full rounded-[14px] border border-card-border bg-card text-center text-5xl font-extrabold outline-none placeholder:text-white/20 focus:border-white/40"
            {...register("bodyweight", {
              required: true,
              validate: (v) => Number.isFinite(parseFloat(v)) && parseFloat(v) > 0,
            })}
          />
        </div>

        {/* 2 — Total sleep: steppers, no native clock wheels */}
        <div className="flex gap-3">
          <NumberStepper
            label="Sleep hours"
            registration={register("sleep_hours", {
              required: true,
              validate: (v) => Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 24,
            })}
            onDecrement={() => stepField("sleep_hours", -1, 0, 24)}
            onIncrement={() => stepField("sleep_hours", 1, 0, 24)}
          />
          <NumberStepper
            label="Sleep minutes"
            registration={register("sleep_minutes", {
              required: true,
              validate: (v) => Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 59,
            })}
            onDecrement={() => stepField("sleep_minutes", -15, 0, 59)}
            onIncrement={() => stepField("sleep_minutes", 15, 0, 59)}
          />
        </div>

        {/* 3 — Morning readiness: 1–10 segment control */}
        <div className="flex flex-col gap-2">
          <span className="label text-center">
            Readiness{errors.morning_readiness && <span className="text-white"> — required</span>}
          </span>
          <div className="grid grid-cols-10 gap-1">
            {READINESS.map((n) => (
              <label
                key={n}
                className="flex h-14 cursor-pointer items-center justify-center rounded-[8px] border border-card-border bg-card text-sm font-semibold text-white/50 has-[:checked]:border-accent has-[:checked]:bg-accent has-[:checked]:text-white"
              >
                <input
                  type="radio"
                  value={String(n)}
                  className="sr-only"
                  {...register("morning_readiness", { required: true })}
                />
                {n}
              </label>
            ))}
          </div>
        </div>

        {/* Optional fields — collapsed, never block the fast path */}
        <details className="group">
          <summary className="label cursor-pointer list-none text-center group-open:mb-3">
            RHR · HRV · Caffeine delay +
          </summary>
          <div className="flex items-stretch gap-3">
            <OptionalNumberInput label="RHR" registration={register("rhr")} />
            <OptionalNumberInput label="HRV" registration={register("hrv")} />
            <div className="flex flex-1 flex-col gap-2">
              <span className="label text-center">Caffeine delay</span>
              <div className="flex flex-1 gap-1">
                {(["yes", "no"] as const).map((opt) => (
                  <label
                    key={opt}
                    className="flex flex-1 cursor-pointer items-center justify-center rounded-[30px] border border-card-border bg-card text-xs font-semibold uppercase text-white/50 has-[:checked]:border-accent has-[:checked]:bg-accent has-[:checked]:text-white"
                  >
                    <input type="radio" value={opt} className="sr-only" {...register("caffeine_delay")} />
                    {opt}
                  </label>
                ))}
              </div>
            </div>
          </div>
        </details>

        {/* 4 — Massive submit, pinned to the bottom of the viewport */}
        <button
          type="submit"
          disabled={isSubmitting}
          className="mt-auto h-16 shrink-0 rounded-[14px] bg-white text-lg font-bold text-black active:bg-white/80 disabled:opacity-50"
        >
          Log morning
        </button>
      </form>
    </main>
  );
}

function OptionalNumberInput({
  label,
  registration,
}: {
  label: string;
  registration: UseFormRegisterReturn;
}) {
  return (
    <div className="flex flex-1 flex-col gap-2">
      <span className="label text-center">{label}</span>
      <input
        type="text"
        inputMode="numeric"
        placeholder="--"
        className="h-full w-full rounded-[8px] border border-card-border bg-card text-center text-xl font-bold outline-none placeholder:text-white/20 focus:border-white/40"
        {...registration}
      />
    </div>
  );
}
