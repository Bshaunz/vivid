import { useEffect, useState } from "react";
import { useForm, type UseFormRegisterReturn } from "react-hook-form";
import { useMutation } from "@tanstack/react-query";
import { useApp } from "@/context/AppContext";
import { useToast } from "@/components/Toast";
import { NumberStepper } from "@/components/NumberStepper";
import { addDays, todayISO } from "@/lib/dates";
import * as api from "@/lib/apiClient";
import type { DailyLog } from "@/types/domain";

/**
 * Morning Log — Input State (~45 sec target).
 *
 * v4 fields only: morning_readiness + sleep_hours required; rhr/hrv optional.
 * Bodyweight is NOT a daily_logs field — the quick-entry here writes a
 * bodyweight_entries row (any day, any time; the week's median is what scores).
 *
 * Frictionless rules:
 * - Single viewport, no scroll: h-dvh flex column, submit pinned at bottom.
 * - Keypad-first: bodyweight autofocuses with inputmode="decimal".
 * - All inputs uncontrolled (RHF register) — zero re-renders while typing.
 * - Steppers/segments need no keyboard; tapping past bodyweight dismisses it.
 * - Optional fields (rhr/hrv) collapsed; untouched means null, never a 0.
 */

interface MorningFormValues {
  bodyweight: string; // optional → bodyweight_entries
  sleep_hours: string; // float, 0–16
  morning_readiness: string; // "1".."10"
  rhr: string;
  hrv: string;
}

interface Seed {
  lastBodyweight: number | null; // placeholder only, never prefilled
  sleepHours: number; // yesterday's sleep as stepper start, else 7.5
}

const READINESS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

