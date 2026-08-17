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
    expect(worker.entitiesPerRequest).toBe(1);
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
        {
          walletNumber: 1,
          behavior: "create-update-delete",
          entitiesPerRequest: 3,
          entityPoolSize: 4,
        },
        { walletNumber: 2 },
      ],
    });

    expect(config.workers.map((worker) => worker.behavior)).toEqual([
      "time-bomb",
      "create-update-delete",
      "create",
    ]);
    expect(config.workers[0]?.timeBombOffsetSeconds).toBe(120);
    expect(config.workers[1]?.entitiesPerRequest).toBe(3);
    expect(config.workers[1]?.entityPoolSize).toBe(4);
    expect(() =>
      normalizeBaseloadConfig({ workers: [{ walletNumber: 0, behavior: "explode" }] }),
    ).toThrow("Worker behavior must be one of");
    expect(() =>
      normalizeBaseloadConfig({ workers: [{ walletNumber: 0, entityPoolSize: 0 }] }),
    ).toThrow("Entity pool size must be at least 1");
    expect(() =>
      normalizeBaseloadConfig({ workers: [{ walletNumber: 0, entitiesPerRequest: 0 }] }),
    ).toThrow("Entities per request must be at least 1");
  });

  test("reads backend baseload runtime settings from env", () => {
    const config = parseBaseloadRuntimeConfig({
      BASELOAD_RPC_NODE: " https://rpc.example.test ",
      BASELOAD_MNEMONIC: " test test test test test test test test test test test junk ",
      BASELOAD_PAYLOAD_PROVIDER_URL: " https://payload.example.test/ ",
      BASELOAD_PAYLOAD_PROVIDER_BEARER_KEY: " submit-secret ",
      BASELOAD_PAYLOAD_PROVIDER_NAMESPACE: " atlas.test ",
      BASELOAD_PAYLOAD_PROVIDER_VERIFY_RECEIPT: " false ",
    });

    expect(config.rpcUrl).toBe("https://rpc.example.test");
    expect(config.mnemonic).toBe("test test test test test test test test test test test junk");
    expect(config.payloadProvider).toEqual({
      url: "https://payload.example.test/",
      bearerKey: "submit-secret",
      namespace: "atlas.test",
      verifyReceipt: false,
    });
  });

  test("defaults backend baseload payload provider settings when only url is set", () => {
    expect(
      parseBaseloadRuntimeConfig({
        BASELOAD_PAYLOAD_PROVIDER_URL: "http://payload-provider:28883",
      }).payloadProvider,
    ).toEqual({
      url: "http://payload-provider:28883",
      namespace: "arkiv.entities",
      verifyReceipt: true,
    });
  });

  test("leaves backend baseload payload provider unset without a url", () => {
    expect(
      parseBaseloadRuntimeConfig({
        BASELOAD_PAYLOAD_PROVIDER_BEARER_KEY: "submit-secret",
      }).payloadProvider,
    ).toBeNull();
  });

  test("rejects invalid backend baseload payload provider receipt verification setting", () => {
    expect(() =>
      parseBaseloadRuntimeConfig({
        BASELOAD_PAYLOAD_PROVIDER_URL: "http://payload-provider:28883",
        BASELOAD_PAYLOAD_PROVIDER_VERIFY_RECEIPT: "sometimes",
      }),
    ).toThrow("BASELOAD_PAYLOAD_PROVIDER_VERIFY_RECEIPT must be a boolean");
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
      expect(config.workers[0]?.entitiesPerRequest).toBe(1);
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
