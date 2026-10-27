/**
 * Shared by the UDC explorer end-to-end scripts (docs/udc-e2e.md): the traffic
 * manifest, canonical entity state, and batched JSON-RPC against the node.
 *
 * Canonical attribute values are the text forms the decoder contract uses
 * (decimal integers, the node's dec text, lowercase hex, lowercase addresses);
 * a bytes value is never carried, only its size and keccak256.
 */
import { keccak256, type Hex } from "viem";

export const PERMANENT = (1n << 64n) - 1n;
export const PERMANENT_TEXT = PERMANENT.toString();

/** Every key of the SDK's RpcSelect: the full projection arkiv_query can return. */
export const FULL_SELECT = {
  key: true,
  owner: true,
  creator: true,
  createdAt: true,
  updatedAt: true,
  expiresAt: true,
  creationFlags: true,
  attributeSchema: true,
  attributes: true,
} as const;

// ---------------------------------------------------------------------------
// Manifest written by udcExplorerTraffic.ts, read by verifyUdcExplorer.ts

export interface ManifestTx {
  label: string;
  hash: Hex;
  from: Hex;
  to: Hex | null;
  kind: "execute" | "transfer";
  expectStatus: "success" | "reverted";
  /** Operation kinds in the transaction, in batch order. */
  ops: string[];
  block: number;
  gasUsed: string;
  rentFee: string;
}

export type FailureOutcome = "mined-status-0" | "refused-at-admission" | "unexpected-success";

export interface ManifestFailure {
  case: string;
  /** What the node should refuse it with (a revert name or an admission message). */
  expectedError: string;
  /** The explicit gas limit it was sent with, or null for the SDK's own estimate. */
  gasLimit: string | null;
  outcome: FailureOutcome;
  hash: Hex | null;
  /** Why it failed, as the SDK reported it (short; never calldata). */
  reason: string;
  nonceAdvanced: boolean;
}

export interface ExpectedAttribute {
  type: string;
  indexed: boolean;
  /** Canonical text; absent for bytes. */
  value?: string;
  size?: number;
  keccak256?: Hex;
}

export type EntityExpectation =
  | { exists: false; why: "expired" | "deleted" | "never-created"; expiresAt?: string }
  | {
      exists: true;
      owner: Hex;
      creator: Hex;
      expiresAt: string;
      permanent: boolean;
      creationFlags: number;
      attributes: Record<string, ExpectedAttribute>;
    };

export interface ManifestEntity {
  label: string;
  key: Hex;
  expect: EntityExpectation;
}

export interface Manifest {
  version: 1;
  generatedAt: string;
  chainId: number;
  rpcUrl: string;
  genesisHash: string | null;
  accounts: Record<string, Hex>;
  /** Blocks worth comparing at: traffic start, mid-run, first block past the expiry, end. */
  checkpoints: { start: number; mid: number; afterExpiry: number; end: number };
  transactions: ManifestTx[];
  failures: ManifestFailure[];
  entities: ManifestEntity[];
  /** Queries that must match nothing at `end` (state a reverted batch would have written). */
  absentQueries: { query: string; reason: string }[];
  /** Distinctive bytes contents written on chain: none may appear in the explorer's database. */
  bytesMarkers: { label: string; text: string; hex: Hex }[];
}

// ---------------------------------------------------------------------------
// Canonical entity state

export interface RpcAttribute {
  name: string;
  type: string;
  value: unknown;
}

export interface RpcEntity {
  key?: Hex;
  owner?: Hex;
  creator?: Hex;
  createdAt?: Hex;
  updatedAt?: Hex;
  expiresAt?: Hex;
  creationFlags?: { readonly?: boolean; permissionlessExtension?: boolean; raw: number } | number;
  attributeSchema?: { name: string; type: string; indexed?: boolean }[];
  attributes?: RpcAttribute[];
}

export interface CanonicalAttribute extends ExpectedAttribute {
  name: string;
  /** null when the source did not say (an index without the indexed flag). */
  indexed: boolean;
  indexedKnown: boolean;
}

export interface CanonicalEntity {
  key: Hex;
  owner: Hex;
  creator: Hex;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  permanent: boolean;
  creationFlags: number;
  attributes: CanonicalAttribute[];
}

const lower = (value: unknown): Hex => String(value).toLowerCase() as Hex;
const quantityText = (value: unknown): string =>
  value === undefined || value === null ? "" : BigInt(value as string).toString();

