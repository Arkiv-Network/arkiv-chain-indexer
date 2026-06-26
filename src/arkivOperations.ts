import { shouldIgnoreTransaction } from "./transactionFilter";
import type { Hex, RpcBlock } from "./types";

export const ARKIV_REGISTRY_ADDRESS = "0x4400000000000000000000000000000000000044";

const arkivRegistryAddress = ARKIV_REGISTRY_ADDRESS.toLowerCase();

export interface ArkivOperationAttribute {
  key: string;
  valueType: number;
  /** "uint" | "string" | "entityKey" | "unknown" */
  valueTypeName: string;
  value: string;
}

/**
 * Offline EIP-191 verification verdict the decoder returns for a payload
 * reference. Mirrors the decoder's `ReferenceVerification` (reference.rs) and
 * the on-chain precompile: `valid` is true only when every check the chain
 * would make passed, and `signerTrusted` records whether the recovered signer
 * is in the trusted payload-provider allowlist for the decode `chainId`.
 */
export interface ArkivReferenceVerification {
  valid: boolean;
  signerTrusted: boolean;
  chainId: number;
  claimedSigner: string | null;
  recoveredSigner: string | null;
  messageHash: string | null;
  errors: string[];
}

/**
 * Parsed v1 payload reference embedded in an operation payload. Under
 * reference mode the entity bytes never travel on-chain; this carries only the
 * provider's content-addressed receipt metadata (id/checksum/sizeBytes/
 * signature) — never the entity bytes. Kept loose so a parsed-but-evolving
 * reference still round-trips through storage as jsonb.
 */
export interface ArkivPayloadReference {
  kind: string;
  version: number;
  provider: string;
  id: string;
  namespace: string;
  contentType?: string;
  checksum: string;
  sizeBytes: number;
  submittedAt: string;
  nonce: string;
  payment: number;
  signature: {
    scheme: string;
    signer: string;
    receipt: Record<string, unknown>;
    messageHash: string;
    signature: string;
    r: string;
    s: string;
    v: number;
  };
}

export interface ArkivOperation {
  /** 0-based index of the operation within the transaction's execute() call. */
  opIndex: number;
  /** 1=create 2=update 3=extend 4=transfer 5=delete 6=expire */
  operationType: number;
  /** "create" | "update" | "extend" | "transfer" | "delete" | "expire" | "unknown(N)" */
  operation: string;
  entityKey: string | null;
  contentType: string | null;
  /** Size only — the payload bytes/hex/text are never stored anywhere. */
  payloadSizeBytes: number;
  attributes: ArkivOperationAttribute[];
  expiresAtBlocks: number;
  newOwner: string | null;
  /** True when the payload is a v1 payload reference (decoder `payload.isReference`). */
  isReference: boolean;
  /** Parsed v1 reference metadata; null unless this op carries a payload reference. */
  payloadReference: ArkivPayloadReference | null;
  /** Offline EIP-191 verification verdict; null unless a reference was present. */
  referenceVerification: ArkivReferenceVerification | null;
  /** Set when contentType is a reference but the payload failed to parse. */
  referenceError: string | null;
}

export interface ArkivOperationSummaryEntry {
  operation: string;
  operationType: number;
  count: number;
}

export interface TransactionArkivOperations {
  position: number;
  hash: Hex;
  operations: ArkivOperation[];
}

/**
 * Client for the atlas-transaction-decoder microservice. A 400 response means
 * the calldata is not an Arkiv execute() call (not an error); any other failure
 * throws so the caller retries the whole block and no silent gaps are created.
 *
 * `chainId`, when set, is sent with each request so the decoder verifies any
 * embedded payload reference against the trusted-signer allowlist for the
 * scanner's actual chain (the decoder otherwise falls back to its own default).
 */
export class ArkivDecoderClient {
  constructor(
    readonly baseUrl: string,
    readonly chainId?: number,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async decodeCalldata(data: Hex): Promise<ArkivOperation[] | null> {
    const url = `${this.baseUrl}/decode`;
    const body =
      this.chainId !== undefined
        ? JSON.stringify({ data, chainId: this.chainId })
        : JSON.stringify({ data });
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    } catch (error) {
      throw new Error(
        `Arkiv decoder request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (response.status === 400) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Arkiv decoder at ${url} returned HTTP ${response.status}`);
    }

    return parseDecoderResponse(await response.json());
  }
}

