import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PAGE_SETTINGS,
  normalizeSettingsDraft,
  readBuildPageSettings,
  readStoredPageSettings,
  settingsToDraft,
  writeStoredPageSettings,
} from "./src/pageSettings";
import type { StorageLike } from "./src/localStorage";

class MemoryStorage implements StorageLike {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("frontend page settings", () => {
  test("reads Vite build values with defaults for invalid numbers", () => {
    expect(
      readBuildPageSettings({
        VITE_CHAIN_NAME: "Hoodi",
        VITE_TOKEN_SYMBOL: "tGLM",
        VITE_BLOCK_TIME_MS: "12000",
        VITE_STUB_TICK_MS: "-1",
        VITE_HISTOGRAM_WINDOW_MINUTES: "30",
        VITE_NO_BATCHER: "true",
      }),
    ).toMatchObject({
      chainName: "Hoodi",
      tokenSymbol: "tGLM",
      blockTimeMs: 12_000,
      stubTickMs: DEFAULT_PAGE_SETTINGS.stubTickMs,
      histogramWindowMinutes: 30,
      noBatcher: true,
    });
  });

  test("only treats VITE_NO_BATCHER=true as disabling batcher UI", () => {
    expect(readBuildPageSettings({ VITE_NO_BATCHER: "true" }).noBatcher).toBe(true);
    expect(readBuildPageSettings({ VITE_NO_BATCHER: "TRUE" }).noBatcher).toBe(true);
    expect(readBuildPageSettings({ VITE_NO_BATCHER: "false" }).noBatcher).toBe(false);
    expect(readBuildPageSettings({ VITE_NO_BATCHER: "1" }).noBatcher).toBe(false);
  });

  test("keeps the token symbol's case and trims surrounding whitespace", () => {
    expect(readBuildPageSettings({ VITE_TOKEN_SYMBOL: " glm " }).tokenSymbol).toBe("glm");
    expect(readBuildPageSettings({ VITE_TOKEN_SYMBOL: "wstETH" }).tokenSymbol).toBe("wstETH");
    expect(readBuildPageSettings({ VITE_TOKEN_SYMBOL: "P1L" }).tokenSymbol).toBe("P1L");
  });

  test("defaults token symbol when Vite value is not 2–10 letters or digits", () => {
    expect(readBuildPageSettings({ VITE_TOKEN_SYMBOL: "" }).tokenSymbol).toBe("ETH");
    expect(readBuildPageSettings({ VITE_TOKEN_SYMBOL: "G" }).tokenSymbol).toBe("ETH");
    expect(readBuildPageSettings({ VITE_TOKEN_SYMBOL: "TOOLONGSYMB" }).tokenSymbol).toBe("ETH");
    expect(readBuildPageSettings({ VITE_TOKEN_SYMBOL: "t GLM" }).tokenSymbol).toBe("ETH");
    expect(readBuildPageSettings({ VITE_TOKEN_SYMBOL: "<b>" }).tokenSymbol).toBe("ETH");
  });

  test("normalizes editable drafts", () => {
    const draft = settingsToDraft(DEFAULT_PAGE_SETTINGS);
    draft.chainName = "Braga";
    draft.tokenSymbol = "tGLM";
    draft.maxStubBlocks = "5";

    expect(normalizeSettingsDraft(draft).settings).toMatchObject({
      chainName: "Braga",
      tokenSymbol: "tGLM",
      maxStubBlocks: 5,
    });
  });

  test("rejects invalid editable drafts", () => {
    const draft = settingsToDraft(DEFAULT_PAGE_SETTINGS);
    draft.nextBlockPingMs = "1.5";

    expect(normalizeSettingsDraft(draft).error).toContain("Next block ping");
  });

  test("persists browser overrides", () => {
    const storage = new MemoryStorage();
    const settings = { ...DEFAULT_PAGE_SETTINGS, chainName: "Local", blockTimeMs: 1_000 };

    writeStoredPageSettings(settings, storage);

    expect(readStoredPageSettings(DEFAULT_PAGE_SETTINGS, storage)).toMatchObject({
      chainName: "Local",
      blockTimeMs: 1_000,
    });
  });
});
