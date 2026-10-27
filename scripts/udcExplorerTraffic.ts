#!/usr/bin/env bun
/**
 * Explorer e2e traffic for the UDC devnet (scripts/udc-devnet.py, docs/udc-e2e.md).
 *
 * Writes, through the UDC SDK (0.9.0-next), what the explorer must index
 * correctly, asserts each result against the node, and writes a manifest
 * (tx hashes, entity keys, expected states, bytes markers) for
 * verifyUdcExplorer.ts:
 *
 *   - failures sent with an explicit gas limit, so no estimate refuses them
 *     first: readonly patch, non-owner transfer / patch / delete,
 *     PermanenceOwnerOnly, missing entity, shortened expiry, transfer to self,
 *     an atomic batch with one bad op, out of gas, rent the sender cannot
 *     afford, a patch of an expired entity. Each is recorded as mined with
 *     status 0 or refused at admission, whichever the node did;
 *   - index toggle and retype by patch; a 32-attribute create; unicode,
 *     negative dec, u256 max, i32 min, case-sensitive names;
 *   - expiry, delete, finite → permanent, transfer of a permanent entity,
 *     a permissionless extension by a non-owner, a mixed batch, GLM transfers.
 *
 * It needs @arkiv-network/sdk 0.9.0-next.* and viem resolvable from its own
 * directory (the e2e runner copies it next to a node_modules that links them).
 *
 *   bun udcExplorerTraffic.ts --devnet <run>/devnet.json --out manifest.json
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { addr, bool, bytes, bytes32, dec, defineSchema, i32, key, str, u256, u64 } from "@arkiv-network/sdk/schema";
import { bytesToHex, type Hex, http, keccak256, parseEther, stringToBytes, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  canonicalEntity,
  type CanonicalEntity,
  type EntityExpectation,
  expectationDiffs,
  type ExpectedAttribute,
  FULL_SELECT,
  type Manifest,
  type ManifestFailure,
  type ManifestTx,
  PERMANENT,
  PERMANENT_TEXT,
  queryAll,
  rpcCall,
} from "./udcE2eModel";

const { values: args } = parseArgs({
  options: {
    devnet: { type: "string" },
    out: { type: "string" },
    "expiry-blocks": { type: "string", default: "40" },
    "gas-limit": { type: "string", default: "3000000" },
  },
});
if (!args.devnet || !args.out) {
  console.error("usage: bun udcExplorerTraffic.ts --devnet <run>/devnet.json --out manifest.json");
  process.exit(2);
}
const devnet = JSON.parse(readFileSync(args.devnet, "utf8"));
const secrets = JSON.parse(readFileSync(devnet.secretsFile, "utf8"));
const url: string = devnet.rpcUrl;
const EXPIRY_BLOCKS = Number(args["expiry-blocks"]);
const GAS = BigInt(args["gas-limit"]!);

const chain = {
  id: devnet.chainId as number,
  name: "UDC e2e",
  nativeCurrency: { name: "GLM", symbol: "GLM", decimals: 18 },
  rpcUrls: { default: { http: [url] } },
};
const transport = http(url, { retryCount: 0, timeout: 30_000 });
const read = createPublicClient({ chain, transport, pollingInterval: 100 });
const accountA = privateKeyToAccount(secrets.accounts.trafficA.privateKey as Hex);
const accountB = privateKeyToAccount(secrets.accounts.trafficB.privateKey as Hex);
const wallet = (account: ReturnType<typeof privateKeyToAccount>) =>
  createWalletClient({ chain, transport, account, pollingInterval: 100 }) as any;
const A = wallet(accountA);
const B = wallet(accountB);
const addrA = accountA.address.toLowerCase() as Hex;
const addrB = accountB.address.toLowerCase() as Hex;

const runNonce = toHex(crypto.getRandomValues(new Uint8Array(8))).slice(2);
const manifest: Manifest = {
  version: 1,
  generatedAt: new Date().toISOString(),
  chainId: chain.id,
  rpcUrl: url,
  genesisHash: devnet.genesisHash ?? null,
  accounts: { trafficA: addrA, trafficB: addrB },
  checkpoints: { start: 0, mid: 0, afterExpiry: 0, end: 0 },
  transactions: [],
  failures: [],
  entities: [],
  absentQueries: [],
  bytesMarkers: [],
};

const step = (message: string) => console.log("ok:", message);
const head = async () => Number(await read.getBlockNumber());
const nonceOf = async (who: Hex) => BigInt(await rpcCall(url, "eth_getTransactionCount", [who, "latest"]));
const receiptOf = (hash: Hex) => read.waitForTransactionReceipt({ hash, timeout: 60_000 }) as Promise<any>;

/** Distinctive bytes contents; the Postgres dump must never contain them. */
function marker(label: string, size = 96): Uint8Array {
  const text = `udc-e2e-bytes:${label}:${runNonce}:`;
  const body = new Uint8Array(size);
  body.set(stringToBytes(text).slice(0, size));
  for (let i = text.length; i < size; i++) body[i] = 0x41 + (i % 26);
  manifest.bytesMarkers.push({ label, text, hex: bytesToHex(stringToBytes(text)) });
  return body;
}

