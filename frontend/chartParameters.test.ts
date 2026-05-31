import { describe, expect, test } from "bun:test";
import { getAvailableParameters, parseSelectedParameters } from "./src/chartParameters";

describe("frontend chart parameters", () => {
  test("keeps batcher parameters available by default", () => {
    const keys = getAvailableParameters(false).map((parameter) => parameter.key);

    expect(keys).toContain("averageBatcherQueueSize");
  });

  test("removes batcher parameters when no batcher is configured", () => {
    const parameters = getAvailableParameters(true);
    const keys = parameters.map((parameter) => parameter.key);

    expect(keys).not.toContain("averageBatcherQueueSize");
    expect(parseSelectedParameters("averageBatcherQueueSize,averageBaseFeeWei", parameters)).toEqual([
      "averageBaseFeeWei",
    ]);
  });

  test("falls back to default chart parameters when hidden batcher parameters are the only selection", () => {
    const parameters = getAvailableParameters(true);

    expect(parseSelectedParameters("averageBatcherQueueSize", parameters)).toEqual([
      "averageBaseFeeWei",
      "averagePriorityFeeWei",
    ]);
  });
});
