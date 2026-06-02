import { buildRouteHref } from "./permalinks";

export const DEFAULT_TX_EXPLORER_BASE_URL = "https://explorer.braga.hoodi.arkiv.network/tx/";

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function envValues(): Record<string, string | undefined> {
  return ((import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {});
}

function normalizeTransactionExplorerBaseUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }

  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

export function readTransactionExplorerBaseUrl(
  env: Record<string, string | undefined> = envValues(),
): string {
  return normalizeTransactionExplorerBaseUrl(env.VITE_TRANSACTION_EXPLORER_BASE_URL) ?? DEFAULT_TX_EXPLORER_BASE_URL;
}

const TX_EXPLORER_BASE_URL = readTransactionExplorerBaseUrl();

export function transactionExplorerHref(hash: string | null | undefined): string | null {
  const value = hash?.trim();
  if (!value || !TX_HASH_RE.test(value)) return null;
  return `${TX_EXPLORER_BASE_URL}${value}`;
}

export function addressSearchHref(address: string | null | undefined): string | null {
  const value = address?.trim();
  if (!value || !ADDRESS_RE.test(value)) return null;

  return buildRouteHref("transactions", { address: value, page: "1" });
}
