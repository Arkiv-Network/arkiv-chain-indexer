// The entity explorer fetches through TanStack Query and keeps its settings in
// the URL through nuqs. No other page uses either, so their providers wrap the
// explorer here, inside its lazy chunk, rather than the whole app.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { enableHistorySync, NuqsAdapter } from "nuqs/adapters/react";
import type { ReactNode } from "react";

// The rest of the app navigates with history.pushState directly; this lets
// nuqs notice those changes as well as its own.
enableHistorySync();

/**
 * One client for the page's lifetime, so going to another page and back finds
 * earlier results still cached. Query errors are answers, not blips, so
 * nothing retries.
 */
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

export function EntityExplorerProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <NuqsAdapter>{children}</NuqsAdapter>
    </QueryClientProvider>
  );
}
