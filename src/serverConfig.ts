import {
  CliHelpRequested,
  coerceBoolean,
  coerceInt,
  coercePort,
  parseCli,
  type CliSpec,
} from "./cli";
import {
  DEFAULT_RESPONSE_CACHE_MAX_BYTES,
  DEFAULT_RESPONSE_CACHE_MAX_ENTRIES,
  DEFAULT_RESPONSE_CACHE_TTL_MS,
} from "./responseCache";
import { DEFAULT_ENTITY_HISTORY_LIMIT } from "./storage";

export interface ServerConfig {
  databaseUrl: string;
  port: number;
  hostname?: string;
  transactionDataEnabled: boolean;
  baseloadAdminBearerToken?: string;
  baseloadInitialConfigPath?: string;
  redisUrl?: string;
  protocolScheduleUrl?: string;
  protocolSchedulePath?: string;
  payloadProviderPaymentShareBps?: number;
  entityHistoryLimit: number;
  entityCacheMaxEntries: number;
  entityCacheMaxBytes: number;
  entityCacheTtlMs: number;
  syncRefreshMs: number;
  listCacheMaxEntries: number;
  listCacheMaxBytes: number;
  listCacheTtlMs: number;
  transactionCountCacheMaxEntries: number;
  transactionCountCacheTtlMs: number;
}

const DEFAULT_PORT = 3000;
const DEFAULT_SYNC_REFRESH_MS = 5_000;
const DEFAULT_LIST_CACHE_MAX_ENTRIES = 200;
const DEFAULT_LIST_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_LIST_CACHE_TTL_MS = 5_000;
const DEFAULT_TRANSACTION_COUNT_CACHE_MAX_ENTRIES = 500;
const DEFAULT_TRANSACTION_COUNT_CACHE_TTL_MS = 5_000;

/** Help text raised when the server is invoked with `--help`. */
export class ServerHelpRequested extends CliHelpRequested {}

