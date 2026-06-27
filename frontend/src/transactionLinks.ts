import { addressDetailHref } from "./permalinks";
import { envValues } from "./runtimeConfig";

export const DEFAULT_TX_EXPLORER_BASE_URL = "https://explorer.braga.hoodi.arkiv.network/tx/";
export const DEFAULT_PAYLOAD_PROVIDER_BASE_URL = "https://payload.atlas.arkiv-global.net/";

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
// Content-addressed payload id: 64-char lowercase hex (matches the decoder's
// PayloadReference.id format).
const PAYLOAD_ID_RE = /^[0-9a-f]{64}$/;

function normalizeHttpBaseUrl(value: string | undefined): string | null {
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
  return normalizeHttpBaseUrl(env.VITE_TRANSACTION_EXPLORER_BASE_URL) ?? DEFAULT_TX_EXPLORER_BASE_URL;
}

const TX_EXPLORER_BASE_URL = readTransactionExplorerBaseUrl();

export function transactionExplorerHref(hash: string | null | undefined): string | null {
  const value = hash?.trim();
  if (!value || !TX_HASH_RE.test(value)) return null;
  return `${TX_EXPLORER_BASE_URL}${value}`;
}

export function readPayloadProviderBaseUrl(
  env: Record<string, string | undefined> = envValues(),
): string {
  return normalizeHttpBaseUrl(env.VITE_PAYLOAD_PROVIDER_BASE_URL) ?? DEFAULT_PAYLOAD_PROVIDER_BASE_URL;
}

const PAYLOAD_PROVIDER_BASE_URL = readPayloadProviderBaseUrl();

/**
 * Link to the payload provider's info page for a content-addressed payload id
 * (the decoder's PayloadReference.id), e.g.
 * `https://payload.atlas.arkiv-global.net/payloads/<id>`.
 */
export function payloadInfoHref(id: string | null | undefined): string | null {
  const value = id?.trim().toLowerCase();
  if (!value || !PAYLOAD_ID_RE.test(value)) return null;
  return `${PAYLOAD_PROVIDER_BASE_URL}payloads/${value}`;
}

export function addressSearchHref(address: string | null | undefined): string | null {
  const value = address?.trim();
  if (!value || !ADDRESS_RE.test(value)) return null;

  return addressDetailHref(value);
}
