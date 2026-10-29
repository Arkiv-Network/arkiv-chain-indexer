import { shouldIgnoreTransaction } from "./transactionFilter";
import type { Hex, RpcBlock, RpcReceipt } from "./types";
import { TOMBSTONE_TYPE_ID, fromUtf8Hex, fromWireAttributeValue, typeTagOfRawId, utf8Hex, wireAttributeValue } from "./entityValues";

export const ARKIV_REGISTRY_ADDRESS = "0x4400000000000000000000000000000000000044";

/** topic0 of the engine's `EntityCreated(bytes32,address,uint64,uint8)` event. */
export const ENTITY_CREATED_TOPIC0 =
  "0xb282d7c494b8899aa8015cd07be621530beb03409eb8c5e8fdc1411ba64356a5";

/** The only response format this indexer reads: arkiv-transaction-decoder v0.3's UDC model. */
export const DECODER_FORMAT = "udc";

/**
 * The SDK's named-schema tag: an indexed `str` attribute whose value names the
 * schema an entity was written through. An ordinary user attribute to the
 * node; the explorer lifts it out as `schema_name`.
 */
export const SCHEMA_ATTRIBUTE_NAME = "arkiv.schema";

/** `expiresAt` of an entity that never expires: 2^64 − 1. */
export const PERMANENT_EXPIRES_AT = "18446744073709551615";
const U64_MAX = (1n << 64n) - 1n;

/** The bit of an attribute's raw `typeId` that asks the node to index it. */
export const INDEXED_TYPE_FLAG = 0x80;
const STR_TYPE_ID = 8;

const arkivRegistryAddress = ARKIV_REGISTRY_ADDRESS.toLowerCase();

const CREATE_OPERATION_TYPE = 1;

/** How often a repeating decoder refusal is warned about, in refusals. */
const REJECTION_WARNING_INTERVAL = 1000;

/**
 * Pulls the decoder's explanation out of a 400 body, which is
 * `{"error":"…"}` (v0.3) or `{"error":{"message":"…"}}`; gives up quietly on
 * anything else — the reason only decorates a warning.
 */
async function readRejectionReason(response: Response): Promise<string | undefined> {
  const body: unknown = await response.json().catch(() => null);
  if (!isRecord(body)) return undefined;
  if (typeof body.error === "string") return body.error;
  if (isRecord(body.error) && typeof body.error.message === "string") return body.error.message;
  return undefined;
}

/**
 * One attribute triple as the decoder reports it, and as
 * `transaction_operations.attributes` stores it — except that a stored str
 * value is {@link utf8Hex} (see {@link toStoredOperationAttributes}).
 *
 * `value` uses the node's `arkiv_query` encoding (u64/u256 as `0x`
 * quantities, i32 as a JSON number, bool as a JSON boolean, dec as a trimmed
 * decimal string, str as text, bytes32/key/addr as lowercase hex), so a
 * decoded value compares to the node's with plain equality. It is `null` for
 * `bytes` (whose content is never stored — only `size` and `keccak256`), for a
 * tombstone and for a triple the node would refuse (then `error` says why).
 */
export interface ArkivOperationAttribute {
  /** Case-sensitive. */
  name: string;
  /** The raw byte: the type in the low seven bits, {@link INDEXED_TYPE_FLAG} on top. */
  typeId: number;
  /** `typeId & 0x7f` as its tag (`str`, `bytes`, …), `tombstone` for 0, `invalid(0x..)` otherwise. */
  type: string;
  indexed: boolean;
  value: string | number | boolean | null;
  /** Bytes of the value as calldata carries them: 32 for a word type, the UTF-8 length of a str. */
  size: number;
  /** `bytes` only: keccak256 of the content. */
  keccak256?: string;
  /** Present only when the triple is malformed. */
  error?: string;
}

/**
 * Attributes as `transaction_operations.attributes` stores them: a str value
 * as the hex of its UTF-8, because jsonb cannot hold the NUL a str may carry.
 * Keyed on the typeId, which is what the chain carries, so nothing is
 * ambiguous; no other string in a triple can hold a NUL (parseDecoderResponse
 * refuses one).
 */
export function toStoredOperationAttributes(attributes: readonly ArkivOperationAttribute[]): ArkivOperationAttribute[] {
  return attributes.map((attribute) => (isStrValue(attribute) ? { ...attribute, value: utf8Hex(attribute.value) } : attribute));
}

