import {
  readStoredString,
  removeStoredValue,
  type StorageLike,
  writeStoredString,
} from "./localStorage";

export interface PageSettings {
  chainName: string;
  blockTimeMs: number;
  stubTickMs: number;
  maxStubBlocks: number;
  stubVisibleAgeMs: number;
  pingStartAgeMs: number;
  loadingMetadataLeadMs: number;
  nextBlockPingMs: number;
  pingMinIntervalMs: number;
  scannerDelayWarningAgeMs: number;
  histogramWindowMinutes: number;
  histogramRefreshMs: number;
  histogramClockTickMs: number;
}

export type PageSettingsKey = keyof PageSettings;
export type NumericPageSettingsKey = Exclude<PageSettingsKey, "chainName">;

interface TextSettingDefinition {
  key: "chainName";
  label: string;
  envName: string;
  kind: "text";
}

interface NumericSettingDefinition {
  key: NumericPageSettingsKey;
  label: string;
  envName: string;
  kind: "number";
  unit: string;
}

export type PageSettingDefinition = TextSettingDefinition | NumericSettingDefinition;

export const DEFAULT_PAGE_SETTINGS: PageSettings = {
  chainName: "Arkiv",
  blockTimeMs: 2_000,
  stubTickMs: 500,
  maxStubBlocks: 3,
  stubVisibleAgeMs: 6_000,
  pingStartAgeMs: 9_000,
  loadingMetadataLeadMs: 1_000,
  nextBlockPingMs: 100,
  pingMinIntervalMs: 1_500,
  scannerDelayWarningAgeMs: 60_000,
  histogramWindowMinutes: 60,
  histogramRefreshMs: 5_000,
  histogramClockTickMs: 1_000,
};

export const PAGE_SETTING_DEFINITIONS: readonly PageSettingDefinition[] = [
  { key: "chainName", label: "Chain name", envName: "VITE_CHAIN_NAME", kind: "text" },
  { key: "blockTimeMs", label: "Block time", envName: "VITE_BLOCK_TIME_MS", kind: "number", unit: "ms" },
  { key: "stubTickMs", label: "Stub tick", envName: "VITE_STUB_TICK_MS", kind: "number", unit: "ms" },
  { key: "maxStubBlocks", label: "Max stub blocks", envName: "VITE_MAX_STUB_BLOCKS", kind: "number", unit: "blocks" },
  {
    key: "stubVisibleAgeMs",
    label: "Stub visible age",
    envName: "VITE_STUB_VISIBLE_AGE_MS",
    kind: "number",
    unit: "ms",
  },
  { key: "pingStartAgeMs", label: "Ping start age", envName: "VITE_PING_START_AGE_MS", kind: "number", unit: "ms" },
  {
    key: "loadingMetadataLeadMs",
    label: "Loading metadata lead",
    envName: "VITE_LOADING_METADATA_LEAD_MS",
    kind: "number",
    unit: "ms",
  },
  {
    key: "nextBlockPingMs",
    label: "Next block ping",
    envName: "VITE_NEXT_BLOCK_PING_MS",
    kind: "number",
    unit: "ms",
  },
  {
    key: "pingMinIntervalMs",
    label: "Ping minimum interval",
    envName: "VITE_PING_MIN_INTERVAL_MS",
    kind: "number",
    unit: "ms",
  },
  {
    key: "scannerDelayWarningAgeMs",
    label: "Scanner delay warning age",
    envName: "VITE_SCANNER_DELAY_WARNING_AGE_MS",
    kind: "number",
    unit: "ms",
  },
  {
    key: "histogramWindowMinutes",
    label: "Histogram window",
    envName: "VITE_HISTOGRAM_WINDOW_MINUTES",
    kind: "number",
    unit: "minutes",
  },
  {
    key: "histogramRefreshMs",
    label: "Histogram refresh",
    envName: "VITE_HISTOGRAM_REFRESH_MS",
    kind: "number",
    unit: "ms",
  },
  {
    key: "histogramClockTickMs",
    label: "Histogram clock tick",
    envName: "VITE_HISTOGRAM_CLOCK_TICK_MS",
    kind: "number",
    unit: "ms",
  },
];

export const PAGE_SETTINGS_STORAGE_KEY = "page.settings";

type SettingsDraft = Record<PageSettingsKey, string>;

function envValues(): Record<string, string | undefined> {
  return ((import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {});
}

export function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fallback;
  return parsed;
}

