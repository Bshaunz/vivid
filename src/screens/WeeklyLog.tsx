import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useApp } from "@/context/AppContext";
import { isSunday, parseISODate, todayISO, weekStartISO } from "@/lib/dates";
import type { WeeklyLog as WeeklyLogRow, WeeklyRollup } from "@/types/domain";

/**
 * Weekly Log — Trajectory Review (Sunday, ~5 min).
 *
 * Sunday-only per spec; other days show the countdown. In dev builds,
 * ?preview=1 unlocks the form for testing (stripped from production).
 *
 * Structure: read-only anchors from the rollup first (avg_bodyweight_7d,
 * total_training_sessions — the user sees their actual week before writing
 * anything), then bodyweight goal (carried forward from last week), capital
 * allocated, and the bottleneck audit. Auto-calculated values are persisted
 * into the weekly_logs row at submit, exactly like the backend will.
 */

interface WeeklyFormValues {
  bodyweight_goal: string;
  capital_allocated: string;
  bottleneck_audit: string;
}

interface Seed {
  rollup: WeeklyRollup;
  existing: WeeklyLogRow | null;
  carriedGoal: number | null;
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
      const [rollup, existing, allWeeks] = await Promise.all([
        data.getWeeklyRollup(weekStart),
        data.getWeeklyLog(weekStart),
        data.listWeeklyLogs(),
      ]);
      if (cancelled) return;
      const prev = allWeeks.find((l) => l.week_start < weekStart);
      setSeed({ rollup, existing, carriedGoal: prev?.bodyweight_goal ?? null });
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, data, weekStart]);

  if (!isSunday(today) && !devPreview) {
    return <WeeklyLocked today={today} />;
  }

  if (!ready || !seed) return null;

  if (seed.existing && !editing) {
    return <WeeklyComplete log={seed.existing} onEdit={() => setEditing(true)} />;
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

// ── Completed state ──────────────────────────────────────────────────────────

function WeeklyComplete({ log, onEdit }: { log: WeeklyLogRow; onEdit: () => void }) {
  const { profile } = useApp();
  const currency = profile?.currency ?? "CAD";
  const unit = profile?.unit_pref ?? "lbs";

  return (
    <main className="mx-auto flex h-dvh max-w-[390px] flex-col gap-4 px-5 pb-5 pt-6">
      <header>
        <p className="label">Week of {log.week_start}</p>
        <h1 className="text-2xl font-extrabold tracking-tight">Week reviewed</h1>
      </header>

      <section className="grid grid-cols-3 gap-3">
        <SummaryCard label={`Avg BW (${unit})`} value={log.avg_bodyweight_7d ?? "--"} />
        <SummaryCard label="Sessions" value={log.total_training_sessions ?? "--"} />
        <SummaryCard label={`Capital (${currency})`} value={log.capital_allocated ?? "--"} />
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

function SummaryCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-[14px] border border-card-border bg-card p-3">
      <p className="label mb-1">{label}</p>
      <p className="text-xl font-bold">{value}</p>
    </div>
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
  const { rollup, existing, carriedGoal } = seed;

  const goalSeed = existing?.bodyweight_goal ?? carriedGoal;
  const bwDelta =
    rollup.avg_bodyweight_7d !== null && goalSeed !== null
      ? Math.round((rollup.avg_bodyweight_7d - goalSeed) * 10) / 10
      : null;

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<WeeklyFormValues>({
    defaultValues: {
      bodyweight_goal: goalSeed !== null ? String(goalSeed) : "",
      capital_allocated: existing?.capital_allocated != null ? String(existing.capital_allocated) : "",
      bottleneck_audit: existing?.bottleneck_audit ?? "",
    },
  });

  const onSubmit = handleSubmit(async (v) => {
    await data.saveWeeklyLog({
      week_start: weekStart,
      // auto-calculated values persisted at review time, matching v_weekly_rollup
      avg_bodyweight_7d: rollup.avg_bodyweight_7d,
      total_training_sessions: rollup.total_training_sessions,
      bodyweight_goal: v.bodyweight_goal === "" ? null : parseFloat(v.bodyweight_goal),
      capital_allocated: parseFloat(v.capital_allocated),
      bottleneck_audit: v.bottleneck_audit.trim(),
      posts_published: existing?.posts_published ?? null,
      followers: existing?.followers ?? null,
      waitlist_signups: existing?.waitlist_signups ?? null,
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
      <section className="grid grid-cols-2 gap-3">
        <div className="rounded-[14px] border border-card-border bg-card p-4">
          <p className="label mb-1">Avg bodyweight ({unit})</p>
          <p className="text-3xl font-extrabold">{rollup.avg_bodyweight_7d ?? "--"}</p>
          {bwDelta !== null && (
            <p className="mt-1 text-xs text-white/50">
              {bwDelta > 0 ? "+" : ""}
              {bwDelta} vs goal
            </p>
          )}
        </div>
        <div className="rounded-[14px] border border-card-border bg-card p-4">
          <p className="label mb-1">Training sessions</p>
          <p className="text-3xl font-extrabold">{rollup.total_training_sessions}</p>
          <p className="mt-1 text-xs text-white/50">
            {rollup.evening_logs_completed}/7 evenings logged
          </p>
        </div>
      </section>

      <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col gap-4">
        {/* 2 — Bodyweight goal, carried forward from last week */}
        <div className="flex items-center justify-between gap-3 rounded-[14px] border border-card-border bg-card py-2 pl-4 pr-2">
          <span className="text-sm font-semibold">Bodyweight goal ({unit})</span>
          <input
            type="text"
            inputMode="decimal"
            placeholder="--"
            className="h-11 w-24 rounded-[8px] border border-card-border bg-transparent text-center text-lg font-bold outline-none placeholder:text-white/20 focus:border-white/40"
            {...register("bodyweight_goal", {
              validate: (v) => v === "" || (Number.isFinite(parseFloat(v)) && parseFloat(v) > 0),
            })}
          />
        </div>

        {/* 3 — Capital allocated: large decimal keypad */}
        <div className="flex flex-col gap-2">
          <span className="label text-center">
            Capital allocated ({currency})
            {errors.capital_allocated && <span className="text-white"> — required</span>}
          </span>
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            className="h-16 w-full rounded-[14px] border border-card-border bg-card text-center text-4xl font-extrabold outline-none placeholder:text-white/20 focus:border-white/40"
            {...register("capital_allocated", {
              required: true,
              validate: (v) => Number.isFinite(parseFloat(v)) && parseFloat(v) >= 0,
            })}
          />
        </div>

        {/* 4 — Bottleneck audit: fills remaining space, screen never scrolls */}
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <span className="label text-center">
            Bottleneck audit
            {errors.bottleneck_audit && <span className="text-white"> — required</span>}
          </span>
          <textarea
            placeholder="What was your primary point of friction this week?"
            className="min-h-0 w-full flex-1 resize-none rounded-[8px] border border-card-border bg-card p-3 text-sm outline-none placeholder:text-white/20 focus:border-white/40"
            {...register("bottleneck_audit", {
              required: true,
              validate: (v) => v.trim().length > 0,
            })}
          />
        </div>

        {/* 5 — Massive submit pinned to the bottom */}
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