async function record(label: string, hash: Hex, ops: string[], expectStatus: ManifestTx["expectStatus"] = "success") {
  const receipt = await receiptOf(hash);
  const status = receipt.status === "success" ? "success" : "reverted";
  assert.equal(status, expectStatus, `${label}: status ${status}`);
  const tx: ManifestTx = {
    label,
    hash,
    from: receipt.from.toLowerCase(),
    to: receipt.to?.toLowerCase() ?? null,
    kind: ops.length ? "execute" : "transfer",
    expectStatus,
    ops,
    block: Number(receipt.blockNumber),
    gasUsed: BigInt(receipt.gasUsed).toString(),
    rentFee: BigInt(receipt.rentFee ?? 0).toString(),
  };
  manifest.transactions.push(tx);
  return tx;
}

/** The entity at the head (or `atBlock`), canonical, or undefined when not live. */
async function entityAt(entityKey: Hex, atBlock?: number): Promise<CanonicalEntity | undefined> {
  const block = atBlock ?? (await head());
  const [found] = await queryAll(url, `$key = key(${entityKey})`, block, FULL_SELECT);
  return found ? canonicalEntity(found) : undefined;
}

const short = (error: any): string => {
  const parts: string[] = [];
  for (let e = error; e && parts.length < 6; e = e.cause) {
    for (const part of [e.shortMessage, e.details, e.name === "EntityMutationError" ? e.message : undefined]) {
      if (typeof part === "string" && part && !parts.includes(part)) parts.push(part.split("\n")[0]!.slice(0, 240));
    }
  }
  return parts.join(" | ") || String(error?.message ?? error).split("\n")[0]!.slice(0, 240);
};

const txHashOf = (error: any): Hex | null => {
  for (let e = error; e; e = e.cause) if (typeof e.txHash === "string") return e.txHash as Hex;
  return null;
};

/**
 * Sends something that must fail, and records whether the node mined it with
 * status 0 or refused it at admission.
 */
async function failure(
  name: string,
  expectedError: string,
  sender: Hex,
  ops: string[],
  send: () => Promise<unknown>,
  gasLimit: bigint | null = GAS,
): Promise<ManifestFailure> {
  const before = await nonceOf(sender);
  let entry: ManifestFailure;
  try {
    await send();
    entry = { case: name, expectedError, gasLimit: gasLimit?.toString() ?? null, outcome: "unexpected-success", hash: null, reason: "", nonceAdvanced: true };
  } catch (error) {
    const hash = txHashOf(error);
    const reason = short(error);
    const nonceAdvanced = (await nonceOf(sender)) > before;
    if (hash) {
      const tx = await record(`fail:${name}`, hash, ops, "reverted");
      assert.equal(tx.rentFee, "0", `${name}: a reverted tx pays no rent`);
      assert.ok(BigInt(tx.gasUsed) > 0n, `${name}: a reverted tx is charged gas`);
    }
    entry = { case: name, expectedError, gasLimit: gasLimit?.toString() ?? null, outcome: hash ? "mined-status-0" : "refused-at-admission", hash, reason, nonceAdvanced };
    assert.equal(nonceAdvanced, hash !== null, `${name}: nonce advanced iff mined (${reason})`);
  }
  manifest.failures.push(entry);
  step(`failure ${name}: ${entry.outcome}${entry.reason ? ` (${entry.reason.slice(0, 160)})` : ""}`);
  return entry;
}

