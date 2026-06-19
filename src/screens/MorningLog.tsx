import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { useApp } from "@/context/AppContext";
import { useToast } from "@/components/Toast";
import { LogSkeleton } from "@/components/Skeleton";
import {
  PrimaryButton,
  Prompt,
  StepShell,
  SummaryCard,
  WizardHeader,
  scrollSelfIntoView,
} from "@/components/wizard";
import { addDays, todayISO } from "@/lib/dates";
import * as api from "@/lib/apiClient";
import type { DailyLog, UnitPreference } from "@/types/domain";

/**
 * Morning Log — "grill-style" interview wizard.
 *
 * One essential question per screen (bodyweight → sleep → readiness), ending on
 * an optional "Anything else?" catch-all (note + RHR/HRV menu). All answers live
 * in a single local `MorningDraft` until the final "Log Morning" tap fires one
 * scored write (POST /api/logs/morning); bodyweight rides along as a
 * bodyweight_entries row (§4), the note persists to daily_logs.morning_note.
 *
 * Flow rules:
 * - Buttons auto-advance on selection; numeric inputs advance on Enter or "Next".
 * - Each step is keyed so the `.step-in` fade/rise replays on mount.
 * - Steps own a scrollable content area + a pinned footer, so the on-screen
 *   keyboard never hides the focused input (it scrolls into view on focus).
 * - Everything past the two essentials is strictly optional (skip = null).
 */

interface MorningDraft {
  bodyweight: string; // optional → bodyweight_entries
  sleepH: string; // hours, "0".."16"
  sleepM: string; // minutes, "0".."59"
  readiness: number | null; // 1..10
  // ── strictly-optional "Anything else?" extras ──
  note: string;
  rhr: string;
  hrv: string;
}

interface Seed {
  lastBodyweight: number | null; // placeholder hint only, never prefilled
  sleepHours: number; // yesterday's sleep as the starting value, else 7.5
}

const READINESS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
const TOTAL_STEPS = 4;

const OPTIONAL_METRICS = [
  { key: "rhr", label: "Resting HR", unit: "bpm", placeholder: "55", min: 20, max: 250 },
  { key: "hrv", label: "HRV", unit: "ms", placeholder: "60", min: 0, max: 300 },
] as const;
type OptionalMetric = (typeof OPTIONAL_METRICS)[number];
type MetricKey = OptionalMetric["key"];

// ── Pure helpers ──────────────────────────────────────────────────────────────

