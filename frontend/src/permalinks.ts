export type View =
  | "home"
  | "blocks"
  | "block"
  | "transactions"
  | "transaction-records"
  | "senders"
  | "ranges"
  | "charts"
  | "chart-fullscreen"
  | "guzzlers"
  | "health"
  | "admin"
  | "baseload";

const VIEW_PARAM = "view";
const VIEW_PATHS: Record<View, string> = {
  home: "/",
  blocks: "/blocks",
  block: "/block",
  transactions: "/transactions",
  "transaction-records": "/records",
  senders: "/senders",
  ranges: "/ranges",
  charts: "/charts",
  "chart-fullscreen": "/charts/fullscreen",
  guzzlers: "/activity",
  health: "/health",
  admin: "/admin",
  baseload: "/baseload",
};

const VIEW_PATH_ALIASES: Record<string, View> = {
  "/": "home",
  "/blocks": "blocks",
  "/block": "block",
  "/transactions": "transactions",
  "/transaction-records": "transaction-records",
  "/records": "transaction-records",
  "/senders": "senders",
  "/ranges": "ranges",
  "/charts": "charts",
  "/charts/fullscreen": "chart-fullscreen",
  "/guzzlers": "guzzlers",
  "/activity": "guzzlers",
  "/health": "health",
  "/admin": "admin",
  "/baseload": "baseload",
};

export interface ClientLocation {
  pathname: string;
  search: string;
}

export interface ClientNavigationClick {
  button: number;
  defaultPrevented: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  currentTarget: {
    getAttribute(name: string): string | null;
  };
}

export function getCurrentLocation(): ClientLocation {
  if (typeof window === "undefined") return { pathname: "/", search: "" };
  return { pathname: window.location.pathname, search: window.location.search };
}

export function getCurrentSearch(): string {
  if (typeof window === "undefined") return "";
  return window.location.search;
}

function normalizePathname(pathname: string): string {
  const prefixed = pathname.startsWith("/") ? pathname : `/${pathname}`;
  if (prefixed.length > 1 && prefixed.endsWith("/")) {
    return prefixed.replace(/\/+$/, "");
  }
  return prefixed;
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
  if (value === "chart-fullscreen") return "chart-fullscreen";
  if (value === "guzzlers") return "guzzlers";
  if (value === "health") return "health";
  if (value === "admin") return "admin";
  if (value === "baseload") return "baseload";
  return "home";
}

export function readViewFromLocation(location: ClientLocation): View {
  const pathname = normalizePathname(location.pathname);
  if (pathname === "/") {
    const legacyView = readViewFromSearch(location.search);
    if (legacyView !== "home") return legacyView;
  }

  const pathView = VIEW_PATH_ALIASES[pathname];
  if (pathView) return pathView;

  return readViewFromSearch(location.search);
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

export function routePathForView(view: View): string {
  return VIEW_PATHS[view];
}

export function buildRouteHref(view: View, filters: Record<string, string>): string {
  const path = routePathForView(view);
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(filters)) {
    if (key === VIEW_PARAM) continue;
    const trimmed = value.trim();
    if (trimmed) params.set(key, trimmed);
  }

  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export function buildPermalinkHref(view: View, filters: Record<string, string>): string {
  if (typeof window === "undefined") return buildRouteHref(view, filters);

  const url = new URL(window.location.href);
  url.pathname = routePathForView(view);
  url.search = "";
  url.hash = "";

  for (const [key, value] of Object.entries(filters)) {
    if (key === VIEW_PARAM) continue;
    const trimmed = value.trim();
    if (trimmed) url.searchParams.set(key, trimmed);
  }

  return url.toString();
}

export function shouldHandleClientNavigation(event: ClientNavigationClick): boolean {
  const target = event.currentTarget.getAttribute("target");
  return (
    event.button === 0 &&
    !event.defaultPrevented &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    (!target || target === "_self")
  );
}

export function writePermalink(view: View, filters: Record<string, string>): boolean {
  if (typeof window === "undefined") return false;

  const href = buildPermalinkHref(view, filters);
  if (href === window.location.href) return false;

  window.history.pushState(null, "", href);
  return true;
}
