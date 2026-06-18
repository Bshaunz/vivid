import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApp, qk } from "@/context/AppContext";
import { SkeletonBlock } from "@/components/Skeleton";
import { generateWeeklySynthesis } from "@/lib/apiClient";
import { weekStartISO, parseISODate, addDays } from "@/lib/dates";
import type { ApiError } from "@/lib/http";
import type { AISynthesis } from "@/types/domain";

/**
 * AI Synthesis (build step 10) — the first and only Blue (--color-ai #3266AD)
 * surface in the app. Blue is used strictly as an ACCENT here (eyebrow, badge,
 * card stripe, insight markers, action buttons) to mark this as AI-derived; the
 * data itself (the optimization score number) stays in the app's standard white,
 * and green/red remain reserved for deltas elsewhere.
 *
 * Insights are the server-parsed `string[]` and are rendered as PLAIN TEXT —
 * never dangerouslySetInnerHTML (§ synthesis output is display-only plain text).
 * The deterministic optimization_score is computed server-side; this screen only
 * renders it. Reads go through DataLayer; generation is the server-only POST.
 */

const BULLET = /^\s*[•–—\-*]\s+/;

/** The non-bullet prose of the synthesis (the deterministic summary today; a
 *  richer narrative once the real LLM lands). The bulleted lines are surfaced
 *  separately as the structured `insights`, so we strip them here to avoid
 *  showing each insight twice. */
function prose(content: string): string {
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !BULLET.test(l))
    .join("\n");
}

