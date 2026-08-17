#!/usr/bin/env bun
/**
 * Reshapes the running Baseload fleet for a load step and reports what the chain
 * did with it.
 *
 * The point of a step is to move more work per *RPC call*, not more calls: the
 * bouncer's rate limit is per client IP (50 calls/s, shared by the scanner and
 * every worker), so throughput cannot be bought with more workers past a point.
 * `entitiesPerRequest` and `singleCreatePayloadSize` are the levers that raise
 * gas and bytes per transaction instead.
 *
 * Usage:
 *   BACKEND_URL=http://127.0.0.1:3000 BASELOAD_ADMIN_BEARER_TOKEN=… \
 *   bun run scripts/rampBaseload.ts --workers 6 --entities 8 --payload 12288
 *
 *   bun run scripts/rampBaseload.ts --report        # just measure, change nothing
 */
import { parseArgs } from "node:util";

/** The engine rejects a transaction whose calldata approaches 128KiB. */
const MAX_TX_PAYLOAD_BYTES = 100 * 1024;

interface Worker {
  id: string;
  behavior: string;
  walletNumber: number;
  entitiesPerRequest: number;
  singleCreatePayloadSize: number;
  [key: string]: unknown;
}

async function getState(backendUrl: string) {
  const response = await fetch(`${backendUrl}/baseload`);
  if (!response.ok) throw new Error(`GET /baseload failed with HTTP ${response.status}`);
  return (await response.json()) as {
    enabled: boolean;
    config: { version: number; workers: Worker[] };
    statuses: Record<string, { status: string; message?: string; attemptedCount?: number }>;
    balances: Record<string, { balanceWei: string }>;
  };
}

async function putConfig(backendUrl: string, token: string | undefined, workers: Worker[]) {
  // walletAddress is derived by the backend from the mnemonic; sending it back
  // is rejected, so strip it.
  const payload = {
    version: 2,
    workers: workers.map(({ walletAddress: _walletAddress, ...rest }) => rest),
  };
  const response = await fetch(`${backendUrl}/baseload`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(`PUT /baseload failed with HTTP ${response.status}: ${text}`);
  }
}

