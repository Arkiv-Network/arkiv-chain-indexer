// The entity explorer keeps its settings in the URL through nuqs. No other page
// uses it, so its adapter wraps the explorer here, inside its lazy chunk,
// rather than the whole app. TanStack Query's client is app-wide (main.tsx).

import { enableHistorySync, NuqsAdapter } from "nuqs/adapters/react";
import type { ReactNode } from "react";

// The rest of the app navigates with history.pushState directly; this lets
// nuqs notice those changes as well as its own.
enableHistorySync();

export function EntityExplorerProviders({ children }: { children: ReactNode }) {
  return <NuqsAdapter>{children}</NuqsAdapter>;
}
