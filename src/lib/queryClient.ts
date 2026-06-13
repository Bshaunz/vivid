import { QueryClient } from "@tanstack/react-query";

/**
 * Shared QueryClient. Defaults are tuned for the frictionless-logging model:
 * mutations apply optimistically and reconcile on settle, reads stay fresh
 * for a minute so re-opening a screen is instant. Retry policy matches the
 * backend contract (§3.4): never hammer, max 2 attempts, never on 4xx.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 5 * 60_000,
      retry: (failureCount, error) => {
        const status = (error as { status?: number })?.status;
        if (status !== undefined && status >= 400 && status < 500) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
});
