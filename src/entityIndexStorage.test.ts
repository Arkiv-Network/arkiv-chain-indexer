import { testAuth, testAdminHeaders } from "./testAuth";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { ARKIV_INDEX_METHODS, createArkivIndexMethods, cursorBinding, defaultProjection, encodeCursor, projectionFingerprint } from "./arkivJsonRpc";
import type { ArkivOperation, TransactionArkivOperations } from "./arkivOperations";
import { udcAttribute, udcOperation } from "./testUdc";
import type { InspectedLog, InspectedTransaction } from "./blockInspector";
import { ENTITY_EVENT_TOPICS } from "./entityIndex";
import { EntityIndexStorage, foldKeyBatches } from "./entityIndexStorage";
import { EntityProjector, retryDelayMs } from "./entityProjector";
import { handleJsonRpcBody, type JsonRpcResponse } from "./jsonRpc";
import { createBlockServer, type HealthResponseBody } from "./server";
import type { ScannerStorage } from "./storage";
import type { BlockMetrics } from "./types";
import { TEST_DATABASE_URL, closeTestPools, createIsolatedStorage, hasPostgresForTests } from "./testPostgres";
import { openDb, type Db } from "./db";
import { GenesisRpcError, GenesisSourceUnavailable } from "./entityGenesis";
import { FAKE_GENESIS_OWNER, createFakeGenesisSource, fakeWireEntity } from "./testGenesisSource";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenesisEntityError } from "./entityGenesis";
import { fileDumpSource } from "./entityGenesisDump";
import { GenesisImportRefused, GenesisImportStopped, importGenesisDump, type GenesisDumpManifest } from "./entityGenesisDumpImport";
import { GenesisProgressTracker, type GenesisProgressDocument } from "./genesisProgress";
import { DUMP_OWNER, buildDump, dumpKey, encodeAttributeValue, seederSystemStorage } from "./testGenesisDump";

const REGISTRY = "0x4400000000000000000000000000000000000044";
const ALICE = `0x${"aa".repeat(20)}`;
const BOB = `0x${"bb".repeat(20)}`;
const CAROL = `0x${"cc".repeat(20)}`;
const KEY_A = `0x${"a1".repeat(32)}`;
const KEY_B = `0x${"b2".repeat(32)}`;
const KEY_C = `0x${"c3".repeat(32)}`;
const KEY_D = `0x${"d4".repeat(32)}`;
const KEY_E = `0x${"e5".repeat(32)}`;
const KEY_F = `0x${"f6".repeat(32)}`;

const word = (value: bigint | number) => BigInt(value).toString(16).padStart(64, "0");
const topicAddress = (address: string) => `0x${"00".repeat(12)}${address.slice(2)}`;

// ---------------------------------------------------------------------------
// Fixture builders

function metrics(blockNumber: number, transactionCount: number): BlockMetrics {
  return {
    blockDate: new Date(Date.UTC(2026, 8, 3, 0, 0, blockNumber * 2)).toISOString(),
    blockNumber: BigInt(blockNumber),
    blockTimeSeconds: "2",
    baseBlockFeeWei: "100",
    totalGasUsed: "21000",
    totalInputDataSizeBytes: "0",
    totalInputDataCompressedSizeBytes: "0",
    maxGasInBlock: "30000000",
    transactionCount,
    blockRewardWei: "0",
    burntFeesWei: "0",
    totalTransactionFeeWei: "0",
    totalRentFeeWei: "0",
    totalBurnedWei: "0",
    feePriceSumWei: "0",
    priorityFeeSumWei: "0",
    priorityFeeWeightedNumeratorWei: "0",
    priorityFeeGasWeightedNumeratorWei: "0",
    averageFeePriceWei: "0",
    averageTransactionFeeWei: "0",
    averageTransactionGasUsed: "0",
    averageTransactionInputDataSizeBytes: "0",
    averageTransactionInputDataCompressedSizeBytes: "0",
    averagePriorityFeeWeightedWei: "0",
    averagePriorityFeeWei: "0",
  };
}

function registryTx(
  blockNumber: number,
  position: number,
  from: string,
  options: { status?: string; logs?: InspectedLog[] } = {},
): InspectedTransaction {
  return {
    position,
    hash: `0x${(blockNumber * 100 + position).toString(16).padStart(64, "0")}`,
    from: from as `0x${string}`,
    to: REGISTRY,
    type: "2",
    nonce: "1",
    valueWei: "0",
    gasLimit: "100000",
    gasUsed: "50000",
    inputDataSizeBytes: "0",
    inputDataCompressedSizeBytes: "0",
    cumulativeGasUsed: "50000",
    gasPriceWei: "100",
    maxFeePerGasWei: "200",
    maxPriorityFeePerGasWei: "10",
    effectiveGasPriceWei: "100",
    priorityFeeWei: "10",
    transactionFeeWei: "5000000",
    rentFeeWei: "0",
    status: options.status ?? "1",
    contractAddress: null,
    ...(options.logs ? { logs: options.logs } : {}),
  };
}

type Attr = ArkivOperation["attributes"][number];
// Values in the decoder's (= the node's) wire encoding.
const str = (name: string, value: string): Attr => udcAttribute(name, "str", value);
const u64 = (name: string, value: string): Attr => udcAttribute(name, "u64", `0x${BigInt(value).toString(16)}`);
const i32 = (name: string, value: string): Attr => udcAttribute(name, "i32", Number(value));
const dec = (name: string, value: string): Attr => udcAttribute(name, "dec", value);
const bool = (name: string, value: string): Attr => udcAttribute(name, "bool", value === "true");
const addr = (name: string, value: string): Attr => udcAttribute(name, "addr", value.toLowerCase());
const tombstone = (name: string): Attr => udcAttribute(name, "tombstone", null);
/** The calldata expiry pair: a lifetime from the landing block, or an absolute deadline. */
const lifetime = (blocks: number) => ({ expiresAt: "0", minLifetime: String(blocks) });
const deadline = (block: number) => ({ expiresAt: String(block), minLifetime: "0" });

function operation(overrides: Partial<ArkivOperation> & { opIndex: number; operationType: number }): ArkivOperation {
  return udcOperation({ attributes: [], ...overrides });
}

const log = (logIndex: number, topics: string[], data = "0x"): InspectedLog => ({
  logIndex,
  address: REGISTRY,
  topics: topics as `0x${string}`[],
  data: data as `0x${string}`,
});
const createdLog = (logIndex: number, key: string, owner: string, expiresAt: number, flags = 0) =>
  log(logIndex, [ENTITY_EVENT_TOPICS.created, key, topicAddress(owner)], `0x${word(expiresAt)}${word(flags)}`);
const patchedLog = (logIndex: number, key: string, owner: string) =>
  log(logIndex, [ENTITY_EVENT_TOPICS.patched, key, topicAddress(owner)]);
const extendedLog = (logIndex: number, key: string, owner: string, expiresAt: number) =>
  log(logIndex, [ENTITY_EVENT_TOPICS.expiryExtended, key, topicAddress(owner)], `0x${word(expiresAt)}`);
const transferredLog = (logIndex: number, key: string, from: string, to: string) =>
  log(logIndex, [ENTITY_EVENT_TOPICS.ownershipTransferred, key, topicAddress(from), topicAddress(to)]);
const deletedLog = (logIndex: number, key: string, owner: string) =>
  log(logIndex, [ENTITY_EVENT_TOPICS.deleted, key, topicAddress(owner)]);

interface FixtureBlock {
  blockNumber: number;
  transactions: InspectedTransaction[];
  operations: TransactionArkivOperations[];
}

/**
 * The chain the tests fold:
 *
 * - 100: Alice creates A (5 typed attributes, expires 150) and B (expires 200,
 *   flags 3); Alice creates E (expires 103) and, in a receipt without stored
 *   logs, F (lifetime 50 → 150 by the calldata rule).
 * - 101: Carol creates C ("other") and D ("demo") in one transaction.
 * - 102: Alice patches A: rank retyped to i32(7), flag unset, `who` added.
 * - 103: Alice extends B to 300; Carol transfers C to Bob.
 * - 104: a reverted delete of D (must be ignored).
 * - 105: Carol deletes D.
 */
function fixtureChain(): FixtureBlock[] {
  return [
    {
      blockNumber: 100,
      transactions: [
        registryTx(100, 0, ALICE, { logs: [createdLog(0, KEY_A, ALICE, 150)] }),
        registryTx(100, 1, ALICE, { logs: [createdLog(1, KEY_B, ALICE, 200, 3)] }),
        registryTx(100, 2, ALICE, { logs: [createdLog(2, KEY_E, ALICE, 103)] }),
        registryTx(100, 3, ALICE),
      ],
      operations: [
        {
          position: 0,
          hash: registryTx(100, 0, ALICE).hash,
          operations: [
            operation({
              opIndex: 0,
              operationType: 1,
              entityKey: KEY_A,
              ...lifetime(50),
              attributes: [str("project", "demo"), u64("rank", "5"), dec("score", "1.5"), bool("flag", "true"), i32("level", "-3")],
            }),
          ],
        },
        {
          position: 1,
          hash: registryTx(100, 1, ALICE).hash,
          operations: [
            operation({
              opIndex: 0,
              operationType: 1,
              entityKey: KEY_B,
              ...deadline(200),
              attributes: [str("project", "demo"), u64("rank", "9"), str("name", "bob")],
            }),
          ],
        },
        {
          position: 2,
          hash: registryTx(100, 2, ALICE).hash,
          operations: [
            operation({ opIndex: 0, operationType: 1, entityKey: KEY_E, ...lifetime(3), attributes: [str("project", "short")] }),
          ],
        },
        {
          position: 3,
          hash: registryTx(100, 3, ALICE).hash,
          operations: [
            operation({ opIndex: 0, operationType: 1, entityKey: KEY_F, ...lifetime(50), attributes: [str("project", "nolog")] }),
          ],
        },
      ],
    },
    {
      blockNumber: 101,
      transactions: [
        registryTx(101, 0, CAROL, { logs: [createdLog(0, KEY_C, CAROL, 1101), createdLog(1, KEY_D, CAROL, 1101)] }),
      ],
      operations: [
        {
          position: 0,
          hash: registryTx(101, 0, CAROL).hash,
          operations: [
            operation({ opIndex: 0, operationType: 1, entityKey: KEY_C, ...lifetime(1000), attributes: [str("project", "other")] }),
            operation({
              opIndex: 1,
              operationType: 1,
              entityKey: KEY_D,
              ...lifetime(1000),
              attributes: [str("project", "demo"), str("tag", "demo-x")],
            }),
          ],
        },
      ],
    },
    {
      blockNumber: 102,
      transactions: [registryTx(102, 0, ALICE, { logs: [patchedLog(0, KEY_A, ALICE)] })],
      operations: [
        {
          position: 0,
          hash: registryTx(102, 0, ALICE).hash,
          operations: [
            operation({
              opIndex: 0,
              operationType: 2,
              entityKey: KEY_A,
              attributes: [i32("rank", "7"), tombstone("flag"), addr("who", "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb")],
            }),
          ],
        },
      ],
    },
    {
      blockNumber: 103,
      transactions: [
        registryTx(103, 0, ALICE, { logs: [extendedLog(0, KEY_B, ALICE, 300)] }),
        registryTx(103, 1, CAROL, { logs: [transferredLog(1, KEY_C, CAROL, BOB)] }),
      ],
      operations: [
        {
          position: 0,
          hash: registryTx(103, 0, ALICE).hash,
          operations: [operation({ opIndex: 0, operationType: 3, entityKey: KEY_B, ...deadline(300) })],
        },
        {
          position: 1,
          hash: registryTx(103, 1, CAROL).hash,
          operations: [operation({ opIndex: 0, operationType: 4, entityKey: KEY_C, newOwner: BOB })],
        },
      ],
    },
    {
      blockNumber: 104,
      transactions: [registryTx(104, 0, CAROL, { status: "0", logs: [] })],
      operations: [
        {
          position: 0,
          hash: registryTx(104, 0, CAROL).hash,
          operations: [operation({ opIndex: 0, operationType: 5, entityKey: KEY_D })],
        },
      ],
    },
    {
      blockNumber: 105,
      transactions: [registryTx(105, 0, CAROL, { logs: [deletedLog(0, KEY_D, CAROL)] })],
      operations: [
        {
          position: 0,
          hash: registryTx(105, 0, CAROL).hash,
          operations: [operation({ opIndex: 0, operationType: 5, entityKey: KEY_D })],
        },
      ],
    },
  ];
}

