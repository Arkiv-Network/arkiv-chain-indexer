import { describe, expect, test } from "bun:test";
import { parseServerConfig, ServerHelpRequested } from "./serverConfig";

const TEST_URL = "postgres://user:pass@localhost:5432/test";
const BASE_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: TEST_URL,
};

describe("parseServerConfig", () => {
  test("applies defaults", () => {
    const config = parseServerConfig([], BASE_ENV);
    expect(config.databaseUrl).toBe(TEST_URL);
    expect(config.port).toBe(3000);
    expect(config.hostname).toBeUndefined();
  });

  test("requires DATABASE_URL", () => {
    expect(() => parseServerConfig([], {})).toThrow(
      "DATABASE_URL (or --database-url) is required",
    );
  });

  test("reads from environment variables", () => {
    const config = parseServerConfig([], {
      DATABASE_URL: "postgres://envhost/db",
      SERVER_PORT: "4500",
      SERVER_HOSTNAME: "0.0.0.0",
      SCANNER_RPC_FULL_NODE: "https://rpc.example",
    });
    expect(config.databaseUrl).toBe("postgres://envhost/db");
    expect(config.port).toBe(4500);
    expect(config.hostname).toBe("0.0.0.0");
    expect(config.rpcUrl).toBe("https://rpc.example");
  });

  test("CLI flags override environment", () => {
    const config = parseServerConfig(
      [
        "--database-url",
        "postgres://cli/db",
        "--port",
        "7000",
        "--host",
        "127.0.0.1",
        "--rpc-url",
        "https://rpc.cli",
      ],
      {
        DATABASE_URL: "postgres://env/db",
        SERVER_PORT: "1234",
        SCANNER_RPC_FULL_NODE: "https://rpc.env",
      },
    );
    expect(config.databaseUrl).toBe("postgres://cli/db");
    expect(config.port).toBe(7000);
    expect(config.hostname).toBe("127.0.0.1");
    expect(config.rpcUrl).toBe("https://rpc.cli");
  });

  test("rejects an invalid port", () => {
    expect(() => parseServerConfig(["--port", "abc"], BASE_ENV)).toThrow();
    expect(() => parseServerConfig(["--port", "70000"], BASE_ENV)).toThrow();
  });

  test("--help raises ServerHelpRequested", () => {
    expect(() => parseServerConfig(["--help"], BASE_ENV)).toThrow(ServerHelpRequested);
  });
});
