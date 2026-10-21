/**
 * The mock chain: a deterministic set of entities written through several
 * made-up schemas, plus a slow trickle of new operations so the live activity
 * feed has something to show.
 *
 * The data is shaped to exercise what user-defined columns make possible:
 * entities with no `bytes` at all, with one, or with several; indexed and
 * stored-only columns side by side; untagged entities next to named schemas;
 * one attribute name holding different types across projects; and every
 * creation flag, expiry and ownership state the explorer renders.
 */

import { ENTITY_EVENTS_ABI, MAX_EXPIRES_AT } from "@arkiv-network/sdk";
import { encodeAbiParameters, encodeEventTopics, type Hex, keccak256, numberToHex, stringToHex, toHex } from "viem";
import {
  GZIP_SAMPLES_0,
  GZIP_SAMPLES_1,
  GZIP_SAMPLES_2,
  THUMBNAIL_0,
  THUMBNAIL_1,
  THUMBNAIL_2,
  THUMBNAIL_3,
} from "./blobs";
import type { MockAttribute, MockValue } from "./queryLanguage";

export const MOCK_CHAIN_ID = 7_738_000;
export const ARKIV_ADDRESS = "0x4400000000000000000000000000000000000044";
const SCHEMA_ATTRIBUTE = "arkiv.schema";

/** Block 0 of the mock chain. Blocks are 2 seconds, as on Tiramisu. */
const GENESIS_MS = Date.UTC(2026, 6, 1);
export const BLOCK_SECONDS = 2;
const BLOCKS_PER_DAY = 43_200;

export function currentBlock(now = Date.now()): bigint {
  return BigInt(Math.floor((now - GENESIS_MS) / (BLOCK_SECONDS * 1000)));
}

export function blockTimestamp(block: bigint): number {
  return Math.floor(GENESIS_MS / 1000) + Number(block) * BLOCK_SECONDS;
}

export type MockEntity = {
  key: Hex;
  owner: Hex;
  creator: Hex;
  createdAt: bigint;
  updatedAt: bigint;
  expiresAt: bigint;
  flags: number;
  /** Sorted by name, as the protocol requires. */
  attributes: MockAttribute[];
};

export type MockLog = {
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
  topics: Hex[];
  data: Hex;
};

/** mulberry32: small, fast and good enough to make the data look varied. */
function rng(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
    chance: (p: number) => next() < p,
    hex: (bytes: number) =>
      `0x${Array.from({ length: bytes }, () =>
        Math.floor(next() * 256)
          .toString(16)
          .padStart(2, "0"),
      ).join("")}` as Hex,
  };
}

const OWNERS = [
  "0x7a3f1c9e2b4d6a8f0e1c3b5d7f9a2c4e6b8d0f12",
  "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
  "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",
  "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
  "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65",
] as const;

const TOKENS = {
  WETH: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  WBTC: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
  USDC: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  GLM: "0x7dd9c5cba05e151c895fde1cf355c9a1d5da6429",
  LINK: "0x514910771af9ca656af840dff83e8264ecf986ca",
} as const;

type Attr = MockAttribute;

function a(name: string, value: MockValue, indexed = false): Attr {
  return { ...value, name, indexed } as Attr;
}
const str = (value: string): MockValue => ({ type: "str", value });
const dec = (value: string | number): MockValue => ({
  type: "dec",
  value: typeof value === "number" ? String(Number(value.toFixed(6))) : value,
});
const i32 = (value: number): MockValue => ({
  type: "i32",
  value: BigInt(value),
});
const u64 = (value: bigint | number): MockValue => ({
  type: "u64",
  value: BigInt(value),
});
const u256 = (value: bigint): MockValue => ({ type: "u256", value });
const bool = (value: boolean): MockValue => ({ type: "bool", value });
const addr = (value: string): MockValue => ({
  type: "addr",
  value: value as Hex,
});
const key = (value: Hex): MockValue => ({ type: "key", value });
const bytes32 = (value: Hex): MockValue => ({ type: "bytes32", value });
const bytes = (value: Hex): MockValue => ({ type: "bytes", value });
const text = (value: string): MockValue => bytes(stringToHex(value));
const json = (value: unknown): MockValue => text(JSON.stringify(value));

