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
      "Effective fee (gwei)",
      "Tx fee (ETH)",
    ]);
  });

  test("does not repeat the active fee metric for fee records", () => {
    expect(recordColumnLabelsForCategory("transaction_fee", "ETH")).toEqual([
      "Rank",
      "Fee paid (ETH)",
      "Block",
      "Hash",
      "From",
      "Gas used",
      "Effective fee (gwei)",
    ]);

    expect(recordColumnLabelsForCategory("effective_fee", "ETH")).toEqual([
      "Rank",
      "Effective fee (gwei)",
      "Block",
      "Hash",
      "From",
      "Gas used",
      "Tx fee (ETH)",
    ]);
  });
});