/** Records the node's current state of an entity as its expected final state. */
function expectLive(label: string, entity: CanonicalEntity) {
  const attributes: Record<string, ExpectedAttribute> = {};
  for (const a of entity.attributes) {
    const { name, indexedKnown: _known, ...rest } = a;
    attributes[name] = rest;
  }
  manifest.entities.push({
    label,
    key: entity.key,
    expect: {
      exists: true,
      owner: entity.owner,
      creator: entity.creator,
      expiresAt: entity.expiresAt,
      permanent: entity.permanent,
      creationFlags: entity.creationFlags,
      attributes,
    },
  });
}

function expectAbsent(label: string, entityKey: Hex, why: "expired" | "deleted" | "never-created", expiresAt?: bigint) {
  const expect: EntityExpectation = { exists: false, why };
  if (expiresAt !== undefined) expect.expiresAt = expiresAt.toString();
  manifest.entities.push({ label, key: entityKey.toLowerCase() as Hex, expect });
}

const attr = (entity: CanonicalEntity | undefined, name: string) => entity?.attributes.find((a) => a.name === name);
const fewBlocks = ExpirationTime.fromBlocks(5000);

// ---------------------------------------------------------------------------

manifest.checkpoints.start = await head();
const balanceA = await read.getBalance({ address: addrA });
assert.ok(balanceA > parseEther("10"), "trafficA is funded at genesis");

// Plain GLM transfers, both directions.
{
  const hash = await A.sendTransaction({ to: addrB, value: parseEther("1.5") });
  const tx = await record("glm-transfer-a-to-b", hash, []);
  assert.equal(tx.rentFee, "0");
  const back = await B.sendTransaction({ to: addrA, value: parseEther("0.25") });
  await record("glm-transfer-b-to-a", back, []);
  step("plain GLM transfers A→B and B→A, no rent");
}

// Expiry: a short-lived entity, created first so it expires during the run.
const Ephemeral = defineSchema("ephemeral", { tag: str().indexed(), body: bytes() });
const expiring = await A.createEntity(
  Ephemeral,
  { tag: `expiring-${runNonce}`, body: marker("expiring") },
  { expiration: ExpirationTime.fromBlocks(EXPIRY_BLOCKS) },
);
await record("create-expiring", expiring.txHash, ["create"]);
const expiringAt = BigInt(expiring.expiresAt);
step(`short-lived entity expires at block ${expiringAt}`);

// Index toggle and retype: the patch's triples carry the new types and flags.
const ToggleV1 = defineSchema("toggle", {
  color: str().indexed(),
  size: u64().indexed(),
  note: str(),
  body: bytes(),
});
const ToggleV2 = defineSchema("toggle", {
  color: str(),
  size: dec().indexed(),
  note: str().indexed(),
});
const toggle = await A.createEntity(
  ToggleV1,
  { color: `red-${runNonce}`, size: u64(3n), note: `plain-${runNonce}`, body: marker("toggle") },
  { expiration: fewBlocks },
);
await record("create-toggle", toggle.txHash, ["create"]);
const findBy = async (query: string) => (await queryAll(url, query, await head(), { key: true })).map((e) => e.key);
assert.deepEqual(await findBy(`color = str('red-${runNonce}')`), [toggle.entityKey]);
assert.deepEqual(await findBy(`note = str('plain-${runNonce}')`), []);
const toggled = await A.patchEntity(ToggleV2, toggle.entityKey, {
  set: { color: `red-${runNonce}`, size: dec("3.5"), note: `plain-${runNonce}` },
});
await record("patch-toggle-retype", toggled.txHash, ["patch"]);
{
  const now = await entityAt(toggle.entityKey);
  assert.deepEqual(
    ["color", "size", "note"].map((n) => [attr(now, n)?.type, attr(now, n)?.indexed]),
    [["str", false], ["dec", true], ["str", true]],
  );
  assert.equal(attr(now, "size")?.value, "3.5");
  assert.deepEqual(await findBy(`color = str('red-${runNonce}')`), []);
  assert.deepEqual(await findBy(`note = str('plain-${runNonce}')`), [toggle.entityKey]);
  step("patch unindexes color, indexes note, retypes size u64 → dec; predicates follow");
}

