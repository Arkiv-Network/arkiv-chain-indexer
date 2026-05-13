export interface ServerConfig {
  dbPath: string;
  port: number;
  hostname?: string;
}

const DEFAULT_DB_PATH = "scanner.sqlite";
const DEFAULT_PORT = 3000;

export class ServerHelpRequested extends Error {}

export function parseServerConfig(args: string[], env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = parseArgs(args);

  if (parsed.help) {
    throw new ServerHelpRequested(usage());
  }

  const dbPath = parsed.values.db ?? env.SCANNER_DB_PATH ?? DEFAULT_DB_PATH;
  const portRaw = parsed.values.port ?? env.SERVER_PORT ?? DEFAULT_PORT.toString();
  const port = parsePortOption("--port", portRaw);
  const hostnameRaw = parsed.values.host ?? env.SERVER_HOSTNAME;

  return {
    dbPath,
    port,
    ...(hostnameRaw ? { hostname: hostnameRaw } : {}),
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
  bun run serve

Options:
  --db <path>     SQLite database path. Defaults to scanner.sqlite (or SCANNER_DB_PATH).
  --port <port>   TCP port to listen on. Defaults to 3000 (or SERVER_PORT). Use 0 to pick any free port.
  --host <host>   Hostname/interface to bind. Defaults to Bun's default (all interfaces).
  --help          Show this message.`;
}
