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
        VITE_BLOCK_TIME_MS: "12000",
        VITE_STUB_TICK_MS: "-1",
        VITE_HISTOGRAM_WINDOW_MINUTES: "30",
      }),
    ).toMatchObject({
      chainName: "Hoodi",
      blockTimeMs: 12_000,
      stubTickMs: DEFAULT_PAGE_SETTINGS.stubTickMs,
      histogramWindowMinutes: 30,
    });
  });

  test("normalizes editable drafts", () => {
    const draft = settingsToDraft(DEFAULT_PAGE_SETTINGS);
    draft.chainName = "Braga";
    draft.maxStubBlocks = "5";

    expect(normalizeSettingsDraft(draft).settings).toMatchObject({
      chainName: "Braga",
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
