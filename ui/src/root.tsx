/** The app itself; loaded by main.tsx once the UI language is ready. */
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import App from "./App";
import { ToastProvider } from "./components/Toast";
import { UploadProvider } from "./components/UploadTray";
import { ApiError } from "./lib/api";

const queryClient: QueryClient = new QueryClient({
  // 401 on a resource: this tab's cloud was signed out (in another tab, or its token
  // expired). Re-reading the session moves the tab to a cloud it still has, or to sign-in.
  queryCache: new QueryCache({
    onError: (e, q) => {
      if (e instanceof ApiError && e.status === 401 && q.queryKey[0] !== "session") {
        void queryClient.invalidateQueries({ queryKey: ["session"] });
      }
    },
  }),
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      // Don't hammer the API on auth/permission errors.
      retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <UploadProvider>
            <App />
          </UploadProvider>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
