import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * Minimal transient toast. Used for the optimistic-save revert path: when a
 * mutation fails we roll the UI back and surface a short error here.
 *
 * Design system (locked): error = negative red, neutral = grey. No blue
 * (AI-only), no green (positive-delta data only) in chrome.
 */

type Variant = "error" | "neutral";

interface ToastState {
  id: number;
  message: string;
  variant: Variant;
}

interface ToastContextValue {
  show: (message: string, variant?: Variant) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const VARIANT_CLASS: Record<Variant, string> = {
  error: "border-negative text-negative",
  neutral: "border-card-border text-white/80",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const show = useCallback((message: string, variant: Variant = "error") => {
    setToast({ id: Date.now(), message, variant });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 3200);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          key={toast.id}
          className="pointer-events-none fixed inset-x-0 z-[100] mx-auto flex max-w-[390px] justify-center px-5"
          style={{ bottom: "calc(env(safe-area-inset-bottom) + 16px)" }}
        >
          <div
            className={`w-full rounded-[14px] border bg-card px-4 py-3 text-center text-sm font-semibold ${VARIANT_CLASS[toast.variant]}`}
          >
            {toast.message}
          </div>
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}