async function storeBlock(storage: ScannerStorage, block: FixtureBlock): Promise<void> {
  await storage.saveBlockMetrics(
    metrics(block.blockNumber, block.transactions.length),
    { kind: "lastSuccessfulBlock" },
    block.transactions,
    block.transactions,
    block.operations,
  );
}

// ---------------------------------------------------------------------------

describe("fold key batching", () => {
  test("splits keys into consecutive batches of at most the batch width", () => {
    expect(foldKeyBatches(["a", "b", "c", "d", "e"], 2)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  test("an exact multiple leaves no trailing empty batch", () => {
    expect(foldKeyBatches(["a", "b", "c", "d"], 2)).toEqual([["a", "b"], ["c", "d"]]);
  });

  test("no keys is no batches, so a fold of nothing reads nothing", () => {
    expect(foldKeyBatches([], 1_000)).toEqual([]);
  });

  test("a batch wider than the keys is one batch", () => {
    expect(foldKeyBatches(["a", "b"], 1_000)).toEqual([["a", "b"]]);
  });

  test("a width below one still makes progress one key at a time", () => {
    expect(foldKeyBatches(["a", "b"], 0)).toEqual([["a"], ["b"]]);
  });
});

describe("fold retry backoff", () => {
  test("the first retry waits one poll interval and each further one doubles", () => {
    expect([1, 2, 3, 4, 5].map((failures) => retryDelayMs(failures, 2_000))).toEqual([
      2_000, 4_000, 8_000, 16_000, 32_000,
    ]);
  });

  test("the wait stops growing at the cap", () => {
    expect(retryDelayMs(6, 2_000)).toBe(60_000);
    expect(retryDelayMs(40, 2_000)).toBe(60_000);
  });

  test("no failures polls at the poll interval", () => {
    expect(retryDelayMs(0, 2_000)).toBe(2_000);
  });
});

const describeWithPostgres = hasPostgresForTests() ? describe : describe.skip;

describeWithPostgres("entity index (Postgres)", () => {
  let storage: ScannerStorage;
  let index: EntityIndexStorage;
  let cleanup: () => Promise<void>;
  let methods: ReturnType<typeof createArkivIndexMethods>;
  let indexDb: Db;
  let indexSchema: string;
  const logs: string[] = [];

  const call = async (method: string, params: unknown[] = []): Promise<JsonRpcResponse> =>
    (await handleJsonRpcBody({ jsonrpc: "2.0", id: 1, method, params }, storage, { localOverrides: methods })) as JsonRpcResponse;
  const result = async <T = unknown>(method: string, params: unknown[] = []): Promise<T> => {
    const response = await call(method, params);
    if (response.error) throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
    return response.result as T;
  };
  const keysOf = async (query: string, options: Record<string, unknown> = {}) =>
    (await result<{ data: Array<{ key: string }> }>("arkiv_query", [query, { limit: 50, ...options }])).data.map((entity) => entity.key);
  const errorOf = async (method: string, params: unknown[]) => (await call(method, params)).error!;

  /** What `arkiv_getEntity` used to answer, through `arkiv_query` (the UDC node has no getEntity). */
  const getEntity = async (key: string, block?: number): Promise<Record<string, unknown> | null> => {
    const select = { key: true, owner: true, creator: true, createdAt: true, updatedAt: true, expiresAt: true, creationFlags: true, attributes: true };
    const page = await result<{ data: Array<Record<string, unknown>> }>("arkiv_query", [
      `$key = key(${key.toLowerCase()})`,
      { select, ...(block === undefined ? {} : { atBlock: `0x${block.toString(16)}` }) },
    ]);
    return page.data[0] ?? null;
  };

  beforeAll(async () => {
    const isolated = await createIsolatedStorage("entity_index");
    storage = isolated.storage;
    cleanup = isolated.cleanup;
    // A second pool on the same schema, the way serve.ts opens it.
    indexDb = openDb(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!, { max: 2 });
    indexSchema = isolated.schema;
    index = await EntityIndexStorage.fromDb(indexDb, { schema: indexSchema });
    methods = createArkivIndexMethods(index, storage);
    for (const block of fixtureChain()) await storeBlock(storage, block);
  });

  afterAll(async () => {
    await cleanup();
    await closeTestPools();
  });

  test("the projector folds the chain in chunks and reports where it stands", async () => {
    const projector = new EntityProjector(index, { maxOpsPerChunk: 3, log: (message) => logs.push(message) });
    const before = await index.getProgress();
    expect(before.projectedThroughBlock).toBeUndefined();

    const tick = await projector.runOnce();
    expect(tick.head).toBe(105n);
    expect(tick.projectedThroughBlock).toBe(105n);
    expect(tick.chunksFolded).toBeGreaterThan(1);
    expect(tick.lockHeldElsewhere).toBe(false);

    const progress = await index.getProgress();
    expect(progress.floorBlock).toBe(100n);
    expect(progress.projectedThroughBlock).toBe(105n);
    expect(progress.lateScanWatermark).toBeDefined();
    expect(logs.some((line) => line.includes("starting at block 100"))).toBe(true);

    // A second tick with nothing new is a no-op.
    const again = await projector.runOnce();
    expect(again.chunksFolded).toBe(0);
    expect(again.projectedThroughBlock).toBe(105n);
  });

  test("a narrow key batch folds to the same versions as a wide one", async () => {
    const keys = await index.keysTouchedBetween(99n, 105n);
    expect(keys.length).toBeGreaterThan(2);

    const wideFold = await index.withFoldLock((client) => index.refoldEntities(keys, 105n, client));
    const wide = await Promise.all(keys.map((key) => index.getEntityVersions(key)));
    expect(wide.some((versions) => versions.length > 0)).toBe(true);

    const narrow = await EntityIndexStorage.fromDb(indexDb, { schema: indexSchema, foldKeyBatch: 2 });
    const narrowFold = await narrow.withFoldLock((client) => narrow.refoldEntities(keys, 105n, client));
    expect(narrowFold).toEqual(wideFold!);

    expect(await Promise.all(keys.map((key) => index.getEntityVersions(key)))).toEqual(wide);
  });

  test("each entity's versions replay its operations", async () => {
    const a = await index.getEntityVersions(KEY_A);
    expect(a.map((version) => [version.version, version.fromBlock, version.toBlock])).toEqual([
      [0, 100, 102],
      [1, 102, null],
    ]);
    expect(a[0]!.attributes.map((attribute) => `${attribute.name}:${attribute.typeId}=${attribute.valueText}`)).toEqual([
      "flag:1=true",
      "level:2=-3",
      "project:8=demo",
      "rank:3=5",
      "score:5=1.5",
    ]);
    expect(a[1]!.attributes.map((attribute) => `${attribute.name}:${attribute.typeId}=${attribute.valueText}`)).toEqual([
      "level:2=-3",
      "project:8=demo",
      "rank:2=7",
      "score:5=1.5",
      `who:9=${BOB}`,
    ]);
    expect(a[1]).toMatchObject({ owner: ALICE, creator: ALICE, createdAt: 100, updatedAt: 102, expiresAt: 150n, creationFlags: 0 });

    const b = await index.getEntityVersions(KEY_B);
    expect(b.map((version) => version.expiresAt)).toEqual([200n, 300n]);
    expect(b[1]).toMatchObject({ updatedAt: 103, creationFlags: 3 });

    const c = await index.getEntityVersions(KEY_C);
    expect(c.map((version) => version.owner)).toEqual([CAROL, BOB]);
    expect(c[1]!.creator).toBe(CAROL);

    // The reverted delete at 104 left no trace; the real one at 105 did.
    const d = await index.getEntityVersions(KEY_D);
    expect(d.map((version) => [version.fromBlock, version.deleted])).toEqual([
      [101, false],
      [105, true],
    ]);

    // No stored logs: expiry and flags from the calldata, which carries both exactly.
    const f = await index.getEntityVersions(KEY_F);
    expect(f[0]).toMatchObject({ expiresAt: 150n, creationFlags: 0 });
  });

  test("* lists the entities live at the projection head, oldest first", async () => {
    const page = await result<{ data: Array<{ key: string }>; blockNumber: string; cursor?: string }>("arkiv_query", ["*"]);
    expect(page.blockNumber).toBe("0x69");
    expect(page.cursor).toBeUndefined();
    // D is deleted and E expired at 103; the node's id order is creation
    // order — block, transaction, then operation within it.
    expect(page.data.map((entity) => entity.key)).toEqual([KEY_A, KEY_B, KEY_F, KEY_C]);
  });

  test("typed predicates match only attributes of their type", async () => {
    expect(await keysOf("project = str('demo')")).toEqual([KEY_A, KEY_B]);
    expect(await keysOf("rank > u64(4)")).toEqual([KEY_B]);
    expect(await keysOf("rank = i32(7)")).toEqual([KEY_A]);
    expect(await keysOf("rank = 7")).toEqual([KEY_A]);
    expect(await keysOf("rank = u64(7)")).toEqual([]);
    expect(await keysOf("score >= dec(1.5)")).toEqual([KEY_A]);
    expect(await keysOf("score > dec(1.50)")).toEqual([]);
    expect(await keysOf("level < 0")).toEqual([KEY_A]);
    expect(await keysOf("level <= i32(-3)")).toEqual([KEY_A]);
    expect(await keysOf("level < i32(-3)")).toEqual([]);
    expect(await keysOf("flag = true")).toEqual([]);
    expect(await keysOf(`who = addr(${BOB})`)).toEqual([KEY_A]);
    expect(await keysOf("nosuch = str('x')")).toEqual([]);
  });

  test("STARTSWITH, NOT, AND and OR compose over the live set", async () => {
    expect(await keysOf("name STARTSWITH str('b')")).toEqual([KEY_B]);
    expect(await keysOf("project STARTSWITH str('dem')")).toEqual([KEY_A, KEY_B]);
    expect(await keysOf("project STARTSWITH str('%')")).toEqual([]);
    expect(await keysOf("NOT project = str('demo')")).toEqual([KEY_F, KEY_C]);
    expect(await keysOf("project = str('demo') AND rank = i32(7)")).toEqual([KEY_A]);
    expect(await keysOf("project = str('other') OR name = str('bob')")).toEqual([KEY_B, KEY_C]);
    expect(await keysOf("NOT (project = str('demo') OR project = str('other'))")).toEqual([KEY_F]);
  });

  test("system attributes query the version columns", async () => {
    expect(await keysOf(`$owner = addr(${BOB})`)).toEqual([KEY_C]);
    expect(await keysOf(`$owner = '${CAROL}'`)).toEqual([]);
    expect(await keysOf(`$creator = addr(${CAROL})`)).toEqual([KEY_C]);
    expect(await keysOf("$createdAt >= u64(101)")).toEqual([KEY_C]);
    expect(await keysOf("$createdAt = u64(100)")).toEqual([KEY_A, KEY_B, KEY_F]);
    expect(await keysOf("$expiresAt < u64(200)")).toEqual([KEY_A, KEY_F]);
    expect(await keysOf("$expiresAt <= u64(300)")).toEqual([KEY_A, KEY_B, KEY_F]);
    expect(await keysOf(`$key = key(${KEY_A})`)).toEqual([KEY_A]);
    expect(await keysOf(`$key = '${KEY_D}'`)).toEqual([]);
    // UDC entities have no payload or content type: the node's own refusals.
    expect(await errorOf("arkiv_query", ["$contentType = 'text/plain'"])).toEqual({
      code: -32002,
      message:
        "query rejected (type): unknown system attribute $contentType — entities have no content type; store one in an indexed str attribute",
      data: { position: 0, got: "$contentType" },
    });
    expect(await errorOf("arkiv_query", ['$payload = str("a")'])).toEqual({
      code: -32002,
      message:
        "query rejected (type): unknown system attribute $payload — entities have no payload; store data in a bytes attribute, which is never indexed",
      data: { position: 0, got: "$payload" },
    });
  });

  test("atBlock evaluates the state as of that block", async () => {
    expect(await keysOf("*", { atBlock: "0x64" })).toEqual([KEY_A, KEY_B, KEY_E, KEY_F]);
    expect(await keysOf("*", { atBlock: "0x66" })).toEqual([KEY_A, KEY_B, KEY_E, KEY_F, KEY_C, KEY_D]);
    // E expires at 103: live at 102, gone at 103.
    expect(await keysOf("project = str('short')", { atBlock: "0x66" })).toEqual([KEY_E]);
    expect(await keysOf("project = str('short')", { atBlock: "0x67" })).toEqual([]);
    // D's reverted delete at 104 changed nothing; the real one at 105 did.
    expect(await keysOf("tag = str('demo-x')", { atBlock: "0x68" })).toEqual([KEY_D]);
    expect(await keysOf("tag = str('demo-x')", { atBlock: "0x69" })).toEqual([]);
    // A's old attributes at 101, its new ones from 102.
    expect(await keysOf("flag = true", { atBlock: "0x65" })).toEqual([KEY_A]);
    expect(await keysOf("rank = u64(5)", { atBlock: "0x65" })).toEqual([KEY_A]);
    expect(await keysOf("rank = u64(5)", { atBlock: "0x66" })).toEqual([]);
    // Ownership and expiry history.
    expect(await keysOf(`$owner = addr(${CAROL})`, { atBlock: "0x66" })).toEqual([KEY_C, KEY_D]);
    expect(await keysOf("$expiresAt = u64(200)", { atBlock: "0x66" })).toEqual([KEY_B]);
    expect(await keysOf("$expiresAt = u64(300)", { atBlock: "0x67" })).toEqual([KEY_B]);

    // Without atBlock the read is at the projection head; "latest" is not a quantity, as on the node.
    expect((await result<{ blockNumber: string }>("arkiv_query", ["*"])).blockNumber).toBe("0x69");
    expect(await errorOf("arkiv_query", ["*", { atBlock: "latest" }])).toEqual({ code: -32602, message: "InvalidParams" });
    expect((await result<{ blockNumber: string }>("arkiv_query", ["*", { atBlock: 101 }])).blockNumber).toBe("0x65");
    const historical = await result<{ blockNumber: string }>("arkiv_query", ["*", { atBlock: "0x65" }]);
    expect(historical.blockNumber).toBe("0x65");
  });

  test("blocks outside the projection are unavailable; atBlock is a quantity", async () => {
    expect(await errorOf("arkiv_query", ["*", { atBlock: "0x6a" }])).toEqual({
      code: -32006,
      message: "query rejected (block): block 106 is above the entity index head 105",
    });
    expect(await errorOf("arkiv_query", ["*", { atBlock: "0x63" }])).toEqual({
      code: -32006,
      message: "query rejected (block): block 99 is below the entity index floor 100",
    });
    // The node's quantities: a JSON integer or 0x hex without leading zeros.
    for (const atBlock of ["earliest", "pending", "0x065", "65", "0x", -1, 1.5]) {
      expect(await errorOf("arkiv_query", ["*", { atBlock }])).toEqual({ code: -32602, message: "InvalidParams" });
    }
  });

  test("pages are bound to their query, block and select through the cursor", async () => {
    const CURSOR = {
      code: -32005,
      message: "query rejected (cursor): the cursor expired, is malformed, or belongs to another query, block or selection",
    };
    const first = await result<{ data: Array<{ key: string }>; cursor?: string }>("arkiv_query", ["*", { limit: "0x1" }]);
    expect(first.data.map((entity) => entity.key)).toEqual([KEY_A]);
    // The node's cursor shape: 0x and 64 hex digits.
    expect(first.cursor).toMatch(/^0x[0-9a-f]{64}$/);

    const second = await result<{ data: Array<{ key: string }>; cursor?: string }>("arkiv_query", [
      "*",
      { limit: 1, cursor: first.cursor, atBlock: "0x69" },
    ]);
    expect(second.data.map((entity) => entity.key)).toEqual([KEY_B]);

    const rest = await result<{ data: Array<{ key: string }>; cursor?: string }>("arkiv_query", [
      "*",
      { limit: 5, cursor: second.cursor, atBlock: "0x69" },
    ]);
    // A different limit is not part of the binding.
    expect(rest.data.map((entity) => entity.key)).toEqual([KEY_F, KEY_C]);
    expect(rest.cursor).toBeUndefined();

    // A cursor pins its block, so the node refuses one without atBlock.
    expect(await errorOf("arkiv_query", ["*", { limit: 1, cursor: first.cursor }])).toEqual(CURSOR);
    expect(await errorOf("arkiv_query", ["project = str('demo')", { limit: 1, cursor: first.cursor, atBlock: "0x69" }])).toEqual(CURSOR);
    expect(await errorOf("arkiv_query", ["*", { limit: 1, cursor: first.cursor, atBlock: "0x68" }])).toEqual(CURSOR);
    expect(await errorOf("arkiv_query", ["*", { limit: 1, cursor: first.cursor, atBlock: "0x69", select: { owner: true } }])).toEqual(CURSOR);
    for (const cursor of ["junk", 5, null, `0x${"00".repeat(32)}`, `0x${"0".repeat(63)}`]) {
      expect(await errorOf("arkiv_query", ["*", { cursor, atBlock: "0x69" }])).toEqual(CURSOR);
    }
  });

  test("the projection follows select, with the node's value encodings", async () => {
    const [b] = (
      await result<{ data: Array<Record<string, unknown>> }>("arkiv_query", [
        `$key = key(${KEY_B})`,
        {
          select: {
            key: true,
            owner: true,
            creator: true,
            createdAt: true,
            updatedAt: true,
            expiresAt: true,
            creationFlags: true,
            attributeSchema: true,
            attributes: true,
          },
        },
      ])
    ).data;
    expect(b).toEqual({
      key: KEY_B,
      owner: ALICE,
      creator: ALICE,
      createdAt: "0x64",
      updatedAt: "0x67",
      expiresAt: "0x12c",
      creationFlags: { readonly: true, permissionlessExtension: true, raw: 3 },
      attributeSchema: [
        { name: "name", type: "str", indexed: true },
        { name: "project", type: "str", indexed: true },
        { name: "rank", type: "u64", indexed: true },
      ],
      attributes: [
        { name: "name", type: "str", value: "bob" },
        { name: "project", type: "str", value: "demo" },
        { name: "rank", type: "u64", value: "0x9" },
      ],
    });

    // key is selected unless the selection turns it off, as on the node.
    const [a] = (
      await result<{ data: Array<Record<string, unknown>> }>("arkiv_query", [
        `$key = key(${KEY_A})`,
        { select: { attributes: { rank: true, score: true, level: true, who: true, missing: true, project: false } } },
      ])
    ).data;
    expect(a).toEqual({
      key: KEY_A,
      attributes: [
        { name: "level", type: "i32", value: -3 },
        { name: "rank", type: "i32", value: 7 },
        { name: "score", type: "dec", value: "1.5" },
        { name: "who", type: "addr", value: BOB },
      ],
    });

    const [defaults] = (await result<{ data: Array<Record<string, unknown>> }>("arkiv_query", [`$key = key(${KEY_A})`])).data;
    expect(defaults).toEqual({ key: KEY_A });
    const [empty] = (await result<{ data: Array<Record<string, unknown>> }>("arkiv_query", [`$key = key(${KEY_A})`, { select: {} }])).data;
    expect(empty).toEqual({ key: KEY_A });
    const [nothing] = (
      await result<{ data: Array<Record<string, unknown>> }>("arkiv_query", [`$key = key(${KEY_A})`, { select: { key: false } }])
    ).data;
    expect(nothing).toEqual({});
    // Without a stored EntityCreated log the flags come from the calldata.
    const [calldataFlags] = (
      await result<{ data: Array<Record<string, unknown>> }>("arkiv_query", [`$key = key(${KEY_F})`, { select: { key: false, creationFlags: true } }])
    ).data;
    expect(calldataFlags).toEqual({ creationFlags: { raw: 0, readonly: false, permissionlessExtension: false } });
  });

  test("malformed options and queries answer the node's codes and messages", async () => {
    const INVALID = { code: -32602, message: "InvalidParams" };
    // select takes exactly the SDK's RpcSelect keys: the removed payload and contentType are invalid params.
    for (const select of [{ payload: true }, { contentType: true }, { bogus: true }, { key: "yes" }, { attributes: 3 }, { attributes: { a: 1 } }, { attributes: { "1bad": true } }, 5, ["key"], null]) {
      expect(await errorOf("arkiv_query", ["*", { select }])).toEqual(INVALID);
    }
    for (const options of [{ limit: 0 }, { limit: 201 }, { limit: "0x12c" }, { limit: "abc" }, { limit: "0x05" }, { bogus: 1 }, 5, null]) {
      expect(await errorOf("arkiv_query", ["*", options])).toEqual(INVALID);
    }
    expect(await errorOf("arkiv_query", [5])).toEqual(INVALID);
    expect(await errorOf("arkiv_query", [])).toEqual(INVALID);
    expect(await errorOf("arkiv_query", ["*", {}, {}])).toEqual(INVALID);
    expect(await errorOf("arkiv_query", ["* AND a = true"])).toEqual({
      code: -32001,
      message: "query rejected (parse): * matches every entity and cannot be combined with other predicates",
      data: { position: 2, got: "AND", expected: "* matches every entity and cannot be combined with other predicates" },
    });
    expect((await errorOf("arkiv_query", ["a != true"])).code).toBe(-32002);
    expect((await errorOf("arkiv_query", ["a = i32(99999999999)"])).code).toBe(-32003);
    expect((await errorOf("arkiv_query", ["(".repeat(40)])).code).toBe(-32004);
    // The query is checked before the options, as on the node.
    expect((await errorOf("arkiv_query", ["x ==", { bogus: 1 }])).code).toBe(-32001);
    expect((await errorOf("arkiv_getBlockTiming", [1])).message).toBe("InvalidParams");
    for (const params of [[{ block: "0x66" }], [{ block: -1 }], [{ query: 5 }], [5], [{}, {}]]) {
      expect(await errorOf("arkiv_getEntityCount", params)).toEqual(INVALID);
    }
  });

  test("values the bigint columns cannot hold are answered, not leaked as driver errors", async () => {
    // A forged cursor whose createdAt is past 2^63 - 1.
    const binding = cursorBinding("*", 105n, projectionFingerprint(defaultProjection()));
    const forged = encodeCursor({ createdAt: 1n << 63n, position: 0, opIndex: 0 }, binding);
    expect((await errorOf("arkiv_query", ["*", { cursor: forged, atBlock: "0x69" }])).code).toBe(-32005);
    // A cursor this index issued resumes; the same position bound elsewhere does not.
    const genuine = encodeCursor({ createdAt: 100n, position: 0, opIndex: 0 }, binding);
    expect(await keysOf("*", { cursor: genuine, atBlock: "0x69" })).toEqual([KEY_B, KEY_F, KEY_C]);
    // $createdAt against a u64 the column cannot hold.
    expect(await keysOf("$createdAt >= u64(9223372036854775808)")).toEqual([]);
    expect(await result<number>("arkiv_getEntityCount", [{ query: "$createdAt < u64(18446744073709551615)" }])).toBe(4);
    // A NUL byte in a str literal.
    expect(await keysOf("project = str('demo\0')")).toEqual([]);
    expect(await result<number>("arkiv_getEntityCount", [{ query: "project STARTSWITH str('a\0')" }])).toBe(0);
  });

  test("arkiv_getEntityCount counts what matches at a block", async () => {
    expect(await result<number>("arkiv_getEntityCount")).toBe(4);
    expect(await result<number>("arkiv_getEntityCount", [{ query: "project = str('demo')" }])).toBe(2);
    expect(await result<number>("arkiv_getEntityCount", [{ block: 102 }])).toBe(6);
    expect(await result<number>("arkiv_getEntityCount", [{ query: "$expiresAt < u64(200)", block: 102 }])).toBe(3);
    expect((await errorOf("arkiv_getEntityCount", [{ block: "0x66" }])).code).toBe(-32602);
    expect((await errorOf("arkiv_getEntityCount", [{ query: "a != true" }])).code).toBe(-32002);
  });

  test("arkiv_getEntity is not served: the UDC node has none", async () => {
    expect((await errorOf("arkiv_getEntity", [KEY_A])).code).toBe(-32601);
    // Its old answers come from arkiv_query on $key, at the head or at a block.
    expect(await getEntity(KEY_A)).toMatchObject({ key: KEY_A, owner: ALICE, createdAt: "0x64", updatedAt: "0x66", expiresAt: "0x96" });
    expect(await getEntity(KEY_D)).toBeNull();
    expect(await getEntity(KEY_D, 104)).toMatchObject({ key: KEY_D, owner: CAROL });
    expect(await getEntity(KEY_E)).toBeNull();
    expect(await getEntity(KEY_E, 102)).toMatchObject({ key: KEY_E });
  });

  test("arkiv_getBlockTiming describes the projection head", async () => {
    expect(await result<unknown>("arkiv_getBlockTiming")).toEqual({
      current_block: 105,
      current_block_time: Math.floor(Date.UTC(2026, 8, 3, 0, 0, 210) / 1000),
      duration: 2,
    });
  });

  test("operations landing below the fold point are picked up by the late scan", async () => {
    // A rescan of block 101 changes C's create — the kind of write a gap fill
    // or a re-scan makes without moving the head.
    const [rescanned] = fixtureChain().filter((block) => block.blockNumber === 101);
    rescanned!.operations[0]!.operations[0]!.attributes = [str("project", "changed")];
    await storage.saveBlockMetrics(metrics(101, 1), { kind: "none" }, rescanned!.transactions, rescanned!.transactions, rescanned!.operations);

    const projector = new EntityProjector(index, { lateScanIntervalMs: 0, lateScanOverlapMs: 0, log: () => {} });
    const tick = await projector.runOnce();
    expect(tick.lateKeysRefolded).toBeGreaterThanOrEqual(1);
    expect(await keysOf("project = str('changed')")).toEqual([KEY_C]);
    expect(await keysOf("project = str('other')")).toEqual([]);
    // D was in the same transaction and was refolded too, unchanged.
    expect(await keysOf("tag = str('demo-x')", { atBlock: "0x68" })).toEqual([KEY_D]);
  });

  test("new blocks extend the projection; one transaction's creates follow operation order; unindexed attributes are kept, never matched", async () => {
    // Two creates in one transaction: 0x77… is operation 0, 0x66… operation 1.
    // The UDC node hands out entity ids in creation order, operations in
    // calldata order, so oldest-first puts 0x77… before 0x66… whatever the keys.
    const high = `0x${"77".repeat(32)}`;
    const low = `0x${"66".repeat(32)}`;
    const blobHash = `0x${"b0".repeat(32)}`;
    const logs = [createdLog(0, high, BOB, 500), createdLog(1, low, BOB, 500)];
    await storage.saveBlockMetrics(
      metrics(106, 1),
      { kind: "lastSuccessfulBlock" },
      [registryTx(106, 0, BOB, { logs })],
      [registryTx(106, 0, BOB, { logs })],
      [
        {
          position: 0,
          hash: registryTx(106, 0, BOB).hash,
          operations: [
            operation({
              opIndex: 0,
              operationType: 1,
              entityKey: high,
              ...lifetime(394),
              bytesSize: 11,
              attributes: [
                udcAttribute("blob", "bytes", null, { size: 11, keccak256: blobHash }),
                udcAttribute("note", "str", "hidden", { indexed: false }),
                str("project", "new"),
              ],
            }),
            operation({ opIndex: 1, operationType: 1, entityKey: low, ...lifetime(394), attributes: [str("project", "new")] }),
          ],
        },
      ],
    );
    // Scanned but not yet projected: the timing head stays where the index is,
    // so a caller pinning reads to it lands on a block the index can answer.
    expect((await result<{ current_block: number }>("arkiv_getBlockTiming")).current_block).toBe(105);
    const projector = new EntityProjector(index, { log: () => {} });
    const tick = await projector.runOnce();
    expect(tick.projectedThroughBlock).toBe(106n);
    expect((await result<{ current_block: number }>("arkiv_getBlockTiming")).current_block).toBe(106);
    expect(await keysOf("project = str('new')")).toEqual([high, low]);
    expect((await keysOf("*")).slice(-2)).toEqual([high, low]);
    // A cursor between the two resumes at the second operation's entity.
    const firstPage = await result<{ data: { key: string }[]; cursor?: string }>("arkiv_query", ["project = str('new')", { limit: 1, atBlock: "0x6a" }]);
    expect(firstPage.data.map((entity) => entity.key)).toEqual([high]);
    const secondPage = await result<{ data: { key: string }[] }>("arkiv_query", ["project = str('new')", { limit: 1, cursor: firstPage.cursor, atBlock: "0x6a" }]);
    expect(secondPage.data.map((entity) => entity.key)).toEqual([low]);
    expect((await result<{ blockNumber: string }>("arkiv_query", ["*"])).blockNumber).toBe("0x6a");
    expect(await result<number>("arkiv_getEntityCount")).toBe(6);
    const stats = await index.getStats();
    expect(stats.liveEntities).toBe(6);

    // The unindexed str and the bytes are stored and returned (bytes as null),
    // and listed in the schema with their flag — but no predicate matches them.
    expect(await keysOf("note = str('hidden')")).toEqual([]);
    expect(await result<number>("arkiv_getEntityCount", [{ query: "note STARTSWITH str('hid')" }])).toBe(0);
    const [entity] = (
      await result<{ data: Array<Record<string, unknown>> }>("arkiv_query", [`$key = key(${high})`, { select: { attributeSchema: true, attributes: true } }])
    ).data;
    expect(entity).toEqual({
      key: high,
      attributeSchema: [
        { name: "blob", type: "bytes", indexed: false },
        { name: "note", type: "str", indexed: false },
        { name: "project", type: "str", indexed: true },
      ],
      attributes: [
        { name: "blob", type: "bytes", value: null },
        { name: "note", type: "str", value: "hidden" },
        { name: "project", type: "str", value: "new" },
      ],
    });
    const [version] = await index.getEntityVersions(high);
    expect(version).toMatchObject({ bytesSize: 11, schemaName: null });
    const rows = await indexDb.query<{ name: string; type_id: number; indexed: boolean; value_text: string; value_num: string | null }>(
      `SELECT name, type_id, indexed, value_text, value_num::text AS value_num FROM "${indexSchema}".entity_version_attributes WHERE entity_key = $1 ORDER BY name`,
      [high],
    );
    expect(rows.rows).toEqual([
      { name: "blob", type_id: 7, indexed: false, value_text: blobHash, value_num: "11" },
      { name: "note", type_id: 8, indexed: false, value_text: "hidden", value_num: null },
      { name: "project", type_id: 8, indexed: true, value_text: "new", value_num: null },
    ]);
  });

  test("the HTTP path answers only when the index is configured and shows up in /health", async () => {
    const without = createBlockServer(storage, { port: 0 });
    try {
      const response = await fetch(`http://${without.hostname}:${without.port}/shadow-rpc/experimental`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "arkiv_getEntityCount", params: [] }),
      });
      expect(response.status).toBe(404);
      const health = (await (await fetch(`http://${without.hostname}:${without.port}/health`)).json()) as HealthResponseBody;
      expect(health.features.entityQueryIndex).toBe(false);
    } finally {
      await without.stop();
    }

    const server = createBlockServer(storage, { port: 0, entityIndex: index, auth: testAuth() });
    try {
      // The relay is admin-only; the token is sent on both paths to show the
      // experimental one does not need it.
      const post = (body: unknown, path = "/shadow-rpc/experimental") =>
        fetch(`http://${server.hostname}:${server.port}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...testAdminHeaders },
          body: JSON.stringify(body),
        }).then((response) => response.json() as Promise<JsonRpcResponse>);
      const count = await post({ jsonrpc: "2.0", id: 7, method: "arkiv_getEntityCount", params: [] });
      expect(count).toEqual({ jsonrpc: "2.0", id: 7, result: 6 });
      // The default path does not know the method (no passthrough is configured here).
      const plain = await post({ jsonrpc: "2.0", id: 8, method: "arkiv_getEntityCount", params: [] }, "/shadow-rpc");
      expect(plain.error?.code).toBe(-32601);
      // Everything else on the experimental path is the same shadow surface.
      const head = await post({ jsonrpc: "2.0", id: 9, method: "eth_blockNumber", params: [] });
      expect(head.result).toBe("0x6a");
      const health = (await (await fetch(`http://${server.hostname}:${server.port}/health`)).json()) as HealthResponseBody;
      expect(health.features.entityQueryIndex).toEqual({
        ready: true, readiness: "ready", genesisBootstrapVersion: 1,
        path: "/shadow-rpc/experimental",
        methods: [...ARKIV_INDEX_METHODS],
        floorBlock: "100",
        projectedThroughBlock: "106",
        lagBlocks: "0",
        liveEntities: 6,
        liveEntitiesAtUtc: expect.any(String),
        lastFoldAtUtc: expect.any(String),
        genesis: null,
      });
    } finally {
      await server.stop();
    }
  });

  test("a backfilled keyed create below the floor is folded and lowers the floor", async () => {
    // The backfill scanner writes block 99 — older than anything the index
    // had seen — without moving the head.
    const key = `0x${"99".repeat(32)}`;
    await storage.saveBlockMetrics(
      metrics(99, 1),
      { kind: "none" },
      [registryTx(99, 0, BOB, { logs: [createdLog(0, key, BOB, 500)] })],
      [registryTx(99, 0, BOB, { logs: [createdLog(0, key, BOB, 500)] })],
      [
        {
          position: 0,
          hash: registryTx(99, 0, BOB).hash,
          operations: [operation({ opIndex: 0, operationType: 1, entityKey: key, ...lifetime(401), attributes: [str("project", "backfilled")] })],
        },
      ],
    );
    const logs: string[] = [];
    const projector = new EntityProjector(index, { lateScanIntervalMs: 0, lateScanOverlapMs: 0, log: (line) => logs.push(line) });
    const tick = await projector.runOnce();
    expect(tick.lateKeysRefolded).toBe(1);
    expect((await index.getProgress()).floorBlock).toBe(99n);
    expect(logs.some((line) => line.includes("floor lowered to block 99"))).toBe(true);
    expect(await keysOf("project = str('backfilled')")).toEqual([key]);
    // Block 99 is now inside the index, and the entity is the oldest of all.
    expect(await keysOf("project = str('backfilled')", { atBlock: "0x63" })).toEqual([key]);
    expect((await keysOf("*"))[0]).toBe(key);
    expect((await index.getProgress()).projectedThroughBlock).toBe(106n);
    expect(await result<number>("arkiv_getEntityCount")).toBe(7);
  });
});

describeWithPostgres("genesis import (Postgres)", () => {
  let storage: ScannerStorage;
  let index: EntityIndexStorage;
  let db: Db;
  let schema: string;
  let cleanup: () => Promise<void>;
  let methods: ReturnType<typeof createArkivIndexMethods>;
  const OWNER = FAKE_GENESIS_OWNER;
  const keyOf = (id: number) => fakeWireEntity(id).key as string;
  const SEVEN = Array.from({ length: 7 }, (_, id) => fakeWireEntity(id));
  // Four entities, the last of which lapses at block 1: live at block 0 only.
  const FOUR = [fakeWireEntity(0), fakeWireEntity(1), fakeWireEntity(2), fakeWireEntity(3, { expiresAt: "0x1" })];
  const attributesOf = (versions: { attributes: { name: string; typeId: number; valueText: string }[] }) =>
    versions.attributes.map((attribute) => `${attribute.name}:${attribute.typeId}=${attribute.valueText}`);

  const call = async (method: string, params: unknown[] = []): Promise<JsonRpcResponse> =>
    (await handleJsonRpcBody({ jsonrpc: "2.0", id: 1, method, params }, storage, { localOverrides: methods })) as JsonRpcResponse;
  const result = async <T = unknown>(method: string, params: unknown[] = []): Promise<T> => {
    const response = await call(method, params);
    if (response.error) throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
    return response.result as T;
  };
  const keysOf = async (query: string, options: Record<string, unknown> = {}) =>
    (await result<{ data: Array<{ key: string }> }>("arkiv_query", [query, { limit: 50, ...options }])).data.map((entity) => entity.key);

  /** What `arkiv_getEntity` used to answer, through `arkiv_query` (the UDC node has no getEntity). */
  const getEntity = async (key: string, block?: number): Promise<Record<string, unknown> | null> => {
    const select = { key: true, owner: true, creator: true, createdAt: true, updatedAt: true, expiresAt: true, creationFlags: true, attributes: true };
    const page = await result<{ data: Array<Record<string, unknown>> }>("arkiv_query", [
      `$key = key(${key.toLowerCase()})`,
      { select, ...(block === undefined ? {} : { atBlock: `0x${block.toString(16)}` }) },
    ]);
    return page.data[0] ?? null;
  };

  beforeAll(async () => {
    const isolated = await createIsolatedStorage("entity_genesis");
    storage = isolated.storage;
    schema = isolated.schema;
    cleanup = isolated.cleanup;
    db = openDb(TEST_DATABASE_URL!, { max: 2 });
    index = await EntityIndexStorage.fromDb(db, { schema });
    methods = createArkivIndexMethods(index, storage);
    await storage.saveChainId(7733102n);
    // A stored block gives the projector a head; the genesis entities need no transactions.
    await storeBlock(storage, { blockNumber: 1, transactions: [], operations: [] });
  });

  afterAll(async () => {
    await cleanup();
    await db.close();
    await closeTestPools();
  });

  test("a seeded genesis is imported once, vouched for from block 0, and paged in the node's order", async () => {
    const source = createFakeGenesisSource(SEVEN);
    const logs: string[] = [];
    const projector = new EntityProjector(index, { genesis: { source, batchEntities: 4, pageSize: 3 }, log: (line) => logs.push(line) });
    const tick = await projector.runOnce();
    expect(tick.genesisStatus).toBe("done");
    expect(tick.genesisEntitiesImported).toBe(7);
    expect(tick.genesisKeysRepaired).toBe(0);
    expect(tick.projectedThroughBlock).toBe(1n);
    expect(source.pages).toBe(3);
    expect((await index.getProgress()).floorBlock).toBe(0n);
    const state = await index.getGenesisImport();
    expect(state).toMatchObject({
      status: "done",
      phase: null,
      source: "rpc",
      chainId: "7733102",
      total: 7,
      imported: 7,
      cursor: null,
      repairAfterKey: null,
      error: null,
    });
    expect(state!.finishedAt).toBeTruthy();
    expect(state!.updatedAt).toBeTruthy();
    expect(logs.some((line) => line.includes("importing 7 genesis entities"))).toBe(true);
    expect(logs.some((line) => line.includes("floor set to block 0"))).toBe(true);
    expect(logs.some((line) => line.includes("genesis import done"))).toBe(true);

    // Oldest first is ascending entity id, at block 0 and at the head alike.
    const ids = [0, 1, 2, 3, 4, 5, 6].map(keyOf);
    expect(await keysOf("*", { atBlock: "0x0" })).toEqual(ids);
    expect(await keysOf("*")).toEqual(ids);
    expect(await result<number>("arkiv_getEntityCount", [{ block: 0 }])).toBe(7);
    expect(await result<number>("arkiv_getEntityCount")).toBe(7);
    expect(await keysOf("n >= u64(5)")).toEqual([keyOf(5), keyOf(6)]);
    expect(await keysOf(`$owner = addr(${OWNER}) AND kind = str('seed')`, { limit: 2 })).toEqual([keyOf(0), keyOf(1)]);

    // The index's own cursor walks the set once, without a repeat.
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await result<{ data: { key: string }[]; cursor?: string }>("arkiv_query", [
        "*",
        { atBlock: "0x0", limit: 2, ...(cursor ? { cursor } : {}) },
      ]);
      seen.push(...page.data.map((entity) => entity.key));
      cursor = page.cursor;
    } while (cursor);
    expect(seen).toEqual(ids);

    // Everything the node says about a genesis entity.
    expect(await getEntity(keyOf(5), 0)).toEqual({
      key: keyOf(5),
      owner: OWNER,
      creator: OWNER,
      createdAt: "0x0",
      updatedAt: "0x0",
      expiresAt: "0xffffffffffffffff",
      creationFlags: { readonly: false, permissionlessExtension: false, raw: 0 },
      attributes: [
        { name: "kind", type: "str", value: "seed" },
        { name: "n", type: "u64", value: "0x5" },
      ],
    });

    const server = createBlockServer(storage, { port: 0, entityIndex: index });
    try {
      const health = (await (await fetch(`http://${server.hostname}:${server.port}/health`)).json()) as HealthResponseBody;
      expect(health.features.entityQueryIndex).toMatchObject({
        floorBlock: "0",
        projectedThroughBlock: "1",
        liveEntities: 7,
        liveEntitiesAtUtc: expect.any(String),
        genesis: { status: "done", phase: null, source: "rpc", total: 7, imported: 7, error: null, updatedAtUtc: expect.any(String) },
      });
      // The entity page: a genesis entity has no operations, so the index's block-0 version answers for it.
      const page = await fetch(`http://${server.hostname}:${server.port}/entity/${keyOf(5)}`);
      expect(page.status).toBe(200);
      expect(await page.json()).toMatchObject({
        entityKey: keyOf(5),
        count: 0,
        totalOperations: 0,
        operations: [],
        genesis: {
          owner: OWNER,
          creator: OWNER,
          expiresAt: "18446744073709551615",
          creationFlags: 0,
          bytesSize: 0,
          schemaName: null,
          attributes: [
            { name: "kind", type: "str", indexed: true, value: "seed" },
            { name: "n", type: "u64", indexed: true, value: "0x5" },
          ],
        },
        // The index's newest state, served fresh beside the cached history.
        state: {
          asOfBlock: "1",
          status: "live",
          version: 0,
          createdAt: "0",
          updatedAt: "0",
          expiresAt: "18446744073709551615",
          permanent: true,
          bytesSize: 0,
          schemaName: null,
        },
      });
      const unknown = await fetch(`http://${server.hostname}:${server.port}/entity/0x${"ab".repeat(32)}`);
      expect(unknown.status).toBe(404);
    } finally {
      await server.stop();
    }

    // A second tick has nothing left to import.
    const again = await projector.runOnce();
    expect(again.genesisStatus).toBe("done");
    expect(again.genesisEntitiesImported).toBe(0);
    expect(source.pages).toBe(3);
  });

  test("an interrupted walk resumes from its cursor without duplicating rows", async () => {
    await index.reset();
    const source = createFakeGenesisSource(SEVEN);
    source.failPage(2, new Error("boom"));
    const projector = new EntityProjector(index, { genesis: { source, batchEntities: 3, pageSize: 3 }, log: () => {} });
    await expect(projector.runOnce()).rejects.toThrow("boom");
    expect(await index.getGenesisImport()).toMatchObject({ status: "running", phase: "walk", imported: 3, cursor: "c:3" });
    expect(await index.getEntityVersions(keyOf(0))).toHaveLength(1);
    expect(await index.getEntityVersions(keyOf(3))).toHaveLength(0);
    // Nothing is served while the import owns the index.
    expect((await call("arkiv_getEntityCount")).error?.message).toMatch(/entity index is incomplete/);

    const tick = await projector.runOnce();
    expect(tick.genesisStatus).toBe("done");
    expect(tick.genesisEntitiesImported).toBe(4);
    expect(source.pages).toBe(4);
    const rows = await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM "${schema}".entity_versions`);
    expect(rows.rows[0]!.count).toBe("7");
    const positions = await Promise.all([6, 5, 4, 3, 2, 1, 0].map(async (id) => (await index.getEntityVersions(keyOf(id)))[0]!.createdPosition));
    expect(positions).toEqual([6, 5, 4, 3, 2, 1, 0]);
    expect(await keysOf("*", { atBlock: "0x0" })).toEqual([0, 1, 2, 3, 4, 5, 6].map(keyOf));
  });

  test("a node restart mid-walk (-32005, the cursor is gone) starts the walk over without duplicating rows", async () => {
    await index.reset();
    const source = createFakeGenesisSource(SEVEN);
    // UDC node cursors are process-local: after a restart a stored cursor is refused.
    source.failPage(
      3,
      new GenesisRpcError(
        "arkiv_query",
        -32005,
        "query rejected (cursor): the cursor expired, is malformed, or belongs to another query, block or selection",
      ),
    );
    const logs: string[] = [];
    const projector = new EntityProjector(index, { genesis: { source, batchEntities: 3, pageSize: 3 }, log: (line) => logs.push(line) });
    const first = await projector.runOnce();
    expect(first.genesisStatus).toBe("running");
    expect(await index.getGenesisImport()).toMatchObject({ status: "running", phase: "walk", imported: 0, cursor: null, error: null });
    expect(logs.some((line) => line.includes("restarting the walk from the first page"))).toBe(true);
    const partial = await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM "${schema}".entity_versions`);
    expect(partial.rows[0]!.count).toBe("6");

    const second = await projector.runOnce();
    expect(second.genesisStatus).toBe("done");
    const rows = await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM "${schema}".entity_versions`);
    expect(rows.rows[0]!.count).toBe("7");
    expect(await index.getGenesisImport()).toMatchObject({ status: "done", imported: 7, total: 7 });
    const positions = await Promise.all([0, 1, 2, 3, 4, 5, 6].map(async (id) => (await index.getEntityVersions(keyOf(id)))[0]!.createdPosition));
    expect(positions).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(await keysOf("*", { atBlock: "0x0" })).toEqual([0, 1, 2, 3, 4, 5, 6].map(keyOf));
  });

  test("a node that refuses every cursor fails the import after three restarts instead of walking forever", async () => {
    await index.reset();
    const expired = new GenesisRpcError(
      "arkiv_query",
      -32005,
      "query rejected (cursor): the cursor expired, is malformed, or belongs to another query, block or selection",
    );
    const source = createFakeGenesisSource(SEVEN, { cursorError: expired });
    const logs: string[] = [];
    const projector = new EntityProjector(index, { genesis: { source, batchEntities: 3, pageSize: 3 }, log: (line) => logs.push(line) });
    const statuses: Array<string | undefined> = [];
    for (let tick = 0; tick < 8; tick++) statuses.push((await projector.runOnce()).genesisStatus);
    // Each tick reads the first page and is refused the second: three restarts, then the fourth refusal fails it.
    expect(statuses.slice(0, 4)).toEqual(["running", "running", "running", "failed"]);
    expect(statuses.slice(4).every((status) => status === "failed")).toBe(true);
    expect(source.pages).toBe(8);
    expect(logs.filter((line) => line.includes("restarting the walk from the first page"))).toHaveLength(3);
    const failed = await index.getGenesisImport();
    expect(failed).toMatchObject({ status: "failed", phase: null });
    expect(failed?.error).toMatch(/refused the genesis walk's cursor 4 times in a row/);
    // Failed closed: nothing is served from a partial genesis.
    expect((await call("arkiv_getEntityCount")).error?.message).toMatch(/entity index/);
  });

  test("a restart run ends once a cursor works again, so later node restarts each get their own restarts", async () => {
    await index.reset();
    const expired = () =>
      new GenesisRpcError("arkiv_query", -32005, "query rejected (cursor): the cursor expired, is malformed, or belongs to another query, block or selection");
    const source = createFakeGenesisSource(SEVEN);
    // Each tick reads the first page and is refused the second (pages 2, 4, 6): three restarts.
    for (const n of [2, 4, 6]) source.failPage(n, expired());
    const projector = new EntityProjector(index, { genesis: { source, batchEntities: 1, pageSize: 3 }, log: () => {} });
    for (let tick = 0; tick < 3; tick++) expect((await projector.runOnce()).genesisStatus).toBe("running");
    // The fourth tick's cursor works (page 8), so the expiry on page 9 starts a new run instead of failing.
    source.failPage(9, expired());
    expect((await projector.runOnce()).genesisStatus).toBe("running");
    expect(await index.getGenesisImport()).toMatchObject({ status: "running", cursor: null, imported: 0 });
    expect((await projector.runOnce()).genesisStatus).toBe("done");
    expect(await index.getGenesisImport()).toMatchObject({ status: "done", imported: 7, total: 7 });
  });

  test("stop() ends the walk after the batch in flight, and the next start resumes it", async () => {
    await index.reset();
    const source = createFakeGenesisSource(SEVEN);
    const projector = new EntityProjector(index, { genesis: { source, batchEntities: 3, pageSize: 3 }, log: () => {} });
    const tick = projector.runOnce();
    await projector.stop(); // returns once the batch in flight is committed, not after the whole walk
    expect((await tick).genesisStatus).toBe("running");
    expect(await index.getGenesisImport()).toMatchObject({ status: "running", phase: "walk", imported: 3, cursor: "c:3" });
    expect(source.pages).toBe(2); // the page prefetched during the commit is dropped

    const restarted = new EntityProjector(index, { genesis: { source, batchEntities: 3, pageSize: 3 }, log: () => {} });
    const resumed = await restarted.runOnce();
    expect(resumed.genesisStatus).toBe("done");
    expect(resumed.genesisEntitiesImported).toBe(4);
    expect(source.pages).toBe(4);
    const rows = await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM "${schema}".entity_versions`);
    expect(rows.rows[0]!.count).toBe("7");
    expect(await keysOf("*", { atBlock: "0x0" })).toEqual([0, 1, 2, 3, 4, 5, 6].map(keyOf));
  });

  test("operations on genesis entities fold on top of their genesis state", async () => {
    await index.reset();
    // Block 2 patches G2, extends G1 and transfers G0; block 3 deletes G1.
    await storeBlock(storage, {
      blockNumber: 2,
      transactions: [
        registryTx(2, 0, OWNER, { logs: [patchedLog(0, keyOf(2), OWNER)] }),
        registryTx(2, 1, OWNER, { logs: [extendedLog(0, keyOf(1), OWNER, 500)] }),
        registryTx(2, 2, OWNER, { logs: [transferredLog(0, keyOf(0), OWNER, BOB)] }),
      ],
      operations: [
        {
          position: 0,
          hash: registryTx(2, 0, OWNER).hash,
          operations: [operation({ opIndex: 0, operationType: 2, entityKey: keyOf(2), attributes: [i32("rank", "7"), tombstone("kind")] })],
        },
        {
          position: 1,
          hash: registryTx(2, 1, OWNER).hash,
          operations: [operation({ opIndex: 0, operationType: 3, entityKey: keyOf(1), ...deadline(500) })],
        },
        {
          position: 2,
          hash: registryTx(2, 2, OWNER).hash,
          operations: [operation({ opIndex: 0, operationType: 4, entityKey: keyOf(0), newOwner: BOB })],
        },
      ],
    });
    await storeBlock(storage, {
      blockNumber: 3,
      transactions: [registryTx(3, 0, OWNER, { logs: [deletedLog(0, keyOf(1), OWNER)] })],
      operations: [{ position: 0, hash: registryTx(3, 0, OWNER).hash, operations: [operation({ opIndex: 0, operationType: 5, entityKey: keyOf(1) })] }],
    });

    const source = createFakeGenesisSource(FOUR);
    const projector = new EntityProjector(index, { genesis: { source }, log: () => {} });
    const tick = await projector.runOnce();
    expect(tick.genesisStatus).toBe("done");
    expect(tick.projectedThroughBlock).toBe(3n);

    // G2: the base keeps the block-0 state; the head shows the patch on top of it.
    const g2 = await index.getEntityVersions(keyOf(2));
    expect(g2.map((version) => [version.version, version.fromBlock, version.toBlock])).toEqual([
      [0, 0, 2],
      [1, 2, null],
    ]);
    expect(attributesOf(g2[0]!)).toEqual(["kind:8=seed", "n:3=2"]);
    expect(attributesOf(g2[1]!)).toEqual(["n:3=2", "rank:2=7"]);
    expect(g2[1]).toMatchObject({ createdAt: 0, createdPosition: 2, updatedAt: 2, owner: OWNER, creator: OWNER, expiresAt: 2n ** 64n - 1n });
    expect(await getEntity(keyOf(2), 0)).toMatchObject({
      updatedAt: "0x0",
      attributes: [
        { name: "kind", type: "str", value: "seed" },
        { name: "n", type: "u64", value: "0x2" },
      ],
    });
    expect(await getEntity(keyOf(2))).toMatchObject({
      updatedAt: "0x2",
      attributes: [
        { name: "n", type: "u64", value: "0x2" },
        { name: "rank", type: "i32", value: 7 },
      ],
    });
    // G1: extended at 2, deleted at 3.
    const g1 = await index.getEntityVersions(keyOf(1));
    expect(g1.map((version) => [version.version, version.expiresAt, version.deleted])).toEqual([
      [0, 2n ** 64n - 1n, false],
      [1, 500n, false],
      [2, 500n, true],
    ]);
    expect(await getEntity(keyOf(1))).toBeNull();
    expect(await getEntity(keyOf(1), 2)).toMatchObject({ expiresAt: "0x1f4" });
    // G0: a new owner, the same creator.
    expect(await getEntity(keyOf(0))).toMatchObject({ owner: BOB, creator: OWNER });
    // G3 lapsed at block 1: counted at block 0, gone at the head.
    expect(await result<number>("arkiv_getEntityCount", [{ block: 0 }])).toBe(4);
    expect(await result<number>("arkiv_getEntityCount")).toBe(2);
    expect(await keysOf("*")).toEqual([keyOf(0), keyOf(2)]);
    expect(await keysOf("*", { atBlock: "0x0" })).toEqual([keyOf(0), keyOf(1), keyOf(2), keyOf(3)]);
    expect(await keysOf("*", { atBlock: "0x1" })).toEqual([keyOf(0), keyOf(1), keyOf(2)]);

    // A refold of G0 for a later block rebuilds it from the base again.
    await storeBlock(storage, {
      blockNumber: 4,
      transactions: [registryTx(4, 0, BOB, { logs: [patchedLog(0, keyOf(0), BOB)] })],
      operations: [
        { position: 0, hash: registryTx(4, 0, BOB).hash, operations: [operation({ opIndex: 0, operationType: 2, entityKey: keyOf(0), attributes: [str("kind", "patched")] })] },
      ],
    });
    await projector.runOnce();
    const g0 = await index.getEntityVersions(keyOf(0));
    expect(g0.map((version) => [version.version, version.fromBlock, version.owner])).toEqual([
      [0, 0, OWNER],
      [1, 2, BOB],
      [2, 4, BOB],
    ]);
    expect(attributesOf(g0[0]!)).toEqual(["kind:8=seed", "n:3=0"]);
    expect(attributesOf(g0[2]!)).toEqual(["kind:8=patched", "n:3=0"]);
  });

  test("an index that folded before the import repairs its genesis histories", async () => {
    await index.reset();
    // Block 5 creates an on-chain entity, which sets the floor at 5; block 6
    // patches G2 above that floor, and with no base that folds to nothing.
    await storeBlock(storage, {
      blockNumber: 5,
      transactions: [registryTx(5, 0, ALICE, { logs: [createdLog(0, KEY_A, ALICE, 900)] })],
      operations: [
        {
          position: 0,
          hash: registryTx(5, 0, ALICE).hash,
          operations: [operation({ opIndex: 0, operationType: 1, entityKey: KEY_A, ...deadline(900), attributes: [str("project", "onchain")] })],
        },
      ],
    });
    await storeBlock(storage, {
      blockNumber: 6,
      transactions: [registryTx(6, 0, OWNER, { logs: [patchedLog(0, keyOf(2), OWNER)] })],
      operations: [{ position: 0, hash: registryTx(6, 0, OWNER).hash, operations: [operation({ opIndex: 0, operationType: 2, entityKey: keyOf(2), attributes: [str("late", "yes")] })] }],
    });
    const blind = new EntityProjector(index, { genesis: { mode: "off" }, log: () => {} });
    const first = await blind.runOnce();
    expect(first.genesisStatus).toBeUndefined();
    expect(await index.getGenesisImport()).toBeUndefined();
    expect((await index.getProgress()).floorBlock).toBe(5n);
    expect((await index.getProgress()).projectedThroughBlock).toBe(6n);
    expect(await index.getEntityVersions(keyOf(2))).toEqual([]);
    expect(await keysOf("*")).toEqual([KEY_A]);

    const source = createFakeGenesisSource(FOUR);
    const logs: string[] = [];
    const projector = new EntityProjector(index, { genesis: { source, batchEntities: 2 }, log: (line) => logs.push(line) });
    const tick = await projector.runOnce();
    expect(tick.genesisStatus).toBe("done");
    expect(tick.genesisEntitiesImported).toBe(4);
    expect(tick.genesisKeysRepaired).toBe(3);
    expect((await index.getProgress()).floorBlock).toBe(0n);
    expect((await index.getProgress()).projectedThroughBlock).toBe(6n);
    expect(logs.some((line) => line.includes("floor set to block 0"))).toBe(true);
    expect(logs.some((line) => line.includes("3 of them refolded"))).toBe(true);
    const g2 = await index.getEntityVersions(keyOf(2));
    expect(g2.map((version) => [version.version, version.fromBlock])).toEqual([
      [0, 0],
      [1, 2],
      [2, 6],
    ]);
    expect(attributesOf(g2[2]!)).toEqual(["late:8=yes", "n:3=2", "rank:2=7"]);
    expect(await keysOf("*")).toEqual([keyOf(0), keyOf(2), KEY_A]);
    expect(await result<number>("arkiv_getEntityCount", [{ block: 0 }])).toBe(4);
    expect(await keysOf("project = str('onchain')", { atBlock: "0x4" })).toEqual([]);
    expect(await keysOf("*", { atBlock: "0x0" })).toEqual([keyOf(0), keyOf(1), keyOf(2), keyOf(3)]);
  });

  test("a probe that finds no genesis entities leaves the floor to the first keyed create while blocks below it are missing", async () => {
    await index.reset();
    const source = createFakeGenesisSource([]);
    const logs: string[] = [];
    const tick = await new EntityProjector(index, { genesis: { source }, log: (line) => logs.push(line) }).runOnce();
    expect(tick.genesisStatus).toBe("none");
    expect(await index.getGenesisImport()).toMatchObject({ status: "none", total: 0, imported: 0 });
    expect((await index.getProgress()).floorBlock).toBe(5n);
    expect(logs.some((line) => line.includes("holds no genesis entities"))).toBe(true);
    expect(source.pages).toBe(0);
  });

  test("a chain born empty and stored from block 0 is answered from block 0, as the node does", async () => {
    const isolated = await createIsolatedStorage("entity_floor_zero");
    const pool = openDb(TEST_DATABASE_URL!, { max: 2 });
    try {
      const own = isolated.storage;
      const ownIndex = await EntityIndexStorage.fromDb(pool, { schema: isolated.schema });
      const ownMethods = createArkivIndexMethods(ownIndex, own);
      const ownResult = async <T = unknown>(method: string, params: unknown[] = []): Promise<T> => {
        const response = (await handleJsonRpcBody({ jsonrpc: "2.0", id: 1, method, params }, own, { localOverrides: ownMethods })) as JsonRpcResponse;
        if (response.error) throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
        return response.result as T;
      };
      await own.saveChainId(7733102n);
      // Blocks 1 and 2 first (the backfill has not reached block 0), the first keyed create at 3.
      // Block 1 also holds a reverted create, which has no key and created nothing.
      await storeBlock(own, {
        blockNumber: 1,
        transactions: [registryTx(1, 0, ALICE, { status: "0" })],
        operations: [{ position: 0, hash: registryTx(1, 0, ALICE).hash, operations: [operation({ opIndex: 0, operationType: 1, ...deadline(900) })] }],
      });
      await storeBlock(own, { blockNumber: 2, transactions: [], operations: [] });
      await storeBlock(own, {
        blockNumber: 3,
        transactions: [registryTx(3, 0, ALICE, { logs: [createdLog(0, KEY_A, ALICE, 900)] })],
        operations: [
          { position: 0, hash: registryTx(3, 0, ALICE).hash, operations: [operation({ opIndex: 0, operationType: 1, entityKey: KEY_A, ...deadline(900), attributes: [str("project", "onchain")] })] },
        ],
      });
      const logs: string[] = [];
      const projector = new EntityProjector(ownIndex, { genesis: { source: createFakeGenesisSource([]) }, lateScanIntervalMs: 0, log: (line) => logs.push(line) });
      expect((await projector.runOnce()).genesisStatus).toBe("none");
      expect((await ownIndex.getProgress()).floorBlock).toBe(3n); // block 0 is not stored yet
      await expect(ownResult("arkiv_getEntityCount", [{ block: 0 }])).rejects.toThrow("-32006");

      // The backfill stores block 0: the history below the first create is complete.
      await storeBlock(own, { blockNumber: 0, transactions: [], operations: [] });
      await projector.runOnce();
      expect((await ownIndex.getProgress()).floorBlock).toBe(0n);
      expect(logs.some((line) => line.includes("floor lowered to block 0 from 3"))).toBe(true);
      expect(await ownResult<number>("arkiv_getEntityCount", [{ block: 0 }])).toBe(0);
      expect((await ownResult<{ data: unknown[] }>("arkiv_query", ["*", { atBlock: 2 }])).data).toEqual([]);
      expect((await ownResult<{ data: Array<{ key: string }> }>("arkiv_query", ["*", { atBlock: 3 }])).data.map((e) => e.key)).toEqual([KEY_A]);

      // A fresh index over the same complete history starts at block 0 straight away.
      await ownIndex.reset();
      const fresh = new EntityProjector(ownIndex, { genesis: { source: createFakeGenesisSource([]) }, log: () => {} });
      await fresh.runOnce();
      expect((await ownIndex.getProgress()).floorBlock).toBe(0n);

      // A successful create without a key below the first keyed one leaves an entity the index cannot know.
      await ownIndex.reset();
      await storeBlock(own, {
        blockNumber: 2,
        transactions: [registryTx(2, 0, ALICE)],
        operations: [{ position: 0, hash: registryTx(2, 0, ALICE).hash, operations: [operation({ opIndex: 0, operationType: 1, ...deadline(900) })] }],
      });
      expect(await ownIndex.countKeylessCreatesBelow(3n)).toBe(1);
      await new EntityProjector(ownIndex, { genesis: { source: createFakeGenesisSource([]) }, log: () => {} }).runOnce();
      expect((await ownIndex.getProgress()).floorBlock).toBe(3n);
    } finally {
      await pool.close();
      await isolated.cleanup();
    }
  });

  test("a read at the head never shows a version newer than the head, and a cancelled read says so", async () => {
    const isolated = await createIsolatedStorage("entity_head_filter");
    const pool = openDb(TEST_DATABASE_URL!, { max: 2 });
    try {
      const own = isolated.storage;
      const ownIndex = await EntityIndexStorage.fromDb(pool, { schema: isolated.schema });
      await own.saveChainId(7733102n);
      await storeBlock(own, {
        blockNumber: 3,
        transactions: [registryTx(3, 0, ALICE, { logs: [createdLog(0, KEY_A, ALICE, 900)] })],
        operations: [
          { position: 0, hash: registryTx(3, 0, ALICE).hash, operations: [operation({ opIndex: 0, operationType: 1, entityKey: KEY_A, ...deadline(900), attributes: [str("v", "one")] })] },
        ],
      });
      await storeBlock(own, {
        blockNumber: 4,
        transactions: [registryTx(4, 0, ALICE, { logs: [patchedLog(0, KEY_A, ALICE)] })],
        operations: [{ position: 0, hash: registryTx(4, 0, ALICE).hash, operations: [operation({ opIndex: 0, operationType: 2, entityKey: KEY_A, attributes: [str("v", "two")] })] }],
      });
      await new EntityProjector(ownIndex, { genesis: { mode: "off" }, log: () => {} }).runOnce();
      expect((await ownIndex.getProgress()).projectedThroughBlock).toBe(4n);
      // A read that saw head 3 before a fold through 4 committed: block 4's version must not leak into it.
      const atThree = await ownIndex.queryEntities({ kind: "all" }, { block: 3n, atHead: true, limit: 10 });
      expect(atThree.entities.map((entity) => entity.attributes.map((attribute) => attribute.valueText))).not.toContainEqual(["two"]);
      expect((await ownIndex.queryEntities({ kind: "all" }, { block: 4n, atHead: true, limit: 10 })).entities.map((e) => e.attributes[0]!.valueText)).toEqual(["two"]);

      const cancelled = createArkivIndexMethods(
        {
          ...ownIndex,
          getProgress: () => ownIndex.getProgress(),
          queryEntities: async () => {
            throw Object.assign(new Error("canceling statement due to statement timeout"), { errno: "57014" });
          },
        } as unknown as EntityIndexStorage,
        own,
      );
      const response = (await handleJsonRpcBody({ jsonrpc: "2.0", id: 1, method: "arkiv_query", params: ["*"] }, own, { localOverrides: cancelled })) as JsonRpcResponse;
      expect(response.error).toEqual({
        code: -32000,
        message: "the entity index cancelled this query at its statement timeout; narrow the query or ask for a smaller limit",
      });
    } finally {
      await pool.close();
      await isolated.cleanup();
    }
  });

  test("a node that cannot answer, a genesis too big for RPC, a different chain, or a pinned floor", async () => {
    await index.reset();
    let source = createFakeGenesisSource(FOUR, {
      count: async () => {
        throw new GenesisSourceUnavailable(-32006, "arkiv_getEntityCount: block 0 is unavailable: state for this block is not retained");
      },
    });
    let tick = await new EntityProjector(index, { genesis: { source }, log: () => {} }).runOnce();
    expect(tick.genesisStatus).toBe("unavailable");
    expect((await index.getGenesisImport())!.error).toContain("not retained");
    expect((await index.getProgress()).floorBlock).toBe(5n);

    await index.reset();
    source = createFakeGenesisSource(FOUR);
    tick = await new EntityProjector(index, { genesis: { source, rpcLimit: 3 }, log: () => {} }).runOnce();
    expect(tick.genesisStatus).toBe("waiting");
    expect(source.pages).toBe(0);
    expect(await index.getGenesisImport()).toMatchObject({ status: "waiting", total: 4, imported: 0, source: null });
    expect((await index.getProgress()).floorBlock).toBe(5n);

    await index.reset();
    source = createFakeGenesisSource(FOUR, { describeError: new Error("ECONNREFUSED") });
    const logs: string[] = [];
    const unreachable = (lines: string[]) => lines.filter((line) => line.includes("could not reach the node")).length;
    let projector = new EntityProjector(index, { genesis: { source, probeRetryMs: 60_000 }, log: (line) => logs.push(line) });
    tick = await projector.runOnce();
    expect(tick.genesisStatus).toBeUndefined();
    expect(await index.getGenesisImport()).toBeUndefined();
    expect((await index.getProgress()).floorBlock).toBe(5n);
    expect(unreachable(logs)).toBe(1);
    await projector.runOnce();
    expect(unreachable(logs)).toBe(1);
    projector = new EntityProjector(index, { genesis: { source, probeRetryMs: 0 }, log: (line) => logs.push(line) });
    await projector.runOnce();
    await projector.runOnce();
    expect(unreachable(logs)).toBe(3);

    await index.reset();
    source = createFakeGenesisSource(FOUR, { chain: { chainId: 1337n } });
    tick = await new EntityProjector(index, { genesis: { source }, log: () => {} }).runOnce();
    expect(tick.genesisStatus).toBe("failed");
    expect((await index.getGenesisImport())!.error).toMatch(/chain 1337.*chain 7733102/);
    expect(source.pages).toBe(0);

    await index.reset();
    source = createFakeGenesisSource(FOUR);
    const pinned: string[] = [];
    tick = await new EntityProjector(index, { floorBlock: 5n, genesis: { source }, log: (line) => pinned.push(line) }).runOnce();
    expect(tick.genesisStatus).toBeUndefined();
    expect(await index.getGenesisImport()).toBeUndefined();
    expect(source.pages).toBe(0);
    expect(pinned.some((line) => line.includes("pinned at block 5"))).toBe(true);
  });

  test("the import stands down while another projector holds the lock, and a reset imports again", async () => {
    await index.reset();
    const source = createFakeGenesisSource(FOUR);
    const projector = new EntityProjector(index, { genesis: { source }, log: () => {} });
    await db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`entity-index:${schema}`]);
      const held = await projector.runOnce();
      expect(held.lockHeldElsewhere).toBe(true);
      expect(await index.getGenesisImport()).toBeUndefined();
    });
    const tick = await projector.runOnce();
    expect(tick.genesisStatus).toBe("done");
    expect(await result<number>("arkiv_getEntityCount", [{ block: 0 }])).toBe(4);

    await index.reset();
    expect(await index.getGenesisImport()).toBeUndefined();
    const again = await new EntityProjector(index, { genesis: { source }, log: () => {} }).runOnce();
    expect(again.genesisStatus).toBe("done");
    expect(again.genesisEntitiesImported).toBe(4);
    expect(await result<number>("arkiv_getEntityCount", [{ block: 0 }])).toBe(4);
  });
});