// A 32-attribute create (unnamed schema: no arkiv.schema tag), every type.
const TYPES = ["bool", "i32", "u64", "u256", "dec", "bytes32", "bytes", "str", "addr", "key"] as const;
const columns: Record<string, any> = {};
const values: Record<string, any> = {};
for (let i = 0; i < 32; i++) {
  const type = TYPES[i % TYPES.length]!;
  const name = `c${String(i).padStart(2, "0")}_${type}`;
  const indexed = type !== "bytes" && i % 3 !== 2;
  const make = { bool, i32, u64, u256, dec, bytes32, bytes, str, addr, key }[type] as any;
  columns[name] = indexed ? make().indexed() : make();
  values[name] = {
    bool: () => bool(i % 2 === 0),
    i32: () => i32(-i * 1000),
    u64: () => u64(BigInt(i) * 10n ** 15n),
    u256: () => u256(2n ** BigInt(100 + i)),
    dec: () => dec(`${i}.${i}5`),
    bytes32: () => bytes32(keccak256(stringToBytes(`b32-${i}`))),
    bytes: () => marker(`wide-${i}`, 40),
    str: () => `s${i}-${runNonce}`,
    addr: () => addr(i % 2 ? addrA : addrB),
    key: () => key(keccak256(stringToBytes(`k-${i}`))),
  }[type]();
}
const Wide = defineSchema(columns);
const wide = await A.createEntity(Wide, values as any, { expiration: fewBlocks });
await record("create-32-attributes", wide.txHash, ["create"]);
assert.equal((await entityAt(wide.entityKey))?.attributes.length, 32);
step("32-attribute create, every type, indexed and stored mixed");

// Edge values and case-sensitive names.
const Edge = defineSchema("edge", {
  text: str().indexed(),
  stored: str(),
  negative: dec().indexed(),
  max: u256().indexed(),
  min: i32().indexed(),
  Name: str().indexed(),
  name: str().indexed(),
  body: bytes(),
});
const unicode = `zażółć gęślą jaźń — 日本語 🚀 ${runNonce}`;
const edge = await A.createEntity(
  Edge,
  {
    text: unicode,
    stored: `ünïcödé stored ${runNonce} with "quotes" and 'single'`,
    negative: dec("-12345.678900"),
    max: u256(2n ** 256n - 1n),
    min: i32(-(2 ** 31)),
    Name: `Upper-${runNonce}`,
    name: `lower-${runNonce}`,
    body: marker("edge"),
  },
  { expiration: fewBlocks },
);
await record("create-edge-values", edge.txHash, ["create"]);
{
  const now = await entityAt(edge.entityKey);
  assert.equal(attr(now, "text")?.value, unicode);
  assert.equal(attr(now, "max")?.value, (2n ** 256n - 1n).toString());
  assert.equal(attr(now, "min")?.value, String(-(2 ** 31)));
  assert.ok(attr(now, "negative")?.value?.startsWith("-12345.6789"), attr(now, "negative")?.value);
  assert.notEqual(attr(now, "Name")?.value, attr(now, "name")?.value);
  assert.deepEqual(await findBy(`text = str('${unicode}')`), [edge.entityKey]);
  step(`unicode, negative dec (${attr(now, "negative")?.value}), u256 max, i32 min, Name ≠ name`);
}