function clampFloat(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Split decimal hours into whole hours + minutes (snapped to 5-min ticks). */
function splitHours(totalHours: number): { h: number; m: number } {
  const clamped = clampFloat(totalHours, 0, 16);
  let h = Math.floor(clamped);
  let m = Math.round(((clamped - h) * 60) / 5) * 5;
  if (m === 60) {
    h += 1;
    m = 0;
  }
  if (h >= 16) return { h: 16, m: 0 };
  return { h, m };
}

/** Recombine the two sleep fields into the stored float, clamped 0–16. */
function draftSleepHours(d: MorningDraft): number {
  const h = parseInt(d.sleepH, 10);
  const m = parseInt(d.sleepM, 10);
  const hours = (Number.isFinite(h) ? h : 0) + (Number.isFinite(m) ? m : 0) / 60;
  return Math.round(clampFloat(hours, 0, 16) * 100) / 100;
}

/** Decimal hours → "7h 45m" as a tile value: big numbers, with the h/m unit
 *  glyphs rendered small + muted to match the Weight tile's "lbs" treatment
 *  (and to keep the string inside the tile on narrow viewports). */
function sleepTileValue(hours: number | null): ReactNode {
  if (hours == null) return "--";
  const total = Math.round(hours * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  const U = ({ children }: { children: string }) => (
    <span className="text-xs font-semibold text-white/40">{children}</span>
  );
  return (
    <>
      {h}
      <U>h</U>
      {m > 0 && (
        <>
          {" "}
          {m}
          <U>m</U>
        </>
      )}
    </>
  );
}

/** Optional bodyweight: empty → null/no-error; out of the 30–660 backend range → error. */
function parseBodyweight(raw: string): { value: number | null; error: boolean } {
  const t = raw.trim();
  if (t === "") return { value: null, error: false };
  const n = parseFloat(t);
  if (!Number.isFinite(n) || n < 30 || n > 660) return { value: null, error: true };
  return { value: n, error: false };
}

function sanitizeInt(raw: string, lo: number, hi: number): string {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits === "") return "";
  return String(Math.max(lo, Math.min(hi, parseInt(digits, 10))));
}

function inIntRange(raw: string, lo: number, hi: number): boolean {
  const n = Number(raw);
  return Number.isInteger(n) && n >= lo && n <= hi;
}

function initDraft(existing: DailyLog | null, seed: Seed): MorningDraft {
  const fromExisting = existing?.morning_done ?? false;
  const baseSleep = fromExisting ? (existing?.sleep_hours ?? seed.sleepHours) : seed.sleepHours;
  const { h, m } = splitHours(baseSleep);
  return {
    bodyweight: "",
    sleepH: String(h),
    sleepM: String(m),
    readiness: fromExisting && existing?.morning_readiness != null ? existing.morning_readiness : null,
    note: fromExisting ? (existing?.morning_note ?? "") : "",
    rhr: fromExisting && existing?.rhr != null ? String(existing.rhr) : "",
    hrv: fromExisting && existing?.hrv != null ? String(existing.hrv) : "",
  };
}

// ── Entry point ───────────────────────────────────────────────────────────────

export default function MorningLog() {
  const { data, todayLog, ready } = useApp();
  const [seed, setSeed] = useState<Seed | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      const today = todayISO();
      try {
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
      } catch (err) {
        // Historical prefill is a convenience, not a gate: if the read fails
        // (backend down/mid-migration), fall back to defaults so the wizard
        // still renders and is enterable instead of hanging on the skeleton.
        if (cancelled) return;
        console.error("MorningLog: seed load failed — using defaults", err);
        setSeed({ lastBodyweight: null, sleepHours: 7.5 });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, data]);

  if (!ready || !seed) return <LogSkeleton title="Morning" />;

  if (todayLog?.morning_done && !editing) {
    return <MorningComplete log={todayLog} onEdit={() => setEditing(true)} />;
  }

  return <MorningWizard seed={seed} existing={todayLog} onSaved={() => setEditing(false)} />;
}

// ── Wizard ────────────────────────────────────────────────────────────────────

