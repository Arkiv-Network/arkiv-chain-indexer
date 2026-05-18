export interface AddressDisplay {
  label: string;
  title?: string;
}

const ENTITY_REGISTRY_ADDRESS = "0x4400000000000000000000000000000000000044";
const ENTITY_REGISTRY_ALIAS = "EntityRegistry";

export function addressDisplay(value: string | null | undefined): AddressDisplay {
  const address = value?.trim();
  if (!address) return { label: "-" };

  return {
    label: addressAlias(address) ?? shortAddress(address),
    title: address,
  };
}

export function addressAlias(value: string | null | undefined): string | null {
  const normalized = normalizeAddress(value);
  if (!normalized) return null;
  if (normalized === ENTITY_REGISTRY_ADDRESS.toLowerCase()) return ENTITY_REGISTRY_ALIAS;
  return null;
}

function normalizeAddress(value: string | null | undefined): string | null {
  const address = value?.trim();
  if (!address || !/^0[xX][0-9a-fA-F]{40}$/.test(address)) return null;
  return address.toLowerCase();
}

function shortAddress(value: string): string {
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}...${value.slice(-8)}`;
}
