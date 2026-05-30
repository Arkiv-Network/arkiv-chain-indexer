export type View =
  | "home"
  | "blocks"
  | "block"
  | "transactions"
  | "transaction-records"
  | "senders"
  | "ranges"
  | "charts"
  | "guzzlers"
  | "health"
  | "admin"
  | "baseload";

const VIEW_PARAM = "view";

export function getCurrentSearch(): string {
  if (typeof window === "undefined") return "";
  return window.location.search;
}

export function readViewFromSearch(search: string): View {
  const params = new URLSearchParams(search);
  const value = params.get(VIEW_PARAM);
  if (value === "home") return "home";
  if (value === "blocks") return "blocks";
  if (value === "block") return "block";
  if (value === "transactions") return "transactions";
  if (value === "transaction-records") return "transaction-records";
  if (value === "senders") return "senders";
  if (value === "ranges") return "ranges";
  if (value === "charts") return "charts";
  if (value === "guzzlers") return "guzzlers";
  if (value === "health") return "health";
  if (value === "admin") return "admin";
  if (value === "baseload") return "baseload";
  return "home";
}

export function readFiltersFromSearch<T extends Record<string, string>>(
  search: string,
  keys: readonly (keyof T & string)[],
  fallback: T,
): T {
  const params = new URLSearchParams(search);
  const next: Record<string, string> = { ...fallback };
  for (const key of keys) {
    const value = params.get(key);
    if (value !== null) next[key] = value;
  }
  return next as T;
}

export function hasAnyFilterParam<T extends Record<string, string>>(
  search: string,
  keys: readonly (keyof T & string)[],
): boolean {
  const params = new URLSearchParams(search);
  return keys.some((key) => params.has(key));
}

export function filtersEqual<T extends Record<string, string>>(
  left: T,
  right: T,
  keys: readonly (keyof T & string)[],
): boolean {
  return keys.every((key) => left[key] === right[key]);
}

export function buildPermalinkHref(view: View, filters: Record<string, string>): string {
  if (typeof window === "undefined") return "";

  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set(VIEW_PARAM, view);

  for (const [key, value] of Object.entries(filters)) {
    const trimmed = value.trim();
    if (trimmed) url.searchParams.set(key, trimmed);
  }

  return url.toString();
}

export function writePermalink(view: View, filters: Record<string, string>): boolean {
  if (typeof window === "undefined") return false;

  const href = buildPermalinkHref(view, filters);
  if (href === window.location.href) return false;

  window.history.pushState(null, "", href);
  return true;
}