/** The inverse of {@link toStoredOperationAttributes}, for rows read back. */
export function fromStoredOperationAttributes(attributes: readonly ArkivOperationAttribute[]): ArkivOperationAttribute[] {
  return attributes.map((attribute) => (isStrValue(attribute) ? { ...attribute, value: fromUtf8Hex(attribute.value) } : attribute));
}

function isStrValue(attribute: ArkivOperationAttribute): attribute is ArkivOperationAttribute & { value: string } {
  return typeTagOfRawId(attribute.typeId) === "str" && typeof attribute.value === "string";
}

export interface ArkivOperation {
  /** 0-based index of the operation within the transaction's execute() call. */
  opIndex: number;
  /** 1=create 2=patch 3=extend 4=transfer 5=delete; any other tag is reported, not refused. */
  operationType: number;
  /** "create" | "patch" | "extend" | "transfer" | "delete" | "unknown(N)" */
  operation: string;
  /** Lowercase; a create's comes from its `EntityCreated` log (calldata carries none). */
  entityKey: string | null;
  /** create: the uint128 salt as a decimal string. */
  salt: string | null;
  /** create: the raw flag byte (bit 0 readonly, bit 1 permissionless extension). */
  creationFlags: number | null;
  /** create/extend: the absolute deadline (block height) as an exact decimal string; "0" when unset. */
  expiresAt: string | null;
  /** create/extend: the lifetime floor in blocks from the landing block, exact decimal; "0" when unset. */
  minLifetime: string | null;
  /** transfer: lowercase. */
  newOwner: string | null;
  /** Bytes held by the operation's `bytes` attributes together. */
  bytesSize: number;
  /** The value of the operation's indexed str `arkiv.schema` attribute, if it sets one. */
  schemaName: string | null;
  /** create: the attributes; patch: the mutations in calldata order, tombstones included. */
  attributes: ArkivOperationAttribute[];
  /**
   * The decoder's reason the node would refuse the operation as a whole.
   * The node refuses such a transaction before it is mined, so a mined one
   * never has it: on a successful transaction it fails the block. Not stored.
   */
  error?: string;
}

/**
 * A stored operation as the API serves it: the calldata fields plus the
 * expiry the engine resolved them to at the operation's block.
 *
 * Permanence is a property of the *resolved* expiry, never of the request
 * alone: the node makes an entity permanent whenever `max(expiresAt, block +
 * minLifetime)` reaches 2^64 − 1, which a huge `minLifetime` does too. (The
 * decoder's own `permanent` flag only says the deadline asked for it, so it is
 * not stored.)
 */
export interface StoredArkivOperation extends ArkivOperation {
  /** create/extend: `max(expiresAt, block + minLifetime)` capped at 2^64 − 1, decimal; null otherwise. */
  resolvedExpiresAt: string | null;
  /** create/extend: `resolvedExpiresAt` is 2^64 − 1; null otherwise. */
  permanent: boolean | null;
}

/**
 * The expiry the engine resolves a create's or extend's pair to at its landing
 * block: `max(expiresAt, block + minLifetime)`, capped at 2^64 − 1. Null for
 * operations that carry no expiry. The engine announces the same value in the
 * operation's `EntityCreated` / `ExpiryExtended` log, which callers that have
 * it should prefer.
 */
export function resolveOperationExpiry(
  blockNumber: number | bigint,
  operation: Pick<ArkivOperation, "expiresAt" | "minLifetime">,
): string | null {
  if (operation.expiresAt === null || operation.minLifetime === null) return null;
  const expiresAt = BigInt(operation.expiresAt);
  const floor = BigInt(blockNumber) + BigInt(operation.minLifetime);
  const resolved = expiresAt > floor ? expiresAt : floor;
  return (resolved > U64_MAX ? U64_MAX : resolved).toString();
}

/** The schema name an operation's attributes carry: the indexed str `arkiv.schema`, else null. */
export function schemaNameOf(attributes: readonly ArkivOperationAttribute[]): string | null {
  const tag = attributes.find(
    (attribute) =>
      attribute.name === SCHEMA_ATTRIBUTE_NAME &&
      attribute.typeId === (STR_TYPE_ID | INDEXED_TYPE_FLAG) &&
      typeof attribute.value === "string",
  );
  return tag ? (tag.value as string) : null;
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
 * The decoder answered 2xx with something other than the UDC operation
 * shape: a decoder older (or newer) than this indexer. Thrown so the block
 * retries — storing a partial reading would leave a silent gap — and loud,
 * naming the decoder version, because it will not fix itself.
 */
export class DecoderContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecoderContractError";
  }
}

