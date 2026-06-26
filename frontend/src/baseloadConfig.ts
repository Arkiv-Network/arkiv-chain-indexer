import {
  BASELOAD_WORKER_BEHAVIORS,
  type BaseloadConfig,
  type BaseloadWorkerBehavior,
  type BaseloadWorkerConfig,
} from "./api";

export { BASELOAD_WORKER_BEHAVIORS } from "./api";
export type { BaseloadConfig, BaseloadWorkerBehavior, BaseloadWorkerConfig } from "./api";

export const BASELOAD_BEHAVIOR_LABELS: Record<BaseloadWorkerBehavior, string> = {
  "create": "Creates only",
  "create-update": "Creates + updates (TTL refresh)",
  "create-ownership": "Creates + ownership change",
  "time-bomb": "Time bomb (synchronized expiry)",
  "create-update-delete": "Creates + updates + deletes",
};

export function behaviorUsesPool(behavior: BaseloadWorkerBehavior): boolean {
  return behavior === "create-update" || behavior === "create-update-delete";
}

export interface BaseloadWorkerDraft {
  behavior: string;
  maxGasPriceGwei: string;
  opsPerMinute: string;
  entitiesPerRequest: string;
  singleCreatePayloadSize: string;
  singleCreateStringArgumentCount: string;
  singleCreateNumberArgumentCount: string;
  entityPoolSize: string;
  timeBombOffsetSeconds: string;
  walletNumber: string;
  startBlock: string;
  endBlock: string;
  durationSeconds: string;
  ttlSeconds: string;
}

export const BASELOAD_CONFIG_VERSION = 2;
export const MIN_WALLET_NUMBER = 0;
export const MAX_WALLET_NUMBER = 100;
export const MAX_BASELOAD_ENTITIES_PER_REQUEST = 1;

export const DEFAULT_BASELOAD_WORKER_VALUES = {
  behavior: "create" as BaseloadWorkerBehavior,
  maxGasPriceGwei: 0.1,
  opsPerMinute: 1,
  entitiesPerRequest: 1,
  singleCreatePayloadSize: 5000,
  singleCreateStringArgumentCount: 2,
  singleCreateNumberArgumentCount: 2,
  entityPoolSize: 10,
  timeBombOffsetSeconds: 600,
  startBlock: 0,
  endBlock: null,
  durationSeconds: null,
  ttlSeconds: 3600,
} as const;

export const EMPTY_BASELOAD_CONFIG: BaseloadConfig = {
  version: BASELOAD_CONFIG_VERSION,
  workers: [],
};

export function createBaseloadWorkerDraft(walletNumber: number): BaseloadWorkerDraft {
  return {
    behavior: DEFAULT_BASELOAD_WORKER_VALUES.behavior,
    maxGasPriceGwei: String(DEFAULT_BASELOAD_WORKER_VALUES.maxGasPriceGwei.toFixed(1)),
    opsPerMinute: String(DEFAULT_BASELOAD_WORKER_VALUES.opsPerMinute),
    entitiesPerRequest: String(DEFAULT_BASELOAD_WORKER_VALUES.entitiesPerRequest),
    singleCreatePayloadSize: String(DEFAULT_BASELOAD_WORKER_VALUES.singleCreatePayloadSize),
    singleCreateStringArgumentCount: String(
      DEFAULT_BASELOAD_WORKER_VALUES.singleCreateStringArgumentCount,
    ),
    singleCreateNumberArgumentCount: String(
      DEFAULT_BASELOAD_WORKER_VALUES.singleCreateNumberArgumentCount,
    ),
    entityPoolSize: String(DEFAULT_BASELOAD_WORKER_VALUES.entityPoolSize),
    timeBombOffsetSeconds: String(DEFAULT_BASELOAD_WORKER_VALUES.timeBombOffsetSeconds),
    walletNumber: String(walletNumber),
    startBlock: String(DEFAULT_BASELOAD_WORKER_VALUES.startBlock),
    endBlock: "",
    durationSeconds: "",
    ttlSeconds: String(DEFAULT_BASELOAD_WORKER_VALUES.ttlSeconds),
  };
}

export function moveDraftToNextAvailableWallet(
  draft: BaseloadWorkerDraft,
  workers: readonly BaseloadWorkerConfig[],
): BaseloadWorkerDraft {
  return {
    ...draft,
    walletNumber: String(getAvailableWalletNumbers(workers)[0] ?? MIN_WALLET_NUMBER),
  };
}

