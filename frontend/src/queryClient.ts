// The one TanStack Query client for the whole app: every page fetches through
// it (useQuery), not through effects. It lives for the page's lifetime, so going
// to another page and back finds earlier results still cached.

import { QueryClient } from "@tanstack/react-query";

/** Query errors are answers, not blips, so nothing retries or refetches on focus. */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