// Creation-flag entities and the failures that need them.
const Probe = defineSchema("probe", { purpose: str().indexed(), body: bytes().optional() });
const readonly = await A.createEntity(
  Probe,
  { purpose: `readonly-${runNonce}`, body: marker("readonly") },
  { expiration: fewBlocks, flags: { readonly: true } },
);
await record("create-readonly", readonly.txHash, ["create"]);
const open = await A.createEntity(
  Probe,
  { purpose: `permissionless-${runNonce}` },
  { expiration: fewBlocks, flags: { permissionlessExtension: true } },
);
await record("create-permissionless", open.txHash, ["create"]);
const target = await A.createEntity(Probe, { purpose: `owned-${runNonce}` }, { expiration: fewBlocks });
await record("create-owned", target.txHash, ["create"]);

manifest.checkpoints.mid = await head();

await failure("readonly-patch", "ReadOnlyEntity", addrA, ["patch"], () =>
  A.patchEntity(Probe, readonly.entityKey, { set: { purpose: "changed" } }, { gas: GAS }),
);
await failure("non-owner-transfer", "NotOwner", addrB, ["transfer"], () =>
  B.changeOwnership({ entityKey: target.entityKey, newOwner: addrB }, { gas: GAS }),
);
await failure("non-owner-patch", "NotOwner", addrB, ["patch"], () =>
  B.patchEntity(Probe, target.entityKey, { set: { purpose: "hijacked" } }, { gas: GAS }),
);
await failure("non-owner-delete", "NotOwner", addrB, ["delete"], () =>
  B.deleteEntity({ entityKey: target.entityKey }, { gas: GAS }),
);
await failure("permanence-owner-only", "PermanenceOwnerOnly", addrB, ["extend"], () =>
  B.extendEntity({ entityKey: open.entityKey, expiration: ExpirationTime.permanent() }, { gas: GAS }),
);
const missing = keccak256(stringToBytes(`missing-${runNonce}`));
await failure("missing-entity-patch", "EntityNotFound", addrA, ["patch"], () =>
  A.patchEntity(Probe, missing, { set: { purpose: "ghost" } }, { gas: GAS }),
);
await failure("shortened-expiry", "ExpiryNotExtended", addrA, ["extend"], () =>
  A.extendEntity({ entityKey: target.entityKey, expiration: ExpirationTime.fromBlocks(50) }, { gas: GAS }),
);
await failure("transfer-to-self", "TransferToSelf", addrA, ["transfer"], () =>
  A.changeOwnership({ entityKey: target.entityKey, newOwner: addrA }, { gas: GAS }),
);
await failure("atomic-batch", "ReadOnlyEntity (second op)", addrA, ["create", "patch"], () =>
  A.executeBatch(
    {
      creates: [{ schema: Probe, values: { purpose: `atomic-${runNonce}` }, expiration: fewBlocks }],
      patches: [{ schema: Probe, entityKey: readonly.entityKey, set: { purpose: "changed" } }],
    },
    { gas: GAS },
  ),
);
manifest.absentQueries.push({
  query: `purpose = str('atomic-${runNonce}')`,
  reason: "the create in a reverted batch must not apply",
});
{
  // Out of gas during execution: enough for admission, not for the create.
  await failure(
    "out-of-gas",
    "out of gas",
    addrA,
    ["create"],
    () =>
      A.createEntity(Probe, { purpose: `oog-${runNonce}`, body: marker("oog", 2048) }, { expiration: fewBlocks }, { gas: 60_000n }),
    60_000n,
  );
  manifest.absentQueries.push({ query: `purpose = str('oog-${runNonce}')`, reason: "an out-of-gas create must not apply" });
}
// Gas but not rent: a fresh key funded with 0.01 GLM tries a permanent 128 KiB create.
{
  const poorKey = generatePrivateKey();
  const poor = wallet(privateKeyToAccount(poorKey));
  const poorAddress = privateKeyToAccount(poorKey).address.toLowerCase() as Hex;
  const fund = await A.sendTransaction({ to: poorAddress, value: parseEther("0.01") });
  await record("glm-fund-poor-sender", fund, []);
  const Blob = defineSchema("blob", { body: bytes() });
  await failure("rent-unaffordable", "insufficient funds for gas * price + value + rent", poorAddress, ["create"], () =>
    poor.createEntity(Blob, { body: new Uint8Array(128 * 1024).fill(0x5a) }, { expiration: ExpirationTime.permanent() }, { gas: GAS }),
  );
}
{
  const now = await entityAt(target.entityKey);
  assert.equal(now?.owner, addrA);
  assert.equal(attr(now, "purpose")?.value, `owned-${runNonce}`);
  assert.equal(attr(await entityAt(readonly.entityKey), "purpose")?.value, `readonly-${runNonce}`);
  assert.deepEqual(await findBy(`purpose = str('atomic-${runNonce}')`), []);
  step("no failed transaction changed any state");
}

