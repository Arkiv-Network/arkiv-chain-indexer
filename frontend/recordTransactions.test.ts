import { describe, expect, test } from "bun:test";
import { recordColumnLabelsForCategory } from "./src/RecordTransactionsView";

describe("record transaction table columns", () => {
  test("does not repeat gas used for the maximum gas used record", () => {
    expect(recordColumnLabelsForCategory("gas_used", "ETH")).toEqual([
      "Rank",
      "Gas used",
      "Block",
      "Hash",
      "From",
      "Effective fee",
      "Tx fee",
    ]);
  });

  test("does not repeat the active fee metric for fee records", () => {
    expect(recordColumnLabelsForCategory("transaction_fee", "ETH")).toEqual([
      "Rank",
      "Fee paid",
      "Block",
      "Hash",
      "From",
      "Gas Used",
      "Effective fee",
    ]);

    expect(recordColumnLabelsForCategory("effective_fee", "ETH")).toEqual([
      "Rank",
      "Effective fee",
      "Block",
      "Hash",
      "From",
      "Gas Used",
      "Tx fee",
    ]);
  });
});
