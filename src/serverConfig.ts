export interface ServerConfig {
  databaseUrl: string;
  port: number;
  hostname?: string;
  transactionDataEnabled: boolean;
  baseloadAdminBearerToken?: string;
}

const DEFAULT_PORT = 3000;

export class ServerHelpRequested extends Error {}

export function parseServerConfig(args: string[], env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = parseArgs(args);

  if (parsed.help) {
    throw new ServerHelpRequested(usage());
  }

  const databaseUrl =
    parsed.values["database-url"] ?? env.DATABASE_URL ?? env.SCANNER_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL (or --database-url) is required");
  }
  const portRaw = parsed.values.port ?? env.SERVER_PORT ?? DEFAULT_PORT.toString();
  const port = parsePortOption("--port", portRaw);
  const hostnameRaw = parsed.values.host ?? env.SERVER_HOSTNAME;
  const transactionDataEnabled = parseBooleanOption(
    "--transaction-data-enabled",
    parsed.values["transaction-data-enabled"] ??
      env.SERVER_TRANSACTION_DATA_ENABLED ??
      env.SAVE_TRANSACTION_DATA ??
      "true",
  );
  const baseloadAdminBearerToken =
    parsed.values["baseload-admin-bearer-token"] ?? env.BASELOAD_ADMIN_BEARER_TOKEN;

  return {
    databaseUrl,
    port,
    ...(hostnameRaw ? { hostname: hostnameRaw } : {}),
    transactionDataEnabled,
    ...(baseloadAdminBearerToken ? { baseloadAdminBearerToken } : {}),
  };
}

interface ParsedArgs {
  help: boolean;
  values: Record<string, string>;
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = { help: false, values: {} };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg?.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    if (!rawKey) {
      throw new Error(`Invalid argument: ${arg}`);
    }

    if (rawKey === "help") {
      result.help = true;
      continue;
    }

    const value = inlineValue ?? args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${rawKey}`);
    }

    result.values[rawKey] = value;
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return result;
}

function parsePortOption(name: string, value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`${name} must be between 0 and 65535`);
  }

  return parsed;
}

function parseBooleanOption(name: string, value: string): boolean {
  const normalized = value.toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean`);
}

function usage(): string {
  return `Usage:
  DATABASE_URL=postgres://user:pass@host:5432/db bun run serve

Options:
  --database-url <url>  PostgreSQL connection string (or DATABASE_URL env).
  --port <port>         TCP port to listen on. Defaults to 3000 (or SERVER_PORT). Use 0 to pick any free port.
  --host <host>         Hostname/interface to bind. Defaults to Bun's default (all interfaces).
  --transaction-data-enabled <bool>
                        Enable transaction inspection endpoints and UI capability metadata. Defaults to true (or SERVER_TRANSACTION_DATA_ENABLED / SAVE_TRANSACTION_DATA).
  --baseload-admin-bearer-token <token>
                        Bearer token required for mutating Baseload worker requests. Defaults to BASELOAD_ADMIN_BEARER_TOKEN. If unset, Baseload mutations are unrestricted.
  --help                Show this message.`;
}
