import { expect, test } from "bun:test";
import { STATISTICS_PERIODS } from "../src/indexerStatisticsTypes";
import { isStatisticsPeriod, selectStatisticsActivity } from "./src/statisticsPeriods";
import { statisticsFixture } from "./testStatistics";

test("selects each supported snapshot period while keeping current entity state independent", () => {
  const data = statisticsFixture();
  const originalEntity = structuredClone(data.entities);
  for (const { id } of STATISTICS_PERIODS) {
    expect(isStatisticsPeriod(id)).toBe(true);
    expect(selectStatisticsActivity(data, id)).toBe(data.windows![id]);
    expect(data.entities).toEqual(originalEntity);
  }
  expect(isStatisticsPeriod("3h")).toBe(false);
  expect(isStatisticsPeriod("7days")).toBe(false);
  expect(selectStatisticsActivity(data, "1h")!.blocks.indexed).toBe("1");
  expect(selectStatisticsActivity(data, "all")!.blocks.inputBytes).toBe("9007199254740993");
});

test("old snapshots expose their original all-time totals and unavailable periods are not zeros", () => {
  const data = statisticsFixture();
  delete data.windows;
  expect(selectStatisticsActivity(data, "all")).toEqual({
    fromInclusiveUtc: null, toExclusiveUtc: null,
    blocks: data.blocks, transactions: data.transactions, operations: data.operations,
  });
  expect(selectStatisticsActivity(data, "1h")).toBeNull();
  data.windows = statisticsFixture().windows!;
  data.windows["1h"].blocks.indexed = "0";
  expect(selectStatisticsActivity(data, "1h")!.blocks.indexed).toBe("0");
});
