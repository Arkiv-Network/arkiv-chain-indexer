import {
  CliHelpRequested,
  coerceBoolean,
  coerceInt,
  coercePort,
  parseCli,
  type CliSpec,
} from "./cli";

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
}

const DEFAULT_PORT = 3000;

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
  };
}
