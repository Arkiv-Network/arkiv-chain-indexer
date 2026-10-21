import { describe, expect, test } from "bun:test";
import { QueryError } from "@arkiv-network/sdk/query";
import { hexToBytes } from "viem";
import { classifyBytes, findBytesHint, gunzip } from "./src/entityExplorer/lib/bytes";
import { getAttributes, getSchemaName, groupBySchema, inferSchema } from "./src/entityExplorer/lib/entity";
import { explorerClient as client } from "./src/entityExplorer/lib/client";
import { compileQuery, MockQueryError, QUERY_ERROR, type QueryTarget } from "./src/entityExplorer/mock/queryLanguage";

// The Data page's network: the SDK talking to the in-browser mock node.

async function select(query: string, limit = 200) {
  return client.query(query, { select: "*", limit });
}

async function rejection(query: string): Promise<QueryError> {
  try {
    await select(query);
  } catch (error) {
    if (error instanceof QueryError) return error;
    throw error;
  }
  throw new Error(`expected ${query} to be rejected`);
}

describe("mock node through the SDK", () => {
  test("answers a schema query with that schema's entities only", async () => {
    const { entities, blockNumber } = await select("arkiv.schema = str('arkiv-demo.posts')");
    expect(entities.length).toBeGreaterThan(0);
    expect(blockNumber).toBeGreaterThan(0n);
    for (const entity of entities) expect(getSchemaName(entity)).toBe("arkiv-demo.posts");
  });

  test("compares by type: the same column name with another type does not match", async () => {
    const i32 = await select("TYPEOF(score) = i32");
    const dec = await select("TYPEOF(score) = dec");
    expect(i32.entities.length).toBeGreaterThan(0);
    expect(dec.entities.length).toBeGreaterThan(0);
    for (const entity of i32.entities) expect(entity.$attributes.score?.type).toBe("i32");
    const keys = new Set(dec.entities.map((entity) => entity.$key));
    expect(i32.entities.some((entity) => keys.has(entity.$key))).toBe(false);
  });

  test("pages with a cursor pinned to the first page's block", async () => {
    const first = await client.query("$expiresAt >= u64(0)", { select: "*", limit: 5 });
    expect(first.entities).toHaveLength(5);
    expect(first.cursor).toBeTruthy();
    const second = await client.query("$expiresAt >= u64(0)", {
      select: "*",
      limit: 5,
      cursor: first.cursor as string,
      atBlock: first.blockNumber,
    });
    expect(second.blockNumber).toBe(first.blockNumber);
    const firstKeys = new Set(first.entities.map((entity) => entity.$key));
    expect(second.entities.some((entity) => firstKeys.has(entity.$key))).toBe(false);
  });

  test("rejects bad queries with the documented error kinds", async () => {
    const parse = await rejection("arkiv.schema = str('unterminated");
    expect(parse.kind).toBe("parse");
    expect((parse.data as { position?: unknown }).position).toBeNumber();
    expect((await rejection("$createdAt > u64(1)")).kind).toBe("type");
    expect((await rejection("score > i32(99999999999)")).kind).toBe("literal");
  });

  test("answers block timing for the explorer's date estimates", async () => {
    const timing = await client.getBlockTiming();
    expect(timing.blockDuration).toBe(2);
    expect(timing.currentBlock).toBeGreaterThan(0n);
  });
});

describe("mock query language", () => {
  const target: QueryTarget = {
    key: `0x${"11".repeat(32)}`,
    owner: `0x${"22".repeat(20)}`,
    creator: `0x${"22".repeat(20)}`,
    expiresAt: 100n,
    attributes: [
      { name: "status", type: "str", value: "open", indexed: true },
      { name: "note", type: "str", value: "stored only", indexed: false },
      { name: "level", type: "i32", value: 7n, indexed: true },
    ],
  };
  const matches = (query: string) => compileQuery(query)(target);

  test("only indexed attributes can match", () => {
    expect(matches("status = str('open')")).toBe(true);
    expect(matches("note = str('stored only')")).toBe(false);
  });

  test("!= only matches an attribute set with the literal's type", () => {
    expect(matches("level != i32(1)")).toBe(true);
    expect(matches("missing != i32(1)")).toBe(false);
    expect(matches("NOT missing = i32(1)")).toBe(true);
  });

  test("keywords are case-insensitive and -- starts a comment", () => {
    expect(matches("status = str('open') and level >= i32(7) -- trailing note")).toBe(true);
    expect(matches("exists(level) AND typeof(level) = i32")).toBe(true);
  });

  test("errors carry the RPC codes", () => {
    expect(() => compileQuery("level = ")).toThrow(MockQueryError);
    try {
      compileQuery("$updatedAt = u64(1)");
    } catch (error) {
      expect((error as MockQueryError).code).toBe(QUERY_ERROR.type);
    }
  });
});

describe("reading entities back", () => {
  test("groups by schema with untagged last and infers each column's types", async () => {
    const { entities } = await select("$expiresAt >= u64(0)");
    const groups = [...groupBySchema(entities).keys()];
    expect(groups.at(-1)).toBe("");
    const schema = inferSchema(entities, null);
    const score = schema.columns.find((column) => column.name === "score");
    expect(score?.types.map(({ type }) => type).sort()).toEqual(["dec", "i32"]);
    expect(schema.columns.some((column) => column.name === "arkiv.schema")).toBe(false);
  });

  test("decompresses a gzip blob whose sibling column names the encoding", async () => {
    const { entities } = await select("arkiv.schema = str('sensor-net.readings')");
    const entity = entities.find((candidate) => candidate.$attributes.samples !== undefined);
    expect(entity).toBeDefined();
    const attributes = getAttributes(entity!);
    const samples = entity!.$attributes.samples;
    expect(samples?.type).toBe("bytes");
    const bytes = hexToBytes(samples!.value as `0x${string}`);
    expect(findBytesHint(attributes, "samples")).toEqual({ column: "samplesEncoding", value: "gzip" });
    expect(classifyBytes(bytes).kind).toBe("gzip");
    const text = new TextDecoder().decode(await gunzip(bytes));
    expect(() => JSON.parse(text)).not.toThrow();
  });
});
