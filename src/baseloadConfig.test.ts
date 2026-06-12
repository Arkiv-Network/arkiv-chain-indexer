import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBaseloadWorkerDraft,
  createBaseloadWorkerFromDraft,
  deriveBaseloadWalletAddress,
  normalizeBaseloadConfig,
  readBaseloadConfigFile,
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
    expect(worker.behavior).toBe("create");
    expect(worker.entityPoolSize).toBe(10);
    expect(worker.timeBombOffsetSeconds).toBe(600);
  });

  test("normalizes imported configs and rejects duplicate wallets", () => {
    const config = normalizeBaseloadConfig({
      workers: [{ walletNumber: 0 }, { walletNumber: 1 }],
    });

    expect(config.workers.map((worker) => worker.walletAddress)).toEqual([
      "0x1e8254Ecb29AC73De90F02066A35b27f75FD5654",
      "0x8C59ca3A3BF65F5C530Eb5Ea67F2bd4b37049cf2",
    ]);
    expect(() => normalizeBaseloadConfig({ workers: [{ walletNumber: 2 }, { walletNumber: 2 }] })).toThrow(
      "Wallet 2 is already attached",
    );
  });

  test("normalizes worker behaviors and rejects unknown values", () => {
    const config = normalizeBaseloadConfig({
      workers: [
        { walletNumber: 0, behavior: "time-bomb", timeBombOffsetSeconds: 120 },
        { walletNumber: 1, behavior: "create-update-delete", entityPoolSize: 4 },
        { walletNumber: 2 },
      ],
    });

    expect(config.workers.map((worker) => worker.behavior)).toEqual([
      "time-bomb",
      "create-update-delete",
      "create",
    ]);
    expect(config.workers[0]?.timeBombOffsetSeconds).toBe(120);
    expect(config.workers[1]?.entityPoolSize).toBe(4);
    expect(() =>
      normalizeBaseloadConfig({ workers: [{ walletNumber: 0, behavior: "explode" }] }),
    ).toThrow("Worker behavior must be one of");
    expect(() =>
      normalizeBaseloadConfig({ workers: [{ walletNumber: 0, entityPoolSize: 0 }] }),
    ).toThrow("Entity pool size must be at least 1");
  });

  test("reads backend baseload runtime settings from env", () => {
    expect(
      parseBaseloadRuntimeConfig({
        BASELOAD_RPC_NODE: " https://rpc.example.test ",
        BASELOAD_MNEMONIC: " test test test test test test test test test test test junk ",
      }).rpcUrl,
    ).toBe("https://rpc.example.test");
  });

  test("reads initial baseload config files with backend normalization", async () => {
    const dir = await mkdtemp(join(tmpdir(), "baseload-config-"));
    try {
      const path = join(dir, "config.json");
      await writeFile(path, JSON.stringify({ workers: [{ walletNumber: 3 }] }), "utf8");

      const config = await readBaseloadConfigFile(path);

      expect(config.workers).toHaveLength(1);
      expect(config.workers[0]?.id).toBe("wallet-3");
      expect(config.workers[0]?.opsPerMinute).toBe(1);
      expect(config.workers[0]?.behavior).toBe("create");
      expect(config.workers[0]?.walletAddress).toBe(deriveBaseloadWalletAddress(3));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reports initial baseload config file path failures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "baseload-config-"));
    try {
      const missingPath = join(dir, "missing.json");
      await expect(readBaseloadConfigFile(missingPath)).rejects.toThrow(
        `Unable to read Baseload config file at ${missingPath}`,
      );

      const invalidPath = join(dir, "invalid.json");
      await writeFile(invalidPath, "{", "utf8");
      await expect(readBaseloadConfigFile(invalidPath)).rejects.toThrow(
        `Invalid Baseload config file at ${invalidPath}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
