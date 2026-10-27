/**
 * Ground truth for the UDC explorer e2e verifier, read from the node alone:
 * every block 0..atBlock, every transaction's receipt (status, gasUsed,
 * rentFee, logs), per-block gas and rent sums, and every live entity at
 * atBlock through arkiv_query with the full select (attributeSchema with the
 * indexed flags, exact expiresAt including 2^64 - 1), plus named keys that may
 * no longer be live.
 *
 * Calldata is never kept (only its size): receipts on this node carry the
 * transaction input, and bytes contents travel in it.
 */
import type { Hex } from "viem";
import {
  FULL_SELECT,
  hexBlock,
  queryAll,
  rpcBatch,
  rpcCall,
  RpcError,
  type RpcEntity,
} from "./udcE2eModel";

export interface LogTruth {
  address: Hex;
  topics: Hex[];
  data: Hex;
  logIndex: number;
}

export interface TxTruth {
  hash: Hex;
  block: number;
  index: number;
  from: Hex;
  to: Hex | null;
  nonce: string;
  type: string;
  value: string;
  gasLimit: string;
  inputBytes: number;
  status: 0 | 1;
  gasUsed: string;
  cumulativeGasUsed: string;
  effectiveGasPrice: string;
  /** gasUsed × effectiveGasPrice. */
  gasFee: string;
  /** The receipt's rentFee (GLM wei charged outside gas); "0" when absent. */
  rentFee: string;
  rentFeePresent: boolean;
  logs: LogTruth[];
}

export interface BlockTruth {
  number: number;
  hash: Hex;
  parentHash: Hex;
  timestamp: number;
  gasUsed: string;
  gasLimit: string;
  baseFeePerGas: string | null;
  txHashes: Hex[];
  /** Sums over the block's receipts. */
  receiptGasUsed: string;
  /**
   * gasUsed − receiptGasUsed: gas the block spent outside any transaction.
   * Nonzero where the producer's expiry sweep removed entities.
   */
  systemGas: string;
  rentSum: string;
  gasFeeSum: string;
  failedTxs: number;
}

export interface NodeTruth {
  rpcUrl: string;
  atBlock: number;
  collectedAt: string;
  chainId: number;
  genesisHash: string | null;
  gasCapabilities: Record<string, unknown> | null;
  blocks: BlockTruth[];
  transactions: TxTruth[];
  totals: { txs: number; failedTxs: number; rentWei: string; gasFeeWei: string };
  /** Every live entity at atBlock, full select, in the node's order. */
  entities: RpcEntity[];
  /** arkiv_getEntityCount("*") at atBlock. */
  entityCount: number | null;
  /** Requested keys at atBlock: the entity, or null when not live. */
  keyed: Record<string, RpcEntity | null>;
}

const big = (value: unknown): bigint => (value === null || value === undefined ? 0n : BigInt(value as string));
const unwrap = <T>(value: T | RpcError, what: string): T => {
  if (value instanceof RpcError) throw new Error(`${what}: ${value.message}`);
  if (value === null || value === undefined) throw new Error(`${what}: null`);
  return value;
};

export async function nodeHead(url: string): Promise<number> {
  return Number(BigInt(await rpcCall<string>(url, "eth_blockNumber")));
}

