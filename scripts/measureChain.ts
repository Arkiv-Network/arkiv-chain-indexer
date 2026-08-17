#!/usr/bin/env bun
/**
 * Samples recent blocks straight from the RPC and reports how full they are.
 *
 * The indexer cannot answer this during a load test while it is still chewing
 * through a backlog — it reports whatever old range it is currently scanning —
 * so a limits test reads the chain head directly. Uses the rotating key pool,
 * costing a handful of calls per sample.
 */
import { parseArgs } from "node:util";
import { RpcKeyRing, loadRpcKeyPool } from "../src/rpcKeyRing";

interface Block {
  number: string;
  timestamp: string;
  gasUsed: string;
  gasLimit: string;
  transactions: unknown[];
}

async function rpc(url: string, ring: RpcKeyRing, method: string, params: unknown[]) {
  const key = ring.next();
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  if (key) ring.noteResponse(key, response.status, response.headers, text);
  if (!response.ok) throw new Error(`${method} -> HTTP ${response.status}: ${text.slice(0, 160)}`);
  const body = JSON.parse(text) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`${method} -> ${body.error.message}`);
  return body.result;
}

async function main() {
  const { values } = parseArgs({
    options: { blocks: { type: "string", default: "20" }, url: { type: "string" } },
  });

  const url = (
    values.url ||
    process.env.MEASURE_RPC_URL ||
    "https://rpc.cheesecake.db-chain.devnet.gobas.me"
  ).replace(/\/+$/, "");
  const keys = await loadRpcKeyPool({ RPC_KEY_POOL_FILE: "rpc-keys/keys.json" });
  const ring = new RpcKeyRing({ keys, log: () => {} });

  const head = Number(BigInt((await rpc(url, ring, "eth_blockNumber", [])) as string));
  const count = Number(values.blocks);
  const numbers = Array.from({ length: count }, (_, i) => head - (count - 1) + i);

  const blocks: Block[] = [];
  for (const number of numbers) {
    const block = (await rpc(url, ring, "eth_getBlockByNumber", [
      `0x${number.toString(16)}`,
      false,
    ])) as Block | null;
    if (block) blocks.push(block);
  }

  const txCounts = blocks.map((b) => b.transactions.length);
  const gasUsed = blocks.map((b) => Number(BigInt(b.gasUsed)));
  const gasLimit = Number(BigInt(blocks[0]?.gasLimit ?? "0x0"));
  const totalTx = txCounts.reduce((a, b) => a + b, 0);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  const spanSeconds =
    Number(BigInt(blocks.at(-1)?.timestamp ?? "0x0")) - Number(BigInt(blocks[0]?.timestamp ?? "0x0"));

  console.log(`head ${head}, sampled ${blocks.length} blocks over ${spanSeconds}s`);
  console.log(`  tx/block   avg ${avg(txCounts).toFixed(2)}  max ${Math.max(...txCounts)}  total ${totalTx}`);
  console.log(
    `  gas/block  avg ${(avg(gasUsed) / 1e6).toFixed(2)}M  max ${(Math.max(...gasUsed) / 1e6).toFixed(2)}M` +
      `  limit ${(gasLimit / 1e6).toFixed(0)}M  (${((avg(gasUsed) / gasLimit) * 100).toFixed(1)}% full)`,
  );
  console.log(`  throughput ${spanSeconds > 0 ? (totalTx / spanSeconds).toFixed(2) : "n/a"} tx/s`);
  const stats = ring.stats();
  console.log(`  keys: ${stats.usable}/${stats.total} usable, ${stats.exhausted} exhausted`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
