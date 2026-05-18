import { MAX_WALLET_NUMBER, MIN_WALLET_NUMBER } from "./baseloadConfig";
import { deriveBaseloadWalletAddress, getBaseloadMnemonic } from "./baseloadWallets";

export interface AddressDisplay {
  label: string;
  title?: string;
}

const ENTITY_REGISTRY_ADDRESS = "0x4400000000000000000000000000000000000044";
const ENTITY_REGISTRY_ALIAS = "EntityRegistry";

let cachedMnemonic = "";
let cachedBaseloadAliases = new Map<string, string>();

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
  return baseloadAliases().get(normalized) ?? null;
}

function baseloadAliases(): Map<string, string> {
  const mnemonic = getBaseloadMnemonic();
  if (cachedMnemonic === mnemonic) return cachedBaseloadAliases;

  cachedMnemonic = mnemonic;
  cachedBaseloadAliases = new Map<string, string>();
  for (let wallet = MIN_WALLET_NUMBER; wallet <= MAX_WALLET_NUMBER; wallet += 1) {
    cachedBaseloadAliases.set(
      deriveBaseloadWalletAddress(wallet, mnemonic).toLowerCase(),
      `Wallet${wallet}`,
    );
  }
  return cachedBaseloadAliases;
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
