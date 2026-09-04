import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { ARKIV_INDEX_METHODS, createArkivIndexMethods, cursorBinding, defaultProjection, projectionFingerprint } from "./arkivJsonRpc";
import type { ArkivOperation, TransactionArkivOperations } from "./arkivOperations";
import type { InspectedLog, InspectedTransaction } from "./blockInspector";
import { ENTITY_EVENT_TOPICS } from "./entityIndex";
import { EntityIndexStorage } from "./entityIndexStorage";
import { EntityProjector } from "./entityProjector";
import { handleJsonRpcBody, type JsonRpcResponse } from "./jsonRpc";
import { createBlockServer, type HealthResponseBody } from "./server";
import type { ScannerStorage } from "./storage";
import type { BlockMetrics } from "./types";
import { closeTestPools, createIsolatedStorage, hasPostgresForTests } from "./testPostgres";

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
    status: options.status ?? "1",
    contractAddress: null,
    ...(options.logs ? { logs: options.logs } : {}),
  };
}

type Attr = ArkivOperation["attributes"][number];
const str = (key: string, value: string): Attr => ({ key, valueType: 8, valueTypeName: "str", value });
const u64 = (key: string, value: string): Attr => ({ key, valueType: 3, valueTypeName: "u64", value });
const i32 = (key: string, value: string): Attr => ({ key, valueType: 2, valueTypeName: "i32", value });
const dec = (key: string, value: string): Attr => ({ key, valueType: 5, valueTypeName: "dec", value });
const bool = (key: string, value: string): Attr => ({ key, valueType: 1, valueTypeName: "bool", value });
const addr = (key: string, value: string): Attr => ({ key, valueType: 9, valueTypeName: "addr", value });
const tombstone = (key: string): Attr => ({ key, valueType: 0, valueTypeName: "tombstone", value: "" });

