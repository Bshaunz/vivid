import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { AppProvider } from "@/context/AppContext";
import { AuthProvider, AuthGate } from "@/context/AuthContext";
import { ToastProvider } from "@/components/Toast";
import { queryClient } from "@/lib/queryClient";
import App from "@/App";
import "./index.css";

// AuthGate sits ABOVE AppProvider so a signed-out user sees the login screen
// and AppProvider's data queries never mount (and never 401). When Supabase is
// unconfigured (local dev), the gate is transparent and the DEV_MODE user runs.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <AuthProvider>
            <AuthGate>
              <AppProvider>
                <App />
              </AppProvider>
            </AuthGate>
          </AuthProvider>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
