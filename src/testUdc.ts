/**
 * Test fixtures for the UDC model: operations shaped like
 * arkiv-transaction-decoder v0.3 answers them, the parsed form the scanner
 * stores, and transactions recorded from the live UDC chain (chain 7706815,
 * `testFixtures/udcLiveBlocks.json`, derived from the decoder's live goldens:
 * receipts, decodes and the node's `arkiv_query` view of every touched
 * entity, with bytes values reduced to their size and keccak256).
 */
import { readFileSync } from "node:fs";
import type { ArkivOperation, ArkivOperationAttribute } from "./arkivOperations";

/** One attribute triple as the decoder reports it. */
export function udcAttribute(
  name: string,
  type: string,
  value: string | number | boolean | null,
  options: { indexed?: boolean; size?: number; keccak256?: string } = {},
): ArkivOperationAttribute {
  const ids: Record<string, number> = {
    tombstone: 0, bool: 1, i32: 2, u64: 3, u256: 4, dec: 5, bytes32: 6, bytes: 7, str: 8, addr: 9, key: 10,
  };
  const indexed = options.indexed ?? (type !== "bytes" && type !== "tombstone");
  const base = ids[type];
  if (base === undefined) throw new Error(`unknown type ${type}`);
  return {
    name,
    typeId: base | (indexed ? 0x80 : 0),
    type,
    indexed,
    value,
    size: options.size ?? (type === "str" ? Buffer.byteLength(String(value), "utf8") : type === "tombstone" ? 0 : 32),
    ...(options.keccak256 !== undefined ? { keccak256: options.keccak256 } : {}),
  };
}

/** A decoder v0.3 operation object (the JSON the decoder sends), every field present. */
export function decoderOperationJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationType: 1,
    operation: "create",
    entityKey: null,
    salt: "42",
    creationFlags: 0,
    expiresAt: "0",
    minLifetime: "1800",
    permanent: false,
    newOwner: null,
    bytesSize: 0,
    attributes: [udcAttribute("project", "str", "demo")],
    ...overrides,
  };
}

/** A whole v0.3 `/decode` response. */
export function decoderResponseJson(operations: unknown[]): Record<string, unknown> {
  return { functionName: "execute", format: "udc", operations };
}

/** A parsed operation as the scanner hands it to storage. */
export function udcOperation(overrides: Partial<ArkivOperation> & { opIndex: number; operationType: number }): ArkivOperation {
  const names: Record<number, string> = { 1: "create", 2: "patch", 3: "extend", 4: "transfer", 5: "delete" };
  const create = overrides.operationType === 1;
  const expiring = create || overrides.operationType === 3;
  const attributes = overrides.attributes ?? (create || overrides.operationType === 2 ? [udcAttribute("project", "str", "demo")] : []);
  return {
    operation: names[overrides.operationType] ?? `unknown(${overrides.operationType})`,
    entityKey: null,
    salt: create ? "1" : null,
    creationFlags: create ? 0 : null,
    expiresAt: expiring ? "0" : null,
    minLifetime: expiring ? "100" : null,
    newOwner: null,
    bytesSize: 0,
    schemaName: null,
    ...overrides,
    attributes,
  };
}

export interface LiveNodeEntity {
  key: string;
  owner: string;
  creator: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  creationFlags: { raw: number; readonly: boolean; permissionlessExtension: boolean };
  attributeSchema: Array<{ name: string; type: string; indexed: boolean }>;
  /** bytes values are `null` here, with `size` and `keccak256` beside them. */
  attributes: Array<{ name: string; type: string; value: unknown; size?: number; keccak256?: string }>;
}

export interface LiveTransaction {
  hash: `0x${string}`;
  transactionIndex: number;
  from: `0x${string}`;
  to: `0x${string}`;
  status: `0x${string}`;
  rentFee: `0x${string}`;
  inputBytes: number;
  logs: Array<{ topics: `0x${string}`[]; data: `0x${string}` }>;
  /** The decoder's answer for this transaction's calldata. */
  decoded: { functionName: string; format: string; operations: Array<Record<string, unknown>> };
  nodeViews: Array<{ key: string; atBlock: number; entity: LiveNodeEntity | null }>;
}

export interface LiveBlock {
  blockNumber: number;
  blockHash: string;
  transactions: LiveTransaction[];
}

export const LIVE_BLOCKS = JSON.parse(
  readFileSync(new URL("./testFixtures/udcLiveBlocks.json", import.meta.url), "utf8"),
) as LiveBlock[];

export function liveBlock(blockNumber: number): LiveBlock {
  const block = LIVE_BLOCKS.find((candidate) => candidate.blockNumber === blockNumber);
  if (!block) throw new Error(`no live fixture for block ${blockNumber}`);
  return block;
}
