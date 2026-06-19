import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApp, qk } from "@/context/AppContext";
import { SkeletonBlock } from "@/components/Skeleton";
import { generateWeeklySynthesis } from "@/lib/apiClient";
import { weekStartISO, parseISODate, addDays } from "@/lib/dates";
import type { ApiError } from "@/lib/http";
import type { AISynthesis } from "@/types/domain";

/**
 * AI Synthesis (build step 10 → 12) — the first and only Blue (--color-ai
 * #3266AD) surface in the app. Blue is used strictly as an ACCENT (eyebrow,
 * badge, card stripe, insight markers, action buttons, and the "insight
 * available" highlight in the period picker) to mark AI-derived surfaces; the
 * data itself (the optimization score number) stays standard white.
 *
 * The historical archive is driven by a single "Current / Historical Period"
 * bar at the top that opens a custom calendar popover. Picking a week sets
 * `activeWeekStart`, which is the query key for the displayed synthesis — so the
 * card swaps (with a loading state) to whichever week is selected. Past weeks
 * render read-only (no Regenerate / generate controls).
 *
 * Insights are the server-parsed `string[]`, rendered as PLAIN TEXT — never
 * dangerouslySetInnerHTML. The deterministic optimization_score is computed
 * server-side; this screen only renders it.
 */

const BULLET = /^\s*[•–—\-*]\s+/;

// How many weeks back the calendar offers by default. Any older week that
// already has a synthesis is unioned in on top of this, so insights are never
// hidden just because they fall outside the window.
const WEEKS_BACK = 12;

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

function weekRangeLabel(weekStart: string, withYear = false): string {
  const start = parseISODate(weekStart);
  const end = parseISODate(addDays(weekStart, 6));
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const base = `${fmt(start)} – ${fmt(end)}`;
  return withYear ? `${base}, ${end.getFullYear()}` : base;
}

