// Loads one bytes attribute's content from a node, on demand. The index keeps
// only a bytes value's size and keccak256; the content is read here, by the
// browser, from the node (never through the indexer backend), and checked
// against the hash the index recorded.

import { callRpc, type RpcCallDeps, type RpcSource } from "./dataRpc";
import { hexToBytes, keccak256Hex } from "./keccak";

export interface LoadedBytes {
  /** `0x` hex of the content. */
  content: string;
  size: number;
  keccak256: string;
  /** The block the node read at. */
  blockNumber: number | null;
  /** Whether the content hashes to the keccak256 the caller expected; null when none was given. */
  matches: boolean | null;
}

export interface LoadBytesRequest {
  entityKey: string;
  name: string;
  /** Read at this block (a past version); the node's head when omitted. */
  atBlock?: number;
  /** The keccak256 the index recorded, to check the content against. */
  expectedKeccak256?: string;
}

const NODE_SOURCE: RpcSource = { kind: "node", customUrl: "" };

export class BytesNotFoundError extends Error {}

export async function loadBytesFromNode(
  request: LoadBytesRequest,
  source: RpcSource = NODE_SOURCE,
  deps: RpcCallDeps = {},
): Promise<LoadedBytes> {
  const options: Record<string, unknown> = {
    select: { key: true, attributes: { [request.name]: true } },
    limit: "0x1",
  };
  if (request.atBlock !== undefined) options.atBlock = `0x${request.atBlock.toString(16)}`;
  const result = await callRpc<{ data?: unknown; blockNumber?: unknown }>(
    source,
    "arkiv_query",
    [`$key = key(${request.entityKey.toLowerCase()})`, options],
    deps,
  );
  const entity = Array.isArray(result?.data) ? (result.data[0] as { attributes?: unknown } | undefined) : undefined;
  if (!entity) throw new BytesNotFoundError("the node has no such entity at that block");
  const attributes = Array.isArray(entity.attributes) ? (entity.attributes as Array<{ name?: unknown; type?: unknown; value?: unknown }>) : [];
  const attribute = attributes.find((item) => item?.name === request.name);
  if (!attribute) throw new BytesNotFoundError(`the entity has no attribute ${request.name} at that block`);
  if (attribute.type !== "bytes" || typeof attribute.value !== "string") {
    throw new BytesNotFoundError(`${request.name} is ${String(attribute.type)} there, not bytes`);
  }
  const bytes = hexToBytes(attribute.value);
  const keccak256 = keccak256Hex(bytes);
  const blockNumber = typeof result.blockNumber === "string" && /^0x[0-9a-fA-F]+$/.test(result.blockNumber)
    ? Number(BigInt(result.blockNumber))
    : null;
  return {
    content: attribute.value.toLowerCase(),
    size: bytes.length,
    keccak256,
    blockNumber,
    matches: request.expectedKeccak256 ? request.expectedKeccak256.toLowerCase() === keccak256 : null,
  };
}

/** The content as UTF-8 text when it is printable text, else null. */
export function bytesAsText(content: string): string | null {
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(content);
  } catch {
    return null;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  // Mostly-printable only: control characters other than whitespace mean binary.
  const control = text.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g)?.length ?? 0;
  return control === 0 ? text : null;
}
