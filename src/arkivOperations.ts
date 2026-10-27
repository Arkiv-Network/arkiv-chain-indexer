import { shouldIgnoreTransaction } from "./transactionFilter";
import type { Hex, RpcBlock, RpcReceipt } from "./types";

export const ARKIV_REGISTRY_ADDRESS = "0x4400000000000000000000000000000000000044";

/** topic0 of the engine's `EntityCreated(bytes32,address,uint64,uint8)` event. */
export const ENTITY_CREATED_TOPIC0 =
  "0xb282d7c494b8899aa8015cd07be621530beb03409eb8c5e8fdc1411ba64356a5";

const arkivRegistryAddress = ARKIV_REGISTRY_ADDRESS.toLowerCase();

const CREATE_OPERATION_TYPE = 1;

/** Bit 7 of a udc attribute's raw type id: the node indexes the attribute. */
const UDC_INDEXED_FLAG = 0x80;

/** A udc `expiresAt` asking never to expire: the largest uint64. */
const UDC_PERMANENT_EXPIRES_AT = 2n ** 64n - 1n;

/**
 * `expiresAtBlocks` for a permanent udc entity. Any lifetime this long reads as
 * permanent to the frontend, and it still fits a JS number and the BIGINT column.
 */
export const PERMANENT_LIFETIME_BLOCKS = Number.MAX_SAFE_INTEGER;

/** How often a repeating decoder refusal is warned about, in refusals. */
const REJECTION_WARNING_INTERVAL = 1000;

/**
 * Pulls the decoder's explanation out of a 400 body, which is
 * `{"error":{"message":"…"},"ok":false}`. Older builds answer with a bare
 * `{"error":"…"}` string, so accept both and give up quietly on anything else —
 * the reason only decorates a warning.
 */
async function readRejectionReason(response: Response): Promise<string | undefined> {
  const body: unknown = await response.json().catch(() => null);
  if (!isRecord(body)) return undefined;
  if (typeof body.error === "string") return body.error;
  if (isRecord(body.error) && typeof body.error.message === "string") return body.error.message;
  return undefined;
}

export interface ArkivOperationAttribute {
  key: string;
  /** The type id without the indexed flag: 0 a tombstone, 1-10 the typed-attribute ids. */
  valueType: number;
  /** "uint" | "string" | "entityKey" | "unknown"; under the udc format the type tag ("str", "u64", "tombstone", …) */
  valueTypeName: string;
  /** Text in the entity index's stored encoding; "" for a `bytes` value or a tombstone. */
  value: string;
  /** udc only: the node indexes the attribute (bit 7 of the raw type id). */
  indexed?: boolean;
  /** udc `bytes` only: the length of the value. The bytes themselves are never stored. */
  size?: number;
  /** udc `bytes` only: keccak256 of the value. */
  keccak256?: string;
}

/**
 * Offline EIP-191 verification verdict a decoder returns for a payload
 * reference. Mirrors a reference-parsing decoder's `ReferenceVerification` and
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
  /** Signed provider payment gas units. Converted to wei with the block base fee. */
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
 * Client for the arkiv-transaction-decoder microservice. A 400 response means
 * the calldata is not an Arkiv execute() call (not an error); any other failure
 * throws so the caller retries the whole block and no silent gaps are created.
 *
 * `chainId`, when set, is sent with each request so the decoder verifies any
 * embedded payload reference against the trusted-signer allowlist for the
 * scanner's actual chain (the decoder otherwise falls back to its own default).
 */
export class ArkivDecoderClient {
  /** How many calls the decoder has refused, per selector. See {@link noteRejection}. */
  private readonly rejectedSelectors = new Map<string, number>();

