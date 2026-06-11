import { useState } from "react";
import MorningLog from "@/screens/MorningLog";
import EveningLog from "@/screens/EveningLog";

/**
 * Temporary shell: AM/PM switcher until the router + bottom nav land.
 * Defaults to the log the user most likely needs right now.
 */
export default function App() {
  const [tab, setTab] = useState<"morning" | "evening">(
    new Date().getHours() >= 15 ? "evening" : "morning",
  );

  return (
    <div>
      {/* fixed (not absolute): survives the keyboard-driven scroll when the
          bodyweight field autofocuses, and clears the notch via safe-area */}
      <div
        className="fixed right-4 z-50 flex gap-1"
        style={{ top: "calc(env(safe-area-inset-top) + 12px)" }}
      >
        {(["morning", "evening"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`h-9 rounded-[30px] border px-3 text-xs font-semibold uppercase tracking-wide ${
              tab === t
                ? "border-accent bg-accent text-white"
                : "border-card-border bg-card text-white/50"
            }`}
          >
            {t === "morning" ? "AM" : "PM"}
          </button>
        ))}
      </div>
      {tab === "morning" ? <MorningLog /> : <EveningLog />}
    </div>
  );
}
