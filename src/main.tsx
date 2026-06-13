import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppProvider } from "@/context/AppContext";
import { ToastProvider } from "@/components/Toast";
import { queryClient } from "@/lib/queryClient";
import App from "@/App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AppProvider>
          <App />
        </AppProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
