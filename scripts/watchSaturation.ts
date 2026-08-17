#!/usr/bin/env bun
/**
 * Watches a running load test and reports whether the chain is staying
 * saturated — and whether it is still healthy.
 *
 * Reads block stats from Postgres (free) rather than the RPC, and probes the RPC
 * only once per tick for liveness. That probe matters more than the throughput
 * numbers: an 80-worker fleet took the execution node down at only ~47% gas
 * utilisation, so "blocks are full" is not on its own evidence of health.
 *
 * Usage: bun run scripts/watchSaturation.ts --interval 60 --ticks 30
 */
import { parseArgs } from "node:util";
import { RpcKeyRing, loadRpcKeyPool } from "../src/rpcKeyRing";

const BACKEND = (process.env.BACKEND_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const RPC = (
  process.env.MEASURE_RPC_URL || "https://rpc.cheesecake.db-chain.devnet.gobas.me"
).replace(/\/+$/, "");

async function probeRpc(ring: RpcKeyRing): Promise<{ ok: boolean; detail: string }> {
  const key = ring.next();
  try {
    const response = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    if (key) ring.noteResponse(key, response.status, response.headers, text);
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status} ${text.slice(0, 90)}` };
    const body = JSON.parse(text) as { result?: string; error?: { message?: string } };
    if (body.error) return { ok: false, detail: body.error.message ?? "rpc error" };
    return { ok: true, detail: `head ${Number(BigInt(body.result!))}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function readWorkers() {
  try {
    const response = await fetch(`${BACKEND}/baseload`, { signal: AbortSignal.timeout(10_000) });
    const state = (await response.json()) as {
      config: { workers: Array<{ id: string }> };
      statuses: Record<string, { status: string; message?: string }>;
      balances: Record<string, { balanceWei: string }>;
    };
    const active = new Set(state.config.workers.map((w) => w.id));
    const counts: Record<string, number> = {};
    for (const [id, st] of Object.entries(state.statuses)) {
      if (!active.has(id)) continue;
      counts[st.status] = (counts[st.status] ?? 0) + 1;
    }
    const balances = Object.entries(state.balances)
      .filter(([id]) => active.has(id))
      .map(([, b]) => Number(BigInt(b.balanceWei) / 10n ** 18n))
      .sort((a, b) => a - b);
    return { counts, minBalance: balances[0] ?? 0, total: active.size };
  } catch {
    return { counts: {}, minBalance: 0, total: 0 };
  }
}

async function readBlocks() {
  const proc = Bun.spawn(
    [
      "docker", "compose", "exec", "-T", "postgres",
      "psql", "-U", "gas", "-d", "gas", "-t", "-A", "-F", "|", "-c",
      `select round(avg(transaction_count)::numeric,1),
              round(avg(total_gas_used::numeric)/1e6,2),
              round(avg(total_gas_used::numeric)/36e6*100,1),
              round(avg(base_block_fee_wei::numeric)/1e9,4),
              max(block_number)
       from (select * from blocks order by block_number desc limit 30) b;`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  const [tx, mgas, pct, feeGwei, head] = out.split("|");
  return { tx, mgas, pct, feeGwei, head };
}

async function main() {
  const { values } = parseArgs({
    options: { interval: { type: "string", default: "60" }, ticks: { type: "string", default: "30" } },
  });
  const intervalMs = Number(values.interval) * 1000;
  const ticks = Number(values.ticks);

  const ring = new RpcKeyRing({ keys: await loadRpcKeyPool({ RPC_KEY_POOL_FILE: "rpc-keys/keys.json" }), log: () => {} });

  console.log("time     | rpc      | head    | tx/blk | Mgas  | full% | basefee gwei | workers        | minETH");
  for (let tick = 0; tick < ticks; tick += 1) {
    const [rpc, blocks, workers] = await Promise.all([probeRpc(ring), readBlocks(), readWorkers()]);
    const stamp = new Date().toISOString().slice(11, 19);
    const workerLabel = Object.entries(workers.counts)
      .map(([k, v]) => `${v}${k[0]}`)
      .join(" ");
    console.log(
      `${stamp} | ${(rpc.ok ? "up" : "DOWN").padEnd(8)} | ${String(blocks.head).padEnd(7)} | ` +
        `${String(blocks.tx).padEnd(6)} | ${String(blocks.mgas).padEnd(5)} | ${String(blocks.pct).padEnd(5)} | ` +
        `${String(blocks.feeGwei).padEnd(12)} | ${workerLabel.padEnd(14)} | ${workers.minBalance}`,
    );
    if (!rpc.ok) console.log(`         ^^ RPC UNHEALTHY: ${rpc.detail}`);
    if (tick < ticks - 1) await Bun.sleep(intervalMs);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