/** One attribute value in canonical text, or null for bytes (carried as size + keccak). */
export function canonicalValue(type: string, value: unknown): string | null {
  switch (type) {
    case "bool":
      return String(value === true || value === "true" || value === 1);
    case "i32":
    case "u64":
    case "u256":
      return BigInt(value as string | number).toString();
    case "addr":
    case "bytes32":
    case "key":
      return lower(value);
    case "bytes":
      return null;
    default:
      return String(value);
  }
}

export function canonicalEntity(raw: RpcEntity): CanonicalEntity {
  const schema = new Map((raw.attributeSchema ?? []).map((entry) => [entry.name, entry]));
  const attributes = (raw.attributes ?? []).map((attribute): CanonicalAttribute => {
    const entry = schema.get(attribute.name);
    const out: CanonicalAttribute = {
      name: attribute.name,
      type: attribute.type,
      indexed: entry?.indexed === true,
      indexedKnown: typeof entry?.indexed === "boolean",
    };
    if (attribute.type === "bytes") {
      const hex = lower(attribute.value);
      out.size = (hex.length - 2) / 2;
      out.keccak256 = keccak256(hex);
    } else {
      out.value = canonicalValue(attribute.type, attribute.value) ?? undefined;
    }
    return out;
  });
  attributes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const flags = raw.creationFlags;
  const expiresAt = quantityText(raw.expiresAt);
  return {
    key: lower(raw.key),
    owner: lower(raw.owner),
    creator: lower(raw.creator),
    createdAt: quantityText(raw.createdAt),
    updatedAt: quantityText(raw.updatedAt),
    expiresAt,
    permanent: expiresAt === PERMANENT_TEXT,
    creationFlags: typeof flags === "number" ? flags : flags?.raw ?? -1,
    attributes,
  };
}

/** Differences between a canonical entity and what the manifest expects of it. */
export function expectationDiffs(entity: CanonicalEntity | undefined, expect: EntityExpectation): string[] {
  if (!expect.exists) return entity ? [`expected absent (${expect.why}), found live`] : [];
  if (!entity) return ["expected live, not found"];
  const diffs: string[] = [];
  const field = (name: string, got: unknown, want: unknown) => {
    if (got !== want) diffs.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  };
  field("owner", entity.owner, expect.owner.toLowerCase());
  field("creator", entity.creator, expect.creator.toLowerCase());
  field("expiresAt", entity.expiresAt, expect.expiresAt);
  field("permanent", entity.permanent, expect.permanent);
  field("creationFlags", entity.creationFlags, expect.creationFlags);
  const byName = new Map(entity.attributes.map((a) => [a.name, a]));
  for (const [name, want] of Object.entries(expect.attributes)) {
    const got = byName.get(name);
    if (!got) {
      diffs.push(`attribute ${name}: missing`);
      continue;
    }
    field(`${name}.type`, got.type, want.type);
    field(`${name}.indexed`, got.indexedKnown ? got.indexed : "unknown", want.indexed);
    if (want.value !== undefined) field(`${name}.value`, got.value, want.value);
    if (want.size !== undefined) field(`${name}.size`, got.size, want.size);
    if (want.keccak256 !== undefined) field(`${name}.keccak256`, got.keccak256, want.keccak256);
  }
  for (const name of byName.keys()) {
    if (!(name in expect.attributes)) diffs.push(`attribute ${name}: unexpected`);
  }
  return diffs;
}

// ---------------------------------------------------------------------------
// JSON-RPC

export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
    readonly data?: unknown,
  ) {
    super(`${method}: ${code ?? "?"} ${message}`);
  }
}

/** The node's JSON-RPC batch cap (arkiv-node signed/rpc.rs). */
export const RPC_BATCH_CAP = 64;

export async function rpcCall<T = any>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const [result] = await rpcBatch<T>(url, [{ method, params }]);
  if (result instanceof RpcError) throw result;
  return result as T;
}

