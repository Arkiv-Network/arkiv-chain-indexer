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

export interface RpcStats {
  calls: number;
  requestBytes: number;
  responseBytes: number;
}

const textEncoder = new TextEncoder();

export class EthereumRpcClient {
  private nextId = 1;
  private stats: RpcStats = {
    calls: 0,
    requestBytes: 0,
    responseBytes: 0,
  };

  constructor(readonly rpcUrl: string) {}

  getStatsSnapshot(): RpcStats {
    return { ...this.stats };
  }

  getStatsSince(snapshot: RpcStats): RpcStats {
    return {
      calls: this.stats.calls - snapshot.calls,
      requestBytes: this.stats.requestBytes - snapshot.requestBytes,
      responseBytes: this.stats.responseBytes - snapshot.responseBytes,
    };
  }

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
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });

    this.stats.calls += 1;
    this.stats.requestBytes += textEncoder.encode(body).byteLength;

    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body,
    });
    const responseText = await response.text();
    this.stats.responseBytes += textEncoder.encode(responseText).byteLength;

    if (!response.ok) {
      throw new Error(`RPC ${method} failed with HTTP ${response.status}`);
    }

    const payload = JSON.parse(responseText) as JsonRpcResponse<T>;
    if ("error" in payload) {
      throw new Error(`RPC ${method} failed: ${payload.error.code} ${payload.error.message}`);
    }

    return payload.result;
  }
}