// A permissionless extension by a non-owner (B pays the rent), within the cap.
{
  const farther = await B.extendEntity({ entityKey: open.entityKey, expiration: ExpirationTime.fromBlocks(20_000) });
  const tx = await record("extend-permissionless-by-other", farther.txHash, ["extend"]);
  assert.equal(tx.from, addrB);
  assert.ok(BigInt(tx.rentFee) > 0n, "extension rent is charged to the extender");
  step(`B extends A's permissionless entity, paying ${tx.rentFee} wei rent`);
}

// Delete.
const doomed = await A.createEntity(Probe, { purpose: `doomed-${runNonce}`, body: marker("doomed") }, { expiration: fewBlocks });
await record("create-doomed", doomed.txHash, ["create"]);
const deleted = await A.deleteEntity({ entityKey: doomed.entityKey });
const deleteTx = await record("delete-doomed", deleted.txHash, ["delete"]);
assert.equal(deleteTx.rentFee, "0");
assert.equal(await entityAt(doomed.entityKey), undefined);
expectAbsent("doomed", doomed.entityKey, "deleted");
step("create then delete; delete pays no rent");

// Finite → permanent.
const finite = await A.createEntity(Probe, { purpose: `finite-${runNonce}` }, { expiration: fewBlocks });
await record("create-finite", finite.txHash, ["create"]);
const forever = await A.extendEntity({ entityKey: finite.entityKey, expiration: ExpirationTime.permanent() });
await record("extend-finite-to-permanent", forever.txHash, ["extend"]);
assert.equal(BigInt(forever.expiresAt), PERMANENT);
assert.equal((await entityAt(finite.entityKey))?.expiresAt, PERMANENT_TEXT);
step("finite entity extended to permanent (2^64 - 1)");

// A permanent entity, handed to B, then patched by its new owner.
const heirloom = await A.createEntity(
  Probe,
  { purpose: `heirloom-${runNonce}`, body: marker("heirloom") },
  { expiration: ExpirationTime.permanent() },
);
const heirloomTx = await record("create-permanent", heirloom.txHash, ["create"]);
assert.ok(BigInt(heirloomTx.rentFee) > 0n, "a permanent create pays the capped rent");
const handed = await A.changeOwnership({ entityKey: heirloom.entityKey, newOwner: addrB });
const handTx = await record("transfer-permanent", handed.txHash, ["transfer"]);
assert.equal(handTx.rentFee, "0");
const kept = await B.patchEntity(Probe, heirloom.entityKey, { set: { purpose: `heirloom-kept-${runNonce}` } });
await record("patch-permanent-by-new-owner", kept.txHash, ["patch"]);
{
  const now = await entityAt(heirloom.entityKey);
  assert.equal(now?.owner, addrB);
  assert.equal(now?.creator, addrA);
  assert.equal(now?.permanent, true);
  step("permanent entity transferred A → B and patched by B; creator stays A");
}