export function readBuildPageSettings(env: Record<string, string | undefined> = envValues()): PageSettings {
  const chainName = env.VITE_CHAIN_NAME?.trim() || DEFAULT_PAGE_SETTINGS.chainName;
  return {
    chainName,
    blockTimeMs: parseNonNegativeInteger(env.VITE_BLOCK_TIME_MS, DEFAULT_PAGE_SETTINGS.blockTimeMs),
    stubTickMs: parseNonNegativeInteger(env.VITE_STUB_TICK_MS, DEFAULT_PAGE_SETTINGS.stubTickMs),
    maxStubBlocks: parseNonNegativeInteger(env.VITE_MAX_STUB_BLOCKS, DEFAULT_PAGE_SETTINGS.maxStubBlocks),
    stubVisibleAgeMs: parseNonNegativeInteger(env.VITE_STUB_VISIBLE_AGE_MS, DEFAULT_PAGE_SETTINGS.stubVisibleAgeMs),
    pingStartAgeMs: parseNonNegativeInteger(env.VITE_PING_START_AGE_MS, DEFAULT_PAGE_SETTINGS.pingStartAgeMs),
    loadingMetadataLeadMs: parseNonNegativeInteger(
      env.VITE_LOADING_METADATA_LEAD_MS,
      DEFAULT_PAGE_SETTINGS.loadingMetadataLeadMs,
    ),
    nextBlockPingMs: parseNonNegativeInteger(env.VITE_NEXT_BLOCK_PING_MS, DEFAULT_PAGE_SETTINGS.nextBlockPingMs),
    pingMinIntervalMs: parseNonNegativeInteger(env.VITE_PING_MIN_INTERVAL_MS, DEFAULT_PAGE_SETTINGS.pingMinIntervalMs),
    scannerDelayWarningAgeMs: parseNonNegativeInteger(
      env.VITE_SCANNER_DELAY_WARNING_AGE_MS,
      DEFAULT_PAGE_SETTINGS.scannerDelayWarningAgeMs,
    ),
    histogramWindowMinutes: parseNonNegativeInteger(
      env.VITE_HISTOGRAM_WINDOW_MINUTES,
      DEFAULT_PAGE_SETTINGS.histogramWindowMinutes,
    ),
    histogramRefreshMs: parseNonNegativeInteger(
      env.VITE_HISTOGRAM_REFRESH_MS,
      DEFAULT_PAGE_SETTINGS.histogramRefreshMs,
    ),
    histogramClockTickMs: parseNonNegativeInteger(
      env.VITE_HISTOGRAM_CLOCK_TICK_MS,
      DEFAULT_PAGE_SETTINGS.histogramClockTickMs,
    ),
  };
}

export const BUILD_PAGE_SETTINGS = readBuildPageSettings();

export function settingsToDraft(settings: PageSettings): SettingsDraft {
  return {
    chainName: settings.chainName,
    blockTimeMs: String(settings.blockTimeMs),
    stubTickMs: String(settings.stubTickMs),
    maxStubBlocks: String(settings.maxStubBlocks),
    stubVisibleAgeMs: String(settings.stubVisibleAgeMs),
    pingStartAgeMs: String(settings.pingStartAgeMs),
    loadingMetadataLeadMs: String(settings.loadingMetadataLeadMs),
    nextBlockPingMs: String(settings.nextBlockPingMs),
    pingMinIntervalMs: String(settings.pingMinIntervalMs),
    scannerDelayWarningAgeMs: String(settings.scannerDelayWarningAgeMs),
    histogramWindowMinutes: String(settings.histogramWindowMinutes),
    histogramRefreshMs: String(settings.histogramRefreshMs),
    histogramClockTickMs: String(settings.histogramClockTickMs),
  };
}

export function normalizeSettingsDraft(
  draft: SettingsDraft,
  fallback: PageSettings = BUILD_PAGE_SETTINGS,
): { settings: PageSettings; error: string | null } {
  const chainName = draft.chainName.trim();
  if (!chainName) {
    return { settings: fallback, error: "Chain name is required." };
  }

  const settings: PageSettings = { ...fallback, chainName };
  for (const definition of PAGE_SETTING_DEFINITIONS) {
    if (definition.kind !== "number") continue;
    const raw = draft[definition.key].trim();
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      return {
        settings: fallback,
        error: `${definition.label} must be a non-negative whole number.`,
      };
    }
    settings[definition.key] = parsed;
  }

  return { settings, error: null };
}

export function readStoredPageSettings(
  fallback: PageSettings = BUILD_PAGE_SETTINGS,
  storage?: StorageLike | null,
): PageSettings {
  const raw = readStoredString(PAGE_SETTINGS_STORAGE_KEY, "", undefined, storage);
  if (!raw) return fallback;

  try {
    const parsed = JSON.parse(raw) as Partial<Record<PageSettingsKey, unknown>>;
    const draft = settingsToDraft(fallback);
    for (const definition of PAGE_SETTING_DEFINITIONS) {
      const value = parsed[definition.key];
      if (typeof value === "string" || typeof value === "number") {
        draft[definition.key] = String(value);
      }
    }
    const result = normalizeSettingsDraft(draft, fallback);
    return result.error ? fallback : result.settings;
  } catch {
    return fallback;
  }
}

export function writeStoredPageSettings(settings: PageSettings, storage?: StorageLike | null): void {
  writeStoredString(PAGE_SETTINGS_STORAGE_KEY, JSON.stringify(settings), storage);
}

export function removeStoredPageSettings(storage?: StorageLike | null): void {
  removeStoredValue(PAGE_SETTINGS_STORAGE_KEY, storage);
}