const POSTS = [
  {
    title: "Arkiv ships schemas",
    category: "news",
    body: '# Arkiv ships schemas\n\nEntities are no longer a payload plus tags. You describe **columns**, give each one a type, and decide which ones get an index.\n\n```ts\nconst Posts = defineSchema("my-app.posts", {\n  author: addr().indexed(),\n  title: str(),\n  body: bytes(),\n})\n```\n\nStored-only columns cost less, so index only what you filter on.',
  },
  {
    title: "Why bytes can't be indexed",
    category: "engineering",
    body: "A `bytes` column holds up to 128 KiB. Indexing that would make every write expensive and every index huge, so the protocol rejects the indexed bit on type 7.\n\nIf you need to find a blob, index a hash of it in a `bytes32` column instead.",
  },
  {
    title: "Pagination at a fixed block",
    category: "engineering",
    body: "Every page of a query reads the same block. The cursor is bound to it, so rows never shift while you page through them, even as new entities land.",
  },
  {
    title: "Tiramisu weekly: 2M entities",
    category: "news",
    body: "The public testnet crossed two million live entities this week. Most are short-lived: the median lifetime is under three days.",
  },
  {
    title: "Modelling comments with key columns",
    category: "tutorial",
    body: "A `key` column points at another entity. Arkiv doesn't check that it exists, so a comment can outlive its post. Index the column to list a post's comments:\n\n    post = key(0x…)",
  },
  {
    title: "Decimals without floating point",
    category: "tutorial",
    body: '`dec` stores 18 decimal places as a scaled integer. Pass fractions as strings: `dec("0.1")` works, `dec(0.1)` throws.',
  },
  {
    title: "Expiration is a feature",
    category: "opinion",
    body: "Data you don't need forever shouldn't cost forever. Start short, extend what you still use.",
  },
  {
    title: "Release notes 0.8.1",
    category: "news",
    body: '- user-defined columns\n- `select()` returns flat rows\n- `onMismatch: "skip"` for mixed data\n- `$attributeSchema` to discover an entity\'s shape',
  },
] as const;

const COMMENTS = [
  "Finally! The payload/attributes split never made sense to me.",
  "Does patching a column change whether it's indexed?",
  "Great write-up, thanks.",
  "How do I migrate an old entity with a $payload?",
  "Is there a limit on how many bytes columns one entity can have?",
  "We hit the 32 attribute limit quickly, is that going up?",
  "+1, this is exactly what we needed for our indexer.",
  'Typo in the second code block: should be dec("4.5").',
  "Would love an example with u256 token amounts.",
  "Our explorer links broke after the migration, any redirect plan?",
];

const SENSOR_SITES = ["warsaw-dc1", "lisbon-lab", "berlin-roof", "austin-greenhouse"] as const;

const FILES = [
  {
    filename: "manifest.json",
    mimeType: "application/json",
    content: {
      name: "arkiv-demo",
      version: "1.4.0",
      entrypoints: { web: "index.html", worker: "sw.js" },
      permissions: ["storage", "network"],
    },
  },
  {
    filename: "README.md",
    mimeType: "text/markdown",
    content:
      "# Demo bucket\n\nFiles in this bucket are stored as Arkiv entities: one `bytes` column for the content, a `bytes32` hash you can filter on, and plain columns for the metadata.",
  },
  {
    filename: "config.toml",
    mimeType: "application/toml",
    content:
      '[node]\nrpc = "https://rpc.tiramisu.db-chain.testnet.arkiv.network"\nretries = 1\n\n[cache]\nttl_seconds = 300\n',
  },
  {
    filename: "avatar.png",
    mimeType: "image/png",
    content: THUMBNAIL_2,
  },
] as const;

function entityKey(seed: string): Hex {
  return keccak256(stringToHex(`mock-entity:${seed}`));
}

function txHash(seed: string): Hex {
  return keccak256(stringToHex(`mock-tx:${seed}`));
}

function sortAttributes(attributes: Attr[]): Attr[] {
  return attributes.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
}

