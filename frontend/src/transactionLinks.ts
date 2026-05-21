const TX_EXPLORER_BASE_URL = "https://explorer.braga.hoodi.arkiv.network/tx/";

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function transactionExplorerHref(hash: string | null | undefined): string | null {
  const value = hash?.trim();
  if (!value || !TX_HASH_RE.test(value)) return null;
  return `${TX_EXPLORER_BASE_URL}${value}`;
}

export function addressSearchHref(address: string | null | undefined): string | null {
  const value = address?.trim();
  if (!value || !ADDRESS_RE.test(value)) return null;

  const params = new URLSearchParams();
  params.set("view", "transactions");
  params.set("address", value);
  params.set("page", "1");
  return `?${params.toString()}`;
}
