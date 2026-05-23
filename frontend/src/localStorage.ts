const PREFIX = "gas-price-tracker:";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface EnumerableStorageLike extends StorageLike {
  readonly length: number;
  key(index: number): string | null;
}

function storageKey(key: string): string {
  return `${PREFIX}${key}`;
}

function isEnumerableStorage(storage: StorageLike): storage is EnumerableStorageLike {
  return typeof (storage as Partial<EnumerableStorageLike>).length === "number" &&
    typeof (storage as Partial<EnumerableStorageLike>).key === "function";
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readStoredString(
  key: string,
  fallback: string,
  isValid: (value: string) => boolean = () => true,
  storage: StorageLike | null = getBrowserStorage(),
): string {
  if (!storage) return fallback;
  try {
    const value = storage.getItem(storageKey(key));
    if (value === null || !isValid(value)) return fallback;
    return value;
  } catch {
    return fallback;
  }
}

export function writeStoredString(
  key: string,
  value: string,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(storageKey(key), value);
  } catch {
    // localStorage may be unavailable or full. Persistence is best-effort.
  }
}

export function removeStoredValue(
  key: string,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(storageKey(key));
  } catch {
    // localStorage may be unavailable. Persistence is best-effort.
  }
}

export function removeStoredSection(
  keyPrefix: string,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage || !isEnumerableStorage(storage)) return;

  try {
    const prefix = storageKey(keyPrefix);
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) {
      storage.removeItem(key);
    }
  } catch {
    // localStorage may be unavailable. Persistence is best-effort.
  }
}

export function readStoredStringRecord<T extends object>(
  key: string,
  fallback: T,
  keys: readonly string[],
  storage: StorageLike | null = getBrowserStorage(),
): T {
  if (!storage) return fallback;

  try {
    const raw = storage.getItem(storageKey(key));
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;

    const input = parsed as Record<string, unknown>;
    const next = { ...fallback } as Record<string, unknown>;
    for (const recordKey of keys) {
      const value = input[recordKey];
      if (typeof value === "string") next[recordKey] = value;
    }
    return next as T;
  } catch {
    return fallback;
  }
}

export function writeStoredStringRecord<T extends object>(
  key: string,
  value: T,
  keys: readonly (keyof T & string)[],
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;

  try {
    const output: Record<string, string> = {};
    for (const recordKey of keys) {
      const recordValue = value[recordKey];
      if (typeof recordValue === "string") output[recordKey] = recordValue;
    }
    storage.setItem(storageKey(key), JSON.stringify(output));
  } catch {
    // localStorage may be unavailable or full. Persistence is best-effort.
  }
}
