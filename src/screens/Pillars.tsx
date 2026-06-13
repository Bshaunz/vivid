import { useState } from "react";
import { useApp } from "@/context/AppContext";
import { useDashboard, type DashboardData } from "@/hooks/useDashboard";
import { SparkLine, type Point } from "@/components/TrendChart";
import { SkeletonBlock } from "@/components/Skeleton";
import type { PillarScoreOut } from "@/lib/apiClient";
import type { Pillar } from "@/types/domain";

/**
 * Pillars (build step 11). One section per active pillar: score + sparkline,
 * the renormalized block decomposition (the §6 sub-scores, with dropped blocks
 * shown honestly as "not logged"), the latest key metrics, and assigned habits
 * + goal badges. All from the single dashboard payload.
 */

const PILLAR_META: { key: Pillar; label: string }[] = [
  { key: "Health", label: "Health" },
  { key: "Fitness", label: "Fitness" },
  { key: "Finances", label: "Finance" },
];

const BLOCK_LABELS: Record<string, string> = {
  readiness: "Morning readiness",
  bw_trend: "Bodyweight trend",
  nutrition: "Nutrition",
  training: "Training",
  deep_work: "Deep work",
  rpe: "Workout RPE",
  allocation: "Capital allocation",
  spend: "Discretionary spend",
};

const DURATIONS = [
  { label: "2W", days: 14 },
  { label: "1M", days: 30 },
  { label: "6M", days: 180 },
];

function pctText(v: number | null | undefined): string {
  return v == null ? "--" : `${Math.round(v * 100)}`;
}

export default function Pillars() {
  const [rangeDays, setRangeDays] = useState(30);
  const { profile } = useApp();
  const { data, isLoading, isError } = useDashboard(rangeDays);

  const active = profile?.active_pillars ?? PILLAR_META.map((p) => p.key);
  const sections = PILLAR_META.filter((p) => active.includes(p.key));

  return (
    <main className="mx-auto flex min-h-full max-w-[390px] flex-col gap-5 px-5 pb-8 pt-6">
      <header className="flex items-center justify-between">
        <div>
          <p className="label">Breakdown</p>
          <h1 className="text-2xl font-extrabold tracking-tight">Pillars</h1>
        </div>
        <div className="flex gap-1.5">
          {DURATIONS.map((d) => (
            <button
              key={d.days}
              type="button"
              onClick={() => setRangeDays(d.days)}
              className={`h-8 rounded-[30px] border px-3 text-xs font-semibold ${
                rangeDays === d.days
                  ? "border-accent bg-accent text-white"
                  : "border-card-border bg-card text-white/50"
              }`}
            >
              {d.label}
            </button>
          ))}
        </div>
      </header>

      {isError ? (
        <div className="rounded-[14px] border border-card-border bg-card px-5 py-10 text-center text-sm text-white/60">
          Couldn't reach your data.
        </div>
      ) : isLoading || !data ? (
        <>
          <SkeletonBlock className="h-48 w-full" />
          <SkeletonBlock className="h-48 w-full" />
        </>
      ) : (
        sections.map((p) => <PillarCard key={p.key} pillarKey={p.key} label={p.label} data={data} />)
      )}
    </main>
  );
}

function PillarCard({ pillarKey, label, data }: { pillarKey: Pillar; label: string; data: DashboardData }) {
  const { habits, goals } = useApp();
  const ps: PillarScoreOut | undefined = data.today_scores.pillars[pillarKey];

  const spark: Point[] = data.score_series.map((s) => ({
    label: s.date,
    value: pillarKey === "Health" ? s.health : pillarKey === "Fitness" ? s.fitness : s.finance,
  }));

  const pillarHabits = habits.filter((h) => h.pillar === pillarKey);
  const pillarGoals = goals.filter((g) => g.pillar === pillarKey);

  return (
    <section className="flex flex-col gap-4 rounded-[14px] border border-card-border bg-card p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="label">{label}</p>
          <p className="text-4xl font-extrabold tabular-nums">{pctText(ps?.score)}</p>
        </div>
        <div className="h-11 w-28">
          <SparkLine data={spark} />
        </div>
      </div>

      {/* Block decomposition — the §6 constituent sub-scores */}
      <div className="flex flex-col gap-2">
        {ps ? (
          Object.entries(ps.blocks).map(([name, value]) => (
            <BlockRow key={name} label={BLOCK_LABELS[name] ?? name} value={value} />
          ))
        ) : (
          <p className="label">Not scored yet today</p>
        )}
      </div>

      <KeyMetrics pillarKey={pillarKey} data={data} />

      {pillarHabits.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {pillarHabits.map((h) => (
            <span key={h.id} className="rounded-[30px] border border-card-border px-3 py-1 text-xs font-semibold text-white/70">
              {h.name}
            </span>
          ))}
        </div>
      )}

      {pillarGoals.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {pillarGoals.map((g) => (
            <span key={g.id} className="label rounded-[8px] border border-card-border px-2 py-1">
              {g.name}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function BlockRow({ label, value }: { label: string; value: number | null }) {
  const dropped = value == null;
  const width = dropped ? 0 : Math.round(value * 100);
  return (
    <div className="flex items-center gap-3">
      <span className="w-32 shrink-0 text-xs font-medium text-white/60">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-[30px] border border-card-border bg-bg">
        <div className="h-full rounded-[30px] bg-accent" style={{ width: `${width}%` }} />
      </div>
      <span className="w-16 shrink-0 text-right text-xs font-semibold tabular-nums text-white/70">
        {dropped ? "not logged" : `${width}`}
      </span>
    </div>
  );
}

function KeyMetrics({ pillarKey, data }: { pillarKey: Pillar; data: DashboardData }) {
  const latest = data.days.at(-1);
  let items: { label: string; value: string }[] = [];

  if (pillarKey === "Health") {
    items = [
      { label: "Readiness", value: latest?.morning_readiness != null ? `${latest.morning_readiness}/10` : "--" },
      { label: "Sleep", value: latest?.sleep_hours != null ? `${latest.sleep_hours}h` : "--" },
      { label: "Weight", value: data.latest_bodyweight != null ? `${data.latest_bodyweight}` : "--" },
    ];
  } else if (pillarKey === "Fitness") {
    items = [
      { label: "Trained", value: latest?.training_done == null ? "--" : latest.training_done ? "Yes" : "No" },
      { label: "Deep work", value: latest?.deep_work_hours != null ? `${latest.deep_work_hours}h` : "--" },
      { label: "RPE", value: latest?.workout_rpe != null ? `${latest.workout_rpe}/10` : "--" },
    ];
  } else {
    items = [
      { label: "Spend", value: latest?.discretionary_spend != null ? `${latest.discretionary_spend}` : "--" },
    ];
  }

  return (
    <div className="grid grid-cols-3 gap-2">
      {items.map((it) => (
        <div key={it.label} className="rounded-[8px] border border-card-border bg-bg p-2">
          <p className="label mb-0.5">{it.label}</p>
          <p className="text-base font-bold tabular-nums">{it.value}</p>
        </div>
      ))}
    </div>
  );
}
