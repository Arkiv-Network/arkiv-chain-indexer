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
    expect(config.transactionDataEnabled).toBe(true);
    expect(config.baseloadAdminBearerToken).toBeUndefined();
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
      SAVE_TRANSACTION_DATA: "false",
      BASELOAD_ADMIN_BEARER_TOKEN: "env-secret",
    });
    expect(config.databaseUrl).toBe("postgres://envhost/db");
    expect(config.port).toBe(4500);
    expect(config.hostname).toBe("0.0.0.0");
    expect(config.transactionDataEnabled).toBe(false);
    expect(config.baseloadAdminBearerToken).toBe("env-secret");
  });

  test("server-specific transaction data flag overrides shared env", () => {
    const config = parseServerConfig([], {
      DATABASE_URL: "postgres://envhost/db",
      SAVE_TRANSACTION_DATA: "false",
      SERVER_TRANSACTION_DATA_ENABLED: "true",
    });
    expect(config.transactionDataEnabled).toBe(true);
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
        "--transaction-data-enabled",
        "false",
        "--baseload-admin-bearer-token",
        "cli-secret",
      ],
      {
        DATABASE_URL: "postgres://env/db",
        SERVER_PORT: "1234",
        SERVER_TRANSACTION_DATA_ENABLED: "true",
        BASELOAD_ADMIN_BEARER_TOKEN: "env-secret",
      },
    );
    expect(config.databaseUrl).toBe("postgres://cli/db");
    expect(config.port).toBe(7000);
    expect(config.hostname).toBe("127.0.0.1");
    expect(config.transactionDataEnabled).toBe(false);
    expect(config.baseloadAdminBearerToken).toBe("cli-secret");
  });

  test("rejects an invalid port", () => {
    expect(() => parseServerConfig(["--port", "abc"], BASE_ENV)).toThrow();
    expect(() => parseServerConfig(["--port", "70000"], BASE_ENV)).toThrow();
  });

  test("rejects invalid transaction data flag", () => {
    expect(() =>
      parseServerConfig([], {
        DATABASE_URL: TEST_URL,
        SAVE_TRANSACTION_DATA: "maybe",
      }),
    ).toThrow("--transaction-data-enabled must be a boolean");
  });

  test("--help raises ServerHelpRequested", () => {
    expect(() => parseServerConfig(["--help"], BASE_ENV)).toThrow(ServerHelpRequested);
  });
});
