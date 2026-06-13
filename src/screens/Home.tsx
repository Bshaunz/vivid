import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useApp } from "@/context/AppContext";
import { useDashboard, type DashboardData } from "@/hooks/useDashboard";
import { TrendChart, type Point } from "@/components/TrendChart";
import { SkeletonBlock } from "@/components/Skeleton";

/**
 * Home (build step 9). Renders entirely from the single GET /api/dashboard
 * payload: the Day Score hero (with delta + personal best from score_series),
 * the three pillar bars, a high-contrast trend chart over the v_daily_analysis
 * rows, and the active habit pills. AI synthesis block is intentionally absent
 * until step 10 (no blue yet).
 */

const PILLARS: { key: "Health" | "Fitness" | "Finances"; label: string }[] = [
  { key: "Health", label: "Health" },
  { key: "Fitness", label: "Fitness" },
  { key: "Finances", label: "Finance" },
];

const DURATIONS: { label: string; days: number }[] = [
  { label: "1W", days: 7 },
  { label: "2W", days: 14 },
  { label: "1M", days: 30 },
  { label: "6M", days: 180 },
  { label: "1Y", days: 365 },
];

type MetricKey = "day_score" | "readiness" | "sleep" | "deep_work" | "spend" | "bodyweight";

const METRICS: { key: MetricKey; label: string; fmt: (v: number) => string }[] = [
  { key: "day_score", label: "Day Score", fmt: (v) => String(Math.round(v)) },
  { key: "readiness", label: "Readiness", fmt: (v) => v.toFixed(0) },
  { key: "sleep", label: "Sleep", fmt: (v) => `${v.toFixed(1)}h` },
  { key: "deep_work", label: "Deep Work", fmt: (v) => `${v.toFixed(1)}h` },
  { key: "spend", label: "Spend", fmt: (v) => v.toFixed(0) },
  { key: "bodyweight", label: "Weight", fmt: (v) => v.toFixed(1) },
];

function shortDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${Number(m)}/${Number(d)}`;
}

function pct(v: number | null | undefined): string {
  return v == null ? "--" : String(Math.round(v * 100));
}

export default function Home() {
  const [rangeDays, setRangeDays] = useState(30);
  const [metric, setMetric] = useState<MetricKey>("day_score");
  const { habits } = useApp();
  const { data, isLoading, isError } = useDashboard(rangeDays);

  return (
    <main className="mx-auto flex min-h-full max-w-[390px] flex-col gap-6 px-5 pb-8 pt-6">
      <header className="flex items-start justify-between">
        <div>
          <p className="label">{new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}</p>
          <h1 className="text-2xl font-extrabold tracking-tight">VIVID</h1>
        </div>
        <Link
          to="/settings"
          aria-label="Settings"
          className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card text-white/60"
        >
          <GearIcon />
        </Link>
      </header>

      {isError ? (
        <ErrorCard />
      ) : isLoading || !data ? (
        <HomeSkeleton />
      ) : (
        <>
          <DayScoreHero data={data} />
          <PillarBars data={data} />
          <TrendSection
            data={data}
            metric={metric}
            setMetric={setMetric}
            rangeDays={rangeDays}
            setRangeDays={setRangeDays}
          />
          {habits.length > 0 && <HabitRows />}
        </>
      )}
    </main>
  );
}

// ── Day Score hero ────────────────────────────────────────────────────────────

function DayScoreHero({ data }: { data: DashboardData }) {
  const score = data.today_scores.day_score;
  const series = data.score_series;
  const todayIso = data.to_date;

  // Most recent prior logged day (exclude today's own row if present).
  const prior = [...series].reverse().find((p) => p.date < todayIso);
  const delta = prior ? score - prior.day_score : null;
  const best = Math.max(score, ...series.map((p) => p.day_score), 0);
  const isBest = score > 0 && score >= best;

  return (
    <section className="flex flex-col items-center gap-1 rounded-[14px] border border-card-border bg-card py-7">
      <p className="label">Day Score</p>
      <p className="text-7xl font-extrabold leading-none tracking-tight tabular-nums">{score}</p>
      <div className="mt-1 flex items-center gap-3 text-sm font-semibold">
        {delta == null ? (
          <span className="text-white/40">—</span>
        ) : delta >= 0 ? (
          <span className="text-positive">▲ {delta} vs last</span>
        ) : (
          <span className="text-negative">▼ {Math.abs(delta)} vs last</span>
        )}
        {isBest && <span className="label">personal best</span>}
      </div>
    </section>
  );
}

// ── Pillar bars ───────────────────────────────────────────────────────────────

function PillarBars({ data }: { data: DashboardData }) {
  return (
    <section className="flex flex-col gap-3">
      {PILLARS.map(({ key, label }) => {
        const ps = data.today_scores.pillars[key];
        const value = ps?.score ?? null;
        const width = value == null ? 0 : Math.round(value * 100);
        return (
          <div key={key} className="flex items-center gap-3">
            <span className="w-16 shrink-0 text-sm font-semibold text-white/80">{label}</span>
            <div className="h-2.5 flex-1 overflow-hidden rounded-[30px] border border-card-border bg-bg">
              <div className="h-full rounded-[30px] bg-accent" style={{ width: `${width}%` }} />
            </div>
            <span className="w-8 shrink-0 text-right text-sm font-bold tabular-nums">{pct(value)}</span>
          </div>
        );
      })}
    </section>
  );
}

// ── Trend chart ─────────────────────────────────────────────────────────────

function buildSeries(data: DashboardData, metric: MetricKey): Point[] {
  if (metric === "day_score") {
    return data.score_series.map((p) => ({ label: shortDate(p.date), value: p.day_score }));
  }
  if (metric === "bodyweight") {
    return data.weekly_bodyweight.map((w) => ({
      label: shortDate(w.week_start),
      value: w.weekly_median_bodyweight,
    }));
  }
  const accessor: Record<Exclude<MetricKey, "day_score" | "bodyweight">, keyof DashboardData["days"][number]> = {
    readiness: "morning_readiness",
    sleep: "sleep_hours",
    deep_work: "deep_work_hours",
    spend: "discretionary_spend",
  };
  const field = accessor[metric as Exclude<MetricKey, "day_score" | "bodyweight">];
  return data.days.map((d) => ({ label: shortDate(d.date), value: (d[field] as number | null) ?? null }));
}

function TrendSection({
  data,
  metric,
  setMetric,
  rangeDays,
  setRangeDays,
}: {
  data: DashboardData;
  metric: MetricKey;
  setMetric: (m: MetricKey) => void;
  rangeDays: number;
  setRangeDays: (d: number) => void;
}) {
  const series = useMemo(() => buildSeries(data, metric), [data, metric]);
  const fmt = METRICS.find((m) => m.key === metric)!.fmt;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {METRICS.map((m) => (
          <Chip key={m.key} active={metric === m.key} onClick={() => setMetric(m.key)}>
            {m.label}
          </Chip>
        ))}
      </div>
      <div className="rounded-[14px] border border-card-border bg-card p-3">
        <TrendChart data={series} formatValue={fmt} />
      </div>
      <div className="flex gap-1.5">
        {DURATIONS.map((d) => (
          <Chip key={d.days} active={rangeDays === d.days} onClick={() => setRangeDays(d.days)}>
            {d.label}
          </Chip>
        ))}
      </div>
    </section>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-8 rounded-[30px] border px-3 text-xs font-semibold ${
        active ? "border-accent bg-accent text-white" : "border-card-border bg-card text-white/50"
      }`}
    >
      {children}
    </button>
  );
}

// ── Habit pills ───────────────────────────────────────────────────────────────

function HabitRows() {
  const { habits } = useApp();
  return (
    <section className="flex flex-col gap-2">
      <p className="label">Habits</p>
      <div className="flex flex-col gap-1.5">
        {habits.map((h) => (
          <div
            key={h.id}
            className="flex items-center justify-between rounded-[30px] border border-card-border bg-card px-4 py-2.5"
          >
            <span className="text-sm font-semibold text-white/80">{h.name}</span>
            {h.pillar && <span className="label">{h.pillar}</span>}
          </div>
        ))}
      </div>
    </section>
  );
}

// ── States + chrome ─────────────────────────────────────────────────────────

function HomeSkeleton() {
  return (
    <>
      <SkeletonBlock className="h-40 w-full" />
      <div className="flex flex-col gap-3">
        {[0, 1, 2].map((i) => (
          <SkeletonBlock key={i} className="h-6 w-full rounded-[30px]" />
        ))}
      </div>
      <SkeletonBlock className="h-56 w-full" />
    </>
  );
}

function ErrorCard() {
  return (
    <div className="flex flex-col items-center gap-2 rounded-[14px] border border-card-border bg-card px-5 py-10 text-center">
      <p className="text-sm font-semibold text-white/80">Couldn't reach your data</p>
      <p className="label">check your connection and pull to retry</p>
    </div>
  );
}

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
