// The Data page talks JSON-RPC to an Arkiv node for entity state the index does
// not hold. This module is the framework-free half: which endpoint to use, how
// a call is made, and the connection check that proves the chosen endpoint
// really answers the Arkiv read methods. Keep React out of here so `bun test`
// can exercise it with a fake fetch.

import { readStoredString, writeStoredString, type StorageLike } from "./localStorage";

/**
 * Where the page sends its JSON-RPC calls: the backend forwarding to its node
 * (`backend`), the backend's own experimental entity index (`index`), or any
 * node the user names (`custom`).
 */
export type RpcSourceKind = "backend" | "index" | "custom";

export interface RpcSource {
  kind: RpcSourceKind;
  /** Only meaningful for `custom`; ignored otherwise. */
  customUrl: string;
}

/** The backend's JSON-RPC surface, reached through the frontend's `/api` proxy. */
export const BACKEND_RPC_PATH = "/api/shadow-rpc";
/**
 * The same surface with the entity reads answered from the backend's own
 * experimental entity index instead of a node. Only served when the
 * deployment enables it (`features.entityQueryIndex` in `/health`).
 */
export const BACKEND_INDEX_RPC_PATH = "/api/shadow-rpc/experimental";
/** The `rpc=` link value that selects the experimental index. */
export const INDEX_RPC_LINK_VALUE = "index";

/** The entity read methods the page depends on. `/health` lists which ones the backend forwards. */
export const ARKIV_READ_METHODS = ["arkiv_query", "arkiv_getEntityCount", "arkiv_getBlockTiming"] as const;

export const DEFAULT_RPC_TIMEOUT_MS = 15_000;

const SOURCE_KIND_STORAGE_KEY = "data.rpcSourceKind";
const CUSTOM_URL_STORAGE_KEY = "data.rpcCustomUrl";

export const DEFAULT_RPC_SOURCE: RpcSource = { kind: "backend", customUrl: "" };

export function isRpcSourceKind(value: string): value is RpcSourceKind {
  return value === "backend" || value === "index" || value === "custom";
}

/** Accepts absolute http(s) URLs only; a key baked into the path is allowed but the page never logs it. */
export function isValidRpcUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function rpcEndpointUrl(source: RpcSource): string {
  if (source.kind === "backend") return BACKEND_RPC_PATH;
  if (source.kind === "index") return BACKEND_INDEX_RPC_PATH;
  return source.customUrl.trim();
}

/**
 * What a shared link carries for the endpoint: the custom URL, the word
 * `index` for the experimental index, nothing for the default backend.
 */
export function rpcLinkValue(source: RpcSource): string {
  if (source.kind === "custom") return source.customUrl.trim();
  if (source.kind === "index") return INDEX_RPC_LINK_VALUE;
  return "";
}

/** The endpoint a link's `rpc=` value names, or null when it names none (or junk). */
export function rpcSourceFromLinkValue(value: string): RpcSource | null {
  const trimmed = value.trim();
  if (trimmed === INDEX_RPC_LINK_VALUE) return { kind: "index", customUrl: "" };
  return trimmed && isValidRpcUrl(trimmed) ? { kind: "custom", customUrl: trimmed } : null;
}

/** A displayable form of the endpoint with any credential in the URL blanked out. */
export function describeRpcEndpoint(source: RpcSource): string {
  if (source.kind === "backend") return BACKEND_RPC_PATH;
  if (source.kind === "index") return BACKEND_INDEX_RPC_PATH;
  const raw = source.customUrl.trim();
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
    }
    return url.toString();
  } catch {
    return raw;
  }
}

export function readStoredRpcSource(storage?: StorageLike | null): RpcSource {
  const kind = readStoredString(SOURCE_KIND_STORAGE_KEY, DEFAULT_RPC_SOURCE.kind, isRpcSourceKind, storage);
  const customUrl = readStoredString(CUSTOM_URL_STORAGE_KEY, "", () => true, storage);
  return { kind: kind as RpcSourceKind, customUrl };
}

export function writeStoredRpcSource(source: RpcSource, storage?: StorageLike | null): void {
  writeStoredString(SOURCE_KIND_STORAGE_KEY, source.kind, storage);
  writeStoredString(CUSTOM_URL_STORAGE_KEY, source.customUrl, storage);
}

/** Which of the Arkiv read methods the backend does not forward, per `/health`'s `features.jsonRpcPassthrough`. */
export function missingBackendMethods(forwarded: readonly string[] | false | null | undefined): string[] {
  if (!forwarded) return [...ARKIV_READ_METHODS];
  const set = new Set(forwarded);
  return ARKIV_READ_METHODS.filter((method) => !set.has(method));
}

