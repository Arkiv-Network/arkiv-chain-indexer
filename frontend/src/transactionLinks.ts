import { addressDetailHref } from "./permalinks";
import { envValues } from "./runtimeConfig";

/**
 * External links are off unless configured. The payload-era Atlas decoder at
 * decoder.atlas.arkiv-global.net cannot read UDC calldata, so it is no longer
 * the default: set VITE_TRANSACTION_DECODER_BASE_URL (build or runtime
 * config) to a decoder UI that takes `?tx=<hash>`, or leave it unset / `off`.
 */
const OFF_VALUES = new Set(["off", "none", "false", "0", "disabled"]);

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function normalizeHttpBaseUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || OFF_VALUES.has(trimmed.toLowerCase())) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }

  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

/** The configured decoder UI base URL, or null when the link is off (the default). */
export function readTransactionDecoderBaseUrl(
  env: Record<string, string | undefined> = envValues(),
): string | null {
  return normalizeHttpBaseUrl(env.VITE_TRANSACTION_DECODER_BASE_URL);
}

const TRANSACTION_DECODER_BASE_URL = readTransactionDecoderBaseUrl();

export function transactionDecoderHref(
  hash: string | null | undefined,
  baseUrl: string | null = TRANSACTION_DECODER_BASE_URL,
): string | null {
  const value = hash?.trim();
  if (!baseUrl || !value || !TX_HASH_RE.test(value)) return null;
  const url = new URL(baseUrl);
  url.searchParams.set("tx", value);
  return url.toString();
}

export function addressSearchHref(address: string | null | undefined): string | null {
  const value = address?.trim();
  if (!value || !ADDRESS_RE.test(value)) return null;

  return addressDetailHref(value);
}
