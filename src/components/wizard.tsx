import type { FocusEvent, ReactNode } from "react";

/**
 * Shared grill-style wizard primitives — used by the Morning and Evening log
 * wizards so both screens share one layout/typography contract:
 *
 * - StepShell      scrollable, centered content area + a pinned footer (keeps
 *                  inputs reachable above the mobile keyboard).
 * - Prompt         the large centered question heading.
 * - PrimaryButton  the massive white submit/advance CTA.
 * - WizardHeader   back chevron + progress dots.
 * - SummaryCard    a finished-log data tile (muted title top-left, big value
 *                  bottom-left, optional small muted unit suffix).
 * - scrollSelfIntoView  lift a focused field above the keyboard on focus.
 *
 * Step transitions stay in each screen (the `.step-in` keyframe on a
 * `key`-mounted panel), since step content differs per screen.
 */

/** Defer past the keyboard's resize, then lift the focused field into view.
 *  Guards against the field unmounting during a step swap before this fires. */
export function scrollSelfIntoView(e: FocusEvent<HTMLElement>): void {
  const el = e.currentTarget;
  window.setTimeout(() => {
    if (el && el.isConnected) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, 250);
}

/** A step's body: a scrollable, centered content area + a pinned footer. The
 *  scroll area is what keeps inputs reachable when the keyboard is up. */
export function StepShell({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex min-h-full flex-col justify-center gap-7 py-6">{children}</div>
      </div>
      {footer && <div className="shrink-0 pt-4">{footer}</div>}
    </>
  );
}

export function Prompt({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-center text-[26px] font-extrabold leading-tight tracking-tight text-white">
      {children}
    </h2>
  );
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="h-16 w-full rounded-[14px] bg-white text-lg font-bold text-black active:bg-white/80 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

export function WizardHeader({ step, total, onBack }: { step: number; total: number; onBack: () => void }) {
  return (
    <header className="flex h-9 shrink-0 items-center justify-between">
      {step > 0 ? (
        <button
          type="button"
          aria-label="Back"
          onClick={onBack}
          className="-ml-2 flex h-9 w-9 items-center justify-center rounded-full text-3xl leading-none text-white/60 active:bg-white/10"
        >
          ‹
        </button>
      ) : (
        <span className="h-9 w-9" />
      )}
      <div className="flex items-center gap-2" aria-hidden>
        {Array.from({ length: total }).map((_, i) => (
          <span
            key={i}
            className={`h-1.5 rounded-full transition-all duration-300 ${
              i === step ? "w-6 bg-white" : i < step ? "w-1.5 bg-white/50" : "w-1.5 bg-white/15"
            }`}
          />
        ))}
      </div>
      <span className="h-9 w-9" />
    </header>
  );
}

/** Finished-log data tile: muted title top-left, large high-contrast value
 *  bottom-left, optional small muted unit suffix. `min-w-0` lets the tile sit at
 *  its true grid-track width (instead of being forced wider by a long value,
 *  which would blow out the row); `overflow-hidden` + `whitespace-nowrap` then
 *  keep that value on one line inside the tile, never overlapping a sibling. */
export function SummaryCard({ label, value, unit }: { label: string; value: ReactNode; unit?: string }) {
  return (
    <div className="flex h-[84px] min-w-0 flex-col justify-between overflow-hidden rounded-[14px] border border-card-border bg-card p-3">
      <p className="label truncate">{label}</p>
      <p className="flex min-w-0 items-baseline gap-1 whitespace-nowrap leading-none">
        <span className="min-w-0 text-2xl font-bold tabular-nums text-white">{value}</span>
        {unit && <span className="shrink-0 text-xs font-semibold text-white/40">{unit}</span>}
      </p>
    </div>
  );
}