function clampFloat(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
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
      const [recent, lastBw] = await Promise.all([
        data.getDailyLogs(addDays(today, -7), addDays(today, -1)),
        data.getLatestBodyweight(),
      ]);
      const yesterday = recent.find((l) => l.date === addDays(today, -1));
      if (cancelled) return;
      setSeed({
        lastBodyweight: lastBw?.value ?? null,
        sleepHours: yesterday?.sleep_hours ?? 7.5,
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
  const { data, profile } = useApp();
  const unit = profile?.unit_pref ?? "lbs";
  const [todayWeight, setTodayWeight] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    data.getBodyweightEntries(log.date, log.date).then((entries) => {
      if (!cancelled) setTodayWeight(entries.at(-1)?.value ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [data, log.date]);

  return (
    <main className="mx-auto flex h-dvh max-w-[390px] flex-col px-5 pb-5 pt-6">
      <header className="mb-6">
        <p className="label">{log.date}</p>
        <h1 className="text-2xl font-extrabold tracking-tight">Morning logged</h1>
      </header>

      <section className="grid grid-cols-3 gap-3">
        <SummaryCard label="Readiness" value={log.morning_readiness ?? "--"} />
        <SummaryCard label="Sleep" value={log.sleep_hours != null ? `${log.sleep_hours}h` : "--"} />
        <SummaryCard label={`Weight (${unit})`} value={todayWeight ?? "--"} />
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
  const { show } = useToast();
  const unit = profile?.unit_pref ?? "lbs";

  // Optimistic: flips to the submitted view the instant the user taps Log,
  // before the network settles. Reverted by onError.
  const [submitted, setSubmitted] = useState(false);

  const fromExisting = existing?.morning_done ?? false;
  const {
    register,
    handleSubmit,
    setValue,
    getValues,
    formState: { errors },
  } = useForm<MorningFormValues>({
    defaultValues: {
      bodyweight: "",
      sleep_hours: String(fromExisting ? (existing?.sleep_hours ?? seed.sleepHours) : seed.sleepHours),
      morning_readiness:
        fromExisting && existing?.morning_readiness != null ? String(existing.morning_readiness) : "",
      rhr: fromExisting && existing?.rhr != null ? String(existing.rhr) : "",
      hrv: fromExisting && existing?.hrv != null ? String(existing.hrv) : "",
    },
  });

  const stepSleep = (delta: number) => {
    const cur = parseFloat(getValues("sleep_hours"));
    const base = Number.isFinite(cur) ? cur : 0;
    setValue("sleep_hours", String(clampFloat(Math.round((base + delta) * 4) / 4, 0, 16)));
  };

  const mutation = useMutation({
    mutationFn: async (v: MorningFormValues) => {
      const date = todayISO();
      const readiness = Number(v.morning_readiness);
      const sleep = parseFloat(v.sleep_hours);
      const rhr = v.rhr === "" ? null : Number(v.rhr);
      const hrv = v.hrv === "" ? null : Number(v.hrv);
      const bwNum = parseFloat(v.bodyweight);
      const bw = v.bodyweight.trim() !== "" && Number.isFinite(bwNum) ? bwNum : null;

      // Real API call first (server validation + scoring). Throws on failure;
      // returns null in local-only mode (no VITE_API_URL).
      const res = await api.saveMorningLog({
        date,
        morning_readiness: readiness,
        sleep_hours: sleep,
        rhr,
        hrv,
        bodyweight: bw,
      });

      // Write-through to the local cache so context reads stay consistent.
      await data.saveMorningLog(date, { morning_readiness: readiness, sleep_hours: sleep, rhr, hrv });
      if (bw !== null) await data.addBodyweightEntry(bw);
      return res;
    },
    onMutate: () => setSubmitted(true), // optimistic
    onError: () => {
      setSubmitted(false); // revert
      show("Couldn't save your morning log — try again");
    },
    onSuccess: async () => {
      await refresh();
      onSaved();
    },
  });

  const onSubmit = handleSubmit((v) => mutation.mutate(v));

  if (submitted) return <SubmittedCard title="Morning logged" pending={mutation.isPending} />;

  return (
    <main className="mx-auto flex h-dvh max-w-[390px] flex-col gap-5 overflow-hidden px-5 pb-5 pt-6">
      <header>
        <p className="label">{todayISO()}</p>
        <h1 className="text-2xl font-extrabold tracking-tight">Morning</h1>
      </header>

      <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col gap-5">
        {/* 1 — Bodyweight quick-entry: keypad-first, optional (its own entity) */}
        <div className="flex flex-col gap-2">
          <span className="label text-center">Bodyweight ({unit}) · optional</span>
          <input
            type="text"
            inputMode="decimal"
            autoFocus
            placeholder={seed.lastBodyweight !== null ? String(seed.lastBodyweight) : "0.0"}
            className="h-20 w-full rounded-[14px] border border-card-border bg-card text-center text-5xl font-extrabold outline-none placeholder:text-white/20 focus:border-accent"
            {...register("bodyweight", {
              validate: (v) => v.trim() === "" || (Number.isFinite(parseFloat(v)) && parseFloat(v) > 0),
            })}
          />
          <p className="text-center text-[11px] leading-tight text-white/35">
            Any day, any time — we use your weekly median, so more entries = a truer picture.
          </p>
        </div>

        {/* 2 — Sleep hours: decimal stepper (float), ±0.25 = 15-min steps */}
        <div className="flex">
          <NumberStepper
            label="Sleep hours"
            inputMode="decimal"
            registration={register("sleep_hours", {
              required: true,
              validate: (v) => Number.isFinite(parseFloat(v)) && parseFloat(v) >= 0 && parseFloat(v) <= 16,
            })}
            onDecrement={() => stepSleep(-0.25)}
            onIncrement={() => stepSleep(0.25)}
          />
        </div>

        {/* 3 — Morning readiness: 1–10 segment control */}
        <div className="flex flex-col gap-2">
          <span className="label text-center">
            Readiness{errors.morning_readiness && <span className="text-negative"> — required</span>}
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
            RHR · HRV +
          </summary>
          <div className="flex items-stretch gap-3">
            <OptionalNumberInput label="RHR" registration={register("rhr")} />
            <OptionalNumberInput label="HRV" registration={register("hrv")} />
          </div>
        </details>

        {/* 4 — Massive submit, pinned to the bottom of the viewport */}
        <button
          type="submit"
          disabled={mutation.isPending}
          className="mt-auto h-16 shrink-0 rounded-[14px] bg-white text-lg font-bold text-black active:bg-white/80 disabled:opacity-50"
        >
          Log morning
        </button>
      </form>
    </main>
  );
}

// Optimistic submitted view — shown the instant the user taps Log, while the
// save settles in the background. Grey accent only (no blue/green chrome).
export function SubmittedCard({ title, pending }: { title: string; pending: boolean }) {
  return (
    <main className="mx-auto flex h-dvh max-w-[390px] flex-col items-center justify-center gap-4 px-5">
      <div className="flex h-16 w-16 items-center justify-center rounded-full border-2 border-accent">
        <span className="text-3xl font-bold text-white">✓</span>
      </div>
      <h1 className="text-2xl font-extrabold tracking-tight">{title}</h1>
      <p className="label">{pending ? "Saving…" : "Saved"}</p>
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
        className="h-12 w-full rounded-[8px] border border-card-border bg-card text-center text-xl font-bold outline-none placeholder:text-white/20 focus:border-accent"
        {...registration}
      />
    </div>
  );
}