function reportStatuses(state: Awaited<ReturnType<typeof getState>>) {
  const counts = new Map<string, number>();
  const errors: string[] = [];
  for (const [id, status] of Object.entries(state.statuses)) {
    counts.set(status.status, (counts.get(status.status) ?? 0) + 1);
    if (status.status === "error" && status.message) errors.push(`${id}: ${status.message}`);
  }
  console.log(`  workers: ${[...counts].map(([k, v]) => `${v} ${k}`).join(", ")}`);
  const balances = Object.values(state.balances).map((b) => Number(BigInt(b.balanceWei) / 10n ** 18n));
  if (balances.length) {
    balances.sort((a, b) => a - b);
    console.log(`  wallet balances: min ${balances[0]} ETH, max ${balances.at(-1)} ETH`);
  }
  for (const error of errors.slice(0, 3)) console.log(`  ERROR ${error}`);
  if (errors.length > 3) console.log(`  … and ${errors.length - 3} more errors`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      workers: { type: "string" },
      entities: { type: "string" },
      payload: { type: "string" },
      behavior: { type: "string" },
      /**
       * Gwei ceiling a worker will pay. It doubles as the throttle point under a
       * saturating load: once the base fee climbs past it the worker stops
       * sending, so the fleet self-limits instead of chasing the fee market up.
       */
      "max-gas-price": { type: "string" },
      /**
       * A heterogeneous fleet, as `<count>x<payloadBytes>` groups:
       *   --groups 20x4096,20x8192,20x16384,20x32768
       * Mixed transaction sizes compete for the same block space, so this is how
       * you see which size actually wins throughput rather than testing each in
       * isolation. Overrides --workers and --payload.
       */
      groups: { type: "string" },
      /**
       * Spread per-worker fee ceilings over a `min:max` gwei range, e.g. 1:10.
       * Under a saturating load the base fee climbs until it prices workers out,
       * so a spread turns the fleet into a fee ladder: the cheap workers drop
       * out first and the load self-limits gradually instead of all at once.
       *
       * The range is applied *within* each --groups group, not across the fleet,
       * so payload size and fee ceiling stay independent variables — otherwise
       * the smallest payloads would get all the cheapest ceilings.
       */
      "spread-gas-price": { type: "string" },
      report: { type: "boolean", default: false },
    },
  });

  const backendUrl = (process.env.BACKEND_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
  const token = process.env.BASELOAD_ADMIN_BEARER_TOKEN?.trim();

  const state = await getState(backendUrl);
  console.log(`Baseload enabled=${state.enabled}, ${state.config.workers.length} workers`);
  reportStatuses(state);

  if (values.report) return;

  const entities = values.entities === undefined ? undefined : Number(values.entities);
  const payload = values.payload === undefined ? undefined : Number(values.payload);
  const workerCount = values.workers === undefined ? undefined : Number(values.workers);
  const maxGasPriceGwei =
    values["max-gas-price"] === undefined ? undefined : Number(values["max-gas-price"]);
  let spread: { min: number; max: number } | undefined;
  if (values["spread-gas-price"] !== undefined) {
    const match = /^([\d.]+):([\d.]+)$/.exec(String(values["spread-gas-price"]).trim());
    if (!match) throw new Error("--spread-gas-price must look like <min>:<max>, e.g. 1:10");
    const min = Number(match[1]);
    const max = Number(match[2]);
    if (!(min > 0) || !(max > min)) throw new Error("--spread-gas-price needs 0 < min < max");
    spread = { min, max };
  }

  /** Evenly spaced ceiling for index `i` of `count`; a lone worker gets the max. */
  const spreadGasPrice = (i: number, count: number): number | undefined => {
    if (!spread) return undefined;
    const step = count <= 1 ? 1 : i / (count - 1);
    return Math.round((spread.min + (spread.max - spread.min) * step) * 100) / 100;
  };
  if (maxGasPriceGwei !== undefined && (!Number.isFinite(maxGasPriceGwei) || maxGasPriceGwei <= 0)) {
    throw new Error("--max-gas-price must be a positive number of gwei");
  }

  if (entities !== undefined && payload !== undefined && entities * payload > MAX_TX_PAYLOAD_BYTES) {
    throw new Error(
      `entities x payload = ${(entities * payload).toLocaleString()} bytes exceeds the ~100KB ` +
        `per-transaction budget; the engine fails the whole batch above that`,
    );
  }

  // Falls back to a built-in template so the fleet can be rebuilt from empty —
  // stopping the load sets workers to [], and that must not become a dead end.
  const template: Worker = state.config.workers[0] ?? {
    id: "creator-w0",
    behavior: "create",
    walletNumber: 0,
    entitiesPerRequest: 1,
    singleCreatePayloadSize: 51200,
    maxGasPriceGwei: 10,
    opsPerMinute: 60,
    singleCreateStringArgumentCount: 1,
    singleCreateNumberArgumentCount: 1,
    entityPoolSize: 10,
    timeBombOffsetSeconds: 600,
    startBlock: 0,
    endBlock: null,
    durationSeconds: null,
    ttlSeconds: 1800,
  };

  if (values.groups) {
    const groups = String(values.groups)
      .split(",")
      .map((spec) => {
        const match = /^(\d+)x(\d+)$/.exec(spec.trim());
        if (!match) throw new Error(`--groups entry "${spec}" must look like <count>x<payloadBytes>`);
        return { count: Number(match[1]), payloadBytes: Number(match[2]) };
      });

    const grouped: Worker[] = [];
    for (const group of groups) {
      if (group.payloadBytes > MAX_TX_PAYLOAD_BYTES) {
        throw new Error(`--groups payload ${group.payloadBytes} exceeds the ~100KB per-tx budget`);
      }
      for (let i = 0; i < group.count; i += 1) {
        const walletNumber = grouped.length;
        const spreadCap = spreadGasPrice(i, group.count);
        grouped.push({
          ...template,
          id: `p${group.payloadBytes}-w${walletNumber}`,
          behavior: values.behavior ?? "create",
          walletNumber,
          entitiesPerRequest: 1,
          singleCreatePayloadSize: group.payloadBytes,
          ...(spreadCap !== undefined
            ? { maxGasPriceGwei: spreadCap }
            : maxGasPriceGwei !== undefined
              ? { maxGasPriceGwei }
              : {}),
        });
      }
    }
    if (grouped.length > 250) {
      throw new Error(`${grouped.length} workers exceeds MAX_WALLET_NUMBER (250 derived wallets)`);
    }
    await putConfig(backendUrl, token, grouped);
    const summary = groups.map((g) => `${g.count}x${(g.payloadBytes / 1024).toFixed(0)}KB`).join(", ");
    const capLabel = spread
      ? `maxGasPrice spread ${spread.min}-${spread.max} gwei within each group`
      : `maxGasPrice ${maxGasPriceGwei ?? template.maxGasPriceGwei} gwei`;
    console.log(`Applied ${grouped.length} workers: ${summary}, ${capLabel}`);
    return;
  }

  let workers = [...state.config.workers];
  if (workerCount !== undefined) {
    while (workers.length > workerCount) workers.pop();
    while (workers.length < workerCount) {
      const walletNumber = workers.length;
      const behavior =
        values.behavior ?? (walletNumber % 2 === 0 ? "create" : "create-update-delete");
      workers.push({
        ...template,
        id: `${behavior === "create" ? "creator" : "churner"}-w${walletNumber}`,
        behavior,
        walletNumber,
      });
    }
  }

  workers = workers.map((worker, index) => ({
    ...worker,
    // --behavior applies to the whole fleet, not just newly added workers: the
    // churn behaviours keep a client-side entity pool that desynchronises from
    // the chain under load ("Transaction failed: no entity 0x…") and wedges the
    // worker, so an all-creator fleet is what sustains throughput.
    ...(values.behavior
      ? {
          behavior: values.behavior,
          id: `${values.behavior === "create" ? "creator" : "churner"}-w${worker.walletNumber ?? index}`,
        }
      : {}),
    ...(entities !== undefined ? { entitiesPerRequest: entities } : {}),
    ...(payload !== undefined ? { singleCreatePayloadSize: payload } : {}),
    ...(maxGasPriceGwei !== undefined ? { maxGasPriceGwei } : {}),
  }));

  await putConfig(backendUrl, token, workers);
  const perTx = (entities ?? template.entitiesPerRequest) * (payload ?? template.singleCreatePayloadSize);
  console.log(
    `Applied: ${workers.length} workers x ${entities ?? template.entitiesPerRequest} entities ` +
      `x ${payload ?? template.singleCreatePayloadSize} bytes = ${perTx.toLocaleString()} bytes/tx` +
      `, maxGasPrice ${maxGasPriceGwei ?? template.maxGasPriceGwei} gwei`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
