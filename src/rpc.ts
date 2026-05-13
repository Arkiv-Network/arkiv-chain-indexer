import { blockNumberToHex } from "./math";
import type { Hex, RpcBlock, RpcReceipt } from "./types";

interface JsonRpcSuccess<T> {
  jsonrpc: "2.0";
  id: number;
  result: T;
}

interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: number;
  error: {
    code: number;
    message: string;
  };
}

type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcFailure;

export class EthereumRpcClient {
  private nextId = 1;

  constructor(private readonly rpcUrl: string) {}

  async getLatestBlockNumber(): Promise<bigint> {
    const result = await this.request<Hex>("eth_blockNumber", []);
    return BigInt(result);
  }

  async getBlockWithTransactions(blockNumber: bigint): Promise<RpcBlock> {
    const result = await this.request<RpcBlock | null>("eth_getBlockByNumber", [
      blockNumberToHex(blockNumber),
      true,
    ]);

    if (result === null) {
      throw new Error(`Block ${blockNumber.toString()} was not found`);
    }

    return result;
  }

  async getTransactionReceipt(transactionHash: Hex): Promise<RpcReceipt> {
    const result = await this.request<RpcReceipt | null>("eth_getTransactionReceipt", [transactionHash]);

    if (result === null) {
      throw new Error(`Receipt ${transactionHash} was not found`);
    }

    return result;
  }

  private async request<T>(method: string, params: unknown[]): Promise<T> {
    const id = this.nextId++;
    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
      }),
    });

    if (!response.ok) {
      throw new Error(`RPC ${method} failed with HTTP ${response.status}`);
    }

    const payload = (await response.json()) as JsonRpcResponse<T>;
    if ("error" in payload) {
      throw new Error(`RPC ${method} failed: ${payload.error.code} ${payload.error.message}`);
    }

    return payload.result;
  }
}
