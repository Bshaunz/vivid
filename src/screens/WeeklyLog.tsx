import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useApp } from "@/context/AppContext";
import { LogSkeleton } from "@/components/Skeleton";
import { isSunday, parseISODate, todayISO, weekStartISO } from "@/lib/dates";
import type { WeeklyLog as WeeklyLogRow, WeeklySummary } from "@/types/domain";

/**
 * Weekly Log — Trajectory Review (Sunday, ~5 min).
 *
 * v4 weekly_logs is just capital_allocated + bottleneck_audit. Bodyweight goal
 * is a profile setting now (Settings), not logged here. The read-only anchors
 * come from WeeklySummary: the week's bodyweight MEDIAN (never an average; raw
 * dailies are never scored, §4), training sessions, and evenings logged.
 *
 * Sunday-only per spec; other days show the countdown. In dev builds,
 * ?preview=1 unlocks the form for testing (stripped from production).
 */

interface WeeklyFormValues {
  capital_allocated: string;
  bottleneck_audit: string;
}

interface Seed {
  summary: WeeklySummary;
  existing: WeeklyLogRow | null;
}

export default function WeeklyLog() {
  const { data, ready } = useApp();
  const [seed, setSeed] = useState<Seed | null>(null);
  const [editing, setEditing] = useState(false);
  const [devPreview] = useState(
    () => import.meta.env.DEV && new URLSearchParams(window.location.search).has("preview"),
  );

  const today = todayISO();
  const weekStart = weekStartISO(today);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      const [summary, existing] = await Promise.all([
        data.getWeeklySummary(weekStart),
        data.getWeeklyLog(weekStart),
      ]);
      if (cancelled) return;
      setSeed({ summary, existing });
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, data, weekStart]);

  if (!isSunday(today) && !devPreview) {
    return <WeeklyLocked today={today} />;
  }

  if (!ready || !seed) return <LogSkeleton title="Weekly review" />;

  if (seed.existing && !editing) {
    return <WeeklyComplete log={seed.existing} summary={seed.summary} onEdit={() => setEditing(true)} />;
  }

  return <WeeklyForm seed={seed} weekStart={weekStart} onSaved={() => setEditing(false)} />;
}

// ── Locked state (Mon–Sat) ───────────────────────────────────────────────────

function WeeklyLocked({ today }: { today: string }) {
  const daysUntilSunday = (7 - parseISODate(today).getDay()) % 7;
  return (
    <main className="mx-auto flex h-dvh max-w-[390px] flex-col px-5 pb-5 pt-6">
      <header>
        <p className="label">{today}</p>
        <h1 className="text-2xl font-extrabold tracking-tight">Weekly review</h1>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-2">
        <p className="text-7xl font-extrabold">{daysUntilSunday}</p>
        <p className="label">{daysUntilSunday === 1 ? "day" : "days"} until Sunday</p>
      </div>
    </main>
  );
}

// ── Read-only week anchors ───────────────────────────────────────────────────

function AnchorGrid({ summary, unit }: { summary: WeeklySummary; unit: string }) {
  const { profile } = useApp();
  const goal = profile?.bodyweight_goal ?? null;
  const bwDelta =
    summary.median_bodyweight !== null && goal !== null
      ? Math.round((summary.median_bodyweight - goal) * 10) / 10
      : null;

  return (
    <section className="grid grid-cols-2 gap-3">
      <div className="rounded-[14px] border border-card-border bg-card p-4">
        <p className="label mb-1">Median bodyweight ({unit})</p>
        <p className="text-3xl font-extrabold">{summary.median_bodyweight ?? "--"}</p>
        <p className="mt-1 text-xs text-white/50">
          {summary.median_bodyweight === null
            ? "no samples this week"
            : summary.low_confidence
              ? `${summary.n_bw_samples} sample${summary.n_bw_samples === 1 ? "" : "s"} · low confidence`
              : bwDelta !== null
                ? `${bwDelta > 0 ? "+" : ""}${bwDelta} vs goal`
                : `${summary.n_bw_samples} samples`}
        </p>
      </div>
      <div className="rounded-[14px] border border-card-border bg-card p-4">
        <p className="label mb-1">Training sessions</p>
        <p className="text-3xl font-extrabold">{summary.training_sessions}</p>
        <p className="mt-1 text-xs text-white/50">{summary.evenings_logged}/7 evenings logged</p>
      </div>
    </section>
  );
}

