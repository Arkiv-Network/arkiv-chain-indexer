#!/usr/bin/env bun
/**
 * High-frequency RPC liveness probe for the break-it experiment. Pings
 * eth_blockNumber every `--interval` seconds and prints a one-line status,
 * calling out the first transition into and out of `no healthy backend` so the
 * exact moment the RPC tier fails is captured against the load that caused it.
 *
 * Deliberately uses one fixed key (not the rotating pool) so a health failure
 * cannot be confused with a per-key quota/rate problem: -32011 is the bouncer
 * reporting it has no upstream node, independent of which key asked.
 *
 * Usage: bun run scripts/probeRpcHealth.ts --interval 3 --seconds 600
 */
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";

const RPC = (
  process.env.MEASURE_RPC_URL || "https://rpc.cheesecake.db-chain.devnet.gobas.me"
).replace(/\/+$/, "");

function firstKey(): string {
  const pool = JSON.parse(readFileSync("rpc-keys/keys.json", "utf8")) as { keys: string[] };
  return pool.keys[0]!;
}

interface Probe {
  ok: boolean;
  status: number;
  head?: number;
  detail: string;
  latencyMs: number;
}

async function probe(key: string): Promise<Probe> {
  const started = performance.now();
  try {
    const response = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    const latencyMs = Math.round(performance.now() - started);
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, status: response.status, detail: text.slice(0, 120), latencyMs };
    }
    const body = JSON.parse(text) as { result?: string; error?: { message?: string } };
    if (body.error) return { ok: false, status: response.status, detail: body.error.message ?? "rpc error", latencyMs };
    return { ok: true, status: response.status, head: Number(BigInt(body.result!)), detail: "ok", latencyMs };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - started);
    return { ok: false, status: 0, detail: error instanceof Error ? error.message : String(error), latencyMs };
  }
}

async function main() {
  const { values } = parseArgs({
    options: { interval: { type: "string", default: "3" }, seconds: { type: "string", default: "600" } },
  });
  const intervalMs = Number(values.interval) * 1000;
  const deadline = performance.now() + Number(values.seconds) * 1000;
  const key = firstKey();

  let lastOk: boolean | null = null;
  let downSince: number | null = null;
  let downCount = 0;
  let totalDownMs = 0;

  console.log(`Probing ${RPC} every ${values.interval}s for ${values.seconds}s`);
  while (performance.now() < deadline) {
    const p = await probe(key);
    const stamp = new Date().toISOString().slice(11, 19);

    if (lastOk === null || p.ok !== lastOk) {
      if (!p.ok) {
        downCount += 1;
        downSince = Date.now();
        console.log(`${stamp} >>> RPC WENT UNHEALTHY: status=${p.status} ${p.detail} (${p.latencyMs}ms)`);
      } else {
        const downMs = downSince ? Date.now() - downSince : 0;
        totalDownMs += downMs;
        if (lastOk === false) console.log(`${stamp} <<< RPC RECOVERED after ${(downMs / 1000).toFixed(0)}s (head ${p.head})`);
        else console.log(`${stamp} healthy (head ${p.head}, ${p.latencyMs}ms)`);
        downSince = null;
      }
      lastOk = p.ok;
    } else if (!p.ok) {
      console.log(`${stamp}     still down: ${p.detail}`);
    } else {
      // Healthy steady state: only note when latency spikes (early stress signal).
      if (p.latencyMs > 1000) console.log(`${stamp} healthy but SLOW: ${p.latencyMs}ms (head ${p.head})`);
    }
    await Bun.sleep(intervalMs);
  }

  if (downSince) totalDownMs += Date.now() - downSince;
  console.log(
    `\nSummary: ${downCount} unhealthy episode(s), ${(totalDownMs / 1000).toFixed(0)}s total downtime`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
