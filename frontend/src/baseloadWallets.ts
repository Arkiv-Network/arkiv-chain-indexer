import { HDNodeWallet } from "ethers";

export const DEFAULT_BASELOAD_MNEMONIC =
  "parent picture garment parrot churn record stadium pill rocket craft fish fiscal clip virus view diary replace wealth extra kitten door enforce piece nut";

const BASELOAD_DERIVATION_PATH_PREFIX = "m/44'/60'/0'/0";

declare global {
  interface Window {
    __ARKIV_CONFIG__?: {
      baseloadMnemonic?: string;
    };
  }
}

export function getBaseloadMnemonic(): string {
  if (typeof window !== "undefined") {
    const runtimeMnemonic = window.__ARKIV_CONFIG__?.baseloadMnemonic?.trim();
    if (runtimeMnemonic) return runtimeMnemonic;
  }
  return DEFAULT_BASELOAD_MNEMONIC;
}

export function deriveBaseloadWalletAddress(
  walletNumber: number,
  mnemonic = getBaseloadMnemonic(),
): string {
  return HDNodeWallet.fromPhrase(
    mnemonic.trim(),
    undefined,
    `${BASELOAD_DERIVATION_PATH_PREFIX}/${walletNumber}`,
  ).address;
}