function tagged(schema: string | null, attributes: (Attr | null | false)[]): Attr[] {
  const present = attributes.filter((attribute): attribute is Attr => !!attribute);
  return sortAttributes(schema ? [a(SCHEMA_ATTRIBUTE, str(schema), true), ...present] : present);
}

function encodeLog(
  event: (typeof ENTITY_EVENTS_ABI)[number]["name"],
  args: Record<string, unknown>,
  data: Hex = "0x",
): Pick<MockLog, "topics" | "data"> {
  const topics = encodeEventTopics({
    abi: ENTITY_EVENTS_ABI,
    eventName: event,
    args: args as never,
  }) as Hex[];
  return { topics, data };
}

export class MockChain {
  readonly entities = new Map<Hex, MockEntity>();
  readonly logs: MockLog[] = [];
  /** Every block up to here has had its simulated operations applied. */
  private simulatedTo: bigint;
  private sequence = 0;

  constructor(now = Date.now()) {
    const head = currentBlock(now);
    this.seed(head);
    this.simulatedTo = head;
  }

  /** Writes the initial dataset as if it had been created over the past week. */
  private seed(head: bigint) {
    const r = rng(42);
    const ago = (minDays: number, maxDays: number) =>
      head - BigInt(r.int(Math.floor(minDays * BLOCKS_PER_DAY), Math.floor(maxDays * BLOCKS_PER_DAY)));
    const lifetime = (createdAt: bigint, minDays: number, maxDays: number) =>
      createdAt + BigInt(r.int(minDays * BLOCKS_PER_DAY, maxDays * BLOCKS_PER_DAY));

    const add = (
      seed: string,
      attributes: Attr[],
      options: {
        owner?: string;
        creator?: string;
        createdAt?: bigint;
        expiresAt?: bigint;
        patchedAt?: bigint;
        flags?: number;
      } = {},
    ) => {
      const creator = (options.creator ?? options.owner ?? r.pick(OWNERS)) as Hex;
      const createdAt = options.createdAt ?? ago(0.05, 7);
      const entity: MockEntity = {
        key: entityKey(seed),
        owner: (options.owner ?? creator) as Hex,
        creator,
        createdAt,
        updatedAt: options.patchedAt ?? createdAt,
        expiresAt: options.expiresAt ?? lifetime(createdAt, 8, 120),
        flags: options.flags ?? 0,
        attributes,
      };
      this.entities.set(entity.key, entity);
      this.pushLog(createdAt, txHash(seed), "EntityCreated", entity);
      return entity;
    };

    // Blog posts: text in one bytes column, an optional PNG thumbnail in another.
    const thumbnails = [THUMBNAIL_0, THUMBNAIL_1, THUMBNAIL_3];
    const posts = POSTS.map((post, index) => {
      const author = OWNERS[index % 3];
      const createdAt = ago(1, 7);
      return add(
        `post-${index}`,
        tagged("arkiv-demo.posts", [
          a("author", addr(author), true),
          a("category", str(post.category), true),
          a("score", dec(r.int(20, 50) / 10), true),
          a("published", u64(blockTimestamp(createdAt)), true),
          a("title", str(post.title)),
          a("body", text(post.body)),
          index % 3 !== 1 &&
            a(
              "summary",
              str(
                post.body
                  .split("\n")
                  .find((line) => line && !line.startsWith("#"))!
                  .split(/(?<=\.)\s/)[0]
                  .slice(0, 120),
              ),
            ),
          index % 2 === 0 && a("thumbnail", bytes(thumbnails[index % thumbnails.length])),
        ]),
        {
          owner: author,
          createdAt,
          patchedAt: index % 4 === 0 ? createdAt + BigInt(r.int(100, 20_000)) : undefined,
          flags: index === 3 ? 0b01 : 0,
          expiresAt: index === 0 ? MAX_EXPIRES_AT : undefined,
        },
      );
    });

    // Comments: no bytes at all, just typed columns and a key back to the post.
    for (let index = 0; index < 26; index++) {
      const post = posts[index % posts.length];
      const author = r.pick(OWNERS);
      add(
        `comment-${index}`,
        tagged("arkiv-demo.comments", [
          a("post", key(post.key), true),
          a("author", addr(author), true),
          a("likes", i32(r.int(0, 140)), true),
          a("text", str(COMMENTS[index % COMMENTS.length])),
          index % 7 === 3 && a("hidden", bool(true), true),
        ]),
        {
          owner: author,
          createdAt: post.createdAt + BigInt(r.int(50, 30_000)),
          flags: index % 5 === 0 ? 0b10 : 0,
        },
      );
    }

    // DeFi feed: big integers and decimals, entities chained by key columns.
    const oracle = OWNERS[4];
    const markets = (Object.entries(TOKENS) as [keyof typeof TOKENS, string][]).map(([symbol, token], index) =>
      add(
        `market-${symbol}`,
        tagged("defi-feed.markets", [
          a("symbol", str(symbol), true),
          a("token", addr(token), true),
          a("oraclePrice", dec(([3120.55, 64210.1, 1.0002, 0.2875, 14.62] as const)[index]), true),
          a("totalSupplied", u256(BigInt(r.int(10_000, 9_000_000)) * 10n ** 18n), true),
          a("liquidationThreshold", dec(([0.825, 0.75, 0.875, 0.65, 0.7] as const)[index])),
          a("riskParams", json({ ltv: 0.7 + index * 0.02, reserveFactor: 0.1, kink: 0.8 })),
        ]),
        {
          owner: oracle,
          createdAt: ago(6, 7),
          patchedAt: head - BigInt(r.int(10, 400)),
          flags: 0b10,
        },
      ),
    );

    const positions = Array.from({ length: 14 }, (_, index) => {
      const market = markets[index % markets.length];
      const account = OWNERS[(index + 1) % OWNERS.length];
      const health = r.int(92, 260) / 100;
      return add(
        `position-${index}`,
        tagged("defi-feed.positions", [
          a("market", key(market.key), true),
          a("account", addr(account), true),
          a("collateral", u256(BigInt(r.int(1, 900)) * 10n ** 17n), true),
          a("debt", u256(BigInt(r.int(1, 500)) * 10n ** 17n)),
          a("healthFactor", dec(health), true),
          a("riskTier", str(health < 1.1 ? "critical" : health < 1.5 ? "watch" : "healthy"), true),
        ]),
        {
          owner: oracle,
          createdAt: ago(1, 6),
          patchedAt: head - BigInt(r.int(5, 2_000)),
          // A few positions are about to drop out of the feed.
          expiresAt: index % 5 === 2 ? head + BigInt(r.int(600, 30_000)) : undefined,
        },
      );
    });

    for (let index = 0; index < 6; index++) {
      const position = positions[index * 2];
      add(
        `liquidation-${index}`,
        tagged("defi-feed.liquidations", [
          a("position", key(position.key), true),
          a("liquidator", addr(OWNERS[5]), true),
          a("repaid", u256(BigInt(r.int(1, 90)) * 10n ** 17n)),
          a("seized", u256(BigInt(r.int(1, 99)) * 10n ** 17n)),
          a("txRef", bytes32(txHash(`liquidation-ref-${index}`)), true),
          a("proof", bytes(r.hex(r.int(180, 900)))),
        ]),
        {
          owner: OWNERS[5],
          createdAt: position.createdAt + BigInt(r.int(100, 5_000)),
          flags: 0b01,
        },
      );
    }

    // Sensor readings: a gzipped JSON column with its encoding in a sibling column,
    // and a raw binary frame. Most are short-lived.
    const gzips = [GZIP_SAMPLES_0, GZIP_SAMPLES_1, GZIP_SAMPLES_2];
    for (let index = 0; index < 18; index++) {
      const site = SENSOR_SITES[index % SENSOR_SITES.length];
      const createdAt = ago(0.02, 2.5);
      add(`reading-${index}`, this.reading(r, index, site, createdAt, gzips), {
        owner: OWNERS[3],
        createdAt,
        expiresAt: createdAt + BigInt(r.int(BLOCKS_PER_DAY, 3 * BLOCKS_PER_DAY)),
      });
    }

    // A file bucket: content and metadata as plain columns, a hash to find it by.
    FILES.forEach((file, index) => {
      const content =
        typeof file.content !== "string"
          ? json(file.content)
          : file.content.startsWith("0x")
            ? bytes(file.content as Hex)
            : text(file.content);
      const hex = content.value as Hex;
      add(
        `file-${index}`,
        tagged("files.blobs", [
          a("filename", str(file.filename), true),
          a("sha256", bytes32(keccak256(hex)), true),
          a("mimeType", str(file.mimeType)),
          a("size", u64((hex.length - 2) / 2)),
          a("content", content),
        ]),
        {
          owner: OWNERS[2],
          creator: index === 1 ? OWNERS[0] : OWNERS[2],
          flags: index === 0 ? 0b11 : 0,
        },
      );
    });

    // Untagged entities, written without a named schema. `score` here is an
    // i32 while the posts' `score` is a dec, so a query has to pick one.
    const labels = ["todo", "doing", "done", "blocked"];
    for (let index = 0; index < 8; index++) {
      add(
        `untagged-${index}`,
        tagged(null, [
          a("type", str("task"), true),
          a("status", str(labels[index % labels.length]), true),
          a("score", i32(r.int(1, 400)), true),
          a("note", str(`Follow up with ${["design", "infra", "the SDK team", "docs"][index % 4]}`)),
          index % 3 === 0 && a("due", u64(blockTimestamp(head) + r.int(1, 20) * 86_400), true),
        ]),
        {
          owner: OWNERS[index % 2 === 0 ? 0 : 1],
          creator: index === 5 ? OWNERS[3] : undefined,
        },
      );
    }

    // Edge cases: only blobs, and nothing at all.
    add(
      "frames-only",
      tagged(null, [
        a("frame0", bytes(r.hex(64))),
        a("frame1", bytes(r.hex(2_048))),
        a("meta", json({ codec: "raw", width: 32, height: 16, frames: 2 })),
      ]),
      { owner: OWNERS[1] },
    );
    add("empty", [], { owner: OWNERS[0], expiresAt: head + 1_800n });
  }

