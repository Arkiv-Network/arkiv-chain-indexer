import { authenticatedFetch } from "./authClient";
import { envValues } from "./runtimeConfig";

export interface NativeIdentity {
  sourceId: string;
  runId: string;
  genesisHash: string;
  chainId: string;
}
export interface NativeSnapshot {
  height: string;
  hash: string;
  stateRoot: string;
}
export interface NativeWorkload {
  version: number;
  seed: string;
  blockPeriodMs: string;
  payloadBytes: number;
  extraRowsPerBlock: number;
}
/** A node's own public status as the backend observed or probed it. */
export interface NativeSourceStatus extends NativeIdentity {
  capabilities?: { profile: string; layoutVersion: number; codecVersion: number; scalarTypes: string[]; systemEquality: string[]; sdkRpcCompatible: boolean; signatures: boolean };
  role: "producer" | "full" | "light";
  head: NativeSnapshot;
  paused: boolean;
  health: string;
  configRevision: string;
  workload: NativeWorkload;
  memory: Record<string, unknown>;
  durability?: string;
  observedPeerHeight?: string;
  coverage?: { from: string; through: string; complete: boolean };
  /** Present only when the node knows its retained file; never a fabricated zero. */
  storage?: { fileBytes: string };
}
export type NodeRole = "producer" | "full" | "light";
export interface NodeReport {
  role: NodeRole;
  configured: boolean;
  available: boolean;
  error: string | null;
  latencyMs: number | null;
  status: NativeSourceStatus | null;
}
export interface NativeNodes {
  identity: NativeIdentity;
  verification: "unverified-projection";
  nodes: Record<NodeRole, NodeReport>;
  explorer: {
    health: string;
    indexed: NativeSnapshot | null;
    observed: NativeSourceStatus | null;
    counters: Record<string, string>;
    schema: string;
    storage: { relationBytes: string | null };
  };
  controlAvailable: boolean;
}
export interface NativeStatus {
  identity: NativeIdentity;
  authentication: "unsigned-simulator-v1";
  producer: NativeSourceStatus | null;
  indexed: NativeSnapshot | null;
  health: string;
  controlAvailable: boolean;
  coverage: { from: string; through: string | null; complete: boolean };
  counters?: Record<string, string>;
}
export type NativeRow = Record<string, unknown>;
export interface NativePage {
  identity: NativeIdentity;
  snapshot: NativeSnapshot;
  verification: "unverified-projection";
  rows: NativeRow[];
  nextCursor: string | null;
}
export interface EqSelection {
  height: string;
  namespace: string;
  attribute: string;
  valueType: "bool" | "i64" | "i32" | "u64" | "u256" | "dec" | "bytes32" | "str" | "addr" | "key";
  value: string | boolean;
  limit: number;
  cursor: string | null;
}
export interface VerifiedPage extends NativeIdentity {
  verification: "proof verified against trusted simulator root; unsigned source";
  snapshot: NativeSnapshot;
  query: Omit<EqSelection, "height" | "cursor">;
  rows: NativeRow[];
  continuation: string | null;
  postingCount: number;
  /** The verifying light process's own telemetry about the complete proof it checked. */
  diagnostics?: {
    verifier: string;
    proofBytes: string;
    fetchMs: string;
    verifyMs: string;
  };
}

export type UiMode = "explorer" | "debug" | "fullnode" | "lightnode";
/** Which native view this deployment serves; the explorer unless configured otherwise. */
export function uiMode(): UiMode {
  const mode = envValues().VITE_UI_MODE;
  return mode === "debug" || mode === "fullnode" || mode === "lightnode" ? mode : "explorer";
}
export type VerifierLocation = "server" | "local";
/** Where the light process behind /local-sim runs relative to this browser.
 * Only an explicit deployment setting may claim it is local; the default never does. */
export function verifierLocation(): VerifierLocation {
  return envValues().VITE_SIMULATOR_VERIFIER === "local" ? "local" : "server";
}
export function publicNodeUrl(): string {
  return envValues().VITE_SIMULATOR_PUBLIC_NODE_URL ?? "";
}
export function peerUiUrl(): string {
  return envValues().VITE_SIMULATOR_PEER_UI_URL ?? "";
}
/** Wording that never claims browser-local verification for a server-side verifier. */
export function verifierText(location: VerifierLocation = verifierLocation()) {
  return location === "local"
    ? {
        button: "Verify Eq locally",
        badge: "Proof verified locally against trusted simulator root; unsigned source",
        where: "a light process running on this machine",
        location: "local light process",
      }
    : {
        button: "Verify Eq (server-side)",
        badge: "Proof verified server-side against trusted simulator root; unsigned source",
        where: "the deployment's light follower, not this browser",
        location: "server-side light follower",
      };
}

export class NativeHttpError extends Error {
  constructor(
    readonly status: number,
    code: string,
  ) {
    super(code);
  }
}

export function retrySameControl(error: unknown): boolean {
  return !(
    error instanceof NativeHttpError &&
    [400, 401, 403, 404, 409, 413, 422].includes(error.status)
  );
}