  constructor(
    readonly baseUrl: string,
    readonly chainId?: number,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /**
   * Warns the first time a selector is refused, then once per
   * {@link REJECTION_WARNING_INTERVAL} after that.
   *
   * Every caller reaches this only for a transaction addressed to the registry,
   * so a refusal is never routine: it means the decoder cannot read calldata
   * the chain accepted, and those operations go unstored. A decoder older than
   * the chain's current `execute()` wire format refuses *every* registry call,
   * which without this warning is indistinguishable from a chain carrying no
   * Arkiv traffic at all — the failure mode this repo actually hit, where
   * `transaction_operations` sat empty across 786k scanned transactions.
   */
  private noteRejection(data: Hex, reason: string | undefined): void {
    const selector = data.slice(0, 10);
    const refusals = (this.rejectedSelectors.get(selector) ?? 0) + 1;
    this.rejectedSelectors.set(selector, refusals);
    if (refusals > 1 && refusals % REJECTION_WARNING_INTERVAL !== 0) return;
    console.warn(
      `Arkiv decoder at ${this.baseUrl} cannot decode registry calldata with selector ` +
        `${selector} (${refusals} so far)${reason ? `: ${reason}` : ""}. Operations for these ` +
        `transactions are not being stored; the decoder is likely older than the chain's ` +
        `current execute() format.`,
    );
  }

  /**
   * `blockNumber` is the block the call landed in. The udc format states expiry
   * as an absolute deadline plus a lifetime floor from the landing block, so
   * turning that into a lifetime takes the block.
   */
  async decodeCalldata(data: Hex, blockNumber?: bigint): Promise<ArkivOperation[] | null> {
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
      this.noteRejection(data, await readRejectionReason(response));
      return null;
    }
    if (!response.ok) {
      throw new Error(`Arkiv decoder at ${url} returned HTTP ${response.status}`);
    }

    return parseDecoderResponse(await response.json(), blockNumber);
  }
}

/**
 * Decode the Arkiv operations of every registry transaction in `block`.
 * `position` is the index in `block.transactions` BEFORE filtering — the same
 * convention as src/blockInspector.ts — so rows align with the
 * `(block_number, position)` primary key of the transactions table.
 *
 * `receipts`, when given, supplies the entity keys of create operations, which
 * calldata alone cannot: the engine derives a created key from the owner and
 * its entity counter, and announces it only in the `EntityCreated` receipt log.
 */
export async function decodeBlockArkivOperations(
  block: RpcBlock,
  client: ArkivDecoderClient,
  receipts?: RpcReceipt[],
): Promise<TransactionArkivOperations[]> {
  const receiptsByHash = new Map<string, RpcReceipt>();
  for (const receipt of receipts ?? []) {
    receiptsByHash.set(receipt.transactionHash.toLowerCase(), receipt);
  }

  const blockNumber = block.number ? BigInt(block.number) : undefined;
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
    const operations = await client.decodeCalldata(transaction.input, blockNumber);
    if (operations !== null && operations.length > 0) {
      fillCreateEntityKeys(
        transaction.hash,
        operations,
        receiptsByHash.get(transaction.hash.toLowerCase()),
      );
      results.push({ position, hash: transaction.hash, operations });
    }
  }
  return results;
}

/**
 * Fills the entity keys of a transaction's create operations from its receipt's
 * `EntityCreated` logs.
 *
 * The engine emits exactly one `EntityCreated` per successful create, in
 * operation order, so the Nth create in the calldata pairs with the Nth
 * `EntityCreated` in the receipt. When the counts disagree the pairing cannot
 * be trusted, so the keys are left null rather than guessed — silently for a
 * reverted transaction (which emits no logs at all), loudly otherwise.
 */
export function fillCreateEntityKeys(
  transactionHash: Hex,
  operations: ArkivOperation[],
  receipt: RpcReceipt | undefined,
): void {
  const creates = operations.filter(
    (operation) => operation.operationType === CREATE_OPERATION_TYPE,
  );
  if (creates.length === 0 || !receipt) {
    return;
  }

  const createdKeys = (receipt.logs ?? [])
    .filter(
      (log) =>
        log.address.toLowerCase() === arkivRegistryAddress &&
        log.topics[0]?.toLowerCase() === ENTITY_CREATED_TOPIC0,
    )
    .map((log) => log.topics[1])
    .filter((topic): topic is Hex => typeof topic === "string");

  if (createdKeys.length !== creates.length) {
    if (receipt.status !== "0x0") {
      console.warn(
        `Transaction ${transactionHash} decodes to ${creates.length} create operation(s) but its ` +
          `receipt carries ${createdKeys.length} EntityCreated log(s); leaving their entity keys null`,
      );
    }
    return;
  }

  creates.forEach((operation, index) => {
    if (operation.entityKey === null) {
      operation.entityKey = createdKeys[index]!;
    }
  });
}

function parseDecoderResponse(body: unknown, blockNumber: bigint | undefined): ArkivOperation[] {
  if (!isRecord(body) || !Array.isArray(body.operations)) {
    throw new Error("Arkiv decoder returned an unexpected response shape");
  }
  // A decoder built for the udc (schema-typed attribute) execute() format says
  // so; its operations have a shape of their own.
  if (body.format === "udc") {
    return body.operations.map((operation, index) => parseUdcOperation(operation, index, blockNumber));
  }
  return body.operations.map((operation, index) => parseDecoderOperation(operation, index));
}