  private reading(
    r: ReturnType<typeof rng>,
    index: number,
    site: string,
    createdAt: bigint,
    gzips: readonly Hex[],
  ): Attr[] {
    return tagged("sensor-net.readings", [
      a("device", str(`${site}/probe-${(index % 3) + 1}`), true),
      a("site", str(site), true),
      a("temperature", dec(r.int(150, 290) / 10), true),
      a("battery", i32(r.int(5, 100)), true),
      a("ts", u64(blockTimestamp(createdAt)), true),
      a("firmware", bytes32(keccak256(stringToHex(`fw-${index % 2}`)))),
      a("samples", bytes(gzips[index % gzips.length])),
      a("samplesEncoding", str("gzip")),
      index % 3 === 0 && a("rawFrame", bytes(r.hex(r.int(48, 160)))),
    ]);
  }

  private pushLog(
    block: bigint,
    hash: Hex,
    event: (typeof ENTITY_EVENTS_ABI)[number]["name"],
    entity: MockEntity,
    extra?: { previousOwner?: Hex },
  ) {
    let encoded: Pick<MockLog, "topics" | "data">;
    switch (event) {
      case "EntityCreated":
        encoded = encodeLog(
          event,
          { entityKey: entity.key, owner: entity.owner },
          encodeAbiParameters([{ type: "uint64" }, { type: "uint8" }], [entity.expiresAt, entity.flags]),
        );
        break;
      case "ExpiryExtended":
        encoded = encodeLog(
          event,
          { entityKey: entity.key, owner: entity.owner },
          encodeAbiParameters([{ type: "uint64" }], [entity.expiresAt]),
        );
        break;
      case "OwnershipTransferred":
        encoded = encodeLog(event, {
          entityKey: entity.key,
          previousOwner: extra?.previousOwner,
          newOwner: entity.owner,
        });
        break;
      default:
        encoded = encodeLog(event, {
          entityKey: entity.key,
          owner: entity.owner,
        });
    }
    const sameBlock = this.logs.filter((log) => log.blockNumber === block).length;
    this.logs.push({
      blockNumber: block,
      transactionHash: hash,
      logIndex: sameBlock,
      ...encoded,
    });
  }