const SPEC: CliSpec = {
  name: "serve",
  summary: "DATABASE_URL=postgres://user:pass@host:5432/db bun run serve",
  options: [
    {
      flags: "--database-url <url>",
      description: "PostgreSQL connection string (or DATABASE_URL env).",
      env: ["DATABASE_URL", "SCANNER_DATABASE_URL"],
    },
    {
      flags: "--port <port>",
      description:
        "TCP port to listen on. Defaults to 3000 (or SERVER_PORT). Use 0 to pick any free port.",
      env: ["SERVER_PORT"],
      default: DEFAULT_PORT.toString(),
    },
    {
      flags: "--host <host>",
      description: "Hostname/interface to bind. Defaults to Bun's default (all interfaces).",
      env: ["SERVER_HOSTNAME"],
    },
    {
      flags: "--transaction-data-enabled <bool>",
      description:
        "Enable transaction inspection endpoints and UI capability metadata. Defaults to true (or SERVER_TRANSACTION_DATA_ENABLED / SAVE_TRANSACTION_DATA).",
      env: ["SERVER_TRANSACTION_DATA_ENABLED", "SAVE_TRANSACTION_DATA"],
      default: "true",
    },
    {
      flags: "--baseload-admin-bearer-token <token>",
      description:
        "Bearer token required for mutating Baseload worker requests. Defaults to BASELOAD_ADMIN_BEARER_TOKEN. If unset, Baseload mutations are unrestricted.",
      env: ["BASELOAD_ADMIN_BEARER_TOKEN"],
    },
    {
      flags: "--baseload-initial-config <path>",
      description:
        "Optional Baseload worker config JSON file to load once at backend startup. Defaults to BASELOAD_INITIAL_CONFIG_PATH.",
      env: ["BASELOAD_INITIAL_CONFIG_PATH"],
    },
    {
      flags: "--redis-url <url>",
      description:
        "Optional Redis connection string. When set, the /guzzlers endpoint serves recent-sender statistics.",
      env: ["REDIS_URL", "SERVER_REDIS_URL"],
    },
    {
      flags: "--protocol-schedule-url <url>",
      description:
        "Optional Arkiv protocol schedule URL used to split payload-provider payments.",
      env: ["ARKIV_PROTOCOL_SCHEDULE_URL", "SERVER_PROTOCOL_SCHEDULE_URL"],
    },
    {
      flags: "--protocol-schedule-path <path>",
      description:
        "Optional local Arkiv protocol schedule JSON path used to split payload-provider payments.",
      env: ["ARKIV_PROTOCOL_SCHEDULE_PATH", "SERVER_PROTOCOL_SCHEDULE_PATH"],
    },
    {
      flags: "--payload-provider-payment-share-bps <bps>",
      description:
        "Optional provider-share basis points override used when no protocol schedule is configured.",
      env: ["PAYLOAD_PROVIDER_PAYMENT_SHARE_BPS", "SERVER_PAYLOAD_PROVIDER_PAYMENT_SHARE_BPS"],
    },
    {
      flags: "--entity-history-limit <count>",
      description:
        "Most-recent operations returned per /entity/:entityKey response. Defaults to 100 (or ENTITY_HISTORY_LIMIT).",
      env: ["ENTITY_HISTORY_LIMIT", "SERVER_ENTITY_HISTORY_LIMIT"],
      default: DEFAULT_ENTITY_HISTORY_LIMIT.toString(),
    },
    {
      flags: "--entity-cache-max-entries <count>",
      description:
        "Entity-history cache entry cap; 0 disables the cache. Defaults to 10000 (or ENTITY_CACHE_MAX_ENTRIES).",
      env: ["ENTITY_CACHE_MAX_ENTRIES", "SERVER_ENTITY_CACHE_MAX_ENTRIES"],
      default: DEFAULT_RESPONSE_CACHE_MAX_ENTRIES.toString(),
    },
    {
      flags: "--entity-cache-max-bytes <bytes>",
      description:
        "Entity-history cache total body-size cap in bytes; 0 disables the cache. Defaults to 67108864 (or ENTITY_CACHE_MAX_BYTES).",
      env: ["ENTITY_CACHE_MAX_BYTES", "SERVER_ENTITY_CACHE_MAX_BYTES"],
      default: DEFAULT_RESPONSE_CACHE_MAX_BYTES.toString(),
    },
    {
      flags: "--entity-cache-ttl-ms <ms>",
      description:
        "Entity-history cache entry lifetime in milliseconds — a staleness backstop behind NOTIFY invalidation; 0 disables the cache. Defaults to 300000 (or ENTITY_CACHE_TTL_MS).",
      env: ["ENTITY_CACHE_TTL_MS", "SERVER_ENTITY_CACHE_TTL_MS"],
      default: DEFAULT_RESPONSE_CACHE_TTL_MS.toString(),
    },
    {
      flags: "--sync-refresh-ms <ms>",
      description:
        "Periodic refresh for the precomputed /sync response, which also recomputes on every stored-block notification; 0 disables precomputing (each request hits storage). Defaults to 5000 (or SYNC_REFRESH_MS).",
      env: ["SYNC_REFRESH_MS", "SERVER_SYNC_REFRESH_MS"],
      default: DEFAULT_SYNC_REFRESH_MS.toString(),
    },
    {
      flags: "--list-cache-max-entries <count>",
      description:
        "Blocks/ranges response cache entry cap; 0 disables the cache. Defaults to 200 (or LIST_CACHE_MAX_ENTRIES).",
      env: ["LIST_CACHE_MAX_ENTRIES", "SERVER_LIST_CACHE_MAX_ENTRIES"],
      default: DEFAULT_LIST_CACHE_MAX_ENTRIES.toString(),
    },
    {
      flags: "--list-cache-max-bytes <bytes>",
      description:
        "Blocks/ranges response cache total body-size cap in bytes; 0 disables the cache. Defaults to 67108864 (or LIST_CACHE_MAX_BYTES).",
      env: ["LIST_CACHE_MAX_BYTES", "SERVER_LIST_CACHE_MAX_BYTES"],
      default: DEFAULT_LIST_CACHE_MAX_BYTES.toString(),
    },
    {
      flags: "--list-cache-ttl-ms <ms>",
      description:
        "Blocks/ranges response cache entry lifetime in milliseconds — a backstop behind the stored-block notification that clears the cache; 0 disables the cache. Defaults to 5000 (or LIST_CACHE_TTL_MS).",
      env: ["LIST_CACHE_TTL_MS", "SERVER_LIST_CACHE_TTL_MS"],
      default: DEFAULT_LIST_CACHE_TTL_MS.toString(),
    },
    {
      flags: "--transaction-count-cache-max-entries <count>",
      description:
        "Cache entry cap for /transactions pagination totals, keyed by filter; 0 disables the cache. Defaults to 500 (or TRANSACTION_COUNT_CACHE_MAX_ENTRIES).",
      env: ["TRANSACTION_COUNT_CACHE_MAX_ENTRIES", "SERVER_TRANSACTION_COUNT_CACHE_MAX_ENTRIES"],
      default: DEFAULT_TRANSACTION_COUNT_CACHE_MAX_ENTRIES.toString(),
    },
    {
      flags: "--transaction-count-cache-ttl-ms <ms>",
      description:
        "Lifetime of a cached /transactions total in milliseconds — a backstop behind the stored-block notification that clears the cache; 0 disables the cache. Defaults to 5000 (or TRANSACTION_COUNT_CACHE_TTL_MS).",
      env: ["TRANSACTION_COUNT_CACHE_TTL_MS", "SERVER_TRANSACTION_COUNT_CACHE_TTL_MS"],
      default: DEFAULT_TRANSACTION_COUNT_CACHE_TTL_MS.toString(),
    },
  ],
};

