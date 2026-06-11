import type { UseFormRegisterReturn } from "react-hook-form";

interface NumberStepperProps {
  label: string;
  registration: UseFormRegisterReturn;
  onDecrement: () => void;
  onIncrement: () => void;
}

/**
 * Stepper around an uncontrolled RHF-registered text input. The +/− buttons
 * mutate the field via the parent's setValue (no re-render), and the input
 * itself stays directly typeable with the numeric keypad — no native clock
 * scroll wheels anywhere.
 */
export function NumberStepper({ label, registration, onDecrement, onIncrement }: NumberStepperProps) {
  return (
    <div className="flex flex-1 flex-col gap-2">
      <span className="label text-center">{label}</span>
      <div className="flex items-center rounded-[14px] border border-card-border bg-card p-1.5">
        <button
          type="button"
          aria-label={`Decrease ${label}`}
          onClick={onDecrement}
          className="h-12 w-12 shrink-0 rounded-[8px] text-2xl font-semibold text-white/70 active:bg-white/10"
        >
          −
        </button>
        <input
          type="text"
          inputMode="numeric"
          className="w-full min-w-0 bg-transparent text-center text-3xl font-bold outline-none"
          {...registration}
        />
        <button
          type="button"
          aria-label={`Increase ${label}`}
          onClick={onIncrement}
          className="h-12 w-12 shrink-0 rounded-[8px] text-2xl font-semibold text-white/70 active:bg-white/10"
        >
          +
        </button>
      </div>
    </div>
  );
}
