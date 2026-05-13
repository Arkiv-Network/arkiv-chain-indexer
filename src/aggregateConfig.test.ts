import { describe, expect, test } from "bun:test";
import {
  AggregateHelpRequested,
  parseAggregateConfig,
} from "./aggregateConfig";

const EMPTY_ENV: NodeJS.ProcessEnv = {};

describe("parseAggregateConfig", () => {
  test("requires --range", () => {
    expect(() => parseAggregateConfig([], EMPTY_ENV)).toThrow(/--range is required/);
  });

  test("parses --range from args", () => {
    const config = parseAggregateConfig(["--range", "50"], EMPTY_ENV);
    expect(config.rangeSize).toBe(50n);
    expect(config.dbPath).toBe("scanner.sqlite");
    expect(config.fromBlock).toBeUndefined();
    expect(config.toBlock).toBeUndefined();
  });

  test("accepts --range and --db together", () => {
    const config = parseAggregateConfig(
      ["--range", "100", "--db", "/tmp/x.sqlite"],
      EMPTY_ENV,
    );
    expect(config.rangeSize).toBe(100n);
    expect(config.dbPath).toBe("/tmp/x.sqlite");
  });

  test("accepts --from-block and --to-block", () => {
    const config = parseAggregateConfig(
      ["--range", "10", "--from-block", "100", "--to-block", "200"],
      EMPTY_ENV,
    );
    expect(config.fromBlock).toBe(100n);
    expect(config.toBlock).toBe(200n);
  });

  test("falls back to env vars", () => {
    const config = parseAggregateConfig([], {
      AGGREGATE_RANGE: "500",
      SCANNER_DB_PATH: "/tmp/env.sqlite",
    } as NodeJS.ProcessEnv);
    expect(config.rangeSize).toBe(500n);
    expect(config.dbPath).toBe("/tmp/env.sqlite");
  });

  test("rejects unsupported range sizes", () => {
    expect(() => parseAggregateConfig(["--range", "7"], EMPTY_ENV)).toThrow();
  });

  test("--help throws AggregateHelpRequested with usage text", () => {
    expect(() => parseAggregateConfig(["--help"], EMPTY_ENV)).toThrow(
      AggregateHelpRequested,
    );
  });
});
