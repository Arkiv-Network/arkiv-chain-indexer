#!/usr/bin/env bun
/**
 * Verifies the explorer against the UDC devnet node (docs/udc-e2e.md).
 *
 * Ground truth comes from the node alone (udcE2eNodeTruth.ts): every block
 * and receipt up to the target block, per-block gas and rent sums, and every
 * live entity there through arkiv_query with the full select. It is first
 * checked against itself and against the manifest that udcExplorerTraffic.ts
 * wrote (statuses, gas, rent, failures, expected entity states, absent
 * queries). With --explorer, the explorer is then compared with it:
 *
 *   - the backend API (through udcExplorerApi.ts, the only module that knows
 *     its shapes): block coverage with tx counts, gas and rent sums; every
 *     tx's status, gas, gas fee and rentFee;
 *   - /shadow-rpc: every receipt and block, field by field, rentFee included;
 *   - /shadow-rpc/experimental: every entity at the target block, exactly
 *     (raw JSON), plus order, counts, the manifest's keys and absent queries.
 *     The one exception is bytes contents, which the index never holds: its
 *     `value: null` for a bytes attribute is "withheld", not a difference, and
 *     the content is checked by size and keccak256 against what GET
 *     /entity/<key> says the index holds (a non-null bytes value from the
 *     index is a failure).
 *
 * Usage:
 *   bun verifyUdcExplorer.ts --node http://127.0.0.1:28545 --manifest manifest.json --node-only
 *   bun verifyUdcExplorer.ts --node http://127.0.0.1:28545 --manifest manifest.json \
 *     --explorer http://127.0.0.1:13101 [--wait-seconds 600] [--report report.json]
 *
 * Options:
 *   --at-block <n>       target block (default: the manifest's end checkpoint, else the node head)
 *   --node-only          collect and self-check the ground truth only
 *   --truth-out <file>   write the ground truth (JSON; holds bytes values, keep it local)
 *   --wait-seconds <n>   wait this long for the explorer to index the target block
 *   --report <file>      machine-readable results
 *   --max-examples <n>   examples kept per failure kind (default 3)
 *   --admin-token-file <file>  the backend's AUTH_TOKEN_LOGIN_TOKEN, for /shadow-rpc (an admin surface)
 *   --admin-email <email>      a token-login admin (in AUTH_ADMIN_EMAILS; default udc-e2e@example.com)
 *
 * Exit status 1 when any check fails.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Hex } from "viem";
import { explorerApi, type ExplorerApi } from "./udcExplorerApi";
import {
  canonicalEntity,
  type ExpectedBytes,
  expectationDiffs,
  FULL_SELECT,
  hexBlock,
  jsonEqual,
  type Manifest,
  queryAll,
  rpcBatch,
  rpcCall,
  RpcError,
  type RpcEntity,
  type SplitBytes,
  splitBytes,
  stableJson,
  withheldVerdict,
} from "./udcE2eModel";
import { collectNodeTruth, nodeHead, type NodeTruth } from "./udcE2eNodeTruth";

const { values: args } = parseArgs({
  options: {
    node: { type: "string" },
    manifest: { type: "string" },
    explorer: { type: "string" },
    "at-block": { type: "string" },
    "node-only": { type: "boolean", default: false },
    "truth-out": { type: "string" },
    "wait-seconds": { type: "string", default: "0" },
    report: { type: "string" },
    "max-examples": { type: "string", default: "3" },
    "admin-token-file": { type: "string" },
    "admin-email": { type: "string", default: "udc-e2e@example.com" },
  },
});
if (!args.node || (!args["node-only"] && !args.explorer)) {
  console.error("usage: verifyUdcExplorer.ts --node <url> [--manifest <file>] (--node-only | --explorer <url>)");
  process.exit(2);
}
const MAX_EXAMPLES = Number(args["max-examples"]);

// ---------------------------------------------------------------------------
// Results: per check, a pass count and failures grouped by kind.

interface Check {
  pass: number;
  fail: number;
  kinds: Map<string, { count: number; examples: string[] }>;
}
const checks = new Map<string, Check>();
const check = (name: string): Check => {
  let c = checks.get(name);
  if (!c) checks.set(name, (c = { pass: 0, fail: 0, kinds: new Map() }));
  return c;
};
const pass = (name: string) => void check(name).pass++;
/** Facts worth reporting that are not failures. */
const info: string[] = [];
function fail(name: string, kind: string, example: string) {
  const c = check(name);
  c.fail++;
  let k = c.kinds.get(kind);
  if (!k) c.kinds.set(kind, (k = { count: 0, examples: [] }));
  k.count++;
  if (k.examples.length < MAX_EXAMPLES) k.examples.push(example);
}
/** Passes when got === want, else fails under `kind` (default: the field name). */
function same(name: string, field: string, got: unknown, want: unknown, where: string) {
  const g = got === undefined ? "<not exposed>" : got;
  if (stableJson(g) === stableJson(want)) return true;
  fail(name, got === undefined ? `${field} not exposed` : `${field} differs`, `${where}: got ${short(g)}, want ${short(want)}`);
  return false;
}
const short = (value: unknown) => {
  const text = typeof value === "string" ? value : stableJson(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
};

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

// ---------------------------------------------------------------------------
// Node self-checks

function selfCheck(truth: NodeTruth, manifest: Manifest | null) {
  const name = "node:chain";
  truth.blocks.forEach((block, i) => {
    if (block.number !== i) fail(name, "block gap", `index ${i} holds block ${block.number}`);
    else if (i > 0 && block.parentHash !== truth.blocks[i - 1]!.hash) fail(name, "parent hash", `block ${i}`);
    else pass(name);
    // A block may spend gas outside its transactions (the expiry sweep), never less than they did.
    if (BigInt(block.systemGas) >= 0n) pass("node:block-gas");
    else fail("node:block-gas", "block gasUsed < Σ receipts", `block ${block.number}: ${block.gasUsed} vs ${block.receiptGasUsed}`);
    if (block.systemGas !== "0") info.push(`block ${block.number}: ${block.systemGas} gas outside transactions (header ${block.gasUsed}, receipts ${block.receiptGasUsed})`);
  });
  for (const tx of truth.transactions) {
    if (tx.rentFeePresent) pass("node:receipt-rentFee");
    else fail("node:receipt-rentFee", "receipt without rentFee", tx.hash);
    if (tx.status === 0 && tx.rentFee !== "0") fail("node:failed-no-rent", "reverted tx paid rent", `${tx.hash}: ${tx.rentFee}`);
    else pass("node:failed-no-rent");
  }
  if (truth.entityCount !== null) {
    if (truth.entityCount === truth.entities.length) pass("node:entity-count");
    else fail("node:entity-count", "count ≠ query", `${truth.entityCount} vs ${truth.entities.length}`);
  }
  for (const entity of truth.entities) {
    const names = (entity.attributes ?? []).map((a) => a.name).sort();
    const schema = (entity.attributeSchema ?? []).map((a) => a.name).sort();
    const flags = (entity.attributeSchema ?? []).every((a) => typeof a.indexed === "boolean");
    if (jsonEqual(names, schema) && flags) pass("node:attribute-schema");
    else fail("node:attribute-schema", "attributeSchema ≠ attributes or no indexed flag", String(entity.key));
  }
  const permanent = truth.entities.filter((e) => e.expiresAt === "0xffffffffffffffff");
  if (permanent.length > 0 && permanent.every((e) => canonicalEntity(e).permanent)) pass("node:permanent");
  else fail("node:permanent", "no 2^64 - 1 entity", `${permanent.length} permanent entities`);

  if (!manifest) return;
  const byHash = new Map(truth.transactions.map((t) => [t.hash, t]));
  for (const want of manifest.transactions) {
    const got = byHash.get(want.hash.toLowerCase() as Hex);
    if (!got) {
      fail("node:manifest-txs", "missing", `${want.label} ${want.hash}`);
      continue;
    }
    const where = `${want.label} ${want.hash}`;
    const ok = [
      same("node:manifest-txs", "block", got.block, want.block, where),
      same("node:manifest-txs", "status", got.status, want.expectStatus === "success" ? 1 : 0, where),
      same("node:manifest-txs", "gasUsed", got.gasUsed, want.gasUsed, where),
      same("node:manifest-txs", "rentFee", got.rentFee, want.rentFee, where),
    ].every(Boolean);
    if (ok) pass("node:manifest-txs");
  }
  for (const failure of manifest.failures) {
    if (failure.outcome === "unexpected-success") fail("node:failures", "unexpected success", failure.case);
    else if (failure.outcome === "refused-at-admission") {
      if (failure.hash === null && !failure.nonceAdvanced) pass("node:failures");
      else fail("node:failures", "refused but left a trace", failure.case);
    } else {
      const got = failure.hash ? byHash.get(failure.hash.toLowerCase() as Hex) : undefined;
      if (got && got.status === 0 && got.rentFee === "0") pass("node:failures");
      else fail("node:failures", "not mined with status 0", `${failure.case} ${failure.hash}`);
    }
  }
  for (const entity of manifest.entities) {
    const raw = truth.keyed[entity.key.toLowerCase()];
    const diffs = expectationDiffs(raw ? canonicalEntity(raw) : undefined, entity.expect);
    if (diffs.length === 0) pass("node:manifest-entities");
    else fail("node:manifest-entities", "state differs", `${entity.label}: ${diffs.slice(0, 3).join("; ")}`);
  }
  const live = stableJson(truth.entities);
  const onChain = manifest.bytesMarkers.filter((m) => live.includes(m.hex.slice(2)));
  if (onChain.length > 0) pass("node:bytes-markers");
  else fail("node:bytes-markers", "no marker in live state", `${manifest.bytesMarkers.length} markers`);
}

async function absentQueries(url: string, manifest: Manifest, atBlock: number, name: string, headers: Record<string, string> = {}) {
  for (const { query, reason } of manifest.absentQueries) {
    try {
      const found = await queryAll(url, query, atBlock, { key: true }, 64, headers);
      if (found.length === 0) pass(name);
      else fail(name, "matched", `${query} (${reason}): ${found.length}`);
    } catch (error) {
      fail(name, "query failed", `${query}: ${(error as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Explorer comparisons

async function waitForExplorer(api: ExplorerApi, target: number, seconds: number) {
  const deadline = Date.now() + seconds * 1000;
  let last = 0;
  for (;;) {
    let head;
    try {
      head = await api.head();
    } catch (error) {
      head = null;
      if (Date.now() >= deadline) throw error;
    }
    const scanned = head?.scannerHead ?? -1;
    const projected = head?.entityIndexHead;
    const done = head && scanned >= target && (head.entityIndexReady === null || (head.entityIndexReady && (projected ?? -1) >= target));
    // An index that reports a failed state does not recover by waiting.
    const readiness = String((head?.raw as any)?.features?.entityQueryIndex?.readiness ?? "");
    const stuck = head && scanned >= target && /fail|error/i.test(readiness);
    if (stuck) console.log(`the entity index reports ${readiness}; not waiting for it`);
    if (done || stuck || Date.now() >= deadline) return head;
    if (Date.now() - last > 15_000) {
      console.log(`waiting for the explorer: scanner ${scanned}, entity index ${projected ?? "-"} (ready ${head?.entityIndexReady}), target ${target}`);
      last = Date.now();
    }
    await Bun.sleep(2_000);
  }
}

const RECEIPT_FIELDS = [
  "transactionHash",
  "transactionIndex",
  "blockHash",
  "blockNumber",
  "from",
  "to",
  "cumulativeGasUsed",
  "gasUsed",
  "effectiveGasPrice",
  "status",
  "type",
  "contractAddress",
  "rentFee",
] as const;
const BLOCK_FIELDS = ["number", "hash", "parentHash", "timestamp", "gasUsed", "gasLimit", "baseFeePerGas"] as const;
const quantity = (value: unknown) =>
  typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value) ? value.toLowerCase() : value ?? null;

async function compareExplorer(truth: NodeTruth, api: ExplorerApi, manifest: Manifest | null, node: string) {
  const target = truth.atBlock;
  const head = await api.head().catch((error) => {
    fail("explorer:head", "health failed", (error as Error).message);
    return null;
  });
  if (head) {
    same("explorer:head", "scanner head ≥ target", (head.scannerHead ?? -1) >= target, true, `scanner ${head.scannerHead}`) && pass("explorer:head");
    if (head.entityIndexReady !== null) {
      same("explorer:head", "entity index ready", head.entityIndexReady, true, JSON.stringify((head.raw as any)?.features?.entityQueryIndex?.readiness)) && pass("explorer:head");
      same("explorer:head", "entity index head ≥ target", (head.entityIndexHead ?? -1) >= target, true, `projected ${head.entityIndexHead}`) && pass("explorer:head");
    } else fail("explorer:head", "entity index off", "features.entityQueryIndex is false");
  }

  // Backend API: blocks.
  try {
    const stored = await api.blocks(0, target);
    for (const block of truth.blocks) {
      const got = stored.get(block.number);
      const where = `block ${block.number}`;
      if (!got) {
        fail("explorer:api-blocks", "missing", where);
        continue;
      }
      const ok = [
        same("explorer:api-blocks", "txCount", got.txCount, block.txHashes.length, where),
        same("explorer:api-blocks", "gasUsed", got.gasUsed, block.gasUsed, where),
        same("explorer:api-blocks", "rentSum", got.rentSum, block.rentSum, where),
      ].every(Boolean);
      if (ok) pass("explorer:api-blocks");
    }
  } catch (error) {
    fail("explorer:api-blocks", "request failed", (error as Error).message);
  }

  // Backend API: transactions.
  await pool(truth.transactions, 16, async (tx) => {
    const where = `${tx.hash} (block ${tx.block})`;
    let got;
    try {
      got = await api.transaction(tx.hash);
    } catch (error) {
      fail("explorer:api-txs", "request failed", `${where}: ${(error as Error).message}`);
      return;
    }
    if (!got) {
      fail("explorer:api-txs", "missing", where);
      return;
    }
    const ok = [
      same("explorer:api-txs", "block", got.block, tx.block, where),
      same("explorer:api-txs", "position", got.position, tx.index, where),
      same("explorer:api-txs", "from", got.from, tx.from, where),
      same("explorer:api-txs", "to", got.to, tx.to, where),
      same("explorer:api-txs", "status", got.status, tx.status, where),
      same("explorer:api-txs", "gasUsed", got.gasUsed, tx.gasUsed, where),
      same("explorer:api-txs", "gasFee", got.gasFee, tx.gasFee, where),
      same("explorer:api-txs", "rentFee", got.rentFee, tx.rentFee, where),
    ].every(Boolean);
    if (ok) pass("explorer:api-txs");
  });

  // Shadow RPC (an admin surface: a token-login session): receipts and blocks,
  // against the node's own answers.
  const shadow = await api.shadowRpcHeaders().catch((e) => e as Error);
  if (shadow instanceof Error) fail("explorer:shadow-login", "login failed", shadow.message);
  const headers = shadow instanceof Error ? {} : shadow;
  const hashes = truth.transactions.map((t) => t.hash);
  const [mine, theirs] = await Promise.all([
    rpcBatch<any>(api.shadowRpcUrl, hashes.map((h) => ({ method: "eth_getTransactionReceipt", params: [h] })), { cap: 50, headers }).catch((e) => e as Error),
    rpcBatch<any>(node, hashes.map((h) => ({ method: "eth_getTransactionReceipt", params: [h] }))),
  ]);
  if (mine instanceof Error) fail("explorer:shadow-receipts", "request failed", mine.message);
  else
    hashes.forEach((hash, i) => {
      const got = mine[i];
      const want = theirs[i];
      if (got instanceof RpcError || got === null) {
        fail("explorer:shadow-receipts", got === null ? "missing" : `error ${(got as RpcError).code}`, hash);
        return;
      }
      if (want instanceof RpcError) return;
      let ok = RECEIPT_FIELDS.map((field) =>
        same("explorer:shadow-receipts", field, field in got ? quantity(got[field]) : undefined, quantity(want[field]), hash),
      ).every(Boolean);
      const logs = (r: any) =>
        (r.logs ?? []).map((l: any) => ({ address: quantity(l.address), topics: (l.topics ?? []).map(quantity), data: quantity(l.data), logIndex: quantity(l.logIndex) }));
      ok = same("explorer:shadow-receipts", "logs", logs(got), logs(want), hash) && ok;
      if (ok) pass("explorer:shadow-receipts");
    });

  const numbers = truth.blocks.map((b) => b.number);
  const [shadowBlocks, nodeBlocks] = await Promise.all([
    rpcBatch<any>(api.shadowRpcUrl, numbers.map((n) => ({ method: "eth_getBlockByNumber", params: [hexBlock(n), false] })), { cap: 50, headers }).catch((e) => e as Error),
    rpcBatch<any>(node, numbers.map((n) => ({ method: "eth_getBlockByNumber", params: [hexBlock(n), false] }))),
  ]);
  if (shadowBlocks instanceof Error) fail("explorer:shadow-blocks", "request failed", shadowBlocks.message);
  else
    numbers.forEach((n, i) => {
      const got = shadowBlocks[i];
      const want = nodeBlocks[i];
      const where = `block ${n}`;
      if (got instanceof RpcError || got === null) {
        fail("explorer:shadow-blocks", got === null ? "missing" : `error ${(got as RpcError).code}`, where);
        return;
      }
      if (want instanceof RpcError) return;
      const txs = (b: any) => (b.transactions ?? []).map((t: any) => quantity(typeof t === "string" ? t : t.hash));
      const ok = [
        ...BLOCK_FIELDS.map((field) => same("explorer:shadow-blocks", field, field in got ? quantity(got[field]) : undefined, quantity(want[field]), where)),
        same("explorer:shadow-blocks", "transactions", txs(got), txs(want), where),
      ].every(Boolean);
      if (ok) pass("explorer:shadow-blocks");
    });

  // Entity index: every entity at the target block, exactly as the node has it
  // (bytes contents aside: see splitBytes).
  const index = api.experimentalRpcUrl;
  const bytesToCheck: Array<{ key: string; expected: ExpectedBytes[] }> = [];
  let indexed: RpcEntity[] | null = null;
  try {
    indexed = await queryAll(index, "*", target, FULL_SELECT, 64, headers);
  } catch (error) {
    fail("explorer:entities", "query failed", (error as Error).message);
  }
  if (indexed) {
    const byKey = new Map(indexed.map((e) => [String(e.key).toLowerCase(), e]));
    for (const want of truth.entities) {
      const got = byKey.get(String(want.key).toLowerCase());
      const where = String(want.key);
      if (!got) {
        fail("explorer:entities", "missing", where);
        continue;
      }
      const split = splitBytes(got, want);
      checkWithheld(split, where);
      if (split.expected.length > 0) bytesToCheck.push({ key: where, expected: split.expected });
      if (jsonEqual(split.got, split.want)) {
        pass("explorer:entities");
        continue;
      }
      for (const field of Object.keys(FULL_SELECT)) {
        const g = (split.got as any)[field];
        const w = (split.want as any)[field];
        if (!jsonEqual(g, w)) {
          const detail =
            field === "attributes" || field === "attributeSchema"
              ? attributeDiff(field, g, w)
              : `got ${short(g)}, want ${short(w)}`;
          fail("explorer:entities", `${field} differs`, `${where}: ${detail}`);
        }
      }
    }
    const nodeKeys = new Set(truth.entities.map((e) => String(e.key).toLowerCase()));
    for (const key of byKey.keys()) if (!nodeKeys.has(key)) fail("explorer:entities", "extra (not live on the node)", key);
    const order = (list: RpcEntity[]) => list.map((e) => String(e.key).toLowerCase()).filter((k) => nodeKeys.has(k) && byKey.has(k));
    same("explorer:entity-order", "order", order(indexed), order(truth.entities), "* at target") && pass("explorer:entity-order");
    await checkBytesHashes(api, bytesToCheck);
  }
  try {
    const count = Number(await rpcCall(index, "arkiv_getEntityCount", [{ query: "*", block: target }], headers));
    same("explorer:entity-count", "count", count, truth.entityCount, "*") && pass("explorer:entity-count");
  } catch (error) {
    fail("explorer:entity-count", "request failed", (error as Error).message);
  }
  for (const [key, want] of Object.entries(truth.keyed)) {
    try {
      const [got] = await queryAll(index, `$key = key(${key})`, target, FULL_SELECT, 64, headers);
      if (!want) same("explorer:entity-keys", "absent", got ? "live" : "absent", "absent", key) && pass("explorer:entity-keys");
      else if (!got) fail("explorer:entity-keys", "missing", key);
      else {
        const split = splitBytes(got, want);
        checkWithheld(split, key);
        if (jsonEqual(split.got, split.want)) pass("explorer:entity-keys");
        else fail("explorer:entity-keys", "differs", `${key}: ${diffFields(split.got, split.want).join(", ")}`);
      }
    } catch (error) {
      fail("explorer:entity-keys", "query failed", `${key}: ${(error as Error).message}`);
    }
  }
  if (manifest) await absentQueries(index, manifest, target, "explorer:absent-queries", headers);
}

/** Records the withheld-bytes verdict (see withheldVerdict) under explorer:bytes-withheld. */
function checkWithheld(split: SplitBytes, where: string) {
  const verdict = withheldVerdict(split);
  if (verdict.outcome === "fail") fail("explorer:bytes-withheld", "index returned bytes content", `${where}: ${verdict.leaked.join(", ")}`);
  else if (verdict.outcome === "pass") pass("explorer:bytes-withheld");
}

/** Each withheld bytes value, by size and keccak256, against what GET /entity/<key> says the index holds. */
async function checkBytesHashes(api: ExplorerApi, entities: Array<{ key: string; expected: ExpectedBytes[] }>) {
  await pool(entities, 8, async ({ key, expected }) => {
    let held: Awaited<ReturnType<ExplorerApi["entityBytes"]>>;
    try {
      held = await api.entityBytes(key as Hex);
    } catch (error) {
      fail("explorer:bytes-hash", "request failed", `${key}: ${(error as Error).message}`);
      return;
    }
    if (held === null) {
      fail("explorer:bytes-hash", "entity unknown to the API", key);
      return;
    }
    if (held === undefined) {
      fail("explorer:bytes-hash", "entity state not exposed", key);
      return;
    }
    for (const want of expected) {
      const where = `${key} ${want.name}`;
      const got = held.get(want.name);
      if (!got) {
        fail("explorer:bytes-hash", "missing", where);
        continue;
      }
      // The REST state withholds the content just as the RPC does.
      if (got.value !== null) fail("explorer:bytes-withheld", "GET /entity returned bytes content", where);
      else pass("explorer:bytes-withheld");
      const sizeOk = same("explorer:bytes-hash", "size", got.size, want.size, where);
      const hashOk = same("explorer:bytes-hash", "keccak256", got.keccak256, want.keccak256, where);
      if (sizeOk && hashOk) pass("explorer:bytes-hash");
    }
  });
}

function diffFields(got: RpcEntity, want: RpcEntity): string[] {
  return Object.keys(FULL_SELECT).filter((f) => !jsonEqual((got as any)[f], (want as any)[f]));
}

function attributeDiff(field: string, got: any[] | undefined, want: any[] | undefined): string {
  const map = (list: any[] | undefined) => new Map((list ?? []).map((a) => [a.name, a]));
  const [g, w] = [map(got), map(want)];
  const notes: string[] = [];
  for (const [name, a] of w) {
    const b = g.get(name);
    if (!b) notes.push(`${name} missing`);
    else if (!jsonEqual(a, b)) notes.push(`${name}: got ${short(b)}, want ${short(a)}`);
  }
  for (const name of g.keys()) if (!w.has(name)) notes.push(`${name} extra`);
  return `${field}: ${notes.slice(0, 3).join("; ")}${notes.length > 3 ? ` (+${notes.length - 3})` : ""}`;
}

// ---------------------------------------------------------------------------

const manifest: Manifest | null = args.manifest ? JSON.parse(readFileSync(args.manifest, "utf8")) : null;
const api = args.explorer
  ? explorerApi(args.explorer, {
      adminEmail: args["admin-email"]!,
      adminToken: args["admin-token-file"] ? readFileSync(args["admin-token-file"], "utf8").trim() : undefined,
    })
  : null;
const target = args["at-block"] ? Number(args["at-block"]) : manifest ? manifest.checkpoints.end : await nodeHead(args.node);
if (api && Number(args["wait-seconds"]) > 0) await waitForExplorer(api, target, Number(args["wait-seconds"]));

const started = Date.now();
const keys = (manifest?.entities ?? []).map((e) => e.key);
const truth = await collectNodeTruth(args.node, { atBlock: target, keys });
console.log(
  `node truth at block ${target}: ${truth.blocks.length} blocks, ${truth.totals.txs} txs (${truth.totals.failedTxs} failed), ` +
    `${truth.entities.length} live entities, rent ${truth.totals.rentWei} wei, gas fees ${truth.totals.gasFeeWei} wei ` +
    `(${((Date.now() - started) / 1000).toFixed(1)} s)`,
);
if (args["truth-out"]) writeFileSync(args["truth-out"], JSON.stringify(truth, null, 1) + "\n");
selfCheck(truth, manifest);
if (manifest) await absentQueries(args.node, manifest, target, "node:absent-queries");
if (api) await compareExplorer(truth, api, manifest, args.node);

let failed = 0;
const report: Record<string, unknown> = { target, node: args.node, explorer: args.explorer ?? null, checks: {} };
for (const [name, c] of [...checks].sort(([a], [b]) => (a < b ? -1 : 1))) {
  failed += c.fail;
  const kinds = Object.fromEntries([...c.kinds].map(([kind, k]) => [kind, k]));
  (report.checks as any)[name] = { pass: c.pass, fail: c.fail, kinds };
  console.log(`${c.fail ? "FAIL" : "ok  "} ${name}: ${c.pass} passed${c.fail ? `, ${c.fail} failed` : ""}`);
  for (const [kind, k] of c.kinds) {
    console.log(`       ${kind}: ${k.count}`);
    for (const example of k.examples) console.log(`         - ${example}`);
  }
}
if (info.length) {
  console.log(`info (${info.length}):`);
  for (const line of info.slice(0, 20)) console.log(`  ${line}`);
}
report.info = info;
report.failed = failed;
if (args.report) writeFileSync(args.report, JSON.stringify(report, null, 2) + "\n");
console.log(failed ? `VERIFY FAILED: ${failed} failed checks` : "VERIFY PASSED");
process.exit(failed ? 1 : 0);
