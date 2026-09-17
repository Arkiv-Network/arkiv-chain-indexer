import { describe, expect, test } from "bun:test";
import {
  createBaseloadWorkerDraftFromWorker,
  createBaseloadWorkerFromDraft,
  describeBaseloadWorkerName,
  isSameBaseloadWorkerDraft,
  normalizeBaseloadConfig,
  parseBaseloadWorkerJson,
  serializeBaseloadWorker,
} from "./src/baseloadConfig";

describe("single worker import/export", () => {
  const worker = normalizeBaseloadConfig({
    workers: [{ walletNumber: 3, name: "Night shift", dailyWindow: "22-6", hourlyWindow: "0-30" }],
  }).workers[0];

  test("round-trips a worker through JSON", () => {
    expect(parseBaseloadWorkerJson(serializeBaseloadWorker(worker))).toEqual(worker);
  });

  test("accepts a one-worker config and rejects fleets", () => {
    const wrapped = JSON.stringify({ version: 2, workers: [worker] });
    expect(parseBaseloadWorkerJson(wrapped)).toEqual(worker);
    expect(() =>
      parseBaseloadWorkerJson(JSON.stringify({ workers: [worker, { ...worker, walletNumber: 4 }] })),
    ).toThrow("holds 2 workers");
    expect(() => parseBaseloadWorkerJson("nope")).toThrow("not valid JSON");
  });

  test("draft round-trips a worker and detects edits", () => {
    const draft = createBaseloadWorkerDraftFromWorker(worker);
    expect(draft.dailyWindow).toBe("22:00-06:00");
    expect(createBaseloadWorkerFromDraft(draft)).toEqual({ ...worker, walletAddress: "" });
    expect(isSameBaseloadWorkerDraft(draft, { ...draft })).toBe(true);
    expect(isSameBaseloadWorkerDraft(draft, { ...draft, name: "Day shift" })).toBe(false);
  });

  test("falls back to the wallet when unnamed", () => {
    expect(describeBaseloadWorkerName(worker)).toBe("Night shift");
    expect(describeBaseloadWorkerName({ name: "", walletNumber: 9 })).toBe("wallet #9");
  });
});