export async function collectNodeTruth(
  url: string,
  options: { atBlock?: number; keys?: Hex[]; fromBlock?: number } = {},
): Promise<NodeTruth> {
  const atBlock = options.atBlock ?? (await nodeHead(url));
  const fromBlock = options.fromBlock ?? 0;
  const chainId = Number(BigInt(await rpcCall<string>(url, "eth_chainId")));
  let genesisHash: string | null = null;
  let gasCapabilities: Record<string, unknown> | null = null;
  try {
    const status: any = await (await fetch(`${url}/signed/v1/status`, { signal: AbortSignal.timeout(10_000) })).json();
    genesisHash = status?.identity?.genesisHash ?? status?.genesisHash ?? null;
    gasCapabilities = status?.capabilities?.gas ?? null;
  } catch {
    // Not every endpoint serves the native REST status.
  }

  const numbers = Array.from({ length: atBlock - fromBlock + 1 }, (_, i) => fromBlock + i);
  const rawBlocks = await rpcBatch<any>(
    url,
    numbers.map((n) => ({ method: "eth_getBlockByNumber", params: [hexBlock(n), false] })),
  );
  const hashes: Hex[] = [];
  const blocks = rawBlocks.map((raw, i) => {
    const block = unwrap(raw, `eth_getBlockByNumber ${numbers[i]}`);
    const txHashes = (block.transactions as (Hex | { hash: Hex })[]).map((t) =>
      (typeof t === "string" ? t : t.hash).toLowerCase() as Hex,
    );
    hashes.push(...txHashes);
    return { block, txHashes };
  });

  const receipts = await rpcBatch<any>(url, hashes.map((h) => ({ method: "eth_getTransactionReceipt", params: [h] })));
  const txs = await rpcBatch<any>(url, hashes.map((h) => ({ method: "eth_getTransactionByHash", params: [h] })));
  const transactions: TxTruth[] = hashes.map((hash, i) => {
    const receipt = unwrap(receipts[i], `eth_getTransactionReceipt ${hash}`);
    const tx = unwrap(txs[i], `eth_getTransactionByHash ${hash}`);
    const gasUsed = big(receipt.gasUsed);
    const price = big(receipt.effectiveGasPrice ?? tx.gasPrice);
    const input: string = tx.input ?? receipt.input ?? "0x";
    return {
      hash,
      block: Number(big(receipt.blockNumber)),
      index: Number(big(receipt.transactionIndex)),
      from: String(receipt.from).toLowerCase() as Hex,
      to: receipt.to ? (String(receipt.to).toLowerCase() as Hex) : null,
      nonce: big(tx.nonce).toString(),
      type: big(tx.type ?? receipt.type ?? 0).toString(),
      value: big(tx.value).toString(),
      gasLimit: big(tx.gas).toString(),
      inputBytes: (input.length - 2) / 2,
      status: big(receipt.status) === 1n ? 1 : 0,
      gasUsed: gasUsed.toString(),
      cumulativeGasUsed: big(receipt.cumulativeGasUsed).toString(),
      effectiveGasPrice: price.toString(),
      gasFee: (gasUsed * price).toString(),
      rentFee: big(receipt.rentFee).toString(),
      rentFeePresent: receipt.rentFee !== undefined && receipt.rentFee !== null,
      logs: (receipt.logs ?? []).map((log: any) => ({
        address: String(log.address).toLowerCase() as Hex,
        topics: (log.topics ?? []).map((t: string) => t.toLowerCase() as Hex),
        data: String(log.data).toLowerCase() as Hex,
        logIndex: Number(big(log.logIndex)),
      })),
    };
  });
  const byHash = new Map(transactions.map((t) => [t.hash, t]));

  const blockTruth: BlockTruth[] = blocks.map(({ block, txHashes }) => {
    let receiptGas = 0n;
    let rent = 0n;
    let fee = 0n;
    let failed = 0;
    for (const hash of txHashes) {
      const t = byHash.get(hash)!;
      receiptGas += BigInt(t.gasUsed);
      rent += BigInt(t.rentFee);
      fee += BigInt(t.gasFee);
      if (t.status === 0) failed++;
    }
    return {
      number: Number(big(block.number)),
      hash: String(block.hash).toLowerCase() as Hex,
      parentHash: String(block.parentHash).toLowerCase() as Hex,
      timestamp: Number(big(block.timestamp)),
      gasUsed: big(block.gasUsed).toString(),
      gasLimit: big(block.gasLimit).toString(),
      baseFeePerGas: block.baseFeePerGas === undefined ? null : big(block.baseFeePerGas).toString(),
      txHashes,
      receiptGasUsed: receiptGas.toString(),
      systemGas: (big(block.gasUsed) - receiptGas).toString(),
      rentSum: rent.toString(),
      gasFeeSum: fee.toString(),
      failedTxs: failed,
    };
  });

  const entities = await queryAll(url, "*", atBlock, FULL_SELECT);
  let entityCount: number | null = null;
  try {
    // `block` is a plain number here, not a hex quantity.
    entityCount = Number(await rpcCall(url, "arkiv_getEntityCount", [{ query: "*", block: atBlock }]));
  } catch {
    entityCount = null;
  }
  const keyed: Record<string, RpcEntity | null> = {};
  for (const key of new Set((options.keys ?? []).map((k) => k.toLowerCase() as Hex))) {
    const [found] = await queryAll(url, `$key = key(${key})`, atBlock, FULL_SELECT);
    keyed[key] = found ?? null;
  }

  return {
    rpcUrl: url,
    atBlock,
    collectedAt: new Date().toISOString(),
    chainId,
    genesisHash,
    gasCapabilities,
    blocks: blockTruth,
    transactions,
    totals: {
      txs: transactions.length,
      failedTxs: transactions.filter((t) => t.status === 0).length,
      rentWei: transactions.reduce((sum, t) => sum + BigInt(t.rentFee), 0n).toString(),
      gasFeeWei: transactions.reduce((sum, t) => sum + BigInt(t.gasFee), 0n).toString(),
    },
    entities,
    entityCount,
    keyed,
  };
}