/** Month bucket for a week, keyed off its Monday — e.g. "June 2026". */
function monthLabel(weekStart: string): string {
  return parseISODate(weekStart).toLocaleDateString(undefined, { month: "long", year: "numeric" });
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

/** Newest-first list of selectable week-start Mondays: the trailing `WEEKS_BACK`
 *  weeks from the current one, unioned with every week that already has a
 *  synthesis (so older insights remain reachable). */
function buildWeekOptions(currentWeek: string, synthesized: Set<string>): string[] {
  const set = new Set<string>();
  for (let i = 0; i < WEEKS_BACK; i++) set.add(addDays(currentWeek, -7 * i));
  synthesized.forEach((w) => set.add(w));
  return [...set].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

/** Collapse the flat week list into month-headed groups, preserving order. */
function groupByMonth(weeks: string[]): { month: string; weeks: string[] }[] {
  const groups: { month: string; weeks: string[] }[] = [];
  for (const w of weeks) {
    const m = monthLabel(w);
    const last = groups[groups.length - 1];
    if (last && last.month === m) last.weeks.push(w);
    else groups.push({ month: m, weeks: [w] });
  }
  return groups;
}

export default function AISynthesis() {
  const { data } = useApp();
  const queryClient = useQueryClient();
  const weekStart = useMemo(() => weekStartISO(), []);

  // Which week is on display, and whether the period picker is open.
  const [activeWeekStart, setActiveWeekStart] = useState(weekStart);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const isCurrentWeek = activeWeekStart === weekStart;

  // Wrapper ref drives outside-click + Escape dismissal of the popover.
  const periodRef = useRef<HTMLDivElement>(null);

  // The displayed synthesis is fetched per the SELECTED week — picking a week
  // swaps the query key and the card swaps once resolved (skeleton meanwhile).
  const activeQ = useQuery({
    queryKey: qk.synthesisForWeek(activeWeekStart),
    queryFn: () => data.getSynthesisForWeek(activeWeekStart),
  });
  const historyQ = useQuery({
    queryKey: qk.syntheses,
    queryFn: () => data.listSyntheses({ limit: 26 }),
  });

  // Generation only ever targets the current week — past weeks are archival.
  const generate = useMutation({
    mutationFn: (force: boolean) => generateWeeklySynthesis(weekStart, force),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.synthesisForWeek(weekStart) }),
        queryClient.invalidateQueries({ queryKey: qk.syntheses }),
      ]);
    },
  });

  const active = activeQ.data ?? null;
  const synthesizedWeeks = useMemo(
    () => new Set((historyQ.data ?? []).map((s) => s.week_start)),
    [historyQ.data],
  );
  const weekGroups = useMemo(
    () => groupByMonth(buildWeekOptions(weekStart, synthesizedWeeks)),
    [weekStart, synthesizedWeeks],
  );

  // Close the popover on any click outside the wrapper, or on Escape.
  useEffect(() => {
    if (!isDropdownOpen) return;
    function onPointerDown(e: MouseEvent) {
      if (periodRef.current && !periodRef.current.contains(e.target as Node)) {
        setIsDropdownOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setIsDropdownOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [isDropdownOpen]);

  function selectWeek(w: string) {
    setActiveWeekStart(w);
    setIsDropdownOpen(false);
  }

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

      {/* ── Active period bar + calendar popover ─────────────────────────── */}
      <div ref={periodRef} className="relative">
        <button
          type="button"
          onClick={() => setIsDropdownOpen((o) => !o)}
          aria-expanded={isDropdownOpen}
          aria-haspopup="listbox"
          className={`flex w-full items-center justify-between rounded-[14px] border bg-card px-4 py-3 text-left transition-colors ${
            isCurrentWeek ? "border-card-border" : "border-ai"
          }`}
        >
          <div>
            <p className={`label ${isCurrentWeek ? "text-white/45" : "text-ai"}`}>
              {isCurrentWeek ? "Current Period" : "Historical Period"}
            </p>
            <p className="mt-0.5 text-sm font-semibold text-white">
              {weekRangeLabel(activeWeekStart, true)}
            </p>
          </div>
          <Chevron open={isDropdownOpen} />
        </button>

        {isDropdownOpen && (
          <div
            role="listbox"
            aria-label="Select a week"
            className="absolute left-0 right-0 top-full z-20 mt-2 max-h-80 overflow-y-auto rounded-[14px] border border-card-border bg-card p-2 shadow-xl shadow-black/50"
          >
            {weekGroups.map((group) => (
              <div key={group.month} className="mb-2 last:mb-0">
                <p className="label px-2 py-1 text-white/35">{group.month}</p>
                <div className="flex flex-col gap-1">
                  {group.weeks.map((w) => (
                    <WeekOption
                      key={w}
                      weekStart={w}
                      hasInsight={synthesizedWeeks.has(w)}
                      active={w === activeWeekStart}
                      isCurrent={w === weekStart}
                      onSelect={() => selectWeek(w)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Pinned snap-back to the live week whenever a past week is in view. */}
      {!isCurrentWeek && (
        <button
          type="button"
          onClick={() => setActiveWeekStart(weekStart)}
          className="-mt-1 self-start text-xs font-semibold text-ai"
        >
          ← Back to current week
        </button>
      )}

      {activeQ.isError ? (
        <ErrorCard />
      ) : activeQ.isLoading ? (
        <SkeletonBlock className="h-56 w-full" />
      ) : active ? (
        <SynthesisCard
          synthesis={active}
          weekLabel={weekRangeLabel(activeWeekStart)}
          readOnly={!isCurrentWeek}
          onRegenerate={() => generate.mutate(true)}
          busy={generate.isPending}
        />
      ) : isCurrentWeek ? (
        <GenerateCard
          weekLabel={weekRangeLabel(weekStart)}
          onGenerate={() => generate.mutate(false)}
          busy={generate.isPending}
        />
      ) : (
        <ArchivedEmptyCard weekLabel={weekRangeLabel(activeWeekStart)} />
      )}

      {/* Generation errors are only reachable from the current-week controls. */}
      {isCurrentWeek && generate.isError && (
        <p className="text-sm text-negative">{generateErrorMessage(generate.error)}</p>
      )}
    </main>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`shrink-0 text-white/50 transition-transform ${open ? "rotate-180" : ""}`}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function WeekOption({
  weekStart,
  hasInsight,
  active,
  isCurrent,
  onSelect,
}: {
  weekStart: string;
  hasInsight: boolean;
  active: boolean;
  isCurrent: boolean;
  onSelect: () => void;
}) {
  // Active: solid AI ring anchors focus. Has-insight: subtle AI wash + dot.
  // Empty: muted neutral — selectable but visibly without content.
  const tone = active
    ? "border-ai bg-ai/10 ring-1 ring-ai"
    : hasInsight
      ? "border-ai/40 bg-ai/5 hover:bg-ai/10"
      : "border-card-border bg-bg/40 hover:bg-card";
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onClick={onSelect}
      className={`flex items-center justify-between rounded-[10px] border px-3 py-2.5 text-left transition-colors ${tone}`}
    >
      <span className="flex items-center gap-2">
        <span
          aria-hidden
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${hasInsight ? "bg-ai" : "bg-transparent"}`}
        />
        <span className={`text-sm font-medium ${hasInsight || active ? "text-white" : "text-white/70"}`}>
          {weekRangeLabel(weekStart)}
        </span>
      </span>
      <span className="flex items-center gap-2">
        {isCurrent && <span className="label text-white/35">Now</span>}
        {hasInsight ? (
          <span className="text-[11px] font-semibold text-ai">Insight</span>
        ) : (
          <span className="text-[11px] text-white/30">Empty</span>
        )}
      </span>
    </button>
  );
}

function SynthesisCard({
  synthesis,
  weekLabel,
  readOnly,
  onRegenerate,
  busy,
}: {
  synthesis: AISynthesis;
  weekLabel: string;
  readOnly: boolean;
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

      {/* Read-only (historical) mode strictly hides every edit/input control. */}
      {readOnly ? (
        <p className="self-start text-xs font-medium uppercase tracking-wider text-white/40">
          Archived · read-only
        </p>
      ) : (
        <button
          type="button"
          onClick={onRegenerate}
          disabled={busy}
          className="self-start rounded-[30px] border border-ai px-4 py-1.5 text-xs font-semibold text-ai disabled:opacity-50"
        >
          {busy ? "Regenerating…" : "Regenerate"}
        </button>
      )}
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

/** A historical week that has no stored synthesis. Past weeks are archival, so
 *  there is no generate affordance here — read-only by construction. */
function ArchivedEmptyCard({ weekLabel }: { weekLabel: string }) {
  return (
    <section className="flex flex-col gap-2 rounded-[14px] border border-card-border border-l-[3px] border-l-ai bg-card p-5">
      <p className="label">{weekLabel}</p>
      <p className="text-sm leading-relaxed text-white/55">
        No synthesis was generated for this week.
      </p>
    </section>
  );
}

function ErrorCard() {
  return (
    <div className="rounded-[14px] border border-card-border bg-card px-5 py-10 text-center text-sm text-white/60">
      Couldn't reach your syntheses.
    </div>
  );
}
