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

  if (entities !== undefined && payload !== undefined && entities * payload > MAX_TX_PAYLOAD_BYTES) {
    throw new Error(
      `entities x payload = ${(entities * payload).toLocaleString()} bytes exceeds the ~100KB ` +
        `per-transaction budget; the engine fails the whole batch above that`,
    );
  }

  const template = state.config.workers[0];
  if (!template) throw new Error("no existing worker to use as a template");

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

  workers = workers.map((worker) => ({
    ...worker,
    ...(entities !== undefined ? { entitiesPerRequest: entities } : {}),
    ...(payload !== undefined ? { singleCreatePayloadSize: payload } : {}),
  }));

  await putConfig(backendUrl, token, workers);
  const perTx = (entities ?? template.entitiesPerRequest) * (payload ?? template.singleCreatePayloadSize);
  console.log(
    `Applied: ${workers.length} workers x ${entities ?? template.entitiesPerRequest} entities ` +
      `x ${payload ?? template.singleCreatePayloadSize} bytes = ${perTx.toLocaleString()} bytes/tx`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
