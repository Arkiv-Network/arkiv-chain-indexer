import { describe, expect, test } from "bun:test";
import {
  AggregateHelpRequested,
  parseAggregateConfig,
} from "./aggregateConfig";

const TEST_URL = "postgres://user:pass@localhost:5432/test";
const BASE_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: TEST_URL,
};

describe("parseAggregateConfig", () => {
  test("requires --range", () => {
    expect(() => parseAggregateConfig([], BASE_ENV)).toThrow(/--range is required/);
  });

  test("requires DATABASE_URL", () => {
    expect(() => parseAggregateConfig(["--range", "50"], {})).toThrow(
      "DATABASE_URL (or --database-url) is required",
    );
  });

  test("parses --range from args", () => {
    const config = parseAggregateConfig(["--range", "50"], BASE_ENV);
    expect(config.rangeSize).toBe(50n);
    expect(config.databaseUrl).toBe(TEST_URL);
    expect(config.fromBlock).toBeUndefined();
    expect(config.toBlock).toBeUndefined();
  });

  test("accepts --range and --database-url together", () => {
    const config = parseAggregateConfig(
      ["--range", "100", "--database-url", "postgres://x"],
      {},
    );
    expect(config.rangeSize).toBe(100n);
    expect(config.databaseUrl).toBe("postgres://x");
  });

  test("accepts --from-block and --to-block", () => {
    const config = parseAggregateConfig(
      ["--range", "10", "--from-block", "100", "--to-block", "200"],
      BASE_ENV,
    );
    expect(config.fromBlock).toBe(100n);
    expect(config.toBlock).toBe(200n);
  });

  test("falls back to env vars", () => {
    const config = parseAggregateConfig([], {
      AGGREGATE_RANGE: "500",
      DATABASE_URL: "postgres://env-host/db",
    } as NodeJS.ProcessEnv);
    expect(config.rangeSize).toBe(500n);
    expect(config.databaseUrl).toBe("postgres://env-host/db");
  });

  test("rejects unsupported range sizes", () => {
    expect(() => parseAggregateConfig(["--range", "7"], BASE_ENV)).toThrow();
  });

  test("--help throws AggregateHelpRequested with usage text", () => {
    expect(() => parseAggregateConfig(["--help"], BASE_ENV)).toThrow(
      AggregateHelpRequested,
    );
  });
});