  /**
   * Applies the simulated operations of every block up to `head`. Each block
   * has a fixed chance of one operation, decided by its number, so reloading
   * the page replays the same history.
   */
  advance(head = currentBlock()) {
    // After a long idle tab, only simulate the recent past.
    if (head - this.simulatedTo > 600n) this.simulatedTo = head - 600n;
    while (this.simulatedTo < head) {
      this.simulatedTo++;
      this.simulateBlock(this.simulatedTo);
    }
    this.dropExpired(head);
  }

  private simulateBlock(block: bigint) {
    const r = rng(Number(block % 2_147_483_647n));
    if (!r.chance(0.35)) return;
    const hash = txHash(`block-${block}`);
    const roll = r.next();
    const live = [...this.entities.values()].filter((entity) => entity.expiresAt > block);

    if (roll < 0.45) {
      const site = r.pick(SENSOR_SITES);
      const seed = `live-${block}-${this.sequence++}`;
      const entity: MockEntity = {
        key: entityKey(seed),
        owner: OWNERS[3],
        creator: OWNERS[3],
        createdAt: block,
        updatedAt: block,
        expiresAt: block + BigInt(BLOCKS_PER_DAY),
        flags: 0,
        attributes: this.reading(r, this.sequence, site, block, [GZIP_SAMPLES_0, GZIP_SAMPLES_1, GZIP_SAMPLES_2]),
      };
      this.entities.set(entity.key, entity);
      this.pushLog(block, hash, "EntityCreated", entity);
      return;
    }

    const pick = (filter: (entity: MockEntity) => boolean) => {
      const candidates = live.filter(filter);
      return candidates.length ? r.pick(candidates) : undefined;
    };
    const schemaOf = (entity: MockEntity) =>
      entity.attributes.find((attribute) => attribute.name === SCHEMA_ATTRIBUTE)?.value;

    if (roll < 0.8) {
      const position = pick((entity) => schemaOf(entity) === "defi-feed.positions");
      if (!position) return;
      const health = r.int(92, 260) / 100;
      position.attributes = sortAttributes(
        position.attributes.map((attribute) =>
          attribute.name === "healthFactor"
            ? a("healthFactor", dec(health), true)
            : attribute.name === "riskTier"
              ? a("riskTier", str(health < 1.1 ? "critical" : health < 1.5 ? "watch" : "healthy"), true)
              : attribute,
        ),
      );
      position.updatedAt = block;
      this.pushLog(block, hash, "EntityPatched", position);
    } else if (roll < 0.9) {
      const entity = pick((candidate) => candidate.expiresAt !== MAX_EXPIRES_AT);
      if (!entity) return;
      entity.expiresAt = block + BigInt(r.int(2, 60) * BLOCKS_PER_DAY);
      this.pushLog(block, hash, "ExpiryExtended", entity);
    } else if (roll < 0.96) {
      const entity = pick((candidate) => schemaOf(candidate) === "arkiv-demo.comments");
      if (!entity) return;
      const previousOwner = entity.owner;
      entity.owner = r.pick(OWNERS.filter((owner) => owner !== previousOwner));
      this.pushLog(block, hash, "OwnershipTransferred", entity, {
        previousOwner,
      });
    } else {
      const entity = pick((candidate) => schemaOf(candidate) === "sensor-net.readings");
      if (!entity) return;
      this.entities.delete(entity.key);
      this.pushLog(block, hash, "EntityDeleted", entity);
    }
  }

  private dropExpired(head: bigint) {
    for (const [entityKey, entity] of this.entities) {
      if (entity.expiresAt <= head) this.entities.delete(entityKey);
    }
  }
}

/** Shapes a log the way `eth_getLogs` returns it. */
export function toRpcLog(log: MockLog) {
  return {
    address: ARKIV_ADDRESS,
    topics: log.topics,
    data: log.data,
    blockNumber: numberToHex(log.blockNumber),
    blockHash: keccak256(toHex(log.blockNumber)),
    transactionHash: log.transactionHash,
    transactionIndex: "0x0",
    logIndex: numberToHex(log.logIndex),
    removed: false,
  };
}
