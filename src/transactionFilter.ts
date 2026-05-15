import type { RpcTransaction } from "./types";

export const IGNORED_TRANSACTION_FROM_ADDRESS = "0xDeaDDEaDDeAdDeAdDEAdDEaddeAddEAdDEAd0001";

const ignoredTransactionFromAddress = IGNORED_TRANSACTION_FROM_ADDRESS.toLowerCase();

export function shouldIgnoreTransaction(transaction: RpcTransaction): boolean {
  return transaction.from?.toLowerCase() === ignoredTransactionFromAddress;
}
