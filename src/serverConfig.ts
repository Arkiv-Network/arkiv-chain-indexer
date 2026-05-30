import { CliHelpRequested, coerceBoolean, coercePort, parseCli, type CliSpec } from "./cli";

export interface ServerConfig {
  databaseUrl: string;
  port: number;
  hostname?: string;
  transactionDataEnabled: boolean;
  baseloadAdminBearerToken?: string;
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

  return {
    databaseUrl,
    port,
    ...(hostname ? { hostname } : {}),
    transactionDataEnabled,
    ...(baseloadAdminBearerToken ? { baseloadAdminBearerToken } : {}),
  };
}
