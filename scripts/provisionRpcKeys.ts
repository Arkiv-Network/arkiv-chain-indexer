#!/usr/bin/env bun
/**
 * Mints a pool of bouncer API keys on a db-chain network and writes them to a
 * pool file that the scanner and the Baseload load agents rotate over.
 *
 * The bouncer's control-service takes a caller-supplied key value
 * (`PUT /keys/{key}` with `{active, quota, origins[], ipwl[]}`), so the keys are
 * generated here and registered one by one. This is the per-network path: the
 * Arkiv Hub generator (api-key-generator) mints Hub keys, which a db-chain
 * bouncer answers with 401 because it keeps its own key store.
 *
 * Usage:
 *   RPC_CONTROL_URL=https://rpc-control.<net>.db-chain.devnet.gobas.me \
 *   RPC_CONTROL_ADMIN_TOKEN=<bouncer ADMIN_AUTH_TOKEN> \
 *   bun run scripts/provisionRpcKeys.ts --count 100 --quota 100000000 \
 *     --out rpc-keys/keys.json
 *
 * Re-running with the same --out merges: existing keys are kept and re-upserted
 * (so a quota bump applies to the whole pool), and only the shortfall is minted.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { maskRpcKey, parseRpcKeyPoolFile } from "../src/rpcKeyRing";

const KEY_PREFIX = "ark_live_";
/** Matches the length of the keys the Hub issues, for consistency in logs. */
const KEY_BODY_LENGTH = 32;

interface PoolFile {
  network: string;
  quota: number;
  updatedAt: string;
  keys: string[];
}

function generateKey(): string {
  // base64url over raw bytes, trimmed to the target length: url-safe, so the key
  // also works as the last URL path segment.
  const body = randomBytes(KEY_BODY_LENGTH)
    .toString("base64url")
    .slice(0, KEY_BODY_LENGTH);
  return `${KEY_PREFIX}${body}`;
}

