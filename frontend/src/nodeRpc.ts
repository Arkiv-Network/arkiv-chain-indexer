// The browser's own line to an Arkiv node, beside the indexer backend: the
// Data tab's default endpoint, where bytes contents are loaded from (the index
// never holds them, and they never pass through the backend), and where the
// rent cap comes from. Configured at runtime (`/config.js`):
//
//   VITE_NODE_RPC_URL     JSON-RPC endpoint, absolute or same-origin
//                         (`/node-rpc` when frontend/server.js proxies
//                         NODE_RPC_UPSTREAM); unset or `off` for none.
//   VITE_NODE_STATUS_URL  the node's `/signed/v1/status`; defaults to the RPC
//                         URL + `/signed/v1/status`; `off` for none.
//
// A node called cross-origin must answer CORS; the rent cap is optional and
// every reader degrades without it.

import { envValues, type RuntimeConfig } from "./runtimeConfig";

const OFF_VALUES = new Set(["off", "none", "false", "0", "disabled"]);

function configuredUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || OFF_VALUES.has(trimmed.toLowerCase())) return null;
  if (trimmed.startsWith("/")) return trimmed;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? trimmed : null;
  } catch {
    return null;
  }
}

/** The configured node JSON-RPC URL, or null when there is none. */
export function readNodeRpcUrl(env: RuntimeConfig = envValues()): string | null {
  return configuredUrl(env.VITE_NODE_RPC_URL);
}

/** The node's status document URL: configured, derived from the RPC URL, or null. */
export function readNodeStatusUrl(env: RuntimeConfig = envValues()): string | null {
  const explicit = env.VITE_NODE_STATUS_URL?.trim();
  if (explicit) return configuredUrl(explicit);
  const rpc = readNodeRpcUrl(env);
  return rpc ? `${rpc.replace(/\/+$/, "")}/signed/v1/status` : null;
}

export const NODE_RPC_URL = readNodeRpcUrl();
export const NODE_STATUS_URL = readNodeStatusUrl();

/** A credential baked into the node URL is never shown. */
export function describeNodeUrl(url: string | null): string {
  if (!url) return "not configured";
  if (url.startsWith("/")) return url;
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// The rent cap

/** What `/signed/v1/status` says about rent (`capabilities.gas`); decimal strings. */
export interface NodeRentCap {
  maxRentLifetimeSeconds: string | null;
  maxRentLifetimeBlocks: string | null;
  rentBlockPeriodMs: string | null;
  rentWeiPerStorageUnitDay: string | null;
}

function decimalOrNull(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return typeof value === "string" && /^\d+$/.test(value) ? value : null;
}

export function parseNodeRentCap(status: unknown): NodeRentCap | null {
  if (!status || typeof status !== "object") return null;
  const gas = (status as { capabilities?: { gas?: Record<string, unknown> } }).capabilities?.gas;
  if (!gas || typeof gas !== "object") return null;
  const cap: NodeRentCap = {
    maxRentLifetimeSeconds: decimalOrNull(gas.maxRentLifetimeSeconds),
    maxRentLifetimeBlocks: decimalOrNull(gas.maxRentLifetimeBlocks),
    rentBlockPeriodMs: decimalOrNull(gas.rentBlockPeriodMs),
    rentWeiPerStorageUnitDay: decimalOrNull(gas.rentWeiPerStorageUnitDay),
  };
  return cap.maxRentLifetimeSeconds === null && cap.maxRentLifetimeBlocks === null ? null : cap;
}

const DAY_SECONDS = 86_400;
const YEAR_SECONDS = 365 * DAY_SECONDS;

/** "1 year (15,768,000 blocks)" for a cap; "the node's rent cap" without one. */
export function describeRentCap(cap: NodeRentCap | null): string {
  if (!cap) return "the node's rent cap";
  const parts: string[] = [];
  if (cap.maxRentLifetimeSeconds !== null) {
    const seconds = Number(cap.maxRentLifetimeSeconds);
    if (seconds > 0 && seconds % YEAR_SECONDS === 0) parts.push(`${seconds / YEAR_SECONDS} ${seconds === YEAR_SECONDS ? "year" : "years"}`);
    else if (seconds > 0 && seconds % DAY_SECONDS === 0) parts.push(`${(seconds / DAY_SECONDS).toLocaleString("en-US")} days`);
    else parts.push(`${seconds.toLocaleString("en-US")} s`);
  }
  if (cap.maxRentLifetimeBlocks !== null) {
    const blocks = `${BigInt(cap.maxRentLifetimeBlocks).toLocaleString("en-US")} blocks`;
    parts.push(parts.length > 0 ? `(${blocks})` : blocks);
  }
  return parts.join(" ");
}

let rentCapPromise: Promise<NodeRentCap | null> | null = null;

/**
 * The node's rent cap, fetched once per page load; null when no status URL is
 * configured, the node is unreachable, or it does not describe one.
 */
export function fetchNodeRentCap(
  fetchImpl: typeof fetch = fetch,
  url: string | null = NODE_STATUS_URL,
): Promise<NodeRentCap | null> {
  if (!url) return Promise.resolve(null);
  if (fetchImpl === fetch && rentCapPromise) return rentCapPromise;
  const promise = fetchImpl(url, { credentials: "omit", headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) })
    .then(async (response) => (response.ok ? parseNodeRentCap(await response.json()) : null))
    .catch(() => null);
  if (fetchImpl === fetch) rentCapPromise = promise;
  return promise;
}
