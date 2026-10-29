import { websiteRpcFetch } from "./websiteRpcTokens";
// The browser's line to the indexed chain's node, beside the index.
//
// JSON-RPC goes through the backend's entity-explorer relay
// (`POST /api/entity-explorer/rpc`, `ENTITY_EXPLORER_RPC_METHODS` in
// src/jsonRpcPassthrough.ts): it forwards `arkiv_query` and
// `arkiv_getBlockTiming`, nothing else, to the node the indexer scans and stores
// nothing. The entity explorer reads entities through it with the SDK
// (entityExplorer/lib/client.ts); the transaction and entity pages load a bytes
// attribute's content through it (nodeBytes.ts), since the index keeps only a
// bytes value's size and keccak256.
//
// The node's rent cap is not a JSON-RPC method: it comes from the node's
// `/signed/v1/status`, read only when the deployment says where that is
// (`VITE_NODE_STATUS_URL` in `/config.js`, absolute with CORS or same-origin,
// e.g. an nginx route; unset or `off` for none). Every reader degrades
// without it.

import { envValues, type RuntimeConfig } from "./runtimeConfig";

/** `POST /entity-explorer/rpc` on the backend, behind the frontend's `/api` prefix. */
export const NODE_RELAY_PATH = "/api/entity-explorer/rpc";

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

/** The node's status document URL, as configured; null when there is none. */
export function readNodeStatusUrl(env: RuntimeConfig = envValues()): string | null {
  return configuredUrl(env.VITE_NODE_STATUS_URL);
}

export const NODE_STATUS_URL = readNodeStatusUrl();

// ---------------------------------------------------------------------------
// JSON-RPC through the relay

/** A JSON-RPC error the node (or the relay, for transport faults and its rate limit) answered with. */
export class NodeRpcError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message);
    this.name = "NodeRpcError";
  }
}

export interface NodeRelayDeps {
  fetchImpl?: typeof fetch;
  /** Defaults to {@link NODE_RELAY_PATH}. */
  url?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
let nextRequestId = 1;

/**
 * One JSON-RPC call through the website session transport. Custom destinations
 * never receive website credentials. fetchImpl can inject a transport in tests.
 */
export async function callNodeRelay<T>(method: string, params: unknown[], deps: NodeRelayDeps = {}): Promise<T> {
  const fetchImpl = deps.fetchImpl ?? websiteRpcFetch;
  const id = nextRequestId++;
  let response: Response;
  try {
    response = await fetchImpl(deps.url ?? NODE_RELAY_PATH, {
      method: "POST",
      credentials: "omit",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new NodeRpcError(`the node could not be reached (${error instanceof Error ? error.message : String(error)})`, null);
  }
  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== "object") {
    throw new NodeRpcError(`the node relay answered HTTP ${response.status} without JSON-RPC`, null);
  }
  const { result, error } = body as { result?: unknown; error?: { code?: unknown; message?: unknown } };
  if (error && typeof error === "object") {
    const code = typeof error.code === "number" ? error.code : null;
    const message = typeof error.message === "string" ? error.message : "the node answered with an error";
    throw new NodeRpcError(message, code);
  }
  if (!response.ok) throw new NodeRpcError(`the node relay answered HTTP ${response.status}`, null);
  return result as T;
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
    .then(async (response) => {
      // A wrong URL often lands on an HTML page (an SPA fallback) with 200: not the status.
      if (!response.ok || !(response.headers.get("content-type") ?? "").toLowerCase().includes("json")) return null;
      return parseNodeRentCap(await response.json());
    })
    .catch(() => null);
  if (fetchImpl === fetch) rentCapPromise = promise;
  return promise;
}
