import {
  EMPTY_BASELOAD_CONFIG,
  normalizeBaseloadConfig,
  serializeBaseloadConfig,
  type BaseloadConfig,
} from "./baseloadConfig";
import { loadFromStorage } from "./persistentState";

const STORAGE_KEY = "gas-tracker.baseload-config";

export function loadStoredBaseloadConfig(): BaseloadConfig {
  try {
    return normalizeBaseloadConfig(loadFromStorage<BaseloadConfig>(STORAGE_KEY, EMPTY_BASELOAD_CONFIG));
  } catch {
    return EMPTY_BASELOAD_CONFIG;
  }
}

export function saveStoredBaseloadConfig(config: BaseloadConfig) {
  try {
    window.localStorage.setItem(STORAGE_KEY, serializeBaseloadConfig(config));
  } catch {
    // ignore quota/serialization errors
  }
}