function operation(overrides: Partial<ArkivOperation> & { opIndex: number; operationType: number }): ArkivOperation {
  const names: Record<number, string> = { 1: "create", 2: "update", 3: "extend", 4: "transfer", 5: "delete" };
  return {
    operation: names[overrides.operationType] ?? "unknown",
    entityKey: null,
    contentType: null,
    payloadSizeBytes: 0,
    attributes: [],
    expiresAtBlocks: 0,
    newOwner: null,
    isReference: false,
    payloadReference: null,
    referenceVerification: null,
    referenceError: null,
    ...overrides,
  };
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
              contentType: "text/plain",
              payloadSizeBytes: 12,
              expiresAtBlocks: 50,
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
              contentType: "application/json",
              payloadSizeBytes: 3,
              expiresAtBlocks: 200,
              attributes: [str("project", "demo"), u64("rank", "9"), str("name", "bob")],
            }),
          ],
        },
        {
          position: 2,
          hash: registryTx(100, 2, ALICE).hash,
          operations: [
            operation({ opIndex: 0, operationType: 1, entityKey: KEY_E, expiresAtBlocks: 3, attributes: [str("project", "short")] }),
          ],
        },
        {
          position: 3,
          hash: registryTx(100, 3, ALICE).hash,
          operations: [
            operation({ opIndex: 0, operationType: 1, entityKey: KEY_F, expiresAtBlocks: 50, attributes: [str("project", "nolog")] }),
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
            operation({ opIndex: 0, operationType: 1, entityKey: KEY_C, expiresAtBlocks: 1000, attributes: [str("project", "other")] }),
            operation({
              opIndex: 1,
              operationType: 1,
              entityKey: KEY_D,
              expiresAtBlocks: 1000,
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
          operations: [operation({ opIndex: 0, operationType: 3, entityKey: KEY_B, expiresAtBlocks: 300 })],
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

const describeWithPostgres = hasPostgresForTests() ? describe : describe.skip;

describeWithPostgres("entity index (Postgres)", () => {
  let storage: ScannerStorage;
  let index: EntityIndexStorage;
  let cleanup: () => Promise<void>;
  let methods: ReturnType<typeof createArkivIndexMethods>;
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

  beforeAll(async () => {
    const isolated = await createIsolatedStorage("entity_index");
    storage = isolated.storage;
    cleanup = isolated.cleanup;
    index = await EntityIndexStorage.fromDb(
      // A second pool on the same schema, the way serve.ts opens it.
      (await import("./db")).openDb(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!, { max: 2 }),
      { schema: isolated.schema },
    );
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

    // No stored logs: expiry from the calldata rule, flags unknown.
    const f = await index.getEntityVersions(KEY_F);
    expect(f[0]).toMatchObject({ expiresAt: 150n, creationFlags: null });
  });

  test("* lists the entities live at the projection head, newest first", async () => {
    const page = await result<{ data: Array<{ key: string }>; blockNumber: string; cursor?: string }>("arkiv_query", ["*"]);
    expect(page.blockNumber).toBe("0x69");
    expect(page.cursor).toBeUndefined();
    // D is deleted and E expired at 103; C and D shared a block, C first.
    expect(page.data.map((entity) => entity.key)).toEqual([KEY_C, KEY_F, KEY_B, KEY_A]);
  });

  test("typed predicates match only attributes of their type", async () => {
    expect(await keysOf("project = str('demo')")).toEqual([KEY_B, KEY_A]);
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
    expect(await keysOf("project STARTSWITH str('dem')")).toEqual([KEY_B, KEY_A]);
    expect(await keysOf("project STARTSWITH str('%')")).toEqual([]);
    expect(await keysOf("NOT project = str('demo')")).toEqual([KEY_C, KEY_F]);
    expect(await keysOf("project = str('demo') AND rank = i32(7)")).toEqual([KEY_A]);
    expect(await keysOf("project = str('other') OR name = str('bob')")).toEqual([KEY_C, KEY_B]);
    expect(await keysOf("NOT (project = str('demo') OR project = str('other'))")).toEqual([KEY_F]);
  });

  test("system attributes query the version columns", async () => {
    expect(await keysOf(`$owner = addr(${BOB})`)).toEqual([KEY_C]);
    expect(await keysOf(`$owner = '${CAROL}'`)).toEqual([]);
    expect(await keysOf(`$creator = addr(${CAROL})`)).toEqual([KEY_C]);
    expect(await keysOf("$createdAt >= u64(101)")).toEqual([KEY_C]);
    expect(await keysOf("$createdAt = u64(100)")).toEqual([KEY_F, KEY_B, KEY_A]);
    expect(await keysOf("$expiresAt < u64(200)")).toEqual([KEY_F, KEY_A]);
    expect(await keysOf("$expiresAt <= u64(300)")).toEqual([KEY_F, KEY_B, KEY_A]);
    expect(await keysOf(`$key = key(${KEY_A})`)).toEqual([KEY_A]);
    expect(await keysOf(`$key = '${KEY_D}'`)).toEqual([]);
    expect(await keysOf("$contentType = str('text/plain')")).toEqual([KEY_A]);
    expect(await keysOf("$contentType STARTSWITH str('application')")).toEqual([KEY_B]);
    expect(await keysOf("$contentType = ''")).toEqual([KEY_C, KEY_F]);
  });

  test("atBlock evaluates the state as of that block", async () => {
    expect(await keysOf("*", { atBlock: "0x64" })).toEqual([KEY_F, KEY_E, KEY_B, KEY_A]);
    expect(await keysOf("*", { atBlock: "0x66" })).toEqual([KEY_D, KEY_C, KEY_F, KEY_E, KEY_B, KEY_A]);
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
    expect(await keysOf(`$owner = addr(${CAROL})`, { atBlock: "0x66" })).toEqual([KEY_D, KEY_C]);
    expect(await keysOf("$expiresAt = u64(200)", { atBlock: "0x66" })).toEqual([KEY_B]);
    expect(await keysOf("$expiresAt = u64(300)", { atBlock: "0x67" })).toEqual([KEY_B]);

    const page = await result<{ blockNumber: string }>("arkiv_query", ["*", { atBlock: "latest" }]);
    expect(page.blockNumber).toBe("0x69");
    const historical = await result<{ blockNumber: string }>("arkiv_query", ["*", { atBlock: "0x65" }]);
    expect(historical.blockNumber).toBe("0x65");
  });

  test("blocks outside the projection are unavailable, tags other than latest rejected", async () => {
    const ahead = await errorOf("arkiv_query", ["*", { atBlock: "0x6a" }]);
    expect(ahead.code).toBe(-32006);
    expect(ahead.data).toEqual({ requested: 106, latest: 105, message: ahead.message });
    expect(ahead.message).toContain("ahead of the entity index head");
    const below = await errorOf("arkiv_query", ["*", { atBlock: "0x63" }]);
    expect(below.code).toBe(-32006);
    expect(below.message).toContain("floor");
    expect((await errorOf("arkiv_query", ["*", { atBlock: "earliest" }])).message).toBe(
      "atBlock tag earliest not supported; use a hex block number or 'latest'",
    );
    expect((await errorOf("arkiv_query", ["*", { atBlock: 101 }])).code).toBe(-32602);
  });

  test("pages are bound to their query, block and select through the cursor", async () => {
    const first = await result<{ data: Array<{ key: string }>; cursor?: string }>("arkiv_query", ["*", { limit: "0x1" }]);
    expect(first.data.map((entity) => entity.key)).toEqual([KEY_C]);
    expect(first.cursor).toMatch(/^b64:[A-Za-z0-9_-]+$/);

    const second = await result<{ data: Array<{ key: string }>; cursor?: string }>("arkiv_query", [
      "*",
      { limit: 1, cursor: first.cursor, atBlock: "0x69" },
    ]);
    expect(second.data.map((entity) => entity.key)).toEqual([KEY_F]);

    const rest = await result<{ data: Array<{ key: string }>; cursor?: string }>("arkiv_query", [
      "*",
      { limit: 5, cursor: second.cursor, atBlock: "0x69" },
    ]);
    // A different limit is not part of the binding.
    expect(rest.data.map((entity) => entity.key)).toEqual([KEY_B, KEY_A]);
    expect(rest.cursor).toBeUndefined();

    const mismatched = await errorOf("arkiv_query", ["project = str('demo')", { limit: 1, cursor: first.cursor }]);
    expect(mismatched.code).toBe(-32005);
    expect(mismatched.message).toContain("different query, block or select");
    const otherSelect = await errorOf("arkiv_query", ["*", { limit: 1, cursor: first.cursor, select: { owner: true } }]);
    expect(otherSelect.code).toBe(-32005);
    const malformed = await errorOf("arkiv_query", ["*", { limit: 1, cursor: "junk" }]);
    expect(malformed).toEqual({ code: -32005, message: malformed.message, data: { message: malformed.message } });
    expect(malformed.message).toContain("malformed");
    expect((await errorOf("arkiv_query", ["*", { cursor: "b64:AAAA" }])).message).toContain("malformed");
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
            contentType: true,
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
      contentType: "application/json",
      attributeSchema: [
        { name: "name", type: "str" },
        { name: "project", type: "str" },
        { name: "rank", type: "u64" },
      ],
      attributes: [
        { name: "name", type: "str", value: "bob" },
        { name: "project", type: "str", value: "demo" },
        { name: "rank", type: "u64", value: "0x9" },
      ],
    });

    const [a] = (
      await result<{ data: Array<Record<string, unknown>> }>("arkiv_query", [
        `$key = key(${KEY_A})`,
        { select: { attributes: { rank: true, score: true, level: true, who: true, missing: true, project: false } } },
      ])
    ).data;
    expect(a).toEqual({
      attributes: [
        { name: "level", type: "i32", value: -3 },
        { name: "rank", type: "i32", value: 7 },
        { name: "score", type: "dec", value: "1.5" },
        { name: "who", type: "addr", value: BOB },
      ],
    });

    const [defaults] = (await result<{ data: Array<Record<string, unknown>> }>("arkiv_query", [`$key = key(${KEY_A})`])).data;
    expect(defaults).toEqual({ key: KEY_A });
    const [nothing] = (await result<{ data: Array<Record<string, unknown>> }>("arkiv_query", [`$key = key(${KEY_A})`, { select: {} }])).data;
    expect(nothing).toEqual({});
    const [unknownFlags] = (
      await result<{ data: Array<Record<string, unknown>> }>("arkiv_query", [`$key = key(${KEY_F})`, { select: { creationFlags: true } }])
    ).data;
    expect(unknownFlags).toEqual({ creationFlags: null });
  });

  test("malformed options and queries answer the node's codes", async () => {
    expect(await errorOf("arkiv_query", ["*", { limit: 0 }])).toEqual({ code: -32602, message: "limit must be at least 1" });
    expect(await errorOf("arkiv_query", ["*", { limit: "0x12c" }])).toEqual({
      code: -32602,
      message: "limit 300 exceeds the node maximum of 200",
    });
    expect((await errorOf("arkiv_query", ["*", { bogus: 1 }])).message).toContain("unknown field `bogus`, expected one of `atBlock`");
    expect((await errorOf("arkiv_query", ["*", { select: { bogus: true } }])).message).toContain("unknown field `bogus`, expected one of `key`");
    expect((await errorOf("arkiv_query", ["*", { select: ["key"] }])).code).toBe(-32602);
    expect((await errorOf("arkiv_query", [5])).message).toContain("invalid query param");
    expect(await errorOf("arkiv_query", ["* AND a = true"])).toEqual({
      code: -32001,
      message: "* matches every entity and cannot be combined with other predicates",
      data: { position: 2, message: "* matches every entity and cannot be combined with other predicates" },
    });
    expect((await errorOf("arkiv_query", ["a != true"])).code).toBe(-32002);
    expect((await errorOf("arkiv_query", ["a = i32(99999999999)"])).code).toBe(-32003);
    expect((await errorOf("arkiv_query", ["(".repeat(40)])).code).toBe(-32004);
    const payload = await errorOf("arkiv_query", ["*", { select: { payload: true } }]);
    expect(payload.code).toBe(-32000);
    expect(payload.message).toContain("payload");

    // Cursors: garbage, a well-formed cursor from another request, and a
    // node's cursor (8-byte entity id) for this very request.
    expect(await errorOf("arkiv_query", ["*", { cursor: "nope" }])).toMatchObject({
      code: -32005,
      message: "cursor is malformed — pass back the cursor from the previous page",
    });
    expect((await errorOf("arkiv_query", ["*", { cursor: `b64:${Buffer.alloc(52).toString("base64url")}` }])).message).toContain(
      "belongs to a different query",
    );
    expect((await errorOf("arkiv_query", ["*", { cursor: `b64:${Buffer.alloc(16).toString("base64url")}` }])).message).toContain(
      "belongs to a different query",
    );
    const binding = cursorBinding("*", 105n, projectionFingerprint(defaultProjection()));
    const nodeCursor = `b64:${Buffer.concat([binding, Buffer.alloc(8)]).toString("base64url")}`;
    expect((await errorOf("arkiv_query", ["*", { cursor: nodeCursor }])).message).toContain("issued by a node");
  });

  test("arkiv_getEntityCount counts what matches at a block", async () => {
    expect(await result<number>("arkiv_getEntityCount")).toBe(4);
    expect(await result<number>("arkiv_getEntityCount", [{ query: "project = str('demo')" }])).toBe(2);
    expect(await result<number>("arkiv_getEntityCount", [{ block: 102 }])).toBe(6);
    expect(await result<number>("arkiv_getEntityCount", [{ query: "$expiresAt < u64(200)", block: 102 }])).toBe(3);
    expect((await errorOf("arkiv_getEntityCount", [{ block: "0x66" }])).code).toBe(-32602);
    expect((await errorOf("arkiv_getEntityCount", [{ query: "a != true" }])).code).toBe(-32002);
  });

  test("arkiv_getEntity reads one entity, in full, as of a block", async () => {
    const a = await result<Record<string, unknown>>("arkiv_getEntity", [KEY_A]);
    expect(a).toMatchObject({ key: KEY_A, owner: ALICE, createdAt: "0x64", updatedAt: "0x66", expiresAt: "0x96", contentType: "text/plain" });
    expect(a).not.toHaveProperty("payload");
    expect(a).not.toHaveProperty("attributeSchema");
    expect((a.attributes as unknown[]).length).toBe(5);
    expect(await result("arkiv_getEntity", [KEY_D])).toBeNull();
    expect(await result<Record<string, unknown>>("arkiv_getEntity", [KEY_D, 104])).toMatchObject({ key: KEY_D, owner: CAROL });
    expect(await result("arkiv_getEntity", [KEY_E])).toBeNull();
    expect(await result<Record<string, unknown>>("arkiv_getEntity", [KEY_E.toUpperCase().replace("0X", "0x"), 102])).toMatchObject({ key: KEY_E });
    expect((await errorOf("arkiv_getEntity", ["0x1234"])).code).toBe(-32602);
    expect((await errorOf("arkiv_getEntity", [KEY_A, 200])).code).toBe(-32006);
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

  test("new blocks extend the projection, and one transaction's creates order by key", async () => {
    // Two creates in one transaction: 0x77… is operation 0, 0x66… operation 1.
    // The node hands out entity ids when the transaction commits, walking its
    // staged deltas in ascending key order, so newest-first puts 0x77… before
    // 0x66… — the opposite of operation order.
    const high = `0x${"77".repeat(32)}`;
    const low = `0x${"66".repeat(32)}`;
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
            operation({ opIndex: 0, operationType: 1, entityKey: high, expiresAtBlocks: 394, attributes: [str("project", "new")] }),
            operation({ opIndex: 1, operationType: 1, entityKey: low, expiresAtBlocks: 394, attributes: [str("project", "new")] }),
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
    expect((await keysOf("*")).slice(0, 2)).toEqual([high, low]);
    // A cursor between the two resumes at the lower key.
    const firstPage = await result<{ data: { key: string }[]; cursor?: string }>("arkiv_query", ["*", { limit: 1 }]);
    expect(firstPage.data.map((entity) => entity.key)).toEqual([high]);
    const secondPage = await result<{ data: { key: string }[] }>("arkiv_query", ["*", { limit: 1, cursor: firstPage.cursor }]);
    expect(secondPage.data.map((entity) => entity.key)).toEqual([low]);
    expect((await result<{ blockNumber: string }>("arkiv_query", ["*"])).blockNumber).toBe("0x6a");
    expect(await result<number>("arkiv_getEntityCount")).toBe(6);
    const stats = await index.getStats();
    expect(stats.liveEntities).toBe(6);
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

    const server = createBlockServer(storage, { port: 0, entityIndex: index });
    try {
      const post = (body: unknown, path = "/shadow-rpc/experimental") =>
        fetch(`http://${server.hostname}:${server.port}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
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
        path: "/shadow-rpc/experimental",
        methods: [...ARKIV_INDEX_METHODS],
        floorBlock: "100",
        projectedThroughBlock: "106",
        lagBlocks: "0",
        liveEntities: 6,
        lastFoldAtUtc: expect.any(String),
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
          operations: [operation({ opIndex: 0, operationType: 1, entityKey: key, expiresAtBlocks: 401, attributes: [str("project", "backfilled")] })],
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
    expect((await keysOf("*")).at(-1)).toBe(key);
    expect((await index.getProgress()).projectedThroughBlock).toBe(106n);
    expect(await result<number>("arkiv_getEntityCount")).toBe(7);
  });
});