export function parseServerConfig(args: string[], env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const cli = parseCli(SPEC, args, env);

  if (cli.helpRequested) {
    throw new ServerHelpRequested(cli.helpText);
  }

  const databaseUrl = cli.value("database-url");
  if (!databaseUrl) {
    throw new Error("DATABASE_URL (or --database-url) is required");
  }

  const port = coercePort("--port", cli.value("port")!);
  const hostname = cli.value("host");
  const transactionDataEnabled = coerceBoolean(
    "--transaction-data-enabled",
    cli.value("transaction-data-enabled")!,
  );
  const baseloadAdminBearerToken = cli.value("baseload-admin-bearer-token");
  const baseloadInitialConfigPath = cli.value("baseload-initial-config");
  const redisUrl = cli.value("redis-url");
  const protocolScheduleUrl = cli.value("protocol-schedule-url");
  const protocolSchedulePath = cli.value("protocol-schedule-path");
  const payloadProviderPaymentShareBpsValue = cli.value("payload-provider-payment-share-bps");
  const payloadProviderPaymentShareBps = payloadProviderPaymentShareBpsValue
    ? coerceInt("--payload-provider-payment-share-bps", payloadProviderPaymentShareBpsValue)
    : undefined;
  if (
    payloadProviderPaymentShareBps !== undefined &&
    (payloadProviderPaymentShareBps < 0 || payloadProviderPaymentShareBps > 10_000)
  ) {
    throw new Error("--payload-provider-payment-share-bps must be between 0 and 10000");
  }
  // Compose-style `${VAR:-}` interpolation hands empty strings to unset env
  // vars; treat those as "use the default" instead of failing coercion.
  const intOrDefault = (flag: string, raw: string | undefined, fallback: number) =>
    raw ? coerceInt(flag, raw) : fallback;
  const entityHistoryLimit = intOrDefault(
    "--entity-history-limit",
    cli.value("entity-history-limit"),
    DEFAULT_ENTITY_HISTORY_LIMIT,
  );
  if (entityHistoryLimit < 1) {
    throw new Error("--entity-history-limit must be at least 1");
  }
  const entityCacheMaxEntries = intOrDefault(
    "--entity-cache-max-entries",
    cli.value("entity-cache-max-entries"),
    DEFAULT_RESPONSE_CACHE_MAX_ENTRIES,
  );
  const entityCacheMaxBytes = intOrDefault(
    "--entity-cache-max-bytes",
    cli.value("entity-cache-max-bytes"),
    DEFAULT_RESPONSE_CACHE_MAX_BYTES,
  );
  const entityCacheTtlMs = intOrDefault(
    "--entity-cache-ttl-ms",
    cli.value("entity-cache-ttl-ms"),
    DEFAULT_RESPONSE_CACHE_TTL_MS,
  );
  const syncRefreshMs = intOrDefault(
    "--sync-refresh-ms",
    cli.value("sync-refresh-ms"),
    DEFAULT_SYNC_REFRESH_MS,
  );
  const listCacheMaxEntries = intOrDefault(
    "--list-cache-max-entries",
    cli.value("list-cache-max-entries"),
    DEFAULT_LIST_CACHE_MAX_ENTRIES,
  );
  const listCacheMaxBytes = intOrDefault(
    "--list-cache-max-bytes",
    cli.value("list-cache-max-bytes"),
    DEFAULT_LIST_CACHE_MAX_BYTES,
  );
  const listCacheTtlMs = intOrDefault(
    "--list-cache-ttl-ms",
    cli.value("list-cache-ttl-ms"),
    DEFAULT_LIST_CACHE_TTL_MS,
  );
  const transactionCountCacheMaxEntries = intOrDefault(
    "--transaction-count-cache-max-entries",
    cli.value("transaction-count-cache-max-entries"),
    DEFAULT_TRANSACTION_COUNT_CACHE_MAX_ENTRIES,
  );
  const transactionCountCacheTtlMs = intOrDefault(
    "--transaction-count-cache-ttl-ms",
    cli.value("transaction-count-cache-ttl-ms"),
    DEFAULT_TRANSACTION_COUNT_CACHE_TTL_MS,
  );

  return {
    databaseUrl,
    port,
    ...(hostname ? { hostname } : {}),
    transactionDataEnabled,
    ...(baseloadAdminBearerToken ? { baseloadAdminBearerToken } : {}),
    ...(baseloadInitialConfigPath ? { baseloadInitialConfigPath } : {}),
    ...(redisUrl ? { redisUrl } : {}),
    ...(protocolScheduleUrl ? { protocolScheduleUrl } : {}),
    ...(protocolSchedulePath ? { protocolSchedulePath } : {}),
    ...(payloadProviderPaymentShareBps !== undefined ? { payloadProviderPaymentShareBps } : {}),
    entityHistoryLimit,
    entityCacheMaxEntries,
    entityCacheMaxBytes,
    entityCacheTtlMs,
    syncRefreshMs,
    listCacheMaxEntries,
    listCacheMaxBytes,
    listCacheTtlMs,
    transactionCountCacheMaxEntries,
    transactionCountCacheTtlMs,
  };
}
