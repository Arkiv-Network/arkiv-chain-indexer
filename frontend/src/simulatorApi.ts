import { authenticatedFetch } from "./authClient";

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
export interface NativeStatus {
  identity: NativeIdentity;
  authentication: "unsigned-simulator-v1";
  producer: {
    head: NativeSnapshot;
    paused: boolean;
    health: string;
    configRevision: string;
    workload: NativeWorkload;
    memory: Record<string, unknown>;
  } | null;
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
  valueType: "bool" | "i64" | "u64" | "str";
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
