import { feedDigest } from "./feedDigest";
import {
  digest,
  headerBytes,
  type FeedBlock,
  type Header,
  type Change,
  type Operation,
  type SourceStatus,
} from "./wire";
export const ZERO = "0x" + "00".repeat(32),
  OWNER = "0x" + "11".repeat(20);
export const id = {
  sourceId: "11111111-1111-4111-8111-111111111111",
  runId: "11".repeat(16),
  chainId: "1337",
  genesisHash: ZERO,
};
export function redigest(b: FeedBlock): FeedBlock {
  const { feedDigest: _, ...metadata } = b;
  b.feedDigest = feedDigest(metadata);
  return b;
}
export function reheader(b: FeedBlock): FeedBlock {
  const bytes = headerBytes(b.chainId, b.header);
  b.header.headerBytes = "0x" + bytes.toString("hex");
  b.header.hash = digest("arkiv/header/v2", bytes);
  return redigest(b);
}
export function genesis(): FeedBlock {
  const h: Header = {
    height: "0",
    hash: ZERO,
    parentHash: ZERO,
    stateRoot: "0x" + "01".repeat(32),
    timestampMs: "1700000000000",
    inputsDigest: ZERO,
    outcomesDigest: ZERO,
    headerBytes: "",
  };
  const b = reheader({
    feedVersion: 1,
    feedDigest: ZERO,
    ...id,
    header: h,
    transactions: [],
    operations: [],
    changes: [],
    spentUnits: "0",
  });
  b.genesisHash = b.header.hash;
  return redigest(b);
}
export function op(
  kind: string,
  namespaceId: string | null = "1",
  recordId: string | null = null,
  recordKey: string | null = null,
): Operation {
  return {
    phase: "user",
    groupPosition: 0,
    operationPosition: 0,
    kind,
    namespaceId,
    recordId,
    recordKey,
    outcome: "applied",
    receipt: { modelVersion: 1, scheduleId: 1, spentUnits: "7" },
    reason: null,
  };
}
export function next(
  prior: FeedBlock,
  changes: Change[] = [],
  ops: Operation[] = [],
): FeedBlock {
  const height = (BigInt(prior.header.height) + 1n).toString(),
    spent = ops
      .reduce((sum, x) => sum + BigInt(x.receipt?.spentUnits ?? 0), 0n)
      .toString();
  const b: FeedBlock = {
    feedVersion: 1,
    feedDigest: ZERO,
    sourceId: prior.sourceId,
    runId: prior.runId,
    chainId: prior.chainId,
    genesisHash: prior.genesisHash,
    header: {
      ...prior.header,
      height,
      parentHash: prior.header.hash,
      timestampMs: (BigInt(prior.header.timestampMs) + 1000n).toString(),
    },
    transactions: ops.some((o) => o.phase === "user")
      ? [
          {
            position: 0,
            digest: "0x" + BigInt(height).toString(16).padStart(64, "0"),
            actor: OWNER,
            requestId: "0x" + BigInt(height).toString(16).padStart(64, "0"),
            budgetUnits: "1000",
            status: ops.some(
              (o) => o.phase === "user" && o.outcome !== "applied",
            )
              ? "failed"
              : "committed",
            spentUnits: ops
              .filter((o) => o.phase === "user")
              .reduce((n, o) => n + BigInt(o.receipt?.spentUnits ?? 0), 0n)
              .toString(),
          },
        ]
      : [],
    operations: ops.map((o, i) => ({ ...o, operationPosition: i })),
    changes,
    spentUnits: spent,
  };
  return reheader(b);
}
export function status(b: FeedBlock): SourceStatus {
  return {
    apiVersion: 1,
    feedVersion: 1,
    sourceId: b.sourceId,
    runId: b.runId,
    chainId: b.chainId,
    genesisHash: b.genesisHash,
    sourceKind: "arkiv-native-simulator",
    authentication: "unsigned-simulator-v1",
    durability: "volatile",
    head: {
      height: b.header.height,
      hash: b.header.hash,
      stateRoot: b.header.stateRoot,
    },
    paused: true,
    health: "ready",
    role: "producer",
    configRevision: "0",
    projectionVersion: 1,
    blockFormatVersion: 1,
    protocolVersion: 2,
    coverage: { from: "0", through: b.header.height, complete: true },
    proofProfiles: ["eq-page-v1"],
    limits: { feedPageBytes: "4194304", pageItems: 64 },
    workload: {
      version: 1,
      seed: "7",
      blockPeriodMs: "1000",
      payloadBytes: 64,
      extraRowsPerBlock: 0,
    },
    memory: {
      engineCacheBytes: "0",
      engineCacheEntries: 0,
      residentManifests: 1,
    },
    observedPeerHeight: b.header.height,
  };
}
export function row(recordId: string, key = "0x01", namespaceId = "1"): Change {
  return {
    kind: "recordUpsert",
    namespaceId,
    recordId,
    recordKey: key,
    expiresAtHeight: "18446744073709551615",
    attributes: [
      { name: "n", type: "u64", value: "18446744073709551615" },
      { name: "flag", type: "bool", value: true },
      { name: "text", type: "str", value: "nul\u0000unicodeé" },
      { name: "minus", type: "i64", value: "-9223372036854775808" },
    ],
    fields: [
      {
        name: "payload",
        type: "bytes",
        byteLength: "1024",
        digest: ZERO,
        reference: null,
      },
    ],
  };
}
export function history(): FeedBlock[] {
  const g = genesis();
  const one = next(
    g,
    [
      {
        kind: "namespaceUpsert",
        namespaceId: "1",
        name: "first",
        owner: OWNER,
        revision: "0",
      },
      {
        kind: "namespaceUpsert",
        namespaceId: "2",
        name: "second",
        owner: OWNER,
        revision: "0",
      },
      row("1"),
      row("1", "0x01", "2"),
    ],
    [
      op("createNamespace", "1"),
      op("createNamespace", "2"),
      op("createRecord", "1", "1", "0x01"),
      op("createRecord", "2", "1", "0x01"),
    ],
  );
  const two = next(
    one,
    [
      {
        kind: "recordDelete",
        namespaceId: "1",
        recordId: "1",
        recordKey: "0x01",
      },
      row("2"),
    ],
    [
      op("deleteRecord", "1", "1", "0x01"),
      op("createRecord", "1", "2", "0x01"),
    ],
  );
  return [g, one, two];
}
