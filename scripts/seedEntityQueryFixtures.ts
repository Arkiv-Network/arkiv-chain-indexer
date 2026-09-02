#!/usr/bin/env bun
/**
 * Seeds a suite of fixture entities that exercises every attribute type and
 * every mutation the entity index folds — creates (several in one
 * transaction, to pin intra-block order), patches that add, overwrite,
 * retype and tombstone attributes or swap the payload, an extension, an
 * ownership transfer, a delete, an entity that expires within minutes,
 * creation flags, an extension by a stranger, and transactions that revert —
 * then writes a manifest that `compareEntityQuery.ts --manifest` uses to
 * compare the node and the index block-exactly around each of them.
 *
 * Every entity carries `suite`, `run` and `case` attributes, so runs never
 * collide and the suite can be found again with
 * `suite = str('arkiv-indexer-query-suite') AND run = str('<run>')`.
 *
 * Usage:
 *   bun run scripts/seedEntityQueryFixtures.ts \
 *     --rpc http://172.21.0.2:8788 --env-file .env \
 *     --wallet 240 --other-wallet 241 --out fixtures.json
 *
 * `--env-file` supplies BASELOAD_MNEMONIC, BASELOAD_FAUCET_URL and
 * BASELOAD_FAUCET_PASSWORD (the same variables the Baseload runtime uses);
 * each can also come from the environment or `--mnemonic`, `--faucet`,
 * `--faucet-password`. Wallets are derived like Baseload workers
 * (m/44'/60'/0'/0/<n>); pick numbers no worker uses.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ExpirationTime, createWalletClient, type WalletArkivClient } from "@arkiv-network/sdk";
import { addr, bool, bytes32, dec, i32, key, str, u64, u256, type AttributeInputs } from "@arkiv-network/sdk/attr";
import type { Expiry } from "@arkiv-network/sdk/entity";
import { defineChain, formatEther, http, parseEther, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { BASELOAD_DERIVATION_PATH_PREFIX } from "../src/baseloadConfig";
import { BaseloadFaucetClient } from "../src/baseloadFaucet";

const { values: args } = parseArgs({
  options: {
    rpc: { type: "string" },
    "env-file": { type: "string" },
    mnemonic: { type: "string" },
    faucet: { type: "string" },
    "faucet-password": { type: "string" },
    wallet: { type: "string", default: "240" },
    "other-wallet": { type: "string", default: "241" },
    suite: { type: "string", default: "arkiv-indexer-query-suite" },
    run: { type: "string" },
    "short-blocks": { type: "string", default: "40" },
    "no-wait": { type: "boolean", default: false },
    out: { type: "string", default: "fixtures.json" },
    help: { type: "boolean", default: false },
  },
});

if (args.help || !args.rpc) {
  console.log(
    "usage: bun run scripts/seedEntityQueryFixtures.ts --rpc <url> [--env-file .env] [--wallet 240] [--other-wallet 241]\n" +
      "       [--suite name] [--run id] [--short-blocks 40] [--no-wait] [--out fixtures.json]",
  );
  process.exit(args.help ? 0 : 2);
}

// ---------------------------------------------------------------------------
// Settings

function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[match[1]!] = value;
  }
  return out;
}

const fileEnv = args["env-file"] ? readEnvFile(args["env-file"]) : {};
const setting = (flag: string | undefined, name: string): string | undefined =>
  flag ?? process.env[name]?.trim() ?? fileEnv[name];

const RPC_URL = args.rpc;
const MNEMONIC = setting(args.mnemonic, "BASELOAD_MNEMONIC");
const FAUCET_URL = setting(args.faucet, "BASELOAD_FAUCET_URL");
const FAUCET_PASSWORD = setting(args["faucet-password"], "BASELOAD_FAUCET_PASSWORD");
const SUITE = args.suite;
const RUN = args.run ?? new Date().toISOString().replace(/[:.]/g, "-");
const SHORT_BLOCKS = Number(args["short-blocks"]);
if (!MNEMONIC) {
  console.error("a mnemonic is required (--mnemonic, BASELOAD_MNEMONIC, or --env-file)");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Chain access

async function rawRpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.code} ${body.error.message}`);
  return body.result as T;
}

const chainId = Number(await rawRpc<string>("eth_chainId"));
const chain = defineChain({
  id: chainId,
  name: `Arkiv ${chainId}`,
  nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
  rpcUrls: { default: { http: [RPC_URL] } },
});

function walletClient(walletNumber: number): WalletArkivClient {
  const account = mnemonicToAccount(MNEMONIC!.trim(), { path: `${BASELOAD_DERIVATION_PATH_PREFIX}/${walletNumber}` });
  return createWalletClient({ chain, transport: http(RPC_URL), account });
}

const walletA = walletClient(Number(args.wallet));
const walletB = walletClient(Number(args["other-wallet"]));
const addressA = walletA.account!.address;
const addressB = walletB.account!.address;

async function currentBlock(): Promise<bigint> {
  return BigInt(await rawRpc<string>("eth_blockNumber"));
}

async function balanceOf(address: string): Promise<bigint> {
  return BigInt(await rawRpc<string>("eth_getBalance", [address, "latest"]));
}

async function ensureFunded(client: WalletArkivClient, label: string): Promise<void> {
  const address = client.account!.address;
  let balance = await balanceOf(address);
  console.log(`${label} ${address}: ${formatEther(balance)} ETH`);
  if (balance >= parseEther("0.5")) return;
  if (!FAUCET_URL || !FAUCET_PASSWORD) {
    throw new Error(`${label} needs funds and no faucet is configured (BASELOAD_FAUCET_URL / BASELOAD_FAUCET_PASSWORD)`);
  }
  const faucet = new BaseloadFaucetClient({
    url: FAUCET_URL,
    password: FAUCET_PASSWORD,
    minBalanceWei: parseEther("50"),
    maxBalanceWei: parseEther("100000"),
    dripAmountWei: parseEther("100"),
    cooldownMs: 0,
  });
  const drip = await faucet.maybeTopUp(address, balance);
  console.log(`  faucet drip ${drip.requested ? "requested" : `skipped (${drip.reason})`}`);
  for (let attempt = 0; attempt < 60; attempt++) {
    await Bun.sleep(2_000);
    balance = await balanceOf(address);
    if (balance >= parseEther("0.5")) {
      console.log(`  funded: ${formatEther(balance)} ETH`);
      return;
    }
  }
  throw new Error(`${label} still unfunded after the faucet drip`);
}

// ---------------------------------------------------------------------------
// Fixtures

interface TxRecord {
  name: string;
  hash: string;
  block: number;
  status: "success" | "reverted";
  created?: string[];
}

const entities: Record<string, Hex> = {};
const txs: TxRecord[] = [];
const encoder = new TextEncoder();

function common(caseName: string, extra: AttributeInputs = {}): AttributeInputs {
  return { suite: str(SUITE), run: str(RUN), case: str(caseName), ...extra };
}

function create(caseName: string, attributes: AttributeInputs = {}, options: { expires?: Expiry; contentType?: string; payload?: string; flags?: { readonly?: boolean; permissionlessExtension?: boolean } } = {}) {
  return {
    payload: encoder.encode(options.payload ?? `fixture ${caseName} ${RUN}`),
    contentType: options.contentType ?? "text/plain",
    attributes: common(caseName, attributes),
    expires: options.expires ?? ExpirationTime.fromHours(24),
    ...(options.flags ? { flags: options.flags } : {}),
  };
}

async function send(name: string, client: WalletArkivClient, ops: Parameters<WalletArkivClient["executeBatch"]>[0], caseNames: string[] = []): Promise<TxRecord> {
  console.log(`\n${name} (${client.account!.address === addressA ? "wallet A" : "wallet B"})`);
  const result = await client.executeBatch(ops);
  const receipt = await rawRpc<{ blockNumber: string; status: string }>("eth_getTransactionReceipt", [result.txHash]);
  const record: TxRecord = {
    name,
    hash: result.txHash,
    block: Number(BigInt(receipt.blockNumber)),
    status: BigInt(receipt.status) === 1n ? "success" : "reverted",
    created: result.createdEntities,
  };
  txs.push(record);
  result.createdEntities.forEach((entityKey, i) => {
    const caseName = caseNames[i];
    if (caseName) entities[caseName] = entityKey;
  });
  console.log(`  ${record.hash} in block ${record.block}: ${record.status}${result.createdEntities.length ? `, ${result.createdEntities.length} created` : ""}`);
  return record;
}

/** A transaction that is expected to revert: sent with a fixed gas limit so no estimate stops it, then waited on. */
async function sendExpectingRevert(name: string, client: WalletArkivClient, ops: Parameters<WalletArkivClient["executeBatch"]>[0]): Promise<TxRecord> {
  console.log(`\n${name} (${client.account!.address === addressA ? "wallet A" : "wallet B"}, expected to revert)`);
  const { txHash } = await client.advanced.sendMutation(ops, { txParams: { gas: 400_000n } });
  const receipt = await client.waitForTransactionReceipt({ hash: txHash });
  const record: TxRecord = { name, hash: txHash, block: Number(receipt.blockNumber), status: receipt.status };
  txs.push(record);
  console.log(`  ${record.hash} in block ${record.block}: ${record.status}`);
  return record;
}