/** Calls in batches of at most RPC_BATCH_CAP; each result is the value or an RpcError. */
export async function rpcBatch<T = any>(
  url: string,
  calls: { method: string; params: unknown[] }[],
  options: { timeoutMs?: number; cap?: number; headers?: Record<string, string> } = {},
): Promise<(T | RpcError)[]> {
  const out: (T | RpcError)[] = [];
  const cap = Math.min(options.cap ?? RPC_BATCH_CAP, RPC_BATCH_CAP);
  for (let start = 0; start < calls.length; start += cap) {
    const chunk = calls.slice(start, start + cap);
    const body = chunk.map((call, index) => ({ jsonrpc: "2.0", id: index, method: call.method, params: call.params }));
    let answers: any;
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...options.headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
      // The node answers 429 while busy, before doing anything: only that is retried.
      if (response.status === 429 && attempt < 50) {
        await Bun.sleep(100);
        continue;
      }
      const text = await response.text();
      try {
        answers = JSON.parse(text);
      } catch {
        throw new Error(`${url}: HTTP ${response.status}: ${text.slice(0, 300)}`);
      }
      break;
    }
    if (!Array.isArray(answers)) {
      const error = answers?.error;
      throw new RpcError(chunk[0]!.method, error?.code, error?.message ?? JSON.stringify(answers).slice(0, 300));
    }
    const byId = new Map(answers.map((answer: any) => [answer.id, answer]));
    chunk.forEach((call, index) => {
      const answer: any = byId.get(index);
      if (!answer) out.push(new RpcError(call.method, undefined, "no answer in batch"));
      else if (answer.error) out.push(new RpcError(call.method, answer.error.code, answer.error.message, answer.error.data));
      else out.push(answer.result as T);
    });
  }
  return out;
}

export const hexBlock = (block: number | bigint): Hex => `0x${BigInt(block).toString(16)}` as Hex;

/** Every entity matching `query` at `atBlock`, following cursors. */
export async function queryAll(
  url: string,
  query: string,
  atBlock: number,
  select: Record<string, unknown> = FULL_SELECT,
  pageSize = 64,
): Promise<RpcEntity[]> {
  const out: RpcEntity[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10_000; page++) {
    const options: Record<string, unknown> = { atBlock: hexBlock(atBlock), select, limit: hexBlock(pageSize) };
    if (cursor) options.cursor = cursor;
    const result = await rpcCall<{ data: RpcEntity[]; cursor?: string }>(url, "arkiv_query", [query, options]);
    out.push(...result.data);
    if (!result.cursor || result.data.length === 0) return out;
    cursor = result.cursor;
  }
  throw new Error(`arkiv_query ${query}: more than 10000 pages`);
}

/** Deep equality on JSON values, insensitive to object key order. */
// ---------------------------------------------------------------------------
// Bytes the index withholds

/** A bytes attribute the node holds, as the index should record it. */
export interface ExpectedBytes {
  name: string;
  size: number;
  keccak256: string;
}

export interface SplitBytes {
  /** The index's entity with every bytes value blanked. */
  got: RpcEntity;
  /** The node's entity with every bytes value blanked. */
  want: RpcEntity;
  /** The node's size and keccak256 per bytes attribute. */
  expected: ExpectedBytes[];
  /** bytes attributes the index answered with a value: it must never hold one. */
  leaked: string[];
}

/**
 * The index withholds bytes contents: where the node answers a bytes
 * attribute with its content (`0x` data), the index answers `value: null`.
 * Blanks every bytes value on both sides so the rest compares exactly, and
 * returns the node's size and keccak256 per bytes attribute (to check against
 * the index's own record) and the bytes the index did not withhold.
 */
export function splitBytes(got: RpcEntity, want: RpcEntity): SplitBytes {
  const blank = (entity: RpcEntity): RpcEntity =>
    entity.attributes
      ? { ...entity, attributes: entity.attributes.map((a) => (a.type === "bytes" ? { ...a, value: null } : a)) }
      : entity;
  const expected = (want.attributes ?? [])
    .filter((a) => a.type === "bytes" && typeof a.value === "string")
    .map((a) => {
      const hex = String(a.value).toLowerCase() as Hex;
      return { name: a.name, size: (hex.length - 2) / 2, keccak256: keccak256(hex) };
    });
  const leaked = (got.attributes ?? []).filter((a) => a.type === "bytes" && a.value !== null).map((a) => a.name);
  return { got: blank(got), want: blank(want), expected, leaked };
}

/**
 * Whether the index withheld every bytes value: `fail` with the names when it
 * returned content, `pass` when there were bytes and it withheld them all,
 * `none` when the entity has no bytes to judge.
 */
export function withheldVerdict(split: Pick<SplitBytes, "expected" | "leaked">): { outcome: "pass" | "fail" | "none"; leaked: string[] } {
  if (split.leaked.length > 0) return { outcome: "fail", leaked: split.leaked };
  return { outcome: split.expected.length > 0 ? "pass" : "none", leaked: [] };
}

export function jsonEqual(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_, inner) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
      : inner,
  );
}