/**
 * Client for the arkiv-transaction-decoder microservice (v0.3, the UDC
 * format). A 400 response means the calldata is not an Arkiv execute() call
 * (not an error); any other failure — transport, status or a response that is
 * not the UDC shape — throws so the caller retries the whole block and no
 * silent gaps are created.
 */
export class ArkivDecoderClient {
  /** How many calls the decoder has refused, per selector. See {@link noteRejection}. */
  private readonly rejectedSelectors = new Map<string, number>();
  private version: string | undefined;

  constructor(readonly baseUrl: string) {
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
   * Arkiv traffic at all.
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
   * The decoder's own version (`GET /version`), for error messages. Cached
   * once read; "unknown" when the decoder does not say.
   */
  async decoderVersion(): Promise<string> {
    if (this.version !== undefined) return this.version;
    try {
      const response = await fetch(`${this.baseUrl}/version`);
      const body: unknown = response.ok ? await response.json() : null;
      if (isRecord(body) && typeof body.version === "string") {
        this.version = body.version;
        return this.version;
      }
    } catch {
      // Reported as unknown below.
    }
    return "unknown";
  }

  async decodeCalldata(data: Hex): Promise<ArkivOperation[] | null> {
    const url = `${this.baseUrl}/decode`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data }),
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

    const body: unknown = await response.json().catch(() => undefined);
    try {
      return parseDecoderResponse(body);
    } catch (error) {
      if (!(error instanceof DecoderContractError)) throw error;
      throw await this.contractBreak(error.message);
    }
  }

  /** The error for an answer outside the contract, naming the decoder and its version. */
  async contractBreak(detail: string): Promise<DecoderContractError> {
    const version = await this.decoderVersion();
    return new DecoderContractError(
      `Arkiv decoder at ${this.baseUrl} (version ${version}) answered outside the UDC contract: ` +
        `${detail}. This indexer reads the "${DECODER_FORMAT}" format of ` +
        `arkiv-transaction-decoder v0.3; upgrade the decoder. The block is retried until then.`,
    );
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
      const receipt = receiptsByHash.get(transaction.hash.toLowerCase());
      // The node refuses before mining whatever the decoder flags, so a flag
      // on a successful transaction means the decoder reads the chain wrong.
      const fault = receipt?.status === "0x1" ? minedOperationFault(operations) : undefined;
      if (fault !== undefined) throw await client.contractBreak(`successful transaction ${transaction.hash}: ${fault}`);
      fillCreateEntityKeys(transaction.hash, operations, receipt);
      results.push({ position, hash: transaction.hash, operations });
    }
  }
  return results;
}

/**
 * What makes decoded operations impossible for a successful transaction: a
 * decoder `error` on an operation or a triple (the node refuses those before
 * a transaction is mined). Undefined when there is none.
 */
export function minedOperationFault(operations: readonly ArkivOperation[]): string | undefined {
  for (const operation of operations) {
    const where = `operation ${operation.opIndex} (${operation.operation})`;
    if (operation.error !== undefined) return `${where} is flagged: ${operation.error}`;
    for (const attribute of operation.attributes) {
      if (attribute.error !== undefined) return `${where} attribute ${JSON.stringify(attribute.name)} is flagged: ${attribute.error}`;
    }
  }
  return undefined;
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
      operation.entityKey = createdKeys[index]!.toLowerCase();
    }
  });
}

// ---------------------------------------------------------------------------
// The v0.3 response contract. Every field of every operation is present, null
// where the operation's tag has none; anything else is a decoder this indexer
// does not speak to, and fails the block loudly rather than storing guesses.

const DECIMAL = /^\d+$/;
const U128_MAX = (1n << 128n) - 1n;
/** `transaction_operations.bytes_size` is a Postgres INTEGER. */
const INT32_MAX = 2 ** 31 - 1;
const HEX = /^0x[0-9a-f]*$/;

