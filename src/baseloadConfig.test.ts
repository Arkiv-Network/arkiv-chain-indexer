import { describe, expect, test } from "bun:test";
import {
  createBaseloadWorkerDraft,
  createBaseloadWorkerFromDraft,
  deriveBaseloadWalletAddress,
  normalizeBaseloadConfig,
  parseBaseloadRuntimeConfig,
} from "./baseloadConfig";

describe("backend baseload config", () => {
  test("derives deterministic backend wallet addresses", () => {
    expect(deriveBaseloadWalletAddress(7)).toBe("0x15cf3D9b2F65Ef7fb29643c7a73C737C44e69D19");
  });

  test("creates workers from UI drafts with backend-derived addresses", () => {
    const worker = createBaseloadWorkerFromDraft(createBaseloadWorkerDraft(1));

    expect(worker.walletNumber).toBe(1);
    expect(worker.walletAddress).toBe("0x8C59ca3A3BF65F5C530Eb5Ea67F2bd4b37049cf2");
  });

  test("normalizes imported configs and rejects duplicate wallets", () => {
    const config = normalizeBaseloadConfig({
      workers: [{ walletNumber: 0 }, { walletNumber: 1 }],
    });

    expect(config.workers.map((worker) => worker.walletAddress)).toEqual([
      "0x638f7fAF81F9449CF7d5487329b4eB8fb5fA96b3",
      "0x8C59ca3A3BF65F5C530Eb5Ea67F2bd4b37049cf2",
    ]);
    expect(() => normalizeBaseloadConfig({ workers: [{ walletNumber: 2 }, { walletNumber: 2 }] })).toThrow(
      "Wallet 2 is already attached",
    );
  });

  test("reads backend baseload runtime settings from env", () => {
    expect(
      parseBaseloadRuntimeConfig({
        BASELOAD_RPC_NODE: " https://rpc.example.test ",
        BASELOAD_MNEMONIC: " test test test test test test test test test test test junk ",
      }).rpcUrl,
    ).toBe("https://rpc.example.test");
  });
});
