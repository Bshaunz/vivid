import { useState } from "react";
import MorningLog from "@/screens/MorningLog";
import EveningLog from "@/screens/EveningLog";
import WeeklyLog from "@/screens/WeeklyLog";

type Tab = "morning" | "evening" | "weekly";

const TABS: { id: Tab; label: string }[] = [
  { id: "morning", label: "AM" },
  { id: "evening", label: "PM" },
  { id: "weekly", label: "WK" },
];

function initialTab(): Tab {
  const param = new URLSearchParams(window.location.search).get("tab");
  if (param === "morning" || param === "evening" || param === "weekly") return param;
  if (new Date().getDay() === 0) return "weekly";
  return new Date().getHours() >= 15 ? "evening" : "morning";
}

/**
 * Log container — time-of-day defaults to the right form; AM/PM/WK pills switch.
 * The forms themselves keep the single-viewport, zero-render uncontrolled
 * architecture (§5). Pills use the grey accent token for the active state.
 */
export default function Log() {
  const [tab, setTab] = useState<Tab>(initialTab);

  return (
    <div className="relative h-full">
      <div
        className="absolute right-4 z-50 flex gap-1"
        style={{ top: "calc(env(safe-area-inset-top) + 12px)" }}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`h-9 rounded-[30px] border px-3 text-xs font-semibold uppercase tracking-wide ${
              tab === t.id
                ? "border-accent bg-accent text-white"
                : "border-card-border bg-card text-white/50"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "morning" ? <MorningLog /> : tab === "evening" ? <EveningLog /> : <WeeklyLog />}
    </div>
  );
}