// ── Completed state ──────────────────────────────────────────────────────────

function WeeklyComplete({
  log,
  summary,
  onEdit,
}: {
  log: WeeklyLogRow;
  summary: WeeklySummary;
  onEdit: () => void;
}) {
  const { profile } = useApp();
  const currency = profile?.currency ?? "CAD";
  const unit = profile?.unit_pref ?? "lbs";

  return (
    <main className="mx-auto flex h-dvh max-w-[390px] flex-col gap-4 px-5 pb-5 pt-6">
      <header>
        <p className="label">Week of {log.week_start}</p>
        <h1 className="text-2xl font-extrabold tracking-tight">Week reviewed</h1>
      </header>

      <AnchorGrid summary={summary} unit={unit} />

      <section className="rounded-[14px] border border-card-border bg-card p-4">
        <p className="label mb-1">Capital allocated ({currency})</p>
        <p className="text-2xl font-bold">{log.capital_allocated}</p>
      </section>

      {log.bottleneck_audit && (
        <section className="rounded-[14px] border border-card-border bg-card p-4">
          <p className="label mb-2">Bottleneck</p>
          <p className="text-sm text-white/80">{log.bottleneck_audit}</p>
        </section>
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

// ── Form ─────────────────────────────────────────────────────────────────────

function WeeklyForm({
  seed,
  weekStart,
  onSaved,
}: {
  seed: Seed;
  weekStart: string;
  onSaved: () => void;
}) {
  const { data, profile, refresh } = useApp();
  const currency = profile?.currency ?? "CAD";
  const unit = profile?.unit_pref ?? "lbs";
  const { summary, existing } = seed;

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<WeeklyFormValues>({
    defaultValues: {
      capital_allocated: existing?.capital_allocated != null ? String(existing.capital_allocated) : "",
      bottleneck_audit: existing?.bottleneck_audit ?? "",
    },
  });

  const onSubmit = handleSubmit(async (v) => {
    await data.saveWeeklyLog({
      week_start: weekStart,
      capital_allocated: parseFloat(v.capital_allocated),
      bottleneck_audit: v.bottleneck_audit.trim() === "" ? null : v.bottleneck_audit.trim(),
    });
    await refresh();
    onSaved();
  });

  return (
    <main className="mx-auto flex h-dvh max-w-[390px] flex-col gap-4 overflow-hidden px-5 pb-5 pt-6">
      <header>
        <p className="label">Week of {weekStart}</p>
        <h1 className="text-2xl font-extrabold tracking-tight">Weekly review</h1>
      </header>

      {/* 1 — Read-only anchors: the week as it actually happened */}
      <AnchorGrid summary={summary} unit={unit} />

      <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col gap-4">
        {/* 2 — Capital allocated: large decimal keypad */}
        <div className="flex flex-col gap-2">
          <span className="label text-center">
            Capital allocated ({currency})
            {errors.capital_allocated && <span className="text-negative"> — required</span>}
          </span>
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            className="h-16 w-full rounded-[14px] border border-card-border bg-card text-center text-4xl font-extrabold outline-none placeholder:text-white/20 focus:border-accent"
            {...register("capital_allocated", {
              required: true,
              validate: (v) => Number.isFinite(parseFloat(v)) && parseFloat(v) >= 0,
            })}
          />
        </div>

        {/* 3 — Bottleneck audit: fills remaining space, screen never scrolls */}
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <span className="label text-center">Bottleneck audit · optional</span>
          <textarea
            maxLength={1000}
            placeholder="What was your primary point of friction this week?"
            className="min-h-0 w-full flex-1 resize-none rounded-[8px] border border-card-border bg-card p-3 text-sm outline-none placeholder:text-white/20 focus:border-accent"
            {...register("bottleneck_audit")}
          />
        </div>

        {/* 4 — Massive submit pinned to the bottom */}
        <button
          type="submit"
          disabled={isSubmitting}
          className="h-16 shrink-0 rounded-[14px] bg-white text-lg font-bold text-black active:bg-white/80 disabled:opacity-50"
        >
          Complete weekly review
        </button>
      </form>
    </main>
  );
}