/** Parse a v0.3 `/decode` body. Throws {@link DecoderContractError} on any other shape. */
export function parseDecoderResponse(body: unknown): ArkivOperation[] {
  if (!isRecord(body)) throw new DecoderContractError("the response is not a JSON object");
  if (body.format !== DECODER_FORMAT) {
    throw new DecoderContractError(
      `the response format is ${JSON.stringify(body.format ?? null)}, not "${DECODER_FORMAT}"`,
    );
  }
  if (body.functionName !== "execute") {
    throw new DecoderContractError(`functionName is ${JSON.stringify(body.functionName ?? null)}, not "execute"`);
  }
  if (!Array.isArray(body.operations)) throw new DecoderContractError("operations is not an array");
  return body.operations.map((operation, index) => parseDecoderOperation(operation, index));
}

function parseDecoderOperation(operation: unknown, opIndex: number): ArkivOperation {
  const where = `operation ${opIndex}`;
  if (!isRecord(operation)) throw new DecoderContractError(`${where} is not an object`);
  const field = <T>(name: string, check: (value: unknown) => value is T, expected: string): T => {
    if (!(name in operation)) throw new DecoderContractError(`${where} has no ${name}`);
    const value = operation[name];
    if (!check(value)) {
      throw new DecoderContractError(`${where}.${name} is ${describe(value)}, expected ${expected}`);
    }
    return value;
  };
  const operationType = field("operationType", isNonNegativeInteger, "an integer tag");
  const name = field("operation", isString, "a string");
  const entityKey = field("entityKey", nullable(isHexOfBytes(32)), "lowercase 32-byte hex or null");
  // The ABI widths (uint128 salt, uint64 expiry pair): the node refuses wider
  // words, so a wider value is a decoder fault, not a number to store.
  const salt = field("salt", nullable(isDecimalUpTo(U128_MAX)), "a uint128 decimal string or null");
  const creationFlags = field("creationFlags", nullable(isByte), "a flag byte or null");
  const expiresAt = field("expiresAt", nullable(isDecimalUpTo(U64_MAX)), "a uint64 decimal string or null");
  const minLifetime = field("minLifetime", nullable(isDecimalUpTo(U64_MAX)), "a uint64 decimal string or null");
  // Checked as part of the contract but not kept: permanence is derived from
  // the resolved expiry (see StoredArkivOperation).
  field("permanent", nullable(isBoolean), "a boolean or null");
  const newOwner = field("newOwner", nullable(isHexOfBytes(20)), "a lowercase address or null");
  const bytesSize = field("bytesSize", (value: unknown): value is number => isNonNegativeInteger(value) && value <= INT32_MAX, "a byte count");
  const rawAttributes = field("attributes", Array.isArray, "an array");
  const error = operation.error;
  if (error !== undefined && !isString(error)) throw new DecoderContractError(`${where}.error is ${describe(error)}`);
  const attributes = rawAttributes.map((attribute, index) =>
    parseDecoderAttribute(attribute, `${where}.attributes[${index}]`),
  );
  return {
    opIndex,
    operationType,
    operation: name,
    entityKey,
    salt,
    creationFlags,
    expiresAt,
    minLifetime,
    newOwner,
    bytesSize,
    schemaName: schemaNameOf(attributes),
    attributes,
    ...(error !== undefined ? { error } : {}),
  };
}