// A mixed batch: two creates, a patch, a delete and an extension in one tx (shared rent).
{
  const pre = await A.createEntity(Probe, { purpose: `batch-patch-${runNonce}` }, { expiration: fewBlocks });
  await record("create-batch-patch-target", pre.txHash, ["create"]);
  const gone = await A.createEntity(Probe, { purpose: `batch-delete-${runNonce}` }, { expiration: fewBlocks });
  await record("create-batch-delete-target", gone.txHash, ["create"]);
  const batch = await A.executeBatch({
    creates: [
      { schema: Probe, values: { purpose: `batch-1-${runNonce}`, body: marker("batch-1") }, expiration: fewBlocks },
      { schema: Probe, values: { purpose: `batch-2-${runNonce}` }, expiration: ExpirationTime.permanent() },
    ],
    patches: [{ schema: Probe, entityKey: pre.entityKey, set: { purpose: `batch-patched-${runNonce}` }, unset: ["body"] }],
    deletes: [{ entityKey: gone.entityKey }],
    extensions: [{ entityKey: pre.entityKey, expiration: ExpirationTime.fromBlocks(9000) }],
  });
  const tx = await record("batch-mixed", batch.txHash, ["create", "create", "patch", "delete", "extend"]);
  assert.equal(batch.createdEntities.length, 2);
  assert.ok(BigInt(tx.rentFee) > 0n);
  expectAbsent("batch-delete-target", gone.entityKey, "deleted");
  for (const [i, created] of batch.createdEntities.entries()) expectLive(`batch-${i + 1}`, (await entityAt(created))!);
  expectLive("batch-patch-target", (await entityAt(pre.entityKey))!);
  step(`mixed batch (2 creates, patch, delete, extend) in one tx, rent ${tx.rentFee} wei`);
}

// Wait for the short-lived entity to expire, then try to patch it.
while ((await head()) < Number(expiringAt)) await Bun.sleep(200);
manifest.checkpoints.afterExpiry = Number(expiringAt);
assert.equal(await entityAt(expiring.entityKey, Number(expiringAt)), undefined);
assert.ok(await entityAt(expiring.entityKey, Number(expiringAt) - 1), "live one block before expiry");
expectAbsent("expiring", expiring.entityKey, "expired", expiringAt);
step(`short-lived entity live at ${expiringAt - 1n}, gone at ${expiringAt}`);
await failure("expired-entity-patch", "EntityExpired", addrA, ["patch"], () =>
  A.patchEntity(Ephemeral, expiring.entityKey, { set: { tag: "late" } }, { gas: GAS }),
);
expectAbsent("missing", missing, "never-created");

// Final expected states, read back from the node.
for (const [label, entityKey] of [
  ["toggle", toggle.entityKey],
  ["wide-32", wide.entityKey],
  ["edge", edge.entityKey],
  ["readonly", readonly.entityKey],
  ["permissionless", open.entityKey],
  ["owned", target.entityKey],
  ["finite-to-permanent", finite.entityKey],
  ["heirloom", heirloom.entityKey],
] as const) {
  const now = await entityAt(entityKey);
  assert.ok(now, `${label} is live`);
  expectLive(label, now!);
}
manifest.checkpoints.end = await head();
for (const entity of manifest.entities) {
  const diffs = expectationDiffs(await entityAt(entity.key, manifest.checkpoints.end), entity.expect);
  assert.deepEqual(diffs, [], `${entity.label}: ${diffs.join("; ")}`);
}

writeFileSync(args.out, JSON.stringify(manifest, null, 2) + "\n");
const mined = manifest.failures.filter((f) => f.outcome === "mined-status-0").map((f) => f.case);
const refused = manifest.failures.filter((f) => f.outcome === "refused-at-admission").map((f) => f.case);
const surprising = manifest.failures.filter((f) => f.outcome === "unexpected-success").map((f) => f.case);
console.log(`mined with status 0: ${mined.join(", ") || "none"}`);
console.log(`refused at admission: ${refused.join(", ") || "none"}`);
if (surprising.length) console.log(`UNEXPECTEDLY SUCCEEDED: ${surprising.join(", ")}`);
console.log(
  `UDC EXPLORER TRAFFIC DONE: ${manifest.transactions.length} txs, ${manifest.entities.length} entities, ` +
    `blocks ${manifest.checkpoints.start}..${manifest.checkpoints.end} → ${args.out}`,
);
process.exit(surprising.length ? 1 : 0);
