import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createDataLayer, type DataLayer } from "@/data";
import type { DailyLog, Goal, Habit, UserProfile } from "@/types/domain";
import { todayISO } from "@/lib/dates";

/**
 * AppContext — the only path from UI components to data.
 *
 * Components call useApp() for cached core state (profile, today's log,
 * habits, goals) and `data` for everything else. After any write, call
 * refresh() to re-sync the cache. No component imports the storage
 * implementation directly.
 */
interface AppContextValue {
  data: DataLayer;
  ready: boolean;
  profile: UserProfile | null;
  todayLog: DailyLog | null;
  habits: Habit[];
  goals: Goal[];
  refresh: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const data = useMemo(() => createDataLayer(), []);
  const [ready, setReady] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [todayLog, setTodayLog] = useState<DailyLog | null>(null);
  const [habits, setHabits] = useState<Habit[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);

  const refresh = useCallback(async () => {
    const [p, log, h, g] = await Promise.all([
      data.getProfile(),
      data.getDailyLog(todayISO()),
      data.listHabits({ activeOnly: true }),
      data.listGoals({ activeOnly: true }),
    ]);
    setProfile(p);
    setTodayLog(log);
    setHabits(h);
    setGoals(g);
  }, [data]);

  useEffect(() => {
    refresh().then(() => setReady(true));
  }, [refresh]);

  const value = useMemo(
    () => ({ data, ready, profile, todayLog, habits, goals, refresh }),
    [data, ready, profile, todayLog, habits, goals, refresh],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within <AppProvider>");
  return ctx;
}