export async function boundedJson(
  response: Response,
  cap = 8 * 1024 * 1024,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("EmptyResponse");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > cap) throw new Error("ResponseTooLarge");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const value: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(body),
  );
  if (!response.ok) {
    const code =
      value && typeof value === "object"
        ? "code" in value
          ? String(value.code)
          : "error" in value
            ? String(value.error)
            : `HTTP_${response.status}`
        : `HTTP_${response.status}`;
    throw new NativeHttpError(
      response.status,
      /^[A-Za-z_0-9]{1,80}$/.test(code) ? code : "RequestFailed",
    );
  }
  return value;
}

function deadline(signal?: AbortSignal): AbortSignal {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
    : AbortSignal.timeout(10000);
}

export async function fetchSourceKind(
  signal?: AbortSignal,
): Promise<"ethereum" | "native-simulator"> {
  const data = await boundedJson(
    await fetch("/api/health", {
      signal: deadline(signal),
      credentials: "same-origin",
    }),
    128 * 1024,
  );
  if (!data || typeof data !== "object") throw new Error("InvalidCapabilities");
  const kind = "sourceKind" in data ? data.sourceKind : "ethereum";
  if (kind === "arkiv-native-simulator" || kind === "native-simulator")
    return "native-simulator";
  if (kind === "ethereum") return "ethereum";
  throw new Error("UnsupportedSourceKind");
}

export async function nativeGet(
  path: string,
  params: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const query = new URLSearchParams(params);
  return boundedJson(
    await fetch(`/api/sim/v1/${path}${query.size ? `?${query}` : ""}`, {
      signal: deadline(signal),
      credentials: "same-origin",
    }),
  );
}

export async function nativeNodes(signal?: AbortSignal): Promise<NativeNodes> {
  const data = await boundedJson(
    await fetch("/api/sim/v1/nodes", {
      signal: deadline(signal),
      credentials: "same-origin",
    }),
    1024 * 1024,
  );
  if (
    !data ||
    typeof data !== "object" ||
    !("nodes" in data) ||
    !("explorer" in data) ||
    !("identity" in data) ||
    (data as { verification?: unknown }).verification !== "unverified-projection"
  )
    throw new Error("InvalidTopologyResponse");
  return data as NativeNodes;
}

export async function nativeQuery(
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  return boundedJson(
    await fetch("/api/sim/v1/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      signal: deadline(signal),
    }),
  );
}

export async function nativeControl(
  body: unknown,
  csrfToken: string,
): Promise<unknown> {
  return boundedJson(
    await authenticatedFetch(
      "/api/admin/sim/v1/control",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: deadline(),
      },
      csrfToken,
    ),
  );
}

export function sameIdentity(value: unknown, b: NativeIdentity): boolean {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  return (
    a.sourceId === b.sourceId &&
    a.runId === b.runId &&
    a.genesisHash === b.genesisHash &&
    a.chainId === b.chainId
  );
}

export function validateVerifiedPage(
  data: unknown,
  identity: NativeIdentity,
  request: EqSelection,
): VerifiedPage {
  if (!data || typeof data !== "object")
    throw new Error("InvalidVerifierResponse");
  const p = data as VerifiedPage;
  if (
    p.verification !==
      "proof verified against trusted simulator root; unsigned source" ||
    !sameIdentity(p, identity) ||
    !p.snapshot ||
    p.snapshot.height !== request.height ||
    !/^0x[0-9a-f]{64}$/.test(p.snapshot.hash) ||
    !/^0x[0-9a-f]{64}$/.test(p.snapshot.stateRoot) ||
    !p.query ||
    !Array.isArray(p.rows) ||
    p.rows.length > request.limit ||
    p.query.namespace !== request.namespace ||
    p.query.attribute !== request.attribute ||
    p.query.valueType !== request.valueType ||
    p.query.value !== request.value ||
    p.query.limit !== request.limit ||
    (p.continuation !== null &&
      (typeof p.continuation !== "string" ||
        p.continuation.length > 4096 ||
        !/^0x[0-9a-f]+$/.test(p.continuation))) ||
    !Number.isInteger(p.postingCount) ||
    p.postingCount < 0 ||
    p.postingCount > 4096
  )
    throw new Error("VerifierBindingMismatch");
  return p;
}

/** This fixed same-origin path reaches the operator-configured local Rust verifier,
 * never the remote SQL API or an arbitrary URL supplied by a page/query. */
export async function localVerifiedQuery(
  identity: NativeIdentity,
  request: EqSelection,
  signal?: AbortSignal,
): Promise<VerifiedPage> {
  const status = await boundedJson(
    await fetch("/local-sim/v1/status", {
      credentials: "omit",
      signal: deadline(signal),
    }),
    128 * 1024,
  );
  if (
    !status ||
    typeof status !== "object" ||
    !("role" in status) ||
    status.role !== "light" ||
    !sameIdentity(status, identity)
  ) {
    throw new Error("LocalVerifierIdentityMismatch");
  }
  const data = await boundedJson(
    await fetch("/local-sim/v1/query/verified", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "omit",
      body: JSON.stringify(request),
      signal: deadline(signal),
    }),
  );
  return validateVerifiedPage(data, identity, request);
}

export function displayNative(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
