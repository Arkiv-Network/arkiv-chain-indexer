#!/usr/bin/env bun
/**
 * High-frequency RPC liveness probe for the break-it experiment. Polls the head
 * block every `--interval` seconds and prints a one-line status, calling out
 * every transition between healthy / stale / down so the exact moment the RPC
 * tier fails is captured against the load that caused it.
 *
 * Health is THREE states, not two, because "returns HTTP 200" is not "healthy":
 * on 2026-08-18 the tier answered eth_blockNumber and eth_chainId normally for
 * hours while the head block it reported was already 2.5h old, and a probe that
 * only checked for a successful response called that healthy. So the probe
 * fetches the head *block* (one call, `eth_getBlockByNumber(latest)`) and
 * compares its timestamp against wall clock:
 *   ok    - responds and the head is fresher than --max-stale
 *   stale - responds, but the head has not advanced recently (tier is serving,
 *           the chain behind it is not moving or the tier cannot see it)
 *   down  - no usable response at all (typically -32011 no healthy backend)
 *
 * Deliberately uses one fixed key (not the rotating pool) so a health failure
 * cannot be confused with a per-key quota/rate problem: -32011 is the bouncer
 * reporting it has no upstream node, independent of which key asked. Key-level
 * rejections (QUOTA_EXCEEDED / INVALID_KEY) are reported as their own state so
 * an exhausted probe key never masquerades as an outage.
 *
 * Usage: bun run scripts/probeRpcHealth.ts --interval 3 --seconds 600 --max-stale 30
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

type Health = "ok" | "stale" | "down" | "key";

interface Probe {
  health: Health;
  status: number;
  head?: number;
  /** Seconds between the head block's own timestamp and wall clock. */
  staleSec?: number;
  detail: string;
  latencyMs: number;
}

async function probe(key: string, maxStaleSec: number): Promise<Probe> {
  const started = performance.now();
  try {
    const response = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getBlockByNumber",
        params: ["latest", false],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const latencyMs = Math.round(performance.now() - started);
    const text = await response.text();

    // A key-level rejection is not an outage; keep it in its own bucket.
    if (text.includes("QUOTA_EXCEEDED") || text.includes("INVALID_KEY")) {
      return { health: "key", status: response.status, detail: text.slice(0, 120), latencyMs };
    }
    if (!response.ok) {
      return { health: "down", status: response.status, detail: text.slice(0, 120), latencyMs };
    }

    const body = JSON.parse(text) as {
      result?: { number?: string; timestamp?: string } | null;
      error?: { message?: string };
    };
    if (body.error) {
      return { health: "down", status: response.status, detail: body.error.message ?? "rpc error", latencyMs };
    }
    if (!body.result?.number || !body.result.timestamp) {
      return { health: "down", status: response.status, detail: "no head block in response", latencyMs };
    }

    const head = Number(BigInt(body.result.number));
    const staleSec = Math.round(Date.now() / 1000 - Number(BigInt(body.result.timestamp)));
    return {
      health: staleSec > maxStaleSec ? "stale" : "ok",
      status: response.status,
      head,
      staleSec,
      detail: staleSec > maxStaleSec ? `head is ${staleSec}s old` : "ok",
      latencyMs,
    };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - started);
    return {
      health: "down",
      status: 0,
      detail: error instanceof Error ? error.message : String(error),
      latencyMs,
    };
  }
}

function describe(p: Probe): string {
  const head = p.head !== undefined ? `head ${p.head}` : "no head";
  switch (p.health) {
    case "ok":
      return `healthy (${head}, ${p.staleSec}s old, ${p.latencyMs}ms)`;
    case "stale":
      return `STALE (${head} last moved ${p.staleSec}s ago, ${p.latencyMs}ms)`;
    case "key":
      return `PROBE KEY REJECTED: ${p.detail} — not an outage, repoint the probe`;
    default:
      return `DOWN: status=${p.status} ${p.detail} (${p.latencyMs}ms)`;
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      interval: { type: "string", default: "3" },
      seconds: { type: "string", default: "600" },
      "max-stale": { type: "string", default: "30" },
    },
  });
  const intervalMs = Number(values.interval) * 1000;
  const maxStaleSec = Number(values["max-stale"]);
  const deadline = performance.now() + Number(values.seconds) * 1000;
  const key = firstKey();

  let last: Health | null = null;
  let since: number | null = null;
  const episodes: Record<Health, number> = { ok: 0, stale: 0, down: 0, key: 0 };
  const timeIn: Record<Health, number> = { ok: 0, stale: 0, down: 0, key: 0 };
  let lastHead: number | null = null;

  console.log(
    `Probing ${RPC} every ${values.interval}s for ${values.seconds}s ` +
      `(head older than ${maxStaleSec}s counts as stale)`,
  );
  while (performance.now() < deadline) {
    const p = await probe(key, maxStaleSec);
    const stamp = new Date().toISOString().slice(11, 19);

    if (last !== p.health) {
      if (last !== null && since !== null) timeIn[last] += Date.now() - since;
      episodes[p.health] += 1;
      since = Date.now();
      const arrow = p.health === "ok" ? "<<<" : ">>>";
      console.log(`${stamp} ${arrow} ${describe(p)}`);
      last = p.health;
    } else if (p.health !== "ok") {
      console.log(`${stamp}     still ${p.health}: ${p.detail}`);
    } else {
      // Healthy steady state: note latency spikes and head advancement only.
      if (p.latencyMs > 1000) console.log(`${stamp} healthy but SLOW: ${p.latencyMs}ms (head ${p.head})`);
      else if (lastHead !== null && p.head === lastHead && p.staleSec! > maxStaleSec / 2) {
        console.log(`${stamp} head ${p.head} unchanged (${p.staleSec}s old)`);
      }
    }
    if (p.head !== undefined) lastHead = p.head;
    await Bun.sleep(intervalMs);
  }
  if (last !== null && since !== null) timeIn[last] += Date.now() - since;

  const secs = (ms: number) => (ms / 1000).toFixed(0);
  console.log(
    `\nSummary: ok ${episodes.ok} episode(s)/${secs(timeIn.ok)}s, ` +
      `stale ${episodes.stale}/${secs(timeIn.stale)}s, ` +
      `down ${episodes.down}/${secs(timeIn.down)}s, ` +
      `key-rejected ${episodes.key}/${secs(timeIn.key)}s`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
