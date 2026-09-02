export type View =
  | "home"
  | "blocks"
  | "block"
  | "transactions"
  | "transaction"
  | "entity"
  | "address"
  | "data"
  | "transaction-records"
  | "senders"
  | "ranges"
  | "charts"
  | "chart-fullscreen"
  | "guzzlers"
  | "cedric"
  | "health"
  | "admin"
  | "baseload";

const VIEW_PARAM = "view";
const VIEW_PATHS: Record<View, string> = {
  home: "/",
  blocks: "/blocks",
  block: "/block",
  transactions: "/transactions",
  transaction: "/tx",
  entity: "/entity",
  address: "/address",
  data: "/data",
  "transaction-records": "/records",
  senders: "/senders",
  ranges: "/ranges",
  charts: "/charts",
  "chart-fullscreen": "/charts/fullscreen",
  guzzlers: "/activity",
  cedric: "/cedric",
  health: "/health",
  admin: "/admin",
  baseload: "/baseload",
};

const VIEW_PATH_ALIASES: Record<string, View> = {
  "/": "home",
  "/blocks": "blocks",
  "/block": "block",
  "/transactions": "transactions",
  "/tx": "transaction",
  "/entity": "entity",
  "/address": "address",
  "/data": "data",
  "/transaction-records": "transaction-records",
  "/records": "transaction-records",
  "/senders": "senders",
  "/ranges": "ranges",
  "/charts": "charts",
  "/charts/fullscreen": "chart-fullscreen",
  "/guzzlers": "guzzlers",
  "/activity": "guzzlers",
  "/cedric": "cedric",
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
  if (value === "transaction") return "transaction";
  if (value === "entity") return "entity";
  if (value === "address") return "address";
  if (value === "data") return "data";
  if (value === "transaction-records") return "transaction-records";
  if (value === "senders") return "senders";
  if (value === "ranges") return "ranges";
  if (value === "charts") return "charts";
  if (value === "chart-fullscreen") return "chart-fullscreen";
  if (value === "guzzlers") return "guzzlers";
  if (value === "cedric") return "cedric";
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

  // Detail route with a dynamic hash segment: /tx/<hash>
  if (pathname === "/tx" || pathname.startsWith("/tx/")) return "transaction";

  // Detail route with a dynamic entity key segment: /entity/<0x…>
  if (pathname === "/entity" || pathname.startsWith("/entity/")) return "entity";

  // Detail route with a dynamic address segment: /address/<0x…>
  if (pathname === "/address" || pathname.startsWith("/address/")) return "address";

  const pathView = VIEW_PATH_ALIASES[pathname];
  if (pathView) return pathView;

  return readViewFromSearch(location.search);
}

/** Extract the transaction hash from a `/tx/<hash>` path, or null if absent. */
export function readTransactionHashFromLocation(location: ClientLocation): string | null {
  const pathname = normalizePathname(location.pathname);
  const match = pathname.match(/^\/tx\/(.+)$/);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]).trim() || null;
  } catch {
    return match[1].trim() || null;
  }
}

/** Build a client-side href for the transaction detail panel (`/tx/<hash>`). */
export function transactionDetailHref(hash: string): string {
  return `${routePathForView("transaction")}/${encodeURIComponent(hash.trim())}`;
}

/** Extract the entity key from an `/entity/<0x…>` path, or null if absent. */
export function readEntityKeyFromLocation(location: ClientLocation): string | null {
  const pathname = normalizePathname(location.pathname);
  const match = pathname.match(/^\/entity\/(.+)$/);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]).trim() || null;
  } catch {
    return match[1].trim() || null;
  }
}

/** Build a client-side href for the entity detail page (`/entity/<0x…>`). */
export function entityDetailHref(entityKey: string): string {
  return `${routePathForView("entity")}/${encodeURIComponent(entityKey.trim())}`;
}

/** Navigate to the entity detail page via history.pushState. */
export function writeEntityPermalink(entityKey: string): boolean {
  if (typeof window === "undefined") return false;

  const url = new URL(window.location.href);
  url.pathname = entityDetailHref(entityKey);
  url.search = "";
  url.hash = "";

  const href = url.toString();
  if (href === window.location.href) return false;

  window.history.pushState(null, "", href);
  return true;
}

/** Extract the address from an `/address/<0x…>` path, or null if absent. */
export function readAddressFromLocation(location: ClientLocation): string | null {
  const pathname = normalizePathname(location.pathname);
  const match = pathname.match(/^\/address\/(.+)$/);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]).trim() || null;
  } catch {
    return match[1].trim() || null;
  }
}

/** Build a client-side href for the address page (`/address/<0x…>?<filters>`). */
export function addressDetailHref(address: string, filters: Record<string, string> = {}): string {
  const base = `${routePathForView("address")}/${encodeURIComponent(address.trim())}`;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (key === VIEW_PARAM || key === "address") continue;
    const trimmed = value.trim();
    if (trimmed) params.set(key, trimmed);
  }
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

/** Absolute href for the address page — used for the shareable "Copy link". */
export function buildAddressPermalinkHref(address: string, filters: Record<string, string>): string {
  if (typeof window === "undefined") return addressDetailHref(address, filters);

  const url = new URL(window.location.href);
  url.pathname = `${routePathForView("address")}/${encodeURIComponent(address.trim())}`;
  url.search = "";
  url.hash = "";
  for (const [key, value] of Object.entries(filters)) {
    if (key === VIEW_PARAM || key === "address") continue;
    const trimmed = value.trim();
    if (trimmed) url.searchParams.set(key, trimmed);
  }
  return url.toString();
}

/** Navigate to the address page (address in the path, other filters in the query). */
export function writeAddressPermalink(address: string, filters: Record<string, string>): boolean {
  if (typeof window === "undefined") return false;

  const href = buildAddressPermalinkHref(address, filters);
  if (href === window.location.href) return false;

  window.history.pushState(null, "", href);
  return true;
}

/** Navigate to the transaction detail panel via history.pushState. */
export function writeTransactionPermalink(hash: string): boolean {
  if (typeof window === "undefined") return false;

  const url = new URL(window.location.href);
  url.pathname = transactionDetailHref(hash);
  url.search = "";
  url.hash = "";

  const href = url.toString();
  if (href === window.location.href) return false;

  window.history.pushState(null, "", href);
  return true;
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