/** A JSON-RPC failure, whether the node said no or the wire did. */
export class RpcCallError extends Error {
  readonly method: string;
  /** JSON-RPC error code when the node answered with one. */
  readonly code: number | undefined;
  /** HTTP status when the transport answered with a non-2xx. */
  readonly httpStatus: number | undefined;
  readonly data: unknown;

  constructor(
    method: string,
    message: string,
    options: { code?: number; httpStatus?: number; data?: unknown; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RpcCallError";
    this.method = method;
    this.code = options.code;
    this.httpStatus = options.httpStatus;
    this.data = options.data;
  }
}

export interface RpcCallDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Lets the caller cancel a call before the timeout does. */
  signal?: AbortSignal;
}

/** One signal that fires when either input does, without relying on `AbortSignal.any`. */
function combineSignals(a: AbortSignal, b: AbortSignal | undefined): AbortSignal {
  if (!b) return a;
  const controller = new AbortController();
  const forward = (signal: AbortSignal) => () => controller.abort(signal.reason);
  if (a.aborted) controller.abort(a.reason);
  else if (b.aborted) controller.abort(b.reason);
  else {
    a.addEventListener("abort", forward(a), { once: true });
    b.addEventListener("abort", forward(b), { once: true });
  }
  return controller.signal;
}

/** Whether a failure came from the caller cancelling the call. */
export function isAbortError(error: unknown): boolean {
  if (error instanceof RpcCallError) return isAbortError(error.cause);
  return error instanceof DOMException && error.name === "AbortError";
}

let nextRequestId = 1;

/**
 * One JSON-RPC 2.0 call. Errors carry the method so a failure in a multi-step
 * check can say which step broke, and the endpoint URL is never put into a
 * message because a custom URL may carry an API key.
 */
export async function callRpc<T = unknown>(
  source: RpcSource,
  method: string,
  params: unknown[] = [],
  deps: RpcCallDeps = {},
): Promise<T> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  const id = nextRequestId++;
  const endpoint = rpcEndpointUrl(source);

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: combineSignals(AbortSignal.timeout(timeoutMs), deps.signal),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    const cancelled = error instanceof DOMException && error.name === "AbortError";
    throw new RpcCallError(
      method,
      timedOut
        ? `${method} timed out after ${Math.round(timeoutMs / 1000)}s`
        : cancelled
          ? `${method} was cancelled`
          : `${method} could not reach the endpoint (${reason}). A custom URL also needs to allow browser (CORS) requests.`,
      { cause: error },
    );
  }

  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    const detail = jsonRpcErrorMessage(body) ?? text.slice(0, 200).trim();
    throw new RpcCallError(method, `${method} answered HTTP ${response.status}${detail ? `: ${detail}` : ""}`, {
      httpStatus: response.status,
      data: body,
    });
  }

  if (!body || typeof body !== "object") {
    throw new RpcCallError(method, `${method} answered with something that is not JSON-RPC`);
  }
  const envelope = body as { result?: unknown; error?: unknown };
  if (envelope.error !== undefined && envelope.error !== null) {
    const error = envelope.error as { code?: unknown; message?: unknown; data?: unknown };
    const code = typeof error.code === "number" ? error.code : undefined;
    const message = typeof error.message === "string" ? error.message : JSON.stringify(error);
    throw new RpcCallError(method, `${method} was rejected${code !== undefined ? ` (${code})` : ""}: ${message}`, {
      code,
      data: error.data,
    });
  }
  if (!("result" in envelope)) {
    throw new RpcCallError(method, `${method} answered without a result`);
  }
  return envelope.result as T;
}

function jsonRpcErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const error = (body as { error?: unknown }).error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  if (typeof error === "string") return error;
  return null;
}

/** Whether the node said it does not know the method (EIP-1474 `-32601`). */
export function isMethodNotFound(error: unknown): boolean {
  return error instanceof RpcCallError && error.code === -32601;
}

// ---------------------------------------------------------------------------
// Connection check

export type RpcCheckStepStatus = "ok" | "fail";

export interface RpcCheckStep {
  method: string;
  /** What the step establishes, in words. */
  purpose: string;
  status: RpcCheckStepStatus;
  durationMs: number;
  /** A short human rendering of the result, or the failure message. */
  summary: string;
  /** Set on failure when the node answered with a JSON-RPC code. */
  code?: number;
}

export interface BlockTiming {
  currentBlock: number;
  /** Unix seconds of the current block. */
  currentBlockTime: number;
  /** Seconds per block. */
  blockDurationSeconds: number;
}

export interface RpcCheckReport {
  endpoint: string;
  startedAtUtc: string;
  steps: RpcCheckStep[];
  /** Every Arkiv read method answered. */
  arkivOk: boolean;
  /** Every step, including the plain Ethereum ones, answered. */
  ok: boolean;
  chainId: number | null;
  clientVersion: string | null;
  timing: BlockTiming | null;
  entityCount: number | null;
  sampleEntityKey: string | null;
  sampleEntityOwner: string | null;
}

