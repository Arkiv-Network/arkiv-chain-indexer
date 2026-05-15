export interface ServerConfig {
  databaseUrl: string;
  port: number;
  hostname?: string;
  rpcUrl?: string;
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
  const rpcUrl = parsed.values["rpc-url"] ?? env.SCANNER_RPC_FULL_NODE;

  return {
    databaseUrl,
    port,
    ...(hostnameRaw ? { hostname: hostnameRaw } : {}),
    ...(rpcUrl ? { rpcUrl } : {}),
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

function usage(): string {
  return `Usage:
  DATABASE_URL=postgres://user:pass@host:5432/db bun run serve

Options:
  --database-url <url>  PostgreSQL connection string (or DATABASE_URL env).
  --port <port>         TCP port to listen on. Defaults to 3000 (or SERVER_PORT). Use 0 to pick any free port.
  --host <host>         Hostname/interface to bind. Defaults to Bun's default (all interfaces).
  --rpc-url <url>       Optional Ethereum JSON-RPC endpoint for on-demand block inspection.
  --help                Show this message.`;
}