const HUGE_U256 = (1n << 256n) - 1n;
const U64_MAX = (1n << 64n) - 1n;
const SAMPLE_KEY = `0x${"11".repeat(31)}ff` as Hex;
const SAMPLE_BYTES32 = `0x${"00".repeat(30)}beef` as Hex;
const SAMPLE_ADDR = "0x000000000000000000000000000000000000dEaD";
const UNICODE = "zażółć gęślą jaźń ✓";
const MAX_STR = "a".repeat(128);

async function main(): Promise<void> {
  console.log(`chain ${chainId} via ${RPC_URL}\nsuite ${SUITE}, run ${RUN}`);
  await ensureFunded(walletA, "wallet A");
  await ensureFunded(walletB, "wallet B");
  const startBlock = await currentBlock();
  console.log(`starting at block ${startBlock}`);

  // 1. Every type, extremes, strings, one transaction: the index must keep the
  //    node's intra-block order for these.
  await send(
    "create-types",
    walletA,
    {
      creates: [
        create("types-all", {
          b: bool(true),
          i: i32(42),
          ineg: i32(-7),
          u: u64(12345),
          big: u256(HUGE_U256 - 1n),
          d: dec("1.5"),
          dneg: dec("-0.000000000000000001"),
          b32: bytes32(SAMPLE_BYTES32),
          s: str("hello"),
          a: addr(SAMPLE_ADDR),
          k: key(SAMPLE_KEY),
        }),
        create("i32-extremes", { i32min: i32(-2147483648), i32max: i32(2147483647), zero: i32(0) }),
        create("u64-extremes", { u64zero: u64(0), u64max: u64(U64_MAX), u64mid: u64(1n << 40n) }),
        create("u256-extremes", { u256zero: u256(0), u256max: u256(HUGE_U256), u256mid: u256(1n << 128n) }),
        create("dec-cases", {
          d1: dec("0"),
          d2: dec("-123456789.123456789012345678"),
          d3: dec("0.5"),
          d4: dec("1000000"),
          d5: dec("99999999999999999999.999999999999999999"),
        }),
        create("str-cases", {
          s_unicode: str(UNICODE),
          s_quote: str("it's"),
          s_empty: str(""),
          s_max: str(MAX_STR),
          s_prefix: str("prefix-match-me"),
          s_upper: str("Prefix-Match-Me"),
        }),
        create("bool-false", { flag: bool(false) }),
        create("order-1", { seq: i32(1) }),
        create("order-2", { seq: i32(2) }),
        create("order-3", { seq: i32(3) }),
      ],
    },
    ["types-all", "i32-extremes", "u64-extremes", "u256-extremes", "dec-cases", "str-cases", "bool-false", "order-1", "order-2", "order-3"],
  );

  // 2. The entities later transactions mutate, plus flags and expiries.
  const head = await currentBlock();
  await send(
    "create-targets",
    walletA,
    {
      creates: [
        create("patch-target", { n: i32(1), keep: str("k"), gone: str("bye") }),
        create("retype-target", { v: i32(5) }),
        create("tombstone-target", { gone: str("x"), stay: i32(1) }),
        create("payload-target", { p: i32(1) }, { contentType: "text/plain", payload: "before" }),
        create("extend-target", { e: i32(1) }),
        create("transfer-target", { t: i32(1) }),
        create("delete-target", { del: i32(1) }),
        create("short-lived", { ttl: i32(SHORT_BLOCKS) }, { expires: ExpirationTime.fromBlocks(SHORT_BLOCKS) }),
        create("absolute-expiry", { abs: i32(1) }, { expires: ExpirationTime.atBlock(head + 5_000n) }),
        create("readonly-flag", { ro: i32(1) }, { flags: { readonly: true } }),
        create("permissionless-flag", { pe: i32(1) }, { flags: { permissionlessExtension: true } }),
        create("both-flags", { bf: i32(1) }, { flags: { readonly: true, permissionlessExtension: true } }),
        create("json-payload", { j: i32(1) }, { contentType: "application/json", payload: '{"fixture":true}' }),
      ],
    },
    [
      "patch-target",
      "retype-target",
      "tombstone-target",
      "payload-target",
      "extend-target",
      "transfer-target",
      "delete-target",
      "short-lived",
      "absolute-expiry",
      "readonly-flag",
      "permissionless-flag",
      "both-flags",
      "json-payload",
    ],
  );

  // 3. Patches: overwrite + add, retype, tombstone, payload swap.
  await send("patch", walletA, {
    patches: [
      { entityKey: entities["patch-target"]!, set: { added: str("new"), n: i32(2) } },
      { entityKey: entities["retype-target"]!, set: { v: u64(5) } },
      { entityKey: entities["tombstone-target"]!, unset: ["gone"] },
      { entityKey: entities["payload-target"]!, payload: encoder.encode('{"after":true}'), contentType: "application/json" },
    ],
  });

  // 4. Extend, 5. transfer, 6. delete — separate transactions, separate checkpoints.
  await send("extend", walletA, { extensions: [{ entityKey: entities["extend-target"]!, expires: ExpirationTime.fromHours(48) }] });
  await send("transfer", walletA, { ownershipChanges: [{ entityKey: entities["transfer-target"]!, newOwner: addressB }] });
  await send("delete", walletA, { deletes: [{ entityKey: entities["delete-target"]! }] });

  // 7. The new owner patches what it received; a stranger extends the
  //    permissionless entity.
  await send("stranger", walletB, {
    patches: [{ entityKey: entities["transfer-target"]!, set: { t: i32(2), by: addr(addressB) } }],
    extensions: [{ entityKey: entities["permissionless-flag"]!, expires: ExpirationTime.fromHours(30) }],
  });

  // 8. Reverts: a patch on a readonly entity, and a stranger patching what it
  //    does not own. The index must fold nothing from either.
  await sendExpectingRevert("revert-readonly", walletA, {
    patches: [{ entityKey: entities["readonly-flag"]!, set: { x: i32(1) } }],
  });
  await sendExpectingRevert("revert-stranger", walletB, {
    patches: [{ entityKey: entities["patch-target"]!, set: { hijacked: bool(true) } }],
  });

  // 9. A second patch of the same entity, to fold two versions after creation.
  await send("patch-again", walletA, {
    patches: [{ entityKey: entities["patch-target"]!, set: { n: i32(3) }, unset: ["keep"] }],
  });

  // The short-lived entity: read its expiry from the node, then wait it out.
  const shortLived = (await rawRpc<{ expiresAt: string } | null>("arkiv_getEntity", [entities["short-lived"]]))!;
  const shortExpiry = Number(BigInt(shortLived.expiresAt));
  console.log(`\nshort-lived entity expires at block ${shortExpiry}`);
  if (!args["no-wait"]) {
    for (;;) {
      const block = await currentBlock();
      if (block > BigInt(shortExpiry) + 1n) break;
      console.log(`  waiting for block ${shortExpiry + 2} (at ${block})`);
      await Bun.sleep(4_000);
    }
  }
  const headAfter = Number(await currentBlock());

  const checkpoints = new Set<number>();
  for (const tx of txs) {
    checkpoints.add(tx.block - 1);
    checkpoints.add(tx.block);
  }
  checkpoints.add(shortExpiry - 1);
  checkpoints.add(shortExpiry);
  checkpoints.add(shortExpiry + 1);

  const B = addressB.toLowerCase();
  const A = addressA.toLowerCase();
  const queries = [
    // types-all
    "case = str('types-all')",
    "b = true",
    "i = i32(42)",
    "i = 42",
    "ineg = i32(-7)",
    "ineg < i32(0)",
    "ineg < 0 AND i > 0",
    "u = u64(12345)",
    "u >= u64(12345)",
    "u > u64(12345)",
    `big = u256(${HUGE_U256 - 1n})`,
    `big < u256(${HUGE_U256})`,
    "d = dec(1.5)",
    "d > dec(1.4)",
    "d >= dec(1.5) AND d <= dec(1.5)",
    "dneg = dec(-0.000000000000000001)",
    "dneg < dec(0)",
    `b32 = bytes32(${SAMPLE_BYTES32})`,
    "s = str('hello')",
    "s STARTSWITH str('he')",
    "s STARTSWITH str('hello!')",
    `a = addr(${SAMPLE_ADDR})`,
    `a = addr(${SAMPLE_ADDR.toLowerCase()})`,
    `k = key(${SAMPLE_KEY})`,
    // extremes
    "i32min = i32(-2147483648)",
    "i32max = i32(2147483647)",
    "i32min < i32(-2147483647)",
    "i32max > i32(2147483646)",
    "zero = 0",
    "u64zero = u64(0)",
    `u64max = u64(${U64_MAX})`,
    `u64max > u64(${U64_MAX - 1n})`,
    `u64max = u64(0x${U64_MAX.toString(16)})`,
    "u64mid >= u64(1099511627776)",
    "u256zero = u256(0)",
    `u256max = u256(${HUGE_U256})`,
    `u256max >= u256(1)`,
    `u256mid = u256(0x${(1n << 128n).toString(16)})`,
    // decimals
    "d1 = dec(0)",
    "d2 = dec(-123456789.123456789012345678)",
    "d2 < dec(-123456789)",
    "d3 = dec(0.5)",
    "d3 >= dec(0.5)",
    "d3 = dec(0.50)",
    "d4 = dec(1000000)",
    "d4 = dec(1000000.000)",
    "d5 = dec(99999999999999999999.999999999999999999)",
    "d5 > dec(99999999999999999999)",
    // strings
    `s_unicode = str('${UNICODE}')`,
    "s_unicode STARTSWITH str('zażó')",
    "s_unicode STARTSWITH str('zaż')",
    "s_quote = str('it''s')",
    "s_quote STARTSWITH str('it''')",
    "s_empty = str('')",
    "s_empty STARTSWITH str('')",
    `s_max = str('${MAX_STR}')`,
    `s_max STARTSWITH str('${"a".repeat(127)}')`,
    "s_prefix STARTSWITH str('prefix-')",
    "s_prefix STARTSWITH str('prefix-match-me-not')",
    "s_upper STARTSWITH str('prefix-')",
    "s_upper STARTSWITH str('Prefix-')",
    // bools
    "flag = false",
    "flag = true",
    "NOT flag = true",
    "NOT flag = false",
    // order
    "seq >= i32(2)",
    "seq = 1 OR seq = 3",
    "seq > 0",
    "NOT seq = 2 AND seq > 0",
    // mutations
    "added = str('new')",
    "n = i32(3)",
    "n = i32(2)",
    "n = i32(1)",
    "keep = str('k')",
    "gone = str('bye')",
    "hijacked = true",
    "x = i32(1)",
    "v = u64(5)",
    "v = i32(5)",
    "gone = str('x')",
    "stay = i32(1)",
    "p = i32(1)",
    "$contentType = 'application/json'",
    "$contentType = 'text/plain'",
    "e = i32(1)",
    "t = i32(2)",
    "t = i32(1)",
    `by = addr(${addressB})`,
    `$owner = addr(${B})`,
    `$owner = addr(${A})`,
    `$owner = '${B}'`,
    `$creator = addr(${A}) AND $owner = addr(${B})`,
    `$creator = addr(${B})`,
    "case = str('delete-target')",
    "del = i32(1)",
    "case = str('short-lived')",
    "ttl = i32(" + SHORT_BLOCKS + ")",
    `$expiresAt <= u64(${shortExpiry})`,
    `$expiresAt = u64(${shortExpiry})`,
    `$expiresAt = u64(${Number(head + 5_000n)})`,
    "abs = i32(1)",
    "ro = i32(1)",
    "pe = i32(1)",
    "bf = i32(1)",
    "j = i32(1)",
    `case = str('types-all') OR case = str('order-2')`,
    `(case = str('order-1') OR case = str('order-2')) AND NOT seq = 1`,
    `$createdAt >= u64(${startBlock}) AND $createdAt <= u64(${headAfter})`,
    `$createdAt = u64(${txs[0]!.block})`,
  ];

  const manifest = {
    suite: SUITE,
    run: RUN,
    chainId,
    rpc: RPC_URL,
    wallets: { a: addressA, b: addressB },
    startBlock: Number(startBlock),
    headAfter,
    shortLivedExpiresAt: shortExpiry,
    entities,
    txs,
    checkpoints: [...checkpoints].sort((a, b) => a - b),
    queries,
  };
  writeFileSync(args.out!, JSON.stringify(manifest, null, 2));
  console.log(`\nmanifest written to ${args.out} (${Object.keys(entities).length} entities, ${txs.length} transactions, ${checkpoints.size} checkpoints, ${queries.length} queries)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