function weekRangeLabel(weekStart: string): string {
  const start = parseISODate(weekStart);
  const end = parseISODate(addDays(weekStart, 6));
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${fmt(start)} – ${fmt(end)}`;
}

function countLabel(n: number): string {
  return `${n} insight${n === 1 ? "" : "s"}`;
}

function generateErrorMessage(err: unknown): string {
  const status = (err as ApiError | null)?.status;
  if (status === 404) return "No logged days this week yet — log a day or two, then synthesize.";
  if (status === 429) return "Daily AI limit reached. Try again tomorrow.";
  return "Couldn't generate the synthesis. Please try again.";
}

export default function AISynthesis() {
  const { data } = useApp();
  const queryClient = useQueryClient();
  const weekStart = useMemo(() => weekStartISO(), []);

  const currentQ = useQuery({
    queryKey: qk.synthesisForWeek(weekStart),
    queryFn: () => data.getSynthesisForWeek(weekStart),
  });
  const historyQ = useQuery({
    queryKey: qk.syntheses,
    queryFn: () => data.listSyntheses({ limit: 8 }),
  });

  const generate = useMutation({
    mutationFn: (force: boolean) => generateWeeklySynthesis(weekStart, force),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.synthesisForWeek(weekStart) }),
        queryClient.invalidateQueries({ queryKey: qk.syntheses }),
      ]);
    },
  });

  const current = currentQ.data ?? null;
  const history = (historyQ.data ?? []).filter((s) => s.week_start !== weekStart);

  return (
    <main className="mx-auto flex min-h-full max-w-[390px] flex-col gap-5 px-5 pb-8 pt-6">
      <header className="flex items-center justify-between">
        <div>
          <p className="label text-ai">Cross-pillar</p>
          <h1 className="text-2xl font-extrabold tracking-tight">AI Synthesis</h1>
        </div>
        <span className="rounded-[30px] border border-ai px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-ai">
          AI
        </span>
      </header>

      {currentQ.isError ? (
        <ErrorCard />
      ) : currentQ.isLoading ? (
        <SkeletonBlock className="h-56 w-full" />
      ) : current ? (
        <SynthesisCard
          synthesis={current}
          weekLabel={weekRangeLabel(weekStart)}
          onRegenerate={() => generate.mutate(true)}
          busy={generate.isPending}
        />
      ) : (
        <GenerateCard
          weekLabel={weekRangeLabel(weekStart)}
          onGenerate={() => generate.mutate(false)}
          busy={generate.isPending}
        />
      )}

      {generate.isError && (
        <p className="text-sm text-negative">{generateErrorMessage(generate.error)}</p>
      )}

      {history.length > 0 && (
        <section className="flex flex-col gap-2">
          <p className="label">Earlier weeks</p>
          {history.map((s) => (
            <HistoryRow key={s.id} synthesis={s} />
          ))}
        </section>
      )}
    </main>
  );
}

function SynthesisCard({
  synthesis,
  weekLabel,
  onRegenerate,
  busy,
}: {
  synthesis: AISynthesis;
  weekLabel: string;
  onRegenerate: () => void;
  busy: boolean;
}) {
  const summary = prose(synthesis.content);
  return (
    <section className="flex flex-col gap-4 rounded-[14px] border border-card-border border-l-[3px] border-l-ai bg-card p-4">
      <div className="flex items-start justify-between">
        <div>
          <p className="label">{weekLabel}</p>
          <p className="mt-1 text-xs text-white/45">
            {countLabel(synthesis.insights.length)} · {synthesis.model}
          </p>
        </div>
        <div className="text-right">
          <p className="label text-ai">Optimization</p>
          <p className="text-4xl font-extrabold tabular-nums text-white">
            {synthesis.optimization_score}
          </p>
        </div>
      </div>

      {summary && (
        <p className="whitespace-pre-line text-sm leading-relaxed text-white/80">{summary}</p>
      )}

      <ul className="flex flex-col gap-2.5">
        {synthesis.insights.map((insight, i) => (
          <li key={i} className="flex gap-2.5">
            <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-ai" />
            <span className="text-sm leading-relaxed text-white/85">{insight}</span>
          </li>
        ))}
        {synthesis.insights.length === 0 && (
          <li className="text-sm text-white/45">
            No cross-pillar correlations had enough data this week.
          </li>
        )}
      </ul>

      <button
        type="button"
        onClick={onRegenerate}
        disabled={busy}
        className="self-start rounded-[30px] border border-ai px-4 py-1.5 text-xs font-semibold text-ai disabled:opacity-50"
      >
        {busy ? "Regenerating…" : "Regenerate"}
      </button>
    </section>
  );
}

function GenerateCard({
  weekLabel,
  onGenerate,
  busy,
}: {
  weekLabel: string;
  onGenerate: () => void;
  busy: boolean;
}) {
  return (
    <section className="flex flex-col items-start gap-3 rounded-[14px] border border-card-border border-l-[3px] border-l-ai bg-card p-5">
      <p className="label">{weekLabel}</p>
      <p className="text-sm leading-relaxed text-white/70">
        No synthesis yet for this week. Generate a plain-language read of how your Health, Fitness
        and Finance moved together — built only from the days you've logged.
      </p>
      <button
        type="button"
        onClick={onGenerate}
        disabled={busy}
        className="rounded-[30px] border border-ai bg-ai px-5 py-2 text-sm font-semibold text-white disabled:opacity-50"
      >
        {busy ? "Synthesizing…" : "Generate this week's synthesis"}
      </button>
    </section>
  );
}

function HistoryRow({ synthesis }: { synthesis: AISynthesis }) {
  return (
    <div className="flex items-center justify-between rounded-[10px] border border-card-border bg-card px-4 py-3">
      <div>
        <p className="text-sm font-semibold">{weekRangeLabel(synthesis.week_start)}</p>
        <p className="text-xs text-white/45">{countLabel(synthesis.insights.length)}</p>
      </div>
      <div className="text-right">
        <p className="label text-ai">Opt</p>
        <p className="text-lg font-bold tabular-nums text-white">{synthesis.optimization_score}</p>
      </div>
    </div>
  );
}

function ErrorCard() {
  return (
    <div className="rounded-[14px] border border-card-border bg-card px-5 py-10 text-center text-sm text-white/60">
      Couldn't reach your syntheses.
    </div>
  );
}
