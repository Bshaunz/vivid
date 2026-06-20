import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { isAuthConfigured, supabase } from "@/lib/supabase";
import AuthScreen from "@/screens/Auth";

/**
 * AuthContext — owns the Supabase session and the sign in / up / out actions.
 *
 * <AuthGate> below is the route guard: until a session exists it renders the
 * login screen INSTEAD of the app, so AppContext's data queries never fire (and
 * never 401) for a signed-out user. When Supabase is unconfigured (local dev),
 * the gate is transparent and the backend's DEV_MODE user is used.
 */

type AuthStatus = "loading" | "authed" | "anon";

interface AuthResult {
  error?: string;
  /** Sign-up only: account created but email confirmation is still required. */
  needsConfirmation?: boolean;
}

interface AuthContextValue {
  status: AuthStatus;
  session: Session | null;
  email: string | null;
  signIn: (email: string, password: string) => Promise<AuthResult>;
  signUp: (email: string, password: string) => Promise<AuthResult>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Map Supabase's raw error strings to calm, on-brand copy. */
function friendly(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("invalid login")) return "Incorrect email or password.";
  if (m.includes("already registered") || m.includes("already been registered"))
    return "That email is already registered — sign in instead.";
  if (m.includes("email not confirmed")) return "Confirm your email first, then sign in.";
  if (m.includes("rate limit")) return "Too many attempts — wait a moment and try again.";
  return message;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  // Unconfigured → settle immediately to "anon"; the gate ignores it anyway.
  const [status, setStatus] = useState<AuthStatus>(isAuthConfigured ? "loading" : "anon");
  // Track the authed user id so we can flush cross-user query cache on a switch.
  const lastUserId = useRef<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    const sync = (next: Session | null) => {
      // Whenever the user identity changes (sign in, sign out, or A→B switch),
      // drop AppContext's cached data so the next user never sees the prior
      // user's profile/logs flash before the refetch (multi-tenant safety).
      const nextId = next?.user.id ?? null;
      if (nextId !== lastUserId.current) {
        queryClient.clear();
        lastUserId.current = nextId;
      }
      setSession(next);
      setStatus(next ? "authed" : "anon");
    };
    // Hydrate from any persisted session, then keep in sync with sign in/out,
    // token refreshes, and confirmation-link returns.
    supabase.auth.getSession().then(({ data }) => sync(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => sync(next));
    return () => sub.subscription.unsubscribe();
  }, [queryClient]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      session,
      email: session?.user.email ?? null,
      signIn: async (email, password) => {
        if (!supabase) return { error: "Auth is not configured." };
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        return error ? { error: friendly(error.message) } : {};
      },
      signUp: async (email, password) => {
        if (!supabase) return { error: "Auth is not configured." };
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) return { error: friendly(error.message) };
        // No session back means the project requires email confirmation.
        return { needsConfirmation: data.session === null };
      },
      signOut: async () => {
        await supabase?.auth.signOut();
      },
    }),
    [status, session],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}

/** Brief on-brand splash while the persisted session hydrates. */
function AuthSplash() {
  return (
    <main className="flex h-full items-center justify-center">
      <div className="h-10 w-10 animate-pulse rounded-full border-2 border-card-border" />
    </main>
  );
}

/**
 * Route guard. Unconfigured (dev) → transparent. Configured → show the splash
 * while hydrating, the login screen when signed out, the app once authed.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (!isAuthConfigured) return <>{children}</>;
  if (status === "loading") return <AuthSplash />;
  if (status === "anon") return <AuthScreen />;
  return <>{children}</>;
}
