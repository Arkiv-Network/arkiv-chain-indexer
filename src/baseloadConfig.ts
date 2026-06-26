import { readFile } from "node:fs/promises";
import { mnemonicToAccount } from "viem/accounts";

export const BASELOAD_WORKER_BEHAVIORS = [
  "create",
  "create-update",
  "create-ownership",
  "time-bomb",
  "create-update-delete",
] as const;

export type BaseloadWorkerBehavior = (typeof BASELOAD_WORKER_BEHAVIORS)[number];

export interface BaseloadWorkerConfig {
  id: string;
  behavior: BaseloadWorkerBehavior;
  maxGasPriceGwei: number;
  opsPerMinute: number;
  entitiesPerRequest: number;
  singleCreatePayloadSize: number;
  singleCreateStringArgumentCount: number;
  singleCreateNumberArgumentCount: number;
  entityPoolSize: number;
  timeBombOffsetSeconds: number;
  walletNumber: number;
  walletAddress: string;
  startBlock: number;
  endBlock: number | null;
  durationSeconds: number | null;
  ttlSeconds: number;
}

export interface BaseloadConfig {
  version: 2;
  workers: BaseloadWorkerConfig[];
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

export interface BaseloadRuntimeConfig {
  rpcUrl: string | null;
  mnemonic: string;
  payloadProvider?: BaseloadPayloadProviderRuntimeConfig | null;
}

export interface BaseloadPayloadProviderRuntimeConfig {
  url: string;
  bearerKey?: string;
  namespace: string;
  verifyReceipt: boolean;
}

export const BASELOAD_CONFIG_VERSION = 2;
export const MIN_WALLET_NUMBER = 0;
export const MAX_WALLET_NUMBER = 100;
export const MAX_BASELOAD_ENTITIES_PER_REQUEST = 1;
export const BASELOAD_DERIVATION_PATH_PREFIX = "m/44'/60'/0'/0";
export const DEFAULT_BASELOAD_PAYLOAD_PROVIDER_NAMESPACE = "arkiv.entities";
export const DEFAULT_BASELOAD_MNEMONIC =
  "parent picture garment parrot churn record stadium pill rocket craft fish fiscal clip virus view diary replace wealth extra kitten door enforce piece nut";

export const DEFAULT_BASELOAD_WORKER_VALUES = {
  behavior: "create" as BaseloadWorkerBehavior,
  maxGasPriceGwei: 1000,
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

export function parseBaseloadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): BaseloadRuntimeConfig {
  const rpcUrl = env.BASELOAD_RPC_NODE?.trim() || null;
  const mnemonic = env.BASELOAD_MNEMONIC?.trim() || env.MNEMONIC?.trim() || DEFAULT_BASELOAD_MNEMONIC;
  const payloadProvider = parseBaseloadPayloadProviderRuntimeConfig(env);
  return { rpcUrl, mnemonic, payloadProvider };
}

function parseBaseloadPayloadProviderRuntimeConfig(
  env: NodeJS.ProcessEnv,
): BaseloadPayloadProviderRuntimeConfig | null {
  const url = env.BASELOAD_PAYLOAD_PROVIDER_URL?.trim();
  if (!url) return null;

  const bearerKey = env.BASELOAD_PAYLOAD_PROVIDER_BEARER_KEY?.trim();
  const namespace =
    env.BASELOAD_PAYLOAD_PROVIDER_NAMESPACE?.trim() || DEFAULT_BASELOAD_PAYLOAD_PROVIDER_NAMESPACE;
  const verifyReceipt = parseBaseloadPayloadProviderVerifyReceipt(
    env.BASELOAD_PAYLOAD_PROVIDER_VERIFY_RECEIPT,
  );

  return {
    url,
    ...(bearerKey ? { bearerKey } : {}),
    namespace,
    verifyReceipt,
  };
}

function parseBaseloadPayloadProviderVerifyReceipt(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return true;
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  throw new Error("BASELOAD_PAYLOAD_PROVIDER_VERIFY_RECEIPT must be a boolean");
}

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

export function createBaseloadWorkerFromDraft(
  draft: BaseloadWorkerDraft,
  mnemonic = DEFAULT_BASELOAD_MNEMONIC,
): BaseloadWorkerConfig {
  return normalizeBaseloadWorker(
    {
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
    },
    mnemonic,
  );
}

export function normalizeBaseloadConfig(
  value: unknown,
  mnemonic = DEFAULT_BASELOAD_MNEMONIC,
): BaseloadConfig {
  if (value === null || typeof value !== "object") {
    throw new Error("Baseload configuration must be a JSON object");
  }

  const input = value as Partial<BaseloadConfig>;
  const rawWorkers = Array.isArray(input.workers) ? input.workers : [];
  const workers = rawWorkers.map((worker) => normalizeBaseloadWorker(worker, mnemonic));
  assertUniqueWallets(workers);

  return {
    version: BASELOAD_CONFIG_VERSION,
    workers,
  };
}

export function parseBaseloadConfigJson(
  json: string,
  mnemonic = DEFAULT_BASELOAD_MNEMONIC,
): BaseloadConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Configuration file is not valid JSON");
  }
  return normalizeBaseloadConfig(parsed, mnemonic);
}

export async function readBaseloadConfigFile(
  path: string,
  mnemonic = DEFAULT_BASELOAD_MNEMONIC,
): Promise<BaseloadConfig> {
  let json: string;
  try {
    json = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Unable to read Baseload config file at ${path}: ${describeError(error)}`);
  }

  try {
    return parseBaseloadConfigJson(json, mnemonic);
  } catch (error) {
    throw new Error(`Invalid Baseload config file at ${path}: ${describeError(error)}`);
  }
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
  mnemonic = DEFAULT_BASELOAD_MNEMONIC,
): BaseloadConfig {
  const workers = config.workers.map((worker) =>
    worker.id === workerId ? normalizeBaseloadWorker({ ...worker, ...patch }, mnemonic) : worker,
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

export function deriveBaseloadWalletAddress(
  walletNumber: number,
  mnemonic = DEFAULT_BASELOAD_MNEMONIC,
): string {
  return mnemonicToAccount(mnemonic.trim(), {
    path: `${BASELOAD_DERIVATION_PATH_PREFIX}/${walletNumber}`,
  }).address;
}

function normalizeBaseloadWorker(
  value: unknown,
  mnemonic = DEFAULT_BASELOAD_MNEMONIC,
): BaseloadWorkerConfig {
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
    walletAddress: deriveBaseloadWalletAddress(walletNumber, mnemonic),
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

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}