function MorningWizard({
  seed,
  existing,
  onSaved,
}: {
  seed: Seed;
  existing: DailyLog | null;
  onSaved: () => void;
}) {
  const { profile, refresh } = useApp();
  const { show } = useToast();
  const unit: UnitPreference = profile?.unit_pref ?? "lbs";
  // First name for the greeting; falls back to "Brody" when the profile has no
  // name. The `?.` chain short-circuits whole, so a null name never throws.
  const greetingName = profile?.name?.trim().split(/\s+/)[0] || "Brody";

  const [submitted, setSubmitted] = useState(false);
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<MorningDraft>(() => initDraft(existing, seed));

  // Readiness taps auto-advance after a beat so the selection is visible first.
  const advanceTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(advanceTimer.current), []);

  const goNext = () => setStep((s) => Math.min(TOTAL_STEPS - 1, s + 1));
  const goBack = () => {
    window.clearTimeout(advanceTimer.current);
    setStep((s) => Math.max(0, s - 1));
  };
  const selectReadiness = (n: number) => {
    setDraft((d) => ({ ...d, readiness: n }));
    window.clearTimeout(advanceTimer.current);
    advanceTimer.current = window.setTimeout(() => setStep(3), 220);
  };
  const continueFromReadiness = () => {
    window.clearTimeout(advanceTimer.current);
    setStep(3);
  };

  const mutation = useMutation({
    mutationFn: (payload: api.MorningPayload) => api.saveMorningLog(payload),
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

  const submit = () => {
    const readiness = draft.readiness;
    if (readiness == null) {
      setStep(2);
      return;
    }
    const bw = parseBodyweight(draft.bodyweight);
    if (bw.error) {
      setStep(0);
      show(`Enter a weight between 30 and 660 ${unit}.`);
      return;
    }
    if (draft.rhr !== "" && !inIntRange(draft.rhr, 20, 250)) {
      show("Resting HR must be between 20 and 250 bpm.");
      return;
    }
    if (draft.hrv !== "" && !inIntRange(draft.hrv, 0, 300)) {
      show("HRV must be between 0 and 300 ms.");
      return;
    }
    mutation.mutate({
      date: todayISO(),
      morning_readiness: readiness,
      sleep_hours: draftSleepHours(draft),
      morning_note: draft.note.trim() === "" ? null : draft.note.trim(),
      rhr: draft.rhr === "" ? null : Number(draft.rhr),
      hrv: draft.hrv === "" ? null : Number(draft.hrv),
      bodyweight: bw.value,
    });
  };

  if (submitted) return <SubmittedCard title="Morning logged" pending={mutation.isPending} />;

  return (
    <main className="mx-auto flex h-full max-w-[390px] flex-col gap-3 overflow-hidden px-5 pb-5 pt-6">
      <WizardHeader step={step} total={TOTAL_STEPS} onBack={goBack} />

      <section key={step} className="step-in flex min-h-0 flex-1 flex-col">
        {step === 0 && (
          <BodyweightStep
            draft={draft}
            setDraft={setDraft}
            unit={unit}
            lastBodyweight={seed.lastBodyweight}
            greetingName={greetingName}
            onNext={goNext}
          />
        )}
        {step === 1 && <SleepStep draft={draft} setDraft={setDraft} onNext={goNext} />}
        {step === 2 && (
          <ReadinessStep
            selected={draft.readiness}
            onSelect={selectReadiness}
            onContinue={continueFromReadiness}
          />
        )}
        {step === 3 && (
          <FinalStep draft={draft} setDraft={setDraft} pending={mutation.isPending} onSubmit={submit} />
        )}
      </section>
    </main>
  );
}

// ── Step 1 · Bodyweight ───────────────────────────────────────────────────────

function BodyweightStep({
  draft,
  setDraft,
  unit,
  lastBodyweight,
  greetingName,
  onNext,
}: {
  draft: MorningDraft;
  setDraft: (updater: (prev: MorningDraft) => MorningDraft) => void;
  unit: UnitPreference;
  lastBodyweight: number | null;
  greetingName: string;
  onNext: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const empty = draft.bodyweight.trim() === "";
  const { error } = parseBodyweight(draft.bodyweight);
  const canAdvance = empty || !error;
  const tryNext = () => {
    if (canAdvance) {
      inputRef.current?.blur();
      onNext();
    }
  };

  return (
    <StepShell
      footer={
        <PrimaryButton onClick={tryNext} disabled={!canAdvance}>
          {empty ? "Skip" : "Next"}
        </PrimaryButton>
      }
    >
      <div className="flex flex-col gap-2">
        <p className="label text-center">{todayISO()}</p>
        <Prompt>
          Good morning, {greetingName}.
          <br />
          What is your weight today?
        </Prompt>
      </div>

      <div className="flex items-end justify-center gap-3">
        <input
          ref={inputRef}
          type="text"
          inputMode="decimal"
          enterKeyHint="next"
          autoFocus
          value={draft.bodyweight}
          onChange={(e) => setDraft((d) => ({ ...d, bodyweight: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              tryNext();
            }
          }}
          onFocus={scrollSelfIntoView}
          placeholder={lastBodyweight !== null ? String(lastBodyweight) : "0.0"}
          aria-label={`Bodyweight in ${unit}`}
          className={`w-[220px] border-b-2 bg-transparent pb-2 text-center text-6xl font-extrabold tabular-nums outline-none placeholder:text-white/15 ${
            !empty && error ? "border-negative" : "border-card-border focus:border-accent"
          }`}
        />
        <span className="pb-3 text-2xl font-bold text-white/40">{unit}</span>
      </div>
    </StepShell>
  );
}

// ── Step 2 · Sleep ────────────────────────────────────────────────────────────

function SleepStep({
  draft,
  setDraft,
  onNext,
}: {
  draft: MorningDraft;
  setDraft: (updater: (prev: MorningDraft) => MorningDraft) => void;
  onNext: () => void;
}) {
  return (
    <StepShell footer={<PrimaryButton onClick={onNext}>Next</PrimaryButton>}>
      <Prompt>How much did you sleep?</Prompt>

      <div className="flex items-stretch justify-center gap-4">
        <SleepField
          label="Hours"
          value={draft.sleepH}
          autoFocus
          onChange={(v) => setDraft((d) => ({ ...d, sleepH: sanitizeInt(v, 0, 16) }))}
          onEnter={onNext}
        />
        <SleepField
          label="Minutes"
          value={draft.sleepM}
          onChange={(v) => setDraft((d) => ({ ...d, sleepM: sanitizeInt(v, 0, 59) }))}
          onEnter={onNext}
        />
      </div>
    </StepShell>
  );
}

function SleepField({
  label,
  value,
  onChange,
  onEnter,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onEnter: () => void;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="flex w-full max-w-[150px] flex-col items-center gap-2">
      <div className="flex w-full items-center justify-center rounded-[14px] border border-card-border bg-card px-3 py-5 focus-within:border-accent">
        <input
          ref={ref}
          type="text"
          inputMode="numeric"
          enterKeyHint="next"
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              ref.current?.blur();
              onEnter();
            }
          }}
          onFocus={scrollSelfIntoView}
          aria-label={label}
          placeholder="0"
          className="w-full min-w-0 bg-transparent text-center text-5xl font-extrabold tabular-nums outline-none placeholder:text-white/20"
        />
      </div>
      <span className="label">{label}</span>
    </div>
  );
}

