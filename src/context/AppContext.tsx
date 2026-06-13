import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createDataLayer, type DataLayer } from "@/data";
import type { DailyLog, Goal, Habit, UserProfile } from "@/types/domain";
import { todayISO } from "@/lib/dates";

/**
 * AppContext — the only path from UI components to data.
 *
 * Core state (profile, today's log, habits, goals) is now sourced from live
 * TanStack queries against the API, not localStorage. Components read the cached
 * values via useApp(); after a write they call refresh() (a query invalidation)
 * to re-sync. `loading` drives skeleton screens.
 */
interface AppContextValue {
  data: DataLayer;
  ready: boolean;
  loading: boolean;
  error: boolean;
  profile: UserProfile | null;
  todayLog: DailyLog | null;
  habits: Habit[];
  goals: Goal[];
  refresh: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

/** Query keys — single source so screens can invalidate precisely. */
export const qk = {
  profile: ["profile"] as const,
  todayLog: (date: string) => ["log", date] as const,
  habits: ["habits", "active"] as const,
  goals: ["goals", "active"] as const,
  dashboard: ["dashboard"] as const,
  completions: (from: string, to: string) => ["completions", from, to] as const,
};

export function AppProvider({ children }: { children: ReactNode }) {
  const data = useMemo(() => createDataLayer(), []);
  const queryClient = useQueryClient();
  const today = todayISO();

  const profileQ = useQuery({ queryKey: qk.profile, queryFn: () => data.getProfile() });
  const todayLogQ = useQuery({ queryKey: qk.todayLog(today), queryFn: () => data.getDailyLog(today) });
  const habitsQ = useQuery({ queryKey: qk.habits, queryFn: () => data.listHabits({ activeOnly: true }) });
  const goalsQ = useQuery({ queryKey: qk.goals, queryFn: () => data.listGoals({ activeOnly: true }) });

  const queries = [profileQ, todayLogQ, habitsQ, goalsQ];
  const loading = queries.some((q) => q.isLoading);
  const error = queries.some((q) => q.isError);
  // Ready once the core queries have resolved at least once (success or error).
  const ready = queries.every((q) => !q.isLoading);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.profile }),
      queryClient.invalidateQueries({ queryKey: qk.todayLog(today) }),
      queryClient.invalidateQueries({ queryKey: qk.habits }),
      queryClient.invalidateQueries({ queryKey: qk.goals }),
      queryClient.invalidateQueries({ queryKey: qk.dashboard }),
    ]);
  };

  const value = useMemo(
    () => ({
      data,
      ready,
      loading,
      error,
      profile: profileQ.data ?? null,
      todayLog: todayLogQ.data ?? null,
      habits: habitsQ.data ?? [],
      goals: goalsQ.data ?? [],
      refresh,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, ready, loading, error, profileQ.data, todayLogQ.data, habitsQ.data, goalsQ.data],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within <AppProvider>");
  return ctx;
}
