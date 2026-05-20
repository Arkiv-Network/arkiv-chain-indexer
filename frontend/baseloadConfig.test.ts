import { describe, expect, test } from "bun:test";
import {
  DEFAULT_BASELOAD_WORKER_VALUES,
  createBaseloadWorkerDraft,
  createBaseloadWorkerFromDraft,
  getAvailableWalletNumbers,
  moveDraftToNextAvailableWallet,
  normalizeBaseloadConfig,
  parseBaseloadConfigJson,
  serializeBaseloadConfig,
} from "./src/baseloadConfig";

describe("baseload config helpers", () => {
  test("creates a worker from the UI draft with expected defaults", () => {
    const draft = createBaseloadWorkerDraft(7);
    const worker = createBaseloadWorkerFromDraft(draft);

    expect(worker).toEqual({
      id: "wallet-7",
      maxGasPriceGwei: DEFAULT_BASELOAD_WORKER_VALUES.maxGasPriceGwei,
      createsPerMinute: 1,
      singleCreatePayloadSize: 5000,
      singleCreateStringArgumentCount: 2,
      singleCreateNumberArgumentCount: 2,
      walletNumber: 7,
      walletAddress: "",
      startBlock: 0,
      endBlock: null,
      durationSeconds: null,
      ttlSeconds: 3600,
    });
  });

  test("normalizes imported configs and fills missing optional values", () => {
    const config = normalizeBaseloadConfig({
      workers: [
        {
          walletNumber: "1",
          maxGasPriceGwei: "5.5",
          createsPerMinute: "2.25",
          singleCreatePayloadSize: "100",
          singleCreateStringArgumentCount: "3",
          singleCreateNumberArgumentCount: "4",
          startBlock: "10",
          endBlock: "20",
          durationSeconds: "60",
          ttlSeconds: "120",
        },
      ],
    });

    expect(config).toEqual({
      version: 1,
      workers: [
        {
          id: "wallet-1",
          maxGasPriceGwei: 5.5,
          createsPerMinute: 2.25,
          singleCreatePayloadSize: 100,
          singleCreateStringArgumentCount: 3,
          singleCreateNumberArgumentCount: 4,
          walletNumber: 1,
          walletAddress: "",
          startBlock: 10,
          endBlock: 20,
          durationSeconds: 60,
          ttlSeconds: 120,
        },
      ],
    });
  });

  test("fills the default TTL for older configs", () => {
    const config = normalizeBaseloadConfig({
      workers: [{ walletNumber: 0 }],
    });

    expect(config.workers[0].ttlSeconds).toBe(3600);
  });

  test("rejects duplicate wallets", () => {
    expect(() =>
      normalizeBaseloadConfig({
        workers: [
          { walletNumber: 2 },
          { walletNumber: 2 },
        ],
      }),
    ).toThrow("Wallet 2 is already attached");
  });

  test("hides already attached wallets from the available list", () => {
    const config = normalizeBaseloadConfig({
      workers: [{ walletNumber: 0 }, { walletNumber: 3 }, { walletNumber: 100 }],
    });

    const wallets = getAvailableWalletNumbers(config.workers);

    expect(wallets).not.toContain(0);
    expect(wallets).not.toContain(3);
    expect(wallets).not.toContain(100);
    expect(wallets[0]).toBe(1);
    expect(wallets.at(-1)).toBe(99);
  });

  test("defaults a new draft to the smallest available wallet", () => {
    const config = normalizeBaseloadConfig({
      workers: [{ walletNumber: 1 }, { walletNumber: 2 }],
    });

    const draft = createBaseloadWorkerDraft(getAvailableWalletNumbers(config.workers)[0] ?? 0);

    expect(draft.walletNumber).toBe("0");
  });

  test("moves a draft to the next available wallet without resetting values", () => {
    const draft = {
      ...createBaseloadWorkerDraft(0),
      maxGasPriceGwei: "7.5",
      createsPerMinute: "11",
      singleCreatePayloadSize: "2048",
      singleCreateStringArgumentCount: "5",
      singleCreateNumberArgumentCount: "6",
      startBlock: "123",
      endBlock: "456",
      durationSeconds: "789",
      ttlSeconds: "321",
    };
    const config = normalizeBaseloadConfig({
      workers: [{ walletNumber: 0 }, { walletNumber: 2 }],
    });

    expect(moveDraftToNextAvailableWallet(draft, config.workers)).toEqual({
      ...draft,
      walletNumber: "1",
    });
  });

  test("serializes a stable downloadable JSON configuration", () => {
    const config = parseBaseloadConfigJson(
      JSON.stringify({
        workers: [{ walletNumber: 4 }],
      }),
    );

    expect(JSON.parse(serializeBaseloadConfig(config))).toEqual({
      version: 1,
      workers: [
        {
          id: "wallet-4",
          maxGasPriceGwei: DEFAULT_BASELOAD_WORKER_VALUES.maxGasPriceGwei,
          createsPerMinute: 1,
          singleCreatePayloadSize: 5000,
          singleCreateStringArgumentCount: 2,
          singleCreateNumberArgumentCount: 2,
          walletNumber: 4,
          walletAddress: "",
          startBlock: 0,
          endBlock: null,
          durationSeconds: null,
          ttlSeconds: 3600,
        },
      ],
    });
  });
});