// ── Step 3 · Readiness ────────────────────────────────────────────────────────

function ReadinessStep({
  selected,
  onSelect,
  onContinue,
}: {
  selected: number | null;
  onSelect: (n: number) => void;
  onContinue: () => void;
}) {
  return (
    <StepShell
      footer={selected !== null ? <PrimaryButton onClick={onContinue}>Next</PrimaryButton> : undefined}
    >
      <Prompt>How ready do you feel today?</Prompt>

      <div className="mx-auto grid w-full max-w-[320px] grid-cols-5 gap-3">
        {READINESS.map((n) => {
          const active = selected === n;
          return (
            <button
              key={n}
              type="button"
              aria-pressed={active}
              onClick={() => onSelect(n)}
              className={`flex aspect-square items-center justify-center rounded-full border text-xl font-bold transition-transform active:scale-95 ${
                active
                  ? "scale-105 border-accent bg-accent text-white"
                  : "border-card-border bg-card text-white/55"
              }`}
            >
              {n}
            </button>
          );
        })}
      </div>
    </StepShell>
  );
}

// ── Step 4 · Anything else? ───────────────────────────────────────────────────

function FinalStep({
  draft,
  setDraft,
  pending,
  onSubmit,
}: {
  draft: MorningDraft;
  setDraft: (updater: (prev: MorningDraft) => MorningDraft) => void;
  pending: boolean;
  onSubmit: () => void;
}) {
  const [added, setAdded] = useState<Set<MetricKey>>(() => {
    const s = new Set<MetricKey>();
    if (draft.rhr !== "") s.add("rhr");
    if (draft.hrv !== "") s.add("hrv");
    return s;
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const available = OPTIONAL_METRICS.filter((m) => !added.has(m.key));

  const metricValue = (k: MetricKey) => (k === "rhr" ? draft.rhr : draft.hrv);
  const setMetricValue = (k: MetricKey, v: string) =>
    setDraft((d) => (k === "rhr" ? { ...d, rhr: v } : { ...d, hrv: v }));
  const addMetric = (k: MetricKey) => {
    setAdded((s) => new Set(s).add(k));
    setMenuOpen(false);
  };
  const removeMetric = (k: MetricKey) => {
    setAdded((s) => {
      const n = new Set(s);
      n.delete(k);
      return n;
    });
    setMetricValue(k, "");
  };

  return (
    <StepShell
      footer={
        <PrimaryButton onClick={onSubmit} disabled={pending}>
          Log Morning
        </PrimaryButton>
      }
    >
      <Prompt>Anything else?</Prompt>

      <textarea
        rows={4}
        maxLength={1000}
        value={draft.note}
        onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
        onFocus={scrollSelfIntoView}
        placeholder="Add a morning note or journal entry… (optional)"
        className="w-full resize-none rounded-[14px] border border-card-border bg-card p-4 text-base leading-relaxed outline-none placeholder:text-white/25 focus:border-accent"
      />

      <div className="flex flex-col gap-3">
        {OPTIONAL_METRICS.filter((m) => added.has(m.key)).map((m) => (
          <MetricInput
            key={m.key}
            meta={m}
            value={metricValue(m.key)}
            onChange={(v) => setMetricValue(m.key, sanitizeInt(v, 0, m.max))}
            onRemove={() => removeMetric(m.key)}
          />
        ))}

        {available.length > 0 && (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
              className="flex items-center gap-2 self-start active:opacity-70"
            >
              <span className="grid h-7 w-7 place-items-center rounded-full border border-card-border text-xl leading-none text-white/70">
                +
              </span>
              <span className="label">Add metric</span>
            </button>

            {menuOpen && (
              <div className="flex flex-col gap-1 rounded-[14px] border border-card-border bg-card p-1.5">
                {available.map((m) => (
                  <button
                    key={m.key}
                    type="button"
                    onClick={() => addMetric(m.key)}
                    className="flex items-center justify-between rounded-[10px] px-3 py-2.5 text-left text-sm font-semibold text-white/80 active:bg-white/10"
                  >
                    <span>{m.label}</span>
                    <span className="label">{m.unit}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </StepShell>
  );
}

function MetricInput({
  meta,
  value,
  onChange,
  onRemove,
}: {
  meta: OptionalMetric;
  value: string;
  onChange: (v: string) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-[14px] border border-card-border bg-card px-4 py-3">
      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-white/80">{meta.label}</span>
      <input
        type="text"
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={scrollSelfIntoView}
        placeholder={meta.placeholder}
        aria-label={meta.label}
        className="w-16 bg-transparent text-right text-2xl font-bold tabular-nums outline-none placeholder:text-white/20"
      />
      <span className="w-8 shrink-0 text-sm font-semibold text-white/40">{meta.unit}</span>
      <button
        type="button"
        aria-label={`Remove ${meta.label}`}
        onClick={onRemove}
        className="-mr-1 ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white/40 active:bg-white/10"
      >
        ✕
      </button>
    </div>
  );
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
    <main className="mx-auto flex h-full max-w-[390px] flex-col px-5 pb-5 pt-6">
      <header className="mb-6">
        <p className="label">{log.date}</p>
        <h1 className="text-2xl font-extrabold tracking-tight">Morning logged</h1>
      </header>

      <section className="grid grid-cols-3 gap-3">
        <SummaryCard
          label="Readiness"
          value={log.morning_readiness != null ? `${log.morning_readiness}/10` : "--"}
        />
        <SummaryCard label="Sleep" value={sleepTileValue(log.sleep_hours)} />
        <SummaryCard label="Weight" value={todayWeight ?? "--"} unit={todayWeight != null ? unit : undefined} />
      </section>

      {log.morning_note && (
        <div className="mt-3 flex min-h-0 flex-col rounded-[14px] border border-card-border bg-card p-4">
          <p className="label mb-1">Note</p>
          <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-white/80">
            {log.morning_note}
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

// Optimistic submitted view — shown the instant the user taps Log, while the
// save settles in the background. Grey accent only (no blue/green chrome).
// Exported: EveningLog reuses this exact card.
export function SubmittedCard({ title, pending }: { title: string; pending: boolean }) {
  return (
    <main className="mx-auto flex h-full max-w-[390px] flex-col items-center justify-center gap-4 px-5">
      <div className="flex h-16 w-16 items-center justify-center rounded-full border-2 border-accent">
        <span className="text-3xl font-bold text-white">✓</span>
      </div>
      <h1 className="text-2xl font-extrabold tracking-tight">{title}</h1>
      <p className="label">{pending ? "Saving…" : "Saved"}</p>
    </main>
  );
}