/**
 * Maps a udc operation onto the stored shape. Operation types keep their
 * numbers (1 create, 2 patch, 3 extend, 4 transfer, 5 delete), so a patch takes
 * the slot an update had. There is no payload or content type: an entity's
 * content lives in `bytes` attributes, whose combined size stands in for the
 * payload size and whose bytes are never stored.
 */
function parseUdcOperation(
  operation: unknown,
  opIndex: number,
  blockNumber: bigint | undefined,
): ArkivOperation {
  if (
    !isRecord(operation) ||
    typeof operation.operationType !== "number" ||
    typeof operation.operation !== "string" ||
    typeof operation.bytesSize !== "number" ||
    !Array.isArray(operation.attributes)
  ) {
    throw new Error(`Arkiv decoder returned an unexpected operation shape at index ${opIndex}`);
  }
  return {
    opIndex,
    operationType: operation.operationType,
    operation: operation.operation,
    entityKey: typeof operation.entityKey === "string" ? operation.entityKey : null,
    contentType: null,
    payloadSizeBytes: operation.bytesSize,
    attributes: operation.attributes.map(parseUdcAttribute),
    expiresAtBlocks: udcLifetimeBlocks(operation, blockNumber),
    newOwner: typeof operation.newOwner === "string" ? operation.newOwner : null,
    isReference: false,
    payloadReference: null,
    referenceVerification: null,
    referenceError: null,
  };
}

/**
 * The lifetime in blocks from the landing block, as the payload format's
 * `expiresAtBlocks` was: the engine keeps an entity until
 * `max(expiresAt, block + minLifetime)`, `expiresAt` 0 meaning unset. 0 for an
 * operation that sets no expiry.
 */
export function udcLifetimeBlocks(operation: Record<string, unknown>, blockNumber: bigint | undefined): number {
  const expiresAt = decimalBigInt(operation.expiresAt);
  const minLifetime = decimalBigInt(operation.minLifetime);
  if (expiresAt === undefined && minLifetime === undefined) return 0;
  if (operation.permanent === true || expiresAt === UDC_PERMANENT_EXPIRES_AT) return PERMANENT_LIFETIME_BLOCKS;
  const block = blockNumber ?? 0n;
  const floor = minLifetime ?? 0n;
  const deadline = expiresAt !== undefined && expiresAt > block + floor ? expiresAt : block + floor;
  if (deadline >= UDC_PERMANENT_EXPIRES_AT) return PERMANENT_LIFETIME_BLOCKS;
  const lifetime = deadline - block;
  return lifetime > BigInt(PERMANENT_LIFETIME_BLOCKS) ? PERMANENT_LIFETIME_BLOCKS : Number(lifetime);
}

function decimalBigInt(value: unknown): bigint | undefined {
  return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : undefined;
}

/**
 * Maps a udc attribute onto the stored shape, its value in the text encoding
 * the entity index reads (`toStoredAttributeValue`): the decoder answers in the
 * node's wire encoding, which differs for `bool`, `i32` and the `0x` quantities
 * of `u64`/`u256`. A `bytes` value is never returned, only its size and hash.
 */
function parseUdcAttribute(attribute: unknown): ArkivOperationAttribute {
  if (
    !isRecord(attribute) ||
    typeof attribute.name !== "string" ||
    typeof attribute.typeId !== "number" ||
    typeof attribute.type !== "string"
  ) {
    throw new Error("Arkiv decoder returned an unexpected attribute shape");
  }
  return {
    key: attribute.name,
    valueType: attribute.typeId & ~UDC_INDEXED_FLAG,
    valueTypeName: attribute.type,
    value: udcValueText(attribute.type, attribute.value),
    indexed: attribute.indexed === true,
    ...(attribute.type === "bytes" && typeof attribute.size === "number" ? { size: attribute.size } : {}),
    ...(typeof attribute.keccak256 === "string" ? { keccak256: attribute.keccak256 } : {}),
  };
}

function udcValueText(type: string, value: unknown): string {
  if (value === null || value === undefined) return "";
  if ((type === "u64" || type === "u256") && typeof value === "string" && /^0x[0-9a-f]+$/i.test(value)) {
    return BigInt(value).toString();
  }
  return String(value);
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