export interface RpcCheckDeps extends RpcCallDeps {
  now?: () => number;
}

interface ArkivBlockTimingResult {
  current_block: number;
  current_block_time: number;
  duration: number;
}

interface ArkivQueryResult {
  data: Array<{ key?: string; owner?: string }>;
  blockNumber: string;
  cursor?: string;
}

function hexToNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return Number(BigInt(value));
  throw new Error(`expected a hex quantity, got ${JSON.stringify(value)}`);
}

export function parseBlockTiming(value: unknown): BlockTiming {
  const raw = value as Partial<ArkivBlockTimingResult> | null;
  if (
    !raw ||
    typeof raw.current_block !== "number" ||
    typeof raw.current_block_time !== "number" ||
    typeof raw.duration !== "number"
  ) {
    throw new Error(`unexpected block timing shape: ${JSON.stringify(value).slice(0, 120)}`);
  }
  return {
    currentBlock: raw.current_block,
    currentBlockTime: raw.current_block_time,
    blockDurationSeconds: raw.duration,
  };
}

/** The node's view of the head block and its cadence, for turning block heights into dates. */
export async function fetchBlockTiming(source: RpcSource, deps: RpcCallDeps = {}): Promise<BlockTiming> {
  return parseBlockTiming(await callRpc(source, "arkiv_getBlockTiming", [], deps));
}

/**
 * Runs the calls the Data page needs, one after another, and keeps going after
 * a failure so the report shows every method's verdict rather than the first.
 */
export async function checkRpcSource(source: RpcSource, deps: RpcCheckDeps = {}): Promise<RpcCheckReport> {
  const now = deps.now ?? (() => Date.now());
  const report: RpcCheckReport = {
    endpoint: describeRpcEndpoint(source),
    startedAtUtc: new Date(now()).toISOString(),
    steps: [],
    arkivOk: false,
    ok: false,
    chainId: null,
    clientVersion: null,
    timing: null,
    entityCount: null,
    sampleEntityKey: null,
    sampleEntityOwner: null,
  };

  const run = async <T>(
    method: string,
    purpose: string,
    params: unknown[],
    decode: (result: unknown) => { value: T; summary: string },
  ): Promise<T | undefined> => {
    const started = now();
    try {
      const result = await callRpc(source, method, params, deps);
      const { value, summary } = decode(result);
      report.steps.push({ method, purpose, status: "ok", durationMs: now() - started, summary });
      return value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof RpcCallError ? error.code : undefined;
      report.steps.push({
        method,
        purpose,
        status: "fail",
        durationMs: now() - started,
        summary: message,
        ...(code !== undefined ? { code } : {}),
      });
      return undefined;
    }
  };

  report.chainId =
    (await run("eth_chainId", "The endpoint is a JSON-RPC node", [], (result) => {
      const value = hexToNumber(result);
      return { value, summary: `chain id ${value}` };
    })) ?? null;

  report.clientVersion =
    (await run("web3_clientVersion", "Which client answers", [], (result) => {
      if (typeof result !== "string") throw new Error("client version is not a string");
      return { value: result, summary: result };
    })) ?? null;

  report.timing =
    (await run("arkiv_getBlockTiming", "Block heights can be turned into dates", [], (result) => {
      const value = parseBlockTiming(result);
      return {
        value,
        summary: `block ${value.currentBlock} at ${new Date(value.currentBlockTime * 1000).toISOString()}, ${value.blockDurationSeconds}s per block`,
      };
    })) ?? null;

  report.entityCount =
    (await run("arkiv_getEntityCount", "The node counts live entities", [], (result) => {
      if (typeof result !== "number") throw new Error("entity count is not a number");
      return { value: result, summary: `${result} live entities` };
    })) ?? null;

  const sample = await run(
    "arkiv_query",
    "Entities can be queried",
    ["*", { limit: "0x1", select: { key: true, owner: true } }],
    (result) => {
      const raw = result as Partial<ArkivQueryResult> | null;
      if (!raw || !Array.isArray(raw.data)) throw new Error("query result carries no data array");
      const first = raw.data[0];
      const value = { key: first?.key ?? null, owner: first?.owner ?? null };
      const summary =
        raw.data.length === 0
          ? `no entities at block ${hexToNumber(raw.blockNumber)}`
          : `first entity ${value.key ?? "?"} at block ${hexToNumber(raw.blockNumber)}${raw.cursor ? ", more pages available" : ""}`;
      return { value, summary };
    },
  );
  report.sampleEntityKey = sample?.key ?? null;
  report.sampleEntityOwner = sample?.owner ?? null;

  const failed = new Set(report.steps.filter((step) => step.status === "fail").map((step) => step.method));
  report.arkivOk = ARKIV_READ_METHODS.every((method) => !failed.has(method));
  report.ok = failed.size === 0;
  return report;
}
