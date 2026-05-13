import { describe, expect, test } from "bun:test";
import { parseServerConfig, ServerHelpRequested } from "./serverConfig";

describe("parseServerConfig", () => {
  test("applies defaults", () => {
    const config = parseServerConfig([], {});
    expect(config.dbPath).toBe("scanner.sqlite");
    expect(config.port).toBe(3000);
    expect(config.hostname).toBeUndefined();
  });

  test("reads from environment variables", () => {
    const config = parseServerConfig([], {
      SCANNER_DB_PATH: "/tmp/foo.sqlite",
      SERVER_PORT: "4500",
      SERVER_HOSTNAME: "0.0.0.0",
    });
    expect(config.dbPath).toBe("/tmp/foo.sqlite");
    expect(config.port).toBe(4500);
    expect(config.hostname).toBe("0.0.0.0");
  });

  test("CLI flags override environment", () => {
    const config = parseServerConfig(["--db", "/tmp/x.sqlite", "--port", "7000", "--host", "127.0.0.1"], {
      SERVER_PORT: "1234",
    });
    expect(config.dbPath).toBe("/tmp/x.sqlite");
    expect(config.port).toBe(7000);
    expect(config.hostname).toBe("127.0.0.1");
  });

  test("rejects an invalid port", () => {
    expect(() => parseServerConfig(["--port", "abc"], {})).toThrow();
    expect(() => parseServerConfig(["--port", "70000"], {})).toThrow();
  });

  test("--help raises ServerHelpRequested", () => {
    expect(() => parseServerConfig(["--help"], {})).toThrow(ServerHelpRequested);
  });
});