export function createBaseloadWorkerFromDraft(draft: BaseloadWorkerDraft): BaseloadWorkerConfig {
  return normalizeBaseloadWorker({
    ...DEFAULT_BASELOAD_WORKER_VALUES,
    id: createWorkerId(Number(draft.walletNumber)),
    behavior: draft.behavior,
    maxGasPriceGwei: parseFiniteNumber("Max gas price accepted gwei", draft.maxGasPriceGwei, {
      allowFloat: true,
      min: 0,
    }),
    opsPerMinute: parseFiniteNumber("Operations per minute", draft.opsPerMinute, {
      allowFloat: true,
      min: 0,
    }),
    entitiesPerRequest: clampEntitiesPerRequest(
      parseFiniteNumber("Entities per request", draft.entitiesPerRequest, {
        allowFloat: false,
        min: 1,
      }),
    ),
    singleCreatePayloadSize: parseFiniteNumber("Single create payload size", draft.singleCreatePayloadSize, {
      allowFloat: false,
      min: 0,
    }),
    singleCreateStringArgumentCount: parseFiniteNumber(
      "Single create string argument number",
      draft.singleCreateStringArgumentCount,
      { allowFloat: false, min: 0 },
    ),
    singleCreateNumberArgumentCount: parseFiniteNumber(
      "Single create number argument number",
      draft.singleCreateNumberArgumentCount,
      { allowFloat: false, min: 0 },
    ),
    entityPoolSize: parseFiniteNumber("Entity pool size", draft.entityPoolSize, {
      allowFloat: false,
      min: 1,
    }),
    timeBombOffsetSeconds: parseFiniteNumber(
      "Time bomb offset seconds",
      draft.timeBombOffsetSeconds,
      { allowFloat: false, min: 1 },
    ),
    walletNumber: parseFiniteNumber("Wallet number", draft.walletNumber, {
      allowFloat: false,
      min: MIN_WALLET_NUMBER,
      max: MAX_WALLET_NUMBER,
    }),
    startBlock: parseFiniteNumber("Start block", draft.startBlock, {
      allowFloat: false,
      min: 0,
    }),
    endBlock:
      draft.endBlock.trim() === ""
        ? null
        : parseFiniteNumber("End block", draft.endBlock, { allowFloat: false, min: 0 }),
    durationSeconds:
      draft.durationSeconds.trim() === ""
        ? null
        : parseFiniteNumber("Duration seconds", draft.durationSeconds, {
            allowFloat: false,
            min: 1,
          }),
    ttlSeconds: parseFiniteNumber("TTL seconds", draft.ttlSeconds, {
      allowFloat: false,
      min: 1,
    }),
  });
}

export function normalizeBaseloadConfig(value: unknown): BaseloadConfig {
  if (value === null || typeof value !== "object") {
    throw new Error("Baseload configuration must be a JSON object");
  }

  const input = value as Partial<BaseloadConfig>;
  const rawWorkers = Array.isArray(input.workers) ? input.workers : [];
  const workers = rawWorkers.map((worker) => normalizeBaseloadWorker(worker));
  assertUniqueWallets(workers);

  return {
    version: BASELOAD_CONFIG_VERSION,
    workers,
  };
}

export function parseBaseloadConfigJson(json: string): BaseloadConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Configuration file is not valid JSON");
  }
  return normalizeBaseloadConfig(parsed);
}

export function serializeBaseloadConfig(config: BaseloadConfig): string {
  return `${JSON.stringify(normalizeBaseloadConfig(config), null, 2)}\n`;
}

export function getAvailableWalletNumbers(workers: readonly BaseloadWorkerConfig[]): number[] {
  const attached = new Set(workers.map((worker) => worker.walletNumber));
  const wallets: number[] = [];
  for (let wallet = MIN_WALLET_NUMBER; wallet <= MAX_WALLET_NUMBER; wallet += 1) {
    if (!attached.has(wallet)) wallets.push(wallet);
  }
  return wallets;
}

export function updateBaseloadWorker(
  config: BaseloadConfig,
  workerId: string,
  patch: Partial<BaseloadWorkerConfig>,
): BaseloadConfig {
  const workers = config.workers.map((worker) =>
    worker.id === workerId ? normalizeBaseloadWorker({ ...worker, ...patch }) : worker,
  );
  assertUniqueWallets(workers);
  return { version: BASELOAD_CONFIG_VERSION, workers };
}

export function removeBaseloadWorker(config: BaseloadConfig, workerId: string): BaseloadConfig {
  return {
    version: BASELOAD_CONFIG_VERSION,
    workers: config.workers.filter((worker) => worker.id !== workerId),
  };
}