describeWithPostgres("offline genesis import (Postgres)", () => {
  let storage: ScannerStorage;
  let index: EntityIndexStorage;
  let db: Db;
  let cleanup: () => Promise<void>;
  let methods: ReturnType<typeof createArkivIndexMethods>;
  let dir: string;

  const call = async (method: string, params: unknown[] = []): Promise<JsonRpcResponse> =>
    (await handleJsonRpcBody({ jsonrpc: "2.0", id: 1, method, params }, storage, { localOverrides: methods })) as JsonRpcResponse;
  const result = async <T = unknown>(method: string, params: unknown[] = []): Promise<T> => {
    const response = await call(method, params);
    if (response.error) throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
    return response.result as T;
  };
  const getEntity = async (key: string, block?: number): Promise<Record<string, unknown>> => {
    const select = { key: true, owner: true, creator: true, createdAt: true, updatedAt: true, expiresAt: true, creationFlags: true, attributes: true };
    const page = await result<{ data: Array<Record<string, unknown>> }>("arkiv_query", [
      `$key = key(${key})`,
      { select, ...(block === undefined ? {} : { atBlock: `0x${block.toString(16)}` }) },
    ]);
    return page.data[0]!;
  };

  // Five entities in seed order; G3 carries the attributes a patch will touch.
  const ENTITIES = [0, 1, 2, 3, 4].map((n) => ({
    key: dumpKey(0x100 + n),
    owner: DUMP_OWNER,
    payload: new Uint8Array(n + 1),
    expiresAt: 5_000n + BigInt(n),
    attributes: [
      { name: "kind", type: "str" as const, value: encodeAttributeValue("str", "seed") },
      { name: "n", type: "u64" as const, value: encodeAttributeValue("u64", BigInt(n)) },
    ],
  }));
  const MANIFEST: GenesisDumpManifest = { chainId: 7733102n, count: 5, stateRoot: null };
  const keyOf = (n: number) => ENTITIES[n]!.key;

  const writeDump = async (name: string, text: string): Promise<string> => {
    const path = join(dir, name);
    await writeFile(path, text);
    return path;
  };
  const runImport = async (
    path: string,
    overrides: Partial<Parameters<typeof importGenesisDump>[0]> = {},
  ): Promise<{ result: Awaited<ReturnType<typeof importGenesisDump>>; events: Array<[string, GenesisProgressDocument]> }> => {
    const events: Array<[string, GenesisProgressDocument]> = [];
    const result = await importGenesisDump({
      storage: index,
      source: fileDumpSource(path),
      dumpPath: path,
      manifest: MANIFEST,
      expected: { chainId: MANIFEST.chainId, genesisHash: `0x${"ab".repeat(32)}` },
      batchEntities: 2,
      onProgress: (event, doc) => events.push([event, doc]),
      progressIntervalMs: 0,
      sleep: async () => {},
      ...overrides,
    });
    return { result, events };
  };

  beforeAll(async () => {
    const isolated = await createIsolatedStorage("entity_genesis_dump");
    storage = isolated.storage;
    cleanup = isolated.cleanup;
    db = openDb(TEST_DATABASE_URL!, { max: 2 });
    index = await EntityIndexStorage.fromDb(db, { schema: isolated.schema });
    methods = createArkivIndexMethods(index, storage);
    dir = await mkdtemp(join(tmpdir(), "genesis-dump-"));
    await storage.saveChainId(7733102n);
    // Block 2 patches G3 before any import: the fold after the import must apply it on top of the genesis base.
    await storeBlock(storage, {
      blockNumber: 2,
      transactions: [registryTx(2, 0, DUMP_OWNER, { logs: [patchedLog(0, keyOf(3), DUMP_OWNER)] })],
      operations: [
        {
          position: 0,
          hash: registryTx(2, 0, DUMP_OWNER).hash,
          operations: [operation({ opIndex: 0, operationType: 2, entityKey: keyOf(3), attributes: [i32("rank", "7"), tombstone("kind")] })],
        },
      ],
    });
  });

  afterAll(async () => {
    await cleanup();
    await db.close();
    await closeTestPools();
  });

  test("loads a dump in batches, proves the id order, and hands the projector a repair", async () => {
    const path = await writeDump("state.jsonl", buildDump(ENTITIES));
    const { result: outcome, events } = await runImport(path);
    expect(outcome).toMatchObject({ imported: 5, resumedFrom: 0, total: 5 });
    expect(outcome.state).toMatchObject({ status: "running", phase: "repair", source: "dump", total: 5, imported: 5, cursor: null, chainId: "7733102" });
    expect(await index.getGenesisImport()).toMatchObject({ status: "running", phase: "repair", source: "dump", imported: 5 });
    expect(events.filter(([event]) => event === "phase").map(([, doc]) => doc.phase)).toEqual([
      "checking",
      "loading",
      "verifying",
      "indexing",
      "repairing",
    ]);
    const last = events[events.length - 1]![1];
    expect(last).toMatchObject({
      writer: "import-script",
      status: "running",
      phase: "repairing",
      percent: 95,
      source: "dump",
      chain_id: 7733102,
      entities: { total: 5, imported: 5, skipped: 0, attributes: 10, payload_bytes: 15 },
      dump: { path, lines: 13, records: 5, system_account: { seen: true, ids: 5, entity_count: 5 }, verification: "passed" },
      database: { batch_size: 2, batches: 3, indexes: "rebuilt" },
    });
    expect(last.dump!.bytes_read).toBe(last.dump!.bytes_total);
    expect(last.state_root).toBe("0x1d97c1c7db8b54a02eece8de8ec381ae1276faa57972bb61260e6130c13dc01b");
    expect(last.database!.index_rebuild_s).not.toBeNull();

    // The projector finishes: floor 0, G3 refolded with its block-2 patch, the file handed over.
    const progressFile = join(dir, "index", "progress.json");
    const projector = new EntityProjector(index, { genesis: { mode: "off", progressFile }, log: () => {} });
    const tick = await projector.runOnce();
    expect(tick.genesisStatus).toBe("done");
    // Block 2 was never folded before the import, so the forward fold (base-aware) applies it; the repair has nothing to redo.
    expect(tick.genesisKeysRepaired).toBe(0);
    expect(tick.projectedThroughBlock).toBe(2n);
    expect((await index.getProgress()).floorBlock).toBe(0n);
    const keys = (await result<{ data: Array<{ key: string }> }>("arkiv_query", ["*", { atBlock: "0x0", limit: 10 }])).data.map((e) => e.key);
    expect(keys).toEqual([keyOf(0), keyOf(1), keyOf(2), keyOf(3), keyOf(4)]);
    expect(await result<number>("arkiv_getEntityCount", [{ block: 0 }])).toBe(5);
    const atGenesis = await getEntity(keyOf(3), 0);
    expect(atGenesis).toMatchObject({ key: keyOf(3), owner: DUMP_OWNER, createdAt: "0x0", expiresAt: "0x138b" });
    expect((atGenesis.attributes as Array<{ name: string }>).map((a) => a.name)).toEqual(["kind", "n"]);
    const atHead = await getEntity(keyOf(3));
    expect((atHead.attributes as Array<{ name: string; value: unknown }>).map((a) => [a.name, a.value])).toEqual([
      ["n", "0x3"],
      ["rank", 7],
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const written = JSON.parse(await readFile(progressFile, "utf8")) as GenesisProgressDocument;
    expect(written).toMatchObject({
      writer: "backend",
      status: "done",
      phase: "done",
      percent: 100,
      source: "dump",
      entities: { total: 5, imported: 5 },
      repair: { keys_refolded: 0, batches: 1 },
    });
    expect(written.finished_at).not.toBeNull();

    // Nothing to do twice.
    const doneBefore = await index.getGenesisImport();
    expect((await runImport(path)).result.state.status).toBe("done");
    expect(await index.getGenesisImport()).toEqual(doneBefore);
  });

  test("an interrupted run resumes from its last batch without duplicating rows", async () => {
    await index.reset();
    const path = await writeDump("resume.jsonl", buildDump(ENTITIES));
    const controller = new AbortController();
    await expect(
      runImport(path, {
        signal: controller.signal,
        onProgress: (_event, doc) => {
          if (doc.database?.batches === 1) controller.abort();
        },
      }),
    ).rejects.toThrow(GenesisImportStopped);
    const stopped = await index.getGenesisImport();
    expect(stopped).toMatchObject({ status: "running", phase: "walk", source: "dump", imported: 2 });
    const cursor = JSON.parse(stopped!.cursor!) as { offset: number; line: number; ledger: { records: number }; indexes: string };
    expect(cursor).toMatchObject({ line: 6, ledger: { records: 2 }, indexes: "dropped" });
    expect(cursor.offset).toBeGreaterThan(0);

    const { result: outcome, events } = await runImport(path);
    expect(outcome).toMatchObject({ imported: 5, resumedFrom: 2 });
    expect(events[events.length - 1]![1].entities).toMatchObject({ imported: 5, skipped: 2 });
    const rows = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${index.schema}.entity_versions`);
    expect(rows.rows[0]!.n).toBe("5");
    expect((await new EntityProjector(index, { genesis: { mode: "off" }, log: () => {} }).runOnce()).genesisStatus).toBe("done");
  });

  test("refuses to run over another import, a different chain, or a node that disagrees", async () => {
    const path = await writeDump("refuse.jsonl", buildDump(ENTITIES));
    await expect(runImport(path, { expected: { chainId: MANIFEST.chainId, genesisHash: `0x${"cd".repeat(32)}` } })).rejects.toThrow(GenesisImportRefused);
    await index.reset();
    await expect(runImport(path, { manifest: { ...MANIFEST, chainId: 1337n } })).rejects.toThrow("follows chain 7733102");
    await index.reset();
    await expect(runImport(path, { expected: { chainId: 7733102n, count: 6 } })).rejects.toThrow("holds 6 entities at block 0");
    await index.reset();
    await expect(runImport(path, { expected: { chainId: 7733102n, stateRoot: "0x" + "11".repeat(32) } })).rejects.toThrow("state root");
    expect((await index.getGenesisImport())?.status).toBe("failed");
    await index.reset();
    await index.setGenesisImport({
      status: "running",
      phase: "walk",
      source: "rpc",
      chainId: "7733102",
      genesisHash: null,
      total: 5,
      imported: 0,
      cursor: null,
      repairAfterKey: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
    });
    await expect(runImport(path)).rejects.toThrow("importing genesis from the node");
    await index.reset();
  });

  test("a dump that does not add up leaves a failed import, not rows that lie", async () => {
    const swapped = seederSystemStorage([keyOf(1), keyOf(0), keyOf(2), keyOf(3), keyOf(4)]);
    const path = await writeDump("swapped.jsonl", buildDump(ENTITIES, { systemStorage: swapped }));
    const { promise, events } = (() => {
      const events: Array<[string, GenesisProgressDocument]> = [];
      return { events, promise: runImport(path, { onProgress: (event, doc) => events.push([event, doc]) }) };
    })();
    await expect(promise).rejects.toThrow(GenesisEntityError);
    expect(await index.getGenesisImport()).toMatchObject({ status: "failed", phase: null, source: "dump", error: expect.stringContaining("not in entity-id order") });
    expect(events[events.length - 1]![1]).toMatchObject({ phase: "failed", status: "failed", dump: { verification: "failed" } });
    await expect(runImport(path)).rejects.toThrow("previous genesis import failed");
    await index.reset();

    const short = await writeDump("short.jsonl", buildDump(ENTITIES.slice(0, 4), { entityCount: 4 }));
    await expect(runImport(short)).rejects.toThrow("holds 4 entity records but the manifest counts 5");
    expect(await index.getGenesisImport()).toMatchObject({ status: "failed" });
    await index.reset();
  });
});