/**
 * Decode the Arkiv operations of every registry transaction in `block`.
 * `position` is the index in `block.transactions` BEFORE filtering — the same
 * convention as src/blockInspector.ts — so rows align with the
 * `(block_number, position)` primary key of the transactions table.
 */
export async function decodeBlockArkivOperations(
  block: RpcBlock,
  client: ArkivDecoderClient,
): Promise<TransactionArkivOperations[]> {
  const results: TransactionArkivOperations[] = [];
  for (const [position, transaction] of block.transactions.entries()) {
    if (shouldIgnoreTransaction(transaction)) {
      continue;
    }
    if (!transaction.to || transaction.to.toLowerCase() !== arkivRegistryAddress) {
      continue;
    }
    if (!transaction.input || transaction.input === "0x") {
      continue;
    }
    const operations = await client.decodeCalldata(transaction.input);
    if (operations !== null && operations.length > 0) {
      results.push({ position, hash: transaction.hash, operations });
    }
  }
  return results;
}

function parseDecoderResponse(body: unknown): ArkivOperation[] {
  if (!isRecord(body) || !Array.isArray(body.operations)) {
    throw new Error("Arkiv decoder returned an unexpected response shape");
  }
  return body.operations.map((operation, index) => parseDecoderOperation(operation, index));
}

function parseDecoderOperation(operation: unknown, opIndex: number): ArkivOperation {
  if (
    !isRecord(operation) ||
    typeof operation.operationType !== "number" ||
    typeof operation.operation !== "string" ||
    !isRecord(operation.payload) ||
    typeof operation.payload.size !== "number" ||
    !Array.isArray(operation.attributes)
  ) {
    throw new Error(`Arkiv decoder returned an unexpected operation shape at index ${opIndex}`);
  }
  return {
    opIndex,
    operationType: operation.operationType,
    operation: operation.operation,
    entityKey: typeof operation.entityKey === "string" ? operation.entityKey : null,
    contentType: typeof operation.contentType === "string" ? operation.contentType : null,
    // Drop payload.hex / payload.text on purpose: only the size is kept.
    payloadSizeBytes: operation.payload.size,
    attributes: operation.attributes.map(parseDecoderAttribute),
    expiresAtBlocks: typeof operation.expiresAtBlocks === "number" ? operation.expiresAtBlocks : 0,
    newOwner: typeof operation.newOwner === "string" ? operation.newOwner : null,
    // Reference-mode metadata. `isReference` lives under `payload`; the parsed
    // reference, its verification verdict, and any parse error are top-level.
    // The reference carries provider receipt metadata only — never entity bytes.
    isReference:
      typeof operation.payload.isReference === "boolean" ? operation.payload.isReference : false,
    payloadReference: isRecord(operation.payloadReference)
      ? (operation.payloadReference as unknown as ArkivPayloadReference)
      : null,
    referenceVerification: isRecord(operation.referenceVerification)
      ? parseReferenceVerification(operation.referenceVerification)
      : null,
    referenceError: typeof operation.referenceError === "string" ? operation.referenceError : null,
  };
}

function parseReferenceVerification(value: Record<string, unknown>): ArkivReferenceVerification {
  return {
    valid: value.valid === true,
    signerTrusted: value.signerTrusted === true,
    chainId: typeof value.chainId === "number" ? value.chainId : 0,
    // The decoder omits these fields (serde skip-if-none/empty) rather than
    // emitting null, so treat absence as null/[].
    claimedSigner: typeof value.claimedSigner === "string" ? value.claimedSigner : null,
    recoveredSigner: typeof value.recoveredSigner === "string" ? value.recoveredSigner : null,
    messageHash: typeof value.messageHash === "string" ? value.messageHash : null,
    errors: Array.isArray(value.errors)
      ? value.errors.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}

function parseDecoderAttribute(attribute: unknown): ArkivOperationAttribute {
  if (
    !isRecord(attribute) ||
    typeof attribute.key !== "string" ||
    typeof attribute.valueType !== "number" ||
    typeof attribute.valueTypeName !== "string" ||
    typeof attribute.value !== "string"
  ) {
    throw new Error("Arkiv decoder returned an unexpected attribute shape");
  }
  return {
    key: attribute.key,
    valueType: attribute.valueType,
    valueTypeName: attribute.valueTypeName,
    value: attribute.value,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
