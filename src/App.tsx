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
    <div className="relative">
      <div className="absolute right-5 top-6 z-10 flex gap-1">
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