async function upsertKey(
  controlUrl: string,
  token: string,
  key: string,
  quota: number,
): Promise<void> {
  const response = await fetch(`${controlUrl}/keys/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ active: true, quota, origins: [], ipwl: [] }),
  });
  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(
      `PUT /keys/${maskRpcKey(key)} failed with HTTP ${response.status}${body ? `: ${body}` : ""}`,
    );
  }
}

async function readQuota(controlUrl: string, token: string, key: string) {
  const response = await fetch(`${controlUrl}/quota/${encodeURIComponent(key)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as
    | { limit?: number; used?: number; remaining?: number; used_percent?: number }
    | null;
}

/**
 * Mints one key through an api-key-generator instance. These are Arkiv Hub keys,
 * and a db-chain bouncer accepts them: its control-service projects the Hub's
 * Postgres, so a Hub-issued key is live on the devnet edge too (verified against
 * rpc.cheesecake…). This is the path that needs no admin token.
 */
async function mintViaGenerator(serviceUrl: string, name: string): Promise<string> {
  const response = await fetch(`${serviceUrl}/keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(`generator answered HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  const key = (JSON.parse(text) as { key?: unknown }).key;
  if (typeof key !== "string" || !key) throw new Error(`generator returned no key: ${text.slice(0, 200)}`);
  return key;
}

async function main() {
  const { values } = parseArgs({
    options: {
      count: { type: "string", default: "100" },
      quota: { type: "string", default: "100000000" },
      out: { type: "string", default: "rpc-keys/keys.json" },
      /**
       * "generator" mints Hub keys through api-key-generator (no admin token,
       * fixed 1M monthly quota per key). "control" registers self-generated keys
       * through the bouncer control-service, which is what lets you choose the
       * quota — but it needs RPC_CONTROL_ADMIN_TOKEN.
       */
      source: { type: "string", default: "generator" },
      concurrency: { type: "string", default: "4" },
      "dry-run": { type: "boolean", default: false },
      verify: { type: "boolean", default: false },
    },
  });

  const source = String(values.source);
  if (source !== "generator" && source !== "control") {
    throw new Error("--source must be 'generator' or 'control'");
  }

  if (source === "generator") {
    return provisionViaGenerator(values);
  }

  const controlUrl = process.env.RPC_CONTROL_URL?.trim().replace(/\/+$/, "");
  const token = process.env.RPC_CONTROL_ADMIN_TOKEN?.trim();
  if (!controlUrl) throw new Error("RPC_CONTROL_URL is required");
  if (!token && !values["dry-run"]) throw new Error("RPC_CONTROL_ADMIN_TOKEN is required");

  const count = Number(values.count);
  const quota = Number(values.quota);
  if (!Number.isInteger(count) || count <= 0) throw new Error("--count must be a positive integer");
  if (!Number.isInteger(quota) || quota <= 0) throw new Error("--quota must be a positive integer");

  const outPath = String(values.out);
  let existing: string[] = [];
  try {
    existing = parseRpcKeyPoolFile(await readFile(outPath, "utf8"));
    console.log(`Found ${existing.length} existing keys in ${outPath}`);
  } catch {
    // No pool file yet; mint the whole set.
  }

  const keys = [...existing];
  while (keys.length < count) keys.push(generateKey());
  const minted = keys.length - existing.length;

  if (values["dry-run"]) {
    console.log(`Dry run: would upsert ${keys.length} keys (${minted} new) at quota ${quota}`);
    return;
  }

  let done = 0;
  for (const key of keys) {
    await upsertKey(controlUrl, token!, key, quota);
    done += 1;
    if (done % 10 === 0 || done === keys.length) {
      console.log(`  upserted ${done}/${keys.length}`);
    }
  }

  const pool: PoolFile = {
    network: controlUrl,
    quota,
    updatedAt: new Date().toISOString(),
    keys,
  };
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(pool, null, 2)}\n`, "utf8");

  console.log(
    `Wrote ${keys.length} keys (${minted} newly minted) to ${outPath} at quota ${quota} each ` +
      `(pool total ${(keys.length * quota).toLocaleString()} cost units/month)`,
  );

  if (values.verify) {
    const sample = keys.slice(0, 3);
    for (const key of sample) {
      const quotaInfo = await readQuota(controlUrl, token!, key);
      console.log(`  ${maskRpcKey(key)} -> ${quotaInfo ? JSON.stringify(quotaInfo) : "no quota read"}`);
    }
  }
}

/**
 * Mints the shortfall through the generator, a few at a time. The generator
 * shares one browser across requests, so this stays modest rather than firing
 * all 100 at once.
 */
async function provisionViaGenerator(values: Record<string, unknown>) {
  const serviceUrl = (process.env.RPC_KEY_SERVICE_URL?.trim() || "http://127.0.0.1:18787").replace(
    /\/+$/,
    "",
  );
  const count = Number(values.count);
  const concurrency = Math.max(1, Number(values.concurrency) || 1);
  const outPath = String(values.out);

  let keys: string[] = [];
  try {
    keys = parseRpcKeyPoolFile(await readFile(outPath, "utf8"));
    console.log(`Found ${keys.length} existing keys in ${outPath}`);
  } catch {
    // No pool file yet.
  }

  const wanted = count - keys.length;
  if (values["dry-run"]) {
    console.log(`Dry run: would mint ${Math.max(0, wanted)} keys via ${serviceUrl}`);
    return;
  }
  if (wanted <= 0) {
    console.log(`Pool already holds ${keys.length} keys; nothing to mint.`);
    return;
  }

  console.log(`Minting ${wanted} keys via ${serviceUrl} (concurrency ${concurrency})…`);
  const failures: string[] = [];
  let issued = 0;
  const startedAtMs = Date.now();

  const workers = Array.from({ length: concurrency }, async () => {
    while (issued < wanted) {
      const index = keys.length + issued;
      issued += 1;
      try {
        keys.push(await mintViaGenerator(serviceUrl, `baseload_pool_${index}`));
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
      if (keys.length % 10 === 0) console.log(`  ${keys.length}/${count} keys`);
    }
  });
  await Promise.all(workers);

  const pool = {
    source: serviceUrl,
    quota: 1_000_000,
    updatedAt: new Date().toISOString(),
    keys,
  };
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(pool, null, 2)}\n`, "utf8");

  const elapsedSeconds = Math.round((Date.now() - startedAtMs) / 1000);
  console.log(
    `Wrote ${keys.length} keys to ${outPath} in ${elapsedSeconds}s ` +
      `(pool total ~${(keys.length * 1_000_000).toLocaleString()} cost units/month` +
      `, ~${(keys.length * 100_000).toLocaleString()} requests at 10 units each)`,
  );
  if (failures.length) {
    console.warn(`${failures.length} mints failed; first: ${failures[0]}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