function parseDecoderAttribute(attribute: unknown, where: string): ArkivOperationAttribute {
  if (!isRecord(attribute)) throw new DecoderContractError(`${where} is not an object`);
  const { name, typeId, type, indexed, value, size, keccak256, error } = attribute;
  if (!isString(name)) throw new DecoderContractError(`${where}.name is ${describe(name)}`);
  if (!isByte(typeId)) throw new DecoderContractError(`${where}.typeId is ${describe(typeId)}`);
  if (!isString(type)) throw new DecoderContractError(`${where}.type is ${describe(type)}`);
  if (!isBoolean(indexed)) throw new DecoderContractError(`${where}.indexed is ${describe(indexed)}`);
  if (!(value === null || isString(value) || isBoolean(value) || (typeof value === "number" && Number.isFinite(value)))) {
    throw new DecoderContractError(`${where}.value is ${describe(value)}`);
  }
  if (!isNonNegativeInteger(size)) throw new DecoderContractError(`${where}.size is ${describe(size)}`);
  if (keccak256 !== undefined && !isHexOfBytes(32)(keccak256)) {
    throw new DecoderContractError(`${where}.keccak256 is ${describe(keccak256)}`);
  }
  if (error !== undefined && !isString(error)) throw new DecoderContractError(`${where}.error is ${describe(error)}`);
  if (indexed !== ((typeId & INDEXED_TYPE_FLAG) !== 0)) {
    throw new DecoderContractError(`${where}.indexed is ${indexed}, but typeId ${typeId} says otherwise`);
  }
  // Only a str value may hold a NUL: it is stored as hex, every other string
  // as text, which jsonb refuses a NUL in. A valid name, tag or error has none.
  const strings: Array<[string, unknown]> = [["name", name], ["type", type], ["error", error]];
  if (typeTagOfRawId(typeId) !== "str") strings.push(["value", value]);
  const withNul = strings.find(([, text]) => isString(text) && text.includes("\0"));
  if (withNul) throw new DecoderContractError(`${where}.${withNul[0]} holds a NUL, which only a str value can`);
  // bytes content never reaches this process from a v0.3 decoder; refuse one
  // that sends it rather than store it. Keyed on the typeId, which is what the
  // chain carries, not on the tag the decoder names it with.
  const isBytes = (typeId & ~INDEXED_TYPE_FLAG) === BYTES_TYPE_ID;
  if (isBytes && value !== null) {
    throw new DecoderContractError(`${where} is a bytes attribute with a value; bytes content is never stored`);
  }
  // An unflagged triple is one the node accepts, so it must read as its type:
  // the tag of its typeId, a value in the node's encoding (bytes: its hash).
  if (error === undefined) {
    const fault = unflaggedTripleFault(typeId, type, value, isBytes, keccak256);
    if (fault !== undefined) throw new DecoderContractError(`${where} ${fault}`);
  }
  return {
    name,
    typeId,
    type,
    indexed,
    value,
    size,
    ...(keccak256 !== undefined ? { keccak256 } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

const BYTES_TYPE_ID = 7;

function unflaggedTripleFault(
  typeId: number,
  type: string,
  value: unknown,
  isBytes: boolean,
  keccak256: unknown,
): string | undefined {
  if (typeId === TOMBSTONE_TYPE_ID) {
    return type === "tombstone" && value === null ? undefined : `is a tombstone named ${JSON.stringify(type)} with value ${describe(value)}`;
  }
  const tag = typeTagOfRawId(typeId);
  if (tag === undefined) return `has typeId ${typeId}, which the node refuses, and no error`;
  if (type !== tag) return `has typeId ${typeId} (${tag}) but type ${JSON.stringify(type)}`;
  if (isBytes) {
    if ((typeId & INDEXED_TYPE_FLAG) !== 0) return "is an indexed bytes attribute, which the node refuses, and has no error";
    return keccak256 === undefined ? "is a bytes attribute without its keccak256" : undefined;
  }
  const stored = fromWireAttributeValue(tag, value);
  if (stored === null) return `has value ${describe(value)}, which does not read as ${tag}`;
  // The node's own encoding, exactly: what the index answers must be what it read.
  if (JSON.stringify(wireAttributeValue(tag, stored)) !== JSON.stringify(value)) {
    return `has value ${describe(value)}, which is not the node's encoding of a ${tag}`;
  }
  return undefined;
}

function describe(value: unknown): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return value.length > 40 ? `a string of ${value.length} characters` : JSON.stringify(value);
  if (typeof value === "object") return "an object";
  return `${typeof value} ${String(value)}`;
}

function nullable<T>(check: (value: unknown) => value is T): (value: unknown) => value is T | null {
  return (value: unknown): value is T | null => value === null || check(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isByte(value: unknown): value is number {
  return isNonNegativeInteger(value) && value <= 255;
}

function isDecimal(value: unknown): value is string {
  return typeof value === "string" && DECIMAL.test(value);
}

function isDecimalUpTo(max: bigint): (value: unknown) => value is string {
  return (value: unknown): value is string => isDecimal(value) && value.length <= 80 && BigInt(value) <= max;
}

function isHexOfBytes(bytes: number): (value: unknown) => value is string {
  return (value: unknown): value is string =>
    typeof value === "string" && HEX.test(value) && value.length === 2 + bytes * 2;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