function normalizeBaseloadWorker(value: unknown): BaseloadWorkerConfig {
  if (value === null || typeof value !== "object") {
    throw new Error("Each baseload worker must be a JSON object");
  }

  const input = value as Partial<BaseloadWorkerConfig>;
  const walletNumber = coerceInteger("Wallet number", input.walletNumber, {
    min: MIN_WALLET_NUMBER,
    max: MAX_WALLET_NUMBER,
  });
  const startBlock = coerceInteger("Start block", input.startBlock, { min: 0 });
  const endBlock = coerceNullableInteger("End block", input.endBlock, { min: 0 });

  if (endBlock !== null && endBlock < startBlock) {
    throw new Error("End block must be greater than or equal to start block");
  }

  return {
    id: typeof input.id === "string" && input.id.trim() ? input.id : createWorkerId(walletNumber),
    behavior: coerceBehavior(input.behavior),
    maxGasPriceGwei: coerceNumber("Max gas price accepted gwei", input.maxGasPriceGwei, {
      min: 0,
    }),
    opsPerMinute: coerceNumber("Operations per minute", input.opsPerMinute, {
      min: 0,
    }),
    entitiesPerRequest: clampEntitiesPerRequest(
      coerceInteger("Entities per request", input.entitiesPerRequest, {
        min: 1,
      }),
    ),
    singleCreatePayloadSize: coerceInteger(
      "Single create payload size",
      input.singleCreatePayloadSize,
      { min: 0 },
    ),
    singleCreateStringArgumentCount: coerceInteger(
      "Single create string argument number",
      input.singleCreateStringArgumentCount,
      { min: 0 },
    ),
    singleCreateNumberArgumentCount: coerceInteger(
      "Single create number argument number",
      input.singleCreateNumberArgumentCount,
      { min: 0 },
    ),
    entityPoolSize: coerceInteger("Entity pool size", input.entityPoolSize, { min: 1 }),
    timeBombOffsetSeconds: coerceInteger("Time bomb offset seconds", input.timeBombOffsetSeconds, {
      min: 1,
    }),
    walletNumber,
    walletAddress: typeof input.walletAddress === "string" ? input.walletAddress : "",
    startBlock,
    endBlock,
    durationSeconds: coerceNullableInteger("Duration seconds", input.durationSeconds, { min: 1 }),
    ttlSeconds: coerceInteger("TTL seconds", input.ttlSeconds, { min: 1 }),
  };
}

function coerceBehavior(value: unknown): BaseloadWorkerBehavior {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_BASELOAD_WORKER_VALUES.behavior;
  }
  if (
    typeof value === "string" &&
    (BASELOAD_WORKER_BEHAVIORS as readonly string[]).includes(value)
  ) {
    return value as BaseloadWorkerBehavior;
  }
  throw new Error(`Worker behavior must be one of: ${BASELOAD_WORKER_BEHAVIORS.join(", ")}`);
}

function createWorkerId(walletNumber: number): string {
  return `wallet-${walletNumber}`;
}

function assertUniqueWallets(workers: readonly BaseloadWorkerConfig[]) {
  const seen = new Set<number>();
  for (const worker of workers) {
    if (seen.has(worker.walletNumber)) {
      throw new Error(`Wallet ${worker.walletNumber} is already attached to another worker`);
    }
    seen.add(worker.walletNumber);
  }
}

function clampEntitiesPerRequest(value: number): number {
  return Math.min(value, MAX_BASELOAD_ENTITIES_PER_REQUEST);
}

function parseFiniteNumber(
  label: string,
  raw: string,
  options: { allowFloat: boolean; min?: number; max?: number },
): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || raw.trim() === "") {
    throw new Error(`${label} must be a number`);
  }
  if (!options.allowFloat && !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  if (options.min !== undefined && value < options.min) {
    throw new Error(`${label} must be at least ${options.min}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new Error(`${label} must be at most ${options.max}`);
  }
  return value;
}

function coerceNumber(label: string, value: unknown, options: { min?: number; max?: number }): number {
  const fallback = defaultNumberFor(label);
  const next = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isFinite(next)) {
    throw new Error(`${label} must be a number`);
  }
  if (options.min !== undefined && next < options.min) {
    throw new Error(`${label} must be at least ${options.min}`);
  }
  if (options.max !== undefined && next > options.max) {
    throw new Error(`${label} must be at most ${options.max}`);
  }
  return next;
}

function coerceInteger(label: string, value: unknown, options: { min?: number; max?: number }): number {
  const next = coerceNumber(label, value, options);
  if (!Number.isInteger(next)) {
    throw new Error(`${label} must be an integer`);
  }
  return next;
}

function coerceNullableInteger(
  label: string,
  value: unknown,
  options: { min?: number; max?: number },
): number | null {
  if (value === undefined || value === null || value === "") return null;
  return coerceInteger(label, value, options);
}

function defaultNumberFor(label: string): number {
  switch (label) {
    case "Max gas price accepted gwei":
      return DEFAULT_BASELOAD_WORKER_VALUES.maxGasPriceGwei;
    case "Operations per minute":
      return DEFAULT_BASELOAD_WORKER_VALUES.opsPerMinute;
    case "Entities per request":
      return DEFAULT_BASELOAD_WORKER_VALUES.entitiesPerRequest;
    case "Single create payload size":
      return DEFAULT_BASELOAD_WORKER_VALUES.singleCreatePayloadSize;
    case "Single create string argument number":
      return DEFAULT_BASELOAD_WORKER_VALUES.singleCreateStringArgumentCount;
    case "Single create number argument number":
      return DEFAULT_BASELOAD_WORKER_VALUES.singleCreateNumberArgumentCount;
    case "Entity pool size":
      return DEFAULT_BASELOAD_WORKER_VALUES.entityPoolSize;
    case "Time bomb offset seconds":
      return DEFAULT_BASELOAD_WORKER_VALUES.timeBombOffsetSeconds;
    case "Start block":
      return DEFAULT_BASELOAD_WORKER_VALUES.startBlock;
    case "TTL seconds":
      return DEFAULT_BASELOAD_WORKER_VALUES.ttlSeconds;
    default:
      return 0;
  }
}
